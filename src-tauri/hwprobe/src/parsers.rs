//! Pure, defensive parsers for platform tool output. No I/O here.

use crate::{GpuKind, GpuVendor};
use serde_json::Value;

/// "8 GB", "1536 MB", "16 GB" → bytes (binary units, as macOS reports memory).
pub fn parse_size_str(s: &str) -> Option<u64> {
    let t = s.trim();
    let mut parts = t.split_whitespace();
    let n: f64 = parts.next()?.replace(',', "").parse().ok()?;
    let unit = parts.next().unwrap_or("B").to_ascii_uppercase();
    let mult: f64 = match unit.as_str() {
        "B" => 1.0,
        "KB" => 1024.0,
        "MB" => 1024.0 * 1024.0,
        "GB" => 1024.0 * 1024.0 * 1024.0,
        "TB" => 1024f64.powi(4),
        _ => return None,
    };
    Some((n * mult) as u64)
}

pub fn vendor_from_pci(id: u32) -> GpuVendor {
    match id {
        0x10de => GpuVendor::Nvidia,
        0x1002 | 0x1022 => GpuVendor::Amd,
        0x8086 => GpuVendor::Intel,
        0x106b => GpuVendor::Apple,
        0x1414 => GpuVendor::Microsoft,
        _ => GpuVendor::Other,
    }
}

/// Virtual display adapters (VMware SVGA, VirtualBox, QEMU std/virtio, Hyper-V).
pub fn is_virtual_pci_vendor(id: u32) -> bool {
    matches!(id, 0x15ad | 0x80ee | 0x1234 | 0x1af4 | 0x1b36 | 0x1414)
}

pub fn vendor_from_name(name: &str) -> GpuVendor {
    let n = name.to_lowercase();
    if n.contains("nvidia") || n.contains("geforce") || n.contains("quadro") || n.contains("rtx") {
        GpuVendor::Nvidia
    } else if n.contains("amd") || n.contains("radeon") {
        GpuVendor::Amd
    } else if n.contains("intel") {
        GpuVendor::Intel
    } else if n.contains("apple") {
        GpuVendor::Apple
    } else if n.contains("microsoft") || n.contains("basic render") || n.contains("basic display") {
        GpuVendor::Microsoft
    } else {
        GpuVendor::Unknown
    }
}

/// Parse "PCI\\VEN_10DE&DEV_2705..." → (vendor, device).
pub fn parse_pnp_ids(pnp: &str) -> Option<(u32, u32)> {
    let up = pnp.to_uppercase();
    let ven = up.split("VEN_").nth(1)?.get(0..4)?;
    let dev = up.split("DEV_").nth(1)?.get(0..4)?;
    Some((u32::from_str_radix(ven, 16).ok()?, u32::from_str_radix(dev, 16).ok()?))
}

pub fn parse_hex_id(s: &str) -> Option<u32> {
    u32::from_str_radix(s.trim().trim_start_matches("0x"), 16).ok()
}

// ------------------------------------------------------------------ nvidia-smi

#[derive(Debug, Clone, PartialEq)]
pub struct NvRow {
    pub index: u32,
    pub name: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub used_bytes: u64,
    pub driver: Option<String>,
}

/// `nvidia-smi --query-gpu=index,name,memory.total,memory.free,memory.used,driver_version --format=csv,noheader,nounits`
pub fn parse_nvidia_smi(csv: &str) -> Vec<NvRow> {
    const MIB: u64 = 1024 * 1024;
    csv.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(',').map(|s| s.trim()).collect();
            if f.len() < 5 {
                return None;
            }
            Some(NvRow {
                index: f[0].parse().ok()?,
                name: f[1].to_string(),
                total_bytes: f[2].parse::<u64>().ok()? * MIB,
                free_bytes: f[3].parse::<u64>().ok()? * MIB,
                used_bytes: f[4].parse::<u64>().ok()? * MIB,
                driver: f.get(5).map(|s| s.to_string()).filter(|s| !s.is_empty()),
            })
        })
        .collect()
}

// ------------------------------------------------------------------ macOS system_profiler

#[derive(Debug, Clone, PartialEq)]
pub struct MacGpu {
    pub name: String,
    pub vendor: GpuVendor,
    pub kind: GpuKind,
    pub vram_bytes: Option<u64>,
    pub shared_vram_bytes: Option<u64>,
    pub cores: Option<u32>,
    pub external: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MacInfo {
    pub model_name: Option<String>,
    pub model_id: Option<String>,
    pub chip: Option<String>,
    pub memory_bytes: Option<u64>,
    pub gpus: Vec<MacGpu>,
}

pub fn parse_system_profiler(json: &str) -> Result<MacInfo, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("system_profiler JSON: {e}"))?;
    let mut info = MacInfo::default();
    if let Some(h) = v.get("SPHardwareDataType").and_then(|x| x.as_array()).and_then(|a| a.first()) {
        let s = |k: &str| h.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
        info.model_name = s("machine_name");
        info.model_id = s("machine_model");
        info.chip = s("chip_type").or_else(|| s("cpu_type"));
        info.memory_bytes = s("physical_memory").and_then(|m| parse_size_str(&m));
    }
    if let Some(arr) = v.get("SPDisplaysDataType").and_then(|x| x.as_array()) {
        for g in arr {
            let s = |k: &str| g.get(k).and_then(|x| x.as_str()).map(|x| x.to_string());
            let name = s("sppci_model").or_else(|| s("_name")).unwrap_or_else(|| "Unknown GPU".into());
            let vendor_raw = s("spdisplays_vendor").unwrap_or_default().to_lowercase();
            let vendor = if vendor_raw.contains("apple") {
                GpuVendor::Apple
            } else if vendor_raw.contains("amd") || vendor_raw.contains("ati") {
                GpuVendor::Amd
            } else if vendor_raw.contains("intel") {
                GpuVendor::Intel
            } else if vendor_raw.contains("nvidia") {
                GpuVendor::Nvidia
            } else {
                vendor_from_name(&name)
            };
            let vram = s("spdisplays_vram").or_else(|| s("_spdisplays_vram")).and_then(|x| parse_size_str(&x));
            let shared = s("spdisplays_vram_shared").and_then(|x| parse_size_str(&x));
            let bus = s("sppci_bus").unwrap_or_default();
            let external = bus.contains("thunderbolt") || bus.contains("external");
            let kind = if vendor == GpuVendor::Apple {
                GpuKind::Unified
            } else if vram.is_some() {
                GpuKind::Discrete
            } else {
                GpuKind::Integrated
            };
            info.gpus.push(MacGpu {
                name,
                vendor,
                kind,
                vram_bytes: vram,
                shared_vram_bytes: shared,
                cores: s("sppci_cores").and_then(|c| c.parse().ok()),
                external,
            });
        }
    }
    Ok(info)
}

// ------------------------------------------------------------------ Windows CIM JSON

#[derive(Debug, Clone, Default, PartialEq)]
pub struct WinCim {
    pub chassis_types: Vec<u32>,
    pub battery_count: Option<u32>,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub hypervisor_present: Option<bool>,
    pub video: Vec<WinVideo>,
    pub os_caption: Option<String>,
    pub os_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WinVideo {
    pub name: String,
    /// Win32_VideoController.AdapterRAM — a 32-bit field, capped near 4 GiB. Low confidence.
    pub adapter_ram: Option<u64>,
    pub driver_version: Option<String>,
    pub pci: Option<(u32, u32)>,
}

/// PowerShell's ConvertTo-Json emits a bare object instead of a 1-element array.
fn as_list(v: Option<&Value>) -> Vec<&Value> {
    match v {
        Some(Value::Array(a)) => a.iter().collect(),
        Some(Value::Null) | None => vec![],
        Some(x) => vec![x],
    }
}

pub fn parse_windows_cim(json: &str) -> Result<WinCim, String> {
    let v: Value = serde_json::from_str(json.trim_start_matches('\u{feff}')).map_err(|e| format!("CIM JSON: {e}"))?;
    let mut out = WinCim::default();
    for e in as_list(v.get("enclosure")) {
        for c in as_list(e.get("ChassisTypes")) {
            if let Some(n) = c.as_u64() {
                out.chassis_types.push(n as u32);
            }
        }
    }
    out.battery_count = v.get("batteryCount").and_then(|x| x.as_u64()).map(|x| x as u32);
    if let Some(cs) = v.get("computerSystem") {
        out.manufacturer = cs.get("Manufacturer").and_then(|x| x.as_str()).map(String::from);
        out.model = cs.get("Model").and_then(|x| x.as_str()).map(String::from);
        out.hypervisor_present = cs.get("HypervisorPresent").and_then(|x| x.as_bool());
    }
    for vc in as_list(v.get("video")) {
        let name = vc.get("Name").and_then(|x| x.as_str()).unwrap_or("Unknown adapter").to_string();
        out.video.push(WinVideo {
            name,
            adapter_ram: vc.get("AdapterRAM").and_then(|x| x.as_u64()),
            driver_version: vc.get("DriverVersion").and_then(|x| x.as_str()).map(String::from),
            pci: vc.get("PNPDeviceID").and_then(|x| x.as_str()).and_then(parse_pnp_ids),
        });
    }
    if let Some(os) = v.get("os") {
        out.os_caption = os.get("Caption").and_then(|x| x.as_str()).map(String::from);
        out.os_version = os.get("Version").and_then(|x| x.as_str()).map(String::from);
    }
    Ok(out)
}

/// Heuristic VM detection from manufacturer/model strings (DMI or CIM).
pub fn vm_hint(manufacturer: &str, model: &str) -> Option<String> {
    let s = format!("{} {}", manufacturer, model).to_lowercase();
    for (needle, label) in [
        ("vmware", "VMware"),
        ("virtualbox", "VirtualBox"),
        ("innotek", "VirtualBox"),
        ("qemu", "QEMU/KVM"),
        ("kvm", "KVM"),
        ("xen", "Xen"),
        ("parallels", "Parallels"),
        ("virtual machine", "Hyper-V"),
        ("bochs", "Bochs"),
        ("amazon ec2", "AWS EC2"),
        ("google compute", "Google Compute Engine"),
    ] {
        if s.contains(needle) {
            return Some(label.into());
        }
    }
    None
}

/// `lspci -mm -s <slot>` → device name ("Vendor" "Device" fields).
pub fn parse_lspci_mm(line: &str) -> Option<String> {
    let parts: Vec<&str> = line.split('"').collect();
    // slot "class" "vendor" "device" ...
    let vendor = parts.get(3)?.trim();
    let device = parts.get(5)?.trim();
    if device.is_empty() {
        return None;
    }
    Some(format!("{vendor} {device}").trim().to_string())
}

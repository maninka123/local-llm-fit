//! Linux adapter: DRM sysfs for GPUs (amdgpu exposes VRAM), NVML/nvidia-smi for NVIDIA,
//! DMI + power_supply for form factor. No root needed.

use super::NvidiaSource;
use crate::classify::ChassisSignals;
use crate::parsers::{is_virtual_pci_vendor, parse_hex_id, parse_lspci_mm, vendor_from_pci, vm_hint};
use crate::{Confidence, Env, Field, GpuDevice, GpuKind, GpuVendor, HardwareReport, SystemProbe, GIB};

pub struct LinuxProbe {
    nvidia: Box<dyn NvidiaSource>,
}

impl LinuxProbe {
    pub fn new(nvidia: Box<dyn NvidiaSource>) -> Self {
        Self { nvidia }
    }
}

fn read_trim(env: &dyn Env, p: &str) -> Option<String> {
    env.read_file(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn drm_cards(env: &dyn Env) -> Vec<String> {
    env.list_dir("/sys/class/drm")
        .unwrap_or_default()
        .into_iter()
        .filter(|n| n.starts_with("card") && n[4..].chars().all(|c| c.is_ascii_digit()) && n.len() > 4)
        .collect()
}

pub fn amd_vram_used(env: &dyn Env) -> Option<u64> {
    let mut total = 0u64;
    for c in drm_cards(env) {
        if let Some(u) = read_trim(env, &format!("/sys/class/drm/{c}/device/mem_info_vram_used")).and_then(|s| s.parse::<u64>().ok()) {
            total += u;
        }
    }
    if total > 0 {
        Some(total)
    } else {
        None
    }
}

impl SystemProbe for LinuxProbe {
    fn gpus(&self, env: &dyn Env, r: &mut HardwareReport) {
        let nv = self.nvidia.query(env);
        let mut nvidia_added = false;
        match &nv {
            Ok((rows, src)) => {
                for row in rows {
                    let mut d = GpuDevice::new(format!("nvidia{}", row.index), row.name.clone(), GpuVendor::Nvidia, GpuKind::Discrete);
                    d.dedicated_bytes = Field::known(row.total_bytes, src.clone(), Confidence::High);
                    d.free_bytes = Field::known(row.free_bytes, format!("{src} (live)"), Confidence::High);
                    d.driver_version = row.driver.clone();
                    d.backend_hints = vec!["cuda".into()];
                    r.gpus.push(d);
                    nvidia_added = true;
                }
            }
            Err(_) => {}
        }

        let cards = drm_cards(env);
        if cards.is_empty() && !nvidia_added {
            r.notes.push("No DRM display devices found in /sys/class/drm (headless, container or restricted sysfs).".into());
        }
        for card in cards {
            let base = format!("/sys/class/drm/{card}/device");
            let vendor_id = read_trim(env, &format!("{base}/vendor")).and_then(|s| parse_hex_id(&s)).unwrap_or(0);
            let device_id = read_trim(env, &format!("{base}/device")).and_then(|s| parse_hex_id(&s)).unwrap_or(0);
            let vendor = vendor_from_pci(vendor_id);
            if vendor == GpuVendor::Nvidia && nvidia_added {
                continue; // already described by NVML/nvidia-smi
            }
            let slot = read_trim(env, &format!("{base}/uevent")).and_then(|u| u.lines().find_map(|l| l.strip_prefix("PCI_SLOT_NAME=").map(String::from)));
            let name = slot
                .as_deref()
                .and_then(|s| env.run("lspci", &["-mm", "-s", s]).ok())
                .and_then(|o| o.lines().next().and_then(parse_lspci_mm))
                .unwrap_or_else(|| format!("{:?} GPU ({vendor_id:04x}:{device_id:04x})", vendor));
            if is_virtual_pci_vendor(vendor_id) {
                let mut d = GpuDevice::new(card.clone(), name, GpuVendor::Other, GpuKind::Virtual);
                d.dedicated_bytes = Field::unknown("sysfs", "Virtual display adapter");
                r.gpus.push(d);
                continue;
            }
            let vram_total = read_trim(env, &format!("{base}/mem_info_vram_total")).and_then(|s| s.parse::<u64>().ok());
            let vram_used = read_trim(env, &format!("{base}/mem_info_vram_used")).and_then(|s| s.parse::<u64>().ok());
            let kind = match vendor {
                GpuVendor::Amd => match vram_total {
                    Some(t) if t >= 2 * GIB => GpuKind::Discrete,
                    Some(_) => GpuKind::Integrated, // APU carve-out
                    None => GpuKind::Unknown,
                },
                GpuVendor::Intel => {
                    if name.to_lowercase().contains("arc") && !name.to_lowercase().contains("arc(tm) graphics") {
                        GpuKind::Discrete
                    } else {
                        GpuKind::Integrated
                    }
                }
                GpuVendor::Nvidia => GpuKind::Discrete,
                _ => GpuKind::Unknown,
            };
            let mut d = GpuDevice::new(card.clone(), name, vendor, kind);
            match vram_total {
                Some(t) => {
                    d.dedicated_bytes = Field::known(t, "amdgpu sysfs mem_info_vram_total", if kind == GpuKind::Integrated { Confidence::Medium } else { Confidence::High });
                    if let Some(u) = vram_used {
                        d.free_bytes = Field::known(t.saturating_sub(u), "amdgpu sysfs (live)", Confidence::High);
                    }
                    d.backend_hints = vec!["rocm".into(), "vulkan".into()];
                }
                None => {
                    let why = match (vendor, &nv) {
                        (GpuVendor::Nvidia, Err(e)) => format!("NVIDIA VRAM unavailable: {e}"),
                        (GpuVendor::Intel, _) if kind == GpuKind::Integrated => "Integrated GPU shares system memory".into(),
                        _ => "Driver does not expose VRAM through sysfs".into(),
                    };
                    d.dedicated_bytes = Field::unknown("sysfs", why);
                }
            }
            if vendor == GpuVendor::Nvidia {
                d.backend_hints = vec!["cuda".into()];
                if let Err(e) = &nv {
                    r.errors.push(format!("NVIDIA GPU found but VRAM could not be read: {e}"));
                }
            }
            r.gpus.push(d);
        }
    }

    fn form_factor_signals(&self, env: &dyn Env, _r: &mut HardwareReport) -> ChassisSignals {
        let chassis = read_trim(env, "/sys/class/dmi/id/chassis_type").and_then(|s| s.parse::<u32>().ok());
        let mut battery = None;
        if let Ok(list) = env.list_dir("/sys/class/power_supply") {
            battery = Some(list.iter().any(|ps| {
                let t = read_trim(env, &format!("/sys/class/power_supply/{ps}/type")).unwrap_or_default();
                let scope = read_trim(env, &format!("/sys/class/power_supply/{ps}/scope")).unwrap_or_default();
                t == "Battery" && scope != "Device"
            }));
        }
        let vendor = read_trim(env, "/sys/class/dmi/id/sys_vendor").unwrap_or_default();
        let product = read_trim(env, "/sys/class/dmi/id/product_name").unwrap_or_default();
        let mut hint = vm_hint(&vendor, &product);
        if hint.is_none() {
            if let Ok(cpu) = env.read_file("/proc/cpuinfo") {
                if cpu.lines().any(|l| l.starts_with("flags") && l.split_whitespace().any(|f| f == "hypervisor")) {
                    hint = Some("CPU hypervisor flag".into());
                }
            }
        }
        ChassisSignals {
            chassis_types: chassis.into_iter().collect(),
            has_battery: battery,
            model_name: None,
            is_vm: Some(hint.is_some()),
            vm_hint: hint,
            source: "DMI sysfs / power_supply".into(),
        }
    }
}

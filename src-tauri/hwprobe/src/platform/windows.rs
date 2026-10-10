//! Windows adapter: DXGI for dedicated vs shared GPU memory (never summed), NVML for live
//! NVIDIA free VRAM, CIM (PowerShell, read-only) for chassis/battery/VM signals.

use super::native::DxgiAdapter;
use super::NvidiaSource;
use crate::classify::ChassisSignals;
use crate::parsers::{is_virtual_pci_vendor, parse_windows_cim, vendor_from_name, vendor_from_pci, vm_hint, WinCim};
use crate::{Confidence, Env, Field, GpuDevice, GpuKind, GpuVendor, HardwareReport, SystemProbe, GIB};
use std::cell::RefCell;

pub type DxgiFn = Box<dyn Fn() -> Result<Vec<DxgiAdapter>, String>>;

/// Fixed, read-only PowerShell query (no user input is ever interpolated).
pub const CIM_SCRIPT: &str = "$ErrorActionPreference='SilentlyContinue';\
[pscustomobject]@{\
enclosure=@(Get-CimInstance Win32_SystemEnclosure | Select-Object ChassisTypes);\
batteryCount=@(Get-CimInstance Win32_Battery).Count;\
computerSystem=(Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,HypervisorPresent);\
video=@(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion,PNPDeviceID);\
os=(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version)\
} | ConvertTo-Json -Depth 4 -Compress";

pub struct WinProbe {
    dxgi: DxgiFn,
    nvidia: Box<dyn NvidiaSource>,
    cim: RefCell<Option<WinCim>>,
}

impl WinProbe {
    pub fn new(dxgi: DxgiFn, nvidia: Box<dyn NvidiaSource>) -> Self {
        Self { dxgi, nvidia, cim: RefCell::new(None) }
    }
    fn cim(&self, env: &dyn Env, r: &mut HardwareReport) -> Option<WinCim> {
        if self.cim.borrow().is_none() {
            match env.run("powershell", &["-NoProfile", "-NonInteractive", "-Command", CIM_SCRIPT]).and_then(|s| parse_windows_cim(&s)) {
                Ok(c) => *self.cim.borrow_mut() = Some(c),
                Err(e) => r.errors.push(format!("CIM query failed: {e}")),
            }
        }
        self.cim.borrow().clone()
    }
}

fn classify_kind(vendor: GpuVendor, name: &str, dedicated: u64) -> GpuKind {
    let n = name.to_lowercase();
    match vendor {
        GpuVendor::Microsoft => GpuKind::Virtual,
        GpuVendor::Intel if n.contains("arc") && !n.contains("arc(tm) graphics") && dedicated >= 2 * GIB => GpuKind::Discrete,
        GpuVendor::Intel => GpuKind::Integrated,
        _ if dedicated >= 2 * GIB => GpuKind::Discrete,
        _ if dedicated > 0 => GpuKind::Integrated,
        _ => GpuKind::Unknown,
    }
}

impl SystemProbe for WinProbe {
    fn os_version(&self, env: &dyn Env) -> Option<String> {
        let _ = env;
        None
    }

    fn gpus(&self, env: &dyn Env, r: &mut HardwareReport) {
        let nv = self.nvidia.query(env).ok().map(|(rows, src)| (rows, src));
        let mut nv_rows = nv.as_ref().map(|(r, _)| r.clone()).unwrap_or_default();
        let nv_src = nv.as_ref().map(|(_, s)| s.clone()).unwrap_or_default();

        match (self.dxgi)() {
            Ok(adapters) => {
                let mut idx = 0;
                for a in adapters.iter().filter(|a| !a.is_software) {
                    let vendor = vendor_from_pci(a.vendor_id);
                    if is_virtual_pci_vendor(a.vendor_id) && vendor != GpuVendor::Microsoft {
                        continue;
                    }
                    let kind = classify_kind(vendor, &a.name, a.dedicated_video);
                    if kind == GpuKind::Virtual {
                        continue;
                    }
                    let mut d = GpuDevice::new(format!("gpu{idx}"), a.name.trim(), vendor, kind);
                    idx += 1;
                    d.dedicated_bytes = if a.dedicated_video > 0 {
                        Field::known(a.dedicated_video, "DXGI DedicatedVideoMemory", if kind == GpuKind::Integrated { Confidence::Medium } else { Confidence::High })
                    } else {
                        Field::unknown("DXGI", "No dedicated video memory reported")
                    };
                    // Shared system memory is informational only and never added to VRAM.
                    if a.shared_system > 0 {
                        d.shared_bytes = Field::known(a.shared_system, "DXGI SharedSystemMemory (system RAM the GPU may borrow; not VRAM)", Confidence::High);
                    }
                    // Live free VRAM: NVML (NVIDIA) preferred, else DXGI budget − usage.
                    let nv_match = if vendor == GpuVendor::Nvidia {
                        let pos = nv_rows.iter().position(|row| row.name.trim() == a.name.trim()).or(if nv_rows.is_empty() { None } else { Some(0) });
                        pos.map(|p| nv_rows.remove(p))
                    } else {
                        None
                    };
                    if let Some(row) = nv_match {
                        d.free_bytes = Field::known(row.free_bytes, format!("{nv_src} (live)"), Confidence::High);
                        d.driver_version = row.driver.clone();
                    } else if let (Some(b), Some(u)) = (a.local_budget, a.local_usage) {
                        if kind == GpuKind::Discrete {
                            d.free_bytes = Field::known(b.saturating_sub(u), "DXGI local budget − usage (approximate, live)", Confidence::Medium);
                        }
                    } else {
                        d.free_bytes = Field::unknown("DXGI", "Free VRAM not exposed by this driver");
                    }
                    d.backend_hints = match vendor {
                        GpuVendor::Nvidia => vec!["cuda".into()],
                        GpuVendor::Amd => vec!["rocm".into(), "vulkan".into()],
                        _ => vec![],
                    };
                    r.gpus.push(d);
                }
            }
            Err(e) => {
                r.errors.push(format!("DXGI unavailable ({e}); falling back to Win32_VideoController (VRAM capped at 4 GiB, low confidence)."));
                if let Some(cim) = self.cim(env, r) {
                    // Each NVML row describes one card: match by name, otherwise take them in order.
                    let mut nv_taken = vec![false; nv_rows.len()];
                    for (i, v) in cim.video.iter().enumerate() {
                        let vendor = v.pci.map(|(ven, _)| vendor_from_pci(ven)).unwrap_or_else(|| vendor_from_name(&v.name));
                        let ram = v.adapter_ram.unwrap_or(0);
                        let kind = classify_kind(vendor, &v.name, ram);
                        if kind == GpuKind::Virtual {
                            continue;
                        }
                        let mut d = GpuDevice::new(format!("gpu{i}"), v.name.clone(), vendor, kind);
                        d.driver_version = v.driver_version.clone();
                        if ram > 0 {
                            d.dedicated_bytes = Field::known(ram, "Win32_VideoController.AdapterRAM (32-bit, may be capped)", Confidence::Low);
                        }
                        if vendor == GpuVendor::Nvidia {
                            let want = v.name.to_lowercase();
                            let pick = (0..nv_rows.len())
                                .find(|&k| !nv_taken[k] && nv_rows[k].name.to_lowercase() == want)
                                .or_else(|| (0..nv_rows.len()).find(|&k| !nv_taken[k]));
                            if let Some(k) = pick {
                                nv_taken[k] = true;
                                let row = &nv_rows[k];
                                d.dedicated_bytes = Field::known(row.total_bytes, nv_src.clone(), Confidence::High);
                                d.free_bytes = Field::known(row.free_bytes, format!("{nv_src} (live)"), Confidence::High);
                                // Promote to discrete when NVML confirms capacity.
                                if row.total_bytes >= 2 * GIB {
                                    d.kind = GpuKind::Discrete;
                                }
                            }
                        }
                        r.gpus.push(d);
                    }
                }
            }
        }
    }

    fn form_factor_signals(&self, env: &dyn Env, r: &mut HardwareReport) -> ChassisSignals {
        let cim = self.cim(env, r);
        let Some(c) = cim else {
            return ChassisSignals { source: "CIM unavailable".into(), ..Default::default() };
        };
        if let (Some(cap), Some(ver)) = (&c.os_caption, &c.os_version) {
            r.os.version = format!("{} ({ver})", cap.trim_start_matches("Microsoft ").trim());
        }
        let hint = vm_hint(c.manufacturer.as_deref().unwrap_or(""), c.model.as_deref().unwrap_or(""));
        ChassisSignals {
            chassis_types: c.chassis_types.clone(),
            has_battery: c.battery_count.map(|n| n > 0),
            model_name: None,
            // HypervisorPresent is also true on hosts with Hyper-V/VBS enabled, so only the
            // manufacturer/model strings count as VM evidence.
            is_vm: Some(hint.is_some()),
            vm_hint: hint,
            source: "Windows CIM (Win32_SystemEnclosure, Win32_Battery)".into(),
        }
    }
}

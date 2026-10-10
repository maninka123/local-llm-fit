//! macOS adapter: system_profiler (GPU + model), Metal working-set limit, pmset battery.

use crate::classify::ChassisSignals;
use crate::parsers::{parse_system_profiler, MacInfo};
use crate::{Confidence, Env, Field, GpuDevice, GpuKind, HardwareReport, SystemProbe};
use std::cell::RefCell;

pub type WorkingSetFn = Box<dyn Fn() -> Option<u64>>;

pub struct MacProbe {
    working_set: WorkingSetFn,
    info: RefCell<Option<MacInfo>>,
}

impl MacProbe {
    pub fn new(working_set: WorkingSetFn) -> Self {
        Self { working_set, info: RefCell::new(None) }
    }
}

impl SystemProbe for MacProbe {
    fn gpus(&self, env: &dyn Env, r: &mut HardwareReport) {
        let info = match env.run("system_profiler", &["-json", "SPDisplaysDataType", "SPHardwareDataType"]).and_then(|s| parse_system_profiler(&s)) {
            Ok(i) => i,
            Err(e) => {
                r.errors.push(format!("GPU detection failed: {e}"));
                return;
            }
        };
        if let Some(chip) = &info.chip {
            if r.cpu.brand.is_empty() || r.cpu.brand == "Unknown CPU" {
                r.cpu.brand = chip.clone();
            }
        }
        for (i, g) in info.gpus.iter().enumerate() {
            let mut d = GpuDevice::new(format!("gpu{i}"), g.name.clone(), g.vendor, g.kind);
            d.external = Some(g.external);
            match g.kind {
                GpuKind::Unified => {
                    d.dedicated_bytes = Field::unknown("Apple Silicon", "Unified memory: there is no separate VRAM");
                    d.free_bytes = Field::unknown("Apple Silicon", "Unified memory: see system memory");
                    d.backend_hints = vec!["metal".into()];
                    if let Some(c) = g.cores {
                        d.name = format!("{} ({c}-core GPU)", g.name);
                    }
                }
                GpuKind::Discrete => {
                    d.dedicated_bytes = match g.vram_bytes {
                        Some(b) => Field::known(b, "system_profiler spdisplays_vram", Confidence::High),
                        None => Field::unknown("system_profiler", "VRAM not reported"),
                    };
                    d.free_bytes = Field::unknown("macOS", "macOS does not expose free VRAM for discrete GPUs");
                    d.backend_hints = vec!["metal".into()];
                }
                _ => {
                    d.dedicated_bytes = Field::unknown("system_profiler", "Integrated GPU shares system memory");
                    if let Some(s) = g.shared_vram_bytes {
                        d.shared_bytes = Field::known(s, "system_profiler spdisplays_vram_shared", Confidence::Medium);
                    }
                }
            }
            r.gpus.push(d);
        }
        if info.gpus.iter().any(|g| g.kind == GpuKind::Unified) {
            r.unified_gpu_working_set_bytes = match (self.working_set)() {
                Some(b) => Field::known(b, "Metal recommendedMaxWorkingSetSize", Confidence::High),
                None => Field::unknown("Metal", "Metal working-set limit not available"),
            };
            r.notes.push("Apple Silicon: CPU and GPU share one unified memory pool.".into());
        }
        *self.info.borrow_mut() = Some(info);
    }

    fn form_factor_signals(&self, env: &dyn Env, _r: &mut HardwareReport) -> ChassisSignals {
        let info = self.info.borrow();
        let has_battery = env.run("pmset", &["-g", "batt"]).ok().map(|s| s.contains("InternalBattery"));
        let is_vm = env.run("sysctl", &["-n", "kern.hv_vmm_present"]).ok().map(|s| s.trim() == "1");
        ChassisSignals {
            chassis_types: vec![],
            has_battery,
            model_name: info.as_ref().and_then(|i| i.model_name.clone()),
            is_vm,
            vm_hint: if is_vm == Some(true) { Some("hypervisor present".into()) } else { None },
            source: "system_profiler / pmset".into(),
        }
    }
}

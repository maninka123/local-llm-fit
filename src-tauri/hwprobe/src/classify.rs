//! Form-factor and memory-architecture classification from collected signals.

use crate::{Confidence, Field, FormFactor, GpuKind, GpuVendor, HardwareReport, MemoryArchitecture, GIB};

#[derive(Debug, Default, Clone)]
pub struct ChassisSignals {
    /// SMBIOS chassis type codes (Windows Win32_SystemEnclosure / Linux DMI).
    pub chassis_types: Vec<u32>,
    pub has_battery: Option<bool>,
    /// e.g. "MacBook Pro", "Mac Studio".
    pub model_name: Option<String>,
    pub is_vm: Option<bool>,
    pub vm_hint: Option<String>,
    pub source: String,
}

/// SMBIOS 3.x System Enclosure types.
pub fn chassis_to_form_factor(code: u32) -> Option<FormFactor> {
    match code {
        3 | 4 | 5 | 6 | 7 | 13 | 15 | 16 | 24 | 35 | 36 => Some(FormFactor::Desktop),
        8 | 9 | 10 | 11 | 12 | 14 | 30 | 31 | 32 => Some(FormFactor::Laptop),
        17 | 23 | 25 | 28 | 29 => Some(FormFactor::Server),
        _ => None,
    }
}

pub fn chassis_name(code: u32) -> &'static str {
    match code {
        3 => "Desktop",
        4 => "Low Profile Desktop",
        5 => "Pizza Box",
        6 => "Mini Tower",
        7 => "Tower",
        8 => "Portable",
        9 => "Laptop",
        10 => "Notebook",
        11 => "Hand Held",
        12 => "Docking Station",
        13 => "All in One",
        14 => "Sub Notebook",
        15 => "Space-saving",
        16 => "Lunch Box",
        17 => "Main Server Chassis",
        23 => "Rack Mount Chassis",
        24 => "Sealed-case PC",
        28 => "Blade",
        30 => "Tablet",
        31 => "Convertible",
        32 => "Detachable",
        35 => "Mini PC",
        36 => "Stick PC",
        _ => "Other/Unknown",
    }
}

fn is_workstation_cpu(brand: &str) -> bool {
    let b = brand.to_lowercase();
    b.contains("xeon") || b.contains("threadripper") || b.contains("epyc")
}

pub fn apply_form_factor(r: &mut HardwareReport, s: &ChassisSignals) {
    let mut ev: Vec<String> = Vec::new();
    if let Some(b) = s.has_battery {
        r.has_battery = Field::known(b, s.source.clone(), Confidence::High);
        ev.push(if b { "Battery present".into() } else { "No battery detected".into() });
    }
    if let Some(vm) = s.is_vm {
        r.is_virtual_machine = Field::known(vm, s.source.clone(), Confidence::Medium);
        if vm {
            ev.push(format!("Virtual machine indicators{}", s.vm_hint.as_deref().map(|h| format!(": {h}")).unwrap_or_default()));
        }
    }
    for c in &s.chassis_types {
        ev.push(format!("Chassis type {c} ({})", chassis_name(*c)));
    }
    if let Some(m) = &s.model_name {
        ev.push(format!("Model: {m}"));
    }

    let mut ff: Option<(FormFactor, Confidence)> = None;
    if s.is_vm == Some(true) {
        ff = Some((FormFactor::VirtualMachine, Confidence::Medium));
    }
    if ff.is_none() {
        if let Some(m) = &s.model_name {
            let m = m.to_lowercase();
            ff = if m.contains("macbook") {
                Some((FormFactor::Laptop, Confidence::High))
            } else if m.contains("mac pro") || m.contains("mac studio") {
                Some((FormFactor::Workstation, Confidence::Medium))
            } else if m.contains("mac mini") || m.contains("imac") {
                Some((FormFactor::Desktop, Confidence::High))
            } else if ["raspberry pi", "jetson", "orange pi", "radxa", "rock 5", "odroid", "khadas", "beaglebone", "libre computer"].iter().any(|b| m.contains(b)) {
                Some((FormFactor::Embedded, Confidence::High))
            } else {
                None
            };
        }
    }
    if ff.is_none() {
        let from_chassis = s.chassis_types.iter().find_map(|c| chassis_to_form_factor(*c));
        ff = match (from_chassis, s.has_battery) {
            (Some(FormFactor::Laptop), _) => Some((FormFactor::Laptop, Confidence::High)),
            (Some(FormFactor::Desktop), Some(true)) => Some((FormFactor::Laptop, Confidence::Low)), // conflicting signals
            (Some(f), _) => Some((f, Confidence::High)),
            (None, Some(true)) => Some((FormFactor::Laptop, Confidence::Medium)), // "Likely laptop"
            (None, _) => None,
        };
    }
    // Workstation: desktop/tower with workstation-class CPU, ≥2 discrete GPUs, or ≥96 GiB RAM.
    if let Some((FormFactor::Desktop, _)) = ff {
        let discrete = r.gpus.iter().filter(|g| g.kind == GpuKind::Discrete).count();
        let big_ram = r.memory.total_bytes.value.map(|t| t >= 96 * GIB).unwrap_or(false);
        if is_workstation_cpu(&r.cpu.brand) || discrete >= 2 || big_ram {
            ev.push("Workstation-class CPU, multiple GPUs or very large RAM".into());
            ff = Some((FormFactor::Workstation, Confidence::Medium));
        }
    }
    r.form_factor = match ff {
        Some((f, c)) => Field::known(f, s.source.clone(), c),
        None => Field::unknown(s.source.clone(), "No chassis, battery or model signal available"),
    };
    r.form_factor_evidence = ev;
}

pub fn apply_memory_architecture(r: &mut HardwareReport) {
    let apple = r.gpus.iter().any(|g| g.vendor == GpuVendor::Apple);
    let unified = apple || r.gpus.iter().any(|g| g.kind == GpuKind::Unified);
    let discrete = r.gpus.iter().any(|g| g.kind == GpuKind::Discrete && g.dedicated_bytes.value.map(|b| b >= 2 * GIB).unwrap_or(true));
    let integrated = r.gpus.iter().any(|g| g.kind == GpuKind::Integrated);
    r.memory_architecture = if unified {
        Field::known(MemoryArchitecture::Unified, if apple { "Apple Silicon GPU" } else { "GPU shares system memory (Jetson / GB10)" }, Confidence::High)
    } else if discrete {
        Field::known(MemoryArchitecture::Discrete, "Discrete GPU with dedicated VRAM", Confidence::High)
    } else if integrated {
        Field::known(MemoryArchitecture::IntegratedShared, "Integrated GPU only (shares system RAM)", Confidence::Medium)
    } else if r.gpus.is_empty() {
        Field::known(MemoryArchitecture::CpuOnly, "No GPU detected", Confidence::Medium)
    } else {
        Field::known(MemoryArchitecture::CpuOnly, "Only virtual/unknown display adapters", Confidence::Low)
    };
}

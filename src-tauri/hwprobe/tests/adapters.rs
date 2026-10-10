//! Fixture-driven tests for every platform adapter. These run on any OS.

use hwprobe::classify::{apply_form_factor, chassis_to_form_factor, ChassisSignals};
use hwprobe::parsers::*;
use hwprobe::platform::linux::LinuxProbe;
use hwprobe::platform::macos::MacProbe;
use hwprobe::platform::native::DxgiAdapter;
use hwprobe::platform::windows::WinProbe;
use hwprobe::platform::NvidiaSource;
use hwprobe::*;
use std::collections::HashMap;

const MIB: u64 = 1024 * 1024;

#[derive(Default)]
struct FixtureEnv {
    files: HashMap<String, String>,
    dirs: HashMap<String, Vec<String>>,
    cmds: HashMap<String, Result<String, String>>,
}

impl FixtureEnv {
    fn file(mut self, p: &str, c: &str) -> Self {
        self.files.insert(p.into(), c.into());
        self
    }
    fn dir(mut self, p: &str, entries: &[&str]) -> Self {
        self.dirs.insert(p.into(), entries.iter().map(|s| s.to_string()).collect());
        self
    }
    fn cmd(mut self, program: &str, out: Result<&str, &str>) -> Self {
        self.cmds.insert(program.into(), out.map(String::from).map_err(String::from));
        self
    }
}

impl Env for FixtureEnv {
    fn run(&self, program: &str, _args: &[&str]) -> Result<String, String> {
        self.cmds.get(program).cloned().unwrap_or_else(|| Err(format!("{program}: not found")))
    }
    fn read_file(&self, path: &str) -> Result<String, String> {
        self.files.get(path).cloned().ok_or_else(|| format!("{path}: permission denied"))
    }
    fn list_dir(&self, path: &str) -> Result<Vec<String>, String> {
        self.dirs.get(path).cloned().ok_or_else(|| format!("{path}: not found"))
    }
}

struct NoNvml;
impl NvidiaSource for NoNvml {
    fn query(&self, _env: &dyn Env) -> Result<(Vec<NvRow>, String), String> {
        Err("NVML Shared Library Not Found".into())
    }
}
struct FixtureNvml(Vec<NvRow>);
impl NvidiaSource for FixtureNvml {
    fn query(&self, _env: &dyn Env) -> Result<(Vec<NvRow>, String), String> {
        Ok((self.0.clone(), "NVML".into()))
    }
}

fn empty_report(total_gib: u64) -> HardwareReport {
    let mut r = base_report();
    r.memory.total_bytes = Field::known(total_gib * GIB, "fixture", Confidence::High);
    r.gpus.clear();
    r.errors.clear();
    r.notes.clear();
    r.cpu.brand = "Fixture CPU".into();
    r
}

// ------------------------------------------------------------------ parsers

#[test]
fn parses_size_strings() {
    assert_eq!(parse_size_str("8 GB"), Some(8 * GIB));
    assert_eq!(parse_size_str("1536 MB"), Some(1536 * MIB));
    assert_eq!(parse_size_str("garbage"), None);
}

#[test]
fn parses_nvidia_smi() {
    let rows = parse_nvidia_smi(include_str!("fixtures/linux_nvidia_smi.csv"));
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].name, "NVIDIA GeForce RTX 4090");
    assert_eq!(rows[0].total_bytes, 24564 * MIB);
    assert_eq!(rows[1].free_bytes, 9000 * MIB);
    assert!(parse_nvidia_smi("NVIDIA-SMI has failed").is_empty());
}

#[test]
fn parses_pnp_and_vendors() {
    assert_eq!(parse_pnp_ids("PCI\\VEN_10DE&DEV_2705&SUBSYS"), Some((0x10de, 0x2705)));
    assert_eq!(vendor_from_pci(0x1002), GpuVendor::Amd);
    assert!(is_virtual_pci_vendor(0x15ad));
    assert_eq!(vm_hint("QEMU", "Standard PC (Q35 + ICH9, 2009)").as_deref(), Some("QEMU/KVM"));
    assert_eq!(vm_hint("Dell Inc.", "XPS 15"), None);
}

#[test]
fn chassis_codes() {
    assert_eq!(chassis_to_form_factor(10), Some(FormFactor::Laptop));
    assert_eq!(chassis_to_form_factor(3), Some(FormFactor::Desktop));
    assert_eq!(chassis_to_form_factor(23), Some(FormFactor::Server));
    assert_eq!(chassis_to_form_factor(2), None);
}

// ------------------------------------------------------------------ macOS

#[test]
fn macos_apple_silicon_is_unified_without_vram() {
    let env = FixtureEnv::default()
        .cmd("system_profiler", Ok(include_str!("fixtures/macos_m3_system_profiler.json")))
        .cmd("pmset", Ok("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charged; present: true"))
        .cmd("sysctl", Ok("0\n"));
    let mut r = empty_report(16);
    let p = MacProbe::new(Box::new(|| Some(12_713_115_648)));
    run_probe(&p, &env, &mut r);
    assert_eq!(r.memory_architecture.value, Some(MemoryArchitecture::Unified));
    assert_eq!(r.gpus.len(), 1);
    assert_eq!(r.gpus[0].kind, GpuKind::Unified);
    assert!(r.gpus[0].dedicated_bytes.value.is_none(), "must not invent discrete VRAM on Apple Silicon");
    assert_eq!(r.unified_gpu_working_set_bytes.value, Some(12_713_115_648));
    assert_eq!(r.form_factor.value, Some(FormFactor::Laptop));
    assert_eq!(r.has_battery.value, Some(true));
}

#[test]
fn macos_metal_unavailable_is_reported_unknown() {
    let env = FixtureEnv::default().cmd("system_profiler", Ok(include_str!("fixtures/macos_m3_system_profiler.json")));
    let mut r = empty_report(16);
    run_probe(&MacProbe::new(Box::new(|| None)), &env, &mut r);
    assert!(r.unified_gpu_working_set_bytes.value.is_none());
    assert!(r.unified_gpu_working_set_bytes.error.is_some());
    // pmset missing → battery unknown, but model name still classifies the laptop
    assert_eq!(r.form_factor.value, Some(FormFactor::Laptop));
}

#[test]
fn macos_intel_with_discrete_amd() {
    let env = FixtureEnv::default().cmd("system_profiler", Ok(include_str!("fixtures/macos_intel_amd_system_profiler.json")));
    let mut r = empty_report(32);
    run_probe(&MacProbe::new(Box::new(|| None)), &env, &mut r);
    assert_eq!(r.memory_architecture.value, Some(MemoryArchitecture::Discrete));
    let amd = r.gpus.iter().find(|g| g.vendor == GpuVendor::Amd).unwrap();
    assert_eq!(amd.dedicated_bytes.value, Some(8 * GIB));
    assert!(amd.free_bytes.value.is_none());
    let intel = r.gpus.iter().find(|g| g.vendor == GpuVendor::Intel).unwrap();
    assert_eq!(intel.kind, GpuKind::Integrated);
    assert!(intel.dedicated_bytes.value.is_none(), "shared iGPU memory is not dedicated VRAM");
}

#[test]
fn macos_system_profiler_failure_still_returns_report() {
    let env = FixtureEnv::default();
    let mut r = empty_report(8);
    run_probe(&MacProbe::new(Box::new(|| None)), &env, &mut r);
    assert!(!r.errors.is_empty());
    assert_eq!(r.memory_architecture.value, Some(MemoryArchitecture::CpuOnly));
}

// ------------------------------------------------------------------ Linux

fn linux_amd_env() -> FixtureEnv {
    FixtureEnv::default()
        .dir("/sys/class/drm", &["card0", "card0-DP-1", "card1", "renderD128", "version"])
        .file("/sys/class/drm/card0/device/vendor", "0x1002\n")
        .file("/sys/class/drm/card0/device/device", "0x744c\n")
        .file("/sys/class/drm/card0/device/uevent", "DRIVER=amdgpu\nPCI_SLOT_NAME=0000:03:00.0\n")
        .file("/sys/class/drm/card0/device/mem_info_vram_total", &(24 * GIB).to_string())
        .file("/sys/class/drm/card0/device/mem_info_vram_used", &(2 * GIB).to_string())
        .file("/sys/class/drm/card1/device/vendor", "0x8086\n")
        .file("/sys/class/drm/card1/device/device", "0xa780\n")
        .cmd("lspci", Ok("03:00.0 \"VGA compatible controller\" \"Advanced Micro Devices, Inc. [AMD/ATI]\" \"Navi 31 [Radeon RX 7900 XTX]\" -r00 \"\" \"\"\n"))
        .file("/sys/class/dmi/id/chassis_type", "3\n")
        .file("/sys/class/dmi/id/sys_vendor", "ASUS\n")
        .file("/sys/class/dmi/id/product_name", "System Product Name\n")
        .dir("/sys/class/power_supply", &["hidpp_battery_0"])
        .file("/sys/class/power_supply/hidpp_battery_0/type", "Battery")
        .file("/sys/class/power_supply/hidpp_battery_0/scope", "Device")
}

#[test]
fn linux_amd_reads_sysfs_vram_and_ignores_mouse_battery() {
    let mut r = empty_report(64);
    run_probe(&LinuxProbe::new(Box::new(NoNvml)), &linux_amd_env(), &mut r);
    let amd = r.gpus.iter().find(|g| g.vendor == GpuVendor::Amd).unwrap();
    assert_eq!(amd.kind, GpuKind::Discrete);
    assert!(amd.name.contains("7900 XTX"));
    assert_eq!(amd.dedicated_bytes.value, Some(24 * GIB));
    assert_eq!(amd.free_bytes.value, Some(22 * GIB));
    assert_eq!(r.memory_architecture.value, Some(MemoryArchitecture::Discrete));
    assert_eq!(r.has_battery.value, Some(false), "a wireless mouse battery is not a laptop battery");
    assert_eq!(r.form_factor.value, Some(FormFactor::Desktop));
}

#[test]
fn linux_nvidia_with_nvml() {
    let rows = parse_nvidia_smi(include_str!("fixtures/linux_nvidia_smi.csv"));
    let env = FixtureEnv::default()
        .dir("/sys/class/drm", &["card0"])
        .file("/sys/class/drm/card0/device/vendor", "0x10de")
        .file("/sys/class/drm/card0/device/device", "0x2684")
        .file("/sys/class/dmi/id/chassis_type", "7");
    let mut r = empty_report(128);
    run_probe(&LinuxProbe::new(Box::new(FixtureNvml(rows))), &env, &mut r);
    assert_eq!(r.gpus.len(), 2, "NVML rows replace the DRM NVIDIA card (no duplicates)");
    assert_eq!(r.gpus[0].free_bytes.value, Some(23170 * MIB));
    // two discrete GPUs + tower chassis → workstation
    assert_eq!(r.form_factor.value, Some(FormFactor::Workstation));
}

#[test]
fn linux_nvml_unavailable_still_functions() {
    let env = FixtureEnv::default()
        .dir("/sys/class/drm", &["card0"])
        .file("/sys/class/drm/card0/device/vendor", "0x10de")
        .file("/sys/class/drm/card0/device/device", "0x2684");
    let mut r = empty_report(32);
    run_probe(&LinuxProbe::new(Box::new(NoNvml)), &env, &mut r);
    assert_eq!(r.gpus.len(), 1);
    assert!(r.gpus[0].dedicated_bytes.value.is_none());
    assert!(r.gpus[0].dedicated_bytes.error.as_deref().unwrap().contains("NVML"));
    assert!(r.errors.iter().any(|e| e.contains("VRAM could not be read")));
    assert_eq!(r.form_factor.value, None, "no DMI access → unknown, not guessed");
}

#[test]
fn linux_permissions_denied_everywhere() {
    let env = FixtureEnv::default();
    let mut r = empty_report(16);
    run_probe(&LinuxProbe::new(Box::new(NoNvml)), &env, &mut r);
    assert!(r.gpus.is_empty());
    assert_eq!(r.memory_architecture.value, Some(MemoryArchitecture::CpuOnly));
    assert!(r.form_factor.error.is_some());
}

#[test]
fn linux_vm_detected_from_dmi() {
    let env = FixtureEnv::default()
        .dir("/sys/class/drm", &["card0"])
        .file("/sys/class/drm/card0/device/vendor", "0x1234")
        .file("/sys/class/drm/card0/device/device", "0x1111")
        .file("/sys/class/dmi/id/sys_vendor", "QEMU")
        .file("/sys/class/dmi/id/product_name", "Standard PC (Q35 + ICH9, 2009)")
        .file("/sys/class/dmi/id/chassis_type", "1");
    let mut r = empty_report(8);
    run_probe(&LinuxProbe::new(Box::new(NoNvml)), &env, &mut r);
    assert_eq!(r.is_virtual_machine.value, Some(true));
    assert_eq!(r.form_factor.value, Some(FormFactor::VirtualMachine));
    assert_eq!(r.gpus[0].kind, GpuKind::Virtual);
    assert_eq!(r.memory_architecture.value, Some(MemoryArchitecture::CpuOnly));
}

// ------------------------------------------------------------------ Windows

fn dxgi_laptop() -> Vec<DxgiAdapter> {
    vec![
        DxgiAdapter {
            name: "Intel(R) Arc(TM) Graphics".into(),
            vendor_id: 0x8086,
            device_id: 0x7d55,
            dedicated_video: 128 * MIB,
            shared_system: 16 * GIB,
            ..Default::default()
        },
        DxgiAdapter {
            name: "NVIDIA GeForce RTX 4060 Laptop GPU".into(),
            vendor_id: 0x10de,
            device_id: 0x28e0,
            dedicated_video: 8 * GIB,
            shared_system: 16 * GIB,
            local_budget: Some(7 * GIB),
            local_usage: Some(GIB / 2),
            ..Default::default()
        },
        DxgiAdapter { name: "Microsoft Basic Render Driver".into(), vendor_id: 0x1414, device_id: 0x8c, is_software: true, shared_system: 16 * GIB, ..Default::default() },
    ]
}

#[test]
fn windows_shared_memory_is_never_vram() {
    let env = FixtureEnv::default().cmd("powershell", Ok(include_str!("fixtures/windows_cim.json")));
    let mut r = empty_report(32);
    let p = WinProbe::new(Box::new(|| Ok(dxgi_laptop())), Box::new(NoNvml));
    run_probe(&p, &env, &mut r);
    assert_eq!(r.gpus.len(), 2, "software adapter skipped");
    let nv = r.gpus.iter().find(|g| g.vendor == GpuVendor::Nvidia).unwrap();
    assert_eq!(nv.kind, GpuKind::Discrete);
    assert_eq!(nv.dedicated_bytes.value, Some(8 * GIB), "dedicated only; 16 GiB shared is NOT added");
    assert_eq!(nv.shared_bytes.value, Some(16 * GIB));
    assert_eq!(nv.free_bytes.value, Some(7 * GIB - GIB / 2));
    let intel = r.gpus.iter().find(|g| g.vendor == GpuVendor::Intel).unwrap();
    assert_eq!(intel.kind, GpuKind::Integrated);
    assert_eq!(r.memory_architecture.value, Some(MemoryArchitecture::Discrete));
    assert_eq!(r.form_factor.value, Some(FormFactor::Laptop));
    assert!(r.os.version.contains("Windows 11 Pro"));
}

#[test]
fn windows_prefers_nvml_for_free_vram() {
    let env = FixtureEnv::default().cmd("powershell", Ok(include_str!("fixtures/windows_cim.json")));
    let mut r = empty_report(32);
    let nv = vec![NvRow { index: 0, name: "NVIDIA GeForce RTX 4060 Laptop GPU".into(), total_bytes: 8 * GIB, free_bytes: 3 * GIB, used_bytes: 5 * GIB, driver: Some("580.88".into()) }];
    run_probe(&WinProbe::new(Box::new(|| Ok(dxgi_laptop())), Box::new(FixtureNvml(nv))), &env, &mut r);
    let g = r.gpus.iter().find(|g| g.vendor == GpuVendor::Nvidia).unwrap();
    assert_eq!(g.free_bytes.value, Some(3 * GIB), "GPU busy with another process → live NVML free is used");
    assert_eq!(g.driver_version.as_deref(), Some("580.88"));
}

#[test]
fn windows_integrated_only_is_shared_architecture() {
    let env = FixtureEnv::default().cmd("powershell", Ok(include_str!("fixtures/windows_cim.json")));
    let mut r = empty_report(16);
    let only_intel = || Ok(vec![DxgiAdapter { name: "Intel(R) UHD Graphics".into(), vendor_id: 0x8086, dedicated_video: 128 * MIB, shared_system: 8 * GIB, ..Default::default() }]);
    run_probe(&WinProbe::new(Box::new(only_intel), Box::new(NoNvml)), &env, &mut r);
    assert_eq!(r.memory_architecture.value, Some(MemoryArchitecture::IntegratedShared));
}

#[test]
fn windows_dxgi_failure_falls_back_to_cim_with_low_confidence() {
    let env = FixtureEnv::default().cmd("powershell", Ok(include_str!("fixtures/windows_cim_single.json")));
    let mut r = empty_report(32);
    run_probe(&WinProbe::new(Box::new(|| Err("E_FAIL".into())), Box::new(NoNvml)), &env, &mut r);
    assert!(r.errors.iter().any(|e| e.contains("DXGI unavailable")));
    assert_eq!(r.gpus.len(), 1);
    assert_eq!(r.gpus[0].dedicated_bytes.confidence, Confidence::Low);
    assert_eq!(r.form_factor.value, Some(FormFactor::Desktop));
}

#[test]
fn windows_everything_unavailable() {
    let env = FixtureEnv::default();
    let mut r = empty_report(16);
    run_probe(&WinProbe::new(Box::new(|| Err("no dxgi".into())), Box::new(NoNvml)), &env, &mut r);
    assert!(r.errors.len() >= 2);
    assert!(r.form_factor.value.is_none());
}

#[test]
fn conflicting_chassis_and_battery_lowers_confidence() {
    let mut r = empty_report(16);
    apply_form_factor(&mut r, &ChassisSignals { chassis_types: vec![3], has_battery: Some(true), source: "fixture".into(), ..Default::default() });
    assert_eq!(r.form_factor.value, Some(FormFactor::Laptop));
    assert_eq!(r.form_factor.confidence, Confidence::Low);
}

#[test]
fn report_serializes_camel_case() {
    let r = empty_report(16);
    let j = serde_json::to_string(&r).unwrap();
    assert!(j.contains("\"memoryArchitecture\"") && j.contains("\"unifiedGpuWorkingSetBytes\""));
}

#[test]
fn linux_jetson_orin_is_unified_cuda_and_embedded() {
    let env = FixtureEnv::default()
        .file("/proc/device-tree/model", "NVIDIA Jetson Orin Nano Engineering Reference Developer Kit Super\0")
        .dir("/sys/class/drm", &[]);
    let mut r = empty_report(8);
    run_probe(&LinuxProbe::new(Box::new(NoNvml)), &env, &mut r);
    assert_eq!(r.gpus.len(), 1);
    assert_eq!(r.gpus[0].kind, GpuKind::Unified);
    assert_eq!(r.gpus[0].vendor, GpuVendor::Nvidia);
    assert_eq!(r.memory_architecture.value, Some(MemoryArchitecture::Unified));
    assert_eq!(r.form_factor.value, Some(FormFactor::Embedded));
}

#[test]
fn linux_raspberry_pi_is_cpu_only_embedded() {
    let env = FixtureEnv::default().file("/proc/device-tree/model", "Raspberry Pi 5 Model B Rev 1.0\0").dir("/sys/class/drm", &["card0", "card1"]);
    let mut r = empty_report(8);
    run_probe(&LinuxProbe::new(Box::new(NoNvml)), &env, &mut r);
    assert_eq!(r.form_factor.value, Some(FormFactor::Embedded));
    assert!(r.form_factor_evidence.iter().any(|e| e == "Model: Raspberry Pi 5 Model B Rev 1.0"));
    assert_ne!(r.memory_architecture.value, Some(MemoryArchitecture::Unified));
    assert_ne!(r.memory_architecture.value, Some(MemoryArchitecture::Discrete));
}

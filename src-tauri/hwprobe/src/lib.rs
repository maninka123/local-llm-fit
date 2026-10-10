//! Cross-platform hardware probe for local-model fit estimates.
//!
//! Design rules:
//! * No privileged operations. Every field carries `source`, `confidence` and an optional
//!   `error` explaining why it is unknown.
//! * Dedicated VRAM and Windows "shared GPU memory" are reported separately and never summed.
//! * Apple Silicon is reported as unified memory with no invented "VRAM" figure.
//! * Platform adapters read the system through the [`Env`] trait so they can be tested with
//!   fixtures on any OS.

use serde::{Deserialize, Serialize};

pub mod classify;
pub mod parsers;
pub mod platform;

pub const PROBE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const GIB: u64 = 1 << 30;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    Medium,
    Low,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Field<T> {
    pub value: Option<T>,
    pub source: String,
    pub confidence: Confidence,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T> Field<T> {
    pub fn known(value: T, source: impl Into<String>, confidence: Confidence) -> Self {
        Self { value: Some(value), source: source.into(), confidence, error: None }
    }
    pub fn unknown(source: impl Into<String>, error: impl Into<String>) -> Self {
        Self { value: None, source: source.into(), confidence: Confidence::None, error: Some(error.into()) }
    }
    pub fn is_known(&self) -> bool {
        self.value.is_some()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GpuVendor {
    Nvidia,
    Amd,
    Intel,
    Apple,
    Microsoft,
    Other,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GpuKind {
    Discrete,
    Integrated,
    Unified,
    Virtual,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuDevice {
    pub id: String,
    pub name: String,
    pub vendor: GpuVendor,
    pub kind: GpuKind,
    /// True dedicated VRAM.
    pub dedicated_bytes: Field<u64>,
    /// Live free dedicated VRAM.
    pub free_bytes: Field<u64>,
    /// Windows shared system memory available to the GPU. Informational only.
    pub shared_bytes: Field<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driver_version: Option<String>,
    pub backend_hints: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external: Option<bool>,
}

impl GpuDevice {
    pub fn new(id: impl Into<String>, name: impl Into<String>, vendor: GpuVendor, kind: GpuKind) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            vendor,
            kind,
            dedicated_bytes: Field::unknown("not probed", "Not reported"),
            free_bytes: Field::unknown("not probed", "Not reported"),
            shared_bytes: Field::unknown("not probed", "Not applicable"),
            driver_version: None,
            backend_hints: vec![],
            external: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FormFactor {
    Desktop,
    Laptop,
    Workstation,
    Server,
    VirtualMachine,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryArchitecture {
    Discrete,
    Unified,
    IntegratedShared,
    CpuOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OsInfo {
    pub name: String,
    pub version: String,
    pub arch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kernel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub brand: String,
    pub physical_cores: Option<usize>,
    pub logical_cores: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub total_bytes: Field<u64>,
    pub available_bytes: Field<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HardwareReport {
    pub probe_version: String,
    pub demo: bool,
    pub detected_at: String,
    pub os: OsInfo,
    pub form_factor: Field<FormFactor>,
    pub form_factor_evidence: Vec<String>,
    pub has_battery: Field<bool>,
    pub is_virtual_machine: Field<bool>,
    pub cpu: CpuInfo,
    pub memory: MemoryInfo,
    pub memory_architecture: Field<MemoryArchitecture>,
    pub unified_gpu_working_set_bytes: Field<u64>,
    pub gpus: Vec<GpuDevice>,
    pub errors: Vec<String>,
    pub notes: Vec<String>,
}

/// Live memory sample used during benchmarks.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemorySample {
    pub ram_used_bytes: Option<u64>,
    pub ram_available_bytes: Option<u64>,
    pub vram_used_bytes: Option<u64>,
    pub vram_source: Option<String>,
}

/// Abstraction over the OS so adapters can be tested with fixtures.
pub trait Env {
    /// Run a fixed command (never user-supplied). Returns stdout on success.
    fn run(&self, program: &str, args: &[&str]) -> Result<String, String>;
    fn read_file(&self, path: &str) -> Result<String, String>;
    fn list_dir(&self, path: &str) -> Result<Vec<String>, String>;
}

/// Real environment.
pub struct RealEnv;

impl Env for RealEnv {
    fn run(&self, program: &str, args: &[&str]) -> Result<String, String> {
        let mut cmd = std::process::Command::new(program);
        cmd.args(args);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let out = cmd.output().map_err(|e| format!("{program}: {e}"))?;
        if !out.status.success() {
            return Err(format!("{program} exited with {}", out.status));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
    fn read_file(&self, path: &str) -> Result<String, String> {
        std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))
    }
    fn list_dir(&self, path: &str) -> Result<Vec<String>, String> {
        let rd = std::fs::read_dir(path).map_err(|e| format!("{path}: {e}"))?;
        let mut v: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        Ok(v)
    }
}

/// Platform-specific GPU/form-factor detection.
pub trait SystemProbe {
    fn gpus(&self, env: &dyn Env, report: &mut HardwareReport);
    fn form_factor_signals(&self, env: &dyn Env, report: &mut HardwareReport) -> classify::ChassisSignals;
    fn os_version(&self, env: &dyn Env) -> Option<String> {
        let _ = env;
        None
    }
}

/// Common CPU / RAM / OS information through `sysinfo`.
pub fn base_report() -> HardwareReport {
    use sysinfo::{MemoryRefreshKind, RefreshKind, System};
    let sys = System::new_with_specifics(RefreshKind::nothing().with_memory(MemoryRefreshKind::everything()).with_cpu(sysinfo::CpuRefreshKind::nothing()));
    let brand = sys.cpus().first().map(|c| c.brand().trim().to_string()).filter(|b| !b.is_empty()).unwrap_or_else(|| "Unknown CPU".into());
    let total = sys.total_memory();
    let avail = sys.available_memory();
    HardwareReport {
        probe_version: PROBE_VERSION.into(),
        demo: false,
        detected_at: chrono::Utc::now().to_rfc3339(),
        os: OsInfo {
            name: match std::env::consts::OS {
                "macos" => "macOS".to_string(),
                "windows" => "Windows".to_string(),
                _ => System::name().unwrap_or_else(|| std::env::consts::OS.into()),
            },
            version: System::os_version().unwrap_or_default(),
            arch: std::env::consts::ARCH.into(),
            kernel: System::kernel_version(),
        },
        form_factor: Field::unknown("not probed", "Not determined"),
        form_factor_evidence: vec![],
        has_battery: Field::unknown("not probed", "Not determined"),
        is_virtual_machine: Field::unknown("not probed", "Not determined"),
        cpu: CpuInfo {
            brand,
            physical_cores: System::physical_core_count(),
            logical_cores: Some(sys.cpus().len()).filter(|n| *n > 0),
        },
        memory: MemoryInfo {
            total_bytes: if total > 0 { Field::known(total, "sysinfo", Confidence::High) } else { Field::unknown("sysinfo", "Total memory not reported") },
            available_bytes: if avail > 0 {
                Field::known(avail, "sysinfo (available memory, live)", Confidence::Medium)
            } else {
                Field::unknown("sysinfo", "Available memory not reported")
            },
        },
        memory_architecture: Field::unknown("not probed", "Not determined"),
        unified_gpu_working_set_bytes: Field::unknown("n/a", "Not applicable"),
        gpus: vec![],
        errors: vec![],
        notes: vec![],
    }
}

/// Full probe on the current OS.
pub fn probe() -> HardwareReport {
    let env = RealEnv;
    let mut report = base_report();
    let p = platform::current();
    run_probe(p.as_ref(), &env, &mut report);
    report
}

/// Shared pipeline used by the real probe and by fixture tests.
pub fn run_probe(p: &dyn SystemProbe, env: &dyn Env, report: &mut HardwareReport) {
    if let Some(v) = p.os_version(env) {
        report.os.version = v;
    }
    p.gpus(env, report);
    let signals = p.form_factor_signals(env, report);
    classify::apply_form_factor(report, &signals);
    classify::apply_memory_architecture(report);
}

/// Lightweight live memory sample (RAM + best-effort VRAM).
pub fn sample_memory() -> MemorySample {
    use sysinfo::{MemoryRefreshKind, RefreshKind, System};
    let sys = System::new_with_specifics(RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()));
    let total = sys.total_memory();
    let avail = sys.available_memory();
    let (vram, src) = platform::vram_used_sample();
    MemorySample {
        ram_used_bytes: if total > 0 { Some(total.saturating_sub(avail)) } else { None },
        ram_available_bytes: if avail > 0 { Some(avail) } else { None },
        vram_used_bytes: vram,
        vram_source: src,
    }
}

//! Platform adapters. Adapter logic compiles on every OS (so fixtures test it anywhere);
//! only the native sources in `native` are cfg-gated.

pub mod linux;
pub mod macos;
pub mod native;
pub mod windows;

use crate::SystemProbe;

/// Source of NVIDIA GPU data (NVML, falling back to nvidia-smi).
pub trait NvidiaSource {
    fn query(&self, env: &dyn crate::Env) -> Result<(Vec<crate::parsers::NvRow>, String), String>;
}

/// NVML first, then the `nvidia-smi` CLI (which itself uses NVML) as a fallback.
pub struct DefaultNvidia;

impl NvidiaSource for DefaultNvidia {
    fn query(&self, env: &dyn crate::Env) -> Result<(Vec<crate::parsers::NvRow>, String), String> {
        match native::nvml_query() {
            Ok(rows) => Ok((rows, "NVML".into())),
            Err(nvml_err) => {
                let out = env
                    .run("nvidia-smi", &["--query-gpu=index,name,memory.total,memory.free,memory.used,driver_version", "--format=csv,noheader,nounits"])
                    .map_err(|e| format!("NVML unavailable ({nvml_err}); nvidia-smi unavailable ({e})"))?;
                let rows = crate::parsers::parse_nvidia_smi(&out);
                if rows.is_empty() {
                    Err(format!("NVML unavailable ({nvml_err}); nvidia-smi returned no GPUs"))
                } else {
                    Ok((rows, "nvidia-smi".into()))
                }
            }
        }
    }
}

pub fn current() -> Box<dyn SystemProbe> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacProbe::new(Box::new(|| native::metal_working_set())))
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WinProbe::new(Box::new(native::dxgi_adapters), Box::new(DefaultNvidia)))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Box::new(linux::LinuxProbe::new(Box::new(DefaultNvidia)))
    }
}

/// Best-effort live VRAM-used sample for benchmarks.
pub fn vram_used_sample() -> (Option<u64>, Option<String>) {
    if let Ok(rows) = native::nvml_query() {
        if !rows.is_empty() {
            return (Some(rows.iter().map(|r| r.used_bytes).sum()), Some("NVML".into()));
        }
    }
    #[cfg(target_os = "linux")]
    {
        let env = crate::RealEnv;
        if let Some(u) = linux::amd_vram_used(&env) {
            return (Some(u), Some("amdgpu sysfs".into()));
        }
    }
    #[cfg(target_os = "windows")]
    {
        let used: u64 = native::dxgi_adapters().unwrap_or_default().iter().filter(|a| !a.is_software).filter_map(|a| a.local_usage).sum();
        if used > 0 {
            return (Some(used), Some("DXGI local usage".into()));
        }
    }
    (None, None)
}

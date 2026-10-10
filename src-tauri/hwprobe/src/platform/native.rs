//! Native, OS-specific data sources. Each returns Err with a human-readable reason when
//! unavailable (missing driver, permissions, unsupported OS); callers degrade gracefully.

use crate::parsers::NvRow;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct DxgiAdapter {
    pub name: String,
    pub vendor_id: u32,
    pub device_id: u32,
    pub dedicated_video: u64,
    pub dedicated_system: u64,
    pub shared_system: u64,
    pub is_software: bool,
    /// IDXGIAdapter3::QueryVideoMemoryInfo(LOCAL): OS budget for this process.
    pub local_budget: Option<u64>,
    pub local_usage: Option<u64>,
}

// ---------------------------------------------------------------- NVML

#[cfg(any(target_os = "linux", target_os = "windows"))]
pub fn nvml_query() -> Result<Vec<NvRow>, String> {
    use nvml_wrapper::Nvml;
    use std::sync::OnceLock;
    static NVML: OnceLock<Result<Nvml, String>> = OnceLock::new();
    let nvml = NVML.get_or_init(|| Nvml::init().map_err(|e| e.to_string())).as_ref().map_err(|e| e.clone())?;
    let count = nvml.device_count().map_err(|e| e.to_string())?;
    let driver = nvml.sys_driver_version().ok();
    let mut rows = Vec::new();
    for i in 0..count {
        let d = nvml.device_by_index(i).map_err(|e| e.to_string())?;
        let mem = d.memory_info().map_err(|e| e.to_string())?;
        rows.push(NvRow {
            index: i,
            name: d.name().unwrap_or_else(|_| "NVIDIA GPU".into()),
            total_bytes: mem.total,
            free_bytes: mem.free,
            used_bytes: mem.used,
            driver: driver.clone(),
        });
    }
    Ok(rows)
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub fn nvml_query() -> Result<Vec<NvRow>, String> {
    Err("NVML is not available on this OS".into())
}

// ---------------------------------------------------------------- Metal (macOS)

#[cfg(target_os = "macos")]
pub fn metal_working_set() -> Option<u64> {
    use objc2_metal::{MTLCreateSystemDefaultDevice, MTLDevice};
    let device = MTLCreateSystemDefaultDevice()?;
    let v = device.recommendedMaxWorkingSetSize();
    if v > 0 {
        Some(v)
    } else {
        None
    }
}

#[cfg(not(target_os = "macos"))]
pub fn metal_working_set() -> Option<u64> {
    None
}

// ---------------------------------------------------------------- DXGI (Windows)

#[cfg(target_os = "windows")]
pub fn dxgi_adapters() -> Result<Vec<DxgiAdapter>, String> {
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter3, IDXGIFactory1, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO,
    };
    let mut out = Vec::new();
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| format!("CreateDXGIFactory1: {e}"))?;
        let mut i = 0u32;
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            i += 1;
            let desc = match adapter.GetDesc1() {
                Ok(d) => d,
                Err(_) => continue,
            };
            let len = desc.Description.iter().position(|c| *c == 0).unwrap_or(desc.Description.len());
            let name = String::from_utf16_lossy(&desc.Description[..len]);
            let mut a = DxgiAdapter {
                name,
                vendor_id: desc.VendorId,
                device_id: desc.DeviceId,
                dedicated_video: desc.DedicatedVideoMemory as u64,
                dedicated_system: desc.DedicatedSystemMemory as u64,
                shared_system: desc.SharedSystemMemory as u64,
                is_software: (desc.Flags & 2) != 0,
                local_budget: None,
                local_usage: None,
            };
            if let Ok(a3) = adapter.cast::<IDXGIAdapter3>() {
                let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
                if a3.QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info).is_ok() {
                    a.local_budget = Some(info.Budget);
                    a.local_usage = Some(info.CurrentUsage);
                }
            }
            out.push(a);
        }
    }
    Ok(out)
}

#[cfg(not(target_os = "windows"))]
pub fn dxgi_adapters() -> Result<Vec<DxgiAdapter>, String> {
    Err("DXGI is only available on Windows".into())
}

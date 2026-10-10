//! Tauri backend: hardware probe, allowlisted metadata HTTP, local Ollama proxy.
//! Security: no shell commands from user input, fixed host/path allowlists, no telemetry.

use base64::Engine;
use futures_util::StreamExt;
use serde::Serialize;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::ipc::Channel;

const ALLOWED_HOSTS: &[&str] = &["ollama.com", "registry.ollama.ai", "huggingface.co"];
const OLLAMA_PATHS: &[&str] = &["/api/version", "/api/tags", "/api/show", "/api/ps", "/api/generate", "/api/pull"];
const OLLAMA_STREAM_PATHS: &[&str] = &["/api/generate", "/api/pull"];
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_RANGE_BYTES: u64 = 4 * 1024 * 1024;

fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("ModelFitExplorer/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::custom(|a| {
                // Registry blobs redirect to a CDN; only follow https redirects, max 5.
                if a.previous().len() >= 5 || a.url().scheme() != "https" {
                    a.stop()
                } else {
                    a.follow()
                }
            }))
            .build()
            .expect("http client")
    })
}

fn local_client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().connect_timeout(Duration::from_secs(3)).build().expect("local client"))
}

/// Ollama base URL: OLLAMA_HOST only if it points at this machine, else the default.
pub fn ollama_base() -> String {
    if let Ok(h) = std::env::var("OLLAMA_HOST") {
        let h = h.trim().trim_end_matches('/');
        let with_scheme = if h.starts_with("http") { h.to_string() } else { format!("http://{h}") };
        if let Ok(u) = url::Url::parse(&with_scheme) {
            let host = u.host_str().unwrap_or("");
            if ["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"].contains(&host) {
                let port = u.port().unwrap_or(11434);
                return format!("http://127.0.0.1:{port}");
            }
        }
    }
    "http://127.0.0.1:11434".into()
}

pub fn check_metadata_url(raw: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(raw).map_err(|_| "Invalid URL".to_string())?;
    if u.scheme() != "https" {
        return Err("Only https URLs are allowed".into());
    }
    let host = u.host_str().unwrap_or("");
    if !ALLOWED_HOSTS.contains(&host) {
        return Err(format!("Host not allowed: {host}"));
    }
    Ok(u)
}

pub fn check_ollama_path(path: &str, streaming: bool) -> Result<(), String> {
    let list = if streaming { OLLAMA_STREAM_PATHS } else { OLLAMA_PATHS };
    if list.contains(&path) {
        Ok(())
    } else {
        Err(format!("Ollama path not allowed: {path}"))
    }
}

#[tauri::command]
async fn probe_hardware() -> Result<hwprobe::HardwareReport, String> {
    tokio::task::spawn_blocking(hwprobe::probe).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn sample_memory() -> Result<hwprobe::MemorySample, String> {
    tokio::task::spawn_blocking(hwprobe::sample_memory).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HttpOut {
    status: u16,
    text: Option<String>,
    bytes_b64: Option<String>,
}

#[tauri::command]
async fn http_get(url: String, accept: Option<String>, range_end: Option<u64>, binary: Option<bool>) -> Result<HttpOut, String> {
    let u = check_metadata_url(&url)?;
    let mut req = client().get(u);
    if let Some(a) = accept {
        req = req.header(reqwest::header::ACCEPT, a);
    }
    let limit = match range_end {
        Some(end) => {
            let end = end.min(MAX_RANGE_BYTES - 1);
            req = req.header(reqwest::header::RANGE, format!("bytes=0-{end}"));
            (end + 1) as usize
        }
        None => MAX_TEXT_BYTES,
    };
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let mut stream = res.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        let take = chunk.len().min(limit - buf.len());
        buf.extend_from_slice(&chunk[..take]);
        if buf.len() >= limit {
            break;
        }
    }
    if binary.unwrap_or(false) {
        Ok(HttpOut { status, text: None, bytes_b64: Some(base64::engine::general_purpose::STANDARD.encode(&buf)) })
    } else {
        Ok(HttpOut { status, text: Some(String::from_utf8_lossy(&buf).into_owned()), bytes_b64: None })
    }
}

#[tauri::command]
async fn ollama_request(method: String, path: String, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    check_ollama_path(&path, false)?;
    let url = format!("{}{}", ollama_base(), path);
    let req = match method.as_str() {
        "GET" => local_client().get(url),
        "POST" => local_client().post(url).json(&body.unwrap_or(serde_json::json!({}))),
        _ => return Err("Method not allowed".into()),
    };
    let res = req.timeout(Duration::from_secs(120)).send().await.map_err(|e| format!("Ollama not reachable: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Ollama {path}: HTTP {} {}", status.as_u16(), text.chars().take(300).collect::<String>()));
    }
    serde_json::from_str(&text).map_err(|e| format!("Ollama {path}: invalid JSON ({e})"))
}

#[tauri::command]
async fn ollama_stream(path: String, body: serde_json::Value, on_event: Channel<serde_json::Value>) -> Result<(), String> {
    check_ollama_path(&path, true)?;
    let url = format!("{}{}", ollama_base(), path);
    let res = local_client().post(url).json(&body).send().await.map_err(|e| format!("Ollama not reachable: {e}"))?;
    if !res.status().is_success() {
        let s = res.status().as_u16();
        let t = res.text().await.unwrap_or_default();
        return Err(format!("Ollama {path}: HTTP {s} {}", t.chars().take(300).collect::<String>()));
    }
    let mut stream = res.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let s = String::from_utf8_lossy(&line);
            let s = s.trim();
            if !s.is_empty() {
                let v: serde_json::Value = serde_json::from_str(s).map_err(|e| e.to_string())?;
                on_event.send(v).map_err(|e| e.to_string())?;
            }
        }
    }
    let rest = String::from_utf8_lossy(&buf);
    if !rest.trim().is_empty() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest.trim()) {
            let _ = on_event.send(v);
        }
    }
    Ok(())
}

pub fn safe_file_name(name: &str) -> Option<String> {
    let n: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')).collect();
    if n.is_empty() || n.starts_with('.') || n.len() > 100 {
        None
    } else {
        Some(n)
    }
}

/// `name`, or `name (2).ext`, `name (3).ext`… so an earlier export is never overwritten.
pub fn unique_path(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) => (&name[..i], &name[i..]),
        None => (name, ""),
    };
    (2..10_000).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

/// Save an export (CSV/JSON) into the user's Downloads folder. Returns the full path.
#[tauri::command]
fn export_file(file_name: String, contents: String) -> Result<String, String> {
    let name = safe_file_name(&file_name).ok_or("Invalid file name")?;
    let dir = dirs::download_dir().or_else(dirs::home_dir).ok_or("No downloads folder")?;
    let path = unique_path(&dir, &name);
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Signed auto-updates from GitHub Releases (desktop only).
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![probe_hardware, sample_memory, http_get, ollama_request, ollama_stream, export_file])
        .run(tauri::generate_context!())
        .expect("error while running Model Fit Explorer");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_never_overwrite() {
        let dir = std::env::temp_dir().join(format!("mfe-export-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = unique_path(&dir, "catalog.json");
        std::fs::write(&a, "1").unwrap();
        let b = unique_path(&dir, "catalog.json");
        assert_eq!(b.file_name().unwrap(), "catalog (2).json");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn metadata_allowlist() {
        assert!(check_metadata_url("https://ollama.com/library").is_ok());
        assert!(check_metadata_url("https://registry.ollama.ai/v2/library/x/manifests/y").is_ok());
        assert!(check_metadata_url("http://ollama.com/library").is_err());
        assert!(check_metadata_url("https://evil.example.com/").is_err());
        assert!(check_metadata_url("https://ollama.com.evil.example/").is_err());
        assert!(check_metadata_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn ollama_path_allowlist() {
        assert!(check_ollama_path("/api/tags", false).is_ok());
        assert!(check_ollama_path("/api/delete", false).is_err());
        assert!(check_ollama_path("/api/create", false).is_err());
        assert!(check_ollama_path("/api/tags", true).is_err());
        assert!(check_ollama_path("/api/pull", true).is_ok());
    }

    #[test]
    fn file_names_are_sanitized() {
        assert_eq!(safe_file_name("catalog.json").as_deref(), Some("catalog.json"));
        assert!(safe_file_name("../x").map(|n| !n.contains('/')).unwrap_or(true));
        assert!(safe_file_name(".hidden").is_none());
    }

    #[test]
    fn ollama_host_only_local() {
        std::env::set_var("OLLAMA_HOST", "0.0.0.0:11500");
        assert_eq!(ollama_base(), "http://127.0.0.1:11500");
        std::env::set_var("OLLAMA_HOST", "http://203.0.113.5:11434");
        assert_eq!(ollama_base(), "http://127.0.0.1:11434");
        std::env::remove_var("OLLAMA_HOST");
    }
}

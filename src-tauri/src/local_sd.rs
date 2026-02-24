// local_sd.rs — Runs stable-diffusion.cpp locally, no WebUI required.
//
// Downloads the sd binary from the GitHub releases of leejet/stable-diffusion.cpp
// into the Tauri app-data directory on first use.
//
// Tauri commands exposed:
//   get_sd_binary_status  → { installed: bool, path: string }
//   download_sd_binary    → streams "sd-download-progress" events, returns final path
//   list_local_sd_models  → lists .safetensors / .ckpt / .gguf files in a directory
//   run_local_sd          → spawns the sd process, streams "sd-progress" events, returns base64 PNG

use base64::{engine::general_purpose, Engine};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LocalSdRequest {
    pub model_path:       String,
    pub prompt:           String,
    pub negative_prompt:  Option<String>,
    pub width:            Option<u32>,
    pub height:           Option<u32>,
    pub steps:            Option<u32>,
    pub cfg_scale:        Option<f32>,
    pub seed:             Option<i64>,
    /// e.g. "euler_a", "dpm2", "lms" — maps to --sampling-method
    pub sampler:          Option<String>,
    pub vae_path:         Option<String>,
    /// Number of CPU threads (0 = auto-detect)
    pub threads:          Option<u32>,
    /// Extra raw CLI flags passed verbatim (advanced users)
    pub extra_args:       Option<String>,
    /// GPU backend: "cpu" | "cuda" | "vulkan" (default: "cpu")
    pub gpu_backend:      Option<String>,
    /// Pass --vae-on-cpu to the sd binary (offloads VAE decode to RAM, prevents VRAM OOM)
    pub vae_on_cpu:       Option<bool>,
    /// Pass --vae-tiling to the sd binary (tiles the VAE decode, greatly reduces VRAM usage)
    pub vae_tiling:       Option<bool>,
    /// Pass --offload-to-cpu: places model weights in RAM, loads to VRAM on-demand (prevents OOM during model load)
    pub offload_to_cpu:   Option<bool>,
}

// ── Helpers ────────────────────────────────────────────────────────────────

/// Returns the binary filename for the requested backend.
/// Each backend gets its own file so switching backends forces a fresh download.
fn sd_bin_name_for(backend: &str) -> String {
    let suffix = match backend {
        "cuda"   => "cuda",
        "vulkan" => "vulkan",
        _        => "cpu",
    };
    if cfg!(target_os = "windows") {
        format!("sd-{}.exe", suffix)
    } else {
        format!("sd-cli-{}", suffix)
    }
}

fn get_sd_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path_resolver()
        .app_data_dir()
        .ok_or_else(|| "Cannot resolve app data directory".to_string())
        .map(|p| p.join("sd_runtime"))
}

fn get_sd_bin_path_for(app: &tauri::AppHandle, backend: &str) -> Result<PathBuf, String> {
    Ok(get_sd_data_dir(app)?.join(sd_bin_name_for(backend)))
}

// ── Tauri commands ─────────────────────────────────────────────────────────

/// Returns { installed: bool, path: string }
/// `backend`: "cpu" | "cuda" | "vulkan" — checks the binary for that specific backend.
#[tauri::command]
pub fn get_sd_binary_status(
    app_handle:   tauri::AppHandle,
    backend_pref: Option<String>,
) -> Result<serde_json::Value, String> {
    let backend = backend_pref.as_deref().unwrap_or("cpu").to_lowercase();
    let p = get_sd_bin_path_for(&app_handle, &backend)?;
    let installed = p.exists();
    // Ensure the execute bit is set on Unix (zip extraction strips it)
    #[cfg(unix)]
    if installed {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&p) {
            let mode = meta.permissions().mode();
            if mode & 0o111 == 0 {
                let mut perms = meta.permissions();
                perms.set_mode(mode | 0o755);
                let _ = std::fs::set_permissions(&p, perms);
            }
        }
    }
    Ok(serde_json::json!({
        "installed": installed,
        "path":      p.to_string_lossy(),
        "backend":   backend,
    }))
}

/// Downloads the sd binary from GitHub releases.
/// Emits `sd-download-progress` → { status: string, progress: number 0-100 }
/// `backend_pref`: "cpu" (default) | "cuda" | "vulkan"
#[tauri::command]
pub async fn download_sd_binary(
    window:       tauri::Window,
    app_handle:   tauri::AppHandle,
    backend_pref: Option<String>,
) -> Result<String, String> {
    let backend = backend_pref.as_deref().unwrap_or("cpu").to_lowercase();
    println!("[SD] download_sd_binary called — requested backend: {}", backend);
    let data_dir = get_sd_data_dir(&app_handle)?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let bin_path = get_sd_bin_path_for(&app_handle, &backend)?;
    if bin_path.exists() {
        println!("[SD] Binary already installed at {:?} — skipping download (backend={})", bin_path, backend);
        return Ok(bin_path.to_string_lossy().to_string());
    }

    emit_progress(&window, "Fetching latest release from GitHub…", 0);
    println!("[SD] Fetching latest release from GitHub…");

    // ── Fetch latest release metadata ──────────────────────────────────
    // Short-timeout client for the GitHub API metadata request only.
    let api_client = reqwest::Client::builder()
        .user_agent("ai-assistant/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    // Download client: long connect timeout, NO total-request timeout.
    // CUDA archives can be 200–500 MB; a global timeout will abort mid-stream.
    let dl_client = reqwest::Client::builder()
        .user_agent("ai-assistant/0.1")
        .connect_timeout(std::time::Duration::from_secs(30))
        .tcp_keepalive(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let release: serde_json::Value = api_client
        .get("https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest")
        .send().await
        .map_err(|e| format!("GitHub API error: {}", e))?
        .json().await
        .map_err(|e| e.to_string())?;

    // ── Pick the right asset ────────────────────────────────────────────
    // Select platform keywords + GPU filter based on requested backend.
    // NOTE: On Linux, stable-diffusion.cpp does NOT release a native CUDA binary.
    //       The Vulkan build works on NVIDIA, AMD, and Intel GPUs via the Vulkan API.
    //       Users should select "Vulkan" on Linux for GPU acceleration.
    //       On Windows, a native CUDA binary is available.
    let platform_keys: &[&str] = if cfg!(target_os = "windows") {
        &["win-avx2", "win-avx", "win-x64", "windows"]
    } else if cfg!(target_os = "macos") {
        &["osx-arm64", "osx-x64", "macos", "osx"]
    } else {
        // Linux: match both common patterns. Actual names differ between releases.
        &["linux-ubuntu", "ubuntu-24", "ubuntu-x64", "linux-x64", "ubuntu", "linux"]
    };

    let assets = release["assets"].as_array()
        .ok_or("No assets in GitHub release")?;

    println!("[SD] Available release assets:");
    for a in assets.iter() {
        println!("  • {}", a["name"].as_str().unwrap_or("?"));
    }

    // On Linux there is no native CUDA release — remap cuda → vulkan so the
    // GPU-capable Vulkan binary is downloaded instead.
    let effective_backend = if cfg!(target_os = "linux") && backend == "cuda" {
        println!("[SD] INFO: No CUDA binary exists for Linux in stable-diffusion.cpp releases. \
            Using Vulkan build instead — works with NVIDIA, AMD, and Intel GPUs via Vulkan API.");
        "vulkan".to_string()
    } else {
        backend.clone()
    };

    let asset = platform_keys.iter().find_map(|kw| {
        assets.iter().find(|a| {
            let name = a["name"].as_str().unwrap_or("").to_lowercase();
            if !(name.ends_with(".zip") || name.ends_with(".tar.gz")) { return false; }
            if !name.contains(kw) { return false; }
            match effective_backend.as_str() {
                "cuda"   => name.contains("cuda"),
                "vulkan" => name.contains("vulkan"),
                _ => {
                    // cpu: skip any GPU build
                    !name.contains("cuda") && !name.contains("metal")
                    && !name.contains("rocm") && !name.contains("vulkan")
                    && !name.contains("opencl") && !name.contains("hip")
                }
            }
        })
    }).or_else(|| {
        // Fallback: any platform match regardless of backend keyword
        println!("[SD] Exact backend match not found — falling back to any platform asset");
        platform_keys.iter().find_map(|kw| {
            assets.iter().find(|a| {
                let name = a["name"].as_str().unwrap_or("").to_lowercase();
                name.contains(kw) && (name.ends_with(".zip") || name.ends_with(".tar.gz"))
                    && !name.contains("rocm") // avoid ROCm for non-AMD users
            })
        })
    }).ok_or_else(|| {
        let names: Vec<_> = assets.iter()
            .filter_map(|a| a["name"].as_str()).collect();
        format!("No suitable binary found. Available: {:?}", names)
    })?;

    println!("[SD] Selected asset: {} (backend={})",
        asset["name"].as_str().unwrap_or("?"), backend);

    let url  = asset["browser_download_url"].as_str().ok_or("No download URL")?;
    let name = asset["name"].as_str().unwrap_or("sd_release");
    let size = asset["size"].as_u64().unwrap_or(0);

    emit_progress(&window,
        &format!("Downloading {} ({:.1} MB)…", name, size as f64 / 1_048_576.0),
        5);

    // ── Streaming download with real progress ──────────────────────────
    let response = dl_client.get(url).send().await
        .map_err(|e| format!("Download failed: {}", e))?;

    let total_bytes = response.content_length().unwrap_or(size);
    let mut downloaded: u64 = 0;
    let mut bytes_buf: Vec<u8> =
        Vec::with_capacity(total_bytes.min(512 * 1024 * 1024) as usize);

    let mut stream = response.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Download stream error: {}", e))?;
        bytes_buf.extend_from_slice(&chunk);
        downloaded += chunk.len() as u64;

        if total_bytes > 0 {
            // Map downloaded bytes to the 5 %–78 % window
            let pct = (downloaded * 73 / total_bytes) as u8 + 5;
            emit_progress(
                &window,
                &format!(
                    "Downloading… {:.1} / {:.1} MB",
                    downloaded as f64 / 1_048_576.0,
                    total_bytes as f64 / 1_048_576.0,
                ),
                pct.min(78),
            );
        }
    }

    emit_progress(&window, "Saving archive…", 79);

    let archive = data_dir.join(name);
    std::fs::write(&archive, &bytes_buf).map_err(|e| e.to_string())?;

    emit_progress(&window, "Extracting archive…", 80);

    let name_lower = name.to_lowercase();
    if name_lower.ends_with(".zip") {
        extract_zip(&archive, &data_dir)?;
    } else if name_lower.ends_with(".tar.gz") {
        extract_targz(&archive, &data_dir)?;
    }
    let _ = std::fs::remove_file(&archive);

    // The binary might be inside a sub-directory of the archive.
    // Search for it recursively.
    let bin_found = find_binary(&data_dir, &sd_bin_name_for(&backend));
    if let Some(found) = bin_found {
        if found != bin_path {
            std::fs::rename(&found, &bin_path).map_err(|e| e.to_string())?;
        }
    }

    // Make all extracted executable files executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // chmod 755 every file in the runtime dir (covers sd-cli, sd-server, etc.)
        if let Ok(entries) = std::fs::read_dir(&data_dir) {
            for entry in entries.flatten() {
                let ep = entry.path();
                if ep.is_file() {
                    if let Ok(meta) = std::fs::metadata(&ep) {
                        let mut perms = meta.permissions();
                        perms.set_mode(perms.mode() | 0o755);
                        let _ = std::fs::set_permissions(&ep, perms);
                    }
                }
            }
        }
    }

    if !bin_path.exists() {
        // The archive may have placed the binary under the original name; search more broadly.
        let generic_name = if cfg!(target_os = "windows") { "sd.exe" } else { "sd" };
        if let Some(found) = find_binary(&data_dir, generic_name) {
            std::fs::rename(&found, &bin_path).map_err(|e| e.to_string())?;
        }
        // New releases (c5eb1e4+) ship the CLI as plain "sd-cli"; prefer it over sd-server.
        if !bin_path.exists() {
            if let Some(found) = find_binary(&data_dir, "sd-cli") {
                std::fs::rename(&found, &bin_path).map_err(|e| e.to_string())?;
            }
        }
        if !bin_path.exists() {
            // Last resort: look for any executable file (common on Linux releases).
            // Explicitly skip sd-server — it is the HTTP inference server, not the CLI.
            if let Ok(entries) = std::fs::read_dir(&data_dir) {
                for entry in entries.flatten() {
                    let ep = entry.path();
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if ep.is_file() {
                            if let Ok(meta) = std::fs::metadata(&ep) {
                                if meta.permissions().mode() & 0o111 != 0 {
                                    let ep_name = ep.file_name().and_then(|n| n.to_str()).unwrap_or("");
                                    // Skip files already named for another backend, and skip sd-server
                                    let already_named = ep_name.starts_with("sd-cli-") || ep_name.starts_with("sd-cpu") || ep_name.starts_with("sd-cuda") || ep_name.starts_with("sd-vulkan");
                                    let is_server = ep_name == "sd-server" || ep_name.starts_with("sd-server-");
                                    if !already_named && !is_server && (ep_name.starts_with("sd") || ep_name == "stable-diffusion") {
                                        std::fs::rename(&ep, &bin_path).map_err(|e| e.to_string())?;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    #[cfg(not(unix))]
                    {
                        if ep.is_file() && ep.extension().and_then(|e| e.to_str()) == Some("exe") {
                            let ep_name = ep.file_name().and_then(|n| n.to_str()).unwrap_or("");
                            let already_named = ep_name.starts_with("sd-cpu") || ep_name.starts_with("sd-cuda") || ep_name.starts_with("sd-vulkan");
                            let is_server = ep_name.starts_with("sd-server");
                            if !already_named && !is_server && ep_name.starts_with("sd") {
                                std::fs::rename(&ep, &bin_path).map_err(|e| e.to_string())?;
                                break;
                            }
                        }
                    }
                }
            }
        }
        if !bin_path.exists() {
            return Err(format!("Binary not found after extraction. Expected: {:?}", bin_path));
        }
    }

    emit_progress(&window, "Done!", 100);
    println!("[SD] Binary downloaded and ready: {:?} (backend={})", bin_path, backend);
    Ok(bin_path.to_string_lossy().to_string())
}

/// Checks whether CUDA runtime libraries are accessible on the system.
/// Returns { found: bool, path: string | null, suggestion: string }.
#[tauri::command]
pub fn check_cuda_libs() -> serde_json::Value {
    #[cfg(not(target_os = "linux"))]
    {
        return serde_json::json!({ "found": false, "path": null,
            "suggestion": "CUDA library check only supported on Linux." });
    }

    #[cfg(target_os = "linux")]
    {
        let mut search_dirs: Vec<String> = Vec::new();
        for env_var in &["CUDA_HOME", "CUDA_PATH", "CUDA_ROOT"] {
            if let Ok(v) = std::env::var(env_var) {
                search_dirs.push(format!("{}/lib64", v));
                search_dirs.push(format!("{}/targets/x86_64-linux/lib", v));
            }
        }
        // Add existing LD_LIBRARY_PATH dirs
        if let Ok(ldp) = std::env::var("LD_LIBRARY_PATH") {
            search_dirs.extend(ldp.split(':').map(|s| s.to_string()));
        }
        search_dirs.extend(vec![
            "/usr/local/cuda/lib64".to_string(),
            "/usr/local/cuda/targets/x86_64-linux/lib".to_string(),
            "/usr/lib/x86_64-linux-gnu".to_string(),
            "/usr/lib64".to_string(),
            "/lib64".to_string(),
        ]);
        // Versioned CUDA dirs (both lib64 and targets/)
        if let Ok(entries) = std::fs::read_dir("/usr/local") {
            let mut cuda_dirs: Vec<String> = entries.flatten()
                .filter_map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    if n.starts_with("cuda-") {
                        Some(vec![
                            format!("/usr/local/{}/lib64", n),
                            format!("/usr/local/{}/targets/x86_64-linux/lib", n),
                        ])
                    } else { None }
                })
                .flatten()
                .collect();
            cuda_dirs.sort_by(|a, b| b.cmp(a));
            search_dirs.extend(cuda_dirs);
        }
        // Also use ldconfig -p to find wherever libcudart.so actually lives
        if let Ok(out) = std::process::Command::new("ldconfig").arg("-p").output() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if line.contains("libcudart.so") {
                    if let Some(path) = line.splitn(2, "=>").nth(1) {
                        let lib_path = path.trim();
                        if let Some(dir) = std::path::Path::new(lib_path).parent() {
                            search_dirs.push(dir.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }

        for dir in &search_dirs {
            let dir_path = std::path::Path::new(dir);
            if !dir_path.exists() { continue; }
            let has_cudart = std::fs::read_dir(dir_path)
                .map(|rd| rd.flatten().any(|e| {
                    e.file_name().to_string_lossy().starts_with("libcudart.so")
                }))
                .unwrap_or(false);
            if has_cudart {
                return serde_json::json!({
                    "found": true,
                    "path": dir,
                    "suggestion": null
                });
            }
        }

        return serde_json::json!({
            "found": false,
            "path": null,
            "suggestion": "CUDA runtime not found. On Nobara/Fedora run:\n  sudo dnf config-manager --add-repo https://developer.download.nvidia.com/compute/cuda/repos/fedora39/x86_64/cuda-fedora39.repo\n  sudo dnf install cuda-cudart cuda-libraries\nOn Ubuntu/Debian: sudo apt install nvidia-cuda-toolkit\nOr set CUDA_HOME env var if CUDA is installed in a non-standard path."
        });
    }
}

/// Deletes the installed binary for the given backend so it can be re-downloaded.
#[tauri::command]
pub fn delete_sd_binary(
    app_handle:   tauri::AppHandle,
    backend_pref: Option<String>,
) -> Result<(), String> {
    let backend = backend_pref.as_deref().unwrap_or("cpu").to_lowercase();
    let bin_path = get_sd_bin_path_for(&app_handle, &backend)?;
    if bin_path.exists() {
        std::fs::remove_file(&bin_path).map_err(|e| e.to_string())?;
        println!("[SD] Deleted binary for backend '{}': {:?}", backend, bin_path);
    }
    Ok(())
}

/// Lists all .safetensors / .ckpt / .gguf / .bin model files in `models_dir`.
#[tauri::command]
pub fn list_local_sd_models(models_dir: String) -> Result<Vec<String>, String> {
    let dir = Path::new(&models_dir);
    if !dir.exists() { return Ok(vec![]); }

    let mut out = Vec::new();
    collect_models(dir, &mut out);
    out.sort();
    Ok(out)
}

/// Runs stable-diffusion.cpp inference.
/// Emits `sd-progress` → { line: string } for each stderr line.
/// Returns base64-encoded PNG.
#[tauri::command]
pub async fn run_local_sd(
    window:     tauri::Window,
    app_handle: tauri::AppHandle,
    req:        LocalSdRequest,
) -> Result<String, String> {
    let gpu_backend = req.gpu_backend.as_deref().unwrap_or("cpu").to_lowercase();
    let bin = get_sd_bin_path_for(&app_handle, &gpu_backend)?;
    if !bin.exists() {
        return Err(format!(
            "stable-diffusion.cpp {} binary not installed. \
             Go to Settings → Image Generation → Native SD, select the {} backend, \
             and click \"Download binary\".",
            gpu_backend.to_uppercase(), gpu_backend.to_uppercase()
        ));
    }
    let t_start = std::time::Instant::now();

    println!("╔══════════════════════════════════════════════════════════════");
    println!("║ [SD] run_local_sd — NEW GENERATION REQUEST");
    println!("║  binary    : {}", bin.display());
    println!("║  model     : {}", req.model_path);
    println!("║  gpu       : {}", gpu_backend);
    println!("║  size      : {}×{}", req.width.unwrap_or(512), req.height.unwrap_or(512));
    println!("║  steps     : {}", req.steps.unwrap_or(20));
    println!("║  cfg_scale : {:.1}", req.cfg_scale.unwrap_or(7.0));
    println!("║  sampler   : {}", req.sampler.as_deref().unwrap_or("default"));
    println!("║  seed      : {}", req.seed.unwrap_or(-1));
    println!("║  neg_prompt: {}", req.negative_prompt.as_deref().unwrap_or("(none)"));
    println!("║  prompt    : {}", &req.prompt.chars().take(200).collect::<String>());
    println!("╚══════════════════════════════════════════════════════════════");

    // Temp output path
    let out_path = std::env::temp_dir().join(format!(
        "sd_out_{}.png",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));

    let mut cmd = Command::new(&bin);
    cmd.arg("-m").arg(&req.model_path)
       .arg("-p").arg(&req.prompt)
       .arg("-o").arg(&out_path)
       .arg("--steps").arg(req.steps.unwrap_or(20).to_string())
       .arg("--cfg-scale").arg(format!("{:.1}", req.cfg_scale.unwrap_or(7.0)))
       .arg("-W").arg(req.width.unwrap_or(512).to_string())
       .arg("-H").arg(req.height.unwrap_or(512).to_string());

    let threads = req.threads.unwrap_or(0);
    if threads > 0 {
        cmd.arg("-t").arg(threads.to_string());
    }
    if let Some(neg) = &req.negative_prompt {
        if !neg.trim().is_empty() { cmd.arg("-n").arg(neg); }
    }
    if let Some(seed) = req.seed {
        cmd.arg("-s").arg(seed.to_string());
    }
    if let Some(sampler) = &req.sampler {
        cmd.arg("--sampling-method").arg(sampler);
    }
    if let Some(vae) = &req.vae_path {
        if !vae.trim().is_empty() { cmd.arg("--vae").arg(vae); }
    }
    if req.vae_on_cpu.unwrap_or(false) {
        cmd.arg("--vae-on-cpu");
        println!("[SD] VAE on CPU: enabled (offloads VAE decode to RAM)");
    }
    if req.vae_tiling.unwrap_or(false) {
        cmd.arg("--vae-tiling");
        println!("[SD] VAE tiling: enabled (reduces VRAM needed for decode)");
    }
    if req.offload_to_cpu.unwrap_or(false) {
        cmd.arg("--offload-to-cpu");
        println!("[SD] Offload to CPU: enabled (model weights in RAM, loaded to VRAM on demand)");
    }

    // ── GPU-specific flags ────────────────────────────────────────────────
    // NOTE: In stable-diffusion.cpp the GPU backend is baked into the binary at
    // compile time. No extra CLI flag is needed to activate GPU computation —
    // just using the CUDA/Vulkan binary is sufficient.
    match gpu_backend.as_str() {
        "cuda" => {
            println!("[SD] GPU backend: CUDA (baked into binary, no extra flags needed)");
        }
        "vulkan" => {
            println!("[SD] GPU backend: Vulkan (baked into binary, no extra flags needed)");
        }
        _ => {
            println!("[SD] GPU backend: CPU");
        }
    }

    if let Some(extra) = &req.extra_args {
        for part in extra.split_whitespace() {
            cmd.arg(part);
        }
        println!("[SD] Extra args: {}", extra);
    }

    // Log the full command line for easy debugging
    let full_cmd = format!(
        "{} {}",
        bin.display(),
        cmd.as_std().get_args()
            .map(|a| a.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ")
    );
    println!("[SD] Full command: {}", full_cmd);
    println!("[SD] Spawning process…");

    cmd.stderr(Stdio::piped()).stdout(Stdio::piped());

    // Ensure libstable-diffusion.so (next to the binary) is on the library path.
    // For CUDA builds also add common system CUDA library directories so the
    // binary can find libcudart.so / libcublas.so without requiring the user to
    // configure LD_LIBRARY_PATH manually.
    let data_dir = get_sd_data_dir(&app_handle)?;
    #[cfg(target_os = "linux")]
    {
        let prev = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
        let mut paths: Vec<String> = vec![data_dir.to_string_lossy().to_string()];

        if gpu_backend == "cuda" {
            // Common CUDA runtime library locations on Linux.
            // Try CUDA_HOME / CUDA_PATH env vars first, then common fixed paths.
            let cuda_candidates: Vec<String> = {
                let mut c = Vec::new();
                for env_var in &["CUDA_HOME", "CUDA_PATH", "CUDA_ROOT"] {
                    if let Ok(v) = std::env::var(env_var) {
                        c.push(format!("{}/lib64", v));
                        c.push(format!("{}/lib", v));
                    }
                }
                // Fixed well-known paths (Ubuntu/Fedora/Arch/Nobara)
                for p in &[
                    "/usr/local/cuda/lib64",
                    "/usr/local/cuda/targets/x86_64-linux/lib",  // Nobara / CUDA 12+
                    "/usr/lib/x86_64-linux-gnu",
                    "/usr/lib64",
                    "/lib64",
                ] {
                    c.push(p.to_string());
                }
                // Glob-expand versioned CUDA dirs: /usr/local/cuda-12.x/lib64
                // and /usr/local/cuda-12.x/targets/x86_64-linux/lib
                if let Ok(entries) = std::fs::read_dir("/usr/local") {
                    let mut cuda_dirs: Vec<String> = entries
                        .flatten()
                        .filter_map(|e| {
                            let n = e.file_name().to_string_lossy().to_string();
                            if n.starts_with("cuda-") {
                                Some(vec![
                                    format!("/usr/local/{}/lib64", n),
                                    format!("/usr/local/{}/targets/x86_64-linux/lib", n),
                                ])
                            } else { None }
                        })
                        .flatten()
                        .collect();
                    cuda_dirs.sort_by(|a, b| b.cmp(a)); // newest version first
                    c.extend(cuda_dirs);
                }
                // Dynamically find libcudart.so via ldconfig -p
                if let Ok(out) = std::process::Command::new("ldconfig").arg("-p").output() {
                    let text = String::from_utf8_lossy(&out.stdout);
                    for line in text.lines() {
                        if line.contains("libcudart.so") {
                            if let Some(path) = line.splitn(2, "=>").nth(1) {
                                let lib_path = path.trim();
                                if let Some(dir) = std::path::Path::new(lib_path).parent() {
                                    let dir_str = dir.to_string_lossy().to_string();
                                    println!("[SD] ldconfig found libcudart at: {}", lib_path);
                                    c.push(dir_str);
                                }
                            }
                        }
                    }
                }
                c
            };

            let mut found_cuda = false;
            for candidate in &cuda_candidates {
                let libcudart = std::path::Path::new(candidate).join("libcudart.so");
                // Also check libcudart.so.12, libcudart.so.11, etc.
                let found = libcudart.exists() || {
                    std::fs::read_dir(candidate)
                        .map(|rd| rd.flatten().any(|e| {
                            e.file_name().to_string_lossy().starts_with("libcudart.so")
                        }))
                        .unwrap_or(false)
                };
                if found {
                    println!("[SD] Found CUDA runtime at: {}", candidate);
                    found_cuda = true;
                }
                if std::path::Path::new(candidate).exists() {
                    paths.push(candidate.clone());
                }
            }
            if !found_cuda {
                println!("[SD] WARNING: libcudart.so not found in any common path. \
                    GPU may fall back to CPU. Install NVIDIA CUDA Toolkit or set CUDA_HOME.");
            }
        }

        if !prev.is_empty() {
            paths.push(prev);
        }
        let new_ld = paths.join(":");
        println!("[SD] LD_LIBRARY_PATH={}", new_ld);
        cmd.env("LD_LIBRARY_PATH", new_ld);
    }
    #[cfg(target_os = "macos")]
    {
        let prev = std::env::var("DYLD_LIBRARY_PATH").unwrap_or_default();
        let new_path = if prev.is_empty() {
            data_dir.to_string_lossy().to_string()
        } else {
            format!("{}:{}", data_dir.display(), prev)
        };
        cmd.env("DYLD_LIBRARY_PATH", new_path);
    }

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to start sd binary: {}", e))?;

    println!("[SD] Process spawned (PID: {:?})", child.id());

    // Stream stderr lines as progress events.
    // stable-diffusion.cpp uses \r to overwrite progress in a terminal, so we
    // must split on BOTH \r and \n — BufReader::lines() (\n-only) would never
    // complete progress lines and the UI would stay at "Preparing…" forever.
    //
    // We also collect every non-empty line so we can include them in the error
    // message when the process exits with a non-zero code.
    //
    // NOTE: stdout is drained concurrently — if left unread it can fill the OS
    // pipe buffer and deadlock the child process.
    let stderr = child.stderr.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let win = window.clone();

    // ── stderr reader — streams progress events and collects lines ──────────
    let stderr_task: tokio::task::JoinHandle<Vec<String>> = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut reader = tokio::io::BufReader::new(stderr);
        let mut raw = Vec::<u8>::with_capacity(256);
        let mut tmp = [0u8; 256];
        let mut collected: Vec<String> = Vec::new();
        loop {
            match reader.read(&mut tmp).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for &b in &tmp[..n] {
                        if b == b'\n' || b == b'\r' {
                            if !raw.is_empty() {
                                let line = String::from_utf8_lossy(&raw).to_string();
                                println!("[SD stderr] {}", line);
                                let _ = win.emit("sd-progress", serde_json::json!({ "line": line.clone() }));
                                collected.push(line);
                                raw.clear();
                            }
                        } else {
                            raw.push(b);
                        }
                    }
                }
            }
        }
        if !raw.is_empty() {
            let line = String::from_utf8_lossy(&raw).to_string();
            println!("[SD stderr] {}", line);
            let _ = win.emit("sd-progress", serde_json::json!({ "line": line.clone() }));
            collected.push(line);
        }
        collected
    });

    // ── stdout reader — drain to avoid deadlock, log for diagnostics ────────
    let stdout_task: tokio::task::JoinHandle<Vec<String>> = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut reader = tokio::io::BufReader::new(stdout);
        let mut raw = Vec::<u8>::with_capacity(256);
        let mut tmp = [0u8; 256];
        let mut collected: Vec<String> = Vec::new();
        loop {
            match reader.read(&mut tmp).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for &b in &tmp[..n] {
                        if b == b'\n' || b == b'\r' {
                            if !raw.is_empty() {
                                let line = String::from_utf8_lossy(&raw).to_string();
                                println!("[SD stdout] {}", line);
                                collected.push(line);
                                raw.clear();
                            }
                        } else {
                            raw.push(b);
                        }
                    }
                }
            }
        }
        if !raw.is_empty() {
            let line = String::from_utf8_lossy(&raw).to_string();
            println!("[SD stdout] {}", line);
            collected.push(line);
        }
        collected
    });

    // Wait for process exit, then for both readers to flush completely.
    let status       = child.wait().await.map_err(|e| e.to_string())?;
    let stderr_lines = stderr_task.await.unwrap_or_default();
    let stdout_lines = stdout_task.await.unwrap_or_default();

    if !status.success() {
        // Combine stdout + stderr; last 30 lines total for the error popup.
        let mut all_lines: Vec<String> = Vec::new();
        if !stdout_lines.is_empty() {
            all_lines.push("--- stdout ---".into());
            all_lines.extend(stdout_lines);
        }
        if !stderr_lines.is_empty() {
            all_lines.push("--- stderr ---".into());
            all_lines.extend(stderr_lines);
        }
        let tail: Vec<&str> = all_lines.iter()
            .rev().take(30).rev()
            .map(|s| s.as_str())
            .collect();
        let output_summary = if tail.is_empty() {
            "(no output captured)".to_string()
        } else {
            tail.join("\n")
        };
        let msg = format!(
            "sd exited with code {:?}.\n\nProcess output:\n{}\n\nTips:\n• Make sure the binary matches your GPU backend (CPU / CUDA / Vulkan)\n• Verify the model path is correct\n• Try switching to CPU backend in Settings → Image Gen → Native SD",
            status.code(), output_summary
        );
        println!("[SD] FAILED — exit code {:?}\n{}", status.code(), output_summary);
        return Err(msg);
    }

    if !out_path.exists() {
        println!("[SD] FAILED — process exited ok but no output image at {:?}", out_path);
        return Err("sd finished but no output image was created.".into());
    }

    let bytes = std::fs::read(&out_path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&out_path);
    let elapsed = t_start.elapsed();
    println!("[SD] SUCCESS — {} bytes, elapsed {:.1}s, output removed from tmp",
        bytes.len(), elapsed.as_secs_f32());
    Ok(general_purpose::STANDARD.encode(&bytes))
}

// ── Private helpers ────────────────────────────────────────────────────────

fn emit_progress(win: &tauri::Window, status: &str, progress: u8) {
    let _ = win.emit("sd-download-progress", serde_json::json!({
        "status":   status,
        "progress": progress
    }));
}

fn find_binary(dir: &Path, name: &str) -> Option<PathBuf> {
    // Also accept the legacy name "sd-cli" or "sd" in case the archive hasn't renamed it yet
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() && p.file_name().and_then(|n| n.to_str()) == Some(name) {
                return Some(p);
            }
            if p.is_dir() {
                if let Some(found) = find_binary(&p, name) {
                    return Some(found);
                }
            }
        }
    }
    None
}

fn collect_models(dir: &Path, out: &mut Vec<String>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                collect_models(&p, out);
            } else if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                if matches!(ext.to_lowercase().as_str(), "safetensors" | "ckpt" | "gguf" | "bin") {
                    out.push(p.to_string_lossy().to_string());
                }
            }
        }
    }
}

fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let out_path = dest.join(entry.name());
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut f = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn extract_targz(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let gz   = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(gz);
    tar.unpack(dest).map_err(|e| e.to_string())?;
    Ok(())
}

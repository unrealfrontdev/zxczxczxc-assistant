// screen_capture.rs — platform-specific screen/window capture
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct CaptureResult {
    pub base64:  String,
    pub width:   u32,
    pub height:  u32,
    pub format:  String,
}

// ═══════════════════════════════════════════════════════════════════════
// macOS — CoreGraphics CGDisplay capture
// ═══════════════════════════════════════════════════════════════════════
#[cfg(target_os = "macos")]
mod platform {
    use super::CaptureResult;
    use anyhow::{anyhow, Result};
    use base64::{engine::general_purpose, Engine};
    use core_graphics::display::{CGDisplay, CGPoint};
    use image::ImageFormat;
    use std::io::Cursor;

    pub fn capture_primary_screen() -> Result<CaptureResult> {
        let display = CGDisplay::main();
        let cg_image = display
            .image()
            .ok_or_else(|| anyhow!("CGDisplay::image() returned None"))?;

        let width         = cg_image.width()  as u32;
        let height        = cg_image.height() as u32;
        let bytes_per_row = cg_image.bytes_per_row();
        let raw           = cg_image.data();
        let raw_bytes     = raw.bytes();

        // CoreGraphics returns BGRA; convert to RGBA for the image crate
        let img_buf = image::ImageBuffer::from_fn(width, height, |x, y| {
            let off = (y as usize * bytes_per_row) + (x as usize * 4);
            let b   = raw_bytes[off];
            let g   = raw_bytes[off + 1];
            let r   = raw_bytes[off + 2];
            let a   = raw_bytes[off + 3];
            image::Rgba([r, g, b, a])
        });

        let mut png: Vec<u8> = Vec::new();
        image::DynamicImage::ImageRgba8(img_buf)
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)?;

        Ok(CaptureResult {
            base64: general_purpose::STANDARD.encode(&png),
            width,
            height,
            format: "png".into(),
        })
    }

    pub fn capture_at_cursor() -> Result<CaptureResult> {
        // TODO: ScreenCaptureKit (macOS 12.3+) for window-aware capture.
        // Falling back to full-screen capture until the SCK Rust bindings
        // are stable enough to ship.
        capture_primary_screen()
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Windows — GDI BitBlt capture
// ═══════════════════════════════════════════════════════════════════════
#[cfg(target_os = "windows")]
mod platform {
    use super::CaptureResult;
    use anyhow::{anyhow, Result};
    use base64::{engine::general_purpose, Engine};
    use image::ImageFormat;
    use std::io::Cursor;
    use windows::Win32::{
        Foundation::{HWND, POINT},
        Graphics::Gdi::{
            BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
            GetDIBits, GetDC, ReleaseDC, SelectObject,
            BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
        },
        UI::WindowsAndMessaging::{GetCursorPos, GetDesktopWindow, GetWindowRect, WindowFromPoint},
    };

    pub fn capture_primary_screen() -> Result<CaptureResult> {
        unsafe { capture_hwnd(GetDesktopWindow()) }
    }

    pub fn capture_at_cursor() -> Result<CaptureResult> {
        unsafe {
            let mut pt = POINT::default();
            GetCursorPos(&mut pt)?;
            let hwnd = WindowFromPoint(pt);
            if hwnd.0 == 0 { capture_primary_screen() } else { capture_hwnd(hwnd) }
        }
    }

    unsafe fn capture_hwnd(hwnd: HWND) -> Result<CaptureResult> {
        let mut rect = windows::Win32::Foundation::RECT::default();
        GetWindowRect(hwnd, &mut rect)?;
        let width  = (rect.right  - rect.left) as u32;
        let height = (rect.bottom - rect.top)  as u32;

        let hdc_src = GetDC(hwnd);
        let hdc_mem = CreateCompatibleDC(hdc_src);
        let hbm     = CreateCompatibleBitmap(hdc_src, width as i32, height as i32);
        SelectObject(hdc_mem, hbm);
        BitBlt(hdc_mem, 0, 0, width as i32, height as i32, hdc_src, 0, 0, SRCCOPY)?;

        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize:        std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth:       width  as i32,
                biHeight:      -(height as i32), // top-down
                biPlanes:      1,
                biBitCount:    32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            bmiColors: [Default::default()],
        };

        let mut pixels = vec![0u8; (width * height * 4) as usize];
        GetDIBits(hdc_mem, hbm, 0, height, Some(pixels.as_mut_ptr() as *mut _),
                  &mut bmi, DIB_RGB_COLORS);

        DeleteObject(hbm);
        DeleteDC(hdc_mem);
        ReleaseDC(hwnd, hdc_src);

        // BGRA → RGBA
        for chunk in pixels.chunks_exact_mut(4) { chunk.swap(0, 2); }

        let img = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(width, height, pixels)
            .ok_or_else(|| anyhow!("Failed to create image buffer from GDI pixels"))?;

        let mut png: Vec<u8> = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)?;

        Ok(CaptureResult {
            base64: general_purpose::STANDARD.encode(&png),
            width,
            height,
            format: "png".into(),
        })
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Linux — Wayland (grim) → X11 (scrot) → X11/Wayland (ImageMagick import)
//
// Priority order:
//   Wayland priority:
//     1. grim             — wlr-screencopy (sway, hyprland, river, …)
//     2. gnome-screenshot — GNOME 41+ Wayland portal
//     3. spectacle        — KDE Plasma
//   X11 priority:
//     4. scrot            — classic X11
//     5. import           — ImageMagick X11 (last resort)
//
// Install on Fedora:  sudo dnf install grim gnome-screenshot spectacle scrot
// Install on Ubuntu:  sudo apt install grim gnome-screenshot spectacle scrot
// Install on Arch:    sudo pacman -S grim gnome-screenshot spectacle scrot
// ═══════════════════════════════════════════════════════════════════════
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
mod platform {
    use super::CaptureResult;
    use anyhow::{anyhow, Context, Result};
    use base64::{engine::general_purpose, Engine};
    use image::GenericImageView;

    pub fn capture_primary_screen() -> Result<CaptureResult> {
        // Ensure WAYLAND_DISPLAY is set even if Tauri didn't inherit it
        ensure_wayland_env();

        let mut errors: Vec<String> = Vec::new();

        // ── Wayland backends ──────────────────────────────────────────
        if std::env::var("WAYLAND_DISPLAY").is_ok() {
            macro_rules! try_backend {
                ($fn:expr, $name:expr) => {
                    match $fn {
                        Ok(r)  => return Ok(r),
                        Err(e) => {
                            log::warn!("{} failed: {}", $name, e);
                            errors.push(format!("{}: {}", $name, e));
                        }
                    }
                };
            }
            try_backend!(try_grim(),               "grim");
            try_backend!(try_gnome_screenshot(),   "gnome-screenshot");
            try_backend!(try_spectacle(),          "spectacle");
        }

        // ── X11 backends ──────────────────────────────────────────────
        if std::env::var("DISPLAY").is_ok() {
            match try_scrot() {
                Ok(r)  => return Ok(r),
                Err(e) => { log::warn!("scrot failed: {}", e); errors.push(format!("scrot: {}", e)); }
            }
            match try_import() {
                Ok(r)  => return Ok(r),
                Err(e) => { log::warn!("import failed: {}", e); errors.push(format!("import: {}", e)); }
            }
        }

        Err(anyhow!(
            "All screenshot backends failed:\n{}\n\nInstall grim (Wayland) or scrot (X11):\n  Fedora: sudo dnf install grim gnome-screenshot\n  Ubuntu: sudo apt install grim gnome-screenshot\n  Arch:   sudo pacman -S grim gnome-screenshot",
            errors.join("\n")
        ))
    }

    /// Falls back to full-screen on Linux.
    pub fn capture_at_cursor() -> Result<CaptureResult> {
        capture_primary_screen()
    }

    // ── display detection ──────────────────────────────────────────────

    /// If WAYLAND_DISPLAY is missing from the process env, try to detect
    /// it from the well-known socket path (helps when Tauri is launched
    /// from a systemd service or via .desktop without env inheritance).
    fn ensure_wayland_env() {
        if std::env::var("WAYLAND_DISPLAY").is_ok() {
            return;
        }
        // Read UID from /proc/self/loginuid
        let uid = std::fs::read_to_string("/proc/self/loginuid")
            .unwrap_or_default();
        let uid = uid.trim();
        if uid.is_empty() || uid == "4294967295" { return; } // not a login session

        let runtime_dir = format!("/run/user/{}", uid);
        // Try wayland-0 … wayland-9
        for i in 0..10 {
            let socket = format!("{}/wayland-{}", runtime_dir, i);
            if std::path::Path::new(&socket).exists() {
                log::info!("Auto-detected WAYLAND_DISPLAY=wayland-{} for uid={}", i, uid);
                // Safety: single-threaded at this point in Tauri init
                unsafe {
                    std::env::set_var("WAYLAND_DISPLAY", format!("wayland-{}", i));
                    std::env::set_var("XDG_RUNTIME_DIR", &runtime_dir);
                }
                return;
            }
        }
    }

    // ── env helpers ────────────────────────────────────────────────────

    fn apply_display_env(cmd: &mut std::process::Command) {
        for var in &["WAYLAND_DISPLAY", "DISPLAY", "XDG_RUNTIME_DIR",
                     "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE"] {
            if let Ok(val) = std::env::var(var) {
                cmd.env(var, val);
            }
        }
    }

    fn tmp_path() -> String {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis()).unwrap_or(0);
        format!("/tmp/ai-assistant-cap-{}.png", ts)
    }

    // ── helpers ────────────────────────────────────────────────────────

    fn png_bytes_to_result(bytes: Vec<u8>) -> Result<CaptureResult> {
        let img = image::load_from_memory(&bytes)
            .context("failed to decode screenshot PNG")?;
        let (width, height) = img.dimensions();
        let b64 = general_purpose::STANDARD.encode(&bytes);
        Ok(CaptureResult { base64: b64, width, height, format: "png".into() })
    }

    fn read_tmp_png(path: &str) -> Result<CaptureResult> {
        let bytes = std::fs::read(path).context("failed to read screenshot temp file")?;
        let _ = std::fs::remove_file(path);
        png_bytes_to_result(bytes)
    }

    fn which_ok(name: &str) -> bool {
        std::process::Command::new("which")
            .arg(name).output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    // ── backend: grim (Wayland, wlr-screencopy) ───────────────────────

    fn try_grim() -> Result<CaptureResult> {
        if !which_ok("grim") { return Err(anyhow!("grim not found in PATH")); }
        let path = tmp_path();
        let mut cmd = std::process::Command::new("grim");
        cmd.arg(&path);
        apply_display_env(&mut cmd);
        let out = cmd.output().context("failed to spawn grim")?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(anyhow!("grim exited {}: {}", out.status, stderr.trim()));
        }
        let r = read_tmp_png(&path)?;
        log::info!("captured via grim");
        Ok(r)
    }

    // ── backend: gnome-screenshot (GNOME Wayland portal) ──────────────

    fn try_gnome_screenshot() -> Result<CaptureResult> {
        if !which_ok("gnome-screenshot") { return Err(anyhow!("gnome-screenshot not found")); }
        let path = tmp_path();
        let mut cmd = std::process::Command::new("gnome-screenshot");
        cmd.args(["--file", &path]);
        apply_display_env(&mut cmd);
        let out = cmd.output().context("failed to spawn gnome-screenshot")?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(anyhow!("gnome-screenshot exited {}: {}", out.status, stderr.trim()));
        }
        let r = read_tmp_png(&path)?;
        log::info!("captured via gnome-screenshot");
        Ok(r)
    }

    // ── backend: spectacle (KDE) ──────────────────────────────────────

    fn try_spectacle() -> Result<CaptureResult> {
        if !which_ok("spectacle") { return Err(anyhow!("spectacle not found")); }
        let path = tmp_path();
        let mut cmd = std::process::Command::new("spectacle");
        cmd.args(["-b", "-n", "-f", "-o", &path]);
        apply_display_env(&mut cmd);
        let out = cmd.output().context("failed to spawn spectacle")?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(anyhow!("spectacle exited {}: {}", out.status, stderr.trim()));
        }
        if !std::path::Path::new(&path).exists() {
            return Err(anyhow!("spectacle produced no output file"));
        }
        let r = read_tmp_png(&path)?;
        log::info!("captured via spectacle");
        Ok(r)
    }

    // ── backend: scrot (X11) ──────────────────────────────────────────

    fn try_scrot() -> Result<CaptureResult> {
        if !which_ok("scrot") { return Err(anyhow!("scrot not found in PATH")); }
        let path = tmp_path();
        let mut cmd = std::process::Command::new("scrot");
        cmd.arg(&path);
        apply_display_env(&mut cmd);
        let status = cmd.status().context("failed to spawn scrot")?;
        if !status.success() {
            return Err(anyhow!("scrot exited with {}", status));
        }
        let r = read_tmp_png(&path)?;
        log::info!("captured via scrot");
        Ok(r)
    }

    // ── backend: ImageMagick import (X11 only) ────────────────────────

    fn try_import() -> Result<CaptureResult> {
        if !which_ok("import") { return Err(anyhow!("import not found in PATH")); }
        if std::env::var("DISPLAY").is_err() {
            return Err(anyhow!("import requires X11 DISPLAY (not set)"));
        }
        let mut cmd = std::process::Command::new("import");
        cmd.args(["-window", "root", "-screen", "png:-"]);
        apply_display_env(&mut cmd);
        let out = cmd.output().context("failed to spawn import")?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(anyhow!("import exited {}: {}", out.status, stderr.trim()));
        }
        if out.stdout.is_empty() {
            return Err(anyhow!("import produced no output"));
        }
        let r = png_bytes_to_result(out.stdout)?;
        log::info!("captured via ImageMagick import");
        Ok(r)
    }
}

// ── Public Tauri commands ────────────────────────────────────────────────

#[tauri::command]
pub async fn capture_screen() -> Result<CaptureResult, String> {
    platform::capture_primary_screen().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn capture_window_under_cursor() -> Result<CaptureResult, String> {
    platform::capture_at_cursor().map_err(|e| e.to_string())
}

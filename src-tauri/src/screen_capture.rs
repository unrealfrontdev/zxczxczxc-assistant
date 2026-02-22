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

// ── Linux stub (X11 / Wayland – placeholder) ────────────────────────────
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
mod platform {
    use super::CaptureResult;
    use anyhow::{anyhow, Result};

    pub fn capture_primary_screen() -> Result<CaptureResult> {
        Err(anyhow!("Screen capture is not yet implemented on Linux"))
    }
    pub fn capture_at_cursor() -> Result<CaptureResult> {
        capture_primary_screen()
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

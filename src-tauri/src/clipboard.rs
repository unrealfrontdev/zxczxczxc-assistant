// clipboard.rs — read image from the system clipboard and return base64 PNG
use arboard::Clipboard;
use base64::{engine::general_purpose, Engine};
use image::{ImageBuffer, Rgba, ImageFormat};
use std::io::Cursor;

/// Read an image from the system clipboard.
/// Returns a base64-encoded PNG string, or an error string.
#[tauri::command]
pub fn get_clipboard_image() -> Result<String, String> {
    let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard init failed: {e}"))?;

    let img_data = clipboard
        .get_image()
        .map_err(|e| format!("No image in clipboard: {e}"))?;

    // arboard gives us raw RGBA bytes
    let width  = img_data.width  as u32;
    let height = img_data.height as u32;
    let bytes  = img_data.bytes.into_owned();

    let img_buf: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(width, height, bytes)
            .ok_or_else(|| "Failed to decode clipboard image data".to_string())?;

    // Encode as PNG into memory buffer
    let mut png_bytes: Vec<u8> = Vec::new();
    image::DynamicImage::ImageRgba8(img_buf)
        .write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
        .map_err(|e| format!("PNG encode failed: {e}"))?;

    let b64 = general_purpose::STANDARD.encode(&png_bytes);
    Ok(b64)
}

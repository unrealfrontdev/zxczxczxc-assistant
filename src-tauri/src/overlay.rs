// overlay.rs — window transparency & click-through control
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, Window};

static CLICK_THROUGH: AtomicBool = AtomicBool::new(false);

/// Enable or disable click-through (cursor event passthrough).
/// Exposed as Tauri command so React can call it directly.
#[tauri::command]
pub fn set_click_through(window: Window, enabled: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())?;

    CLICK_THROUGH.store(enabled, Ordering::SeqCst);

    window
        .emit("click-through-changed", enabled)
        .map_err(|e| e.to_string())?;

    log::info!("click-through → {}", enabled);
    Ok(())
}

/// Flip the current click-through state. Called from hotkey handler.
pub fn toggle_click_through(window: &Window) {
    let next = !CLICK_THROUGH.load(Ordering::SeqCst);
    if let Err(e) = set_click_through(window.clone(), next) {
        log::error!("toggle_click_through failed: {}", e);
    }
}

/// Read the current state (used on frontend startup).
#[tauri::command]
pub fn get_click_through_state() -> bool {
    CLICK_THROUGH.load(Ordering::SeqCst)
}

/// Pin / unpin the window above all others.
#[tauri::command]
pub fn set_always_on_top(window: Window, on_top: bool) -> Result<(), String> {
    window
        .set_always_on_top(on_top)
        .map_err(|e| e.to_string())
}

// ── Unit tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_click_through_state_default() {
        // After module load the global flag must be false
        assert!(!get_click_through_state());
    }

    #[test]
    fn test_click_through_atomic_roundtrip() {
        CLICK_THROUGH.store(true,  Ordering::SeqCst);
        assert!(get_click_through_state());
        CLICK_THROUGH.store(false, Ordering::SeqCst);
        assert!(!get_click_through_state());
    }
}

/// Show or hide the main window (used from tray + hotkey).
pub fn toggle_window(app: &AppHandle) {
    if let Some(win) = app.get_window("main") {
        match win.is_visible() {
            Ok(true)  => { let _ = win.hide(); }
            Ok(false) => { let _ = win.show(); let _ = win.set_focus(); }
            Err(e)    => log::error!("toggle_window: {}", e),
        }
    }
}

// overlay.rs — window transparency, click-through, cursor-area tracking
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Size, Position, Window};

// Width of the interactive right-side panel in physical pixels.
const PANEL_PX: u32 = 460; // slightly wider than the CSS 420 px to cover DPI rounding

// Height of the floating window in windowed mode (physical pixels).
const WINDOW_H: u32 = 720;

// ── Global state ─────────────────────────────────────────────────────────

/// Is the window currently click-through?
static CLICK_THROUGH: AtomicBool = AtomicBool::new(false);

/// Is "ghost mode" (Alt+M) active? In ghost mode the window is ALWAYS
/// click-through regardless of cursor position.
static GHOST_MODE: AtomicBool = AtomicBool::new(false);

/// Left X pixel where the interactive panel starts.
/// When cursor X >= this value the panel should be interactive.
static PANEL_X_START: AtomicI32 = AtomicI32::new(2_147_483_647);

/// Set to true while a native OS file dialog is open so the cursor tracker
/// does not touch `set_ignore_cursor_events` and compete with the dialog.
static DIALOG_OPEN: AtomicBool = AtomicBool::new(false);

/// Is the window in 'windowed' (floating panel) mode?
/// In windowed mode the cursor tracker is disabled — the whole window is interactive.
static WINDOWED_MODE: AtomicBool = AtomicBool::new(false);

// ── Public Tauri commands ─────────────────────────────────────────────────

/// Enable or disable click-through (cursor event passthrough).
#[tauri::command]
pub fn set_click_through(window: Window, enabled: bool) -> Result<(), String> {
    CLICK_THROUGH.store(enabled, Ordering::SeqCst);
    window
        .emit("click-through-changed", enabled)
        .map_err(|e| e.to_string())?;
    log::info!("click-through → {}", enabled);
    let win = window.clone();
    std::thread::spawn(move || {
        if let Err(e) = win.set_ignore_cursor_events(enabled) {
            log::error!("set_ignore_cursor_events failed: {}", e);
        }
    });
    Ok(())
}

/// Toggle ghost mode (Alt+M hotkey).
/// Emits the event FIRST so the UI updates instantly, then calls the
/// potentially slow set_ignore_cursor_events in a background thread.
#[tauri::command]
pub fn toggle_ghost_mode(window: Window) -> Result<bool, String> {
    let next = !GHOST_MODE.load(Ordering::SeqCst);
    GHOST_MODE.store(next, Ordering::SeqCst);
    CLICK_THROUGH.store(next, Ordering::SeqCst);
    // Notify frontend immediately — UI hides the panel before GTK call
    window
        .emit("ghost-mode-changed", next)
        .map_err(|e| e.to_string())?;
    log::info!("ghost mode → {}", next);
    // set_ignore_cursor_events can block on Wayland/GTK — run it off-thread
    let win = window.clone();
    std::thread::spawn(move || {
        if let Err(e) = win.set_ignore_cursor_events(next) {
            log::error!("set_ignore_cursor_events failed: {}", e);
        }
    });
    Ok(next)
}

/// Set ghost mode to an explicit value (called from JS with a known target state).
/// Using set instead of toggle avoids the race condition where both the JS keydown
/// listener and the Rust global shortcut fire at the same time.
#[tauri::command]
pub fn set_ghost_mode(window: Window, value: bool) -> Result<(), String> {
    GHOST_MODE.store(value, Ordering::SeqCst);
    CLICK_THROUGH.store(value, Ordering::SeqCst);
    window
        .emit("ghost-mode-changed", value)
        .map_err(|e| e.to_string())?;
    let win = window.clone();
    std::thread::spawn(move || {
        if let Err(e) = win.set_ignore_cursor_events(value) {
            log::error!("set_ignore_cursor_events failed: {}", e);
        }
    });
    Ok(())
}

/// Tell Rust where the interactive panel starts (screen X in pixels).
#[tauri::command]
pub fn set_panel_x(x: i32) {
    PANEL_X_START.store(x, Ordering::SeqCst);
}

/// Read the current click-through state.
#[tauri::command]
pub fn get_click_through_state() -> bool {
    CLICK_THROUGH.load(Ordering::SeqCst)
}

/// Read the current ghost-mode state.
#[tauri::command]
pub fn get_ghost_mode_state() -> bool {
    GHOST_MODE.load(Ordering::SeqCst)
}

/// Pause or resume the cursor tracker while a native file dialog is open.
/// Shrinks the overlay window to the panel strip so the OS dialog can open
/// freely in the remaining screen space, then restores fullscreen after.
#[tauri::command]
pub fn set_dialog_open(window: Window, open: bool) -> Result<(), String> {
    DIALOG_OPEN.store(open, Ordering::SeqCst);

    if open {
        // ── Get screen dimensions ────────────────────────────────────
        let monitor = window
            .current_monitor()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no monitor detected".to_string())?;
        let sw = monitor.size().width;
        let sh = monitor.size().height;

        // Shrink to panel-only strip on the right
        window
            .set_size(Size::Physical(PhysicalSize { width: PANEL_PX, height: sh }))
            .map_err(|e| e.to_string())?;
        window
            .set_position(Position::Physical(PhysicalPosition {
                x: (sw as i32) - (PANEL_PX as i32),
                y: 0,
            }))
            .map_err(|e| e.to_string())?;

        window.set_always_on_top(false).map_err(|e| e.to_string())?;

        // Disable click-through off-thread (GTK call can block on Wayland)
        let win = window.clone();
        std::thread::spawn(move || {
            let _ = win.set_ignore_cursor_events(false);
            CLICK_THROUGH.store(false, Ordering::SeqCst);
        });
    } else {
        // ── Restore fullscreen overlay ───────────────────────────────
        let monitor = window
            .current_monitor()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "no monitor detected".to_string())?;
        let sw = monitor.size().width;
        let sh = monitor.size().height;

        window
            .set_size(Size::Physical(PhysicalSize { width: sw, height: sh }))
            .map_err(|e| e.to_string())?;
        window
            .set_position(Position::Physical(PhysicalPosition { x: 0, y: 0 }))
            .map_err(|e| e.to_string())?;

        window.set_always_on_top(true).map_err(|e| e.to_string())?;
        // Cursor tracker will re-evaluate click-through on its next tick.
    }
    Ok(())
}

/// Pin / unpin the window above all others.
#[tauri::command]
pub fn set_always_on_top(window: Window, on_top: bool) -> Result<(), String> {
    window
        .set_always_on_top(on_top)
        .map_err(|e| e.to_string())
}

/// Switch between overlay (fullscreen, transparent) and windowed (floating panel) modes.
///
/// - `windowed = true`:  resize to PANEL_PX × WINDOW_H, center on screen,
///   disable click-through and cursor tracker, set always-on-top according to `on_top`.
/// - `windowed = false`: restore full-monitor size, re-enable cursor tracker, always-on-top.
#[tauri::command]
pub fn set_window_mode(window: Window, windowed: bool, on_top: Option<bool>) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no monitor detected".to_string())?;
    let sw = monitor.size().width;
    let sh = monitor.size().height;

    WINDOWED_MODE.store(windowed, Ordering::SeqCst);

    if windowed {
        // ── Floating window mode ─────────────────────────────────────
        // Center the panel on screen
        let wx = ((sw as i32) - (PANEL_PX as i32)) / 2;
        let wy = ((sh as i32) - (WINDOW_H as i32)) / 2;

        window
            .set_size(Size::Physical(PhysicalSize { width: PANEL_PX, height: WINDOW_H }))
            .map_err(|e| e.to_string())?;
        window
            .set_position(Position::Physical(PhysicalPosition { x: wx, y: wy }))
            .map_err(|e| e.to_string())?;

        // The entire window is the panel — make it fully interactive
        PANEL_X_START.store(0, Ordering::SeqCst);
        CLICK_THROUGH.store(false, Ordering::SeqCst);
        GHOST_MODE.store(false, Ordering::SeqCst);

        // Drop always-on-top by default in windowed mode so it feels like a normal window
        let aot = on_top.unwrap_or(false);
        window.set_always_on_top(aot).map_err(|e| e.to_string())?;

        let win = window.clone();
        std::thread::spawn(move || {
            let _ = win.set_ignore_cursor_events(false);
        });

        window.emit("window-mode-changed", true).map_err(|e| e.to_string())?;
    } else {
        // ── Fullscreen overlay mode ──────────────────────────────────
        window
            .set_size(Size::Physical(PhysicalSize { width: sw, height: sh }))
            .map_err(|e| e.to_string())?;
        window
            .set_position(Position::Physical(PhysicalPosition { x: 0, y: 0 }))
            .map_err(|e| e.to_string())?;

        // Restore panel X — cursor tracker will re-evaluate on its next tick
        let panel_x = (sw as i32) - (PANEL_PX as i32);
        PANEL_X_START.store(panel_x, Ordering::SeqCst);

        let aot = on_top.unwrap_or(true);
        window.set_always_on_top(aot).map_err(|e| e.to_string())?;

        window.emit("window-mode-changed", false).map_err(|e| e.to_string())?;
    }

    Ok(())
}

// ── Called from hotkey handler (non-Tauri-command) ────────────────────────

pub fn toggle_click_through(window: &Window) {
    let _ = toggle_ghost_mode(window.clone());
}

pub fn toggle_window(app: &AppHandle) {
    if let Some(win) = app.get_window("main") {
        match win.is_visible() {
            Ok(true)  => { let _ = win.hide(); }
            Ok(false) => { let _ = win.show(); let _ = win.set_focus(); }
            Err(e)    => log::error!("toggle_window: {}", e),
        }
    }
}

// ── Background cursor tracker ─────────────────────────────────────────────

/// Spawn a background thread that polls cursor X every 40 ms and toggles
/// click-through based on whether the cursor is over the interactive panel.
pub fn spawn_cursor_tracker(window: Window) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(40));

            if GHOST_MODE.load(Ordering::SeqCst) {
                continue;
            }

            // In windowed mode the whole window is interactive — tracker is a no-op.
            if WINDOWED_MODE.load(Ordering::SeqCst) {
                continue;
            }

            // Pause while a native file/folder dialog is open.
            if DIALOG_OPEN.load(Ordering::SeqCst) {
                continue;
            }

            let panel_x = PANEL_X_START.load(Ordering::SeqCst);
            if panel_x == 2_147_483_647 {
                continue;
            }

            let cursor_x = match get_cursor_x() {
                Some(x) => x,
                None    => continue, // tool not found or failed — keep retrying
            };

            let should_pass = cursor_x < panel_x;
            let is_pass     = CLICK_THROUGH.load(Ordering::SeqCst);

            if should_pass != is_pass {
                if window.set_ignore_cursor_events(should_pass).is_ok() {
                    CLICK_THROUGH.store(should_pass, Ordering::SeqCst);
                    let _ = window.emit("click-through-changed", should_pass);
                }
            }
        }
    });
}

// ── Platform-specific cursor-X implementations ────────────────────────────

/// Windows: query cursor position via Win32 GetCursorPos.
/// No external tools required — works out of the box on any Win10/11 machine.
#[cfg(target_os = "windows")]
fn get_cursor_x() -> Option<i32> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT::default();
    unsafe {
        if GetCursorPos(&mut pt).is_ok() {
            Some(pt.x)
        } else {
            None
        }
    }
}

/// Linux / macOS: try xdotool (X11) and hyprctl (Hyprland Wayland).
/// On macOS this is currently unused because the cursor tracker is not
/// needed — the panel takes the right portion of the overlay and macOS
/// handles hit-testing transparently. Return None to keep the tracker idle.
#[cfg(not(target_os = "windows"))]
fn get_cursor_x() -> Option<i32> {
    // X11 — xdotool
    if let Ok(out) = std::process::Command::new("xdotool")
        .args(["getmouselocation", "--shell"])
        .output()
    {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Some(v) = line.strip_prefix("X=") {
                    return v.trim().parse().ok();
                }
            }
        }
    }
    // Hyprland Wayland — hyprctl
    if let Ok(out) = std::process::Command::new("hyprctl")
        .args(["cursorpos", "-j"])
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            // {"x":1234,"y":567}
            let digits: String = text.chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit())
                .collect();
            return digits.parse().ok();
        }
    }
    None
}

// ── Unit tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_click_through_state_default() {
        assert!(!get_click_through_state());
    }

    #[test]
    fn test_ghost_mode_state_default() {
        assert!(!get_ghost_mode_state());
    }

    #[test]
    fn test_click_through_atomic_roundtrip() {
        CLICK_THROUGH.store(true, Ordering::SeqCst);
        assert!(get_click_through_state());
        CLICK_THROUGH.store(false, Ordering::SeqCst);
        assert!(!get_click_through_state());
    }
}

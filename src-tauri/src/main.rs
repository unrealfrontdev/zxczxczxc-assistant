#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod ai_bridge;
mod clipboard;
mod overlay;
mod project_indexer;
mod screen_capture;
mod web_search;

use tauri::{GlobalShortcutManager, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTrayMenuItem};

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let tray_menu = SystemTrayMenu::new()
        .add_item(tauri::CustomMenuItem::new("toggle", "Toggle Overlay"))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(tauri::CustomMenuItem::new("quit", "Quit"));

    let system_tray = SystemTray::new().with_menu(tray_menu);

    tauri::Builder::default()
        .system_tray(system_tray)
        // ── Tray event handler ────────────────────────────────────────
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "toggle" => overlay::toggle_window(app),
                "quit"   => std::process::exit(0),
                _        => {}
            },
            SystemTrayEvent::DoubleClick { .. } => overlay::toggle_window(app),
            _ => {}
        })
        .setup(|app| {
            let app_handle = app.handle();

            // ── Cursor tracker (auto click-through on transparent areas) ──
            let win_tracker = app_handle.get_window("main").unwrap();
            overlay::spawn_cursor_tracker(win_tracker);

            // ── Global hotkeys ────────────────────────────────────────
            // Registration is best-effort: some keys may be claimed by the
            // desktop environment (e.g. Alt+Space on GNOME). A failure is
            // logged as a warning instead of crashing the app.
            let mut shortcuts = app.global_shortcut_manager();

            // Alt+M → toggle click-through
            let win = app_handle.get_window("main").unwrap();
            if let Err(e) = shortcuts.register("Alt+M", move || {
                overlay::toggle_click_through(&win);
            }) {
                log::warn!("Could not register Alt+M: {}", e);
            }

            // Alt+Shift+S → capture screen and analyze
            let win_s = app_handle.get_window("main").unwrap();
            if let Err(e) = shortcuts.register("Alt+Shift+S", move || {
                let _ = win_s.emit("trigger-screenshot", ());
            }) {
                log::warn!("Could not register Alt+Shift+S: {}", e);
            }

            // Alt+Shift+H → hide/show window
            let app_h = app_handle.clone();
            if let Err(e) = shortcuts.register("Alt+Shift+H", move || {
                overlay::toggle_window(&app_h);
            }) {
                log::warn!("Could not register Alt+Shift+H: {}", e);
            }

            // ── macOS: keep process as accessory so no dock icon ──────
            #[cfg(target_os = "macos")]
            {
                use cocoa::appkit::{NSApp, NSApplicationActivationPolicy};
                unsafe {
                    NSApp().setActivationPolicy_(
                        NSApplicationActivationPolicy::NSApplicationActivationPolicyAccessory,
                    );
                }
            }

            log::info!("AI Assistant started – hotkeys registered");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            overlay::set_click_through,
            overlay::set_always_on_top,
            overlay::set_dialog_open,
            overlay::set_window_mode,
            overlay::get_click_through_state,
            overlay::toggle_ghost_mode,
            overlay::get_ghost_mode_state,
            overlay::set_ghost_mode,
            overlay::set_panel_x,
            screen_capture::capture_screen,
            screen_capture::capture_window_under_cursor,
            ai_bridge::analyze_with_openai,
            ai_bridge::analyze_with_claude,
            project_indexer::index_directory,
            project_indexer::read_file_content,
            project_indexer::write_file,
            project_indexer::patch_file,
            project_indexer::delete_file,
            ai_bridge::analyze_with_deepseek,
            ai_bridge::analyze_with_openrouter,
            ai_bridge::analyze_with_local,
            ai_bridge::cancel_ai_request,
            web_search::web_search,
            web_search::fetch_url_content,
            web_search::search_and_fetch,
            clipboard::get_clipboard_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

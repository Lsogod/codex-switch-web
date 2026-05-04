mod native_api;

use native_api::{
    api_request, build_context_menu, handle_context_menu_event, refresh_tray_context_menu,
    setup_overlay_window,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, WindowEvent};

fn position_overlay_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("overlay") else {
        return;
    };
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let work_area = monitor.work_area();
        let size = window.outer_size().ok();
        let width = size.map(|size| size.width as i32).unwrap_or(86);
        let x = work_area.position.x + work_area.size.width as i32 - width - 18;
        let y = work_area.position.y + 78;
        let _ = window.set_position(PhysicalPosition { x, y });
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let menu = build_context_menu(app.handle())?;
            let tray_icon =
                tauri::image::Image::from_bytes(include_bytes!("../../build/icon-32.png"))?;

            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .tooltip("Codex Switch")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    handle_context_menu_event(app, event.id.as_ref());
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left | MouseButton::Right,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        refresh_tray_context_menu(tray.app_handle());
                    }
                })
                .build(app)?;

            position_overlay_window(app.handle());
            setup_overlay_window(app.handle());

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![api_request])
        .run(tauri::generate_context!())
        .expect("failed to run Codex Switch Tauri app");
}

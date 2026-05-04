use base64::Engine;
use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalSize};
use thiserror::Error;
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

const PROFILE_FILES: &[&str] = &["auth.json", "config.toml", "AGENTS.md", "models_cache.json"];
const PROFILE_DIRS: &[&str] = &["rules", "pets"];
const SESSION_DIRS: &[&str] = &["sessions", "shell_snapshots"];
const SESSION_DATABASES: &[&str] = &["state_5.sqlite", "logs_1.sqlite", "logs_2.sqlite"];
const GLOBAL_STATE_FILE: &str = ".codex-global-state.json";
const AUTH_EXPORT_FILES: &[&str] = &[
    "auth.json",
    "config.toml",
    "AGENTS.md",
    "models_cache.json",
    "installation_id",
    "version.json",
];
const AUTH_EXPORT_DIRS: &[&str] = &["rules"];
const RECENT_CONVERSATION_SEED_LIMIT: usize = 100;
const AUTO_SWITCH_POLL_MS: i64 = 15_000;
const AUTO_SWITCH_COOLDOWN_MS: i64 = 45_000;
const USAGE_FETCH_TIMEOUT_SECS: u64 = 3;
const USAGE_CACHE_TTL_SECS: i64 = 60;
const OVERLAY_COLLAPSED_SIZE: (u32, u32) = (86, 96);
const OVERLAY_COLLAPSED_NOTICE_SIZE: (u32, u32) = (168, 128);
const OVERLAY_EXPANDED_SIZE: (u32, u32) = (278, 96);
const OVERLAY_EXPANDED_NOTICE_SIZE: (u32, u32) = (278, 128);

#[derive(Debug, Deserialize)]
pub struct ApiRequest {
    method: String,
    path: String,
    body: Option<Value>,
}

#[derive(Debug, Serialize)]
pub struct ApiResponse {
    status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    headers: Option<Vec<(String, String)>>,
    body: Value,
    #[serde(rename = "bodyBase64", skip_serializing_if = "Option::is_none")]
    body_base64: Option<String>,
}

#[derive(Debug, Error)]
enum NativeError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Walkdir(#[from] walkdir::Error),
    #[error(transparent)]
    Zip(#[from] zip::result::ZipError),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
}

type NativeResult<T> = Result<T, NativeError>;

pub fn setup_overlay_window(app: &tauri::AppHandle) {
    let _ = restore_overlay_position(app);
    let enabled = read_shell_state()
        .ok()
        .and_then(|state| {
            state
                .get("overlay")
                .and_then(|value| value.get("enabled"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(true);
    if enabled {
        let _ = show_overlay_window(app, false);
    }
}

fn show_dashboard_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn reload_app_windows(app: &tauri::AppHandle) {
    for label in ["main", "overlay"] {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.eval("window.location.reload()");
        }
    }
}

fn menu_profile_entries() -> Vec<(String, bool)> {
    let active = current_profile_name().unwrap_or_else(|_| String::new());
    list_profile_names()
        .unwrap_or_default()
        .into_iter()
        .map(|name| {
            let is_active = name == active;
            (name, is_active)
        })
        .collect()
}

fn is_overlay_enabled() -> bool {
    read_shell_state()
        .ok()
        .and_then(|state| {
            state
                .get("overlay")
                .and_then(|value| value.get("enabled"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(true)
}

fn toggle_overlay_enabled(app: &tauri::AppHandle) -> NativeResult<()> {
    if is_overlay_enabled() {
        set_overlay_enabled(false)?;
        if let Some(window) = app.get_webview_window("overlay") {
            let _ = window.hide();
        }
    } else {
        set_overlay_enabled(true)?;
        show_overlay_window(app, true)?;
    }
    Ok(())
}

fn switch_profile_from_menu(app: &tauri::AppHandle, profile: &str) -> NativeResult<()> {
    ensure_shared_layout(Some(profile))?;
    let _ = close_codex_processes();
    use_profile(profile, true)?;
    ensure_shared_layout(Some(profile))?;
    open_codex()?;
    reload_app_windows(app);
    Ok(())
}

pub fn build_context_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::with_id(app, "codex-switch-context")?;
    let open_dashboard =
        MenuItem::with_id(app, "open-dashboard", "打开控制台", true, None::<&str>)?;
    let open_codex_item = MenuItem::with_id(app, "open-codex", "启动 Codex", true, None::<&str>)?;
    let profiles = Submenu::with_id(app, "profiles", "账号列表", true)?;
    let profile_entries = menu_profile_entries();

    if profile_entries.is_empty() {
        let empty = MenuItem::with_id(app, "profiles-empty", "暂无账号", false, None::<&str>)?;
        profiles.append(&empty)?;
    } else {
        for (name, active) in profile_entries {
            let label = if active {
                format!("{name}  ✓")
            } else {
                name.clone()
            };
            let item = CheckMenuItem::with_id(
                app,
                format!("profile::{name}"),
                label,
                true,
                active,
                None::<&str>,
            )?;
            profiles.append(&item)?;
        }
    }

    let overlay_enabled = is_overlay_enabled();
    let overlay_item = CheckMenuItem::with_id(
        app,
        "toggle-overlay",
        "显示悬浮额度",
        true,
        overlay_enabled,
        None::<&str>,
    )?;
    let rebuild_sidebar =
        MenuItem::with_id(app, "rebuild-sidebar", "重建侧边栏", true, None::<&str>)?;
    let refresh_windows =
        MenuItem::with_id(app, "refresh-windows", "刷新切换台", true, None::<&str>)?;
    let version = Submenu::with_id(app, "version", "版本与更新", true)?;
    let current_version = MenuItem::with_id(
        app,
        "version-current",
        format!("当前版本 v{}", env!("CARGO_PKG_VERSION")),
        false,
        None::<&str>,
    )?;
    let check_update = MenuItem::with_id(app, "check-update", "检查更新", true, None::<&str>)?;
    version.append(&current_version)?;
    version.append(&check_update)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    menu.append(&open_dashboard)?;
    menu.append(&open_codex_item)?;
    menu.append(&profiles)?;
    menu.append(&overlay_item)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&rebuild_sidebar)?;
    menu.append(&refresh_windows)?;
    menu.append(&version)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&quit)?;
    Ok(menu)
}

pub fn refresh_tray_context_menu(app: &tauri::AppHandle) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(menu) = build_context_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

pub fn show_context_menu(app: &tauri::AppHandle, window_label: &str) -> tauri::Result<()> {
    let menu = build_context_menu(app)?;
    if let Some(window) = app
        .get_webview_window(window_label)
        .or_else(|| app.get_webview_window("overlay"))
        .or_else(|| app.get_webview_window("main"))
    {
        window.popup_menu(&menu)?;
    }
    Ok(())
}

pub fn handle_context_menu_event(app: &tauri::AppHandle, id: &str) {
    let result = match id {
        "open-dashboard" => {
            show_dashboard_window(app);
            Ok(())
        }
        "open-codex" => open_codex(),
        "toggle-overlay" => toggle_overlay_enabled(app),
        "rebuild-sidebar" => {
            let result = ensure_shared_layout(None);
            reload_app_windows(app);
            result
        }
        "refresh-windows" => {
            reload_app_windows(app);
            Ok(())
        }
        "check-update" => {
            show_dashboard_window(app);
            reload_app_windows(app);
            Ok(())
        }
        "quit" => {
            app.exit(0);
            Ok(())
        }
        item if item.starts_with("profile::") => {
            let profile = item.trim_start_matches("profile::");
            switch_profile_from_menu(app, profile)
        }
        _ => Ok(()),
    };

    if let Err(error) = result {
        show_dashboard_window(app);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval(&format!(
                "window.alert({});",
                serde_json::to_string(&format!("Codex Switch: {error}"))
                    .unwrap_or_else(|_| "\"Codex Switch error\"".to_string())
            ));
        }
    }
    refresh_tray_context_menu(app);
}

#[tauri::command]
pub fn api_request(app: tauri::AppHandle, request: ApiRequest) -> ApiResponse {
    match handle_api_request(&app, request) {
        Ok(response) => response,
        Err(error) => ApiResponse {
            status: 500,
            headers: None,
            body: json!({
                "ok": false,
                "error": error.to_string()
            }),
            body_base64: None,
        },
    }
}

fn handle_api_request(app: &tauri::AppHandle, request: ApiRequest) -> NativeResult<ApiResponse> {
    let method = request.method.to_ascii_uppercase();
    let path = request.path.split('?').next().unwrap_or(&request.path);

    let body = match (method.as_str(), path) {
        ("GET", "/api/health") => json!({ "ok": true, "host": "tauri", "port": null }),
        ("GET", "/api/state") => read_state()?,
        ("GET", "/api/sessions") => {
            let session_browser = read_session_browser_state()?;
            json!({
                "ok": true,
                "generatedAt": now_string(),
                "summary": session_browser["summary"].clone(),
                "projects": session_browser["projects"].clone()
            })
        }
        ("GET", "/api/app/version") => app_version(false),
        ("POST", "/api/app/update/check") => app_version(true),
        ("POST", "/api/app/update/install") => json!({
            "ok": false,
            "message": "Tauri 轻量版暂未接入自动安装更新"
        }),
        ("GET", "/api/shell/auto-update-checks-enabled") => {
            json!({ "ok": true, "enabled": read_shell_state()?.get("autoUpdateChecks").and_then(|value| value.get("enabled")).and_then(Value::as_bool).unwrap_or(true) })
        }
        ("POST", "/api/shell/open-dashboard") => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            json!({ "ok": true })
        }
        ("POST", "/api/shell/show-overlay") => {
            set_overlay_enabled(true)?;
            show_overlay_window(app, true)?;
            json!({ "ok": true })
        }
        ("POST", "/api/shell/hide-overlay") => {
            set_overlay_enabled(false)?;
            if let Some(window) = app.get_webview_window("overlay") {
                let _ = window.hide();
            }
            json!({ "ok": true })
        }
        ("POST", "/api/shell/set-overlay-expanded") => {
            let expanded = request
                .body
                .as_ref()
                .and_then(|value| value.get("expanded"))
                .and_then(Value::as_bool)
                == Some(true);
            let has_update_notice = request
                .body
                .as_ref()
                .and_then(|value| value.get("hasUpdateNotice"))
                .and_then(Value::as_bool)
                == Some(true);
            set_overlay_expanded(app, expanded, has_update_notice)?;
            json!({ "ok": true })
        }
        ("POST", "/api/shell/set-overlay-update-notice-visible") => {
            let visible = request
                .body
                .as_ref()
                .and_then(|value| value.get("visible"))
                .and_then(Value::as_bool)
                == Some(true);
            let expanded = request
                .body
                .as_ref()
                .and_then(|value| value.get("expanded"))
                .and_then(Value::as_bool)
                == Some(true);
            set_overlay_expanded(app, expanded, visible)?;
            json!({ "ok": true })
        }
        ("GET", "/api/shell/overlay-bounds") => {
            json!({ "ok": true, "bounds": overlay_bounds(app) })
        }
        ("POST", "/api/shell/set-overlay-position") => {
            let x = request
                .body
                .as_ref()
                .and_then(|value| value.get("x"))
                .and_then(Value::as_i64)
                .unwrap_or(0) as i32;
            let y = request
                .body
                .as_ref()
                .and_then(|value| value.get("y"))
                .and_then(Value::as_i64)
                .unwrap_or(0) as i32;
            set_overlay_position(app, x, y)?;
            json!({ "ok": true })
        }
        ("POST", "/api/shell/show-context-menu") => {
            show_context_menu(app, "overlay")?;
            json!({ "ok": true })
        }
        ("GET", "/api/auth/export") => {
            let (bytes, manifest) = build_auth_export_archive()?;
            let filename = format!("codex-accounts-for-windows-{}.zip", file_stamp());
            return Ok(ApiResponse {
                status: 200,
                headers: Some(vec![
                    ("content-type".to_string(), "application/zip".to_string()),
                    (
                        "content-disposition".to_string(),
                        format!("attachment; filename=\"{filename}\""),
                    ),
                    (
                        "x-codex-profile-count".to_string(),
                        manifest["profiles"]
                            .as_array()
                            .map(|items| items.len())
                            .unwrap_or(0)
                            .to_string(),
                    ),
                    (
                        "x-codex-exported-files".to_string(),
                        manifest["files"].as_u64().unwrap_or(0).to_string(),
                    ),
                ]),
                body: json!({}),
                body_base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            });
        }
        ("POST", "/api/auth/import") => {
            if !list_codex_processes().is_empty() {
                return Ok(ApiResponse {
                    status: 409,
                    headers: None,
                    body: json!({
                        "ok": false,
                        "error": "Codex appears to be running. Close Codex-related processes before importing accounts."
                    }),
                    body_base64: None,
                });
            }
            let bytes = request_body_bytes(request.body.as_ref())?;
            let (imported_files, imported_active, imported_profiles) = import_auth_archive(&bytes)?;
            json!({
                "ok": true,
                "importedFiles": imported_files,
                "importedActive": imported_active,
                "importedProfiles": imported_profiles,
                "message": format!("已导入 {} 个 profile，写入 {} 个凭证/配置文件", imported_profiles.len(), imported_files)
            })
        }
        ("POST", "/api/profile/use") => {
            let body = request.body.as_ref();
            let name = body
                .and_then(|value| value.get("name"))
                .and_then(Value::as_str)
                .ok_or_else(|| NativeError::Message("Missing profile name".to_string()))?;
            let close_and_force = body
                .and_then(|value| value.get("closeAndForce"))
                .and_then(Value::as_bool)
                == Some(true);
            let open_after_switch = body
                .and_then(|value| value.get("openCodex"))
                .and_then(Value::as_bool)
                == Some(true);
            ensure_shared_layout(Some(name))?;
            if close_and_force {
                let _ = close_codex_processes();
            }
            use_profile(name, true)?;
            if open_after_switch {
                open_codex()?;
            }
            json!({ "ok": true, "message": format!("Active Codex profile: {name}") })
        }
        ("POST", "/api/profile/save") => {
            let name = request
                .body
                .as_ref()
                .and_then(|value| value.get("name"))
                .and_then(Value::as_str)
                .ok_or_else(|| NativeError::Message("Missing profile name".to_string()))?;
            save_profile(name)?;
            ensure_shared_layout(Some(name))?;
            json!({ "ok": true, "message": format!("Saved current account as profile {name}") })
        }
        ("POST", "/api/profile/new") => {
            let name = request
                .body
                .as_ref()
                .and_then(|value| value.get("name"))
                .and_then(Value::as_str)
                .ok_or_else(|| NativeError::Message("Missing profile name".to_string()))?;
            new_profile(name)?;
            ensure_shared_layout(Some(name))?;
            json!({ "ok": true, "message": format!("Created fresh profile: {name}") })
        }
        ("POST", "/api/profile/rename") => {
            let old_name = request
                .body
                .as_ref()
                .and_then(|value| value.get("oldName"))
                .and_then(Value::as_str)
                .ok_or_else(|| NativeError::Message("Missing old profile name".to_string()))?;
            let new_name = request
                .body
                .as_ref()
                .and_then(|value| value.get("newName"))
                .and_then(Value::as_str)
                .ok_or_else(|| NativeError::Message("Missing new profile name".to_string()))?;
            rename_profile(old_name, new_name)?;
            ensure_shared_layout(Some(new_name))?;
            json!({ "ok": true, "message": format!("Renamed profile: {old_name} -> {new_name}") })
        }
        ("POST", "/api/profile/delete") => {
            let name = request
                .body
                .as_ref()
                .and_then(|value| value.get("name"))
                .and_then(Value::as_str)
                .ok_or_else(|| NativeError::Message("Missing profile name".to_string()))?;
            delete_profile(name)?;
            json!({ "ok": true, "message": format!("Deleted profile: {name}") })
        }
        ("POST", "/api/codex/rebuild-sidebar") => {
            ensure_shared_layout(None)?;
            json!({ "ok": true, "message": "Merged local session history into the shared store" })
        }
        ("POST", "/api/open/codex") => {
            open_codex()?;
            json!({ "ok": true, "message": "Opened Codex" })
        }
        ("GET", "/api/codex/processes") => json!({
            "ok": true,
            "processes": list_codex_processes()
        }),
        ("POST", "/api/codex/close") => json!(close_codex_processes()),
        ("GET", "/api/auto-switch") => {
            json!({ "ok": true, "autoSwitch": read_auto_switch_state()? })
        }
        ("POST", "/api/auto-switch") => {
            let enabled = request
                .body
                .as_ref()
                .and_then(|value| value.get("enabled"))
                .and_then(Value::as_bool)
                .ok_or_else(|| NativeError::Message("enabled must be boolean".to_string()))?;
            json!({ "ok": true, "autoSwitch": set_auto_switch_enabled(enabled)? })
        }
        ("POST", "/api/login/start") => {
            open_terminal_command("codex login")?;
            json!({ "ok": true, "message": "已打开终端，请在终端里完成 codex login" })
        }
        ("POST", "/api/login/start-device-auth") => {
            open_terminal_command("codex login --device-auth")?;
            json!({ "ok": true, "message": "已打开终端，请按设备码流程登录" })
        }
        ("POST", "/api/login/logout") => logout_codex()?,
        ("POST", "/api/profile/auto-register-active") => auto_register_active_profile()?,
        ("POST", "/api/session/delete") => {
            let id = request
                .body
                .as_ref()
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
                .ok_or_else(|| NativeError::Message("Invalid session id".to_string()))?;
            delete_shared_session_by_id(id)?
        }
        ("POST", "/api/session/resume") => {
            let id = request
                .body
                .as_ref()
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
                .ok_or_else(|| NativeError::Message("Invalid session id".to_string()))?;
            let session = find_shared_session_by_id(id)?
                .ok_or_else(|| NativeError::Message("Session not found".to_string()))?;
            open_terminal_command(&build_resume_command(&session))?;
            json!({ "ok": true, "message": format!("已在终端打开会话：{}", session_title(&session)) })
        }
        ("POST", "/api/session/reveal") => {
            let id = request
                .body
                .as_ref()
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
                .ok_or_else(|| NativeError::Message("Invalid session id".to_string()))?;
            let session = find_shared_session_by_id(id)?
                .ok_or_else(|| NativeError::Message("Session not found".to_string()))?;
            reveal_session(&session)?
        }
        _ => {
            return Ok(ApiResponse {
                status: 404,
                headers: None,
                body: json!({ "ok": false, "error": format!("Unknown API route: {method} {path}") }),
                body_base64: None,
            });
        }
    };

    Ok(ApiResponse {
        status: 200,
        headers: None,
        body,
        body_base64: None,
    })
}

fn app_version(force_refresh: bool) -> Value {
    json!({
        "ok": true,
        "app": {
            "packaged": true,
            "platform": "win32-tauri",
            "currentVersion": env!("CARGO_PKG_VERSION"),
            "currentVersionLabel": format!("v{}", env!("CARGO_PKG_VERSION")),
            "update": {
                "ok": true,
                "checked": force_refresh,
                "available": false,
                "latestVersionLabel": format!("v{}", env!("CARGO_PKG_VERSION")),
                "assetName": null
            },
            "install": {
                "inFlight": false,
                "message": null
            }
        }
    })
}

fn read_state() -> NativeResult<Value> {
    ensure_profiles_dir()?;
    let active_profile = current_profile_name()?;
    cleanup_orphan_login_staging_profiles(&active_profile)?;
    let active_auth = read_auth_for_profile(&active_profile, None)?;
    let mut active_account = extract_profile_meta(active_auth.as_ref());
    let active_usage = read_usage_for_profile(&active_profile, active_auth.as_ref());
    apply_usage_plan_type(&mut active_account, &active_usage);
    let profile_names = list_profile_names()?;
    let profiles = profile_names
        .iter()
        .map(|name| profile_state(name, name == &active_profile))
        .collect::<NativeResult<Vec<_>>>()?;

    Ok(json!({
        "activeProfile": active_profile,
        "loginStatus": read_login_status(active_auth.as_ref()),
        "activeAccount": active_account,
        "activeUsage": active_usage,
        "localSessions": read_local_sessions(80)?,
        "autoSwitch": read_auto_switch_state()?,
        "profilesDir": profiles_dir(),
        "activeCodexDir": active_codex_dir(),
        "profiles": profiles,
        "recommendedProfile": profiles.first().cloned().unwrap_or_else(|| json!(null)),
        "notes": [
            "Windows Tauri shell is migrating core logic from Node to Rust.",
            "Session/thread history and pets are merged into shared local stores before switching profiles.",
            "Some non-critical endpoints still use the Electron/Node build during migration."
        ]
    }))
}

fn profile_state(name: &str, active: bool) -> NativeResult<Value> {
    let dir = profiles_dir().join(name);
    let auth = read_json_if_exists(&dir.join("auth.json"))?;
    let mut meta = extract_profile_meta(auth.as_ref());
    let usage = read_usage_for_profile(name, auth.as_ref());
    apply_usage_plan_type(&mut meta, &usage);
    let meta_obj = meta.as_object_mut().unwrap();
    meta_obj.insert("profileName".to_string(), json!(name));
    meta_obj.insert("path".to_string(), json!(dir));
    meta_obj.insert("active".to_string(), json!(active));
    meta_obj.insert("hasAuth".to_string(), json!(dir.join("auth.json").exists()));
    meta_obj.insert(
        "hasConfig".to_string(),
        json!(dir.join("config.toml").exists()),
    );
    meta_obj.insert("priority".to_string(), build_usage_priority(&usage));
    meta_obj.insert("usage".to_string(), usage);
    Ok(meta)
}

fn apply_usage_plan_type(meta: &mut Value, usage: &Value) {
    let Some(plan_type) = usage
        .get("data")
        .and_then(|data| data.get("planType"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };

    if let Some(meta_obj) = meta.as_object_mut() {
        meta_obj.insert("planType".to_string(), json!(plan_type));
        meta_obj.insert("planSource".to_string(), json!("usage"));
    }
}

fn extract_profile_meta(auth: Option<&Value>) -> Value {
    let tokens = auth
        .and_then(|value| value.get("tokens"))
        .unwrap_or(&Value::Null);
    let id_payload = tokens
        .get("id_token")
        .and_then(Value::as_str)
        .and_then(decode_jwt_payload);
    let access_payload = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .and_then(decode_jwt_payload);
    let auth_meta = id_payload
        .as_ref()
        .and_then(|value| value.get("https://api.openai.com/auth"))
        .or_else(|| {
            access_payload
                .as_ref()
                .and_then(|value| value.get("https://api.openai.com/auth"))
        });
    let profile_meta = access_payload
        .as_ref()
        .and_then(|value| value.get("https://api.openai.com/profile"));

    let email = id_payload
        .as_ref()
        .and_then(|value| value.get("email"))
        .or_else(|| profile_meta.and_then(|value| value.get("email")))
        .cloned()
        .unwrap_or(Value::Null);
    let display_name = id_payload
        .as_ref()
        .and_then(|value| value.get("name"))
        .cloned()
        .unwrap_or(Value::Null);
    let plan_type = auth_meta
        .and_then(|value| {
            value
                .get("chatgpt_plan_type")
                .or_else(|| value.get("plan_type"))
        })
        .cloned()
        .unwrap_or(Value::Null);
    let account_id = tokens
        .get("account_id")
        .or_else(|| auth_meta.and_then(|value| value.get("chatgpt_account_id")))
        .cloned()
        .unwrap_or(Value::Null);
    let auth_mode = auth
        .and_then(|value| value.get("auth_mode"))
        .cloned()
        .unwrap_or(Value::Null);
    let usage_note = if auth_mode == json!("api_key") {
        "For API-key profiles, check the official Platform billing and usage pages."
    } else {
        "ChatGPT/Codex remaining usage is not exposed through a documented local/API endpoint."
    };

    json!({
        "authMode": auth_mode,
        "email": email,
        "displayName": display_name,
        "planType": plan_type,
        "accountId": account_id,
        "lastRefresh": auth.and_then(|value| value.get("last_refresh")).cloned().unwrap_or(Value::Null),
        "usageNote": usage_note
    })
}

fn decode_jwt_payload(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn read_usage_for_profile(name: &str, auth: Option<&Value>) -> Value {
    if let Some(value) = get_fresh_persisted_usage_success(name) {
        return value;
    }

    match read_live_usage_for_auth(auth) {
        Ok(Some(raw)) => {
            let value = json!({
                "ok": true,
                "data": normalize_usage_response(&raw),
                "rawFetchedAt": now_iso_string()
            });
            if usage_has_summary(&value) {
                let _ = set_persisted_usage_success(name, &value);
                value
            } else {
                usage_fallback_or_error(
                    name,
                    "Current account did not return usable usage data.",
                    "warn",
                )
            }
        }
        Ok(None) => usage_fallback_or_error(
            name,
            "Current account does not expose ChatGPT/Codex usage data.",
            "warn",
        ),
        Err(error) => usage_fallback_or_error(name, &error.to_string(), "danger"),
    }
}

fn read_live_usage_for_auth(auth: Option<&Value>) -> NativeResult<Option<Value>> {
    let Some(auth) = auth else {
        return Ok(None);
    };
    if auth.get("auth_mode").and_then(Value::as_str) != Some("chatgpt") {
        return Ok(None);
    }

    let tokens = auth.get("tokens").unwrap_or(&Value::Null);
    let Some(access_token) = tokens.get("access_token").and_then(Value::as_str) else {
        return Ok(None);
    };
    let account_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            decode_jwt_payload(access_token)
                .and_then(|payload| payload.get("https://api.openai.com/auth").cloned())
                .and_then(|auth_meta| {
                    auth_meta
                        .get("chatgpt_account_id")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
        });
    let Some(account_id) = account_id else {
        return Ok(None);
    };

    curl_json(
        "https://chatgpt.com/backend-api/wham/usage",
        &[
            ("Authorization", format!("Bearer {access_token}")),
            ("ChatGPT-Account-Id", account_id),
            ("Accept", "application/json".to_string()),
            ("User-Agent", "codex-switch-web".to_string()),
        ],
    )
    .map(Some)
}

fn curl_json(url: &str, headers: &[(&str, String)]) -> NativeResult<Value> {
    let timeout = USAGE_FETCH_TIMEOUT_SECS.to_string();
    let mut command = Command::new("curl.exe");
    command.args([
        "-sS",
        "--request",
        "GET",
        "--connect-timeout",
        &timeout,
        "--max-time",
        &timeout,
    ]);
    for (name, value) in headers {
        command.args(["-H", &format!("{name}: {value}")]);
    }
    command.args(["-w", "\n%{http_code}", url]);

    let output = command.output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(NativeError::Message(if stderr.is_empty() {
            "Usage request failed.".to_string()
        } else {
            stderr
        }));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let mut lines = stdout.lines().collect::<Vec<_>>();
    let status = lines
        .pop()
        .and_then(|line| line.trim().parse::<u16>().ok())
        .unwrap_or(0);
    let body_text = lines.join("\n");
    let body = if body_text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str::<Value>(body_text.trim()).unwrap_or_else(|_| json!(body_text.trim()))
    };

    if !(200..300).contains(&status) {
        let message = body
            .get("detail")
            .or_else(|| body.get("error"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("Usage request failed with HTTP {status}"));
        return Err(NativeError::Message(message));
    }

    Ok(body)
}

fn normalize_usage_response(usage: &Value) -> Value {
    let primary = normalize_usage_window(
        usage
            .get("rate_limit")
            .and_then(|value| value.get("primary_window")),
        None,
    );
    let secondary = normalize_usage_window(
        usage
            .get("rate_limit")
            .and_then(|value| value.get("secondary_window")),
        None,
    );
    let code_review = normalize_usage_window(
        usage
            .get("code_review_rate_limit")
            .and_then(|value| value.get("primary_window")),
        Some("Code review usage"),
    );
    let additional_limits = usage
        .get("additional_rate_limits")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|entry| {
                    let label = entry
                        .get("limit_name")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or("Additional usage");
                    let primary = normalize_usage_window(
                        entry
                            .get("rate_limit")
                            .and_then(|value| value.get("primary_window")),
                        Some(label),
                    );
                    let secondary = normalize_usage_window(
                        entry
                            .get("rate_limit")
                            .and_then(|value| value.get("secondary_window")),
                        Some(label),
                    );
                    if primary.is_none() && secondary.is_none() {
                        return None;
                    }
                    Some(json!({
                        "label": label,
                        "blocked": entry
                            .get("rate_limit")
                            .map(|rate| {
                                rate.get("limit_reached").and_then(Value::as_bool) == Some(true)
                                    || rate.get("allowed").and_then(Value::as_bool) == Some(false)
                            })
                            .unwrap_or(false),
                        "primary": primary,
                        "secondary": secondary
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let main_windows = [primary.clone(), secondary.clone()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let mut fallback_windows = Vec::new();
    if let Some(value) = code_review.clone() {
        fallback_windows.push(value);
    }
    for limit in &additional_limits {
        if let Some(value) = limit.get("primary").filter(|value| !value.is_null()) {
            fallback_windows.push(value.clone());
        }
        if let Some(value) = limit.get("secondary").filter(|value| !value.is_null()) {
            fallback_windows.push(value.clone());
        }
    }

    let blocked = usage
        .get("rate_limit")
        .map(|rate| {
            rate.get("limit_reached").and_then(Value::as_bool) == Some(true)
                || rate.get("allowed").and_then(Value::as_bool) == Some(false)
        })
        .unwrap_or(false)
        || main_windows
            .iter()
            .any(|window| percent_field(window, "remainingPercent") == Some(0));
    let summary = build_usage_summary(&main_windows, blocked)
        .or_else(|| build_usage_summary(&fallback_windows, false));
    let credits = usage.get("credits").map(|credits| {
        json!({
            "hasCredits": credits.get("has_credits").and_then(Value::as_bool) == Some(true),
            "unlimited": credits.get("unlimited").and_then(Value::as_bool) == Some(true),
            "balance": credits.get("balance").and_then(Value::as_f64)
        })
    });

    json!({
        "planType": usage.get("plan_type").cloned().unwrap_or(Value::Null),
        "blocked": blocked,
        "primary": primary,
        "secondary": secondary,
        "codeReview": code_review,
        "additionalLimits": additional_limits,
        "credits": credits,
        "summary": summary
    })
}

fn normalize_usage_window(window: Option<&Value>, fallback_name: Option<&str>) -> Option<Value> {
    let window = window?;
    let used_percent = clamp_percent(window.get("used_percent").and_then(Value::as_f64))?;
    let remaining_percent = clamp_percent(Some(100.0 - used_percent as f64))?;
    let window_duration_mins = window
        .get("limit_window_seconds")
        .and_then(Value::as_f64)
        .map(|value| (value / 60.0).round() as i64);

    Some(json!({
        "label": fallback_name.map(str::to_string).unwrap_or_else(|| format_window_label(window_duration_mins)),
        "usedPercent": used_percent,
        "remainingPercent": remaining_percent,
        "windowDurationMins": window_duration_mins,
        "resetAt": window.get("reset_at").and_then(Value::as_f64).and_then(to_iso_from_unix_seconds)
    }))
}

fn build_usage_summary(windows: &[Value], blocked: bool) -> Option<Value> {
    let candidates = windows
        .iter()
        .filter(|window| percent_field(window, "remainingPercent").is_some())
        .cloned()
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return None;
    }
    let mut limiting = candidates[0].clone();
    for candidate in candidates.iter().skip(1) {
        if usage_window_is_more_constrained(candidate, &limiting) {
            limiting = candidate.clone();
        }
    }
    let remaining_percent = percent_field(&limiting, "remainingPercent")?;
    if let Some(obj) = limiting.as_object_mut() {
        obj.insert("remainingPercent".to_string(), json!(remaining_percent));
        obj.insert(
            "blocked".to_string(),
            json!(blocked || remaining_percent == 0),
        );
        obj.insert("aggregate".to_string(), json!(candidates.len() > 1));
        obj.insert("windowCount".to_string(), json!(candidates.len()));
        if candidates.len() > 1 {
            obj.insert("note".to_string(), json!("按最紧限制窗口汇总"));
        }
    }
    Some(limiting)
}

fn usage_window_is_more_constrained(left: &Value, right: &Value) -> bool {
    let left_remaining = percent_field(left, "remainingPercent").unwrap_or(i64::MAX);
    let right_remaining = percent_field(right, "remainingPercent").unwrap_or(i64::MAX);
    if left_remaining != right_remaining {
        return left_remaining < right_remaining;
    }

    let left_reset = left.get("resetAt").and_then(Value::as_str).unwrap_or("");
    let right_reset = right.get("resetAt").and_then(Value::as_str).unwrap_or("");
    if left_reset.is_empty() != right_reset.is_empty() {
        return !left_reset.is_empty();
    }
    left_reset < right_reset
}

fn build_usage_priority(usage: &Value) -> Value {
    if usage.get("ok").and_then(Value::as_bool) == Some(false) {
        return json!({
            "score": -260,
            "level": "unknown",
            "label": "待确认",
            "reason": usage.get("error").and_then(Value::as_str).unwrap_or("额度查询失败"),
            "usable": false,
            "remainingPercent": null,
            "resetAt": null,
            "stale": true
        });
    }

    let summary = usage.get("data").and_then(|data| data.get("summary"));
    let remaining = summary.and_then(|value| percent_field(value, "remainingPercent"));
    let Some(remaining) = remaining else {
        return json!({
            "score": -220,
            "level": "unknown",
            "label": "待确认",
            "reason": "当前账号未返回可分析的额度窗口",
            "usable": false,
            "remainingPercent": null,
            "resetAt": null,
            "stale": true
        });
    };

    let blocked = usage
        .get("data")
        .and_then(|data| data.get("blocked"))
        .and_then(Value::as_bool)
        == Some(true)
        || summary
            .and_then(|value| value.get("blocked"))
            .and_then(Value::as_bool)
            == Some(true)
        || remaining <= 0;
    let level = if blocked {
        "blocked"
    } else if remaining <= 35 {
        "medium"
    } else {
        "high"
    };
    json!({
        "score": if blocked { -180 } else { 100 - remaining },
        "level": level,
        "label": if blocked { "暂不可用" } else { "可用" },
        "reason": format!("剩余 {remaining}%"),
        "usable": !blocked,
        "remainingPercent": remaining,
        "resetAt": summary.and_then(|value| value.get("resetAt")).cloned().unwrap_or(Value::Null),
        "stale": usage.get("fallback").and_then(Value::as_bool) == Some(true)
    })
}

fn usage_fallback_or_error(name: &str, message: &str, level: &str) -> Value {
    if let Some(mut value) = get_persisted_usage_success(name) {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("fallback".to_string(), json!(true));
            obj.insert(
                "issue".to_string(),
                json!({
                    "level": level,
                    "message": format!("{message}; showing last successful usage data"),
                    "showNotice": false
                }),
            );
        }
        return value;
    }
    json!({
        "ok": false,
        "error": message,
        "issue": {
            "level": level,
            "message": message,
            "showNotice": false
        }
    })
}

fn usage_has_summary(value: &Value) -> bool {
    value.get("ok").and_then(Value::as_bool) != Some(false)
        && value
            .get("data")
            .and_then(|data| data.get("summary"))
            .and_then(|summary| summary.get("remainingPercent"))
            .is_some()
}

fn get_persisted_usage_success(cache_key: &str) -> Option<Value> {
    let store = read_json_if_exists(&usage_snapshot_path()).ok().flatten()?;
    let value = store.get(cache_key)?.clone();
    usage_has_summary(&value).then_some(value)
}

fn get_fresh_persisted_usage_success(cache_key: &str) -> Option<Value> {
    let value = get_persisted_usage_success(cache_key)?;
    let fetched_at = value.get("rawFetchedAt").and_then(Value::as_str)?;
    let fetched_at = DateTime::parse_from_rfc3339(fetched_at).ok()?;
    let age = Utc::now().signed_duration_since(fetched_at.with_timezone(&Utc));
    (age.num_seconds() <= USAGE_CACHE_TTL_SECS).then_some(value)
}

fn set_persisted_usage_success(cache_key: &str, value: &Value) -> NativeResult<()> {
    if !usage_has_summary(value) {
        return Ok(());
    }
    let path = usage_snapshot_path();
    let mut store = read_json_if_exists(&path)?.unwrap_or_else(|| json!({}));
    if !store.is_object() {
        store = json!({});
    }
    if let Some(obj) = store.as_object_mut() {
        obj.insert(cache_key.to_string(), value.clone());
    }
    write_json(&path, &store)
}

fn percent_field(value: &Value, key: &str) -> Option<i64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .and_then(|number| clamp_percent(Some(number)))
}

fn clamp_percent(value: Option<f64>) -> Option<i64> {
    let value = value?;
    value
        .is_finite()
        .then(|| value.round().clamp(0.0, 100.0) as i64)
}

fn format_window_label(window_duration_mins: Option<i64>) -> String {
    match window_duration_mins {
        Some(value) if value >= 1440 => "Weekly usage".to_string(),
        Some(value) if value >= 60 => {
            format!("{}-hour usage", (value as f64 / 60.0).round() as i64)
        }
        Some(value) if value > 0 => format!("{value}-minute usage"),
        _ => "Usage limit".to_string(),
    }
}

fn to_iso_from_unix_seconds(value: f64) -> Option<String> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    DateTime::<Utc>::from_timestamp(value as i64, 0).map(|date| date.to_rfc3339())
}

fn ensure_shared_layout(target_profile_name: Option<&str>) -> NativeResult<()> {
    ensure_profiles_dir()?;
    ensure_dir(&shared_sessions_dir())?;
    ensure_dir(&shared_pets_dir())?;

    let active_profile = current_profile_name()?;
    let profile_names = list_profile_names()?;

    if matches!(
        active_profile.as_str(),
        "missing" | "unknown" | "unmanaged" | "external-link"
    ) && active_codex_dir().exists()
    {
        sync_session_artifacts_from_dir(&active_codex_dir())?;
        sync_global_state_from_dir(&active_codex_dir())?;
        sync_pets_from_dir(&active_codex_dir())?;
    }

    for profile_name in &profile_names {
        let dir = profile_dir(profile_name);
        sync_session_artifacts_from_dir(&dir)?;
        sync_global_state_from_dir(&dir)?;
        sync_pets_from_dir(&dir)?;
    }

    let mut profiles_to_link: HashSet<String> = profile_names.into_iter().collect();
    if let Some(target) = target_profile_name {
        profiles_to_link.insert(target.to_string());
    }
    if !matches!(
        active_profile.as_str(),
        "missing" | "unknown" | "unmanaged" | "external-link"
    ) {
        profiles_to_link.insert(active_profile);
    }

    for profile_name in profiles_to_link {
        let dir = profile_dir(&profile_name);
        if !dir.exists() {
            continue;
        }
        link_profile_pets_to_shared(&dir)?;
        for db_name in SESSION_DATABASES {
            merge_sqlite_database(&shared_sessions_dir().join(db_name), &dir.join(db_name))?;
        }
        merge_session_index(
            &shared_sessions_dir().join("session_index.jsonl"),
            &dir.join("session_index.jsonl"),
        )?;
        for dir_name in SESSION_DIRS {
            merge_directory_into(&shared_sessions_dir().join(dir_name), &dir.join(dir_name))?;
        }
    }
    repair_shared_session_index()?;
    Ok(())
}

fn sync_session_artifacts_from_dir(source_dir: &Path) -> NativeResult<()> {
    for db_name in SESSION_DATABASES {
        merge_sqlite_database(
            &shared_sessions_dir().join(db_name),
            &source_dir.join(db_name),
        )?;
    }
    merge_session_index(
        &shared_sessions_dir().join("session_index.jsonl"),
        &source_dir.join("session_index.jsonl"),
    )?;
    for dir_name in SESSION_DIRS {
        merge_directory_into(
            &shared_sessions_dir().join(dir_name),
            &source_dir.join(dir_name),
        )?;
    }
    repair_shared_session_index()?;
    Ok(())
}

fn sync_global_state_from_dir(source_dir: &Path) -> NativeResult<()> {
    let source = source_dir.join(GLOBAL_STATE_FILE);
    if !source.exists() {
        return Ok(());
    }
    let mut shared = read_json_if_exists(&shared_global_state_path())?.unwrap_or_else(|| json!({}));
    let incoming = read_json_if_exists(&source)?.unwrap_or_else(|| json!({}));
    merge_json_objects(&mut shared, &incoming);
    write_json(&shared_global_state_path(), &shared)?;
    Ok(())
}

fn merge_json_objects(target: &mut Value, source: &Value) {
    let Some(target_map) = target.as_object_mut() else {
        *target = source.clone();
        return;
    };
    let Some(source_map) = source.as_object() else {
        return;
    };
    for (key, value) in source_map {
        target_map
            .entry(key.clone())
            .or_insert_with(|| value.clone());
    }
}

fn sync_pets_from_dir(source_dir: &Path) -> NativeResult<()> {
    merge_directory_into(&shared_pets_dir(), &source_dir.join("pets"))
}

fn link_profile_pets_to_shared(profile_dir: &Path) -> NativeResult<()> {
    let pets_path = profile_dir.join("pets");
    if same_entry(&pets_path, &shared_pets_dir()) {
        return Ok(());
    }
    if pets_path.exists() {
        sync_pets_from_dir(profile_dir)?;
        fs::remove_dir_all(&pets_path).ok();
    }
    create_junction_or_symlink(&shared_pets_dir(), &pets_path)
}

fn merge_sqlite_database(shared_path: &Path, source_path: &Path) -> NativeResult<()> {
    if !source_path.exists() || same_entry(shared_path, source_path) {
        return Ok(());
    }
    ensure_dir(shared_path.parent().unwrap())?;
    if !shared_path.exists() {
        fs::copy(source_path, shared_path)?;
        return Ok(());
    }

    let conn = Connection::open(shared_path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    let source = source_path.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("ATTACH DATABASE '{}' AS src;", source))?;

    for table in common_tables(&conn)? {
        let main_columns = table_columns(&conn, "main", &table)?;
        let source_columns = table_columns(&conn, "src", &table)?;
        let columns: Vec<String> = main_columns
            .into_iter()
            .filter(|column| source_columns.contains(column))
            .collect();
        if columns.is_empty() {
            continue;
        }
        let column_sql = columns
            .iter()
            .map(|column| sql_ident(column))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "INSERT OR IGNORE INTO main.{} ({}) SELECT {} FROM src.{};",
            sql_ident(&table),
            column_sql,
            column_sql,
            sql_ident(&table)
        );
        conn.execute_batch(&sql)?;
    }

    conn.execute_batch("DETACH DATABASE src; PRAGMA wal_checkpoint(TRUNCATE);")?;
    Ok(())
}

fn common_tables(conn: &Connection) -> NativeResult<Vec<String>> {
    let main = table_names(conn, "main")?;
    let src = table_names(conn, "src")?;
    Ok(main
        .into_iter()
        .filter(|table| src.contains(table))
        .collect())
}

fn table_names(conn: &Connection, schema: &str) -> NativeResult<HashSet<String>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT name FROM {}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
        sql_ident(schema)
    ))?;
    let names = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut out = HashSet::new();
    for name in names {
        out.insert(name?);
    }
    Ok(out)
}

fn table_columns(conn: &Connection, schema: &str, table: &str) -> NativeResult<Vec<String>> {
    let mut stmt = conn.prepare(&format!(
        "PRAGMA {}.table_info({});",
        sql_ident(schema),
        sql_ident(table)
    ))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut columns = Vec::new();
    for column in rows {
        columns.push(column?);
    }
    Ok(columns)
}

fn sql_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn merge_session_index(shared_path: &Path, source_path: &Path) -> NativeResult<()> {
    if !source_path.exists() || same_entry(shared_path, source_path) {
        return Ok(());
    }
    ensure_dir(shared_path.parent().unwrap())?;
    let mut seen_ids = HashSet::new();
    let mut entries = Vec::new();
    for path in [shared_path, source_path] {
        if !path.exists() {
            continue;
        }
        let raw = fs::read_to_string(path)?;
        for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let Some(id) = read_index_id(&value) else {
                continue;
            };
            if seen_ids.insert(id) {
                entries.push(value);
            }
        }
    }
    write_session_index_entries(shared_path, &entries)?;
    Ok(())
}

fn write_session_index_entries(path: &Path, entries: &[Value]) -> NativeResult<()> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let mut lines = Vec::new();
    for entry in entries {
        lines.push(serde_json::to_string(entry)?);
    }
    fs::write(path, format!("{}\n", lines.join("\n")))?;
    Ok(())
}

fn repair_shared_session_index() -> NativeResult<()> {
    let index_path = shared_sessions_dir().join("session_index.jsonl");
    let mut seen_ids = HashSet::new();
    let mut entries = Vec::new();

    for session in read_shared_thread_rows(None)? {
        let Some(id) = session.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !seen_ids.insert(id.to_string()) {
            continue;
        }
        entries.push(json!({
            "id": id,
            "thread_name": session.get("baseTitle").or_else(|| session.get("title")).and_then(Value::as_str).unwrap_or(id),
            "updated_at": session.get("updatedAt").cloned().unwrap_or(Value::Null)
        }));
    }

    for entry in read_session_index_entries(None)? {
        let Some(id) = read_index_id(&entry) else {
            continue;
        };
        if seen_ids.insert(id) {
            entries.push(entry);
        }
    }

    if !entries.is_empty() {
        write_session_index_entries(&index_path, &entries)?;
    }
    Ok(())
}

fn merge_directory_into(target: &Path, source: &Path) -> NativeResult<()> {
    if !source.exists() || same_entry(target, source) {
        return Ok(());
    }
    ensure_dir(target)?;
    for entry in WalkDir::new(source) {
        let entry = entry?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|error| NativeError::Message(error.to_string()))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let dest = target.join(relative);
        if entry.file_type().is_dir() {
            ensure_dir(&dest)?;
        } else if !dest.exists() {
            if let Some(parent) = dest.parent() {
                ensure_dir(parent)?;
            }
            fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

fn read_session_index_entries(limit: Option<usize>) -> NativeResult<Vec<Value>> {
    let index_path = shared_sessions_dir().join("session_index.jsonl");
    if !index_path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(index_path)?;
    let mut out = Vec::new();
    for line in raw.lines().filter(|line| !line.trim().is_empty()) {
        if limit.map(|max| out.len() >= max).unwrap_or(false) {
            break;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            out.push(value);
        }
    }
    Ok(out)
}

fn read_index_id(entry: &Value) -> Option<String> {
    entry
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn read_index_title(entry: &Value) -> Option<String> {
    entry
        .get("threadName")
        .or_else(|| entry.get("thread_name"))
        .or_else(|| entry.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string)
}

fn read_index_updated_at(entry: &Value) -> Option<String> {
    entry
        .get("updatedAt")
        .or_else(|| entry.get("updated_at"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|updated| !updated.is_empty())
        .map(str::to_string)
}

fn session_fallback_title(id: &str) -> String {
    format!("会话 {id}")
}

fn read_shared_thread_rows(limit: Option<usize>) -> NativeResult<Vec<Value>> {
    let db_path = shared_sessions_dir().join("state_5.sqlite");
    if !db_path.exists() {
        return Ok(Vec::new());
    }

    let conn = match Connection::open(db_path) {
        Ok(conn) => conn,
        Err(_) => return Ok(Vec::new()),
    };
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));

    let sql = if limit.is_some() {
        "SELECT id, updated_at, cwd, source, archived, rollout_path, model_provider, model, title, first_user_message, agent_nickname, agent_role FROM threads ORDER BY updated_at DESC LIMIT ?1"
    } else {
        "SELECT id, updated_at, cwd, source, archived, rollout_path, model_provider, model, title, first_user_message, agent_nickname, agent_role FROM threads ORDER BY updated_at DESC"
    };
    let mut stmt = match conn.prepare(sql) {
        Ok(stmt) => stmt,
        Err(_) => return Ok(Vec::new()),
    };

    let mut out = Vec::new();
    if let Some(max) = limit {
        let rows = stmt.query_map([max as i64], thread_row_to_value)?;
        for row in rows {
            if let Ok(value) = row {
                out.push(value);
            }
        }
    } else {
        let rows = stmt.query_map([], thread_row_to_value)?;
        for row in rows {
            if let Ok(value) = row {
                out.push(value);
            }
        }
    }
    Ok(out)
}

fn thread_row_to_value(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let id: String = row.get(0)?;
    let updated_at_seconds: i64 = row.get(1)?;
    let cwd: String = row.get(2)?;
    let source: String = row.get(3)?;
    let archived: i64 = row.get(4)?;
    let rollout_path: String = row.get(5)?;
    let model_provider: String = row.get(6)?;
    let model: Option<String> = row.get(7).ok();
    let title: String = row.get(8)?;
    let first_user_message: Option<String> = row.get(9).ok();
    let agent_nickname: Option<String> = row.get(10).ok();
    let agent_role: Option<String> = row.get(11).ok();
    let base_title = if title.trim().is_empty() {
        first_user_message
            .as_deref()
            .map(str::trim)
            .filter(|message| !message.is_empty())
            .unwrap_or("")
            .to_string()
    } else {
        title
    };
    let display_title = if let Some(nickname) = agent_nickname
        .as_deref()
        .map(str::trim)
        .filter(|nickname| !nickname.is_empty())
    {
        format!("{base_title} · {nickname}")
    } else {
        base_title.clone()
    };

    Ok(json!({
        "id": id,
        "title": display_title,
        "baseTitle": base_title,
        "updatedAt": to_iso_from_unix_seconds(updated_at_seconds as f64),
        "cwd": cwd,
        "source": format_session_source(&source, agent_nickname.as_deref(), agent_role.as_deref()),
        "rawSource": source,
        "agentNickname": agent_nickname,
        "agentRole": agent_role,
        "archived": archived == 1,
        "rolloutPath": rollout_path,
        "modelProvider": model_provider,
        "model": model.unwrap_or_default()
    }))
}

fn format_session_source(
    source: &str,
    agent_nickname: Option<&str>,
    agent_role: Option<&str>,
) -> String {
    if let Some(nickname) = agent_nickname
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return if let Some(role) = agent_role.map(str::trim).filter(|value| !value.is_empty()) {
            format!("subagent:{nickname}/{role}")
        } else {
            format!("subagent:{nickname}")
        };
    }
    let source = source.trim();
    if source.starts_with('{') {
        return "subagent".to_string();
    }
    source.to_string()
}

fn read_shared_sessions(limit: Option<usize>) -> NativeResult<Vec<Value>> {
    let index_limit = limit;
    let db_limit = limit.map(|max| max.saturating_mul(2).max(max));
    let index_entries = read_session_index_entries(index_limit)?;
    let index_by_id: HashMap<String, Value> = index_entries
        .iter()
        .filter_map(|entry| read_index_id(entry).map(|id| (id, entry.clone())))
        .collect();
    let thread_rows = read_shared_thread_rows(db_limit)?;

    let mut merged = HashMap::<String, Value>::new();
    for mut row in thread_rows {
        let Some(id) = row.get("id").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        if let Some(obj) = row.as_object_mut() {
            if let Some(index) = index_by_id.get(&id) {
                if obj
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty()
                {
                    obj.insert(
                        "title".to_string(),
                        json!(
                            read_index_title(index).unwrap_or_else(|| session_fallback_title(&id))
                        ),
                    );
                }
                if obj.get("updatedAt").is_none() || obj.get("updatedAt") == Some(&Value::Null) {
                    if let Some(updated_at) = read_index_updated_at(index) {
                        obj.insert("updatedAt".to_string(), json!(updated_at));
                    }
                }
            }
            if obj
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                obj.insert("title".to_string(), json!(session_fallback_title(&id)));
            }
        }
        merged.insert(id, row);
    }

    for entry in index_entries {
        let Some(id) = read_index_id(&entry) else {
            continue;
        };
        if merged.contains_key(&id) {
            continue;
        }
        merged.insert(
            id.clone(),
            json!({
                "id": id,
                "title": read_index_title(&entry).unwrap_or_else(|| session_fallback_title(&id)),
                "updatedAt": read_index_updated_at(&entry),
                "cwd": entry.get("cwd").and_then(Value::as_str).unwrap_or(""),
                "source": entry.get("source").and_then(Value::as_str).unwrap_or(""),
                "archived": false,
                "rolloutPath": entry.get("rolloutPath").or_else(|| entry.get("rollout_path")).and_then(Value::as_str).unwrap_or(""),
                "modelProvider": entry.get("modelProvider").or_else(|| entry.get("model_provider")).and_then(Value::as_str).unwrap_or(""),
                "model": entry.get("model").and_then(Value::as_str).unwrap_or("")
            }),
        );
    }

    let mut ordered: Vec<Value> = merged.into_values().collect();
    ordered.sort_by(|left, right| {
        let left_time = left.get("updatedAt").and_then(Value::as_str).unwrap_or("");
        let right_time = right.get("updatedAt").and_then(Value::as_str).unwrap_or("");
        right_time.cmp(left_time)
    });
    if let Some(max) = limit {
        ordered.truncate(max);
    }
    Ok(ordered)
}

fn read_local_sessions(limit: usize) -> NativeResult<Vec<Value>> {
    read_shared_sessions(Some(limit))
}

fn read_all_local_sessions() -> NativeResult<Vec<Value>> {
    read_shared_sessions(None)
}

fn read_session_browser_state() -> NativeResult<Value> {
    repair_shared_session_index()?;
    let sessions = read_all_local_sessions()?;
    let global_state = read_json_if_exists(&shared_global_state_path())?;
    let known_workspace_roots = get_known_workspace_roots(global_state.as_ref());
    let sidebar_seed_ids: HashSet<String> = sessions
        .iter()
        .take(RECENT_CONVERSATION_SEED_LIMIT)
        .filter_map(|session| session.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let mut projects = Vec::<Value>::new();
    let mut by_key = std::collections::BTreeMap::<String, Vec<Value>>::new();

    for mut session in sessions.iter().cloned() {
        let cwd = session
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let workspace_root = resolve_workspace_root(&cwd, &known_workspace_roots);
        let project_key = if workspace_root.is_empty() {
            if cwd.is_empty() {
                session
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|id| format!("id:{id}"))
                    .unwrap_or_else(|| "unknown".to_string())
            } else {
                format!("cwd:{cwd}")
            }
        } else {
            workspace_root.clone()
        };
        let session_id = session
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(obj) = session.as_object_mut() {
            obj.insert("workspaceRoot".to_string(), json!(workspace_root.clone()));
            obj.insert(
                "sidebarSeeded".to_string(),
                json!(sidebar_seed_ids.contains(&session_id)),
            );
        }
        by_key.entry(project_key).or_default().push(session);
    }

    for (project_key, project_sessions) in by_key {
        let workspace_root = project_sessions
            .first()
            .and_then(|session| session.get("workspaceRoot"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let sidebar_count = project_sessions
            .iter()
            .filter(|session| session.get("sidebarSeeded").and_then(Value::as_bool) == Some(true))
            .count();
        let latest_updated_at = project_sessions
            .iter()
            .filter_map(|session| session.get("updatedAt").and_then(Value::as_str))
            .max()
            .map(str::to_string);
        projects.push(json!({
            "workspaceRoot": workspace_root,
            "label": workspace_label(if workspace_root.is_empty() { &project_key } else { &workspace_root }),
            "totalCount": project_sessions.len(),
            "sidebarCount": sidebar_count,
            "hiddenCount": project_sessions.len().saturating_sub(sidebar_count),
            "latestUpdatedAt": latest_updated_at,
            "sessions": project_sessions
        }));
    }

    projects.sort_by(|left, right| {
        let left_root = left
            .get("workspaceRoot")
            .and_then(Value::as_str)
            .unwrap_or("");
        let right_root = right
            .get("workspaceRoot")
            .and_then(Value::as_str)
            .unwrap_or("");
        let left_rank = workspace_root_rank(left_root, &known_workspace_roots);
        let right_rank = workspace_root_rank(right_root, &known_workspace_roots);
        if left_rank != right_rank {
            return left_rank.cmp(&right_rank);
        }
        let left_time = left
            .get("latestUpdatedAt")
            .and_then(Value::as_str)
            .unwrap_or("");
        let right_time = right
            .get("latestUpdatedAt")
            .and_then(Value::as_str)
            .unwrap_or("");
        right_time.cmp(left_time)
    });

    Ok(json!({
        "summary": {
            "totalSessions": sessions.len(),
            "totalProjects": projects.len(),
            "sidebarWindowSize": RECENT_CONVERSATION_SEED_LIMIT,
            "visibleProjects": projects.iter().filter(|project| project.get("sidebarCount").and_then(Value::as_u64).unwrap_or(0) > 0).count(),
            "hiddenSessions": sessions.len().saturating_sub(RECENT_CONVERSATION_SEED_LIMIT.min(sessions.len()))
        },
        "projects": projects
    }))
}

fn workspace_label(workspace_root: &str) -> String {
    if workspace_root.is_empty() || workspace_root == "unknown" {
        return "未分组".to_string();
    }
    let normalized = workspace_root
        .strip_prefix("cwd:")
        .or_else(|| workspace_root.strip_prefix("id:"))
        .unwrap_or(workspace_root);
    Path::new(normalized)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| normalized.to_string())
}

fn get_known_workspace_roots(global_state: Option<&Value>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut roots = Vec::new();
    for key in [
        "project-order",
        "electron-saved-workspace-roots",
        "active-workspace-roots",
    ] {
        if let Some(items) = global_state
            .and_then(|state| state.get(key))
            .and_then(Value::as_array)
        {
            for item in items {
                if let Some(root) = item.as_str().map(str::trim).filter(|root| !root.is_empty()) {
                    if seen.insert(root.to_string()) {
                        roots.push(root.to_string());
                    }
                }
            }
        }
    }
    roots
}

fn normalize_comparable_path(path: &str) -> String {
    let trimmed = path.trim();
    let stripped = trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed);
    stripped
        .replace('/', r"\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn is_workspace_root_match(cwd: &str, root: &str) -> bool {
    let cwd = normalize_comparable_path(cwd);
    let root = normalize_comparable_path(root);
    if cwd.is_empty() || root.is_empty() {
        return false;
    }
    cwd == root || cwd.starts_with(&format!(r"{root}\"))
}

fn resolve_workspace_root(cwd: &str, workspace_roots: &[String]) -> String {
    let normalized_cwd = cwd.trim();
    if normalized_cwd.is_empty() {
        return String::new();
    }
    workspace_roots
        .iter()
        .filter(|root| is_workspace_root_match(normalized_cwd, root))
        .max_by_key(|root| root.len())
        .cloned()
        .unwrap_or_else(|| normalized_cwd.to_string())
}

fn workspace_root_rank(workspace_root: &str, workspace_roots: &[String]) -> usize {
    workspace_roots
        .iter()
        .position(|root| {
            normalize_comparable_path(root) == normalize_comparable_path(workspace_root)
        })
        .unwrap_or(usize::MAX)
}

fn find_shared_session_by_id(session_id: &str) -> NativeResult<Option<Value>> {
    let normalized = session_id.trim();
    if normalized.is_empty() {
        return Ok(None);
    }
    Ok(read_all_local_sessions()?
        .into_iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(normalized)))
}

fn session_title(session: &Value) -> String {
    session
        .get("title")
        .and_then(Value::as_str)
        .or_else(|| session.get("id").and_then(Value::as_str))
        .unwrap_or("unknown")
        .to_string()
}

fn build_resume_command(session: &Value) -> String {
    let id = session.get("id").and_then(Value::as_str).unwrap_or("");
    let cwd = session.get("cwd").and_then(Value::as_str).unwrap_or("");
    if cwd.is_empty() {
        format!("codex resume --all {}", powershell_quote(id))
    } else {
        format!(
            "Set-Location -LiteralPath {}; codex resume --all {}",
            powershell_quote(cwd),
            powershell_quote(id)
        )
    }
}

fn open_terminal_command(command: &str) -> NativeResult<()> {
    let script = format!(
        "Start-Process -FilePath powershell.exe -ArgumentList @('-NoExit','-Command',{})",
        powershell_quote(command)
    );
    let status = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .status()?;
    if !status.success() {
        return Err(NativeError::Message(
            "Failed to open PowerShell".to_string(),
        ));
    }
    Ok(())
}

fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn reveal_session(session: &Value) -> NativeResult<Value> {
    let rollout_path = session
        .get("rolloutPath")
        .and_then(Value::as_str)
        .unwrap_or("");
    let cwd_path = session.get("cwd").and_then(Value::as_str).unwrap_or("");
    let rollout = PathBuf::from(rollout_path);
    let cwd = PathBuf::from(cwd_path);

    if !rollout_path.is_empty() && rollout.exists() {
        Command::new("explorer.exe")
            .arg(format!("/select,{}", rollout.display()))
            .spawn()?;
        return Ok(json!({ "ok": true, "message": "已在文件管理器中定位到会话文件" }));
    }
    if !cwd_path.is_empty() && cwd.exists() {
        Command::new("explorer.exe").arg(cwd).spawn()?;
        return Ok(json!({ "ok": true, "message": "已打开会话目录" }));
    }

    Err(NativeError::Message(
        "No local file path found for this session".to_string(),
    ))
}

fn delete_shared_session_by_id(session_id: &str) -> NativeResult<Value> {
    let normalized = session_id.trim();
    if normalized.is_empty() {
        return Ok(json!({ "ok": false, "error": "Invalid session id" }));
    }
    let Some(session) = find_shared_session_by_id(normalized)? else {
        return Ok(json!({ "ok": false, "notFound": true, "error": "Session not found" }));
    };

    delete_session_from_databases(normalized)?;
    delete_session_from_index(normalized)?;
    delete_session_from_global_state(normalized)?;
    let deleted_files = delete_session_artifacts(normalized, &session)?;

    Ok(json!({
        "ok": true,
        "message": format!("已删除 session：{}", session_title(&session)),
        "deletedFiles": deleted_files
    }))
}

fn delete_session_from_databases(session_id: &str) -> NativeResult<()> {
    let thread_id = session_id.replace('\'', "''");
    for db_name in SESSION_DATABASES {
        let db_path = shared_sessions_dir().join(db_name);
        if !db_path.exists() {
            continue;
        }
        let conn = Connection::open(db_path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        for table in [
            "thread_dynamic_tools",
            "stage1_outputs",
            "agent_job_items",
            "logs",
            "threads",
        ] {
            if table_names(&conn, "main")?.contains(table) {
                let column = if table == "threads" {
                    "id"
                } else {
                    "thread_id"
                };
                let sql = format!(
                    "DELETE FROM {} WHERE {} = '{}';",
                    sql_ident(table),
                    sql_ident(column),
                    thread_id
                );
                let _ = conn.execute_batch(&sql);
            }
        }
        if table_names(&conn, "main")?.contains("thread_spawn_edges") {
            let sql = format!(
                "DELETE FROM thread_spawn_edges WHERE child_thread_id = '{}' OR parent_thread_id = '{}';",
                thread_id, thread_id
            );
            let _ = conn.execute_batch(&sql);
        }
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    Ok(())
}

fn delete_session_from_index(session_id: &str) -> NativeResult<()> {
    let path = shared_sessions_dir().join("session_index.jsonl");
    if !path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(&path)?;
    let lines = raw
        .lines()
        .filter(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|value| {
                    value
                        .get("id")
                        .and_then(Value::as_str)
                        .map(|id| id != session_id)
                })
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();
    fs::write(path, format!("{}\n", lines.join("\n")))?;
    Ok(())
}

fn delete_session_from_global_state(session_id: &str) -> NativeResult<()> {
    let path = shared_global_state_path();
    let Some(mut state) = read_json_if_exists(&path)? else {
        return Ok(());
    };
    if let Some(obj) = state.as_object_mut() {
        for key in [
            "thread-titles",
            "thread-workspace-root-hints",
            "queued-follow-ups",
        ] {
            if let Some(value) = obj.get_mut(key).and_then(Value::as_object_mut) {
                value.remove(session_id);
            }
        }
    }
    write_json(&path, &state)
}

fn delete_session_artifacts(session_id: &str, session: &Value) -> NativeResult<usize> {
    let mut candidates = HashSet::new();
    if let Some(path) = session.get("rolloutPath").and_then(Value::as_str) {
        if !path.is_empty() {
            candidates.insert(PathBuf::from(path));
        }
    }
    for dir in SESSION_DIRS {
        let root = shared_sessions_dir().join(dir);
        if !root.exists() {
            continue;
        }
        for entry in WalkDir::new(root) {
            let entry = entry?;
            if entry.file_type().is_file() {
                if let Ok(raw) = fs::read_to_string(entry.path()) {
                    if raw.contains(session_id) {
                        candidates.insert(entry.path().to_path_buf());
                    }
                }
            }
        }
    }
    let mut deleted = 0;
    for path in candidates {
        if path.exists() && fs::remove_file(path).is_ok() {
            deleted += 1;
        }
    }
    Ok(deleted)
}

fn use_profile(name: &str, force: bool) -> NativeResult<()> {
    validate_profile_name(name)?;
    if !force && !list_codex_processes().is_empty() {
        return Err(NativeError::Message(
            "Codex appears to be running. Close Codex first, or rerun with force.".to_string(),
        ));
    }
    let target = profile_dir(name);
    if !target.exists() {
        return Err(NativeError::Message(format!(
            "profile does not exist: {name}"
        )));
    }
    remove_active_codex_dir()?;
    create_junction_or_symlink(&target, &active_codex_dir())
}

fn save_profile(name: &str) -> NativeResult<()> {
    validate_profile_name(name)?;
    ensure_profiles_dir()?;
    if !active_codex_dir().exists() {
        return Err(NativeError::Message("~/.codex does not exist".to_string()));
    }
    let source = canonicalize_if_exists(&active_codex_dir()).unwrap_or_else(active_codex_dir);
    let target = profile_dir(name);
    let tmp = profiles_dir().join(format!("{name}.tmp.{}", std::process::id()));
    if tmp.exists() {
        fs::remove_dir_all(&tmp)?;
    }
    copy_profile_payload(&source, &tmp)?;
    if target.exists() {
        fs::remove_dir_all(&target)?;
    }
    fs::rename(tmp, target)?;
    Ok(())
}

fn new_profile(name: &str) -> NativeResult<()> {
    validate_profile_name(name)?;
    ensure_profiles_dir()?;
    let target = profile_dir(name);
    if target.exists() {
        return Err(NativeError::Message(format!(
            "profile already exists: {name}"
        )));
    }
    ensure_dir(&target)?;
    let source = canonicalize_if_exists(&active_codex_dir()).unwrap_or_else(active_codex_dir);
    for item in ["config.toml", "AGENTS.md"] {
        copy_path_if_exists(&source.join(item), &target.join(item))?;
    }
    for item in PROFILE_DIRS {
        copy_path_if_exists(&source.join(item), &target.join(item))?;
    }
    Ok(())
}

fn rename_profile(old_name: &str, new_name: &str) -> NativeResult<()> {
    validate_profile_name(old_name)?;
    validate_profile_name(new_name)?;
    ensure_profiles_dir()?;
    let source = profile_dir(old_name);
    let target = profile_dir(new_name);
    if !source.exists() {
        return Err(NativeError::Message(format!(
            "profile does not exist: {old_name}"
        )));
    }
    if target.exists() {
        return Err(NativeError::Message(format!(
            "target profile already exists: {new_name}"
        )));
    }
    let active = current_profile_name()?;
    fs::rename(&source, &target)?;
    if active == old_name {
        remove_active_codex_dir()?;
        create_junction_or_symlink(&target, &active_codex_dir())?;
    }
    Ok(())
}

fn delete_profile(name: &str) -> NativeResult<()> {
    validate_profile_name(name)?;
    if current_profile_name()? == name {
        return Err(NativeError::Message(format!(
            "cannot delete the active profile: {name}"
        )));
    }
    let target = profile_dir(name);
    if target.exists() {
        fs::remove_dir_all(target)?;
    }
    Ok(())
}

fn validate_profile_name(name: &str) -> NativeResult<()> {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | '+' | '-'))
    {
        return Err(NativeError::Message(format!(
            "invalid profile name: {name}"
        )));
    }
    Ok(())
}

fn current_profile_name() -> NativeResult<String> {
    let codex_dir = active_codex_dir();
    if !codex_dir.exists() {
        return Ok("missing".to_string());
    }
    let resolved = canonicalize_if_exists(&codex_dir);
    let profiles_root = canonicalize_if_exists(&profiles_dir());
    if let (Some(resolved), Some(profiles_root)) = (resolved, profiles_root) {
        if let Ok(relative) = resolved.strip_prefix(&profiles_root) {
            if let Some(name) = relative.components().next() {
                return Ok(name.as_os_str().to_string_lossy().to_string());
            }
        }
    }
    Ok("unmanaged".to_string())
}

fn list_profile_names() -> NativeResult<Vec<String>> {
    ensure_profiles_dir()?;
    let mut names = Vec::new();
    for entry in fs::read_dir(profiles_dir())? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || is_internal_profile_name(&name) || !entry.file_type()?.is_dir()
        {
            continue;
        }
        names.push(name);
    }
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(names)
}

fn is_internal_profile_name(name: &str) -> bool {
    name.starts_with("pre-switch-") || name.starts_with("login-staging-")
}

fn cleanup_orphan_login_staging_profiles(active_profile: &str) -> NativeResult<()> {
    for name in list_profile_names()? {
        if name.starts_with("login-") && name != active_profile {
            let auth = read_json_if_exists(&profile_dir(&name).join("auth.json"))?;
            if auth.is_none() {
                fs::remove_dir_all(profile_dir(&name)).ok();
            }
        }
    }
    Ok(())
}

fn read_auth_for_profile(active_profile: &str, name: Option<&str>) -> NativeResult<Option<Value>> {
    let target = if let Some(name) = name {
        profile_dir(name).join("auth.json")
    } else if matches!(
        active_profile,
        "missing" | "unknown" | "unmanaged" | "external-link"
    ) {
        active_codex_dir().join("auth.json")
    } else {
        profile_dir(active_profile).join("auth.json")
    };
    read_json_if_exists(&target)
}

fn read_login_status(auth: Option<&Value>) -> String {
    match auth
        .and_then(|value| value.get("auth_mode"))
        .and_then(Value::as_str)
    {
        Some("chatgpt") => "Logged in using ChatGPT".to_string(),
        Some("api_key") => "Logged in using API key".to_string(),
        Some(mode) => format!("Logged in using {mode}"),
        None => "Not logged in".to_string(),
    }
}

fn list_codex_processes() -> Vec<Value> {
    let script = "Get-Process | Where-Object { $_.ProcessName -in @('Codex','codex') } | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress";
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() {
        return Vec::new();
    }
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    match parsed {
        Value::Array(items) => items,
        Value::Object(_) => vec![parsed],
        _ => Vec::new(),
    }
}

fn close_codex_processes() -> Value {
    let mut closed = 0;
    for process in list_codex_processes() {
        if let Some(pid) = process.get("Id").and_then(Value::as_i64) {
            let status = Command::new("taskkill.exe")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .status();
            if matches!(status, Ok(status) if status.success()) {
                closed += 1;
            }
        }
    }
    json!({ "ok": true, "closed": closed })
}

fn open_codex() -> NativeResult<()> {
    let script = "Get-StartApps | Where-Object { $_.Name -eq 'Codex' -or $_.AppID -like 'OpenAI.Codex*' } | Select-Object -First 1 -ExpandProperty AppID";
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()?;
    let app_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !app_id.is_empty() {
        Command::new("explorer.exe")
            .arg(format!("shell:AppsFolder\\{app_id}"))
            .spawn()?;
        return Ok(());
    }
    Command::new("cmd.exe")
        .args(["/d", "/s", "/c", "start", "\"\"", "Codex"])
        .spawn()?;
    Ok(())
}

fn logout_codex() -> NativeResult<Value> {
    let output = Command::new("codex").arg("logout").output()?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Ok(json!({
        "ok": output.status.success(),
        "message": if stdout.is_empty() { stderr } else { stdout }
    }))
}

fn auto_register_active_profile() -> NativeResult<Value> {
    let active_profile = current_profile_name()?;
    let auth = read_auth_for_profile(&active_profile, None)?;
    let meta = extract_profile_meta(auth.as_ref());
    let email = meta.get("email").and_then(Value::as_str).unwrap_or("");
    if email.is_empty() {
        return Ok(json!({
            "ok": false,
            "changed": false,
            "message": "Active account email is missing or not usable as a profile name"
        }));
    }
    validate_profile_name(email)?;
    if active_profile == email {
        return Ok(json!({
            "ok": true,
            "changed": false,
            "message": "Active profile already matches the account email"
        }));
    }
    if profile_dir(email).exists() {
        return Ok(json!({
            "ok": false,
            "changed": false,
            "message": "An email-named profile already exists"
        }));
    }
    if matches!(
        active_profile.as_str(),
        "missing" | "unknown" | "unmanaged" | "external-link"
    ) {
        save_profile(email)?;
    } else {
        rename_profile(&active_profile, email)?;
    }
    ensure_shared_layout(Some(email))?;
    Ok(json!({
        "ok": true,
        "changed": true,
        "profileName": email,
        "message": format!("Saved active account as profile {email}")
    }))
}

fn read_auto_switch_state() -> NativeResult<Value> {
    let config = read_json_if_exists(&auto_switch_state_path())?.unwrap_or_else(|| json!({}));
    Ok(json!({
        "enabled": config.get("enabled").and_then(Value::as_bool).unwrap_or(false),
        "inFlight": false,
        "pollIntervalMs": AUTO_SWITCH_POLL_MS,
        "cooldownMs": AUTO_SWITCH_COOLDOWN_MS,
        "lastCheckAt": null,
        "lastActionAt": null,
        "lastAction": null,
        "lastDecision": null,
        "lastError": null
    }))
}

fn read_shell_state() -> NativeResult<Value> {
    let mut state = read_json_if_exists(&shell_state_path())?.unwrap_or_else(|| json!({}));
    if !state.is_object() {
        state = json!({});
    }
    let overlay_enabled = state
        .get("overlay")
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let overlay_x = state
        .get("overlay")
        .and_then(|value| value.get("x"))
        .and_then(Value::as_i64);
    let overlay_y = state
        .get("overlay")
        .and_then(|value| value.get("y"))
        .and_then(Value::as_i64);
    let auto_updates = state
        .get("autoUpdateChecks")
        .and_then(|value| value.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    Ok(json!({
        "overlay": {
            "enabled": overlay_enabled,
            "x": overlay_x,
            "y": overlay_y
        },
        "autoUpdateChecks": {
            "enabled": auto_updates
        }
    }))
}

fn write_shell_state(state: &Value) -> NativeResult<()> {
    write_json(&shell_state_path(), state)
}

fn set_overlay_enabled(enabled: bool) -> NativeResult<()> {
    let mut state = read_shell_state()?;
    if let Some(overlay) = state.get_mut("overlay").and_then(Value::as_object_mut) {
        overlay.insert("enabled".to_string(), json!(enabled));
    }
    write_shell_state(&state)
}

fn save_overlay_position(x: i32, y: i32) -> NativeResult<()> {
    let mut state = read_shell_state()?;
    if let Some(overlay) = state.get_mut("overlay").and_then(Value::as_object_mut) {
        overlay.insert("x".to_string(), json!(x));
        overlay.insert("y".to_string(), json!(y));
    }
    write_shell_state(&state)
}

fn show_overlay_window(app: &tauri::AppHandle, restore: bool) -> NativeResult<()> {
    let Some(window) = app.get_webview_window("overlay") else {
        return Ok(());
    };
    if restore {
        restore_overlay_position(app)?;
    }
    set_overlay_expanded(app, false, false)?;
    window.set_always_on_top(true)?;
    window.show()?;
    Ok(())
}

fn restore_overlay_position(app: &tauri::AppHandle) -> NativeResult<()> {
    let state = read_shell_state()?;
    let Some(overlay) = state.get("overlay") else {
        return Ok(());
    };
    let x = overlay
        .get("x")
        .and_then(Value::as_i64)
        .map(|value| value as i32);
    let y = overlay
        .get("y")
        .and_then(Value::as_i64)
        .map(|value| value as i32);
    let Some(window) = app.get_webview_window("overlay") else {
        return Ok(());
    };
    let size = window.outer_size().ok();
    let width = size
        .map(|size| size.width)
        .unwrap_or_else(|| overlay_logical_to_physical_size(&window, OVERLAY_COLLAPSED_SIZE).0);
    let height = size
        .map(|size| size.height)
        .unwrap_or_else(|| overlay_logical_to_physical_size(&window, OVERLAY_COLLAPSED_SIZE).1);
    let position = if let (Some(x), Some(y)) = (x, y) {
        clamp_overlay_position(app, x, y, width, height)
    } else {
        default_overlay_position(app, width, height)
    };
    window.set_position(PhysicalPosition {
        x: position.0,
        y: position.1,
    })?;
    Ok(())
}

fn set_overlay_expanded(
    app: &tauri::AppHandle,
    expanded: bool,
    has_update_notice: bool,
) -> NativeResult<()> {
    let Some(window) = app.get_webview_window("overlay") else {
        return Ok(());
    };
    let logical_size = overlay_target_size(expanded, has_update_notice);
    let (width, height) = overlay_logical_to_physical_size(&window, logical_size);
    let current_position = window
        .outer_position()
        .unwrap_or(PhysicalPosition { x: 0, y: 0 });
    let current_size = window.outer_size().unwrap_or_else(|_| {
        let (width, height) = overlay_logical_to_physical_size(&window, OVERLAY_COLLAPSED_SIZE);
        PhysicalSize::new(width, height)
    });
    let x = current_position.x;
    let y = current_position.y + current_size.height as i32 - height as i32;
    let position = clamp_overlay_position(app, x, y, width, height);
    window.set_size(LogicalSize::new(
        logical_size.0 as f64,
        logical_size.1 as f64,
    ))?;
    window.set_position(PhysicalPosition {
        x: position.0,
        y: position.1,
    })?;
    Ok(())
}

fn overlay_bounds(app: &tauri::AppHandle) -> Value {
    let Some(window) = app.get_webview_window("overlay") else {
        return Value::Null;
    };
    let position = window
        .outer_position()
        .unwrap_or(PhysicalPosition { x: 0, y: 0 });
    let size = window.outer_size().unwrap_or_else(|_| {
        let (width, height) = overlay_logical_to_physical_size(&window, OVERLAY_COLLAPSED_SIZE);
        PhysicalSize::new(width, height)
    });
    json!({
        "x": position.x,
        "y": position.y,
        "width": size.width,
        "height": size.height
    })
}

fn set_overlay_position(app: &tauri::AppHandle, x: i32, y: i32) -> NativeResult<()> {
    let Some(window) = app.get_webview_window("overlay") else {
        return Ok(());
    };
    let size = window.outer_size().unwrap_or(PhysicalSize::new(
        OVERLAY_COLLAPSED_SIZE.0,
        OVERLAY_COLLAPSED_SIZE.1,
    ));
    let position = clamp_overlay_position(app, x, y, size.width, size.height);
    window.set_position(PhysicalPosition {
        x: position.0,
        y: position.1,
    })?;
    save_overlay_position(position.0, position.1)
}

fn overlay_target_size(expanded: bool, has_update_notice: bool) -> (u32, u32) {
    match (expanded, has_update_notice) {
        (true, true) => OVERLAY_EXPANDED_NOTICE_SIZE,
        (true, false) => OVERLAY_EXPANDED_SIZE,
        (false, true) => OVERLAY_COLLAPSED_NOTICE_SIZE,
        (false, false) => OVERLAY_COLLAPSED_SIZE,
    }
}

fn overlay_logical_to_physical_size(
    window: &tauri::WebviewWindow,
    logical_size: (u32, u32),
) -> (u32, u32) {
    let scale = window.scale_factor().unwrap_or(1.0);
    (
        ((logical_size.0 as f64) * scale).round().max(1.0) as u32,
        ((logical_size.1 as f64) * scale).round().max(1.0) as u32,
    )
}

fn default_overlay_position(app: &tauri::AppHandle, width: u32, _height: u32) -> (i32, i32) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let area = monitor.work_area();
        return (
            area.position.x + area.size.width as i32 - width as i32 - 18,
            area.position.y + 78,
        );
    }
    (18, 78)
}

fn clamp_overlay_position(
    app: &tauri::AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> (i32, i32) {
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return (x, y);
    };
    let area = monitor.work_area();
    let min_x = area.position.x;
    let min_y = area.position.y;
    let max_x = area.position.x + area.size.width as i32 - width as i32;
    let max_y = area.position.y + area.size.height as i32 - height as i32;
    (x.clamp(min_x, max_x), y.clamp(min_y, max_y))
}

fn set_auto_switch_enabled(enabled: bool) -> NativeResult<Value> {
    write_json(
        &auto_switch_state_path(),
        &json!({
            "enabled": enabled,
            "updatedAt": now_string()
        }),
    )?;
    read_auto_switch_state()
}

fn request_body_bytes(body: Option<&Value>) -> NativeResult<Vec<u8>> {
    let encoded = body
        .and_then(|value| value.get("base64"))
        .and_then(Value::as_str)
        .ok_or_else(|| NativeError::Message("Missing uploaded archive bytes".to_string()))?;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| NativeError::Message(error.to_string()))
}

fn build_auth_export_archive() -> NativeResult<(Vec<u8>, Value)> {
    let cursor = Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let active_profile = current_profile_name()?;
    let profile_names = list_profile_names()?;
    let mut exported_profiles = Vec::new();
    let mut exported_files = 0usize;

    if active_codex_dir().exists() {
        exported_files +=
            add_auth_payload_to_zip(&mut zip, &active_codex_dir(), ".codex", options)?;
    }
    for profile_name in profile_names {
        let count = add_auth_payload_to_zip(
            &mut zip,
            &profile_dir(&profile_name),
            &format!(".codex-profiles/{profile_name}"),
            options,
        )?;
        if count > 0 {
            exported_profiles.push(profile_name);
            exported_files += count;
        }
    }

    let manifest = json!({
        "version": 1,
        "exportedAt": now_string(),
        "activeProfile": active_profile,
        "profiles": exported_profiles,
        "files": exported_files,
        "note": "Contains local Codex auth credentials and profile configuration only. Session history is intentionally excluded."
    });
    zip.start_file("codex-auth-export-manifest.json", options)?;
    zip.write_all(format!("{}\n", serde_json::to_string_pretty(&manifest)?).as_bytes())?;
    zip.start_file("README-WINDOWS.txt", options)?;
    zip.write_all(b"Windows restore:\n1. Open Codex Switch and use Import Accounts.\n2. Verify: codex login status\n\nThis archive contains Codex auth credentials. Delete it after restoring.\n")?;

    Ok((zip.finish()?.into_inner(), manifest))
}

fn add_auth_payload_to_zip(
    zip: &mut ZipWriter<Cursor<Vec<u8>>>,
    source_dir: &Path,
    prefix: &str,
    options: SimpleFileOptions,
) -> NativeResult<usize> {
    let mut count = 0;
    for file_name in AUTH_EXPORT_FILES {
        let path = source_dir.join(file_name);
        if path.exists() && path.is_file() {
            zip.start_file(format!("{prefix}/{file_name}"), options)?;
            zip.write_all(&fs::read(path)?)?;
            count += 1;
        }
    }
    for dir_name in AUTH_EXPORT_DIRS {
        let root = source_dir.join(dir_name);
        if !root.exists() {
            continue;
        }
        for entry in WalkDir::new(&root) {
            let entry = entry?;
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(&root)
                .map_err(|error| NativeError::Message(error.to_string()))?;
            let rel = rel.to_string_lossy().replace('\\', "/");
            zip.start_file(format!("{prefix}/{dir_name}/{rel}"), options)?;
            zip.write_all(&fs::read(entry.path())?)?;
            count += 1;
        }
    }
    Ok(count)
}

fn import_auth_archive(bytes: &[u8]) -> NativeResult<(usize, bool, Vec<String>)> {
    if bytes.is_empty() {
        return Err(NativeError::Message(
            "Uploaded archive is empty".to_string(),
        ));
    }
    let cursor = Cursor::new(bytes);
    let mut archive =
        ZipArchive::new(cursor).map_err(|error| NativeError::Message(error.to_string()))?;
    let mut imported_files = 0usize;
    let mut imported_active = false;
    let mut imported_profiles = HashSet::<String>::new();

    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| NativeError::Message(error.to_string()))?;
        if file.is_dir() {
            continue;
        }
        let Some((target, profile_name, active)) = resolve_auth_import_target(file.name())? else {
            continue;
        };
        if let Some(parent) = target.parent() {
            ensure_dir(parent)?;
        }
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;
        fs::write(target, data)?;
        imported_files += 1;
        imported_active |= active;
        if let Some(profile_name) = profile_name {
            imported_profiles.insert(profile_name);
        }
    }

    if imported_files == 0 {
        return Err(NativeError::Message(
            "Archive does not contain supported Codex auth/profile files".to_string(),
        ));
    }
    let mut profiles = imported_profiles.into_iter().collect::<Vec<_>>();
    profiles.sort();
    Ok((imported_files, imported_active, profiles))
}

fn resolve_auth_import_target(
    entry_name: &str,
) -> NativeResult<Option<(PathBuf, Option<String>, bool)>> {
    let normalized = normalize_zip_entry_name(entry_name)?;
    let parts = normalized.split('/').collect::<Vec<_>>();
    if parts.first() == Some(&".codex") {
        let relative = parts[1..].join("/");
        if !is_allowed_auth_relative_path(&relative) {
            return Ok(None);
        }
        return Ok(Some((
            active_codex_dir().join(relative_path(&relative)),
            None,
            true,
        )));
    }
    if parts.first() == Some(&".codex-profiles") {
        let profile_name = parts.get(1).copied().unwrap_or("");
        validate_profile_name(profile_name)?;
        let relative = parts[2..].join("/");
        if !is_allowed_auth_relative_path(&relative) {
            return Ok(None);
        }
        return Ok(Some((
            profile_dir(profile_name).join(relative_path(&relative)),
            Some(profile_name.to_string()),
            false,
        )));
    }
    Ok(None)
}

fn normalize_zip_entry_name(entry_name: &str) -> NativeResult<String> {
    let raw = entry_name.replace('\\', "/");
    if raw.is_empty() || raw.starts_with('/') || raw.contains(':') {
        return Err(NativeError::Message(format!(
            "Invalid archive path: {entry_name}"
        )));
    }
    let parts = raw
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>();
    if parts.iter().any(|part| *part == "..") {
        return Err(NativeError::Message(format!(
            "Invalid archive path: {entry_name}"
        )));
    }
    Ok(parts.join("/"))
}

fn is_allowed_auth_relative_path(relative: &str) -> bool {
    if AUTH_EXPORT_FILES.contains(&relative) {
        return true;
    }
    AUTH_EXPORT_DIRS.iter().any(|dir| {
        relative
            .strip_prefix(&format!("{dir}/"))
            .map(|rest| !rest.is_empty() && !rest.split('/').any(str::is_empty))
            .unwrap_or(false)
    })
}

fn relative_path(relative: &str) -> PathBuf {
    relative.split('/').collect()
}

fn read_json_if_exists(path: &Path) -> NativeResult<Option<Value>> {
    if !path.exists() {
        return Ok(None);
    }
    let mut raw = String::new();
    fs::File::open(path)?.read_to_string(&mut raw)?;
    Ok(Some(serde_json::from_str(&raw)?))
}

fn write_json(path: &Path, value: &Value) -> NativeResult<()> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value)?))?;
    Ok(())
}

fn remove_active_codex_dir() -> NativeResult<()> {
    let dir = active_codex_dir();
    if !dir.exists() {
        return Ok(());
    }
    let metadata = fs::symlink_metadata(&dir)?;
    if metadata.file_type().is_symlink() {
        fs::remove_dir(&dir).or_else(|_| fs::remove_file(&dir))?;
    } else {
        fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

fn create_junction_or_symlink(target: &Path, link: &Path) -> NativeResult<()> {
    if let Some(parent) = link.parent() {
        ensure_dir(parent)?;
    }
    #[cfg(windows)]
    {
        let status = Command::new("cmd.exe")
            .args(["/d", "/s", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .status()?;
        if status.success() {
            return Ok(());
        }
    }
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(target, link)?;
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(target, link)?;
    Ok(())
}

fn copy_profile_payload(src: &Path, dst: &Path) -> NativeResult<()> {
    if dst.exists() {
        fs::remove_dir_all(dst)?;
    }
    ensure_dir(dst)?;
    for item in PROFILE_FILES {
        copy_path_if_exists(&src.join(item), &dst.join(item))?;
    }
    for item in PROFILE_DIRS {
        copy_path_if_exists(&src.join(item), &dst.join(item))?;
    }
    Ok(())
}

fn copy_path_if_exists(src: &Path, dst: &Path) -> NativeResult<()> {
    if !src.exists() {
        return Ok(());
    }
    if src.is_dir() {
        merge_directory_into(dst, src)
    } else {
        if let Some(parent) = dst.parent() {
            ensure_dir(parent)?;
        }
        fs::copy(src, dst)?;
        Ok(())
    }
}

fn ensure_profiles_dir() -> NativeResult<()> {
    ensure_dir(&profiles_dir())
}

fn ensure_dir(path: &Path) -> NativeResult<()> {
    fs::create_dir_all(path)?;
    Ok(())
}

fn same_entry(left: &Path, right: &Path) -> bool {
    match (canonicalize_if_exists(left), canonicalize_if_exists(right)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn canonicalize_if_exists(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn active_codex_dir() -> PathBuf {
    home_dir().join(".codex")
}

fn profiles_dir() -> PathBuf {
    home_dir().join(".codex-profiles")
}

fn profile_dir(name: &str) -> PathBuf {
    profiles_dir().join(name)
}

fn shared_sessions_dir() -> PathBuf {
    profiles_dir().join(".shared-sessions")
}

fn shared_pets_dir() -> PathBuf {
    profiles_dir().join(".shared-pets")
}

fn shared_global_state_path() -> PathBuf {
    profiles_dir().join(".shared-global-state.json")
}

fn auto_switch_state_path() -> PathBuf {
    profiles_dir().join(".auto-switch.json")
}

fn usage_snapshot_path() -> PathBuf {
    profiles_dir().join(".usage-last-success.json")
}

fn shell_state_path() -> PathBuf {
    profiles_dir().join(".shell-state.json")
}

fn now_iso_string() -> String {
    Utc::now().to_rfc3339()
}

fn now_string() -> String {
    format!("{:?}", std::time::SystemTime::now())
}

fn file_stamp() -> String {
    let raw = format!("{:?}", std::time::SystemTime::now());
    raw.chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(24)
        .collect()
}

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use clawdle_local_runtime::{
    private, receiver, settings, Checkpoint, JournalEntry, Repository, ResultRecord,
    RuntimeSnapshot,
};
use rand::RngCore;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;
struct Native {
    repo: Arc<Repository>,
    dir: PathBuf,
    _receiver: Mutex<Option<receiver::Receiver>>,
}
#[tauri::command]
fn runtime_snapshot(s: tauri::State<Native>) -> Result<RuntimeSnapshot, String> {
    s.repo.snapshot()
}
#[tauri::command]
fn journal_read(
    s: tauri::State<Native>,
    after_seq: i64,
    limit: Option<usize>,
) -> Result<Vec<JournalEntry>, String> {
    s.repo.read(after_seq, limit.unwrap_or(500))
}
#[tauri::command]
fn journal_append(
    app: tauri::AppHandle,
    s: tauri::State<Native>,
    event_id: String,
    command: Value,
) -> Result<JournalEntry, String> {
    let e = s.repo.append(&event_id, "command", command)?;
    let _ = app.emit("journal-updated", e.seq);
    Ok(e)
}
#[tauri::command]
fn checkpoint_commit(
    s: tauri::State<Native>,
    expected_version: i64,
    processed_seq: i64,
    state: Value,
    results: Option<Vec<ResultRecord>>,
) -> Result<Checkpoint, String> {
    s.repo.commit(
        expected_version,
        processed_seq,
        state,
        results.unwrap_or_default(),
    )
}
#[tauri::command]
fn effect_claim(s: tauri::State<Native>, effect_id: String) -> Result<bool, String> {
    s.repo.claim_effect(&effect_id)
}
#[tauri::command]
fn native_random(length: usize) -> Result<Vec<u8>, String> {
    if length > 4096 {
        return Err("random_limit".into());
    }
    let mut bytes = vec![0u8; length];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    Ok(bytes)
}
fn show(app: &tauri::AppHandle, explicit: bool) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("window_missing")?;
    if explicit {
        window.show().map_err(|_| "window_show")?;
        window.set_focus().map_err(|_| "window_focus")?;
    } else {
        #[cfg(windows)]
        {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                SetWindowPos, ShowWindow, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE,
            };
            let hwnd = window.hwnd().map_err(|_| "window_handle")?.0;
            unsafe {
                ShowWindow(hwnd as _, SW_SHOWNOACTIVATE);
                SetWindowPos(
                    hwnd as _,
                    std::ptr::null_mut(),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
                );
            }
        }
        #[cfg(not(windows))]
        {
            app.notification()
                .builder()
                .title("Clawdle")
                .body("An agent turn is ready to race.")
                .show()
                .map_err(|_| "notification")?;
        }
    }
    Ok(())
}
#[tauri::command]
fn native_show(app: tauri::AppHandle, explicit: bool) -> Result<(), String> {
    show(&app, explicit)?;
    if app
        .get_webview_window("main")
        .is_some_and(|w| w.is_visible().unwrap_or(false))
    {
        let _ = app.emit("window-presented", ());
    }
    Ok(())
}
#[tauri::command]
fn native_is_visible(app: tauri::AppHandle) -> Result<bool, String> {
    app.get_webview_window("main")
        .ok_or("window_missing")?
        .is_visible()
        .map_err(|_| "window_visibility".into())
}
#[tauri::command]
fn native_hide(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or("window_missing")?
        .hide()
        .map_err(|_| "window_hide".into())
}
#[tauri::command]
fn native_clipboard(app: tauri::AppHandle, text: String) -> Result<(), String> {
    if text.len() > 65536 {
        return Err("clipboard_limit".into());
    }
    app.clipboard()
        .write_text(text)
        .map_err(|_| "clipboard_unavailable".into())
}
#[tauri::command]
fn native_notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    if title.len() > 80 || body.len() > 256 {
        return Err("notification_limit".into());
    }
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|_| "notification_unavailable".into())
}
fn bridge(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|_| "resource_directory")?
        .join("clawdle-bridge.exe");
    if bundled.is_file() {
        return Ok(bundled);
    }
    let sibling = std::env::current_exe()
        .map_err(|_| "executable")?
        .with_file_name("clawdle-bridge.exe");
    if sibling.is_file() {
        return Ok(sibling);
    }
    Err("bridge_missing_build_bridge_first".into())
}
#[tauri::command]
fn integration_doctor(app: tauri::AppHandle, s: tauri::State<Native>) -> Value {
    let p = settings::settings_path("user", None).ok();
    let count = p
        .as_ref()
        .map(|p| settings::owned_count(p, &s.dir.join("ownership")))
        .unwrap_or(0);
    json!({"protocolVersion":1,"tokenPresent":s.dir.join("token").is_file(),"receiverAvailable":private::endpoint(&s.dir).is_ok(),"ownedUserHandlers":count,"installed":count>0,"claudeVersion":null,"bridgePresent":bridge(&app).is_ok(),"compatibility":"Windows native Claude Code; documented prompt_id and exec-form command hooks required. Refresh the Claude session after setup. Native Claude smoke testing is still required for a version support claim."})
}
#[tauri::command]
fn integration_install(
    app: tauri::AppHandle,
    s: tauri::State<Native>,
    scope: String,
    project: Option<String>,
) -> Result<Value, String> {
    let p = project.map(PathBuf::from);
    let settings_path = settings::settings_path(&scope, p.as_deref())?;
    settings::prepare_for(
        &settings_path,
        &s.dir.join("ownership"),
        &bridge(&app)?,
        true,
        cfg!(debug_assertions),
    )?
    .commit()?;
    Ok(json!({"installed":true,"refreshClaudeSession":true}))
}
#[tauri::command]
fn integration_uninstall(
    app: tauri::AppHandle,
    s: tauri::State<Native>,
    scope: String,
    project: Option<String>,
) -> Result<Value, String> {
    let p = project.map(PathBuf::from);
    let settings_path = settings::settings_path(&scope, p.as_deref())?;
    settings::prepare_for(
        &settings_path,
        &s.dir.join("ownership"),
        &bridge(&app)?,
        false,
        cfg!(debug_assertions),
    )?
    .commit()?;
    Ok(json!({"installed":false,"refreshClaudeSession":true}))
}
#[tauri::command]
fn integration_configure(s: tauri::State<Native>, auto_launch: bool) -> Result<(), String> {
    private::atomic_write(&s.dir.join("bridge.json"),&serde_json::to_vec(&json!({"autoLaunch":auto_launch,"desktopPath":std::env::current_exe().map_err(|_|"desktop_path")?})).map_err(|_|"config_json")?).map_err(|_|"config_save".into())
}
#[tauri::command]
fn native_always_on_top(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or("window_missing")?
        .set_always_on_top(enabled)
        .map_err(|_| "window_top".into())
}
fn geometry(app: &tauri::AppHandle, dir: &std::path::Path) {
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(bytes) = std::fs::read(dir.join("geometry.json")) {
            if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                let mut width = v["width"].as_f64().unwrap_or(420.0).clamp(360.0, 1000.0);
                let mut height = v["height"].as_f64().unwrap_or(650.0).clamp(600.0, 1200.0);
                if let Ok(Some(m)) = w.current_monitor() {
                    let factor = m.scale_factor();
                    let pos = m.work_area().position.to_logical::<f64>(factor);
                    let size = m.work_area().size.to_logical::<f64>(factor);
                    width = width.min(size.width);
                    height = height.min(size.height);
                    let _ = w.set_size(tauri::LogicalSize::new(width, height));
                    let x = v["x"]
                        .as_f64()
                        .unwrap_or(pos.x)
                        .clamp(pos.x, (pos.x + size.width - width).max(pos.x));
                    let y = v["y"]
                        .as_f64()
                        .unwrap_or(pos.y)
                        .clamp(pos.y, (pos.y + size.height - height).max(pos.y));
                    let _ = w.set_position(tauri::LogicalPosition::new(x, y));
                }
            }
        }
    }
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|a| a == "--hook-launch") {
                let _ = show(app, true);
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            runtime_snapshot,
            journal_read,
            journal_append,
            checkpoint_commit,
            effect_claim,
            native_random,
            native_show,
            native_is_visible,
            native_hide,
            native_clipboard,
            native_notify,
            native_always_on_top,
            integration_doctor,
            integration_install,
            integration_uninstall,
            integration_configure
        ])
        .setup(|app| {
            let dir = clawdle_local_runtime::data_dir(cfg!(debug_assertions));
            private::secure_dir(&dir)?;
            let repo = Arc::new(
                Repository::open(&dir.join("clawdle.sqlite")).map_err(std::io::Error::other)?,
            );
            let handle = app.handle().clone();
            let notify = Arc::new(move |seq| {
                let _ = handle.emit("journal-updated", seq);
            });
            let receiver = tauri::async_runtime::block_on(receiver::start(
                dir.clone(),
                repo.clone(),
                cfg!(debug_assertions),
                notify,
            ))?;
            app.manage(Native {
                repo: repo.clone(),
                dir: dir.clone(),
                _receiver: Mutex::new(Some(receiver)),
            });
            geometry(app.handle(), &dir);
            let open =
                tauri::menu::MenuItem::with_id(app, "open", "Open Clawdle", true, None::<&str>)?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&open, &quit])?;
            tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or("app_icon_missing")?.clone())
                .tooltip("Clawdle")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        let _ = show(app, true);
                    }
                    "quit" => {
                        let s = app.state::<Native>();
                        let _ = s.repo.append(
                            &uuid::Uuid::new_v4().to_string(),
                            "runtime",
                            json!({"type":"runtime.interrupted"}),
                        );
                        s._receiver.lock().unwrap_or_else(|e| e.into_inner()).take();
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;
            if !std::env::args().any(|a| a == "--hook-launch") {
                show(app.handle(), true).map_err(std::io::Error::other)?;
            }
            // Detect sleep and wall/monotonic continuity gaps conservatively. No agent polling.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut last = Instant::now();
                let mut utc = chrono::Utc::now();
                loop {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    let elapsed = last.elapsed();
                    let now = chrono::Utc::now();
                    let wall = (now - utc).num_milliseconds();
                    if elapsed > Duration::from_secs(15)
                        || (wall - elapsed.as_millis() as i64).abs() > 2000
                    {
                        if let Ok(e) = repo.append(
                            &uuid::Uuid::new_v4().to_string(),
                            "runtime",
                            json!({"type":"runtime.interrupted"}),
                        ) {
                            let _ = handle.emit("journal-updated", e.seq);
                        }
                    }
                    last = Instant::now();
                    utc = now;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                let app = window.app_handle();
                if let Some(s) = app.try_state::<Native>() {
                    if let (Ok(pos), Ok(size), Ok(scale)) = (
                        window.outer_position(),
                        window.inner_size(),
                        window.scale_factor(),
                    ) {
                        let p = pos.to_logical::<f64>(scale);
                        let z = size.to_logical::<f64>(scale);
                        let _ = private::atomic_write(
                            &s.dir.join("geometry.json"),
                            json!({"x":p.x,"y":p.y,"width":z.width,"height":z.height})
                                .to_string()
                                .as_bytes(),
                        );
                    }
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("Unable to start Clawdle; local data has been preserved");
}

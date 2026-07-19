use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, ImageBuffer, ImageFormat, RgbaImage};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::Cursor,
    path::PathBuf,
    process::Command,
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{CreateRoundRectRgn, SetWindowRgn};
#[cfg(windows)]
#[derive(Debug, Serialize)]
struct HermesSession {
    id: String,
    title: String,
    preview: String,
    started_at: f64,
    last_active: f64,
}

#[derive(Debug, Serialize)]
struct AskResponse {
    answer: String,
    session_id: String,
}

#[derive(Debug, Serialize)]
struct CaptureResponse {
    data_url: String,
    width: u32,
    height: u32,
}

struct CapturedDesktop {
    image: RgbaImage,
}

#[derive(Debug, Deserialize)]
struct NormalizedRegion {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Default)]
struct PendingCapture(Mutex<Option<CapturedDesktop>>);

fn hermes_home() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("HERMES_HOME") {
        return Ok(PathBuf::from(value));
    }
    #[cfg(windows)]
    if let Some(value) = env::var_os("LOCALAPPDATA") {
        return Ok(PathBuf::from(value).join("hermes"));
    }
    env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".hermes"))
        .ok_or_else(|| "Could not locate the Hermes home directory".to_string())
}

fn state_db_path() -> Result<PathBuf, String> {
    Ok(hermes_home()?.join("state.db"))
}

fn hermes_binary() -> Result<PathBuf, String> {
    let root = hermes_home()?;
    let mut candidates = Vec::new();
    #[cfg(windows)]
    {
        candidates.push(root.join("hermes-agent/venv/Scripts/hermes.exe"));
        candidates.push(root.join("venv/Scripts/hermes.exe"));
    }
    #[cfg(not(windows))]
    {
        candidates.push(root.join("hermes-agent/venv/bin/hermes"));
        candidates.push(root.join("venv/bin/hermes"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| {
            which_on_path(if cfg!(windows) {
                "hermes.exe"
            } else {
                "hermes"
            })
        })
        .ok_or_else(|| {
            "Hermes CLI was not found. Start Hermes Desktop once, then retry.".to_string()
        })
}

fn which_on_path(name: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    })
}

fn desktop_binary() -> Result<PathBuf, String> {
    let root = hermes_home()?;
    let release = root.join("hermes-agent/apps/desktop/release");
    #[cfg(windows)]
    {
        let direct = release.join("win-unpacked/Hermes.exe");
        if direct.is_file() {
            return Ok(direct);
        }
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            let installed = PathBuf::from(local).join("Programs/Hermes/Hermes.exe");
            if installed.is_file() {
                return Ok(installed);
            }
        }
    }
    Err("Hermes Desktop executable was not found".to_string())
}

fn query_sessions(limit: usize) -> Result<Vec<HermesSession>, String> {
    let path = state_db_path()?;
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Could not read Hermes sessions: {error}"))?;
    query_sessions_from(&connection, limit)
}

fn query_sessions_from(
    connection: &Connection,
    limit: usize,
) -> Result<Vec<HermesSession>, String> {
    let sql = r#"
        SELECT s.id,
               COALESCE(NULLIF(s.title, ''), NULLIF(s.display_name, ''), 'Untitled session'),
               COALESCE((SELECT m.content FROM messages m
                         WHERE m.session_id = s.id AND m.role = 'user' AND m.active = 1
                         ORDER BY m.timestamp DESC LIMIT 1), ''),
               s.started_at,
               COALESCE((SELECT MAX(m.timestamp) FROM messages m
                         WHERE m.session_id = s.id AND m.active = 1), s.started_at)
          FROM sessions s
         WHERE COALESCE(s.archived, 0) = 0
           AND s.source IN ('cli', 'desktop')
         ORDER BY 5 DESC
         LIMIT ?1
    "#;
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([limit as i64], |row| {
            let preview: String = row.get(2)?;
            Ok(HermesSession {
                id: row.get(0)?,
                title: row.get(1)?,
                preview: preview.chars().take(140).collect(),
                started_at: row.get(3)?,
                last_active: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_sessions() -> Result<Vec<HermesSession>, String> {
    query_sessions(30)
}

fn write_attachment(data_url: &str) -> Result<PathBuf, String> {
    let encoded = data_url
        .split_once(',')
        .map(|(_, body)| body)
        .ok_or_else(|| "Invalid screenshot data".to_string())?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|error| format!("Invalid screenshot: {error}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = env::temp_dir().join(format!("ask-hermes-{stamp}.png"));
    fs::write(&path, bytes).map_err(|error| format!("Could not save screenshot: {error}"))?;
    Ok(path)
}

fn read_reasoning_effort(binary: &PathBuf) -> Result<String, String> {
    let mut command = Command::new(binary);
    command
        .arg("config")
        .arg("get")
        .arg("agent.reasoning_effort");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .map_err(|error| format!("Could not read Hermes thinking effort: {error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn set_reasoning_effort(binary: &PathBuf, effort: &str) -> Result<(), String> {
    const VALID_EFFORTS: &[&str] = &[
        "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
    ];
    if !VALID_EFFORTS.contains(&effort) {
        return Err("Invalid thinking effort".to_string());
    }
    let mut command = Command::new(binary);
    command
        .arg("config")
        .arg("set")
        .arg("agent.reasoning_effort")
        .arg(effort);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .map_err(|error| format!("Could not set Hermes thinking effort: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
async fn ask_hermes(
    prompt: String,
    session_id: Option<String>,
    image_data_urls: Vec<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
) -> Result<AskResponse, String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() && image_data_urls.is_empty() {
        return Err("Type a question or attach a screen region".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let binary = hermes_binary()?;
        let attachments = image_data_urls
            .iter()
            .map(|data_url| write_attachment(data_url))
            .collect::<Result<Vec<_>, _>>()?;
        let mut full_prompt = if prompt.is_empty() {
            "What can you tell me about this screenshot?".to_string()
        } else {
            prompt
        };
        for (index, path) in attachments.iter().enumerate() {
            full_prompt.push_str(&format!(
                "\n\nScreenshot {} is attached at this local path: {}. Inspect it as part of the question.",
                index + 1,
                path.display()
            ));
        }
        let mut command = Command::new(&binary);
        if session_id.is_none() {
            if let Some(model) = model.as_ref().filter(|model| !model.trim().is_empty()) {
                command.arg("--model").arg(model.trim());
            }
        }
        if let Some(id) = session_id.as_ref().filter(|id| !id.trim().is_empty()) {
            command.arg("--resume").arg(id.trim());
        }
        command.arg("--oneshot").arg(&full_prompt);
        if let Some(home) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")) {
            command.current_dir(home);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut previous_effort = None;
        if session_id.is_none() {
            if let Some(effort) = reasoning_effort
                .as_deref()
                .map(str::trim)
                .filter(|effort| !effort.is_empty())
            {
                let previous = read_reasoning_effort(&binary)?;
                if previous != effort {
                    set_reasoning_effort(&binary, effort)?;
                    previous_effort = Some(previous);
                }
            }
        }
        let output = command.output().map_err(|error| format!("Could not start Hermes: {error}"));
        if let Some(previous) = previous_effort {
            let _ = set_reasoning_effort(&binary, &previous);
        }
        for path in attachments {
            let _ = fs::remove_file(path);
        }
        let output = output?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("Hermes exited with {}", output.status)
            } else {
                stderr
            });
        }
        let answer = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let resolved_id = session_id
            .filter(|id| !id.trim().is_empty())
            .or_else(|| query_sessions(1).ok()?.into_iter().next().map(|session| session.id))
            .unwrap_or_default();
        Ok(AskResponse { answer, session_id: resolved_id })
    })
    .await
    .map_err(|error| format!("Hermes task failed: {error}"))?
}

fn image_data_url(image: &RgbaImage) -> Result<String, String> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.clone())
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(bytes.into_inner())
    ))
}

fn image_jpeg_data_url(image: &RgbaImage) -> Result<String, String> {
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 82)
        .encode_image(&DynamicImage::ImageRgba8(image.clone()))
        .map_err(|error| error.to_string())?;
    Ok(format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)))
}

fn capture_desktop() -> Result<CapturedDesktop, String> {
    let screens = xcap::Monitor::all().map_err(|error| error.to_string())?;
    if screens.is_empty() {
        return Err("No displays were found".to_string());
    }
    let geometries = screens
        .iter()
        .map(|screen| {
            Ok((
                screen.x().map_err(|error| error.to_string())?,
                screen.y().map_err(|error| error.to_string())?,
                screen.width().map_err(|error| error.to_string())?,
                screen.height().map_err(|error| error.to_string())?,
            ))
        })
        .collect::<Result<Vec<(i32, i32, u32, u32)>, String>>()?;
    let min_x = geometries
        .iter()
        .map(|geometry| geometry.0)
        .min()
        .unwrap_or(0);
    let min_y = geometries
        .iter()
        .map(|geometry| geometry.1)
        .min()
        .unwrap_or(0);
    let max_x = geometries
        .iter()
        .map(|geometry| geometry.0 + geometry.2 as i32)
        .max()
        .unwrap_or(0);
    let max_y = geometries
        .iter()
        .map(|geometry| geometry.1 + geometry.3 as i32)
        .max()
        .unwrap_or(0);
    let width = (max_x - min_x) as u32;
    let height = (max_y - min_y) as u32;
    let mut canvas: RgbaImage =
        ImageBuffer::from_pixel(width, height, image::Rgba([20, 20, 20, 255]));
    for (screen, geometry) in screens.into_iter().zip(geometries) {
        let shot = screen.capture_image().map_err(|error| error.to_string())?;
        image::imageops::overlay(
            &mut canvas,
            &shot,
            (geometry.0 - min_x) as i64,
            (geometry.1 - min_y) as i64,
        );
    }
    Ok(CapturedDesktop { image: canvas })
}

fn prepare_selection_overlay(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("capture")
        .ok_or_else(|| "Capture window is unavailable".to_string())?;
    let screens = xcap::Monitor::all().map_err(|error| error.to_string())?;
    let geometries = screens
        .iter()
        .map(|screen| {
            Ok((
                screen.x().map_err(|error| error.to_string())?,
                screen.y().map_err(|error| error.to_string())?,
                screen.width().map_err(|error| error.to_string())?,
                screen.height().map_err(|error| error.to_string())?,
            ))
        })
        .collect::<Result<Vec<(i32, i32, u32, u32)>, String>>()?;
    let min_x = geometries
        .iter()
        .map(|geometry| geometry.0)
        .min()
        .unwrap_or(0);
    let min_y = geometries
        .iter()
        .map(|geometry| geometry.1)
        .min()
        .unwrap_or(0);
    let max_x = geometries
        .iter()
        .map(|geometry| geometry.0 + geometry.2 as i32)
        .max()
        .unwrap_or(0);
    let max_y = geometries
        .iter()
        .map(|geometry| geometry.1 + geometry.3 as i32)
        .max()
        .unwrap_or(0);
    window
        .set_position(Position::Physical(PhysicalPosition::new(min_x, min_y)))
        .map_err(|error| error.to_string())?;
    window
        .set_size(Size::Physical(PhysicalSize::new(
            (max_x - min_x) as u32,
            (max_y - min_y) as u32,
        )))
        .map_err(|error| error.to_string())?;
    window
        .emit("reset-selection", ())
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn show_main_above_capture(main: &WebviewWindow) -> Result<(), String> {
    // Reinsert the prompt at the top of the topmost z-order group. A transparent
    // capture window can otherwise remain above it and steal input on Windows.
    main.set_always_on_top(false)
        .map_err(|error| error.to_string())?;
    main.set_always_on_top(true)
        .map_err(|error| error.to_string())?;
    main.show().map_err(|error| error.to_string())?;
    apply_main_shape(main)?;
    main.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(windows)]
fn apply_main_shape(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let radius = (22.0 * window.scale_factor().unwrap_or(1.0)).round() as i32;
    unsafe {
        let region = CreateRoundRectRgn(
            0,
            0,
            size.width as i32 + 1,
            size.height as i32 + 1,
            radius * 2,
            radius * 2,
        );
        if region.is_invalid() || SetWindowRgn(hwnd, Some(region), true) == 0 {
            return Err("Could not apply rounded prompt window".to_string());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn apply_main_shape(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn start_selection(
    app: AppHandle,
    state: tauri::State<'_, PendingCapture>,
) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        main.hide().map_err(|error| error.to_string())?;
    }
    let captured_result = tauri::async_runtime::spawn_blocking(capture_desktop)
        .await
        .map_err(|error| format!("Screen capture task failed: {error}"));
    let captured = captured_result??;
    let background = image_jpeg_data_url(&captured.image)?;
    *state.0.lock().map_err(|_| "Capture state lock failed")? = Some(captured);
    prepare_selection_overlay(&app)?;
    if let Some(capture) = app.get_webview_window("capture") {
        capture
            .emit("selection-background", background)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_prepared_selection(app: AppHandle) -> Result<(), String> {
    let capture = app
        .get_webview_window("capture")
        .ok_or_else(|| "Capture window is unavailable".to_string())?;
    capture.show().map_err(|error| error.to_string())?;
    capture.set_focus().map_err(|error| error.to_string())?;
    if let Some(main) = app.get_webview_window("main") {
        main.emit("selection-ready", ())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn capture_region(
    window: WebviewWindow,
    app: AppHandle,
    state: tauri::State<'_, PendingCapture>,
    region: NormalizedRegion,
) -> Result<CaptureResponse, String> {
    window.hide().map_err(|error| error.to_string())?;
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    let pending = state
        .0
        .lock()
        .map_err(|_| "Capture state lock failed")?
        .take();
    let captured = if let Some(captured) = pending {
        captured
    } else {
        tauri::async_runtime::spawn_blocking(|| {
            thread::sleep(Duration::from_millis(100));
            capture_desktop()
        })
        .await
        .map_err(|error| format!("Screen capture task failed: {error}"))??
    };
    let full_width = captured.image.width();
    let full_height = captured.image.height();
    let x = ((region.x.clamp(0.0, 1.0) * full_width as f64).round() as u32)
        .min(full_width.saturating_sub(1));
    let y = ((region.y.clamp(0.0, 1.0) * full_height as f64).round() as u32)
        .min(full_height.saturating_sub(1));
    let width = ((region.width.clamp(0.0, 1.0) * full_width as f64).round() as u32)
        .max(1)
        .min(full_width.saturating_sub(x));
    let height = ((region.height.clamp(0.0, 1.0) * full_height as f64).round() as u32)
        .max(1)
        .min(full_height.saturating_sub(y));
    let cropped = image::imageops::crop_imm(&captured.image, x, y, width, height).to_image();
    let data_url = match image_data_url(&cropped) {
        Ok(data_url) => data_url,
        Err(error) => {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                let _ = main.set_focus();
            }
            return Err(error);
        }
    };
    let response = CaptureResponse {
        data_url,
        width,
        height,
    };
    if let Some(main) = app.get_webview_window("main") {
        main.show().map_err(|error| error.to_string())?;
        main.set_focus().map_err(|error| error.to_string())?;
        main.emit("capture-complete", &response)
            .map_err(|error| error.to_string())?;
    }
    Ok(response)
}

#[tauri::command]
fn cancel_selection(app: AppHandle, state: tauri::State<'_, PendingCapture>) -> Result<(), String> {
    *state.0.lock().map_err(|_| "Capture state lock failed")? = None;
    if let Some(capture) = app.get_webview_window("capture") {
        capture.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_prompt_expanded(window: WebviewWindow, expanded: bool) -> Result<(), String> {
    let height = if expanded { 360.0 } else { 76.0 };
    window
        .set_size(Size::Logical(tauri::LogicalSize::new(620.0, height)))
        .map_err(|error| error.to_string())?;
    apply_main_shape(&window)
}

#[tauri::command]
fn hide_window(app: AppHandle) -> Result<(), String> {
    if let Some(capture) = app.get_webview_window("capture") {
        capture.hide().map_err(|error| error.to_string())?;
    }
    if let Some(main) = app.get_webview_window("main") {
        main.emit("clear-prompt", ())
            .map_err(|error| error.to_string())?;
        main.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = show_main_above_capture(&window);
        let _ = window.emit("open-settings", ());
    }
}

#[tauri::command]
fn open_hermes_desktop() -> Result<(), String> {
    let binary = desktop_binary()?;
    let mut command = Command::new(binary);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .spawn()
        .map_err(|error| format!("Could not open Hermes Desktop: {error}"))?;
    Ok(())
}

fn show_prompt(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        if visible && window.is_focused().unwrap_or(false) {
            let _ = hide_window(app.clone());
        } else if visible {
            let _ = window.set_focus();
        } else {
            let _ = show_main_above_capture(&window);
            let _ = window.emit("open-prompt", ());
        }
    }
}

fn tray_icon() -> Image<'static> {
    let source = image::load_from_memory(include_bytes!("../icons/hermes-tray-source.png"))
        .expect("embedded Hermes tray icon must be a valid PNG")
        .into_rgba8();
    let (mut left, mut top, mut right, mut bottom) = (source.width(), source.height(), 0, 0);
    for (x, y, pixel) in source.enumerate_pixels() {
        if pixel[3] > 8 {
            left = left.min(x);
            top = top.min(y);
            right = right.max(x);
            bottom = bottom.max(y);
        }
    }
    let cropped = image::imageops::crop_imm(
        &source,
        left,
        top,
        right.saturating_sub(left) + 1,
        bottom.saturating_sub(top) + 1,
    )
    .to_image();
    let tray = image::imageops::resize(&cropped, 32, 32, image::imageops::FilterType::Lanczos3);
    Image::new_owned(tray.into_raw(), 32, 32)
}

pub fn run() {
    tauri::Builder::default()
        .manage(PendingCapture::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "main" {
                    let _ = window.emit("clear-prompt", ());
                }
                let _ = window.hide();
            }
        })
        .setup(|app| {
            #[cfg(windows)]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))?;

            let shortcut = Shortcut::new(Some(Modifiers::ALT), Code::Space);
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, pressed, event| {
                        if event.state() != ShortcutState::Pressed {
                            return;
                        }
                        if pressed == &shortcut {
                            show_prompt(app);
                        }
                    })
                    .build(),
            )?;
            app.global_shortcut().register(shortcut)?;

            let show = MenuItem::with_id(app, "show", "Open Ask Hermes", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &settings, &quit])?;
            TrayIconBuilder::new()
                .icon(tray_icon())
                .tooltip("Ask Hermes — Alt+Space")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_prompt(app),
                    "settings" => show_settings(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            ask_hermes,
            start_selection,
            show_prepared_selection,
            capture_region,
            cancel_selection,
            set_prompt_expanded,
            hide_window,
            open_hermes_desktop
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ask Hermes");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            r#"
            CREATE TABLE sessions (
              id TEXT PRIMARY KEY, source TEXT NOT NULL, display_name TEXT,
              started_at REAL NOT NULL, title TEXT, archived INTEGER DEFAULT 0
            );
            CREATE TABLE messages (
              id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
              content TEXT, timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1
            );
            "#,
        )
        .unwrap();
        db
    }

    #[test]
    fn lists_desktop_and_cli_sessions_newest_first() {
        let db = session_db();
        db.execute_batch(
            r#"
            INSERT INTO sessions VALUES ('desktop-old', 'desktop', NULL, 10, 'Desktop chat', 0);
            INSERT INTO sessions VALUES ('cli-new', 'cli', NULL, 20, 'CLI chat', 0);
            INSERT INTO sessions VALUES ('worker', 'subagent', NULL, 30, 'Worker', 0);
            INSERT INTO sessions VALUES ('archived', 'desktop', NULL, 40, 'Hidden', 1);
            INSERT INTO messages VALUES (1, 'desktop-old', 'user', 'old question', 11, 1);
            INSERT INTO messages VALUES (2, 'cli-new', 'user', 'new question', 25, 1);
            "#,
        )
        .unwrap();

        let sessions = query_sessions_from(&db, 20).unwrap();
        let ids: Vec<_> = sessions.iter().map(|session| session.id.as_str()).collect();
        assert_eq!(ids, ["cli-new", "desktop-old"]);
        assert_eq!(sessions[0].preview, "new question");
    }

    #[test]
    fn uses_display_name_then_untitled_as_title_fallbacks() {
        let db = session_db();
        db.execute_batch(
            r#"
            INSERT INTO sessions VALUES ('named', 'desktop', 'Display name', 10, NULL, 0);
            INSERT INTO sessions VALUES ('blank', 'cli', NULL, 20, '', 0);
            "#,
        )
        .unwrap();

        let sessions = query_sessions_from(&db, 20).unwrap();
        assert_eq!(sessions[0].title, "Untitled session");
        assert_eq!(sessions[1].title, "Display name");
    }
}

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use futures_util::{SinkExt, StreamExt};
use image::{DynamicImage, ImageBuffer, ImageFormat, RgbaImage};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    env,
    io::{BufRead, BufReader, Cursor},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tokio_tungstenite::{connect_async, tungstenite::Message};

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

#[derive(Debug, Clone, Serialize)]
struct HermesGatewayConnection {
    ws_url: String,
}

#[derive(Debug, Clone, Serialize)]
struct HermesSessionStarted {
    exchange_id: String,
    runtime_session_id: String,
    stored_session_id: String,
}

#[derive(Debug, Clone, Serialize)]
struct HermesAnswerDelta {
    exchange_id: String,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
struct HermesTurnActivity {
    exchange_id: String,
    kind: String,
    tool_name: Option<String>,
    context: Option<String>,
}

#[derive(Debug, Serialize)]
struct HermesTurnResponse {
    answer: String,
    runtime_session_id: String,
    stored_session_id: String,
}

struct HermesBackendProcess {
    child: Child,
    connection: HermesGatewayConnection,
}

#[derive(Default)]
struct HermesBackend(Mutex<Option<HermesBackendProcess>>);

impl Drop for HermesBackend {
    fn drop(&mut self) {
        if let Ok(slot) = self.0.get_mut() {
            if let Some(backend) = slot.as_mut() {
                let _ = backend.child.kill();
            }
        }
    }
}

#[derive(Default)]
struct PreviousChatMenu(Mutex<Option<MenuItem<tauri::Wry>>>);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionShortcutConfig {
    shortcut: String,
    session_id: String,
}

#[derive(Default)]
struct SessionShortcutState(Mutex<Vec<SessionShortcutConfig>>);

#[derive(Default)]
struct SettingsWindowState(Mutex<bool>);

#[derive(Default)]
struct SessionShortcutTrayState(Mutex<SessionShortcutTray>);

#[derive(Default)]
struct SessionShortcutTray {
    menu: Option<Menu<tauri::Wry>>,
    submenu: Option<Submenu<tauri::Wry>>,
    items: Vec<MenuItem<tauri::Wry>>,
    session_by_item: HashMap<String, String>,
    attached: bool,
}

#[derive(Debug, Serialize)]
struct HermesHistoryMessage {
    id: i64,
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct HermesHistoryPage {
    messages: Vec<HermesHistoryMessage>,
    has_older: bool,
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
            "Hermes Agent was not found. Start Hermes Desktop once, then retry.".to_string()
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

#[tauri::command]
fn hermes_desktop_available() -> bool {
    desktop_binary().is_ok()
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
    query_sessions(200)
}

fn query_history_page_from(
    connection: &Connection,
    session_id: &str,
    before_id: Option<i64>,
    limit: usize,
) -> Result<HermesHistoryPage, String> {
    let boundary = before_id.unwrap_or(i64::MAX);
    let mut user_statement = connection
        .prepare(
            "SELECT id FROM messages
             WHERE session_id = ?1 AND active = 1 AND role = 'user'
               AND COALESCE(content, '') <> '' AND id < ?2
             ORDER BY id DESC LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let user_ids = user_statement
        .query_map((session_id, boundary, limit.clamp(1, 50) as i64), |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let Some(earliest_id) = user_ids.last().copied() else {
        return Ok(HermesHistoryPage {
            messages: Vec::new(),
            has_older: false,
        });
    };

    let mut message_statement = connection
        .prepare(
            "SELECT id, role, content FROM messages
             WHERE session_id = ?1 AND active = 1
               AND role IN ('user', 'assistant')
               AND COALESCE(content, '') <> ''
               AND id >= ?2 AND id < ?3
             ORDER BY id",
        )
        .map_err(|error| error.to_string())?;
    let messages = message_statement
        .query_map((session_id, earliest_id, boundary), |row| {
            Ok(HermesHistoryMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let has_older = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM messages
             WHERE session_id = ?1 AND active = 1 AND role = 'user'
               AND COALESCE(content, '') <> '' AND id < ?2)",
            (session_id, earliest_id),
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(HermesHistoryPage {
        messages,
        has_older,
    })
}

#[tauri::command]
fn get_session_history_page(
    session_id: String,
    before_id: Option<i64>,
    limit: usize,
) -> Result<HermesHistoryPage, String> {
    let path = state_db_path()?;
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Could not read Hermes history: {error}"))?;
    query_history_page_from(&connection, &session_id, before_id, limit)
}

fn start_hermes_backend() -> Result<HermesBackendProcess, String> {
    let token = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
    let mut command = Command::new(hermes_binary()?);
    command
        .args(["serve", "--host", "127.0.0.1", "--port", "0"])
        .env("HERMES_DASHBOARD_SESSION_TOKEN", &token)
        .env("HERMES_DESKTOP", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(home) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")) {
        command.current_dir(home);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the Hermes gateway: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Hermes gateway did not expose its startup output".to_string())?;
    let mut reader = BufReader::new(stdout);
    let port = loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => {
                let _ = child.kill();
                return Err("Hermes gateway exited before it became ready".to_string());
            }
            Ok(_) => {
                if let Some(value) = line.split("HERMES_BACKEND_READY port=").nth(1) {
                    break value
                        .split_whitespace()
                        .next()
                        .ok_or_else(|| "Hermes gateway returned an invalid port".to_string())?
                        .parse::<u16>()
                        .map_err(|error| {
                            format!("Hermes gateway returned an invalid port: {error}")
                        })?;
                }
            }
            Err(error) => {
                let _ = child.kill();
                return Err(format!("Could not read Hermes gateway startup: {error}"));
            }
        }
    };
    thread::spawn(move || {
        for line in reader.lines() {
            if line.is_err() {
                break;
            }
        }
    });

    Ok(HermesBackendProcess {
        child,
        connection: HermesGatewayConnection {
            ws_url: format!("ws://127.0.0.1:{port}/api/ws?token={token}"),
        },
    })
}

fn hermes_gateway_connection(state: &HermesBackend) -> Result<HermesGatewayConnection, String> {
    let mut slot = state
        .0
        .lock()
        .map_err(|_| "Hermes gateway state is unavailable")?;
    if let Some(backend) = slot.as_mut() {
        if backend
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            return Ok(backend.connection.clone());
        }
    }
    let backend = start_hermes_backend()?;
    let connection = backend.connection.clone();
    *slot = Some(backend);
    Ok(connection)
}

async fn gateway_rpc<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(
            json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
                .to_string()
                .into(),
        ))
        .await
        .map_err(|error| format!("Could not send {method} to Hermes: {error}"))?;
    while let Some(frame) = socket.next().await {
        let frame = frame.map_err(|error| format!("Hermes gateway disconnected: {error}"))?;
        let Message::Text(text) = frame else { continue };
        let value: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Hermes request failed")
                .to_string());
        }
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
    Err("Hermes gateway disconnected".to_string())
}

#[tauri::command]
async fn ask_hermes_gateway(
    app: AppHandle,
    state: tauri::State<'_, HermesBackend>,
    exchange_id: String,
    prompt: String,
    image_data_urls: Vec<String>,
    stored_session_id: Option<String>,
    runtime_session_id: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast: Option<bool>,
) -> Result<HermesTurnResponse, String> {
    let connection = hermes_gateway_connection(&state)?;
    let (mut socket, _) = connect_async(&connection.ws_url)
        .await
        .map_err(|error| format!("Could not connect to Hermes backend: {error}"))?;
    let mut request_id = 0_u64;
    let mut runtime_id = runtime_session_id.filter(|id| !id.trim().is_empty());
    let mut stored_id = stored_session_id.filter(|id| !id.trim().is_empty());

    if runtime_id.is_none() {
        request_id += 1;
        let result = if let Some(id) = stored_id.as_ref() {
            gateway_rpc(
                &mut socket,
                request_id,
                "session.resume",
                json!({ "session_id": id, "source": "desktop" }),
            )
            .await?
        } else {
            gateway_rpc(
                &mut socket,
                request_id,
                "session.create",
                json!({
                    "source": "desktop",
                    "model": model.unwrap_or_default(),
                    "reasoning_effort": reasoning_effort.unwrap_or_default(),
                    "fast": fast.unwrap_or(false),
                }),
            )
            .await?
        };
        runtime_id = result
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        stored_id = result
            .get("stored_session_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .or(stored_id);
    }

    let runtime_id =
        runtime_id.ok_or_else(|| "Hermes did not return a runtime session ID".to_string())?;
    let stored_id =
        stored_id.ok_or_else(|| "Hermes did not return a stored session ID".to_string())?;
    app.emit(
        "hermes-session-started",
        HermesSessionStarted {
            exchange_id: exchange_id.clone(),
            runtime_session_id: runtime_id.clone(),
            stored_session_id: stored_id.clone(),
        },
    )
    .map_err(|error| error.to_string())?;

    for (index, data_url) in image_data_urls.iter().enumerate() {
        request_id += 1;
        gateway_rpc(
            &mut socket,
            request_id,
            "image.attach_bytes",
            json!({
                "session_id": runtime_id,
                "content_base64": data_url,
                "filename": format!("ask-hermes-{}.png", index + 1),
            }),
        )
        .await?;
    }

    request_id += 1;
    socket
        .send(Message::Text(
            json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "prompt.submit",
                "params": { "session_id": runtime_id, "text": prompt },
            })
            .to_string()
            .into(),
        ))
        .await
        .map_err(|error| format!("Could not submit the prompt to Hermes: {error}"))?;

    while let Some(frame) = socket.next().await {
        let frame = frame.map_err(|error| format!("Hermes gateway disconnected: {error}"))?;
        let Message::Text(text) = frame else { continue };
        let value: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
        if value.get("id").and_then(Value::as_u64) == Some(request_id) {
            if let Some(error) = value.get("error") {
                return Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Hermes rejected the prompt")
                    .to_string());
            }
            continue;
        }
        let Some(params) = value.get("params") else {
            continue;
        };
        if params.get("session_id").and_then(Value::as_str) != Some(runtime_id.as_str()) {
            continue;
        }
        let event_type = params
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload = params.get("payload").unwrap_or(&Value::Null);
        let text = payload
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match event_type {
            "tool.start" | "tool.started" => {
                app.emit(
                    "hermes-turn-activity",
                    HermesTurnActivity {
                        exchange_id: exchange_id.clone(),
                        kind: "tool".to_string(),
                        tool_name: payload
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        context: payload
                            .get("context")
                            .and_then(Value::as_str)
                            .filter(|value| !value.trim().is_empty())
                            .map(str::to_string),
                    },
                )
                .map_err(|error| error.to_string())?;
            }
            "tool.complete" | "tool.completed" | "tool.failed" | "reasoning.available" => {
                app.emit(
                    "hermes-turn-activity",
                    HermesTurnActivity {
                        exchange_id: exchange_id.clone(),
                        kind: "thinking".to_string(),
                        tool_name: None,
                        context: None,
                    },
                )
                .map_err(|error| error.to_string())?;
            }
            "message.delta" if !text.is_empty() => {
                app.emit(
                    "hermes-answer-delta",
                    HermesAnswerDelta {
                        exchange_id: exchange_id.clone(),
                        text: text.to_string(),
                    },
                )
                .map_err(|error| error.to_string())?;
            }
            "message.complete" => {
                if payload.get("status").and_then(Value::as_str) == Some("error") {
                    return Err(text.to_string());
                }
                return Ok(HermesTurnResponse {
                    answer: text.to_string(),
                    runtime_session_id: runtime_id,
                    stored_session_id: stored_id,
                });
            }
            "error" => return Err(text.to_string()),
            _ => {}
        }
    }
    Err("Hermes gateway disconnected before answering".to_string())
}

#[tauri::command]
fn set_previous_chat_available(
    available: bool,
    state: tauri::State<'_, PreviousChatMenu>,
) -> Result<(), String> {
    let slot = state
        .0
        .lock()
        .map_err(|_| "Tray menu state is unavailable")?;
    if let Some(item) = slot.as_ref() {
        item.set_enabled(available)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn register_session_shortcut(
    app: &AppHandle,
    binding: &SessionShortcutConfig,
) -> Result<(), String> {
    let shortcut = binding
        .shortcut
        .parse::<Shortcut>()
        .map_err(|error| format!("Invalid shortcut {}: {error}", binding.shortcut))?;
    let session_id = binding.session_id.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            show_session_shortcut(app, &session_id);
        })
        .map_err(|error| error.to_string())
}

fn show_session_shortcut(app: &AppHandle, session_id: &str) {
    if let Ok(mut open) = app.state::<SettingsWindowState>().0.lock() {
        *open = false;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_size(Size::Logical(tauri::LogicalSize::new(620.0, 360.0)));
        let _ = show_main_above_capture(&window);
        let _ = window.emit("open-session-shortcut", session_id);
    }
}

#[tauri::command]
fn set_session_shortcuts(
    app: AppHandle,
    shortcuts: Vec<SessionShortcutConfig>,
    state: tauri::State<'_, SessionShortcutState>,
) -> Result<(), String> {
    let base_shortcut = Shortcut::new(Some(Modifiers::ALT), Code::Space);
    let mut ids = HashSet::new();
    for binding in &shortcuts {
        if binding.shortcut.trim().is_empty() || binding.session_id.trim().is_empty() {
            return Err(
                "Every session shortcut needs both a key combination and a session".to_string(),
            );
        }
        let parsed = binding
            .shortcut
            .parse::<Shortcut>()
            .map_err(|error| format!("Invalid shortcut {}: {error}", binding.shortcut))?;
        if parsed.id() == base_shortcut.id() {
            return Err("Alt+Space is reserved for the main Ask Hermes prompt".to_string());
        }
        if !ids.insert(parsed.id()) {
            return Err(format!(
                "Shortcut {} is assigned more than once",
                binding.shortcut
            ));
        }
    }

    let mut active = state
        .0
        .lock()
        .map_err(|_| "Session shortcut state is unavailable")?;
    for binding in active.iter() {
        let _ = app.global_shortcut().unregister(binding.shortcut.as_str());
    }
    let mut registered: Vec<String> = Vec::new();
    for binding in &shortcuts {
        if let Err(error) = register_session_shortcut(&app, binding) {
            for item in &registered {
                let _ = app.global_shortcut().unregister(item.as_str());
            }
            for previous in active.iter() {
                let _ = register_session_shortcut(&app, previous);
            }
            return Err(error);
        }
        registered.push(binding.shortcut.clone());
    }
    *active = shortcuts.clone();
    drop(active);

    let titles = query_sessions(1000)
        .unwrap_or_default()
        .into_iter()
        .map(|session| (session.id, session.title))
        .collect::<HashMap<_, _>>();
    let tray_state = app.state::<SessionShortcutTrayState>();
    let mut tray = tray_state
        .0
        .lock()
        .map_err(|_| "Session tray state is unavailable")?;
    if let Some(submenu) = tray.submenu.clone() {
        for item in tray.items.drain(..) {
            submenu.remove(&item).map_err(|error| error.to_string())?;
        }
        tray.session_by_item.clear();
        for (index, binding) in shortcuts.iter().enumerate() {
            let item_id = format!("session-shortcut-{index}");
            let title = titles
                .get(&binding.session_id)
                .cloned()
                .unwrap_or_else(|| "Untitled session".to_string());
            let item = MenuItem::with_id(
                &app,
                &item_id,
                format!("{title}    {}", binding.shortcut),
                true,
                None::<&str>,
            )
            .map_err(|error| error.to_string())?;
            submenu.append(&item).map_err(|error| error.to_string())?;
            tray.session_by_item
                .insert(item_id, binding.session_id.clone());
            tray.items.push(item);
        }
        if let Some(menu) = tray.menu.clone() {
            if shortcuts.is_empty() && tray.attached {
                menu.remove(&submenu).map_err(|error| error.to_string())?;
                tray.attached = false;
            } else if !shortcuts.is_empty() && !tray.attached {
                menu.insert(&submenu, 2)
                    .map_err(|error| error.to_string())?;
                tray.attached = true;
            }
        }
    }
    Ok(())
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
    *app.state::<SettingsWindowState>()
        .0
        .lock()
        .map_err(|_| "Settings state is unavailable")? = false;
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
    if let Ok(mut open) = app.state::<SettingsWindowState>().0.lock() {
        *open = true;
    }
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
        let settings_open = app
            .state::<SettingsWindowState>()
            .0
            .lock()
            .map(|open| *open)
            .unwrap_or(false);
        if settings_open {
            if !visible {
                let _ = show_main_above_capture(&window);
            } else {
                let _ = window.set_focus();
            }
            return;
        }
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
    let shortcut = Shortcut::new(Some(Modifiers::ALT), Code::Space);
    let registered_shortcut = shortcut.clone();
    tauri::Builder::default()
        .plugin(
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
        )
        .manage(PendingCapture::default())
        .manage(HermesBackend::default())
        .manage(PreviousChatMenu::default())
        .manage(SessionShortcutState::default())
        .manage(SessionShortcutTrayState::default())
        .manage(SettingsWindowState::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "main" {
                    if let Ok(mut open) =
                        window.app_handle().state::<SettingsWindowState>().0.lock()
                    {
                        *open = false;
                    }
                    let _ = window.emit("clear-prompt", ());
                }
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            #[cfg(windows)]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))?;

            app.global_shortcut().register(registered_shortcut)?;

            let show = MenuItem::with_id(app, "show", "Open Ask Hermes", true, None::<&str>)?;
            let previous =
                MenuItem::with_id(app, "previous", "Open previous chat", false, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let open_desktop = if desktop_binary().is_ok() {
                Some(MenuItem::with_id(
                    app,
                    "open-desktop",
                    "Open Hermes Desktop",
                    true,
                    None::<&str>,
                )?)
            } else {
                None
            };
            let session_shortcuts = Submenu::new(app, "Sessions", true)?;
            *app.state::<PreviousChatMenu>()
                .0
                .lock()
                .expect("tray menu state") = Some(previous.clone());
            let menu = if let Some(open_desktop) = open_desktop.as_ref() {
                Menu::with_items(app, &[&show, &previous, open_desktop, &settings, &quit])?
            } else {
                Menu::with_items(app, &[&show, &previous, &settings, &quit])?
            };
            {
                let tray_state = app.state::<SessionShortcutTrayState>();
                let mut tray = tray_state.0.lock().expect("session tray state");
                tray.menu = Some(menu.clone());
                tray.submenu = Some(session_shortcuts.clone());
            }
            TrayIconBuilder::new()
                .icon(tray_icon())
                .tooltip("Ask Hermes — Alt+Space")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    let item_id = event.id().as_ref();
                    match item_id {
                        "show" => show_prompt(app),
                        "previous" => {
                            if let Ok(mut open) = app.state::<SettingsWindowState>().0.lock() {
                                *open = false;
                            }
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = show_main_above_capture(&window);
                                let _ = window.emit("open-previous-chat", ());
                            }
                        }
                        "settings" => show_settings(app),
                        "open-desktop" => {
                            let _ = open_hermes_desktop();
                        }
                        "quit" => app.exit(0),
                        _ if item_id.starts_with("session-shortcut-") => {
                            let session_id = app
                                .state::<SessionShortcutTrayState>()
                                .0
                                .lock()
                                .ok()
                                .and_then(|tray| tray.session_by_item.get(item_id).cloned());
                            if let Some(session_id) = session_id {
                                show_session_shortcut(app, &session_id);
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            hermes_desktop_available,
            get_session_history_page,
            set_session_shortcuts,
            ask_hermes_gateway,
            set_previous_chat_available,
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

    #[test]
    fn pages_history_by_complete_user_turns() {
        let db = session_db();
        db.execute(
            "INSERT INTO sessions VALUES ('chat', 'desktop', NULL, 10, 'Chat', 0)",
            [],
        )
        .unwrap();
        for turn in 0..6_i64 {
            db.execute(
                "INSERT INTO messages (id, session_id, role, content, timestamp, active)
                 VALUES (?1, 'chat', 'user', ?2, ?1, 1)",
                (turn * 2 + 1, format!("question {turn}")),
            )
            .unwrap();
            db.execute(
                "INSERT INTO messages (id, session_id, role, content, timestamp, active)
                 VALUES (?1, 'chat', 'assistant', ?2, ?1, 1)",
                (turn * 2 + 2, format!("answer {turn}")),
            )
            .unwrap();
        }

        let latest = query_history_page_from(&db, "chat", None, 5).unwrap();
        assert!(latest.has_older);
        assert_eq!(latest.messages.first().unwrap().content, "question 1");
        assert_eq!(latest.messages.last().unwrap().content, "answer 5");

        let older =
            query_history_page_from(&db, "chat", Some(latest.messages.first().unwrap().id), 5)
                .unwrap();
        assert!(!older.has_older);
        assert_eq!(older.messages.len(), 2);
        assert_eq!(older.messages[0].content, "question 0");
    }

    #[test]
    fn accepts_shortcut_strings_recorded_by_the_settings_ui() {
        assert!("Ctrl+Alt+H".parse::<Shortcut>().is_ok());
        assert!("Shift+F8".parse::<Shortcut>().is_ok());
    }
}

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use futures_util::{SinkExt, StreamExt};
use image::{DynamicImage, ImageBuffer, ImageFormat, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env, fs,
    io::{BufRead, BufReader, Cursor, Read, Write},
    net::TcpStream,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, Submenu},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tokio_tungstenite::{connect_async, tungstenite::Message};

mod workspace;

/// Native-only English copy. Frontend copy lives in `src/workspace/strings.ts`;
/// native menus and command errors cannot import that TypeScript catalog.
mod native_text {
    use std::fmt::Display;

    pub const OPEN_ASK_HERMES: &str = "Open Ask Hermes";
    pub const OPEN_WORKSPACE: &str = "Open workspace";
    pub const OPEN_PREVIOUS_CHAT: &str = "Open previous chat";
    pub const SETTINGS: &str = "Settings";
    pub const QUIT: &str = "Quit";
    pub const OPEN_HERMES_DESKTOP: &str = "Open Hermes Desktop";
    pub const SESSIONS: &str = "Sessions";
    pub const DESKTOP_EXECUTABLE_NOT_FOUND: &str = "Hermes Desktop executable was not found";
    pub const TRAY_MENU_STATE_UNAVAILABLE: &str = "Tray menu state is unavailable";
    pub const SESSION_TRAY_STATE_UNAVAILABLE: &str = "Session tray state is unavailable";
    pub const TRAY_LINK_STATE_UNAVAILABLE: &str = "Tray link state is unavailable";
    pub const TRAY_MENU_UNAVAILABLE: &str = "Tray menu is unavailable";
    pub const WORKSPACE_TRAY_ITEM_UNAVAILABLE: &str = "Workspace tray item is unavailable";
    pub const DESKTOP_TRAY_ITEM_UNAVAILABLE: &str = "Hermes Desktop tray item is unavailable";
    pub const READ_WORKSPACE_GEOMETRY: &str = "Could not read workspace geometry";
    pub const PARSE_WORKSPACE_GEOMETRY: &str = "Could not parse workspace geometry";
    pub const WORKSPACE_GEOMETRY_STATE_UNAVAILABLE: &str =
        "Workspace geometry state is unavailable";
    pub const CREATE_APP_CONFIGURATION: &str = "Could not create app configuration";
    pub const ENCODE_WORKSPACE_GEOMETRY: &str = "Could not encode workspace geometry";
    pub const SAVE_WORKSPACE_GEOMETRY: &str = "Could not save workspace geometry";
    pub const WORKSPACE_WINDOW_UNAVAILABLE: &str = "Workspace window is unavailable";
    pub const UNKNOWN_ACTIVITY_SOURCE: &str = "Unknown activity source";
    pub const OPEN_HERMES_DESKTOP_ERROR: &str = "Could not open Hermes Desktop";

    pub fn with_error(context: &str, error: impl Display) -> String {
        format!("{context}: {error}")
    }
}

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
    http_url: String,
    token: String,
}

struct HermesBackendProcess {
    child: Child,
    connection: HermesGatewayConnection,
    profile: String,
    #[cfg(windows)]
    _job: WindowsKillJob,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HermesTurnRequest {
    instance_id: String,
    instance_generation: u64,
    exchange_id: String,
    prompt: String,
    image_data_urls: Vec<String>,
    stored_session_id: Option<String>,
    runtime_session_id: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceInputConfig {
    max_recording_seconds: u64,
    stt_enabled: bool,
}

#[derive(Debug, Serialize)]
struct VoiceTranscription {
    transcript: String,
}

const SPEACHES_MODEL: &str = "deepdml/faster-whisper-large-v3-turbo-ct2";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeachesStatus {
    installed: bool,
    running: bool,
    model: &'static str,
    websocket_url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct HermesInstanceConfig {
    remote: bool,
    address: String,
    port: u16,
    token: String,
    #[serde(default)]
    instance_id: String,
    #[serde(default)]
    instance_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HermesInstanceScope {
    instance_id: String,
    instance_generation: u64,
}

fn hermes_instance_id(config: &HermesInstanceConfig) -> String {
    if !config.instance_id.trim().is_empty() {
        config.instance_id.clone()
    } else if config.remote {
        format!("existing:{}:{}", config.address, config.port)
    } else {
        "automatic-hermes".to_string()
    }
}

impl Default for HermesInstanceConfig {
    fn default() -> Self {
        Self {
            remote: false,
            address: "127.0.0.1".to_string(),
            port: 0,
            token: String::new(),
            instance_id: "automatic-hermes".to_string(),
            instance_name: "Automatic Hermes".to_string(),
        }
    }
}

#[derive(Default)]
struct HermesBackendState {
    processes: HashMap<String, HermesBackendProcess>,
    unscoped_profile: Option<String>,
    config: HermesInstanceConfig,
    configured_once: bool,
    generation: u64,
}

const AUTOMATIC_UNSCOPED_PROCESS: &str = "__ask_hermes_active_profile__";

fn automatic_process_key(state: &HermesBackendState, profile: Option<&str>) -> String {
    profile
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| state.unscoped_profile.clone())
        .unwrap_or_else(|| AUTOMATIC_UNSCOPED_PROCESS.to_string())
}

#[derive(Default)]
struct HermesBackend(Mutex<HermesBackendState>);

impl Drop for HermesBackend {
    fn drop(&mut self) {
        if let Ok(state) = self.0.get_mut() {
            for process in state.processes.values_mut() {
                let _ = process.child.kill();
            }
        }
    }
}

struct SpeachesProcess {
    child: Child,
    #[cfg(windows)]
    _job: WindowsKillJob,
}

#[derive(Default)]
struct SpeachesBackend(Mutex<Option<SpeachesProcess>>);

impl Drop for SpeachesBackend {
    fn drop(&mut self) {
        if let Ok(slot) = self.0.get_mut() {
            if let Some(process) = slot.as_mut() {
                let _ = process.child.kill();
            }
        }
    }
}

#[cfg(windows)]
struct WindowsKillJob(isize);

#[cfg(windows)]
impl Drop for WindowsKillJob {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        let _ = unsafe { CloseHandle(HANDLE(self.0 as *mut _)) };
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

const DEFAULT_PROMPT_SHORTCUT: &str = "Alt+Space";
const TRAY_ICON_ID: &str = "ask-hermes-tray";
const PROMPT_SHORTCUT_CONFIG_FILE: &str = "prompt-shortcut.json";

#[derive(Debug, Clone)]
struct ActiveShortcutConfiguration {
    prompt_shortcut: String,
    prompt: Shortcut,
    session_shortcuts: Vec<SessionShortcutConfig>,
    session_by_shortcut: HashMap<u32, String>,
    registered: HashMap<u32, Shortcut>,
}

impl Default for ActiveShortcutConfiguration {
    fn default() -> Self {
        let prompt = Shortcut::new(Some(Modifiers::ALT), Code::Space);
        Self {
            prompt_shortcut: DEFAULT_PROMPT_SHORTCUT.to_string(),
            prompt,
            session_shortcuts: Vec::new(),
            session_by_shortcut: HashMap::new(),
            registered: HashMap::from([(prompt.id(), prompt)]),
        }
    }
}

#[derive(Default)]
struct ShortcutConfigurationState(Mutex<ActiveShortcutConfiguration>);

#[derive(Default)]
struct ShortcutUpdateState(tokio::sync::Mutex<()>);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedPromptShortcut {
    version: u8,
    shortcut: String,
}

#[derive(Default)]
struct SettingsWindowState(Mutex<bool>);

#[derive(Default)]
struct ActiveSessionShortcut(Mutex<Option<String>>);

struct PromptWindowLayout(Mutex<PromptWindowLayoutState>);

struct PromptWindowLayoutState {
    expanded: bool,
    settings: bool,
    expanded_width: f64,
    expanded_height: f64,
}

impl Default for PromptWindowLayout {
    fn default() -> Self {
        Self(Mutex::new(PromptWindowLayoutState {
            expanded: false,
            settings: false,
            expanded_width: 620.0,
            expanded_height: 360.0,
        }))
    }
}

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

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum TrayLinkMode {
    Workspace,
    Desktop,
    Both,
}

impl Default for TrayLinkMode {
    fn default() -> Self {
        Self::Workspace
    }
}

#[derive(Default)]
struct TrayLinkMenuState(Mutex<TrayLinkMenu>);

#[derive(Default)]
struct TrayLinkMenu {
    menu: Option<Menu<tauri::Wry>>,
    workspace: Option<MenuItem<tauri::Wry>>,
    desktop: Option<MenuItem<tauri::Wry>>,
    mode: TrayLinkMode,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceOpenTarget {
    instance_id: String,
    instance_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    handoff_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    schedule_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    draft: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    captures: Option<Vec<WorkspaceHandoffCapture>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceQuitRequest {
    confirmation_required: bool,
}

#[derive(Default)]
struct WorkspaceQuitState(Mutex<Option<WorkspaceQuitRequest>>);

impl WorkspaceQuitState {
    fn queue(&self, confirmation_required: bool) -> Result<WorkspaceQuitRequest, String> {
        let mut pending = self
            .0
            .lock()
            .map_err(|_| "Workspace quit state is unavailable".to_string())?;
        let request = WorkspaceQuitRequest {
            confirmation_required: confirmation_required
                || pending
                    .as_ref()
                    .is_some_and(|request| request.confirmation_required),
        };
        *pending = Some(request.clone());
        Ok(request)
    }

    fn pending(&self) -> Result<Option<WorkspaceQuitRequest>, String> {
        self.0
            .lock()
            .map_err(|_| "Workspace quit state is unavailable".to_string())
            .map(|request| request.clone())
    }

    fn cancel(&self) -> Result<(), String> {
        *self
            .0
            .lock()
            .map_err(|_| "Workspace quit state is unavailable".to_string())? = None;
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceHandoffCapture {
    name: String,
    mime_type: String,
    data_url: String,
    size: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

const WORKSPACE_STARTUP_SMOKE_READY_FILE_ENV: &str = "ASK_HERMES_SMOKE_READY_FILE";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceStartupSmokeReport {
    document_url: String,
    shell_display: String,
    shell_width: f64,
    shell_height: f64,
    wordmark: String,
}

#[derive(Default)]
struct WorkspaceGeometryState(Mutex<Option<WorkspaceGeometry>>);

#[derive(Default)]
struct WorkspaceActiveWork(Mutex<HashMap<String, usize>>);

impl WorkspaceActiveWork {
    fn set(&self, source: &str, active: bool) {
        if let Ok(mut sources) = self.0.lock() {
            if active {
                sources.insert(source.to_string(), 1);
            } else {
                sources.remove(source);
            }
        }
    }

    fn increment(&self, source: &str) {
        if let Ok(mut sources) = self.0.lock() {
            *sources.entry(source.to_string()).or_default() += 1;
        }
    }

    fn decrement(&self, source: &str) {
        if let Ok(mut sources) = self.0.lock() {
            if let Some(count) = sources.get_mut(source) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    sources.remove(source);
                }
            }
        }
    }

    fn any(&self) -> bool {
        self.0
            .lock()
            .map(|sources| sources.values().any(|count| *count > 0))
            .unwrap_or(true)
    }

    fn any_named(&self, names: &[&str]) -> bool {
        self.0
            .lock()
            .map(|sources| {
                names
                    .iter()
                    .any(|name| sources.get(*name).is_some_and(|count| *count > 0))
            })
            .unwrap_or(true)
    }
}

struct PromptActiveGuard(AppHandle);

impl PromptActiveGuard {
    fn new(app: &AppHandle) -> Self {
        app.state::<WorkspaceActiveWork>()
            .increment("prompt-backend");
        Self(app.clone())
    }
}

impl Drop for PromptActiveGuard {
    fn drop(&mut self) {
        self.0
            .state::<WorkspaceActiveWork>()
            .decrement("prompt-backend");
    }
}

struct PromptMirrorGuard {
    app: AppHandle,
    profile: String,
    stored_id: String,
    finished: bool,
}

impl PromptMirrorGuard {
    fn finish(&mut self) {
        self.finished = true;
    }
}

impl Drop for PromptMirrorGuard {
    fn drop(&mut self) {
        if !self.finished {
            workspace::mirror_prompt_ended(
                &self.app,
                &self.profile,
                &self.stored_id,
                Some("Prompt turn ended before Hermes completed it"),
            );
        }
    }
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
        .ok_or_else(|| {
            "Hermes Agent was not found. Start Hermes Desktop once, then retry.".to_string()
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
    Err(native_text::DESKTOP_EXECUTABLE_NOT_FOUND.to_string())
}

#[tauri::command]
fn hermes_desktop_available() -> bool {
    desktop_binary().is_ok()
}

fn numeric_time(value: Option<&Value>) -> f64 {
    value
        .and_then(|value| {
            value.as_f64().or_else(|| {
                value
                    .as_str()
                    .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
                    .map(|time| time.timestamp_millis() as f64 / 1000.0)
            })
        })
        .unwrap_or_default()
}

fn encode_query(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

async fn active_profile(connection: &HermesGatewayConnection) -> Result<String, String> {
    let payload = hermes_http_json(
        connection,
        reqwest::Method::GET,
        "/api/profiles/active",
        None,
        Duration::from_secs(15),
    )
    .await?;
    Ok(payload
        .get("active")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("default")
        .to_string())
}

async fn query_sessions_gateway(
    backend: &HermesBackend,
    limit: usize,
) -> Result<Vec<HermesSession>, String> {
    let connection = hermes_gateway_connection(backend)?;
    let profile = active_profile(&connection).await?;
    bind_unscoped_hermes_gateway_profile(backend, &profile)?;
    let path = format!(
        "/api/profiles/sessions?limit={}&offset=0&min_messages=0&archived=exclude&order=recent&profile={}&exclude_sources=subagent%2Cbackground%2Ccron%2Cschedule",
        limit.clamp(1, 1000),
        encode_query(&profile),
    );
    let payload = hermes_http_json(
        &connection,
        reqwest::Method::GET,
        &path,
        None,
        Duration::from_secs(30),
    )
    .await?;
    Ok(payload
        .get("sessions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?.to_string();
            let title = row
                .get("title")
                .or_else(|| row.get("display_name"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("Untitled session")
                .to_string();
            let preview = row
                .get("preview")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .chars()
                .take(140)
                .collect();
            Some(HermesSession {
                id,
                title,
                preview,
                started_at: numeric_time(row.get("started_at")),
                last_active: numeric_time(row.get("last_active").or_else(|| row.get("started_at"))),
            })
        })
        .collect())
}

#[tauri::command]
async fn list_sessions(
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, workspace::WorkspaceBackend>,
    instance_id: String,
    instance_generation: u64,
) -> Result<Vec<HermesSession>, String> {
    let _operation = workspace::begin_instance_operation(
        &backend,
        &workspace,
        &instance_id,
        instance_generation,
    )
    .await?;
    query_sessions_gateway(&backend, 200).await
}

pub(crate) async fn locate_session_profile(
    connection: &HermesGatewayConnection,
    session_id: &str,
) -> Result<(String, Value), String> {
    let active = active_profile(connection).await?;
    let profiles = hermes_http_json(
        connection,
        reqwest::Method::GET,
        "/api/profiles",
        None,
        Duration::from_secs(15),
    )
    .await?;
    let mut names = vec![active];
    names.extend(
        profiles
            .get("profiles")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|profile| {
                profile
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }),
    );
    names.dedup();
    for profile in names {
        let path = format!(
            "/api/sessions/{}?profile={}",
            encode_query(session_id),
            encode_query(&profile)
        );
        if let Ok(detail) = hermes_http_json(
            connection,
            reqwest::Method::GET,
            &path,
            None,
            Duration::from_secs(15),
        )
        .await
        {
            return Ok((profile, detail));
        }
    }
    Err("Hermes session was not found on the active instance".to_string())
}

async fn gateway_message_rows(
    connection: &HermesGatewayConnection,
    profile: &str,
    session_id: &str,
    offset: usize,
    limit: usize,
) -> Result<Vec<Value>, String> {
    let path = format!(
        "/api/sessions/{}/messages?profile={}&offset={offset}&limit={}",
        encode_query(session_id),
        encode_query(profile),
        limit.clamp(1, 500),
    );
    let payload = hermes_http_json(
        connection,
        reqwest::Method::GET,
        &path,
        None,
        Duration::from_secs(30),
    )
    .await?;
    Ok(payload
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

#[tauri::command]
async fn get_session_history_page(
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, workspace::WorkspaceBackend>,
    instance_id: String,
    instance_generation: u64,
    session_id: String,
    before_id: Option<i64>,
    limit: usize,
) -> Result<HermesHistoryPage, String> {
    let _operation = workspace::begin_instance_operation(
        &backend,
        &workspace,
        &instance_id,
        instance_generation,
    )
    .await?;
    let connection = hermes_gateway_connection(&backend)?;
    let (profile, detail) = locate_session_profile(&connection, &session_id).await?;
    let count = detail
        .get("message_count")
        .and_then(Value::as_u64)
        .unwrap_or_default() as usize;
    let mut boundary = count;
    if let Some(before_id) = before_id {
        let mut end = count;
        let mut found = None;
        while end > 0 && count.saturating_sub(end) < 20_000 {
            let start = end.saturating_sub(500);
            let rows = gateway_message_rows(&connection, &profile, &session_id, start, end - start)
                .await?;
            if let Some(index) = rows.iter().position(|row| {
                row.get("id")
                    .and_then(|id| id.as_i64().or_else(|| id.as_str()?.parse().ok()))
                    == Some(before_id)
            }) {
                found = Some(start + index);
                break;
            }
            end = start;
        }
        boundary = found.ok_or_else(|| "Could not locate the history page boundary".to_string())?;
    }

    let wanted_users = limit.clamp(1, 50);
    let mut start = boundary;
    let mut rows = Vec::new();
    while start > 0 {
        let chunk_start = start.saturating_sub(500);
        let mut chunk = gateway_message_rows(
            &connection,
            &profile,
            &session_id,
            chunk_start,
            start - chunk_start,
        )
        .await?;
        chunk.append(&mut rows);
        rows = chunk;
        start = chunk_start;
        let user_count = rows
            .iter()
            .filter(|row| {
                row.get("role").and_then(Value::as_str) == Some("user")
                    && !workspace::gateway_value_text(
                        row.get("content").or_else(|| row.get("text")),
                    )
                    .is_empty()
            })
            .count();
        if user_count >= wanted_users || rows.len() >= 20_000 {
            break;
        }
    }
    let user_indexes = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| {
            row.get("role").and_then(Value::as_str) == Some("user")
                && !workspace::gateway_value_text(row.get("content").or_else(|| row.get("text")))
                    .is_empty()
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let page_start = user_indexes
        .iter()
        .rev()
        .take(wanted_users)
        .last()
        .copied()
        .unwrap_or(rows.len());
    let has_older = start > 0 || user_indexes.iter().any(|index| *index < page_start);
    let messages = rows[page_start..]
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            let role = row.get("role").and_then(Value::as_str)?;
            if !matches!(role, "user" | "assistant") {
                return None;
            }
            let content =
                workspace::gateway_value_text(row.get("content").or_else(|| row.get("text")));
            if content.is_empty() {
                return None;
            }
            let id = row
                .get("id")
                .and_then(|id| id.as_i64().or_else(|| id.as_str()?.parse().ok()))
                .unwrap_or((start + page_start + index + 1) as i64);
            Some(HermesHistoryMessage {
                id,
                role: role.to_string(),
                content,
            })
        })
        .collect();
    Ok(HermesHistoryPage {
        messages,
        has_older,
    })
}

fn validate_hermes_address(config: &HermesInstanceConfig) -> Result<String, String> {
    let address = config.address.trim();
    if address.is_empty()
        || address.contains("://")
        || address
            .chars()
            .any(|character| character.is_whitespace() || "/\\@?#".contains(character))
    {
        return Err("Enter a valid Hermes hostname or IP address".to_string());
    }
    let unbracketed = address
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(address);
    let formatted_host = if unbracketed.contains(':') {
        format!("[{unbracketed}]")
    } else {
        unbracketed.to_string()
    };
    reqwest::Url::parse(&format!("http://{formatted_host}:1"))
        .map_err(|_| "Enter a valid Hermes hostname or IP address".to_string())?;
    Ok(unbracketed.to_string())
}

fn remote_hermes_connection(
    config: &HermesInstanceConfig,
) -> Result<HermesGatewayConnection, String> {
    let address = validate_hermes_address(config)?;
    if config.port == 0 {
        return Err("Hermes port must be between 1 and 65535".to_string());
    }
    let token = config.token.trim();
    let formatted_address = if address.contains(':') {
        format!("[{address}]")
    } else {
        address
    };
    let mut http_url = reqwest::Url::parse(&format!("http://{formatted_address}:{}", config.port))
        .map_err(|_| "Enter a valid Hermes hostname or IP address".to_string())?;
    let mut ws_url = http_url.clone();
    ws_url
        .set_scheme("ws")
        .map_err(|_| "Could not build the Hermes WebSocket address".to_string())?;
    ws_url.set_path("/api/ws");
    if !token.is_empty() {
        ws_url.query_pairs_mut().append_pair("token", token);
    }
    http_url.set_path("");
    Ok(HermesGatewayConnection {
        ws_url: ws_url.to_string(),
        http_url: http_url.as_str().trim_end_matches('/').to_string(),
        token: token.to_string(),
    })
}

fn parse_local_gateway_active_profile(response: &[u8]) -> Result<String, String> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Hermes active-profile response was invalid".to_string())?;
    let headers = std::str::from_utf8(&response[..header_end])
        .map_err(|_| "Hermes active-profile response was invalid".to_string())?;
    let status = headers.lines().next().unwrap_or_default();
    if !status.starts_with("HTTP/1.1 200 ") && !status.starts_with("HTTP/1.0 200 ") {
        return Err(format!("Hermes active-profile request failed: {status}"));
    }
    let payload: Value = serde_json::from_slice(&response[header_end + 4..])
        .map_err(|error| format!("Hermes active-profile response was invalid: {error}"))?;
    payload
        .get("active")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Hermes did not report its active profile".to_string())
}

fn local_gateway_active_profile(port: u16, token: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .map_err(|error| format!("Could not parse Hermes gateway address: {error}"))?,
        Duration::from_secs(2),
    )
    .map_err(|error| format!("Could not inspect Hermes active profile: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    let auth = if token.is_empty() {
        String::new()
    } else {
        format!("X-Hermes-Session-Token: {token}\r\n")
    };
    stream
        .write_all(
            format!(
                "GET /api/profiles/active HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Connection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .map_err(|error| format!("Could not inspect Hermes active profile: {error}"))?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("Could not inspect Hermes active profile: {error}"))?;
    parse_local_gateway_active_profile(&response)
}

fn start_hermes_backend_for_profile(profile: Option<&str>) -> Result<HermesBackendProcess, String> {
    let address = "127.0.0.1";
    let token = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
    let mut command = Command::new(hermes_binary()?);
    if let Some(profile) = profile.filter(|value| !value.trim().is_empty()) {
        command.args(["--profile", profile]);
    }
    command
        .args(["serve", "--host", address, "--port", "0"])
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
        use windows::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        command.creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the Hermes gateway: {error}"))?;
    #[cfg(windows)]
    let job = match assign_process_job_and_resume(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            return Err(error);
        }
    };
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Hermes gateway did not expose its startup output".to_string())?;
    let mut reader = BufReader::new(stdout);
    let actual_port = loop {
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

    let active_profile = match profile.filter(|value| !value.trim().is_empty()) {
        Some(profile) => profile.to_string(),
        None => match local_gateway_active_profile(actual_port, &token) {
            Ok(profile) => profile,
            Err(error) => {
                let _ = child.kill();
                return Err(error);
            }
        },
    };
    Ok(HermesBackendProcess {
        child,
        connection: HermesGatewayConnection {
            ws_url: format!("ws://127.0.0.1:{actual_port}/api/ws?token={token}"),
            http_url: format!("http://127.0.0.1:{actual_port}"),
            token,
        },
        profile: active_profile,
        #[cfg(windows)]
        _job: job,
    })
}

#[cfg(test)]
fn start_hermes_backend() -> Result<HermesBackendProcess, String> {
    start_hermes_backend_for_profile(None)
}

#[tauri::command]
fn get_hermes_instance_scope(
    state: tauri::State<'_, HermesBackend>,
    expected_instance_id: Option<String>,
) -> Result<HermesInstanceScope, String> {
    let backend = state
        .0
        .lock()
        .map_err(|_| "Hermes gateway state is unavailable")?;
    let instance_id = hermes_instance_id(&backend.config);
    if expected_instance_id
        .as_deref()
        .is_some_and(|expected| expected != instance_id)
    {
        return Err("Hermes instance configuration is still changing".to_string());
    }
    Ok(HermesInstanceScope {
        instance_id,
        instance_generation: backend.generation,
    })
}

#[tauri::command]
async fn configure_hermes_instance(
    app: AppHandle,
    config: HermesInstanceConfig,
    state: tauri::State<'_, HermesBackend>,
    active_work: tauri::State<'_, WorkspaceActiveWork>,
    workspace: tauri::State<'_, workspace::WorkspaceBackend>,
) -> Result<HermesInstanceScope, String> {
    if config.remote {
        remote_hermes_connection(&config)?;
    }
    // Gateway mutations hold the read side for their complete async lifetime.
    // Never let an in-flight old-instance request overlap a configuration swap.
    let _instance_operation = workspace.instance_operations.write().await;
    let (same_config, configured_once) = state
        .0
        .lock()
        .map(|backend| (backend.config == config, backend.configured_once))
        .map_err(|_| "Hermes gateway state is unavailable")?;
    if same_config {
        let mut backend = state
            .0
            .lock()
            .map_err(|_| "Hermes gateway state is unavailable")?;
        backend.configured_once = true;
        return Ok(HermesInstanceScope {
            instance_id: hermes_instance_id(&backend.config),
            instance_generation: backend.generation,
        });
    }
    // Before first persisted configuration, only a real compact backend turn
    // can belong to the default process. Persisted workspace queues belong to
    // the instance being selected and must not deadlock initial hydration.
    if !configured_once && active_work.any_named(&["prompt-backend", "prompt-submit"]) {
        return Err("Finish or clear active turns/queues before switching instances".to_string());
    }
    if configured_once {
        let authoritative_active = workspace::refresh_authoritative_active_work_locked(&app)
            .await
            .map_err(|error| {
                format!("Could not verify active Hermes work before switching instances: {error}")
            })?;
        if authoritative_active {
            return Err(
                "Finish or clear active turns/queues before switching instances".to_string(),
            );
        }
    }
    let scope = {
        let mut backend = state
            .0
            .lock()
            .map_err(|_| "Hermes gateway state is unavailable")?;
        if backend.config == config {
            backend.configured_once = true;
            return Ok(HermesInstanceScope {
                instance_id: hermes_instance_id(&backend.config),
                instance_generation: backend.generation,
            });
        }
        // Initial configuration may race persisted UI queue hydration. No gateway
        // has been selected yet, so that hydration cannot belong to this process.
        if (backend.configured_once || active_work.any_named(&["prompt-backend", "prompt-submit"]))
            && active_work.any()
        {
            return Err(
                "Finish or clear active turns/queues before switching instances".to_string(),
            );
        }
        for process in backend.processes.values_mut() {
            let _ = process.child.kill();
        }
        backend.processes.clear();
        backend.unscoped_profile = None;
        backend.config = config;
        backend.configured_once = true;
        backend.generation = backend.generation.wrapping_add(1);
        HermesInstanceScope {
            instance_id: hermes_instance_id(&backend.config),
            instance_generation: backend.generation,
        }
    };
    workspace.reset_for_instance_switch().await;
    let _ = app.emit("workspace-event", json!({ "type": "instance-invalidated" }));
    Ok(scope)
}

fn hermes_gateway_connection(state: &HermesBackend) -> Result<HermesGatewayConnection, String> {
    hermes_gateway_connection_for_profile(state, None)
}

fn hermes_gateway_connection_for_profile(
    state: &HermesBackend,
    profile: Option<&str>,
) -> Result<HermesGatewayConnection, String> {
    let mut backend = state
        .0
        .lock()
        .map_err(|_| "Hermes gateway state is unavailable")?;
    if backend.config.remote {
        return remote_hermes_connection(&backend.config);
    }
    let profile = profile.map(str::trim).filter(|value| !value.is_empty());
    // An unscoped launch uses Hermes' active profile. Once the gateway reports
    // that profile, bind_unscoped_hermes_gateway_profile rekeys this process so
    // compact prompt and same-profile workspace calls reuse one runtime host.
    let mut process_key = automatic_process_key(&backend, profile);
    let alive_connection = if let Some(process) = backend.processes.get_mut(&process_key) {
        if process
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            Some(process.connection.clone())
        } else {
            None
        }
    } else {
        None
    };
    if let Some(connection) = alive_connection {
        return Ok(connection);
    }
    backend.processes.remove(&process_key);
    if profile.is_none() && backend.unscoped_profile.as_deref() == Some(process_key.as_str()) {
        // A dead active-profile process must be rediscovered. CLI may have
        // changed the active profile since this process was launched.
        backend.unscoped_profile = None;
        process_key = AUTOMATIC_UNSCOPED_PROCESS.to_string();
    }
    let mut process = start_hermes_backend_for_profile(profile)?;
    if profile.is_none() {
        // Startup has already asked this gateway for its active profile while
        // the backend lock is held. Publish only that canonical key: an
        // explicit request cannot race an unresolved, turn-owning process.
        process_key = process.profile.clone();
        backend.unscoped_profile = Some(process_key.clone());
        if let Some(existing) = backend.processes.get_mut(&process_key) {
            let existing_alive = match existing.child.try_wait() {
                Ok(status) => status.is_none(),
                Err(error) => {
                    let _ = process.child.kill();
                    backend.unscoped_profile = None;
                    return Err(error.to_string());
                }
            };
            if existing_alive {
                // Explicit-first startup: the newly discovered unscoped
                // gateway has never been returned and cannot own a turn.
                // Keep the canonical explicit process and stop the duplicate.
                let connection = existing.connection.clone();
                let _ = process.child.kill();
                return Ok(connection);
            }
            backend.processes.remove(&process_key);
        }
    }
    let connection = process.connection.clone();
    backend.processes.insert(process_key, process);
    Ok(connection)
}

/// Bind a lazily launched, unscoped automatic gateway to the profile it
/// reports. This prevents a later explicit request for that profile from
/// launching a duplicate process and keeps mirrored runtime IDs usable.
pub(crate) fn bind_unscoped_hermes_gateway_profile(
    state: &HermesBackend,
    profile: &str,
) -> Result<(), String> {
    let profile = profile.trim();
    if profile.is_empty() {
        return Ok(());
    }
    let mut backend = state
        .0
        .lock()
        .map_err(|_| "Hermes gateway state is unavailable".to_string())?;
    if backend.config.remote || backend.unscoped_profile.as_deref() == Some(profile) {
        return Ok(());
    }
    let Some(mut process) = backend.processes.remove(AUTOMATIC_UNSCOPED_PROCESS) else {
        return Ok(());
    };
    if let Some(existing) = backend.processes.get_mut(profile) {
        let existing_alive = match existing.child.try_wait() {
            Ok(status) => status.is_none(),
            Err(error) => {
                backend
                    .processes
                    .insert(AUTOMATIC_UNSCOPED_PROCESS.to_string(), process);
                return Err(error.to_string());
            }
        };
        if existing_alive {
            // Legacy/race recovery only. Normal startup binds before returning
            // a connection, so this unscoped process cannot own a turn.
            let _ = process.child.kill();
            backend.unscoped_profile = Some(profile.to_string());
            return Ok(());
        }
        backend.processes.remove(profile);
    }
    process.profile = profile.to_string();
    backend.processes.insert(profile.to_string(), process);
    backend.unscoped_profile = Some(profile.to_string());
    Ok(())
}

/// Snapshot profile gateways already owned by Ask without launching dormant
/// profiles. Used by All Profiles activity reconciliation.
pub(crate) fn running_hermes_gateway_connections(
    state: &HermesBackend,
) -> Result<Vec<(String, HermesGatewayConnection)>, String> {
    let mut backend = state
        .0
        .lock()
        .map_err(|_| "Hermes gateway state is unavailable".to_string())?;
    if backend.config.remote {
        return Ok(Vec::new());
    }
    let mut connections = Vec::new();
    for (profile, process) in &mut backend.processes {
        if profile == AUTOMATIC_UNSCOPED_PROCESS {
            // Profile is not authoritative until /api/profiles/active binds it.
            // Never project this process as a literal/default profile.
            continue;
        }
        if process
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            connections.push((profile.clone(), process.connection.clone()));
        }
    }
    Ok(connections)
}

fn transcription_timeout(data_url_len: usize) -> Duration {
    Duration::from_millis(((data_url_len as u64) / 10).clamp(180_000, 600_000))
}

async fn hermes_http_json(
    connection: &HermesGatewayConnection,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
    timeout: Duration,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .build()
        .map_err(|error| format!("Could not prepare Hermes request: {error}"))?;
    let mut request = client.request(method, format!("{}{}", connection.http_url, path));
    if !connection.token.is_empty() {
        request = request.header("X-Hermes-Session-Token", &connection.token);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Could not reach Hermes gateway: {error}"))?;
    let status = response.status();
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Hermes returned an invalid response: {error}"))?;
    if !status.is_success() {
        let message = payload
            .get("detail")
            .and_then(Value::as_str)
            .unwrap_or("Hermes request failed");
        return Err(message.to_string());
    }
    Ok(payload)
}

#[tauri::command]
async fn get_voice_input_config(
    state: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, workspace::WorkspaceBackend>,
    instance_id: String,
    instance_generation: u64,
) -> Result<VoiceInputConfig, String> {
    let _operation =
        workspace::begin_instance_operation(&state, &workspace, &instance_id, instance_generation)
            .await?;
    let connection = hermes_gateway_connection(&state)?;
    let config = hermes_http_json(
        &connection,
        reqwest::Method::GET,
        "/api/config",
        None,
        Duration::from_secs(30),
    )
    .await?;
    let seconds = config
        .pointer("/voice/max_recording_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(120)
        .clamp(1, 600);
    let stt_enabled = config
        .pointer("/stt/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    Ok(VoiceInputConfig {
        max_recording_seconds: seconds,
        stt_enabled,
    })
}

#[tauri::command]
async fn transcribe_voice_audio(
    state: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, workspace::WorkspaceBackend>,
    instance_id: String,
    instance_generation: u64,
    data_url: String,
    mime_type: String,
) -> Result<VoiceTranscription, String> {
    let _operation =
        workspace::begin_instance_operation(&state, &workspace, &instance_id, instance_generation)
            .await?;
    let connection = hermes_gateway_connection(&state)?;
    let timeout = transcription_timeout(data_url.len());
    let response = hermes_http_json(
        &connection,
        reqwest::Method::POST,
        "/api/audio/transcribe",
        Some(json!({ "data_url": data_url, "mime_type": mime_type })),
        timeout,
    )
    .await?;
    Ok(VoiceTranscription {
        transcript: response
            .get("transcript")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string(),
    })
}

fn speaches_root() -> Result<PathBuf, String> {
    let local_app_data = env::var_os("LOCALAPPDATA")
        .ok_or_else(|| "Windows local application data directory is unavailable".to_string())?;
    Ok(PathBuf::from(local_app_data)
        .join("Ask Hermes")
        .join("Speaches"))
}

fn speaches_python() -> Result<PathBuf, String> {
    let python = speaches_root()?
        .join(".venv")
        .join("Scripts")
        .join("python.exe");
    if python.is_file() {
        Ok(python)
    } else {
        Err("Native Speaches is not installed".to_string())
    }
}

async fn speaches_is_running() -> bool {
    let client = match reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    client
        .get("http://127.0.0.1:8000/health")
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn assign_process_job_and_resume(child: &Child) -> Result<WindowsKillJob, String> {
    use std::{mem::size_of, os::windows::io::AsRawHandle};
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                    THREADENTRY32,
                },
                JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
                Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
            },
        },
    };

    let job_handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
        .map_err(|error| format!("Could not create process job: {error}"))?;
    let job = WindowsKillJob(job_handle.0 as isize);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job_handle,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|error| format!("Could not configure process job: {error}"))?;
        AssignProcessToJobObject(job_handle, HANDLE(child.as_raw_handle()))
            .map_err(|error| format!("Could not assign Speaches to its process job: {error}"))?;
    }

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }
        .map_err(|error| format!("Could not inspect the suspended process: {error}"))?;
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut thread_id = None;
    if unsafe { Thread32First(snapshot, &mut entry) }.is_ok() {
        loop {
            if entry.th32OwnerProcessID == child.id() {
                thread_id = Some(entry.th32ThreadID);
                break;
            }
            if unsafe { Thread32Next(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }
    let _ = unsafe { CloseHandle(snapshot) };
    let thread_id =
        thread_id.ok_or_else(|| "Could not find the suspended process thread".to_string())?;
    let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, thread_id) }
        .map_err(|error| format!("Could not open the suspended process thread: {error}"))?;
    let resume_result = unsafe { ResumeThread(thread) };
    let _ = unsafe { CloseHandle(thread) };
    if resume_result == u32::MAX {
        return Err("Could not resume the Speaches process".to_string());
    }
    Ok(job)
}

fn spawn_speaches() -> Result<SpeachesProcess, String> {
    let root = speaches_root()?;
    let python = speaches_python()?;
    let cublas = root
        .join(".venv")
        .join("Lib")
        .join("site-packages")
        .join("nvidia")
        .join("cublas")
        .join("bin");
    let cudnn = root
        .join(".venv")
        .join("Lib")
        .join("site-packages")
        .join("nvidia")
        .join("cudnn")
        .join("bin");
    let inherited_path = env::var_os("PATH").unwrap_or_default();
    let search_paths = [cublas, cudnn]
        .into_iter()
        .chain(env::split_paths(&inherited_path));
    let search_path = env::join_paths(search_paths)
        .map_err(|error| format!("Could not configure Speaches CUDA libraries: {error}"))?;

    let mut command = Command::new(python);
    command
        .current_dir(&root)
        .args([
            "-m",
            "uvicorn",
            "speaches.main:create_app",
            "--factory",
            "--host",
            "127.0.0.1",
            "--port",
            "8000",
            "--log-level",
            "warning",
        ])
        .env("PATH", search_path)
        .env("WHISPER__INFERENCE_DEVICE", "cuda")
        .env("WHISPER__COMPUTE_TYPE", "float16")
        .env("STT_MODEL_TTL", "-1")
        .env("ENABLE_UI", "false")
        .env("LOOPBACK_HOST_URL", "http://127.0.0.1:8000")
        .env("HF_HOME", root.join("models"))
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        command.creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start native Speaches: {error}"))?;
    #[cfg(windows)]
    let job = match assign_process_job_and_resume(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            return Err(error);
        }
    };
    Ok(SpeachesProcess {
        child,
        #[cfg(windows)]
        _job: job,
    })
}

#[tauri::command]
async fn get_speaches_status() -> SpeachesStatus {
    let installed = speaches_python().is_ok();
    SpeachesStatus {
        installed,
        running: installed && speaches_is_running().await,
        model: SPEACHES_MODEL,
        websocket_url: format!(
            "ws://127.0.0.1:8000/v1/realtime?model={SPEACHES_MODEL}&intent=transcription"
        ),
    }
}

#[tauri::command]
async fn ensure_speaches(
    state: tauri::State<'_, SpeachesBackend>,
) -> Result<SpeachesStatus, String> {
    speaches_python()?;
    if !speaches_is_running().await {
        let should_spawn = {
            let mut slot = state
                .0
                .lock()
                .map_err(|_| "Speaches process state is unavailable")?;
            match slot.as_mut() {
                Some(process) => process
                    .child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_some(),
                None => true,
            }
        };
        if should_spawn {
            let process = spawn_speaches()?;
            *state
                .0
                .lock()
                .map_err(|_| "Speaches process state is unavailable")? = Some(process);
        }
        let mut ready = false;
        for _ in 0..120 {
            if speaches_is_running().await {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        if !ready {
            return Err("Native Speaches did not become ready".to_string());
        }
    }
    Ok(SpeachesStatus {
        installed: true,
        running: true,
        model: SPEACHES_MODEL,
        websocket_url: format!(
            "ws://127.0.0.1:8000/v1/realtime?model={SPEACHES_MODEL}&intent=transcription"
        ),
    })
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
    workspace: tauri::State<'_, workspace::WorkspaceBackend>,
    request: HermesTurnRequest,
) -> Result<HermesTurnResponse, String> {
    let HermesTurnRequest {
        instance_id,
        instance_generation,
        exchange_id,
        prompt,
        image_data_urls,
        stored_session_id,
        runtime_session_id,
        model,
        reasoning_effort,
        fast,
    } = request;
    // Serialize turn start against instance configuration. Once active work is
    // registered, configure will reject instead of waiting on an old transport.
    let instance_operation = workspace.instance_operations.read().await;
    {
        let backend = state
            .0
            .lock()
            .map_err(|_| "Hermes gateway state is unavailable")?;
        if hermes_instance_id(&backend.config) != instance_id
            || backend.generation != instance_generation
        {
            return Err("Prompt turn belongs to a stale Hermes instance generation".to_string());
        }
    }
    let _active_turn = PromptActiveGuard::new(&app);
    let connection = hermes_gateway_connection(&state)?;
    drop(instance_operation);
    let (mut socket, _) = connect_async(&connection.ws_url)
        .await
        .map_err(|error| format!("Could not connect to Hermes backend: {error}"))?;
    let mut request_id = 0_u64;
    let supplied_runtime_id = runtime_session_id.filter(|id| !id.trim().is_empty());
    let runtime_id: Option<String>;
    let mut stored_id = stored_session_id.filter(|id| !id.trim().is_empty());

    // A runtime ID is only meaningful inside the current Hermes gateway process.
    // A stored ID is durable. Re-resume stored chats on every turn so Hermes can
    // cheaply reuse a live runtime, recreate a reaped one, or follow a compressed
    // session to its continuation instead of trusting stale frontend state.
    if stored_id.is_some() {
        request_id += 1;
        let result = gateway_rpc(
            &mut socket,
            request_id,
            "session.resume",
            json!({ "session_id": stored_id.as_ref().unwrap(), "source": "desktop" }),
        )
        .await?;
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
    } else if supplied_runtime_id.is_some() {
        runtime_id = supplied_runtime_id;
    } else {
        request_id += 1;
        let result = gateway_rpc(
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
        .await?;
        runtime_id = result
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        stored_id = result
            .get("stored_session_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string);
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

    let profile_id = hermes_http_json(
        &connection,
        reqwest::Method::GET,
        "/api/profiles/active",
        None,
        Duration::from_secs(10),
    )
    .await
    .ok()
    .and_then(|payload| {
        payload
            .get("active")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
    .unwrap_or_else(|| "default".to_string());
    bind_unscoped_hermes_gateway_profile(&state, &profile_id)?;
    workspace::mirror_prompt_started(
        &app,
        &profile_id,
        &stored_id,
        &runtime_id,
        &exchange_id,
        &prompt,
        &image_data_urls,
    );
    let mut mirror_guard = PromptMirrorGuard {
        app: app.clone(),
        profile: profile_id.clone(),
        stored_id: stored_id.clone(),
        finished: false,
    };

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
        if workspace::mirror_prompt_event(&app, &profile_id, &stored_id, event_type, payload) {
            mirror_guard.finish();
        }
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
        .map_err(|_| native_text::TRAY_MENU_STATE_UNAVAILABLE)?;
    if let Some(item) = slot.as_ref() {
        item.set_enabled(available)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn should_hide_session_shortcut(visible: bool, active: Option<&str>, requested: &str) -> bool {
    visible && active == Some(requested)
}

fn show_session_shortcut(app: &AppHandle, session_id: &str) {
    let active_session = app
        .state::<ActiveSessionShortcut>()
        .0
        .lock()
        .ok()
        .and_then(|active| active.clone());
    if let Some(window) = app.get_webview_window("main") {
        if should_hide_session_shortcut(
            window.is_visible().unwrap_or(false),
            active_session.as_deref(),
            session_id,
        ) {
            let _ = hide_window(app.clone());
            return;
        }
    }
    if let Ok(mut open) = app.state::<SettingsWindowState>().0.lock() {
        *open = false;
    }
    if let Ok(mut active) = app.state::<ActiveSessionShortcut>().0.lock() {
        *active = Some(session_id.to_string());
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_size(Size::Logical(tauri::LogicalSize::new(620.0, 360.0)));
        let _ = show_main_above_capture(&window);
        let _ = window.emit("open-session-shortcut", session_id);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ConfiguredShortcutAction {
    Prompt,
    Session(String),
}

fn configured_shortcut_action(
    configuration: &ActiveShortcutConfiguration,
    shortcut_id: u32,
) -> Option<ConfiguredShortcutAction> {
    if configuration.prompt.id() == shortcut_id {
        return Some(ConfiguredShortcutAction::Prompt);
    }
    configuration
        .session_by_shortcut
        .get(&shortcut_id)
        .cloned()
        .map(ConfiguredShortcutAction::Session)
}

fn parse_modified_shortcut(value: &str, label: &str) -> Result<Shortcut, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    let shortcut = value
        .parse::<Shortcut>()
        .map_err(|error| format!("Invalid shortcut {value}: {error}"))?;
    if shortcut.mods.is_empty() {
        return Err(format!("{label} must include Ctrl, Alt, Shift, or Super"));
    }
    Ok(shortcut)
}

fn prompt_shortcut_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(PROMPT_SHORTCUT_CONFIG_FILE))
        .map_err(|error| format!("Could not locate app configuration: {error}"))
}

fn load_persisted_prompt_shortcut(app: &AppHandle) -> Result<Option<String>, String> {
    let path = prompt_shortcut_config_path(app)?;
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read prompt shortcut: {error}")),
    };
    let persisted = serde_json::from_str::<PersistedPromptShortcut>(&contents)
        .map_err(|error| format!("Could not parse prompt shortcut: {error}"))?;
    if persisted.version != 1 {
        return Err(format!(
            "Unsupported prompt shortcut settings version {}",
            persisted.version
        ));
    }
    parse_modified_shortcut(&persisted.shortcut, "Prompt shortcut")?;
    Ok(Some(persisted.shortcut.trim().to_string()))
}

fn save_persisted_prompt_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    let path = prompt_shortcut_config_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create app configuration: {error}"))?;
    }
    let encoded = serde_json::to_vec(&PersistedPromptShortcut {
        version: 1,
        shortcut: shortcut.to_string(),
    })
    .map_err(|error| format!("Could not encode prompt shortcut: {error}"))?;
    fs::write(path, encoded).map_err(|error| format!("Could not save prompt shortcut: {error}"))
}

fn validate_shortcut_configuration(
    prompt_shortcut: &str,
    shortcuts: &[SessionShortcutConfig],
) -> Result<ActiveShortcutConfiguration, String> {
    let prompt_shortcut = prompt_shortcut.trim();
    let prompt = parse_modified_shortcut(prompt_shortcut, "Prompt shortcut")?;
    let mut registered = HashMap::from([(prompt.id(), prompt)]);
    let mut session_by_shortcut = HashMap::new();
    let mut normalized_shortcuts = Vec::with_capacity(shortcuts.len());
    for binding in shortcuts {
        let shortcut_text = binding.shortcut.trim();
        let session_id = binding.session_id.trim();
        if shortcut_text.is_empty() || session_id.is_empty() {
            return Err(
                "Every session shortcut needs both a key combination and a session".to_string(),
            );
        }
        let shortcut = parse_modified_shortcut(shortcut_text, "Session shortcut")?;
        if shortcut.id() == prompt.id() {
            return Err(format!(
                "{shortcut_text} is already assigned to Open Ask Hermes"
            ));
        }
        if registered.insert(shortcut.id(), shortcut).is_some() {
            return Err(format!(
                "Shortcut {shortcut_text} is assigned more than once"
            ));
        }
        session_by_shortcut.insert(shortcut.id(), session_id.to_string());
        normalized_shortcuts.push(SessionShortcutConfig {
            shortcut: shortcut_text.to_string(),
            session_id: session_id.to_string(),
        });
    }
    Ok(ActiveShortcutConfiguration {
        prompt_shortcut: prompt_shortcut.to_string(),
        prompt,
        session_shortcuts: normalized_shortcuts,
        session_by_shortcut,
        registered,
    })
}

fn shortcut_registration_delta(
    active: &ActiveShortcutConfiguration,
    next: &ActiveShortcutConfiguration,
) -> (Vec<Shortcut>, Vec<Shortcut>) {
    let additions = next
        .registered
        .iter()
        .filter(|(id, _)| !active.registered.contains_key(id))
        .map(|(_, shortcut)| *shortcut)
        .collect();
    let removals = active
        .registered
        .iter()
        .filter(|(id, _)| !next.registered.contains_key(id))
        .map(|(_, shortcut)| *shortcut)
        .collect();
    (additions, removals)
}

fn replace_registered_shortcuts_with(
    active: &mut ActiveShortcutConfiguration,
    next: ActiveShortcutConfiguration,
    mut register: impl FnMut(Shortcut) -> Result<(), String>,
    mut unregister: impl FnMut(Shortcut) -> Result<(), String>,
) -> Result<(), String> {
    let (additions, removals) = shortcut_registration_delta(active, &next);
    let mut registered_additions = Vec::new();
    for shortcut in additions {
        if let Err(error) = register(shortcut) {
            for registered in registered_additions {
                let _ = unregister(registered);
            }
            return Err(format!("Could not register shortcut {shortcut}: {error}"));
        }
        registered_additions.push(shortcut);
    }

    let mut next = next;
    for shortcut in removals {
        if unregister(shortcut).is_err() {
            // Windows can report that a previously registered hotkey is already
            // gone. Keep its plugin registration tracked but route no action to
            // it; later saves retry cleanup and process exit releases it.
            next.registered.insert(shortcut.id(), shortcut);
        }
    }

    *active = next;
    Ok(())
}

fn replace_registered_shortcuts(
    app: &AppHandle,
    active: &mut ActiveShortcutConfiguration,
    next: ActiveShortcutConfiguration,
) -> Result<(), String> {
    replace_registered_shortcuts_with(
        active,
        next,
        |shortcut| {
            app.global_shortcut()
                .register(shortcut)
                .map_err(|error| error.to_string())
        },
        |shortcut| {
            app.global_shortcut()
                .unregister(shortcut)
                .map_err(|error| error.to_string())
        },
    )
}

fn update_session_shortcut_tray(
    app: &AppHandle,
    shortcuts: &[SessionShortcutConfig],
    titles: &HashMap<String, String>,
) -> Result<(), String> {
    let tray_state = app.state::<SessionShortcutTrayState>();
    let mut tray = tray_state
        .0
        .lock()
        .map_err(|_| native_text::SESSION_TRAY_STATE_UNAVAILABLE)?;
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
                app,
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
                let tray_link_count = app
                    .state::<TrayLinkMenuState>()
                    .0
                    .lock()
                    .map_err(|_| native_text::TRAY_LINK_STATE_UNAVAILABLE)?
                    .mode
                    .visible_links();
                menu.insert(&submenu, 2 + tray_link_count)
                    .map_err(|error| error.to_string())?;
                tray.attached = true;
            }
        }
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn set_shortcuts(
    app: AppHandle,
    prompt_shortcut: String,
    shortcuts: Vec<SessionShortcutConfig>,
    state: tauri::State<'_, ShortcutConfigurationState>,
    updates: tauri::State<'_, ShortcutUpdateState>,
    backend: tauri::State<'_, HermesBackend>,
) -> Result<(), String> {
    let next = validate_shortcut_configuration(&prompt_shortcut, &shortcuts)?;
    let _update = updates.0.lock().await;
    let previous = state
        .0
        .lock()
        .map_err(|_| "Shortcut configuration state is unavailable")?
        .clone();
    let mut applied = previous.clone();
    let applied_prompt = next.prompt_shortcut.clone();
    let applied_sessions = next.session_shortcuts.clone();
    replace_registered_shortcuts(&app, &mut applied, next)?;
    if let Err(error) = save_persisted_prompt_shortcut(&app, &applied_prompt) {
        let shortcut_rollback =
            replace_registered_shortcuts(&app, &mut applied, previous.clone()).err();
        let persistence_rollback =
            save_persisted_prompt_shortcut(&app, &previous.prompt_shortcut).err();
        let rollback_errors = shortcut_rollback
            .into_iter()
            .chain(persistence_rollback)
            .collect::<Vec<_>>();
        let rollback = if rollback_errors.is_empty() {
            String::new()
        } else {
            format!(" Rollback errors: {}", rollback_errors.join("; "))
        };
        return Err(format!("{error}.{rollback}"));
    }
    {
        let mut active = state
            .0
            .lock()
            .map_err(|_| "Shortcut configuration state is unavailable")?;
        *active = applied;
    }
    if let Some(tray) = app.tray_by_id(TRAY_ICON_ID) {
        let _ = tray.set_tooltip(Some(format!("Ask Hermes — {applied_prompt}")));
    }
    let titles = if applied_sessions.is_empty() {
        HashMap::new()
    } else {
        query_sessions_gateway(&backend, 1000)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|session| (session.id, session.title))
            .collect::<HashMap<_, _>>()
    };
    let _ = update_session_shortcut_tray(&app, &applied_sessions, &titles);
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
fn set_prompt_expanded(
    window: WebviewWindow,
    expanded: bool,
    settings: bool,
    state: tauri::State<'_, PromptWindowLayout>,
) -> Result<(), String> {
    let mut layout = state
        .0
        .lock()
        .map_err(|_| "Window layout state is unavailable")?;
    if settings {
        let entering_settings = !layout.settings;
        window
            .set_min_size(None::<Size>)
            .map_err(|error| error.to_string())?;
        window
            .set_size(Size::Logical(tauri::LogicalSize::new(760.0, 560.0)))
            .map_err(|error| error.to_string())?;
        window
            .set_min_size(Some(Size::Logical(tauri::LogicalSize::new(620.0, 460.0))))
            .map_err(|error| error.to_string())?;
        window
            .set_resizable(true)
            .map_err(|error| error.to_string())?;
        if entering_settings {
            window.center().map_err(|error| error.to_string())?;
        }
        layout.expanded = true;
        layout.settings = true;
        return apply_main_shape(&window);
    }

    let leaving_settings = layout.settings;
    layout.settings = false;
    if layout.expanded == expanded && !leaving_settings {
        window
            .set_resizable(expanded)
            .map_err(|error| error.to_string())?;
        return apply_main_shape(&window);
    }

    if expanded {
        window
            .set_min_size(None::<Size>)
            .map_err(|error| error.to_string())?;
        window
            .set_size(Size::Logical(tauri::LogicalSize::new(
                layout.expanded_width,
                layout.expanded_height,
            )))
            .map_err(|error| error.to_string())?;
        window
            .set_min_size(Some(Size::Logical(tauri::LogicalSize::new(420.0, 260.0))))
            .map_err(|error| error.to_string())?;
        window
            .set_resizable(true)
            .map_err(|error| error.to_string())?;
    } else {
        if !leaving_settings {
            if let (Ok(size), Ok(scale)) = (window.outer_size(), window.scale_factor()) {
                let logical = size.to_logical::<f64>(scale);
                layout.expanded_width = logical.width.max(420.0);
                layout.expanded_height = logical.height.max(260.0);
            }
        }
        window
            .set_min_size(None::<Size>)
            .map_err(|error| error.to_string())?;
        window
            .set_resizable(false)
            .map_err(|error| error.to_string())?;
        window
            .set_size(Size::Logical(tauri::LogicalSize::new(620.0, 76.0)))
            .map_err(|error| error.to_string())?;
    }
    layout.expanded = expanded;
    apply_main_shape(&window)
}

#[tauri::command]
fn hide_window(app: AppHandle) -> Result<(), String> {
    *app.state::<SettingsWindowState>()
        .0
        .lock()
        .map_err(|_| "Settings state is unavailable")? = false;
    *app.state::<ActiveSessionShortcut>()
        .0
        .lock()
        .map_err(|_| "Session shortcut state is unavailable")? = None;
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
    if let Ok(mut active) = app.state::<ActiveSessionShortcut>().0.lock() {
        *active = None;
    }
    if let Ok(mut open) = app.state::<SettingsWindowState>().0.lock() {
        *open = true;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = show_main_above_capture(&window);
        let _ = window.emit("open-settings", ());
    }
}

impl TrayLinkMode {
    fn includes_workspace(self) -> bool {
        matches!(self, Self::Workspace | Self::Both)
    }

    fn includes_desktop(self) -> bool {
        matches!(self, Self::Desktop | Self::Both)
    }

    fn visible_links(self) -> usize {
        self.includes_workspace() as usize + self.includes_desktop() as usize
    }
}

#[tauri::command]
fn set_tray_link_mode(
    mode: TrayLinkMode,
    state: tauri::State<'_, TrayLinkMenuState>,
) -> Result<(), String> {
    let mut tray = state
        .0
        .lock()
        .map_err(|_| native_text::TRAY_LINK_STATE_UNAVAILABLE)?;
    if tray.mode == mode {
        return Ok(());
    }
    if mode.includes_desktop() && tray.desktop.is_none() {
        return Err(native_text::DESKTOP_EXECUTABLE_NOT_FOUND.to_string());
    }

    let menu = tray
        .menu
        .clone()
        .ok_or_else(|| native_text::TRAY_MENU_UNAVAILABLE.to_string())?;
    let workspace = tray
        .workspace
        .clone()
        .ok_or_else(|| native_text::WORKSPACE_TRAY_ITEM_UNAVAILABLE.to_string())?;
    let desktop = tray.desktop.clone();

    if tray.mode.includes_workspace() {
        menu.remove(&workspace).map_err(|error| error.to_string())?;
    }
    if tray.mode.includes_desktop() {
        if let Some(desktop) = desktop.as_ref() {
            menu.remove(desktop).map_err(|error| error.to_string())?;
        }
    }

    let mut position = 1;
    if mode.includes_workspace() {
        menu.insert(&workspace, position)
            .map_err(|error| error.to_string())?;
        position += 1;
    }
    if mode.includes_desktop() {
        menu.insert(
            desktop
                .as_ref()
                .ok_or_else(|| native_text::DESKTOP_TRAY_ITEM_UNAVAILABLE.to_string())?,
            position,
        )
        .map_err(|error| error.to_string())?;
    }
    tray.mode = mode;
    Ok(())
}

fn workspace_geometry_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("workspace-window.json"))
        .map_err(|error| format!("Could not locate app configuration: {error}"))
}

fn load_workspace_geometry(app: &AppHandle) -> Result<Option<WorkspaceGeometry>, String> {
    let path = workspace_geometry_path(app)?;
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(native_text::with_error(
                native_text::READ_WORKSPACE_GEOMETRY,
                error,
            ))
        }
    };
    serde_json::from_str(&contents)
        .map(Some)
        .map_err(|error| native_text::with_error(native_text::PARSE_WORKSPACE_GEOMETRY, error))
}

fn workspace_geometry_is_visible(window: &WebviewWindow, geometry: &WorkspaceGeometry) -> bool {
    let left = geometry.x as i64;
    let top = geometry.y as i64;
    let right = left + geometry.width as i64;
    let bottom = top + geometry.height as i64;
    window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .any(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let monitor_left = position.x as i64;
            let monitor_top = position.y as i64;
            let monitor_right = monitor_left + size.width as i64;
            let monitor_bottom = monitor_top + size.height as i64;
            left < monitor_right
                && right > monitor_left
                && top < monitor_bottom
                && bottom > monitor_top
        })
}

fn apply_workspace_geometry(
    window: &WebviewWindow,
    geometry: &WorkspaceGeometry,
) -> Result<(), String> {
    window
        .set_size(Size::Physical(PhysicalSize::new(
            geometry.width.max(820),
            geometry.height.max(560),
        )))
        .map_err(|error| error.to_string())?;
    if workspace_geometry_is_visible(window, geometry) {
        window
            .set_position(Position::Physical(PhysicalPosition::new(
                geometry.x, geometry.y,
            )))
            .map_err(|error| error.to_string())?;
    } else {
        window.center().map_err(|error| error.to_string())?;
    }
    if geometry.maximized {
        window.maximize().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn record_workspace_geometry(window: &WebviewWindow) -> Result<(), String> {
    if window.is_minimized().unwrap_or(false) {
        return Ok(());
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let state = window.app_handle().state::<WorkspaceGeometryState>();
    let mut geometry = state
        .0
        .lock()
        .map_err(|_| native_text::WORKSPACE_GEOMETRY_STATE_UNAVAILABLE)?;
    if maximized {
        if let Some(geometry) = geometry.as_mut() {
            geometry.maximized = true;
        }
        return Ok(());
    }
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    *geometry = Some(WorkspaceGeometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: false,
    });
    Ok(())
}

fn persist_workspace_geometry(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("workspace") {
        record_workspace_geometry(&window)?;
    }
    let geometry = app
        .state::<WorkspaceGeometryState>()
        .0
        .lock()
        .map_err(|_| native_text::WORKSPACE_GEOMETRY_STATE_UNAVAILABLE)?
        .clone();
    let Some(geometry) = geometry else {
        return Ok(());
    };
    let path = workspace_geometry_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            native_text::with_error(native_text::CREATE_APP_CONFIGURATION, error)
        })?;
    }
    let contents = serde_json::to_vec(&geometry)
        .map_err(|error| native_text::with_error(native_text::ENCODE_WORKSPACE_GEOMETRY, error))?;
    fs::write(path, contents)
        .map_err(|error| native_text::with_error(native_text::SAVE_WORKSPACE_GEOMETRY, error))
}

fn scope_workspace_open_target(
    app: &AppHandle,
    mut target: WorkspaceOpenTarget,
) -> Result<WorkspaceOpenTarget, String> {
    let state = app.state::<HermesBackend>();
    let backend = state
        .0
        .lock()
        .map_err(|_| "Hermes gateway state is unavailable")?;
    let instance_id = hermes_instance_id(&backend.config);
    let instance_generation = backend.generation;
    if target.instance_id.is_empty() {
        target.instance_id = instance_id;
        target.instance_generation = instance_generation;
    } else if target.instance_id != instance_id || target.instance_generation != instance_generation
    {
        return Err("Workspace target belongs to a stale Hermes instance generation".to_string());
    }
    Ok(target)
}

fn show_workspace_window(app: &AppHandle, target: WorkspaceOpenTarget) -> Result<(), String> {
    let target = scope_workspace_open_target(app, target)?;
    let workspace = app
        .get_webview_window("workspace")
        .ok_or_else(|| native_text::WORKSPACE_WINDOW_UNAVAILABLE.to_string())?;
    if workspace.is_minimized().unwrap_or(false) {
        workspace.unminimize().map_err(|error| error.to_string())?;
    }
    workspace.show().map_err(|error| error.to_string())?;
    workspace.set_focus().map_err(|error| error.to_string())?;
    workspace
        .emit("workspace-visibility-changed", true)
        .map_err(|error| error.to_string())?;
    workspace
        .emit("open-workspace-target", target)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn hide_workspace_window(workspace: &WebviewWindow) -> Result<(), String> {
    persist_workspace_geometry(workspace.app_handle())?;
    workspace
        .emit("workspace-visibility-changed", false)
        .map_err(|error| error.to_string())?;
    workspace.hide().map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn open_workspace(
    window: WebviewWindow,
    instance_id: Option<String>,
    instance_generation: Option<u64>,
    handoff_id: Option<String>,
    profile_id: Option<String>,
    session_id: Option<String>,
    schedule_id: Option<String>,
    draft: Option<String>,
    captures: Option<Vec<WorkspaceHandoffCapture>>,
) -> Result<(), String> {
    let hide_prompt_immediately = handoff_id.is_none() && window.label() == "main";
    show_workspace_window(
        window.app_handle(),
        WorkspaceOpenTarget {
            instance_id: instance_id.unwrap_or_default(),
            instance_generation: instance_generation.unwrap_or_default(),
            handoff_id,
            profile_id,
            session_id,
            schedule_id,
            draft: draft.filter(|value| !value.is_empty()),
            captures: captures.filter(|value| !value.is_empty()),
        },
    )?;
    if hide_prompt_immediately {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_workspace(app: AppHandle) -> Result<(), String> {
    let workspace = app
        .get_webview_window("workspace")
        .ok_or_else(|| native_text::WORKSPACE_WINDOW_UNAVAILABLE.to_string())?;
    hide_workspace_window(&workspace)
}

#[tauri::command]
fn report_workspace_startup_smoke(
    window: WebviewWindow,
    report: WorkspaceStartupSmokeReport,
) -> Result<(), String> {
    let Some(ready_path) = env::var_os(WORKSPACE_STARTUP_SMOKE_READY_FILE_ENV) else {
        return Ok(());
    };
    if window.label() != "workspace" {
        return Err("Startup smoke report must come from the workspace window".to_string());
    }
    let native_url = window.url().map_err(|error| error.to_string())?.to_string();
    let payload = json!({
        "nativeDev": cfg!(dev),
        "label": window.label(),
        "nativeUrl": native_url,
        "documentUrl": report.document_url,
        "shellDisplay": report.shell_display,
        "shellWidth": report.shell_width,
        "shellHeight": report.shell_height,
        "wordmark": report.wordmark,
    });
    let encoded = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    fs::write(PathBuf::from(ready_path), encoded).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_workspace_has_active_work(
    source: String,
    active: bool,
    state: tauri::State<'_, WorkspaceActiveWork>,
) -> Result<(), String> {
    let source = match source.as_str() {
        "prompt" | "prompt-submit" | "workspace-ui" => source,
        _ => return Err(native_text::UNKNOWN_ACTIVITY_SOURCE.to_string()),
    };
    state.set(&source, active);
    Ok(())
}

#[tauri::command]
fn quit_app_confirmed(app: AppHandle) {
    let _ = persist_workspace_geometry(&app);
    app.exit(0);
}

fn emit_pending_workspace_quit(app: &AppHandle) -> Result<(), String> {
    let request = app.state::<WorkspaceQuitState>().pending()?;
    let Some(request) = request else {
        return Ok(());
    };
    let workspace = app
        .get_webview_window("workspace")
        .ok_or_else(|| native_text::WORKSPACE_WINDOW_UNAVAILABLE.to_string())?;
    workspace
        .emit("workspace-quit-requested", request)
        .map_err(|error| error.to_string())
}

fn request_workspace_quit(app: &AppHandle, confirmation_required: bool) -> Result<(), String> {
    app.state::<WorkspaceQuitState>()
        .queue(confirmation_required)?;
    if confirmation_required {
        show_workspace_window(app, WorkspaceOpenTarget::default())?;
    }
    // Keep request pending until renderer either confirms process exit or
    // explicitly cancels. If this event races a renderer reload, the next
    // listener-ready command replays it.
    emit_pending_workspace_quit(app)
}

#[tauri::command]
fn workspace_quit_listener_ready(app: AppHandle) -> Result<(), String> {
    emit_pending_workspace_quit(&app)
}

#[tauri::command]
fn workspace_quit_cancelled(state: tauri::State<'_, WorkspaceQuitState>) -> Result<(), String> {
    state.cancel()
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
        .map_err(|error| native_text::with_error(native_text::OPEN_HERMES_DESKTOP_ERROR, error))?;
    Ok(())
}

fn allowed_external_url(url: &str) -> bool {
    let normalized = url.trim();
    normalized.len() <= 8192
        && !normalized.chars().any(char::is_control)
        && (normalized.starts_with("https://")
            || normalized.starts_with("http://")
            || normalized.starts_with("mailto:"))
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let url = url.trim();
    if !allowed_external_url(url) {
        return Err("Only http, https, and mailto links can be opened".to_string());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(url)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|error| format!("Could not open the link: {error}"))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("Could not open the link: {error}"))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("Could not open the link: {error}"))?;
        Ok(())
    }
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
            if let Ok(mut active) = app.state::<ActiveSessionShortcut>().0.lock() {
                *active = None;
            }
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
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, pressed, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let settings_open = app
                        .state::<SettingsWindowState>()
                        .0
                        .lock()
                        .map(|open| *open)
                        .unwrap_or(false);
                    if settings_open {
                        return;
                    }
                    let action = app
                        .state::<ShortcutConfigurationState>()
                        .0
                        .lock()
                        .ok()
                        .and_then(|configuration| {
                            configured_shortcut_action(&configuration, pressed.id())
                        });
                    match action {
                        Some(ConfiguredShortcutAction::Prompt) => show_prompt(app),
                        Some(ConfiguredShortcutAction::Session(session_id)) => {
                            show_session_shortcut(app, &session_id)
                        }
                        None => {}
                    }
                })
                .build(),
        )
        .manage(PendingCapture::default())
        .manage(HermesBackend::default())
        .manage(SpeachesBackend::default())
        .manage(PreviousChatMenu::default())
        .manage(ShortcutConfigurationState::default())
        .manage(ShortcutUpdateState::default())
        .manage(SessionShortcutTrayState::default())
        .manage(TrayLinkMenuState::default())
        .manage(WorkspaceGeometryState::default())
        .manage(WorkspaceActiveWork::default())
        .manage(WorkspaceQuitState::default())
        .manage(workspace::WorkspaceBackend::default())
        .manage(SettingsWindowState::default())
        .manage(ActiveSessionShortcut::default())
        .manage(PromptWindowLayout::default())
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                if window.label() == "main" {
                    if let Ok(mut active) = window
                        .app_handle()
                        .state::<ActiveSessionShortcut>()
                        .0
                        .lock()
                    {
                        *active = None;
                    }
                    if let Ok(mut open) =
                        window.app_handle().state::<SettingsWindowState>().0.lock()
                    {
                        *open = false;
                    }
                    let _ = window.emit("clear-prompt", ());
                    let _ = window.hide();
                } else if window.label() == "workspace" {
                    if let Some(workspace) = window.app_handle().get_webview_window("workspace") {
                        let _ = hide_workspace_window(&workspace);
                    }
                } else {
                    let _ = window.hide();
                }
            }
            tauri::WindowEvent::Resized(_) if window.label() == "main" => {
                if let Some(main) = window.app_handle().get_webview_window("main") {
                    let _ = apply_main_shape(&main);
                }
            }
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_)
                if window.label() == "workspace" =>
            {
                if let Some(workspace) = window.app_handle().get_webview_window("workspace") {
                    let _ = record_workspace_geometry(&workspace);
                }
            }
            _ => {}
        })
        .setup(move |app| {
            #[cfg(windows)]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))?;

            let persisted_prompt_shortcut = load_persisted_prompt_shortcut(app.handle())
                .ok()
                .flatten()
                .unwrap_or_else(|| DEFAULT_PROMPT_SHORTCUT.to_string());
            let mut initial_shortcuts =
                validate_shortcut_configuration(&persisted_prompt_shortcut, &[])
                    .unwrap_or_else(|_| ActiveShortcutConfiguration::default());
            let initial_prompt_shortcut = initial_shortcuts.prompt_shortcut.clone();
            let initial_prompt = initial_shortcuts.prompt;
            initial_shortcuts.registered.clear();
            *app.state::<ShortcutConfigurationState>()
                .0
                .lock()
                .expect("shortcut configuration state") = initial_shortcuts;
            if app.global_shortcut().register(initial_prompt).is_ok() {
                app.state::<ShortcutConfigurationState>()
                    .0
                    .lock()
                    .expect("shortcut configuration state")
                    .registered
                    .insert(initial_prompt.id(), initial_prompt);
            }

            let show = MenuItem::with_id(
                app,
                "show",
                native_text::OPEN_ASK_HERMES,
                true,
                None::<&str>,
            )?;
            let open_workspace_item = MenuItem::with_id(
                app,
                "open-workspace",
                native_text::OPEN_WORKSPACE,
                true,
                None::<&str>,
            )?;
            let previous = MenuItem::with_id(
                app,
                "previous",
                native_text::OPEN_PREVIOUS_CHAT,
                false,
                None::<&str>,
            )?;
            let settings =
                MenuItem::with_id(app, "settings", native_text::SETTINGS, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", native_text::QUIT, true, None::<&str>)?;
            let open_desktop = if desktop_binary().is_ok() {
                Some(MenuItem::with_id(
                    app,
                    "open-desktop",
                    native_text::OPEN_HERMES_DESKTOP,
                    true,
                    None::<&str>,
                )?)
            } else {
                None
            };
            let session_shortcuts = Submenu::new(app, native_text::SESSIONS, true)?;
            *app.state::<PreviousChatMenu>()
                .0
                .lock()
                .expect("tray menu state") = Some(previous.clone());
            let menu = Menu::with_items(
                app,
                &[&show, &open_workspace_item, &previous, &settings, &quit],
            )?;
            {
                let tray_state = app.state::<SessionShortcutTrayState>();
                let mut tray = tray_state.0.lock().expect("session tray state");
                tray.menu = Some(menu.clone());
                tray.submenu = Some(session_shortcuts.clone());
            }
            {
                let tray_link_state = app.state::<TrayLinkMenuState>();
                let mut tray = tray_link_state.0.lock().expect("tray link state");
                tray.menu = Some(menu.clone());
                tray.workspace = Some(open_workspace_item.clone());
                tray.desktop = open_desktop.clone();
                tray.mode = TrayLinkMode::Workspace;
            }

            if let Some(workspace) = app.get_webview_window("workspace") {
                if let Ok(Some(geometry)) = load_workspace_geometry(app.handle()) {
                    *app.state::<WorkspaceGeometryState>()
                        .0
                        .lock()
                        .expect("workspace geometry state") = Some(geometry.clone());
                    let _ = apply_workspace_geometry(&workspace, &geometry);
                } else {
                    let _ = record_workspace_geometry(&workspace);
                }
            }
            TrayIconBuilder::with_id(TRAY_ICON_ID)
                .icon(tray_icon())
                .tooltip(format!("Ask Hermes — {initial_prompt_shortcut}"))
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::DoubleClick {
                            button: MouseButton::Left,
                            ..
                        }
                    ) {
                        let _ = show_workspace_window(
                            tray.app_handle(),
                            WorkspaceOpenTarget::default(),
                        );
                    }
                })
                .on_menu_event(|app, event| {
                    let item_id = event.id().as_ref();
                    match item_id {
                        "show" => show_prompt(app),
                        "open-workspace" => {
                            let _ = show_workspace_window(app, WorkspaceOpenTarget::default());
                        }
                        "previous" => {
                            if let Ok(mut active) = app.state::<ActiveSessionShortcut>().0.lock() {
                                *active = None;
                            }
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
                        "quit" => {
                            let app = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let has_active_work =
                                    workspace::refresh_authoritative_active_work(&app)
                                        .await
                                        .unwrap_or(true);
                                // Workspace renderer owns the persistence flush
                                // and is the sole bridge to quit_app_confirmed.
                                let _ = request_workspace_quit(&app, has_active_work);
                            });
                        }
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
            if env::var_os(WORKSPACE_STARTUP_SMOKE_READY_FILE_ENV).is_some() {
                let _ = show_workspace_window(app.handle(), WorkspaceOpenTarget::default());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            hermes_desktop_available,
            get_session_history_page,
            get_hermes_instance_scope,
            configure_hermes_instance,
            set_shortcuts,
            get_voice_input_config,
            transcribe_voice_audio,
            get_speaches_status,
            ensure_speaches,
            ask_hermes_gateway,
            set_previous_chat_available,
            start_selection,
            show_prepared_selection,
            capture_region,
            cancel_selection,
            set_prompt_expanded,
            hide_window,
            open_workspace,
            hide_workspace,
            report_workspace_startup_smoke,
            set_tray_link_mode,
            set_workspace_has_active_work,
            quit_app_confirmed,
            workspace_quit_listener_ready,
            workspace_quit_cancelled,
            open_hermes_desktop,
            open_external_url,
            workspace::workspace_bootstrap,
            workspace::workspace_refresh,
            workspace::workspace_reconnect,
            workspace::workspace_profile_options,
            workspace::workspace_resolve_session_profile,
            workspace::workspace_session_summary,
            workspace::workspace_list_sessions,
            workspace::workspace_list_messages,
            workspace::workspace_search,
            workspace::workspace_resolve_search_hit,
            workspace::workspace_create_session,
            workspace::workspace_resolve_handoff_destination,
            workspace::workspace_set_session_yolo,
            workspace::workspace_session_action,
            workspace::workspace_branch_session,
            workspace::workspace_send_turn,
            workspace::workspace_steer_turn,
            workspace::workspace_execute_slash,
            workspace::workspace_stop_turn,
            workspace::workspace_retry_message,
            workspace::workspace_edit_message,
            workspace::workspace_undo,
            workspace::workspace_submit_interaction,
            workspace::workspace_upload_attachment,
            workspace::workspace_capture_screen,
            workspace::workspace_list_schedules,
            workspace::workspace_save_schedule,
            workspace::workspace_schedule_action,
            workspace::workspace_list_schedule_runs,
            workspace::workspace_get_client_state,
            workspace::workspace_sync_client_state,
            workspace::workspace_mutate_client_state,
            workspace::workspace_open_external,
            workspace::workspace_read_gateway_file,
            workspace::workspace_copy_error_details,
            workspace::workspace_transcribe_voice
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ask Hermes");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_kill_job_terminates_its_suspended_process() {
        use std::{os::windows::process::CommandExt, time::Instant};
        use windows::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

        let mut child = Command::new("cmd.exe")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0)
            .spawn()
            .expect("test process should start suspended");
        let job = assign_process_job_and_resume(&child).expect("test process should enter the job");
        assert!(child.try_wait().unwrap().is_none());
        drop(job);
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        panic!("closing the job did not terminate its process");
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "manual smoke test; automated tests use the mocked gateway"]
    fn starts_and_reaches_the_hermes_gateway() {
        use std::net::TcpStream;

        if hermes_binary().is_err() {
            return;
        }
        let backend =
            start_hermes_backend().expect("Hermes gateway should announce its connection");
        let url = reqwest::Url::parse(&backend.connection.http_url).unwrap();
        let address = format!(
            "{}:{}",
            url.host_str().expect("gateway URL should contain a host"),
            url.port().expect("gateway URL should contain a port")
        );
        TcpStream::connect_timeout(&address.parse().unwrap(), Duration::from_secs(2))
            .expect("announced Hermes gateway should accept connections");
        drop(backend);
    }

    #[test]
    fn accepts_shortcut_strings_recorded_by_the_settings_ui() {
        assert!("Ctrl+Alt+H".parse::<Shortcut>().is_ok());
        assert!("Ctrl+Shift+D".parse::<Shortcut>().is_ok());
        assert!("Shift+F8".parse::<Shortcut>().is_ok());
    }

    #[test]
    fn configurable_prompt_shortcut_reserves_only_its_current_binding() {
        let conflict = validate_shortcut_configuration(
            "Ctrl+Alt+H",
            &[SessionShortcutConfig {
                shortcut: "Ctrl+Alt+H".to_string(),
                session_id: "chat-a".to_string(),
            }],
        )
        .unwrap_err();
        assert!(conflict.contains("Open Ask Hermes"));

        let moved = validate_shortcut_configuration(
            "Ctrl+Alt+H",
            &[SessionShortcutConfig {
                shortcut: DEFAULT_PROMPT_SHORTCUT.to_string(),
                session_id: "chat-a".to_string(),
            }],
        )
        .unwrap();
        let old_default = DEFAULT_PROMPT_SHORTCUT.parse::<Shortcut>().unwrap();
        assert_eq!(
            configured_shortcut_action(&moved, old_default.id()),
            Some(ConfiguredShortcutAction::Session("chat-a".to_string()))
        );
        assert!(validate_shortcut_configuration("H", &[]).is_err());
    }

    #[test]
    fn prompt_and_session_shortcuts_can_swap_without_os_registration_churn() {
        let active = validate_shortcut_configuration(
            DEFAULT_PROMPT_SHORTCUT,
            &[SessionShortcutConfig {
                shortcut: "Ctrl+Alt+H".to_string(),
                session_id: "chat-a".to_string(),
            }],
        )
        .unwrap();
        let next = validate_shortcut_configuration(
            "Ctrl+Alt+H",
            &[SessionShortcutConfig {
                shortcut: DEFAULT_PROMPT_SHORTCUT.to_string(),
                session_id: "chat-a".to_string(),
            }],
        )
        .unwrap();
        let (additions, removals) = shortcut_registration_delta(&active, &next);
        assert!(additions.is_empty());
        assert!(removals.is_empty());
        assert_eq!(
            configured_shortcut_action(&next, next.prompt.id()),
            Some(ConfiguredShortcutAction::Prompt)
        );
    }

    #[test]
    fn failed_prompt_registration_keeps_the_previous_configuration_active() {
        let mut active = validate_shortcut_configuration(DEFAULT_PROMPT_SHORTCUT, &[]).unwrap();
        let previous_id = active.prompt.id();
        let next = validate_shortcut_configuration("Ctrl+Alt+H", &[]).unwrap();
        let register_attempts = std::cell::RefCell::new(Vec::new());
        let unregister_attempts = std::cell::RefCell::new(Vec::new());

        let error = replace_registered_shortcuts_with(
            &mut active,
            next,
            |shortcut| {
                register_attempts.borrow_mut().push(shortcut.id());
                Err("already registered by another application".to_string())
            },
            |shortcut| {
                unregister_attempts.borrow_mut().push(shortcut.id());
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.contains("already registered"));
        assert_eq!(active.prompt.id(), previous_id);
        assert_eq!(register_attempts.borrow().len(), 1);
        assert!(unregister_attempts.borrow().is_empty());
    }

    #[test]
    fn failed_old_shortcut_cleanup_does_not_reject_the_new_binding() {
        let mut active = validate_shortcut_configuration(DEFAULT_PROMPT_SHORTCUT, &[]).unwrap();
        let old_id = active.prompt.id();
        let next = validate_shortcut_configuration("Ctrl+Alt+H", &[]).unwrap();
        let new_id = next.prompt.id();

        replace_registered_shortcuts_with(
            &mut active,
            next,
            |_| Ok(()),
            |_| Err("Failed to unregister hotkey".to_string()),
        )
        .unwrap();

        assert_eq!(active.prompt.id(), new_id);
        assert!(active.registered.contains_key(&old_id));
        assert_eq!(
            configured_shortcut_action(&active, new_id),
            Some(ConfiguredShortcutAction::Prompt)
        );
        assert_eq!(configured_shortcut_action(&active, old_id), None);
    }

    #[test]
    fn accepts_existing_hermes_instance_addresses() {
        assert_eq!(
            validate_hermes_address(&HermesInstanceConfig {
                remote: true,
                address: "::1".to_string(),
                port: 9119,
                token: "secret".to_string(),
                ..HermesInstanceConfig::default()
            })
            .unwrap(),
            "::1"
        );
    }

    #[test]
    fn rejects_invalid_existing_hermes_instance_addresses() {
        let invalid_host = HermesInstanceConfig {
            remote: true,
            address: "http://hermes.lan".to_string(),
            port: 9119,
            token: "secret".to_string(),
            ..HermesInstanceConfig::default()
        };
        assert!(validate_hermes_address(&invalid_host)
            .unwrap_err()
            .contains("hostname"));
    }

    #[test]
    fn builds_authenticated_existing_hermes_connection() {
        let connection = remote_hermes_connection(&HermesInstanceConfig {
            remote: true,
            address: "127.0.0.1".to_string(),
            port: 9119,
            token: "a/b c".to_string(),
            ..HermesInstanceConfig::default()
        })
        .unwrap();
        assert_eq!(connection.http_url, "http://127.0.0.1:9119");
        assert_eq!(
            connection.ws_url,
            "ws://127.0.0.1:9119/api/ws?token=a%2Fb+c"
        );
    }

    #[test]
    fn builds_tokenless_existing_hermes_connection() {
        let connection = remote_hermes_connection(&HermesInstanceConfig {
            remote: true,
            address: "127.0.0.1".to_string(),
            port: 9119,
            token: String::new(),
            ..HermesInstanceConfig::default()
        })
        .unwrap();
        assert_eq!(connection.ws_url, "ws://127.0.0.1:9119/api/ws");
        assert!(connection.token.is_empty());
    }

    #[test]
    fn automatic_unscoped_gateway_reuses_reported_non_default_profile_key() {
        let mut state = HermesBackendState::default();
        assert_eq!(
            automatic_process_key(&state, None),
            AUTOMATIC_UNSCOPED_PROCESS
        );
        assert_eq!(automatic_process_key(&state, Some("work")), "work");

        state.unscoped_profile = Some("work".to_string());
        assert_eq!(automatic_process_key(&state, None), "work");
        assert_eq!(automatic_process_key(&state, Some("work")), "work");
        assert_eq!(automatic_process_key(&state, Some("personal")), "personal");
    }

    #[test]
    fn automatic_gateway_reads_non_default_profile_before_publication() {
        let response = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 17\r\n\r\n{\"active\":\"work\"}";
        assert_eq!(
            parse_local_gateway_active_profile(response).unwrap(),
            "work"
        );
    }

    #[test]
    fn voice_transcription_timeout_is_bounded() {
        assert_eq!(transcription_timeout(1), Duration::from_secs(180));
        assert_eq!(transcription_timeout(3_000_000), Duration::from_secs(300));
        assert_eq!(transcription_timeout(99_000_000), Duration::from_secs(600));
    }

    #[test]
    fn accepts_nested_frontend_turn_request() {
        let request: HermesTurnRequest = serde_json::from_value(json!({
            "instanceId": "automatic-hermes",
            "instanceGeneration": 4,
            "exchangeId": "exchange-1",
            "prompt": "hello",
            "imageDataUrls": ["data:image/png;base64,AA=="],
            "storedSessionId": null,
            "runtimeSessionId": "runtime-1",
            "model": "gpt-5.6-terra",
            "reasoningEffort": "low",
            "fast": true
        }))
        .unwrap();
        assert_eq!(request.exchange_id, "exchange-1");
        assert_eq!(request.instance_generation, 4);
        assert_eq!(request.image_data_urls.len(), 1);
        assert_eq!(request.fast, Some(true));
    }

    #[test]
    fn only_allows_safe_external_link_schemes() {
        assert!(allowed_external_url("https://example.com/path?q=1"));
        assert!(allowed_external_url("http://localhost:3000"));
        assert!(allowed_external_url("mailto:hello@example.com"));
        assert!(!allowed_external_url("javascript:alert(1)"));
        assert!(!allowed_external_url("file:///C:/Windows/System32"));
        assert!(!allowed_external_url("https://example.com\nmalicious"));
    }

    #[test]
    fn session_shortcuts_toggle_only_the_same_visible_session() {
        assert!(should_hide_session_shortcut(true, Some("chat-a"), "chat-a"));
        assert!(!should_hide_session_shortcut(
            true,
            Some("chat-a"),
            "chat-b"
        ));
        assert!(!should_hide_session_shortcut(
            false,
            Some("chat-a"),
            "chat-a"
        ));
        assert!(!should_hide_session_shortcut(true, None, "chat-a"));
    }

    #[test]
    fn accepts_tray_link_modes_from_settings() {
        assert_eq!(
            serde_json::from_str::<TrayLinkMode>("\"workspace\"").unwrap(),
            TrayLinkMode::Workspace
        );
        assert_eq!(
            serde_json::from_str::<TrayLinkMode>("\"desktop\"").unwrap(),
            TrayLinkMode::Desktop
        );
        let both = serde_json::from_str::<TrayLinkMode>("\"both\"").unwrap();
        assert_eq!(both.visible_links(), 2);
        assert!(both.includes_workspace());
        assert!(both.includes_desktop());
    }

    #[test]
    fn serializes_workspace_handoff_target_for_frontend() {
        let target = WorkspaceOpenTarget {
            instance_id: "automatic-hermes".to_string(),
            instance_generation: 7,
            handoff_id: Some("handoff-1".to_string()),
            profile_id: Some("default".to_string()),
            session_id: Some("session-1".to_string()),
            schedule_id: None,
            draft: None,
            captures: None,
        };
        assert_eq!(
            serde_json::to_value(target).unwrap(),
            json!({
                "instanceId": "automatic-hermes", "instanceGeneration": 7,
                "handoffId": "handoff-1", "profileId": "default", "sessionId": "session-1"
            })
        );
    }

    #[test]
    fn serializes_typed_workspace_quit_request_for_frontend() {
        assert_eq!(
            serde_json::to_value(WorkspaceQuitRequest {
                confirmation_required: true,
            })
            .unwrap(),
            json!({ "confirmationRequired": true })
        );
    }

    #[test]
    fn pending_quit_survives_lost_delivery_until_cancelled() {
        let state = WorkspaceQuitState::default();
        assert!(!state.queue(false).unwrap().confirmation_required);
        // A later authoritative check may discover active work; never weaken a
        // pending confirmation while waiting for a renderer listener.
        assert!(state.queue(true).unwrap().confirmation_required);
        assert!(state.pending().unwrap().unwrap().confirmation_required);
        state.cancel().unwrap();
        assert!(state.pending().unwrap().is_none());
    }
}

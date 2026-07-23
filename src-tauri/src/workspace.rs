//! Gateway-only backend for the Chats + Schedules workspace.
//!
//! This module deliberately never opens Hermes' session database. HTTP and
//! WebSocket gateway APIs are the only source of workspace data, which keeps
//! local and remote instances behaviorally identical.

use super::{
    capture_desktop, hermes_gateway_connection_for_profile, hermes_http_json, image_data_url,
    open_external_url, HermesBackend, HermesGatewayConnection, WorkspaceActiveWork,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{FutureExt, SinkExt, StreamExt};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex, RwLock, RwLockReadGuard};
use tokio_tungstenite::{connect_async, tungstenite::Message, WebSocketStream};

type GatewaySocket = WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type ScopeKey = (String, String);

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const GATEWAY_FILE_DATA_URL_MAX_CHARS: usize = 24 * 1024 * 1024;
const INITIAL_SESSION_LIMIT: usize = 80;
const REQUIRED_DESKTOP_CONTRACT: u64 = 4;
const SEARCH_METADATA_LIMIT: usize = 500;
const SEARCH_RESOLVE_PAGE_ROWS: usize = 500;

#[derive(Default)]
pub(crate) struct WorkspaceBackend {
    pub(crate) instance_operations: RwLock<()>,
    runtimes: Mutex<HashMap<ScopeKey, String>>,
    pending_sessions: Mutex<HashMap<ScopeKey, PendingSession>>,
    starting: Mutex<HashSet<ScopeKey>>,
    // A completed turn can still be applying its final title update and
    // publishing terminal events. Keep that work authoritative until every
    // old-instance side effect has finished.
    finalizing: Mutex<HashSet<ScopeKey>>,
    controls: Mutex<HashMap<ScopeKey, mpsc::UnboundedSender<ControlRequest>>>,
    server_active: Mutex<HashSet<ScopeKey>>,
    server_active_rows: Mutex<HashMap<ScopeKey, Value>>,
    // Sessions whose current turn was submitted by this Ask process. Keep this
    // separate from server_active: active_list also reports turns owned by a
    // CLI or Hermes Desktop, and session.resume would steal their transport.
    owned_active: Mutex<HashSet<ScopeKey>>,
    mirrored_active: Mutex<HashSet<ScopeKey>>,
    live_users: Mutex<HashMap<ScopeKey, Value>>,
    live_messages: Mutex<HashMap<ScopeKey, LiveMessage>>,
    interactions: Mutex<HashMap<(String, String, String), PendingInteraction>>,
    client_states: Mutex<HashMap<ScopeKey, SessionClientState>>,
    // Handoff orchestration lives in the persistent native backend rather than
    // either webview. A workspace renderer reload can therefore retry the same
    // handoff without creating a second destination session.
    handoff_destinations: AsyncMutex<HashMap<String, HandoffDestination>>,
    applied_handoffs: Mutex<HashMap<ScopeKey, HashSet<String>>>,
    removed_queue_entries: Mutex<HashMap<ScopeKey, HashSet<String>>>,
    validated_contracts: Mutex<HashSet<ScopeKey>>,
    pins: Mutex<HashSet<ScopeKey>>,
    last_errors: Mutex<HashMap<String, String>>,
}

impl WorkspaceBackend {
    pub(crate) async fn reset_for_instance_switch(&self) {
        if let Ok(mut values) = self.runtimes.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.pending_sessions.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.starting.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.finalizing.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.controls.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.server_active.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.server_active_rows.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.owned_active.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.mirrored_active.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.live_users.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.live_messages.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.interactions.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.client_states.lock() {
            values.clear();
        }
        self.handoff_destinations.lock().await.clear();
        if let Ok(mut values) = self.applied_handoffs.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.removed_queue_entries.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.validated_contracts.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.pins.lock() {
            values.clear();
        }
        if let Ok(mut values) = self.last_errors.lock() {
            values.clear();
        }
    }
}

#[derive(Clone)]
struct PendingSession {
    title: String,
    created_at: String,
    settings: TurnSettings,
    parent_session_id: Option<String>,
}

struct ControlRequest {
    method: String,
    params: Value,
    response: oneshot::Sender<Result<Value, String>>,
}

#[derive(Clone)]
enum PendingInteraction {
    Clarification {
        choices: HashMap<String, String>,
    },
    Approval,
    Sensitive {
        method: &'static str,
        value_key: &'static str,
    },
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TurnSettings {
    model: Option<String>,
    provider: Option<String>,
    reasoning_effort: Option<String>,
    fast: Option<bool>,
    personality: Option<String>,
    approval_mode: Option<String>,
    yolo: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AttachmentRef {
    id: String,
    name: String,
    mime_type: String,
    size: usize,
    state: String,
    url: Option<String>,
    preview_url: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct QueueEntry {
    id: String,
    text: String,
    created_at: String,
    #[serde(default)]
    attachments: Vec<AttachmentRef>,
    settings: Option<TurnSettings>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionClientState {
    #[serde(default)]
    draft: String,
    #[serde(default)]
    queue: Vec<QueueEntry>,
    #[serde(default)]
    attachments: Vec<AttachmentRef>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum ClientStateMutation {
    SetDraft {
        draft: String,
    },
    AppendDraft {
        text: String,
        separator: Option<String>,
    },
    RestoreDraft {
        draft: String,
    },
    AddQueue {
        entry: QueueEntry,
        #[serde(default)]
        front: bool,
    },
    UpdateQueue {
        entry_id: String,
        text: String,
    },
    MoveQueue {
        entry_id: String,
        direction: i8,
    },
    RemoveQueue {
        entry_id: String,
    },
    RestoreQueue {
        entry: QueueEntry,
    },
    AddAttachment {
        attachment: AttachmentRef,
    },
    ReplaceAttachment {
        attachment_id: String,
        attachment: AttachmentRef,
    },
    RemoveAttachment {
        attachment_id: String,
    },
    ConsumeComposer {
        entry: Option<QueueEntry>,
    },
    RestoreComposer {
        draft: String,
        attachments: Vec<AttachmentRef>,
        entry_id: Option<String>,
    },
    ApplyHandoff {
        handoff_id: String,
        draft: Option<String>,
        #[serde(default)]
        attachments: Vec<AttachmentRef>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErrorDetailsRequest {
    profile_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstanceScope {
    instance_id: String,
    instance_generation: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HandoffDestination {
    profile_id: String,
    session_id: String,
    created: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolveHandoffDestinationRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    handoff_id: String,
    profile_id: String,
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessagePageRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: String,
    before: Option<String>,
    around_message_id: Option<String>,
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionPageRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: Option<String>,
    cursor: Option<String>,
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolveSessionProfileRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateSessionRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    settings: Option<TurnSettings>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRefRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScopedSessionRefRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetSessionYoloRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: String,
    enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchSessionRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: String,
    message_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendTurnRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: String,
    entry: QueueEntry,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SteerTurnRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExecuteSlashRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: String,
    command: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageActionRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: String,
    message_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EditMessageRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: String,
    message_id: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UndoRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: String,
    message_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InteractionRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: String,
    interaction_id: String,
    option_id: Option<String>,
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadAttachmentRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: String,
    name: String,
    mime_type: String,
    data_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscribeVoiceRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    data_url: String,
    mime_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionActionRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: String,
    action: SessionAction,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum SessionAction {
    Rename { title: String },
    Pin { pinned: bool },
    Archive,
    Restore,
    Delete,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    query: String,
    profile_id: Option<String>,
    filters: SearchFilters,
    cursor: Option<String>,
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolveSearchHitRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    session_id: String,
    resolver: SearchHitResolver,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum SearchHitResolver {
    Message {
        query: String,
        excerpt: String,
        role: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchFilters {
    include_active: bool,
    include_archived: bool,
    source: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduleDraft {
    #[serde(flatten)]
    instance: InstanceScope,
    id: Option<String>,
    profile_id: String,
    name: String,
    prompt: String,
    cron: String,
    original_cron: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    preserved_fields: Option<Map<String, Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduleActionRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    schedule_id: String,
    action: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduleRunsRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    schedule_id: String,
    cursor: Option<String>,
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncClientStateRequest {
    instance_id: String,
    instance_generation: u64,
    profile_id: String,
    session_id: String,
    state: SessionClientState,
    base_state: Option<SessionClientState>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GetClientStateRequest {
    instance_id: String,
    instance_generation: u64,
    profile_id: String,
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MutateClientStateRequest {
    instance_id: String,
    instance_generation: u64,
    profile_id: String,
    session_id: String,
    mutation: ClientStateMutation,
    client_id: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OpenExternalRequest {
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadGatewayFileRequest {
    #[serde(flatten)]
    instance: InstanceScope,
    profile_id: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GatewayFileData {
    name: String,
    mime_type: String,
    data_url: String,
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn decode_gateway_file_url_path(path: &str) -> Result<String, String> {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .ok_or_else(|| "Gateway file URL is invalid".to_string())?;
            let value = std::str::from_utf8(hex)
                .ok()
                .and_then(|value| u8::from_str_radix(value, 16).ok())
                .ok_or_else(|| "Gateway file URL is invalid".to_string())?;
            decoded.push(value);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "Gateway file URL is invalid".to_string())
}

fn validated_gateway_file_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() || path.len() > 32_768 || path.chars().any(char::is_control) {
        return Err("Gateway file path is invalid".to_string());
    }
    let lower = path.to_ascii_lowercase();
    if lower.starts_with("http:")
        || lower.starts_with("https:")
        || lower.starts_with("data:")
        || lower.starts_with("mailto:")
        || lower.starts_with("javascript:")
    {
        return Err("Gateway file reads require a gateway-local path".to_string());
    }
    if lower.starts_with("file:") {
        let url =
            reqwest::Url::parse(path).map_err(|_| "Gateway file URL is invalid".to_string())?;
        if url
            .host_str()
            .is_some_and(|host| !host.eq_ignore_ascii_case("localhost"))
        {
            return Err("Gateway file URL must not contain a remote host".to_string());
        }
        let mut decoded = decode_gateway_file_url_path(url.path())?;
        if decoded.len() >= 3
            && decoded.starts_with('/')
            && decoded.as_bytes()[1].is_ascii_alphabetic()
            && decoded.as_bytes()[2] == b':'
        {
            decoded.remove(0);
        }
        if decoded.is_empty() || decoded.len() > 32_768 || decoded.chars().any(char::is_control) {
            return Err("Gateway file path is invalid".to_string());
        }
        return Ok(decoded);
    }
    if let Some(separator) = path.find(':') {
        let windows_drive =
            separator == 1 && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
        if !windows_drive {
            return Err("Gateway file reads require a gateway-local path".to_string());
        }
    }
    Ok(path.to_string())
}

fn gateway_file_data_from_response(
    path: &str,
    response: &Value,
) -> Result<GatewayFileData, String> {
    let data_url = response
        .as_str()
        .or_else(|| response.get("dataUrl").and_then(Value::as_str))
        .or_else(|| response.get("data_url").and_then(Value::as_str))
        .ok_or_else(|| "Hermes returned no gateway file data".to_string())?;
    if data_url.len() > GATEWAY_FILE_DATA_URL_MAX_CHARS {
        return Err("Gateway file exceeds the 16 MB preview limit".to_string());
    }
    let (metadata, encoded) = data_url
        .strip_prefix("data:")
        .and_then(|value| value.split_once(','))
        .ok_or_else(|| "Hermes returned invalid gateway file data".to_string())?;
    let media = metadata
        .strip_suffix(";base64")
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or_else(|| "Hermes returned invalid gateway file data".to_string())?;
    let mime_type = media.split(';').next().unwrap_or_default();
    if !mime_type.contains('/')
        || !mime_type.is_ascii()
        || encoded.len() % 4 != 0
        || !encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return Err("Hermes returned invalid gateway file data".to_string());
    }
    let padding = encoded
        .bytes()
        .rev()
        .take_while(|byte| *byte == b'=')
        .count();
    if padding > 2 || encoded[..encoded.len().saturating_sub(padding)].contains('=') {
        return Err("Hermes returned invalid gateway file data".to_string());
    }
    Ok(GatewayFileData {
        name: reference_name(path, "Artifact"),
        mime_type: mime_type.to_string(),
        data_url: data_url.to_string(),
    })
}

async fn read_gateway_file_data(
    connection: &HermesGatewayConnection,
    path: &str,
) -> Result<GatewayFileData, String> {
    let path = validated_gateway_file_path(path)?;
    let response = hermes_http_json(
        connection,
        Method::GET,
        &api_path("/api/fs/read-data-url", &[("path", Some(path.clone()))]),
        None,
        HTTP_TIMEOUT,
    )
    .await?;
    gateway_file_data_from_response(&path, &response)
}

fn api_path(path: &str, pairs: &[(&str, Option<String>)]) -> String {
    let mut result = path.to_string();
    let mut first = true;
    for (key, value) in pairs {
        let Some(value) = value.as_ref() else {
            continue;
        };
        result.push(if first { '?' } else { '&' });
        first = false;
        result.push_str(&percent_encode(key));
        result.push('=');
        result.push_str(&percent_encode(value));
    }
    result
}

fn profile_key(profile: &str) -> String {
    let value = profile.trim();
    if value.is_empty() {
        "default".to_string()
    } else {
        value.to_string()
    }
}

fn unix_or_iso(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return chrono::Utc::now().to_rfc3339();
    };
    if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
        return text.to_string();
    }
    let seconds = value.as_f64().unwrap_or_default();
    let whole = seconds.trunc() as i64;
    let nanos = ((seconds.fract().abs()) * 1_000_000_000.0) as u32;
    chrono::DateTime::<chrono::Utc>::from_timestamp(whole, nanos)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

fn value_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .map(str::to_string)
                    .or_else(|| part.get("text").and_then(Value::as_str).map(str::to_string))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::Null) | None => String::new(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn pretty_value(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    if let Some(text) = value.as_str() {
        if let Ok(parsed) = serde_json::from_str::<Value>(text) {
            return serde_json::to_string_pretty(&parsed).unwrap_or_else(|_| text.to_string());
        }
        return text.to_string();
    }
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn first_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .filter(|text| !text.trim().is_empty())
}

fn content_part_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.as_str().map(str::to_string).or_else(|| {
                    first_string(part, &["text", "output_text", "input_text"]).map(str::to_string)
                })
            })
            .collect::<Vec<_>>()
            .join("\n"),
        other => value_text(other),
    }
}

fn attachment_mime(name: &str, fallback: Option<&str>) -> String {
    if let Some(mime) = fallback.filter(|mime| !mime.trim().is_empty()) {
        return mime.to_string();
    }
    let lower = name.to_ascii_lowercase();
    for (extension, mime) in [
        (".png", "image/png"),
        (".jpg", "image/jpeg"),
        (".jpeg", "image/jpeg"),
        (".gif", "image/gif"),
        (".webp", "image/webp"),
        (".svg", "image/svg+xml"),
        (".pdf", "application/pdf"),
        (".json", "application/json"),
        (".md", "text/markdown"),
        (".txt", "text/plain"),
        (".csv", "text/csv"),
        (".mp3", "audio/mpeg"),
        (".wav", "audio/wav"),
        (".mp4", "video/mp4"),
    ] {
        if lower
            .split('?')
            .next()
            .unwrap_or(&lower)
            .ends_with(extension)
        {
            return mime.to_string();
        }
    }
    "application/octet-stream".to_string()
}

fn reference_name(value: &str, fallback: &str) -> String {
    if value.starts_with("data:") {
        return fallback.to_string();
    }
    let clean = value
        .split(['?', '#'])
        .next()
        .unwrap_or(value)
        .trim_end_matches(['/', '\\']);
    clean
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn hermes_references(text: &str) -> Vec<(&'static str, String)> {
    let markers = [
        ("@file:", "file"),
        ("@folder:", "folder"),
        ("@url:", "url"),
        ("@image:", "image"),
    ];
    let mut found = Vec::new();
    for (marker, kind) in markers {
        let mut rest = text;
        while let Some(index) = rest.find(marker) {
            let after = &rest[index + marker.len()..];
            let trimmed = after.trim_start();
            let skipped = after.len() - trimmed.len();
            let (value, consumed) = if let Some(quote) = trimmed
                .chars()
                .next()
                .filter(|quote| matches!(quote, '`' | '\'' | '"'))
            {
                let body = &trimmed[quote.len_utf8()..];
                if let Some(end) = body.find(quote) {
                    (&body[..end], quote.len_utf8() + end + quote.len_utf8())
                } else {
                    (body, trimmed.len())
                }
            } else {
                let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
                (&trimmed[..end], end)
            };
            let value = value
                .trim()
                .trim_end_matches(|character: char| matches!(character, ',' | ';' | ')' | ']'));
            if !value.is_empty() {
                found.push((kind, value.to_string()));
            }
            let advance = skipped + consumed;
            rest = &after[advance.min(after.len())..];
        }
    }
    found
}

fn attachment_from_part(part: &Value, message_id: &str, index: usize) -> Option<Value> {
    let kind = part.get("type").and_then(Value::as_str).unwrap_or_default();
    let image = matches!(kind, "image_url" | "input_image" | "image");
    let file = matches!(
        kind,
        "file" | "input_file" | "document" | "attachment" | "audio" | "video"
    );
    if !image && !file {
        return None;
    }
    let nested = if image {
        part.get("image_url")
            .or_else(|| part.get("image"))
            .unwrap_or(part)
    } else {
        part.get("file")
            .or_else(|| part.get("input_file"))
            .or_else(|| part.get("document"))
            .or_else(|| part.get("attachment"))
            .unwrap_or(part)
    };
    let url = first_string(nested, &["url", "file_url", "download_url", "path"])
        .or_else(|| {
            image
                .then(|| first_string(nested, &["data", "file_data"]))
                .flatten()
                .filter(|value| value.starts_with("data:image/"))
        })
        .or_else(|| nested.as_str())
        .map(str::to_string);
    let fallback_name = if image { "Image" } else { "File" };
    let name = first_string(nested, &["name", "filename", "file_name"])
        .map(str::to_string)
        .or_else(|| url.as_deref().map(|url| reference_name(url, fallback_name)))
        .unwrap_or_else(|| format!("{fallback_name} {}", index + 1));
    let mime = attachment_mime(
        &name,
        first_string(
            nested,
            &["mime_type", "mimeType", "media_type", "content_type"],
        )
        .or_else(|| if image { Some("image/*") } else { None }),
    );
    let size = nested
        .get("size")
        .or_else(|| nested.get("bytes"))
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let preview = url.as_deref().filter(|url| {
        mime.starts_with("image/")
            && (url.starts_with("data:image/")
                || url.starts_with("http://")
                || url.starts_with("https://"))
    });
    json!({
        "id": format!("{message_id}-attachment-{index}"),
        "name": name,
        "mimeType": mime,
        "size": size,
        "state": "ready",
        "url": url,
        "previewUrl": preview,
    })
    .into()
}

fn content_attachments(row: &Value, message_id: &str) -> Vec<Value> {
    let mut attachments = row
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, part)| attachment_from_part(part, message_id, index))
        .collect::<Vec<_>>();
    if let Some(text) = row
        .get("content")
        .or_else(|| row.get("text"))
        .and_then(Value::as_str)
    {
        for (index, line) in text.lines().enumerate() {
            let url = line.trim();
            if !url.starts_with("data:image/") {
                continue;
            }
            attachments.push(json!({
                "id": format!("{message_id}-embedded-{index}"),
                "name": format!("Image {}", attachments.len() + 1),
                "mimeType": url.strip_prefix("data:").and_then(|value| value.split(';').next()).unwrap_or("image/*"),
                "size": 0,
                "state": "ready",
                "url": url,
                "previewUrl": url,
            }));
        }
    }
    if row.get("role").and_then(Value::as_str) == Some("user") {
        let text = content_part_text(row.get("content").or_else(|| row.get("text")));
        for (index, (kind, value)) in hermes_references(&text).into_iter().enumerate() {
            let name = reference_name(&value, if kind == "folder" { "Folder" } else { "File" });
            let mime = if kind == "folder" {
                "inode/directory".to_string()
            } else if kind == "url" {
                "text/uri-list".to_string()
            } else {
                attachment_mime(&name, (kind == "image").then_some("image/*"))
            };
            let url = matches!(kind, "url" | "image")
                .then(|| value.clone())
                .filter(|url| {
                    url.starts_with("http://")
                        || url.starts_with("https://")
                        || url.starts_with("data:image/")
                });
            if attachments.iter().any(|attachment| {
                attachment.get("url").and_then(Value::as_str) == url.as_deref()
                    && attachment.get("name").and_then(Value::as_str) == Some(name.as_str())
            }) {
                continue;
            }
            attachments.push(json!({
                "id": format!("{message_id}-reference-{index}"),
                "name": name,
                "mimeType": mime,
                "size": 0,
                "state": "ready",
                "url": url,
                "previewUrl": if kind == "image" { url.clone() } else { None::<String> },
                "reference": value,
            }));
        }
    }
    attachments
}

fn visible_message_text(row: &Value) -> String {
    let mut text = content_part_text(row.get("content").or_else(|| row.get("text")));
    if row.get("role").and_then(Value::as_str) == Some("user") {
        if let Some(index) = text
            .find("\n--- Attached Context ---")
            .or_else(|| text.starts_with("--- Attached Context ---").then_some(0))
        {
            text.truncate(index);
        }
        if let Some(index) = text
            .find("\n--- Context Warnings ---")
            .or_else(|| text.starts_with("--- Context Warnings ---").then_some(0))
        {
            text.truncate(index);
        }
    }
    text.lines()
        .filter(|line| !line.trim().starts_with("data:image/"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

pub(crate) fn gateway_value_text(value: Option<&Value>) -> String {
    value_text(value)
}

fn source_name(source: Option<&str>) -> &'static str {
    match source.unwrap_or_default().to_ascii_lowercase().as_str() {
        "workspace" => "workspace",
        "desktop" => "desktop",
        "cli" | "tui" | "terminal" => "cli",
        "cron" | "schedule" => "schedule",
        "subagent" | "delegate" => "subagent",
        "background" => "background",
        "telegram" | "discord" | "slack" | "whatsapp" | "signal" | "imessage" | "wechat"
        | "weixin" | "matrix" | "email" | "messaging" => "messaging",
        _ => "workspace",
    }
}

fn schedule_fields(job: &Value) -> Map<String, Value> {
    let mut fields = job.as_object().cloned().unwrap_or_default();
    for key in [
        "id",
        "profile",
        "name",
        "prompt",
        "schedule",
        "schedule_display",
        "model",
        "provider",
        "state",
        "enabled",
        "next_run_at",
        "last_run_at",
        "last_error",
        "created_at",
        "updated_at",
        // Scheduler-owned state must never be round-tripped from an edit form.
        // A run can settle while the editor is open; writing this snapshot back
        // would otherwise roll counters and status metadata back in time.
        "last_status",
        "last_delivery_error",
        "latest_execution",
        "paused_at",
        "paused_reason",
        "provider_snapshot",
        "model_snapshot",
        "repeat",
    ] {
        fields.remove(key);
    }
    // `repeat.times` is configuration that the simplified editor does not
    // expose, while `repeat.completed` is live scheduler state. Preserve only
    // the former so existing bounded jobs keep their configured limit without
    // allowing a stale edit to replay already-completed runs.
    if let Some(times) = job
        .get("repeat")
        .and_then(Value::as_object)
        .and_then(|repeat| repeat.get("times"))
    {
        fields.insert("repeat".to_string(), json!({ "times": times.clone() }));
    }
    fields
}

fn latest_schedule_fields(
    current: &Value,
    stale_fallback: Option<Map<String, Value>>,
) -> Map<String, Value> {
    let mut fields = schedule_fields(current);
    // Compatible gateways should return the complete job. Keep form-carried
    // fields only as a fallback for an older gateway that omits unknown keys;
    // a concurrently changed server value always wins.
    for (key, value) in stale_fallback.unwrap_or_default() {
        fields.entry(key).or_insert(value);
    }
    fields
}

fn edited_schedule_value(
    current: &Value,
    submitted_cron: &str,
    original_cron: Option<&str>,
) -> Value {
    if original_cron.is_some_and(|original| original.trim() == submitted_cron.trim()) {
        current
            .get("schedule")
            .cloned()
            .unwrap_or_else(|| Value::String(submitted_cron.to_string()))
    } else {
        Value::String(submitted_cron.to_string())
    }
}

fn schedule_cron(job: &Value) -> String {
    match job.get("schedule") {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Object(value)) => match value.get("kind").and_then(Value::as_str) {
            Some("once") => value
                .get("run_at")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            Some("interval") => value
                .get("minutes")
                .and_then(Value::as_u64)
                .map(|minutes| format!("every {minutes}m"))
                .unwrap_or_default(),
            _ => value
                .get("expr")
                .or_else(|| value.get("value"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        },
        _ => job
            .get("schedule_display")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

fn map_schedule(job: &Value, fallback_profile: Option<&str>) -> Value {
    let profile = job
        .get("profile")
        .and_then(Value::as_str)
        .or(fallback_profile)
        .unwrap_or("default");
    let deliver = job
        .get("deliver")
        .and_then(Value::as_str)
        .unwrap_or("local");
    let script = job
        .get("script")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let no_agent = job
        .get("no_agent")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let kind = if no_agent && !script.is_empty() {
        "script"
    } else if deliver != "local" {
        "messaging"
    } else {
        "agent"
    };
    let raw_state = job.get("state").and_then(Value::as_str).unwrap_or_default();
    let state = if raw_state.eq_ignore_ascii_case("running") {
        "running"
    } else if raw_state.eq_ignore_ascii_case("error")
        || job.get("last_error").is_some_and(|value| {
            value
                .as_str()
                .map(|text| !text.trim().is_empty())
                .unwrap_or(!value.is_null())
        })
    {
        "error"
    } else if job.get("enabled").and_then(Value::as_bool) == Some(false)
        || matches!(raw_state, "paused" | "disabled")
    {
        "paused"
    } else {
        "active"
    };
    json!({
        "id": job.get("id").and_then(Value::as_str).unwrap_or_default(),
        "profileId": profile,
        "name": job.get("name").and_then(Value::as_str)
            .or_else(|| job.get("prompt").and_then(Value::as_str))
            .filter(|text| !text.trim().is_empty())
            .unwrap_or("Untitled schedule"),
        "kind": kind,
        "prompt": job.get("prompt").cloned().unwrap_or(Value::Null),
        "cron": schedule_cron(job),
        "model": job.get("model").cloned().unwrap_or(Value::Null),
        "provider": job.get("provider").cloned().unwrap_or(Value::Null),
        "state": state,
        "nextRunAt": job.get("next_run_at").cloned().unwrap_or(Value::Null),
        "lastRunAt": job.get("last_run_at").cloned().unwrap_or(Value::Null),
        "lastError": job.get("last_error").cloned().unwrap_or(Value::Null),
        "preservedFields": schedule_fields(job),
    })
}

fn turn_is_active(backend: &WorkspaceBackend, key: &ScopeKey) -> bool {
    backend
        .starting
        .lock()
        .map(|values| values.contains(key))
        .unwrap_or(true)
        || backend
            .finalizing
            .lock()
            .map(|values| values.contains(key))
            .unwrap_or(true)
        || backend
            .controls
            .lock()
            .map(|values| values.contains_key(key))
            .unwrap_or(true)
        || backend
            .server_active
            .lock()
            .map(|values| values.contains(key))
            .unwrap_or(true)
        || backend
            .owned_active
            .lock()
            .map(|values| values.contains(key))
            .unwrap_or(true)
        || backend
            .mirrored_active
            .lock()
            .map(|values| values.contains(key))
            .unwrap_or(true)
}

fn server_runtime(backend: &WorkspaceBackend, key: &ScopeKey) -> Option<String> {
    let server_active = backend
        .server_active
        .lock()
        .map(|values| values.contains(key))
        .unwrap_or(false);
    // Compact-prompt turns are mirrored into the workspace without appearing
    // in server_active until the next reconciliation. They still have a valid
    // cached runtime ID, and must be controlled directly: session.resume would
    // rebind the live Gateway transport away from the prompt window.
    let prompt_mirrored = backend
        .mirrored_active
        .lock()
        .map(|values| values.contains(key))
        .unwrap_or(false);
    if !server_active && !prompt_mirrored {
        return None;
    }
    backend
        .runtimes
        .lock()
        .ok()
        .and_then(|runtimes| runtimes.get(key).cloned())
}

fn session_has_queue(backend: &WorkspaceBackend, key: &ScopeKey) -> bool {
    backend
        .client_states
        .lock()
        .map(|states| states.get(key).is_some_and(|state| !state.queue.is_empty()))
        .unwrap_or(true)
}

fn gateway_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        Value::Number(value) => value.as_i64().map(|value| value != 0),
        Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" | "yolo" => Some(true),
            "0" | "false" | "no" | "off" | "default" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn gateway_approval_mode(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "manual" | "smart" | "off"))
}

fn merge_turn_settings(settings: &mut TurnSettings, source: &Value) {
    let Some(source) = source.as_object() else {
        return;
    };
    if let Some(value) = source
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        settings.model = Some(value.to_string());
    }
    if let Some(value) = source
        .get("provider")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        settings.provider = Some(value.to_string());
    }
    if let Some(value) = source
        .get("reasoning_effort")
        .or_else(|| source.get("reasoningEffort"))
        .and_then(Value::as_str)
    {
        settings.reasoning_effort = Some(value.to_string());
    }
    if let Some(value) = source.get("fast").and_then(gateway_bool) {
        settings.fast = Some(value);
    } else if let Some(value) = source.get("service_tier").and_then(Value::as_str) {
        settings.fast = Some(value == "priority");
    }
    if let Some(value) = source
        .get("personality")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        settings.personality = Some(value.to_string());
    }
    if let Some(value) = source
        .get("approval_mode")
        .or_else(|| source.get("approvalMode"))
        .and_then(gateway_approval_mode)
    {
        settings.approval_mode = Some(value);
    }
    if let Some(value) = source.get("yolo").and_then(gateway_bool) {
        settings.yolo = Some(value);
    }
}

fn turn_settings_from_row(row: &Value) -> TurnSettings {
    let mut settings = TurnSettings::default();
    merge_turn_settings(&mut settings, row);
    if settings.provider.is_none() {
        settings.provider = row
            .get("model_config")
            .and_then(|value| value.get("provider"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
    }
    // session.info is authoritative for effective runtime state. Active-list
    // implementations may nest it under `info`, while persisted session rows
    // usually expose only model/provider at the top level.
    if let Some(info) = row.get("info") {
        merge_turn_settings(&mut settings, info);
    }
    settings
}

fn session_settings(row: &Value, live_row: Option<&Value>) -> TurnSettings {
    let mut settings = turn_settings_from_row(row);
    if let Some(live_row) = live_row {
        let live = turn_settings_from_row(live_row);
        if live.model.is_some() {
            settings.model = live.model;
        }
        if live.provider.is_some() {
            settings.provider = live.provider;
        }
        if live.reasoning_effort.is_some() {
            settings.reasoning_effort = live.reasoning_effort;
        }
        if live.fast.is_some() {
            settings.fast = live.fast;
        }
        if live.personality.is_some() {
            settings.personality = live.personality;
        }
        if live.approval_mode.is_some() {
            settings.approval_mode = live.approval_mode;
        }
        if live.yolo.is_some() {
            settings.yolo = live.yolo;
        }
    }
    settings
}

fn live_row_is_stalled(row: &Value) -> bool {
    let stalled = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .is_some_and(|value| value.eq_ignore_ascii_case("stalled"))
    };
    stalled(row.get("status"))
        || stalled(row.get("state"))
        || stalled(row.get("turn_state"))
        || stalled(row.get("turnState"))
        || row.get("info").is_some_and(|info| {
            stalled(info.get("status"))
                || stalled(info.get("state"))
                || stalled(info.get("turn_state"))
                || stalled(info.get("turnState"))
        })
}

fn session_turn_state(backend: &WorkspaceBackend, key: &ScopeKey) -> &'static str {
    if !turn_is_active(backend, key) {
        return "idle";
    }
    let stalled = backend
        .server_active_rows
        .lock()
        .ok()
        .and_then(|rows| rows.get(key).cloned())
        .is_some_and(|row| live_row_is_stalled(&row));
    if stalled {
        "stalled"
    } else {
        "running"
    }
}

fn map_session(row: &Value, fallback_profile: Option<&str>, backend: &WorkspaceBackend) -> Value {
    let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
    let profile = row
        .get("profile")
        .and_then(Value::as_str)
        .or(fallback_profile)
        .unwrap_or("default");
    let key = (profile.to_string(), id.to_string());
    let turn_state = session_turn_state(backend, &key);
    let queued_count = backend
        .client_states
        .lock()
        .ok()
        .and_then(|states| states.get(&key).map(|state| state.queue.len()))
        .unwrap_or_default();
    let title = row
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| row.get("display_name").and_then(Value::as_str))
        .unwrap_or("Untitled chat");
    let live_row = backend
        .server_active_rows
        .lock()
        .ok()
        .and_then(|rows| rows.get(&key).cloned());
    let settings = session_settings(row, live_row.as_ref());
    json!({
        "id": id,
        "profileId": profile,
        "title": title,
        "source": source_name(row.get("source").and_then(Value::as_str)),
        "createdAt": unix_or_iso(row.get("started_at")),
        "updatedAt": unix_or_iso(row.get("last_active").or_else(|| row.get("started_at"))),
        "archived": row.get("archived").and_then(Value::as_bool)
            .unwrap_or_else(|| row.get("archived").and_then(Value::as_i64).unwrap_or_default() != 0),
        "pinned": false,
        "turnState": turn_state,
        "queuedCount": queued_count,
        "unread": row.get("unread").and_then(Value::as_bool)
            .unwrap_or_else(|| row.get("unread").and_then(Value::as_i64).unwrap_or_default() != 0),
        "branchParentId": row.get("parent_session_id").cloned().unwrap_or(Value::Null),
        "parentSessionId": row.get("parent_session_id").cloned().unwrap_or(Value::Null),
        "lastMessagePreview": row.get("preview").cloned().unwrap_or(Value::Null),
        "settings": settings,
    })
}

fn parse_json_value(value: &Value) -> Option<Value> {
    value
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
}

fn values_array(value: Option<&Value>) -> Vec<Value> {
    let Some(value) = value else {
        return Vec::new();
    };
    if let Some(values) = value.as_array() {
        return values.clone();
    }
    if let Some(parsed) = parse_json_value(value) {
        return parsed.as_array().cloned().unwrap_or_else(|| vec![parsed]);
    }
    if value.is_null() {
        Vec::new()
    } else {
        vec![value.clone()]
    }
}

fn key_suggests_artifact(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "path", "file", "url", "image", "artifact", "output", "download", "result", "target",
    ]
    .iter()
    .any(|hint| key.contains(hint))
}

fn known_file_suffix(value: &str) -> bool {
    let lower = value
        .split(['?', '#'])
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase();
    [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".pdf", ".txt", ".json", ".md",
        ".csv", ".zip", ".tar", ".gz", ".mp3", ".wav", ".mp4", ".mov", ".html", ".htm", ".doc",
        ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ]
    .iter()
    .any(|suffix| lower.ends_with(suffix))
}

fn looks_like_path(value: &str) -> bool {
    value.starts_with('/')
        || value.starts_with("./")
        || value.starts_with("../")
        || value.starts_with("~/")
        || value.starts_with("file://")
        || (value.len() > 3
            && value.as_bytes().get(1) == Some(&b':')
            && matches!(value.as_bytes().get(2), Some(b'\\' | b'/')))
}

fn normalize_artifact_candidate(value: &str) -> String {
    value
        .trim()
        .trim_matches(|character: char| matches!(character, '`' | '"' | '\'' | '<' | '>'))
        .trim_end_matches(|character: char| matches!(character, ',' | ';' | ')' | ']'))
        .to_string()
}

fn collect_text_artifact_candidates(text: &str, explicit: bool, candidates: &mut Vec<String>) {
    let mut rest = text;
    while let Some(start) = rest.find("](") {
        let after = &rest[start + 2..];
        let Some(end) = after.find(')') else {
            break;
        };
        let candidate = normalize_artifact_candidate(&after[..end]);
        if !candidate.is_empty()
            && (explicit
                || candidate.starts_with("data:image/")
                || known_file_suffix(&candidate)
                || (looks_like_path(&candidate) && candidate.contains('.')))
        {
            candidates.push(candidate);
        }
        rest = &after[end + 1..];
    }
    for token in text.split_whitespace() {
        let candidate = normalize_artifact_candidate(token);
        let web = candidate.starts_with("http://") || candidate.starts_with("https://");
        if !candidate.is_empty()
            && (candidate.starts_with("data:image/")
                || (web && (explicit || known_file_suffix(&candidate)))
                || (looks_like_path(&candidate) && known_file_suffix(&candidate)))
        {
            candidates.push(candidate);
        }
    }
}

fn collect_artifact_candidates(
    value: &Value,
    key_path: &str,
    explicit: bool,
    candidates: &mut Vec<String>,
    depth: usize,
) {
    if depth > 6 {
        return;
    }
    match value {
        Value::String(text) => {
            if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                collect_artifact_candidates(&parsed, key_path, explicit, candidates, depth + 1);
            }
            let hinted = explicit || key_suggests_artifact(key_path);
            if hinted {
                let candidate = normalize_artifact_candidate(text);
                if !candidate.is_empty()
                    && (explicit
                        || candidate.starts_with("http://")
                        || candidate.starts_with("https://")
                        || candidate.starts_with("data:image/")
                        || looks_like_path(&candidate))
                {
                    candidates.push(candidate);
                }
            }
            collect_text_artifact_candidates(text, hinted, candidates);
        }
        Value::Array(values) => {
            for value in values {
                collect_artifact_candidates(value, key_path, explicit, candidates, depth + 1);
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                let next = if key_path.is_empty() {
                    key.clone()
                } else {
                    format!("{key_path}.{key}")
                };
                collect_artifact_candidates(value, &next, explicit, candidates, depth + 1);
            }
        }
        _ => {}
    }
}

fn artifact_kind(value: &str) -> &'static str {
    let mime = attachment_mime(value, None);
    if value.starts_with("data:image/") || mime.starts_with("image/") {
        "image"
    } else if looks_like_path(value) {
        "file"
    } else {
        "link"
    }
}

fn artifact_values(row: &Value, message_id: &str) -> Vec<Value> {
    let mut candidates = Vec::new();
    for key in ["artifacts", "artifact", "outputs", "generated_files"] {
        if let Some(value) = row.get(key) {
            collect_artifact_candidates(value, key, true, &mut candidates, 0);
        }
    }
    if matches!(
        row.get("role").and_then(Value::as_str),
        Some("assistant" | "tool")
    ) {
        if let Some(content) = row.get("content").or_else(|| row.get("text")) {
            collect_artifact_candidates(content, "content", false, &mut candidates, 0);
        }
        if let Some(calls) = row.get("tool_calls") {
            collect_artifact_candidates(calls, "tool_calls", false, &mut candidates, 0);
        }
    }
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        // Image content parts are already represented by AttachmentRef and a
        // data URL can be megabytes. Do not duplicate those bytes as artifact metadata.
        .filter(|candidate| !candidate.starts_with("data:image/"))
        .filter(|candidate| seen.insert(candidate.clone()))
        .enumerate()
        .map(|(index, value)| {
            let kind = artifact_kind(&value);
            let name = reference_name(&value, "Artifact");
            let url = (value.starts_with("http://")
                || value.starts_with("https://")
                || value.starts_with("data:image/"))
            .then(|| value.clone());
            json!({
                "id": format!("{message_id}-artifact-{index}"),
                "kind": kind,
                "name": name,
                "value": value,
                "url": url,
                "mimeType": attachment_mime(&name, None),
            })
        })
        .collect()
}

fn normalize_todo_status(value: Option<&str>) -> &'static str {
    match value.unwrap_or_default().to_ascii_lowercase().as_str() {
        "in_progress" | "in-progress" | "doing" | "running" | "active" => "in_progress",
        "done" | "complete" | "completed" | "success" => "completed",
        "cancelled" | "canceled" | "skipped" => "cancelled",
        _ => "pending",
    }
}

fn collect_todos(value: &Value, id_prefix: &str, todos: &mut Vec<Value>, depth: usize) {
    if depth > 6 {
        return;
    }
    if let Some(parsed) = parse_json_value(value) {
        collect_todos(&parsed, id_prefix, todos, depth + 1);
        return;
    }
    if let Some(values) = value.as_array() {
        for value in values {
            collect_todos(value, id_prefix, todos, depth + 1);
        }
        return;
    }
    let Some(row) = value.as_object() else {
        return;
    };
    for key in ["todos", "items", "tasks"] {
        if let Some(nested) = row.get(key) {
            collect_todos(nested, id_prefix, todos, depth + 1);
        }
    }
    let content = ["content", "task", "title", "text"]
        .iter()
        .find_map(|key| row.get(*key).and_then(Value::as_str))
        .filter(|text| !text.trim().is_empty());
    let Some(content) = content else {
        return;
    };
    let index = todos.len();
    todos.push(json!({
        "id": row.get("id").and_then(Value::as_str).map(str::to_string)
            .unwrap_or_else(|| format!("{id_prefix}-todo-{index}")),
        "content": content,
        "status": normalize_todo_status(row.get("status").and_then(Value::as_str)),
        "priority": row.get("priority").cloned().unwrap_or(Value::Null),
    }));
}

fn todo_values(row: &Value, message_id: &str) -> Vec<Value> {
    let mut todos = Vec::new();
    for key in ["todos", "todo"] {
        if let Some(value) = row.get(key) {
            collect_todos(value, message_id, &mut todos, 0);
        }
    }
    if let Some(calls) = row.get("tool_calls") {
        for call in values_array(Some(calls)) {
            let function = call.get("function").unwrap_or(&call);
            if first_string(function, &["name"])
                .unwrap_or_default()
                .to_ascii_lowercase()
                .contains("todo")
            {
                for key in ["arguments", "args", "input", "result", "output"] {
                    if let Some(value) = function.get(key).or_else(|| call.get(key)) {
                        collect_todos(value, message_id, &mut todos, 0);
                    }
                }
            }
        }
    }
    let mut merged: Vec<Value> = Vec::new();
    for todo in todos {
        let content = todo
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if let Some(existing) = merged
            .iter_mut()
            .find(|existing| existing.get("content").and_then(Value::as_str) == Some(content))
        {
            *existing = todo;
        } else {
            merged.push(todo);
        }
    }
    merged
}

fn interaction_options(value: &Value) -> Vec<Value> {
    if let Some(parsed) = parse_json_value(value) {
        return interaction_options(&parsed);
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, option)| {
            if let Some(label) = option.as_str() {
                return Some(json!({ "id": format!("choice-{index}"), "label": label }));
            }
            let label = first_string(option, &["label", "title", "text", "value"])?;
            Some(json!({
                "id": first_string(option, &["id", "value", "key"])
                    .map(str::to_string).unwrap_or_else(|| format!("choice-{index}")),
                "label": label,
                "description": first_string(option, &["description", "detail", "help"]),
            }))
        })
        .collect()
}

fn map_interaction(
    value: &Value,
    message_id: &str,
    index: usize,
    fallback_kind: &str,
) -> Option<Value> {
    let parsed = parse_json_value(value);
    let value = parsed.as_ref().unwrap_or(value);
    let kind_text = first_string(value, &["kind", "type", "name"])
        .unwrap_or(fallback_kind)
        .to_ascii_lowercase();
    let kind = if kind_text.contains("approval") || kind_text.contains("confirm") {
        "approval"
    } else {
        "clarification"
    };
    let title = first_string(
        value,
        &["title", "question", "description", "prompt", "message"],
    )
    .unwrap_or(if kind == "approval" {
        "Approval requested"
    } else {
        "Hermes requested clarification"
    });
    let status = first_string(value, &["status", "state"])
        .unwrap_or_default()
        .to_ascii_lowercase();
    let response = value
        .get("response")
        .or_else(|| value.get("answer"))
        .or_else(|| value.get("decision"));
    let explicitly_pending = matches!(status.as_str(), "pending" | "waiting" | "open");
    let resolved = value
        .get("resolved")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| response.is_some() || (!explicitly_pending && !status.is_empty()));
    let choices = value
        .get("options")
        .or_else(|| value.get("choices"))
        .map(interaction_options)
        .unwrap_or_default();
    Some(json!({
        "id": first_string(value, &["id", "request_id", "requestId"])
            .map(str::to_string).unwrap_or_else(|| format!("{message_id}-interaction-{index}")),
        "kind": kind,
        "title": title,
        "body": value.get("body").or_else(|| value.get("command"))
            .map(|value| pretty_value(Some(value))).filter(|value| !value.is_empty()),
        "options": choices,
        "allowText": value.get("allowText").or_else(|| value.get("allow_text")).and_then(Value::as_bool)
            .unwrap_or(kind == "clarification"),
        "sensitive": value.get("sensitive").and_then(Value::as_bool).unwrap_or(false),
        "resolved": resolved,
        "response": response.map(|value| pretty_value(Some(value))).unwrap_or_default(),
        // REST history cannot recreate the live blocking callback. Keep an
        // unresolved historical request visible without presenting dead controls.
        "respondable": false,
    }))
}

fn interaction_values(row: &Value, message_id: &str) -> Vec<Value> {
    let mut interactions = Vec::new();
    for (field, fallback_kind) in [
        ("interactions", "clarification"),
        ("interaction", "clarification"),
        ("approvals", "approval"),
        ("approval", "approval"),
        ("clarifications", "clarification"),
        ("clarification", "clarification"),
    ] {
        for value in values_array(row.get(field)) {
            if let Some(interaction) =
                map_interaction(&value, message_id, interactions.len(), fallback_kind)
            {
                interactions.push(interaction);
            }
        }
    }
    if let Some(parts) = row.get("content").and_then(Value::as_array) {
        for part in parts {
            let kind = part.get("type").and_then(Value::as_str).unwrap_or_default();
            if kind.contains("approval") || kind.contains("clarif") || kind == "interaction" {
                if let Some(interaction) = map_interaction(
                    part,
                    message_id,
                    interactions.len(),
                    if kind.contains("approval") {
                        "approval"
                    } else {
                        "clarification"
                    },
                ) {
                    interactions.push(interaction);
                }
            }
        }
    }
    interactions
}

fn u64_field(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| {
        value.get(*key).and_then(|value| {
            value.as_u64().or_else(|| {
                value
                    .as_f64()
                    .filter(|value| *value >= 0.0)
                    .map(|value| value as u64)
            })
        })
    })
}

fn token_usage(value: &Value, scope: &str) -> Option<Value> {
    let usage = value.get("usage").unwrap_or(value);
    let input = u64_field(usage, &["input", "input_tokens", "prompt_tokens"]);
    let output = u64_field(usage, &["output", "output_tokens", "completion_tokens"]);
    let context_used = u64_field(usage, &["context_used", "context", "context_tokens"]);
    let context_max = u64_field(usage, &["context_max", "context_window", "context_limit"]);
    let total = u64_field(usage, &["total", "total_tokens", "token_count"])
        .or_else(|| input.zip(output).map(|(input, output)| input + output));
    let cost = ["cost_usd", "estimated_cost_usd", "actual_cost_usd"]
        .iter()
        .find_map(|key| usage.get(*key).and_then(Value::as_f64));
    if input.is_none()
        && output.is_none()
        && context_used.is_none()
        && context_max.is_none()
        && total.is_none()
        && cost.is_none()
    {
        return None;
    }
    Some(json!({
        "scope": scope,
        "inputTokens": input,
        "outputTokens": output,
        "totalTokens": total,
        "contextTokens": context_used,
        "contextMaxTokens": context_max,
        "costUsd": cost,
    }))
}

fn map_tool_call(call: &Value, message_id: &str, index: usize) -> Value {
    let function = call.get("function").unwrap_or(call);
    let id = first_string(call, &["id", "tool_call_id", "toolCallId"])
        .map(str::to_string)
        .unwrap_or_else(|| format!("{message_id}-tool-{index}"));
    let name = first_string(function, &["name", "tool_name", "toolName"])
        .or_else(|| first_string(call, &["name", "tool_name", "toolName"]))
        .unwrap_or("tool");
    let input = function
        .get("arguments")
        .or_else(|| function.get("args"))
        .or_else(|| function.get("input"))
        .or_else(|| call.get("input"));
    let output = call
        .get("result")
        .or_else(|| call.get("output"))
        .or_else(|| function.get("result"))
        .or_else(|| function.get("output"));
    let error = call
        .get("error")
        .or_else(|| function.get("error"))
        .filter(|error| !error.is_null() && error.as_bool() != Some(false));
    let raw_status = first_string(call, &["status", "state"])
        .unwrap_or("complete")
        .to_ascii_lowercase();
    let status = if error.is_some() || matches!(raw_status.as_str(), "failed" | "error") {
        "error"
    } else if matches!(raw_status.as_str(), "pending" | "queued") {
        "pending"
    } else if matches!(raw_status.as_str(), "running" | "active") {
        "running"
    } else {
        "complete"
    };
    json!({
        "id": id,
        "name": name,
        "status": status,
        "summary": first_string(call, &["summary", "context", "preview"])
            .or_else(|| first_string(function, &["summary", "context", "preview"])),
        "input": pretty_value(input),
        "output": pretty_value(output),
        "error": error.map(|value| pretty_value(Some(value))).unwrap_or_default(),
    })
}

fn map_message(row: &Value, profile: &str, session_id: &str) -> Value {
    let id = row
        .get("id")
        .map(|id| {
            id.as_str()
                .map(str::to_string)
                .unwrap_or_else(|| id.to_string())
        })
        .unwrap_or_else(|| {
            // Older gateway projections omit DB ids. Derive a deterministic
            // fallback so pagination/refetches never remount the same message.
            let source = format!(
                "{}\0{}\0{}",
                row.get("timestamp")
                    .map(Value::to_string)
                    .unwrap_or_default(),
                row.get("role").and_then(Value::as_str).unwrap_or_default(),
                value_text(row.get("content").or_else(|| row.get("text")))
            );
            let mut hash = 0xcbf29ce484222325_u64;
            for byte in source.bytes() {
                hash ^= byte as u64;
                hash = hash.wrapping_mul(0x100000001b3);
            }
            format!("history-{hash:016x}")
        });
    let role = match row.get("role").and_then(Value::as_str).unwrap_or("system") {
        "user" => "user",
        "assistant" => "assistant",
        "tool" => "tool",
        _ => "system",
    };
    let attachments = content_attachments(row, &id);
    let mut tools = values_array(row.get("tool_calls"))
        .iter()
        .enumerate()
        .map(|(index, call)| map_tool_call(call, &id, index))
        .collect::<Vec<_>>();
    if role == "tool" && tools.is_empty() {
        let output = row
            .get("content")
            .or_else(|| row.get("text"))
            .or_else(|| row.get("context"));
        let error = row
            .get("error")
            .filter(|error| !error.is_null() && error.as_bool() != Some(false));
        tools.push(json!({
            "id": row.get("tool_call_id").and_then(Value::as_str).map(str::to_string)
                .unwrap_or_else(|| format!("{id}-result")),
            "name": first_string(row, &["tool_name", "name"]).unwrap_or("tool"),
            "status": if error.is_some() { "error" } else { "complete" },
            "output": pretty_value(output),
            "error": error.map(|value| pretty_value(Some(value))).unwrap_or_default(),
        }));
    }
    let reasoning = [row.get("reasoning"), row.get("reasoning_content")]
        .into_iter()
        .flatten()
        .map(|value| value_text(Some(value)))
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let usage = token_usage(row, "message");
    let total_tokens = usage
        .as_ref()
        .and_then(|usage| usage.get("totalTokens"))
        .cloned()
        .unwrap_or(Value::Null);
    let context_tokens = usage
        .as_ref()
        .and_then(|usage| usage.get("contextTokens"))
        .cloned()
        .unwrap_or(Value::Null);
    let raw_status = first_string(row, &["status", "state", "finish_reason"])
        .unwrap_or_default()
        .to_ascii_lowercase();
    let message_error = row
        .get("error")
        .filter(|error| !error.is_null() && error.as_bool() != Some(false))
        .map(|error| pretty_value(Some(error)));
    let message_status =
        if message_error.is_some() || matches!(raw_status.as_str(), "error" | "failed") {
            "error"
        } else if matches!(
            raw_status.as_str(),
            "cancelled" | "canceled" | "interrupted"
        ) {
            "cancelled"
        } else {
            "complete"
        };
    let mut interactions = interaction_values(row, &id);
    for (index, call) in values_array(row.get("tool_calls")).iter().enumerate() {
        let function = call.get("function").unwrap_or(call);
        let name = first_string(function, &["name", "tool_name"])
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !(name.contains("clarif") || name == "ask_user" || name.contains("approval")) {
            continue;
        }
        let arguments = function
            .get("arguments")
            .or_else(|| function.get("args"))
            .or_else(|| function.get("input"));
        let parsed = arguments.and_then(parse_json_value);
        let interaction_source = parsed.as_ref().or(arguments).unwrap_or(function);
        let mut source = interaction_source.clone();
        if let Some(object) = source.as_object_mut() {
            object.entry("id").or_insert_with(|| {
                call.get("id")
                    .cloned()
                    .unwrap_or_else(|| json!(format!("{id}-tool-{index}")))
            });
            if !["title", "question", "description", "prompt", "message"]
                .iter()
                .any(|key| object.get(*key).and_then(Value::as_str).is_some())
            {
                object.insert(
                    "title".to_string(),
                    json!(if name.contains("approval") {
                        "Approval requested"
                    } else {
                        "Hermes requested clarification"
                    }),
                );
            }
        }
        if let Some(interaction) = map_interaction(
            &source,
            &id,
            interactions.len(),
            if name.contains("approval") {
                "approval"
            } else {
                "clarification"
            },
        ) {
            interactions.push(interaction);
        }
    }
    json!({
        "id": id,
        "sessionId": session_id,
        "profileId": profile,
        "role": role,
        "content": visible_message_text(row),
        "createdAt": unix_or_iso(row.get("timestamp")),
        "status": message_status,
        "attachments": attachments,
        "artifacts": artifact_values(row, &id),
        "tools": tools,
        "interactions": interactions,
        "todos": todo_values(row, &id),
        "reasoning": if reasoning.is_empty() { Value::Null } else { Value::String(reasoning) },
        "usage": usage,
        "contextTokens": context_tokens,
        "totalTokens": total_tokens,
        "sourceMessageIds": [id],
        "error": message_error,
    })
}

fn append_unique_values(target: &mut Value, field: &str, values: Vec<Value>, key: &str) {
    if values.is_empty() {
        return;
    }
    let Some(object) = target.as_object_mut() else {
        return;
    };
    let target_values = object
        .entry(field)
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(target_values) = target_values.as_array_mut() else {
        return;
    };
    for value in values {
        let duplicate = if key.is_empty() {
            target_values.contains(&value)
        } else {
            value.get(key).is_some_and(|candidate| {
                target_values
                    .iter()
                    .any(|existing| existing.get(key) == Some(candidate))
            })
        };
        if !duplicate {
            target_values.push(value);
        }
    }
}

fn merge_todo_values(target: &mut Value, values: Vec<Value>) {
    let Some(target_values) = target.as_object_mut().and_then(|object| {
        object
            .entry("todos")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
    }) else {
        return;
    };
    for value in values {
        let content = value
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if let Some(existing) = target_values
            .iter_mut()
            .find(|existing| existing.get("content").and_then(Value::as_str) == Some(content))
        {
            *existing = value;
        } else {
            target_values.push(value);
        }
    }
}

fn merge_interaction_values(target: &mut Value, values: Vec<Value>) {
    let Some(target_values) = target.as_object_mut().and_then(|object| {
        object
            .entry("interactions")
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
    }) else {
        return;
    };
    for value in values {
        let id = value.get("id").and_then(Value::as_str).unwrap_or_default();
        if let Some(existing) = target_values
            .iter_mut()
            .find(|existing| existing.get("id").and_then(Value::as_str) == Some(id))
        {
            *existing = value;
        } else {
            target_values.push(value);
        }
    }
}

fn merge_message_values(target: &mut Value, source: Value) {
    let source_content = source
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !source_content.trim().is_empty() {
        let current = target
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        target["content"] = Value::String(if current.trim().is_empty() {
            source_content.to_string()
        } else {
            format!("{current}\n\n{source_content}")
        });
    }
    let source_reasoning = source
        .get("reasoning")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !source_reasoning.trim().is_empty() {
        let current = target
            .get("reasoning")
            .and_then(Value::as_str)
            .unwrap_or_default();
        target["reasoning"] = Value::String(if current.trim().is_empty() {
            source_reasoning.to_string()
        } else {
            format!("{current}\n\n{source_reasoning}")
        });
    }
    for (field, key) in [
        ("sourceMessageIds", ""),
        ("attachments", "id"),
        ("artifacts", "value"),
        ("tools", "id"),
    ] {
        let values = source
            .get(field)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if field == "sourceMessageIds" {
            let Some(target_values) = target
                .as_object_mut()
                .and_then(|object| object.get_mut(field))
                .and_then(Value::as_array_mut)
            else {
                continue;
            };
            for value in values {
                if !target_values.contains(&value) {
                    target_values.push(value);
                }
            }
        } else {
            append_unique_values(target, field, values, key);
        }
    }
    merge_todo_values(
        target,
        source
            .get("todos")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    );
    merge_interaction_values(
        target,
        source
            .get("interactions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    );
    if source.get("usage").is_some_and(|usage| !usage.is_null()) {
        target["usage"] = source["usage"].clone();
        target["contextTokens"] = source["contextTokens"].clone();
        target["totalTokens"] = source["totalTokens"].clone();
    }
    target["id"] = source["id"].clone();
    target["createdAt"] = source["createdAt"].clone();
}

fn result_is_error(row: &Value) -> bool {
    row.get("error")
        .is_some_and(|error| !error.is_null() && error.as_bool() != Some(false))
        || matches!(
            first_string(row, &["status", "state", "finish_reason"]),
            Some("error" | "failed")
        )
        || row
            .get("content")
            .and_then(parse_json_value)
            .as_ref()
            .and_then(|value| value.get("error"))
            .is_some_and(|error| !error.is_null() && error.as_bool() != Some(false))
}

fn map_messages(rows: &[Value], profile: &str, session_id: &str) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::new();
    let mut active_assistant: Option<usize> = None;
    let mut tool_targets: HashMap<String, (usize, usize)> = HashMap::new();

    for row in rows {
        let mapped = map_message(row, profile, session_id);
        let role = mapped
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("system");
        if role == "tool" {
            let tool_call_id = first_string(row, &["tool_call_id", "toolCallId"]);
            let tool_name = first_string(row, &["tool_name", "name"]).unwrap_or("tool");
            let target = tool_call_id
                .and_then(|id| tool_targets.get(id).copied())
                .or_else(|| {
                    active_assistant.and_then(|message_index| {
                        messages[message_index]
                            .get("tools")
                            .and_then(Value::as_array)
                            .and_then(|tools| {
                                tools
                                    .iter()
                                    .enumerate()
                                    .rev()
                                    .find_map(|(tool_index, tool)| {
                                        (tool.get("name").and_then(Value::as_str)
                                            == Some(tool_name)
                                            && tool
                                                .get("output")
                                                .and_then(Value::as_str)
                                                .unwrap_or_default()
                                                .is_empty())
                                        .then_some((message_index, tool_index))
                                    })
                            })
                    })
                });
            if let Some((message_index, tool_index)) = target {
                let output_value = row
                    .get("content")
                    .or_else(|| row.get("text"))
                    .or_else(|| row.get("context"))
                    .or_else(|| row.get("result"))
                    .or_else(|| row.get("output"));
                if let Some(tool) = messages[message_index]
                    .get_mut("tools")
                    .and_then(Value::as_array_mut)
                    .and_then(|tools| tools.get_mut(tool_index))
                {
                    tool["output"] = Value::String(pretty_value(output_value));
                    tool["status"] = Value::String(
                        if result_is_error(row) {
                            "error"
                        } else {
                            "complete"
                        }
                        .to_string(),
                    );
                    if result_is_error(row) {
                        tool["error"] =
                            Value::String(pretty_value(row.get("error").or(output_value)));
                    }
                }
                let source_id = mapped["id"].clone();
                append_unique_values(
                    &mut messages[message_index],
                    "sourceMessageIds",
                    vec![source_id],
                    "",
                );
                append_unique_values(
                    &mut messages[message_index],
                    "artifacts",
                    artifact_values(row, mapped["id"].as_str().unwrap_or("tool")),
                    "value",
                );
                let mut todos = Vec::new();
                if let Some(value) = output_value {
                    collect_todos(
                        value,
                        mapped["id"].as_str().unwrap_or("tool"),
                        &mut todos,
                        0,
                    );
                }
                merge_todo_values(&mut messages[message_index], todos);
                if let Some(interactions) = messages[message_index]
                    .get_mut("interactions")
                    .and_then(Value::as_array_mut)
                {
                    for interaction in interactions {
                        let same_id = tool_call_id.is_some_and(|id| {
                            interaction.get("id").and_then(Value::as_str) == Some(id)
                        });
                        if same_id
                            || (tool_call_id.is_none()
                                && interaction.get("resolved").and_then(Value::as_bool)
                                    == Some(false))
                        {
                            interaction["resolved"] = Value::Bool(true);
                            interaction["response"] = Value::String(pretty_value(output_value));
                            if same_id {
                                break;
                            }
                        }
                    }
                }
                continue;
            }
            if let Some(message_index) = active_assistant {
                let tools = mapped
                    .get("tools")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                append_unique_values(&mut messages[message_index], "tools", tools, "id");
                append_unique_values(
                    &mut messages[message_index],
                    "sourceMessageIds",
                    vec![mapped["id"].clone()],
                    "",
                );
                append_unique_values(
                    &mut messages[message_index],
                    "artifacts",
                    mapped
                        .get("artifacts")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                    "value",
                );
                continue;
            }
            messages.push(mapped);
            continue;
        }

        if role == "assistant" {
            let source_has_tools = mapped
                .get("tools")
                .and_then(Value::as_array)
                .is_some_and(|tools| !tools.is_empty());
            let target_has_tools = active_assistant.is_some_and(|index| {
                messages[index]
                    .get("tools")
                    .and_then(Value::as_array)
                    .is_some_and(|tools| !tools.is_empty())
            });
            let message_index = if let Some(index) =
                active_assistant.filter(|_| source_has_tools || target_has_tools)
            {
                merge_message_values(&mut messages[index], mapped);
                index
            } else {
                messages.push(mapped);
                messages.len() - 1
            };
            active_assistant = Some(message_index);
            if let Some(tools) = messages[message_index]
                .get("tools")
                .and_then(Value::as_array)
            {
                for (tool_index, tool) in tools.iter().enumerate() {
                    if let Some(id) = tool.get("id").and_then(Value::as_str) {
                        tool_targets.insert(id.to_string(), (message_index, tool_index));
                    }
                }
            }
            continue;
        }

        active_assistant = None;
        messages.push(mapped);
    }
    messages
}

fn apply_session_usage(messages: &mut [Value], detail: &Value) {
    let session = detail.get("session").unwrap_or(detail);
    let Some(usage) = token_usage(session, "session") else {
        return;
    };
    if let Some(message) = messages
        .iter_mut()
        .rev()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
    {
        message["sessionUsage"] = usage;
    }
}

fn connected_info(status: &Value) -> Value {
    json!({
        "state": "connected",
        "backend": status.get("backend").and_then(Value::as_str).unwrap_or("Hermes Agent"),
        "version": status.get("version").cloned().unwrap_or(Value::Null),
    })
}

fn configured_instance_id(config: &super::HermesInstanceConfig) -> String {
    if !config.instance_id.trim().is_empty() {
        config.instance_id.clone()
    } else if config.remote {
        format!("existing:{}:{}", config.address, config.port)
    } else {
        "automatic-hermes".to_string()
    }
}

fn client_state_scope_matches(
    config: &super::HermesInstanceConfig,
    generation: u64,
    instance_id: &str,
    instance_generation: u64,
) -> bool {
    configured_instance_id(config) == instance_id && generation == instance_generation
}

async fn begin_scoped_gateway_operation<'a>(
    backend: &HermesBackend,
    workspace: &'a WorkspaceBackend,
    instance: &InstanceScope,
) -> Result<RwLockReadGuard<'a, ()>, String> {
    begin_instance_operation(
        backend,
        workspace,
        &instance.instance_id,
        instance.instance_generation,
    )
    .await
}

pub(crate) async fn begin_instance_operation<'a>(
    backend: &HermesBackend,
    workspace: &'a WorkspaceBackend,
    instance_id: &str,
    instance_generation: u64,
) -> Result<RwLockReadGuard<'a, ()>, String> {
    // Configure takes the write side of this lock. Holding a read guard keeps
    // one request on one instance for its entire lifetime, including awaits.
    let operation = workspace.instance_operations.read().await;
    let backend = backend
        .0
        .lock()
        .map_err(|_| "Hermes gateway state is unavailable")?;
    if !client_state_scope_matches(
        &backend.config,
        backend.generation,
        instance_id,
        instance_generation,
    ) {
        return Err("Gateway operation belongs to a stale Hermes instance generation".to_string());
    }
    drop(backend);
    Ok(operation)
}

async fn begin_current_instance_operation(workspace: &WorkspaceBackend) -> RwLockReadGuard<'_, ()> {
    workspace.instance_operations.read().await
}

#[derive(Clone, Copy)]
struct CapabilityFlags {
    schedule: bool,
    schedule_history: bool,
    search: bool,
    archive: bool,
    delete: bool,
    branch: bool,
    attachments: bool,
    artifact_files: bool,
    interactions: bool,
    rewind: bool,
    undo: bool,
}

fn capabilities(flags: CapabilityFlags) -> Value {
    let supported = |value: bool, reason: &str| {
        if value {
            json!({"supported": true})
        } else {
            json!({"supported": false, "reason": reason})
        }
    };
    json!({
        "sessions": supported(true, "Session gateway APIs are unavailable"),
        "sessionSearch": supported(flags.search, "Gateway does not expose GET /api/sessions/search"),
        "sessionBranch": supported(flags.branch, "Gateway does not expose session.branch"),
        "sessionPin": supported(false, "Gateway does not expose session pin mutation"),
        "sessionArchive": supported(flags.archive, "Gateway does not expose PATCH /api/sessions/{id}"),
        "sessionDelete": supported(flags.delete, "Gateway does not expose DELETE /api/sessions/{id}"),
        "attachments": supported(flags.attachments, "Gateway lacks image.attach_bytes/image.attach/image.detach or file.attach"),
        "artifactFiles": supported(flags.artifact_files, "Gateway does not expose GET /api/fs/read-data-url"),
        "interactions": supported(flags.interactions, "Gateway lacks clarify.respond/approval.respond/sudo.respond/secret.respond"),
        "messageRetry": supported(flags.rewind, "Gateway does not support prompt.submit rewind parameters"),
        "messageEdit": supported(flags.rewind, "Gateway does not support prompt.submit rewind parameters"),
        "messageUndo": supported(flags.undo, "Gateway does not expose session.undo"),
        "schedules": supported(flags.schedule, "Gateway does not expose GET /api/cron/jobs"),
        "scheduleHistory": supported(flags.schedule_history, "Gateway does not expose GET /api/cron/jobs/{id}/runs"),
        "profiles": supported(true, "Gateway does not expose /api/profiles"),
    })
}

fn connection_for(
    backend: &HermesBackend,
    profile: Option<&str>,
) -> Result<HermesGatewayConnection, String> {
    hermes_gateway_connection_for_profile(backend, profile)
}

async fn status_for(
    connection: &HermesGatewayConnection,
    profile: Option<&str>,
) -> Result<Value, String> {
    hermes_http_json(
        connection,
        Method::GET,
        &api_path("/api/status", &[("profile", profile.map(str::to_string))]),
        None,
        HTTP_TIMEOUT,
    )
    .await
}

async fn profiles_for(
    connection: &HermesGatewayConnection,
) -> Result<(Vec<Value>, String), String> {
    let (profiles, active) = futures_util::try_join!(
        hermes_http_json(connection, Method::GET, "/api/profiles", None, HTTP_TIMEOUT),
        hermes_http_json(
            connection,
            Method::GET,
            "/api/profiles/active",
            None,
            HTTP_TIMEOUT
        ),
    )?;
    map_profile_responses(&profiles, &active)
}

fn map_profile_responses(profiles: &Value, active: &Value) -> Result<(Vec<Value>, String), String> {
    let active_id = active
        .get("active")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "Incompatible Hermes gateway: GET /api/profiles/active did not return a non-empty active profile"
                .to_string()
        })?
        .to_string();
    let raw_profiles = profiles
        .get("profiles")
        .and_then(Value::as_array)
        .filter(|profiles| !profiles.is_empty())
        .ok_or_else(|| {
            "Incompatible Hermes gateway: GET /api/profiles did not return a non-empty profiles array"
                .to_string()
        })?;
    let rows = raw_profiles
        .iter()
        .map(|profile| {
            let name = profile
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    "Incompatible Hermes gateway: every /api/profiles entry must have a non-empty name"
                        .to_string()
                })?;
            Ok(json!({
                "id": name,
                "name": name,
                "isDefault": profile.get("is_default").and_then(Value::as_bool).unwrap_or(name == "default"),
                "connection": { "state": "connected" },
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    if !rows
        .iter()
        .any(|profile| profile.get("id").and_then(Value::as_str) == Some(active_id.as_str()))
    {
        return Err(format!(
            "Incompatible Hermes gateway: active profile '{active_id}' is absent from GET /api/profiles"
        ));
    }
    Ok((rows, active_id))
}

fn active_list_row_is_active(row: &Value) -> bool {
    // Current gateways expose an explicit `running` boolean. A newly-created
    // idle session is `status: waiting, running: false`.
    if let Some(running) = row.get("running").and_then(Value::as_bool) {
        return running;
    }
    matches!(
        row.get("status").and_then(Value::as_str),
        Some("starting" | "waiting" | "working" | "running" | "stalled")
    )
}

fn active_session_projection(row: &Value, profile: &str, stored_id: &str) -> Value {
    let mut projection = row.clone();
    if let Some(fields) = projection.as_object_mut() {
        fields.insert("id".to_string(), Value::String(stored_id.to_string()));
        fields.insert("profile".to_string(), Value::String(profile.to_string()));
    }
    projection
}

fn retain_owned_during_reconcile(
    key: &ScopeKey,
    profile: &str,
    global_scope: bool,
    active: &HashSet<ScopeKey>,
    controlled: &HashSet<ScopeKey>,
    starting: &HashSet<ScopeKey>,
    finalizing: &HashSet<ScopeKey>,
) -> bool {
    (!global_scope && key.0 != profile)
        || active.contains(key)
        || controlled.contains(key)
        || starting.contains(key)
        || finalizing.contains(key)
}

async fn reconcile_server_active(
    connection: &HermesGatewayConnection,
    profile: &str,
    backend: &WorkspaceBackend,
    global_scope: bool,
) -> Result<(), String> {
    let result = rpc_once(
        connection,
        "session.active_list",
        json!({ "current_session_id": "" }),
    )
    .await?;
    let rows = result
        .get("sessions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut active_keys = HashSet::new();
    let mut active_rows = HashMap::new();
    let mut runtime_pairs = Vec::new();
    for row in rows {
        let Some(stored_id) = row
            .get("session_key")
            .or_else(|| row.get("stored_session_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let is_active = active_list_row_is_active(&row);
        let explicit_profile = row
            .get("profile")
            .or_else(|| row.get("profile_name"))
            .or_else(|| row.get("info").and_then(|info| info.get("profile_name")))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let known_profile = backend
            .pending_sessions
            .lock()
            .ok()
            .and_then(|pending| {
                pending
                    .keys()
                    .find(|(_, id)| id == stored_id)
                    .map(|(profile, _)| profile.clone())
            })
            .or_else(|| {
                backend.runtimes.lock().ok().and_then(|runtimes| {
                    runtimes
                        .keys()
                        .find(|(_, id)| id == stored_id)
                        .map(|(profile, _)| profile.clone())
                })
            });
        let row_profile = if let Some(explicit_profile) = explicit_profile {
            explicit_profile.to_string()
        } else if let Some(known_profile) = known_profile {
            known_profile
        } else if global_scope {
            // A multiplexed Hermes gateway's active_list rows intentionally omit
            // profile. Resolve active rows through the public profile/session API;
            // falling back to the currently selected profile can make another
            // profile look idle and allow an unsafe instance switch or queue drain.
            if !is_active {
                continue;
            }
            super::locate_session_profile(connection, stored_id)
                .await
                .map(|(profile, _)| profile)?
        } else {
            profile.to_string()
        };
        let key = (row_profile.clone(), stored_id.to_string());
        if let Some(runtime) = row.get("id").and_then(Value::as_str) {
            runtime_pairs.push((key.clone(), runtime.to_string()));
        }
        if is_active {
            active_rows.insert(
                key.clone(),
                active_session_projection(&row, &row_profile, stored_id),
            );
            active_keys.insert(key);
        }
    }
    let controlled = backend
        .controls
        .lock()
        .map(|controls| controls.keys().cloned().collect::<HashSet<_>>())
        .unwrap_or_default();
    let starting = backend
        .starting
        .lock()
        .map(|starting| starting.clone())
        .unwrap_or_default();
    let finalizing = backend
        .finalizing
        .lock()
        .map(|finalizing| finalizing.clone())
        .unwrap_or_default();
    if let Ok(mut owned) = backend.owned_active.lock() {
        owned.retain(|key| {
            retain_owned_during_reconcile(
                key,
                profile,
                global_scope,
                &active_keys,
                &controlled,
                &starting,
                &finalizing,
            )
        });
    }
    if let Ok(mut active) = backend.server_active.lock() {
        if global_scope {
            active.clear();
        } else {
            active.retain(|key| key.0 != profile);
        }
        active.extend(active_keys.iter().cloned());
    }
    if let Ok(mut projections) = backend.server_active_rows.lock() {
        if global_scope {
            projections.clear();
        } else {
            projections.retain(|key, _| key.0 != profile);
        }
        projections.extend(active_rows);
    }
    if let Ok(mut runtimes) = backend.runtimes.lock() {
        runtimes.extend(runtime_pairs);
    }
    Ok(())
}

fn gateway_lists_all_profiles(backend: &HermesBackend) -> bool {
    backend
        .0
        .lock()
        .map(|state| state.config.remote)
        .unwrap_or(false)
}

async fn reconcile_running_profile_connections(
    backend: &HermesBackend,
    workspace: &WorkspaceBackend,
    skip_profile: &str,
) {
    if gateway_lists_all_profiles(backend) {
        return;
    }
    let connections = match super::running_hermes_gateway_connections(backend) {
        Ok(connections) => connections,
        Err(error) => {
            record_error(workspace, None, &error);
            return;
        }
    };
    let live_profiles = connections
        .iter()
        .map(|(profile, _)| profile.clone())
        .collect::<HashSet<_>>();
    discard_stopped_gateway_state(workspace, &live_profiles);
    for (profile, connection) in connections {
        if profile == skip_profile {
            continue;
        }
        if let Err(error) = reconcile_server_active(&connection, &profile, workspace, false).await {
            record_error(workspace, Some(&profile), &error);
        }
    }
}

fn discard_stopped_gateway_state(workspace: &WorkspaceBackend, live_profiles: &HashSet<String>) {
    if let Ok(mut values) = workspace.server_active.lock() {
        values.retain(|key| live_profiles.contains(&key.0));
    }
    if let Ok(mut values) = workspace.server_active_rows.lock() {
        values.retain(|key, _| live_profiles.contains(&key.0));
    }
    if let Ok(mut values) = workspace.owned_active.lock() {
        values.retain(|key| live_profiles.contains(&key.0));
    }
    if let Ok(mut values) = workspace.mirrored_active.lock() {
        values.retain(|key| live_profiles.contains(&key.0));
    }
    if let Ok(mut values) = workspace.starting.lock() {
        values.retain(|key| live_profiles.contains(&key.0));
    }
    if let Ok(mut values) = workspace.controls.lock() {
        values.retain(|key, _| live_profiles.contains(&key.0));
    }
    if let Ok(mut values) = workspace.runtimes.lock() {
        values.retain(|key, _| live_profiles.contains(&key.0));
    }
    if let Ok(mut values) = workspace.live_users.lock() {
        values.retain(|key, _| live_profiles.contains(&key.0));
    }
    if let Ok(mut values) = workspace.live_messages.lock() {
        values.retain(|key, _| live_profiles.contains(&key.0));
    }
    if let Ok(mut values) = workspace.pending_sessions.lock() {
        values.retain(|key, _| live_profiles.contains(&key.0));
    }
    if let Ok(mut values) = workspace.interactions.lock() {
        values.retain(|key, _| live_profiles.contains(&key.0));
    }
}

async fn sessions_for(
    connection: &HermesGatewayConnection,
    profile: Option<&str>,
    backend: &WorkspaceBackend,
    limit: usize,
    offset: usize,
) -> Result<(Vec<Value>, usize, usize), String> {
    let selected = profile.filter(|value| !value.is_empty());
    let path = api_path(
        "/api/profiles/sessions",
        &[
            ("limit", Some(limit.clamp(1, 500).to_string())),
            ("offset", Some(offset.to_string())),
            ("min_messages", Some("0".to_string())),
            ("archived", Some("include".to_string())),
            ("order", Some("recent".to_string())),
            ("profile", Some(selected.unwrap_or("all").to_string())),
            ("exclude_sources", Some("cron,schedule".to_string())),
        ],
    );
    let payload = hermes_http_json(connection, Method::GET, &path, None, HTTP_TIMEOUT).await?;
    let server_total = payload
        .get("total")
        .or_else(|| {
            payload
                .get("pagination")
                .and_then(|value| value.get("total"))
        })
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    let mut sessions = payload
        .get("sessions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|row| map_session(row, selected, backend))
        .collect::<Vec<_>>();
    let server_count = sessions.len();

    let mut known = sessions
        .iter()
        .filter_map(|session| {
            Some((
                session.get("profileId")?.as_str()?.to_string(),
                session.get("id")?.as_str()?.to_string(),
            ))
        })
        .collect::<HashSet<_>>();
    if offset == 0 {
        if let Ok(pending) = backend.pending_sessions.lock() {
            for ((pending_profile, id), pending) in pending.iter() {
                if selected.is_some_and(|scope| scope != pending_profile)
                    || known.contains(&(pending_profile.clone(), id.clone()))
                {
                    continue;
                }
                let turn_state =
                    session_turn_state(backend, &(pending_profile.clone(), id.clone()));
                sessions.push(json!({
                    "id": id,
                    "profileId": pending_profile,
                    "title": pending.title,
                    "source": "workspace",
                    "createdAt": pending.created_at,
                    "updatedAt": pending.created_at,
                    "archived": false,
                    "pinned": false,
                    "turnState": turn_state,
                    "branchParentId": pending.parent_session_id,
                    "parentSessionId": pending.parent_session_id,
                    "settings": pending.settings,
                }));
                known.insert((pending_profile.clone(), id.clone()));
            }
        }
        let active_keys = backend
            .server_active
            .lock()
            .map(|active| active.clone())
            .unwrap_or_default();
        let active_rows = backend
            .server_active_rows
            .lock()
            .map(|rows| rows.clone())
            .unwrap_or_default();
        for (key, row) in active_rows {
            if !active_keys.contains(&key)
                || selected.is_some_and(|scope| scope != key.0)
                || known.contains(&key)
            {
                continue;
            }
            sessions.push(map_session(&row, Some(&key.0), backend));
            known.insert(key);
        }
    }
    sessions.sort_by(|left, right| {
        right
            .get("updatedAt")
            .and_then(Value::as_str)
            .cmp(&left.get("updatedAt").and_then(Value::as_str))
    });
    let total = server_total.unwrap_or(offset + server_count);
    Ok((sessions, total, server_count))
}

async fn schedules_for(
    connection: &HermesGatewayConnection,
    profile: Option<&str>,
) -> Result<Vec<Value>, String> {
    let scope = profile.filter(|value| !value.is_empty()).unwrap_or("all");
    let payload = hermes_http_json(
        connection,
        Method::GET,
        &api_path("/api/cron/jobs", &[("profile", Some(scope.to_string()))]),
        None,
        HTTP_TIMEOUT,
    )
    .await?;
    let rows = payload
        .as_array()
        .or_else(|| payload.get("jobs").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();
    Ok(rows.iter().map(|job| map_schedule(job, profile)).collect())
}

fn map_models(payload: &Value) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for provider in payload
        .get("providers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let provider_id = provider
            .get("slug")
            .or_else(|| provider.get("id"))
            .or_else(|| provider.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        for model in provider
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = model
                .as_str()
                .or_else(|| model.get("id").and_then(Value::as_str))
                .or_else(|| model.get("name").and_then(Value::as_str))
                .unwrap_or_default();
            if id.is_empty() || !seen.insert(format!("{provider_id}\0{id}")) {
                continue;
            }
            let label = model
                .get("label")
                .or_else(|| model.get("name"))
                .and_then(Value::as_str)
                .unwrap_or(id);
            let provider_caps = provider.get("capabilities").and_then(|caps| caps.get(id));
            let supports_reasoning = model
                .get("capabilities")
                .or(provider_caps)
                .and_then(|caps| {
                    caps.get("reasoning")
                        .or_else(|| caps.get("supports_reasoning"))
                })
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let supports_fast = model
                .get("capabilities")
                .or(provider_caps)
                .and_then(|caps| caps.get("fast").or_else(|| caps.get("supports_fast")))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            models.push(json!({
                "id": id,
                "label": label,
                "provider": provider_id,
                "supportsFast": supports_fast,
                "reasoningEfforts": if supports_reasoning {
                    // Match Hermes' VALID_REASONING_EFFORTS. `none` is the
                    // session-scoped thinking-off value; the remaining values
                    // are the effort choices reported by current Hermes.
                    json!(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
                } else {
                    json!([])
                },
            }));
        }
    }
    if models.is_empty() {
        if let Some(id) = payload
            .get("model")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            models.push(json!({
                "id": id,
                "label": id,
                "provider": payload.get("provider").cloned().unwrap_or(Value::Null),
                "supportsFast": true,
                "reasoningEfforts": ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
            }));
        }
    }
    models
}

async fn model_choices(connection: &HermesGatewayConnection, profile: &str) -> Vec<Value> {
    let path = api_path(
        "/api/model/options",
        &[
            ("profile", Some(profile.to_string())),
            ("explicit_only", Some("1".to_string())),
        ],
    );
    match hermes_http_json(connection, Method::GET, &path, None, HTTP_TIMEOUT).await {
        Ok(payload) => map_models(&payload),
        Err(_) => Vec::new(),
    }
}

async fn personality_choices(connection: &HermesGatewayConnection, profile: &str) -> Vec<Value> {
    let config_path = api_path("/api/config", &[("profile", Some(profile.to_string()))]);
    let (config, defaults) = futures_util::join!(
        hermes_http_json(connection, Method::GET, &config_path, None, HTTP_TIMEOUT),
        hermes_http_json(
            connection,
            Method::GET,
            "/api/config/defaults",
            None,
            HTTP_TIMEOUT
        ),
    );
    let mut names = HashSet::new();
    for payload in [config.ok(), defaults.ok()].into_iter().flatten() {
        if let Some(personalities) = payload
            .get("agent")
            .and_then(|agent| agent.get("personalities"))
            .and_then(Value::as_object)
        {
            names.extend(personalities.keys().cloned());
        }
    }
    let mut names = names.into_iter().collect::<Vec<_>>();
    names.sort();
    names
        .into_iter()
        .map(|name| json!({ "id": name, "label": name }))
        .collect()
}

async fn rpc_once(
    connection: &HermesGatewayConnection,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let (mut socket, _) = connect_async(&connection.ws_url)
        .await
        .map_err(|error| format!("Could not connect to Hermes gateway: {error}"))?;
    rpc_on_socket(&mut socket, 1, method, params).await
}

async fn rpc_on_socket(
    socket: &mut GatewaySocket,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, String> {
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
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| format!("Hermes returned invalid JSON: {error}"))?;
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Hermes request failed")
                .to_string();
            if error.get("code").and_then(Value::as_i64) == Some(-32601) {
                return Err(format!("Unsupported Hermes RPC method {method}: {message}"));
            }
            return Err(message);
        }
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
    Err("Hermes gateway disconnected".to_string())
}

fn rpc_method_not_found(error: &str, method: &str) -> bool {
    if error.starts_with(&format!("Unsupported Hermes RPC method {method}:")) {
        return true;
    }
    // Compatibility with older gateway builds that omitted JSON-RPC codes.
    let normalized = error.trim().to_ascii_lowercase();
    normalized == "method not found"
        || normalized == format!("method '{method}' not found")
        || normalized == format!("unknown method: {method}")
}

fn reported_desktop_contract(result: &Value) -> u64 {
    result
        .get("info")
        .and_then(|info| info.get("desktop_contract"))
        .and_then(Value::as_u64)
        .unwrap_or_default()
}

fn incompatible_contract_error(reported: u64, version: Option<&str>) -> String {
    let version = version
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("unknown");
    let reported = if reported == 0 {
        "not reported".to_string()
    } else {
        reported.to_string()
    };
    format!(
        "Incompatible Hermes gateway version {version}: desktop contract {reported}; Ask Hermes requires {REQUIRED_DESKTOP_CONTRACT}. Update Hermes or derp-agent, then reconnect."
    )
}

fn validate_desktop_contract(result: &Value) -> Result<(), String> {
    let reported = reported_desktop_contract(result);
    if reported >= REQUIRED_DESKTOP_CONTRACT {
        return Ok(());
    }
    let version = result
        .get("info")
        .and_then(|info| info.get("version"))
        .and_then(Value::as_str);
    Err(incompatible_contract_error(reported, version))
}

async fn probe_desktop_contract(
    connection: &HermesGatewayConnection,
    profile: &str,
) -> Result<u64, String> {
    let (mut socket, _) = connect_async(&connection.ws_url)
        .await
        .map_err(|error| format!("Could not connect to Hermes gateway: {error}"))?;
    let active = rpc_on_socket(
        &mut socket,
        1,
        "session.active_list",
        json!({ "current_session_id": "" }),
    )
    .await?;
    if let Some(contract) = active
        .get("sessions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|session| session.get("info"))
        .filter_map(|info| info.get("desktop_contract"))
        .filter_map(Value::as_u64)
        .next()
    {
        return Ok(contract);
    }

    // No active session can report runtime info. Create a lazy session (Hermes
    // explicitly does not persist it before first prompt), then close it on the
    // same transport. close_on_disconnect also guarantees cleanup on failure.
    let created = rpc_on_socket(
        &mut socket,
        2,
        "session.create",
        json!({
            "source": "desktop",
            "profile": profile,
            "close_on_disconnect": true,
        }),
    )
    .await?;
    let contract = reported_desktop_contract(&created);
    if let Some(runtime) = created.get("session_id").and_then(Value::as_str) {
        rpc_on_socket(
            &mut socket,
            3,
            "session.close",
            json!({ "session_id": runtime }),
        )
        .await
        .map_err(|error| format!("Could not close Hermes compatibility probe: {error}"))?;
    }
    Ok(contract)
}

async fn ensure_gateway_contract(
    connection: &HermesGatewayConnection,
    profile: &str,
    status: &Value,
    workspace: &WorkspaceBackend,
    force_probe: bool,
) -> Result<(), String> {
    let version = status
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let cache_key = (profile.to_string(), version.to_string());
    if !force_probe
        && workspace
            .validated_contracts
            .lock()
            .map(|contracts| contracts.contains(&cache_key))
            .unwrap_or(false)
    {
        return Ok(());
    }
    let contract = probe_desktop_contract(connection, profile).await?;
    if contract < REQUIRED_DESKTOP_CONTRACT {
        return Err(incompatible_contract_error(contract, Some(version)));
    }
    workspace
        .validated_contracts
        .lock()
        .map_err(|_| "Workspace compatibility state is unavailable".to_string())?
        .insert(cache_key);
    Ok(())
}

fn rpc_error_reports_unknown_method(error: &Value) -> bool {
    if error.get("code").and_then(Value::as_i64) == Some(-32601) {
        return true;
    }
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    [
        "method not found",
        "unknown method",
        "unsupported method",
        "method is not supported",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

async fn rpc_method_supported(connection: &HermesGatewayConnection, method: &str) -> bool {
    let probe = async {
        let (mut socket, _) = connect_async(&connection.ws_url).await.ok()?;
        socket
            .send(Message::Text(
                json!({
                    "jsonrpc": "2.0", "id": 1, "method": method,
                    "params": { "session_id": "__ask_hermes_capability_probe__", "request_id": "__probe__" }
                })
                .to_string()
                .into(),
            ))
            .await
            .ok()?;
        while let Some(frame) = socket.next().await {
            let Message::Text(text) = frame.ok()? else {
                continue;
            };
            let response: Value = serde_json::from_str(&text).ok()?;
            if response.get("id").and_then(Value::as_u64) != Some(1) {
                continue;
            }
            return Some(
                response
                    .get("error")
                    .is_none_or(|error| !rpc_error_reports_unknown_method(error)),
            );
        }
        None
    };
    tokio::time::timeout(Duration::from_secs(5), probe)
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
}

async fn http_route_supported(connection: &HermesGatewayConnection, path: &str) -> bool {
    let client = match reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    let mut request = client.request(Method::OPTIONS, format!("{}{}", connection.http_url, path));
    if !connection.token.is_empty() {
        request = request.header("X-Hermes-Session-Token", &connection.token);
    }
    request
        .send()
        .await
        .map(|response| response.status().as_u16() != 404)
        .unwrap_or(false)
}

async fn http_method_supported(
    connection: &HermesGatewayConnection,
    path: &str,
    method: Method,
) -> bool {
    let client = match reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    let mut request = client.request(Method::OPTIONS, format!("{}{}", connection.http_url, path));
    if !connection.token.is_empty() {
        request = request.header("X-Hermes-Session-Token", &connection.token);
    }
    let Ok(response) = request.send().await else {
        return false;
    };
    if response.status().as_u16() == 404 {
        return false;
    }
    let Some(allowed) = response
        .headers()
        .get(reqwest::header::ALLOW)
        .and_then(|value| value.to_str().ok())
    else {
        // Legacy Hermes OPTIONS responses do not advertise Allow. Preserve
        // route-level compatibility until server capability manifests exist.
        return true;
    };
    allowed
        .split(',')
        .any(|allowed| allowed.trim().eq_ignore_ascii_case(method.as_str()))
}

async fn probe_optional_capabilities(
    connection: &HermesGatewayConnection,
    schedule_supported: bool,
) -> CapabilityFlags {
    let search_supported = hermes_http_json(
        connection,
        Method::GET,
        "/api/sessions/search?q=__ask_hermes_capability_probe__&limit=1",
        None,
        HTTP_TIMEOUT,
    )
    .await
    .is_ok();
    let probes: [bool; 15] = futures_util::future::join_all([
        http_method_supported(
            connection,
            "/api/sessions/__ask_hermes_capability_probe__",
            Method::PATCH,
        )
        .boxed(),
        http_method_supported(
            connection,
            "/api/sessions/__ask_hermes_capability_probe__",
            Method::DELETE,
        )
        .boxed(),
        rpc_method_supported(connection, "session.branch").boxed(),
        http_route_supported(
            connection,
            "/api/cron/jobs/__ask_hermes_capability_probe__/runs",
        )
        .boxed(),
        rpc_method_supported(connection, "image.attach_bytes").boxed(),
        rpc_method_supported(connection, "image.attach").boxed(),
        rpc_method_supported(connection, "image.detach").boxed(),
        rpc_method_supported(connection, "file.attach").boxed(),
        http_route_supported(connection, "/api/fs/read-data-url").boxed(),
        rpc_method_supported(connection, "clarify.respond").boxed(),
        rpc_method_supported(connection, "approval.respond").boxed(),
        rpc_method_supported(connection, "sudo.respond").boxed(),
        rpc_method_supported(connection, "secret.respond").boxed(),
        rpc_method_supported(connection, "prompt.submit").boxed(),
        rpc_method_supported(connection, "session.undo").boxed(),
    ])
    .await
    .try_into()
    .expect("capability probe count is fixed");
    let [archive, delete, branch, schedule_history, attach_bytes, attach_path, detach_image, attach_file, artifact_files, clarify, approval, sudo, secret, rewind, undo] =
        probes;
    CapabilityFlags {
        schedule: schedule_supported,
        schedule_history: schedule_supported && schedule_history,
        search: search_supported,
        archive,
        delete,
        branch,
        attachments: attach_bytes && attach_path && detach_image && attach_file,
        artifact_files,
        interactions: clarify && approval && sudo && secret,
        rewind,
        undo,
    }
}

async fn slash_commands(connection: &HermesGatewayConnection, profile: &str) -> Vec<Value> {
    let payload = match rpc_once(
        connection,
        "commands.catalog",
        json!({ "profile": profile }),
    )
    .await
    {
        Ok(payload) => payload,
        Err(_) => return Vec::new(),
    };
    let pairs = payload
        .get("pairs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let skill_count = payload
        .get("skill_count")
        .and_then(Value::as_u64)
        .unwrap_or_default() as usize;
    let allowed = [
        "/new",
        "/branch",
        "/title",
        "/model",
        "/resume",
        "/agents",
        "/background",
        "/compress",
        "/compact",
        "/goal",
        "/personality",
        "/queue",
        "/retry",
        "/status",
        "/steer",
        "/stop",
        "/interrupt",
        "/undo",
        "/usage",
        "/version",
    ]
    .into_iter()
    .collect::<HashSet<_>>();
    let skill_start = pairs.len().saturating_sub(skill_count);
    pairs
        .iter()
        .enumerate()
        .filter_map(|(index, pair)| {
            let values = pair.as_array()?;
            let name = values.first()?.as_str()?;
            if index < skill_start && !allowed.contains(name) {
                return None;
            }
            Some(json!({
                "name": name,
                "description": values.get(1).and_then(Value::as_str).unwrap_or_default(),
                "source": if index >= skill_start { "skill" } else { "gateway" },
            }))
        })
        .collect()
}

fn record_error(state: &WorkspaceBackend, profile: Option<&str>, error: &str) {
    if let Ok(mut errors) = state.last_errors.lock() {
        errors.insert(profile.unwrap_or("all").to_string(), error.to_string());
    }
}

#[tauri::command]
pub(crate) async fn workspace_bootstrap(
    app: AppHandle,
    request: InstanceScope,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request).await?;
    let connection = connection_for(&backend, None)?;
    let status = match status_for(&connection, None).await {
        Ok(status) => status,
        Err(error) => {
            record_error(&workspace, None, &error);
            return Err(error);
        }
    };
    let (profiles, active_profile) = profiles_for(&connection).await?;
    super::bind_unscoped_hermes_gateway_profile(&backend, &active_profile)?;
    if let Err(error) =
        ensure_gateway_contract(&connection, &active_profile, &status, &workspace, false).await
    {
        record_error(&workspace, Some(&active_profile), &error);
        return Err(error);
    }
    let _ = reconcile_server_active(
        &connection,
        &active_profile,
        &workspace,
        gateway_lists_all_profiles(&backend),
    )
    .await;
    reconcile_running_profile_connections(&backend, &workspace, &active_profile).await;
    recover_active_streams(&app).await;
    let (sessions, session_total, session_server_count) =
        sessions_for(&connection, None, &workspace, INITIAL_SESSION_LIMIT, 0).await?;
    let schedules_result = schedules_for(&connection, None).await;
    let schedule_supported = schedules_result.is_ok();
    let schedules = schedules_result.unwrap_or_default();
    let capability_flags = probe_optional_capabilities(&connection, schedule_supported).await;
    let (models, personalities, commands) = futures_util::join!(
        model_choices(&connection, &active_profile),
        personality_choices(&connection, &active_profile),
        slash_commands(&connection, &active_profile),
    );
    let (config, instance_generation) = backend
        .0
        .lock()
        .map(|backend| (backend.config.clone(), backend.generation))
        .map_err(|_| "Hermes gateway state is unavailable")?;
    let instance_id = configured_instance_id(&config);
    let instance = if config.remote {
        json!({
            "id": instance_id,
            "name": if config.instance_name.trim().is_empty() {
                "Existing Hermes instance".to_string()
            } else { config.instance_name.clone() },
            "kind": "existing",
            "address": format!("{}:{}", config.address, config.port),
        })
    } else {
        json!({
            "id": instance_id,
            "name": if config.instance_name.trim().is_empty() { "Automatic Hermes" } else { &config.instance_name },
            "kind": "automatic"
        })
    };
    let connection_info = connected_info(&status);
    recompute_active_work(&app, &workspace);
    Ok(json!({
        "instance": instance,
        "instanceGeneration": instance_generation,
        "connection": connection_info,
        "capabilities": capabilities(capability_flags),
        "profiles": profiles,
        "sessions": sessions,
        "sessionCursor": if session_server_count < session_total {
            Value::String(session_server_count.to_string())
        } else {
            Value::Null
        },
        "sessionTotal": session_total,
        "schedules": schedules,
        "activeProfileId": active_profile,
        "models": models,
        "personalities": personalities,
        "slashCommands": commands,
    }))
}

async fn workspace_refresh_inner(
    profile: Option<String>,
    backend: &HermesBackend,
    workspace: &WorkspaceBackend,
    renegotiate: bool,
) -> Result<Value, String> {
    let selected = profile.as_deref().filter(|value| !value.is_empty());
    let connection = connection_for(backend, selected)?;
    let status = status_for(&connection, selected).await?;
    let (profiles, active_profile) = profiles_for(&connection).await?;
    if selected.is_none() {
        super::bind_unscoped_hermes_gateway_profile(backend, &active_profile)?;
    }
    let live_profile = selected.unwrap_or(&active_profile);
    ensure_gateway_contract(&connection, live_profile, &status, workspace, renegotiate).await?;
    let _ = reconcile_server_active(
        &connection,
        live_profile,
        workspace,
        gateway_lists_all_profiles(backend),
    )
    .await;
    if selected.is_none() {
        reconcile_running_profile_connections(backend, workspace, live_profile).await;
    }
    let (sessions, session_total, session_server_count) =
        sessions_for(&connection, selected, workspace, INITIAL_SESSION_LIMIT, 0).await?;
    // Cron is optional. A server without schedule APIs is still a healthy chat
    // backend, so never turn this into a disconnected workspace refresh.
    let schedules = schedules_for(&connection, selected).await;
    let schedule_supported = schedules.is_ok();
    let mut refresh = json!({
        "connection": connected_info(&status),
        "profiles": profiles,
        "sessions": sessions,
        "sessionCursor": if session_server_count < session_total {
            Value::String(session_server_count.to_string())
        } else {
            Value::Null
        },
        "sessionTotal": session_total,
    });
    match schedules {
        Ok(schedules) => refresh["schedules"] = Value::Array(schedules),
        Err(error) => record_error(workspace, selected, &format!("Schedules: {error}")),
    }
    if renegotiate {
        refresh["capabilities"] =
            capabilities(probe_optional_capabilities(&connection, schedule_supported).await);
    }
    Ok(refresh)
}

#[tauri::command]
pub(crate) async fn workspace_refresh(
    app: AppHandle,
    request: ProfileRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let result =
        workspace_refresh_inner(request.profile_id.clone(), &backend, &workspace, false).await;
    if let Err(error) = &result {
        record_error(&workspace, request.profile_id.as_deref(), error);
    }
    if result.is_ok() {
        recover_active_streams(&app).await;
    }
    recompute_active_work(&app, &workspace);
    result
}

#[tauri::command]
pub(crate) async fn workspace_reconnect(
    app: AppHandle,
    request: ProfileRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let result = workspace_refresh_inner(request.profile_id, &backend, &workspace, true).await;
    if result.is_ok() {
        recover_active_streams(&app).await;
    }
    recompute_active_work(&app, &workspace);
    result
}

#[tauri::command]
pub(crate) async fn workspace_profile_options(
    request: ProfileRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let profile = profile_key(request.profile_id.as_deref().unwrap_or("default"));
    let connection = connection_for(&backend, Some(&profile))?;
    let (models, personalities, commands) = futures_util::join!(
        model_choices(&connection, &profile),
        personality_choices(&connection, &profile),
        slash_commands(&connection, &profile),
    );
    Ok(json!({
        "profileId": profile,
        "models": models,
        "personalities": personalities,
        "slashCommands": commands,
    }))
}

#[tauri::command]
pub(crate) async fn workspace_resolve_session_profile(
    request: ResolveSessionProfileRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let connection = connection_for(&backend, None)?;
    let (profile_id, _) = super::locate_session_profile(&connection, &request.session_id).await?;
    Ok(json!({ "profileId": profile_id }))
}

async fn session_summary_for(
    connection: &HermesGatewayConnection,
    profile: &str,
    session_id: &str,
    workspace: &WorkspaceBackend,
) -> Result<Value, String> {
    let key = (profile.to_string(), session_id.to_string());
    let pending_summary = |pending: PendingSession| {
        json!({
            "id": session_id,
            "profileId": profile,
            "title": pending.title,
            "source": "workspace",
            "createdAt": pending.created_at,
            "updatedAt": pending.created_at,
            "archived": false,
            "pinned": false,
            "turnState": session_turn_state(workspace, &key),
            "branchParentId": pending.parent_session_id,
            "parentSessionId": pending.parent_session_id,
            "settings": pending.settings,
        })
    };
    if let Some(pending) = workspace
        .pending_sessions
        .lock()
        .ok()
        .and_then(|pending| pending.get(&key).cloned())
    {
        return Ok(pending_summary(pending));
    }
    let detail = match session_detail(connection, profile, session_id).await {
        Ok(detail) => detail,
        Err(error)
            if workspace
                .runtimes
                .lock()
                .map(|runtimes| runtimes.contains_key(&key))
                .unwrap_or(false) =>
        {
            // session.create is intentionally not durable until first prompt.
            // After renderer/native restart, active_list still exposes its
            // runtime while REST correctly has no row yet. Rehydrate that
            // pending session so persisted drafts/queues can submit.
            let pending = PendingSession {
                title: "Untitled chat".to_string(),
                created_at: chrono::Utc::now().to_rfc3339(),
                settings: TurnSettings::default(),
                parent_session_id: None,
            };
            if let Ok(mut sessions) = workspace.pending_sessions.lock() {
                sessions.insert(key.clone(), pending.clone());
            }
            return Ok(pending_summary(pending));
        }
        Err(error) => return Err(error),
    };
    Ok(map_session(
        detail.get("session").unwrap_or(&detail),
        Some(profile),
        workspace,
    ))
}

#[tauri::command]
pub(crate) async fn workspace_session_summary(
    request: SessionRefRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let profile = profile_key(&request.profile_id);
    let connection = connection_for(&backend, Some(&profile))?;
    // A recovered queue must not be submitted into a turn owned by another
    // client. Refresh live state before deciding whether this row is idle.
    let _ = reconcile_server_active(
        &connection,
        &profile,
        &workspace,
        gateway_lists_all_profiles(&backend),
    )
    .await;
    session_summary_for(&connection, &profile, &request.session_id, &workspace).await
}

async fn profile_approval_mode(
    connection: &HermesGatewayConnection,
    profile: &str,
) -> Option<String> {
    let path = api_path("/api/config", &[("profile", Some(profile.to_string()))]);
    let payload = hermes_http_json(connection, Method::GET, &path, None, HTTP_TIMEOUT)
        .await
        .ok()?;
    payload
        .get("approvals")
        .and_then(|value| value.get("mode"))
        .or_else(|| {
            payload
                .get("config")
                .and_then(|value| value.get("approvals"))
                .and_then(|value| value.get("mode"))
        })
        .and_then(gateway_approval_mode)
}

fn cached_runtime_settings(workspace: &WorkspaceBackend, key: &ScopeKey) -> TurnSettings {
    workspace
        .server_active_rows
        .lock()
        .ok()
        .and_then(|rows| rows.get(key).cloned())
        .map(|row| turn_settings_from_row(&row))
        .unwrap_or_default()
}

fn cache_session_yolo(
    workspace: &WorkspaceBackend,
    key: &ScopeKey,
    yolo: bool,
    approval_mode: Option<&str>,
) {
    if let Ok(mut rows) = workspace.server_active_rows.lock() {
        if let Some(row) = rows.get_mut(key) {
            if !row.get("info").is_some_and(Value::is_object) {
                row["info"] = json!({});
            }
            row["info"]["yolo"] = Value::Bool(yolo);
            if let Some(mode) = approval_mode {
                row["info"]["approval_mode"] = Value::String(mode.to_string());
            }
        }
    }
    if let Ok(mut pending) = workspace.pending_sessions.lock() {
        if let Some(session) = pending.get_mut(key) {
            session.settings.yolo = Some(yolo);
            if let Some(mode) = approval_mode {
                session.settings.approval_mode = Some(mode.to_string());
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn workspace_set_session_yolo(
    request: SetSessionYoloRequest,
    app: AppHandle,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let profile = profile_key(&request.profile_id);
    let key = (profile.clone(), request.session_id.clone());
    let connection = connection_for(&backend, Some(&profile))?;

    // Refresh ownership before touching runtime transport. An active CLI or
    // Hermes Desktop turn must receive config.set by runtime id; session.resume
    // would rebind its live event stream to this process.
    let known_active = turn_is_active(&workspace, &key);
    let reconciliation = reconcile_server_active(
        &connection,
        &profile,
        &workspace,
        gateway_lists_all_profiles(&backend),
    )
    .await;
    if let Err(error) = reconciliation {
        // Cached local/prompt ownership is already enough to forbid resume.
        // Reconciliation is mandatory only before treating a session as idle.
        if !known_active {
            return Err(error);
        }
    }

    let mut observed = cached_runtime_settings(&workspace, &key);
    let params = json!({
        "key": "yolo",
        "scope": "session",
        "value": if request.enabled { "1" } else { "0" },
    });
    let result = if turn_is_active(&workspace, &key) {
        if let Some(result) = control_request(&workspace, &key, "config.set", params.clone()).await
        {
            result?
        } else {
            let runtime = server_runtime(&workspace, &key).ok_or_else(|| {
                "Hermes session is active, but its runtime is not available yet".to_string()
            })?;
            rpc_once(
                &connection,
                "config.set",
                json!({
                    "session_id": runtime,
                    "key": "yolo",
                    "scope": "session",
                    "value": if request.enabled { "1" } else { "0" },
                }),
            )
            .await?
        }
    } else {
        // Resuming an idle stored session is safe and yields its authoritative
        // session.info. Never use a stale cached runtime id here: Hermes treats
        // config.set without a matching live session as process-scoped state.
        let (mut socket, runtime, next_id, running, resume) =
            open_runtime_socket(&connection, &workspace, &profile, &request.session_id).await?;
        if running {
            return Err(
                "Hermes session became active while changing YOLO; try again after it settles"
                    .to_string(),
            );
        }
        observed = turn_settings_from_row(&resume);
        rpc_on_socket(
            &mut socket,
            next_id,
            "config.set",
            json!({
                "session_id": runtime,
                "key": "yolo",
                "scope": "session",
                "value": if request.enabled { "1" } else { "0" },
            }),
        )
        .await?
    };

    let session_yolo = result
        .get("value")
        .and_then(gateway_bool)
        .unwrap_or(request.enabled);
    let approval_mode = match observed.approval_mode {
        Some(mode) => Some(mode),
        None => profile_approval_mode(&connection, &profile).await,
    };
    // session.info reports effective state: profile mode `off` keeps YOLO on
    // even when the per-session override is cleared.
    let effective_yolo = session_yolo || approval_mode.as_deref() == Some("off");
    cache_session_yolo(&workspace, &key, effective_yolo, approval_mode.as_deref());
    let settings = TurnSettings {
        approval_mode: approval_mode.clone(),
        yolo: Some(effective_yolo),
        ..TurnSettings::default()
    };
    workspace_event(
        &app,
        json!({
            "type": "session-settings",
            "profileId": profile,
            "sessionId": request.session_id,
            "settings": settings,
        }),
    );
    Ok(json!({
        "yolo": effective_yolo,
        "approvalMode": approval_mode,
    }))
}

#[tauri::command]
pub(crate) async fn workspace_list_sessions(
    request: SessionPageRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let profile = request
        .profile_id
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "all");
    let offset = request
        .cursor
        .as_deref()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or_default();
    let limit = request.limit.clamp(1, 200);
    let connection = connection_for(&backend, profile)?;
    let (sessions, total, server_count) =
        sessions_for(&connection, profile, &workspace, limit, offset).await?;
    let next = offset + server_count;
    Ok(json!({
        "sessions": sessions,
        "total": total,
        "cursor": if next < total { Value::String(next.to_string()) } else { Value::Null },
    }))
}

async fn session_detail(
    connection: &HermesGatewayConnection,
    profile: &str,
    session_id: &str,
) -> Result<Value, String> {
    let path = api_path(
        &format!("/api/sessions/{}", percent_encode(session_id)),
        &[("profile", Some(profile.to_string()))],
    );
    hermes_http_json(connection, Method::GET, &path, None, HTTP_TIMEOUT).await
}

async fn raw_messages(
    connection: &HermesGatewayConnection,
    profile: &str,
    session_id: &str,
    limit: usize,
    offset: usize,
) -> Result<Vec<Value>, String> {
    let path = api_path(
        &format!("/api/sessions/{}/messages", percent_encode(session_id)),
        &[
            ("profile", Some(profile.to_string())),
            ("limit", Some(limit.clamp(1, 500).to_string())),
            ("offset", Some(offset.to_string())),
        ],
    );
    let payload = hermes_http_json(connection, Method::GET, &path, None, HTTP_TIMEOUT).await?;
    Ok(payload
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

async fn raw_messages_through(
    connection: &HermesGatewayConnection,
    profile: &str,
    session_id: &str,
    message_id: &str,
) -> Result<Vec<Value>, String> {
    let detail = session_detail(connection, profile, session_id).await?;
    let count = detail
        .get("message_count")
        .and_then(Value::as_u64)
        .unwrap_or_default() as usize;
    let mut rows = Vec::with_capacity(count.min(1_000));
    let mut offset = 0;
    loop {
        let limit = if count > offset {
            (count - offset).min(500)
        } else {
            500
        };
        let page = raw_messages(connection, profile, session_id, limit, offset).await?;
        let returned = page.len();
        if let Some(index) = page
            .iter()
            .position(|message| message_id_matches(message, message_id))
        {
            rows.extend(page.into_iter().take(index + 1));
            return Ok(rows);
        }
        rows.extend(page);
        if returned == 0 || returned < limit || (count > 0 && rows.len() >= count) {
            break;
        }
        offset += returned;
    }
    Err("Could not find the selected message".to_string())
}

fn merge_live_snapshot(
    backend: &WorkspaceBackend,
    key: &ScopeKey,
    mut messages: Vec<Value>,
) -> Vec<Value> {
    if !turn_is_active(backend, key) {
        return messages;
    }
    if let Ok(users) = backend.live_users.lock() {
        if let Some(user) = users.get(key) {
            let duplicate = messages.iter().any(|message| {
                message.get("role").and_then(Value::as_str) == Some("user")
                    && message.get("content") == user.get("content")
            });
            if !duplicate {
                messages.push(user.clone());
            }
        }
    }
    if let Ok(live) = backend.live_messages.lock() {
        if let Some(message) = live.get(key) {
            let value = message.value();
            if let Some(index) = messages.iter().position(|existing| {
                existing.get("id").and_then(Value::as_str) == Some(message.id.as_str())
            }) {
                messages[index] = value;
            } else {
                messages.push(value);
            }
        }
    }
    messages
}

fn history_page_window(count: usize, limit: usize, before: Option<usize>) -> (usize, usize) {
    let boundary = before.unwrap_or(count).min(count);
    if boundary == 0 {
        return (0, 0);
    }
    let page_limit = limit.clamp(1, 500).min(boundary);
    (boundary.saturating_sub(page_limit), page_limit)
}

#[tauri::command]
pub(crate) async fn workspace_list_messages(
    request: MessagePageRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let connection = connection_for(&backend, Some(&request.profile_id))?;
    let key = (request.profile_id.clone(), request.session_id.clone());
    let pending = workspace
        .pending_sessions
        .lock()
        .map(|pending| pending.contains_key(&key))
        .unwrap_or(false);
    if pending {
        return Ok(json!({
            "messages": merge_live_snapshot(&workspace, &key, Vec::new()),
            "hasOlder": false
        }));
    }
    let limit = request.limit.clamp(1, 500);
    let detail = session_detail(&connection, &request.profile_id, &request.session_id).await?;
    let count = detail
        .get("message_count")
        .and_then(Value::as_u64)
        .unwrap_or_default() as usize;
    // `before` is an exclusive history index. This avoids overlapping pages:
    // 120 rows at 50/page => [70..120], [20..70], [0..20].
    let boundary = request
        .before
        .as_deref()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(count)
        .min(count);
    if boundary == 0 {
        return Ok(json!({
            "messages": merge_live_snapshot(&workspace, &key, Vec::new()),
            "olderCursor": Value::Null,
            "hasOlder": false,
        }));
    }
    let (mut offset, mut page_limit) = history_page_window(count, limit, Some(boundary));

    if request.before.is_none() {
        if let Some(anchor) = request.around_message_id.as_deref() {
            // REST has offset pagination only. Locate the requested DB message
            // lazily in this selected transcript, then center a page around it.
            let mut scan_offset = 0;
            let mut found = false;
            'scan: while scan_offset < count {
                let chunk = raw_messages(
                    &connection,
                    &request.profile_id,
                    &request.session_id,
                    500,
                    scan_offset,
                )
                .await?;
                for (index, row) in chunk.iter().enumerate() {
                    if message_id_matches(row, anchor) {
                        offset = (scan_offset + index).saturating_sub(limit / 2);
                        page_limit = limit.min(count.saturating_sub(offset).max(1));
                        found = true;
                        break 'scan;
                    }
                }
                if chunk.len() < 500 {
                    break;
                }
                scan_offset += chunk.len();
            }
            if !found {
                return Err("Could not load the resolved search message. The chat changed after search; run the search again.".to_string());
            }
        }
    }

    let rows = raw_messages(
        &connection,
        &request.profile_id,
        &request.session_id,
        page_limit,
        offset,
    )
    .await?;
    let mut messages = map_messages(&rows, &request.profile_id, &request.session_id);
    apply_session_usage(&mut messages, &detail);
    let messages = merge_live_snapshot(&workspace, &key, messages);
    Ok(json!({
        "messages": messages,
        "olderCursor": if offset > 0 { Value::String(offset.to_string()) } else { Value::Null },
        "hasOlder": offset > 0,
    }))
}

fn parse_iso_filter(
    value: Option<&str>,
    inclusive_end_of_day: bool,
) -> Option<chrono::DateTime<chrono::Utc>> {
    value.and_then(|value| {
        if let Ok(time) = chrono::DateTime::parse_from_rfc3339(value) {
            return Some(time.with_timezone(&chrono::Utc));
        }
        let date = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
        let time = if inclusive_end_of_day {
            chrono::NaiveTime::from_hms_nano_opt(23, 59, 59, 999_999_999)?
        } else {
            chrono::NaiveTime::MIN
        };
        Some(chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(
            date.and_time(time),
            chrono::Utc,
        ))
    })
}

fn search_snippet_segments(snippet: &str) -> Vec<String> {
    let cleaned = snippet.replace(">>>", "").replace("<<<", "");
    cleaned
        .replace('\u{2026}', "...")
        .split("...")
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .map(|segment| segment.to_lowercase())
        .collect()
}

fn search_hit_message_id(hit: &Value) -> Option<String> {
    [
        "message_id",
        "messageId",
        "match_message_id",
        "matchMessageId",
        "around_message_id",
        "aroundMessageId",
        "id",
    ]
    .into_iter()
    .find_map(|field| {
        let value = hit.get(field)?;
        if value.is_null() {
            return None;
        }
        let id = value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| value.to_string());
        (!id.trim().is_empty()).then_some(id)
    })
}

fn raw_message_id(row: &Value) -> Option<String> {
    let value = row.get("id")?;
    if value.is_null() {
        return None;
    }
    let id = value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string());
    (!id.trim().is_empty()).then_some(id)
}

fn ordered_search_segments_match(text: &str, segments: &[String]) -> bool {
    if segments.is_empty() {
        return false;
    }
    let mut offset = 0;
    for segment in segments {
        let Some(found) = text[offset..].find(segment) else {
            return false;
        };
        offset += found + segment.len();
    }
    true
}

fn search_query_terms(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .filter(|term| !matches!(term.to_ascii_uppercase().as_str(), "AND" | "OR" | "NOT"))
        .map(|term| {
            term.trim_matches(|character| matches!(character, '"' | '\'' | '(' | ')'))
                .trim_end_matches('*')
                .to_lowercase()
        })
        .filter(|term| !term.is_empty())
        .collect()
}

fn search_row_match_level(
    row: &Value,
    role: Option<&str>,
    snippet_segments: &[String],
    query_terms: &[String],
) -> u8 {
    if role.is_some_and(|role| row.get("role").and_then(Value::as_str) != Some(role)) {
        return 0;
    }
    let text = value_text(row.get("content").or_else(|| row.get("text"))).to_lowercase();
    if ordered_search_segments_match(&text, snippet_segments) {
        return 2;
    }
    if !query_terms.is_empty() && query_terms.iter().all(|term| text.contains(term)) {
        return 1;
    }
    0
}

async fn resolve_search_hit_message_id(
    connection: &HermesGatewayConnection,
    profile: &str,
    session_id: &str,
    role: Option<&str>,
    excerpt: &str,
    query: &str,
) -> Result<String, String> {
    let snippet_segments = search_snippet_segments(excerpt);
    let query_terms = search_query_terms(query);
    let mut query_candidate: Option<String> = None;
    let mut query_is_ambiguous = false;
    let mut previous_page_signature: Option<(Option<String>, Option<String>, usize)> = None;
    let mut offset = 0;

    loop {
        let rows = raw_messages(
            connection,
            profile,
            session_id,
            SEARCH_RESOLVE_PAGE_ROWS,
            offset,
        )
        .await?;
        let returned = rows.len();
        let signature = (
            rows.first().and_then(raw_message_id),
            rows.last().and_then(raw_message_id),
            returned,
        );
        if returned == SEARCH_RESOLVE_PAGE_ROWS
            && previous_page_signature.as_ref() == Some(&signature)
        {
            return Err("Hermes did not advance message pagination while resolving this search result. Open the chat normally or reconnect and try again.".to_string());
        }
        previous_page_signature = Some(signature);

        for row in &rows {
            let Some(message_id) = raw_message_id(row) else {
                continue;
            };
            match search_row_match_level(row, role, &snippet_segments, &query_terms) {
                // Exact snippet context is deterministic in Gateway transcript
                // order. Return immediately; no unrelated transcript is read.
                2 => return Ok(message_id),
                1 if query_candidate.as_deref().is_none_or(|id| id == message_id) => {
                    query_candidate = Some(message_id);
                }
                1 => query_is_ambiguous = true,
                _ => {}
            }
        }
        if returned < SEARCH_RESOLVE_PAGE_ROWS {
            break;
        }
        offset = offset.checked_add(returned).ok_or_else(|| {
            "Hermes message pagination overflowed while resolving this search result".to_string()
        })?;
    }

    if !query_is_ambiguous {
        if let Some(message_id) = query_candidate {
            return Ok(message_id);
        }
    }
    Err("Could not locate this search match in the selected chat. It may be in compacted history. Refine the search query or open the chat normally.".to_string())
}

#[tauri::command]
pub(crate) async fn workspace_search(
    request: SearchRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let requested_profile = request
        .profile_id
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "all");
    let base_connection = connection_for(&backend, requested_profile)?;
    let profiles = if let Some(profile) = requested_profile {
        vec![profile.to_string()]
    } else {
        let (profiles, active_profile) = profiles_for(&base_connection).await?;
        super::bind_unscoped_hermes_gateway_profile(&backend, &active_profile)?;
        profiles
            .into_iter()
            .filter_map(|profile| {
                profile
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect()
    };
    let offset = request
        .cursor
        .as_deref()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or_default();
    let fetch_limit = 100;
    let from = parse_iso_filter(request.filters.from.as_deref(), false);
    let to = parse_iso_filter(request.filters.to.as_deref(), true);
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    let mut truncated = false;
    let query_folded = request.query.trim().to_lowercase();
    for profile in profiles {
        let connection = connection_for(&backend, Some(&profile))?;
        let mut metadata = Vec::new();
        let mut session_offset = 0;
        loop {
            let remaining = SEARCH_METADATA_LIMIT.saturating_sub(session_offset);
            if remaining == 0 {
                truncated = true;
                break;
            }
            let metadata_page = remaining.min(100);
            let session_payload = hermes_http_json(
                &connection,
                Method::GET,
                &api_path(
                    "/api/profiles/sessions",
                    &[
                        ("limit", Some(metadata_page.to_string())),
                        ("offset", Some(session_offset.to_string())),
                        ("min_messages", Some("0".to_string())),
                        ("archived", Some("include".to_string())),
                        ("order", Some("recent".to_string())),
                        ("profile", Some(profile.clone())),
                    ],
                ),
                None,
                HTTP_TIMEOUT,
            )
            .await?;
            let rows = session_payload
                .get("sessions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let returned = rows.len();
            metadata.extend(rows);
            session_offset += returned;
            let total = session_payload
                .get("total")
                .or_else(|| {
                    session_payload
                        .get("pagination")
                        .and_then(|value| value.get("total"))
                })
                .and_then(Value::as_u64)
                .map(|value| value as usize);
            if returned < metadata_page || total.is_some_and(|total| session_offset >= total) {
                break;
            }
            if session_offset >= SEARCH_METADATA_LIMIT {
                truncated = true;
                break;
            }
        }
        let by_id = metadata
            .iter()
            .filter_map(|row| Some((row.get("id")?.as_str()?.to_string(), row)))
            .collect::<HashMap<_, _>>();
        let path = api_path(
            "/api/sessions/search",
            &[
                ("q", Some(request.query.clone())),
                ("limit", Some(fetch_limit.to_string())),
                ("profile", Some(profile.clone())),
            ],
        );
        let payload = hermes_http_json(&connection, Method::GET, &path, None, HTTP_TIMEOUT).await?;
        let hits = payload
            .get("results")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        // Current Hermes caps this endpoint at 100 and exposes no cursor. Tell
        // clients results may be partial instead of pretending pagination is complete.
        truncated |= hits.len() >= fetch_limit;
        for hit in &hits {
            let Some(session_id) = hit.get("session_id").and_then(Value::as_str) else {
                continue;
            };
            let owned_detail;
            let detail = if let Some(detail) = by_id.get(session_id).copied() {
                detail
            } else {
                owned_detail = session_detail(&connection, &profile, session_id).await?;
                &owned_detail
            };
            let archived = detail
                .get("archived")
                .and_then(Value::as_bool)
                .unwrap_or_else(|| {
                    detail
                        .get("archived")
                        .and_then(Value::as_i64)
                        .unwrap_or_default()
                        != 0
                });
            if (archived && !request.filters.include_archived)
                || (!archived && !request.filters.include_active)
            {
                continue;
            }
            let source = source_name(detail.get("source").and_then(Value::as_str));
            if request
                .filters
                .source
                .as_deref()
                .is_some_and(|wanted| wanted != source)
            {
                continue;
            }
            let timestamp_text = unix_or_iso(
                detail
                    .get("last_active")
                    .or_else(|| hit.get("session_started"))
                    .or_else(|| detail.get("started_at")),
            );
            if let Ok(timestamp) = chrono::DateTime::parse_from_rfc3339(&timestamp_text) {
                let timestamp = timestamp.with_timezone(&chrono::Utc);
                if from.is_some_and(|from| timestamp < from) || to.is_some_and(|to| timestamp > to)
                {
                    continue;
                }
            }
            let title = detail
                .get("title")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .unwrap_or("Untitled chat");
            let message_id = search_hit_message_id(hit);
            let resolver =
                if message_id.is_none() && hit.get("role").and_then(Value::as_str).is_some() {
                    json!({
                        "kind": "message",
                        "query": request.query.trim(),
                        "excerpt": hit.get("snippet").and_then(Value::as_str).unwrap_or_default(),
                        "role": hit.get("role").cloned().unwrap_or(Value::Null),
                    })
                } else {
                    Value::Null
                };
            let result_key = format!(
                "{profile}\0{session_id}\0{}",
                message_id.as_deref().unwrap_or(&format!(
                    "snippet:{}",
                    hit.get("snippet").map(Value::to_string).unwrap_or_default()
                ))
            );
            if !seen.insert(result_key) {
                continue;
            }
            results.push(json!({
                "sessionId": session_id,
                "profileId": profile,
                "messageId": message_id,
                "resolver": resolver,
                "title": title,
                "excerpt": hit.get("snippet").and_then(Value::as_str).unwrap_or_default(),
                "source": source,
                "archived": archived,
                "timestamp": timestamp_text,
            }));
        }

        // Hermes search covers transcript FTS but older gateways do not index
        // session titles. Merge title matches from session metadata only; never
        // scan transcripts or build a local index.
        if !query_folded.is_empty() {
            for detail in &metadata {
                let Some(session_id) = detail.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let title = detail
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("Untitled chat");
                if !title.to_lowercase().contains(&query_folded) {
                    continue;
                }
                let archived = detail
                    .get("archived")
                    .and_then(Value::as_bool)
                    .unwrap_or_else(|| {
                        detail
                            .get("archived")
                            .and_then(Value::as_i64)
                            .unwrap_or_default()
                            != 0
                    });
                if (archived && !request.filters.include_archived)
                    || (!archived && !request.filters.include_active)
                {
                    continue;
                }
                let source = source_name(detail.get("source").and_then(Value::as_str));
                if request
                    .filters
                    .source
                    .as_deref()
                    .is_some_and(|wanted| wanted != source)
                {
                    continue;
                }
                let timestamp_text = unix_or_iso(
                    detail
                        .get("last_active")
                        .or_else(|| detail.get("started_at")),
                );
                if let Ok(timestamp) = chrono::DateTime::parse_from_rfc3339(&timestamp_text) {
                    let timestamp = timestamp.with_timezone(&chrono::Utc);
                    if from.is_some_and(|from| timestamp < from)
                        || to.is_some_and(|to| timestamp > to)
                    {
                        continue;
                    }
                }
                if !seen.insert(format!("{profile}\0{session_id}\0title")) {
                    continue;
                }
                results.push(json!({
                    "sessionId": session_id,
                    "profileId": profile,
                    "messageId": Value::Null,
                    "resolver": Value::Null,
                    "title": title,
                    "excerpt": title,
                    "source": source,
                    "archived": archived,
                    "timestamp": timestamp_text,
                }));
            }
        }
    }
    results.sort_by(|left, right| {
        right
            .get("timestamp")
            .and_then(Value::as_str)
            .cmp(&left.get("timestamp").and_then(Value::as_str))
    });
    let page = results
        .iter()
        .skip(offset)
        .take(request.limit)
        .cloned()
        .collect::<Vec<_>>();
    let next = offset + page.len();
    Ok(json!({
        "results": page,
        "cursor": if next < results.len() { Value::String(next.to_string()) } else { Value::Null },
        "truncated": truncated,
    }))
}

#[tauri::command]
pub(crate) async fn workspace_resolve_search_hit(
    request: ResolveSearchHitRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let connection = connection_for(&backend, Some(&request.profile_id))?;
    let message_id = match request.resolver {
        SearchHitResolver::Message {
            query,
            excerpt,
            role,
        } => {
            resolve_search_hit_message_id(
                &connection,
                &request.profile_id,
                &request.session_id,
                role.as_deref(),
                &excerpt,
                &query,
            )
            .await?
        }
    };
    Ok(json!({ "messageId": message_id }))
}

async fn create_gateway_session(
    connection: &HermesGatewayConnection,
    profile: &str,
    settings: &TurnSettings,
    messages: Option<Vec<Value>>,
    parent_session_id: Option<&str>,
) -> Result<(String, String), String> {
    let mut params = json!({
        "source": "desktop",
        "profile": profile,
        "model": settings.model.clone().unwrap_or_default(),
        "provider": settings.provider.clone().unwrap_or_default(),
        "reasoning_effort": settings.reasoning_effort.clone().unwrap_or_default(),
    });
    if let Some(fast) = settings.fast {
        params["fast"] = Value::Bool(fast);
    }
    if let Some(messages) = messages {
        params["messages"] = Value::Array(messages);
    }
    if let Some(parent) = parent_session_id {
        params["parent_session_id"] = Value::String(parent.to_string());
    }
    let result = rpc_once(connection, "session.create", params).await?;
    validate_desktop_contract(&result)?;
    let runtime_id = result
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Hermes did not return a runtime session ID".to_string())?
        .to_string();
    let stored_id = result
        .get("stored_session_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(&runtime_id)
        .to_string();
    Ok((runtime_id, stored_id))
}

#[tauri::command]
pub(crate) async fn workspace_create_session(
    request: CreateSessionRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let profile = profile_key(&request.profile_id);
    let settings = request.settings.unwrap_or_default();
    let connection = connection_for(&backend, Some(&profile))?;
    let (runtime_id, stored_id) =
        create_gateway_session(&connection, &profile, &settings, None, None).await?;
    let key = (profile.clone(), stored_id.clone());
    workspace
        .runtimes
        .lock()
        .map_err(|_| "Workspace runtime state is unavailable")?
        .insert(key.clone(), runtime_id);
    workspace
        .pending_sessions
        .lock()
        .map_err(|_| "Workspace session state is unavailable")?
        .insert(
            key,
            PendingSession {
                title: "Untitled chat".to_string(),
                created_at: chrono::Utc::now().to_rfc3339(),
                settings,
                parent_session_id: None,
            },
        );
    Ok(json!({ "sessionId": stored_id }))
}

#[tauri::command]
pub(crate) async fn workspace_resolve_handoff_destination(
    request: ResolveHandoffDestinationRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<HandoffDestination, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let handoff_id = request.handoff_id.trim();
    if handoff_id.is_empty() {
        return Err("Workspace handoff ID cannot be empty".to_string());
    }
    let profile = profile_key(&request.profile_id);
    if profile.is_empty() {
        return Err("Workspace handoff requires a profile".to_string());
    }

    // Keep this async lock for destination resolution and creation. If the
    // workspace renderer reloads while session.create is in flight, its retry
    // waits here and receives the exact same destination.
    let mut destinations = workspace.handoff_destinations.lock().await;
    if let Some(destination) = destinations.get(handoff_id) {
        return Ok(destination.clone());
    }

    if let Some(session_id) = request
        .session_id
        .filter(|session_id| !session_id.trim().is_empty())
    {
        let destination = HandoffDestination {
            profile_id: profile,
            session_id,
            created: false,
        };
        destinations.insert(handoff_id.to_string(), destination.clone());
        return Ok(destination);
    }

    let settings = TurnSettings::default();
    let connection = connection_for(&backend, Some(&profile))?;
    let (runtime_id, stored_id) =
        create_gateway_session(&connection, &profile, &settings, None, None).await?;
    let destination = HandoffDestination {
        profile_id: profile.clone(),
        session_id: stored_id.clone(),
        created: true,
    };
    // Record immediately after session.create, before refresh or any renderer
    // work which may fail and trigger a retry.
    destinations.insert(handoff_id.to_string(), destination.clone());
    drop(destinations);

    let key = (profile, stored_id);
    workspace
        .runtimes
        .lock()
        .map_err(|_| "Workspace runtime state is unavailable")?
        .insert(key.clone(), runtime_id);
    workspace
        .pending_sessions
        .lock()
        .map_err(|_| "Workspace session state is unavailable")?
        .insert(
            key,
            PendingSession {
                title: "Untitled chat".to_string(),
                created_at: chrono::Utc::now().to_rfc3339(),
                settings,
                parent_session_id: None,
            },
        );
    Ok(destination)
}

#[tauri::command]
pub(crate) async fn workspace_session_action(
    request: SessionActionRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<(), String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let key = (request.profile_id.clone(), request.session_id.clone());
    if let SessionAction::Pin { pinned } = &request.action {
        let _ = pinned;
        return Err("Gateway does not expose session pin mutation".to_string());
    }

    let pending = workspace
        .pending_sessions
        .lock()
        .map(|pending| pending.contains_key(&key))
        .unwrap_or(false);
    if pending {
        match request.action {
            SessionAction::Rename { title } => {
                if let Ok(mut sessions) = workspace.pending_sessions.lock() {
                    if let Some(session) = sessions.get_mut(&key) {
                        session.title = title;
                    }
                }
            }
            SessionAction::Archive | SessionAction::Delete => {
                if turn_is_active(&workspace, &key) || session_has_queue(&workspace, &key) {
                    return Err("Stop the active turn and clear its queue first".to_string());
                }
                if let Some(runtime) = workspace
                    .runtimes
                    .lock()
                    .ok()
                    .and_then(|runtimes| runtimes.get(&key).cloned())
                {
                    let connection = connection_for(&backend, Some(&request.profile_id))?;
                    rpc_once(
                        &connection,
                        "session.close",
                        json!({ "session_id": runtime }),
                    )
                    .await?;
                }
                clear_session_state(&workspace, &key);
            }
            SessionAction::Restore => {}
            SessionAction::Pin { .. } => unreachable!(),
        }
        return Ok(());
    }

    let connection = connection_for(&backend, Some(&request.profile_id))?;
    if matches!(
        &request.action,
        SessionAction::Archive | SessionAction::Delete
    ) {
        reconcile_server_active(
            &connection,
            &request.profile_id,
            &workspace,
            gateway_lists_all_profiles(&backend),
        )
        .await
        .map_err(|error| format!("Could not verify live session state: {error}"))?;
    }
    if matches!(
        &request.action,
        SessionAction::Archive | SessionAction::Delete
    ) && (turn_is_active(&workspace, &key) || session_has_queue(&workspace, &key))
    {
        return Err("Stop the active turn and clear its queue first".to_string());
    }
    let path = api_path(
        &format!("/api/sessions/{}", percent_encode(&request.session_id)),
        &[("profile", Some(request.profile_id.clone()))],
    );
    match request.action {
        SessionAction::Rename { title } => {
            hermes_http_json(
                &connection,
                Method::PATCH,
                &path,
                Some(json!({ "title": title, "profile": request.profile_id })),
                HTTP_TIMEOUT,
            )
            .await?;
        }
        SessionAction::Archive | SessionAction::Restore => {
            let archived = matches!(request.action, SessionAction::Archive);
            hermes_http_json(
                &connection,
                Method::PATCH,
                &path,
                Some(json!({ "archived": archived, "profile": request.profile_id })),
                HTTP_TIMEOUT,
            )
            .await?;
        }
        SessionAction::Delete => {
            let detail =
                session_detail(&connection, &request.profile_id, &request.session_id).await?;
            let archived = detail
                .get("archived")
                .and_then(Value::as_bool)
                .unwrap_or_else(|| {
                    detail
                        .get("archived")
                        .and_then(Value::as_i64)
                        .unwrap_or_default()
                        != 0
                });
            if !archived {
                return Err("Archive the chat before deleting it permanently".to_string());
            }
            hermes_http_json(&connection, Method::DELETE, &path, None, HTTP_TIMEOUT).await?;
            clear_session_state(&workspace, &key);
        }
        SessionAction::Pin { .. } => unreachable!(),
    }
    Ok(())
}

fn clear_session_state(workspace: &WorkspaceBackend, key: &ScopeKey) {
    if let Ok(mut values) = workspace.pending_sessions.lock() {
        values.remove(key);
    }
    if let Ok(mut values) = workspace.runtimes.lock() {
        values.remove(key);
    }
    if let Ok(mut values) = workspace.starting.lock() {
        values.remove(key);
    }
    if let Ok(mut values) = workspace.finalizing.lock() {
        values.remove(key);
    }
    if let Ok(mut values) = workspace.controls.lock() {
        values.remove(key);
    }
    if let Ok(mut values) = workspace.server_active.lock() {
        values.remove(key);
    }
    if let Ok(mut values) = workspace.server_active_rows.lock() {
        values.remove(key);
    }
    if let Ok(mut values) = workspace.owned_active.lock() {
        values.remove(key);
    }
    if let Ok(mut values) = workspace.mirrored_active.lock() {
        values.remove(key);
    }
    if let Ok(mut values) = workspace.live_users.lock() {
        values.remove(key);
    }
    if let Ok(mut values) = workspace.live_messages.lock() {
        values.remove(key);
    }
    if let Ok(mut values) = workspace.client_states.lock() {
        values.remove(key);
    }
    if let Ok(mut values) = workspace.pins.lock() {
        values.remove(key);
    }
    if let Ok(mut values) = workspace.interactions.lock() {
        values.retain(|(profile, session, _), _| profile != &key.0 || session != &key.1);
    }
}

fn active_row_profile(row: &Value) -> Option<&str> {
    row.get("profile")
        .or_else(|| row.get("profile_name"))
        .or_else(|| row.get("info").and_then(|info| info.get("profile_name")))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn active_row_stored_id(row: &Value) -> Option<&str> {
    row.get("session_key")
        .or_else(|| row.get("stored_session_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn active_runtime_for_stored(result: &Value, profile: &str, stored_id: &str) -> Option<String> {
    result
        .get("sessions")
        .and_then(Value::as_array)?
        .iter()
        .find(|row| {
            active_row_stored_id(row) == Some(stored_id)
                && active_row_profile(row).is_none_or(|value| value == profile)
        })
        .and_then(|row| row.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn active_stored_for_runtime(result: &Value, profile: &str, runtime_id: &str) -> Option<String> {
    result
        .get("sessions")
        .and_then(Value::as_array)?
        .iter()
        .find(|row| {
            row.get("id").and_then(Value::as_str) == Some(runtime_id)
                && active_row_profile(row).is_none_or(|value| value == profile)
        })
        .and_then(active_row_stored_id)
        .map(str::to_string)
}

async fn branch_whole_gateway_session(
    connection: &HermesGatewayConnection,
    profile: &str,
    stored_id: &str,
) -> Result<(String, String, String), String> {
    let (mut socket, _) = connect_async(&connection.ws_url)
        .await
        .map_err(|error| format!("Could not connect to Hermes gateway: {error}"))?;
    let mut id = 1;
    let active = rpc_on_socket(
        &mut socket,
        id,
        "session.active_list",
        json!({ "current_session_id": "" }),
    )
    .await?;
    let parent_runtime =
        if let Some(runtime) = active_runtime_for_stored(&active, profile, stored_id) {
            // Branching an already-live runtime on this separate transport leaves its
            // current owner attached. Calling session.resume here would steal it.
            runtime
        } else {
            id += 1;
            let resumed = rpc_on_socket(
                &mut socket,
                id,
                "session.resume",
                json!({
                    "session_id": stored_id,
                    "source": "desktop",
                    "profile": profile,
                }),
            )
            .await?;
            validate_desktop_contract(&resumed)?;
            resumed
                .get("session_id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Hermes did not return a runtime session ID".to_string())?
                .to_string()
        };

    id += 1;
    let branched = rpc_on_socket(
        &mut socket,
        id,
        "session.branch",
        json!({ "session_id": parent_runtime }),
    )
    .await?;
    let branch_runtime = branched
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Hermes did not return the branched runtime session ID".to_string())?
        .to_string();
    let title = branched
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("Branched chat")
        .to_string();

    let mut branch_stored = branched
        .get("session_key")
        .or_else(|| branched.get("stored_session_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if branch_stored.is_none() {
        id += 1;
        let active = rpc_on_socket(
            &mut socket,
            id,
            "session.active_list",
            json!({ "current_session_id": branch_runtime }),
        )
        .await?;
        branch_stored = active_stored_for_runtime(&active, profile, &branch_runtime);
    }
    let branch_stored = branch_stored.ok_or_else(|| {
        "Hermes did not expose the branched stored session ID in session.active_list".to_string()
    })?;

    // session.branch currently returns only a runtime ID. Resolve its stored key
    // through active_list, then verify it against the requested profile's REST
    // namespace before exposing it to workspace state.
    let detail = session_detail(connection, profile, &branch_stored).await?;
    if let Some(actual_profile) = detail
        .get("profile")
        .or_else(|| detail.get("profile_name"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        if actual_profile != profile {
            return Err(format!(
                "Hermes returned branched session {branch_stored} for profile {actual_profile}, expected {profile}"
            ));
        }
    }
    Ok((branch_runtime, branch_stored, title))
}

#[tauri::command]
pub(crate) async fn workspace_branch_session(
    request: BranchSessionRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let connection = connection_for(&backend, Some(&request.profile_id))?;
    let (runtime_id, stored_id, title) = if let Some(message_id) = request.message_id.as_deref() {
        let messages = raw_messages_through(
            &connection,
            &request.profile_id,
            &request.session_id,
            message_id,
        )
        .await
        .map_err(|error| {
            if error == "Could not find the selected message" {
                "Could not find the selected branch message".to_string()
            } else {
                error
            }
        })?;
        let seeds = messages
            .iter()
            .map(|message| {
                json!({
                    "role": message.get("role").and_then(Value::as_str).unwrap_or("system"),
                    "content": message.get("content").or_else(|| message.get("text")).cloned().unwrap_or(Value::Null),
                    "tool_calls": message.get("tool_calls").cloned().unwrap_or(Value::Null),
                    "tool_call_id": message.get("tool_call_id").cloned().unwrap_or(Value::Null),
                    "name": message.get("name").cloned().unwrap_or(Value::Null),
                })
            })
            .collect::<Vec<_>>();
        let (runtime, stored) = create_gateway_session(
            &connection,
            &request.profile_id,
            &TurnSettings::default(),
            Some(seeds),
            Some(&request.session_id),
        )
        .await?;
        (runtime, stored, "Branched chat".to_string())
    } else {
        branch_whole_gateway_session(&connection, &request.profile_id, &request.session_id).await?
    };
    let key = (request.profile_id.clone(), stored_id.clone());
    workspace
        .runtimes
        .lock()
        .map_err(|_| "Workspace runtime state is unavailable")?
        .insert(key.clone(), runtime_id);
    workspace
        .pending_sessions
        .lock()
        .map_err(|_| "Workspace session state is unavailable")?
        .insert(
            key,
            PendingSession {
                title,
                created_at: chrono::Utc::now().to_rfc3339(),
                settings: TurnSettings::default(),
                parent_session_id: Some(request.session_id),
            },
        );
    Ok(json!({ "sessionId": stored_id }))
}

async fn active_row_for_stored_session(
    connection: &HermesGatewayConnection,
    active: &Value,
    workspace: &WorkspaceBackend,
    profile: &str,
    stored_id: &str,
) -> Result<Option<Value>, String> {
    let rows = active
        .get("sessions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let candidates = rows
        .into_iter()
        .filter(|row| active_row_stored_id(row) == Some(stored_id))
        .collect::<Vec<_>>();
    if let Some(row) = candidates
        .iter()
        .find(|row| active_row_profile(row) == Some(profile))
    {
        return Ok(Some((*row).clone()));
    }
    let Some(row) = candidates
        .into_iter()
        .find(|row| active_row_profile(row).is_none())
    else {
        return Ok(None);
    };
    let key = (profile.to_string(), stored_id.to_string());
    if workspace
        .pending_sessions
        .lock()
        .map(|pending| pending.contains_key(&key))
        .unwrap_or(false)
    {
        return Ok(Some(row));
    }
    // Multiplexed existing-instance gateways may omit profile from active_list.
    // Resolve the durable key through public profile/session APIs before
    // attributing activity, otherwise a stale row can poison another profile.
    let (resolved_profile, _) = super::locate_session_profile(connection, stored_id).await?;
    Ok((resolved_profile == profile).then_some(row))
}

async fn open_runtime_socket_with_policy(
    connection: &HermesGatewayConnection,
    workspace: &WorkspaceBackend,
    profile: &str,
    stored_id: &str,
    resume_active_owned_turn: bool,
) -> Result<(GatewaySocket, String, u64, bool, Value), String> {
    let (mut socket, _) = connect_async(&connection.ws_url)
        .await
        .map_err(|error| format!("Could not connect to Hermes gateway: {error}"))?;
    let key = (profile.to_string(), stored_id.to_string());
    let active = rpc_on_socket(
        &mut socket,
        1,
        "session.active_list",
        json!({ "current_session_id": "" }),
    )
    .await?;
    if let Some(row) =
        active_row_for_stored_session(connection, &active, workspace, profile, stored_id).await?
    {
        if let Some(runtime) = row
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            let runtime = runtime.to_string();
            if let Ok(mut runtimes) = workspace.runtimes.lock() {
                runtimes.insert(key.clone(), runtime.clone());
            }
            if active_list_row_is_active(&row) {
                if let Ok(mut active) = workspace.server_active.lock() {
                    active.insert(key.clone());
                }
                if let Ok(mut rows) = workspace.server_active_rows.lock() {
                    rows.insert(
                        key.clone(),
                        active_session_projection(&row, profile, stored_id),
                    );
                }
                if !resume_active_owned_turn {
                    // Direct RPCs can safely address this runtime on the fresh
                    // socket. session.resume would rebind its event transport
                    // away from Hermes Desktop, CLI, or compact prompt.
                    return Ok((socket, runtime, 2, true, row));
                }
            }
        }
    }
    // session.create happens on a short-lived RPC connection. Every new
    // transport must explicitly resume/activate the stored key; a runtime id
    // cached from another socket does not bind this socket to that session.
    let result = rpc_on_socket(
        &mut socket,
        2,
        "session.resume",
        json!({
            "session_id": stored_id,
            "source": "desktop",
            "profile": profile,
        }),
    )
    .await?;
    validate_desktop_contract(&result)?;
    let runtime = result
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Hermes did not return a runtime session ID".to_string())?
        .to_string();
    let running = active_list_row_is_active(&result)
        || result.get("inflight").is_some_and(|value| !value.is_null());
    workspace
        .runtimes
        .lock()
        .map_err(|_| "Workspace runtime state is unavailable")?
        .insert(key, runtime.clone());
    Ok((socket, runtime, 3, running, result))
}

async fn open_runtime_socket(
    connection: &HermesGatewayConnection,
    workspace: &WorkspaceBackend,
    profile: &str,
    stored_id: &str,
) -> Result<(GatewaySocket, String, u64, bool, Value), String> {
    open_runtime_socket_with_policy(connection, workspace, profile, stored_id, false).await
}

fn workspace_event(app: &AppHandle, value: Value) {
    let _ = app.emit("workspace-event", value);
}

fn has_authoritative_live_work(workspace: &WorkspaceBackend) -> bool {
    workspace
        .starting
        .lock()
        .map(|starting| !starting.is_empty())
        .unwrap_or(true)
        || workspace
            .finalizing
            .lock()
            .map(|finalizing| !finalizing.is_empty())
            .unwrap_or(true)
        || workspace
            .controls
            .lock()
            .map(|controls| !controls.is_empty())
            .unwrap_or(true)
        || workspace
            .server_active
            .lock()
            .map(|active| !active.is_empty())
            .unwrap_or(true)
        || workspace
            .owned_active
            .lock()
            .map(|active| !active.is_empty())
            .unwrap_or(true)
        || workspace
            .mirrored_active
            .lock()
            .map(|active| !active.is_empty())
            .unwrap_or(true)
}

fn recompute_active_work(app: &AppHandle, workspace: &WorkspaceBackend) {
    let live = has_authoritative_live_work(workspace);
    let queued = workspace
        .client_states
        .lock()
        .map(|states| states.values().any(|state| !state.queue.is_empty()))
        .unwrap_or(true);
    app.state::<WorkspaceActiveWork>()
        .set("workspace-backend", live || queued);
}

/// Refreshes Gateway-owned activity while the caller already owns the
/// instance-operation write lock. This is used by instance configuration;
/// taking the public read-guarded wrapper there would deadlock.
pub(crate) async fn refresh_authoritative_active_work_locked(
    app: &AppHandle,
) -> Result<bool, String> {
    let backend = app.state::<HermesBackend>();
    let workspace = app.state::<WorkspaceBackend>();
    if gateway_lists_all_profiles(&backend) {
        let connection = connection_for(&backend, None)?;
        let (_, active_profile) = profiles_for(&connection).await?;
        reconcile_server_active(&connection, &active_profile, &workspace, true).await?;
    } else {
        let connections = super::running_hermes_gateway_connections(&backend)?;
        let live_profiles = connections
            .iter()
            .map(|(profile, _)| profile.clone())
            .collect::<HashSet<_>>();
        discard_stopped_gateway_state(&workspace, &live_profiles);
        for (profile, connection) in connections {
            reconcile_server_active(&connection, &profile, &workspace, false).await?;
        }
    }
    recompute_active_work(app, &workspace);
    Ok(app.state::<WorkspaceActiveWork>().any())
}

/// Refreshes Gateway-owned activity before destructive choices such as Quit.
/// Holding the read side for the complete gateway/reconcile lifetime prevents
/// an old-instance preflight from writing its activity into caches after an
/// instance switch resets them.
pub(crate) async fn refresh_authoritative_active_work(app: &AppHandle) -> Result<bool, String> {
    let workspace = app.state::<WorkspaceBackend>();
    let _instance_operation = begin_current_instance_operation(&workspace).await;
    refresh_authoritative_active_work_locked(app).await
}

fn recoverable_active_keys(
    server_active: &HashSet<ScopeKey>,
    owned_active: &HashSet<ScopeKey>,
) -> Vec<ScopeKey> {
    server_active.intersection(owned_active).cloned().collect()
}

async fn recover_active_streams(app: &AppHandle) {
    let workspace = app.state::<WorkspaceBackend>();
    let backend = app.state::<HermesBackend>();
    let owned = workspace
        .owned_active
        .lock()
        .map(|active| active.clone())
        .unwrap_or_default();
    let keys = workspace
        .server_active
        .lock()
        .map(|active| recoverable_active_keys(&active, &owned))
        .unwrap_or_default();
    for key in keys {
        let reserved = if let Ok(mut starting) = workspace.starting.lock() {
            let controlled = workspace
                .controls
                .lock()
                .map(|controls| controls.contains_key(&key))
                .unwrap_or(true);
            let mirrored = workspace
                .mirrored_active
                .lock()
                .map(|active| active.contains(&key))
                .unwrap_or(true);
            let finalizing = workspace
                .finalizing
                .lock()
                .map(|active| active.contains(&key))
                .unwrap_or(true);
            if starting.contains(&key) || controlled || mirrored || finalizing {
                false
            } else {
                starting.insert(key.clone());
                true
            }
        } else {
            false
        };
        if !reserved {
            continue;
        }
        let connection = match connection_for(&backend, Some(&key.0)) {
            Ok(connection) => connection,
            Err(error) => {
                record_error(&workspace, Some(&key.0), &error);
                if let Ok(mut starting) = workspace.starting.lock() {
                    starting.remove(&key);
                }
                continue;
            }
        };
        match open_runtime_socket_with_policy(&connection, &workspace, &key.0, &key.1, true).await {
            Ok((socket, runtime, next_id, true, resume)) => {
                let (sender, receiver) = mpsc::unbounded_channel();
                if let Ok(mut controls) = workspace.controls.lock() {
                    controls.insert(key.clone(), sender);
                }
                if let Ok(mut starting) = workspace.starting.lock() {
                    starting.remove(&key);
                }
                if let Some(user_text) = resume
                    .get("inflight")
                    .and_then(|inflight| inflight.get("user"))
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                {
                    let user = json!({
                        "id": format!("recovered-user-{}", key.1),
                        "sessionId": key.1,
                        "profileId": key.0,
                        "role": "user",
                        "content": user_text,
                        "createdAt": chrono::Utc::now().to_rfc3339(),
                        "status": "complete",
                        "attachments": [],
                    });
                    let inserted = workspace
                        .live_users
                        .lock()
                        .map(|mut users| {
                            if users.contains_key(&key) {
                                false
                            } else {
                                users.insert(key.clone(), user.clone());
                                true
                            }
                        })
                        .unwrap_or(false);
                    if inserted {
                        workspace_event(app, json!({ "type": "message-upsert", "message": user }));
                    }
                }
                let mut live = workspace
                    .live_messages
                    .lock()
                    .ok()
                    .and_then(|messages| messages.get(&key).cloned())
                    .unwrap_or_else(|| {
                        LiveMessage::new(&key.0, &key.1, &format!("recovered-{}", key.1))
                    });
                if let Some(inflight) = resume.get("inflight") {
                    let assistant = inflight
                        .get("assistant")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if assistant.len() >= live.content.len() {
                        live.content = assistant.to_string();
                    }
                }
                live.status = "streaming".to_string();
                live.error = None;
                if let Ok(mut messages) = workspace.live_messages.lock() {
                    messages.insert(key.clone(), live.clone());
                }
                workspace_event(
                    app,
                    json!({
                        "type": "turn-state", "profileId": key.0,
                        "sessionId": key.1, "state": "running",
                    }),
                );
                live.emit_upsert(app);
                tauri::async_runtime::spawn(stream_turn(
                    app.clone(),
                    socket,
                    key,
                    runtime,
                    next_id,
                    u64::MAX,
                    receiver,
                    live,
                ));
            }
            Ok((_, _, _, false, _)) => {
                if let Ok(mut active) = workspace.server_active.lock() {
                    active.remove(&key);
                }
                if let Ok(mut active) = workspace.owned_active.lock() {
                    active.remove(&key);
                }
                if let Ok(mut starting) = workspace.starting.lock() {
                    starting.remove(&key);
                }
            }
            Err(error) => {
                record_error(&workspace, Some(&key.0), &error);
                if let Ok(mut starting) = workspace.starting.lock() {
                    starting.remove(&key);
                }
            }
        }
    }
    recompute_active_work(app, &workspace);
}

async fn control_request(
    workspace: &WorkspaceBackend,
    key: &ScopeKey,
    method: &str,
    params: Value,
) -> Option<Result<Value, String>> {
    let sender = workspace
        .controls
        .lock()
        .ok()
        .and_then(|controls| controls.get(key).cloned())?;
    let (response, receiver) = oneshot::channel();
    if sender
        .send(ControlRequest {
            method: method.to_string(),
            params,
            response,
        })
        .is_err()
    {
        return Some(Err("Hermes turn control channel is closed".to_string()));
    }
    Some(
        receiver
            .await
            .unwrap_or_else(|_| Err("Hermes turn control response was lost".to_string())),
    )
}

#[derive(Clone)]
struct LiveMessage {
    id: String,
    profile: String,
    session_id: String,
    content: String,
    created_at: String,
    status: String,
    tools: Vec<Value>,
    interactions: Vec<Value>,
    context_tokens: Option<u64>,
    total_tokens: Option<u64>,
    error: Option<String>,
}

impl LiveMessage {
    fn new(profile: &str, session_id: &str, entry_id: &str) -> Self {
        Self {
            id: format!("assistant-{entry_id}"),
            profile: profile.to_string(),
            session_id: session_id.to_string(),
            content: String::new(),
            created_at: chrono::Utc::now().to_rfc3339(),
            status: "streaming".to_string(),
            tools: Vec::new(),
            interactions: Vec::new(),
            context_tokens: None,
            total_tokens: None,
            error: None,
        }
    }

    fn value(&self) -> Value {
        json!({
            "id": self.id,
            "sessionId": self.session_id,
            "profileId": self.profile,
            "role": "assistant",
            "content": self.content,
            "createdAt": self.created_at,
            "status": self.status,
            "tools": self.tools,
            "interactions": self.interactions,
            "contextTokens": self.context_tokens,
            "totalTokens": self.total_tokens,
            "error": self.error,
        })
    }

    fn emit_upsert(&self, app: &AppHandle) {
        workspace_event(
            app,
            json!({ "type": "message-upsert", "message": self.value() }),
        );
    }
}

pub(crate) fn mirror_prompt_started(
    app: &AppHandle,
    profile: &str,
    stored_id: &str,
    runtime_id: &str,
    exchange_id: &str,
    prompt: &str,
    image_data_urls: &[String],
) {
    let workspace = app.state::<WorkspaceBackend>();
    let key = (profile.to_string(), stored_id.to_string());
    if let Ok(mut runtimes) = workspace.runtimes.lock() {
        runtimes.insert(key.clone(), runtime_id.to_string());
    }
    if let Ok(mut active) = workspace.mirrored_active.lock() {
        active.insert(key.clone());
    }
    let created_at = chrono::Utc::now().to_rfc3339();
    let attachments = image_data_urls
        .iter()
        .enumerate()
        .map(|(index, data_url)| {
            let mime_type = data_url
                .strip_prefix("data:")
                .and_then(|value| value.split_once(';').map(|(mime, _)| mime))
                .filter(|mime| mime.starts_with("image/"))
                .unwrap_or("image/png");
            let encoded_len = data_url
                .split_once(',')
                .map(|(_, encoded)| encoded.len())
                .unwrap_or_default();
            json!({
                "id": format!("prompt-image-{exchange_id}-{index}"),
                "name": format!("Image {}", index + 1),
                "mimeType": mime_type,
                "size": encoded_len.saturating_mul(3) / 4,
                "state": "ready",
                "previewUrl": data_url,
            })
        })
        .collect::<Vec<_>>();
    let user = json!({
        "id": format!("prompt-user-{exchange_id}"),
        "sessionId": stored_id,
        "profileId": profile,
        "role": "user",
        "content": prompt,
        "createdAt": created_at,
        "status": "complete",
        "attachments": attachments,
    });
    if let Ok(mut users) = workspace.live_users.lock() {
        users.insert(key.clone(), user.clone());
    }
    let live = LiveMessage::new(profile, stored_id, &format!("prompt-{exchange_id}"));
    if let Ok(mut messages) = workspace.live_messages.lock() {
        messages.insert(key.clone(), live.clone());
    }
    if let Ok(mut pending) = workspace.pending_sessions.lock() {
        pending.entry(key.clone()).or_insert(PendingSession {
            title: "Untitled chat".to_string(),
            created_at,
            settings: TurnSettings::default(),
            parent_session_id: None,
        });
    }
    workspace_event(app, json!({ "type": "message-upsert", "message": user }));
    live.emit_upsert(app);
    workspace_event(
        app,
        json!({
            "type": "turn-state", "profileId": profile,
            "sessionId": stored_id, "state": "running",
        }),
    );
    recompute_active_work(app, &workspace);
}

pub(crate) fn mirror_prompt_event(
    app: &AppHandle,
    profile: &str,
    stored_id: &str,
    event_type: &str,
    payload: &Value,
) -> bool {
    let workspace = app.state::<WorkspaceBackend>();
    let key = (profile.to_string(), stored_id.to_string());
    let mut live = workspace
        .live_messages
        .lock()
        .ok()
        .and_then(|messages| messages.get(&key).cloned())
        .unwrap_or_else(|| LiveMessage::new(profile, stored_id, "prompt-live"));
    let finished = gateway_event(app, &workspace, &mut live, event_type, payload);
    if finished {
        mirror_prompt_ended(app, profile, stored_id, live.error.as_deref());
    }
    finished
}

pub(crate) fn mirror_prompt_ended(
    app: &AppHandle,
    profile: &str,
    stored_id: &str,
    error: Option<&str>,
) {
    let workspace = app.state::<WorkspaceBackend>();
    let key = (profile.to_string(), stored_id.to_string());
    if let Ok(mut active) = workspace.mirrored_active.lock() {
        active.remove(&key);
    }
    if let Ok(mut pending) = workspace.pending_sessions.lock() {
        pending.remove(&key);
    }
    if let Some(error) = error {
        if let Ok(mut messages) = workspace.live_messages.lock() {
            if let Some(message) = messages.get_mut(&key) {
                message.status = "error".to_string();
                message.error = Some(error.to_string());
                message.emit_upsert(app);
            }
        }
    }
    // Prompt images are only transient previews for the other window. Drop
    // cached user/message copies once authoritative gateway history can load.
    if let Ok(mut users) = workspace.live_users.lock() {
        users.remove(&key);
    }
    if let Ok(mut messages) = workspace.live_messages.lock() {
        messages.remove(&key);
    }
    workspace_event(
        app,
        json!({
            "type": "turn-state", "profileId": profile, "sessionId": stored_id,
            "state": if error.is_some() { "error" } else { "idle" },
            "error": error,
        }),
    );
    workspace_event(
        app,
        json!({ "type": "snapshot-invalidated", "profileId": profile }),
    );
    recompute_active_work(app, &workspace);
}

fn update_tool(message: &mut LiveMessage, payload: &Value, event_type: &str) {
    let id = payload
        .get("tool_id")
        .or_else(|| payload.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
        });
    let status = if event_type.contains("failed")
        || event_type.contains("error")
        || payload.get("error").is_some_and(|value| !value.is_null())
    {
        "error"
    } else if event_type.contains("complete") || event_type.contains("result") {
        "complete"
    } else {
        "running"
    };
    let tool = json!({
        "id": id,
        "name": payload.get("name").and_then(Value::as_str).unwrap_or("tool"),
        "status": status,
        "summary": payload.get("summary").or_else(|| payload.get("context")).cloned().unwrap_or(Value::Null),
        "input": payload.get("input").or_else(|| payload.get("arguments")).map(|v| value_text(Some(v))).unwrap_or_default(),
        "output": payload.get("output").or_else(|| payload.get("result")).map(|v| value_text(Some(v))).unwrap_or_default(),
    });
    if let Some(index) = message
        .tools
        .iter()
        .position(|existing| existing.get("id").and_then(Value::as_str) == Some(id))
    {
        message.tools[index] = tool;
    } else {
        message.tools.push(tool);
    }
}

fn cache_live_message(workspace: &WorkspaceBackend, message: &LiveMessage) {
    if let Ok(mut live) = workspace.live_messages.lock() {
        live.insert(
            (message.profile.clone(), message.session_id.clone()),
            message.clone(),
        );
    }
}

fn gateway_event(
    app: &AppHandle,
    workspace: &WorkspaceBackend,
    message: &mut LiveMessage,
    event_type: &str,
    payload: &Value,
) -> bool {
    match event_type {
        "message.start" => message.emit_upsert(app),
        "message.delta" => {
            let delta = value_text(payload.get("text"));
            if !delta.is_empty() {
                message.content.push_str(&delta);
                workspace_event(
                    app,
                    json!({
                        "type": "message-delta",
                        "profileId": message.profile,
                        "sessionId": message.session_id,
                        "messageId": message.id,
                        "delta": delta,
                    }),
                );
            }
        }
        "message.interim" => {
            let text = value_text(payload.get("text"));
            if !text.is_empty() && message.content.is_empty() {
                message.content = text;
                message.emit_upsert(app);
            }
        }
        "message.complete" => {
            let text = value_text(payload.get("text").or_else(|| payload.get("rendered")));
            if !text.is_empty() {
                message.content = text;
            }
            message.status = if payload.get("status").and_then(Value::as_str) == Some("error") {
                "error".to_string()
            } else {
                "complete".to_string()
            };
            if let Some(usage) = payload.get("usage") {
                message.context_tokens = usage
                    .get("context_used")
                    .or_else(|| usage.get("context"))
                    .and_then(Value::as_u64);
                message.total_tokens = usage.get("total").and_then(Value::as_u64);
            }
            cache_live_message(workspace, message);
            message.emit_upsert(app);
            return true;
        }
        event if event.starts_with("tool.") => {
            update_tool(message, payload, event);
            message.emit_upsert(app);
        }
        "clarify.request" => {
            let id = payload
                .get("request_id")
                .and_then(Value::as_str)
                .unwrap_or("clarification")
                .to_string();
            let mut choice_map = HashMap::new();
            let options = payload
                .get("choices")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
                .filter_map(|(index, choice)| {
                    let label = choice.as_str()?.to_string();
                    let option_id = format!("choice-{index}");
                    choice_map.insert(option_id.clone(), label.clone());
                    Some(json!({ "id": option_id, "label": label }))
                })
                .collect::<Vec<_>>();
            if let Ok(mut interactions) = workspace.interactions.lock() {
                interactions.insert(
                    (
                        message.profile.clone(),
                        message.session_id.clone(),
                        id.clone(),
                    ),
                    PendingInteraction::Clarification {
                        choices: choice_map,
                    },
                );
            }
            let interaction = json!({
                "id": id,
                "kind": "clarification",
                "title": payload.get("question").and_then(Value::as_str).unwrap_or("Hermes needs input"),
                "options": options,
                "allowText": true,
            });
            message.interactions.push(interaction.clone());
            workspace_event(
                app,
                json!({
                    "type": "interaction",
                    "profileId": message.profile,
                    "sessionId": message.session_id,
                    "messageId": message.id,
                    "interaction": interaction,
                }),
            );
        }
        "approval.request" => {
            let id = payload
                .get("request_id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("approval-{}", message.id));
            if let Ok(mut interactions) = workspace.interactions.lock() {
                interactions.insert(
                    (
                        message.profile.clone(),
                        message.session_id.clone(),
                        id.clone(),
                    ),
                    PendingInteraction::Approval,
                );
            }
            let allowed_choices = payload
                .get("choices")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_else(|| {
                    vec![
                        json!("once"),
                        json!("session"),
                        json!("always"),
                        json!("deny"),
                    ]
                });
            let options = allowed_choices
                .iter()
                .filter_map(Value::as_str)
                .map(|choice| {
                    let label = match choice {
                        "once" => "Approve once",
                        "session" => "Approve for session",
                        "always" => "Always approve",
                        "deny" => "Deny",
                        other => other,
                    };
                    json!({ "id": choice, "label": label })
                })
                .collect::<Vec<_>>();
            let interaction = json!({
                "id": id,
                "kind": "approval",
                "title": payload.get("description").and_then(Value::as_str).unwrap_or("Approve action?"),
                "body": payload.get("command").cloned().unwrap_or(Value::Null),
                "options": options,
                "allowText": false,
            });
            message.interactions.push(interaction.clone());
            workspace_event(
                app,
                json!({
                    "type": "interaction",
                    "profileId": message.profile,
                    "sessionId": message.session_id,
                    "messageId": message.id,
                    "interaction": interaction,
                }),
            );
        }
        "sudo.request" | "secret.request" => {
            let id = payload
                .get("request_id")
                .and_then(Value::as_str)
                .unwrap_or("sensitive-input")
                .to_string();
            let is_sudo = event_type == "sudo.request";
            if let Ok(mut interactions) = workspace.interactions.lock() {
                interactions.insert(
                    (
                        message.profile.clone(),
                        message.session_id.clone(),
                        id.clone(),
                    ),
                    PendingInteraction::Sensitive {
                        method: if is_sudo {
                            "sudo.respond"
                        } else {
                            "secret.respond"
                        },
                        value_key: if is_sudo { "password" } else { "value" },
                    },
                );
            }
            let interaction = json!({
                "id": id,
                "kind": "clarification",
                "title": if is_sudo { "Administrator password required" } else { "Secret value required" },
                "body": payload.get("prompt").or_else(|| payload.get("name")).cloned().unwrap_or(Value::Null),
                "options": [],
                "allowText": true,
                "sensitive": true,
            });
            message.interactions.push(interaction.clone());
            workspace_event(
                app,
                json!({
                    "type": "interaction",
                    "profileId": message.profile,
                    "sessionId": message.session_id,
                    "messageId": message.id,
                    "interaction": interaction,
                }),
            );
        }
        "sudo.expire" | "secret.expire" => {
            if let Some(request_id) = payload.get("request_id").and_then(Value::as_str) {
                if let Ok(mut interactions) = workspace.interactions.lock() {
                    interactions.remove(&(
                        message.profile.clone(),
                        message.session_id.clone(),
                        request_id.to_string(),
                    ));
                }
                for interaction in &mut message.interactions {
                    if interaction.get("id").and_then(Value::as_str) == Some(request_id) {
                        interaction["resolved"] = Value::Bool(true);
                    }
                }
                message.emit_upsert(app);
            }
        }
        "session.title" => {
            workspace_event(
                app,
                json!({ "type": "snapshot-invalidated", "profileId": message.profile }),
            );
        }
        "session.info" => {
            let key = (message.profile.clone(), message.session_id.clone());
            let settings = turn_settings_from_row(payload);
            if let Ok(mut rows) = workspace.server_active_rows.lock() {
                let row = rows.entry(key.clone()).or_insert_with(|| {
                    json!({
                        "id": message.session_id,
                        "session_key": message.session_id,
                        "profile": message.profile,
                    })
                });
                row["info"] = payload.clone();
            }
            if let Ok(mut pending) = workspace.pending_sessions.lock() {
                if let Some(session) = pending.get_mut(&key) {
                    if settings.model.is_some() {
                        session.settings.model = settings.model.clone();
                    }
                    if settings.provider.is_some() {
                        session.settings.provider = settings.provider.clone();
                    }
                    if settings.reasoning_effort.is_some() {
                        session.settings.reasoning_effort = settings.reasoning_effort.clone();
                    }
                    if settings.fast.is_some() {
                        session.settings.fast = settings.fast;
                    }
                    if settings.personality.is_some() {
                        session.settings.personality = settings.personality.clone();
                    }
                    if settings.approval_mode.is_some() {
                        session.settings.approval_mode = settings.approval_mode.clone();
                    }
                    if settings.yolo.is_some() {
                        session.settings.yolo = settings.yolo;
                    }
                }
            }
            workspace_event(
                app,
                json!({
                    "type": "session-settings",
                    "profileId": message.profile,
                    "sessionId": message.session_id,
                    "settings": settings,
                }),
            );
            if payload.get("running").and_then(Value::as_bool) == Some(false) {
                cache_live_message(workspace, message);
                return true;
            }
        }
        "status.update" => {
            let kind = payload
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if matches!(kind, "ready" | "idle" | "complete" | "completed") {
                cache_live_message(workspace, message);
                return true;
            }
            workspace_event(
                app,
                json!({
                    "type": "turn-state",
                    "profileId": message.profile,
                    "sessionId": message.session_id,
                    "state": if kind == "stalled" { "stalled" } else { "running" },
                }),
            );
        }
        event
            if event.starts_with("subagent.")
                || event.starts_with("background.")
                || event.starts_with("todo.") =>
        {
            update_tool(message, payload, event);
            message.emit_upsert(app);
        }
        "reasoning.available" => {
            let mut reasoning = payload.clone();
            reasoning["id"] = json!("reasoning");
            reasoning["name"] = json!("Reasoning");
            update_tool(message, &reasoning, "tool.result");
            message.emit_upsert(app);
        }
        "error" => {
            let error = payload
                .get("message")
                .or_else(|| payload.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("Hermes reported an error")
                .to_string();
            message.status = "error".to_string();
            message.error = Some(error);
            cache_live_message(workspace, message);
            message.emit_upsert(app);
            return true;
        }
        _ => {}
    }
    cache_live_message(workspace, message);
    false
}

async fn stream_turn(
    app: AppHandle,
    mut socket: GatewaySocket,
    key: ScopeKey,
    runtime_id: String,
    mut next_id: u64,
    prompt_request_id: u64,
    mut controls: mpsc::UnboundedReceiver<ControlRequest>,
    mut live_message: LiveMessage,
) {
    let workspace = app.state::<WorkspaceBackend>();
    let mut pending_controls: HashMap<u64, oneshot::Sender<Result<Value, String>>> = HashMap::new();
    let mut finished = false;
    let mut recoverable_disconnect = false;
    while !finished {
        tokio::select! {
            control = controls.recv() => {
                let Some(mut control) = control else {
                    recoverable_disconnect = true;
                    live_message.error = Some("Hermes turn control disconnected; recovering".to_string());
                    live_message.emit_upsert(&app);
                    break
                };
                next_id += 1;
                if control.params.get("session_id").is_none() {
                    control.params["session_id"] = Value::String(runtime_id.clone());
                }
                let frame = json!({
                    "jsonrpc": "2.0", "id": next_id,
                    "method": control.method, "params": control.params,
                });
                match socket.send(Message::Text(frame.to_string().into())).await {
                    Ok(()) => { pending_controls.insert(next_id, control.response); }
                    Err(error) => { let _ = control.response.send(Err(error.to_string())); }
                }
            }
            frame = socket.next() => {
                let Some(frame) = frame else {
                    recoverable_disconnect = true;
                    live_message.error = Some("Hermes gateway disconnected".to_string());
                    live_message.emit_upsert(&app);
                    break;
                };
                let frame = match frame {
                    Ok(frame) => frame,
                    Err(error) => {
                        recoverable_disconnect = true;
                        live_message.error = Some(format!("Hermes gateway disconnected: {error}"));
                        live_message.emit_upsert(&app);
                        break;
                    }
                };
                let Message::Text(text) = frame else { continue };
                let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    if let Some(response) = pending_controls.remove(&id) {
                        let result = if let Some(error) = value.get("error") {
                            Err(error.get("message").and_then(Value::as_str).unwrap_or("Hermes request failed").to_string())
                        } else {
                            Ok(value.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = response.send(result);
                    } else if id == prompt_request_id {
                        if let Some(error) = value.get("error") {
                            live_message.status = "error".to_string();
                            live_message.error = Some(error.get("message").and_then(Value::as_str).unwrap_or("Hermes rejected the prompt").to_string());
                            live_message.emit_upsert(&app);
                            finished = true;
                        }
                    }
                    continue;
                }
                let Some(params) = value.get("params") else { continue };
                if params.get("session_id").and_then(Value::as_str).is_some_and(|id| id != runtime_id) {
                    continue;
                }
                let event_type = params.get("type").and_then(Value::as_str).unwrap_or_default();
                let payload = params.get("payload").unwrap_or(&Value::Null);
                if event_type == "terminal.read.request" {
                    if let Some(request_id) = payload.get("request_id").and_then(Value::as_str) {
                        next_id += 1;
                        // Workspace deliberately has no terminal pane. Hermes Desktop's
                        // contract defines empty text as "no live pane"; answer immediately
                        // so read_terminal never waits for its 30-second timeout.
                        let response = json!({
                            "jsonrpc": "2.0",
                            "id": next_id,
                            "method": "terminal.read.respond",
                            "params": { "request_id": request_id, "text": "" },
                        });
                        if let Err(error) = socket.send(Message::Text(response.to_string().into())).await {
                            recoverable_disconnect = true;
                            live_message.error = Some(format!("Could not answer terminal read: {error}"));
                            live_message.emit_upsert(&app);
                            break;
                        }
                    }
                    continue;
                }
                finished = gateway_event(&app, &workspace, &mut live_message, event_type, payload);
            }
        }
    }
    for (_, response) in pending_controls {
        let _ = response.send(Err("Turn ended before the control completed".to_string()));
    }
    // Register finalization before removing controls so active-work coverage
    // has no gap that could admit an instance switch.
    if let Ok(mut finalizing) = workspace.finalizing.lock() {
        finalizing.insert(key.clone());
    }
    if let Ok(mut controls) = workspace.controls.lock() {
        controls.remove(&key);
    }
    if finished {
        if let Ok(mut active) = workspace.server_active.lock() {
            active.remove(&key);
        }
        if let Ok(mut active) = workspace.owned_active.lock() {
            active.remove(&key);
        }
        let pending = workspace
            .pending_sessions
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&key));
        if let Some(pending) = pending {
            if pending.title != "Untitled chat" {
                if let Ok(connection) = connection_for(&app.state::<HermesBackend>(), Some(&key.0))
                {
                    let path = api_path(
                        &format!("/api/sessions/{}", percent_encode(&key.1)),
                        &[("profile", Some(key.0.clone()))],
                    );
                    let _ = hermes_http_json(
                        &connection,
                        Method::PATCH,
                        &path,
                        Some(json!({ "title": pending.title, "profile": key.0 })),
                        HTTP_TIMEOUT,
                    )
                    .await;
                }
            }
        }
        if let Ok(mut users) = workspace.live_users.lock() {
            users.remove(&key);
        }
        if let Ok(mut messages) = workspace.live_messages.lock() {
            messages.remove(&key);
        }
    }
    workspace_event(
        &app,
        json!({
            "type": "turn-state",
            "profileId": key.0,
            "sessionId": key.1,
            "state": if recoverable_disconnect { "stalled" } else if live_message.status == "error" { "error" } else { "idle" },
            "error": live_message.error,
        }),
    );
    workspace_event(
        &app,
        json!({ "type": "snapshot-invalidated", "profileId": key.0 }),
    );
    if let Ok(mut finalizing) = workspace.finalizing.lock() {
        finalizing.remove(&key);
    }
    recompute_active_work(&app, &workspace);
}

async fn apply_turn_settings(
    socket: &mut GatewaySocket,
    runtime_id: &str,
    mut next_id: u64,
    settings: Option<&TurnSettings>,
) -> Result<u64, String> {
    let Some(settings) = settings else {
        return Ok(next_id);
    };
    let mut values: Vec<(&str, String)> = Vec::new();
    if let Some(model) = settings.model.as_ref().filter(|value| !value.is_empty()) {
        let model_value =
            if let Some(provider) = settings.provider.as_ref().filter(|value| !value.is_empty()) {
                format!("{model} --provider {provider} --session")
            } else {
                format!("{model} --session")
            };
        values.push(("model", model_value));
    }
    if let Some(fast) = settings.fast {
        values.push(("fast", if fast { "fast" } else { "normal" }.to_string()));
    }
    if let Some(reasoning) = settings
        .reasoning_effort
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        values.push(("reasoning", reasoning.clone()));
    }
    // YOLO is changed immediately by workspace_set_session_yolo. Do not replay
    // a queued prompt's stale snapshot here and override a newer chat toggle.
    // Personality uses session-scoped slash.exec below; config.set would also
    // rewrite profile-global config and is intentionally avoided.
    for (key, value) in values {
        next_id += 1;
        rpc_on_socket(
            socket,
            next_id,
            "config.set",
            json!({ "session_id": runtime_id, "key": key, "value": value }),
        )
        .await?;
    }
    if let Some(personality) = settings
        .personality
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        next_id += 1;
        rpc_on_socket(
            socket,
            next_id,
            "slash.exec",
            json!({
                "session_id": runtime_id,
                "command": format!("/personality {personality}"),
            }),
        )
        .await?;
    }
    Ok(next_id)
}

async fn begin_turn(
    app: AppHandle,
    backend: &HermesBackend,
    workspace: &WorkspaceBackend,
    profile: String,
    session_id: String,
    entry: QueueEntry,
    truncate_ordinal: Option<usize>,
) -> Result<(), String> {
    let key = (profile.clone(), session_id.clone());
    {
        let mut starting = workspace
            .starting
            .lock()
            .map_err(|_| "Workspace turn state is unavailable")?;
        let already_starting = starting.contains(&key);
        let locally_running = workspace
            .controls
            .lock()
            .map(|controls| controls.contains_key(&key))
            .unwrap_or(true);
        let remotely_running = workspace
            .server_active
            .lock()
            .map(|active| active.contains(&key))
            .unwrap_or(true)
            || workspace
                .mirrored_active
                .lock()
                .map(|active| active.contains(&key))
                .unwrap_or(true)
            || workspace
                .finalizing
                .lock()
                .map(|active| active.contains(&key))
                .unwrap_or(true);
        if already_starting || locally_running || remotely_running {
            return Err("Session already has an active turn".to_string());
        }
        starting.insert(key.clone());
    }
    recompute_active_work(&app, workspace);

    let setup = async {
        let connection = connection_for(backend, Some(&profile))?;
        let (mut socket, runtime_id, next_id, resumed_running, _) =
            open_runtime_socket(&connection, workspace, &profile, &session_id).await?;
        if resumed_running {
            return Err("Session already has an active turn".to_string());
        }
        let mut next_id =
            apply_turn_settings(&mut socket, &runtime_id, next_id, entry.settings.as_ref()).await?;
        let mut prompt = entry.text.clone();
        for attachment in &entry.attachments {
            let Some(reference) = attachment.url.as_deref().filter(|value| !value.is_empty())
            else {
                continue;
            };
            if attachment.mime_type.starts_with("image/") {
                next_id += 1;
                if reference.starts_with("data:image/") {
                    let content = reference
                        .split_once(',')
                        .map(|(_, encoded)| encoded)
                        .unwrap_or(reference);
                    rpc_on_socket(
                        &mut socket,
                        next_id,
                        "image.attach_bytes",
                        json!({
                            "session_id": runtime_id,
                            "content_base64": content,
                            "filename": attachment.name,
                        }),
                    )
                    .await?;
                } else {
                    rpc_on_socket(
                        &mut socket,
                        next_id,
                        "image.attach",
                        json!({ "session_id": runtime_id, "path": reference }),
                    )
                    .await?;
                }
            } else if !prompt.contains(reference) {
                if !prompt.is_empty() {
                    prompt.push('\n');
                }
                prompt.push_str(reference);
            }
        }
        next_id += 1;
        let prompt_request_id = next_id;
        let mut params = json!({ "session_id": runtime_id, "text": prompt });
        if let Some(ordinal) = truncate_ordinal {
            params["truncate_before_user_ordinal"] = json!(ordinal);
        }
        socket
            .send(Message::Text(
                json!({
                    "jsonrpc": "2.0", "id": prompt_request_id,
                    "method": "prompt.submit", "params": params,
                })
                .to_string()
                .into(),
            ))
            .await
            .map_err(|error| format!("Could not submit prompt to Hermes: {error}"))?;
        Ok::<_, String>((socket, runtime_id, next_id, prompt_request_id))
    }
    .await;

    let (socket, runtime_id, next_id, prompt_request_id) = match setup {
        Ok(setup) => setup,
        Err(error) => {
            if let Ok(mut starting) = workspace.starting.lock() {
                starting.remove(&key);
            }
            recompute_active_work(&app, workspace);
            return Err(error);
        }
    };
    let (sender, receiver) = mpsc::unbounded_channel();
    if let Err(_) = workspace
        .controls
        .lock()
        .map(|mut controls| controls.insert(key.clone(), sender))
    {
        if let Ok(mut starting) = workspace.starting.lock() {
            starting.remove(&key);
        }
        recompute_active_work(&app, workspace);
        return Err("Workspace turn state is unavailable".to_string());
    }
    if let Ok(mut owned) = workspace.owned_active.lock() {
        owned.insert(key.clone());
    }
    if let Ok(mut starting) = workspace.starting.lock() {
        starting.remove(&key);
    }
    if let Ok(mut active) = workspace.server_active.lock() {
        active.remove(&key);
    }
    workspace_event(
        &app,
        json!({
            "type": "turn-state", "profileId": profile,
            "sessionId": session_id, "state": "running",
        }),
    );
    let user_message = json!({
        "id": entry.id.clone(),
        "sessionId": session_id,
        "profileId": profile,
        "role": "user",
        "content": entry.text.clone(),
        "createdAt": entry.created_at.clone(),
        "status": "complete",
        "attachments": entry.attachments.clone(),
    });
    if let Ok(mut users) = workspace.live_users.lock() {
        users.insert(key.clone(), user_message.clone());
    }
    workspace_event(
        &app,
        json!({ "type": "message-upsert", "message": user_message }),
    );
    let live_message = LiveMessage::new(&profile, &session_id, &entry.id);
    if let Ok(mut live) = workspace.live_messages.lock() {
        live.insert(key.clone(), live_message.clone());
    }
    live_message.emit_upsert(&app);
    recompute_active_work(&app, &workspace);
    tauri::async_runtime::spawn(stream_turn(
        app,
        socket,
        key,
        runtime_id,
        next_id,
        prompt_request_id,
        receiver,
        live_message,
    ));
    Ok(())
}

#[tauri::command]
pub(crate) async fn workspace_send_turn(
    app: AppHandle,
    request: SendTurnRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<(), String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    begin_turn(
        app,
        &backend,
        &workspace,
        request.profile_id,
        request.session_id,
        request.entry,
        None,
    )
    .await
}

#[tauri::command]
pub(crate) async fn workspace_steer_turn(
    request: SteerTurnRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<bool, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let text = request.text.trim();
    if text.is_empty() {
        return Err("Steer text cannot be empty".to_string());
    }
    let key = (request.profile_id.clone(), request.session_id.clone());
    let result = if let Some(result) =
        control_request(&workspace, &key, "session.steer", json!({ "text": text })).await
    {
        result?
    } else {
        let runtime = workspace
            .runtimes
            .lock()
            .ok()
            .and_then(|runtimes| runtimes.get(&key).cloned())
            .ok_or_else(|| "Session has no active turn to steer".to_string())?;
        let connection = connection_for(&backend, Some(&request.profile_id))?;
        rpc_once(
            &connection,
            "session.steer",
            json!({ "session_id": runtime, "text": text }),
        )
        .await?
    };
    Ok(!matches!(
        result.get("status").and_then(Value::as_str),
        Some("rejected")
    ))
}

#[tauri::command]
pub(crate) async fn workspace_execute_slash(
    request: ExecuteSlashRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let command = request.command.trim().trim_start_matches('/').trim();
    if command.is_empty() {
        return Err("Slash command cannot be empty".to_string());
    }
    let mut parts = command.splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or_default();
    let arg = parts.next().unwrap_or_default().trim();
    let connection = connection_for(&backend, Some(&request.profile_id))?;
    let advertised = slash_commands(&connection, &request.profile_id).await;
    let allowed = advertised.iter().any(|item| {
        item.get("name")
            .and_then(Value::as_str)
            .is_some_and(|candidate| candidate.trim_start_matches('/').eq_ignore_ascii_case(name))
    });
    if !allowed {
        return Err(format!(
            "/{name} is outside the Ask Hermes workspace command surface"
        ));
    }
    let key = (request.profile_id.clone(), request.session_id.clone());
    if let Some(primary) = control_request(
        &workspace,
        &key,
        "slash.exec",
        json!({ "command": command }),
    )
    .await
    {
        return match primary {
            Ok(result) => Ok(result),
            Err(_) => control_request(
                &workspace,
                &key,
                "command.dispatch",
                json!({ "name": name, "arg": arg }),
            )
            .await
            .ok_or_else(|| "Active turn ended while executing slash command".to_string())?,
        };
    }

    if let Some(runtime) = server_runtime(&workspace, &key) {
        let primary = rpc_once(
            &connection,
            "slash.exec",
            json!({ "session_id": runtime, "command": command }),
        )
        .await;
        return match primary {
            Ok(result) => Ok(result),
            Err(error) if rpc_method_not_found(&error, "slash.exec") => {
                rpc_once(
                    &connection,
                    "command.dispatch",
                    json!({ "session_id": runtime, "name": name, "arg": arg }),
                )
                .await
            }
            Err(error) => Err(error),
        };
    }

    let (mut socket, runtime, mut id, _, _) = open_runtime_socket(
        &connection,
        &workspace,
        &request.profile_id,
        &request.session_id,
    )
    .await?;
    id += 1;
    match rpc_on_socket(
        &mut socket,
        id,
        "slash.exec",
        json!({ "session_id": runtime, "command": command }),
    )
    .await
    {
        Ok(result) => Ok(result),
        Err(error) if rpc_method_not_found(&error, "slash.exec") => {
            id += 1;
            rpc_on_socket(
                &mut socket,
                id,
                "command.dispatch",
                json!({ "session_id": runtime, "name": name, "arg": arg }),
            )
            .await
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub(crate) async fn workspace_stop_turn(
    app: AppHandle,
    request: ScopedSessionRefRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<(), String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let key = (request.profile_id.clone(), request.session_id.clone());
    if !turn_is_active(&workspace, &key) {
        return Ok(());
    }
    workspace_event(
        &app,
        json!({ "type": "turn-state", "profileId": request.profile_id, "sessionId": request.session_id, "state": "stopping" }),
    );
    if let Some(result) = control_request(&workspace, &key, "session.interrupt", json!({})).await {
        result?;
        return Ok(());
    }
    let connection = connection_for(&backend, Some(&request.profile_id))?;
    let result = if let Some(runtime) = server_runtime(&workspace, &key) {
        rpc_once(
            &connection,
            "session.interrupt",
            json!({ "session_id": runtime }),
        )
        .await
    } else {
        let (mut socket, runtime, mut id, _, _) = open_runtime_socket(
            &connection,
            &workspace,
            &request.profile_id,
            &request.session_id,
        )
        .await?;
        id += 1;
        rpc_on_socket(
            &mut socket,
            id,
            "session.interrupt",
            json!({ "session_id": runtime }),
        )
        .await
    };
    match result {
        Ok(_) => {
            if let Ok(mut active) = workspace.server_active.lock() {
                active.remove(&key);
            }
            if let Ok(mut active) = workspace.owned_active.lock() {
                active.remove(&key);
            }
            workspace_event(
                &app,
                json!({
                    "type": "turn-state", "profileId": request.profile_id,
                    "sessionId": request.session_id, "state": "idle",
                }),
            );
            recompute_active_work(&app, &workspace);
            Ok(())
        }
        Err(error) => {
            workspace_event(
                &app,
                json!({
                    "type": "turn-state", "profileId": request.profile_id,
                    "sessionId": request.session_id, "state": "error", "error": error,
                }),
            );
            Err(error)
        }
    }
}

fn message_id_matches(row: &Value, requested: &str) -> bool {
    if row
        .get("id")
        .map(|id| {
            id.as_str()
                .map(str::to_string)
                .unwrap_or_else(|| id.to_string())
        })
        .as_deref()
        == Some(requested)
    {
        return true;
    }
    map_message(row, "", "").get("id").and_then(Value::as_str) == Some(requested)
}

async fn rewind_plan(
    connection: &HermesGatewayConnection,
    profile: &str,
    session_id: &str,
    message_id: &str,
) -> Result<(String, usize, Vec<AttachmentRef>), String> {
    let messages = raw_messages_through(connection, profile, session_id, message_id).await?;
    let user_index = (0..messages.len())
        .rev()
        .find(|index| messages[*index].get("role").and_then(Value::as_str) == Some("user"))
        .ok_or_else(|| "Could not find the user prompt for this exchange".to_string())?;
    let ordinal = messages[..user_index]
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .count();
    let text = visible_message_text(&messages[user_index]);
    let attachments = content_attachments(&messages[user_index], message_id)
        .into_iter()
        .filter_map(|attachment| serde_json::from_value(attachment).ok())
        .collect::<Vec<_>>();
    if text.trim().is_empty() && attachments.is_empty() {
        return Err("Cannot retry an empty prompt".to_string());
    }
    Ok((text, ordinal, attachments))
}

#[tauri::command]
pub(crate) async fn workspace_retry_message(
    app: AppHandle,
    request: MessageActionRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<(), String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let connection = connection_for(&backend, Some(&request.profile_id))?;
    let (text, ordinal, attachments) = rewind_plan(
        &connection,
        &request.profile_id,
        &request.session_id,
        &request.message_id,
    )
    .await?;
    let entry = QueueEntry {
        id: format!("retry-{}", request.message_id),
        text,
        created_at: chrono::Utc::now().to_rfc3339(),
        attachments,
        settings: None,
    };
    begin_turn(
        app,
        &backend,
        &workspace,
        request.profile_id,
        request.session_id,
        entry,
        Some(ordinal),
    )
    .await
}

#[tauri::command]
pub(crate) async fn workspace_edit_message(
    app: AppHandle,
    request: EditMessageRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<(), String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let connection = connection_for(&backend, Some(&request.profile_id))?;
    let (_, ordinal, attachments) = rewind_plan(
        &connection,
        &request.profile_id,
        &request.session_id,
        &request.message_id,
    )
    .await?;
    let entry = QueueEntry {
        id: format!("edit-{}", request.message_id),
        text: request.content,
        created_at: chrono::Utc::now().to_rfc3339(),
        attachments,
        settings: None,
    };
    begin_turn(
        app,
        &backend,
        &workspace,
        request.profile_id,
        request.session_id,
        entry,
        Some(ordinal),
    )
    .await
}

#[tauri::command]
pub(crate) async fn workspace_undo(
    request: UndoRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<(), String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let key = (request.profile_id.clone(), request.session_id.clone());
    if turn_is_active(&workspace, &key) {
        return Err("Stop the active turn before undoing".to_string());
    }
    let connection = connection_for(&backend, Some(&request.profile_id))?;
    let (mut socket, runtime, mut id, running, _) = open_runtime_socket(
        &connection,
        &workspace,
        &request.profile_id,
        &request.session_id,
    )
    .await?;
    if running {
        return Err("Stop the active turn before undoing".to_string());
    }
    id += 1;
    // Current Hermes undo removes the latest complete exchange. messageId is
    // accepted by the workspace contract for future gateways with targeted undo.
    rpc_on_socket(
        &mut socket,
        id,
        "session.undo",
        json!({ "session_id": runtime, "message_id": request.message_id }),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn workspace_submit_interaction(
    app: AppHandle,
    request: InteractionRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<(), String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let key = (request.profile_id.clone(), request.session_id.clone());
    let interaction = workspace.interactions.lock().ok().and_then(|interactions| {
        interactions
            .get(&(
                request.profile_id.clone(),
                request.session_id.clone(),
                request.interaction_id.clone(),
            ))
            .cloned()
    });
    let (method, params) = match interaction {
        Some(PendingInteraction::Approval) => (
            "approval.respond",
            json!({ "choice": request.option_id.as_deref().unwrap_or("deny") }),
        ),
        Some(PendingInteraction::Clarification { choices }) => {
            let answer = request
                .text
                .clone()
                .filter(|text| !text.trim().is_empty())
                .or_else(|| {
                    request
                        .option_id
                        .as_ref()
                        .and_then(|id| choices.get(id).cloned())
                })
                .unwrap_or_default();
            (
                "clarify.respond",
                json!({ "request_id": request.interaction_id, "answer": answer }),
            )
        }
        Some(PendingInteraction::Sensitive { method, value_key }) => {
            let mut params = json!({ "request_id": request.interaction_id });
            params[value_key] = Value::String(request.text.clone().unwrap_or_default());
            (method, params)
        }
        None if request.text.is_none() => (
            "approval.respond",
            json!({ "choice": request.option_id.as_deref().unwrap_or("deny") }),
        ),
        None => (
            "clarify.respond",
            json!({ "request_id": request.interaction_id, "answer": request.text.unwrap_or_default() }),
        ),
    };
    if let Some(result) = control_request(&workspace, &key, method, params.clone()).await {
        result?;
    } else {
        let connection = connection_for(&backend, Some(&request.profile_id))?;
        if let Some(runtime) = server_runtime(&workspace, &key) {
            let mut params = params;
            params["session_id"] = Value::String(runtime);
            rpc_once(&connection, method, params).await?;
        } else {
            let (mut socket, runtime, mut id, _, _) = open_runtime_socket(
                &connection,
                &workspace,
                &request.profile_id,
                &request.session_id,
            )
            .await?;
            id += 1;
            let mut params = params;
            params["session_id"] = Value::String(runtime);
            rpc_on_socket(&mut socket, id, method, params).await?;
        }
    }
    if let Ok(mut interactions) = workspace.interactions.lock() {
        interactions.remove(&(
            request.profile_id.clone(),
            request.session_id.clone(),
            request.interaction_id.clone(),
        ));
    }
    if let Ok(mut messages) = workspace.live_messages.lock() {
        if let Some(message) = messages.get_mut(&key) {
            for interaction in &mut message.interactions {
                if interaction.get("id").and_then(Value::as_str)
                    == Some(request.interaction_id.as_str())
                {
                    interaction["resolved"] = Value::Bool(true);
                }
            }
            message.emit_upsert(&app);
        }
    }
    Ok(())
}

fn normalize_data_url(data_url: &str, mime_type: &str) -> Result<(String, usize), String> {
    let raw = data_url.trim();
    let base64 = raw
        .split_once(",")
        .map(|(_, encoded)| encoded)
        .unwrap_or(raw)
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    let size = STANDARD
        .decode(&base64)
        .map_err(|_| "Attachment is not valid base64".to_string())?
        .len();
    Ok((format!("data:{mime_type};base64,{base64}"), size))
}

fn attachment_result_reference(
    result: &Value,
    mime_type: &str,
    name: &str,
) -> Result<String, String> {
    let message = result
        .get("message")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    if result.get("attached").and_then(Value::as_bool) == Some(false) {
        return Err(message
            .map(str::to_string)
            .unwrap_or_else(|| format!("Could not attach {name}")));
    }
    let field = if mime_type.starts_with("image/") {
        "path"
    } else {
        "ref_text"
    };
    result
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            message.map(str::to_string).unwrap_or_else(|| {
                format!("Hermes did not return an attachment reference for {name}")
            })
        })
}

async fn upload_via_socket(
    socket: &mut GatewaySocket,
    id: u64,
    runtime: &str,
    name: &str,
    mime_type: &str,
    data_url: &str,
) -> Result<Value, String> {
    let (method, params) = if mime_type.starts_with("image/") {
        let content = data_url
            .split_once(',')
            .map(|(_, value)| value)
            .unwrap_or(data_url);
        (
            "image.attach_bytes",
            json!({ "session_id": runtime, "content_base64": content, "filename": name }),
        )
    } else {
        (
            "file.attach",
            json!({ "session_id": runtime, "data_url": data_url, "name": name }),
        )
    };
    rpc_on_socket(socket, id, method, params).await
}

#[tauri::command]
pub(crate) async fn workspace_upload_attachment(
    request: UploadAttachmentRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    workspace_upload_attachment_inner(request, &backend, &workspace).await
}

async fn workspace_upload_attachment_inner(
    request: UploadAttachmentRequest,
    backend: &HermesBackend,
    workspace: &WorkspaceBackend,
) -> Result<Value, String> {
    let (data_url, size) = normalize_data_url(&request.data_url, &request.mime_type)?;
    if size > 16 * 1024 * 1024 {
        return Err("Attachment exceeds the 16 MB workspace limit".to_string());
    }
    let key = (request.profile_id.clone(), request.session_id.clone());
    let result = if workspace
        .controls
        .lock()
        .map(|controls| controls.contains_key(&key))
        .unwrap_or(false)
    {
        let method = if request.mime_type.starts_with("image/") {
            "image.attach_bytes"
        } else {
            "file.attach"
        };
        let params = if request.mime_type.starts_with("image/") {
            json!({
                "content_base64": data_url.split_once(',').map(|(_, value)| value).unwrap_or(&data_url),
                "filename": request.name,
            })
        } else {
            json!({ "data_url": data_url, "name": request.name })
        };
        let result = control_request(workspace, &key, method, params)
            .await
            .ok_or_else(|| "Active turn ended during attachment upload".to_string())??;
        if request.mime_type.starts_with("image/") {
            if let Some(path) = result.get("path").and_then(Value::as_str) {
                control_request(workspace, &key, "image.detach", json!({ "path": path }))
                    .await
                    .ok_or_else(|| "Active turn ended while staging attachment".to_string())??;
            }
        }
        result
    } else if let Some(runtime) = server_runtime(workspace, &key) {
        let connection = connection_for(backend, Some(&request.profile_id))?;
        let (method, params) = if request.mime_type.starts_with("image/") {
            (
                "image.attach_bytes",
                json!({
                    "session_id": runtime,
                    "content_base64": data_url.split_once(',').map(|(_, value)| value).unwrap_or(&data_url),
                    "filename": request.name,
                }),
            )
        } else {
            (
                "file.attach",
                json!({
                    "session_id": runtime,
                    "data_url": data_url,
                    "name": request.name,
                }),
            )
        };
        let result = rpc_once(&connection, method, params).await?;
        if request.mime_type.starts_with("image/") {
            if let Some(path) = result.get("path").and_then(Value::as_str) {
                rpc_once(
                    &connection,
                    "image.detach",
                    json!({ "session_id": runtime, "path": path }),
                )
                .await?;
            }
        }
        result
    } else {
        let connection = connection_for(backend, Some(&request.profile_id))?;
        let (mut socket, runtime, mut id, _, _) = open_runtime_socket(
            &connection,
            workspace,
            &request.profile_id,
            &request.session_id,
        )
        .await?;
        id += 1;
        let result = upload_via_socket(
            &mut socket,
            id,
            &runtime,
            &request.name,
            &request.mime_type,
            &data_url,
        )
        .await?;
        if request.mime_type.starts_with("image/") {
            if let Some(path) = result.get("path").and_then(Value::as_str) {
                id += 1;
                rpc_on_socket(
                    &mut socket,
                    id,
                    "image.detach",
                    json!({ "session_id": runtime, "path": path }),
                )
                .await?;
            }
        }
        result
    };
    let reference = attachment_result_reference(&result, &request.mime_type, &request.name)?;
    let id = result
        .get("path")
        .or_else(|| result.get("ref_path"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| reference.clone());
    Ok(json!({
        "id": id,
        "name": request.name,
        "mimeType": request.mime_type,
        "size": size,
        "state": "ready",
        "url": reference,
    }))
}

#[tauri::command]
pub(crate) async fn workspace_capture_screen(
    request: CaptureRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Option<Value>, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let Some(session_id) = request.session_id else {
        return Ok(None);
    };
    let captured = tauri::async_runtime::spawn_blocking(capture_desktop)
        .await
        .map_err(|error| format!("Screen capture task failed: {error}"))??;
    let data_url = image_data_url(&captured.image)?;
    workspace_upload_attachment_inner(
        UploadAttachmentRequest {
            instance: request.instance,
            profile_id: request.profile_id,
            session_id,
            name: format!(
                "screenshot-{}.png",
                chrono::Utc::now().format("%Y%m%d-%H%M%S")
            ),
            mime_type: "image/png".to_string(),
            data_url,
        },
        &backend,
        &workspace,
    )
    .await
    .map(Some)
}

#[tauri::command]
pub(crate) async fn workspace_list_schedules(
    request: ProfileRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Vec<Value>, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let profile = request
        .profile_id
        .as_deref()
        .filter(|value| !value.is_empty());
    let connection = connection_for(&backend, profile)?;
    schedules_for(&connection, profile).await
}

#[tauri::command]
pub(crate) async fn workspace_save_schedule(
    request: ScheduleDraft,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let connection = connection_for(&backend, Some(&request.profile_id))?;
    let profile_query = [("profile", Some(request.profile_id.clone()))];
    let response = if let Some(id) = request.id.as_deref() {
        let current = hermes_http_json(
            &connection,
            Method::GET,
            &api_path(
                &format!("/api/cron/jobs/{}", percent_encode(id)),
                &profile_query,
            ),
            None,
            HTTP_TIMEOUT,
        )
        .await?;
        let mut updates = latest_schedule_fields(&current, request.preserved_fields);
        updates.insert("name".to_string(), Value::String(request.name));
        updates.insert("prompt".to_string(), Value::String(request.prompt));
        updates.insert(
            "schedule".to_string(),
            edited_schedule_value(&current, &request.cron, request.original_cron.as_deref()),
        );
        updates.insert(
            "model".to_string(),
            request.model.map(Value::String).unwrap_or(Value::Null),
        );
        updates.insert(
            "provider".to_string(),
            request.provider.map(Value::String).unwrap_or(Value::Null),
        );
        hermes_http_json(
            &connection,
            Method::PUT,
            &api_path(
                &format!("/api/cron/jobs/{}", percent_encode(id)),
                &profile_query,
            ),
            Some(json!({ "updates": updates })),
            HTTP_TIMEOUT,
        )
        .await?
    } else {
        hermes_http_json(
            &connection,
            Method::POST,
            &api_path("/api/cron/jobs", &profile_query),
            Some(json!({
                "name": request.name,
                "prompt": request.prompt,
                "schedule": request.cron,
                "deliver": "local",
                "model": request.model,
                "provider": request.provider,
            })),
            HTTP_TIMEOUT,
        )
        .await?
    };
    Ok(map_schedule(&response, Some(&request.profile_id)))
}

#[tauri::command]
pub(crate) async fn workspace_schedule_action(
    app: AppHandle,
    request: ScheduleActionRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<(), String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let connection = connection_for(&backend, Some(&request.profile_id))?;
    let suffix = match request.action.as_str() {
        "pause" => "/pause",
        "resume" => "/resume",
        "run" => "/trigger",
        "delete" => "",
        _ => return Err(format!("Unknown schedule action: {}", request.action)),
    };
    let path = api_path(
        &format!(
            "/api/cron/jobs/{}{}",
            percent_encode(&request.schedule_id),
            suffix
        ),
        &[("profile", Some(request.profile_id.clone()))],
    );
    let method = if request.action == "delete" {
        Method::DELETE
    } else {
        Method::POST
    };
    hermes_http_json(&connection, method, &path, None, HTTP_TIMEOUT).await?;
    workspace_event(
        &app,
        if request.action == "delete" {
            json!({
                "type": "schedule-remove", "profileId": request.profile_id,
                "scheduleId": request.schedule_id,
            })
        } else {
            json!({ "type": "snapshot-invalidated", "profileId": request.profile_id })
        },
    );
    Ok(())
}

fn schedule_run_state(run: &Value) -> (&'static str, bool, Option<&Value>) {
    let finished = run.get("finished_at").or_else(|| run.get("ended_at"));
    let explicit_status = run
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let running = matches!(explicit_status, "running" | "started")
        || (explicit_status.is_empty() && finished.is_none_or(Value::is_null));
    let end_reason = run
        .get("end_reason")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let reported_error = run
        .get("error")
        .or_else(|| run.get("last_error"))
        .filter(|value| match value {
            Value::Null => false,
            Value::String(text) => !text.trim().is_empty(),
            _ => true,
        });
    let status = if matches!(explicit_status, "cancelled" | "canceled") {
        "cancelled"
    } else if matches!(explicit_status, "error" | "failed") {
        "error"
    } else if matches!(explicit_status, "complete" | "completed" | "success") {
        "complete"
    } else if running {
        "running"
    } else if end_reason.contains("cancel") || end_reason.contains("interrupt") {
        "cancelled"
    } else if end_reason.contains("error") || reported_error.is_some() {
        "error"
    } else {
        // Hermes' current run endpoint returns session rows and always ends
        // them with cron_complete, even when job execution failed.
        "finished"
    };
    (status, running, reported_error)
}

fn schedule_run_fetch_limit(offset: usize, limit: usize) -> usize {
    offset.saturating_add(limit).saturating_add(1).clamp(1, 100)
}

fn schedule_run_next_cursor(offset: usize, page_len: usize, fetched_len: usize) -> Option<String> {
    let next = offset.saturating_add(page_len);
    (next < fetched_len && next < 100).then(|| next.to_string())
}

#[tauri::command]
pub(crate) async fn workspace_list_schedule_runs(
    request: ScheduleRunsRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let connection = connection_for(&backend, Some(&request.profile_id))?;
    let offset = request
        .cursor
        .as_deref()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or_default();
    // Current Hermes endpoint is a bounded latest window without offset. Ask
    // for enough rows to page client-side while keeping the contract forward compatible.
    let fetch = schedule_run_fetch_limit(offset, request.limit);
    let path = api_path(
        &format!(
            "/api/cron/jobs/{}/runs",
            percent_encode(&request.schedule_id)
        ),
        &[
            ("profile", Some(request.profile_id.clone())),
            ("limit", Some(fetch.to_string())),
        ],
    );
    let payload = hermes_http_json(&connection, Method::GET, &path, None, HTTP_TIMEOUT).await?;
    let rows = payload
        .get("runs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let runs = rows
        .iter()
        .skip(offset)
        .take(request.limit)
        .map(|run| {
            let finished = run.get("finished_at").or_else(|| run.get("ended_at"));
            let (status, running, reported_error) = schedule_run_state(run);
            let id = run.get("id").or_else(|| run.get("run_id")).and_then(Value::as_str).unwrap_or_default();
            let session_id = run
                .get("session_id")
                .or_else(|| run.get("sessionId"))
                .and_then(Value::as_str)
                .unwrap_or(id);
            json!({
                "id": id,
                "scheduleId": request.schedule_id,
                "profileId": request.profile_id,
                "sessionId": session_id,
                "startedAt": unix_or_iso(run.get("started_at")),
                "finishedAt": if running { Value::Null } else { Value::String(unix_or_iso(finished)) },
                "status": status,
                "error": reported_error.cloned().unwrap_or(Value::Null),
            })
        })
        .collect::<Vec<_>>();
    let cursor = schedule_run_next_cursor(offset, runs.len(), rows.len());
    Ok(json!({
        "runs": runs,
        "cursor": cursor,
    }))
}

fn merge_attachment_refs(
    preferred: &[AttachmentRef],
    fallback: &[AttachmentRef],
) -> Vec<AttachmentRef> {
    let mut merged = preferred.to_vec();
    let mut ids = preferred
        .iter()
        .map(|attachment| attachment.id.as_str())
        .collect::<HashSet<_>>();
    for attachment in fallback {
        if ids.insert(attachment.id.as_str()) {
            merged.push(attachment.clone());
        }
    }
    merged
}

/// Recovery snapshots are whole-state by necessity, but may be stale by the
/// time they reach Rust. Merge them into the authoritative state instead of
/// replacing fields changed by another window in the meantime.
fn merge_recovery_client_state(
    recovery: &SessionClientState,
    current: &SessionClientState,
    base: Option<&SessionClientState>,
) -> SessionClientState {
    if let Some(base) = base {
        let mut merged = current.clone();
        if recovery.draft != base.draft && merged.draft == base.draft {
            merged.draft = recovery.draft.clone();
        }

        let recovery_queue_ids = recovery
            .queue
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<HashSet<_>>();
        for base_entry in &base.queue {
            if recovery_queue_ids.contains(base_entry.id.as_str()) {
                continue;
            }
            if let Some(index) = merged
                .queue
                .iter()
                .position(|entry| entry.id == base_entry.id && entry == base_entry)
            {
                merged.queue.remove(index);
            }
        }
        let base_queue = base
            .queue
            .iter()
            .map(|entry| (entry.id.as_str(), entry))
            .collect::<HashMap<_, _>>();
        for (desired_index, desired) in recovery.queue.iter().enumerate() {
            match base_queue.get(desired.id.as_str()) {
                None => {
                    if !merged.queue.iter().any(|entry| entry.id == desired.id) {
                        merged
                            .queue
                            .insert(desired_index.min(merged.queue.len()), desired.clone());
                    }
                }
                Some(base_entry) if *base_entry != desired => {
                    if let Some(current_entry) = merged
                        .queue
                        .iter_mut()
                        .find(|entry| entry.id == desired.id && *entry == *base_entry)
                    {
                        *current_entry = desired.clone();
                    }
                }
                _ => {}
            }
        }

        let recovery_attachment_ids = recovery
            .attachments
            .iter()
            .map(|attachment| attachment.id.as_str())
            .collect::<HashSet<_>>();
        for base_attachment in &base.attachments {
            if recovery_attachment_ids.contains(base_attachment.id.as_str()) {
                continue;
            }
            if let Some(index) = merged.attachments.iter().position(|attachment| {
                attachment.id == base_attachment.id && attachment == base_attachment
            }) {
                merged.attachments.remove(index);
            }
        }
        let base_attachments = base
            .attachments
            .iter()
            .map(|attachment| (attachment.id.as_str(), attachment))
            .collect::<HashMap<_, _>>();
        for (desired_index, desired) in recovery.attachments.iter().enumerate() {
            match base_attachments.get(desired.id.as_str()) {
                None => {
                    if !merged
                        .attachments
                        .iter()
                        .any(|attachment| attachment.id == desired.id)
                    {
                        merged
                            .attachments
                            .insert(desired_index.min(merged.attachments.len()), desired.clone());
                    }
                }
                Some(base_attachment) if *base_attachment != desired => {
                    if let Some(current_attachment) =
                        merged.attachments.iter_mut().find(|attachment| {
                            attachment.id == desired.id && *attachment == *base_attachment
                        })
                    {
                        *current_attachment = desired.clone();
                    }
                }
                _ => {}
            }
        }
        return merged;
    }

    let current_queue = current
        .queue
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect::<HashMap<_, _>>();
    let recovery_ids = recovery
        .queue
        .iter()
        .map(|entry| entry.id.as_str())
        .collect::<HashSet<_>>();
    let mut queue = recovery
        .queue
        .iter()
        .map(|entry| {
            current_queue
                .get(entry.id.as_str())
                .map(|current_entry| {
                    let mut merged = (*current_entry).clone();
                    merged.attachments =
                        merge_attachment_refs(&current_entry.attachments, &entry.attachments);
                    merged
                })
                .unwrap_or_else(|| entry.clone())
        })
        .collect::<Vec<_>>();
    queue.extend(
        current
            .queue
            .iter()
            .filter(|entry| !recovery_ids.contains(entry.id.as_str()))
            .cloned(),
    );
    SessionClientState {
        draft: if current.draft.is_empty() {
            recovery.draft.clone()
        } else {
            current.draft.clone()
        },
        queue,
        attachments: merge_attachment_refs(&current.attachments, &recovery.attachments),
    }
}

fn corrected_recovery_client_state(
    desired: &SessionClientState,
    current: &SessionClientState,
    base: Option<&SessionClientState>,
    removed_queue_entries: &HashSet<String>,
) -> SessionClientState {
    let mut state = merge_recovery_client_state(desired, current, base);
    state
        .queue
        .retain(|entry| !removed_queue_entries.contains(&entry.id));
    state
}

fn restore_draft(current: &mut String, restored: &str) {
    if restored.is_empty() || current == restored {
        return;
    }
    if current.is_empty() {
        *current = restored.to_string();
    } else {
        *current = format!("{restored}\n{current}");
    }
}

fn append_handoff_draft(current: &mut String, incoming: Option<&str>) {
    let Some(incoming) = incoming.filter(|value| !value.is_empty()) else {
        return;
    };
    if current == incoming || current.ends_with(&format!("\n{incoming}")) {
        return;
    }
    if !current.is_empty() {
        current.push('\n');
    }
    current.push_str(incoming);
}

fn apply_client_state_mutation(state: &mut SessionClientState, mutation: ClientStateMutation) {
    match mutation {
        ClientStateMutation::SetDraft { draft } => state.draft = draft,
        ClientStateMutation::AppendDraft { text, separator } => {
            if state.draft.is_empty() {
                state.draft = text;
            } else if !text.is_empty() {
                state.draft.push_str(separator.as_deref().unwrap_or(""));
                state.draft.push_str(&text);
            }
        }
        ClientStateMutation::RestoreDraft { draft } => restore_draft(&mut state.draft, &draft),
        ClientStateMutation::AddQueue { entry, front } => {
            if !state.queue.iter().any(|current| current.id == entry.id) {
                if front {
                    state.queue.insert(0, entry);
                } else {
                    state.queue.push(entry);
                }
            }
        }
        ClientStateMutation::UpdateQueue { entry_id, text } => {
            if let Some(entry) = state.queue.iter_mut().find(|entry| entry.id == entry_id) {
                entry.text = text;
            }
        }
        ClientStateMutation::MoveQueue {
            entry_id,
            direction,
        } => {
            if let Some(from) = state.queue.iter().position(|entry| entry.id == entry_id) {
                let to = if direction < 0 {
                    from.checked_sub(1)
                } else if direction > 0 && from + 1 < state.queue.len() {
                    Some(from + 1)
                } else {
                    None
                };
                if let Some(to) = to {
                    state.queue.swap(from, to);
                }
            }
        }
        ClientStateMutation::RemoveQueue { entry_id } => {
            state.queue.retain(|entry| entry.id != entry_id);
        }
        ClientStateMutation::RestoreQueue { entry } => {
            if !state.queue.iter().any(|current| current.id == entry.id) {
                state.queue.insert(0, entry);
            }
        }
        ClientStateMutation::AddAttachment { attachment } => {
            if !state
                .attachments
                .iter()
                .any(|current| current.id == attachment.id)
            {
                state.attachments.push(attachment);
            }
        }
        ClientStateMutation::ReplaceAttachment {
            attachment_id,
            attachment,
        } => {
            if let Some(current) = state
                .attachments
                .iter_mut()
                .find(|current| current.id == attachment_id)
            {
                *current = attachment;
            }
        }
        ClientStateMutation::RemoveAttachment { attachment_id } => {
            state
                .attachments
                .retain(|attachment| attachment.id != attachment_id);
        }
        ClientStateMutation::ConsumeComposer { mut entry } => {
            if let Some(entry) = entry.as_mut() {
                entry.attachments = merge_attachment_refs(&state.attachments, &entry.attachments);
            }
            state.draft.clear();
            state.attachments.clear();
            if let Some(entry) = entry {
                if !state.queue.iter().any(|current| current.id == entry.id) {
                    state.queue.push(entry);
                }
            }
        }
        ClientStateMutation::RestoreComposer {
            draft,
            attachments,
            entry_id,
        } => {
            if let Some(entry_id) = entry_id {
                state.queue.retain(|entry| entry.id != entry_id);
            }
            restore_draft(&mut state.draft, &draft);
            state.attachments = merge_attachment_refs(&attachments, &state.attachments);
        }
        ClientStateMutation::ApplyHandoff {
            draft, attachments, ..
        } => {
            append_handoff_draft(&mut state.draft, draft.as_deref());
            state.attachments = merge_attachment_refs(&state.attachments, &attachments);
        }
    }
}

fn update_queue_tombstones(
    tombstones: &mut HashMap<ScopeKey, HashSet<String>>,
    key: &ScopeKey,
    mutation: &ClientStateMutation,
) {
    let values = tombstones.entry(key.clone()).or_default();
    match mutation {
        ClientStateMutation::RemoveQueue { entry_id } => {
            values.insert(entry_id.clone());
        }
        ClientStateMutation::RestoreComposer {
            entry_id: Some(entry_id),
            ..
        } => {
            values.insert(entry_id.clone());
        }
        ClientStateMutation::AddQueue { entry, .. }
        | ClientStateMutation::RestoreQueue { entry }
        | ClientStateMutation::ConsumeComposer { entry: Some(entry) } => {
            values.remove(&entry.id);
        }
        _ => {}
    }
    if values.is_empty() {
        tombstones.remove(key);
    }
}

fn emit_client_state(
    app: &AppHandle,
    instance_id: &str,
    instance_generation: u64,
    profile_id: &str,
    session_id: &str,
    state: &SessionClientState,
    client_id: Option<&str>,
) {
    workspace_event(
        app,
        json!({
            "type": "client-state", "instanceId": instance_id,
            "instanceGeneration": instance_generation,
            "profileId": profile_id,
            "sessionId": session_id, "state": state,
            "clientId": client_id,
        }),
    );
}

#[tauri::command]
pub(crate) fn workspace_sync_client_state(
    app: AppHandle,
    request: SyncClientStateRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<SessionClientState, String> {
    // Keep instance configuration stable until client state is stored and its
    // queue contribution reaches the instance-switch guard. Lock order matches
    // configure_hermes_instance: backend, then workspace.
    let backend_guard = backend
        .0
        .lock()
        .map_err(|_| "Hermes gateway state is unavailable")?;
    if !client_state_scope_matches(
        &backend_guard.config,
        backend_guard.generation,
        &request.instance_id,
        request.instance_generation,
    ) {
        return Err("Client state belongs to a stale Hermes instance generation".to_string());
    }
    let instance_id = configured_instance_id(&backend_guard.config);
    let instance_generation = backend_guard.generation;
    let key = (request.profile_id.clone(), request.session_id.clone());
    let removed_queue_entries = workspace
        .removed_queue_entries
        .lock()
        .map_err(|_| "Workspace queue recovery state is unavailable")?
        .get(&key)
        .cloned()
        .unwrap_or_default();
    let state = {
        let mut states = workspace
            .client_states
            .lock()
            .map_err(|_| "Workspace client state is unavailable")?;
        let state = states.entry(key).or_default();
        *state = corrected_recovery_client_state(
            &request.state,
            state,
            request.base_state.as_ref(),
            &removed_queue_entries,
        );
        state.clone()
    };
    recompute_active_work(&app, &workspace);
    drop(backend_guard);
    emit_client_state(
        &app,
        &instance_id,
        instance_generation,
        &request.profile_id,
        &request.session_id,
        &state,
        None,
    );
    Ok(state)
}

#[tauri::command]
pub(crate) fn workspace_mutate_client_state(
    app: AppHandle,
    request: MutateClientStateRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<SessionClientState, String> {
    // Match configure_hermes_instance lock order so the generation cannot
    // change between validation and mutation.
    let backend_guard = backend
        .0
        .lock()
        .map_err(|_| "Hermes gateway state is unavailable")?;
    if !client_state_scope_matches(
        &backend_guard.config,
        backend_guard.generation,
        &request.instance_id,
        request.instance_generation,
    ) {
        return Err("Client state belongs to a stale Hermes instance generation".to_string());
    }
    let instance_id = configured_instance_id(&backend_guard.config);
    let instance_generation = backend_guard.generation;
    let key = (request.profile_id.clone(), request.session_id.clone());
    let handoff_id = match &request.mutation {
        ClientStateMutation::ApplyHandoff { handoff_id, .. } => Some(handoff_id.clone()),
        _ => None,
    };
    workspace
        .removed_queue_entries
        .lock()
        .map_err(|_| "Workspace queue recovery state is unavailable")
        .map(|mut tombstones| update_queue_tombstones(&mut tombstones, &key, &request.mutation))?;
    let state = {
        let mut applied_handoffs = workspace
            .applied_handoffs
            .lock()
            .map_err(|_| "Workspace handoff state is unavailable")?;
        let mut states = workspace
            .client_states
            .lock()
            .map_err(|_| "Workspace client state is unavailable")?;
        let state = states.entry(key.clone()).or_default();
        let already_applied = handoff_id.as_ref().is_some_and(|handoff_id| {
            applied_handoffs
                .get(&key)
                .is_some_and(|values| values.contains(handoff_id))
        });
        if !already_applied {
            apply_client_state_mutation(state, request.mutation);
            if let Some(handoff_id) = handoff_id {
                applied_handoffs.entry(key).or_default().insert(handoff_id);
            }
        }
        state.clone()
    };
    recompute_active_work(&app, &workspace);
    drop(backend_guard);
    emit_client_state(
        &app,
        &instance_id,
        instance_generation,
        &request.profile_id,
        &request.session_id,
        &state,
        Some(&request.client_id),
    );
    Ok(state)
}

#[tauri::command]
pub(crate) fn workspace_get_client_state(
    request: GetClientStateRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<SessionClientState, String> {
    let backend_guard = backend
        .0
        .lock()
        .map_err(|_| "Hermes gateway state is unavailable")?;
    if !client_state_scope_matches(
        &backend_guard.config,
        backend_guard.generation,
        &request.instance_id,
        request.instance_generation,
    ) {
        return Err("Client state belongs to a stale Hermes instance generation".to_string());
    }
    let key = (request.profile_id, request.session_id);
    workspace
        .client_states
        .lock()
        .map_err(|_| "Workspace client state is unavailable".to_string())
        .map(|states| states.get(&key).cloned().unwrap_or_default())
}

#[tauri::command]
pub(crate) fn workspace_open_external(request: OpenExternalRequest) -> Result<(), String> {
    open_external_url(request.url)
}

#[tauri::command]
pub(crate) async fn workspace_read_gateway_file(
    request: ReadGatewayFileRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<GatewayFileData, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let connection = connection_for(&backend, Some(&request.profile_id))?;
    read_gateway_file_data(&connection, &request.path).await
}

#[tauri::command]
pub(crate) fn workspace_copy_error_details(
    request: ErrorDetailsRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<String, String> {
    let config = backend
        .0
        .lock()
        .map_err(|_| "Hermes gateway state is unavailable")?
        .config
        .clone();
    let scope = request.profile_id.as_deref().unwrap_or("all");
    let error = workspace
        .last_errors
        .lock()
        .ok()
        .and_then(|errors| errors.get(scope).or_else(|| errors.get("all")).cloned())
        .unwrap_or_else(|| "No recorded connection error".to_string());
    Ok(format!(
        "Ask Hermes workspace\nInstance: {}\nMode: {}\nAddress: {}:{}\nProfile: {}\nError: {}",
        if config.instance_name.is_empty() {
            "Hermes"
        } else {
            &config.instance_name
        },
        if config.remote {
            "existing"
        } else {
            "automatic"
        },
        config.address,
        config.port,
        scope,
        error,
    ))
}

#[tauri::command]
pub(crate) async fn workspace_transcribe_voice(
    request: TranscribeVoiceRequest,
    backend: tauri::State<'_, HermesBackend>,
    workspace: tauri::State<'_, WorkspaceBackend>,
) -> Result<Value, String> {
    let _instance_operation =
        begin_scoped_gateway_operation(&backend, &workspace, &request.instance).await?;
    let profile_id = request.profile_id.clone();
    let data_url = if request.data_url.starts_with("data:") {
        request.data_url
    } else {
        format!(
            "data:{};base64,{}",
            request.mime_type.as_deref().unwrap_or("audio/webm"),
            request.data_url
        )
    };
    let timeout = super::transcription_timeout(data_url.len());
    let connection = connection_for(&backend, Some(&profile_id))?;
    let payload = hermes_http_json(
        &connection,
        Method::POST,
        "/api/audio/transcribe",
        Some(json!({
            "data_url": data_url,
            "mime_type": request.mime_type.unwrap_or_else(|| "audio/webm".to_string()),
        })),
        timeout,
    )
    .await?;
    Ok(json!({
        "transcript": payload.get("text").or_else(|| payload.get("transcript")).and_then(Value::as_str).unwrap_or_default()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn history_windows_are_non_overlapping() {
        assert_eq!(history_page_window(120, 50, None), (70, 50));
        assert_eq!(history_page_window(120, 50, Some(70)), (20, 50));
        assert_eq!(history_page_window(120, 50, Some(20)), (0, 20));
        assert_eq!(history_page_window(0, 50, None), (0, 0));
    }

    #[test]
    fn active_branch_ids_are_resolved_with_profile_scope() {
        let active = json!({ "sessions": [
            { "id": "runtime-default", "session_key": "same-key", "profile": "default" },
            { "id": "runtime-work", "stored_session_id": "same-key", "profile_name": "work" },
            { "id": "runtime-child", "session_key": "child-key", "info": { "profile_name": "work" } }
        ] });
        assert_eq!(
            active_runtime_for_stored(&active, "work", "same-key").as_deref(),
            Some("runtime-work")
        );
        assert_eq!(
            active_stored_for_runtime(&active, "work", "runtime-child").as_deref(),
            Some("child-key")
        );
        assert_eq!(
            active_stored_for_runtime(&active, "default", "runtime-child"),
            None
        );
    }

    #[test]
    fn stale_client_state_sync_is_rejected_after_instance_switch_or_switch_back() {
        let mut config = super::super::HermesInstanceConfig {
            instance_id: "instance-a".to_string(),
            ..super::super::HermesInstanceConfig::default()
        };
        assert!(client_state_scope_matches(&config, 4, "instance-a", 4));
        config.instance_id = "instance-b".to_string();
        assert!(!client_state_scope_matches(&config, 5, "instance-a", 4));
        config.instance_id = "instance-a".to_string();
        assert!(!client_state_scope_matches(&config, 6, "instance-a", 4));
    }

    #[tokio::test]
    async fn finalizing_turn_remains_authoritative_until_explicit_cleanup() {
        let workspace = WorkspaceBackend::default();
        let key = ("default".to_string(), "settling-session".to_string());
        workspace.finalizing.lock().unwrap().insert(key.clone());
        assert!(turn_is_active(&workspace, &key));
        assert!(has_authoritative_live_work(&workspace));

        clear_session_state(&workspace, &key);
        assert!(!turn_is_active(&workspace, &key));
        assert!(!has_authoritative_live_work(&workspace));

        workspace.finalizing.lock().unwrap().insert(key);
        workspace.reset_for_instance_switch().await;
        assert!(!has_authoritative_live_work(&workspace));
    }

    #[tokio::test]
    async fn handoff_destination_survives_renderer_retry_until_instance_switch() {
        let workspace = WorkspaceBackend::default();
        let destination = HandoffDestination {
            profile_id: "default".to_string(),
            session_id: "created-once".to_string(),
            created: true,
        };
        workspace
            .handoff_destinations
            .lock()
            .await
            .insert("handoff-1".to_string(), destination.clone());

        assert_eq!(
            workspace
                .handoff_destinations
                .lock()
                .await
                .get("handoff-1")
                .cloned(),
            Some(destination)
        );

        workspace.reset_for_instance_switch().await;
        assert!(workspace.handoff_destinations.lock().await.is_empty());
    }

    #[test]
    fn reconciliation_keeps_owned_turn_while_finalizing() {
        let key = ("default".to_string(), "settling-session".to_string());
        let none = HashSet::new();
        let finalizing = HashSet::from([key.clone()]);
        assert!(retain_owned_during_reconcile(
            &key,
            "default",
            true,
            &none,
            &none,
            &none,
            &finalizing,
        ));
        assert!(!retain_owned_during_reconcile(
            &key, "default", true, &none, &none, &none, &none,
        ));
    }

    #[tokio::test]
    async fn scoped_gateway_operation_rejects_stale_generation_and_blocks_switch() {
        let backend = HermesBackend::default();
        let workspace = WorkspaceBackend::default();
        let (instance_id, instance_generation) = backend
            .0
            .lock()
            .map(|state| (configured_instance_id(&state.config), state.generation))
            .unwrap();
        let current = InstanceScope {
            instance_id: instance_id.clone(),
            instance_generation,
        };
        let operation = begin_scoped_gateway_operation(&backend, &workspace, &current)
            .await
            .unwrap();
        assert!(workspace.instance_operations.try_write().is_err());
        drop(operation);
        assert!(workspace.instance_operations.try_write().is_ok());

        let stale = InstanceScope {
            instance_id,
            instance_generation: instance_generation.wrapping_add(1),
        };
        assert!(begin_scoped_gateway_operation(&backend, &workspace, &stale)
            .await
            .unwrap_err()
            .contains("stale Hermes instance generation"));
    }

    #[tokio::test]
    async fn current_instance_preflight_guard_blocks_configuration() {
        let workspace = WorkspaceBackend::default();
        let operation = begin_current_instance_operation(&workspace).await;
        assert!(workspace.instance_operations.try_write().is_err());
        drop(operation);
        assert!(workspace.instance_operations.try_write().is_ok());
    }

    #[test]
    fn gateway_read_requests_require_instance_scope() {
        assert!(serde_json::from_value::<InstanceScope>(json!({})).is_err());
        assert!(serde_json::from_value::<ProfileRequest>(json!({
            "profileId": "default"
        }))
        .is_err());
        assert!(
            serde_json::from_value::<ResolveSessionProfileRequest>(json!({
                "sessionId": "session-1"
            }))
            .is_err()
        );
        assert!(serde_json::from_value::<SessionRefRequest>(json!({
            "profileId": "default", "sessionId": "session-1"
        }))
        .is_err());
        assert!(serde_json::from_value::<SessionPageRequest>(json!({
            "profileId": "default", "limit": 20
        }))
        .is_err());
        assert!(serde_json::from_value::<MessagePageRequest>(json!({
            "profileId": "default", "sessionId": "session-1", "limit": 20
        }))
        .is_err());
        assert!(serde_json::from_value::<SearchRequest>(json!({
            "query": "needle",
            "filters": { "includeActive": true, "includeArchived": true },
            "limit": 20
        }))
        .is_err());
        assert!(serde_json::from_value::<ResolveSearchHitRequest>(json!({
            "profileId": "default",
            "sessionId": "session-1",
            "resolver": { "kind": "message", "query": "needle", "excerpt": "needle" }
        }))
        .is_err());
        assert!(serde_json::from_value::<ScheduleRunsRequest>(json!({
            "profileId": "default", "scheduleId": "schedule-1", "limit": 20
        }))
        .is_err());
    }

    #[test]
    fn malformed_profile_contract_is_rejected_instead_of_defaulted() {
        let missing_profiles =
            map_profile_responses(&json!({}), &json!({ "active": "default" })).unwrap_err();
        assert!(missing_profiles.starts_with("Incompatible Hermes gateway"));

        let missing_active =
            map_profile_responses(&json!({ "profiles": [{ "name": "default" }] }), &json!({}))
                .unwrap_err();
        assert!(missing_active.contains("non-empty active profile"));

        let unknown_active = map_profile_responses(
            &json!({ "profiles": [{ "name": "default" }] }),
            &json!({ "active": "work" }),
        )
        .unwrap_err();
        assert!(unknown_active.contains("absent from GET /api/profiles"));
    }

    #[test]
    fn capability_probe_recognizes_legacy_unknown_method_errors() {
        assert!(rpc_error_reports_unknown_method(
            &json!({ "code": -32601, "message": "anything" })
        ));
        assert!(rpc_error_reports_unknown_method(
            &json!({ "code": -32000, "message": "Unknown method: session.branch" })
        ));
        assert!(!rpc_error_reports_unknown_method(
            &json!({ "code": -32000, "message": "Session was not found" })
        ));
    }

    #[test]
    fn gateway_file_path_normalizes_file_urls_and_rejects_active_data() {
        assert_eq!(
            validated_gateway_file_path("file:///tmp/a%20b.png").unwrap(),
            "/tmp/a b.png"
        );
        assert_eq!(
            validated_gateway_file_path("file:///C:/Users/me/a%20b.png").unwrap(),
            "C:/Users/me/a b.png"
        );
        assert!(validated_gateway_file_path("https://example.test/report.pdf").is_err());
        assert!(validated_gateway_file_path("data:text/html;base64,PGgxPk5vPC9oMT4=").is_err());
        assert!(gateway_file_data_from_response(
            "/gateway/report.html",
            &json!({ "dataUrl": "data:text/html,<script>alert(1)</script>" }),
        )
        .is_err());
        assert!(gateway_file_data_from_response(
            "/gateway/report.bin",
            &json!({ "dataUrl": "data:application/octet-stream;base64,%%%%" }),
        )
        .is_err());
    }

    #[tokio::test]
    async fn forced_contract_check_bypasses_same_version_cache() {
        let workspace = WorkspaceBackend::default();
        workspace
            .validated_contracts
            .lock()
            .unwrap()
            .insert(("default".to_string(), "same-version".to_string()));
        let connection = HermesGatewayConnection {
            http_url: "http://127.0.0.1:9".to_string(),
            ws_url: "ws://127.0.0.1:9/api/ws".to_string(),
            token: String::new(),
        };
        let status = json!({ "version": "same-version" });
        ensure_gateway_contract(&connection, "default", &status, &workspace, false)
            .await
            .unwrap();
        assert!(
            ensure_gateway_contract(&connection, "default", &status, &workspace, true)
                .await
                .is_err()
        );
    }

    #[test]
    fn client_state_mutation_uses_camel_case_tag_and_fields() {
        let mutation: ClientStateMutation = serde_json::from_value(json!({
            "kind": "removeQueue",
            "entryId": "queued"
        }))
        .unwrap();
        assert!(matches!(
            mutation,
            ClientStateMutation::RemoveQueue { entry_id } if entry_id == "queued"
        ));
    }

    fn client_queue_entry(id: &str) -> QueueEntry {
        QueueEntry {
            id: id.to_string(),
            text: id.to_string(),
            created_at: "2026-07-22T00:00:00Z".to_string(),
            attachments: Vec::new(),
            settings: None,
        }
    }

    #[test]
    fn atomic_queue_append_and_stale_base_draft_edit_preserve_both_fields() {
        let base = SessionClientState::default();
        let mut queue_then_draft = base.clone();
        apply_client_state_mutation(
            &mut queue_then_draft,
            ClientStateMutation::AddQueue {
                entry: client_queue_entry("queued"),
                front: false,
            },
        );
        apply_client_state_mutation(
            &mut queue_then_draft,
            ClientStateMutation::SetDraft {
                draft: "typed from stale window".to_string(),
            },
        );

        let mut draft_then_queue = base;
        apply_client_state_mutation(
            &mut draft_then_queue,
            ClientStateMutation::SetDraft {
                draft: "typed from stale window".to_string(),
            },
        );
        apply_client_state_mutation(
            &mut draft_then_queue,
            ClientStateMutation::AddQueue {
                entry: client_queue_entry("queued"),
                front: false,
            },
        );

        for state in [queue_then_draft, draft_then_queue] {
            assert_eq!(state.draft, "typed from stale window");
            assert_eq!(state.queue.len(), 1);
            assert_eq!(state.queue[0].id, "queued");
        }
    }

    #[test]
    fn atomic_queue_removal_and_stale_base_draft_edit_preserve_both_fields() {
        let base = SessionClientState {
            draft: "old".to_string(),
            queue: vec![client_queue_entry("remove"), client_queue_entry("keep")],
            attachments: Vec::new(),
        };
        let mut state = base;
        apply_client_state_mutation(
            &mut state,
            ClientStateMutation::RemoveQueue {
                entry_id: "remove".to_string(),
            },
        );
        apply_client_state_mutation(
            &mut state,
            ClientStateMutation::SetDraft {
                draft: "new draft".to_string(),
            },
        );
        assert_eq!(state.draft, "new draft");
        assert_eq!(state.queue.len(), 1);
        assert_eq!(state.queue[0].id, "keep");
    }

    #[test]
    fn rapid_queue_mutations_apply_in_fifo_order() {
        let mut state = SessionClientState {
            draft: String::new(),
            queue: vec![
                client_queue_entry("a"),
                client_queue_entry("b"),
                client_queue_entry("c"),
            ],
            attachments: Vec::new(),
        };
        apply_client_state_mutation(
            &mut state,
            ClientStateMutation::UpdateQueue {
                entry_id: "b".to_string(),
                text: "edited".to_string(),
            },
        );
        apply_client_state_mutation(
            &mut state,
            ClientStateMutation::MoveQueue {
                entry_id: "b".to_string(),
                direction: -1,
            },
        );
        apply_client_state_mutation(
            &mut state,
            ClientStateMutation::RemoveQueue {
                entry_id: "a".to_string(),
            },
        );
        assert_eq!(
            state
                .queue
                .iter()
                .map(|entry| format!("{}:{}", entry.id, entry.text))
                .collect::<Vec<_>>(),
            vec!["b:edited", "c:c"]
        );
    }

    #[test]
    fn recovery_three_way_merge_does_not_resurrect_concurrently_removed_queue() {
        let base = SessionClientState {
            draft: String::new(),
            queue: vec![client_queue_entry("removed-between-get-and-sync")],
            attachments: Vec::new(),
        };
        let desired = SessionClientState {
            draft: "recovered draft".to_string(),
            queue: vec![
                client_queue_entry("persisted-only"),
                client_queue_entry("removed-between-get-and-sync"),
            ],
            attachments: Vec::new(),
        };
        let current = SessionClientState::default();
        let merged = merge_recovery_client_state(&desired, &current, Some(&base));
        assert_eq!(merged.draft, "recovered draft");
        assert_eq!(merged.queue.len(), 1);
        assert_eq!(merged.queue[0].id, "persisted-only");
    }

    #[test]
    fn recovery_tombstone_beats_stale_seed_when_remote_is_already_empty() {
        let key = ("default".to_string(), "session".to_string());
        let mut tombstones = HashMap::new();
        update_queue_tombstones(
            &mut tombstones,
            &key,
            &ClientStateMutation::RemoveQueue {
                entry_id: "stale-seed".to_string(),
            },
        );
        let desired = SessionClientState {
            draft: String::new(),
            queue: vec![client_queue_entry("stale-seed")],
            attachments: Vec::new(),
        };
        let base = SessionClientState::default();
        let removed = tombstones.get(&key).unwrap();
        let corrected = corrected_recovery_client_state(&desired, &base, Some(&base), removed);
        assert!(corrected.queue.is_empty());
    }

    #[test]
    fn attachment_upload_rejects_gateway_false_success_and_missing_references() {
        assert_eq!(
            attachment_result_reference(
                &json!({ "attached": false, "message": "upload denied" }),
                "text/plain",
                "notes.txt",
            )
            .unwrap_err(),
            "upload denied"
        );
        assert!(attachment_result_reference(
            &json!({ "attached": true }),
            "text/plain",
            "notes.txt",
        )
        .unwrap_err()
        .contains("did not return an attachment reference"));
        assert_eq!(
            attachment_result_reference(
                &json!({ "attached": true, "ref_text": "@file:notes.txt" }),
                "text/plain",
                "notes.txt",
            )
            .unwrap(),
            "@file:notes.txt"
        );
        assert_eq!(
            attachment_result_reference(
                &json!({ "attached": true, "path": "/tmp/image.png" }),
                "image/png",
                "image.png",
            )
            .unwrap(),
            "/tmp/image.png"
        );
    }

    #[test]
    fn date_only_filters_cover_the_whole_end_day() {
        let from = parse_iso_filter(Some("2026-07-22"), false).unwrap();
        let to = parse_iso_filter(Some("2026-07-22"), true).unwrap();
        assert_eq!(from.to_rfc3339(), "2026-07-22T00:00:00+00:00");
        assert!(to > from + chrono::Duration::hours(23));
        assert!(to < from + chrono::Duration::days(1));
    }

    #[test]
    fn search_snippet_anchor_prefers_exact_context_segments() {
        assert_eq!(
            search_snippet_segments("…before >>>needle<<< after...tail"),
            vec!["before needle after", "tail"]
        );
    }

    #[test]
    fn search_uses_gateway_message_anchor_variants_without_lookup() {
        assert_eq!(
            search_hit_message_id(&json!({ "match_message_id": 42 })),
            Some("42".to_string())
        );
        assert_eq!(
            search_hit_message_id(&json!({ "messageId": "message-7" })),
            Some("message-7".to_string())
        );
        assert_eq!(search_hit_message_id(&json!({ "message_id": null })), None);
    }

    #[test]
    fn search_anchor_requires_ordered_context_and_honors_role() {
        let row = json!({
            "id": 2,
            "role": "assistant",
            "content": "prefix before needle after middle tail suffix"
        });
        let segments = search_snippet_segments("...before >>>needle<<< after...tail...");
        let query = search_query_terms("needle");
        assert_eq!(search_row_match_level(&row, None, &segments, &query), 2);
        assert_eq!(
            search_row_match_level(&row, Some("user"), &segments, &query),
            0
        );
        assert_eq!(
            search_row_match_level(
                &row,
                None,
                &search_snippet_segments("tail...before >>>needle<<< after"),
                &query,
            ),
            1
        );
    }

    #[test]
    fn schedule_mapping_preserves_oneshot_and_unknown_fields() {
        let mapped = map_schedule(
            &json!({
                "id": "job-1", "profile": "default", "name": "Once",
                "schedule": { "kind": "once", "run_at": "2026-08-01T10:00:00+00:00", "display": "once at ..." },
                "deliver": "discord", "future_option": { "x": 1 }, "last_error": "",
                "repeat": { "times": 5, "completed": 3 },
                "last_status": "success", "last_delivery_error": "old",
                "latest_execution": { "status": "complete" },
                "provider_snapshot": "stale-provider", "model_snapshot": "stale-model",
            }),
            None,
        );
        assert_eq!(mapped["cron"], "2026-08-01T10:00:00+00:00");
        assert_eq!(mapped["state"], "active");
        assert_eq!(mapped["preservedFields"]["future_option"]["x"], 1);
        assert_eq!(mapped["preservedFields"]["deliver"], "discord");
        assert_eq!(mapped["preservedFields"]["repeat"], json!({ "times": 5 }));
        for field in [
            "last_status",
            "last_delivery_error",
            "latest_execution",
            "provider_snapshot",
            "model_snapshot",
        ] {
            assert!(
                mapped["preservedFields"].get(field).is_none(),
                "{field} leaked into editable fields"
            );
        }
    }

    #[test]
    fn schedule_edit_prefers_fresh_hidden_fields_over_form_snapshot() {
        let fields = latest_schedule_fields(
            &json!({
                "id": "job-1", "name": "Job", "prompt": "run", "schedule": "0 * * * *",
                "deliver": "slack", "script": "fresh.py", "future_option": { "revision": 2 }
            }),
            Some(
                json!({
                    "deliver": "discord", "script": "stale.py",
                    "future_option": { "revision": 1 }, "legacy_omitted": true
                })
                .as_object()
                .unwrap()
                .clone(),
            ),
        );
        assert_eq!(fields["deliver"], "slack");
        assert_eq!(fields["script"], "fresh.py");
        assert_eq!(fields["future_option"]["revision"], 2);
        assert_eq!(fields["legacy_omitted"], true);
    }

    #[test]
    fn schedule_edit_preserves_fresh_structured_schedule_when_cron_was_unchanged() {
        let current = json!({
            "schedule": { "kind": "interval", "minutes": 15, "jitter": 2 }
        });

        assert_eq!(
            edited_schedule_value(&current, "every 10m", Some("every 10m")),
            json!({ "kind": "interval", "minutes": 15, "jitter": 2 })
        );
        assert_eq!(
            edited_schedule_value(&current, "0 * * * *", Some("every 10m")),
            Value::String("0 * * * *".to_string())
        );
    }

    #[test]
    fn source_mapping_keeps_workspace_distinct_from_desktop() {
        assert_eq!(source_name(Some("workspace")), "workspace");
        assert_eq!(source_name(Some("desktop")), "desktop");
    }

    #[test]
    fn schedule_run_paging_fetches_lookahead_and_exposes_full_first_page_cursor() {
        assert_eq!(schedule_run_fetch_limit(0, 30), 31);
        assert_eq!(schedule_run_fetch_limit(30, 30), 61);
        assert_eq!(schedule_run_fetch_limit(90, 30), 100);
        assert_eq!(schedule_run_next_cursor(0, 30, 31).as_deref(), Some("30"));
        assert_eq!(schedule_run_next_cursor(0, 30, 30), None);
        assert_eq!(schedule_run_next_cursor(90, 10, 100), None);
    }

    #[test]
    fn message_fallback_id_is_stable_and_models_keep_provider_identity() {
        let row = json!({ "role": "assistant", "content": "same", "timestamp": 10 });
        assert_eq!(
            map_message(&row, "p", "s")["id"],
            map_message(&row, "p", "s")["id"]
        );
        let models = map_models(&json!({
            "providers": [
                { "slug": "a", "models": [
                    { "id": "shared", "capabilities": { "reasoning": true } },
                    "shared-fast"
                ] },
                { "slug": "b", "models": ["shared"] }
            ]
        }));
        assert_eq!(models.len(), 3);
        let base = models
            .iter()
            .find(|model| model["provider"] == "a" && model["id"] == "shared")
            .unwrap();
        assert_eq!(
            base["reasoningEfforts"],
            json!(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
        );
        assert!(models
            .iter()
            .any(|model| model["provider"] == "a" && model["id"] == "shared-fast"));
    }

    #[test]
    fn rich_history_preserves_files_tool_results_interactions_todos_and_usage() {
        let rows = vec![
            json!({
                "id": 1,
                "role": "user",
                "content": [
                    { "type": "text", "text": "Review this\n\n--- Attached Context ---\n@file:`reports/input.pdf`\n(binary omitted)" },
                    { "type": "input_file", "file": {
                        "filename": "notes.txt", "mime_type": "text/plain", "url": "https://example.test/notes.txt", "size": 42
                    } }
                ],
                "timestamp": 1
            }),
            json!({
                "id": 2,
                "role": "assistant",
                "reasoning": "Inspecting source files",
                "tool_calls": [
                    { "id": "todo-1", "function": { "name": "todo", "arguments": "{\"todos\":[{\"content\":\"Build report\",\"status\":\"pending\"}]}" } },
                    { "id": "clarify-1", "function": { "name": "clarify", "arguments": "{\"question\":\"Which format?\",\"choices\":[\"PDF\",\"HTML\"]}" } }
                ],
                "timestamp": 2
            }),
            json!({
                "id": 3,
                "role": "tool",
                "tool_call_id": "todo-1",
                "tool_name": "todo",
                "content": "{\"todos\":[{\"content\":\"Build report\",\"status\":\"completed\"}],\"output_path\":\"/tmp/report.pdf\"}",
                "timestamp": 3
            }),
            json!({
                "id": 4,
                "role": "tool",
                "tool_call_id": "clarify-1",
                "tool_name": "clarify",
                "content": "{\"answer\":\"PDF\"}",
                "timestamp": 4
            }),
            json!({
                "id": 5,
                "role": "assistant",
                "content": "Done: [report](/tmp/report.pdf)",
                "usage": { "input": 120, "output": 30, "total": 150, "context_used": 400, "context_max": 1000 },
                "timestamp": 5
            }),
        ];

        let messages = map_messages(&rows, "work", "session-1");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["content"], "Review this");
        assert_eq!(messages[0]["attachments"].as_array().unwrap().len(), 2);
        assert!(messages[0]["attachments"]
            .as_array()
            .unwrap()
            .iter()
            .any(|attachment| attachment["name"] == "notes.txt"));

        let assistant = &messages[1];
        assert_eq!(assistant["id"], "5");
        assert_eq!(assistant["sourceMessageIds"], json!(["2", "3", "4", "5"]));
        assert_eq!(assistant["tools"][0]["status"], "complete");
        assert!(assistant["tools"][0]["output"]
            .as_str()
            .unwrap()
            .contains("output_path"));
        assert_eq!(assistant["todos"].as_array().unwrap().len(), 1);
        assert_eq!(assistant["todos"][0]["status"], "completed");
        assert_eq!(assistant["interactions"][0]["title"], "Which format?");
        assert_eq!(assistant["interactions"][0]["resolved"], true);
        assert!(assistant["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|artifact| artifact["value"] == "/tmp/report.pdf"));
        assert_eq!(assistant["reasoning"], "Inspecting source files");
        assert_eq!(assistant["usage"]["totalTokens"], 150);
        assert_eq!(assistant["usage"]["contextTokens"], 400);
    }

    #[test]
    fn persisted_gateway_interactions_render_as_non_respondable_history() {
        let mapped = map_message(
            &json!({
                "id": "m",
                "role": "assistant",
                "content": "Waiting",
                "approval": {
                    "request_id": "approval-7", "description": "Run command?", "command": "rm temp.txt", "status": "pending"
                },
                "token_count": 9
            }),
            "default",
            "s",
        );
        assert_eq!(mapped["interactions"][0]["kind"], "approval");
        assert_eq!(mapped["interactions"][0]["resolved"], false);
        assert_eq!(mapped["interactions"][0]["respondable"], false);
        assert_eq!(mapped["totalTokens"], 9);
    }

    #[test]
    fn rejects_old_desktop_contract_and_limits_recovery_to_owned_turns() {
        assert!(validate_desktop_contract(&json!({
            "info": { "desktop_contract": REQUIRED_DESKTOP_CONTRACT }
        }))
        .is_ok());
        let error = validate_desktop_contract(&json!({
            "info": { "desktop_contract": REQUIRED_DESKTOP_CONTRACT - 1 }
        }))
        .unwrap_err();
        assert!(error.contains("Incompatible Hermes gateway"));
        assert!(error.contains("Update Hermes or derp-agent"));

        let ask = ("default".to_string(), "ask-turn".to_string());
        let external = ("default".to_string(), "cli-turn".to_string());
        let server = HashSet::from([ask.clone(), external]);
        let owned = HashSet::from([ask.clone()]);
        assert_eq!(recoverable_active_keys(&server, &owned), vec![ask]);
    }

    #[test]
    fn active_list_contract_keeps_builds_and_interactions_busy() {
        for status in ["starting", "waiting", "working", "running", "stalled"] {
            assert!(active_list_row_is_active(&json!({ "status": status })));
        }
        assert!(active_list_row_is_active(&json!({
            "status": "idle",
            "running": true,
        })));
        assert!(!active_list_row_is_active(&json!({
            "status": "waiting",
            "running": false,
        })));
        assert!(!active_list_row_is_active(&json!({ "status": "idle" })));
    }

    #[test]
    fn reconnect_mapping_preserves_server_reported_stalled_state() {
        let backend = WorkspaceBackend::default();
        let key = ("work".to_string(), "session-1".to_string());
        backend.server_active.lock().unwrap().insert(key.clone());
        backend.server_active_rows.lock().unwrap().insert(
            key,
            json!({
                "id": "runtime-1",
                "session_key": "session-1",
                "profile": "work",
                "status": "stalled"
            }),
        );

        let mapped = map_session(
            &json!({
                "id": "session-1",
                "profile": "work",
                "started_at": 1,
                "last_active": 2
            }),
            Some("work"),
            &backend,
        );

        assert_eq!(mapped["turnState"], "stalled");
    }

    #[test]
    fn session_info_maps_effective_yolo_and_global_approval_mode() {
        let settings = turn_settings_from_row(&json!({
            "model": "stored-model",
            "provider": "stored-provider",
            "info": {
                "model": "live-model",
                "provider": "live-provider",
                "reasoning_effort": "high",
                "fast": true,
                "personality": "concise",
                "approval_mode": "off",
                "yolo": true
            }
        }));
        assert_eq!(settings.model.as_deref(), Some("live-model"));
        assert_eq!(settings.provider.as_deref(), Some("live-provider"));
        assert_eq!(settings.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(settings.fast, Some(true));
        assert_eq!(settings.personality.as_deref(), Some("concise"));
        assert_eq!(settings.approval_mode.as_deref(), Some("off"));
        assert_eq!(settings.yolo, Some(true));
    }

    #[test]
    fn active_list_nested_info_overrides_persisted_session_settings() {
        let backend = WorkspaceBackend::default();
        let key = ("work".to_string(), "session-1".to_string());
        backend.server_active.lock().unwrap().insert(key.clone());
        backend.server_active_rows.lock().unwrap().insert(
            key,
            json!({
                "id": "runtime-1",
                "session_key": "session-1",
                "profile": "work",
                "status": "working",
                "info": { "approval_mode": "smart", "yolo": true }
            }),
        );
        let mapped = map_session(
            &json!({
                "id": "session-1",
                "profile": "work",
                "model": "model-a",
                "started_at": 1,
                "last_active": 2
            }),
            Some("work"),
            &backend,
        );
        assert_eq!(mapped["settings"]["model"], "model-a");
        assert_eq!(mapped["settings"]["approvalMode"], "smart");
        assert_eq!(mapped["settings"]["yolo"], true);
    }

    #[test]
    fn active_yolo_control_uses_cached_runtime_without_resume() {
        let backend = WorkspaceBackend::default();
        let key = ("default".to_string(), "session-1".to_string());
        backend
            .runtimes
            .lock()
            .unwrap()
            .insert(key.clone(), "runtime-1".to_string());
        assert_eq!(server_runtime(&backend, &key), None);
        backend.server_active.lock().unwrap().insert(key.clone());
        assert_eq!(server_runtime(&backend, &key).as_deref(), Some("runtime-1"));
    }

    #[test]
    fn slash_fallback_requires_method_not_found() {
        assert!(rpc_method_not_found(
            "Unsupported Hermes RPC method slash.exec: method not found",
            "slash.exec"
        ));
        assert!(!rpc_method_not_found(
            "Invalid argument for slash command",
            "slash.exec"
        ));
    }

    #[test]
    fn cron_complete_without_result_status_stays_neutral() {
        let row = json!({
            "ended_at": 4,
            "end_reason": "cron_complete"
        });
        let (status, running, error) = schedule_run_state(&row);
        assert_eq!(status, "finished");
        assert!(!running);
        assert!(error.is_none());
        assert_eq!(
            schedule_run_state(&json!({ "ended_at": 4, "status": "success" })).0,
            "complete"
        );
        assert_eq!(
            schedule_run_state(&json!({ "ended_at": 4, "error": "boom" })).0,
            "error"
        );
    }

    async fn mock_http_server() -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut request = vec![0_u8; 16 * 1024];
                    let Ok(size) = stream.read(&mut request).await else {
                        return;
                    };
                    let request = String::from_utf8_lossy(&request[..size]);
                    let first = request.lines().next().unwrap_or_default();
                    let method = first.split_whitespace().next().unwrap_or("GET");
                    let path = first.split_whitespace().nth(1).unwrap_or("/");
                    let mut status = "200 OK";
                    let body = if path.starts_with("/api/status") {
                        json!({ "backend": "Mock Hermes", "version": "1.0" })
                    } else if path == "/api/fs/read-data-url?path=%2Fgateway%2Freport%20image.png" {
                        json!({ "dataUrl": "data:image/png;base64,aGVsbG8=" })
                    } else if path.starts_with("/api/profiles/active") {
                        json!({ "active": "default" })
                    } else if path.starts_with("/api/profiles/sessions") {
                        json!({ "sessions": [{
                            "id": "stored-1", "profile": "default", "title": "Mock chat",
                            "source": "desktop", "started_at": 1, "last_active": 2,
                            "message_count": 2, "archived": false
                        }] })
                    } else if path.starts_with("/api/profiles") {
                        json!({ "profiles": [
                            { "name": "default", "is_default": true },
                            { "name": "work", "is_default": false }
                        ] })
                    } else if path.contains("/runs") {
                        json!({ "runs": [{ "id": "cron_job-1_1", "source": "cron", "started_at": 3, "ended_at": 4, "end_reason": "cron_complete" }] })
                    } else if path.starts_with("/api/cron/jobs/job-1") && method == "PUT" {
                        json!({ "id": "job-1", "name": "Updated", "schedule": "0 * * * *", "profile": "default" })
                    } else if path.starts_with("/api/cron/jobs/job-1") && method == "GET" {
                        json!({ "id": "job-1", "name": "Mock schedule", "schedule": "0 * * * *", "profile": "default", "deliver": "local" })
                    } else if path.starts_with("/api/cron/jobs") && method == "POST" {
                        json!({ "id": "job-2", "name": "Created", "schedule": "0 * * * *", "profile": "default" })
                    } else if path.starts_with("/api/cron/jobs") {
                        json!({ "jobs": [{ "id": "job-1", "name": "Mock schedule", "schedule": "0 * * * *", "profile": "default" }] })
                    } else if path.starts_with("/api/sessions/search") {
                        json!({ "results": [{ "session_id": "stored-1", "snippet": "hello", "role": "user", "session_started": 1 }] })
                    } else if path.starts_with("/api/sessions/paged/messages") {
                        if path.contains("offset=0") {
                            json!({
                                "messages": (0..500)
                                    .map(|id| json!({ "id": id, "role": "assistant", "content": format!("message {id}") }))
                                    .collect::<Vec<_>>()
                            })
                        } else if path.contains("offset=500") {
                            json!({ "messages": [
                                { "id": 500, "role": "user", "content": "target" },
                                { "id": 501, "role": "assistant", "content": "must not be included" }
                            ] })
                        } else {
                            status = "500 Internal Server Error";
                            json!({ "detail": "prefix pager read past its target" })
                        }
                    } else if path.contains("/messages") {
                        json!({ "messages": [
                            { "id": 1, "role": "user", "content": [
                                { "type": "text", "text": "hello" },
                                { "type": "image_url", "image_url": { "url": "data:image/png;base64,aGVsbG8=" } }
                            ], "timestamp": 1 },
                            { "id": 2, "role": "assistant", "content": "mock answer", "timestamp": 2 }
                        ] })
                    } else if path.starts_with("/api/sessions/stored-branch") {
                        json!({ "id": "stored-branch", "profile": "default", "title": "Mock chat (branch)", "message_count": 2, "archived": false })
                    } else if path.starts_with("/api/sessions/paged") {
                        json!({ "id": "paged", "profile": "default", "title": "Paged chat", "message_count": 100_000, "archived": false })
                    } else if path.starts_with("/api/sessions/stored-1") {
                        json!({ "id": "stored-1", "profile": "default", "title": "Mock chat", "message_count": 2, "archived": method == "DELETE" })
                    } else if path.starts_with("/api/sessions/stored-b")
                        && path.contains("profile=work")
                    {
                        json!({ "id": "stored-b", "profile": "work", "title": "Busy work chat", "message_count": 4, "archived": false })
                    } else if path.starts_with("/api/sessions/stored-b") {
                        status = "404 Not Found";
                        json!({ "detail": "session not found" })
                    } else if path.starts_with("/api/model/options") {
                        json!({ "providers": [{ "slug": "mock", "models": ["mock-model"] }] })
                    } else if path.starts_with("/fail") {
                        status = "500 Internal Server Error";
                        json!({ "detail": "mock failure" })
                    } else {
                        json!({})
                    };
                    let encoded = body.to_string();
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        encoded.len(), encoded,
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        (format!("http://{address}"), task)
    }

    async fn mock_ws_server() -> (String, tokio::task::JoinHandle<()>) {
        mock_ws_server_with_active(Vec::new()).await
    }

    async fn mock_ws_server_with_active(
        active_sessions: Vec<Value>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let mut active_sessions = active_sessions.clone();
                tokio::spawn(async move {
                    let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                        return;
                    };
                    while let Some(Ok(Message::Text(text))) = socket.next().await {
                        let Ok(request) = serde_json::from_str::<Value>(&text) else {
                            continue;
                        };
                        let id = request.get("id").cloned().unwrap_or(json!(1));
                        let method = request
                            .get("method")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if method == "missing.method" {
                            let _ = socket
                                .send(Message::Text(
                                    json!({
                                        "jsonrpc": "2.0", "id": id,
                                        "error": { "code": -32601, "message": "method not found" }
                                    })
                                    .to_string()
                                    .into(),
                                ))
                                .await;
                            continue;
                        }
                        if method == "session.resume"
                            && active_sessions.iter().any(|row| {
                                active_list_row_is_active(row)
                                    && active_row_stored_id(row)
                                        == request
                                            .get("params")
                                            .and_then(|params| params.get("session_id"))
                                            .and_then(Value::as_str)
                            })
                        {
                            let _ = socket
                                .send(Message::Text(
                                    json!({
                                        "jsonrpc": "2.0", "id": id,
                                        "error": { "code": -32000, "message": "resume would steal active transport" }
                                    })
                                    .to_string()
                                    .into(),
                                ))
                                .await;
                            continue;
                        }
                        let result = match method {
                            "session.create" => {
                                json!({
                                    "session_id": "runtime-1",
                                    "stored_session_id": "stored-1",
                                    "info": { "desktop_contract": 4 }
                                })
                            }
                            "session.resume" => {
                                json!({
                                    "session_id": "runtime-1",
                                    "stored_session_id": "stored-1",
                                    "running": false,
                                    "info": { "desktop_contract": 4 }
                                })
                            }
                            "session.branch" => {
                                active_sessions.push(json!({
                                    "id": "runtime-branch",
                                    "session_key": "stored-branch",
                                    "profile": "default",
                                    "status": "idle",
                                }));
                                json!({
                                    "session_id": "runtime-branch",
                                    "title": "Mock chat (branch)",
                                    "parent": "stored-1",
                                })
                            }
                            "session.active_list" => {
                                json!({ "sessions": active_sessions.clone() })
                            }
                            "image.attach_bytes" => {
                                json!({ "attached": true, "path": "/gateway/image.png" })
                            }
                            "image.attach" => {
                                json!({ "attached": true, "path": "/gateway/image.png" })
                            }
                            "image.detach" => json!({ "detached": true }),
                            "file.attach" => {
                                json!({ "attached": true, "ref_text": "@file:mock.txt" })
                            }
                            "slash.exec" => json!({ "output": "mock slash output" }),
                            "session.steer" => json!({ "status": "steered" }),
                            _ => json!({ "ok": true }),
                        };
                        let _ = socket
                            .send(Message::Text(
                                json!({ "jsonrpc": "2.0", "id": id, "result": result })
                                    .to_string()
                                    .into(),
                            ))
                            .await;
                        if method == "prompt.submit" {
                            for event in [
                                json!({ "type": "message.delta", "payload": { "text": "mock " } }),
                                json!({ "type": "message.complete", "payload": { "text": "mock answer" } }),
                            ] {
                                let _ = socket.send(Message::Text(json!({
                                    "jsonrpc": "2.0", "method": "event",
                                    "params": { "session_id": "runtime-1", "type": event["type"], "payload": event["payload"] }
                                }).to_string().into())).await;
                            }
                        }
                    }
                });
            }
        });
        (format!("ws://{address}/api/ws"), task)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn mocked_gateway_covers_rest_mapping_and_ws_create_resume_stream() {
        let (http_url, http_task) = mock_http_server().await;
        let (ws_url, ws_task) = mock_ws_server().await;
        let connection = HermesGatewayConnection {
            http_url,
            ws_url,
            token: String::new(),
        };
        let backend = WorkspaceBackend::default();

        let status = status_for(&connection, None).await.unwrap();
        assert_eq!(status["backend"], "Mock Hermes");
        let gateway_file =
            read_gateway_file_data(&connection, "file:///gateway/report%20image.png")
                .await
                .unwrap();
        assert_eq!(gateway_file.name, "report image.png");
        assert_eq!(gateway_file.mime_type, "image/png");
        assert_eq!(gateway_file.data_url, "data:image/png;base64,aGVsbG8=");
        ensure_gateway_contract(&connection, "default", &status, &backend, false)
            .await
            .unwrap();
        let (profiles, active) = profiles_for(&connection).await.unwrap();
        assert_eq!(active, "default");
        assert_eq!(profiles.len(), 2);
        let sessions = sessions_for(&connection, Some("default"), &backend, 80, 0)
            .await
            .unwrap()
            .0;
        assert_eq!(sessions[0]["title"], "Mock chat");
        assert_eq!(
            schedules_for(&connection, Some("default")).await.unwrap()[0]["id"],
            "job-1"
        );
        assert_eq!(
            model_choices(&connection, "default").await[0]["provider"],
            "mock"
        );
        assert_eq!(
            session_detail(&connection, "default", "stored-1")
                .await
                .unwrap()["message_count"],
            2
        );
        let direct_summary = session_summary_for(&connection, "default", "stored-1", &backend)
            .await
            .unwrap();
        assert_eq!(direct_summary["id"], "stored-1");
        assert_eq!(direct_summary["profileId"], "default");
        assert_eq!(direct_summary["title"], "Mock chat");
        assert_eq!(
            raw_messages(&connection, "default", "stored-1", 50, 0)
                .await
                .unwrap()
                .len(),
            2
        );
        let prefix = raw_messages_through(&connection, "default", "paged", "500")
            .await
            .unwrap();
        assert_eq!(prefix.len(), 501);
        assert_eq!(prefix.last().unwrap()["id"], 500);
        assert_eq!(
            resolve_search_hit_message_id(
                &connection,
                "default",
                "paged",
                Some("user"),
                ">>>target<<<",
                "target",
            )
            .await
            .unwrap(),
            "500"
        );
        let (retry_text, ordinal, retry_attachments) =
            rewind_plan(&connection, "default", "stored-1", "1")
                .await
                .unwrap();
        assert_eq!(retry_text, "hello");
        assert_eq!(ordinal, 0);
        assert_eq!(retry_attachments.len(), 1);
        assert_eq!(
            retry_attachments[0].url.as_deref(),
            Some("data:image/png;base64,aGVsbG8=")
        );
        let search = hermes_http_json(
            &connection,
            Method::GET,
            "/api/sessions/search?q=hello&limit=100&profile=default",
            None,
            HTTP_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(search["results"][0]["session_id"], "stored-1");
        let created_job = hermes_http_json(
            &connection,
            Method::POST,
            "/api/cron/jobs?profile=default",
            Some(json!({ "name": "Created", "prompt": "run", "schedule": "0 * * * *" })),
            HTTP_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(created_job["id"], "job-2");
        let updated_job = hermes_http_json(
            &connection,
            Method::PUT,
            "/api/cron/jobs/job-1?profile=default",
            Some(json!({ "updates": { "name": "Updated" } })),
            HTTP_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(updated_job["name"], "Updated");
        let runs = hermes_http_json(
            &connection,
            Method::GET,
            "/api/cron/jobs/job-1/runs?profile=default&limit=20",
            None,
            HTTP_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(runs["runs"][0]["id"], "cron_job-1_1");
        for (method, path, body) in [
            (
                Method::PATCH,
                "/api/sessions/stored-1?profile=default",
                Some(json!({ "archived": true })),
            ),
            (
                Method::DELETE,
                "/api/sessions/stored-1?profile=default",
                None,
            ),
            (
                Method::POST,
                "/api/cron/jobs/job-1/pause?profile=default",
                None,
            ),
            (
                Method::POST,
                "/api/cron/jobs/job-1/trigger?profile=default",
                None,
            ),
        ] {
            hermes_http_json(&connection, method, path, body, HTTP_TIMEOUT)
                .await
                .unwrap();
        }
        assert!(
            hermes_http_json(&connection, Method::GET, "/fail", None, HTTP_TIMEOUT,)
                .await
                .unwrap_err()
                .contains("mock failure")
        );

        let (runtime, stored) =
            create_gateway_session(&connection, "default", &TurnSettings::default(), None, None)
                .await
                .unwrap();
        assert_eq!(
            (runtime.as_str(), stored.as_str()),
            ("runtime-1", "stored-1")
        );
        let (branch_runtime, branch_stored, branch_title) =
            branch_whole_gateway_session(&connection, "default", "stored-1")
                .await
                .unwrap();
        assert_eq!(branch_runtime, "runtime-branch");
        assert_eq!(branch_stored, "stored-branch");
        assert_eq!(branch_title, "Mock chat (branch)");
        let (mut socket, runtime, mut id, running, _) =
            open_runtime_socket(&connection, &backend, "default", "stored-1")
                .await
                .unwrap();
        assert!(!running);
        id += 1;
        rpc_on_socket(
            &mut socket,
            id,
            "prompt.submit",
            json!({ "session_id": runtime, "text": "hello" }),
        )
        .await
        .unwrap();
        let mut types = Vec::new();
        while types.len() < 2 {
            let frame = socket.next().await.unwrap().unwrap();
            let Message::Text(text) = frame else { continue };
            let event: Value = serde_json::from_str(&text).unwrap();
            types.push(event["params"]["type"].as_str().unwrap().to_string());
        }
        assert_eq!(types, ["message.delta", "message.complete"]);
        id += 1;
        let uploaded = upload_via_socket(
            &mut socket,
            id,
            &runtime,
            "image.png",
            "image/png",
            "data:image/png;base64,aGVsbG8=",
        )
        .await
        .unwrap();
        assert_eq!(uploaded["path"], "/gateway/image.png");
        assert_eq!(
            attachment_result_reference(&uploaded, "image/png", "image.png").unwrap(),
            "/gateway/image.png"
        );
        id += 1;
        assert_eq!(
            rpc_on_socket(
                &mut socket,
                id,
                "image.detach",
                json!({ "session_id": runtime, "path": uploaded["path"] }),
            )
            .await
            .unwrap()["detached"],
            true
        );
        id += 1;
        let uploaded_file = upload_via_socket(
            &mut socket,
            id,
            &runtime,
            "mock.txt",
            "text/plain",
            "data:text/plain;base64,aGVsbG8=",
        )
        .await
        .unwrap();
        assert_eq!(
            attachment_result_reference(&uploaded_file, "text/plain", "mock.txt").unwrap(),
            "@file:mock.txt"
        );
        id += 1;
        assert_eq!(
            rpc_on_socket(
                &mut socket,
                id,
                "slash.exec",
                json!({ "session_id": runtime, "command": "status" }),
            )
            .await
            .unwrap()["output"],
            "mock slash output"
        );
        id += 1;
        assert!(rpc_on_socket(&mut socket, id, "missing.method", json!({}))
            .await
            .unwrap_err()
            .contains("method not found"));
        reconcile_server_active(&connection, "default", &backend, false)
            .await
            .unwrap();
        assert!(backend.server_active.lock().unwrap().is_empty());
        http_task.abort();
        ws_task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn new_pending_session_is_idle_and_accepts_its_first_prompt() {
        let (http_url, http_task) = mock_http_server().await;
        let (ws_url, ws_task) = mock_ws_server_with_active(vec![json!({
            "id": "runtime-1",
            "session_key": "stored-1",
            "status": "waiting",
            "running": false,
        })])
        .await;
        let connection = HermesGatewayConnection {
            http_url,
            ws_url,
            token: String::new(),
        };
        let backend = WorkspaceBackend::default();
        let key = ("default".to_string(), "stored-1".to_string());
        backend
            .runtimes
            .lock()
            .unwrap()
            .insert(key.clone(), "runtime-1".to_string());
        backend.pending_sessions.lock().unwrap().insert(
            key.clone(),
            PendingSession {
                title: "Untitled chat".to_string(),
                created_at: chrono::Utc::now().to_rfc3339(),
                settings: TurnSettings::default(),
                parent_session_id: None,
            },
        );

        reconcile_server_active(&connection, "default", &backend, true)
            .await
            .unwrap();
        assert!(!turn_is_active(&backend, &key));
        let summary = session_summary_for(&connection, "default", "stored-1", &backend)
            .await
            .unwrap();
        assert_eq!(summary["turnState"], "idle");

        let (mut socket, runtime, mut id, running, _) =
            open_runtime_socket(&connection, &backend, "default", "stored-1")
                .await
                .unwrap();
        assert!(!running);
        id += 1;
        rpc_on_socket(
            &mut socket,
            id,
            "prompt.submit",
            json!({ "session_id": runtime, "text": "first prompt" }),
        )
        .await
        .unwrap();

        http_task.abort();
        ws_task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn whole_branch_does_not_resume_an_active_parent_transport() {
        let (http_url, http_task) = mock_http_server().await;
        let (ws_url, ws_task) = mock_ws_server_with_active(vec![json!({
            "id": "runtime-1",
            "session_key": "stored-1",
            "profile": "default",
            "status": "working",
        })])
        .await;
        let connection = HermesGatewayConnection {
            http_url,
            ws_url,
            token: String::new(),
        };

        // This mock rejects session.resume when the stored key is already live.
        // Success therefore proves branching used active_list's runtime directly.
        let (runtime, stored, _) = branch_whole_gateway_session(&connection, "default", "stored-1")
            .await
            .unwrap();
        assert_eq!(runtime, "runtime-branch");
        assert_eq!(stored, "stored-branch");

        http_task.abort();
        ws_task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stale_external_active_preflight_never_resumes_or_misattributes_profile() {
        let (http_url, http_task) = mock_http_server().await;
        let (ws_url, ws_task) = mock_ws_server_with_active(vec![json!({
            "id": "runtime-b",
            "session_key": "stored-b",
            "status": "waiting",
        })])
        .await;
        let connection = HermesGatewayConnection {
            http_url,
            ws_url,
            token: String::new(),
        };
        let backend = WorkspaceBackend::default();

        // Mock rejects session.resume for any already-live stored key. The row
        // omits profile, so success also proves public profile lookup attributed
        // it to work instead of the gateway's active/default profile.
        let (_, runtime, _, running, _) =
            open_runtime_socket(&connection, &backend, "work", "stored-b")
                .await
                .unwrap();
        assert!(running);
        assert_eq!(runtime, "runtime-b");
        assert!(backend
            .server_active
            .lock()
            .unwrap()
            .contains(&("work".to_string(), "stored-b".to_string())));
        assert!(!backend
            .server_active
            .lock()
            .unwrap()
            .contains(&("default".to_string(), "stored-b".to_string())));

        http_task.abort();
        ws_task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn global_active_rows_resolve_profile_and_escape_first_page() {
        let (http_url, http_task) = mock_http_server().await;
        let (ws_url, ws_task) = mock_ws_server_with_active(vec![json!({
            "id": "runtime-b",
            "session_key": "stored-b",
            "status": "waiting",
            "title": "Busy work chat",
            "preview": "Needs approval",
            "started_at": 3,
            "last_active": 4,
            "message_count": 4,
            "model": "mock-model",
        })])
        .await;
        let connection = HermesGatewayConnection {
            http_url,
            ws_url,
            token: String::new(),
        };
        let backend = WorkspaceBackend::default();

        reconcile_server_active(&connection, "default", &backend, true)
            .await
            .unwrap();
        let key = ("work".to_string(), "stored-b".to_string());
        assert!(backend.server_active.lock().unwrap().contains(&key));
        assert!(!backend
            .server_active
            .lock()
            .unwrap()
            .contains(&("default".to_string(), "stored-b".to_string())));
        assert_eq!(
            backend
                .runtimes
                .lock()
                .unwrap()
                .get(&key)
                .map(String::as_str),
            Some("runtime-b")
        );

        let sessions = sessions_for(&connection, None, &backend, 1, 0)
            .await
            .unwrap()
            .0;
        let active = sessions
            .iter()
            .find(|session| session["id"] == "stored-b")
            .expect("active row outside the first REST page should be injected");
        assert_eq!(active["profileId"], "work");
        assert_eq!(active["turnState"], "running");
        assert_eq!(active["lastMessagePreview"], "Needs approval");

        http_task.abort();
        ws_task.abort();
    }
}

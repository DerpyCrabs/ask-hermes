import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  AttachmentRef,
  ClientStateMutation,
  MessagePage,
  ModelChoice,
  PersonalityChoice,
  QueueEntry,
  ScheduleAction,
  ScheduleDraft,
  ScheduleRecord,
  ScheduleRun,
  SearchPage,
  SearchRequest,
  ResolveSearchHitRequest,
  SlashCommand,
  SessionPage,
  SessionSummary,
  SessionAction,
  SessionClientState,
  SessionYoloState,
  TurnSettings,
  WorkspaceEvent,
  WorkspaceMessage,
  WorkspaceOpenTarget,
  WorkspaceOpenRequest,
  WorkspaceQuitRequest,
  WorkspaceRefresh,
  WorkspaceSnapshot,
  GatewayFileData,
} from './types'
import type { HermesInstanceConfig } from '../hermes-instance'

type SessionRef = { profileId: string; sessionId: string }
export type InstanceScope = { instanceId: string; instanceGeneration: number }
type MutatingSessionRef = SessionRef & InstanceScope
type ClientStateRef = SessionRef & InstanceScope
type ScheduleRef = { profileId: string; scheduleId: string }
export type HandoffDestination = { profileId: string; sessionId: string; created: boolean }

export interface WorkspaceCommands {
  configureInstance(config: HermesInstanceConfig): Promise<InstanceScope>
  instanceScope(expectedInstanceId?: string): Promise<InstanceScope>
  bootstrap(request: InstanceScope): Promise<WorkspaceSnapshot>
  refresh(request: InstanceScope & { profileId?: string }): Promise<WorkspaceRefresh>
  reconnect(request: InstanceScope & { profileId?: string }): Promise<WorkspaceRefresh>
  profileOptions(request: InstanceScope & { profileId: string }): Promise<{ profileId: string; models: ModelChoice[]; personalities: PersonalityChoice[]; slashCommands: SlashCommand[] }>
  resolveSessionProfile(request: InstanceScope & { sessionId: string }): Promise<{ profileId: string }>
  sessionSummary(request: InstanceScope & SessionRef): Promise<SessionSummary>
  listSessions(request: InstanceScope & { profileId?: string; cursor?: string; limit: number }): Promise<SessionPage>
  messages(request: InstanceScope & SessionRef & { before?: string; aroundMessageId?: string; limit: number }): Promise<MessagePage>
  search(request: InstanceScope & SearchRequest): Promise<SearchPage>
  resolveSearchHit(request: InstanceScope & ResolveSearchHitRequest): Promise<{ messageId: string }>
  createSession(request: InstanceScope & { profileId: string; settings?: TurnSettings }): Promise<{ sessionId: string }>
  resolveHandoffDestination(request: InstanceScope & { handoffId: string; profileId: string; sessionId?: string }): Promise<HandoffDestination>
  setSessionYolo(request: MutatingSessionRef & { enabled: boolean }): Promise<SessionYoloState>
  sessionAction(request: MutatingSessionRef & { action: SessionAction }): Promise<void>
  branchSession(request: MutatingSessionRef & { messageId?: string }): Promise<{ sessionId: string }>
  sendTurn(request: MutatingSessionRef & { entry: QueueEntry }): Promise<void>
  executeSlash(request: MutatingSessionRef & { command: string }): Promise<unknown>
  steerTurn(request: MutatingSessionRef & { text: string }): Promise<boolean>
  stopTurn(request: MutatingSessionRef): Promise<void>
  retryMessage(request: MutatingSessionRef & { messageId: string }): Promise<void>
  editMessage(request: MutatingSessionRef & { messageId: string; content: string }): Promise<void>
  undo(request: MutatingSessionRef & { messageId?: string }): Promise<void>
  submitInteraction(request: MutatingSessionRef & { interactionId: string; optionId?: string; text?: string }): Promise<void>
  uploadAttachment(request: MutatingSessionRef & { name: string; mimeType: string; dataUrl: string }): Promise<AttachmentRef>
  readGatewayFile(request: InstanceScope & { profileId: string; path: string }): Promise<GatewayFileData>
  captureScreen(request: InstanceScope & { profileId: string; sessionId?: string }): Promise<AttachmentRef | undefined>
  transcribeVoice(request: InstanceScope & { profileId: string; dataUrl: string; mimeType: string }): Promise<{ transcript: string }>
  listSchedules(request: InstanceScope & { profileId?: string }): Promise<ScheduleRecord[]>
  saveSchedule(request: InstanceScope & ScheduleDraft): Promise<ScheduleRecord>
  scheduleAction(request: InstanceScope & ScheduleRef & { action: ScheduleAction }): Promise<void>
  scheduleRuns(request: InstanceScope & ScheduleRef & { cursor?: string; limit: number }): Promise<{ runs: ScheduleRun[]; cursor?: string }>
  getClientState(request: ClientStateRef): Promise<SessionClientState>
  syncClientState(request: ClientStateRef & { state: SessionClientState; baseState?: SessionClientState }): Promise<SessionClientState>
  mutateClientState(request: ClientStateRef & { mutation: ClientStateMutation; clientId: string }): Promise<SessionClientState>
  openExternal(url: string): Promise<void>
  copyErrorDetails(profileId?: string): Promise<string>
  hideWorkspace(): Promise<void>
  openWorkspace(target?: WorkspaceOpenRequest): Promise<void>
  setActiveWork(active: boolean): Promise<void>
  quitConfirmed(): Promise<void>
  quitListenerReady(): Promise<void>
  quitCancelled(): Promise<void>
  events(handler: (event: WorkspaceEvent) => void): Promise<UnlistenFn>
  targetEvents(handler: (target: WorkspaceOpenTarget) => void): Promise<UnlistenFn>
  quitEvents(handler: (request: WorkspaceQuitRequest) => void): Promise<UnlistenFn>
  notificationPreferenceEvents(handler: () => void): Promise<UnlistenFn>
  visibilityEvents(handler: (visible: boolean) => void): Promise<UnlistenFn>
}

const request = <T>(command: string, value?: unknown) =>
  value === undefined ? invoke<T>(command) : invoke<T>(command, { request: value })

/**
 * Sole Tauri transport boundary for workspace. Gateway/Rust protocol changes belong here,
 * never in views or state helpers.
 */
export const workspaceCommands: WorkspaceCommands = {
  configureInstance: config => invoke<InstanceScope>('configure_hermes_instance', { config }),
  instanceScope: expectedInstanceId => invoke<InstanceScope>('get_hermes_instance_scope', { expectedInstanceId }),
  bootstrap: value => request<WorkspaceSnapshot>('workspace_bootstrap', value),
  refresh: value => request<WorkspaceRefresh>('workspace_refresh', value),
  reconnect: value => request<WorkspaceRefresh>('workspace_reconnect', value),
  profileOptions: value => request<{ profileId: string; models: ModelChoice[]; personalities: PersonalityChoice[]; slashCommands: SlashCommand[] }>('workspace_profile_options', value),
  resolveSessionProfile: value => request<{ profileId: string }>('workspace_resolve_session_profile', value),
  sessionSummary: value => request<SessionSummary>('workspace_session_summary', value),
  listSessions: value => request<SessionPage>('workspace_list_sessions', value),
  messages: value => request<MessagePage>('workspace_list_messages', value),
  search: value => request<SearchPage>('workspace_search', value),
  resolveSearchHit: value => request<{ messageId: string }>('workspace_resolve_search_hit', value),
  createSession: value => request<{ sessionId: string }>('workspace_create_session', value),
  resolveHandoffDestination: value => request<HandoffDestination>('workspace_resolve_handoff_destination', value),
  setSessionYolo: value => request<SessionYoloState>('workspace_set_session_yolo', value),
  sessionAction: value => request<void>('workspace_session_action', value),
  branchSession: value => request<{ sessionId: string }>('workspace_branch_session', value),
  sendTurn: value => request<void>('workspace_send_turn', value),
  executeSlash: value => request<unknown>('workspace_execute_slash', value),
  steerTurn: value => request<boolean>('workspace_steer_turn', value),
  stopTurn: value => request<void>('workspace_stop_turn', value),
  retryMessage: value => request<void>('workspace_retry_message', value),
  editMessage: value => request<void>('workspace_edit_message', value),
  undo: value => request<void>('workspace_undo', value),
  submitInteraction: value => request<void>('workspace_submit_interaction', value),
  uploadAttachment: value => request<AttachmentRef>('workspace_upload_attachment', value),
  readGatewayFile: value => request<GatewayFileData>('workspace_read_gateway_file', value),
  captureScreen: value => request<AttachmentRef | undefined>('workspace_capture_screen', value),
  transcribeVoice: value => request<{ transcript: string }>('workspace_transcribe_voice', value),
  listSchedules: value => request<ScheduleRecord[]>('workspace_list_schedules', value),
  saveSchedule: value => request<ScheduleRecord>('workspace_save_schedule', value),
  scheduleAction: value => request<void>('workspace_schedule_action', value),
  scheduleRuns: value => request<{ runs: ScheduleRun[]; cursor?: string }>('workspace_list_schedule_runs', value),
  getClientState: value => request<SessionClientState>('workspace_get_client_state', value),
  syncClientState: value => request<SessionClientState>('workspace_sync_client_state', value),
  mutateClientState: value => request<SessionClientState>('workspace_mutate_client_state', value),
  openExternal: url => request<void>('workspace_open_external', { url }),
  copyErrorDetails: profileId => request<string>('workspace_copy_error_details', { profileId }),
  hideWorkspace: () => request<void>('hide_workspace'),
  openWorkspace: target => invoke<void>('open_workspace', {
    instanceId: target?.instanceId,
    instanceGeneration: target?.instanceGeneration,
    handoffId: target?.handoffId,
    profileId: target?.profileId,
    sessionId: target?.sessionId,
    scheduleId: target?.scheduleId,
    draft: target?.draft,
    captures: target?.captures,
  }),
  setActiveWork: active => invoke<void>('set_workspace_has_active_work', { source: 'workspace-ui', active }),
  quitConfirmed: () => invoke<void>('quit_app_confirmed'),
  quitListenerReady: () => invoke<void>('workspace_quit_listener_ready'),
  quitCancelled: () => invoke<void>('workspace_quit_cancelled'),
  events: handler => listen<WorkspaceEvent>('workspace-event', event => handler(event.payload)),
  targetEvents: handler => listen<WorkspaceOpenTarget>('open-workspace-target', event => handler(event.payload)),
  quitEvents: handler => listen<WorkspaceQuitRequest>('workspace-quit-requested', event => handler(event.payload)),
  notificationPreferenceEvents: handler => listen('workspace-notification-preferences-changed', handler),
  visibilityEvents: handler => listen<boolean>('workspace-visibility-changed', event => handler(event.payload)),
}

export type { WorkspaceMessage }

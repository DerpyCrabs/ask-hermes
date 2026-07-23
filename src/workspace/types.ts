export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'incompatible'
export type CapabilityName =
  | 'sessions'
  | 'sessionSearch'
  | 'sessionBranch'
  | 'sessionPin'
  | 'sessionArchive'
  | 'sessionDelete'
  | 'attachments'
  | 'artifactFiles'
  | 'interactions'
  | 'messageRetry'
  | 'messageEdit'
  | 'messageUndo'
  | 'schedules'
  | 'scheduleHistory'
  | 'profiles'

export type Capability = {
  supported: boolean
  reason?: string
}

export type WorkspaceCapabilities = Record<CapabilityName, Capability>

export type ConnectionInfo = {
  state: ConnectionState
  backend?: string
  version?: string
  error?: string
  retryAt?: string
}

export type WorkspaceInstance = {
  id: string
  name: string
  kind: 'automatic' | 'existing'
  address?: string
}

export type WorkspaceProfile = {
  id: string
  name: string
  isDefault?: boolean
  connection: ConnectionInfo
}

export type ModelChoice = {
  id: string
  label: string
  provider?: string
  supportsFast?: boolean
  reasoningEfforts?: string[]
}

export type PersonalityChoice = {
  id: string
  label: string
}

export type ApprovalMode = 'manual' | 'smart' | 'off'

export type TurnSettings = {
  model?: string
  provider?: string
  reasoningEffort?: string
  fast?: boolean
  personality?: string
  /** Profile-wide Hermes policy, reported by session.info. Read-only here. */
  approvalMode?: ApprovalMode
  /** Effective per-session approval bypass, including profile mode `off`. */
  yolo?: boolean
}

export type SessionYoloState = Pick<TurnSettings, 'approvalMode'> & { yolo: boolean }

export type SessionSource = 'workspace' | 'desktop' | 'cli' | 'schedule' | 'messaging' | 'subagent' | 'background'
export type TurnState = 'idle' | 'running' | 'stopping' | 'stalled' | 'error'

export type SessionSummary = {
  id: string
  profileId: string
  title: string
  source: SessionSource
  createdAt: string
  updatedAt: string
  archived: boolean
  pinned: boolean
  unread?: boolean
  turnState: TurnState
  queuedCount?: number
  branchParentId?: string
  parentSessionId?: string
  scheduleId?: string
  lastMessagePreview?: string
  settings?: TurnSettings
}

export type AttachmentState = 'uploading' | 'ready' | 'failed'

export type AttachmentRef = {
  id: string
  name: string
  mimeType: string
  size: number
  state: AttachmentState
  url?: string
  previewUrl?: string
  error?: string
  /** Original Hermes @file/@folder/@url reference when no openable URL exists. */
  reference?: string
}

export type ArtifactReference = {
  id: string
  kind: 'image' | 'file' | 'link'
  name: string
  value: string
  url?: string
  mimeType?: string
}

export type GatewayFileData = {
  name: string
  mimeType: string
  dataUrl: string
}

export type TodoItem = {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority?: string
}

export type TokenUsage = {
  scope: 'message' | 'session'
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  contextTokens?: number
  contextMaxTokens?: number
  costUsd?: number
}

export type ToolCall = {
  id: string
  name: string
  status: 'pending' | 'running' | 'complete' | 'error'
  summary?: string
  input?: string
  output?: string
  error?: string
}

export type InteractionRequest = {
  id: string
  kind: 'approval' | 'clarification'
  title: string
  body?: string
  options?: Array<{ id: string; label: string; description?: string }>
  allowText?: boolean
  sensitive?: boolean
  resolved?: boolean
  response?: string
  /** False for a REST-history request whose original blocking callback is gone. */
  respondable?: boolean
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'
export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'error' | 'cancelled'

export type WorkspaceMessage = {
  id: string
  sessionId: string
  profileId: string
  role: MessageRole
  content: string
  createdAt: string
  status: MessageStatus
  attachments?: AttachmentRef[]
  artifacts?: ArtifactReference[]
  tools?: ToolCall[]
  interactions?: InteractionRequest[]
  todos?: TodoItem[]
  reasoning?: string
  usage?: TokenUsage
  sessionUsage?: TokenUsage
  contextTokens?: number
  totalTokens?: number
  /** Raw Gateway rows folded into this rendered assistant turn. */
  sourceMessageIds?: string[]
  error?: string
}

export type MessagePage = {
  messages: WorkspaceMessage[]
  olderCursor?: string
  hasOlder: boolean
}

export type SessionPage = {
  sessions: SessionSummary[]
  cursor?: string
  total: number
}

export type QueueEntry = {
  id: string
  text: string
  createdAt: string
  attachments: AttachmentRef[]
  settings?: TurnSettings
}

export type SessionClientState = {
  draft: string
  queue: QueueEntry[]
  attachments: AttachmentRef[]
}

/**
 * Atomic edits to the shared per-session composer. These intentionally carry
 * no client-side base state: prompt and workspace windows may both be open,
 * and Rust applies each edit to the latest state under one lock.
 */
export type ClientStateMutation =
  | { kind: 'setDraft'; draft: string }
  | { kind: 'appendDraft'; text: string; separator?: string }
  | { kind: 'restoreDraft'; draft: string }
  | { kind: 'addQueue'; entry: QueueEntry; front?: boolean }
  | { kind: 'updateQueue'; entryId: string; text: string }
  | { kind: 'moveQueue'; entryId: string; direction: -1 | 1 }
  | { kind: 'removeQueue'; entryId: string }
  | { kind: 'restoreQueue'; entry: QueueEntry }
  | { kind: 'addAttachment'; attachment: AttachmentRef }
  | { kind: 'replaceAttachment'; attachmentId: string; attachment: AttachmentRef }
  | { kind: 'removeAttachment'; attachmentId: string }
  | { kind: 'consumeComposer'; entry?: QueueEntry }
  | { kind: 'restoreComposer'; draft: string; attachments: AttachmentRef[]; entryId?: string }
  | { kind: 'applyHandoff'; handoffId: string; draft?: string; attachments: AttachmentRef[] }

export type ScheduleKind = 'agent' | 'script' | 'messaging'
export type ScheduleState = 'active' | 'paused' | 'running' | 'error'

export type ScheduleRecord = {
  id: string
  profileId: string
  name: string
  kind: ScheduleKind
  prompt?: string
  cron: string
  model?: string
  provider?: string
  state: ScheduleState
  nextRunAt?: string
  lastRunAt?: string
  lastError?: string
  preservedFields?: Record<string, unknown>
}

export type ScheduleDraft = {
  id?: string
  profileId: string
  kind?: ScheduleKind
  name: string
  prompt: string
  cron: string
  /** Cron text loaded into the editor; omitted for new schedules. */
  originalCron?: string
  model?: string
  provider?: string
  preservedFields?: Record<string, unknown>
}

export type ScheduleRun = {
  id: string
  scheduleId: string
  profileId: string
  sessionId?: string
  startedAt: string
  finishedAt?: string
  status: 'running' | 'complete' | 'finished' | 'error' | 'cancelled'
  error?: string
}

export type SearchFilters = {
  includeActive: boolean
  includeArchived: boolean
  source?: SessionSource
  from?: string
  to?: string
}

export type SearchRequest = {
  query: string
  profileId?: string
  filters: SearchFilters
  cursor?: string
  limit: number
}

export type SearchResult = {
  sessionId: string
  profileId: string
  messageId?: string
  resolver?: SearchHitResolver
  title: string
  excerpt: string
  source: SessionSource
  archived: boolean
  timestamp: string
}

export type SearchHitResolver = {
  kind: 'message'
  query: string
  excerpt: string
  role?: WorkspaceMessage['role']
}

export type ResolveSearchHitRequest = {
  profileId: string
  sessionId: string
  resolver: SearchHitResolver
}

export type SearchPage = {
  results: SearchResult[]
  cursor?: string
  truncated?: boolean
}

export type SlashCommand = {
  name: string
  description: string
  source: 'workspace' | 'gateway' | 'skill'
}

export type WorkspaceSnapshot = {
  instance: WorkspaceInstance
  instanceGeneration: number
  connection: ConnectionInfo
  capabilities: WorkspaceCapabilities
  profiles: WorkspaceProfile[]
  sessions: SessionSummary[]
  sessionCursor?: string
  sessionTotal?: number
  schedules: ScheduleRecord[]
  activeProfileId?: string
  models: ModelChoice[]
  personalities: PersonalityChoice[]
  slashCommands: SlashCommand[]
}

export type WorkspaceRefresh = {
  connection: ConnectionInfo
  capabilities?: WorkspaceCapabilities
  profiles?: WorkspaceProfile[]
  sessions?: SessionSummary[]
  sessionCursor?: string
  sessionTotal?: number
  schedules?: ScheduleRecord[]
}

export type SessionAction =
  | { kind: 'rename'; title: string }
  | { kind: 'pin'; pinned: boolean }
  | { kind: 'archive' }
  | { kind: 'restore' }
  | { kind: 'delete' }

export type ScheduleAction = 'pause' | 'resume' | 'run' | 'delete'

export type WorkspaceEvent =
  | { type: 'connection'; connection: ConnectionInfo; profileId?: string }
  | { type: 'instance-invalidated' }
  | { type: 'snapshot-invalidated'; profileId?: string }
  | { type: 'session-upsert'; session: SessionSummary }
  | { type: 'session-settings'; profileId: string; sessionId: string; settings: TurnSettings }
  | { type: 'session-remove'; profileId: string; sessionId: string }
  | { type: 'message-upsert'; message: WorkspaceMessage }
  | { type: 'message-delta'; profileId: string; sessionId: string; messageId: string; delta: string }
  | { type: 'turn-state'; profileId: string; sessionId: string; state: TurnState; error?: string }
  | { type: 'interaction'; profileId: string; sessionId: string; messageId: string; interaction: InteractionRequest }
  | { type: 'schedule-upsert'; schedule: ScheduleRecord }
  | { type: 'schedule-remove'; profileId: string; scheduleId: string }
  | { type: 'client-state'; instanceId: string; instanceGeneration: number; profileId: string; sessionId: string; state: SessionClientState; clientId?: string }

export type WorkspaceSelection =
  | { kind: 'chat'; profileId: string; id: string; aroundMessageId?: string }
  | { kind: 'schedule'; profileId: string; id: string }
  | { kind: 'none' }

export type WorkspaceOpenTarget = {
  instanceId: string
  instanceGeneration: number
  handoffId?: string
  profileId?: string
  sessionId?: string
  scheduleId?: string
  draft?: string
  captures?: Array<{ name: string; mimeType: string; dataUrl: string; size: number }>
}

export type WorkspaceOpenRequest = Omit<WorkspaceOpenTarget, 'instanceId' | 'instanceGeneration'> & {
  instanceId?: string
  instanceGeneration?: number
}

export type WorkspaceHandoffResult = {
  handoffId: string
  instanceId: string
  instanceGeneration: number
  status: 'success' | 'failure'
  error?: string
}

export type WorkspaceQuitRequest = {
  confirmationRequired: boolean
}

export type WorkspaceNavigation = 'chats' | 'archived' | 'search' | 'schedules'

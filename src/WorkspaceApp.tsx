import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import type { JSX } from 'solid-js'
import { invoke } from '@tauri-apps/api/core'
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window'
import { emit } from '@tauri-apps/api/event'
import { isPermissionGranted, onAction, requestPermission, sendNotification, type Options as NativeNotification } from '@tauri-apps/plugin-notification'
import Archive from 'lucide-solid/icons/archive'
import ArrowDown from 'lucide-solid/icons/arrow-down'
import ArrowUp from 'lucide-solid/icons/arrow-up'
import CalendarClock from 'lucide-solid/icons/calendar-clock'
import Camera from 'lucide-solid/icons/camera'
import Check from 'lucide-solid/icons/check'
import ChevronDown from 'lucide-solid/icons/chevron-down'
import CircleAlert from 'lucide-solid/icons/circle-alert'
import Copy from 'lucide-solid/icons/copy'
import Ellipsis from 'lucide-solid/icons/ellipsis'
import FileIcon from 'lucide-solid/icons/file'
import GitBranch from 'lucide-solid/icons/git-branch'
import LoaderCircle from 'lucide-solid/icons/loader-circle'
import Mic from 'lucide-solid/icons/mic'
import Menu from 'lucide-solid/icons/menu'
import MessageSquare from 'lucide-solid/icons/message-square'
import PanelLeftClose from 'lucide-solid/icons/panel-left-close'
import PanelLeftOpen from 'lucide-solid/icons/panel-left-open'
import Paperclip from 'lucide-solid/icons/paperclip'
import Pause from 'lucide-solid/icons/pause'
import Pencil from 'lucide-solid/icons/pencil'
import Pin from 'lucide-solid/icons/pin'
import Play from 'lucide-solid/icons/play'
import Plus from 'lucide-solid/icons/plus'
import RefreshCw from 'lucide-solid/icons/refresh-cw'
import RotateCcw from 'lucide-solid/icons/rotate-ccw'
import Search from 'lucide-solid/icons/search'
import SendHorizontal from 'lucide-solid/icons/send-horizontal'
import Settings2 from 'lucide-solid/icons/settings-2'
import Square from 'lucide-solid/icons/square'
import Trash2 from 'lucide-solid/icons/trash-2'
import Undo2 from 'lucide-solid/icons/undo-2'
import X from 'lucide-solid/icons/x'
import { renderMarkdown } from './markdown'
import { ACTIVE_INSTANCE_KEY, INSTANCES_KEY, activeSavedInstance, instanceConfig, parseSavedInstances } from './instances'
import { HermesRecording, blobToDataUrl, microphoneErrorMessage, preferredAudioMimeType, type VoiceInputStatus } from './voice-input'
import { SpeachesRealtimeSession, speachesRealtimeUrl } from './speaches-realtime'
import { workspaceCommands, type InstanceScope, type WorkspaceCommands } from './workspace/commands'
import { downloadGatewayFile, gatewayLocalFilePath, safeGatewayDataUrl, safeInlineImageSource } from './workspace/gateway-files'
import { defaultWorkspaceUi, parseSessionScopeKey, readWorkspaceUi, sanitizeClientState, sanitizeInstanceClientStates, sessionScopeKey, writeWorkspaceUi, type PersistedWorkspaceUi } from './workspace/persistence'
import { isTurnCompletion, notificationEnabled, readWorkspaceNotificationPreferences, scheduleTransitionNotification, schedulesNeedBackgroundPolling, workspaceNeedsBackgroundMonitoring, type WorkspaceNotificationKind } from './workspace/notifications'
import {
  capability,
  applyClientStateMutation,
  clientStateGenerationMatches,
  composerHasSubmission,
  composerSubmissionText,
  newQueueEntry,
  queueDrainTransition,
  reduceCollections,
  reduceMessages,
  schedulesForProfile,
  hasBlockingWork,
  hasClientStateContent,
  lifecycleMutationBlockReason,
  mergeClientState,
  mergeSessionPage,
  overlayPendingDraft,
  safeExternalUrl,
  topLevelSessions,
  unavailableSessionSummary,
} from './workspace/state'
import { workspaceText as text } from './workspace/strings'
import { SearchNavigationGuard, searchResolutionRequest } from './workspace/search'
import { handoffTargetMatchesSnapshot } from './workspace/handoff'
import type {
  AttachmentRef,
  ClientStateMutation,
  ConnectionInfo,
  InteractionRequest,
  GatewayFileData,
  MessagePage,
  ModelChoice,
  PersonalityChoice,
  QueueEntry,
  ScheduleDraft,
  ScheduleRecord,
  ScheduleRun,
  SearchFilters,
  SearchResult,
  SlashCommand,
  SessionClientState,
  SessionSummary,
  TurnState,
  TurnSettings,
  WorkspaceEvent,
  WorkspaceHandoffResult,
  WorkspaceMessage,
  WorkspaceNavigation,
  WorkspaceOpenTarget,
  WorkspaceQuitRequest,
  WorkspaceRefresh,
  WorkspaceSelection,
  WorkspaceSnapshot,
  WorkspaceCapabilities,
} from './workspace/types'
import type { QueueDrainPhase } from './workspace/state'
import './workspace.css'

type WorkspaceAppProps = { commands?: WorkspaceCommands }
type Target = WorkspaceOpenTarget
type AtomicClientStateTarget = { instanceId: string; instanceGeneration: number; profileId: string; sessionId: string }
type PendingAtomicMutation = {
  target: AtomicClientStateTarget
  mutation: ClientStateMutation
  resolve(state: SessionClientState): void
  reject(reason: unknown): void
}

export function handleWorkspaceQuitRequest(
  request: WorkspaceQuitRequest,
  flush: () => void,
  confirm: () => boolean,
  quitConfirmed: () => Promise<void>,
  quitCancelled: () => Promise<void> = async () => undefined,
) {
  flush()
  if (request.confirmationRequired && !confirm()) {
    void quitCancelled()
    return false
  }
  void quitConfirmed()
  return true
}
type VoiceProvider = 'hermes' | 'speaches'
type SpeachesStatus = { installed: boolean; running: boolean; model: string; websocketUrl: string }

const emptyClientState = (): SessionClientState => ({ draft: '', queue: [], attachments: [] })
const defaultFilters = (): SearchFilters => ({ includeActive: true, includeArchived: true })
const SESSION_PAGE_LIMIT = 80
const ALL_SESSION_SCOPE = '__all__'
const allowedGatewayCommands = new Set([
  'agents', 'background', 'branch', 'compact', 'compress', 'goal', 'interrupt', 'model', 'new', 'personality',
  'queue', 'resume', 'retry', 'status', 'steer', 'stop', 'title', 'undo', 'usage', 'version',
])

export function workspaceSearchAction(
  capabilities: WorkspaceCapabilities | undefined,
  query: string,
  searching: boolean,
) {
  const feature = capability(capabilities, 'sessionSearch')
  return {
    disabled: searching || !query.trim() || !feature.supported,
    reason: feature.supported ? undefined : feature.reason,
  }
}

const formatTime = (value?: string) => value
  ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
  : text.notAvailable
const formatElapsed = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  return hours > 0
    ? `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}
const messageAuthor = (role: WorkspaceMessage['role']) => ({
  assistant: text.hermes,
  user: text.you,
  system: text.system,
  tool: text.tool,
})[role]

const failedConnection = (reason: unknown): ConnectionInfo => {
  const error = String(reason)
  return { state: error.startsWith('Incompatible Hermes gateway') ? 'incompatible' : 'disconnected', error }
}

const profileName = (snapshot: WorkspaceSnapshot | undefined, id: string) =>
  snapshot?.profiles.find(profile => profile.id === id)?.name || id

const renderMessageMarkdown = (value: string) => renderMarkdown(value)
  .replaceAll('<pre><code', `<div class="workspace-code"><button type="button" data-copy-code>${text.copy}</button><pre><code`)
  .replaceAll('</code></pre>', '</code></pre></div>')

function ProfileBadge(props: { snapshot?: WorkspaceSnapshot; profileId: string }) {
  return <span class="workspace-profile-badge">{profileName(props.snapshot, props.profileId)}</span>
}

function SessionStatus(props: { session: SessionSummary }) {
  return (
    <span class="workspace-session-status" title={props.session.turnState}>
      <Show when={props.session.turnState === 'running' || props.session.turnState === 'stopping'}>
        <LoaderCircle class="workspace-spin" size={12} />
      </Show>
      <Show when={props.session.turnState === 'stalled' || props.session.turnState === 'error'}><CircleAlert size={12} /></Show>
      <Show when={props.session.unread}><span class="workspace-unread" /></Show>
      <Show when={(props.session.queuedCount || 0) > 0}><span>{props.session.queuedCount}</span></Show>
    </span>
  )
}

function SessionRow(props: {
  session: SessionSummary
  snapshot?: WorkspaceSnapshot
  allProfiles: boolean
  selected: boolean
  onOpen(): void
}) {
  return (
    <button class="workspace-session-row" classList={{ selected: props.selected }} onClick={props.onOpen}>
      <span class="workspace-session-row-title">
        <Show when={props.session.pinned}><Pin size={11} /></Show>
        <Show when={props.session.branchParentId}><GitBranch size={11} aria-label={text.branchedChat} /></Show>
        <span>{props.session.title || text.untitledChat}</span>
      </span>
      <span class="workspace-session-row-meta">
        <Show when={props.allProfiles}><ProfileBadge snapshot={props.snapshot} profileId={props.session.profileId} /></Show>
        <span>{formatTime(props.session.updatedAt)}</span>
        <SessionStatus session={props.session} />
      </span>
    </button>
  )
}

const SESSION_ROW_HEIGHT = 49

function VirtualSessionList(props: {
  sessions: SessionSummary[]
  snapshot?: WorkspaceSnapshot
  allProfiles: boolean
  selected(profileId: string, sessionId: string): boolean
  onOpen(profileId: string, sessionId: string): void
  scrollRoot?: HTMLElement
  scrollTop: number
  viewportHeight: number
  emptyText: string
  layoutKey?: string
}) {
  let root: HTMLDivElement | undefined
  let layoutFrame: number | undefined
  const [contentTop, setContentTop] = createSignal(0)
  const updateContentTop = () => {
    if (!root || !props.scrollRoot) return
    const rootBox = root.getBoundingClientRect()
    const scrollBox = props.scrollRoot.getBoundingClientRect()
    setContentTop(rootBox.top - scrollBox.top + props.scrollRoot.scrollTop)
  }
  const scheduleContentTop = () => {
    if (layoutFrame !== undefined) window.cancelAnimationFrame(layoutFrame)
    layoutFrame = window.requestAnimationFrame(() => {
      layoutFrame = undefined
      updateContentTop()
    })
  }
  createEffect(() => {
    props.sessions.length
    props.layoutKey
    scheduleContentTop()
  })
  onMount(() => {
    scheduleContentTop()
    const observer = typeof ResizeObserver !== 'undefined' && root && props.scrollRoot
      ? new ResizeObserver(scheduleContentTop)
      : undefined
    if (observer && root && props.scrollRoot) {
      observer.observe(root)
      observer.observe(props.scrollRoot)
    }
    onCleanup(() => {
      observer?.disconnect()
      if (layoutFrame !== undefined) window.cancelAnimationFrame(layoutFrame)
    })
  })
  const range = createMemo(() => {
    const total = props.sessions.length
    const localTop = props.scrollTop - contentTop()
    const overscan = 350
    const start = Math.max(0, Math.floor((localTop - overscan) / SESSION_ROW_HEIGHT))
    const end = Math.min(total, Math.ceil((localTop + Math.max(props.viewportHeight, 500) + overscan) / SESSION_ROW_HEIGHT))
    return { start, end }
  })
  return (
    <Show when={props.sessions.length} fallback={<div class="workspace-sidebar-empty">{props.emptyText}</div>}>
      <div ref={root} class="workspace-session-virtual-list" style={{ height: `${props.sessions.length * SESSION_ROW_HEIGHT}px` }}>
        <div class="workspace-session-virtual-window" style={{ transform: `translateY(${range().start * SESSION_ROW_HEIGHT}px)` }}>
          <For each={props.sessions.slice(range().start, range().end)}>{session => (
            <SessionRow session={session} snapshot={props.snapshot} allProfiles={props.allProfiles}
              selected={props.selected(session.profileId, session.id)} onOpen={() => props.onOpen(session.profileId, session.id)} />
          )}</For>
        </div>
      </div>
    </Show>
  )
}

function ToolCalls(props: { tools: NonNullable<WorkspaceMessage['tools']> }) {
  return (
    <div class="workspace-tools">
      <For each={props.tools}>{tool => (
        <details class="workspace-tool" open={tool.status === 'running' || tool.status === 'error'}>
          <summary>
            <span classList={{ 'workspace-tool-running': tool.status === 'running' }}>{tool.name}</span>
            <span>{tool.summary || tool.status}</span>
          </summary>
          <Show when={tool.input}><pre>{tool.input}</pre></Show>
          <Show when={tool.output}><pre classList={{ error: tool.status === 'error' }}>{tool.output}</pre></Show>
          <Show when={tool.error && tool.error !== tool.output}><pre class="error">{tool.error}</pre></Show>
        </details>
      )}</For>
    </div>
  )
}

function TodoList(props: { todos: NonNullable<WorkspaceMessage['todos']> }) {
  const completed = () => props.todos.filter(todo => todo.status === 'completed').length
  return (
    <details class="workspace-rich-details workspace-todos">
      <summary>{text.tasks} <span>{completed()}/{props.todos.length} {text.complete}</span></summary>
      <ul>
        <For each={props.todos}>{todo => (
          <li class={`workspace-todo-${todo.status}`}>
            <span aria-hidden="true">{todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◐' : todo.status === 'cancelled' ? '–' : '○'}</span>
            <span>{todo.content}</span>
            <Show when={todo.priority}><small>{todo.priority}</small></Show>
          </li>
        )}</For>
      </ul>
    </details>
  )
}

type GatewayFileViewProps = {
  gatewayFileReason?: string
  onReadGatewayFile?(path: string): Promise<GatewayFileData>
  onOpenGatewayFile?(path: string, name: string): void | Promise<void>
}

function GatewayImage(props: GatewayFileViewProps & { alt: string; directSrc?: string; path?: string }) {
  const [source, setSource] = createSignal(safeInlineImageSource(props.directSrc))
  const [loading, setLoading] = createSignal(false)
  const [failure, setFailure] = createSignal('')

  createEffect(() => {
    const direct = safeInlineImageSource(props.directSrc)
    const path = gatewayLocalFilePath(props.path)
    setSource(direct)
    setFailure('')
    setLoading(false)
    if (direct || !path || props.gatewayFileReason || !props.onReadGatewayFile) return

    let active = true
    setLoading(true)
    void props.onReadGatewayFile(path).then(file => {
      if (!active) return
      const next = safeGatewayDataUrl(file, true)
      if (!next) throw new Error(text.gatewayFileUnsafe)
      setSource(next)
    }).catch(reason => {
      if (active) setFailure(String(reason))
    }).finally(() => {
      if (active) setLoading(false)
    })
    onCleanup(() => { active = false })
  })

  return <Show when={source()} fallback={loading()
    ? <LoaderCircle class="workspace-spin" size={14} />
    : <FileIcon size={14} aria-label={failure() || props.gatewayFileReason || text.gatewayFilePreviewUnavailable} />}>
    {src => <img src={src()} alt={props.alt} title={failure() || undefined} />}
  </Show>
}

function AttachmentItem(props: GatewayFileViewProps & { attachment: AttachmentRef; onOpenLink(url: string): void }) {
  const externalUrl = () => safeExternalUrl(props.attachment.url || '') || safeExternalUrl(props.attachment.reference || '')
  const localPath = () => externalUrl() ? undefined : gatewayLocalFilePath(props.attachment.reference || props.attachment.url)
  const folder = () => props.attachment.mimeType === 'inode/directory'
  const unavailableReason = () => folder() ? text.gatewayFolderUnavailable : props.gatewayFileReason
  const body = () => <>
    <Show when={props.attachment.mimeType.startsWith('image/')} fallback={<FileIcon size={14} />}>
      <GatewayImage
        alt={props.attachment.name}
        directSrc={props.attachment.previewUrl || props.attachment.url}
        path={localPath()}
        gatewayFileReason={unavailableReason()}
        onReadGatewayFile={props.onReadGatewayFile}
      />
    </Show>
    <span title={props.attachment.reference || props.attachment.url}>{props.attachment.name}</span>
  </>

  return <Show when={externalUrl()} fallback={<Show when={localPath()} fallback={<span class="workspace-attachment-reference">{body()}</span>}>
    {path => <button class="workspace-attachment-reference" disabled={Boolean(unavailableReason())} title={unavailableReason() || text.openGatewayFile}
      onClick={() => void props.onOpenGatewayFile?.(path(), props.attachment.name)}>{body()}</button>}
  </Show>}>
    {url => <a href={url()} onClick={event => { event.preventDefault(); props.onOpenLink(url()) }}>{body()}</a>}
  </Show>
}

function ArtifactList(props: GatewayFileViewProps & { artifacts: NonNullable<WorkspaceMessage['artifacts']>; onOpenLink(url: string): void }) {
  return (
    <details class="workspace-rich-details workspace-artifacts">
      <summary>{text.artifacts} <span>{props.artifacts.length}</span></summary>
      <div>
        <For each={props.artifacts}>{artifact => {
          const externalUrl = safeExternalUrl(artifact.url || '') || (artifact.kind === 'link' ? safeExternalUrl(artifact.value) : undefined)
          const localPath = !externalUrl && artifact.kind !== 'link' ? gatewayLocalFilePath(artifact.value) : undefined
          const body = <>
            <Show when={artifact.kind === 'image'} fallback={<FileIcon size={13} />}>
              <GatewayImage alt={artifact.name} directSrc={artifact.url} path={localPath}
                gatewayFileReason={props.gatewayFileReason} onReadGatewayFile={props.onReadGatewayFile} />
            </Show>
            <span><strong>{artifact.name}</strong><small>{artifact.value}</small></span>
          </>
          return <Show when={externalUrl} fallback={<Show when={localPath} fallback={<span class="workspace-artifact-reference">{body}</span>}>
            {path => <button class="workspace-artifact-reference" disabled={Boolean(props.gatewayFileReason)}
              title={props.gatewayFileReason || text.openGatewayFile}
              onClick={() => void props.onOpenGatewayFile?.(path(), artifact.name)}>{body}</button>}
          </Show>}>
            {url => <a href={url()} onClick={event => { event.preventDefault(); props.onOpenLink(url()) }}>{body}</a>}
          </Show>
        }}</For>
      </div>
    </details>
  )
}

function InteractionCard(props: {
  interaction: InteractionRequest
  disabled: boolean
  onSubmit(optionId?: string, value?: string): void | Promise<void>
}) {
  const [value, setValue] = createSignal('')
  const [submitting, setSubmitting] = createSignal(false)
  const [submitted, setSubmitted] = createSignal(false)
  const submissionValue = () => props.interaction.sensitive ? value() : value().trim()
  const submitResponse = async (optionId?: string, response?: string) => {
    if (submitting() || submitted()) return
    setSubmitting(true)
    try {
      await props.onSubmit(optionId, response)
      setSubmitted(true)
      if (response !== undefined) setValue('')
    } catch {
      // Parent surfaces gateway error; keep controls available for retry.
    } finally {
      setSubmitting(false)
    }
  }
  const submitText = () => {
    const response = submissionValue()
    if (response) void submitResponse(undefined, response)
  }
  return (
    <section class="workspace-interaction" classList={{ resolved: Boolean(props.interaction.resolved) }}>
      <strong>{props.interaction.title}</strong>
      <Show when={props.interaction.body}><p>{props.interaction.body}</p></Show>
      <Show when={props.interaction.response}><pre class="workspace-interaction-response">{props.interaction.response}</pre></Show>
      <Show when={!props.interaction.resolved && props.interaction.respondable === false}>
        <small>{text.historicalRequest}</small>
      </Show>
      <Show when={!props.interaction.resolved && props.interaction.respondable !== false}>
        <div class="workspace-interaction-actions">
          <For each={props.interaction.options}>{option => (
            <button disabled={props.disabled || submitting() || submitted()} title={option.description} onClick={() => void submitResponse(option.id)}>{option.label}</button>
          )}</For>
        </div>
      </Show>
      <Show when={props.interaction.allowText && !props.interaction.resolved && props.interaction.respondable !== false}>
        <form onSubmit={event => { event.preventDefault(); submitText() }}>
          <input type={props.interaction.sensitive ? 'password' : 'text'} value={value()} onInput={event => setValue(event.currentTarget.value)}
            placeholder={props.interaction.sensitive ? text.enterSecret : text.typeResponse} disabled={props.disabled || submitting() || submitted()}
            autocomplete={props.interaction.sensitive ? 'new-password' : 'off'} spellcheck={false} />
          <button type="submit" disabled={props.disabled || submitting() || submitted() || !submissionValue()}>{text.send}</button>
        </form>
      </Show>
    </section>
  )
}

export function MessageCard(props: {
  message: WorkspaceMessage
  disabled: boolean
  onCopy(): void
  onRetry(): void
  onEdit(): void
  onBranch(): void
  onUndo(): void
  onInteraction(interactionId: string, optionId?: string, value?: string): void | Promise<void>
  onOpenLink(url: string): void
  gatewayFileReason?: string
  onReadGatewayFile?(path: string): Promise<GatewayFileData>
  onOpenGatewayFile?(path: string, name: string): void | Promise<void>
  actionReasons: { retry?: string; edit?: string; branch?: string; undo?: string; interaction?: string }
}) {
  const openLink: JSX.EventHandler<HTMLDivElement, MouseEvent> = event => {
    const copy = (event.target as Element).closest<HTMLButtonElement>('[data-copy-code]')
    if (copy) {
      const code = copy.parentElement?.querySelector('code')?.textContent || ''
      void navigator.clipboard.writeText(code)
      return
    }
    const anchor = (event.target as Element).closest<HTMLAnchorElement>('a')
    if (!anchor) return
    event.preventDefault()
    const url = safeExternalUrl(anchor.href)
    if (url) props.onOpenLink(url)
  }
  return (
    <article class="workspace-message" classList={{ user: props.message.role === 'user', failed: props.message.status === 'error' }} title={formatTime(props.message.createdAt)}>
      <Show when={props.message.role === 'system' || props.message.role === 'tool'}>
        <header><span>{messageAuthor(props.message.role)}</span></header>
      </Show>
      <Show when={props.message.attachments?.length}>
        <div class="workspace-message-attachments">
          <For each={props.message.attachments}>{attachment => <AttachmentItem attachment={attachment}
            gatewayFileReason={props.gatewayFileReason} onReadGatewayFile={props.onReadGatewayFile}
            onOpenGatewayFile={props.onOpenGatewayFile} onOpenLink={props.onOpenLink} />}</For>
        </div>
      </Show>
      <Show when={props.message.reasoning}>
        <details class="workspace-rich-details workspace-reasoning"><summary>{text.reasoning}</summary><pre>{props.message.reasoning}</pre></details>
      </Show>
      <Show when={props.message.content}>
        <div class="workspace-markdown" onClick={openLink} innerHTML={renderMessageMarkdown(props.message.content)} />
      </Show>
      <Show when={props.message.tools?.length}><ToolCalls tools={props.message.tools!} /></Show>
      <Show when={props.message.todos?.length}><TodoList todos={props.message.todos!} /></Show>
      <Show when={props.message.artifacts?.length}><ArtifactList artifacts={props.message.artifacts!} onOpenLink={props.onOpenLink}
        gatewayFileReason={props.gatewayFileReason} onReadGatewayFile={props.onReadGatewayFile}
        onOpenGatewayFile={props.onOpenGatewayFile} /></Show>
      <For each={props.message.interactions}>{interaction => (
        <InteractionCard interaction={interaction} disabled={props.disabled || Boolean(props.actionReasons.interaction)} onSubmit={(option, value) => props.onInteraction(interaction.id, option, value)} />
      )}</For>
      <Show when={props.message.error}><div class="workspace-message-error">{props.message.error}</div></Show>
      <footer>
        <Show when={props.message.status === 'streaming' || props.message.status === 'pending'}><LoaderCircle class="workspace-spin" size={13} /></Show>
        <span class="workspace-message-actions">
          <button title={text.copy} onClick={props.onCopy}><Copy size={13} /></button>
          <Show when={props.message.role === 'assistant'}><button title={props.actionReasons.retry || text.retry} disabled={props.disabled || Boolean(props.actionReasons.retry)} onClick={props.onRetry}><RotateCcw size={13} /></button></Show>
          <Show when={props.message.role === 'user'}><button title={props.actionReasons.edit || text.editAndResubmit} disabled={props.disabled || Boolean(props.actionReasons.edit)} onClick={props.onEdit}><Pencil size={13} /></button></Show>
          <button title={props.actionReasons.branch || text.branchFromHere} disabled={props.disabled || Boolean(props.actionReasons.branch)} onClick={props.onBranch}><GitBranch size={13} /></button>
          <button title={props.actionReasons.undo || text.undoLatestExchange} disabled={props.disabled || Boolean(props.actionReasons.undo)} onClick={props.onUndo}><Undo2 size={13} /></button>
        </span>
      </footer>
    </article>
  )
}

function MeasuredMessage(props: { id: string; onHeight(id: string, height: number): void; children: JSX.Element }) {
  let root: HTMLDivElement | undefined
  onMount(() => {
    if (!root) return
    const measure = () => props.onHeight(props.id, Math.ceil(root!.getBoundingClientRect().height))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    onCleanup(() => observer.disconnect())
  })
  return <div ref={root} class="workspace-message-measure" data-message-id={props.id}>{props.children}</div>
}

function WorkspaceApp(props: WorkspaceAppProps) {
  const api = props.commands || workspaceCommands
  let fileInput: HTMLInputElement | undefined
  let folderInput: HTMLInputElement | undefined
  let attachMenu: HTMLDetailsElement | undefined
  let composerInput: HTMLTextAreaElement | undefined
  let transcript: HTMLDivElement | undefined
  let sidebarNav: HTMLElement | undefined
  let searchInput: HTMLInputElement | undefined
  let loadGeneration = 0
  let instanceContinuationGeneration = 0
  let navigationGeneration = 0
  let scheduleRunGeneration = 0
  let sessionListGeneration = 0
  let searchGeneration = 0
  const handoffsInFlight = new Set<string>()
  const settledHandoffs = new Map<string, WorkspaceHandoffResult>()
  const handoffUploads = new Map<string, Map<string, AttachmentRef>>()
  const attachmentUploads = new Map<string, Promise<boolean>>()
  const attachmentUploadSources = new Map<string, {
    profile: string
    sessionId: string
    name: string
    mimeType: string
    dataUrl: string
    size: number
  }>()
  let searchResultScope = ''
  let voiceRecording: HermesRecording | undefined
  let speachesSession: SpeachesRealtimeSession | undefined
  let voiceTarget: InstanceScope & { profileId: string; sessionId: string } | undefined
  let voiceGeneration = 0
  let streamingVoiceTranscript = ''
  let persistTimer: number | undefined
  let bootstrapInFlight = false
  let workspaceEventDisposer: (() => void) | undefined
  let workspaceEventSubscription: Promise<void> | undefined
  let appDisposed = false
  let workspaceActivated = false
  let schedulePollInFlight = false
  let schedulePollGeneration = 0
  let workspaceEventsReady = false
  const initial = typeof localStorage === 'undefined' ? defaultWorkspaceUi() : readWorkspaceUi()
  let profileScopeInitialized = initial.lastProfileId !== undefined
  let expectedInstanceId = typeof localStorage === 'undefined'
    ? initial.instanceId
    : activeSavedInstance(parseSavedInstances(localStorage.getItem(INSTANCES_KEY)), localStorage.getItem(ACTIVE_INSTANCE_KEY)).id
  let pendingInstanceScope: Promise<InstanceScope> | undefined
  let backgroundBootstrapInFlight: Promise<void> | undefined
  let reconnectInFlight: Promise<void> | undefined
  const draftTimers = new Map<string, number>()
  const pendingDrafts = new Map<string, { draft: string; revision: number; target: AtomicClientStateTarget }>()
  const draftCommits = new Map<string, Promise<void>>()
  const mutationQueues = new Map<string, PendingAtomicMutation[]>()
  const mutationProcessing = new Set<string>()
  const authoritativeClientStates = new Map<string, SessionClientState>()
  const deferredClientStateEvents = new Map<string, { target: AtomicClientStateTarget; state: SessionClientState }>()
  const mutationClientId = globalThis.crypto?.randomUUID?.() || `workspace-${Date.now()}-${Math.random()}`
  let draftRevision = 0
  const queueDrainPhases = new Map<string, QueueDrainPhase>()
  const queueDrainsInFlight = new Set<string>()
  const failedQueueDrains = new Set<string>()
  const observedTurnStates = new Map<string, TurnState>()
  const profileChoiceRequests = new Map<string, Promise<void>>()
  const sessionSummaryRequests = new Map<string, Promise<SessionSummary>>()
  const pendingMessageDeltas = new Map<string, Extract<WorkspaceEvent, { type: 'message-delta' }>>()
  let messageDeltaFrame: number | undefined
  const messageHeights = new Map<string, number>()
  const messageCache = new Map<string, {
    messages: WorkspaceMessage[]
    olderCursor?: string
    hasOlder: boolean
  }>()
  const recoverySeeds = new Map(Object.entries(initial.sessions).filter(([, state]) => hasClientStateContent(state)))
  const recoveryIncomingStates = new Map<string, SessionClientState>()
  const searchNavigation = new SearchNavigationGuard()
  const [snapshot, setSnapshot] = createSignal<WorkspaceSnapshot>()
  const [profileChoices, setProfileChoices] = createSignal<Record<string, { models: ModelChoice[]; personalities: PersonalityChoice[]; slashCommands: SlashCommand[] }>>({})
  const [connection, setConnection] = createSignal<ConnectionInfo>({ state: 'connecting' })
  const [profileConnections, setProfileConnections] = createSignal<Record<string, ConnectionInfo>>({})
  const [sessions, setSessions] = createSignal<SessionSummary[]>([])
  const [schedules, setSchedules] = createSignal<ScheduleRecord[]>([])
  const [profileId, setProfileId] = createSignal(initial.lastProfileId || '')
  const [lastConcreteProfileId, setLastConcreteProfileId] = createSignal(
    initial.lastConcreteProfileId
      || (initial.lastSelection.kind !== 'none' ? initial.lastSelection.profileId : '')
      || initial.lastProfileId
      || '',
  )
  const [selection, setSelection] = createSignal<WorkspaceSelection>(initial.lastSelection)
  const [navigation, setNavigation] = createSignal<WorkspaceNavigation>(initial.navigation)
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(initial.sidebarCollapsed)
  const [expandedSections, setExpandedSections] = createSignal(initial.expandedSections)
  const [clientStates, setClientStates] = createSignal<Record<string, SessionClientState>>(initial.sessions)
  const [messages, setMessages] = createSignal<WorkspaceMessage[]>([])
  const [olderCursor, setOlderCursor] = createSignal<string>()
  const [hasOlder, setHasOlder] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [loadingMessages, setLoadingMessages] = createSignal(false)
  const [error, setError] = createSignal('')
  const [searchQuery, setSearchQuery] = createSignal('')
  const [searchFilters, setSearchFilters] = createSignal<SearchFilters>(defaultFilters())
  const [searchResults, setSearchResults] = createSignal<SearchResult[]>([])
  const [searchCursor, setSearchCursor] = createSignal<string>()
  const [searchTruncated, setSearchTruncated] = createSignal(false)
  const [searching, setSearching] = createSignal(false)
  const [runtimeSettings, setRuntimeSettings] = createSignal<Record<string, TurnSettings>>({})
  const [scheduleDraft, setScheduleDraft] = createSignal<ScheduleDraft>()
  const [scheduleRuns, setScheduleRuns] = createSignal<ScheduleRun[]>([])
  const [scheduleQuery, setScheduleQuery] = createSignal('')
  const [scheduleRunsCursor, setScheduleRunsCursor] = createSignal<string>()
  const [loadingRuns, setLoadingRuns] = createSignal(false)
  const [loadingSessions, setLoadingSessions] = createSignal(false)
  const [creatingChat, setCreatingChat] = createSignal(false)
  const [sessionPages, setSessionPages] = createSignal<Record<string, { initialized: boolean; cursor?: string; total?: number }>>({})
  const [pendingTarget, setPendingTarget] = createSignal<Target>()
  const [voiceStatus, setVoiceStatus] = createSignal<VoiceInputStatus>('idle')
  const [workspaceVisible, setWorkspaceVisible] = createSignal(false)
  const [sidebarScrollTop, setSidebarScrollTop] = createSignal(0)
  const [sidebarViewportHeight, setSidebarViewportHeight] = createSignal(600)
  const [transcriptScrollTop, setTranscriptScrollTop] = createSignal(0)
  const [transcriptViewportHeight, setTranscriptViewportHeight] = createSignal(600)
  const [messageHeightVersion, setMessageHeightVersion] = createSignal(0)
  const [turnStartedAt, setTurnStartedAt] = createSignal<Record<string, number>>({})
  const [elapsedNow, setElapsedNow] = createSignal(Date.now())

  type InstanceContinuation = { epoch: number; instanceId?: string; instanceGeneration?: number }
  const captureInstanceContinuation = (): InstanceContinuation => {
    const current = snapshot()
    return {
      epoch: instanceContinuationGeneration,
      instanceId: current?.instance.id,
      instanceGeneration: current?.instanceGeneration,
    }
  }
  const instanceContinuationIsCurrent = (continuation: InstanceContinuation) => {
    if (appDisposed || continuation.epoch !== instanceContinuationGeneration) return false
    if (!continuation.instanceId) return true
    const current = snapshot()
    return Boolean(current
      && current.instance.id === continuation.instanceId
      && current.instanceGeneration === continuation.instanceGeneration
    )
  }
  const mutationScope = (continuation: InstanceContinuation): InstanceScope => {
    if (!continuation.instanceId || continuation.instanceGeneration === undefined) {
      throw new Error(text.workspaceTurnReconnecting)
    }
    return {
      instanceId: continuation.instanceId,
      instanceGeneration: continuation.instanceGeneration,
    }
  }
  const cancelInstanceContinuations = () => {
    instanceContinuationGeneration += 1
    navigationGeneration += 1
    loadGeneration += 1
    scheduleRunGeneration += 1
    sessionListGeneration += 1
    schedulePollGeneration += 1
    searchGeneration += 1
    searchResultScope = ''
    searchNavigation.cancel()
    bootstrapInFlight = false
    backgroundBootstrapInFlight = undefined
    pendingInstanceScope = undefined
    schedulePollInFlight = false
    setSearching(false)
    setLoadingMessages(false)
    setLoadingRuns(false)
    setLoadingSessions(false)
    if (persistTimer !== undefined) window.clearTimeout(persistTimer)
    persistTimer = undefined
    for (const timer of draftTimers.values()) window.clearTimeout(timer)
    draftTimers.clear()
    pendingDrafts.clear()
    if (messageDeltaFrame !== undefined) window.cancelAnimationFrame(messageDeltaFrame)
    messageDeltaFrame = undefined
    pendingMessageDeltas.clear()
    voiceGeneration += 1
    voiceRecording?.cancel()
    voiceRecording = undefined
    speachesSession?.cancel()
    speachesSession = undefined
    voiceTarget = undefined
    setVoiceStatus('idle')
  }
  const invalidateSearchScope = () => {
    searchGeneration += 1
    navigationGeneration += 1
    loadGeneration += 1
    searchResultScope = ''
    searchNavigation.cancel()
    setSearching(false)
    setSearchResults([])
    setSearchCursor(undefined)
    setSearchTruncated(false)
  }

  const trackTurnState = (profile: string, session: string, state: TurnState, hint?: string) => {
    const key = `${profile}\0${session}`
    const active = state === 'running' || state === 'stopping' || state === 'stalled'
    setTurnStartedAt(current => {
      if (active && current[key]) return current
      if (active) {
        const parsed = hint ? Date.parse(hint) : Number.NaN
        return { ...current, [key]: Number.isFinite(parsed) ? parsed : Date.now() }
      }
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  const allProfiles = createMemo(() => !profileId())
  const selectedSession = createMemo(() => {
    const selected = selection()
    return selected.kind === 'chat' ? sessions().find(item => item.id === selected.id && item.profileId === selected.profileId) : undefined
  })
  const selectedSchedule = createMemo(() => {
    const selected = selection()
    return selected.kind === 'schedule' ? schedules().find(item => item.id === selected.id && item.profileId === selected.profileId) : undefined
  })
  const connectionProfileId = createMemo(() => selectedSession()?.profileId
    || selectedSchedule()?.profileId
    || scheduleDraft()?.profileId
    || profileId()
    || lastConcreteProfileId()
    || undefined)
  const effectiveConnection = createMemo(() => {
    const profile = connectionProfileId()
    return (profile && profileConnections()[profile]) || connection()
  })
  const isConnected = createMemo(() => effectiveConnection().state === 'connected')
  const selectedChildSessions = createMemo(() => {
    const selected = selectedSession()
    if (!selected) return []
    return sessions().filter(item => item.profileId === selected.profileId
      && item.parentSessionId === selected.id
      && (item.source === 'subagent' || item.source === 'background'))
  })
  const visibleSessions = createMemo(() => topLevelSessions(sessions(), profileId() || undefined, navigation() === 'archived'))
  const pinnedSessions = createMemo(() => visibleSessions().filter(item => item.pinned))
  const recentSessions = createMemo(() => visibleSessions().filter(item => !item.pinned))
  const scopedSchedules = createMemo(() => schedulesForProfile(schedules(), profileId() || undefined))
  const sessionScope = () => profileId() || ALL_SESSION_SCOPE
  const currentSessionPage = createMemo(() => sessionPages()[sessionScope()])
  const currentLoadedSessionCount = createMemo(() => profileId()
    ? sessions().filter(session => session.profileId === profileId()).length
    : sessions().length)
  const visibleSchedules = createMemo(() => {
    const query = scheduleQuery().trim().toLowerCase()
    return query ? scopedSchedules().filter(item => `${item.name} ${item.cron} ${item.prompt || ''}`.toLowerCase().includes(query)) : scopedSchedules()
  })
  const concreteProfileId = () => profileId()
    || lastConcreteProfileId()
    || snapshot()?.activeProfileId
    || snapshot()?.profiles.find(item => item.isDefault)?.id
    || snapshot()?.profiles[0]?.id
    || ''
  const clientInstanceId = () => snapshot()?.instance.id || expectedInstanceId || initial.instanceId || 'unknown'
  const clientStateRef = (profile: string, session: string) => {
    const current = snapshot()
    return current ? {
      instanceId: current.instance.id,
      instanceGeneration: current.instanceGeneration,
      profileId: profile,
      sessionId: session,
    } : undefined
  }
  const currentScope = () => {
    const selected = selection()
    if (selected.kind !== 'chat') return undefined
    return sessionScopeKey(clientInstanceId(), selected.profileId, selected.id)
  }
  const selectedClientState = createMemo(() => {
    const key = currentScope()
    return key ? clientStates()[key] || emptyClientState() : emptyClientState()
  })
  const selectedSettings = createMemo(() => {
    const selected = selectedSession()
    if (!selected) return {}
    const key = sessionScopeKey(clientInstanceId(), selected.profileId, selected.id)
    return runtimeSettings()[key] || selected.settings || {}
  })
  const choicesProfileId = createMemo(() => selectedSession()?.profileId || scheduleDraft()?.profileId || concreteProfileId())
  const currentChoices = createMemo(() => {
    const profile = choicesProfileId()
    return profileChoices()[profile] || {
      models: profile === snapshot()?.activeProfileId ? snapshot()?.models || [] : [],
      personalities: profile === snapshot()?.activeProfileId ? snapshot()?.personalities || [] : [],
      slashCommands: profile === snapshot()?.activeProfileId ? snapshot()?.slashCommands || [] : [],
    }
  })
  const slashCommands = createMemo(() => {
    const value = selectedClientState().draft.trimStart()
    if (!value.startsWith('/') || value.includes(' ')) return []
    const query = value.slice(1).toLowerCase()
    return currentChoices().slashCommands
      .filter(command => command.source === 'skill' || allowedGatewayCommands.has(command.name.replace(/^\//, '')))
      .filter(command => command.name.replace(/^\//, '').toLowerCase().startsWith(query))
      .slice(0, 8)
  })
  const searchAction = createMemo(() => workspaceSearchAction(snapshot()?.capabilities, searchQuery(), searching()))
  const providers = createMemo(() => [...new Set(currentChoices().models.map(model => model.provider).filter((value): value is string => Boolean(value)))])
  const modelOptionKey = (model: NonNullable<WorkspaceSnapshot['models']>[number]) =>
    `${encodeURIComponent(model.provider || '')}::${encodeURIComponent(model.id)}`
  const selectedModelChoice = createMemo(() => currentChoices().models.find(model =>
    model.id === selectedSettings().model
    && (!selectedSettings().provider || model.provider === selectedSettings().provider)))
  const availableModels = createMemo(() => {
    const provider = selectedSettings().provider
    return provider ? currentChoices().models.filter(model => model.provider === provider) : currentChoices().models
  })
  const missingReason = (name: Parameters<typeof capability>[1]) => {
    const feature = capability(snapshot()?.capabilities, name)
    return feature.supported ? undefined : feature.reason
  }
  const readGatewayFile = async (profile: string, path: string) => {
    const continuation = captureInstanceContinuation()
    const reason = missingReason('artifactFiles')
    if (reason) throw new Error(reason)
    if (!isConnected()) throw new Error(text.reconnectToOpenGatewayFile)
    const file = await api.readGatewayFile({ ...mutationScope(continuation), profileId: profile, path })
    if (!instanceContinuationIsCurrent(continuation)) throw new Error(text.workspaceTurnReconnecting)
    return file
  }
  const openGatewayFile = async (profile: string, path: string, name: string) => {
    const continuation = captureInstanceContinuation()
    try {
      const file = await readGatewayFile(profile, path)
      if (!instanceContinuationIsCurrent(continuation)) return
      await downloadGatewayFile(file, name)
    } catch (reason) {
      if (instanceContinuationIsCurrent(continuation)) setError(text.openGatewayFileFailed(reason))
    }
  }
  const lifecycleReasonFor = (session: SessionSummary) => lifecycleMutationBlockReason(session, stateFor(session.profileId, session.id))

  const showNativeNotification = async (
    kind: WorkspaceNotificationKind,
    title: string,
    body: string,
    target: { profileId: string; sessionId?: string; scheduleId?: string },
  ) => {
    const continuation = captureInstanceContinuation()
    const notificationInstanceId = clientInstanceId()
    const preferences = readWorkspaceNotificationPreferences()
    if (!notificationEnabled(preferences, kind)) return
    try {
      const windows = (await getAllWindows()).filter(item => item.label === 'main' || item.label === 'workspace')
      const focus = await Promise.all(windows.map(item => item.isFocused().catch(() => false)))
      if (focus.some(Boolean)) return
      const granted = await isPermissionGranted()
      if (!granted && await requestPermission() !== 'granted') return
      if (!instanceContinuationIsCurrent(continuation)) return
      sendNotification({
        title,
        body,
        autoCancel: true,
        extra: { askHermesWorkspace: true, instanceId: notificationInstanceId, ...target },
      })
    } catch {
      // Notifications are best-effort; gateway state and queue flow must continue.
    }
  }

  const openNotificationTarget = (notification: NativeNotification) => {
    const target = notification.extra as (Target & { instanceId?: string; askHermesWorkspace?: boolean }) | undefined
    if (!target?.askHermesWorkspace || !target.profileId) return
    void (async () => {
      const currentInstanceId = clientInstanceId()
      if (target.instanceId && target.instanceId !== currentInstanceId) {
        const instances = parseSavedInstances(localStorage.getItem(INSTANCES_KEY))
        const requested = instances.find(instance => instance.id === target.instanceId)
        if (!requested) throw new Error(text.instanceNoLongerConfigured(target.instanceId))
        expectedInstanceId = requested.id
        await api.configureInstance(instanceConfig(requested))
        localStorage.setItem(ACTIVE_INSTANCE_KEY, requested.id)
        await emit('hermes-instance-selected', { instanceId: requested.id })
      }
      await api.openWorkspace({ profileId: target.profileId, sessionId: target.sessionId, scheduleId: target.scheduleId })
    })().catch(reason => setError(String(reason)))
  }
  const notifyScheduleTransition = (schedule: ScheduleRecord, previous?: ScheduleRecord) => {
    const kind = scheduleTransitionNotification(previous, schedule)
    if (!kind) return
    void showNativeNotification(kind, kind === 'scheduleFailure' ? text.scheduleFailed : text.scheduleCompleted, schedule.lastError || schedule.name, {
      profileId: schedule.profileId,
      scheduleId: schedule.id,
    })
  }
  const selectedIs = (profile: string, session: string) => {
    const current = selection()
    return current.kind === 'chat' && current.profileId === profile && current.id === session
  }
  const currentInstanceStates = createMemo(() => {
    const prefix = `${encodeURIComponent(clientInstanceId())}::`
    return Object.fromEntries(Object.entries(clientStates()).filter(([key]) => key.startsWith(prefix)))
  })
  const activeWork = createMemo(() => hasBlockingWork(sessions(), currentInstanceStates()))
  const needsBackgroundMonitoring = () => workspaceNeedsBackgroundMonitoring(
    readWorkspaceNotificationPreferences(),
    Object.entries(currentInstanceStates()).some(([, state]) => hasClientStateContent(state)),
    activeWork(),
  )
  const messageLayout = createMemo(() => {
    messageHeightVersion()
    const offsets = [0]
    for (const message of messages()) offsets.push(offsets[offsets.length - 1] + (messageHeights.get(message.id) || 96))
    return { offsets, total: offsets[offsets.length - 1] }
  })
  const visibleMessageRange = createMemo(() => {
    const { offsets } = messageLayout()
    const count = messages().length
    const findIndex = (value: number) => {
      let low = 0
      let high = count
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (offsets[middle + 1] < value) low = middle + 1
        else high = middle
      }
      return Math.max(0, Math.min(count, low))
    }
    const overscan = 900
    const start = findIndex(Math.max(0, transcriptScrollTop() - overscan))
    const end = Math.min(count, findIndex(transcriptScrollTop() + Math.max(transcriptViewportHeight(), 500) + overscan) + 1)
    return { start, end }
  })
  const visibleMessages = createMemo(() => {
    const range = visibleMessageRange()
    return messages().slice(range.start, range.end)
  })
  const latestExchangeMessageIds = createMemo(() => {
    const rows = messages()
    let start = rows.length - 1
    while (start >= 0 && rows[start].role !== 'user') start -= 1
    if (start < 0) start = rows.length - 1
    return new Set(rows.slice(Math.max(0, start)).map(message => message.id))
  })
  const updateMessageHeight = (id: string, height: number) => {
    if (!height || messageHeights.get(id) === height) return
    messageHeights.set(id, height)
    setMessageHeightVersion(value => value + 1)
  }

  const messageDeltaKey = (event: Extract<WorkspaceEvent, { type: 'message-delta' }>) =>
    `${event.profileId}\0${event.sessionId}\0${event.messageId}`
  const flushMessageDeltas = () => {
    messageDeltaFrame = undefined
    const pending = [...pendingMessageDeltas.values()]
    pendingMessageDeltas.clear()
    const selected = selection()
    if (selected.kind !== 'chat') return
    setMessages(current => pending.reduce(
      (next, event) => reduceMessages(next, event, selected.profileId, selected.id),
      current,
    ))
  }
  const queueMessageDelta = (event: Extract<WorkspaceEvent, { type: 'message-delta' }>) => {
    const key = messageDeltaKey(event)
    const pending = pendingMessageDeltas.get(key)
    pendingMessageDeltas.set(key, pending ? { ...event, delta: pending.delta + event.delta } : event)
    if (messageDeltaFrame === undefined) messageDeltaFrame = window.requestAnimationFrame(flushMessageDeltas)
  }

  const centerTranscriptMessage = (messageId: string, isCurrent: () => boolean = () => true) => {
    if (!transcript || !isCurrent()) return
    const index = messages().findIndex(message => message.id === messageId || message.sourceMessageIds?.includes(messageId))
    if (index < 0) return
    const renderedMessageId = messages()[index].id
    const layout = messageLayout()
    const estimatedHeight = layout.offsets[index + 1] - layout.offsets[index]
    const estimatedTop = layout.offsets[index] + estimatedHeight / 2 - transcript.clientHeight / 2
    transcript.scrollTop = Math.max(0, estimatedTop)
    setTranscriptScrollTop(transcript.scrollTop)
    window.requestAnimationFrame(() => {
      if (!transcript || !isCurrent()) return
      const anchor = [...transcript.querySelectorAll<HTMLElement>('[data-message-id]')]
        .find(element => element.dataset.messageId === renderedMessageId)
      if (!anchor) return
      const viewport = transcript.getBoundingClientRect()
      const bounds = anchor.getBoundingClientRect()
      transcript.scrollTop += bounds.top + bounds.height / 2 - (viewport.top + viewport.height / 2)
      setTranscriptScrollTop(transcript.scrollTop)
    })
  }

  const uiValue = (): PersistedWorkspaceUi => ({
    version: 1,
    instanceId: clientInstanceId(),
    lastProfileId: profileId(),
    lastConcreteProfileId: lastConcreteProfileId() || undefined,
    lastSelection: selection(),
    navigation: navigation(),
    sidebarCollapsed: sidebarCollapsed(),
    expandedSections: expandedSections(),
    pinnedSessions: [],
    sessions: clientStates(),
  })

  const flushPersistence = () => {
    if (persistTimer !== undefined) window.clearTimeout(persistTimer)
    persistTimer = undefined
    if (typeof localStorage !== 'undefined') writeWorkspaceUi(uiValue())
  }

  const discardTransientInstanceState = (instanceId: string) => {
    setClientStates(states => sanitizeInstanceClientStates(states, instanceId))
    for (const [scope, state] of recoverySeeds) {
      if (parseSessionScopeKey(scope)?.instanceId !== instanceId) continue
      const recoverable = sanitizeClientState(state)
      if (hasClientStateContent(recoverable)) recoverySeeds.set(scope, recoverable)
      else recoverySeeds.delete(scope)
    }
    for (const [scope, state] of recoveryIncomingStates) {
      if (parseSessionScopeKey(scope)?.instanceId !== instanceId) continue
      recoveryIncomingStates.set(scope, sanitizeClientState(state))
    }
  }

  const persistSoon = () => {
    if (persistTimer !== undefined) window.clearTimeout(persistTimer)
    persistTimer = window.setTimeout(flushPersistence, 180)
  }

  const stateFor = (profile: string, session: string) => {
    const key = sessionScopeKey(clientInstanceId(), profile, session)
    return clientStates()[key] || emptyClientState()
  }
  const settingsKeyFor = (profile: string, session: string) =>
    sessionScopeKey(clientInstanceId(), profile, session)
  const applyAuthoritativeApprovalState = (
    profile: string,
    session: string,
    state: Pick<TurnSettings, 'approvalMode' | 'yolo'>,
  ) => {
    setSessions(items => items.map(item => item.id === session && item.profileId === profile
      ? { ...item, settings: { ...item.settings, ...state } }
      : item))
    const key = settingsKeyFor(profile, session)
    setRuntimeSettings(items => items[key]
      ? { ...items, [key]: { ...items[key], ...state } }
      : items)
  }
  const drainKey = (profile: string, session: string) => `${encodeURIComponent(profile)}::${encodeURIComponent(session)}`

  const installClientState = (
    profile: string,
    session: string,
    next: SessionClientState,
  ) => {
    const key = sessionScopeKey(clientInstanceId(), profile, session)
    if (!next.queue.length) failedQueueDrains.delete(drainKey(profile, session))
    setClientStates(states => ({ ...states, [key]: next }))
    setSessions(items => items.map(item => item.id === session && item.profileId === profile ? { ...item, queuedCount: next.queue.length } : item))
    persistSoon()
  }

  const clientStateTargetIsCurrent = (target: AtomicClientStateTarget) => {
    const current = snapshot()
    return Boolean(current && clientStateGenerationMatches({
      instanceId: current.instance.id,
      instanceGeneration: current.instanceGeneration,
    }, target))
  }

  const renderAuthoritativeClientState = (target: AtomicClientStateTarget, state: SessionClientState) => {
    if (!clientStateTargetIsCurrent(target)) return
    const key = sessionScopeKey(target.instanceId, target.profileId, target.sessionId)
    authoritativeClientStates.set(key, state)
    const optimistic = (mutationQueues.get(key) || []).reduce(
      (current, pending) => applyClientStateMutation(current, pending.mutation),
      state,
    )
    installClientState(target.profileId, target.sessionId, overlayPendingDraft(optimistic, pendingDrafts.get(key)?.draft))
  }

  const processMutationQueue = (key: string) => {
    if (mutationProcessing.has(key)) return
    mutationProcessing.add(key)
    void (async () => {
      while (mutationQueues.get(key)?.length) {
        const pending = mutationQueues.get(key)![0]
        try {
          const state = await api.mutateClientState({
            ...pending.target,
            mutation: pending.mutation,
            clientId: mutationClientId,
          })
          mutationQueues.get(key)?.shift()
          let latest = state
          if (!mutationQueues.get(key)?.length && clientStateTargetIsCurrent(pending.target)) {
            try { latest = await api.getClientState(pending.target) }
            catch { latest = deferredClientStateEvents.get(key)?.state || state }
            deferredClientStateEvents.delete(key)
          }
          renderAuthoritativeClientState(pending.target, latest)
          pending.resolve(state)
        } catch (reason) {
          mutationQueues.get(key)?.shift()
          if (clientStateTargetIsCurrent(pending.target)) {
            try {
              const state = await api.getClientState(pending.target)
              renderAuthoritativeClientState(pending.target, state)
            } catch {
              // Keep optimistic persistence when even the authoritative reload is unavailable.
            }
            setError(String(reason))
          }
          pending.reject(reason)
        }
      }
    })().finally(() => {
      mutationProcessing.delete(key)
      if (mutationQueues.get(key)?.length) processMutationQueue(key)
      else mutationQueues.delete(key)
    })
  }

  const enqueueClientStateMutation = (
    key: string,
    target: AtomicClientStateTarget,
    mutation: ClientStateMutation,
  ) => new Promise<SessionClientState>((resolve, reject) => {
    const queue = mutationQueues.get(key) || []
    queue.push({ target, mutation, resolve, reject })
    mutationQueues.set(key, queue)
    processMutationQueue(key)
  })

  const commitPendingDraft = (key: string): Promise<void> => {
    const existing = draftCommits.get(key)
    if (existing) return existing.then(() => pendingDrafts.has(key) ? commitPendingDraft(key) : undefined)
    const pending = pendingDrafts.get(key)
    if (!pending) return Promise.resolve()
    const timer = draftTimers.get(key)
    if (timer !== undefined) window.clearTimeout(timer)
    draftTimers.delete(key)
    const commit = enqueueClientStateMutation(key, pending.target, { kind: 'setDraft', draft: pending.draft })
      .then(() => undefined)
      .finally(() => {
        if (pendingDrafts.get(key)?.revision === pending.revision) pendingDrafts.delete(key)
        draftCommits.delete(key)
      })
    draftCommits.set(key, commit)
    return commit.then(() => pendingDrafts.has(key) ? commitPendingDraft(key) : undefined)
  }

  const setDebouncedDraft = (profile: string, session: string, draft: string) => {
    const key = sessionScopeKey(clientInstanceId(), profile, session)
    const current = clientStates()[key] || emptyClientState()
    installClientState(profile, session, applyClientStateMutation(current, { kind: 'setDraft', draft }))
    const target = clientStateRef(profile, session)
    if (!target) return
    const revision = ++draftRevision
    pendingDrafts.set(key, { draft, revision, target })
    const existing = draftTimers.get(key)
    if (existing !== undefined) window.clearTimeout(existing)
    draftTimers.set(key, window.setTimeout(() => {
      void commitPendingDraft(key).catch(() => undefined)
    }, 240))
  }

  const mutateClientState = async (
    profile: string,
    session: string,
    mutation: ClientStateMutation,
  ) => {
    const target = clientStateRef(profile, session)
    if (!target) throw new Error(text.workspaceTurnReconnecting)
    const key = sessionScopeKey(target.instanceId, profile, session)
    if (mutation.kind === 'setDraft'
      || mutation.kind === 'appendDraft'
      || mutation.kind === 'restoreDraft'
      || mutation.kind === 'consumeComposer'
      || mutation.kind === 'restoreComposer'
      || mutation.kind === 'applyHandoff') {
      await commitPendingDraft(key)
    }
    if (!clientStateTargetIsCurrent(target)) throw new Error('Client state belongs to a stale Hermes instance generation')
    const current = clientStates()[key] || emptyClientState()
    installClientState(profile, session, applyClientStateMutation(current, mutation))
    return enqueueClientStateMutation(key, target, mutation)
  }

  const loadProfileChoices = (profile: string) => {
    if (!profile || profileChoices()[profile]) return Promise.resolve()
    const existing = profileChoiceRequests.get(profile)
    if (existing) return existing
    const continuation = captureInstanceContinuation()
    const request = api.profileOptions({ ...mutationScope(continuation), profileId: profile })
      .then(result => {
        if (!instanceContinuationIsCurrent(continuation)) return
        setProfileChoices(current => ({
          ...current,
          [result.profileId || profile]: { models: result.models, personalities: result.personalities, slashCommands: result.slashCommands },
        }))
      })
      .finally(() => {
        if (profileChoiceRequests.get(profile) === request) profileChoiceRequests.delete(profile)
      })
    profileChoiceRequests.set(profile, request)
    return request
  }

  const hydratePersistedClientStates = async (instanceId: string, instanceGeneration: number) => {
    // Backend client state is instance-local and is cleared on every instance
    // switch. Re-seed from the still-persisted UI state each time an instance
    // becomes active; the initial mount map alone is not sufficient when the
    // user switches away and later returns in the same renderer lifetime.
    for (const [scope, state] of Object.entries(clientStates())) {
      const key = parseSessionScopeKey(scope)
      if (key?.instanceId === instanceId && hasClientStateContent(state)) {
        recoverySeeds.set(scope, state)
      }
    }
    const restored = [...recoverySeeds.entries()].flatMap(([scope, state]) => {
      const key = parseSessionScopeKey(scope)
      return key?.instanceId === instanceId ? [{ scope, key, state }] : []
    })
    await Promise.all(restored.map(async ({ scope, key, state }) => {
      const target = { instanceId, instanceGeneration, profileId: key.profileId, sessionId: key.sessionId }
      const remote = sanitizeClientState(await api.getClientState(target))
      if (!clientStateTargetIsCurrent(target)) return
      authoritativeClientStates.set(scope, remote)
      let merged = mergeClientState(state, remote)
      const latestIncoming = recoveryIncomingStates.get(scope)
      if (latestIncoming) merged = mergeClientState(merged, latestIncoming)
      const corrected = sanitizeClientState(await api.syncClientState({
        instanceId, instanceGeneration, profileId: key.profileId, sessionId: key.sessionId,
        state: merged, baseState: remote,
      }))
      if (!clientStateTargetIsCurrent(target)) return
      recoverySeeds.delete(scope)
      recoveryIncomingStates.delete(scope)
      // Backend tombstones are authoritative. Install its corrected result
      // synchronously before hydration returns and queue restoration may drain.
      renderAuthoritativeClientState(target, corrected)
    }))
  }

  const ensureSessionLoaded = async (profile: string, sessionId: string, instanceId = clientInstanceId()) => {
    const loaded = sessions().find(session => session.id === sessionId && session.profileId === profile)
    if (loaded) return loaded
    const continuation = captureInstanceContinuation()
    const scope = sessionScopeKey(instanceId, profile, sessionId)
    const requestKey = `${scope}::${continuation.instanceGeneration ?? 'unknown'}`
    let request = sessionSummaryRequests.get(requestKey)
    if (!request) {
      request = api.sessionSummary({ ...mutationScope(continuation), profileId: profile, sessionId })
        .finally(() => {
          if (sessionSummaryRequests.get(requestKey) === request) sessionSummaryRequests.delete(requestKey)
        })
      sessionSummaryRequests.set(requestKey, request)
    }
    const summary = await request
    if (!instanceContinuationIsCurrent(continuation) || clientInstanceId() !== instanceId) return summary
    const queuedCount = clientStates()[scope]?.queue.length || 0
    const restored = { ...summary, queuedCount }
    setSessions(current => mergeSessionPage(current, [restored]))
    return restored
  }

  const ensureQueuedSessionsLoaded = async (instanceId: string) => {
    const continuation = captureInstanceContinuation()
    if (continuation.instanceId && continuation.instanceId !== instanceId) return
    const missing = Object.entries(clientStates()).flatMap(([scope, state]) => {
      const key = parseSessionScopeKey(scope)
      return key?.instanceId === instanceId
        && state.queue.length > 0
        && !sessions().some(session => session.id === key.sessionId && session.profileId === key.profileId)
        ? [{ key }]
        : []
    })
    const failures: string[] = []
    await Promise.all(missing.map(async ({ key }) => {
      try {
        const summary = await ensureSessionLoaded(key.profileId, key.sessionId, instanceId)
        if (!instanceContinuationIsCurrent(continuation) || clientInstanceId() !== instanceId) return
        const queuedCount = clientStates()[sessionScopeKey(instanceId, key.profileId, key.sessionId)]?.queue.length || 0
        if (queuedCount && ['idle', 'error'].includes(summary.turnState)) {
          window.queueMicrotask(() => void drainQueue(key.profileId, key.sessionId))
        }
      } catch (reason) {
        if (!instanceContinuationIsCurrent(continuation) || clientInstanceId() !== instanceId) return
        const failure = String(reason)
        const queuedCount = clientStates()[sessionScopeKey(instanceId, key.profileId, key.sessionId)]?.queue.length || 0
        setSessions(current => mergeSessionPage(current, [unavailableSessionSummary(
          key.profileId,
          key.sessionId,
          queuedCount,
          failure,
        )]))
        failures.push(`${key.profileId}/${key.sessionId}: ${failure}`)
      }
    }))
    if (!instanceContinuationIsCurrent(continuation) || clientInstanceId() !== instanceId) return
    if (failures.length) throw new Error(text.restoreQueuedChats(failures))
  }

  const mergeProfileSlice = <T extends { profileId: string; id: string }>(
    current: T[],
    next: T[],
    refreshedProfileId?: string,
  ) => refreshedProfileId
    ? [...current.filter(item => item.profileId !== refreshedProfileId), ...next]
    : next

  const applyRefresh = (refresh: WorkspaceRefresh, refreshedProfileId?: string, authoritativeLoadedPage = false) => {
    if (refreshedProfileId) {
      setProfileConnections(current => ({ ...current, [refreshedProfileId]: refresh.connection }))
    } else {
      setConnection(refresh.connection)
    }
    setSnapshot(current => current ? {
      ...current,
      connection: refreshedProfileId ? current.connection : refresh.connection,
      capabilities: refresh.capabilities || current.capabilities,
      profiles: refresh.profiles || current.profiles,
    } : current)
    const nextSessions = refresh.sessions
    const nextSchedules = refresh.schedules
    let selectedMessagesChanged: { profileId: string; sessionId: string } | undefined
    if (nextSessions) {
      const previousSessions = sessions()
      const mergedRefresh = nextSessions.map(next => {
        const previous = previousSessions.find(item => item.id === next.id && item.profileId === next.profileId)
        trackTurnState(next.profileId, next.id, next.turnState, next.updatedAt)
        let unread = selectedIs(next.profileId, next.id) ? false : Boolean(next.unread || previous?.unread)
        if (isTurnCompletion(previous?.turnState, next.turnState)) {
          if (!selectedIs(next.profileId, next.id)) unread = true
          void showNativeNotification('turnCompletion', text.hermesFinished, next.title || previous?.title || text.chatCompleted, {
            profileId: next.profileId,
            sessionId: next.id,
          })
        }
        const selected = selection()
        if (selected.kind === 'chat'
          && selected.profileId === next.profileId
          && selected.id === next.id
          && previous?.updatedAt !== next.updatedAt
          && !['running', 'stopping', 'stalled'].includes(next.turnState)) {
          selectedMessagesChanged = { profileId: next.profileId, sessionId: next.id }
        }
        return { ...next, unread }
      })
      const scope = refreshedProfileId || ALL_SESSION_SCOPE
      const page = sessionPages()[scope]
      const loadedCount = refreshedProfileId
        ? previousSessions.filter(item => item.profileId === refreshedProfileId).length
        : previousSessions.length
      const hasAdditionalPages = Boolean(page?.initialized && loadedCount > SESSION_PAGE_LIMIT)
      const selectedBeforeRefresh = selection()
      if (selectedBeforeRefresh.kind === 'chat'
        && (!refreshedProfileId || selectedBeforeRefresh.profileId === refreshedProfileId)
        && (!hasAdditionalPages || authoritativeLoadedPage)
        && !mergedRefresh.some(item => item.id === selectedBeforeRefresh.id && item.profileId === selectedBeforeRefresh.profileId)
        && !hasClientStateContent(stateFor(selectedBeforeRefresh.profileId, selectedBeforeRefresh.id))) {
        setSelection({ kind: 'none' })
        setMessages([])
      }
      setSessions(current => {
        const refreshed = authoritativeLoadedPage
          ? mergeProfileSlice(current, mergedRefresh, refreshedProfileId)
          : hasAdditionalPages
          ? mergeSessionPage(current, mergedRefresh)
          : mergeProfileSlice(current, mergedRefresh, refreshedProfileId)
        const refreshedKeys = new Set(refreshed.map(session => `${session.profileId}\0${session.id}`))
        const queuedOutsidePage = current.filter(session =>
          !refreshedKeys.has(`${session.profileId}\0${session.id}`)
          && hasClientStateContent(stateFor(session.profileId, session.id)))
        return [...refreshed, ...queuedOutsidePage]
      })
      setSessionPages(pages => {
        const current = pages[scope]
        if (current?.initialized) {
          return { ...pages, [scope]: { ...current, total: refresh.sessionTotal ?? current.total } }
        }
        const cursor = refresh.sessionCursor
          ?? ((refresh.sessionTotal ?? nextSessions.length) > nextSessions.length ? String(nextSessions.length) : undefined)
        return { ...pages, [scope]: { initialized: true, cursor, total: refresh.sessionTotal ?? nextSessions.length } }
      })
    }
    if (nextSchedules) {
      const previousSchedules = schedules()
      for (const schedule of nextSchedules) {
        notifyScheduleTransition(schedule, previousSchedules.find(item => item.id === schedule.id && item.profileId === schedule.profileId))
      }
      setSchedules(current => mergeProfileSlice(current, nextSchedules, refreshedProfileId))
    }
    if (refresh.connection.state === 'connected') {
      window.queueMicrotask(() => {
        for (const session of sessions()) {
          if (['idle', 'error'].includes(session.turnState) && stateFor(session.profileId, session.id).queue.length) {
            void drainQueue(session.profileId, session.id)
          }
        }
      })
    }
    if (selectedMessagesChanged) {
      const target = selectedMessagesChanged
      window.queueMicrotask(() => void loadMessagePage(target!.profileId, target!.sessionId, undefined, undefined, true))
    }
  }

  const ensureProfileConnected = async (profile: string, forceRefresh = false) => {
    if (!forceRefresh && profileConnections()[profile]?.state === 'connected') return
    const continuation = captureInstanceContinuation()
    setProfileConnections(current => ({ ...current, [profile]: { state: 'connecting' } }))
    try {
      const refreshed = await api.refresh({ ...mutationScope(continuation), profileId: profile })
      if (!instanceContinuationIsCurrent(continuation)) return
      applyRefresh(refreshed, profile)
    } catch (reason) {
      if (!instanceContinuationIsCurrent(continuation)) return
      const failed = failedConnection(reason)
      setProfileConnections(current => ({ ...current, [profile]: failed }))
      throw reason
    }
  }

  const targetInstanceIsCurrent = (target: Target) => {
    const current = snapshot()
    return Boolean(current && handoffTargetMatchesSnapshot(target, current))
  }

  const settleHandoff = async (target: Target, status: WorkspaceHandoffResult['status'], error?: unknown) => {
    if (!target.handoffId) return
    const result: WorkspaceHandoffResult = {
      handoffId: target.handoffId,
      instanceId: target.instanceId,
      instanceGeneration: target.instanceGeneration,
      status,
      error: status === 'failure' ? String(error || text.handoffSessionOpenFailed) : undefined,
    }
    handoffsInFlight.delete(target.handoffId)
    if (status === 'success') {
      settledHandoffs.set(target.handoffId, result)
      handoffUploads.delete(target.handoffId)
    }
    await emit('workspace-handoff-result', result)
  }

  const queuePendingTarget = (target: Target) => {
    const previous = pendingTarget()
    if (previous?.handoffId && previous.handoffId !== target.handoffId) {
      void settleHandoff(previous, 'failure', text.handoffSuperseded)
    }
    setPendingTarget(target)
  }

  const openHandoffTarget = async (target: Target) => {
    const handoffId = target.handoffId
    if (!handoffId) return
    const settled = settledHandoffs.get(handoffId)
    if (settled) {
      await emit('workspace-handoff-result', settled)
      return
    }
    if (handoffsInFlight.has(handoffId)) return
    if (!snapshot()) {
      queuePendingTarget(target)
      return
    }
    if (!targetInstanceIsCurrent(target)) {
      await settleHandoff(target, 'failure', text.handoffStaleInstance)
      return
    }
    handoffsInFlight.add(handoffId)
    try {
      const matching = target.sessionId
        ? sessions().find(item => item.id === target.sessionId && (!target.profileId || item.profileId === target.profileId))
        : undefined
      let requestedProfile = target.profileId || matching?.profileId
      if (!requestedProfile && target.sessionId) {
        requestedProfile = (await api.resolveSessionProfile({
          instanceId: target.instanceId,
          instanceGeneration: target.instanceGeneration,
          sessionId: target.sessionId,
        })).profileId
        if (!targetInstanceIsCurrent(target)) throw new Error(text.handoffStaleInstance)
      }
      requestedProfile ||= concreteProfileId()
      if (!requestedProfile) throw new Error(text.handoffProfileUnavailable)
      const destination = await api.resolveHandoffDestination({
        instanceId: target.instanceId,
        instanceGeneration: target.instanceGeneration,
        handoffId,
        profileId: requestedProfile,
        sessionId: target.sessionId,
      })
      if (!targetInstanceIsCurrent(target)) throw new Error(text.handoffStaleInstance)
      const profile = destination.profileId
      const session = destination.sessionId
      await ensureProfileConnected(profile)
      if (!targetInstanceIsCurrent(target)) throw new Error(text.handoffStaleInstance)
      await ensureSessionLoaded(profile, session)
      if (!targetInstanceIsCurrent(target)) throw new Error(text.handoffStaleInstance)

      setPendingTarget(undefined)
      setProfileId(profile)
      setNavigation('chats')
      if (!await openSession(profile, session)) throw new Error(text.handoffSessionOpenFailed)
      if (!targetInstanceIsCurrent(target)) throw new Error(text.handoffStaleInstance)

      const uploaded: AttachmentRef[] = []
      const cachedUploads = handoffUploads.get(handoffId) || new Map<string, AttachmentRef>()
      handoffUploads.set(handoffId, cachedUploads)
      for (const [index, capture] of (target.captures || []).entries()) {
        const cacheKey = `${index}:${capture.name}:${capture.mimeType}:${capture.size}`
        let attachment = cachedUploads.get(cacheKey)
        if (!attachment) {
          attachment = await api.uploadAttachment({
            instanceId: target.instanceId,
            instanceGeneration: target.instanceGeneration,
            profileId: profile,
            sessionId: session,
            name: capture.name,
            mimeType: capture.mimeType,
            dataUrl: capture.dataUrl,
          })
          cachedUploads.set(cacheKey, attachment)
        }
        uploaded.push(attachment)
        if (!targetInstanceIsCurrent(target)) throw new Error(text.handoffStaleInstance)
      }
      await mutateClientState(profile, session, {
        kind: 'applyHandoff',
        handoffId,
        draft: target.draft,
        attachments: uploaded,
      })
      if (!targetInstanceIsCurrent(target)) throw new Error(text.handoffStaleInstance)
      await settleHandoff(target, 'success')
    } catch (reason) {
      if (targetInstanceIsCurrent(target)) setError(String(reason))
      await settleHandoff(target, 'failure', reason).catch(() => undefined)
    }
  }

  const openTarget = (target: Target) => {
    if (!snapshot()) {
      queuePendingTarget(target)
      persistSoon()
      return
    }
    if (!targetInstanceIsCurrent(target)) {
      if (target.handoffId) void settleHandoff(target, 'failure', text.handoffStaleInstance)
      else setError(text.handoffStaleInstance)
      return
    }
    if (target.handoffId) {
      void openHandoffTarget(target)
      persistSoon()
      return
    }
    if (target.scheduleId) {
      const matchingSchedule = schedules().find(item => item.id === target.scheduleId && (!target.profileId || item.profileId === target.profileId))
      if (matchingSchedule) {
        setProfileId(target.profileId || matchingSchedule.profileId)
        setNavigation('schedules')
        void openSchedule(matchingSchedule.profileId, matchingSchedule.id)
      } else {
        setPendingTarget(target)
      }
      persistSoon()
      return
    }
    const matching = target.sessionId
      ? sessions().find(item => item.id === target.sessionId && (!target.profileId || item.profileId === target.profileId))
      : undefined
    if (matching) {
      setProfileId(target.profileId || matching.profileId)
      setNavigation(matching.archived ? 'archived' : 'chats')
      void openSession(matching.profileId, matching.id).catch(reason => setError(String(reason)))
    } else if (!target.sessionId && (target.draft || target.captures?.length)) {
      setError(text.handoffSessionOpenFailed)
    } else if (target.sessionId) {
      setPendingTarget(target)
      const continuation = captureInstanceContinuation()
      void (async () => {
        const profile = target.profileId || (await api.resolveSessionProfile({
          ...mutationScope(continuation),
          sessionId: target.sessionId!,
        })).profileId
        if (!instanceContinuationIsCurrent(continuation)) return
        await ensureProfileConnected(profile)
        if (!instanceContinuationIsCurrent(continuation)) return
        const summary = await ensureSessionLoaded(profile, target.sessionId!)
        if (!instanceContinuationIsCurrent(continuation)) return
        setPendingTarget(undefined)
        setProfileId(profile)
        setNavigation(summary.archived ? 'archived' : 'chats')
        await openSession(profile, target.sessionId!)
      })().catch(reason => {
        if (instanceContinuationIsCurrent(continuation)) setError(String(reason))
      })
    } else if (target.profileId && snapshot()?.profiles.some(item => item.id === target.profileId)) {
      setProfileId(target.profileId)
    }
    persistSoon()
  }

  const replayPendingTarget = () => {
    const target = pendingTarget()
    if (!target || !snapshot()) return false
    setPendingTarget(undefined)
    openTarget(target)
    return true
  }

  const bootstrap = async (allowHidden = false, preparedScope?: InstanceScope) => {
    if ((!workspaceVisible() && !allowHidden) || bootstrapInFlight) return
    const continuation = instanceContinuationGeneration
    bootstrapInFlight = true
    setLoading(true)
    setError('')
    setConnection({ state: 'connecting' })
    try {
      let readScope = preparedScope
      if (!readScope && pendingInstanceScope) readScope = await pendingInstanceScope
      if (!readScope) {
        const configured = activeSavedInstance(
          parseSavedInstances(localStorage.getItem(INSTANCES_KEY)),
          localStorage.getItem(ACTIVE_INSTANCE_KEY),
        )
        expectedInstanceId = configured.id
        try {
          readScope = await api.instanceScope(configured.id)
        } catch {
          readScope = await api.configureInstance(instanceConfig(configured))
        }
      }
      if (appDisposed || continuation !== instanceContinuationGeneration) return
      expectedInstanceId = readScope.instanceId
      const result = await api.bootstrap(readScope)
      if (appDisposed || continuation !== instanceContinuationGeneration) return
      if (result.instance.id !== readScope.instanceId || result.instanceGeneration !== readScope.instanceGeneration) {
        throw new Error(text.workspaceTurnReconnecting)
      }
      setSnapshot(result)
      if (result.activeProfileId) {
        setProfileChoices(current => ({
          ...current,
          [result.activeProfileId!]: { models: result.models, personalities: result.personalities, slashCommands: result.slashCommands },
        }))
      }
      setConnection(result.connection)
      if (result.activeProfileId) {
        setProfileConnections(current => ({ ...current, [result.activeProfileId!]: result.connection }))
      }
      setSessions(result.sessions)
      setTurnStartedAt(Object.fromEntries(result.sessions
        .filter(session => ['running', 'stopping', 'stalled'].includes(session.turnState))
        .map(session => [`${session.profileId}\0${session.id}`, Date.parse(session.updatedAt) || Date.now()])))
      setSessionPages({
        [ALL_SESSION_SCOPE]: {
          initialized: true,
          cursor: result.sessionCursor ?? ((result.sessionTotal ?? result.sessions.length) > result.sessions.length ? String(result.sessions.length) : undefined),
          total: result.sessionTotal ?? result.sessions.length,
        },
      })
      setSchedules(result.schedules)
      const fallbackProfile = result.activeProfileId || result.profiles.find(item => item.isDefault)?.id || result.profiles[0]?.id || ''
      if (!profileScopeInitialized || (profileId() && !result.profiles.some(item => item.id === profileId()))) {
        setProfileId(fallbackProfile)
        profileScopeInitialized = true
      }
      if (!lastConcreteProfileId() || !result.profiles.some(item => item.id === lastConcreteProfileId())) {
        setLastConcreteProfileId(fallbackProfile)
      }
      const initialProfileScope = profileId()
      if (initialProfileScope) {
        const page = await api.listSessions({
          instanceId: result.instance.id,
          instanceGeneration: result.instanceGeneration,
          profileId: initialProfileScope,
          limit: SESSION_PAGE_LIMIT,
        })
        if (appDisposed || continuation !== instanceContinuationGeneration) return
        setSessions(current => mergeProfileSlice(current, page.sessions, initialProfileScope))
        setSessionPages(pages => ({
          ...pages,
          [initialProfileScope]: { initialized: true, cursor: page.cursor, total: page.total },
        }))
      }
      // Recover local drafts/queues only after replacing the concrete profile's
      // first page. Recovery may inject off-page queued chats that must survive
      // bootstrap so their queue can drain.
      await hydratePersistedClientStates(result.instance.id, result.instanceGeneration).catch(reason => setError(text.restoreDraftsAndQueues(reason)))
      if (appDisposed || continuation !== instanceContinuationGeneration) return
      await ensureQueuedSessionsLoaded(result.instance.id).catch(reason => setError(String(reason)))
      if (appDisposed || continuation !== instanceContinuationGeneration) return
      if (pendingTarget()) replayPendingTarget()
      else {
        const selected = selection()
        if (selected.kind === 'chat') {
          try {
            await ensureSessionLoaded(selected.profileId, selected.id, result.instance.id)
            await openSession(selected.profileId, selected.id, selected.aroundMessageId)
          } catch {
            setSelection({ kind: 'none' })
          }
        } else if (selected.kind === 'schedule' && result.schedules.some(item => item.id === selected.id && item.profileId === selected.profileId)) {
          await openSchedule(selected.profileId, selected.id)
        } else setSelection({ kind: 'none' })
      }
      window.queueMicrotask(() => {
        for (const session of sessions()) {
          if (['idle', 'error'].includes(session.turnState) && stateFor(session.profileId, session.id).queue.length) {
            void drainQueue(session.profileId, session.id)
          }
        }
      })
    } catch (reason) {
      if (appDisposed || continuation !== instanceContinuationGeneration) return
      setConnection(failedConnection(reason))
      setError(String(reason))
    } finally {
      if (continuation === instanceContinuationGeneration) {
        bootstrapInFlight = false
        setLoading(false)
        persistSoon()
      }
    }
  }

  const refresh = async (allowHidden = false, requestedProfileId?: string) => {
    if (!workspaceVisible() && !allowHidden) return
    const continuation = captureInstanceContinuation()
    // Background recovery must reconcile every profile; sidebar scope is only
    // a presentation filter and cannot strand another profile's queue.
    const scope = allowHidden ? undefined : requestedProfileId || profileId() || undefined
    try {
      let result = await api.refresh({ ...mutationScope(continuation), profileId: scope })
      if (!instanceContinuationIsCurrent(continuation)) return
      // Polling stays bounded to Gateway's first page. Older pages remain in
      // memory and change only through explicit pagination/events. Refresh the
      // selected off-page chat directly so its lifecycle state remains honest
      // without turning every 15-second poll into dozens of HTTP requests.
      const selected = selection()
      const firstPageKeys = new Set((result.sessions || []).map(session => `${session.profileId}\0${session.id}`))
      if (selected.kind === 'chat'
        && (!scope || selected.profileId === scope)
        && !firstPageKeys.has(`${selected.profileId}\0${selected.id}`)) {
        try {
          const summary = await api.sessionSummary({
            ...mutationScope(continuation),
            profileId: selected.profileId,
            sessionId: selected.id,
          })
          if (!instanceContinuationIsCurrent(continuation)) return
          result = { ...result, sessions: mergeSessionPage(result.sessions || [], [summary]) }
        } catch (reason) {
          if (!instanceContinuationIsCurrent(continuation)) return
          const state = stateFor(selected.profileId, selected.id)
          if (hasClientStateContent(state)) {
            result = {
              ...result,
              sessions: mergeSessionPage(result.sessions || [], [unavailableSessionSummary(
                selected.profileId,
                selected.id,
                state.queue.length,
                String(reason),
              )]),
            }
          }
        }
      }
      applyRefresh(result, scope)
      const currentInstance = snapshot()
      const instanceId = currentInstance?.instance.id
      if (currentInstance && instanceId && [...recoverySeeds.keys()].some(key => parseSessionScopeKey(key)?.instanceId === instanceId)) {
        try {
          await hydratePersistedClientStates(instanceId, currentInstance.instanceGeneration)
          if (!instanceContinuationIsCurrent(continuation)) return
          await ensureQueuedSessionsLoaded(instanceId)
        } catch (reason) {
          setError(text.restoreDraftsAndQueues(reason))
        }
      }
      if (instanceContinuationIsCurrent(continuation) && pendingTarget()) replayPendingTarget()
    } catch (reason) {
      if (!instanceContinuationIsCurrent(continuation)) return
      const failed = failedConnection(reason)
      if (scope) setProfileConnections(current => ({ ...current, [scope]: failed }))
      else setConnection(current => ({ ...current, ...failed }))
      setError(String(reason))
    }
  }

  const reconnect = (allowHidden = false): Promise<void> => {
    if (reconnectInFlight) return reconnectInFlight
    const request = (async () => {
      failedQueueDrains.clear()
      if (!snapshot()) { await bootstrap(allowHidden); return }
      const scope = connectionProfileId()
      const continuation = captureInstanceContinuation()
      if (scope) setProfileConnections(current => ({ ...current, [scope]: { ...current[scope], state: 'reconnecting' } }))
      else setConnection(current => ({ ...current, state: 'reconnecting' }))
      try {
        const refreshed = await api.reconnect({ ...mutationScope(continuation), profileId: scope })
        if (!instanceContinuationIsCurrent(continuation)) return
        applyRefresh(refreshed, scope)
        const currentInstance = snapshot()
        const instanceId = currentInstance?.instance.id
        if (currentInstance && instanceId && [...recoverySeeds.keys()].some(key => parseSessionScopeKey(key)?.instanceId === instanceId)) {
          try {
            await hydratePersistedClientStates(instanceId, currentInstance.instanceGeneration)
            if (!instanceContinuationIsCurrent(continuation)) return
            await ensureQueuedSessionsLoaded(instanceId)
            setError('')
          } catch (reason) {
            setError(text.restoreDraftsAndQueues(reason))
          }
        } else {
          setError('')
        }
        if (instanceContinuationIsCurrent(continuation) && pendingTarget()) replayPendingTarget()
      }
      catch (reason) {
        if (!instanceContinuationIsCurrent(continuation)) return
        const failed = failedConnection(reason)
        if (scope) setProfileConnections(current => ({ ...current, [scope]: failed }))
        else setConnection(current => ({ ...current, ...failed }))
      }
    })()
    reconnectInFlight = request
    const clear = () => { if (reconnectInFlight === request) reconnectInFlight = undefined }
    void request.then(clear, clear)
    return request
  }

  const loadMoreSessions = async () => {
    const scope = sessionScope()
    const cursor = currentSessionPage()?.cursor
    if (!cursor || loadingSessions()) return
    const continuation = captureInstanceContinuation()
    const requestedProfile = profileId()
    const generation = ++sessionListGeneration
    setLoadingSessions(true)
    try {
      const page = await api.listSessions({
        ...mutationScope(continuation),
        profileId: requestedProfile || undefined,
        cursor,
        limit: SESSION_PAGE_LIMIT,
      })
      if (!instanceContinuationIsCurrent(continuation)
        || generation !== sessionListGeneration
        || requestedProfile !== profileId()
        || scope !== sessionScope()) return
      setSessions(current => mergeSessionPage(current, page.sessions))
      setSessionPages(pages => ({
        ...pages,
        [scope]: { initialized: true, cursor: page.cursor, total: page.total },
      }))
    } catch (reason) {
      if (instanceContinuationIsCurrent(continuation) && generation === sessionListGeneration) setError(String(reason))
    } finally {
      if (instanceContinuationIsCurrent(continuation) && generation === sessionListGeneration) setLoadingSessions(false)
    }
  }

  const loadMessagePage = async (profile: string, session: string, before?: string, aroundMessageId?: string, preserveViewport = false) => {
    const generation = before ? loadGeneration : ++loadGeneration
    const navigation = navigationGeneration
    const continuation = captureInstanceContinuation()
    const previousScrollHeight = before || preserveViewport ? transcript?.scrollHeight : undefined
    const previousScrollTop = before || preserveViewport ? transcript?.scrollTop : undefined
    const previousClientHeight = preserveViewport ? transcript?.clientHeight : undefined
    setLoadingMessages(true)
    try {
      const page: MessagePage = await api.messages({
        ...mutationScope(continuation),
        profileId: profile,
        sessionId: session,
        before,
        aroundMessageId,
        limit: 50,
      })
      const selected = selection()
      if (!instanceContinuationIsCurrent(continuation)
        || generation !== loadGeneration
        || navigation !== navigationGeneration
        || selected.kind !== 'chat'
        || selected.profileId !== profile
        || selected.id !== session) return
      setMessages(current => {
        if (before) return [...page.messages, ...current]
        if (!preserveViewport) return page.messages
        const incomingIds = new Set(page.messages.map(message => message.id))
        const firstOverlap = current.findIndex(message => incomingIds.has(message.id))
        return firstOverlap > 0 ? [...current.slice(0, firstOverlap), ...page.messages] : page.messages
      })
      setOlderCursor(page.olderCursor)
      setHasOlder(page.hasOlder)
      window.requestAnimationFrame(() => {
        const current = selection()
        if (!instanceContinuationIsCurrent(continuation)
          || generation !== loadGeneration
          || navigation !== navigationGeneration
          || current.kind !== 'chat'
          || current.profileId !== profile
          || current.id !== session) return
        if (!transcript) return
        if (preserveViewport && previousScrollHeight !== undefined && previousScrollTop !== undefined && previousClientHeight !== undefined) {
          const distanceFromBottom = previousScrollHeight - previousScrollTop - previousClientHeight
          transcript.scrollTop = distanceFromBottom < 140
            ? transcript.scrollHeight
            : Math.max(0, transcript.scrollHeight - transcript.clientHeight - distanceFromBottom)
        } else if (!before && aroundMessageId) centerTranscriptMessage(aroundMessageId, () => {
          const selected = selection()
          return instanceContinuationIsCurrent(continuation)
            && generation === loadGeneration
            && navigation === navigationGeneration
            && selected.kind === 'chat'
            && selected.profileId === profile
            && selected.id === session
        })
        else if (!before) transcript.scrollTo({ top: transcript.scrollHeight })
        else if (previousScrollHeight !== undefined && previousScrollTop !== undefined) {
          transcript.scrollTop = previousScrollTop + transcript.scrollHeight - previousScrollHeight
        }
      })
    } catch (reason) {
      if (instanceContinuationIsCurrent(continuation)
        && generation === loadGeneration
        && navigation === navigationGeneration) setError(String(reason))
    } finally {
      if (instanceContinuationIsCurrent(continuation)
        && generation === loadGeneration
        && navigation === navigationGeneration) setLoadingMessages(false)
    }
  }

  async function openSession(profile: string, session: string, aroundMessageId?: string) {
    const navigation = ++navigationGeneration
    const continuation = captureInstanceContinuation()
    const previous = selection()
    if (previous.kind === 'chat') {
      messageCache.set(`${previous.profileId}\0${previous.id}`, {
        messages: messages(),
        olderCursor: olderCursor(),
        hasOlder: hasOlder(),
      })
    }
    const cached = messageCache.get(`${profile}\0${session}`)
    setLastConcreteProfileId(profile)
    setSessions(items => items.map(item => item.id === session && item.profileId === profile ? { ...item, unread: false } : item))
    setSelection({ kind: 'chat', profileId: profile, id: session, aroundMessageId })
    setScheduleDraft(undefined)
    setMessages(cached?.messages || [])
    setHasOlder(cached?.hasOlder || false)
    setOlderCursor(cached?.olderCursor)
    setTranscriptScrollTop(0)
    window.requestAnimationFrame(() => composerInput?.focus())
    persistSoon()
    try { await ensureProfileConnected(profile) }
    catch (reason) {
      if (instanceContinuationIsCurrent(continuation) && navigation === navigationGeneration) setError(String(reason))
      return false
    }
    if (!instanceContinuationIsCurrent(continuation) || navigation !== navigationGeneration) return false
    void loadProfileChoices(profile).catch(reason => setError(String(reason)))
    await loadMessagePage(profile, session, undefined, aroundMessageId)
    return instanceContinuationIsCurrent(continuation)
      && navigation === navigationGeneration
      && selectedIs(profile, session)
  }

  async function openSchedule(profile: string, schedule: string) {
    const navigation = ++navigationGeneration
    scheduleRunGeneration += 1
    const continuation = captureInstanceContinuation()
    try { await ensureProfileConnected(profile) }
    catch (reason) {
      if (instanceContinuationIsCurrent(continuation) && navigation === navigationGeneration) setError(String(reason))
      return
    }
    if (!instanceContinuationIsCurrent(continuation) || navigation !== navigationGeneration) return
    setLastConcreteProfileId(profile)
    setSelection({ kind: 'schedule', profileId: profile, id: schedule })
    setScheduleDraft(undefined)
    setScheduleRuns([])
    setScheduleRunsCursor(undefined)
    persistSoon()
    if (capability(snapshot()?.capabilities, 'scheduleHistory').supported) await loadScheduleRuns(profile, schedule)
  }

  const retryMessage = async (session: SessionSummary, message: WorkspaceMessage) => {
    const continuation = captureInstanceContinuation()
    const previous = messages()
    const target = previous.findIndex(item => item.id === message.id)
    let userIndex = -1
    for (let index = target; index >= 0; index -= 1) {
      if (previous[index].role === 'user') { userIndex = index; break }
    }
    if (userIndex < 0) { setError(text.missingPromptForResponse); return }
    const optimisticId = `retry-${message.id}`
    const user = previous[userIndex]
    setMessages([
      ...previous.slice(0, userIndex),
      { ...user, id: optimisticId, createdAt: new Date().toISOString(), status: 'pending', error: undefined },
    ])
    try {
      await api.retryMessage({ ...mutationScope(continuation), profileId: session.profileId, sessionId: session.id, messageId: message.id })
      if (!instanceContinuationIsCurrent(continuation) || !selectedIs(session.profileId, session.id)) return
      setMessages(items => items.map(item => item.id === optimisticId ? { ...item, status: 'complete' as const } : item))
    } catch (reason) {
      if (!instanceContinuationIsCurrent(continuation) || !selectedIs(session.profileId, session.id)) return
      setMessages(previous)
      setError(String(reason))
    }
  }

  const editMessage = async (session: SessionSummary, message: WorkspaceMessage) => {
    const continuation = captureInstanceContinuation()
    const content = window.prompt(text.editMessage, message.content)
    if (!content?.trim()) return
    const previous = messages()
    const target = previous.findIndex(item => item.id === message.id)
    if (target < 0) return
    const optimisticId = `edit-${message.id}`
    setMessages([
      ...previous.slice(0, target),
      { ...message, id: optimisticId, content: content.trim(), createdAt: new Date().toISOString(), status: 'pending', error: undefined },
    ])
    try {
      await api.editMessage({ ...mutationScope(continuation), profileId: session.profileId, sessionId: session.id, messageId: message.id, content: content.trim() })
      if (!instanceContinuationIsCurrent(continuation) || !selectedIs(session.profileId, session.id)) return
      setMessages(items => items.map(item => item.id === optimisticId ? { ...item, status: 'complete' as const } : item))
    } catch (reason) {
      if (!instanceContinuationIsCurrent(continuation) || !selectedIs(session.profileId, session.id)) return
      setMessages(previous)
      setError(String(reason))
    }
  }

  const undoMessage = async (session: SessionSummary, message: WorkspaceMessage) => {
    const continuation = captureInstanceContinuation()
    try {
      await api.undo({ ...mutationScope(continuation), profileId: session.profileId, sessionId: session.id, messageId: message.id })
      if (!instanceContinuationIsCurrent(continuation)) return
      await loadMessagePage(session.profileId, session.id)
    } catch (reason) {
      if (instanceContinuationIsCurrent(continuation)) setError(String(reason))
    }
  }

  const branchFromSession = async (session: SessionSummary, messageId?: string) => {
    const navigation = ++navigationGeneration
    const continuation = captureInstanceContinuation()
    try {
      const result = await api.branchSession({
        ...mutationScope(continuation),
        profileId: session.profileId,
        sessionId: session.id,
        messageId,
      })
      if (!instanceContinuationIsCurrent(continuation) || navigation !== navigationGeneration) return
      await openSession(session.profileId, result.sessionId)
    } catch (reason) {
      if (instanceContinuationIsCurrent(continuation)) setError(String(reason))
    }
  }

  const createChat = async () => {
    if (creatingChat()) return
    const profile = concreteProfileId()
    if (!profile) return
    setCreatingChat(true)
    const navigation = ++navigationGeneration
    const continuation = captureInstanceContinuation()
    try {
      await ensureProfileConnected(profile)
      if (!instanceContinuationIsCurrent(continuation) || navigation !== navigationGeneration) return
      const result = await api.createSession({ ...mutationScope(continuation), profileId: profile })
      if (!instanceContinuationIsCurrent(continuation) || navigation !== navigationGeneration) return
      setNavigation('chats')
      await ensureSessionLoaded(profile, result.sessionId)
      if (!instanceContinuationIsCurrent(continuation) || navigation !== navigationGeneration) return
      await openSession(profile, result.sessionId)
    } catch (reason) {
      if (instanceContinuationIsCurrent(continuation)) setError(String(reason))
    } finally {
      setCreatingChat(false)
    }
  }

  const sessionAction = async (session: SessionSummary, action: Parameters<WorkspaceCommands['sessionAction']>[0]['action']) => {
    if ((action.kind === 'archive' || action.kind === 'delete') && lifecycleReasonFor(session)) {
      setError(lifecycleReasonFor(session)!)
      return
    }
    const continuation = captureInstanceContinuation()
    try {
      await ensureProfileConnected(session.profileId)
      if (!instanceContinuationIsCurrent(continuation)) return
      await api.sessionAction({ ...mutationScope(continuation), profileId: session.profileId, sessionId: session.id, action })
      if (!instanceContinuationIsCurrent(continuation)) return
      if (action.kind === 'delete') {
        setSessions(items => items.filter(item => item.id !== session.id || item.profileId !== session.profileId))
        const key = sessionScopeKey(snapshot()?.instance.id || 'unknown', session.profileId, session.id)
        setClientStates(states => Object.fromEntries(Object.entries(states).filter(([scope]) => scope !== key)))
        setRuntimeSettings(items => Object.fromEntries(Object.entries(items).filter(([scope]) => scope !== key)))
        const timer = draftTimers.get(key)
        if (timer !== undefined) window.clearTimeout(timer)
        draftTimers.delete(key)
        pendingDrafts.delete(key)
        const turnKey = drainKey(session.profileId, session.id)
        queueDrainPhases.delete(turnKey)
        queueDrainsInFlight.delete(turnKey)
        persistSoon()
      }
      if (action.kind === 'archive' || action.kind === 'delete') setSelection({ kind: 'none' })
      await refresh()
    } catch (reason) {
      if (instanceContinuationIsCurrent(continuation)) setError(String(reason))
    }
  }

  const setSessionYolo = async (session: SessionSummary, enabled: boolean) => {
    const continuation = captureInstanceContinuation()
    const previous = {
      approvalMode: selectedSettings().approvalMode,
      yolo: selectedSettings().yolo,
    }
    applyAuthoritativeApprovalState(session.profileId, session.id, { ...previous, yolo: enabled })
    try {
      const effective = await api.setSessionYolo({
        ...mutationScope(continuation),
        profileId: session.profileId,
        sessionId: session.id,
        enabled,
      })
      if (!instanceContinuationIsCurrent(continuation)) return
      applyAuthoritativeApprovalState(session.profileId, session.id, effective)
    } catch (reason) {
      if (!instanceContinuationIsCurrent(continuation)) return
      applyAuthoritativeApprovalState(session.profileId, session.id, previous)
      setError(String(reason))
    }
  }

  const sendEntry = async (session: SessionSummary, entry: QueueEntry): Promise<'accepted' | 'failed' | 'stale'> => {
    const continuation = captureInstanceContinuation()
    if (selectedIs(session.profileId, session.id)) setMessages(items => [...items, {
        id: entry.id,
        sessionId: session.id,
        profileId: session.profileId,
        role: 'user',
        content: entry.text,
        attachments: entry.attachments,
        createdAt: entry.createdAt,
        status: 'pending',
      }])
    try {
      await api.sendTurn({ ...mutationScope(continuation), profileId: session.profileId, sessionId: session.id, entry })
      if (!instanceContinuationIsCurrent(continuation)) return 'stale'
      setSessions(items => items.map(item => item.id === session.id && item.profileId === session.profileId ? { ...item, turnState: 'running' } : item))
      if (selectedIs(session.profileId, session.id)) setMessages(items => items.map(message => message.id === entry.id ? { ...message, status: 'complete' as const } : message))
      return 'accepted'
    }
    catch (reason) {
      if (!instanceContinuationIsCurrent(continuation)) return 'stale'
      const failure = String(reason)
      setError(failure)
      if (selectedIs(session.profileId, session.id)) setMessages(items => items.filter(message => message.id !== entry.id))
      return 'failed'
    }
  }

  const stopSession = async (session: SessionSummary) => {
    const continuation = captureInstanceContinuation()
    try {
      await api.stopTurn({ ...mutationScope(continuation), profileId: session.profileId, sessionId: session.id })
    } catch (reason) {
      if (instanceContinuationIsCurrent(continuation)) setError(String(reason))
    }
  }

  const appendSlashOutput = (session: SessionSummary, content: string) => {
    const value = content.trim()
    if (!value || !selectedIs(session.profileId, session.id)) return
    setMessages(items => [...items, {
      id: `slash-${crypto.randomUUID()}`,
      sessionId: session.id,
      profileId: session.profileId,
      role: 'system',
      content: value,
      createdAt: new Date().toISOString(),
      status: 'complete',
    }])
  }

  const executeSlash = async (session: SessionSummary, command: string, active: boolean) => {
    const continuation = captureInstanceContinuation()
    const navigation = navigationGeneration
    const match = command.trim().match(/^\/+([^\s]+)(?:\s+([\s\S]*))?$/)
    if (!match) { setError(text.emptySlashCommand); return }
    const name = match[1].toLowerCase()
    const arg = (match[2] || '').trim()
    const advertisedSkill = currentChoices().slashCommands.some(item =>
      item.source === 'skill' && item.name.replace(/^\//, '').toLowerCase() === name)
    if (!allowedGatewayCommands.has(name) && !advertisedSkill) {
      throw new Error(text.commandOutsideSurface(name))
    }
    if (name === 'new') { await createChat(); return }
    if (name === 'branch') {
      const result = await api.branchSession({ ...mutationScope(continuation), profileId: session.profileId, sessionId: session.id })
      if (!instanceContinuationIsCurrent(continuation) || navigation !== navigationGeneration) return
      await refresh()
      if (!instanceContinuationIsCurrent(continuation) || navigation !== navigationGeneration) return
      await openSession(session.profileId, result.sessionId)
      return
    }
    if (name === 'title' && arg) {
      await api.sessionAction({ ...mutationScope(continuation), profileId: session.profileId, sessionId: session.id, action: { kind: 'rename', title: arg } })
      if (!instanceContinuationIsCurrent(continuation) || navigation !== navigationGeneration) return
      appendSlashOutput(session, text.sessionTitleSet(arg))
      await refresh()
      return
    }
    if (name === 'resume') {
      if (!arg) { appendSlashOutput(session, text.resumeUsage); return }
      const query = arg.toLowerCase()
      const target = sessions().find(item => item.profileId === session.profileId
        && (item.id === arg || item.title.toLowerCase().includes(query)))
      if (target) { await openSession(target.profileId, target.id); return }
      const result = await api.search({
        ...mutationScope(continuation),
        query: arg,
        profileId: session.profileId,
        filters: { includeActive: true, includeArchived: true },
        limit: 10,
      })
      if (!instanceContinuationIsCurrent(continuation) || navigation !== navigationGeneration) return
      const match = result.results.find(item => item.profileId === session.profileId
        && (item.sessionId === arg || item.title.toLowerCase().includes(query)))
      if (!match) { setError(text.noMatchingSession(arg)); return }
      await openSession(match.profileId, match.sessionId, match.messageId)
      return
    }
    if (name === 'model') {
      if (!arg) { appendSlashOutput(session, text.chooseModelInControls); return }
      const query = arg.toLowerCase()
      const choice = currentChoices().models.find(item =>
        item.id.toLowerCase() === query
        || `${item.provider || ''}/${item.id}`.toLowerCase() === query
        || item.label.toLowerCase() === query)
      if (!choice) { setError(text.unknownModel(arg)); return }
      setRuntimeSettings(items => ({
        ...items,
        [settingsKeyFor(session.profileId, session.id)]: { ...selectedSettings(), model: choice.id, provider: choice.provider },
      }))
      appendSlashOutput(session, text.modelSetForNextTurn(choice.label, choice.provider))
      return
    }
    const raw = await api.executeSlash({ ...mutationScope(continuation), profileId: session.profileId, sessionId: session.id, command })
    if (!instanceContinuationIsCurrent(continuation) || navigation !== navigationGeneration) return
    const result = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const type = typeof result.type === 'string' ? result.type : ''
    const notice = typeof result.notice === 'string' ? result.notice.trim() : ''
    if (notice) appendSlashOutput(session, notice)
    if (type === 'prefill' && typeof result.message === 'string') {
      await mutateClientState(session.profileId, session.id, { kind: 'setDraft', draft: result.message as string })
      return
    }
    if ((type === 'send' || type === 'skill') && typeof result.message === 'string') {
      const entry = newQueueEntry(result.message, [], selectedSettings())
      await mutateClientState(session.profileId, session.id, { kind: 'addQueue', entry })
      if (!instanceContinuationIsCurrent(continuation) || navigation !== navigationGeneration) return
      if (active) {
        appendSlashOutput(session, text.commandQueued)
        return
      }
      const outcome = await sendEntry(session, entry)
      if (outcome === 'accepted' && instanceContinuationIsCurrent(continuation)) {
        await mutateClientState(session.profileId, session.id, { kind: 'removeQueue', entryId: entry.id })
      } else if (outcome === 'failed') {
        failedQueueDrains.add(drainKey(session.profileId, session.id))
      }
      return
    }
    const output = typeof result.output === 'string' ? result.output : ''
    const warning = typeof result.warning === 'string' ? result.warning : ''
    if (warning || output) appendSlashOutput(session, [warning && text.warning(warning), output].filter(Boolean).join('\n'))
    else appendSlashOutput(session, text.commandNoOutput(name))
  }

  const settleComposerAttachments = async (
    session: SessionSummary,
    initial: SessionClientState,
    continuation: InstanceContinuation,
  ) => {
    let current = initial
    for (const attachment of current.attachments.filter(item => item.state === 'failed')) {
      const source = attachmentUploadSources.get(attachment.id)
      if (!source) continue
      await mutateClientState(session.profileId, session.id, {
        kind: 'removeAttachment',
        attachmentId: attachment.id,
      })
      attachmentUploadSources.delete(attachment.id)
      if (!instanceContinuationIsCurrent(continuation) || !selectedIs(session.profileId, session.id)) return undefined
      await uploadDataAttachment(
        source.profile,
        source.sessionId,
        source.name,
        source.mimeType,
        source.dataUrl,
        source.size,
      )
      if (!instanceContinuationIsCurrent(continuation) || !selectedIs(session.profileId, session.id)) return undefined
      current = selectedClientState()
    }
    const pending = current.attachments
      .filter(item => item.state === 'uploading')
      .map(item => attachmentUploads.get(item.id))
      .filter((task): task is Promise<boolean> => Boolean(task))
    if (pending.length) await Promise.allSettled(pending)
    if (!instanceContinuationIsCurrent(continuation) || !selectedIs(session.profileId, session.id)) return undefined
    return selectedClientState()
  }

  const submit = async () => {
    const session = selectedSession()
    if (!session || !isConnected()) return
    const continuation = captureInstanceContinuation()
    if (session.archived) { setError(text.restoreBeforeSending); return }
    let state = selectedClientState()
    if (state.attachments.some(item => item.state !== 'ready')) {
      const settled = await settleComposerAttachments(session, state, continuation)
      if (!settled) return
      state = settled
    }
    const prompt = composerSubmissionText(state.draft, state.attachments)
    if (!prompt) {
      const failure = state.attachments.find(item => item.state === 'failed')
      setError(failure?.error || (failure ? text.removeFailedAttachments : text.waitForAttachments))
      return
    }
    setError('')
    const active = session.turnState === 'running' || session.turnState === 'stopping' || session.turnState === 'stalled'
    if (active && /^\/(?:stop|interrupt)\s*$/i.test(prompt)) {
      try { await mutateClientState(session.profileId, session.id, { kind: 'setDraft', draft: '' }) }
      catch { return }
      if (!instanceContinuationIsCurrent(continuation)) return
      try { await api.stopTurn({ ...mutationScope(continuation), profileId: session.profileId, sessionId: session.id }) }
      catch (reason) {
        if (instanceContinuationIsCurrent(continuation)) setError(String(reason))
      }
      return
    }
    const steer = active ? /^\/steer(?:\s+([\s\S]+))?$/i.exec(prompt) : undefined
    if (steer) {
      if (!steer[1]?.trim()) { setError(text.steerUsage); return }
      if (state.attachments.length) { setError(text.steerAttachmentsUnsupported); return }
      try {
        const steeringText = steer[1].trim()
        if (!await api.steerTurn({ ...mutationScope(continuation), profileId: session.profileId, sessionId: session.id, text: steeringText })) {
          if (!instanceContinuationIsCurrent(continuation)) return
          setError(text.steeringRejected)
          return
        }
        if (!instanceContinuationIsCurrent(continuation) || !selectedIs(session.profileId, session.id)) return
        await mutateClientState(session.profileId, session.id, { kind: 'setDraft', draft: '' })
        if (!instanceContinuationIsCurrent(continuation) || !selectedIs(session.profileId, session.id)) return
        setMessages(items => [...items, {
          id: `steer-${crypto.randomUUID()}`,
          sessionId: session.id,
          profileId: session.profileId,
          role: 'system',
          content: text.steered(steeringText),
          createdAt: new Date().toISOString(),
          status: 'complete',
        }])
      } catch (reason) {
        if (instanceContinuationIsCurrent(continuation)) setError(String(reason))
      }
      return
    }
    if (prompt.startsWith('/')) {
      if (state.attachments.length) { setError(text.slashAttachmentsUnsupported); return }
      try { await mutateClientState(session.profileId, session.id, { kind: 'setDraft', draft: '' }) }
      catch { return }
      if (!instanceContinuationIsCurrent(continuation)) return
      try { await executeSlash(session, prompt, active) }
      catch (reason) {
        if (!instanceContinuationIsCurrent(continuation)) return
        await mutateClientState(session.profileId, session.id, { kind: 'restoreDraft', draft: state.draft }).catch(() => undefined)
        setError(String(reason))
      }
      return
    }
    const entry = newQueueEntry(prompt, state.attachments, selectedSettings())
    if (active) {
      await mutateClientState(session.profileId, session.id, { kind: 'consumeComposer', entry }).catch(() => undefined)
      return
    }
    let consumed: SessionClientState
    try { consumed = await mutateClientState(session.profileId, session.id, { kind: 'consumeComposer', entry }) }
    catch { return }
    if (!instanceContinuationIsCurrent(continuation)) return
    const consumedEntry = consumed.queue.find(current => current.id === entry.id) || entry
    const outcome = await sendEntry(session, consumedEntry)
    if (!instanceContinuationIsCurrent(continuation)) return
    if (outcome === 'accepted') {
      await mutateClientState(session.profileId, session.id, { kind: 'removeQueue', entryId: entry.id }).catch(() => undefined)
    } else if (outcome === 'failed') {
      await mutateClientState(session.profileId, session.id, {
        kind: 'restoreComposer', draft: state.draft, attachments: consumedEntry.attachments, entryId: entry.id,
      }).catch(() => undefined)
    }
  }

  const drainQueue = async (profile: string, sessionId: string) => {
    const continuation = captureInstanceContinuation()
    const key = drainKey(profile, sessionId)
    if (queueDrainsInFlight.has(key) || failedQueueDrains.has(key)) return
    const state = stateFor(profile, sessionId)
    const next = state.queue[0]
    const session = sessions().find(item => item.id === sessionId && item.profileId === profile)
    if (!next || !session || session.archived || !['idle', 'error'].includes(session.turnState)) return
    try { await ensureProfileConnected(profile, true) }
    catch { return }
    if (!instanceContinuationIsCurrent(continuation)) return
    let refreshedSession: SessionSummary
    try {
      const summary = await api.sessionSummary({ ...mutationScope(continuation), profileId: profile, sessionId })
      if (!instanceContinuationIsCurrent(continuation)) return
      const queuedCount = stateFor(profile, sessionId).queue.length
      refreshedSession = { ...summary, queuedCount }
      setSessions(current => mergeSessionPage(current, [refreshedSession]))
    } catch (reason) {
      if (instanceContinuationIsCurrent(continuation)) setError(String(reason))
      return
    }
    const refreshedNext = stateFor(profile, sessionId).queue[0]
    if (!refreshedSession
      || !refreshedNext
      || refreshedNext.id !== next.id
      || refreshedSession.archived
      || !['idle', 'error'].includes(refreshedSession.turnState)) return
    if (queueDrainsInFlight.has(key)) return
    queueDrainsInFlight.add(key)
    queueDrainPhases.set(key, 'awaiting-running')
    let outcome: 'accepted' | 'failed' | 'stale' = 'stale'
    try {
      outcome = await sendEntry(refreshedSession, next)
      if (!instanceContinuationIsCurrent(continuation)) return
      if (outcome === 'accepted') {
        await mutateClientState(profile, sessionId, { kind: 'removeQueue', entryId: next.id })
      } else if (outcome === 'failed') {
        failedQueueDrains.add(key)
        queueDrainPhases.delete(key)
      }
    } finally {
      if (instanceContinuationIsCurrent(continuation)) queueDrainsInFlight.delete(key)
      if (outcome === 'accepted' && instanceContinuationIsCurrent(continuation)) window.queueMicrotask(() => {
        if (!instanceContinuationIsCurrent(continuation)) return
        const current = sessions().find(item => item.id === sessionId && item.profileId === profile)
        if (current && !current.archived && ['idle', 'error'].includes(current.turnState) && stateFor(profile, sessionId).queue.length) {
          void drainQueue(profile, sessionId)
        }
      })
    }
  }

  async function uploadDataAttachment(
    profile: string,
    sessionId: string,
    name: string,
    mimeType: string,
    dataUrl: string,
    size: number,
    keepFailed = true,
  ) {
    const continuation = captureInstanceContinuation()
    const temporary: AttachmentRef = {
      id: `upload-${crypto.randomUUID()}`,
      name,
      mimeType: mimeType || 'application/octet-stream',
      size,
      state: 'uploading',
      previewUrl: mimeType.startsWith('image/') ? dataUrl : undefined,
    }
    const source = { profile, sessionId, name, mimeType: temporary.mimeType, dataUrl, size }
    attachmentUploadSources.set(temporary.id, source)
    try { await mutateClientState(profile, sessionId, { kind: 'addAttachment', attachment: temporary }) }
    catch {
      attachmentUploadSources.delete(temporary.id)
      return false
    }
    if (!instanceContinuationIsCurrent(continuation)) {
      attachmentUploadSources.delete(temporary.id)
      return false
    }
    const task = (async () => {
      try {
        const uploaded = await api.uploadAttachment({ ...mutationScope(continuation), profileId: profile, sessionId, name, mimeType: temporary.mimeType, dataUrl })
        if (!instanceContinuationIsCurrent(continuation)) return false
        await mutateClientState(profile, sessionId, {
          kind: 'replaceAttachment',
          attachmentId: temporary.id,
          attachment: { ...uploaded, previewUrl: uploaded.previewUrl || temporary.previewUrl },
        })
        attachmentUploadSources.delete(temporary.id)
        return true
      } catch (reason) {
        if (!instanceContinuationIsCurrent(continuation)) return false
        if (keepFailed) {
          await mutateClientState(profile, sessionId, {
            kind: 'replaceAttachment',
            attachmentId: temporary.id,
            attachment: { ...temporary, state: 'failed', error: String(reason) },
          }).catch(() => undefined)
        } else {
          attachmentUploadSources.delete(temporary.id)
          await mutateClientState(profile, sessionId, {
            kind: 'removeAttachment', attachmentId: temporary.id,
          }).catch(() => undefined)
        }
        return false
      }
    })()
    attachmentUploads.set(temporary.id, task)
    try {
      return await task
    } finally {
      if (attachmentUploads.get(temporary.id) === task) attachmentUploads.delete(temporary.id)
    }
  }

  const uploadFiles = async (files: FileList | File[]) => {
    const session = selectedSession()
    if (!session || !isConnected()) return
    const continuation = captureInstanceContinuation()
    await Promise.all(Array.from(files).map(async file => {
      if (!instanceContinuationIsCurrent(continuation)) return
      const name = file.webkitRelativePath || file.name
      if (file.size > 16 * 1024 * 1024) { setError(text.uploadLimitExceeded(name)); return }
      const dataUrl = await blobToDataUrl(file)
      if (!instanceContinuationIsCurrent(continuation)) return
      await uploadDataAttachment(session.profileId, session.id, name, file.type || 'application/octet-stream', dataUrl, file.size)
    }))
  }

  const removeComposerAttachment = (profile: string, sessionId: string, attachmentId: string) => {
    attachmentUploadSources.delete(attachmentId)
    attachmentUploads.delete(attachmentId)
    void mutateClientState(profile, sessionId, {
      kind: 'removeAttachment',
      attachmentId,
    }).catch(() => undefined)
  }

  const addUrlReference = () => {
    const session = selectedSession()
    if (!session) return
    const value = window.prompt(text.urlToInclude)?.trim()
    if (!value) return
    try {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(text.httpUrlsOnly)
      void mutateClientState(session.profileId, session.id, {
        kind: 'appendDraft', text: `@url:${url.toString()}`, separator: '\n',
      }).catch(() => undefined)
    } catch (reason) { setError(text.invalidUrl(reason)) }
  }

  const captureScreen = async () => {
    const session = selectedSession()
    if (!session || !isConnected()) return
    const continuation = captureInstanceContinuation()
    try {
      const attachment = await api.captureScreen({ ...mutationScope(continuation), profileId: session.profileId, sessionId: session.id })
      if (!instanceContinuationIsCurrent(continuation)) return
      if (attachment) await mutateClientState(session.profileId, session.id, { kind: 'addAttachment', attachment })
    } catch (reason) {
      if (instanceContinuationIsCurrent(continuation)) setError(String(reason))
    }
  }

  const appendVoiceTranscript = (target: { profileId: string; sessionId: string }, transcript: string) => {
    const value = transcript.trim()
    if (!value) throw new Error(text.noSpeechDetected)
    const currentDraft = stateFor(target.profileId, target.sessionId).draft
    void mutateClientState(target.profileId, target.sessionId, {
      kind: 'appendDraft', text: value, separator: currentDraft && !/\s$/.test(currentDraft) ? ' ' : '',
    }).catch(() => undefined)
  }

  const toggleVoice = async () => {
    const session = selectedSession()
    if (!session || !isConnected()) return
    const provider: VoiceProvider = localStorage.getItem('ask-hermes.voice-provider') === 'speaches' ? 'speaches' : 'hermes'
    if (speachesSession) {
      setVoiceStatus('transcribing')
      speachesSession.stop()
      return
    }
    if (voiceRecording) {
      const generation = voiceGeneration
      const recording = voiceRecording
      voiceRecording = undefined
      const target = voiceTarget || { ...mutationScope(captureInstanceContinuation()), profileId: session.profileId, sessionId: session.id }
      setVoiceStatus('transcribing')
      try {
        const blob = await recording.stop()
        if (!blob || generation !== voiceGeneration) return
        const dataUrl = await blobToDataUrl(blob)
        if (generation !== voiceGeneration) return
        const result = await api.transcribeVoice({
          instanceId: target.instanceId,
          instanceGeneration: target.instanceGeneration,
          profileId: target.profileId,
          dataUrl,
          mimeType: blob.type || 'audio/webm',
        })
        if (generation !== voiceGeneration) return
        appendVoiceTranscript(target, result.transcript)
      } catch (reason) {
        if (generation === voiceGeneration) setError(microphoneErrorMessage(reason))
      }
      finally {
        if (generation === voiceGeneration) { voiceTarget = undefined; setVoiceStatus('idle') }
      }
      return
    }
    const generation = ++voiceGeneration
    voiceTarget = { ...mutationScope(captureInstanceContinuation()), profileId: session.profileId, sessionId: session.id }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      if (generation !== voiceGeneration) { stream.getTracks().forEach(track => track.stop()); return }
      if (provider === 'speaches') {
        streamingVoiceTranscript = ''
        const target = voiceTarget
        const status = invoke<SpeachesStatus>('ensure_speaches')
        const realtime = new SpeachesRealtimeSession({
          onSpeechStopped: () => { if (generation === voiceGeneration) setVoiceStatus('transcribing') },
          onTranscriptDelta: delta => {
            if (generation !== voiceGeneration || !target) return
            streamingVoiceTranscript += delta
          },
          onComplete: transcript => {
            if (generation !== voiceGeneration || !target) return
            try { appendVoiceTranscript(target, transcript) }
            catch (reason) { setError(text.voiceInputError(reason)) }
            speachesSession = undefined
            voiceTarget = undefined
            setVoiceStatus('idle')
          },
          onError: message => {
            if (generation !== voiceGeneration) return
            speachesSession = undefined
            voiceTarget = undefined
            setVoiceStatus('idle')
            setError(text.voiceInputError(message))
          },
        })
        speachesSession = realtime
        setVoiceStatus('recording')
        await realtime.start(
          status.then(value => speachesRealtimeUrl(value.websocketUrl, localStorage.getItem('ask-hermes.speaches-force-english') === 'true')),
          stream,
        )
        return
      }
      const mimeType = preferredAudioMimeType(value => MediaRecorder.isTypeSupported(value))
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      voiceRecording = new HermesRecording(recorder, stream, mimeType, () => setError(text.voiceRecordingFailed))
      voiceRecording.start()
      setVoiceStatus('recording')
    } catch (reason) {
      if (generation !== voiceGeneration) return
      speachesSession?.cancel()
      speachesSession = undefined
      voiceRecording?.cancel()
      voiceRecording = undefined
      voiceTarget = undefined
      setError(microphoneErrorMessage(reason))
      setVoiceStatus('idle')
    }
  }

  const runSearch = async (event?: SubmitEvent, cursor?: string) => {
    event?.preventDefault()
    const query = searchQuery().trim()
    const action = workspaceSearchAction(snapshot()?.capabilities, query, searching())
    if (action.reason) { setError(action.reason); return }
    if (action.disabled) return
    const requestedProfile = profileId()
    const filters = { ...searchFilters() }
    const scope = JSON.stringify([clientInstanceId(), requestedProfile, query, filters])
    if (cursor && scope !== searchResultScope) return
    const generation = ++searchGeneration
    const continuation = captureInstanceContinuation()
    if (!cursor) searchResultScope = scope
    searchNavigation.cancel()
    setSearching(true)
    try {
      const result = await api.search({
        ...mutationScope(continuation),
        query,
        profileId: requestedProfile || undefined,
        filters,
        cursor,
        limit: 50,
      })
      if (!instanceContinuationIsCurrent(continuation)
        || generation !== searchGeneration
        || scope !== searchResultScope) return
      setSearchResults(items => cursor ? [...items, ...result.results] : result.results)
      setSearchCursor(result.cursor)
      setSearchTruncated(previous => cursor ? previous || Boolean(result.truncated) : Boolean(result.truncated))
    } catch (reason) {
      if (instanceContinuationIsCurrent(continuation)
        && generation === searchGeneration
        && scope === searchResultScope) setError(String(reason))
    }
    finally {
      if (instanceContinuationIsCurrent(continuation)
        && generation === searchGeneration
        && scope === searchResultScope) setSearching(false)
    }
  }

  const openSearchResult = async (result: SearchResult) => {
    const ticket = searchNavigation.begin()
    const continuation = captureInstanceContinuation()
    try {
      let messageId = result.messageId
      const resolution = searchResolutionRequest(result)
      if (resolution) {
        const resolved = await api.resolveSearchHit({ ...mutationScope(continuation), ...resolution })
        if (!searchNavigation.isCurrent(ticket) || !instanceContinuationIsCurrent(continuation)) return
        messageId = resolved.messageId
      }
      await ensureSessionLoaded(result.profileId, result.sessionId)
      if (!searchNavigation.isCurrent(ticket) || !instanceContinuationIsCurrent(continuation)) return
      const opened = await openSession(result.profileId, result.sessionId, messageId)
      if (!opened) return
      if (!searchNavigation.isCurrent(ticket) || !instanceContinuationIsCurrent(continuation)) return
      setNavigation(result.archived ? 'archived' : 'chats')
    } catch (reason) {
      if (searchNavigation.isCurrent(ticket) && instanceContinuationIsCurrent(continuation)) setError(String(reason))
    }
  }

  const openSidebarSession = (profile: string, session: string) => {
    invalidateSearchScope()
    setNavigation(navigation() === 'archived' ? 'archived' : 'chats')
    return openSession(profile, session)
  }

  const startSchedule = () => {
    const profile = concreteProfileId()
    if (!profile) return
    navigationGeneration += 1
    scheduleRunGeneration += 1
    void loadProfileChoices(profile).catch(reason => setError(String(reason)))
    setSelection({ kind: 'none' })
    setNavigation('schedules')
    setScheduleDraft({ profileId: profile, kind: 'agent', name: '', prompt: '', cron: '' })
  }

  const editSchedule = (schedule: ScheduleRecord) => {
    navigationGeneration += 1
    scheduleRunGeneration += 1
    void loadProfileChoices(schedule.profileId).catch(reason => setError(String(reason)))
    setScheduleDraft({
      id: schedule.id,
      profileId: schedule.profileId,
      kind: schedule.kind,
      name: schedule.name,
      prompt: schedule.prompt || '',
      cron: schedule.cron,
      originalCron: schedule.cron,
      model: schedule.model,
      provider: schedule.provider,
      preservedFields: schedule.preservedFields,
    })
  }

  const saveSchedule = async (event: SubmitEvent) => {
    event.preventDefault()
    const draft = scheduleDraft()
    if (!draft || !draft.name.trim() || !draft.cron.trim()) return
    const continuation = captureInstanceContinuation()
    try {
      await ensureProfileConnected(draft.profileId)
      if (!instanceContinuationIsCurrent(continuation)) return
      const saved = await api.saveSchedule({ ...mutationScope(continuation), ...draft, name: draft.name.trim(), prompt: draft.prompt.trim(), cron: draft.cron.trim() })
      if (!instanceContinuationIsCurrent(continuation)) return
      setSchedules(items => reduceCollections({ sessions: [], schedules: items }, { type: 'schedule-upsert', schedule: saved }).schedules)
      setScheduleDraft(undefined)
      await openSchedule(saved.profileId, saved.id)
    } catch (reason) {
      if (instanceContinuationIsCurrent(continuation)) setError(String(reason))
    }
  }

  async function loadScheduleRuns(profile: string, schedule: string, cursor?: string) {
    const generation = cursor ? scheduleRunGeneration : ++scheduleRunGeneration
    const continuation = captureInstanceContinuation()
    setLoadingRuns(true)
    try {
      const page = await api.scheduleRuns({
        ...mutationScope(continuation),
        profileId: profile,
        scheduleId: schedule,
        cursor,
        limit: 30,
      })
      const selected = selection()
      if (!instanceContinuationIsCurrent(continuation)
        || generation !== scheduleRunGeneration
        || selected.kind !== 'schedule'
        || selected.profileId !== profile
        || selected.id !== schedule) return
      setScheduleRuns(current => cursor ? [...current, ...page.runs] : page.runs)
      setScheduleRunsCursor(page.cursor)
    } catch (reason) {
      if (instanceContinuationIsCurrent(continuation) && generation === scheduleRunGeneration) setError(String(reason))
    }
    finally {
      if (instanceContinuationIsCurrent(continuation) && generation === scheduleRunGeneration) setLoadingRuns(false)
    }
  }

  const openScheduleRun = async (run: ScheduleRun) => {
    if (!run.sessionId) return
    const navigation = ++navigationGeneration
    const continuation = captureInstanceContinuation()
    try {
      await ensureSessionLoaded(run.profileId, run.sessionId)
      if (!instanceContinuationIsCurrent(continuation) || navigation !== navigationGeneration) return
      setNavigation('chats')
      await openSession(run.profileId, run.sessionId)
    } catch (reason) {
      if (instanceContinuationIsCurrent(continuation)) setError(String(reason))
    }
  }

  const performScheduleAction = async (schedule: ScheduleRecord, action: 'pause' | 'resume' | 'run' | 'delete') => {
    if (action === 'delete' && !window.confirm(text.deleteScheduleConfirmation(schedule.name))) return
    const continuation = captureInstanceContinuation()
    try {
      await ensureProfileConnected(schedule.profileId)
      if (!instanceContinuationIsCurrent(continuation)) return
      await api.scheduleAction({ ...mutationScope(continuation), profileId: schedule.profileId, scheduleId: schedule.id, action })
      if (!instanceContinuationIsCurrent(continuation)) return
      if (action === 'delete') setSelection({ kind: 'none' })
      await refresh()
      if (action === 'run') await loadScheduleRuns(schedule.profileId, schedule.id)
    } catch (reason) {
      if (instanceContinuationIsCurrent(continuation)) setError(String(reason))
    }
  }

  const submitInteractionResponse = async (
    session: SessionSummary,
    interactionId: string,
    optionId?: string,
    value?: string,
  ) => {
    const continuation = captureInstanceContinuation()
    try {
      await api.submitInteraction({
        ...mutationScope(continuation),
        profileId: session.profileId,
        sessionId: session.id,
        interactionId,
        optionId,
        text: value,
      })
    } catch (reason) {
      if (!instanceContinuationIsCurrent(continuation)) return
      setError(String(reason))
      throw reason
    }
  }

  const handleEvent = (event: WorkspaceEvent) => {
    if (event.type === 'instance-invalidated') {
      const invalidatedInstanceId = snapshot()?.instance.id
      const invalidatedTarget = pendingTarget()
      setPendingTarget(undefined)
      if (invalidatedTarget?.handoffId) {
        void settleHandoff(invalidatedTarget, 'failure', text.handoffStaleInstance)
      }
      handoffsInFlight.clear()
      handoffUploads.clear()
      if (invalidatedInstanceId) discardTransientInstanceState(invalidatedInstanceId)
      flushPersistence()
      cancelInstanceContinuations()
      observedTurnStates.clear()
      queueDrainPhases.clear()
      queueDrainsInFlight.clear()
      failedQueueDrains.clear()
      sessionSummaryRequests.clear()
      setTurnStartedAt({})
      setSnapshot(undefined)
      setConnection({ state: 'connecting' })
      setProfileConnections({})
      setSessions([])
      setSchedules([])
      setMessages([])
      setRuntimeSettings({})
      setProfileChoices({})
      profileChoiceRequests.clear()
      setSessionPages({})
      setSelection({ kind: 'none' })
      const preferences = readWorkspaceNotificationPreferences()
      const needsBackground = recoverySeeds.size > 0
        || preferences.turnCompletion
        || preferences.interactionRequired
        || preferences.scheduleFailure
        || preferences.scheduleCompletion
      const scopeRequest = api.instanceScope()
      pendingInstanceScope = scopeRequest
      void scopeRequest.then(scope => {
        if (pendingInstanceScope !== scopeRequest || appDisposed) return
        expectedInstanceId = scope.instanceId
        if (workspaceVisible()) void bootstrap(false, scope)
        else if (needsBackground) {
          workspaceActivated = true
          void bootstrap(true, scope)
        }
      }).catch(reason => {
        if (pendingInstanceScope === scopeRequest && !appDisposed) setError(String(reason))
      }).finally(() => {
        if (pendingInstanceScope === scopeRequest) pendingInstanceScope = undefined
      })
      return
    }
    if (event.type === 'connection') {
      if (event.profileId) {
        setProfileConnections(current => ({ ...current, [event.profileId!]: event.connection }))
      } else {
        setConnection(event.connection)
      }
      return
    }
    if (event.type === 'snapshot-invalidated') {
      if (!document.hidden) void refresh(false, event.profileId)
      return
    }
    const eventSession = event.type === 'message-upsert'
      ? { profileId: event.message.profileId, sessionId: event.message.sessionId }
      : event.type === 'message-delta' || event.type === 'turn-state' || event.type === 'interaction' || event.type === 'session-settings'
        ? { profileId: event.profileId, sessionId: event.sessionId }
        : undefined
    if (eventSession && !sessions().some(item => item.id === eventSession.sessionId && item.profileId === eventSession.profileId)) {
      workspaceActivated = true
      void bootstrap(true)
    }
    let shouldDrainQueue = false
    let ignoreTurnState = false
    let markUnread: { profileId: string; sessionId: string } | undefined
    if (event.type === 'turn-state') {
      const key = drainKey(event.profileId, event.sessionId)
      trackTurnState(event.profileId, event.sessionId, event.state)
      if (event.state === 'running') failedQueueDrains.delete(key)
      const observedPreviousState = sessions().find(item => item.id === event.sessionId && item.profileId === event.profileId)?.turnState
        || observedTurnStates.get(key)
      observedTurnStates.set(key, event.state)
      const transition = queueDrainTransition(queueDrainPhases.get(key), event.state)
      if (transition.phase) queueDrainPhases.set(key, transition.phase)
      else queueDrainPhases.delete(key)
      shouldDrainQueue = transition.shouldDrain
      if (failedQueueDrains.has(key)) shouldDrainQueue = false
      ignoreTurnState = transition.ignoreTurnState
      const previous = sessions().find(item => item.id === event.sessionId && item.profileId === event.profileId)
      if (!ignoreTurnState && isTurnCompletion(observedPreviousState, event.state)) {
        if (!selectedIs(event.profileId, event.sessionId)) markUnread = { profileId: event.profileId, sessionId: event.sessionId }
        void showNativeNotification('turnCompletion', text.hermesFinished, previous?.title || text.chatCompleted, {
          profileId: event.profileId,
          sessionId: event.sessionId,
        })
      }
    } else if (event.type === 'interaction' && !event.interaction.resolved) {
      const session = sessions().find(item => item.id === event.sessionId && item.profileId === event.profileId)
      void showNativeNotification('interactionRequired', event.interaction.kind === 'approval' ? text.hermesNeedsApproval : text.hermesHasQuestion, session?.title || event.interaction.title, {
        profileId: event.profileId,
        sessionId: event.sessionId,
      })
    } else if (event.type === 'schedule-upsert') {
      const previous = schedules().find(item => item.id === event.schedule.id && item.profileId === event.schedule.profileId)
      notifyScheduleTransition(event.schedule, previous)
    }
    const changed = ignoreTurnState ? { sessions: sessions(), schedules: schedules() } : reduceCollections({ sessions: sessions(), schedules: schedules() }, event)
    setSessions(markUnread
      ? changed.sessions.map(item => item.id === markUnread!.sessionId && item.profileId === markUnread!.profileId ? { ...item, unread: true } : item)
      : changed.sessions)
    setSchedules(changed.schedules)
    if (event.type === 'session-settings') {
      applyAuthoritativeApprovalState(event.profileId, event.sessionId, {
        approvalMode: event.settings.approvalMode,
        yolo: event.settings.yolo,
      })
    }
    const selected = selection()
    if (selected.kind === 'chat') {
      const stickToBottom = transcript
        ? transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 140
        : false
      if (event.type === 'message-delta') {
        queueMessageDelta(event)
      } else {
        if (event.type === 'message-upsert') pendingMessageDeltas.delete(`${event.message.profileId}\0${event.message.sessionId}\0${event.message.id}`)
        setMessages(current => reduceMessages(current, event, selected.profileId, selected.id))
      }
      if (stickToBottom) window.requestAnimationFrame(() => transcript?.scrollTo({ top: transcript.scrollHeight }))
    }
    if (event.type === 'client-state') {
      const currentInstance = snapshot()
      if (!currentInstance) {
        if (expectedInstanceId === event.instanceId) {
          workspaceActivated = true
          void bootstrap(true)
        }
        return
      }
      if (currentInstance.instance.id !== event.instanceId
        || currentInstance.instanceGeneration !== event.instanceGeneration) return
      if (event.clientId === mutationClientId) return
      const key = sessionScopeKey(event.instanceId, event.profileId, event.sessionId)
      const eventTarget = {
        instanceId: event.instanceId,
        instanceGeneration: event.instanceGeneration,
        profileId: event.profileId,
        sessionId: event.sessionId,
      }
      if (mutationQueues.get(key)?.length) {
        deferredClientStateEvents.set(key, { target: eventTarget, state: event.state })
        return
      }
      const recoverySeed = recoverySeeds.get(key)
      if (recoverySeed) {
        // Hydration's command response is the ordered authoritative handoff.
        // Rendering this independent event could expose a stale recovered queue
        // and start draining before backend tombstones are applied.
        recoveryIncomingStates.set(key, event.state)
        return
      }
      authoritativeClientStates.set(key, event.state)
      const merged = event.state
      const optimistic = (mutationQueues.get(key) || []).reduce(
        (current, pending) => applyClientStateMutation(current, pending.mutation),
        merged,
      )
      const next = overlayPendingDraft(optimistic, pendingDrafts.get(key)?.draft)
      setClientStates(states => ({ ...states, [key]: next }))
      setSessions(items => items.map(item => item.id === event.sessionId && item.profileId === event.profileId ? { ...item, queuedCount: next.queue.length } : item))
      persistSoon()
      const sessionLoaded = sessions().some(item => item.id === event.sessionId && item.profileId === event.profileId)
      if (!sessionLoaded && next.queue.length) {
        workspaceActivated = true
        void ensureQueuedSessionsLoaded(event.instanceId).catch(reason => setError(String(reason)))
      }
    }
    if (event.type === 'session-remove') {
      const key = drainKey(event.profileId, event.sessionId)
      queueDrainPhases.delete(key)
      queueDrainsInFlight.delete(key)
      failedQueueDrains.delete(key)
      observedTurnStates.delete(key)
    }
    if (event.type === 'turn-state' && shouldDrainQueue) void drainQueue(event.profileId, event.sessionId)
  }

  const onComposerKeyDown: JSX.EventHandler<HTMLTextAreaElement, KeyboardEvent> = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit() }
    if (event.key === 'Escape' && selectedSession()?.turnState === 'running') void stopSession(selectedSession()!)
  }

  const onGlobalKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyD' && !event.altKey && !event.metaKey) {
      event.preventDefault(); void toggleVoice(); return
    }
    if (!(event.ctrlKey || event.metaKey)) return
    if (event.key.toLowerCase() === 'n') { event.preventDefault(); void createChat() }
    if (event.key.toLowerCase() === 'k' || event.key.toLowerCase() === 'f') {
      event.preventDefault(); setNavigation('search'); window.requestAnimationFrame(() => searchInput?.focus())
    }
  }

  const ensureBackgroundBootstrap = () => {
    const preferences = readWorkspaceNotificationPreferences()
    const configured = activeSavedInstance(parseSavedInstances(localStorage.getItem(INSTANCES_KEY)), localStorage.getItem(ACTIVE_INSTANCE_KEY))
    expectedInstanceId = configured.id
    const hasPersistedWork = [...recoverySeeds.keys()].some(scope => parseSessionScopeKey(scope)?.instanceId === configured.id)
    const needsNotifications = preferences.turnCompletion
      || preferences.interactionRequired
      || preferences.scheduleFailure
      || preferences.scheduleCompletion
    if (!hasPersistedWork && !needsNotifications) return
    workspaceActivated = true
    if (backgroundBootstrapInFlight) return backgroundBootstrapInFlight
    if (snapshot()?.instance.id === configured.id) {
      if ((!hasPersistedWork && snapshot()) || bootstrapInFlight) return
      const generation = snapshot()!.instanceGeneration
      const continuation = instanceContinuationGeneration
      const request = hydratePersistedClientStates(configured.id, generation)
        .then(() => ensureQueuedSessionsLoaded(configured.id))
        .catch(reason => {
          if (continuation === instanceContinuationGeneration) setError(text.restoreDraftsAndQueues(reason))
        })
      backgroundBootstrapInFlight = request
      void request.finally(() => {
        if (backgroundBootstrapInFlight === request) backgroundBootstrapInFlight = undefined
      })
      return backgroundBootstrapInFlight
    }
    const request = api.configureInstance(instanceConfig(configured)).then(async scope => {
      if (appDisposed || expectedInstanceId !== configured.id) return
      workspaceActivated = true
      if (!snapshot()) await bootstrap(true, scope)
    }).catch(reason => {
      if (!appDisposed && expectedInstanceId === configured.id) setConnection(failedConnection(reason))
    })
    backgroundBootstrapInFlight = request
    void request.finally(() => {
      if (backgroundBootstrapInFlight === request) backgroundBootstrapInFlight = undefined
    })
    return backgroundBootstrapInFlight
  }

  createEffect(() => { profileId(); navigation(); sidebarCollapsed(); expandedSections(); selection(); persistSoon() })
  let previousNavigation = navigation()
  createEffect(() => {
    const current = navigation()
    if (previousNavigation === 'search' && current !== 'search') invalidateSearchScope()
    previousNavigation = current
  })
  createEffect(() => { void api.setActiveWork(activeWork()).catch(() => undefined) })
  createEffect(() => {
    if (!Object.keys(turnStartedAt()).length) return
    setElapsedNow(Date.now())
    const timer = window.setInterval(() => setElapsedNow(Date.now()), 1000)
    onCleanup(() => window.clearInterval(timer))
  })
  createEffect(() => {
    selection()
    sidebarCollapsed()
    window.requestAnimationFrame(() => {
      setSidebarViewportHeight(sidebarNav?.clientHeight || 600)
      setTranscriptViewportHeight(transcript?.clientHeight || 600)
    })
  })

  onMount(() => {
    document.documentElement.classList.add('workspace-document')
    document.body.classList.add('workspace-document')
    if (import.meta.env.PROD) {
      const reportStartupSmoke = (attempt = 0) => {
        const shell = document.querySelector<HTMLElement>('main.workspace-shell')
        const wordmark = shell?.querySelector<HTMLElement>('.workspace-wordmark')
        if (!shell || !wordmark) return
        const bounds = shell.getBoundingClientRect()
        if ((bounds.width <= 0 || bounds.height <= 0) && attempt < 30) {
          window.requestAnimationFrame(() => reportStartupSmoke(attempt + 1))
          return
        }
        void invoke('report_workspace_startup_smoke', {
          report: {
            documentUrl: window.location.href,
            shellDisplay: window.getComputedStyle(shell).display,
            shellWidth: bounds.width,
            shellHeight: bounds.height,
            wordmark: wordmark.textContent?.trim() || '',
          },
        }).catch(() => undefined)
      }
      window.requestAnimationFrame(() => reportStartupSmoke())
    }
    window.addEventListener('keydown', onGlobalKeyDown)
    const updateViewports = () => {
      setSidebarViewportHeight(sidebarNav?.clientHeight || 600)
      setTranscriptViewportHeight(transcript?.clientHeight || 600)
    }
    window.addEventListener('resize', updateViewports)
    const targetUnlisten = api.targetEvents(openTarget)
    void targetUnlisten.then(() => emit('workspace-target-listener-ready')).catch(reason => setError(String(reason)))
    const quitUnlisten = api.quitEvents(request => {
      // Flush synchronously before the only command that can terminate the
      // process. Rust's authoritative active-work check decides whether the
      // user must confirm; hidden UI state may not contain mirrored turns yet.
      handleWorkspaceQuitRequest(
        request,
        flushPersistence,
        () => window.confirm(text.quitConfirmation),
        api.quitConfirmed,
        api.quitCancelled,
      )
    })
    void quitUnlisten.then(() => api.quitListenerReady()).catch(reason => setError(String(reason)))
    const notificationUnlisten = onAction(openNotificationTarget)
    const notificationPreferencesUnlisten = api.notificationPreferenceEvents(ensureBackgroundBootstrap)
    const activateVisibleWorkspace = () => {
      workspaceActivated = true
      const background = ensureBackgroundBootstrap()
      if (background) return
      if (snapshot()) void refresh()
      else void bootstrap()
    }
    const updateVisibility = (visible: boolean) => {
      setWorkspaceVisible(visible)
      if (visible && workspaceEventsReady) activateVisibleWorkspace()
    }
    workspaceEventSubscription = api.events(handleEvent)
      .then(dispose => {
        workspaceEventsReady = true
        if (appDisposed) dispose()
        else {
          workspaceEventDisposer = dispose
          const background = ensureBackgroundBootstrap()
          if (!background && workspaceVisible()) activateVisibleWorkspace()
        }
      })
      .catch(reason => {
        workspaceEventsReady = true
        if (!appDisposed) {
          setError(String(reason))
          const background = ensureBackgroundBootstrap()
          if (!background && workspaceVisible()) activateVisibleWorkspace()
        }
      })
      .finally(() => { workspaceEventSubscription = undefined })
    const visibilityUnlisten = api.visibilityEvents(updateVisibility)
    void getCurrentWindow().isVisible().then(updateVisibility).catch(() => updateVisibility(false))
    const poll = window.setInterval(() => {
      const hidden = !workspaceVisible() || document.hidden
      const connectionState = effectiveConnection().state
      if (connectionState === 'incompatible') return
      if (hidden && !activeWork()) {
        if (connectionState === 'disconnected' && needsBackgroundMonitoring()) void reconnect(true)
        return
      }
      if (connectionState === 'disconnected') { void reconnect(hidden); return }
      if (connectionState === 'connecting' || connectionState === 'reconnecting') return
      if (snapshot()) void refresh(activeWork())
      else void bootstrap(activeWork())
      const schedule = selectedSchedule()
      if (workspaceVisible() && schedule && !loadingRuns() && capability(snapshot()?.capabilities, 'scheduleHistory').supported) {
        void loadScheduleRuns(schedule.profileId, schedule.id)
      }
    }, 15_000)
    const schedulePoll = window.setInterval(() => {
      const notificationPreferences = readWorkspaceNotificationPreferences()
      if (!schedulesNeedBackgroundPolling(notificationPreferences)) return
      if (!workspaceActivated || workspaceVisible() || schedulePollInFlight || !snapshot() || !isConnected() || !capability(snapshot()?.capabilities, 'schedules').supported) return
      const generation = ++schedulePollGeneration
      const continuation = captureInstanceContinuation()
      schedulePollInFlight = true
      void api.listSchedules(mutationScope(continuation)).then(next => {
        if (!instanceContinuationIsCurrent(continuation) || generation !== schedulePollGeneration) return
        const previous = schedules()
        for (const schedule of next) {
          notifyScheduleTransition(schedule, previous.find(item => item.id === schedule.id && item.profileId === schedule.profileId))
        }
        setSchedules(next)
      }).catch(() => undefined).finally(() => {
        if (generation === schedulePollGeneration) schedulePollInFlight = false
      })
    }, 30_000)
    onCleanup(() => {
      appDisposed = true
      cancelInstanceContinuations()
      window.removeEventListener('keydown', onGlobalKeyDown)
      window.removeEventListener('resize', updateViewports)
      window.clearInterval(poll)
      window.clearInterval(schedulePoll)
      workspaceEventDisposer?.()
      void targetUnlisten.then(dispose => dispose())
      void quitUnlisten.then(dispose => dispose())
      void notificationUnlisten.then(dispose => dispose.unregister())
      void notificationPreferencesUnlisten.then(dispose => dispose())
      void visibilityUnlisten.then(dispose => dispose())
      voiceGeneration += 1
      voiceRecording?.cancel()
      speachesSession?.cancel()
      flushPersistence()
      document.documentElement.classList.remove('workspace-document')
      document.body.classList.remove('workspace-document')
    })
  })

  return (
    <main class="workspace-shell" classList={{ 'sidebar-collapsed': sidebarCollapsed() }}>
      <aside class="workspace-sidebar">
        <header class="workspace-sidebar-header">
          <span class="workspace-wordmark">{text.hermes}</span>
          <button title={text.hideWorkspace} onClick={() => void api.hideWorkspace()}><X size={16} /></button>
        </header>
        <div class="workspace-primary-actions">
          <button class="workspace-new-chat" title={missingReason('sessions')} onClick={() => void createChat()} disabled={creatingChat() || !isConnected() || !concreteProfileId() || Boolean(missingReason('sessions'))}>
            <Plus size={16} /> <span>{text.newChat}</span>
          </button>
          <button classList={{ active: navigation() === 'search' }} onClick={() => { setNavigation('search'); window.requestAnimationFrame(() => searchInput?.focus()) }}>
            <Search size={16} /> <span>{text.search}</span>
          </button>
        </div>
        <label class="workspace-profile-select">
          <span class="sr-only">{text.profile}</span>
          <select value={profileId()} onChange={event => {
            const profile = event.currentTarget.value
            invalidateSearchScope()
            sessionListGeneration += 1
            setLoadingSessions(false)
            setProfileId(profile)
            if (profile) setLastConcreteProfileId(profile)
            setSelection({ kind: 'none' })
            if (profile) void loadProfileChoices(profile).catch(reason => setError(String(reason)))
            void refresh()
          }}>
            <option value="">{text.allProfiles}</option>
            <For each={snapshot()?.profiles}>{profile => <option value={profile.id}>{profile.name}</option>}</For>
          </select>
          <ChevronDown size={14} />
        </label>
        <nav ref={sidebarNav} class="workspace-nav" aria-label={text.workspace} onScroll={event => setSidebarScrollTop(event.currentTarget.scrollTop)}>
          <Show when={navigation() !== 'archived'}>
            <Show when={pinnedSessions().length}>
              <section>
                <button class="workspace-section-title" onClick={() => setExpandedSections(items => items.includes('pinned') ? items.filter(item => item !== 'pinned') : [...items, 'pinned'])}>
                  <span>{text.pinned}</span><span>{pinnedSessions().length}</span>
                </button>
                <Show when={expandedSections().includes('pinned')}>
                  <VirtualSessionList sessions={pinnedSessions()} snapshot={snapshot()} allProfiles={allProfiles()}
                    selected={selectedIs} onOpen={(profile, session) => void openSidebarSession(profile, session)} scrollRoot={sidebarNav}
                    scrollTop={sidebarScrollTop()} viewportHeight={sidebarViewportHeight()} emptyText={text.noChats}
                    layoutKey={`${expandedSections().join(',')}:${pinnedSessions().length}`} />
                </Show>
              </section>
            </Show>
            <section>
              <button class="workspace-section-title" onClick={() => setExpandedSections(items => items.includes('recent') ? items.filter(item => item !== 'recent') : [...items, 'recent'])}>
                <span>{text.recent}</span><span>{recentSessions().length}</span>
              </button>
              <Show when={expandedSections().includes('recent')}>
                  <VirtualSessionList sessions={recentSessions()} snapshot={snapshot()} allProfiles={allProfiles()}
                    selected={selectedIs} onOpen={(profile, session) => void openSidebarSession(profile, session)} scrollRoot={sidebarNav}
                  scrollTop={sidebarScrollTop()} viewportHeight={sidebarViewportHeight()} emptyText={text.noChats}
                  layoutKey={`${expandedSections().join(',')}:${pinnedSessions().length}`} />
              </Show>
            </section>
          </Show>
          <Show when={navigation() === 'archived'}>
            <section>
              <div class="workspace-section-title"><span>{text.archived}</span><span>{visibleSessions().length}</span></div>
              <VirtualSessionList sessions={visibleSessions()} snapshot={snapshot()} allProfiles={allProfiles()}
                selected={selectedIs} onOpen={(profile, session) => void openSidebarSession(profile, session)} scrollRoot={sidebarNav}
                scrollTop={sidebarScrollTop()} viewportHeight={sidebarViewportHeight()} emptyText={text.noArchived}
                layoutKey={`${navigation()}:${expandedSections().join(',')}`} />
            </section>
          </Show>
          <Show when={currentSessionPage()?.cursor}>
            <button class="workspace-load-sessions" disabled={loadingSessions()} onClick={() => void loadMoreSessions()}>
              {loadingSessions() ? text.loading : text.loadMoreChats(currentLoadedSessionCount(), currentSessionPage()?.total)}
            </button>
          </Show>
        </nav>
        <footer class="workspace-sidebar-footer">
          <button classList={{ active: navigation() === 'archived' }} onClick={() => { setNavigation(navigation() === 'archived' ? 'chats' : 'archived'); setSelection({ kind: 'none' }) }}>
            <Archive size={15} /><span>{text.archived}</span>
          </button>
          <button classList={{ active: navigation() === 'schedules' }} onClick={() => { setNavigation('schedules'); setSelection({ kind: 'none' }) }}>
            <CalendarClock size={15} /><span>{text.schedules}</span><span>{scopedSchedules().length}</span>
          </button>
        </footer>
      </aside>

      <section class="workspace-main">
        <header class="workspace-topbar">
          <button class="workspace-sidebar-toggle" onClick={() => setSidebarCollapsed(value => !value)} title={sidebarCollapsed() ? text.showSidebar : text.hideSidebar}>
            <Show when={sidebarCollapsed()} fallback={<PanelLeftClose size={17} />}><PanelLeftOpen size={17} /></Show>
          </button>
          <div class="workspace-instance">
            <strong>{snapshot()?.instance.name || text.title}</strong>
          </div>
          <button title={text.refresh} disabled={loading() || effectiveConnection().state === 'incompatible'} onClick={() => void refresh()}><RefreshCw size={15} /></button>
        </header>
        <Show when={effectiveConnection().state === 'disconnected' || effectiveConnection().state === 'incompatible'}>
          <div class="workspace-connection-banner" classList={{ incompatible: effectiveConnection().state === 'incompatible' }} role="status">
            <CircleAlert size={17} />
            <span>{effectiveConnection().state === 'incompatible' ? text.incompatible : text.disconnected}<Show when={effectiveConnection().error}> {effectiveConnection().error}</Show></span>
            <Show when={effectiveConnection().state !== 'incompatible'}><button onClick={() => void reconnect()}>{text.reconnect}</button></Show>
          </div>
        </Show>
        <Show when={error()}><div class="workspace-error" role="alert"><span>{error()}</span><button onClick={() => setError('')}><X size={14} /></button></div></Show>

        <Switch>
          <Match when={loading()}><div class="workspace-centered"><LoaderCircle class="workspace-spin" size={22} /> {text.connectingToHermes}</div></Match>
          <Match when={navigation() === 'search'}>
            <section class="workspace-search-view">
              <header><h1>{text.searchChats}</h1><p>{text.searchDescription}</p></header>
              <form class="workspace-search-form" onSubmit={runSearch}>
                <div><Search size={17} /><input ref={searchInput} value={searchQuery()} onInput={event => { invalidateSearchScope(); setSearchQuery(event.currentTarget.value) }} placeholder={text.searchMessages} /><button type="submit" title={searchAction().reason} disabled={searchAction().disabled}>{searching() ? text.searching : text.search}</button></div>
                <details>
                  <summary>{text.filters}</summary>
                  <label><input type="checkbox" checked={searchFilters().includeActive} onChange={event => { invalidateSearchScope(); setSearchFilters(value => ({ ...value, includeActive: event.currentTarget.checked })) }} /> {text.active}</label>
                  <label><input type="checkbox" checked={searchFilters().includeArchived} onChange={event => { invalidateSearchScope(); setSearchFilters(value => ({ ...value, includeArchived: event.currentTarget.checked })) }} /> {text.archivedFilter}</label>
                  <label>{text.source} <select value={searchFilters().source || ''} onChange={event => { invalidateSearchScope(); setSearchFilters(value => ({ ...value, source: (event.currentTarget.value || undefined) as SearchFilters['source'] })) }}><option value="">{text.any}</option><option value="workspace">{text.workspaceSource}</option><option value="desktop">{text.desktopSource}</option><option value="cli">{text.cliSource}</option><option value="schedule">{text.scheduleSource}</option><option value="messaging">{text.messagingSource}</option></select></label>
                  <label>{text.from} <input type="date" value={searchFilters().from || ''} onChange={event => { invalidateSearchScope(); setSearchFilters(value => ({ ...value, from: event.currentTarget.value || undefined })) }} /></label>
                  <label>{text.to} <input type="date" value={searchFilters().to || ''} onChange={event => { invalidateSearchScope(); setSearchFilters(value => ({ ...value, to: event.currentTarget.value || undefined })) }} /></label>
                </details>
              </form>
              <Show when={!capability(snapshot()?.capabilities, 'sessionSearch').supported}><div class="workspace-feature-missing">{capability(snapshot()?.capabilities, 'sessionSearch').reason}</div></Show>
              <Show when={searchTruncated()}><div class="workspace-feature-missing">{text.partialSearchResults}</div></Show>
              <div class="workspace-search-results">
                <For each={searchResults()} fallback={<div class="workspace-empty">{searchQuery() ? text.noSearchResults : text.enterSearchQuery}</div>}>
                  {result => <button onClick={() => void openSearchResult(result)}>
                    <span><strong>{result.title}</strong><ProfileBadge snapshot={snapshot()} profileId={result.profileId} /></span>
                    <p>{result.excerpt}</p><small>{result.source} · {formatTime(result.timestamp)}</small>
                  </button>}
                </For>
                <Show when={searchCursor()}>{cursor => <button disabled={searching()} onClick={() => void runSearch(undefined, cursor())}>{text.loadMoreResults}</button>}</Show>
              </div>
            </section>
          </Match>
          <Match when={scheduleDraft()}>{draft => (
            <section class="workspace-schedule-editor">
              <header><div><h1>{draft().id ? text.editSchedule : text.addSchedule}</h1><ProfileBadge snapshot={snapshot()} profileId={draft().profileId} /></div><button onClick={() => setScheduleDraft(undefined)}><X size={16} /></button></header>
              <form onSubmit={saveSchedule}>
                <label>{text.name}<input value={draft().name} onInput={event => setScheduleDraft(value => value ? { ...value, name: event.currentTarget.value } : value)} required /></label>
                <Show when={!draft().kind || draft().kind === 'agent'}><label>{text.prompt}<textarea value={draft().prompt} onInput={event => setScheduleDraft(value => value ? { ...value, prompt: event.currentTarget.value } : value)} rows={8} /></label></Show>
                <label>{text.cronExpression}<input value={draft().cron} onInput={event => setScheduleDraft(value => value ? { ...value, cron: event.currentTarget.value } : value)} placeholder={text.cronPlaceholder} required spellcheck={false} /></label>
                <Show when={!draft().kind || draft().kind === 'agent'}><div class="workspace-form-row">
                  <label>{text.model}<select value={(() => {
                    const choice = currentChoices().models.find(model => model.id === draft().model && (!draft().provider || model.provider === draft().provider))
                    return choice ? modelOptionKey(choice) : ''
                  })()} onChange={event => {
                    const choice = currentChoices().models.find(model => modelOptionKey(model) === event.currentTarget.value)
                    setScheduleDraft(value => value ? { ...value, model: choice?.id, provider: choice?.provider } : value)
                  }}><option value="">{text.hermesDefault}</option><For each={currentChoices().models}>{model => <option value={modelOptionKey(model)}>{model.label}{model.provider ? ` · ${model.provider}` : ''}</option>}</For></select></label>
                  <label>{text.provider}<input value={draft().provider || ''} onInput={event => setScheduleDraft(value => value ? { ...value, provider: event.currentTarget.value || undefined } : value)} placeholder={text.hermesDefault} /></label>
                </div></Show>
                <footer><button type="button" onClick={() => setScheduleDraft(undefined)}>{text.cancel}</button><button class="primary" type="submit" disabled={!isConnected()}>{text.save}</button></footer>
              </form>
            </section>
          )}</Match>
          <Match when={navigation() === 'schedules' && selection().kind === 'none'}>
            <section class="workspace-schedules-list">
              <header><div><h1>{text.schedules}</h1><p>{text.agentJobsFor(allProfiles() ? text.allProfilesLower : profileName(snapshot(), profileId()))}</p></div><button class="primary" disabled={!isConnected() || !capability(snapshot()?.capabilities, 'schedules').supported} title={capability(snapshot()?.capabilities, 'schedules').reason} onClick={startSchedule}><Plus size={15} /> {text.addSchedule}</button></header>
              <label class="workspace-schedule-search"><Search size={15} /><input value={scheduleQuery()} onInput={event => setScheduleQuery(event.currentTarget.value)} placeholder={text.searchSchedules} /></label>
              <For each={visibleSchedules()} fallback={<div class="workspace-empty">{text.noSchedules}</div>}>
                {schedule => <button class="workspace-schedule-row" onClick={() => void openSchedule(schedule.profileId, schedule.id)}>
                  <span><strong>{schedule.name}</strong><ProfileBadge snapshot={snapshot()} profileId={schedule.profileId} /></span>
                  <span>{schedule.cron}</span><span class={`schedule-${schedule.state}`}>{schedule.state}</span><span>{text.next}: {formatTime(schedule.nextRunAt)}</span>
                </button>}
              </For>
            </section>
          </Match>
          <Match when={selectedSchedule()}>{schedule => (
            <section class="workspace-schedule-detail">
              <header>
                <div><h1>{schedule().name}</h1><span>{schedule().kind} · {schedule().state}</span><ProfileBadge snapshot={snapshot()} profileId={schedule().profileId} /></div>
                <div>
                  <button title={missingReason('schedules')} onClick={() => void performScheduleAction(schedule(), schedule().state === 'paused' ? 'resume' : 'pause')} disabled={!isConnected() || Boolean(missingReason('schedules'))}>{schedule().state === 'paused' ? <Play size={14} /> : <Pause size={14} />} {schedule().state === 'paused' ? text.resume : text.pause}</button>
                  <button title={missingReason('schedules')} onClick={() => void performScheduleAction(schedule(), 'run')} disabled={!isConnected() || Boolean(missingReason('schedules'))}><Play size={14} /> {text.runNow}</button>
                  <button title={missingReason('schedules')} onClick={() => editSchedule(schedule())} disabled={!isConnected() || Boolean(missingReason('schedules'))}><Pencil size={14} /> {text.edit}</button>
                  <button title={missingReason('schedules')} class="danger" onClick={() => void performScheduleAction(schedule(), 'delete')} disabled={!isConnected() || Boolean(missingReason('schedules'))}><Trash2 size={14} /></button>
                </div>
              </header>
              <div class="workspace-schedule-facts"><span><small>{text.cron}</small>{schedule().cron}</span><span><small>{text.nextRun}</small>{formatTime(schedule().nextRunAt)}</span><span><small>{text.lastRun}</small>{formatTime(schedule().lastRunAt)}</span><Show when={schedule().model}><span><small>{text.model}</small>{schedule().model}</span></Show></div>
              <Show when={schedule().prompt}><section><h2>{text.prompt}</h2><p class="workspace-schedule-prompt">{schedule().prompt}</p></section></Show>
              <Show when={schedule().lastError}><div class="workspace-feature-missing">{schedule().lastError}</div></Show>
              <section><h2>{text.runHistory}</h2>
                <Show when={missingReason('scheduleHistory')}><div class="workspace-feature-missing">{missingReason('scheduleHistory')}</div></Show>
                <For each={scheduleRuns()} fallback={<div class="workspace-empty">{text.noRuns}</div>}>
                  {run => <button class="workspace-run-row" disabled={!run.sessionId} onClick={() => void openScheduleRun(run)}><span class={`run-${run.status}`}>{run.status}</span><span>{formatTime(run.startedAt)}</span><span>{run.error || (run.finishedAt ? text.finishedAt(formatTime(run.finishedAt)) : text.inProgress)}</span></button>}
                </For>
                <Show when={scheduleRunsCursor()}><button disabled={loadingRuns()} onClick={() => void loadScheduleRuns(schedule().profileId, schedule().id, scheduleRunsCursor())}>{text.loadMore}</button></Show>
              </section>
            </section>
          )}</Match>
          <Match when={selectedSession()}>{session => (
            <section class="workspace-chat">
              <header class="workspace-chat-header">
                <div><h1>{session().title || text.untitledChat}</h1><Show when={turnStartedAt()[`${session().profileId}\0${session().id}`]}>{started => <span>{formatElapsed(elapsedNow() - started())}</span>}</Show><Show when={allProfiles()}><ProfileBadge snapshot={snapshot()} profileId={session().profileId} /></Show></div>
                <div class="workspace-chat-actions">
                  <Show when={session().turnState === 'running' || session().turnState === 'stopping' || session().turnState === 'stalled'}><button class="danger" onClick={() => void stopSession(session())} disabled={!isConnected()}><Square size={12} /> {text.stop}</button></Show>
                  <details><summary title={text.chatOptions}><Ellipsis size={17} /></summary><div>
                    <button title={missingReason('sessions')} onClick={() => { const title = window.prompt(text.chatTitle, session().title); if (title?.trim()) void sessionAction(session(), { kind: 'rename', title: title.trim() }) }} disabled={!isConnected() || Boolean(missingReason('sessions'))}>{text.rename}</button>
                    <button title={missingReason('sessionPin')} onClick={() => void sessionAction(session(), { kind: 'pin', pinned: !session().pinned })}
                      disabled={!isConnected() || Boolean(missingReason('sessionPin'))}>{session().pinned ? text.unpin : text.pin}</button>
                    <button title={missingReason('sessionBranch')} onClick={() => void branchFromSession(session())} disabled={!isConnected() || Boolean(missingReason('sessionBranch'))}>{text.branch}</button>
                    <Show when={session().archived} fallback={<button title={lifecycleReasonFor(session()) || missingReason('sessionArchive')} onClick={() => void sessionAction(session(), { kind: 'archive' })} disabled={!isConnected() || Boolean(missingReason('sessionArchive')) || Boolean(lifecycleReasonFor(session()))}>{text.archive}</button>}><button title={missingReason('sessionArchive')} onClick={() => void sessionAction(session(), { kind: 'restore' })} disabled={!isConnected() || Boolean(missingReason('sessionArchive'))}>{text.restore}</button></Show>
                    <Show when={session().archived}><button title={lifecycleReasonFor(session()) || missingReason('sessionDelete')} class="danger" onClick={() => window.confirm(text.deleteChatConfirmation(session().title)) && void sessionAction(session(), { kind: 'delete' })} disabled={!isConnected() || Boolean(missingReason('sessionDelete')) || Boolean(lifecycleReasonFor(session()))}>{text.deletePermanently}</button></Show>
                  </div></details>
                </div>
              </header>
              <div class="workspace-transcript" ref={transcript} onScroll={event => {
                setTranscriptScrollTop(event.currentTarget.scrollTop)
                setTranscriptViewportHeight(event.currentTarget.clientHeight)
              }}>
                <Show when={hasOlder()}><button class="workspace-load-older" disabled={loadingMessages()} onClick={() => void loadMessagePage(session().profileId, session().id, olderCursor())}>{text.loadEarlier}</button></Show>
                <div class="workspace-message-virtual-list" style={{ height: `${messageLayout().total}px` }}>
                  <div class="workspace-message-virtual-window" style={{ transform: `translateY(${messageLayout().offsets[visibleMessageRange().start]}px)` }}>
                    <For each={visibleMessages()}>{message => (
                      <MeasuredMessage id={message.id} onHeight={updateMessageHeight}>
                        <MessageCard message={message} disabled={!isConnected()} onCopy={() => void navigator.clipboard.writeText(message.content)}
                          onRetry={() => void retryMessage(session(), message)}
                          onEdit={() => void editMessage(session(), message)}
                          onBranch={() => void branchFromSession(session(), message.id)}
                           onUndo={() => void undoMessage(session(), message)}
                           onInteraction={(interactionId, optionId, value) => submitInteractionResponse(session(), interactionId, optionId, value)}
                           onOpenLink={url => void api.openExternal(url)}
                           gatewayFileReason={!isConnected() ? text.reconnectToOpenGatewayFile : missingReason('artifactFiles')}
                           onReadGatewayFile={path => readGatewayFile(message.profileId, path)}
                           onOpenGatewayFile={(path, name) => openGatewayFile(message.profileId, path, name)}
                           actionReasons={{ retry: missingReason('messageRetry'), edit: missingReason('messageEdit'), branch: missingReason('sessionBranch'), undo: missingReason('messageUndo') || (latestExchangeMessageIds().has(message.id) ? undefined : text.latestExchangeOnly), interaction: missingReason('interactions') }} />
                      </MeasuredMessage>
                    )}</For>
                  </div>
                </div>
              </div>
              <Show when={selectedChildSessions().length}>
                <details class="workspace-child-activity">
                  <summary>{text.agentActivity} <span>{selectedChildSessions().length}</span></summary>
                  <For each={selectedChildSessions()}>{child => (
                    <button onClick={() => void openSession(child.profileId, child.id)}>
                      <span><Show when={child.source === 'subagent'} fallback={<Play size={12} />}><GitBranch size={12} /></Show>{child.title || child.source}</span>
                      <span>{child.turnState} · {formatTime(child.updatedAt)}</span>
                      <Show when={child.lastMessagePreview}><small>{child.lastMessagePreview}</small></Show>
                    </button>
                  )}</For>
                </details>
              </Show>
              <Show when={selectedClientState().queue.length}>
                <section class="workspace-queue">
                  <header><span>{text.queue}</span><span>{selectedClientState().queue.length}</span><Show when={session().turnState === 'error' || failedQueueDrains.has(drainKey(session().profileId, session().id))}><button onClick={() => { const key = drainKey(session().profileId, session().id); failedQueueDrains.delete(key); queueDrainPhases.delete(key); void drainQueue(session().profileId, session().id) }}>{text.retryQueuedPrompts}</button></Show></header>
                  <For each={selectedClientState().queue}>{(entry, index) => <div>
                    <div class="workspace-queue-content"><textarea value={entry.text} onInput={event => { void mutateClientState(session().profileId, session().id, { kind: 'updateQueue', entryId: entry.id, text: event.currentTarget.value }).catch(() => undefined) }} rows={1} /><Show when={entry.attachments.length}><span>{entry.attachments.map(item => item.name).join(', ')}</span></Show></div>
                    <button title={text.moveUp} disabled={index() === 0} onClick={() => { void mutateClientState(session().profileId, session().id, { kind: 'moveQueue', entryId: entry.id, direction: -1 }).catch(() => undefined) }}><ArrowUp size={13} /></button>
                    <button title={text.moveDown} disabled={index() === selectedClientState().queue.length - 1} onClick={() => { void mutateClientState(session().profileId, session().id, { kind: 'moveQueue', entryId: entry.id, direction: 1 }).catch(() => undefined) }}><ArrowDown size={13} /></button>
                    <button title={text.remove} onClick={() => { void mutateClientState(session().profileId, session().id, { kind: 'removeQueue', entryId: entry.id }).catch(() => undefined) }}><X size={13} /></button>
                  </div>}</For>
                </section>
              </Show>
              <Show when={!session().archived}><footer class="workspace-composer-wrap">
                <Show when={slashCommands().length}><div class="workspace-command-menu"><For each={slashCommands()}>{command => <button onClick={() => setDebouncedDraft(session().profileId, session().id, `/${command.name.replace(/^\//, '')} `)}><strong>/{command.name.replace(/^\//, '')}</strong><span>{command.description}</span></button>}</For></div></Show>
                <div class="workspace-composer" onDragOver={event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy' }} onDrop={event => { event.preventDefault(); if (event.dataTransfer) void uploadFiles(event.dataTransfer.files) }}>
                  <Show when={selectedClientState().attachments.length}><div class="workspace-composer-attachments"><For each={selectedClientState().attachments}>{attachment => <span classList={{ failed: attachment.state === 'failed' }} title={attachment.error}><Show when={attachment.state === 'uploading'} fallback={<Show when={attachment.mimeType.startsWith('image/') && attachment.previewUrl} fallback={<FileIcon size={13} />}>{preview => <img src={preview()} alt="" />}</Show>}><LoaderCircle class="workspace-spin" size={13} /></Show>{attachment.name}<button title={text.remove} onClick={() => removeComposerAttachment(session().profileId, session().id, attachment.id)}><X size={11} /></button></span>}</For></div></Show>
                  <textarea ref={composerInput} value={selectedClientState().draft} onInput={event => setDebouncedDraft(session().profileId, session().id, event.currentTarget.value)} onKeyDown={onComposerKeyDown}
                    onPaste={event => { const files = Array.from(event.clipboardData?.files || []); if (files.length) { event.preventDefault(); void uploadFiles(files) } }}
                    placeholder={isConnected() ? text.messagePlaceholder : text.reconnectToSend} disabled={!isConnected() || session().archived} rows={2} />
                  <div class="workspace-composer-actions">
                    <input ref={fileInput} type="file" multiple hidden onChange={event => { if (event.currentTarget.files) void uploadFiles(event.currentTarget.files); event.currentTarget.value = ''; if (attachMenu) attachMenu.open = false }} />
                    <input ref={element => { folderInput = element; element.setAttribute('webkitdirectory', '') }} type="file" multiple hidden onChange={event => { if (event.currentTarget.files) void uploadFiles(event.currentTarget.files); event.currentTarget.value = ''; if (attachMenu) attachMenu.open = false }} />
                    <details ref={attachMenu} class="workspace-attach-menu"><summary title={text.addContext}><Paperclip size={16} /></summary><div>
                      <button disabled={!isConnected()} onClick={() => fileInput?.click()}>{text.attachFiles}</button>
                      <button disabled={!isConnected()} onClick={() => folderInput?.click()}>{text.attachFolder}</button>
                      <button disabled={!isConnected()} onClick={addUrlReference}>{text.addUrlReference}</button>
                    </div></details>
                    <button title={missingReason('attachments') || text.captureScreen} disabled={!isConnected() || Boolean(missingReason('attachments'))} onClick={() => void captureScreen()}><Camera size={16} /></button>
                    <button title={voiceStatus() === 'recording' ? text.stopVoiceInput : voiceStatus() === 'transcribing' ? text.transcribingVoiceInput : text.voiceInput} classList={{ 'voice-recording': voiceStatus() === 'recording' }} disabled={!isConnected() || voiceStatus() === 'transcribing'} onClick={() => void toggleVoice()}><Show when={voiceStatus() !== 'transcribing'} fallback={<LoaderCircle class="workspace-spin" size={16} />}><Mic size={16} /></Show></button>
                    <details class="workspace-runtime-menu"><summary title={text.chatControls}><Settings2 size={16} /></summary><div>
                      <label>{text.model}<select value={selectedModelChoice() ? modelOptionKey(selectedModelChoice()!) : ''} onChange={event => {
                        const choice = currentChoices().models.find(model => modelOptionKey(model) === event.currentTarget.value)
                        const current = selectedSettings()
                        setRuntimeSettings(items => ({ ...items, [settingsKeyFor(session().profileId, session().id)]: {
                          ...current,
                          model: choice?.id,
                          provider: choice?.provider,
                          reasoningEffort: choice?.reasoningEfforts?.includes(current.reasoningEffort || '') ? current.reasoningEffort : undefined,
                          fast: choice?.supportsFast ? current.fast : undefined,
                        } }))
                      }}><option value="">{text.hermesDefault}</option><For each={availableModels()}>{model => <option value={modelOptionKey(model)}>{model.label}{model.provider ? ` · ${model.provider}` : ''}</option>}</For></select></label>
                      <Show when={providers().length}><label>{text.provider}<select value={selectedSettings().provider || ''} onChange={event => {
                        const provider = event.currentTarget.value || undefined
                        const model = currentChoices().models.some(choice => choice.id === selectedSettings().model && choice.provider === provider) ? selectedSettings().model : undefined
                        setRuntimeSettings(items => ({ ...items, [settingsKeyFor(session().profileId, session().id)]: { ...selectedSettings(), provider, model } }))
                      }}><option value="">{text.hermesDefault}</option><For each={providers()}>{provider => <option value={provider}>{provider}</option>}</For></select></label></Show>
                      <Show when={selectedModelChoice()?.reasoningEfforts?.length}><label>{text.reasoningSetting}<select value={selectedSettings().reasoningEffort || ''} onChange={event => setRuntimeSettings(items => ({ ...items, [settingsKeyFor(session().profileId, session().id)]: { ...selectedSettings(), reasoningEffort: event.currentTarget.value || undefined } }))}><option value="">{text.default}</option><For each={selectedModelChoice()?.reasoningEfforts || []}>{effort => <option value={effort}>{effort}</option>}</For></select></label></Show>
                      <Show when={selectedModelChoice()?.supportsFast}><label class="workspace-toggle">{text.fastMode}<input type="checkbox" checked={selectedSettings().fast || false} onChange={event => setRuntimeSettings(items => ({ ...items, [settingsKeyFor(session().profileId, session().id)]: { ...selectedSettings(), fast: event.currentTarget.checked } }))} /></label></Show>
                      <Show when={currentChoices().personalities.length}><label>{text.personality}<select value={selectedSettings().personality || ''} onChange={event => setRuntimeSettings(items => ({ ...items, [settingsKeyFor(session().profileId, session().id)]: { ...selectedSettings(), personality: event.currentTarget.value || undefined } }))}><option value="">{text.default}</option><For each={currentChoices().personalities}>{personality => <option value={personality.id}>{personality.label}</option>}</For></select></label></Show>
                       <label>{text.approvals}<select value={selectedSettings().yolo ? 'yolo' : 'default'} disabled={!isConnected()} onChange={event => void setSessionYolo(session(), event.currentTarget.value === 'yolo')}><option value="default">{text.default}</option><option value="yolo">{text.yolo}</option></select></label>
                    </div></details>
                    <span class="workspace-composer-model">{selectedModelChoice()?.label || text.hermesDefault}</span>
                    <button class="workspace-send" title={selectedClientState().attachments.some(item => item.state === 'failed') ? text.retryFailedAttachments : selectedClientState().attachments.some(item => item.state === 'uploading') ? text.waitForAttachments : session().turnState === 'running' ? text.addToQueue : text.send} onClick={() => void submit()} disabled={!isConnected() || !composerHasSubmission(selectedClientState().draft, selectedClientState().attachments)}><SendHorizontal size={17} /></button>
                  </div>
                </div>
              </footer></Show>
            </section>
          )}</Match>
          <Match when={true}><div class="workspace-centered workspace-welcome"><MessageSquare size={28} /><h1>{text.selectChat}</h1><button class="primary" title={missingReason('sessions')} disabled={creatingChat() || !isConnected() || Boolean(missingReason('sessions'))} onClick={() => void createChat()}><Plus size={15} /> {text.newChat}</button></div></Match>
        </Switch>
      </section>
    </main>
  )
}

export { WorkspaceApp }
export default WorkspaceApp

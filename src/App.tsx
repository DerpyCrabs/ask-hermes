import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification'
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart'
import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import type { JSX } from 'solid-js'
import ArrowRight from 'lucide-solid/icons/arrow-right'
import Camera from 'lucide-solid/icons/camera'
import ChevronDown from 'lucide-solid/icons/chevron-down'
import ExternalLink from 'lucide-solid/icons/external-link'
import LoaderCircle from 'lucide-solid/icons/loader-circle'
import Mic from 'lucide-solid/icons/mic'
import PanelsTopLeft from 'lucide-solid/icons/panels-top-left'
import Plus from 'lucide-solid/icons/plus'
import Trash2 from 'lucide-solid/icons/trash-2'
import Square from 'lucide-solid/icons/square'
import X from 'lucide-solid/icons/x'
import { NEW_SESSION, normalizeSelection } from './selection'
import { appendCapture, clipboardImageFiles, imageFileToCapture, removeCaptureAt, type Capture } from './captures'
import { renderMarkdown } from './markdown'
import { autostartAction } from './autostart'
import { runHermesTurn } from './hermes-gateway'
import { appendAnswerDelta, beginExchange, finishExchange, type Exchange } from './conversation'
import { shortcutFromKeyboardEvent, transcriptFromMessages, type HistoryMessage, type HistoryPage, type SessionShortcut } from './session-shortcuts'
import { sessionsEqual, type SessionRecord } from './sessions'
import { supportsFastMode } from './model-settings'
import { formatTurnActivity } from './turn-activity'
import { shouldRememberPreviousChat } from './previous-chat'
import { HermesRecording, HermesSilenceDetector, VoiceStartGate, blobToDataUrl, isVoiceInputShortcut, microphoneErrorMessage, normalizedVoiceLevel, preferredAudioMimeType, voiceInputTooltip, type VoiceInputStatus } from './voice-input'
import { SpeachesRealtimeSession, speachesRealtimeUrl } from './speaches-realtime'
import { buildHermesInstanceConfig } from './hermes-instance'
import { WorkspaceApp } from './WorkspaceApp'
import { workspaceCommands } from './workspace/commands'
import { applyClientStateMutation, clientStateGenerationMatches, overlayPendingDraft } from './workspace/state'
import {
  ACTIVE_INSTANCE_KEY,
  AUTOMATIC_INSTANCE_ID,
  INSTANCES_KEY,
  activeSavedInstance,
  automaticHermesInstance,
  parseSavedInstances,
  type SavedHermesInstance,
} from './instances'
import {
  readWorkspaceNotificationPreferences,
  writeWorkspaceNotificationPreferences,
} from './workspace/notifications'
import { workspaceText as workspaceCopy } from './workspace/strings'
import {
  handoffResultMatchesPending,
  handoffPayloadMatches,
  handoffSourceRevisionIsCurrent,
  type PendingHandoffIdentity,
} from './workspace/handoff'
import type { AttachmentRef, ClientStateMutation, QueueEntry, SessionClientState, WorkspaceEvent, WorkspaceHandoffResult, WorkspaceOpenRequest } from './workspace/types'
import hermesIcon from '../src-tauri/icons/hermes-tray-source.png'

type Session = SessionRecord

type Selection = { x: number; y: number; width: number; height: number }
type PreviousChat = { history: Exchange[]; activeSession: string; runtimeSession?: string }
type VoiceConfig = { maxRecordingSeconds: number; sttEnabled: boolean }
type VoiceTranscription = { transcript: string }
type VoiceProvider = 'hermes' | 'speaches'
type SpeachesStatus = { installed: boolean; running: boolean; model: string; websocketUrl: string }
type SharedClientStateTarget = { instanceId: string; instanceGeneration: number; profileId: string; sessionId: string }
type HermesInstanceScope = { instanceId: string; instanceGeneration: number }
type PendingWorkspaceHandoff = PendingHandoffIdentity & {
  prompt: string
  captures: Capture[]
  target: WorkspaceOpenRequest
}
type PendingSharedMutation = {
  target: SharedClientStateTarget
  mutation: ClientStateMutation
  resolve(state: SessionClientState): void
  reject(reason: unknown): void
}

const SESSION_PREFERENCE_KEY = 'ask-hermes.session-preference.v2'
const MODEL_KEY = 'ask-hermes.model'
const EFFORT_KEY = 'ask-hermes.reasoning-effort'
const FAST_KEY = 'ask-hermes.fast-mode'
const PROMPT_SHORTCUT_KEY = 'ask-hermes.prompt-shortcut.v1'
const SESSION_SHORTCUTS_KEY = 'ask-hermes.session-shortcuts.v1'
const VOICE_PROVIDER_KEY = 'ask-hermes.voice-provider'
const SPEACHES_ENGLISH_KEY = 'ask-hermes.speaches-force-english'
const VOICE_AUTO_START_KEY = 'ask-hermes.voice-auto-start'
const HERMES_ADDRESS_KEY = 'ask-hermes.instance.address'
const HERMES_PORT_KEY = 'ask-hermes.instance.port'
const HERMES_REMOTE_KEY = 'ask-hermes.instance.remote'
const HERMES_TOKEN_KEY = 'ask-hermes.instance.token'
const TRAY_LINK_MODE_KEY = 'ask-hermes.tray-link-mode.v1'
const DEFAULT_PROMPT_SHORTCUT = 'Alt+Space'

type TrayLinkMode = 'workspace' | 'desktop' | 'both'

function storedTrayLinkMode(): TrayLinkMode {
  const value = localStorage.getItem(TRAY_LINK_MODE_KEY)
  return value === 'desktop' || value === 'both' ? value : 'workspace'
}

function initialSavedInstances() {
  const parsed = parseSavedInstances(localStorage.getItem(INSTANCES_KEY))
  if (parsed.some(instance => instance.mode === 'existing')) return parsed
  if (localStorage.getItem(HERMES_REMOTE_KEY) !== 'true') return parsed
  return [
    ...parsed.filter(instance => instance.id !== 'legacy-existing'),
    {
      id: 'legacy-existing',
      name: workspaceCopy.existingHermes,
      mode: 'existing' as const,
      address: localStorage.getItem(HERMES_ADDRESS_KEY) || '127.0.0.1',
      port: Number(localStorage.getItem(HERMES_PORT_KEY) || 9119),
      token: localStorage.getItem(HERMES_TOKEN_KEY) || '',
    },
  ]
}

function storedSessionShortcuts(): SessionShortcut[] {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_SHORTCUTS_KEY) || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function storedPromptShortcut() {
  return localStorage.getItem(PROMPT_SHORTCUT_KEY) || DEFAULT_PROMPT_SHORTCUT
}

function compactTime(timestamp: number) {
  if (!timestamp) return ''
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp * 1000))
}

function PromptWindow() {
  let inputRef: HTMLTextAreaElement | undefined
  let conversationRef: HTMLDivElement | undefined
  let promptGeneration = 0
  let composerRevision = 0
  let openedFromSessionShortcut = false
  let hermesRecording: HermesRecording | undefined
  let voiceStartedAt = 0
  let voiceInterval: number | undefined
  let voiceTimeout: number | undefined
  let voiceAudioContext: AudioContext | undefined
  let voiceMeterSource: MediaStreamAudioSourceNode | undefined
  let voiceMeterFrame: number | undefined
  let voiceGeneration = 0
  let speachesSession: SpeachesRealtimeSession | undefined
  let activeVoiceProvider: VoiceProvider | undefined
  let streamingTranscript = ''
  const voiceStartGate = new VoiceStartGate()
  const [sessions, setSessions] = createSignal<Session[]>([])
  const [sessionPreference, setSessionPreference] = createSignal(
    localStorage.getItem(SESSION_PREFERENCE_KEY) || NEW_SESSION,
  )
  const [activeSession, setActiveSession] = createSignal(sessionPreference())
  const [runtimeSession, setRuntimeSession] = createSignal<string>()
  const [prompt, setPrompt] = createSignal('')
  const [captures, setCaptures] = createSignal<Capture[]>([])
  const [preview, setPreview] = createSignal<Capture>()
  const [history, setHistory] = createSignal<Exchange[]>([])
  const [previousChat, setPreviousChat] = createSignal<PreviousChat>()
  const [busy, setBusy] = createSignal(false)
  const [submitStarting, setSubmitStarting] = createSignal(false)
  const [workspaceHandoffInFlight, setWorkspaceHandoffInFlight] = createSignal(false)
  const [workspaceBusy, setWorkspaceBusy] = createSignal(false)
  const [workspaceProfileId, setWorkspaceProfileId] = createSignal<string>()
  const [workspaceSessionId, setWorkspaceSessionId] = createSignal<string>()
  const [workspaceInstanceId, setWorkspaceInstanceId] = createSignal<string>()
  const [workspaceInstanceGeneration, setWorkspaceInstanceGeneration] = createSignal<number>()
  const [sharedClientState, setSharedClientState] = createSignal<SessionClientState>({ draft: '', queue: [], attachments: [] })
  const [turnActivities, setTurnActivities] = createSignal<Record<string, string>>({})
  const [capturing, setCapturing] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [settingsTab, setSettingsTab] = createSignal<'general' | 'hermes' | 'voice' | 'shortcuts'>('general')
  const [model, setModel] = createSignal(localStorage.getItem(MODEL_KEY) || 'gpt-5.6-terra')
  const [effort, setEffort] = createSignal(localStorage.getItem(EFFORT_KEY) || 'low')
  const [fastMode, setFastMode] = createSignal(localStorage.getItem(FAST_KEY) === 'true')
  const [startAtLogin, setStartAtLogin] = createSignal(false)
  const [promptShortcut, setPromptShortcut] = createSignal(storedPromptShortcut())
  const [sessionShortcuts, setSessionShortcuts] = createSignal<SessionShortcut[]>(storedSessionShortcuts())
  const [pagedMessages, setPagedMessages] = createSignal<HistoryMessage[]>([])
  const [pagedSession, setPagedSession] = createSignal<string>()
  const [hasOlderMessages, setHasOlderMessages] = createSignal(false)
  const [loadingOlderMessages, setLoadingOlderMessages] = createSignal(false)
  const [loadingSessionHistory, setLoadingSessionHistory] = createSignal(false)
  const [error, setError] = createSignal('')
  const [settingsError, setSettingsError] = createSignal('')
  const [desktopAvailable, setDesktopAvailable] = createSignal(false)
  const [voiceStatus, setVoiceStatus] = createSignal<VoiceInputStatus>('idle')
  const [voiceElapsed, setVoiceElapsed] = createSignal(0)
  const [voiceProvider, setVoiceProvider] = createSignal<VoiceProvider>(
    localStorage.getItem(VOICE_PROVIDER_KEY) === 'speaches' ? 'speaches' : 'hermes',
  )
  const [speachesStatus, setSpeachesStatus] = createSignal<SpeachesStatus>()
  const [speachesForceEnglish, setSpeachesForceEnglish] = createSignal(
    localStorage.getItem(SPEACHES_ENGLISH_KEY) === 'true',
  )
  const [voiceAutoStart, setVoiceAutoStart] = createSignal(
    localStorage.getItem(VOICE_AUTO_START_KEY) === 'true',
  )
  const initialInstances = initialSavedInstances()
  const initialInstance = activeSavedInstance(
    initialInstances,
    localStorage.getItem(ACTIVE_INSTANCE_KEY)
      || (localStorage.getItem(HERMES_REMOTE_KEY) === 'true' ? 'legacy-existing' : AUTOMATIC_INSTANCE_ID),
  )
  const [savedInstances, setSavedInstances] = createSignal(initialInstances)
  const [activeInstanceId, setActiveInstanceId] = createSignal(initialInstance.id)
  const [instanceName, setInstanceName] = createSignal(initialInstance.name)
  const [remoteHermes, setRemoteHermes] = createSignal(initialInstance.mode === 'existing')
  const [hermesAddress, setHermesAddress] = createSignal(initialInstance.address || '127.0.0.1')
  const [hermesPort, setHermesPort] = createSignal(String(initialInstance.port || 9119))
  const [hermesToken, setHermesToken] = createSignal(initialInstance.token || '')
  const isBusy = () => busy() || workspaceBusy() || submitStarting()
  const canQueueDuringLocalTurn = () => busy()
    && activeSession() !== NEW_SESSION
    && workspaceSessionId() === activeSession()
    && Boolean(workspaceProfileId())
  const workspaceAssistantExchanges = new Map<string, string>()
  let sharedDraftTimer: number | undefined
  let sharedDraftRevision = 0
  let pendingSharedDraft: {
    draft: string
    revision: number
    target: { instanceId: string; instanceGeneration: number; profileId: string; sessionId: string }
  } | undefined
  let sharedDraftCommit: Promise<void> | undefined
  const sharedMutationQueues = new Map<string, PendingSharedMutation[]>()
  const sharedMutationProcessing = new Set<string>()
  const deferredSharedClientStates = new Map<string, { target: SharedClientStateTarget; state: SessionClientState }>()
  const sharedMutationClientId = globalThis.crypto?.randomUUID?.() || `prompt-${Date.now()}-${Math.random()}`
  let pendingWorkspaceHandoff: PendingWorkspaceHandoff | undefined
  let failedWorkspaceHandoff: PendingWorkspaceHandoff | undefined
  let promptConfigurationReady = false
  let promptConfigurationInFlight: Promise<HermesInstanceScope> | undefined
  let sessionLoadRequest = 0
  let voiceInstanceScope: HermesInstanceScope | undefined
  const [trayLinkMode, setTrayLinkMode] = createSignal<TrayLinkMode>(storedTrayLinkMode())
  const initialNotificationPreferences = readWorkspaceNotificationPreferences()
  const [notifyTurnCompletion, setNotifyTurnCompletion] = createSignal(initialNotificationPreferences.turnCompletion)
  const [notifyInteractionRequired, setNotifyInteractionRequired] = createSignal(initialNotificationPreferences.interactionRequired)
  const [notifyScheduleFailure, setNotifyScheduleFailure] = createSignal(initialNotificationPreferences.scheduleFailure)
  const [notifyScheduleCompletion, setNotifyScheduleCompletion] = createSignal(initialNotificationPreferences.scheduleCompletion)

  const markComposerChanged = () => { composerRevision += 1 }
  const retirePendingWorkspaceHandoff = (preserveRetry = false) => {
    pendingWorkspaceHandoff = undefined
    if (!preserveRetry) failedWorkspaceHandoff = undefined
    setWorkspaceHandoffInFlight(false)
  }
  const dispatchWorkspaceHandoff = (pending: PendingWorkspaceHandoff) =>
    invoke<void>('open_workspace', pending.target)
  const failPendingWorkspaceHandoff = async (pending: PendingWorkspaceHandoff, reason: unknown) => {
    if (pendingWorkspaceHandoff !== pending) return
    failedWorkspaceHandoff = pending
    retirePendingWorkspaceHandoff(true)
    setError(String(reason))
    const currentWindow = getCurrentWindow()
    await currentWindow.show().catch(() => undefined)
    await currentWindow.setFocus().catch(() => undefined)
  }

  const requestNotificationPermission = () => {
    void isPermissionGranted()
      .then(granted => granted ? undefined : requestPermission())
      .catch(() => undefined)
  }

  const currentHermesInstance = () => buildHermesInstanceConfig(
    remoteHermes(),
    hermesAddress(),
    hermesPort(),
    hermesToken(),
    activeInstanceId(),
    instanceName(),
  )
  let appliedHermesInstance = currentHermesInstance()

  const ensurePromptConfiguration = () => {
    if (promptConfigurationReady) return Promise.resolve<HermesInstanceScope | undefined>(undefined)
    if (promptConfigurationInFlight) return promptConfigurationInFlight
    const config = appliedHermesInstance
    const expectedInstanceId = config.instanceId
    const request = invoke<HermesInstanceScope>('configure_hermes_instance', { config })
      .then(scope => {
        if (appliedHermesInstance.instanceId !== expectedInstanceId || scope.instanceId !== expectedInstanceId) {
          throw new Error(workspaceCopy.workspaceTurnReconnecting)
        }
        promptConfigurationReady = true
        return scope
      })
      .finally(() => {
        if (promptConfigurationInFlight === request) promptConfigurationInFlight = undefined
      })
    promptConfigurationInFlight = request
    return request
  }

  const promptInstanceScope = async (expectedInstanceId = appliedHermesInstance.instanceId) => {
    await ensurePromptConfiguration()
    if (appliedHermesInstance.instanceId !== expectedInstanceId) {
      throw new Error(workspaceCopy.workspaceTurnReconnecting)
    }
    return invoke<HermesInstanceScope>('get_hermes_instance_scope', { expectedInstanceId })
  }

  const emptySharedClientState = (): SessionClientState => ({ draft: '', queue: [], attachments: [] })
  const sharedStateTarget = (profileId: string, sessionId: string) => {
    const instanceId = workspaceInstanceId()
    const instanceGeneration = workspaceInstanceGeneration()
    return instanceId && instanceGeneration !== undefined
      ? { instanceId, instanceGeneration, profileId, sessionId }
      : undefined
  }
  const sharedStateTargetIsCurrent = (target: NonNullable<ReturnType<typeof sharedStateTarget>>) =>
    workspaceInstanceId() !== undefined
    && workspaceInstanceGeneration() !== undefined
    && clientStateGenerationMatches({
      instanceId: workspaceInstanceId()!,
      instanceGeneration: workspaceInstanceGeneration()!,
    }, target)
  const sharedMutationKey = (target: SharedClientStateTarget) =>
    `${encodeURIComponent(target.instanceId)}::${target.instanceGeneration}::${encodeURIComponent(target.profileId)}::${encodeURIComponent(target.sessionId)}`

  const renderSharedClientState = (target: SharedClientStateTarget, state: SessionClientState, applyDraft = false) => {
    if (!sharedStateTargetIsCurrent(target)) return
    const optimistic = (sharedMutationQueues.get(sharedMutationKey(target)) || []).reduce(
      (current, pending) => applyClientStateMutation(current, pending.mutation),
      state,
    )
    useSharedClientState(target.profileId, target.sessionId, optimistic, applyDraft)
  }

  const processSharedMutationQueue = (key: string) => {
    if (sharedMutationProcessing.has(key)) return
    sharedMutationProcessing.add(key)
    void (async () => {
      while (sharedMutationQueues.get(key)?.length) {
        const pending = sharedMutationQueues.get(key)![0]
        try {
          const state = await workspaceCommands.mutateClientState({
            ...pending.target,
            mutation: pending.mutation,
            clientId: sharedMutationClientId,
          })
          sharedMutationQueues.get(key)?.shift()
          let latest = state
          if (!sharedMutationQueues.get(key)?.length && sharedStateTargetIsCurrent(pending.target)) {
            try { latest = await workspaceCommands.getClientState(pending.target) }
            catch { latest = deferredSharedClientStates.get(key)?.state || state }
            deferredSharedClientStates.delete(key)
          }
          renderSharedClientState(pending.target, latest)
          pending.resolve(state)
        } catch (reason) {
          sharedMutationQueues.get(key)?.shift()
          if (sharedStateTargetIsCurrent(pending.target)) {
            try {
              renderSharedClientState(pending.target, await workspaceCommands.getClientState(pending.target))
            } catch {
              // Preserve optimistic prompt text when authoritative reload also fails.
            }
          }
          pending.reject(reason)
        }
      }
    })().finally(() => {
      sharedMutationProcessing.delete(key)
      if (sharedMutationQueues.get(key)?.length) processSharedMutationQueue(key)
      else sharedMutationQueues.delete(key)
    })
  }

  const enqueueSharedMutation = (target: SharedClientStateTarget, mutation: ClientStateMutation) =>
    new Promise<SessionClientState>((resolve, reject) => {
      const key = sharedMutationKey(target)
      const queue = sharedMutationQueues.get(key) || []
      queue.push({ target, mutation, resolve, reject })
      sharedMutationQueues.set(key, queue)
      processSharedMutationQueue(key)
    })

  const flushPendingSharedDraft = (): Promise<void> => {
    if (sharedDraftCommit) {
      return sharedDraftCommit.then(() => pendingSharedDraft ? flushPendingSharedDraft() : undefined)
    }
    if (sharedDraftTimer !== undefined) window.clearTimeout(sharedDraftTimer)
    sharedDraftTimer = undefined
    const pending = pendingSharedDraft
    if (!pending) return Promise.resolve()
    const commit = enqueueSharedMutation(pending.target, { kind: 'setDraft', draft: pending.draft })
      .then(() => undefined)
      .finally(() => {
        if (pendingSharedDraft?.revision === pending.revision) pendingSharedDraft = undefined
        sharedDraftCommit = undefined
      })
    sharedDraftCommit = commit
    return commit.then(() => pendingSharedDraft ? flushPendingSharedDraft() : undefined)
  }

  const cancelPendingSharedDraft = () => {
    if (sharedDraftTimer !== undefined) window.clearTimeout(sharedDraftTimer)
    sharedDraftTimer = undefined
    pendingSharedDraft = undefined
  }

  const useSharedClientState = (profileId: string, sessionId: string, state: SessionClientState, applyDraft = true) => {
    if (activeSession() !== sessionId) return
    const pending = pendingSharedDraft
    const next = overlayPendingDraft(state,
      pending?.target.profileId === profileId
        && pending.target.sessionId === sessionId
        && sharedStateTargetIsCurrent(pending.target) ? pending.draft : undefined)
    setWorkspaceProfileId(profileId)
    setWorkspaceSessionId(sessionId)
    setSharedClientState(next)
    if (applyDraft && !busy() && captures().length === 0 && prompt() !== next.draft) {
      markComposerChanged()
      setPrompt(next.draft)
    }
  }

  const loadSharedClientState = async (profileId: string, sessionId: string, applyDraft = true) => {
    const target = sharedStateTarget(profileId, sessionId)
    if (!target) throw new Error(workspaceCopy.workspaceTurnReconnecting)
    const state = await workspaceCommands.getClientState(target)
    renderSharedClientState(target, state, applyDraft)
    return state
  }

  const discoverWorkspaceSession = async (sessionId: string, applyDraft = true) => {
    if (sessionId === NEW_SESSION) return
    const generation = promptGeneration
    const instanceId = activeInstanceId()
    try {
      const scope = await workspaceCommands.configureInstance(currentHermesInstance())
      const snapshot = await workspaceCommands.bootstrap(scope)
      if (generation !== promptGeneration || instanceId !== activeInstanceId() || activeSession() !== sessionId) return
      const listedSession = snapshot.sessions.find(item => item.id === sessionId)
      const profileId = listedSession?.profileId || (await workspaceCommands.resolveSessionProfile({ ...scope, sessionId })).profileId
      const session = listedSession || await workspaceCommands.sessionSummary({ ...scope, profileId, sessionId })
      if (generation !== promptGeneration || instanceId !== activeInstanceId() || activeSession() !== sessionId) return
      setWorkspaceInstanceId(snapshot.instance.id)
      setWorkspaceInstanceGeneration(snapshot.instanceGeneration)
      setWorkspaceBusy(Boolean(session && ['running', 'stopping', 'stalled'].includes(session.turnState)))
      await loadSharedClientState(profileId, sessionId, applyDraft)
    } catch {
      // Compact prompt remains usable when optional workspace discovery fails.
    }
  }

  const mutateSharedClientState = async (profileId: string, sessionId: string, mutation: ClientStateMutation) => {
    const target = sharedStateTarget(profileId, sessionId)
    if (!target) throw new Error(workspaceCopy.workspaceTurnReconnecting)
    if (mutation.kind === 'setDraft'
      || mutation.kind === 'appendDraft'
      || mutation.kind === 'restoreDraft'
      || mutation.kind === 'consumeComposer'
      || mutation.kind === 'restoreComposer') await flushPendingSharedDraft()
    if (!sharedStateTargetIsCurrent(target)) throw new Error('Client state belongs to a stale Hermes instance generation')
    useSharedClientState(profileId, sessionId, applyClientStateMutation(sharedClientState(), mutation), false)
    return enqueueSharedMutation(target, mutation)
  }

  const setCompactDraft = (value: string) => {
    markComposerChanged()
    setPrompt(value)
    const profileId = workspaceProfileId()
    const sessionId = activeSession()
    if (!profileId || sessionId === NEW_SESSION || (busy() && !canQueueDuringLocalTurn())) return
    const state = { ...sharedClientState(), draft: value }
    setSharedClientState(state)
    if (sharedDraftTimer !== undefined) window.clearTimeout(sharedDraftTimer)
    const target = sharedStateTarget(profileId, sessionId)
    if (!target) return
    const revision = ++sharedDraftRevision
    pendingSharedDraft = { draft: value, revision, target }
    sharedDraftTimer = window.setTimeout(() => {
      void flushPendingSharedDraft().catch(() => undefined)
    }, 180)
  }

  const selectSavedInstance = (id: string) => {
    const instance = activeSavedInstance(savedInstances(), id)
    setActiveInstanceId(instance.id)
    setInstanceName(instance.name)
    setRemoteHermes(instance.mode === 'existing')
    setHermesAddress(instance.address || '127.0.0.1')
    setHermesPort(String(instance.port || 9119))
    setHermesToken(instance.token || '')
  }

  const addSavedInstance = () => {
    const id = crypto.randomUUID()
    const instance: SavedHermesInstance = {
      id,
      name: workspaceCopy.newHermesInstance,
      mode: 'existing',
      address: '127.0.0.1',
      port: 9119,
      token: '',
    }
    setSavedInstances(items => [...items, instance])
    selectSavedInstance(id)
  }

  const removeSavedInstance = () => {
    if (activeInstanceId() === AUTOMATIC_INSTANCE_ID) return
    setSavedInstances(items => items.filter(instance => instance.id !== activeInstanceId()))
    selectSavedInstance(AUTOMATIC_INSTANCE_ID)
  }

  const loadSessions = async () => {
    const request = ++sessionLoadRequest
    const generation = promptGeneration
    const expectedInstanceId = appliedHermesInstance.instanceId
    try {
      const scope = await promptInstanceScope(expectedInstanceId)
      const list = await invoke<Session[]>('list_sessions', scope)
      if (request !== sessionLoadRequest
        || generation !== promptGeneration
        || appliedHermesInstance.instanceId !== expectedInstanceId) return
      let changed = false
      setSessions(current => {
        if (sessionsEqual(current, list)) return current
        changed = true
        return list
      })
      if (changed) {
        window.requestAnimationFrame(() => {
          const preference = document.querySelector<HTMLSelectElement>('[data-session-preference]')
          if (preference) preference.value = sessionPreference()
          const bindings = new Map(sessionShortcuts().map(binding => [binding.id, binding.sessionId]))
          document.querySelectorAll<HTMLSelectElement>('[data-session-shortcut]').forEach(select => {
            const value = bindings.get(select.dataset.sessionShortcut || '')
            if (value) select.value = value
          })
        })
      }
      const normalized = normalizeSelection(sessionPreference(), list)
      if (normalized !== sessionPreference()) {
        setSessionPreference(normalized)
        setActiveSession(normalized)
        setRuntimeSession(undefined)
        localStorage.setItem(SESSION_PREFERENCE_KEY, normalized)
      }
      const selected = activeSession()
      if (selected !== NEW_SESSION && workspaceSessionId() !== selected) void discoverWorkspaceSession(selected)
    } catch (reason) {
      if (request === sessionLoadRequest
        && generation === promptGeneration
        && appliedHermesInstance.instanceId === expectedInstanceId) setError(String(reason))
    }
  }

  const scrollToLatest = () => {
    const scroll = () => conversationRef?.scrollTo({ top: conversationRef.scrollHeight })
    window.requestAnimationFrame(() => window.requestAnimationFrame(scroll))
    window.setTimeout(scroll, 120)
  }

  const clearVoiceTimers = () => {
    if (voiceInterval !== undefined) window.clearInterval(voiceInterval)
    if (voiceTimeout !== undefined) window.clearTimeout(voiceTimeout)
    voiceInterval = undefined
    voiceTimeout = undefined
  }

  const releaseVoiceResources = () => {
    if (voiceMeterFrame !== undefined) window.cancelAnimationFrame(voiceMeterFrame)
    voiceMeterFrame = undefined
    voiceMeterSource?.disconnect()
    voiceMeterSource = undefined
    void voiceAudioContext?.close()
    voiceAudioContext = undefined
    clearVoiceTimers()
  }

  const startHermesSilenceMeter = (stream: MediaStream, generation: number) => {
    let context: AudioContext | undefined
    let source: MediaStreamAudioSourceNode | undefined
    try {
      context = new AudioContext()
      const analyser = context.createAnalyser()
      source = context.createMediaStreamSource(stream)
      analyser.fftSize = 256
      const samples = new Uint8Array(analyser.fftSize)
      const detector = new HermesSilenceDetector(voiceStartedAt)
      source.connect(analyser)
      voiceAudioContext = context
      voiceMeterSource = source
      void context.resume()
      const tick = () => {
        if (generation !== voiceGeneration || activeVoiceProvider !== 'hermes' || voiceStatus() !== 'recording') return
        analyser.getByteTimeDomainData(samples)
        const result = detector.update(normalizedVoiceLevel(samples), Date.now())
        if (result === 'speech-ended') {
          void stopVoiceInput()
          return
        }
        if (result === 'idle-timeout') {
          cancelVoiceInput()
          return
        }
        voiceMeterFrame = window.requestAnimationFrame(tick)
      }
      tick()
    } catch {
      source?.disconnect()
      void context?.close()
      voiceMeterSource = undefined
      voiceAudioContext = undefined
    }
  }

  const cancelVoiceInput = () => {
    voiceGeneration += 1
    voiceStartGate.cancel()
    hermesRecording?.cancel()
    hermesRecording = undefined
    releaseVoiceResources()
    speachesSession?.cancel()
    speachesSession = undefined
    activeVoiceProvider = undefined
    voiceInstanceScope = undefined
    setVoiceElapsed(0)
    setVoiceStatus('idle')
  }

  const applyVoiceTranscript = (transcript: string) => {
    const text = transcript.trim()
    if (!text) throw new Error('No speech was detected')
    setCompactDraft(prompt().trim() ? `${prompt().trimEnd()} ${text}` : text)
    setError('')
  }

  const stopVoiceInput = async () => {
    if (voiceStatus() !== 'recording') return
    if (activeVoiceProvider === 'speaches' && speachesSession) {
      setVoiceStatus('transcribing')
      clearVoiceTimers()
      speachesSession.stop()
      return
    }
    if (!hermesRecording) return
    const generation = voiceGeneration
    const recording = hermesRecording
    const instanceScope = voiceInstanceScope
    setVoiceStatus('transcribing')
    clearVoiceTimers()
    releaseVoiceResources()
    const blob = await recording.stop()
    if (generation !== voiceGeneration) return
    if (hermesRecording === recording) hermesRecording = undefined
    if (!blob || blob.size === 0) {
      setError('No audio was recorded')
      setVoiceStatus('idle')
      return
    }
    try {
      if (!instanceScope) throw new Error(workspaceCopy.workspaceTurnReconnecting)
      const dataUrl = await blobToDataUrl(blob)
      const result = await invoke<VoiceTranscription>('transcribe_voice_audio', {
        ...instanceScope,
        dataUrl,
        mimeType: blob.type || 'audio/webm',
      })
      if (generation !== voiceGeneration) return
      applyVoiceTranscript(result.transcript)
    } catch (reason) {
      if (generation === voiceGeneration) setError(`Voice input: ${String(reason)}`)
    } finally {
      if (generation === voiceGeneration) {
        activeVoiceProvider = undefined
        voiceInstanceScope = undefined
        setVoiceStatus('idle')
        setVoiceElapsed(0)
        window.setTimeout(() => inputRef?.focus(), 20)
      }
    }
  }

  const startSpeachesVoiceInput = async (generation: number) => {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
      throw new Error('Voice recording is not supported on this system')
    }
    const status = invoke<SpeachesStatus>('ensure_speaches').then(result => {
      setSpeachesStatus(result)
      return result
    })
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    })
    if (generation !== voiceGeneration) {
      stream.getTracks().forEach(track => track.stop())
      return
    }
    streamingTranscript = ''
    const session = new SpeachesRealtimeSession({
      onSpeechStopped: () => {
        if (generation !== voiceGeneration) return
        setVoiceStatus('transcribing')
        clearVoiceTimers()
      },
      onTranscriptDelta: delta => {
        if (generation !== voiceGeneration) return
        streamingTranscript += delta
        setPrompt(streamingTranscript)
      },
      onComplete: transcript => {
        if (generation !== voiceGeneration) return
        try {
          setPrompt('')
          applyVoiceTranscript(transcript)
        } catch (reason) {
          setError(`Voice input: ${String(reason)}`)
        }
        speachesSession = undefined
        activeVoiceProvider = undefined
        setVoiceStatus('idle')
        setVoiceElapsed(0)
        clearVoiceTimers()
        window.setTimeout(() => inputRef?.focus(), 20)
      },
      onError: message => {
        if (generation !== voiceGeneration) return
        speachesSession = undefined
        activeVoiceProvider = undefined
        setVoiceStatus('idle')
        setVoiceElapsed(0)
        clearVoiceTimers()
        setError(`Voice input: ${message}`)
      },
    })
    speachesSession = session
    activeVoiceProvider = 'speaches'
    voiceInstanceScope = undefined
    voiceStartedAt = Date.now()
    setVoiceElapsed(0)
    setVoiceStatus('recording')
    voiceInterval = window.setInterval(() => setVoiceElapsed((Date.now() - voiceStartedAt) / 1000), 250)
    voiceTimeout = window.setTimeout(() => void stopVoiceInput(), 120_000)
    await session.start(
      status.then(result => speachesRealtimeUrl(result.websocketUrl, speachesForceEnglish())),
      stream,
    )
    if (generation !== voiceGeneration) session.cancel()
  }

  const startHermesVoiceInput = async (generation: number) => {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Voice recording is not supported on this system')
      }
      const instanceScope = await promptInstanceScope()
      if (generation !== voiceGeneration) return
      voiceInstanceScope = instanceScope
      const config = invoke<VoiceConfig>('get_voice_input_config', instanceScope).then(
        value => ({ value }),
        reason => ({ reason }),
      )
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      if (generation !== voiceGeneration) {
        stream.getTracks().forEach(track => track.stop())
        return
      }
      const mimeType = preferredAudioMimeType(type => MediaRecorder.isTypeSupported(type))
      let recorder: MediaRecorder
      try {
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      } catch (reason) {
        stream.getTracks().forEach(track => track.stop())
        throw reason
      }
      activeVoiceProvider = 'hermes'
      const recording = new HermesRecording(recorder, stream, mimeType, () => {
        releaseVoiceResources()
        if (hermesRecording === recording) hermesRecording = undefined
        if (generation === voiceGeneration) {
          activeVoiceProvider = undefined
          voiceInstanceScope = undefined
          setError('Voice input: recording failed')
          setVoiceStatus('idle')
        }
      })
      hermesRecording = recording
      recording.start()
      voiceStartedAt = Date.now()
      setVoiceElapsed(0)
      setVoiceStatus('recording')
      voiceInterval = window.setInterval(() => setVoiceElapsed((Date.now() - voiceStartedAt) / 1000), 250)
      startHermesSilenceMeter(stream, generation)
      const configResult = await config
      if (generation !== voiceGeneration || voiceStatus() !== 'recording') return
      if ('reason' in configResult) throw configResult.reason
      const resolvedConfig = configResult.value
      if (!resolvedConfig.sttEnabled) throw new Error('Speech-to-text is disabled in Hermes')
      const maxSeconds = Math.min(600, Math.max(1, resolvedConfig.maxRecordingSeconds || 120))
      voiceTimeout = window.setTimeout(() => void stopVoiceInput(), maxSeconds * 1000)
  }

  const startVoiceInput = async () => {
    if (voiceStatus() !== 'idle' || prompt().trim() || (busy() && !canQueueDuringLocalTurn()) || capturing()) return
    const generation = voiceGeneration + 1
    if (!voiceStartGate.tryStart(generation)) return
    voiceGeneration = generation
    setError('')
    try {
      if (voiceProvider() === 'speaches') await startSpeachesVoiceInput(generation)
      else await startHermesVoiceInput(generation)
    } catch (reason) {
      if (generation === voiceGeneration) {
        speachesSession?.cancel()
        speachesSession = undefined
        activeVoiceProvider = undefined
        voiceInstanceScope = undefined
        hermesRecording?.cancel()
        hermesRecording = undefined
        releaseVoiceResources()
        setVoiceStatus('idle')
        setError(`Voice input: ${microphoneErrorMessage(reason)}`)
      }
    } finally {
      voiceStartGate.finish(generation)
    }
  }

  const toggleVoiceInput = () => {
    if (voiceStatus() === 'recording') void stopVoiceInput()
    else if (voiceStatus() === 'idle') void startVoiceInput()
  }

  const clearPrompt = () => {
    // Hiding the compact window clears only its presentation. Per-session draft
    // state belongs to the shared workspace scope and must survive close/reopen.
    void flushPendingSharedDraft().catch(() => undefined)
    retirePendingWorkspaceHandoff()
    cancelVoiceInput()
    const transcript = history()
    if (shouldRememberPreviousChat(transcript.length, openedFromSessionShortcut)) {
      setPreviousChat({ history: transcript, activeSession: activeSession(), runtimeSession: runtimeSession() })
      void invoke('set_previous_chat_available', { available: true })
    }
    openedFromSessionShortcut = false
    promptGeneration += 1
    markComposerChanged()
    setPrompt('')
    setCaptures([])
    setPreview(undefined)
    setHistory([])
    setBusy(false)
    setWorkspaceBusy(false)
    setWorkspaceProfileId(undefined)
    setWorkspaceSessionId(undefined)
    setSharedClientState(emptySharedClientState())
    workspaceAssistantExchanges.clear()
    setTurnActivities({})
    setCapturing(false)
    setSettingsOpen(false)
    setActiveSession(sessionPreference())
    setRuntimeSession(undefined)
    setPagedMessages([])
    setPagedSession(undefined)
    setHasOlderMessages(false)
    setLoadingSessionHistory(false)
    setError('')
  }

  const refreshCompactHistory = (sessionId: string) => {
    const generation = promptGeneration
    const expectedInstanceId = appliedHermesInstance.instanceId
    void promptInstanceScope(expectedInstanceId)
      .then(scope => invoke<HistoryPage>('get_session_history_page', { ...scope, sessionId, beforeId: null, limit: 40 }))
      .then(page => {
        if (generation !== promptGeneration
          || appliedHermesInstance.instanceId !== expectedInstanceId
          || activeSession() !== sessionId
          || busy()) return
        setPagedMessages(page.messages)
        setPagedSession(sessionId)
        setHasOlderMessages(page.has_older)
        setHistory(transcriptFromMessages(page.messages))
        scrollToLatest()
      })
      .catch(() => undefined)
  }

  const handleWorkspaceEvent = (event: WorkspaceEvent) => {
    if (event.type === 'instance-invalidated') {
      promptGeneration += 1
      retirePendingWorkspaceHandoff()
      cancelVoiceInput()
      cancelPendingSharedDraft()
      setWorkspaceBusy(false)
      setWorkspaceProfileId(undefined)
      setWorkspaceSessionId(undefined)
      setWorkspaceInstanceId(undefined)
      setWorkspaceInstanceGeneration(undefined)
      setSharedClientState(emptySharedClientState())
      workspaceAssistantExchanges.clear()
      return
    }
    const selected = activeSession()
    if (selected === NEW_SESSION) return
    if ('sessionId' in event && event.sessionId !== selected) return
    if ('profileId' in event && typeof event.profileId === 'string') setWorkspaceProfileId(event.profileId)
    if (event.type === 'client-state') {
      if (workspaceInstanceId() !== event.instanceId
        || workspaceInstanceGeneration() !== event.instanceGeneration) return
      if (event.clientId === sharedMutationClientId) return
      const target = {
        instanceId: event.instanceId,
        instanceGeneration: event.instanceGeneration,
        profileId: event.profileId,
        sessionId: event.sessionId,
      }
      const key = sharedMutationKey(target)
      if (sharedMutationQueues.get(key)?.length) deferredSharedClientStates.set(key, { target, state: event.state })
      else renderSharedClientState(target, event.state, true)
      return
    }
    if (busy()) {
      // Local compact turns own transcript rendering, but shared turn state is
      // still authoritative. A queued turn may start before local cleanup.
      if (event.type === 'turn-state') {
        setWorkspaceBusy(event.state === 'running' || event.state === 'stopping' || event.state === 'stalled')
      }
      return
    }
    if (event.type === 'turn-state') {
      const active = event.state === 'running' || event.state === 'stopping' || event.state === 'stalled'
      setWorkspaceBusy(active)
      if (active) void loadSharedClientState(event.profileId, event.sessionId, false).catch(() => undefined)
      if (active) {
        setHistory(items => items.length && items[items.length - 1].status !== 'pending'
          ? items.map((item, index) => index === items.length - 1 ? { ...item, status: 'pending' as const } : item)
          : items)
      } else {
        setHistory(items => items.map(item => item.status === 'pending'
          ? { ...item, status: event.state === 'error' ? 'error' as const : 'complete' as const, answer: item.answer || event.error || '' }
          : item))
        window.setTimeout(() => refreshCompactHistory(selected), 80)
      }
      scrollToLatest()
      return
    }
    if (event.type === 'message-upsert') {
      const message = event.message
      if (message.role === 'user') {
        const exchangeId = `workspace-${message.id}`
        setHistory(items => items.some(item => item.id === exchangeId)
          ? items
          : beginExchange(items, { id: exchangeId, prompt: message.content, images: [] }))
      } else if (message.role === 'assistant') {
        let exchangeId = workspaceAssistantExchanges.get(message.id)
        setHistory(items => {
          exchangeId ||= items.at(-1)?.id
          if (!exchangeId) return items
          workspaceAssistantExchanges.set(message.id, exchangeId)
          return items.map(item => item.id === exchangeId
            ? { ...item, answer: message.content, status: message.status === 'error' ? 'error' as const : message.status === 'complete' ? 'complete' as const : 'pending' as const }
            : item)
        })
      }
      scrollToLatest()
      return
    }
    if (event.type === 'message-delta') {
      const exchangeId = workspaceAssistantExchanges.get(event.messageId) || history().at(-1)?.id
      if (exchangeId) {
        workspaceAssistantExchanges.set(event.messageId, exchangeId)
        setHistory(items => appendAnswerDelta(items, exchangeId, event.delta))
        scrollToLatest()
      }
    }
  }

  onMount(() => {
    void ensurePromptConfiguration()
      .then(() => loadSessions())
      .catch(reason => setError(String(reason)))
    const unlistenInstanceSelected = listen<{ instanceId: string }>('hermes-instance-selected', event => {
      const instances = parseSavedInstances(localStorage.getItem(INSTANCES_KEY))
      const instance = activeSavedInstance(instances, event.payload.instanceId)
      setSavedInstances(instances)
      setActiveInstanceId(instance.id)
      setInstanceName(instance.name)
      setRemoteHermes(instance.mode === 'existing')
      setHermesAddress(instance.address || '127.0.0.1')
      setHermesPort(String(instance.port || 9119))
      setHermesToken(instance.token || '')
      appliedHermesInstance = buildHermesInstanceConfig(
        instance.mode === 'existing',
        instance.address,
        String(instance.port),
        instance.token,
        instance.id,
        instance.name,
      )
      promptConfigurationReady = true
      void resetPromptForInstanceSwitch().catch(reason => setError(String(reason)))
    })
    const unlistenWorkspaceEvents = listen<WorkspaceEvent>('workspace-event', event => handleWorkspaceEvent(event.payload))
    const unlistenWorkspaceHandoff = listen<WorkspaceHandoffResult>('workspace-handoff-result', event => {
      const pending = pendingWorkspaceHandoff
      if (!pending || !handoffResultMatchesPending(pending, event.payload)) return
      if (event.payload.status === 'failure') {
        void failPendingWorkspaceHandoff(pending, event.payload.error || workspaceCopy.handoffSessionOpenFailed)
        return
      }
      const clearSource = handoffSourceRevisionIsCurrent(pending, promptGeneration, composerRevision)
        && prompt() === pending.prompt
        && captures() === pending.captures
      retirePendingWorkspaceHandoff()
      if (clearSource) {
        markComposerChanged()
        setPrompt('')
        setCaptures([])
      }
      setError('')
      void getCurrentWindow().hide()
    })
    const unlistenWorkspaceTargetReady = listen('workspace-target-listener-ready', () => {
      const pending = pendingWorkspaceHandoff
      if (!pending) return
      void dispatchWorkspaceHandoff(pending).catch(reason => failPendingWorkspaceHandoff(pending, reason))
    })
    void invoke<boolean>('hermes_desktop_available').then(available => {
      setDesktopAvailable(available)
      const mode = !available && trayLinkMode() !== 'workspace' ? 'workspace' : trayLinkMode()
      if (mode !== trayLinkMode()) setTrayLinkMode(mode)
      void invoke('set_tray_link_mode', { mode }).catch(reason => setError(String(reason)))
    }).catch(() => {
      setDesktopAvailable(false)
      setTrayLinkMode('workspace')
      void invoke('set_tray_link_mode', { mode: 'workspace' }).catch(() => undefined)
    })
    void invoke('set_shortcuts', {
      promptShortcut: promptShortcut(),
      shortcuts: sessionShortcuts(),
    }).catch(reason => setError(String(reason)))
    const unlisten = getCurrentWindow().onFocusChanged(({ payload }) => {
      if (payload) window.setTimeout(() => inputRef?.focus(), 30)
    })
    const unlistenOpen = listen('open-prompt', () => {
      openedFromSessionShortcut = false
      void loadSessions()
      window.setTimeout(() => inputRef?.focus(), 20)
      if (voiceAutoStart()) window.setTimeout(() => void startVoiceInput(), 40)
    })
    const unlistenPrevious = listen('open-previous-chat', () => {
      const previous = previousChat()
      if (!previous) return
      openedFromSessionShortcut = false
      promptGeneration += 1
      retirePendingWorkspaceHandoff()
      markComposerChanged()
      setPrompt('')
      setCaptures([])
      setPreview(undefined)
      setSettingsOpen(false)
      setError('')
      setBusy(false)
      setWorkspaceBusy(false)
      setWorkspaceProfileId(undefined)
      setWorkspaceSessionId(undefined)
      setSharedClientState(emptySharedClientState())
      workspaceAssistantExchanges.clear()
      setCapturing(false)
      setHistory(previous.history)
      setActiveSession(previous.activeSession)
      setRuntimeSession(previous.runtimeSession)
      setPagedMessages([])
      setPagedSession(undefined)
      setHasOlderMessages(false)
      setLoadingSessionHistory(false)
      void discoverWorkspaceSession(previous.activeSession)
      scrollToLatest()
      window.setTimeout(() => inputRef?.focus(), 20)
    })
    const unlistenSessionShortcut = listen<string>('open-session-shortcut', event => {
      const sessionId = event.payload
      const transcript = history()
      if (shouldRememberPreviousChat(transcript.length, openedFromSessionShortcut)) {
        setPreviousChat({ history: transcript, activeSession: activeSession(), runtimeSession: runtimeSession() })
        void invoke('set_previous_chat_available', { available: true })
      }
      openedFromSessionShortcut = true
      promptGeneration += 1
      retirePendingWorkspaceHandoff()
      markComposerChanged()
      const generation = promptGeneration
      setPrompt('')
      setCaptures([])
      setPreview(undefined)
      setSettingsOpen(false)
      setError('')
      setBusy(false)
      setWorkspaceBusy(false)
      setWorkspaceProfileId(undefined)
      setWorkspaceSessionId(undefined)
      setSharedClientState(emptySharedClientState())
      workspaceAssistantExchanges.clear()
      setCapturing(false)
      setHistory([])
      setLoadingSessionHistory(true)
      setActiveSession(sessionId)
      setRuntimeSession(undefined)
      setPagedMessages([])
      setPagedSession(sessionId)
      setHasOlderMessages(false)
      void discoverWorkspaceSession(sessionId)
      const expectedInstanceId = appliedHermesInstance.instanceId
      void promptInstanceScope(expectedInstanceId)
        .then(scope => invoke<HistoryPage>('get_session_history_page', { ...scope, sessionId, beforeId: null, limit: 40 }))
        .then(page => {
          if (generation !== promptGeneration || appliedHermesInstance.instanceId !== expectedInstanceId) return
          setPagedMessages(page.messages)
          setPagedSession(sessionId)
          setHasOlderMessages(page.has_older)
          setHistory(transcriptFromMessages(page.messages))
          setLoadingSessionHistory(false)
          scrollToLatest()
          window.setTimeout(() => inputRef?.focus(), 20)
        })
        .catch(reason => {
          if (generation !== promptGeneration || appliedHermesInstance.instanceId !== expectedInstanceId) return
          setLoadingSessionHistory(false)
          setError(String(reason))
        })
    })
    const unlistenClear = listen('clear-prompt', clearPrompt)
    const unlistenCapture = listen<Capture>('capture-complete', event => {
      markComposerChanged()
      setCaptures(items => appendCapture(items, event.payload))
      setCapturing(false)
      window.setTimeout(() => inputRef?.focus(), 30)
    })
    const unlistenCaptureReady = listen('selection-ready', () => setCapturing(false))
    const unlistenSettings = listen('open-settings', () => {
      setSettingsTab('general')
      setSettingsError('')
      setSettingsOpen(true)
      void loadSessions()
      void isAutostartEnabled().then(setStartAtLogin).catch(reason => setError(String(reason)))
      void invoke<SpeachesStatus>('get_speaches_status').then(setSpeachesStatus).catch(() => setSpeachesStatus(undefined))
    })
    onCleanup(() => void unlisten.then(dispose => dispose()))
    onCleanup(() => void unlistenInstanceSelected.then(dispose => dispose()))
    onCleanup(() => void unlistenWorkspaceEvents.then(dispose => dispose()))
    onCleanup(() => void unlistenWorkspaceHandoff.then(dispose => dispose()))
    onCleanup(() => void unlistenWorkspaceTargetReady.then(dispose => dispose()))
    onCleanup(() => void unlistenOpen.then(dispose => dispose()))
    onCleanup(() => void unlistenPrevious.then(dispose => dispose()))
    onCleanup(() => void unlistenSessionShortcut.then(dispose => dispose()))
    onCleanup(() => void unlistenClear.then(dispose => dispose()))
    onCleanup(() => void unlistenCapture.then(dispose => dispose()))
    onCleanup(() => void unlistenCaptureReady.then(dispose => dispose()))
    onCleanup(() => void unlistenSettings.then(dispose => dispose()))
    onCleanup(() => { void flushPendingSharedDraft().catch(() => undefined) })
    onCleanup(cancelVoiceInput)
  })

  createEffect(() => {
    if (!settingsOpen()) return
    const timer = window.setInterval(() => void loadSessions(), 2000)
    onCleanup(() => window.clearInterval(timer))
  })

  createEffect(() => {
    void invoke('set_prompt_expanded', {
      expanded: history().length > 0 || loadingSessionHistory() || Boolean(preview()) || settingsOpen(),
      settings: settingsOpen(),
    })
  })

  createEffect(() => {
    void invoke('set_workspace_has_active_work', { source: 'prompt', active: busy() }).catch(() => undefined)
  })

  let observedSharedSession = activeSession()
  createEffect(() => {
    const selected = activeSession()
    if (selected === observedSharedSession) return
    observedSharedSession = selected
    void flushPendingSharedDraft().catch(() => undefined)
    setWorkspaceBusy(false)
    setWorkspaceProfileId(undefined)
    setWorkspaceSessionId(undefined)
    setWorkspaceInstanceId(undefined)
    setWorkspaceInstanceGeneration(undefined)
    setSharedClientState(emptySharedClientState())
    if (selected !== NEW_SESSION) void discoverWorkspaceSession(selected)
  })

  const uploadCompactCaptures = async (
    target: SharedClientStateTarget,
    profileId: string,
    sessionId: string,
    images: Capture[],
  ) => {
    const uploaded: AttachmentRef[] = []
    for (const [index, capture] of images.entries()) {
      if (!sharedStateTargetIsCurrent(target)) throw new Error('Client state belongs to a stale Hermes instance generation')
      const mimeType = /^data:([^;,]+)/.exec(capture.data_url)?.[1] || 'image/png'
      const encoded = capture.data_url.split(',', 2)[1] || ''
      uploaded.push(await workspaceCommands.uploadAttachment({
        instanceId: target.instanceId,
        instanceGeneration: target.instanceGeneration,
        profileId,
        sessionId,
        name: `ask-hermes-${index + 1}.${mimeType.split('/')[1] || 'png'}`,
        mimeType,
        dataUrl: capture.data_url,
      }))
      if (!sharedStateTargetIsCurrent(target)) throw new Error('Client state belongs to a stale Hermes instance generation')
      if (!uploaded[uploaded.length - 1].size) uploaded[uploaded.length - 1].size = Math.floor(encoded.length * 0.75)
    }
    return uploaded
  }

  const submitThroughWorkspace = async (
    profileId: string,
    sessionId: string,
    question: string,
    images: Capture[],
    queue: boolean,
  ) => {
    const target = sharedStateTarget(profileId, sessionId)
    if (!target) throw new Error(workspaceCopy.workspaceTurnReconnecting)
    const current = target
      ? await workspaceCommands.getClientState(target).catch(() => sharedClientState())
      : sharedClientState()
    if (!sharedStateTargetIsCurrent(target)) throw new Error('Client state belongs to a stale Hermes instance generation')
    const uploaded = await uploadCompactCaptures(target, profileId, sessionId, images)
    if (!sharedStateTargetIsCurrent(target)) throw new Error('Client state belongs to a stale Hermes instance generation')
    const entry: QueueEntry = {
      id: `prompt-${crypto.randomUUID()}`,
      text: question,
      createdAt: new Date().toISOString(),
      attachments: [...current.attachments, ...uploaded],
    }
    const consumed = await mutateSharedClientState(profileId, sessionId, { kind: 'consumeComposer', entry })
    if (queue) return
    const consumedEntry = consumed.queue.find(currentEntry => currentEntry.id === entry.id) || entry
    try {
      await workspaceCommands.sendTurn({ ...target, profileId, sessionId, entry: consumedEntry })
    } catch (reason) {
      if (sharedStateTargetIsCurrent(target)) {
        await mutateSharedClientState(profileId, sessionId, {
          kind: 'restoreComposer',
          draft: current.draft || question,
          attachments: consumedEntry.attachments,
          entryId: entry.id,
        }).catch(() => undefined)
      }
      throw reason
    }
    if (!sharedStateTargetIsCurrent(target)) return
    await mutateSharedClientState(profileId, sessionId, { kind: 'removeQueue', entryId: entry.id }).catch(() => undefined)
  }

  const submit = async () => {
    if (submitStarting() || (busy() && !canQueueDuringLocalTurn()) || capturing() || (!prompt().trim() && captures().length === 0)) return
    const sourcePrompt = prompt()
    const question = sourcePrompt.trim() || 'What can you tell me about these screenshots?'
    const images = captures()
    const generation = promptGeneration
    const exchangeId = `exchange-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const selectedSession = activeSession()
    const profileId = workspaceProfileId()
    if (workspaceBusy() && (!profileId || selectedSession === NEW_SESSION)) {
      setError(workspaceCopy.workspaceTurnReconnecting)
      return
    }
    if (profileId && selectedSession !== NEW_SESSION) {
      setPrompt('')
      setCaptures([])
      setError('')
      try {
        await submitThroughWorkspace(profileId, selectedSession, question, images, workspaceBusy() || busy())
      } catch (reason) {
        setPrompt(question)
        setCaptures(images)
        setError(String(reason))
      }
      return
    }
    setSubmitStarting(true)
    const expectedInstanceId = appliedHermesInstance.instanceId
    let reserved = false
    let turnUiStarted = false
    try {
      await ensurePromptConfiguration()
      if (generation !== promptGeneration || appliedHermesInstance.instanceId !== expectedInstanceId) return
      await invoke('set_workspace_has_active_work', { source: 'prompt-submit', active: true })
      reserved = true
      const instanceScope = await promptInstanceScope(expectedInstanceId)
      if (generation !== promptGeneration || appliedHermesInstance.instanceId !== expectedInstanceId) return
      if (prompt() !== sourcePrompt || captures() !== images) {
        throw new Error(workspaceCopy.composerChangedWhilePreparing)
      }
      setHistory(items => beginExchange(items, { id: exchangeId, prompt: question, images }))
      setTurnActivities(items => ({ ...items, [exchangeId]: formatTurnActivity('thinking') }))
      setPrompt('')
      setCaptures([])
      setBusy(true)
      // Preparation is complete once the turn owns the compact prompt. From
      // here, the normal busy/session checks decide whether another prompt can
      // be queued for the discovered workspace session.
      setSubmitStarting(false)
      setError('')
      turnUiStarted = true
      const result = await runHermesTurn({
        ...instanceScope,
        exchangeId,
        prompt: question,
        images: images.map(image => image.data_url),
        storedSessionId: selectedSession === NEW_SESSION ? undefined : selectedSession,
        runtimeSessionId: runtimeSession(),
        model: selectedSession === NEW_SESSION ? model() || undefined : undefined,
        reasoningEffort: selectedSession === NEW_SESSION ? effort() || undefined : undefined,
        fast: selectedSession === NEW_SESSION && supportsFastMode(model()) ? fastMode() : undefined,
        onSession: (runtimeId, storedId) => {
          if (generation !== promptGeneration) return
          setRuntimeSession(runtimeId)
          setActiveSession(storedId)
        },
        onDelta: text => {
          if (generation !== promptGeneration) return
          setTurnActivities(items => ({ ...items, [exchangeId]: formatTurnActivity('writing') }))
          setHistory(items => appendAnswerDelta(items, exchangeId, text))
        },
        onActivity: (kind, toolName, context) => {
          if (generation !== promptGeneration) return
          setTurnActivities(items => ({ ...items, [exchangeId]: formatTurnActivity(kind, toolName, context) }))
        },
      })
      if (generation !== promptGeneration) return
      setRuntimeSession(result.runtimeSessionId)
      setActiveSession(result.storedSessionId)
      setHistory(items => finishExchange(items, exchangeId, result.answer))
      window.setTimeout(() => void discoverWorkspaceSession(result.storedSessionId, false), 0)
      await loadSessions()
      for (const delay of [1200, 3500, 8000]) {
        window.setTimeout(() => void loadSessions(), delay)
      }
    } catch (reason) {
      if (generation !== promptGeneration) return
      const message = String(reason)
      if (turnUiStarted) {
        setHistory(items => items.map(item => item.id === exchangeId ? { ...item, answer: item.answer || message, status: 'error' } : item))
      } else {
        setError(message)
      }
    } finally {
      if (reserved) {
        await invoke('set_workspace_has_active_work', { source: 'prompt-submit', active: false }).catch(() => undefined)
      }
      setSubmitStarting(false)
      if (generation === promptGeneration && turnUiStarted) {
        setTurnActivities(items => {
          const next = { ...items }
          delete next[exchangeId]
          return next
        })
        setBusy(false)
        window.setTimeout(() => inputRef?.focus(), 20)
      }
    }
  }

  const onKeyDown: JSX.EventHandler<HTMLTextAreaElement, KeyboardEvent> = event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  const onPaste: JSX.EventHandler<HTMLTextAreaElement, ClipboardEvent> = event => {
    const files = clipboardImageFiles(event.clipboardData?.items)
    if (files.length === 0) return
    event.preventDefault()
    void Promise.all(files.map(imageFileToCapture))
      .then(images => {
        markComposerChanged()
        setCaptures(items => [...items, ...images])
      })
      .catch(reason => setError(String(reason)))
  }

  async function beginCapture() {
    if (capturing() || (busy() && !canQueueDuringLocalTurn()) || voiceStatus() !== 'idle') return
    setError('')
    setCapturing(true)
    try {
      await invoke('start_selection')
    } catch (reason) {
      setCapturing(false)
      setError(String(reason))
    }
  }

  const openDesktop = async () => {
    try {
      await invoke('open_hermes_desktop')
      await invoke('hide_window')
    } catch (reason) {
      setError(String(reason))
    }
  }

  const openWorkspace = async () => {
    if (workspaceHandoffInFlight()) return
    setWorkspaceHandoffInFlight(true)
    let pending: PendingWorkspaceHandoff | undefined
    try {
      const sourcePromptGeneration = promptGeneration
      const selected = activeSession()
      const profileId = workspaceProfileId()
      const sharedTarget = selected !== NEW_SESSION && profileId
        ? sharedStateTarget(profileId, selected)
        : undefined
      if (sharedTarget) {
        await flushPendingSharedDraft()
        if (!sharedStateTargetIsCurrent(sharedTarget)) {
          throw new Error(workspaceCopy.workspaceTurnReconnecting)
        }
      }
      const instance = sharedTarget || await promptInstanceScope(appliedHermesInstance.instanceId)
      if (sourcePromptGeneration !== promptGeneration || selected !== activeSession()) {
        throw new Error(workspaceCopy.workspaceTurnReconnecting)
      }
      const handoffPrompt = prompt()
      const sourceCaptures = captures()
      const reusableHandoff = failedWorkspaceHandoff
        && failedWorkspaceHandoff.promptGeneration === sourcePromptGeneration
        && failedWorkspaceHandoff.composerRevision === composerRevision
        && failedWorkspaceHandoff.instanceId === instance.instanceId
        && failedWorkspaceHandoff.instanceGeneration === instance.instanceGeneration
        && failedWorkspaceHandoff.target.profileId === profileId
        && failedWorkspaceHandoff.target.sessionId === (selected === NEW_SESSION ? undefined : selected)
        && handoffPayloadMatches(failedWorkspaceHandoff, handoffPrompt, sourceCaptures)
        ? failedWorkspaceHandoff
        : undefined
      const handoffId = handoffPrompt.trim() || sourceCaptures.length
        ? reusableHandoff?.id || crypto.randomUUID()
        : undefined
      if (!reusableHandoff) failedWorkspaceHandoff = undefined
      const handoffCaptures = sourceCaptures.map((capture, index) => {
        const mimeType = /^data:([^;,]+)/.exec(capture.data_url)?.[1] || 'image/png'
        const encoded = capture.data_url.split(',', 2)[1] || ''
        return {
          name: `ask-hermes-${handoffId}-${index + 1}.${mimeType.split('/')[1] || 'png'}`,
          mimeType,
          dataUrl: capture.data_url,
          size: Math.floor(encoded.length * 0.75),
        }
      })
      const target: WorkspaceOpenRequest = {
        instanceId: instance.instanceId,
        instanceGeneration: instance.instanceGeneration,
        handoffId,
        profileId,
        sessionId: selected === NEW_SESSION ? undefined : selected,
        // Existing discovered sessions already share draft state with the
        // workspace. Passing it again would append a duplicate on handoff.
        draft: sharedTarget ? undefined : handoffPrompt.trim() || undefined,
        captures: handoffCaptures.length ? handoffCaptures : undefined,
      }
      if (!handoffId) {
        await invoke('open_workspace', target)
        setWorkspaceHandoffInFlight(false)
        return
      }
      pending = {
        id: handoffId,
        instanceId: instance.instanceId,
        instanceGeneration: instance.instanceGeneration,
        promptGeneration: sourcePromptGeneration,
        composerRevision,
        prompt: handoffPrompt,
        captures: sourceCaptures,
        target,
      }
      pendingWorkspaceHandoff = pending
      await dispatchWorkspaceHandoff(pending)
    } catch (reason) {
      if (pending) await failPendingWorkspaceHandoff(pending, reason)
      else {
        setWorkspaceHandoffInFlight(false)
        setError(String(reason))
      }
    }
  }

  const resetPromptForInstanceSwitch = async () => {
    promptGeneration += 1
    retirePendingWorkspaceHandoff()
    cancelVoiceInput()
    setWorkspaceInstanceId(undefined)
    setWorkspaceInstanceGeneration(undefined)
    markComposerChanged()
    setPrompt('')
    setHistory([])
    setPagedMessages([])
    setPagedSession(undefined)
    setHasOlderMessages(false)
    setLoadingSessionHistory(false)
    setPreviousChat(undefined)
    setTurnActivities({})
    setCaptures([])
    setPreview(undefined)
    setBusy(false)
    setWorkspaceBusy(false)
    setWorkspaceProfileId(undefined)
    setWorkspaceSessionId(undefined)
    setSharedClientState(emptySharedClientState())
    workspaceAssistantExchanges.clear()
    setSessionPreference(NEW_SESSION)
    setActiveSession(NEW_SESSION)
    setRuntimeSession(undefined)
    localStorage.setItem(SESSION_PREFERENCE_KEY, NEW_SESSION)
    await invoke('set_previous_chat_available', { available: false })
    await loadSessions()
  }

  const applySettings = async () => {
    setSettingsError('')
    try {
      const instance = currentHermesInstance()
      const instanceChanged = JSON.stringify(instance) !== JSON.stringify(appliedHermesInstance)
      if (instanceChanged && isBusy()) throw new Error(workspaceCopy.waitBeforeInstanceSwitch)
      const currentAutostart = await isAutostartEnabled()
      const action = autostartAction(currentAutostart, startAtLogin())
      if (action === 'enable') await enableAutostart()
      if (action === 'disable') await disableAutostart()
      await invoke<HermesInstanceScope>('configure_hermes_instance', { config: instance })
      appliedHermesInstance = instance
      promptConfigurationReady = true
      const port = Number(hermesPort())
      const nextInstances = savedInstances().map(saved => saved.id === activeInstanceId()
        ? {
            ...saved,
            name: saved.id === AUTOMATIC_INSTANCE_ID ? automaticHermesInstance().name : instanceName().trim() || workspaceCopy.hermesInstance,
            mode: remoteHermes() ? 'existing' as const : 'automatic' as const,
            address: remoteHermes() ? hermesAddress().trim() : '127.0.0.1',
            port: remoteHermes() ? port : 0,
            token: remoteHermes() ? hermesToken().trim() : '',
          }
        : saved)
      const nextTrayMode = trayLinkMode()
      await invoke('set_tray_link_mode', { mode: nextTrayMode })
      const nextPromptShortcut = promptShortcut()
      const nextSessionShortcuts = sessionShortcuts()
      await invoke('set_shortcuts', {
        promptShortcut: nextPromptShortcut,
        shortcuts: nextSessionShortcuts,
      })

      // Commit browser persistence only after every fallible native setting
      // mutation succeeds. Failed Apply must not leave a half-saved form.
      setSavedInstances(nextInstances)
      localStorage.setItem(MODEL_KEY, model())
      localStorage.setItem(EFFORT_KEY, effort())
      localStorage.setItem(FAST_KEY, String(fastMode()))
      localStorage.setItem(VOICE_PROVIDER_KEY, voiceProvider())
      localStorage.setItem(SPEACHES_ENGLISH_KEY, String(speachesForceEnglish()))
      localStorage.setItem(VOICE_AUTO_START_KEY, String(voiceAutoStart()))
      localStorage.setItem(INSTANCES_KEY, JSON.stringify(nextInstances))
      localStorage.setItem(ACTIVE_INSTANCE_KEY, activeInstanceId())
      localStorage.setItem(HERMES_REMOTE_KEY, String(remoteHermes()))
      localStorage.setItem(HERMES_ADDRESS_KEY, hermesAddress().trim())
      localStorage.setItem(HERMES_PORT_KEY, hermesPort().trim())
      localStorage.setItem(HERMES_TOKEN_KEY, hermesToken().trim())
      localStorage.setItem(TRAY_LINK_MODE_KEY, nextTrayMode)
      writeWorkspaceNotificationPreferences({
        turnCompletion: notifyTurnCompletion(),
        interactionRequired: notifyInteractionRequired(),
        scheduleFailure: notifyScheduleFailure(),
        scheduleCompletion: notifyScheduleCompletion(),
      })
      await emit('workspace-notification-preferences-changed')
      localStorage.setItem(PROMPT_SHORTCUT_KEY, nextPromptShortcut)
      localStorage.setItem(SESSION_SHORTCUTS_KEY, JSON.stringify(nextSessionShortcuts))
      if (instanceChanged) {
        await resetPromptForInstanceSwitch()
      } else {
        localStorage.setItem(SESSION_PREFERENCE_KEY, sessionPreference())
      }
      if (!instanceChanged && history().length === 0) {
        setActiveSession(sessionPreference())
        setRuntimeSession(undefined)
      }
      await invoke('hide_window')
    } catch (reason) {
      setSettingsError(String(reason))
    }
  }

  const globalKeys = (event: KeyboardEvent) => {
    if (isVoiceInputShortcut(event) && !settingsOpen()) {
      event.preventDefault()
      toggleVoiceInput()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (preview()) {
        setPreview(undefined)
        return
      }
      if (settingsOpen()) {
        void invoke('hide_window')
        return
      }
      void invoke('hide_window')
    }
  }

  const addSessionShortcut = () => {
    const session = sessions()[0]
    if (!session) return
    setSessionShortcuts(items => [...items, { id: crypto.randomUUID(), shortcut: '', sessionId: session.id }])
  }

  const updateSessionShortcut = (id: string, update: Partial<SessionShortcut>) => {
    setSessionShortcuts(items => items.map(item => item.id === id ? { ...item, ...update } : item))
  }

  const recordPromptShortcut: JSX.EventHandler<HTMLInputElement, KeyboardEvent> = event => {
    event.preventDefault()
    event.stopPropagation()
    if ((event.key === 'Backspace' || event.key === 'Delete') && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      setPromptShortcut(DEFAULT_PROMPT_SHORTCUT)
      return
    }
    const shortcut = shortcutFromKeyboardEvent(event)
    if (shortcut) setPromptShortcut(shortcut)
  }

  const recordShortcut: JSX.EventHandler<HTMLInputElement, KeyboardEvent> = event => {
    event.preventDefault()
    event.stopPropagation()
    const id = event.currentTarget.dataset.id!
    if ((event.key === 'Backspace' || event.key === 'Delete') && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      updateSessionShortcut(id, { shortcut: '' })
      return
    }
    const shortcut = shortcutFromKeyboardEvent(event)
    if (shortcut) updateSessionShortcut(id, { shortcut })
  }

  const loadOlderHistory = async () => {
    const sessionId = pagedSession()
    const existing = pagedMessages()
    if (!sessionId || !hasOlderMessages() || loadingOlderMessages() || existing.length === 0) return
    const viewport = conversationRef
    const previousHeight = viewport?.scrollHeight || 0
    const storedExchangeCount = transcriptFromMessages(existing).length
    const generation = promptGeneration
    const expectedInstanceId = appliedHermesInstance.instanceId
    const firstMessageId = existing[0].id
    setLoadingOlderMessages(true)
    try {
      const scope = await promptInstanceScope(expectedInstanceId)
      const page = await invoke<HistoryPage>('get_session_history_page', {
        ...scope,
        sessionId,
        beforeId: firstMessageId,
        limit: 40,
      })
      if (generation !== promptGeneration
        || appliedHermesInstance.instanceId !== expectedInstanceId
        || pagedSession() !== sessionId
        || pagedMessages()[0]?.id !== firstMessageId) return
      const merged = [...page.messages, ...existing]
      const liveExchanges = history().slice(storedExchangeCount)
      setPagedMessages(merged)
      setHasOlderMessages(page.has_older)
      setHistory([...transcriptFromMessages(merged), ...liveExchanges])
      window.requestAnimationFrame(() => {
        if (viewport) viewport.scrollTop += viewport.scrollHeight - previousHeight
      })
    } catch (reason) {
      if (generation === promptGeneration
        && appliedHermesInstance.instanceId === expectedInstanceId
        && pagedSession() === sessionId) setError(String(reason))
    } finally {
      if (generation === promptGeneration
        && appliedHermesInstance.instanceId === expectedInstanceId
        && pagedSession() === sessionId) setLoadingOlderMessages(false)
    }
  }
  window.addEventListener('keydown', globalKeys)
  onCleanup(() => window.removeEventListener('keydown', globalKeys))

  const startDragging: JSX.EventHandler<HTMLElement, MouseEvent> = event => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (!target.closest('button')) {
      void getCurrentWindow().startDragging()
    }
  }

  const openAnswerLink: JSX.EventHandler<HTMLDivElement, MouseEvent> = event => {
    const anchor = (event.target as Element).closest<HTMLAnchorElement>('.answer a')
    if (!anchor) return
    event.preventDefault()
    event.stopPropagation()
    void invoke('open_external_url', { url: anchor.href }).catch(reason => setError(String(reason)))
  }

  return (
      <main class="window-shell" classList={{ expanded: history().length > 0 || loadingSessionHistory() }}>
        <section class="content">
          <Show when={history().length || loadingSessionHistory()}>
            <div class="conversation" ref={conversationRef} onClick={openAnswerLink} onScroll={event => {
              if (event.currentTarget.scrollTop < 36) void loadOlderHistory()
            }}>
              <div class="conversation-bar drag-zone" onMouseDown={startDragging} data-tauri-drag-region>
                <span>Ask Hermes</span>
                <div class="conversation-actions">
                  <button onClick={openWorkspace} disabled={workspaceHandoffInFlight()}>{workspaceCopy.openWorkspace} <PanelsTopLeft size={12} /></button>
                  <Show when={desktopAvailable()}><button onClick={openDesktop}>Open in Hermes <ExternalLink size={12} /></button></Show>
                  <button class="conversation-close" aria-label="Close Ask Hermes" title="Close" onClick={() => void invoke('hide_window')}>
                    <X size={14} />
                  </button>
                </div>
              </div>
              <Show when={loadingSessionHistory()}><div class="history-opening"><span class="capture-spinner" /> Opening session…</div></Show>
              <Show when={loadingOlderMessages()}><div class="history-loading"><span class="capture-spinner" /> Loading earlier messages…</div></Show>
              <For each={history()}>
                {item => (
                  <article class="exchange">
                    <div class="question">
                      <Show when={item.images.length}>
                        <div class="question-captures">
                          <For each={item.images}>{image => <img src={image.data_url} alt="Attached screen region" />}</For>
                        </div>
                      </Show>
                      {item.prompt}
                    </div>
                    <Show when={item.answer}>
                      <div class="answer markdown" classList={{ failed: item.status === 'error' }} innerHTML={renderMarkdown(item.answer)} />
                    </Show>
                    <Show when={item.status === 'pending'}>
                      <div class="answer-activity" role="status" aria-live="polite">
                        <LoaderCircle size={13} />
                        <span>{turnActivities()[item.id] || 'Thinking…'}</span>
                      </div>
                    </Show>
                  </article>
                )}
              </For>
            </div>
          </Show>

          <div class="composer">
            <div class="brand-mark drag-zone" title="Drag Ask Hermes" onMouseDown={startDragging} data-tauri-drag-region>
              <img src={hermesIcon} alt="Hermes" draggable={false} />
            </div>
            <Show when={captures().length}>
              <div class="attachments" aria-label="Attached screen captures">
                <For each={captures()}>{(capture, index) => (
                <div class="attachment">
                  <button class="attachment-preview" aria-label={`Preview capture ${index() + 1}`} onClick={() => setPreview(capture)}>
                    <img src={capture.data_url} alt={`Screen capture ${index() + 1}`} />
                  </button>
                  <button class="attachment-remove" aria-label={`Remove capture ${index() + 1}`} disabled={workspaceHandoffInFlight()} onClick={() => {
                    markComposerChanged()
                    setCaptures(items => removeCaptureAt(items, index()))
                  }}><X size={11} /></button>
                </div>
                )}</For>
              </div>
            </Show>
            <Show when={sharedClientState().queue.length}>
              <button class="compact-queue-status" onClick={openWorkspace} disabled={workspaceHandoffInFlight()} title={workspaceCopy.openWorkspaceQueueEdit}>
                {workspaceCopy.queuedCount(sharedClientState().queue.length)}
              </button>
            </Show>
            <textarea
              ref={inputRef}
              value={prompt()}
              onInput={event => setCompactDraft(event.currentTarget.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder="Ask Hermes anything…"
              disabled={submitStarting() || workspaceHandoffInFlight()}
              rows={1}
              autofocus
            />
            <button class="capture-button" classList={{ capturing: capturing() }} onClick={beginCapture} disabled={workspaceHandoffInFlight() || submitStarting() || (busy() && !canQueueDuringLocalTurn()) || capturing() || voiceStatus() !== 'idle'} title="Select another screen region" aria-label={capturing() ? 'Preparing screen capture' : 'Select screen region'}>
              <Show when={!capturing()} fallback={<span class="capture-spinner" />}>
              <Camera size={20} />
              </Show>
            </button>
            <Show
              when={(!prompt().trim() && captures().length === 0) || voiceStatus() !== 'idle'}
              fallback={
                <button class="send-button" aria-label={workspaceBusy() || busy() ? workspaceCopy.queueForHermes : 'Ask Hermes'} onClick={submit} disabled={workspaceHandoffInFlight() || submitStarting() || (busy() && !canQueueDuringLocalTurn()) || capturing()}>
                  <Show when={!submitStarting() && (!busy() || canQueueDuringLocalTurn())} fallback={<span class="spinner" />}><ArrowRight size={20} /></Show>
                </button>
              }
            >
              <button
                class="voice-button"
                classList={{ recording: voiceStatus() === 'recording' }}
                onClick={toggleVoiceInput}
                disabled={workspaceHandoffInFlight() || submitStarting() || (busy() && !canQueueDuringLocalTurn()) || capturing() || voiceStatus() === 'transcribing'}
                title={voiceInputTooltip(voiceStatus(), voiceElapsed())}
                aria-label={voiceInputTooltip(voiceStatus(), voiceElapsed())}
              >
                <Show when={voiceStatus() === 'idle'}><Mic size={20} /></Show>
                <Show when={voiceStatus() === 'recording'}><Square size={15} /></Show>
                <Show when={voiceStatus() === 'transcribing'}><span class="spinner" /></Show>
              </button>
            </Show>
          </div>

          <Show when={error()}><div class="error">{error()}</div></Show>
          <Show when={preview()}>{capture => (
            <div class="capture-preview" role="dialog" aria-modal="true" aria-label="Screen capture preview" onMouseDown={event => {
              if (event.target === event.currentTarget) setPreview(undefined)
            }}>
              <img src={capture().data_url} alt="Screen capture preview" />
              <button aria-label="Close capture preview" onClick={() => setPreview(undefined)}><X size={18} /></button>
            </div>
          )}</Show>
          <Show when={settingsOpen()}>
            <div class="settings-panel" role="dialog" aria-modal="true" aria-label="Ask Hermes settings">
              <div class="settings-header"><span>Settings</span><button aria-label="Close settings" onClick={() => void invoke('hide_window')}><X size={16} /></button></div>
              <nav class="settings-tabs" aria-label="Settings sections">
                <button classList={{ active: settingsTab() === 'general' }} onClick={() => setSettingsTab('general')}>General</button>
                <button classList={{ active: settingsTab() === 'hermes' }} onClick={() => setSettingsTab('hermes')}>Hermes</button>
                <button classList={{ active: settingsTab() === 'voice' }} onClick={() => setSettingsTab('voice')}>Voice input</button>
                <button classList={{ active: settingsTab() === 'shortcuts' }} onClick={() => setSettingsTab('shortcuts')}>Shortcuts</button>
              </nav>
              <div class="settings-body">
                <Show when={settingsTab() === 'general'}>
                  <div class="settings-form">
                    <label>
                      Session
                      <span class="select-shell">
                        <select data-session-preference value={sessionPreference()} onChange={event => setSessionPreference(event.currentTarget.value)}>
                          <option value={NEW_SESSION}>Always start a new session</option>
                          <For each={sessions()}>
                            {session => <option value={session.id}>{session.title} · {compactTime(session.last_active)}</option>}
                          </For>
                        </select>
                        <ChevronDown class="select-chevron" size={16} />
                      </span>
                    </label>
                    <label>
                      Model
                      <span class="select-shell">
                        <select value={model()} onChange={event => setModel(event.currentTarget.value)}>
                          <option value="">Hermes default</option>
                          <option value="gpt-5.6-terra">GPT-5.6 Terra · faster</option>
                          <option value="gpt-5.6-sol">GPT-5.6 Sol · strongest</option>
                        </select>
                        <ChevronDown class="select-chevron" size={16} />
                      </span>
                    </label>
                    <label>
                      Thinking effort
                      <span class="select-shell">
                        <select value={effort()} onChange={event => setEffort(event.currentTarget.value)}>
                          <option value="none">None</option>
                          <option value="minimal">Minimal</option>
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                          <option value="xhigh">Extra high</option>
                          <option value="max">Max</option>
                          <option value="ultra">Ultra</option>
                        </select>
                        <ChevronDown class="select-chevron" size={16} />
                      </span>
                    </label>
                    <Show when={supportsFastMode(model())}>
                      <label class="settings-toggle">
                        Fast mode
                        <input type="checkbox" checked={fastMode()} onChange={event => setFastMode(event.currentTarget.checked)} />
                      </label>
                    </Show>
                    <label class="settings-toggle">
                      Start with Windows
                      <input type="checkbox" checked={startAtLogin()} onChange={event => setStartAtLogin(event.currentTarget.checked)} />
                    </label>
                    <label>
                      {workspaceCopy.trayLinks}
                      <span class="select-shell">
                        <select value={trayLinkMode()} onChange={event => setTrayLinkMode(event.currentTarget.value as TrayLinkMode)}>
                          <option value="workspace">{workspaceCopy.workspaceOnly}</option>
                          <option value="desktop" disabled={!desktopAvailable()}>{workspaceCopy.hermesDesktopOnly}</option>
                          <option value="both" disabled={!desktopAvailable()}>{workspaceCopy.showBoth}</option>
                        </select>
                        <ChevronDown class="select-chevron" size={16} />
                      </span>
                    </label>
                    <p>{workspaceCopy.notifications}</p>
                    <label class="settings-toggle">
                      {workspaceCopy.turnCompleted}
                      <input type="checkbox" checked={notifyTurnCompletion()} onChange={event => { setNotifyTurnCompletion(event.currentTarget.checked); if (event.currentTarget.checked) requestNotificationPermission() }} />
                    </label>
                    <label class="settings-toggle">
                      {workspaceCopy.interactionRequired}
                      <input type="checkbox" checked={notifyInteractionRequired()} onChange={event => { setNotifyInteractionRequired(event.currentTarget.checked); if (event.currentTarget.checked) requestNotificationPermission() }} />
                    </label>
                    <label class="settings-toggle">
                      {workspaceCopy.scheduleFailedSetting}
                      <input type="checkbox" checked={notifyScheduleFailure()} onChange={event => { setNotifyScheduleFailure(event.currentTarget.checked); if (event.currentTarget.checked) requestNotificationPermission() }} />
                    </label>
                    <label class="settings-toggle">
                      {workspaceCopy.scheduleCompletedSetting}
                      <input type="checkbox" checked={notifyScheduleCompletion()} onChange={event => { setNotifyScheduleCompletion(event.currentTarget.checked); if (event.currentTarget.checked) requestNotificationPermission() }} />
                    </label>
                    <p>Model, thinking effort, and Fast mode apply only to sessions created by Ask Hermes.</p>
                  </div>
                </Show>
                <Show when={settingsTab() === 'hermes'}>
                  <div class="settings-form">
                    <label>
                      {workspaceCopy.connection}
                      <span class="select-shell">
                        <select value={activeInstanceId()} onChange={event => selectSavedInstance(event.currentTarget.value)}>
                          <For each={savedInstances()}>{instance => (
                            <option value={instance.id}>{instance.name}</option>
                          )}</For>
                        </select>
                        <ChevronDown class="select-chevron" size={16} />
                      </span>
                    </label>
                    <div class="instance-actions">
                      <button type="button" onClick={addSavedInstance}><Plus size={14} /> {workspaceCopy.addInstance}</button>
                      <button type="button" onClick={removeSavedInstance} disabled={activeInstanceId() === AUTOMATIC_INSTANCE_ID}><Trash2 size={14} /> {workspaceCopy.remove}</button>
                    </div>
                    <Show when={remoteHermes()}>
                    <label>
                      {workspaceCopy.name}
                      <input value={instanceName()} onInput={event => setInstanceName(event.currentTarget.value)} placeholder={workspaceCopy.localDerpAgent} />
                    </label>
                    <label>
                      {workspaceCopy.address}
                      <input value={hermesAddress()} onInput={event => setHermesAddress(event.currentTarget.value)} placeholder="127.0.0.1" spellcheck={false} />
                    </label>
                    <label>
                      {workspaceCopy.port}
                      <input value={hermesPort()} onInput={event => setHermesPort(event.currentTarget.value)} inputmode="numeric" placeholder="9119" />
                    </label>
                    <label>
                      {workspaceCopy.sessionTokenOptional}
                      <input type="password" value={hermesToken()} onInput={event => setHermesToken(event.currentTarget.value)} autocomplete="off" />
                    </label>
                    </Show>
                  </div>
                </Show>
                <Show when={settingsTab() === 'voice'}>
                  <div class="settings-form">
                    <label>
                      Provider
                      <span class="select-shell">
                        <select value={voiceProvider()} onChange={event => setVoiceProvider(event.currentTarget.value as VoiceProvider)}>
                          <option value="hermes">Hermes native</option>
                          <option value="speaches" disabled={speachesStatus()?.installed === false}>
                            {speachesStatus()?.installed === false ? 'Speaches realtime · not installed' : 'Speaches realtime'}
                          </option>
                        </select>
                        <ChevronDown class="select-chevron" size={16} />
                      </span>
                    </label>
                    <Show when={voiceProvider() === 'speaches'}>
                      <label class="settings-toggle">
                        Force English
                        <input type="checkbox" checked={speachesForceEnglish()} onChange={event => setSpeachesForceEnglish(event.currentTarget.checked)} />
                      </label>
                    </Show>
                    <label class="settings-toggle">
                      Start listening on open
                      <input type="checkbox" checked={voiceAutoStart()} onChange={event => setVoiceAutoStart(event.currentTarget.checked)} />
                    </label>
                  </div>
                </Show>
                <Show when={settingsTab() === 'shortcuts'}>
                  <section class="shortcut-settings prompt-shortcut-settings" aria-labelledby="prompt-shortcut-settings-title">
                    <div class="shortcut-settings-header">
                      <div>
                        <h3 id="prompt-shortcut-settings-title">Open prompt</h3>
                        <p>Press a modified key combination. Backspace or Delete restores the default.</p>
                      </div>
                    </div>
                    <div class="prompt-shortcut-row">
                      <label for="prompt-shortcut">Global shortcut</label>
                      <input
                        id="prompt-shortcut"
                        value={promptShortcut()}
                        readOnly
                        aria-label="Prompt shortcut keys"
                        onKeyDown={recordPromptShortcut}
                      />
                      <button
                        type="button"
                        onClick={() => setPromptShortcut(DEFAULT_PROMPT_SHORTCUT)}
                        disabled={promptShortcut() === DEFAULT_PROMPT_SHORTCUT}
                      >
                        Reset
                      </button>
                    </div>
                  </section>
                  <section class="shortcut-settings session-shortcut-settings" aria-labelledby="shortcut-settings-title">
                    <div class="shortcut-settings-header">
                      <h3 id="shortcut-settings-title">Open sessions directly</h3>
                      <button type="button" onClick={addSessionShortcut} disabled={sessions().length === 0}>Add shortcut</button>
                    </div>
                    <Show when={sessionShortcuts().length > 0} fallback={<div class="shortcut-empty">No session shortcuts configured.</div>}>
                      <For each={sessionShortcuts()}>{binding => (
                        <div class="shortcut-row">
                          <input data-id={binding.id} value={binding.shortcut} readOnly placeholder="Press keys" aria-label="Shortcut keys" onKeyDown={recordShortcut} />
                          <span class="select-shell">
                            <select data-session-shortcut={binding.id} value={binding.sessionId} aria-label="Hermes session" onChange={event => updateSessionShortcut(binding.id, { sessionId: event.currentTarget.value })}>
                              <For each={sessions()}>{session => <option value={session.id}>{session.title} · {compactTime(session.last_active)}</option>}</For>
                            </select>
                            <ChevronDown class="select-chevron" size={15} />
                          </span>
                          <button class="shortcut-remove" type="button" aria-label="Remove shortcut" onClick={() => setSessionShortcuts(items => items.filter(item => item.id !== binding.id))}><X size={15} /></button>
                        </div>
                      )}</For>
                    </Show>
                  </section>
                </Show>
              </div>
              <Show when={settingsError()}><div class="settings-error" role="alert">{settingsError()}</div></Show>
              <footer class="settings-footer"><button class="settings-save" onClick={applySettings}>Apply</button></footer>
            </div>
          </Show>
        </section>
      </main>
  )
}

function CaptureWindow() {
  let surface: HTMLDivElement | undefined
  const [dragStart, setDragStart] = createSignal<{ x: number; y: number }>()
  const [selection, setSelection] = createSignal<Selection>()
  const [background, setBackground] = createSignal<string>()
  const [error, setError] = createSignal('')

  const reset = () => {
    setDragStart(undefined)
    setSelection(undefined)
    setBackground(undefined)
    setError('')
  }

  onMount(() => {
    document.documentElement.classList.add('capture-document')
    const unlisten = listen('reset-selection', reset)
    const unlistenBackground = listen<string>('selection-background', event => setBackground(event.payload))
    onCleanup(() => {
      document.documentElement.classList.remove('capture-document')
      void unlisten.then(dispose => dispose())
      void unlistenBackground.then(dispose => dispose())
    })
  })

  const point = (event: PointerEvent) => {
    const bounds = surface!.getBoundingClientRect()
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }

  const pointerDown: JSX.EventHandler<HTMLDivElement, PointerEvent> = event => {
    if (event.button !== 0) return
    const start = point(event)
    setDragStart(start)
    setSelection({ ...start, width: 0, height: 0 })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const pointerMove: JSX.EventHandler<HTMLDivElement, PointerEvent> = event => {
    const start = dragStart()
    if (!start) return
    const current = point(event)
    setSelection({
      x: Math.min(start.x, current.x),
      y: Math.min(start.y, current.y),
      width: Math.abs(current.x - start.x),
      height: Math.abs(current.y - start.y)
    })
  }

  const captureNormalized = async (region: Selection) => {
    try {
      await invoke<Capture>('capture_region', { region })
      reset()
    } catch (reason) {
      setError(String(reason))
    }
  }

  const pointerUp: JSX.EventHandler<HTMLDivElement, PointerEvent> = async event => {
    if (!dragStart()) return
    setDragStart(undefined)
    const region = selection()
    if (!region || region.width < 8 || region.height < 8) {
      setSelection(undefined)
      return
    }
    const bounds = surface!.getBoundingClientRect()
    try {
      await captureNormalized({
        x: region.x / bounds.width,
        y: region.y / bounds.height,
        width: region.width / bounds.width,
        height: region.height / bounds.height
      })
    } finally {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    }
  }

  const keyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      reset()
      void invoke('hide_window')
    }
  }
  window.addEventListener('keydown', keyDown)
  onCleanup(() => window.removeEventListener('keydown', keyDown))

  return (
    <div
      class="capture-surface"
      ref={surface}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
    >
      <Show when={background()}>
        {image => (
          <img
            class="capture-background"
            src={image()}
            alt="Screen snapshot"
            onLoad={() => void invoke('show_prepared_selection')}
          />
        )}
      </Show>
      <Show when={selection()}>
        {region => (
          <div
            class="capture-selection"
            style={{
              left: `${region().x}px`,
              top: `${region().y}px`,
              width: `${region().width}px`,
              height: `${region().height}px`
            }}
          />
        )}
      </Show>
      <Show when={error()}><div class="capture-error">{error()}</div></Show>
    </div>
  )
}

export function App() {
  const label = getCurrentWindow().label
  if (label === 'capture') return <CaptureWindow />
  if (label === 'workspace') return <WorkspaceApp />
  return <PromptWindow />
}

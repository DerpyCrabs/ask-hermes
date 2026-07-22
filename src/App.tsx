import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart'
import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import type { JSX } from 'solid-js'
import ArrowRight from 'lucide-solid/icons/arrow-right'
import Camera from 'lucide-solid/icons/camera'
import ChevronDown from 'lucide-solid/icons/chevron-down'
import ExternalLink from 'lucide-solid/icons/external-link'
import LoaderCircle from 'lucide-solid/icons/loader-circle'
import Mic from 'lucide-solid/icons/mic'
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
import hermesIcon from '../src-tauri/icons/hermes-tray-source.png'

type Session = SessionRecord

type Selection = { x: number; y: number; width: number; height: number }
type PreviousChat = { history: Exchange[]; activeSession: string; runtimeSession?: string }
type VoiceConfig = { maxRecordingSeconds: number; sttEnabled: boolean }
type VoiceTranscription = { transcript: string }
type VoiceProvider = 'hermes' | 'speaches'
type SpeachesStatus = { installed: boolean; running: boolean; model: string; websocketUrl: string }

const SESSION_PREFERENCE_KEY = 'ask-hermes.session-preference.v2'
const MODEL_KEY = 'ask-hermes.model'
const EFFORT_KEY = 'ask-hermes.reasoning-effort'
const FAST_KEY = 'ask-hermes.fast-mode'
const SESSION_SHORTCUTS_KEY = 'ask-hermes.session-shortcuts.v1'
const VOICE_PROVIDER_KEY = 'ask-hermes.voice-provider'
const SPEACHES_ENGLISH_KEY = 'ask-hermes.speaches-force-english'
const VOICE_AUTO_START_KEY = 'ask-hermes.voice-auto-start'
const HERMES_ADDRESS_KEY = 'ask-hermes.instance.address'
const HERMES_PORT_KEY = 'ask-hermes.instance.port'
const HERMES_REMOTE_KEY = 'ask-hermes.instance.remote'
const HERMES_TOKEN_KEY = 'ask-hermes.instance.token'

function storedSessionShortcuts(): SessionShortcut[] {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_SHORTCUTS_KEY) || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function compactTime(timestamp: number) {
  if (!timestamp) return ''
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp * 1000))
}

function PromptWindow() {
  let inputRef: HTMLTextAreaElement | undefined
  let conversationRef: HTMLDivElement | undefined
  let promptGeneration = 0
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
  const [turnActivities, setTurnActivities] = createSignal<Record<string, string>>({})
  const [capturing, setCapturing] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [settingsTab, setSettingsTab] = createSignal<'general' | 'hermes' | 'voice' | 'shortcuts'>('general')
  const [model, setModel] = createSignal(localStorage.getItem(MODEL_KEY) || 'gpt-5.6-terra')
  const [effort, setEffort] = createSignal(localStorage.getItem(EFFORT_KEY) || 'low')
  const [fastMode, setFastMode] = createSignal(localStorage.getItem(FAST_KEY) === 'true')
  const [startAtLogin, setStartAtLogin] = createSignal(false)
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
  const [remoteHermes, setRemoteHermes] = createSignal(localStorage.getItem(HERMES_REMOTE_KEY) === 'true')
  const [hermesAddress, setHermesAddress] = createSignal(localStorage.getItem(HERMES_ADDRESS_KEY) || '127.0.0.1')
  const [hermesPort, setHermesPort] = createSignal(localStorage.getItem(HERMES_PORT_KEY) || '9119')
  const [hermesToken, setHermesToken] = createSignal(localStorage.getItem(HERMES_TOKEN_KEY) || '')

  const currentHermesInstance = () => buildHermesInstanceConfig(
    remoteHermes(),
    hermesAddress(),
    hermesPort(),
    hermesToken(),
  )

  const loadSessions = async () => {
    try {
      const list = await invoke<Session[]>('list_sessions')
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
    } catch (reason) {
      setError(String(reason))
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
    setVoiceElapsed(0)
    setVoiceStatus('idle')
  }

  const applyVoiceTranscript = (transcript: string) => {
    const text = transcript.trim()
    if (!text) throw new Error('No speech was detected')
    setPrompt(current => current.trim() ? `${current.trimEnd()} ${text}` : text)
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
      const dataUrl = await blobToDataUrl(blob)
      const result = await invoke<VoiceTranscription>('transcribe_voice_audio', {
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
      const config = invoke<VoiceConfig>('get_voice_input_config').then(
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
    if (voiceStatus() !== 'idle' || prompt().trim() || busy() || capturing()) return
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
    cancelVoiceInput()
    const transcript = history()
    if (shouldRememberPreviousChat(transcript.length, openedFromSessionShortcut)) {
      setPreviousChat({ history: transcript, activeSession: activeSession(), runtimeSession: runtimeSession() })
      void invoke('set_previous_chat_available', { available: true })
    }
    openedFromSessionShortcut = false
    promptGeneration += 1
    setPrompt('')
    setCaptures([])
    setPreview(undefined)
    setHistory([])
    setBusy(false)
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

  onMount(() => {
    try {
      void invoke('configure_hermes_instance', { config: currentHermesInstance() }).catch(reason => setError(String(reason)))
    } catch (reason) {
      setError(String(reason))
    }
    void loadSessions()
    void invoke<boolean>('hermes_desktop_available').then(setDesktopAvailable).catch(() => setDesktopAvailable(false))
    void invoke('set_session_shortcuts', { shortcuts: sessionShortcuts() }).catch(reason => setError(String(reason)))
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
      setPrompt('')
      setCaptures([])
      setPreview(undefined)
      setSettingsOpen(false)
      setError('')
      setBusy(false)
      setCapturing(false)
      setHistory(previous.history)
      setActiveSession(previous.activeSession)
      setRuntimeSession(previous.runtimeSession)
      setPagedMessages([])
      setPagedSession(undefined)
      setHasOlderMessages(false)
      setLoadingSessionHistory(false)
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
      const generation = promptGeneration
      setPrompt('')
      setCaptures([])
      setPreview(undefined)
      setSettingsOpen(false)
      setError('')
      setBusy(false)
      setCapturing(false)
      setHistory([])
      setLoadingSessionHistory(true)
      setActiveSession(sessionId)
      setRuntimeSession(undefined)
      setPagedMessages([])
      setPagedSession(sessionId)
      setHasOlderMessages(false)
      void invoke<HistoryPage>('get_session_history_page', { sessionId, beforeId: null, limit: 40 })
        .then(page => {
          if (generation !== promptGeneration) return
          setPagedMessages(page.messages)
          setPagedSession(sessionId)
          setHasOlderMessages(page.has_older)
          setHistory(transcriptFromMessages(page.messages))
          setLoadingSessionHistory(false)
          scrollToLatest()
          window.setTimeout(() => inputRef?.focus(), 20)
        })
        .catch(reason => {
          setLoadingSessionHistory(false)
          setError(String(reason))
        })
    })
    const unlistenClear = listen('clear-prompt', clearPrompt)
    const unlistenCapture = listen<Capture>('capture-complete', event => {
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
    onCleanup(() => void unlistenOpen.then(dispose => dispose()))
    onCleanup(() => void unlistenPrevious.then(dispose => dispose()))
    onCleanup(() => void unlistenSessionShortcut.then(dispose => dispose()))
    onCleanup(() => void unlistenClear.then(dispose => dispose()))
    onCleanup(() => void unlistenCapture.then(dispose => dispose()))
    onCleanup(() => void unlistenCaptureReady.then(dispose => dispose()))
    onCleanup(() => void unlistenSettings.then(dispose => dispose()))
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

  const submit = async () => {
    if (busy() || capturing() || (!prompt().trim() && captures().length === 0)) return
    const question = prompt().trim() || 'What can you tell me about these screenshots?'
    const images = captures()
    const generation = promptGeneration
    const exchangeId = `exchange-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const selectedSession = activeSession()
    setHistory(items => beginExchange(items, { id: exchangeId, prompt: question, images }))
    setTurnActivities(items => ({ ...items, [exchangeId]: formatTurnActivity('thinking') }))
    setPrompt('')
    setCaptures([])
    setBusy(true)
    setError('')
    try {
      const result = await runHermesTurn({
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
      await loadSessions()
      for (const delay of [1200, 3500, 8000]) {
        window.setTimeout(() => void loadSessions(), delay)
      }
    } catch (reason) {
      const message = String(reason)
      setHistory(items => items.map(item => item.id === exchangeId ? { ...item, answer: item.answer || message, status: 'error' } : item))
    } finally {
      setTurnActivities(items => {
        const next = { ...items }
        delete next[exchangeId]
        return next
      })
      setBusy(false)
      window.setTimeout(() => inputRef?.focus(), 20)
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
      .then(images => setCaptures(items => [...items, ...images]))
      .catch(reason => setError(String(reason)))
  }

  async function beginCapture() {
    if (capturing() || busy() || voiceStatus() !== 'idle') return
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

  const applySettings = async () => {
    setSettingsError('')
    try {
      const currentAutostart = await isAutostartEnabled()
      const action = autostartAction(currentAutostart, startAtLogin())
      if (action === 'enable') await enableAutostart()
      if (action === 'disable') await disableAutostart()
      localStorage.setItem(SESSION_PREFERENCE_KEY, sessionPreference())
      localStorage.setItem(MODEL_KEY, model())
      localStorage.setItem(EFFORT_KEY, effort())
      localStorage.setItem(FAST_KEY, String(fastMode()))
      localStorage.setItem(VOICE_PROVIDER_KEY, voiceProvider())
      localStorage.setItem(SPEACHES_ENGLISH_KEY, String(speachesForceEnglish()))
      localStorage.setItem(VOICE_AUTO_START_KEY, String(voiceAutoStart()))
      const instance = currentHermesInstance()
      await invoke('configure_hermes_instance', { config: instance })
      localStorage.setItem(HERMES_REMOTE_KEY, String(remoteHermes()))
      localStorage.setItem(HERMES_ADDRESS_KEY, hermesAddress().trim())
      localStorage.setItem(HERMES_PORT_KEY, hermesPort().trim())
      localStorage.setItem(HERMES_TOKEN_KEY, hermesToken().trim())
      await invoke('set_session_shortcuts', { shortcuts: sessionShortcuts() })
      localStorage.setItem(SESSION_SHORTCUTS_KEY, JSON.stringify(sessionShortcuts()))
      if (history().length === 0) {
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
    setLoadingOlderMessages(true)
    try {
      const page = await invoke<HistoryPage>('get_session_history_page', {
        sessionId,
        beforeId: existing[0].id,
        limit: 40,
      })
      const merged = [...page.messages, ...existing]
      const liveExchanges = history().slice(storedExchangeCount)
      setPagedMessages(merged)
      setHasOlderMessages(page.has_older)
      setHistory([...transcriptFromMessages(merged), ...liveExchanges])
      window.requestAnimationFrame(() => {
        if (viewport) viewport.scrollTop += viewport.scrollHeight - previousHeight
      })
    } catch (reason) {
      setError(String(reason))
    } finally {
      setLoadingOlderMessages(false)
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
                  <button class="attachment-remove" aria-label={`Remove capture ${index() + 1}`} onClick={() => setCaptures(items => removeCaptureAt(items, index()))}><X size={11} /></button>
                </div>
                )}</For>
              </div>
            </Show>
            <textarea
              ref={inputRef}
              value={prompt()}
              onInput={event => setPrompt(event.currentTarget.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder="Ask Hermes anything…"
              rows={1}
              autofocus
            />
            <button class="capture-button" classList={{ capturing: capturing() }} onClick={beginCapture} disabled={busy() || capturing() || voiceStatus() !== 'idle'} title="Select another screen region" aria-label={capturing() ? 'Preparing screen capture' : 'Select screen region'}>
              <Show when={!capturing()} fallback={<span class="capture-spinner" />}>
              <Camera size={20} />
              </Show>
            </button>
            <Show
              when={(!prompt().trim() && captures().length === 0) || voiceStatus() !== 'idle'}
              fallback={
                <button class="send-button" aria-label="Ask Hermes" onClick={submit} disabled={busy() || capturing()}>
                  <Show when={!busy()} fallback={<span class="spinner" />}><ArrowRight size={20} /></Show>
                </button>
              }
            >
              <button
                class="voice-button"
                classList={{ recording: voiceStatus() === 'recording' }}
                onClick={toggleVoiceInput}
                disabled={busy() || capturing() || voiceStatus() === 'transcribing'}
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
                <button classList={{ active: settingsTab() === 'shortcuts' }} onClick={() => setSettingsTab('shortcuts')}>Session shortcuts</button>
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
                    <p>Model, thinking effort, and Fast mode apply only to sessions created by Ask Hermes.</p>
                  </div>
                </Show>
                <Show when={settingsTab() === 'hermes'}>
                  <div class="settings-form">
                    <label>
                      Connection
                      <span class="select-shell">
                        <select value={remoteHermes() ? 'remote' : 'local'} onChange={event => setRemoteHermes(event.currentTarget.value === 'remote')}>
                          <option value="local">Automatic</option>
                          <option value="remote">Existing instance</option>
                        </select>
                        <ChevronDown class="select-chevron" size={16} />
                      </span>
                    </label>
                    <Show when={remoteHermes()}>
                    <label>
                      Address
                      <input value={hermesAddress()} onInput={event => setHermesAddress(event.currentTarget.value)} placeholder="127.0.0.1" spellcheck={false} />
                    </label>
                    <label>
                      Port
                      <input value={hermesPort()} onInput={event => setHermesPort(event.currentTarget.value)} inputmode="numeric" placeholder="9119" />
                    </label>
                    <label>
                      Session token (optional)
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
                  <section class="shortcut-settings" aria-labelledby="shortcut-settings-title">
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
  return <PromptWindow />
}

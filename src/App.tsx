import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart'
import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import type { JSX } from 'solid-js'
import { NEW_SESSION, normalizeSelection } from './selection'
import { appendCapture, clipboardImageFiles, imageFileToCapture, removeCaptureAt, type Capture } from './captures'
import { renderMarkdown } from './markdown'
import { autostartAction } from './autostart'
import { runHermesTurn } from './hermes-gateway'
import { appendAnswerDelta, beginExchange, finishExchange, type Exchange } from './conversation'
import hermesIcon from '../src-tauri/icons/hermes-tray-source.png'

type Session = {
  id: string
  title: string
  preview: string
  started_at: number
  last_active: number
}

type Selection = { x: number; y: number; width: number; height: number }
type PreviousChat = { history: Exchange[]; activeSession: string; runtimeSession?: string }

const SESSION_PREFERENCE_KEY = 'ask-hermes.session-preference.v2'
const MODEL_KEY = 'ask-hermes.model'
const EFFORT_KEY = 'ask-hermes.reasoning-effort'

function compactTime(timestamp: number) {
  if (!timestamp) return ''
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp * 1000))
}

function PromptWindow() {
  let inputRef: HTMLTextAreaElement | undefined
  let promptGeneration = 0
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
  const [capturing, setCapturing] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [model, setModel] = createSignal(localStorage.getItem(MODEL_KEY) || 'gpt-5.6-terra')
  const [effort, setEffort] = createSignal(localStorage.getItem(EFFORT_KEY) || 'low')
  const [startAtLogin, setStartAtLogin] = createSignal(false)
  const [error, setError] = createSignal('')

  const loadSessions = async () => {
    try {
      const list = await invoke<Session[]>('list_sessions')
      setSessions(list)
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

  const clearPrompt = () => {
    const transcript = history()
    if (transcript.length > 0) {
      setPreviousChat({ history: transcript, activeSession: activeSession(), runtimeSession: runtimeSession() })
      void invoke('set_previous_chat_available', { available: true })
    }
    promptGeneration += 1
    setPrompt('')
    setCaptures([])
    setPreview(undefined)
    setHistory([])
    setBusy(false)
    setCapturing(false)
    setSettingsOpen(false)
    setActiveSession(sessionPreference())
    setRuntimeSession(undefined)
    setError('')
  }

  onMount(() => {
    void loadSessions()
    const unlisten = getCurrentWindow().onFocusChanged(({ payload }) => {
      if (payload) window.setTimeout(() => inputRef?.focus(), 30)
    })
    const unlistenOpen = listen('open-prompt', () => {
      void loadSessions()
      window.setTimeout(() => inputRef?.focus(), 20)
    })
    const unlistenPrevious = listen('open-previous-chat', () => {
      const previous = previousChat()
      if (!previous) return
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
      window.setTimeout(() => inputRef?.focus(), 20)
    })
    const unlistenClear = listen('clear-prompt', clearPrompt)
    const unlistenCapture = listen<Capture>('capture-complete', event => {
      setCaptures(items => appendCapture(items, event.payload))
      setCapturing(false)
      window.setTimeout(() => inputRef?.focus(), 30)
    })
    const unlistenCaptureReady = listen('selection-ready', () => setCapturing(false))
    const unlistenSettings = listen('open-settings', () => {
      setSettingsOpen(true)
      void loadSessions()
      void isAutostartEnabled().then(setStartAtLogin).catch(reason => setError(String(reason)))
    })
    onCleanup(() => void unlisten.then(dispose => dispose()))
    onCleanup(() => void unlistenOpen.then(dispose => dispose()))
    onCleanup(() => void unlistenPrevious.then(dispose => dispose()))
    onCleanup(() => void unlistenClear.then(dispose => dispose()))
    onCleanup(() => void unlistenCapture.then(dispose => dispose()))
    onCleanup(() => void unlistenCaptureReady.then(dispose => dispose()))
    onCleanup(() => void unlistenSettings.then(dispose => dispose()))
  })

  createEffect(() => {
    if (!settingsOpen()) return
    const timer = window.setInterval(() => void loadSessions(), 2000)
    onCleanup(() => window.clearInterval(timer))
  })

  createEffect(() => {
    void invoke('set_prompt_expanded', { expanded: history().length > 0 || Boolean(preview()) || settingsOpen() })
  })

  const submit = async () => {
    if (busy() || capturing() || (!prompt().trim() && captures().length === 0)) return
    const question = prompt().trim() || 'What can you tell me about these screenshots?'
    const images = captures()
    const generation = promptGeneration
    const exchangeId = `exchange-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const selectedSession = activeSession()
    setHistory(items => beginExchange(items, { id: exchangeId, prompt: question, images }))
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
        onSession: (runtimeId, storedId) => {
          if (generation !== promptGeneration) return
          setRuntimeSession(runtimeId)
          setActiveSession(storedId)
        },
        onDelta: text => {
          if (generation !== promptGeneration) return
          setHistory(items => appendAnswerDelta(items, exchangeId, text))
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
    if (capturing() || busy()) return
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
    try {
      const currentAutostart = await isAutostartEnabled()
      const action = autostartAction(currentAutostart, startAtLogin())
      if (action === 'enable') await enableAutostart()
      if (action === 'disable') await disableAutostart()
      localStorage.setItem(SESSION_PREFERENCE_KEY, sessionPreference())
      localStorage.setItem(MODEL_KEY, model())
      localStorage.setItem(EFFORT_KEY, effort())
      if (history().length === 0) {
        setActiveSession(sessionPreference())
        setRuntimeSession(undefined)
      }
      setSettingsOpen(false)
    } catch (reason) {
      setError(String(reason))
    }
  }

  const globalKeys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (preview()) {
        setPreview(undefined)
        return
      }
      if (settingsOpen()) {
        setSettingsOpen(false)
        return
      }
      void invoke('hide_window')
    }
  }
  window.addEventListener('keydown', globalKeys)
  onCleanup(() => window.removeEventListener('keydown', globalKeys))

  const startDragging: JSX.EventHandler<HTMLElement, MouseEvent> = event => {
    const target = event.target as HTMLElement
    if (!target.closest('button, input, textarea, select, .attachments, .capture-preview, .settings-panel')) {
      void getCurrentWindow().startDragging()
    }
  }

  return (
      <main class="window-shell" classList={{ expanded: history().length > 0 }} onMouseDown={startDragging} data-tauri-drag-region>
        <section class="content" data-tauri-drag-region>
          <Show when={history().length}>
            <div class="conversation">
              <div class="conversation-bar drag-zone" data-tauri-drag-region>
                <span>Ask Hermes</span>
                <button onClick={openDesktop}>Open in Hermes ↗</button>
              </div>
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
                    <Show when={item.status === 'pending' && !item.answer}>
                      <div class="answer-pending" aria-label="Hermes is thinking"><span /><span /><span /></div>
                    </Show>
                  </article>
                )}
              </For>
            </div>
          </Show>

          <div class="composer" data-tauri-drag-region>
            <div class="brand-mark drag-zone" title="Drag Ask Hermes" data-tauri-drag-region>
              <img src={hermesIcon} alt="Hermes" draggable={false} />
            </div>
            <Show when={captures().length}>
              <div class="attachments" aria-label="Attached screen captures">
                <For each={captures()}>{(capture, index) => (
                <div class="attachment">
                  <button class="attachment-preview" aria-label={`Preview capture ${index() + 1}`} onClick={() => setPreview(capture)}>
                    <img src={capture.data_url} alt={`Screen capture ${index() + 1}`} />
                  </button>
                  <button class="attachment-remove" aria-label={`Remove capture ${index() + 1}`} onClick={() => setCaptures(items => removeCaptureAt(items, index()))}>×</button>
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
            <button class="capture-button" classList={{ capturing: capturing() }} onClick={beginCapture} disabled={busy() || capturing()} title="Select another screen region" aria-label={capturing() ? 'Preparing screen capture' : 'Select screen region'}>
              <Show when={!capturing()} fallback={<span class="capture-spinner" />}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><circle cx="12" cy="12" r="3.25" /><path d="M8 5.5 9.2 3.8h5.6L16 5.5" /></svg>
              </Show>
            </button>
            <button class="send-button" aria-label="Ask Hermes" onClick={submit} disabled={busy() || capturing() || (!prompt().trim() && captures().length === 0)}>
              <Show when={!busy()} fallback={<span class="spinner" />}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M13 7l5 5-5 5" /></svg>
              </Show>
            </button>
          </div>

          <Show when={error()}><div class="error">{error()}</div></Show>
          <Show when={preview()}>{capture => (
            <div class="capture-preview" role="dialog" aria-modal="true" aria-label="Screen capture preview" onMouseDown={event => {
              if (event.target === event.currentTarget) setPreview(undefined)
            }}>
              <img src={capture().data_url} alt="Screen capture preview" />
              <button aria-label="Close capture preview" onClick={() => setPreview(undefined)}>×</button>
            </div>
          )}</Show>
          <Show when={settingsOpen()}>
            <div class="settings-panel" role="dialog" aria-modal="true" aria-label="Ask Hermes settings">
              <div class="settings-header"><span>Settings</span><button aria-label="Close settings" onClick={() => setSettingsOpen(false)}>×</button></div>
              <label>
                Session
                <select value={sessionPreference()} onChange={event => setSessionPreference(event.currentTarget.value)}>
                  <option value={NEW_SESSION}>Always start a new session</option>
                  <For each={sessions()}>
                    {session => <option value={session.id}>{session.title} · {compactTime(session.last_active)}</option>}
                  </For>
                </select>
              </label>
              <label>
                Model
                <select value={model()} onChange={event => setModel(event.currentTarget.value)}>
                  <option value="">Hermes default</option>
                  <option value="gpt-5.6-terra">GPT-5.6 Terra · faster</option>
                  <option value="gpt-5.6-sol">GPT-5.6 Sol · strongest</option>
                </select>
              </label>
              <label>
                Thinking effort
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
              </label>
              <label class="settings-toggle">
                Start with Windows
                <input type="checkbox" checked={startAtLogin()} onChange={event => setStartAtLogin(event.currentTarget.checked)} />
              </label>
              <p>Model and thinking effort apply only when Ask Hermes creates a new session. Existing sessions keep their own settings.</p>
              <button class="settings-save" onClick={applySettings}>Apply</button>
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

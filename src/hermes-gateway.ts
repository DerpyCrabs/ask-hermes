import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createAnswerDeltaBatcher } from './answer-delta-batcher'
import type { TurnActivityKind } from './turn-activity'

export const HERMES_TURN_CANCELLED = 'HERMES_TURN_CANCELLED'

type TurnOptions = {
  exchangeId: string
  prompt: string
  images: string[]
  storedSessionId?: string
  runtimeSessionId?: string
  model?: string
  reasoningEffort?: string
  fast?: boolean
  signal?: AbortSignal
  onDelta(text: string): void
  onActivity(kind: TurnActivityKind, toolName?: string, context?: string): void
  onSession(runtimeSessionId: string, storedSessionId: string): void
}

type SessionStarted = { exchange_id: string; runtime_session_id: string; stored_session_id: string }
type AnswerDelta = { exchange_id: string; text: string }
type TurnActivity = {
  exchange_id: string
  kind: TurnActivityKind
  tool_name?: string
  context?: string
}
export type TurnResult = { answer: string; runtime_session_id: string; stored_session_id: string }

export function sessionStrategy(runtimeSessionId?: string, storedSessionId?: string) {
  if (storedSessionId) return 'resume' as const
  if (runtimeSessionId) return 'reuse' as const
  return 'create' as const
}

export function isHermesTurnCancelled(reason: unknown) {
  return String(reason).includes(HERMES_TURN_CANCELLED)
}

export function hermesTurnErrorMessage(reason: unknown) {
  const message = String(reason).replace(/^Error:\s*/, '')
  const phase = message.match(/HERMES_TIMEOUT:([a-z-]+)/i)?.[1]?.toLowerCase()
  if (!phase) return message
  if (phase === 'startup') return 'Hermes did not start in time. Retry the turn.'
  if (phase === 'connect') return 'Hermes did not accept a connection in time. Retry the turn.'
  if (phase === 'idle') return 'Hermes stopped responding. Any partial answer was preserved; retry when ready.'
  if (phase === 'overall') return 'Hermes turn exceeded its time limit. Partial answer preserved.'
  return 'Hermes request timed out. Retry the turn.'
}

export async function runHermesTurn(options: TurnOptions) {
  if (options.signal?.aborted) throw new Error(HERMES_TURN_CANCELLED)
  const deltas = createAnswerDeltaBatcher(options.onDelta)
  const disposers: Array<() => void> = []
  let cancellationRequested = false
  const cancel = () => {
    if (cancellationRequested) return
    cancellationRequested = true
    deltas.flush()
    // Native side records a bounded tombstone when cancellation arrives before
    // ask_hermes_gateway registration, so one exchange-scoped request is enough.
    void invoke<boolean>('cancel_hermes_turn', { exchangeId: options.exchangeId })
      .catch(() => undefined)
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  try {
    const ensureActive = () => {
      if (!options.signal?.aborted) return
      cancel()
      throw new Error(HERMES_TURN_CANCELLED)
    }
    ensureActive()
    disposers.push(await listen<SessionStarted>('hermes-session-started', event => {
      if (event.payload.exchange_id === options.exchangeId) {
        options.onSession(event.payload.runtime_session_id, event.payload.stored_session_id)
      }
    }))
    ensureActive()
    disposers.push(await listen<AnswerDelta>('hermes-answer-delta', event => {
      if (event.payload.exchange_id === options.exchangeId) deltas.add(event.payload.text)
    }))
    ensureActive()
    disposers.push(await listen<TurnActivity>('hermes-turn-activity', event => {
      if (event.payload.exchange_id === options.exchangeId) {
        options.onActivity(event.payload.kind, event.payload.tool_name, event.payload.context)
      }
    }))
    ensureActive()
    const result = await invoke<TurnResult>('ask_hermes_gateway', {
      request: {
        exchangeId: options.exchangeId,
        prompt: options.prompt,
        imageDataUrls: options.images,
        storedSessionId: options.storedSessionId,
        runtimeSessionId: options.runtimeSessionId,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        fast: options.fast,
      },
    })
    return {
      answer: result.answer,
      runtimeSessionId: result.runtime_session_id,
      storedSessionId: result.stored_session_id,
    }
  } catch (reason) {
    deltas.flush()
    if (options.signal?.aborted || isHermesTurnCancelled(reason)) {
      throw new Error(HERMES_TURN_CANCELLED)
    }
    throw reason
  } finally {
    options.signal?.removeEventListener('abort', cancel)
    deltas.cancel()
    for (const dispose of disposers.reverse()) dispose()
  }
}

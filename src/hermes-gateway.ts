import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

type TurnOptions = {
  exchangeId: string
  prompt: string
  images: string[]
  storedSessionId?: string
  runtimeSessionId?: string
  model?: string
  reasoningEffort?: string
  fast?: boolean
  onDelta(text: string): void
  onSession(runtimeSessionId: string, storedSessionId: string): void
}

type SessionStarted = { exchange_id: string; runtime_session_id: string; stored_session_id: string }
type AnswerDelta = { exchange_id: string; text: string }
export type TurnResult = { answer: string; runtime_session_id: string; stored_session_id: string }

export function sessionStrategy(runtimeSessionId?: string, storedSessionId?: string) {
  if (runtimeSessionId) return 'reuse' as const
  if (storedSessionId) return 'resume' as const
  return 'create' as const
}

export async function runHermesTurn(options: TurnOptions) {
  const disposeSession = await listen<SessionStarted>('hermes-session-started', event => {
    if (event.payload.exchange_id === options.exchangeId) {
      options.onSession(event.payload.runtime_session_id, event.payload.stored_session_id)
    }
  })
  const disposeDelta = await listen<AnswerDelta>('hermes-answer-delta', event => {
    if (event.payload.exchange_id === options.exchangeId) options.onDelta(event.payload.text)
  })
  try {
    const result = await invoke<TurnResult>('ask_hermes_gateway', {
      exchangeId: options.exchangeId,
      prompt: options.prompt,
      imageDataUrls: options.images,
      storedSessionId: options.storedSessionId,
      runtimeSessionId: options.runtimeSessionId,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      fast: options.fast,
    })
    return {
      answer: result.answer,
      runtimeSessionId: result.runtime_session_id,
      storedSessionId: result.stored_session_id,
    }
  } finally {
    disposeSession()
    disposeDelta()
  }
}

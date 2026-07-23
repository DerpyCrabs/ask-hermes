import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { TurnActivityKind } from './turn-activity'

type TurnOptions = {
  instanceId: string
  instanceGeneration: number
  exchangeId: string
  prompt: string
  images: string[]
  storedSessionId?: string
  runtimeSessionId?: string
  model?: string
  reasoningEffort?: string
  fast?: boolean
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

export async function runHermesTurn(options: TurnOptions) {
  const disposeSession = await listen<SessionStarted>('hermes-session-started', event => {
    if (event.payload.exchange_id === options.exchangeId) {
      options.onSession(event.payload.runtime_session_id, event.payload.stored_session_id)
    }
  })
  const disposeDelta = await listen<AnswerDelta>('hermes-answer-delta', event => {
    if (event.payload.exchange_id === options.exchangeId) options.onDelta(event.payload.text)
  })
  const disposeActivity = await listen<TurnActivity>('hermes-turn-activity', event => {
    if (event.payload.exchange_id === options.exchangeId) {
      options.onActivity(event.payload.kind, event.payload.tool_name, event.payload.context)
    }
  })
  try {
    const result = await invoke<TurnResult>('ask_hermes_gateway', {
      request: {
        instanceId: options.instanceId,
        instanceGeneration: options.instanceGeneration,
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
  } finally {
    disposeSession()
    disposeDelta()
    disposeActivity()
  }
}

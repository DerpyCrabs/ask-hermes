import { describe, expect, it } from 'vitest'
import { appendAnswerDelta, beginExchange, finishExchange } from './conversation'

describe('conversation updates', () => {
  it('puts a submitted question in the transcript before an answer exists', () => {
    const items = beginExchange([], { id: 'turn-1', prompt: 'Question', images: [] })
    expect(items).toEqual([{ id: 'turn-1', prompt: 'Question', answer: '', images: [], status: 'pending' }])
  })

  it('streams and completes the same exchange', () => {
    const started = beginExchange([], { id: 'turn-1', prompt: 'Question', images: [] })
    const streamed = appendAnswerDelta(appendAnswerDelta(started, 'turn-1', 'Hel'), 'turn-1', 'lo')
    expect(finishExchange(streamed, 'turn-1', 'Hello')[0]).toMatchObject({ answer: 'Hello', status: 'complete' })
  })
})

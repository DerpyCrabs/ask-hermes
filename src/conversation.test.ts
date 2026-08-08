import { describe, expect, it } from 'vitest'
import {
  appendAnswerDelta,
  beginExchange,
  failExchange,
  finishExchange,
  interruptExchange,
  retryExchange,
} from './conversation'

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

  it('preserves partial output when interrupted and ignores late completion', () => {
    const started = beginExchange([], { id: 'turn-1', prompt: 'Question', images: [] })
    const streamed = appendAnswerDelta(started, 'turn-1', 'Partial')
    const interrupted = interruptExchange(streamed, 'turn-1')

    expect(interrupted[0]).toMatchObject({ answer: 'Partial', status: 'interrupted' })
    expect(appendAnswerDelta(interrupted, 'turn-1', ' late')).toEqual(interrupted)
    expect(finishExchange(interrupted, 'turn-1', 'Late result')).toEqual(interrupted)
  })

  it('keeps failure reason separate from any partial answer', () => {
    const started = beginExchange([], { id: 'turn-1', prompt: 'Question', images: [] })
    expect(failExchange(started, 'turn-1', 'Disconnected')[0]).toMatchObject({
      answer: '',
      error: 'Disconnected',
      status: 'error',
    })

    const streamed = appendAnswerDelta(started, 'turn-1', 'Partial')
    expect(failExchange(streamed, 'turn-1', 'Disconnected')[0]).toMatchObject({
      answer: 'Partial',
      error: 'Disconnected',
      status: 'error',
    })
  })

  it('retries stopped and failed exchanges as new transcript entries', () => {
    const capture = { data_url: 'data:image/png;base64,a', width: 1, height: 1 }
    const started = beginExchange([], { id: 'turn-1', prompt: 'Question', images: [capture] })
    const interrupted = interruptExchange(started, 'turn-1')
    const retried = retryExchange(interrupted, 'turn-1', 'turn-2')

    expect(retried).toHaveLength(2)
    expect(retried[1]).toEqual({
      id: 'turn-2',
      prompt: 'Question',
      answer: '',
      images: [capture],
      status: 'pending',
    })
    expect(retried[1].images).not.toBe(interrupted[0].images)
  })

  it('does not retry a pending or completed exchange', () => {
    const started = beginExchange([], { id: 'turn-1', prompt: 'Question', images: [] })
    expect(retryExchange(started, 'turn-1', 'turn-2')).toBe(started)

    const complete = finishExchange(started, 'turn-1', 'Answer')
    expect(retryExchange(complete, 'turn-1', 'turn-2')).toBe(complete)
  })
})

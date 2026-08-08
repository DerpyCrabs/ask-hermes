import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAnswerDeltaBatcher } from './answer-delta-batcher'

afterEach(() => {
  vi.useRealTimers()
})

describe('answer delta batching', () => {
  it('coalesces a burst in order after 40ms', () => {
    vi.useFakeTimers()
    const updates: string[] = []
    const batcher = createAnswerDeltaBatcher(text => updates.push(text))

    batcher.add('Hel')
    batcher.add('lo')
    vi.advanceTimersByTime(39)
    expect(updates).toEqual([])

    vi.advanceTimersByTime(1)
    expect(updates).toEqual(['Hello'])
  })

  it('flushes immediately and remains ready for later deltas', () => {
    vi.useFakeTimers()
    const updates: string[] = []
    const batcher = createAnswerDeltaBatcher(text => updates.push(text))

    batcher.add('first')
    batcher.flush()
    batcher.add('second')

    expect(updates).toEqual(['first'])
    vi.advanceTimersByTime(40)
    expect(updates).toEqual(['first', 'second'])
  })

  it('cancels pending work and ignores late deltas', () => {
    vi.useFakeTimers()
    const updates: string[] = []
    const batcher = createAnswerDeltaBatcher(text => updates.push(text))

    batcher.add('discard me')
    batcher.cancel()
    batcher.add('late')
    batcher.flush()
    vi.runAllTimers()

    expect(updates).toEqual([])
  })

  it('does not schedule work for empty deltas', () => {
    vi.useFakeTimers()
    const apply = vi.fn()
    const batcher = createAnswerDeltaBatcher(apply)

    batcher.add('')
    vi.runAllTimers()

    expect(apply).not.toHaveBeenCalled()
  })
})

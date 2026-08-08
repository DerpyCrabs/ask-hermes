import { beforeEach, describe, expect, it } from 'vitest'
import {
  browseBackward,
  browseForward,
  deriveUserHistory,
  isBrowsingHistory,
  resetAllBrowseStates,
  resetBrowseState,
} from './composer-history'

beforeEach(resetAllBrowseStates)

describe('composer sent-prompt history', () => {
  const history = ['third', 'second', 'first']

  it('derives non-empty user messages newest first', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: ' ' },
      { role: 'user', content: 'second' },
    ]
    expect(deriveUserHistory(messages, message => message.content)).toEqual(['second', 'first'])
  })

  it('walks backward and restores the unsent draft when returning to present', () => {
    expect(browseBackward('a', 'unsent', history)).toBe('third')
    expect(browseBackward('a', 'ignored', history)).toBe('second')
    expect(browseBackward('a', 'ignored', history)).toBe('first')
    expect(browseBackward('a', 'ignored', history)).toBeUndefined()
    expect(browseForward('a', history)).toBe('second')
    expect(browseForward('a', history)).toBe('third')
    expect(browseForward('a', history)).toBe('unsent')
    expect(isBrowsingHistory('a')).toBe(false)
  })

  it('isolates sessions and resets edited history', () => {
    expect(browseBackward('a', '', history)).toBe('third')
    expect(browseBackward('b', 'draft-b', ['only-b'])).toBe('only-b')
    resetBrowseState('a')
    expect(browseForward('a', history)).toBeUndefined()
    expect(browseForward('b', ['only-b'])).toBe('draft-b')
  })
})

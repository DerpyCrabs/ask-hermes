import { describe, expect, it } from 'vitest'
import { SearchNavigationGuard, searchResolutionRequest } from './search'
import type { SearchResult } from './types'

const result = (overrides: Partial<SearchResult> = {}): SearchResult => ({
  sessionId: 'session-1',
  profileId: 'work',
  title: 'Search chat',
  excerpt: 'before >>>needle<<< after',
  source: 'desktop',
  archived: false,
  timestamp: '2026-07-22T00:00:00Z',
  resolver: { kind: 'message', query: 'needle', excerpt: 'before >>>needle<<< after', role: 'user' },
  ...overrides,
})

describe('search-result navigation', () => {
  it('resolves only legacy message hits that lack an exact Gateway id', () => {
    expect(searchResolutionRequest(result({ messageId: '42' }))).toBeUndefined()
    expect(searchResolutionRequest(result({ resolver: undefined }))).toBeUndefined()
    expect(searchResolutionRequest(result())).toEqual({
      profileId: 'work',
      sessionId: 'session-1',
      resolver: { kind: 'message', query: 'needle', excerpt: 'before >>>needle<<< after', role: 'user' },
    })
  })

  it('invalidates stale result opens after replacement or cancellation', () => {
    const guard = new SearchNavigationGuard()
    const first = guard.begin()
    const second = guard.begin()
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(second)).toBe(true)
    guard.cancel()
    expect(guard.isCurrent(second)).toBe(false)
  })
})

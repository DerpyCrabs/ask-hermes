import { describe, expect, it } from 'vitest'
import { sessionsEqual, type SessionRecord } from './sessions'

const session = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: 'one', title: 'One', preview: 'Question', started_at: 1, last_active: 2, ...overrides,
})

describe('session list equality', () => {
  it('keeps an identical polled list stable', () => {
    expect(sessionsEqual([session()], [session()])).toBe(true)
  })

  it('detects title, activity, and ordering changes', () => {
    expect(sessionsEqual([session()], [session({ title: 'Renamed' })])).toBe(false)
    expect(sessionsEqual([session()], [session({ last_active: 3 })])).toBe(false)
    expect(sessionsEqual([session(), session({ id: 'two' })], [session({ id: 'two' }), session()])).toBe(false)
  })
})

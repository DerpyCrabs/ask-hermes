import { describe, expect, it } from 'vitest'
import { shouldRememberPreviousChat } from './previous-chat'

describe('previous chat origin', () => {
  it('remembers Alt+Space conversations', () => {
    expect(shouldRememberPreviousChat(2, false)).toBe(true)
  })

  it('never replaces previous chat with a session-shortcut conversation', () => {
    expect(shouldRememberPreviousChat(2, true)).toBe(false)
    expect(shouldRememberPreviousChat(0, false)).toBe(false)
  })
})

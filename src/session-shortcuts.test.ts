import { describe, expect, it } from 'vitest'
import { shortcutFromKeyboardEvent, shortcutTextsMatch, shouldPreserveSessionShortcutContext, transcriptFromMessages } from './session-shortcuts'

describe('session shortcuts', () => {
  it('formats modified keys for the native shortcut parser', () => {
    expect(shortcutFromKeyboardEvent({ key: 'h', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })).toBe('Ctrl+Alt+H')
    expect(shortcutFromKeyboardEvent({ key: 'F8', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false })).toBe('Shift+F8')
    expect(shortcutFromKeyboardEvent({ key: ' ', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false })).toBe('Alt+Space')
    expect(shortcutFromKeyboardEvent({ key: 'k', ctrlKey: false, altKey: false, shiftKey: false, metaKey: true })).toBe('Super+K')
    expect(shortcutFromKeyboardEvent({ key: '!', code: 'Digit1', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false })).toBe('Ctrl+Shift+1')
    expect(shortcutFromKeyboardEvent({ key: 'layout-dependent', code: 'KeyA', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBe('Ctrl+A')
  })

  it('rejects bare keys and modifier-only input', () => {
    expect(shortcutFromKeyboardEvent({ key: 'h', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })).toBeUndefined()
    expect(shortcutFromKeyboardEvent({ key: 'Control', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBeUndefined()
  })

  it('preserves meaningful state only when reopening the same session', () => {
    expect(shouldPreserveSessionShortcutContext('session-1', 'session-1', true)).toBe(true)
    expect(shouldPreserveSessionShortcutContext('session-1', 'session-2', true)).toBe(false)
    expect(shouldPreserveSessionShortcutContext('session-1', 'session-1', false)).toBe(false)
  })

  it('matches equivalent shortcut text independent of modifier order and case', () => {
    expect(shortcutTextsMatch('Alt+Space', 'space + ALT')).toBe(true)
    expect(shortcutTextsMatch('Ctrl+Alt+H', 'Alt+Ctrl+H')).toBe(true)
    expect(shortcutTextsMatch('Alt+Space', 'Ctrl+Space')).toBe(false)
  })

  it('builds a complete chat transcript from stored messages', () => {
    const transcript = transcriptFromMessages([
      { id: 1, role: 'user', content: 'First' },
      { id: 2, role: 'assistant', content: 'Answer one' },
      { id: 3, role: 'user', content: 'Second' },
      { id: 4, role: 'assistant', content: 'Answer two' },
    ])
    expect(transcript.map(({ prompt, answer }) => ({ prompt, answer }))).toEqual([
      { prompt: 'First', answer: 'Answer one' },
      { prompt: 'Second', answer: 'Answer two' },
    ])
  })
})

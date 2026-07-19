import { describe, expect, it } from 'vitest'
import { shortcutFromKeyboardEvent, transcriptFromMessages } from './session-shortcuts'

describe('session shortcuts', () => {
  it('formats modified keys for the native shortcut parser', () => {
    expect(shortcutFromKeyboardEvent({ key: 'h', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })).toBe('Ctrl+Alt+H')
    expect(shortcutFromKeyboardEvent({ key: 'F8', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false })).toBe('Shift+F8')
  })

  it('rejects bare keys and modifier-only input', () => {
    expect(shortcutFromKeyboardEvent({ key: 'h', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })).toBeUndefined()
    expect(shortcutFromKeyboardEvent({ key: 'Control', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBeUndefined()
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

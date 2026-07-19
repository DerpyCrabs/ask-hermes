import { describe, expect, it } from 'vitest'
import { autostartAction } from './autostart'

describe('Windows startup preference', () => {
  it('enables startup only when requested', () => {
    expect(autostartAction(false, true)).toBe('enable')
  })

  it('disables startup only when requested', () => {
    expect(autostartAction(true, false)).toBe('disable')
  })

  it('does nothing when the setting is unchanged', () => {
    expect(autostartAction(true, true)).toBe('none')
    expect(autostartAction(false, false)).toBe('none')
  })
})

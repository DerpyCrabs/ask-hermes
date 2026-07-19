import { describe, expect, it } from 'vitest'
import { NEW_SESSION, newSessionSetting, normalizeSelection, sourceRect } from './selection'

describe('normalizeSelection', () => {
  const sessions = [{ id: 'latest' }, { id: 'older' }]

  it('keeps a remembered session', () => {
    expect(normalizeSelection('older', sessions)).toBe('older')
  })

  it('keeps the explicit new-session choice', () => {
    expect(normalizeSelection(NEW_SESSION, sessions)).toBe(NEW_SESSION)
  })

  it('falls back to a new session instead of silently choosing the latest session', () => {
    expect(normalizeSelection('deleted', sessions)).toBe(NEW_SESSION)
  })

  it('falls back to new when Hermes has no sessions', () => {
    expect(normalizeSelection('', [])).toBe(NEW_SESSION)
  })
})

describe('newSessionSetting', () => {
  it('applies a model or effort only while creating a new session', () => {
    expect(newSessionSetting(NEW_SESSION, 'low')).toBe('low')
    expect(newSessionSetting('existing-session', 'low')).toBeNull()
  })
})

describe('sourceRect', () => {
  it('maps a CSS selection into physical screenshot pixels', () => {
    expect(
      sourceRect(
        { x: 100, y: 50, width: 200, height: 100 },
        { x: 0, y: 0, width: 800, height: 400 },
        { width: 2400, height: 1200 }
      )
    ).toEqual({ x: 300, y: 150, width: 600, height: 300 })
  })

  it('never creates a zero-sized crop', () => {
    expect(sourceRect({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 800, height: 400 }, { width: 800, height: 400 }))
      .toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })
})

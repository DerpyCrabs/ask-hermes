import { describe, expect, it } from 'vitest'
import {
  applySettingsToStorage,
  mergeLegacyPromptShortcut,
  settingsFromStorage,
} from './settings-config'

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  }
}

describe('persistent settings', () => {
  it('copies known settings without unrelated local storage', () => {
    const storage = memoryStorage({
      'ask-hermes.model': 'custom',
      'ask-hermes.prompt-shortcut.v1': 'Ctrl+Alt+H',
      unrelated: 'keep-local',
    })
    expect(settingsFromStorage(storage).values).toEqual({
      'ask-hermes.model': 'custom',
      'ask-hermes.prompt-shortcut.v1': 'Ctrl+Alt+H',
    })
  })

  it('treats config file as authoritative for known settings', () => {
    const storage = memoryStorage({
      'ask-hermes.model': 'stale',
      'ask-hermes.fast-mode': 'true',
      unrelated: 'keep',
    })
    applySettingsToStorage({ version: 1, values: { 'ask-hermes.model': 'saved' } }, storage)
    expect(storage.values.get('ask-hermes.model')).toBe('saved')
    expect(storage.values.has('ask-hermes.fast-mode')).toBe(false)
    expect(storage.values.get('unrelated')).toBe('keep')
  })

  it('merges legacy prompt shortcut without replacing central settings', () => {
    const central = {
      version: 1 as const,
      values: {
        'ask-hermes.model': 'gpt-5.2',
        'ask-hermes.fast-mode': 'true',
      },
    }
    const merged = mergeLegacyPromptShortcut(central, 'Ctrl+Alt+H')

    expect(merged.changed).toBe(true)
    expect(merged.settings.values).toEqual({
      ...central.values,
      'ask-hermes.prompt-shortcut.v1': 'Ctrl+Alt+H',
    })
  })

  it('keeps explicit central or local prompt shortcut over legacy value', () => {
    const central = {
      version: 1 as const,
      values: {
        'ask-hermes.model': 'gpt-5.2',
        'ask-hermes.prompt-shortcut.v1': 'Shift+F8',
      },
    }
    expect(mergeLegacyPromptShortcut(central, 'Ctrl+Alt+H')).toEqual({
      settings: central,
      changed: false,
    })

    const local = settingsFromStorage(memoryStorage({
      'ask-hermes.prompt-shortcut.v1': 'Ctrl+Space',
    }))
    expect(mergeLegacyPromptShortcut(local, 'Ctrl+Alt+H')).toEqual({
      settings: local,
      changed: false,
    })
  })
})

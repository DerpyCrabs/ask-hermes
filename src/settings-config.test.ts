import { describe, expect, it } from 'vitest'
import { applySettingsToStorage, settingsFromStorage } from './settings-config'

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
    const storage = memoryStorage({ 'ask-hermes.model': 'custom', unrelated: 'keep-local' })
    expect(settingsFromStorage(storage).values).toEqual({ 'ask-hermes.model': 'custom' })
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
})

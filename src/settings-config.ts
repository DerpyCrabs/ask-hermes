import { invoke } from '@tauri-apps/api/core'
import { ACTIVE_INSTANCE_KEY, INSTANCES_KEY } from './instances'
import { WORKSPACE_NOTIFICATIONS_KEY } from './workspace/notifications'

export const PERSISTENT_SETTING_KEYS = [
  'ask-hermes.session-preference.v2',
  'ask-hermes.model',
  'ask-hermes.reasoning-effort',
  'ask-hermes.fast-mode',
  'ask-hermes.prompt-shortcut.v1',
  'ask-hermes.session-shortcuts.v1',
  'ask-hermes.voice-provider',
  'ask-hermes.speaches-force-english',
  'ask-hermes.voice-auto-start',
  'ask-hermes.instance.address',
  'ask-hermes.instance.port',
  'ask-hermes.instance.remote',
  'ask-hermes.instance.token',
  'ask-hermes.tray-link-mode.v1',
  INSTANCES_KEY,
  ACTIVE_INSTANCE_KEY,
  WORKSPACE_NOTIFICATIONS_KEY,
] as const

export type PersistedSettings = {
  version: 1
  values: Record<string, string>
}

type LoadedSettings = {
  settings: PersistedSettings | null
  migrateLocalStorage: boolean
}

export function settingsFromStorage(storage: Pick<Storage, 'getItem'>): PersistedSettings {
  return {
    version: 1,
    values: Object.fromEntries(PERSISTENT_SETTING_KEYS.flatMap(key => {
      const value = storage.getItem(key)
      return value === null ? [] : [[key, value]]
    })),
  }
}

export function applySettingsToStorage(
  settings: PersistedSettings,
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
) {
  for (const key of PERSISTENT_SETTING_KEYS) {
    const value = settings.values[key]
    if (typeof value === 'string') storage.setItem(key, value)
    else storage.removeItem(key)
  }
}

export async function hydratePersistentSettings(storage: Storage = localStorage) {
  const loaded = await invoke<LoadedSettings>('load_settings')
  if (loaded.settings) {
    applySettingsToStorage(loaded.settings, storage)
    return
  }
  const initial = loaded.migrateLocalStorage ? settingsFromStorage(storage) : { version: 1 as const, values: {} }
  if (!loaded.migrateLocalStorage) applySettingsToStorage(initial, storage)
  await invoke('save_settings', { settings: initial })
}

export function savePersistentSettings(settings: PersistedSettings) {
  return invoke<void>('save_settings', { settings })
}

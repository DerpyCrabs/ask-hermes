import { invoke } from '@tauri-apps/api/core'

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
] as const

export type PersistedSettings = {
  version: 1
  values: Record<string, string>
}

type LoadedSettings = {
  settings: PersistedSettings | null
  migrateLocalStorage: boolean
  legacyPromptShortcut: string | null
  profileKey: string
}

const PROMPT_SHORTCUT_SETTING_KEY = 'ask-hermes.prompt-shortcut.v1'
let hydratedSettingsProfileKey = 'default-v1'

export function currentSettingsProfileKey() {
  return hydratedSettingsProfileKey
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

export function mergeLegacyPromptShortcut(
  settings: PersistedSettings,
  legacyPromptShortcut: string | null,
): { settings: PersistedSettings; changed: boolean } {
  if (
    !legacyPromptShortcut
    || Object.prototype.hasOwnProperty.call(settings.values, PROMPT_SHORTCUT_SETTING_KEY)
  ) {
    return { settings, changed: false }
  }
  return {
    settings: {
      version: 1,
      values: {
        ...settings.values,
        [PROMPT_SHORTCUT_SETTING_KEY]: legacyPromptShortcut,
      },
    },
    changed: true,
  }
}

export async function hydratePersistentSettings(storage: Storage = localStorage) {
  const loaded = await invoke<LoadedSettings>('load_settings')
  hydratedSettingsProfileKey = loaded.profileKey
  if (loaded.settings) {
    const merged = mergeLegacyPromptShortcut(loaded.settings, loaded.legacyPromptShortcut)
    applySettingsToStorage(merged.settings, storage)
    if (merged.changed) await invoke('save_settings', { settings: merged.settings })
    return
  }
  const initial = loaded.migrateLocalStorage
    ? settingsFromStorage(storage)
    : { version: 1 as const, values: {} }
  const merged = mergeLegacyPromptShortcut(initial, loaded.legacyPromptShortcut)
  applySettingsToStorage(merged.settings, storage)
  await invoke('save_settings', { settings: merged.settings })
}

export function savePersistentSettings(settings: PersistedSettings) {
  return invoke<void>('save_settings', { settings })
}

import { buildHermesInstanceConfig, type HermesInstanceConfig } from './hermes-instance'
import { workspaceText as text } from './workspace/strings'

export const INSTANCES_KEY = 'ask-hermes.instances.v1'
export const ACTIVE_INSTANCE_KEY = 'ask-hermes.active-instance.v1'
export const AUTOMATIC_INSTANCE_ID = 'automatic-hermes'

export type SavedHermesInstance = {
  id: string
  name: string
  mode: 'automatic' | 'existing'
  address: string
  port: number
  token: string
}

export const automaticHermesInstance = (): SavedHermesInstance => ({
  id: AUTOMATIC_INSTANCE_ID,
  name: text.automaticHermes,
  mode: 'automatic',
  address: '127.0.0.1',
  port: 0,
  token: '',
})

function normalizedInstance(value: unknown): SavedHermesInstance | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<SavedHermesInstance>
  if (typeof candidate.id !== 'string' || !candidate.id.trim()) return undefined
  if (candidate.mode !== 'automatic' && candidate.mode !== 'existing') return undefined
  const port = Number(candidate.port)
  if (candidate.mode === 'existing' && (!Number.isInteger(port) || port < 1 || port > 65535)) return undefined
  const address = typeof candidate.address === 'string' ? candidate.address.trim() : ''
  if (candidate.mode === 'existing' && !address) return undefined
  return {
    id: candidate.id.trim(),
    name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : text.hermesInstance,
    mode: candidate.mode,
    address: candidate.mode === 'automatic' ? '127.0.0.1' : address,
    port: candidate.mode === 'automatic' ? 0 : port,
    token: typeof candidate.token === 'string' ? candidate.token.trim() : '',
  }
}

export function parseSavedInstances(raw: string | null): SavedHermesInstance[] {
  let values: unknown
  try {
    values = JSON.parse(raw || '[]')
  } catch {
    values = []
  }
  const parsed = Array.isArray(values)
    ? values.map(normalizedInstance).filter((item): item is SavedHermesInstance => Boolean(item))
    : []
  const unique = new Map(parsed.map(instance => [instance.id, instance]))
  unique.set(AUTOMATIC_INSTANCE_ID, automaticHermesInstance())
  return [...unique.values()]
}

export function activeSavedInstance(instances: SavedHermesInstance[], requestedId: string | null) {
  return instances.find(instance => instance.id === requestedId)
    || instances.find(instance => instance.id === AUTOMATIC_INSTANCE_ID)
    || automaticHermesInstance()
}

export function instanceConfig(instance: SavedHermesInstance): HermesInstanceConfig {
  return buildHermesInstanceConfig(
    instance.mode === 'existing',
    instance.address,
    String(instance.port),
    instance.token,
    instance.id,
    instance.name,
  )
}

export function canSwitchInstance(activeTurnCount: number, queuedPromptCount: number) {
  return activeTurnCount === 0 && queuedPromptCount === 0
}

export function instanceStorageScope(instanceId: string, profile: string, sessionId?: string) {
  return [instanceId, profile || 'default', sessionId || '_'].map(encodeURIComponent).join(':')
}

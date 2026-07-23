import { describe, expect, it } from 'vitest'
import {
  AUTOMATIC_INSTANCE_ID,
  activeSavedInstance,
  canSwitchInstance,
  instanceConfig,
  instanceStorageScope,
  parseSavedInstances,
} from './instances'

describe('saved Hermes instances', () => {
  it('always includes the automatic Hermes connection', () => {
    expect(parseSavedInstances(null)).toEqual([
      expect.objectContaining({ id: AUTOMATIC_INSTANCE_ID, mode: 'automatic' }),
    ])
  })

  it('keeps valid named instances and drops unsafe shapes', () => {
    const parsed = parseSavedInstances(JSON.stringify([
      { id: 'derp', name: 'Local derp', mode: 'existing', address: '127.0.0.1', port: 9120, token: '' },
      { id: 'bad', name: 'Bad', mode: 'existing', address: '', port: 0 },
    ]))
    expect(parsed.map(item => item.id)).toEqual(['derp', AUTOMATIC_INSTANCE_ID])
  })

  it('falls back to automatic when selected id disappeared', () => {
    const selected = activeSavedInstance(parseSavedInstances('[]'), 'missing')
    expect(selected.id).toBe(AUTOMATIC_INSTANCE_ID)
  })

  it('maps existing and automatic entries to current backend config', () => {
    const auto = activeSavedInstance(parseSavedInstances(null), AUTOMATIC_INSTANCE_ID)
    expect(instanceConfig(auto)).toEqual({
      remote: false, address: '127.0.0.1', port: 0, token: '',
      instanceId: AUTOMATIC_INSTANCE_ID, instanceName: 'Automatic Hermes',
    })
    expect(instanceConfig({ id: 'x', name: 'x', mode: 'existing', address: '::1', port: 9119, token: 't' }))
      .toEqual({ remote: true, address: '::1', port: 9119, token: 't', instanceId: 'x', instanceName: 'x' })
  })

  it('blocks instance switching during active or queued work', () => {
    expect(canSwitchInstance(0, 0)).toBe(true)
    expect(canSwitchInstance(1, 0)).toBe(false)
    expect(canSwitchInstance(0, 1)).toBe(false)
  })

  it('keys persisted UI state by instance, profile, and session', () => {
    expect(instanceStorageScope('remote 1', 'work', 'chat/a')).toBe('remote%201:work:chat%2Fa')
  })
})

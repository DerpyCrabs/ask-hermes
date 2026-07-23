import { describe, expect, it } from 'vitest'
import { buildHermesInstanceConfig } from './hermes-instance'

describe('Hermes instance configuration', () => {
  it('keeps local connection configuration internal', () => {
    expect(buildHermesInstanceConfig(false, '', '', '')).toEqual({
      remote: false,
      address: '127.0.0.1',
      port: 0,
      token: '',
      instanceId: 'automatic-hermes',
      instanceName: 'Automatic Hermes',
    })
  })

  it('normalizes a remote instance', () => {
    expect(buildHermesInstanceConfig(true, ' hermes.lan ', ' 9119 ', ' secret ')).toEqual({
      remote: true,
      address: 'hermes.lan',
      port: 9119,
      token: 'secret',
      instanceId: 'existing:hermes.lan:9119',
      instanceName: 'Existing Hermes instance',
    })
  })

  it('preserves the saved connection identity for scoped workspace state', () => {
    expect(buildHermesInstanceConfig(true, 'host', '9119', '', 'derp-local', 'Local derp-agent')).toMatchObject({
      instanceId: 'derp-local',
      instanceName: 'Local derp-agent',
    })
  })

  it('rejects invalid remote endpoints and allows no token', () => {
    expect(() => buildHermesInstanceConfig(true, 'http://host', '9119', 'secret')).toThrow('hostname')
    expect(() => buildHermesInstanceConfig(true, 'host', '0', 'secret')).toThrow('port')
    expect(buildHermesInstanceConfig(true, 'host', '9119', '').token).toBe('')
  })
})

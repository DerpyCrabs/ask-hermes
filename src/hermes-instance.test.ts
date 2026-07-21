import { describe, expect, it } from 'vitest'
import { buildHermesInstanceConfig } from './hermes-instance'

describe('Hermes instance configuration', () => {
  it('keeps local connection configuration internal', () => {
    expect(buildHermesInstanceConfig(false, '', '', '')).toEqual({
      remote: false,
      address: '127.0.0.1',
      port: 0,
      token: '',
    })
  })

  it('normalizes a remote instance', () => {
    expect(buildHermesInstanceConfig(true, ' hermes.lan ', ' 9119 ', ' secret ')).toEqual({
      remote: true,
      address: 'hermes.lan',
      port: 9119,
      token: 'secret',
    })
  })

  it('rejects incomplete remote configuration', () => {
    expect(() => buildHermesInstanceConfig(true, 'http://host', '9119', 'secret')).toThrow('hostname')
    expect(() => buildHermesInstanceConfig(true, 'host', '0', 'secret')).toThrow('port')
    expect(() => buildHermesInstanceConfig(true, 'host', '9119', '')).toThrow('session token')
  })
})

import { describe, expect, it } from 'vitest'
import {
  HERMES_TURN_CANCELLED,
  hermesTurnErrorMessage,
  isHermesTurnCancelled,
  sessionStrategy,
} from './hermes-gateway'

describe('Hermes session routing', () => {
  it('revalidates a stored session instead of trusting a cached runtime ID', () => {
    expect(sessionStrategy('runtime-1', 'stored-1')).toBe('resume')
  })

  it('uses a runtime only without a stored ID and creates without either ID', () => {
    expect(sessionStrategy(undefined, 'stored-1')).toBe('resume')
    expect(sessionStrategy('runtime-1')).toBe('reuse')
    expect(sessionStrategy()).toBe('create')
  })

  it('recognizes native and wrapped cancellation errors', () => {
    expect(isHermesTurnCancelled(HERMES_TURN_CANCELLED)).toBe(true)
    expect(isHermesTurnCancelled(new Error(`invoke failed: ${HERMES_TURN_CANCELLED}`))).toBe(true)
    expect(isHermesTurnCancelled(new Error('Disconnected'))).toBe(false)
  })

  it('turns timeout codes into actionable messages', () => {
    expect(hermesTurnErrorMessage('HERMES_TIMEOUT:startup')).toContain('did not start')
    expect(hermesTurnErrorMessage(new Error('HERMES_TIMEOUT:idle'))).toContain('partial answer was preserved')
    expect(hermesTurnErrorMessage('Disconnected')).toBe('Disconnected')
  })
})

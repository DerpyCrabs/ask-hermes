import { describe, expect, it } from 'vitest'
import { handoffPayloadMatches, handoffResultMatchesPending, handoffSourceRevisionIsCurrent, handoffTargetMatchesSnapshot } from './handoff'

const pending = {
  id: 'handoff-1', instanceId: 'instance-a', instanceGeneration: 4,
  promptGeneration: 8, composerRevision: 3,
}

describe('workspace handoff fencing', () => {
  it('never accepts a target from another instance generation', () => {
    const target = { instanceId: 'instance-a', instanceGeneration: 4 }
    const snapshot = { instance: { id: 'instance-a' }, instanceGeneration: 4 }
    expect(handoffTargetMatchesSnapshot(target, snapshot as never)).toBe(true)
    expect(handoffTargetMatchesSnapshot({ ...target, instanceGeneration: 5 }, snapshot as never)).toBe(false)
    expect(handoffTargetMatchesSnapshot({ ...target, instanceId: 'instance-b' }, snapshot as never)).toBe(false)
  })

  it('requires matching id, scope, prompt generation, and composer revision', () => {
    const result = { handoffId: 'handoff-1', instanceId: 'instance-a', instanceGeneration: 4, status: 'success' as const }
    expect(handoffResultMatchesPending(pending, result)).toBe(true)
    expect(handoffResultMatchesPending(pending, { ...result, instanceGeneration: 5 })).toBe(false)
    expect(handoffSourceRevisionIsCurrent(pending, 8, 3)).toBe(true)
    expect(handoffSourceRevisionIsCurrent(pending, 9, 3)).toBe(false)
    expect(handoffSourceRevisionIsCurrent(pending, 8, 4)).toBe(false)
  })

  it('reuses a failed handoff identity only for the exact prompt and captures', () => {
    const failed = { prompt: 'original', captures: [{ data_url: 'data:image/png;base64,one' }] }
    expect(handoffPayloadMatches(failed, 'original', failed.captures)).toBe(true)
    expect(handoffPayloadMatches(failed, 'changed', failed.captures)).toBe(false)
    expect(handoffPayloadMatches(failed, 'original', [{ data_url: 'data:image/png;base64,two' }])).toBe(false)
  })
})

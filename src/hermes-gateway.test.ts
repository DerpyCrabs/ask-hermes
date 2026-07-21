import { describe, expect, it } from 'vitest'
import { sessionStrategy } from './hermes-gateway'

describe('Hermes session routing', () => {
  it('revalidates a stored session instead of trusting a cached runtime ID', () => {
    expect(sessionStrategy('runtime-1', 'stored-1')).toBe('resume')
  })

  it('uses a runtime only without a stored ID and creates without either ID', () => {
    expect(sessionStrategy(undefined, 'stored-1')).toBe('resume')
    expect(sessionStrategy('runtime-1')).toBe('reuse')
    expect(sessionStrategy()).toBe('create')
  })
})

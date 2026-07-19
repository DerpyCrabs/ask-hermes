import { describe, expect, it } from 'vitest'
import { sessionStrategy } from './hermes-gateway'

describe('Hermes session routing', () => {
  it('reuses the live session for follow-up questions', () => {
    expect(sessionStrategy('runtime-1', 'stored-1')).toBe('reuse')
  })

  it('resumes a selected stored session and creates only without either ID', () => {
    expect(sessionStrategy(undefined, 'stored-1')).toBe('resume')
    expect(sessionStrategy()).toBe('create')
  })
})

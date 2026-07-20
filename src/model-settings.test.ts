import { describe, expect, it } from 'vitest'
import { supportsFastMode } from './model-settings'

describe('fast mode availability', () => {
  it('is offered for explicit GPT models', () => {
    expect(supportsFastMode('gpt-5.6-terra')).toBe(true)
    expect(supportsFastMode('GPT-5.6-sol')).toBe(true)
  })

  it('is not offered when the model is unknown or non-GPT', () => {
    expect(supportsFastMode('')).toBe(false)
    expect(supportsFastMode('claude-opus')).toBe(false)
  })
})

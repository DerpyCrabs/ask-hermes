import { describe, expect, it } from 'vitest'
import { COMPOSER_MAX_HEIGHT, COMPOSER_MIN_HEIGHT, boundedComposerHeight } from './composer-height'

describe('composer height', () => {
  it('grows between its single-line and six-line bounds', () => {
    expect(boundedComposerHeight(12)).toBe(COMPOSER_MIN_HEIGHT)
    expect(boundedComposerHeight(97.2)).toBe(98)
    expect(boundedComposerHeight(400)).toBe(COMPOSER_MAX_HEIGHT)
  })

  it('uses the minimum for invalid measurements', () => {
    expect(boundedComposerHeight(Number.NaN)).toBe(COMPOSER_MIN_HEIGHT)
  })
})

import { describe, expect, it } from 'vitest'
import { formatTurnActivity } from './turn-activity'

describe('formatTurnActivity', () => {
  it('describes model phases', () => {
    expect(formatTurnActivity('thinking')).toBe('Thinking…')
    expect(formatTurnActivity('writing')).toBe('Writing answer…')
  })

  it('makes tool names readable and includes Hermes context', () => {
    expect(formatTurnActivity('tool', 'web_search', 'weather in Moscow')).toBe(
      'Running web search · weather in Moscow',
    )
    expect(formatTurnActivity('tool', 'terminal_tool')).toBe('Running terminal tool…')
  })
})

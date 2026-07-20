export type TurnActivityKind = 'thinking' | 'tool' | 'writing'

function readableToolName(name = '') {
  return name
    .replace(/^mcp[_:.\/-]*/i, '')
    .replace(/[_.:/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function formatTurnActivity(kind: TurnActivityKind, toolName?: string, context?: string) {
  if (kind === 'writing') return 'Writing answer…'
  if (kind === 'thinking') return 'Thinking…'

  const name = readableToolName(toolName) || 'tool'
  const detail = context?.trim()
  return detail ? `Running ${name} · ${detail}` : `Running ${name}…`
}

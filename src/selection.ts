export type SessionChoice = { id: string }
export type Rect = { x: number; y: number; width: number; height: number }

export const NEW_SESSION = '__new__'

export function normalizeSelection(remembered: string, sessions: SessionChoice[]) {
  if (remembered === NEW_SESSION) return NEW_SESSION
  if (remembered && sessions.some(session => session.id === remembered)) return remembered
  return NEW_SESSION
}

export function newSessionSetting<T>(activeSession: string, value: T): T | null {
  return activeSession === NEW_SESSION ? value : null
}

export function sourceRect(region: Rect, surface: Rect, source: { width: number; height: number }): Rect {
  return {
    x: Math.round((region.x / surface.width) * source.width),
    y: Math.round((region.y / surface.height) * source.height),
    width: Math.max(1, Math.round((region.width / surface.width) * source.width)),
    height: Math.max(1, Math.round((region.height / surface.height) * source.height))
  }
}

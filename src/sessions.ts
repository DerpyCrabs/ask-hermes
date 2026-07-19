export type SessionRecord = {
  id: string
  title: string
  preview: string
  started_at: number
  last_active: number
}

export function sessionsEqual(current: SessionRecord[], incoming: SessionRecord[]) {
  return current.length === incoming.length && current.every((session, index) => {
    const next = incoming[index]
    return session.id === next.id
      && session.title === next.title
      && session.preview === next.preview
      && session.started_at === next.started_at
      && session.last_active === next.last_active
  })
}

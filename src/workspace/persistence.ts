import type { AttachmentRef, SessionClientState, WorkspaceNavigation, WorkspaceSelection } from './types'

export const WORKSPACE_UI_KEY = 'ask-hermes.workspace-ui.v1'

export type PersistedWorkspaceUi = {
  version: 1
  instanceId?: string
  lastProfileId?: string
  lastConcreteProfileId?: string
  lastSelection: WorkspaceSelection
  navigation: WorkspaceNavigation
  sidebarCollapsed: boolean
  expandedSections: string[]
  pinnedSessions: string[]
  sessions: Record<string, SessionClientState>
}

export const defaultWorkspaceUi = (): PersistedWorkspaceUi => ({
  version: 1,
  lastSelection: { kind: 'none' },
  navigation: 'chats',
  sidebarCollapsed: false,
  expandedSections: ['pinned', 'recent', 'schedules'],
  pinnedSessions: [],
  sessions: {},
})

const validSelection = (value: unknown): value is WorkspaceSelection => {
  if (!value || typeof value !== 'object') return false
  const selection = value as Partial<WorkspaceSelection> & { profileId?: unknown; id?: unknown }
  if (selection.kind === 'none') return true
  return (selection.kind === 'chat' || selection.kind === 'schedule')
    && typeof selection.profileId === 'string'
    && typeof selection.id === 'string'
}

const attachmentIsPersistent = (attachment: AttachmentRef) =>
  attachment.state === 'ready' && Boolean(attachment.id)

const persistentAttachment = (attachment: AttachmentRef): AttachmentRef => ({
  ...attachment,
  // Blob/data previews contain local bytes or are invalid after restart. Gateway URL is authoritative.
  previewUrl: undefined,
})

export function sanitizeClientState(value?: Partial<SessionClientState>): SessionClientState {
  return {
    draft: typeof value?.draft === 'string' ? value.draft : '',
    queue: Array.isArray(value?.queue)
      ? value.queue.filter(entry => entry && typeof entry.id === 'string' && typeof entry.text === 'string').map(entry => ({
          ...entry,
          attachments: Array.isArray(entry.attachments) ? entry.attachments.filter(attachmentIsPersistent).map(persistentAttachment) : [],
        }))
      : [],
    attachments: Array.isArray(value?.attachments) ? value.attachments.filter(attachmentIsPersistent).map(persistentAttachment) : [],
  }
}

export function parseWorkspaceUi(raw: string | null): PersistedWorkspaceUi {
  if (!raw) return defaultWorkspaceUi()
  try {
    const value = JSON.parse(raw) as Partial<PersistedWorkspaceUi>
    if (value.version !== 1) return defaultWorkspaceUi()
    const sessions: Record<string, SessionClientState> = {}
    if (value.sessions && typeof value.sessions === 'object') {
      for (const [key, state] of Object.entries(value.sessions)) sessions[key] = sanitizeClientState(state)
    }
    const navigation: WorkspaceNavigation = ['chats', 'archived', 'search', 'schedules'].includes(value.navigation || '')
      ? value.navigation as WorkspaceNavigation
      : 'chats'
    return {
      version: 1,
      instanceId: typeof value.instanceId === 'string' ? value.instanceId : undefined,
      lastProfileId: typeof value.lastProfileId === 'string' ? value.lastProfileId : undefined,
      lastConcreteProfileId: typeof value.lastConcreteProfileId === 'string' ? value.lastConcreteProfileId : undefined,
      lastSelection: validSelection(value.lastSelection) ? value.lastSelection : { kind: 'none' },
      navigation,
      sidebarCollapsed: value.sidebarCollapsed === true,
      expandedSections: Array.isArray(value.expandedSections)
        ? value.expandedSections.filter((item): item is string => typeof item === 'string')
        : defaultWorkspaceUi().expandedSections,
      pinnedSessions: Array.isArray(value.pinnedSessions)
        ? value.pinnedSessions.filter((item): item is string => typeof item === 'string')
        : [],
      sessions,
    }
  } catch {
    return defaultWorkspaceUi()
  }
}

export function readWorkspaceUi(storage: Pick<Storage, 'getItem'> = localStorage) {
  return parseWorkspaceUi(storage.getItem(WORKSPACE_UI_KEY))
}

export function writeWorkspaceUi(value: PersistedWorkspaceUi, storage: Pick<Storage, 'setItem'> = localStorage) {
  const safe = {
    ...value,
    sessions: Object.fromEntries(Object.entries(value.sessions).map(([key, state]) => [key, sanitizeClientState(state)])),
  }
  storage.setItem(WORKSPACE_UI_KEY, JSON.stringify(safe))
}

export function sessionScopeKey(instanceId: string, profileId: string, sessionId: string) {
  return [instanceId, profileId, sessionId].map(encodeURIComponent).join('::')
}

export function parseSessionScopeKey(value: string) {
  const parts = value.split('::')
  if (parts.length !== 3) return undefined
  try {
    return { instanceId: decodeURIComponent(parts[0]), profileId: decodeURIComponent(parts[1]), sessionId: decodeURIComponent(parts[2]) }
  } catch {
    return undefined
  }
}

export function sanitizeInstanceClientStates(
  sessions: Record<string, SessionClientState>,
  instanceId: string,
) {
  return Object.fromEntries(Object.entries(sessions).map(([scope, state]) => [
    scope,
    parseSessionScopeKey(scope)?.instanceId === instanceId ? sanitizeClientState(state) : state,
  ]))
}

export function removeScopedSessionState(
  sessions: Record<string, SessionClientState>,
  pinnedSessions: string[],
  key: string,
) {
  return {
    sessions: Object.fromEntries(Object.entries(sessions).filter(([scope]) => scope !== key)),
    pinnedSessions: pinnedSessions.filter(scope => scope !== key),
  }
}

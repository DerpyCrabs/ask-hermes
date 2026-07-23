export const WORKSPACE_NOTIFICATIONS_KEY = 'ask-hermes.workspace-notifications.v1'

export type WorkspaceNotificationPreferences = {
  turnCompletion: boolean
  interactionRequired: boolean
  scheduleFailure: boolean
  scheduleCompletion: boolean
}

export type WorkspaceNotificationKind = keyof WorkspaceNotificationPreferences

export function notificationEnabled(preferences: WorkspaceNotificationPreferences, kind: WorkspaceNotificationKind) {
  return preferences[kind]
}

export function schedulesNeedBackgroundPolling(preferences: WorkspaceNotificationPreferences) {
  return preferences.scheduleFailure || preferences.scheduleCompletion
}

export function workspaceNeedsBackgroundMonitoring(
  preferences: WorkspaceNotificationPreferences,
  hasPersistedWork: boolean,
  hasActiveWork: boolean,
) {
  return hasPersistedWork
    || hasActiveWork
    || preferences.turnCompletion
    || preferences.interactionRequired
    || preferences.scheduleFailure
    || preferences.scheduleCompletion
}

export function isTurnCompletion(previous: string | undefined, next: string) {
  return (previous === 'running' || previous === 'stopping' || previous === 'stalled')
    && (next === 'idle' || next === 'error')
}

type ScheduleNotificationState = {
  state: string
  lastRunAt?: string
  lastError?: string
}

export function scheduleTransitionNotification(
  previous: ScheduleNotificationState | undefined,
  next: ScheduleNotificationState,
): 'scheduleFailure' | 'scheduleCompletion' | undefined {
  // Gateway schedule rows often expose only a changed last-run timestamp, not
  // a transient running state. Treat that timestamp as authoritative settlement.
  if (previous && next.lastRunAt && next.lastRunAt !== previous.lastRunAt) {
    return next.lastError ? 'scheduleFailure' : 'scheduleCompletion'
  }
  if (next.state === 'error' && previous?.state !== 'error') return 'scheduleFailure'
  if (previous?.state === 'running' && next.state === 'active') {
    return next.lastError ? 'scheduleFailure' : 'scheduleCompletion'
  }
  return undefined
}

export const defaultWorkspaceNotificationPreferences = (): WorkspaceNotificationPreferences => ({
  turnCompletion: true,
  interactionRequired: true,
  scheduleFailure: false,
  scheduleCompletion: false,
})

export function parseWorkspaceNotificationPreferences(raw: string | null): WorkspaceNotificationPreferences {
  const defaults = defaultWorkspaceNotificationPreferences()
  if (!raw) return defaults
  try {
    const value = JSON.parse(raw) as Partial<WorkspaceNotificationPreferences>
    return {
      turnCompletion: typeof value.turnCompletion === 'boolean' ? value.turnCompletion : defaults.turnCompletion,
      interactionRequired: typeof value.interactionRequired === 'boolean' ? value.interactionRequired : defaults.interactionRequired,
      scheduleFailure: typeof value.scheduleFailure === 'boolean' ? value.scheduleFailure : defaults.scheduleFailure,
      scheduleCompletion: typeof value.scheduleCompletion === 'boolean' ? value.scheduleCompletion : defaults.scheduleCompletion,
    }
  } catch {
    return defaults
  }
}

export function readWorkspaceNotificationPreferences(storage: Pick<Storage, 'getItem'> = localStorage) {
  return parseWorkspaceNotificationPreferences(storage.getItem(WORKSPACE_NOTIFICATIONS_KEY))
}

export function writeWorkspaceNotificationPreferences(
  preferences: WorkspaceNotificationPreferences,
  storage: Pick<Storage, 'setItem'> = localStorage,
) {
  storage.setItem(WORKSPACE_NOTIFICATIONS_KEY, JSON.stringify(preferences))
}

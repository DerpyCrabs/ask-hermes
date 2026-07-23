import { describe, expect, it } from 'vitest'
import {
  defaultWorkspaceNotificationPreferences,
  isTurnCompletion,
  notificationEnabled,
  parseWorkspaceNotificationPreferences,
  schedulesNeedBackgroundPolling,
  scheduleTransitionNotification,
  workspaceNeedsBackgroundMonitoring,
  writeWorkspaceNotificationPreferences,
  WORKSPACE_NOTIFICATIONS_KEY,
} from './notifications'

describe('workspace notification preferences', () => {
  it('uses conservative defaults and recovers malformed values', () => {
    expect(parseWorkspaceNotificationPreferences('{')).toEqual(defaultWorkspaceNotificationPreferences())
    expect(defaultWorkspaceNotificationPreferences()).toMatchObject({
      turnCompletion: true,
      interactionRequired: true,
      scheduleFailure: false,
      scheduleCompletion: false,
    })
  })

  it('preserves defaults for missing fields and persists one JSON record', () => {
    expect(parseWorkspaceNotificationPreferences('{"turnCompletion":false}')).toEqual({
      ...defaultWorkspaceNotificationPreferences(),
      turnCompletion: false,
    })
    let saved = ''
    writeWorkspaceNotificationPreferences(defaultWorkspaceNotificationPreferences(), {
      setItem(key, value) { expect(key).toBe(WORKSPACE_NOTIFICATIONS_KEY); saved = value },
    })
    expect(JSON.parse(saved)).toEqual(defaultWorkspaceNotificationPreferences())
  })

  it('detects only authoritative completion/failure transitions', () => {
    expect(isTurnCompletion('running', 'idle')).toBe(true)
    expect(isTurnCompletion('stopping', 'idle')).toBe(true)
    expect(isTurnCompletion('running', 'error')).toBe(true)
    expect(isTurnCompletion('stalled', 'idle')).toBe(true)
    expect(isTurnCompletion('idle', 'idle')).toBe(false)
    expect(scheduleTransitionNotification({ state: 'running' }, { state: 'active' })).toBe('scheduleCompletion')
    expect(scheduleTransitionNotification({ state: 'active' }, { state: 'error' })).toBe('scheduleFailure')
    expect(scheduleTransitionNotification({ state: 'error' }, { state: 'error' })).toBeUndefined()
    expect(scheduleTransitionNotification(
      { state: 'active', lastRunAt: '2026-07-22T10:00:00Z' },
      { state: 'active', lastRunAt: '2026-07-22T11:00:00Z' },
    )).toBe('scheduleCompletion')
    expect(scheduleTransitionNotification(
      { state: 'active', lastRunAt: '2026-07-22T10:00:00Z' },
      { state: 'active', lastRunAt: '2026-07-22T11:00:00Z', lastError: 'boom' },
    )).toBe('scheduleFailure')
    expect(notificationEnabled(defaultWorkspaceNotificationPreferences(), 'scheduleCompletion')).toBe(false)
    expect(schedulesNeedBackgroundPolling(defaultWorkspaceNotificationPreferences())).toBe(false)
    expect(schedulesNeedBackgroundPolling({
      ...defaultWorkspaceNotificationPreferences(),
      scheduleFailure: true,
    })).toBe(true)
  })

  it('keeps hidden monitoring alive for notifications or recoverable work', () => {
    const disabled = {
      turnCompletion: false,
      interactionRequired: false,
      scheduleFailure: false,
      scheduleCompletion: false,
    }
    expect(workspaceNeedsBackgroundMonitoring(disabled, false, false)).toBe(false)
    expect(workspaceNeedsBackgroundMonitoring(disabled, true, false)).toBe(true)
    expect(workspaceNeedsBackgroundMonitoring(disabled, false, true)).toBe(true)
    expect(workspaceNeedsBackgroundMonitoring({ ...disabled, interactionRequired: true }, false, false)).toBe(true)
    expect(workspaceNeedsBackgroundMonitoring({ ...disabled, scheduleCompletion: true }, false, false)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { defaultWorkspaceUi, parseSessionScopeKey, parseWorkspaceUi, removeScopedSessionState, sanitizeInstanceClientStates, sessionScopeKey, writeWorkspaceUi, WORKSPACE_UI_KEY } from './persistence'

describe('workspace persistence', () => {
  it('recovers from invalid or old values', () => {
    expect(parseWorkspaceUi('{')).toEqual(defaultWorkspaceUi())
    expect(parseWorkspaceUi('{"version":2}')).toEqual(defaultWorkspaceUi())
  })

  it('keys session UI state by instance, profile, and session', () => {
    expect(sessionScopeKey('remote/a', 'work', 'chat 1')).toBe('remote%2Fa::work::chat%201')
    expect(parseSessionScopeKey('remote%2Fa::work::chat%201')).toEqual({ instanceId: 'remote/a', profileId: 'work', sessionId: 'chat 1' })
    expect(parseSessionScopeKey('broken')).toBeUndefined()
  })

  it('persists only completed gateway attachment references', () => {
    const ui = defaultWorkspaceUi()
    ui.pinnedSessions = ['instance::profile::chat']
    ui.sessions.key = {
      draft: 'hello',
      attachments: [
        { id: 'ready', name: 'a.png', mimeType: 'image/png', size: 1, state: 'ready', url: 'gateway://a', previewUrl: 'data:ready-secret' },
        { id: 'uploading', name: 'b.png', mimeType: 'image/png', size: 1, state: 'uploading', previewUrl: 'data:secret' },
      ],
      queue: [],
    }
    let saved = ''
    writeWorkspaceUi(ui, { setItem(key, value) { expect(key).toBe(WORKSPACE_UI_KEY); saved = value } })
    expect(parseWorkspaceUi(saved).sessions.key.attachments.map(item => item.id)).toEqual(['ready'])
    expect(parseWorkspaceUi(saved).pinnedSessions).toEqual(['instance::profile::chat'])
    expect(saved).not.toContain('data:secret')
    expect(saved).not.toContain('data:ready-secret')
  })

  it('drops a switched instance transient upload without changing other instances', () => {
    const oldScope = sessionScopeKey('old', 'default', 'chat')
    const currentScope = sessionScopeKey('current', 'default', 'chat')
    const uploading = { id: 'upload', name: 'capture.png', mimeType: 'image/png', size: 1, state: 'uploading' as const }
    const states = {
      [oldScope]: { draft: 'old draft', queue: [], attachments: [uploading] },
      [currentScope]: { draft: 'current draft', queue: [], attachments: [uploading] },
    }

    const sanitized = sanitizeInstanceClientStates(states, 'old')

    expect(sanitized[oldScope]).toEqual({ draft: 'old draft', queue: [], attachments: [] })
    expect(sanitized[currentScope]).toBe(states[currentScope])
  })

  it('removes all persisted state for a permanently deleted session', () => {
    const state = { draft: 'private', queue: [], attachments: [] }
    const removed = removeScopedSessionState({ deleted: state, retained: state }, ['deleted', 'retained'], 'deleted')
    expect(removed).toEqual({ sessions: { retained: state }, pinnedSessions: ['retained'] })
  })
})

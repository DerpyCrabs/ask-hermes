import { describe, expect, it } from 'vitest'
import { ATTACHMENT_ONLY_PROMPT, applyClientStateMutation, capability, clientStateGenerationMatches, composerHasSubmission, composerSubmissionText, hasBlockingWork, hasClientStateContent, lifecycleMutationBlockReason, mergeClientState, mergeSessionPage, moveQueueEntry, overlayPendingDraft, queueDrainTransition, reduceCollections, reduceMessages, safeExternalUrl, shouldAppendHandoffDraft, topLevelSessions, unavailableSessionSummary } from './state'
import type { QueueEntry, SessionClientState, SessionSummary, WorkspaceMessage } from './types'

const session = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1', profileId: 'p1', title: 'Chat', source: 'workspace', createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z', archived: false, pinned: false, turnState: 'idle', ...overrides,
})

const entry = (id: string): QueueEntry => ({ id, text: id, createdAt: id, attachments: [] })

describe('workspace state helpers', () => {
  it('does not duplicate a shared or replayed handoff draft', () => {
    expect(shouldAppendHandoffDraft('hello', 'hello')).toBe(false)
    expect(shouldAppendHandoffDraft('existing\nhello', 'hello')).toBe(false)
    expect(shouldAppendHandoffDraft('existing', 'hello')).toBe(true)
  })

  it('applies a handoff draft and captures as one composer mutation', () => {
    const existing = { id: 'old', name: 'old.png', mimeType: 'image/png', size: 1, state: 'ready' as const }
    const capture = { id: 'new', name: 'new.png', mimeType: 'image/png', size: 2, state: 'ready' as const }
    const state: SessionClientState = { draft: 'existing', queue: [], attachments: [existing] }
    const mutation = { kind: 'applyHandoff' as const, handoffId: 'handoff-1', draft: 'incoming', attachments: [capture] }
    const applied = applyClientStateMutation(state, mutation)
    expect(applied.draft).toBe('existing\nincoming')
    expect(applied.attachments.map(item => item.id)).toEqual(['old', 'new'])
    expect(applyClientStateMutation(applied, mutation)).toEqual(applied)
  })

  it('keeps child and schedule sessions out of top-level navigation', () => {
    const visible = topLevelSessions([
      session(),
      session({ id: 'child', parentSessionId: 's1', source: 'subagent' }),
      session({ id: 'branch', parentSessionId: 's1', source: 'desktop' }),
      session({ id: 'run', source: 'schedule', scheduleId: 'cron' }),
      session({ id: 'other', profileId: 'p2' }),
    ], 'p1', false)
    expect(visible.map(item => item.id)).toEqual(['s1', 'branch'])
  })

  it('sorts pinned before recency', () => {
    const visible = topLevelSessions([
      session({ id: 'new', updatedAt: '2026-05-01T00:00:00Z' }),
      session({ id: 'pin', pinned: true, updatedAt: '2026-01-01T00:00:00Z' }),
    ], undefined, false)
    expect(visible.map(item => item.id)).toEqual(['pin', 'new'])
  })

  it('moves queue entries without mutating source and guards edges', () => {
    const source = [entry('a'), entry('b'), entry('c')]
    expect(moveQueueEntry(source, 'b', -1).map(item => item.id)).toEqual(['b', 'a', 'c'])
    expect(moveQueueEntry(source, 'a', -1)).toBe(source)
    expect(source.map(item => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('blocks instance switching for a turn or persisted queue', () => {
    expect(hasBlockingWork([session({ turnState: 'running' })], {})).toBe(true)
    expect(hasBlockingWork([session({ turnState: 'stalled' })], {})).toBe(true)
    const states: Record<string, SessionClientState> = { key: { draft: '', queue: [entry('a')], attachments: [] } }
    expect(hasBlockingWork([session()], states)).toBe(true)
    expect(hasBlockingWork([session()], {})).toBe(false)
  })

  it('merges persisted and incoming startup state without dropping queue or attachments', () => {
    const attachment = (id: string, name = id) => ({ id, name, mimeType: 'text/plain', size: 1, state: 'ready' as const })
    const persisted: SessionClientState = {
      draft: 'persisted draft',
      queue: [
        { ...entry('shared'), text: 'persisted shared', attachments: [attachment('local')] },
        { ...entry('persisted-only'), attachments: [] },
      ],
      attachments: [attachment('shared-attachment', 'old'), attachment('local-only')],
    }
    const incoming: SessionClientState = {
      draft: 'new draft',
      queue: [
        { ...entry('shared'), text: 'incoming shared', attachments: [attachment('remote')] },
        { ...entry('incoming-only'), attachments: [] },
      ],
      attachments: [attachment('shared-attachment', 'new'), attachment('remote-only')],
    }

    const merged = mergeClientState(persisted, incoming)
    expect(merged.draft).toBe('new draft')
    expect(merged.queue.map(item => item.id)).toEqual(['shared', 'persisted-only', 'incoming-only'])
    expect(merged.queue[0].text).toBe('incoming shared')
    expect(merged.queue[0].attachments.map(item => item.id)).toEqual(['remote', 'local'])
    expect(merged.attachments.map(item => `${item.id}:${item.name}`)).toEqual([
      'shared-attachment:new', 'remote-only:remote-only', 'local-only:local-only',
    ])
  })

  it('keeps persisted draft when incoming startup state has no draft', () => {
    const persisted: SessionClientState = { draft: 'keep me', queue: [], attachments: [] }
    expect(mergeClientState(persisted, { draft: '', queue: [], attachments: [] }).draft).toBe('keep me')
    expect(hasClientStateContent(persisted)).toBe(true)
    expect(hasClientStateContent({ draft: '', queue: [], attachments: [] })).toBe(false)
  })

  it('composes stale-base queue append and removal with independent draft edits', () => {
    const base: SessionClientState = { draft: 'old', queue: [entry('remove'), entry('keep')], attachments: [] }
    const appended = applyClientStateMutation(base, { kind: 'addQueue', entry: entry('append') })
    const typedAfterAppend = applyClientStateMutation(appended, { kind: 'setDraft', draft: 'new draft' })
    expect(typedAfterAppend.draft).toBe('new draft')
    expect(typedAfterAppend.queue.map(item => item.id)).toEqual(['remove', 'keep', 'append'])

    const typed = applyClientStateMutation(base, { kind: 'setDraft', draft: 'new draft' })
    const removedAfterTyping = applyClientStateMutation(typed, { kind: 'removeQueue', entryId: 'remove' })
    expect(removedAfterTyping.draft).toBe('new draft')
    expect(removedAfterTyping.queue.map(item => item.id)).toEqual(['keep'])
  })

  it('replays rapid queue edits in FIFO order', () => {
    let state: SessionClientState = { draft: '', queue: [entry('a'), entry('b'), entry('c')], attachments: [] }
    state = applyClientStateMutation(state, { kind: 'updateQueue', entryId: 'b', text: 'edited' })
    state = applyClientStateMutation(state, { kind: 'moveQueue', entryId: 'b', direction: -1 })
    state = applyClientStateMutation(state, { kind: 'removeQueue', entryId: 'a' })
    expect(state.queue.map(item => `${item.id}:${item.text}`)).toEqual(['b:edited', 'c:c'])
  })

  it('overlays a pending local draft without hiding authoritative queue changes', () => {
    const incoming: SessionClientState = { draft: 'remote', queue: [entry('remote-queue')], attachments: [] }
    expect(overlayPendingDraft(incoming, 'still typing')).toEqual({
      draft: 'still typing', queue: incoming.queue, attachments: [],
    })
  })

  it('rejects stale instance generations, including switch-back to the same ID', () => {
    const request = { instanceId: 'instance-a', instanceGeneration: 4 }
    expect(clientStateGenerationMatches(request, request)).toBe(true)
    expect(clientStateGenerationMatches({ instanceId: 'instance-b', instanceGeneration: 5 }, request)).toBe(false)
    expect(clientStateGenerationMatches({ instanceId: 'instance-a', instanceGeneration: 6 }, request)).toBe(false)
  })

  it('creates an actionable row for a queued chat missing from Gateway', () => {
    const unavailable = unavailableSessionSummary('work', 'deleted-chat', 2, 'not found', '2026-01-01T00:00:00Z')
    expect(unavailable).toMatchObject({
      id: 'deleted-chat', profileId: 'work', turnState: 'error', queuedCount: 2, archived: false,
      lastMessagePreview: 'not found',
    })
  })

  it('applies live collection and streaming events immutably', () => {
    const collections = reduceCollections({ sessions: [session()], schedules: [] }, {
      type: 'turn-state', profileId: 'p1', sessionId: 's1', state: 'running',
    })
    expect(collections.sessions[0].turnState).toBe('running')
    const yolo = reduceCollections(collections, {
      type: 'session-settings', profileId: 'p1', sessionId: 's1', settings: { approvalMode: 'smart', yolo: true },
    })
    expect(yolo.sessions[0].settings).toEqual({ approvalMode: 'smart', yolo: true })

    const message: WorkspaceMessage = {
      id: 'm1', sessionId: 's1', profileId: 'p1', role: 'assistant', content: 'Hi',
      createdAt: '2026-01-01T00:00:00Z', status: 'streaming',
    }
    const changed = reduceMessages([message], {
      type: 'message-delta', profileId: 'p1', sessionId: 's1', messageId: 'm1', delta: ' there',
    }, 'p1', 's1')
    expect(changed[0].content).toBe('Hi there')
    expect(message.content).toBe('Hi')
  })

  it('explains absent capabilities', () => {
    expect(capability(undefined, 'schedules')).toEqual({ supported: false, reason: 'Hermes did not report schedules support' })
  })

  it('allows only safe external message links', () => {
    expect(safeExternalUrl('https://example.com/path')).toBe('https://example.com/path')
    expect(safeExternalUrl('mailto:person@example.com')).toBe('mailto:person@example.com')
    expect(safeExternalUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeExternalUrl('file:///secret')).toBeUndefined()
  })

  it('blocks archive/delete while a turn or queue is active', () => {
    expect(lifecycleMutationBlockReason(session({ turnState: 'running' }), { draft: '', queue: [], attachments: [] }))
      .toContain('Stop the active turn')
    expect(lifecycleMutationBlockReason(session(), { draft: '', queue: [entry('queued')], attachments: [] }))
      .toContain('Remove queued prompts')
    expect(lifecycleMutationBlockReason(session(), { draft: 'safe draft', queue: [], attachments: [] })).toBeUndefined()
  })

  it('requires ready attachments and supplies an attachment-only prompt', () => {
    const ready = { id: 'file', name: 'notes.txt', mimeType: 'text/plain', size: 5, state: 'ready' as const }
    expect(composerSubmissionText('', [ready])).toBe(ATTACHMENT_ONLY_PROMPT)
    expect(composerSubmissionText('  inspect this  ', [ready])).toBe('inspect this')
    expect(composerSubmissionText('', [{ ...ready, state: 'uploading' }])).toBeUndefined()
    expect(composerSubmissionText('send', [{ ...ready, state: 'failed' }])).toBeUndefined()
    expect(composerSubmissionText('', [])).toBeUndefined()
    expect(composerHasSubmission('', [{ ...ready, state: 'uploading' }])).toBe(true)
    expect(composerHasSubmission('', [{ ...ready, state: 'failed' }])).toBe(true)
    expect(composerHasSubmission(' ', [])).toBe(false)
  })

  it('drains once per authoritative queued-turn cycle', () => {
    expect(queueDrainTransition(undefined, 'idle')).toEqual({ phase: undefined, shouldDrain: true, ignoreTurnState: false })
    expect(queueDrainTransition('awaiting-running', 'idle')).toEqual({ phase: 'awaiting-running', shouldDrain: false, ignoreTurnState: true })
    expect(queueDrainTransition('awaiting-running', 'running')).toEqual({ phase: 'awaiting-settlement', shouldDrain: false, ignoreTurnState: false })
    expect(queueDrainTransition('awaiting-settlement', 'idle')).toEqual({ phase: undefined, shouldDrain: true, ignoreTurnState: false })
    expect(queueDrainTransition('awaiting-settlement', 'error')).toEqual({ phase: undefined, shouldDrain: true, ignoreTurnState: false })
    expect(queueDrainTransition(undefined, 'error')).toEqual({ phase: undefined, shouldDrain: true, ignoreTurnState: false })
  })

  it('merges refreshed and paged sessions without dropping loaded rows', () => {
    const older = session({ id: 'older', updatedAt: '2024-01-01T00:00:00Z' })
    const current = session({ id: 'current', title: 'Old title' })
    const refreshed = session({ id: 'current', title: 'New title' })
    expect(mergeSessionPage([current, older], [refreshed])).toEqual([refreshed, older])
  })
})

import type {
  AttachmentRef,
  Capability,
  CapabilityName,
  ClientStateMutation,
  QueueEntry,
  ScheduleRecord,
  SessionClientState,
  SessionSummary,
  WorkspaceCapabilities,
  WorkspaceEvent,
  WorkspaceMessage,
} from './types'
import { workspaceText as text } from './strings'

export const ATTACHMENT_ONLY_PROMPT = text.attachmentOnlyPrompt
export type QueueDrainPhase = 'awaiting-running' | 'awaiting-settlement'

export type WorkspaceCollections = {
  sessions: SessionSummary[]
  schedules: ScheduleRecord[]
}

const time = (value?: string) => {
  const parsed = value ? Date.parse(value) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

export function topLevelSessions(sessions: SessionSummary[], profileId: string | undefined, archived: boolean) {
  return sessions
    .filter(session => (!profileId || session.profileId === profileId)
      && session.archived === archived
      && session.source !== 'schedule'
      && session.source !== 'subagent'
      && session.source !== 'background')
    .sort((left, right) => Number(right.pinned) - Number(left.pinned) || time(right.updatedAt) - time(left.updatedAt))
}

export function schedulesForProfile(schedules: ScheduleRecord[], profileId?: string) {
  return schedules
    .filter(schedule => !profileId || schedule.profileId === profileId)
    .sort((left, right) => time(right.lastRunAt) - time(left.lastRunAt) || left.name.localeCompare(right.name))
}

export function mergeSessionPage(current: SessionSummary[], page: SessionSummary[]) {
  const pageKeys = new Set(page.map(session => `${session.profileId}:${session.id}`))
  const retained = current.filter(session => !pageKeys.has(`${session.profileId}:${session.id}`))
  return [...page, ...retained]
}

export function capability(capabilities: WorkspaceCapabilities | undefined, name: CapabilityName): Capability {
  return capabilities?.[name] || { supported: false, reason: text.capabilityMissing(name) }
}

export const safeExternalUrl = (value: string) => /^(https?:|mailto:)/i.test(value) ? value : undefined

export function lifecycleMutationBlockReason(session: SessionSummary, state: SessionClientState) {
  if (session.turnState === 'running' || session.turnState === 'stopping' || session.turnState === 'stalled') {
    return text.stopBeforeLifecycleMutation
  }
  if (state.queue.length > 0) return text.removeQueueBeforeLifecycleMutation
  return undefined
}

export function composerSubmissionText(text: string, attachments: AttachmentRef[]) {
  if (attachments.some(attachment => attachment.state !== 'ready')) return undefined
  const prompt = text.trim()
  if (prompt) return prompt
  return attachments.length ? ATTACHMENT_ONLY_PROMPT : undefined
}

export function composerHasSubmission(text: string, attachments: AttachmentRef[]) {
  return Boolean(text.trim() || attachments.length)
}

export function queueDrainTransition(phase: QueueDrainPhase | undefined, turnState: SessionSummary['turnState']) {
  const settled = turnState === 'idle' || turnState === 'error'
  if (turnState === 'running' && phase === 'awaiting-running') {
    return { phase: 'awaiting-settlement' as const, shouldDrain: false, ignoreTurnState: false }
  }
  if (settled && phase === 'awaiting-settlement') {
    return { phase: undefined, shouldDrain: true, ignoreTurnState: false }
  }
  if (settled && phase === undefined) {
    return { phase: undefined, shouldDrain: true, ignoreTurnState: false }
  }
  return { phase, shouldDrain: false, ignoreTurnState: turnState === 'idle' && phase === 'awaiting-running' }
}

export function newQueueEntry(text: string, attachments: QueueEntry['attachments'], settings?: QueueEntry['settings']): QueueEntry {
  return {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    text: text.trim(),
    createdAt: new Date().toISOString(),
    attachments,
    settings,
  }
}

export const updateQueueEntry = (queue: QueueEntry[], id: string, text: string) =>
  queue.map(entry => entry.id === id ? { ...entry, text } : entry)

export const removeQueueEntry = (queue: QueueEntry[], id: string) =>
  queue.filter(entry => entry.id !== id)

export function moveQueueEntry(queue: QueueEntry[], id: string, direction: -1 | 1) {
  const from = queue.findIndex(entry => entry.id === id)
  const to = from + direction
  if (from < 0 || to < 0 || to >= queue.length) return queue
  const moved = [...queue]
  ;[moved[from], moved[to]] = [moved[to], moved[from]]
  return moved
}

export const hasBlockingWork = (sessions: SessionSummary[], states: Record<string, SessionClientState>) =>
  sessions.some(session => session.turnState === 'running' || session.turnState === 'stopping' || session.turnState === 'stalled')
  || Object.values(states).some(state => state.queue.length > 0)

export const hasClientStateContent = (state: SessionClientState) =>
  Boolean(state.draft || state.queue.length || state.attachments.length)

export function unavailableSessionSummary(
  profileId: string,
  sessionId: string,
  queuedCount: number,
  error: string,
  timestamp = new Date().toISOString(),
): SessionSummary {
  return {
    id: sessionId,
    profileId,
    title: text.unavailableChat(sessionId),
    source: 'workspace',
    createdAt: timestamp,
    updatedAt: timestamp,
    archived: false,
    pinned: false,
    turnState: 'error',
    queuedCount,
    lastMessagePreview: error,
  }
}

function mergeAttachments(persisted: AttachmentRef[], incoming: AttachmentRef[]) {
  const incomingIds = new Set(incoming.map(attachment => attachment.id))
  return [...incoming, ...persisted.filter(attachment => !incomingIds.has(attachment.id))]
}

/**
 * Reconciles startup state from local persistence with state already held by
 * another Ask Hermes window. Incoming order and values win, while locally
 * persisted queue entries and gateway attachment references are never lost.
 */
export function mergeClientState(persisted: SessionClientState, incoming: SessionClientState): SessionClientState {
  const incomingQueue = new Map(incoming.queue.map(entry => [entry.id, entry]))
  const persistedIds = new Set(persisted.queue.map(entry => entry.id))
  const reconciledPersistedQueue = persisted.queue.map(entry => {
    const next = incomingQueue.get(entry.id)
    return next
      ? { ...next, attachments: mergeAttachments(entry.attachments, next.attachments) }
      : entry
  })
  return {
    draft: incoming.draft || persisted.draft,
    queue: [...reconciledPersistedQueue, ...incoming.queue.filter(entry => !persistedIds.has(entry.id))],
    attachments: mergeAttachments(persisted.attachments, incoming.attachments),
  }
}

const restoreDraft = (current: string, restored: string) => {
  if (!restored || current === restored) return current
  return current ? `${restored}\n${current}` : restored
}

/** Mirrors Rust mutations for immediate UI feedback; Rust remains authoritative. */
export function applyClientStateMutation(state: SessionClientState, mutation: ClientStateMutation): SessionClientState {
  switch (mutation.kind) {
    case 'setDraft': return { ...state, draft: mutation.draft }
    case 'appendDraft': return {
      ...state,
      draft: !state.draft ? mutation.text : !mutation.text ? state.draft : `${state.draft}${mutation.separator || ''}${mutation.text}`,
    }
    case 'restoreDraft': return { ...state, draft: restoreDraft(state.draft, mutation.draft) }
    case 'addQueue': return state.queue.some(entry => entry.id === mutation.entry.id) ? state : {
      ...state, queue: mutation.front ? [mutation.entry, ...state.queue] : [...state.queue, mutation.entry],
    }
    case 'updateQueue': return { ...state, queue: updateQueueEntry(state.queue, mutation.entryId, mutation.text) }
    case 'moveQueue': return { ...state, queue: moveQueueEntry(state.queue, mutation.entryId, mutation.direction) }
    case 'removeQueue': return { ...state, queue: removeQueueEntry(state.queue, mutation.entryId) }
    case 'restoreQueue': return state.queue.some(entry => entry.id === mutation.entry.id)
      ? state : { ...state, queue: [mutation.entry, ...state.queue] }
    case 'addAttachment': return state.attachments.some(item => item.id === mutation.attachment.id)
      ? state : { ...state, attachments: [...state.attachments, mutation.attachment] }
    case 'replaceAttachment': return {
      ...state,
      attachments: state.attachments.map(item => item.id === mutation.attachmentId ? mutation.attachment : item),
    }
    case 'removeAttachment': return {
      ...state, attachments: state.attachments.filter(item => item.id !== mutation.attachmentId),
    }
    case 'consumeComposer': return {
      ...state,
      draft: '',
      attachments: [],
      queue: mutation.entry && !state.queue.some(entry => entry.id === mutation.entry!.id)
        ? [...state.queue, { ...mutation.entry, attachments: mergeAttachments(mutation.entry.attachments, state.attachments) }]
        : state.queue,
    }
    case 'restoreComposer': return {
      ...state,
      draft: restoreDraft(state.draft, mutation.draft),
      queue: mutation.entryId ? state.queue.filter(entry => entry.id !== mutation.entryId) : state.queue,
      attachments: mergeAttachments(state.attachments, mutation.attachments),
    }
    case 'applyHandoff': return {
      ...state,
      draft: shouldAppendHandoffDraft(state.draft, mutation.draft)
        ? state.draft ? `${state.draft}\n${mutation.draft}` : mutation.draft || ''
        : state.draft,
      attachments: mergeAttachments(mutation.attachments, state.attachments),
    }
  }
}

/** Prevent a remote event from visually rolling back text still awaiting debounce. */
export const overlayPendingDraft = (state: SessionClientState, pendingDraft: string | undefined): SessionClientState =>
  pendingDraft === undefined ? state : { ...state, draft: pendingDraft }

/** Handoff events may be replayed after reconnect; never append their draft twice. */
export const shouldAppendHandoffDraft = (current: string, incoming?: string) => Boolean(
  incoming
  && current !== incoming
  && !current.endsWith(`\n${incoming}`),
)

export const clientStateGenerationMatches = (
  current: { instanceId: string; instanceGeneration: number },
  requested: { instanceId: string; instanceGeneration: number },
) => current.instanceId === requested.instanceId
  && current.instanceGeneration === requested.instanceGeneration

export function reduceCollections(collections: WorkspaceCollections, event: WorkspaceEvent): WorkspaceCollections {
  switch (event.type) {
    case 'session-upsert':
      return { ...collections, sessions: upsert(collections.sessions, event.session, item => `${item.profileId}:${item.id}`) }
    case 'session-remove':
      return { ...collections, sessions: collections.sessions.filter(item => item.id !== event.sessionId || item.profileId !== event.profileId) }
    case 'session-settings':
      return {
        ...collections,
        sessions: collections.sessions.map(item => item.id === event.sessionId && item.profileId === event.profileId
          ? { ...item, settings: { ...item.settings, ...event.settings } }
          : item),
      }
    case 'turn-state':
      return {
        ...collections,
        sessions: collections.sessions.map(item => item.id === event.sessionId && item.profileId === event.profileId
          ? { ...item, turnState: event.state }
          : item),
      }
    case 'schedule-upsert':
      return { ...collections, schedules: upsert(collections.schedules, event.schedule, item => `${item.profileId}:${item.id}`) }
    case 'schedule-remove':
      return { ...collections, schedules: collections.schedules.filter(item => item.id !== event.scheduleId || item.profileId !== event.profileId) }
    default:
      return collections
  }
}

export function reduceMessages(messages: WorkspaceMessage[], event: WorkspaceEvent, profileId: string, sessionId: string) {
  if (event.type === 'message-upsert' && event.message.profileId === profileId && event.message.sessionId === sessionId) {
    return upsert(messages, event.message, item => item.id)
  }
  if (event.type === 'message-delta' && event.profileId === profileId && event.sessionId === sessionId) {
    return messages.map(message => message.id === event.messageId
      ? { ...message, content: message.content + event.delta, status: 'streaming' as const }
      : message)
  }
  if (event.type === 'interaction' && event.profileId === profileId && event.sessionId === sessionId) {
    return messages.map(message => message.id === event.messageId
      ? { ...message, interactions: [...(message.interactions || []), event.interaction] }
      : message)
  }
  return messages
}

function upsert<T>(items: T[], value: T, key: (item: T) => string) {
  const index = items.findIndex(item => key(item) === key(value))
  if (index < 0) return [...items, value]
  const next = [...items]
  next[index] = value
  return next
}

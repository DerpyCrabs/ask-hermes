import { describe, expect, it } from 'vitest'
import { COMPOSER_DRAFT_STORAGE_KEY, composerDraftSessionId, composerDraftStorageKey, createComposerDraftStore } from './composer-draft'

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(COMPOSER_DRAFT_STORAGE_KEY, initial)
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => { values.delete(key) },
    value: () => values.get(COMPOSER_DRAFT_STORAGE_KEY),
  }
}

describe('composer draft persistence', () => {
  it('round-trips text with its selected session', () => {
    const storage = memoryStorage()
    const drafts = createComposerDraftStore(storage)

    drafts.save({ sessionId: 'session-7', text: 'unfinished question' })

    expect(drafts.load()).toEqual({ sessionId: 'session-7', text: 'unfinished question' })
  })

  it('isolates drafts between settings profiles', () => {
    const storage = memoryStorage()
    const personal = createComposerDraftStore(storage, composerDraftStorageKey('default-v1'))
    const work = createComposerDraftStore(storage, composerDraftStorageKey('custom-v1-1234'))

    personal.save({ sessionId: 'personal-session', text: 'personal draft' })
    work.save({ sessionId: 'work-session', text: 'work draft' })

    expect(personal.load()).toEqual({ sessionId: 'personal-session', text: 'personal draft' })
    expect(work.load()).toEqual({ sessionId: 'work-session', text: 'work draft' })
  })

  it('keeps restored session affinity until session validation finishes', () => {
    expect(composerDraftSessionId('__new__', 'pending-session', false)).toBe('pending-session')
    expect(composerDraftSessionId('validated-session', 'pending-session', true)).toBe('validated-session')
  })

  it('clears storage when the composer becomes empty', () => {
    const storage = memoryStorage()
    const drafts = createComposerDraftStore(storage)
    drafts.save({ sessionId: 'session-7', text: 'question' })

    drafts.save({ sessionId: 'session-7', text: '' })

    expect(storage.value()).toBeUndefined()
    expect(drafts.load()).toBeUndefined()
  })

  it.each([
    'not json',
    'null',
    '{}',
    '{"version":2,"sessionId":"session-7","text":"old"}',
    '{"version":1,"sessionId":7,"text":"wrong"}',
  ])('rejects and removes unsafe stored value %s', raw => {
    const storage = memoryStorage(raw)

    expect(createComposerDraftStore(storage).load()).toBeUndefined()
    expect(storage.value()).toBeUndefined()
  })

  it('bounds stored data and removes an older draft when the replacement is too large', () => {
    const storage = memoryStorage()
    const drafts = createComposerDraftStore(storage)
    drafts.save({ sessionId: 'session-7', text: 'old' })

    drafts.save({ sessionId: 'session-7', text: '🌕'.repeat(20_000) })

    expect(storage.value()).toBeUndefined()
  })

  it('treats unavailable storage as a non-fatal missing draft', () => {
    const unavailable = {
      getItem: () => { throw new Error('disabled') },
      setItem: () => { throw new Error('disabled') },
      removeItem: () => { throw new Error('disabled') },
    }
    const drafts = createComposerDraftStore(unavailable)

    expect(drafts.load()).toBeUndefined()
    expect(() => drafts.save({ sessionId: 'session-7', text: 'question' })).not.toThrow()
  })
})

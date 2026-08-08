const COMPOSER_DRAFT_STORAGE_PREFIX = 'ask-hermes.composer-draft.v1'

export function composerDraftStorageKey(profileKey: string) {
  const safeProfileKey = /^[a-z0-9-]{1,96}$/i.test(profileKey) ? profileKey : 'default-v1'
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}.${safeProfileKey}`
}

export const COMPOSER_DRAFT_STORAGE_KEY = composerDraftStorageKey('default-v1')

export function composerDraftSessionId(
  activeSessionId: string,
  pendingSessionId: string | undefined,
  sessionsValidated: boolean,
) {
  return !sessionsValidated && pendingSessionId ? pendingSessionId : activeSessionId
}

const MAX_STORED_BYTES = 64 * 1024
const MAX_SESSION_ID_LENGTH = 512

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type ComposerDraft = {
  sessionId: string
  text: string
}

export type ComposerDraftStore = {
  load(): ComposerDraft | undefined
  save(draft: ComposerDraft | undefined): void
}

type StoredDraft = ComposerDraft & { version: 1 }

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SESSION_ID_LENGTH
}

function parseDraft(raw: string): ComposerDraft | undefined {
  if (raw.length > MAX_STORED_BYTES || byteLength(raw) > MAX_STORED_BYTES) return undefined

  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return undefined
    const draft = value as Partial<StoredDraft>
    if (draft.version !== 1 || !validSessionId(draft.sessionId) || typeof draft.text !== 'string') {
      return undefined
    }
    return { sessionId: draft.sessionId, text: draft.text }
  } catch {
    return undefined
  }
}

/**
 * Persists one composer draft. Corrupt, stale-schema, and oversized values are
 * removed instead of reaching callers or surviving as misleading old drafts.
 */
export function createComposerDraftStore(
  storage: DraftStorage,
  key = COMPOSER_DRAFT_STORAGE_KEY,
): ComposerDraftStore {
  const remove = () => {
    try {
      storage.removeItem(key)
    } catch {
      // Draft persistence must never make the composer unusable.
    }
  }

  return {
    load() {
      let raw: string | null
      try {
        raw = storage.getItem(key)
      } catch {
        return undefined
      }
      if (raw === null) return undefined

      const draft = parseDraft(raw)
      if (!draft) remove()
      return draft
    },
    save(draft) {
      if (!draft || draft.text.length === 0 || !validSessionId(draft.sessionId)) {
        remove()
        return
      }

      let serialized: string
      try {
        serialized = JSON.stringify({ version: 1, ...draft } satisfies StoredDraft)
      } catch {
        remove()
        return
      }
      if (byteLength(serialized) > MAX_STORED_BYTES) {
        remove()
        return
      }

      try {
        storage.setItem(key, serialized)
      } catch {
        // Quota and privacy-mode failures are non-fatal.
      }
    },
  }
}

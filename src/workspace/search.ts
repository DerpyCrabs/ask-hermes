import type { ResolveSearchHitRequest, SearchResult } from './types'

export function searchResolutionRequest(result: SearchResult): ResolveSearchHitRequest | undefined {
  if (result.messageId || !result.resolver) return undefined
  return {
    profileId: result.profileId,
    sessionId: result.sessionId,
    resolver: result.resolver,
  }
}

/** Makes async search-result navigation latest-request-wins. */
export class SearchNavigationGuard {
  private generation = 0

  begin() {
    this.generation += 1
    return this.generation
  }

  cancel() {
    this.generation += 1
  }

  isCurrent(ticket: number) {
    return ticket === this.generation
  }
}

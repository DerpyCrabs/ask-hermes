type BrowseState = {
  cursor: number
  draftSnapshot: string
}

const browseStates = new Map<string, BrowseState>()

function stateFor(scope: string) {
  let state = browseStates.get(scope)
  if (!state) {
    state = { cursor: -1, draftSnapshot: '' }
    browseStates.set(scope, state)
  }
  return state
}

export function deriveUserHistory<T extends { role: string }>(
  messages: readonly T[],
  getText: (message: T) => string,
) {
  const history: string[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const text = getText(message).trim()
    if (text) history.push(text)
  }
  return history
}

export function browseBackward(scope: string, draft: string, history: readonly string[]) {
  if (!scope || !history.length) return undefined
  const state = stateFor(scope)
  if (state.cursor < 0) {
    state.cursor = 0
    state.draftSnapshot = draft
  } else if (state.cursor < history.length - 1) {
    state.cursor += 1
  } else {
    return undefined
  }
  return history[state.cursor]
}

export function browseForward(scope: string, history: readonly string[]) {
  if (!scope) return undefined
  const state = stateFor(scope)
  if (state.cursor < 0) return undefined
  if (state.cursor > 0) {
    state.cursor -= 1
    return history[state.cursor]
  }
  const draft = state.draftSnapshot
  resetBrowseState(scope)
  return draft
}

export function isBrowsingHistory(scope: string) {
  return (browseStates.get(scope)?.cursor ?? -1) >= 0
}

export function resetBrowseState(scope: string) {
  if (scope) browseStates.set(scope, { cursor: -1, draftSnapshot: '' })
}

export function resetAllBrowseStates() {
  browseStates.clear()
}

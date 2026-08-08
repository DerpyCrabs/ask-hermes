const FLUSH_DELAY_MS = 40

export type AnswerDeltaBatcher = {
  add(delta: string): void
  flush(): void
  cancel(): void
}

/**
 * Coalesces a turn's streaming answer deltas into UI-sized updates.
 * `cancel` is terminal: it discards buffered text and ignores late deltas.
 */
export function createAnswerDeltaBatcher(
  apply: (text: string) => void,
): AnswerDeltaBatcher {
  let buffered = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false

  const flush = () => {
    if (cancelled) return
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!buffered) return

    const text = buffered
    buffered = ''
    apply(text)
  }

  return {
    add(delta) {
      if (cancelled || !delta) return
      buffered += delta
      if (timer === undefined) timer = setTimeout(flush, FLUSH_DELAY_MS)
    },
    flush,
    cancel() {
      cancelled = true
      buffered = ''
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

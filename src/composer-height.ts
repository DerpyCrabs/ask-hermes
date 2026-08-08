export const COMPOSER_MIN_HEIGHT = 42
export const COMPOSER_MAX_HEIGHT = 162

export function boundedComposerHeight(scrollHeight: number) {
  if (!Number.isFinite(scrollHeight)) return COMPOSER_MIN_HEIGHT
  return Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, Math.ceil(scrollHeight)))
}

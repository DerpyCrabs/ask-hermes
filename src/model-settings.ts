export function supportsFastMode(model: string) {
  return /^gpt-/i.test(model.trim())
}

export type Capture = {
  data_url: string
  width: number
  height: number
}

export function appendCapture(items: readonly Capture[], capture: Capture): Capture[] {
  return [...items, capture]
}

export function removeCaptureAt(items: readonly Capture[], index: number): Capture[] {
  return items.filter((_, itemIndex) => itemIndex !== index)
}

type ClipboardItemLike = {
  type: string
  getAsFile(): File | null
}

export function clipboardImageFiles(items: ArrayLike<ClipboardItemLike> | undefined): File[] {
  if (!items) return []
  return Array.from(items)
    .filter(item => item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter((file): file is File => file !== null)
}

export async function imageFileToCapture(file: File): Promise<Capture> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read clipboard image'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(file)
  })

  const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image()
    image.onerror = () => reject(new Error('Could not decode clipboard image'))
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.src = dataUrl
  })

  return { data_url: dataUrl, ...dimensions }
}

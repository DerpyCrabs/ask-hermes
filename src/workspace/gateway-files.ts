import type { GatewayFileData } from './types'

const MAX_GATEWAY_DATA_URL_CHARS = 24 * 1024 * 1024
const URI_SCHEME = /^([a-z][a-z0-9+.-]*):/i
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i

export function gatewayLocalFilePath(value?: string): string | undefined {
  const path = value?.trim()
  if (!path || path.length > 32_768 || /[\u0000-\u001f\u007f]/.test(path)) return undefined
  if (WINDOWS_DRIVE.test(path)) return path
  const scheme = URI_SCHEME.exec(path)?.[1]?.toLowerCase()
  if (scheme && scheme !== 'file') return undefined
  return path
}

function dataUrlMimeType(value: string): string | undefined {
  if (value.length > MAX_GATEWAY_DATA_URL_CHARS || /[\u0000-\u001f\u007f]/.test(value)) return undefined
  const match = /^data:([^;,\s]+)(?:;[^,\r\n]*)?;base64,/i.exec(value)
  if (!match) return undefined
  const encoded = value.slice(match[0].length)
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined
  return match[1]?.toLowerCase()
}

export function safeGatewayDataUrl(file: GatewayFileData, imageOnly = false): string | undefined {
  const mimeType = dataUrlMimeType(file.dataUrl)
  if (!mimeType || (imageOnly && !mimeType.startsWith('image/'))) return undefined
  if (file.mimeType && file.mimeType.split(';', 1)[0].trim().toLowerCase() !== mimeType) return undefined
  return file.dataUrl
}

export function safeInlineImageSource(value?: string): string | undefined {
  const source = value?.trim()
  if (!source || source.length > MAX_GATEWAY_DATA_URL_CHARS || /[\u0000-\u001f\u007f]/.test(source)) return undefined
  if (/^https?:\/\//i.test(source)) return source
  const mimeType = dataUrlMimeType(source)
  return mimeType?.startsWith('image/') ? source : undefined
}

export function gatewayDownloadName(file: GatewayFileData, suggestedName?: string): string {
  const candidate = (suggestedName || file.name || 'artifact')
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    .trim()
    .slice(0, 180)
  return candidate || 'artifact'
}

export async function downloadGatewayFile(file: GatewayFileData, suggestedName?: string): Promise<void> {
  const dataUrl = safeGatewayDataUrl(file)
  if (!dataUrl) throw new Error('Hermes returned unsafe gateway file data')
  const response = await fetch(dataUrl)
  if (!response.ok) throw new Error('Could not decode gateway file data')
  const blobUrl = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = blobUrl
  anchor.download = gatewayDownloadName(file, suggestedName)
  anchor.rel = 'noopener noreferrer'
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000)
  }
}

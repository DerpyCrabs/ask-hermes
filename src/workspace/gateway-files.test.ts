// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadGatewayFile, gatewayDownloadName, gatewayLocalFilePath, safeGatewayDataUrl, safeInlineImageSource } from './gateway-files'

const image = { name: 'remote.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('gateway file boundary', () => {
  it('accepts gateway-local paths but never web or active-content URLs', () => {
    expect(gatewayLocalFilePath('/srv/work/report.pdf')).toBe('/srv/work/report.pdf')
    expect(gatewayLocalFilePath('C:\\work\\report.pdf')).toBe('C:\\work\\report.pdf')
    expect(gatewayLocalFilePath('file:///srv/work/report.pdf')).toBe('file:///srv/work/report.pdf')
    expect(gatewayLocalFilePath('https://example.test/report.pdf')).toBeUndefined()
    expect(gatewayLocalFilePath('javascript:alert(1)')).toBeUndefined()
  })

  it('allows base64 data only when MIME metadata agrees', () => {
    expect(safeGatewayDataUrl(image, true)).toBe(image.dataUrl)
    expect(safeGatewayDataUrl({ ...image, mimeType: 'text/html' }, true)).toBeUndefined()
    expect(safeGatewayDataUrl({ ...image, dataUrl: 'data:text/html;base64,PGgxPm5vPC9oMT4=' }, true)).toBeUndefined()
    expect(safeGatewayDataUrl({ ...image, dataUrl: 'data:image/png;base64,%%%%' }, true)).toBeUndefined()
    expect(safeInlineImageSource('https://example.test/image.png')).toBe('https://example.test/image.png')
    expect(safeInlineImageSource('data:text/html;base64,PGgxPm5vPC9oMT4=')).toBeUndefined()
  })

  it('downloads through a temporary blob URL and revokes it', async () => {
    vi.useFakeTimers()
    const blob = new Blob(['hello'], { type: 'image/png' })
    const fetchFile = vi.fn(async () => ({ ok: true, blob: async () => blob }))
    vi.stubGlobal('fetch', fetchFile)
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:gateway-file')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    await downloadGatewayFile(image, '../unsafe/name.png')

    expect(fetchFile).toHaveBeenCalledWith(image.dataUrl)
    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(click).toHaveBeenCalledOnce()
    expect(gatewayDownloadName(image, '../unsafe/name.png')).toBe('.._unsafe_name.png')
    vi.advanceTimersByTime(30_000)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:gateway-file')
  })
})

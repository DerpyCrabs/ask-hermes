import { describe, expect, it } from 'vitest'
import { appendCapture, clipboardImageFiles, removeCaptureAt, type Capture } from './captures'

const first: Capture = { data_url: 'data:image/png;base64,first', width: 120, height: 80 }
const second: Capture = { data_url: 'data:image/png;base64,second', width: 300, height: 200 }

describe('capture collection', () => {
  it('appends repeated captures without replacing earlier ones', () => {
    expect(appendCapture(appendCapture([], first), second)).toEqual([first, second])
  })

  it('removes only the selected capture', () => {
    expect(removeCaptureAt([first, second], 0)).toEqual([second])
  })

  it('extracts every image from clipboard items and ignores text', () => {
    const png = new File(['png'], 'one.png', { type: 'image/png' })
    const jpeg = new File(['jpeg'], 'two.jpg', { type: 'image/jpeg' })
    const items = [
      { type: 'text/plain', getAsFile: () => null },
      { type: 'image/png', getAsFile: () => png },
      { type: 'image/jpeg', getAsFile: () => jpeg },
    ]

    expect(clipboardImageFiles(items)).toEqual([png, jpeg])
  })

  it('returns no captures for a text-only clipboard', () => {
    expect(clipboardImageFiles([{ type: 'text/plain', getAsFile: () => null }])).toEqual([])
  })
})

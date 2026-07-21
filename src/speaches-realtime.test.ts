import { describe, expect, it } from 'vitest'
import { PendingAudioBuffer, floatAudioToPcm16Base64, parseSpeachesEvent, speachesRealtimeUrl } from './speaches-realtime'

const decodeBase64 = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0))

describe('Speaches realtime protocol', () => {
  it('encodes clipped little-endian PCM16 audio', () => {
    const encoded = floatAudioToPcm16Base64(new Float32Array([-2, 0, 2]), 24_000)
    expect([...decodeBase64(encoded)]).toEqual([0, 128, 0, 0, 255, 127])
  })

  it('resamples input to 24 kHz', () => {
    const encoded = floatAudioToPcm16Base64(new Float32Array(480), 48_000)
    expect(decodeBase64(encoded).byteLength).toBe(240 * 2)
  })

  it('ignores malformed events and parses realtime events', () => {
    expect(parseSpeachesEvent('not json')).toBeUndefined()
    expect(parseSpeachesEvent('{"type":"input_audio_buffer.speech_stopped"}')?.type)
      .toBe('input_audio_buffer.speech_stopped')
  })

  it('flushes audio captured before a delayed connection in order', () => {
    const buffer = new PendingAudioBuffer()
    const sent: string[] = []
    buffer.append('first')
    buffer.append('second')
    buffer.flush(audio => sent.push(audio))
    buffer.flush(audio => sent.push(audio))
    expect(sent).toEqual(['first', 'second'])
  })

  it('discards buffered audio when startup is cancelled', () => {
    const buffer = new PendingAudioBuffer()
    const sent: string[] = []
    buffer.append('private audio')
    buffer.clear()
    buffer.flush(audio => sent.push(audio))
    expect(sent).toEqual([])
  })

  it('forces English without disturbing realtime URL parameters', () => {
    const base = 'ws://127.0.0.1:8000/v1/realtime?model=test/model&intent=transcription'
    expect(speachesRealtimeUrl(base, false)).toBe(base)
    const forced = new URL(speachesRealtimeUrl(base, true))
    expect(forced.searchParams.get('model')).toBe('test/model')
    expect(forced.searchParams.get('intent')).toBe('transcription')
    expect(forced.searchParams.get('language')).toBe('en')
  })
})

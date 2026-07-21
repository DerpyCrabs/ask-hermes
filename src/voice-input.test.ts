import { describe, expect, it, vi } from 'vitest'
import { HermesRecording, HermesSilenceDetector, VoiceStartGate, isVoiceInputShortcut, microphoneErrorMessage, normalizedVoiceLevel, preferredAudioMimeType, voiceInputTooltip } from './voice-input'

class FakeRecorder {
  state: RecordingState = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null

  start() { this.state = 'recording' }
  stop() { this.state = 'inactive' }
  data(blob: Blob) { this.ondataavailable?.({ data: blob } as BlobEvent) }
  stopped() { this.onstop?.() }
}

function fakeStream() {
  const track = { stop: vi.fn() }
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track }
}

describe('voice input helpers', () => {
  it('chooses the first supported Hermes-compatible recording type', () => {
    expect(preferredAudioMimeType(type => type === 'audio/mp4')).toBe('audio/mp4')
    expect(preferredAudioMimeType(() => false)).toBe('')
  })

  it('turns browser microphone failures into useful messages', () => {
    expect(microphoneErrorMessage(new DOMException('', 'NotAllowedError'))).toBe('Microphone access was denied')
    expect(microphoneErrorMessage(new DOMException('', 'NotFoundError'))).toBe('No microphone was found')
  })

  it('shows the shortcut and elapsed recording time', () => {
    expect(voiceInputTooltip('idle')).toBe('Voice input (Ctrl+Shift+D)')
    expect(voiceInputTooltip('recording', 65)).toBe('Stop voice input · 1:05 (Ctrl+Shift+D)')
  })

  it('matches Hermes Desktop silence timing after speech', () => {
    const detector = new HermesSilenceDetector(0)
    expect(detector.update(0.08, 100)).toBeUndefined()
    expect(detector.update(0.01, 200)).toBeUndefined()
    expect(detector.update(0.01, 1_449)).toBeUndefined()
    expect(detector.update(0.01, 1_450)).toBe('speech-ended')
  })

  it('stops an idle recording after twelve seconds without speech', () => {
    const detector = new HermesSilenceDetector(1_000)
    expect(detector.update(0.01, 12_999)).toBeUndefined()
    expect(detector.update(0.01, 13_000)).toBe('idle-timeout')
  })

  it('uses Hermes Desktop RMS normalization', () => {
    expect(normalizedVoiceLevel(new Uint8Array([128, 128]))).toBe(0)
    expect(normalizedVoiceLevel(new Uint8Array([170, 86]))).toBe(1)
  })

  it('isolates recorder callbacks between consecutive recordings', async () => {
    const oldRecorder = new FakeRecorder()
    const oldStream = fakeStream()
    const oldRecording = new HermesRecording(
      oldRecorder as unknown as MediaRecorder,
      oldStream.stream,
      'audio/webm',
      vi.fn(),
    )
    oldRecording.start()
    const staleStop = oldRecorder.onstop
    oldRecording.cancel()
    expect(await oldRecording.completion).toBeUndefined()
    expect(oldStream.track.stop).toHaveBeenCalledOnce()

    const newRecorder = new FakeRecorder()
    const newStream = fakeStream()
    const newRecording = new HermesRecording(
      newRecorder as unknown as MediaRecorder,
      newStream.stream,
      'audio/webm',
      vi.fn(),
    )
    newRecording.start()
    newRecorder.data(new Blob(['new audio']))
    staleStop?.()
    const completion = newRecording.stop()
    newRecorder.stopped()
    expect((await completion)?.size).toBe(9)
    expect(newStream.track.stop).toHaveBeenCalledOnce()
  })

  it('detaches handlers and resolves when recording fails', async () => {
    const recorder = new FakeRecorder()
    const source = fakeStream()
    const onError = vi.fn()
    const recording = new HermesRecording(
      recorder as unknown as MediaRecorder,
      source.stream,
      'audio/webm',
      onError,
    )
    recording.start()
    recorder.onerror?.()
    expect(await recording.completion).toBeUndefined()
    expect(onError).toHaveBeenCalledOnce()
    expect(recorder.onstop).toBeNull()
    expect(source.track.stop).toHaveBeenCalledOnce()
  })

  it('allows restart after cancellation without an older startup unlocking the new one', () => {
    const gate = new VoiceStartGate()
    expect(gate.tryStart(1)).toBe(true)
    gate.cancel()
    expect(gate.tryStart(2)).toBe(true)
    gate.finish(1)
    expect(gate.tryStart(3)).toBe(false)
    gate.finish(2)
    expect(gate.tryStart(3)).toBe(true)
  })

  it('recognizes the in-window voice shortcut without extra modifiers', () => {
    expect(isVoiceInputShortcut({ code: 'KeyD', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false })).toBe(true)
    expect(isVoiceInputShortcut({ code: 'KeyD', ctrlKey: true, shiftKey: true, altKey: true, metaKey: false })).toBe(false)
    expect(isVoiceInputShortcut({ code: 'KeyD', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false })).toBe(false)
  })
})

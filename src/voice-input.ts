export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing'
export type SilenceResult = 'speech-ended' | 'idle-timeout' | undefined

export class VoiceStartGate {
  private generation?: number

  tryStart(generation: number) {
    if (this.generation !== undefined) return false
    this.generation = generation
    return true
  }

  cancel() {
    this.generation = undefined
  }

  finish(generation: number) {
    if (this.generation === generation) this.generation = undefined
  }
}

export function isVoiceInputShortcut(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>) {
  return event.code === 'KeyD' && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
}

export class HermesSilenceDetector {
  private heardSpeech = false
  private silenceStartedAt?: number

  constructor(
    private startedAt: number,
    private speechThreshold = 0.075,
    private silenceMs = 1_250,
    private idleSilenceMs = 12_000,
  ) {}

  update(level: number, now: number): SilenceResult {
    if (level >= this.speechThreshold) {
      this.heardSpeech = true
      this.silenceStartedAt = undefined
      return undefined
    }
    if (this.heardSpeech) {
      this.silenceStartedAt ??= now
      if (now - this.silenceStartedAt >= this.silenceMs) return 'speech-ended'
    } else if (now - this.startedAt >= this.idleSilenceMs) {
      return 'idle-timeout'
    }
    return undefined
  }
}

export function normalizedVoiceLevel(samples: Uint8Array) {
  let sum = 0
  for (const value of samples) {
    const centered = value - 128
    sum += centered * centered
  }
  return Math.min(1, Math.sqrt(sum / samples.length) / 42)
}

export class HermesRecording {
  private chunks: Blob[] = []
  private settled = false
  private resolve!: (blob?: Blob) => void
  readonly completion = new Promise<Blob | undefined>(resolve => { this.resolve = resolve })

  constructor(
    private recorder: MediaRecorder,
    private stream: MediaStream,
    private mimeType: string,
    private onError: () => void,
  ) {}

  start() {
    this.recorder.ondataavailable = event => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    this.recorder.onstop = () => {
      const blob = this.chunks.length
        ? new Blob(this.chunks, { type: this.recorder.mimeType || this.mimeType || 'audio/webm' })
        : undefined
      this.finish(blob)
    }
    this.recorder.onerror = () => {
      this.finish()
      this.onError()
    }
    this.recorder.start()
  }

  stop() {
    if (!this.settled && this.recorder.state !== 'inactive') this.recorder.stop()
    else if (!this.settled) this.finish()
    return this.completion
  }

  cancel() {
    if (this.settled) return
    this.detachRecorder()
    if (this.recorder.state !== 'inactive') {
      try { this.recorder.stop() } catch { /* recorder is already shutting down */ }
    }
    this.finish()
  }

  private detachRecorder() {
    this.recorder.ondataavailable = null
    this.recorder.onstop = null
    this.recorder.onerror = null
  }

  private finish(blob?: Blob) {
    if (this.settled) return
    this.settled = true
    this.detachRecorder()
    this.chunks = []
    this.stream.getTracks().forEach(track => track.stop())
    this.resolve(blob)
  }
}

const AUDIO_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/wav',
]

export function preferredAudioMimeType(isSupported: (mimeType: string) => boolean) {
  return AUDIO_TYPES.find(isSupported) || ''
}

export function microphoneErrorMessage(error: unknown) {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was denied'
  if (name === 'NotFoundError') return 'No microphone was found'
  if (name === 'NotReadableError') return 'The microphone is already in use or unavailable'
  if (name === 'OverconstrainedError') return 'The microphone does not support the requested recording settings'
  return error instanceof Error ? error.message : String(error)
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read the voice recording'))
    reader.onerror = () => reject(reader.error || new Error('Could not read the voice recording'))
    reader.readAsDataURL(blob)
  })
}

function elapsedLabel(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function voiceInputTooltip(status: VoiceInputStatus, elapsedSeconds = 0) {
  if (status === 'recording') return `Stop voice input · ${elapsedLabel(elapsedSeconds)} (Ctrl+Shift+D)`
  if (status === 'transcribing') return 'Transcribing voice input…'
  return 'Voice input (Ctrl+Shift+D)'
}

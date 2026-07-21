export const SPEACHES_SAMPLE_RATE = 24_000

export function speachesRealtimeUrl(baseUrl: string, forceEnglish: boolean) {
  if (!forceEnglish) return baseUrl
  const url = new URL(baseUrl)
  url.searchParams.set('language', 'en')
  return url.toString()
}

export type SpeachesRealtimeCallbacks = {
  onSpeechStarted?: () => void
  onSpeechStopped?: () => void
  onTranscriptDelta?: (delta: string) => void
  onComplete: (transcript: string) => void
  onError: (message: string) => void
}

type RealtimeEvent = {
  type?: string
  delta?: string
  transcript?: string
  error?: { message?: string }
}

export function parseSpeachesEvent(raw: string): RealtimeEvent | undefined {
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && typeof value.type === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

export function floatAudioToPcm16Base64(input: Float32Array, sourceRate: number) {
  const targetLength = sourceRate === SPEACHES_SAMPLE_RATE
    ? input.length
    : Math.max(1, Math.round(input.length * SPEACHES_SAMPLE_RATE / sourceRate))
  const bytes = new Uint8Array(targetLength * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < targetLength; index += 1) {
    const sourceIndex = sourceRate === SPEACHES_SAMPLE_RATE
      ? index
      : Math.min(input.length - 1, Math.floor(index * sourceRate / SPEACHES_SAMPLE_RATE))
    const sample = Math.max(-1, Math.min(1, input[sourceIndex] || 0))
    view.setInt16(index * 2, sample < 0 ? sample * 32768 : sample * 32767, true)
  }
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return btoa(binary)
}

export class PendingAudioBuffer {
  private items: string[] = []

  append(audio: string) {
    this.items.push(audio)
  }

  flush(send: (audio: string) => void) {
    for (const audio of this.items) send(audio)
    this.items = []
  }

  clear() {
    this.items = []
  }
}

export class SpeachesRealtimeSession {
  private socket?: WebSocket
  private context?: AudioContext
  private source?: MediaStreamAudioSourceNode
  private processor?: AudioWorkletNode
  private sink?: GainNode
  private stream?: MediaStream
  private pendingAudio = new PendingAudioBuffer()
  private stopped = false
  private completed = false

  constructor(private callbacks: SpeachesRealtimeCallbacks) {}

  async start(websocketUrl: string | Promise<string>, stream: MediaStream) {
    this.stream = stream
    const context = new AudioContext({ sampleRate: SPEACHES_SAMPLE_RATE })
    this.context = context
    await context.audioWorklet.addModule('/speaches-pcm-worklet.js')
    const source = context.createMediaStreamSource(stream)
    const processor = new AudioWorkletNode(context, 'speaches-pcm-processor')
    const sink = context.createGain()
    sink.gain.value = 0
    processor.port.onmessage = event => {
      if (this.stopped) return
      const samples = event.data instanceof Float32Array ? event.data : new Float32Array(event.data)
      const audio = floatAudioToPcm16Base64(samples, context.sampleRate)
      if (this.socket?.readyState === WebSocket.OPEN) this.sendAudio(audio)
      else this.pendingAudio.append(audio)
    }
    source.connect(processor)
    processor.connect(sink)
    sink.connect(context.destination)
    this.source = source
    this.processor = processor
    this.sink = sink
    await context.resume()

    const resolvedUrl = await websocketUrl
    if (this.completed) return
    const socket = new WebSocket(resolvedUrl)
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Speaches realtime connection timed out')), 30_000)
      socket.onopen = () => {
        window.clearTimeout(timeout)
        resolve()
      }
      socket.onerror = () => {
        window.clearTimeout(timeout)
        reject(new Error('Could not connect to native Speaches'))
      }
    })

    socket.onmessage = event => this.handleMessage(String(event.data))
    socket.onerror = () => this.fail('Native Speaches connection failed')
    socket.onclose = () => {
      if (!this.completed) this.fail('Native Speaches disconnected')
    }
    socket.send(JSON.stringify({
      type: 'session.update',
      session: {
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          silence_duration_ms: 1_250,
          create_response: false,
        },
      },
    }))
    this.pendingAudio.flush(audio => this.sendAudio(audio))
    if (this.stopped) socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
  }

  private sendAudio(audio: string) {
    this.socket?.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio,
    }))
  }

  stop() {
    if (this.stopped) return
    this.stopAudio()
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
    }
  }

  cancel() {
    this.completed = true
    this.pendingAudio.clear()
    this.stopAudio()
    this.socket?.close()
    this.socket = undefined
  }

  private stopAudio() {
    if (this.stopped) return
    this.stopped = true
    this.processor?.disconnect()
    this.source?.disconnect()
    this.sink?.disconnect()
    this.processor = undefined
    this.source = undefined
    this.sink = undefined
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = undefined
    void this.context?.close()
    this.context = undefined
  }

  private handleMessage(raw: string) {
    const event = parseSpeachesEvent(raw)
    if (!event) return
    if (event.type === 'input_audio_buffer.speech_started') this.callbacks.onSpeechStarted?.()
    if (event.type === 'input_audio_buffer.speech_stopped') {
      this.stopAudio()
      this.callbacks.onSpeechStopped?.()
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta' && event.delta) {
      this.callbacks.onTranscriptDelta?.(event.delta)
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      this.completed = true
      this.pendingAudio.clear()
      this.stopAudio()
      this.callbacks.onComplete(event.transcript || '')
      this.socket?.close()
      this.socket = undefined
    }
    if (event.type === 'error') this.fail(event.error?.message || 'Native Speaches reported an error')
  }

  private fail(message: string) {
    if (this.completed) return
    this.completed = true
    this.pendingAudio.clear()
    this.stopAudio()
    this.socket?.close()
    this.socket = undefined
    this.callbacks.onError(message)
  }
}

class SpeachesPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = []
    this.chunkSize = Math.max(1, Math.round(sampleRate / 10))
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    for (const sample of channel) this.samples.push(sample)
    while (this.samples.length >= this.chunkSize) {
      const chunk = new Float32Array(this.samples.splice(0, this.chunkSize))
      this.port.postMessage(chunk, [chunk.buffer])
    }
    return true
  }
}

registerProcessor('speaches-pcm-processor', SpeachesPcmProcessor)

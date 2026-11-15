// Forwards microphone audio to the main thread in ~32 ms blocks (512 samples
// at 16 kHz). Voice activity detection and transcription happen there.
class ChunkForwarder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(512)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) {
      return true
    }
    let offset = 0
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, this.buffer.length - this.filled)
      this.buffer.set(channel.subarray(offset, offset + count), this.filled)
      this.filled += count
      offset += count
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer.slice())
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('chunk-forwarder', ChunkForwarder)

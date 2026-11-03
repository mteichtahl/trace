// Dictation's microphone capture (web/src/components/chat/voice/dictation.ts): downsample to 16 kHz and post 16-bit
// PCM chunks with a level for the meter. A file of the app's own, because the content policy allows scripts from
// 'self' only, and worklets are scripts: a blob: module is refused.
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.buf = []; this.acc = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    let sum = 0
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i]
    for (let i = 0; i < ch.length; i++) {
      this.acc += 1
      if (this.acc >= this.ratio) { this.acc -= this.ratio; this.buf.push(ch[i]) }
    }
    if (this.buf.length >= 1600) {
      const pcm = new Int16Array(this.buf.length)
      for (let i = 0; i < this.buf.length; i++) { const s = Math.max(-1, Math.min(1, this.buf[i])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff }
      this.port.postMessage({ pcm: pcm.buffer, level: Math.sqrt(sum / ch.length) }, [pcm.buffer])
      this.buf = []
    } else {
      this.port.postMessage({ level: Math.sqrt(sum / ch.length) })
    }
    return true
  }
}
registerProcessor('trace-capture', Capture)

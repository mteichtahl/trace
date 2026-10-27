/**
 * Dictation with Amazon Transcribe streaming. The web backend hands out a short-lived signed WebSocket URL
 * (/api/voice/listen); the browser captures the microphone with an AudioWorklet, resamples to 16 kHz 16-bit PCM,
 * frames each chunk as an AudioEvent and reads TranscriptEvents back. Words appear live; partial results are
 * replaced as they firm up. Audio streams only while the mic is live and is never stored.
 */
import { api } from '@/lib/api'
import { audioEvent, readTranscript } from './eventstream'

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor(o) { super(); this.ratio = sampleRate / 16000; this.buf = []; this.acc = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    let sum = 0
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i]
    // downsample by averaging into 16 kHz
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
`

export interface DictationHandlers {
  /** the text so far: firm words plus the current partial */
  onText: (text: string, partial: boolean) => void
  /** 0..1, for the level meter */
  onLevel?: (level: number) => void
  onError?: (message: string) => void
  onEnd?: () => void
}

/** Whether the project's own words (its Transcribe custom vocabulary) are in use, as /api/voice/listen says. */
export interface DictationWords { state: 'READY' | 'PENDING' | 'FAILED' | 'NONE'; used: boolean; note: string }

export interface Dictation {
  stop: () => void
  /** the project's words, when a project was named */
  words: DictationWords | null
}

export async function startDictation(o: { language: string; repo?: string } & DictationHandlers): Promise<Dictation> {
  const { url, vocabulary } = await api<{ url: string; vocabulary?: DictationWords }>('/api/voice/listen', { method: 'POST', body: { language: o.language, ...(o.repo ? { repo: o.repo } : {}) } })
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
  const ctx = new AudioContext()
  const blob = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
  await ctx.audioWorklet.addModule(blob)
  URL.revokeObjectURL(blob)
  const src = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'trace-capture')
  src.connect(node)

  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  let firm = ''
  let stopped = false

  node.port.onmessage = (e: MessageEvent<{ pcm?: ArrayBuffer; level: number }>) => {
    o.onLevel?.(Math.min(1, e.data.level * 4))
    if (e.data.pcm && ws.readyState === WebSocket.OPEN) ws.send(audioEvent(new Uint8Array(e.data.pcm)))
  }
  ws.onmessage = (e) => {
    try {
      const { results, error } = readTranscript(new Uint8Array(e.data as ArrayBuffer))
      if (error) {
        o.onError?.(error)
        return
      }
      for (const r of results) {
        if (r.partial) o.onText(`${firm}${firm && r.text ? ' ' : ''}${r.text}`, true)
        else {
          firm = `${firm}${firm && r.text ? ' ' : ''}${r.text}`
          o.onText(firm, false)
        }
      }
    } catch (err) {
      o.onError?.(err instanceof Error ? err.message : String(err))
    }
  }
  ws.onerror = () => o.onError?.('The dictation connection failed.')
  ws.onclose = () => cleanup()

  function cleanup() {
    if (stopped) return
    stopped = true
    node.port.onmessage = null
    src.disconnect()
    node.disconnect()
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
    o.onEnd?.()
  }

  return {
    words: vocabulary ?? null,
    stop() {
      // an empty AudioEvent tells Transcribe the audio has ended; it then sends its last results and closes
      if (ws.readyState === WebSocket.OPEN) ws.send(audioEvent(new Uint8Array(0)))
      setTimeout(() => ws.close(), 1500)
      cleanup()
    },
  }
}

/** Spoken commands at the end of dictated text: "send", "cancel", "stop", "read that again". */
export type SpokenCommand = 'send' | 'cancel' | 'stop' | 'read-again'
export function spokenCommand(text: string): { command: SpokenCommand; rest: string } | null {
  const m = /(?:^|\s)(send|cancel|stop|read that again)[.!?]?\s*$/i.exec(text)
  if (!m) return null
  const word = m[1]!.toLowerCase()
  const command: SpokenCommand = word === 'read that again' ? 'read-again' : (word as SpokenCommand)
  return { command, rest: text.slice(0, m.index).trim() }
}

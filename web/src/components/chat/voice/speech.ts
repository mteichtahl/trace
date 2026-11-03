/**
 * Reading replies aloud with Amazon Polly (/api/voice/speak → a signed MP3 URL and word speech marks). One player
 * for the app: play a message from the start, highlight the word being spoken, jump to a sentence, Pause, Stop, Skip
 * and speed (0.75× to 1.5×). Speech stops when the person starts typing or speaking.
 */
import { api } from '@/lib/api'
import { createStore, useStore } from '@/lib/store'
import type { SpeechMark, Voice } from '@/lib/types'

export interface Speaking {
  messageId: string | null
  playing: boolean
  /** the character range in the spoken text of the current word */
  word: { start: number; end: number } | null
  voice: string | null
  /** the engine the voice is read with: neural where the voice has it, otherwise generative */
  engine: 'neural' | 'generative'
  /** the person's language, so the backend can choose a voice when none is picked */
  language: string
  rate: number
}

export const speech = createStore<Speaking>({ messageId: null, playing: false, word: null, voice: null, engine: 'neural', language: 'en-AU', rate: 1 })
export const useSpeech = () => useStore(speech)

let audio: HTMLAudioElement | null = null
/** One element for the whole app: a phone lets it play later only once a tap has played it (unlockAudio). */
let player: HTMLAudioElement | null = null
const element = (): HTMLAudioElement => (player ??= new Audio())

/** A tenth of a second of silence (8 kHz, 8-bit WAV), to unlock the player inside a tap. */
function silence(): string {
  const n = 800
  const b = new ArrayBuffer(44 + n)
  const v = new DataView(b)
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true)
  v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, 'data'); v.setUint32(40, n, true)
  new Uint8Array(b, 44).fill(128)
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }))
}

let unlocked = false
/** Call inside a tap (any tap will do): after it, replies can be read aloud without one, as on a phone they must. */
export function unlockAudio() {
  if (unlocked) return
  const a = element()
  if (!a.paused) return
  const src = silence()
  a.src = src
  a.play().then(() => { unlocked = true; a.pause() }).catch(() => {}).finally(() => URL.revokeObjectURL(src))
}

/** The person's saved voice, engine, speed and language (from their preferences). */
export function configureSpeech(o: Partial<Pick<Speaking, 'voice' | 'engine' | 'rate' | 'language'>>) {
  speech.set((s) => ({ ...s, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) }))
}
let marks: SpeechMark[] = []
let raf = 0
let queue: { id: string; text: string }[] = []

/** Speech-friendly text: code, tables and file previews become a short line; markdown marks go. */
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (A code block follows on screen.) ')
    .replace(/(^\|.*\|\s*$\n?)+/gm, (t) => ` (A table of ${Math.max(0, t.trim().split('\n').length - 2)} rows follows on screen.) `)
    .replace(/\$\$[\s\S]*?\$\$/g, ' (A formula follows on screen.) ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function tick() {
  if (!audio) return
  const t = audio.currentTime * 1000
  let cur: SpeechMark | undefined
  for (const m of marks) {
    if (m.type !== 'word') continue
    if (m.time <= t) cur = m
    else break
  }
  speech.set((s) => ({ ...s, word: cur ? { start: cur.start, end: cur.end } : null }))
  raf = requestAnimationFrame(tick)
}

export async function speak(id: string, markdown: string, o: { voice?: string; engine?: 'neural' | 'generative'; rate?: number; fromChar?: number } = {}): Promise<void> {
  stopSpeaking()
  const text = speakable(markdown)
  const s = speech.get()
  const voice = o.voice ?? s.voice ?? undefined
  const engine = o.engine ?? (o.voice ? 'neural' : s.engine)
  const rate = o.rate ?? s.rate
  const r = await api<{ url: string; marks: SpeechMark[] }>('/api/voice/speak', { method: 'POST', body: { text, rate, engine, language: s.language, ...(voice ? { voice } : {}) } })
  marks = r.marks
  audio = element()
  audio.src = r.url
  audio.playbackRate = rate
  if (o.fromChar) {
    const m = marks.find((x) => x.start >= o.fromChar!)
    if (m) audio.currentTime = m.time / 1000
  }
  audio.onended = () => {
    cancelAnimationFrame(raf)
    speech.set((x) => ({ ...x, playing: false, messageId: null, word: null }))
    const next = queue.shift()
    if (next) void speak(next.id, next.text).catch(() => {})
  }
  speech.set((x) => ({ ...x, messageId: id, playing: true, word: null }))
  try {
    await audio.play()
  } catch (e) {
    speech.set((x) => ({ ...x, playing: false, messageId: null, word: null }))
    throw e
  }
  raf = requestAnimationFrame(tick)
}

/** For "read replies aloud": queue a reply to be read after the current one. */
export function enqueueSpeech(id: string, markdown: string) {
  if (speech.get().playing) queue.push({ id, text: markdown })
  else void speak(id, markdown).catch(() => {})
}

export function pauseSpeaking() {
  if (!audio) return
  if (audio.paused) {
    void audio.play()
    speech.set((s) => ({ ...s, playing: true }))
  } else {
    audio.pause()
    speech.set((s) => ({ ...s, playing: false }))
  }
}

export function stopSpeaking() {
  queue = []
  cancelAnimationFrame(raf)
  audio?.pause()
  audio = null
  speech.set((s) => ({ ...s, playing: false, messageId: null, word: null }))
}

export function skipSpeaking() {
  cancelAnimationFrame(raf)
  audio?.pause()
  audio = null
  const next = queue.shift()
  speech.set((s) => ({ ...s, playing: false, messageId: null, word: null }))
  if (next) void speak(next.id, next.text).catch(() => {})
}

export function setRate(rate: number) {
  const r = Math.min(1.5, Math.max(0.75, rate))
  if (audio) audio.playbackRate = r
  speech.set((s) => ({ ...s, rate: r }))
}

export const setVoice = (voice: string, engines?: readonly string[]) =>
  speech.set((s) => ({ ...s, voice, engine: !engines || engines.includes('neural') ? 'neural' : 'generative' }))

export const listVoices = (language: string) => api<{ voices: Voice[] }>(`/api/voice/voices?language=${encodeURIComponent(language)}`)

export async function previewVoice(voice: string, engines?: readonly string[]) {
  const engine = !engines || engines.includes('neural') ? 'neural' : 'generative'
  await speak(`preview-${voice}`, 'Hello. This is how trace sounds with this voice.', { voice, engine })
}

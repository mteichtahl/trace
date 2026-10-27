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
  rate: number
}

export const speech = createStore<Speaking>({ messageId: null, playing: false, word: null, voice: null, rate: 1 })
export const useSpeech = () => useStore(speech)

let audio: HTMLAudioElement | null = null
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

export async function speak(id: string, markdown: string, o: { voice?: string; rate?: number; fromChar?: number } = {}): Promise<void> {
  stopSpeaking()
  const text = speakable(markdown)
  const s = speech.get()
  const voice = o.voice ?? s.voice ?? undefined
  const rate = o.rate ?? s.rate
  const r = await api<{ url: string; marks: SpeechMark[] }>('/api/voice/speak', { method: 'POST', body: { text, voice, rate } })
  marks = r.marks
  audio = new Audio(r.url)
  audio.playbackRate = rate
  if (o.fromChar) {
    const m = marks.find((x) => x.start >= o.fromChar!)
    if (m) audio.currentTime = m.time / 1000
  }
  audio.onended = () => {
    cancelAnimationFrame(raf)
    speech.set((x) => ({ ...x, playing: false, messageId: null, word: null }))
    const next = queue.shift()
    if (next) void speak(next.id, next.text)
  }
  speech.set((x) => ({ ...x, messageId: id, playing: true, word: null }))
  await audio.play()
  raf = requestAnimationFrame(tick)
}

/** For "read replies aloud": queue a reply to be read after the current one. */
export function enqueueSpeech(id: string, markdown: string) {
  if (speech.get().playing) queue.push({ id, text: markdown })
  else void speak(id, markdown)
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
  if (next) void speak(next.id, next.text)
}

export function setRate(rate: number) {
  const r = Math.min(1.5, Math.max(0.75, rate))
  if (audio) audio.playbackRate = r
  speech.set((s) => ({ ...s, rate: r }))
}

export const setVoice = (voice: string) => speech.set((s) => ({ ...s, voice }))

export const listVoices = (language: string) => api<{ voices: Voice[] }>(`/api/voice/voices?language=${encodeURIComponent(language)}`)

export async function previewVoice(voice: string) {
  await speak(`preview-${voice}`, 'Hello. This is how trace sounds with this voice.', { voice })
}

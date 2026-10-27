/**
 * /api/voice: Amazon Polly speech and Amazon Transcribe streaming, with no AWS keys in the browser.
 *
 *   voices   DescribeVoices for a language, neural and generative voices only: { id, name, gender, engines }
 *   speak    SynthesizeSpeech as MP3 and as word speech marks, cached in the voice bucket under
 *            `<voicePrefix>/<sha256(voice|engine|rate|text)>.mp3` (and `.json` for the marks), so a replay costs
 *            nothing; answered with presigned GET URLs (5 minutes) and the marks themselves. Text over 3,000
 *            characters is split at sentence (then word) boundaries and answered as `parts`, in order; the first part
 *            is also `url` and `marks`. A rate other than 1 is SSML prosody. Generative voices make no speech marks:
 *            their `marks` is empty.
 *   listen   a presigned WebSocket URL for StartStreamTranscriptionWebSocket (SigV4 query signing, service
 *            transcribe, 5 minutes): PCM, 16 kHz. The browser streams audio straight to Transcribe.
 *            Follow-up: per-project custom vocabularies (`repo`) need a vocabulary made ahead per project; until the
 *            project's parts and net names are reachable here, `repo` is accepted and ignored.
 */
import { createHash } from 'node:crypto'
import { Sha256 } from '@aws-crypto/sha256-js'
import type { Engine, LanguageCode, VoiceId } from '@aws-sdk/client-polly'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import { z } from 'zod'
import type { WebConfig } from './config.js'
import { type WebDeps, signedIn } from './deps.js'
import { WebError, parseBody, route } from './http.js'
import type { Credentials } from './ports.js'

export const MAX_TEXT = 3000
const URL_SECONDS = 300
const ENGINES = ['neural', 'generative'] as const

const Language = z.string().regex(/^[a-z]{2,3}-[A-Z]{2}$/, 'a language code such as en-AU')
const Speak = z.object({
  text: z.string().min(1).max(100_000),
  voice: z.string().min(1).max(64).regex(/^[A-Za-z-]+$/),
  engine: z.enum(ENGINES).default('neural'),
  rate: z.number().min(0.75).max(1.5).default(1),
})
const Listen = z.object({ language: Language, repo: z.string().max(200).optional() })

/** The cache key of one piece of speech. */
export const speechKey = (prefix: string, voice: string, engine: string, rate: number, text: string): string =>
  `${prefix.replace(/\/+$/, '')}/${createHash('sha256').update(`${voice}|${engine}|${rate}|${text}`).digest('hex')}`

/** Split text into pieces of at most `max` characters, at sentence ends where possible, then at spaces. */
export function splitText(text: string, max = MAX_TEXT): string[] {
  const t = text.trim()
  if (t.length <= max) return [t]
  const out: string[] = []
  let rest = t
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '), window.lastIndexOf('\n'))
    if (cut < max / 2) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = max - 1
    out.push(rest.slice(0, cut + 1).trim())
    rest = rest.slice(cut + 1).trim()
  }
  if (rest) out.push(rest)
  return out
}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const Mark = z.object({ time: z.number(), type: z.string(), start: z.number().optional(), end: z.number().optional(), value: z.string() }).loose()
export type Mark = z.output<typeof Mark>

/** Polly's speech marks (one JSON object per line). */
export const parseMarks = (s: string): Mark[] => s.split('\n').filter((l) => l.trim()).flatMap((l) => {
  try { const m = Mark.safeParse(JSON.parse(l)); return m.success ? [m.data] : [] } catch { return [] }
})

/** The presigned Transcribe streaming URL (wss, SigV4 in the query, X-Amz-Expires 300). */
export async function transcribeUrl(region: string, language: string, credentials: Credentials, now: Date = new Date()): Promise<string> {
  const hostname = `transcribestreaming.${region}.amazonaws.com:8443`
  const signer = new SignatureV4({ service: 'transcribe', region, credentials, sha256: Sha256 })
  const req = new HttpRequest({
    method: 'GET', protocol: 'wss:', hostname, path: '/stream-transcription-websocket',
    headers: { host: hostname },
    query: { 'language-code': language, 'media-encoding': 'pcm', 'sample-rate': '16000' },
  })
  const signed = await signer.presign(req, { expiresIn: URL_SECONDS, signingDate: now })
  const q = Object.entries(signed.query ?? {}).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x] as const) : v === null ? [] : [[k, v] as const]))
  const qs = q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  return `wss://${hostname}${signed.path}?${qs}`
}

async function speakOne(deps: WebDeps, c: WebConfig, b: z.output<typeof Speak>, text: string): Promise<{ url: string; marks: Mark[] }> {
  const store = deps.store(c)
  const base = speechKey(c.voicePrefix, b.voice, b.engine, b.rate, text)
  const mp3 = `${base}.mp3`
  const json = `${base}.json`
  const ssml = b.rate !== 1
  const input = ssml ? `<speak><prosody rate="${Math.round(b.rate * 100)}%">${escapeXml(text)}</prosody></speak>` : text
  const common = { Engine: b.engine as Engine, VoiceId: b.voice as VoiceId, Text: input, TextType: ssml ? 'ssml' as const : 'text' as const }
  let marks: Mark[] = []
  if (await store.exists(c.voiceBucket, mp3)) {
    if (b.engine !== 'generative') marks = parseMarks(await store.getText(c.voiceBucket, json).catch(() => ''))
  } else {
    const polly = deps.polly(c)
    const [audio, rawMarks] = await Promise.all([
      polly.synthesize({ ...common, OutputFormat: 'mp3' }),
      b.engine === 'generative' ? Promise.resolve(null) : polly.synthesize({ ...common, OutputFormat: 'json', SpeechMarkTypes: ['word'] }),
    ])
    const marksText = rawMarks ? Buffer.from(rawMarks).toString('utf8') : ''
    marks = parseMarks(marksText)
    // the marks first: a cached MP3 always has its marks beside it
    if (rawMarks) await store.put(c.voiceBucket, json, marksText, 'application/x-ndjson')
    await store.put(c.voiceBucket, mp3, audio, 'audio/mpeg')
  }
  return { url: await store.presignGet(c.voiceBucket, mp3, URL_SECONDS), marks }
}

const pollyError = (e: unknown): WebError => {
  const name = e instanceof Error ? e.name : ''
  if (/Throttl|TooManyRequests/.test(name)) return new WebError(429, 'speech is busy: try again in a moment', 'throttled')
  if (/InvalidSsml|TextLengthExceeded|LanguageNotSupported|EngineNotSupported|InvalidParameter|Validation/.test(name)) return new WebError(400, 'that voice cannot read this text', name)
  return new WebError(500, 'speech is not available right now', 'polly')
}

export function voiceRoutes(deps: WebDeps) {
  return [
    route('GET', '/api/voice/voices', async (req, ctx) => {
      const s = await signedIn(req, ctx, deps)
      const lang = Language.safeParse(req.query.get('language') ?? 'en-US')
      if (!lang.success) throw new WebError(400, 'language: a language code such as en-AU', 'bad_request')
      const voices = await deps.polly(s.config).describeVoices({ LanguageCode: lang.data as LanguageCode, IncludeAdditionalLanguageCodes: true }).catch((e: unknown) => { throw pollyError(e) })
      const out = voices
        .map((v) => ({ id: v.Id ?? '', name: v.Name ?? v.Id ?? '', gender: v.Gender ?? null, engines: (v.SupportedEngines ?? []).filter((e): e is (typeof ENGINES)[number] => (ENGINES as readonly string[]).includes(e)) }))
        .filter((v) => v.id && v.engines.length)
        .sort((a, b) => a.name.localeCompare(b.name))
      return { body: { voices: out } }
    }),

    route('POST', '/api/voice/speak', async (req, ctx) => {
      const s = await signedIn(req, ctx, deps)
      const b = parseBody(req, Speak)
      const pieces = splitText(b.text)
      const parts: { url: string; marks: Mark[] }[] = []
      for (const p of pieces) parts.push(await speakOne(deps, s.config, b, p).catch((e: unknown) => { throw e instanceof WebError ? e : pollyError(e) }))
      const first = parts[0] as { url: string; marks: Mark[] }
      return { body: { url: first.url, marks: first.marks, ...(parts.length > 1 ? { parts } : {}) } }
    }),

    route('POST', '/api/voice/listen', async (req, ctx) => {
      const s = await signedIn(req, ctx, deps)
      const b = parseBody(req, Listen)
      return { body: { url: await transcribeUrl(s.config.region, b.language, deps.credentials, new Date(deps.now())), expiresIn: URL_SECONDS, sampleRate: 16000, encoding: 'pcm' } }
    }),
  ]
}

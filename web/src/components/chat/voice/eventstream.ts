/**
 * The AWS event-stream binary framing Transcribe streaming speaks over its WebSocket:
 *
 *   [total length u32][headers length u32][prelude CRC32 u32][headers…][payload…][message CRC32 u32]
 *
 * Each header: [name length u8][name utf-8][type u8][value]. Only the types Transcribe uses are needed here:
 * 7 (string: [length u16][utf-8]). Others are skipped by their known sizes when decoding.
 */

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(bytes: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export type Headers = Record<string, string>
export interface EventMessage {
  headers: Headers
  payload: Uint8Array
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function encodeMessage(m: EventMessage): Uint8Array {
  const parts: Uint8Array[] = []
  for (const [name, value] of Object.entries(m.headers)) {
    const n = enc.encode(name)
    const v = enc.encode(value)
    const h = new Uint8Array(1 + n.length + 1 + 2 + v.length)
    const dv = new DataView(h.buffer)
    h[0] = n.length
    h.set(n, 1)
    h[1 + n.length] = 7
    dv.setUint16(2 + n.length, v.length)
    h.set(v, 4 + n.length)
    parts.push(h)
  }
  const headersLen = parts.reduce((a, p) => a + p.length, 0)
  const total = 12 + headersLen + m.payload.length + 4
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, total)
  dv.setUint32(4, headersLen)
  dv.setUint32(8, crc32(out.subarray(0, 8)))
  let o = 12
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  out.set(m.payload, o)
  dv.setUint32(total - 4, crc32(out.subarray(0, total - 4)))
  return out
}

export function decodeMessage(bytes: Uint8Array): EventMessage {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const total = dv.getUint32(0)
  const headersLen = dv.getUint32(4)
  if (total !== bytes.length) throw new Error(`event-stream: length ${bytes.length}, expected ${total}`)
  if (dv.getUint32(8) !== crc32(bytes.subarray(0, 8))) throw new Error('event-stream: prelude checksum')
  if (dv.getUint32(total - 4) !== crc32(bytes.subarray(0, total - 4))) throw new Error('event-stream: message checksum')
  const headers: Headers = {}
  let o = 12
  const end = 12 + headersLen
  while (o < end) {
    const nl = bytes[o]!
    const name = dec.decode(bytes.subarray(o + 1, o + 1 + nl))
    o += 1 + nl
    const type = bytes[o]!
    o += 1
    switch (type) {
      case 0: case 1: headers[name] = String(type === 0); break
      case 2: o += 1; break
      case 3: o += 2; break
      case 4: o += 4; break
      case 5: case 8: o += 8; break
      case 9: o += 16; break
      case 6: case 7: {
        const len = dv.getUint16(o)
        const v = bytes.subarray(o + 2, o + 2 + len)
        if (type === 7) headers[name] = dec.decode(v)
        o += 2 + len
        break
      }
      default: throw new Error(`event-stream: header type ${type}`)
    }
  }
  return { headers, payload: bytes.slice(end, total - 4) }
}

/** An AudioEvent carrying PCM: what the browser sends for each chunk of audio. */
export const audioEvent = (pcm: Uint8Array): Uint8Array =>
  encodeMessage({ headers: { ':content-type': 'application/octet-stream', ':event-type': 'AudioEvent', ':message-type': 'event' }, payload: pcm })

export interface TranscriptResult {
  text: string
  partial: boolean
  resultId: string
}

/** Read a TranscriptEvent (or an exception) from Transcribe. */
export function readTranscript(bytes: Uint8Array): { results: TranscriptResult[]; error?: string } {
  const m = decodeMessage(bytes)
  const body = m.payload.length ? JSON.parse(dec.decode(m.payload)) : {}
  if (m.headers[':message-type'] === 'exception') return { results: [], error: body.Message ?? m.headers[':exception-type'] ?? 'Transcribe error' }
  const results = (body.Transcript?.Results ?? []) as { Alternatives?: { Transcript?: string }[]; IsPartial?: boolean; ResultId?: string }[]
  return {
    results: results.map((r) => ({ text: r.Alternatives?.[0]?.Transcript ?? '', partial: !!r.IsPartial, resultId: r.ResultId ?? '' })),
  }
}

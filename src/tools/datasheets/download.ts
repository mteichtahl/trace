/**
 * Downloading a vendor's datasheet.
 *
 * Vendors' sites refuse obvious robots, so the request looks like a browser. Redirects are followed by hand (at most
 * six hops) so each hop can be checked: only http(s), no credentials in the URL, and never a private, loopback or
 * link-local address (a cloud instance's metadata service, anything inside a VPC). The body is capped, and what comes
 * back must start with the PDF magic bytes — a vendor's product page is not a datasheet, and is refused with a note
 * to upload the document instead. A page that only wraps the document (LCSC's datasheet links answer an HTML viewer
 * whose iframe loads the PDF) is followed once to the document it embeds, as one more hop under the same checks.
 */
import { lookup as lookupCb, type LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'

export const MAX_BYTES = 60 * 1024 * 1024
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export class DownloadError extends Error {
  override name = 'DownloadError'
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>
export type ResolveHost = (host: string) => Promise<string[]>

export const dnsResolve: ResolveHost = async (host) => (await lookup(host, { all: true })).map((a) => a.address)

export function isPdf(b: Uint8Array): boolean {
  return b.length > 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d // %PDF-
}

/** The eight 16-bit groups of an IPv6 address (a trailing dotted IPv4 part included), or null if it is not one. */
function ipv6Groups(ip: string): number[] | null {
  let x = ip.toLowerCase().split('%')[0] ?? ''
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(x)
  if (dotted) {
    const o = (dotted[2] ?? '').split('.').map(Number)
    if (o.length !== 4 || o.some((n) => !(n >= 0 && n <= 255))) return null
    x = `${dotted[1] ?? ''}${((o[0] ?? 0) * 256 + (o[1] ?? 0)).toString(16)}:${((o[2] ?? 0) * 256 + (o[3] ?? 0)).toString(16)}`
  }
  const halves = x.split('::')
  if (halves.length > 2) return null
  const part = (h: string): string[] => (h === '' ? [] : h.split(':'))
  const head = part(halves[0] ?? '')
  const tail = halves.length === 2 ? part(halves[1] ?? '') : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail]
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => parseInt(g, 16))
}

function privateV4(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
}

/** Private, loopback, link-local, CGNAT, multicast and unspecified addresses, IPv4 also when written inside IPv6
 * (mapped `::ffff:a.b.c.d` or `::ffff:7f00:1`, compatible `::a.b.c.d`, and NAT64 `64:ff9b::/96`). */
export function isPrivateAddress(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)
  if (m) return privateV4(Number(m[1]), Number(m[2]))
  const g = ipv6Groups(ip)
  if (!g) return true // not an address we can read: refuse it
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0] = g
  const embedded = (): boolean => privateV4(g6 >> 8, g6 & 0xff)
  const zeros = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  if (zeros && (g5 === 0xffff || g5 === 0)) return (g5 === 0 && g6 === 0) ? true : embedded() // ::, ::1, mapped, compatible
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded() // NAT64
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xff00) === 0xff00
}

/** A lookup that answers only public addresses: the connection goes to an address that was checked, so a name that
 * resolves to a public address once and a private one the next time (DNS rebinding) can't reach the private one. */
export const publicLookup: LookupFunction = (host, opts, cb) => {
  lookupCb(host, { ...opts, all: true }, (err, addrs) => {
    const done = cb as unknown as (e: NodeJS.ErrnoException | null, a: string | LookupAddress[], f?: number) => void
    if (err) return done(err, [])
    const list = addrs as unknown as LookupAddress[]
    const bad = list.find((a) => isPrivateAddress(a.address))
    if (!list.length || bad) {
      const e: NodeJS.ErrnoException = new Error(`refusing ${host}: not a public address`)
      e.code = 'EPRIVATE'
      return done(e, [])
    }
    if ((opts as { all?: boolean }).all) return done(null, list)
    const first = list[0] as LookupAddress
    return done(null, first.address, first.family)
  })
}

/** The default fetch for downloads: node:http(s) with publicLookup, no redirects followed (the caller checks each). */
export const guardedFetch: FetchLike = (url, init) => new Promise((resolve, reject) => {
  const u = new URL(url)
  const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
    method: 'GET', lookup: publicLookup, headers: Object.fromEntries(new Headers(init.headers).entries()), ...(init.signal ? { signal: init.signal } : {}),
  }, (res) => {
    const headers = new Headers()
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
    const status = res.statusCode ?? 0
    const body = status === 204 || status === 304 || (status >= 300 && status < 400) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>)
    if (!body) res.resume()
    resolve(new Response(body, { status, headers }))
  })
  req.on('error', (e) => reject(e.message.includes('not a public address') ? new DownloadError(e.message) : e))
  req.end()
})

export interface Downloaded {
  bytes: Uint8Array
  finalUrl: string
  contentType: string
  filename: string
}

export interface DownloadOptions {
  fetch?: FetchLike
  resolveHost?: ResolveHost
  timeoutMs?: number
}

/**
 * The document an HTML page embeds, when it is a page that only wraps one: an iframe, embed or object whose source
 * is a .pdf (or a pdf.js viewer's ?file=), else null. Only the first such element counts, never a link in the text:
 * a product page that merely links to several documents is not taken as one of them.
 */
export function embeddedPdf(html: string, base: URL): URL | null {
  const tag = /<(?:iframe|embed|object)\b[^>]*?\b(?:src|data)\s*=\s*["']([^"']+)["']/gi
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    let u: URL
    try {
      u = new URL(m[1]!.replace(/&amp;/g, '&'), base)
    } catch {
      continue
    }
    const file = u.searchParams.get('file')
    if (file && /viewer\.html$/i.test(u.pathname)) {
      try {
        u = new URL(file, u)
      } catch {
        continue
      }
    }
    if (/\.pdf$/i.test(u.pathname)) return u
  }
  return null
}

export async function downloadPdf(start: string, opts: DownloadOptions = {}): Promise<Downloaded> {
  const f: FetchLike = opts.fetch ?? guardedFetch
  const resolveHost = opts.resolveHost ?? dnsResolve
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 90_000)
  let url: URL
  try {
    url = new URL(start)
  } catch {
    throw new DownloadError(`not a URL: ${start}`)
  }
  let embedFollowed = false
  for (let hop = 0; hop < 7; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new DownloadError(`refusing a ${url.protocol} URL`)
    if (url.username || url.password) throw new DownloadError('refusing a URL with credentials')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const addrs = isIP(host) ? [host] : await resolveHost(host).catch(() => [])
    if (!addrs.length) throw new DownloadError(`${host}: does not resolve`)
    if (addrs.some(isPrivateAddress)) throw new DownloadError(`refusing ${host}: not a public address`)
    const r = await f(url.toString(), {
      headers: { 'user-agent': BROWSER_UA, accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.5', 'accept-language': 'en' },
      redirect: 'manual',
      signal,
    })
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location')
      if (!loc) throw new DownloadError(`HTTP ${r.status} without a location`)
      url = new URL(loc, url)
      continue
    }
    if (!r.ok) throw new DownloadError(`HTTP ${r.status} from ${url.host}`)
    const declared = Number(r.headers.get('content-length') ?? 0)
    if (declared > MAX_BYTES) throw new DownloadError(`too large (${declared} bytes)`)
    const chunks: Uint8Array[] = []
    let size = 0
    if (r.body) {
      const reader = r.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > MAX_BYTES) {
          await reader.cancel()
          throw new DownloadError(`too large (over ${MAX_BYTES} bytes)`)
        }
        chunks.push(value)
      }
    }
    const bytes = new Uint8Array(size)
    let at = 0
    for (const c of chunks) {
      bytes.set(c, at)
      at += c.length
    }
    const contentType = r.headers.get('content-type') ?? 'unknown type'
    if (!isPdf(bytes) && !embedFollowed) {
      const inner = embeddedPdf(new TextDecoder().decode(bytes.subarray(0, 2_000_000)), url)
      if (inner && inner.toString() !== url.toString()) {
        embedFollowed = true
        url = inner
        continue
      }
    }
    if (!isPdf(bytes)) {
      throw new DownloadError(`${url.toString()} is not a PDF (${contentType}): probably a product page; download the document and add it as a file`)
    }
    const last = decodeURIComponent(url.pathname.split('/').pop() || '') || 'datasheet.pdf'
    return { bytes, finalUrl: url.toString(), contentType, filename: last.toLowerCase().endsWith('.pdf') ? last : `${last}.pdf` }
  }
  throw new DownloadError('too many redirects')
}

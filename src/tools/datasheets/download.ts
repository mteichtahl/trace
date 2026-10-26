/**
 * Downloading a vendor's datasheet.
 *
 * Vendors' sites refuse obvious robots, so the request looks like a browser. Redirects are followed by hand (at most
 * six hops) so each hop can be checked: only http(s), no credentials in the URL, and never a private, loopback or
 * link-local address (a cloud instance's metadata service, anything inside a VPC). The body is capped, and what comes
 * back must start with the PDF magic bytes — a vendor's product page is not a datasheet, and is refused with a note
 * to upload the document instead.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

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

/** Private, loopback, link-local, CGNAT, multicast and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v4)
  if (m) {
    const a = Number(m[1])
    const b = Number(m[2])
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  const x = ip.toLowerCase()
  return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff')
}

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

export async function downloadPdf(start: string, opts: DownloadOptions = {}): Promise<Downloaded> {
  const f: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i))
  const resolveHost = opts.resolveHost ?? dnsResolve
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 90_000)
  let url: URL
  try {
    url = new URL(start)
  } catch {
    throw new DownloadError(`not a URL: ${start}`)
  }
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
    if (!isPdf(bytes)) {
      throw new DownloadError(`${url.toString()} is not a PDF (${contentType}): probably a product page; download the document and add it as a file`)
    }
    const last = decodeURIComponent(url.pathname.split('/').pop() || '') || 'datasheet.pdf'
    return { bytes, finalUrl: url.toString(), contentType, filename: last.toLowerCase().endsWith('.pdf') ? last : `${last}.pdf` }
  }
  throw new DownloadError('too many redirects')
}

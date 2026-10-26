/**
 * One shape for a part as every provider describes it, so lookups merge and BOM checks do arithmetic on one thing.
 *
 * A provider fills what it knows and leaves the rest null: a missing stock figure is null, never 0, and a missing
 * price is no price break, never a guessed one.
 */

export type ProviderName = 'lcsc' | 'mouser' | 'digikey' | 'nexar'

export interface PriceBreak {
  qty: number
  price: number
  currency: string
}

export interface PartOffer {
  mpn: string
  manufacturer: string | null
  description: string | null
  provider: ProviderName
  /** The seller, when the provider aggregates several (Nexar); otherwise the provider itself. */
  seller: string
  provider_part: string | null
  stock: number | null
  moq: number | null
  price_breaks: PriceBreak[]
  lifecycle: string | null
  datasheet_url: string | null
  package: string | null
  attributes: Record<string, string>
  url: string | null
}

export interface ProviderNote {
  provider: ProviderName
  ok: boolean
  /** Why it was skipped (no credentials) or what failed. */
  note?: string
  cached?: boolean
}

/** How a provider talks HTTP: the global fetch, or a test's canned answers. */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>

export interface ProviderContext {
  fetch: HttpFetch
  env: Readonly<Record<string, string | undefined>>
  currency: string
}

export interface Provider {
  readonly name: ProviderName
  /** null when it can run; otherwise why not (missing credentials). */
  unavailable(env: ProviderContext['env']): string | null
  /** Offers for this exact part number (and its packaging variants). */
  lookup(mpn: string, ctx: ProviderContext): Promise<PartOffer[]>
  /** Offers for a keyword search. */
  search(query: string, ctx: ProviderContext, limit: number): Promise<PartOffer[]>
}

export class ProviderError extends Error {
  override name = 'ProviderError'
}

/** "1,234" / "1234 In Stock" / 1234 → 1234; anything else null. */
export function intOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null
  if (typeof v !== 'string') return null
  const m = /-?\d[\d,]*/.exec(v.replace(/\s/g, ''))
  if (!m) return null
  const n = Number(m[0].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

/** "$0.123" / "0,123 €" / 0.123 → 0.123; anything else null. */
export function priceOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null
  if (typeof v !== 'string') return null
  let s = v.replace(/[^\d.,]/g, '')
  if (/,\d{1,5}$/.test(s) && !s.includes('.')) s = s.replace(',', '.')
  s = s.replace(/,/g, '')
  const n = Number(s)
  return s && Number.isFinite(n) && n > 0 ? n : null
}

export async function jsonOf(r: Response, what: string): Promise<unknown> {
  const text = await r.text()
  if (!r.ok) throw new ProviderError(`${what}: HTTP ${r.status} ${text.slice(0, 200)}`)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ProviderError(`${what}: an answer that is not JSON`)
  }
}

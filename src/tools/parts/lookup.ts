/**
 * Part lookups across providers, merged; BOM checks; alternatives.
 *
 *   lookup(mpn)       every configured provider (config parts.providers, in that order), answered from the parts
 *                     database when fresher than 6 h. A provider without credentials is skipped with a note; one that
 *                     fails is reported, and the others still answer.
 *   search(q)         a keyword search, filtered by package / manufacturer / in stock.
 *   bomCheck(rows)    per line: the quantity a build needs (qty × boards, at least the MOQ), the best offer that covers
 *                     it, unit price at that quantity, flags (out of stock, short, not found, end of life), and the total.
 *                     Prices in another currency than the configured one are not added to the total; the line says so.
 *   alternatives(mpn) parts in the same package with the same key attributes, from a provider search. Always marked
 *                     as candidates that need an engineer's review: trace never calls a part a drop-in replacement.
 */
import { readFileSync } from 'node:fs'
import { ToolError } from '../../core/registry.js'
import { mpnKey, mpnLoose } from '../datasheets/mpn.js'
import { PartsDb } from './db.js'
import { digikey } from './providers/digikey.js'
import { lcsc, LCSC_CODE } from './providers/lcsc.js'
import { mouser } from './providers/mouser.js'
import { nexar } from './providers/nexar.js'
import type { HttpFetch, PartOffer, PriceBreak, Provider, ProviderName, ProviderNote } from './types.js'

export const PROVIDERS: Readonly<Record<ProviderName, Provider>> = { lcsc, mouser, digikey, nexar }

export interface LookupOptions {
  providers: readonly ProviderName[]
  currency: string
  fetch?: HttpFetch
  env?: Readonly<Record<string, string | undefined>>
  db?: PartsDb
  /** Ignore the parts database and ask the providers. */
  fresh?: boolean
}

export interface LookupResult {
  mpn: string
  offers: PartOffer[]
  providers: ProviderNote[]
  /** The part's facts, from the offers whose MPN matches exactly. */
  part: {
    manufacturer: string | null
    description: string | null
    package: string | null
    lifecycle: string | null
    datasheet_url: string | null
  }
}

function ctxOf(o: LookupOptions) {
  return { fetch: o.fetch ?? ((u: string, i: RequestInit) => fetch(u, i)), env: o.env ?? process.env, currency: o.currency }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function lookup(mpn: string, o: LookupOptions): Promise<LookupResult> {
  if (!mpn.trim()) throw new ToolError('an empty part number')
  const db = o.db ?? new PartsDb()
  const ctx = ctxOf(o)
  const notes: ProviderNote[] = []
  const offers: PartOffer[] = []
  for (const name of o.providers) {
    const p = PROVIDERS[name]
    const why = p.unavailable(ctx.env)
    if (why) {
      notes.push({ provider: name, ok: false, note: `skipped: ${why}` })
      continue
    }
    const hit = o.fresh ? undefined : await db.cached(mpn, name)
    if (hit) {
      offers.push(...hit)
      notes.push({ provider: name, ok: true, cached: true })
      continue
    }
    try {
      const got = await p.lookup(mpn, ctx)
      await db.record(mpn, name, got)
      offers.push(...got)
      notes.push({ provider: name, ok: true, ...(got.length ? {} : { note: 'no listing' }) })
    } catch (e) {
      await db.recordFailure(mpn, name, msg(e)).catch(() => undefined)
      notes.push({ provider: name, ok: false, note: msg(e) })
    }
  }
  const want = mpnLoose(mpn)
  const exact = offers.filter((x) => mpnLoose(x.mpn) === want || (LCSC_CODE.test(mpn) && x.provider_part === mpn.toUpperCase()))
  const from = exact.length ? exact : offers
  const first = <K extends keyof LookupResult['part']>(k: K): string | null => from.find((x) => x[k])?.[k] ?? null
  return {
    mpn: mpnKey(mpn),
    offers: rank(offers, want),
    providers: notes,
    part: { manufacturer: first('manufacturer'), description: first('description'), package: first('package'), lifecycle: first('lifecycle'), datasheet_url: first('datasheet_url') },
  }
}

/** Exact part number first, then in stock, then the most stock. */
function rank(offers: PartOffer[], want: string): PartOffer[] {
  return [...offers].sort((a, b) =>
    Number(mpnLoose(b.mpn) === want) - Number(mpnLoose(a.mpn) === want) || Number((b.stock ?? 0) > 0) - Number((a.stock ?? 0) > 0) || (b.stock ?? 0) - (a.stock ?? 0))
}

// ------------------------------------------------------------------ search

export interface SearchFilters {
  package?: string
  manufacturer?: string
  in_stock?: boolean
}

export async function search(query: string, filters: SearchFilters, limit: number, o: LookupOptions): Promise<{ total: number; offers: PartOffer[]; providers: ProviderNote[] }> {
  const ctx = ctxOf(o)
  const notes: ProviderNote[] = []
  let offers: PartOffer[] = []
  for (const name of o.providers) {
    const p = PROVIDERS[name]
    const why = p.unavailable(ctx.env)
    if (why) {
      notes.push({ provider: name, ok: false, note: `skipped: ${why}` })
      continue
    }
    try {
      offers.push(...(await p.search(query, ctx, limit)))
      notes.push({ provider: name, ok: true })
    } catch (e) {
      notes.push({ provider: name, ok: false, note: msg(e) })
    }
  }
  const has = (v: string | null, f: string) => (v ?? '').toLowerCase().includes(f.toLowerCase())
  if (filters.package) offers = offers.filter((x) => has(x.package, filters.package as string) || Object.values(x.attributes).some((v) => has(v, filters.package as string)))
  if (filters.manufacturer) offers = offers.filter((x) => has(x.manufacturer, filters.manufacturer as string))
  if (filters.in_stock) offers = offers.filter((x) => (x.stock ?? 0) > 0)
  return { total: offers.length, offers: offers.slice(0, limit), providers: notes }
}

// ------------------------------------------------------------------ prices

/** The unit price when buying n: the highest break n reaches. Null when n reaches none. */
export function unitPriceAt(n: number, breaks: readonly PriceBreak[]): PriceBreak | null {
  let best: PriceBreak | null = null
  for (const b of breaks) if (n >= b.qty && (!best || b.qty > best.qty)) best = b
  return best
}

/** How many to buy for a need: at least the MOQ and the first price break. */
export function buyQuantity(need: number, moq: number | null, breaks: readonly PriceBreak[]): number {
  const first = breaks.length ? Math.min(...breaks.map((b) => b.qty)) : 1
  return Math.max(Math.ceil(need), moq ?? 1, first, 1)
}

const round = (x: number, d = 4): number => Math.round(x * 10 ** d) / 10 ** d

// ------------------------------------------------------------------ BOM check

export interface BomRow {
  mpn?: string
  qty: number
  lcsc?: string
  refs?: string
}

/** Read a BOM CSV with MPN / Qty / LCSC columns (also "Manufacturer Part Number", "Quantity", "LCSC Part #", "Designator"). */
export function parseBomCsv(text: string): BomRow[] {
  const rows = parseCsv(text)
  const [head, ...body] = rows
  if (!head) throw new ToolError('the BOM is empty')
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h.trim().toLowerCase()))
  const c = {
    mpn: col('mpn', 'manufacturer part number', 'mfr part number', 'mfr. part #', 'part number'),
    qty: col('qty', 'quantity', 'qty per board'),
    lcsc: col('lcsc', 'lcsc part #', 'lcsc part', 'lcsc part number', 'jlcpcb part #'),
    refs: col('designator', 'designators', 'reference', 'references', 'refs'),
  }
  if (c.mpn < 0 && c.lcsc < 0) throw new ToolError('the BOM needs an MPN or an LCSC column')
  return body.map((r, i) => {
    const at = (k: number) => (k >= 0 ? (r[k] ?? '').trim() : '')
    const refs = at(c.refs)
    const qtyText = at(c.qty)
    const qty = qtyText ? Number(qtyText.replace(/,/g, '')) : refs ? refs.split(/[,\s]+/).filter(Boolean).length : NaN
    if (!Number.isFinite(qty) || qty < 0) throw new ToolError(`BOM line ${i + 2}: quantity ${JSON.stringify(qtyText)} is not a number`)
    return { ...(at(c.mpn) ? { mpn: at(c.mpn) } : {}), qty, ...(at(c.lcsc) ? { lcsc: at(c.lcsc).toUpperCase() } : {}), ...(refs ? { refs } : {}) }
  })
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else q = false
      } else field += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(field); field = '' } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

export type LineStatus = 'ok' | 'low' | 'short' | 'out' | 'not-found' | 'error'
export const LOW_STOCK_FACTOR = 3
const EOL = /obsolete|end of life|eol|discontinued|last time buy|nrnd|not recommended/i

export interface BomLine {
  line: number
  mpn: string | null
  lcsc: string | null
  refs: string | null
  qty_per_board: number
  need: number
  status: LineStatus
  flags: string[]
  offer: { provider: ProviderName; seller: string; provider_part: string | null; stock: number | null; url: string | null } | null
  buy: number | null
  unit_price: number | null
  line_total: number | null
  currency: string | null
  lifecycle: string | null
  note: string
}

export interface BomResult {
  boards: number
  currency: string
  lines: BomLine[]
  counts: Record<LineStatus, number>
  /** Lines that stop a build: out, short or not found. */
  blocking: number
  total: number
  /** Lines with a price in another currency, left out of the total. */
  unpriced: number
  providers: ProviderNote[]
}

/** The best offer for a need: covers it, then cheapest at that quantity in the configured currency, then most stock. */
function bestOffer(offers: PartOffer[], need: number, currency: string): { offer: PartOffer; buy: number; unit: PriceBreak | null } | null {
  const scored = offers.map((offer) => {
    const buy = buyQuantity(need, offer.moq, offer.price_breaks)
    return { offer, buy, unit: unitPriceAt(buy, offer.price_breaks) }
  })
  const cost = (s: (typeof scored)[number]) => (s.unit && s.unit.currency === currency ? s.unit.price * s.buy : Number.POSITIVE_INFINITY)
  scored.sort((a, b) => Number((b.offer.stock ?? 0) >= b.buy) - Number((a.offer.stock ?? 0) >= a.buy) || cost(a) - cost(b) || (b.offer.stock ?? 0) - (a.offer.stock ?? 0))
  return scored[0] ?? null
}

export async function bomCheck(rows: BomRow[], boards: number, o: LookupOptions): Promise<BomResult> {
  if (!Number.isInteger(boards) || boards < 1) throw new ToolError('boards must be a whole number ≥ 1')
  const lines: BomLine[] = []
  const notes = new Map<ProviderName, ProviderNote>()
  for (const [i, r] of rows.entries()) {
    const id = r.mpn ?? r.lcsc ?? ''
    const need = r.qty * boards
    const base = { line: i + 1, mpn: r.mpn ?? null, lcsc: r.lcsc ?? null, refs: r.refs ?? null, qty_per_board: r.qty, need }
    if (!id) {
      lines.push({ ...base, status: 'not-found', flags: ['no-part-number'], offer: null, buy: null, unit_price: null, line_total: null, currency: null, lifecycle: null, note: 'no MPN or LCSC code on this line' })
      continue
    }
    if (need === 0) {
      lines.push({ ...base, status: 'ok', flags: ['not-fitted'], offer: null, buy: 0, unit_price: null, line_total: 0, currency: o.currency, lifecycle: null, note: 'quantity 0: not fitted' })
      continue
    }
    const res = await lookup(id, o)
    for (const n of res.providers) if (!notes.has(n.provider) || !n.ok) notes.set(n.provider, n)
    // An LCSC code on the line pins the listing: use it when present.
    const pinned = r.lcsc ? res.offers.filter((x) => x.provider === 'lcsc' && x.provider_part === r.lcsc) : []
    const want = r.mpn ? mpnLoose(r.mpn) : ''
    const exact = pinned.length ? pinned : res.offers.filter((x) => !want || mpnLoose(x.mpn) === want || x.provider_part === r.lcsc)
    const candidates = exact.length ? exact : []
    const flags: string[] = []
    const lifecycle = res.part.lifecycle
    if (lifecycle && EOL.test(lifecycle)) flags.push('end-of-life')
    if (!candidates.length) {
      const errored = res.providers.length > 0 && res.providers.every((n) => !n.ok)
      const variants = res.offers.length ? `; ${res.offers.length} listing(s) for packaging or grade variants (${[...new Set(res.offers.map((x) => x.mpn))].slice(0, 3).join(', ')}) need a person to confirm` : ''
      lines.push({ ...base, status: errored ? 'error' : 'not-found', flags: [...flags, errored ? 'no-provider-answered' : 'not-found'], offer: null, buy: null, unit_price: null, line_total: null, currency: null, lifecycle, note: errored ? `no provider answered (${res.providers.map((n) => `${n.provider}: ${n.note ?? 'error'}`).join('; ')})` : `${id} not found${variants}` })
      continue
    }
    const best = bestOffer(candidates, need, o.currency) as NonNullable<ReturnType<typeof bestOffer>>
    const stock = best.offer.stock
    let status: LineStatus
    let note: string
    if (stock === null) { status = 'ok'; note = `${best.offer.seller} does not publish stock`; flags.push('stock-unknown') } else if (stock <= 0) { status = 'out'; note = `out of stock at every provider asked; ${best.buy} needed`; flags.push('out-of-stock') } else if (stock < best.buy) { status = 'short'; note = `${stock} in stock, ${best.buy} needed: ${best.buy - stock} short`; flags.push('short') } else if (stock < best.buy * LOW_STOCK_FACTOR) { status = 'low'; note = `${stock} in stock covers ${best.buy}, with under ${LOW_STOCK_FACTOR}× to spare`; flags.push('low-stock') } else { status = 'ok'; note = `${stock} in stock, ${best.buy} needed` }
    const unit = best.unit
    const sameCurrency = unit !== null && unit.currency === o.currency
    if (unit && !sameCurrency) { flags.push('other-currency'); note += `; priced in ${unit.currency}, not added to the ${o.currency} total` }
    if (!unit) { flags.push('no-price'); note += '; no price published at this quantity' }
    if (best.buy > need) note += ` (buying ${best.buy}: the MOQ or first price break)`
    lines.push({
      ...base, status, flags,
      offer: { provider: best.offer.provider, seller: best.offer.seller, provider_part: best.offer.provider_part, stock, url: best.offer.url },
      buy: best.buy, unit_price: unit ? unit.price : null,
      line_total: unit && sameCurrency ? round(unit.price * best.buy) : null,
      currency: unit ? unit.currency : null, lifecycle, note,
    })
  }
  const counts: Record<LineStatus, number> = { ok: 0, low: 0, short: 0, out: 0, 'not-found': 0, error: 0 }
  for (const l of lines) counts[l.status]++
  return {
    boards, currency: o.currency, lines, counts,
    blocking: counts.out + counts.short + counts['not-found'],
    total: round(lines.reduce((s, l) => s + (l.line_total ?? 0), 0), 2),
    unpriced: lines.filter((l) => l.need > 0 && l.line_total === null).length,
    providers: [...notes.values()],
  }
}

export function readBom(path: string): BomRow[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new ToolError(`${path}: ${msg(e)}`)
  }
  return parseBomCsv(text.replace(/^﻿/, ''))
}

// ------------------------------------------------------------------ alternatives

/** Attributes that decide whether two parts are even comparable; compared as printed (normalised spacing/case). */
const KEY_ATTRIBUTES = [
  'Capacitance', 'Resistance', 'Inductance', 'Tolerance', 'Voltage - Rated', 'Voltage Rating', 'Rated Voltage', 'Voltage Rating - DC',
  'Temperature Coefficient', 'Dielectric', 'Power (Watts)', 'Power', 'Current Rating (Amps)', 'Current - Output', 'Voltage - Output',
  'Voltage - Input (Max)', 'Frequency - Switching', 'Output Type', 'Topology', 'Number of Channels', 'Channels', 'Mounting Type', 'Mounting Style',
] as const

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, '').replace(/μ|µ/g, 'u')

export interface AlternativeCandidate {
  mpn: string
  manufacturer: string | null
  package: string | null
  matched: string[]
  differs: { attribute: string; original: string; candidate: string | null }[]
  offers: number
  stock: number | null
  best_unit_price: PriceBreak | null
  datasheet_url: string | null
  review: 'candidate: an engineer must compare the datasheets before it replaces the original'
}

export async function alternatives(mpn: string, o: LookupOptions & { limit?: number; in_stock?: boolean }): Promise<{
  original: { mpn: string; package: string | null; key_attributes: Record<string, string> }
  query: string
  candidates: AlternativeCandidate[]
  total: number
  providers: ProviderNote[]
  note: string
}> {
  const orig = await lookup(mpn, o)
  if (!orig.offers.length) throw new ToolError(`${mpn}: no provider knows this part, so there is nothing to compare against`)
  const want = mpnLoose(mpn)
  const own = orig.offers.filter((x) => mpnLoose(x.mpn) === want)
  const ref = own.length ? own : orig.offers
  const attrs: Record<string, string> = {}
  for (const x of ref) for (const [k, v] of Object.entries(x.attributes)) if (!(k in attrs)) attrs[k] = v
  const pkg = orig.part.package
  const keys = KEY_ATTRIBUTES.filter((k) => attrs[k])
  if (!pkg && !keys.length) throw new ToolError(`${mpn}: the providers give no package or key attributes to search by; look for alternatives by hand`)
  const query = [orig.part.description?.split(/[,;]/)[0] ?? '', ...keys.slice(0, 3).map((k) => attrs[k] as string), pkg ?? ''].filter(Boolean).join(' ').trim()
  const found = await search(query, { ...(o.in_stock ? { in_stock: true } : {}) }, 50, o)
  const byMpn = new Map<string, PartOffer[]>()
  for (const x of found.offers) {
    const k = mpnLoose(x.mpn)
    if (k === want || k.startsWith(want)) continue // the part itself and its packaging variants
    byMpn.set(k, [...(byMpn.get(k) ?? []), x])
  }
  const candidates: AlternativeCandidate[] = []
  for (const offers of byMpn.values()) {
    const first = offers[0] as PartOffer
    const cAttrs: Record<string, string> = {}
    for (const x of offers) for (const [k, v] of Object.entries(x.attributes)) if (!(k in cAttrs)) cAttrs[k] = v
    const cPkg = offers.find((x) => x.package)?.package ?? null
    if (pkg && (!cPkg || norm(cPkg) !== norm(pkg))) continue
    const matched: string[] = pkg ? ['package'] : []
    const differs: AlternativeCandidate['differs'] = []
    for (const k of keys) {
      const v = cAttrs[k]
      if (v !== undefined && norm(v) === norm(attrs[k] as string)) matched.push(k)
      else differs.push({ attribute: k, original: attrs[k] as string, candidate: v ?? null })
    }
    if (differs.some((d) => d.candidate !== null)) continue // a key attribute that is printed and different: not comparable
    const stock = offers.reduce<number | null>((s, x) => (x.stock === null ? s : (s ?? 0) + x.stock), null)
    const prices = offers.flatMap((x) => x.price_breaks).filter((b) => b.currency === o.currency)
    candidates.push({
      mpn: first.mpn, manufacturer: first.manufacturer, package: cPkg, matched, differs, offers: offers.length, stock,
      best_unit_price: prices.length ? prices.reduce((a, b) => (b.price < a.price ? b : a)) : null,
      datasheet_url: offers.find((x) => x.datasheet_url)?.datasheet_url ?? null,
      review: 'candidate: an engineer must compare the datasheets before it replaces the original',
    })
  }
  candidates.sort((a, b) => b.matched.length - a.matched.length || a.differs.length - b.differs.length || (b.stock ?? 0) - (a.stock ?? 0))
  const limit = o.limit ?? 10
  return {
    original: { mpn: mpnKey(mpn), package: pkg, key_attributes: Object.fromEntries(keys.map((k) => [k, attrs[k] as string])) },
    query, candidates: candidates.slice(0, limit), total: candidates.length,
    providers: [...orig.providers, ...found.providers.map((n) => ({ ...n, note: `search: ${n.note ?? 'ok'}` }))],
    note: 'Candidates share the package and the key attributes the providers print; nothing else is checked. None is a drop-in replacement until an engineer has compared the datasheets (pinout, ratings, behaviour, layout).',
  }
}

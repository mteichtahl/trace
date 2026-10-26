/**
 * The parts tools: lookups across providers (lcsc, mouser, digikey, nexar — config parts.providers chooses which and
 * in what order), BOM checks, alternatives, and fetching a part's datasheet into the shared library. Answers are kept
 * in the central parts database for 6 h, so every project shares them and providers' rate limits are spent once.
 */
import { z } from 'zod'
import { load } from '../core/config.js'
import { defineTool, ToolError, type AnyTool } from '../core/registry.js'
import type { ResolveHost } from '../datasheets/download.js'
import { DatasheetLibrary, library } from '../datasheets/library.js'
import { PartsDb } from './db.js'
import { alternatives as findAlternatives, bomCheck, lookup, readBom, search as providerSearch, type LookupOptions } from './lookup.js'
import type { PartOffer, ProviderName } from './types.js'

const ProviderEnum = z.enum(['lcsc', 'mouser', 'digikey', 'nexar'])
const providersArg = z.array(ProviderEnum).min(1).optional().describe('providers to ask, in order; default config parts.providers')

/** Test seam: canned HTTP for the providers and the datasheet download (and its host check). */
export const http: { fetch: LookupOptions['fetch']; resolveHost: ResolveHost | undefined } = { fetch: undefined, resolveHost: undefined }

function options(providers: ProviderName[] | undefined, fresh = false): LookupOptions {
  let cfg: { providers: ProviderName[]; currency: string }
  try {
    cfg = load(undefined, { strict: false }).parts
  } catch {
    cfg = { providers: ['lcsc'], currency: 'USD' }
  }
  return { providers: providers ?? cfg.providers, currency: cfg.currency, fresh, ...(http.fetch ? { fetch: http.fetch } : {}) }
}

const compact = (o: PartOffer) => ({
  mpn: o.mpn, manufacturer: o.manufacturer, provider: o.provider, seller: o.seller, provider_part: o.provider_part, stock: o.stock, moq: o.moq,
  price_breaks: o.price_breaks.slice(0, 6), lifecycle: o.lifecycle, package: o.package, url: o.url,
})

export const partsLookup = defineTool({
  name: 'parts.lookup',
  description: 'Look a part number (or an LCSC code) up at every configured provider, merged: stock, MOQ, price breaks, lifecycle, package, datasheet URL. Providers without credentials are skipped with a note. Answers are reused for 6 h unless fresh.',
  input: z.object({
    mpn: z.string().min(1), providers: providersArg, fresh: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(20), attributes: z.boolean().default(false).describe('include each offer\'s attributes'),
  }),
  run: async (a) => {
    const r = await lookup(a.mpn, options(a.providers, a.fresh))
    return {
      mpn: r.mpn, part: r.part, providers: r.providers, total: r.offers.length,
      offers: r.offers.slice(0, a.limit).map((o) => (a.attributes ? { ...compact(o), description: o.description, attributes: o.attributes } : compact(o))),
    }
  },
})

export const partsSearch = defineTool({
  name: 'parts.search',
  description: 'Keyword search across the configured providers (e.g. "100nF 0402 X7R 16V"), filtered by package, manufacturer or in stock.',
  input: z.object({
    query: z.string().min(2), package: z.string().optional(), manufacturer: z.string().optional(), in_stock: z.boolean().default(false),
    providers: providersArg, limit: z.number().int().min(1).max(50).default(20),
  }),
  run: async (a) => {
    const r = await providerSearch(a.query, {
      ...(a.package ? { package: a.package } : {}), ...(a.manufacturer ? { manufacturer: a.manufacturer } : {}), in_stock: a.in_stock,
    }, a.limit, options(a.providers))
    return { total: r.total, providers: r.providers, offers: r.offers.map((o) => ({ ...compact(o), description: o.description })) }
  },
})

const BomRowArg = z.object({ mpn: z.string().optional(), qty: z.number().min(0), lcsc: z.string().optional(), refs: z.string().optional() })

export const partsBomCheck = defineTool({
  name: 'parts.bom_check',
  description: 'Check a BOM (a CSV path with MPN/Qty/LCSC columns, or rows) for a build of N boards: per line the best offer, stock, unit price at the quantity bought (qty × boards, at least the MOQ), flags (out of stock, short, low, not found, end of life) and the total.',
  input: z.object({
    path: z.string().optional(), rows: z.array(BomRowArg).max(2000).optional(), boards: z.number().int().min(1).default(1),
    providers: providersArg, fresh: z.boolean().default(false), limit: z.number().int().min(1).max(2000).default(200),
    only_problems: z.boolean().default(false).describe('list only lines that are not ok'),
  }),
  run: async (a) => {
    if ((a.path === undefined) === (a.rows === undefined)) throw new ToolError('give a BOM path or rows (one of them)')
    const rows = a.path !== undefined ? readBom(a.path) : (a.rows ?? []).map((r) => ({ ...r, ...(r.lcsc ? { lcsc: r.lcsc.toUpperCase() } : {}) }))
    const r = await bomCheck(rows, a.boards, options(a.providers, a.fresh))
    const shown = (a.only_problems ? r.lines.filter((l) => l.status !== 'ok' || l.flags.includes('end-of-life')) : r.lines).slice(0, a.limit)
    return { ...r, lines: shown, line_count: r.lines.length }
  },
})

export const partsAlternatives = defineTool({
  name: 'parts.alternatives',
  description: 'Candidate alternatives for a part: same package and the same key attributes the providers print (value, rating, tolerance …). Candidates only — an engineer must compare datasheets before any replaces the original; none is a drop-in.',
  input: z.object({ mpn: z.string().min(1), providers: providersArg, in_stock: z.boolean().default(true), limit: z.number().int().min(1).max(30).default(10) }),
  run: async (a) => findAlternatives(a.mpn, { ...options(a.providers), in_stock: a.in_stock, limit: a.limit }),
})

export const partsFetchDatasheet = defineTool({
  name: 'parts.fetch_datasheet',
  description: "Fetch a part's datasheet from the URL the providers give and add it to the shared datasheet library (all projects); links it in the parts database. Give url to override.",
  input: z.object({ mpn: z.string().min(1), url: z.string().url().optional(), providers: providersArg, by: z.string().optional(), library: z.string().optional() }),
  run: async (a) => {
    const opts = options(a.providers)
    let url = a.url ?? null
    let manufacturer: string | null = null
    let title: string | null = null
    if (!url) {
      const r = await lookup(a.mpn, opts)
      url = r.part.datasheet_url
      manufacturer = r.part.manufacturer
      title = r.part.description
      if (!url) throw new ToolError(`${a.mpn}: no provider gives a datasheet URL (${r.providers.map((p) => `${p.provider}: ${p.ok ? 'none' : p.note ?? 'failed'}`).join('; ')}); add it with datasheets.add and a file`)
    }
    if (url.startsWith('//')) url = `https:${url}`
    const base = library(a.library)
    const lib = http.fetch || http.resolveHost
      ? new DatasheetLibrary({ central: base.central, ...(http.fetch ? { fetch: http.fetch } : {}), ...(http.resolveHost ? { resolveHost: http.resolveHost } : {}) })
      : base
    const added = await lib.add({
      mpn: a.mpn, url, ...(manufacturer ? { manufacturer } : {}), ...(title ? { title } : {}), ...(a.by ? { by: a.by } : {}),
    })
    await new PartsDb(base.central).linkDatasheet(a.mpn, added.sha256)
    return { outcome: added.outcome, sha256: added.sha256, source_url: url, mpn: added.entry.key, ...(added.note ? { note: added.note } : {}) }
  },
})

export const tools: AnyTool[] = [partsLookup, partsSearch, partsBomCheck, partsAlternatives, partsFetchDatasheet] as AnyTool[]

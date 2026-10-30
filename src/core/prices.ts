/**
 * The one price table trace estimates cloud cost from: Claude on Amazon Bedrock per million tokens, and the AWS Batch
 * pools (graphics card and CPU jobs) per hour. Every amount computed from it is an ESTIMATE and is marked so wherever
 * it is shown; what AWS actually billed comes from Cost Explorer (src/core/cost.ts actuals), never from here.
 *
 * Why a table and not the Agent SDK's own figure: the SDK prices tokens at Anthropic's list prices, which do not know
 * the Bedrock region (regional endpoints cost more than global ones for newer models) or a negotiated rate. The SDK's
 * figure is kept beside each row (`sdk_cost`) and used only for a model the table does not know.
 *
 * Where the prices come from, highest first (each entry says which, and its date):
 *   override   the stack setting `cost.prices` (src/infra/props.ts, the installer's answers): a model entry, a pool, and
 *              an `asOf`. The stack hands it to the workers and the API as TRACE_PRICES
 *   fetched    the AWS price list, read once a day by the `<prefix>-cost-explorer` Lambda (src/infra/lambda/
 *              cost-explorer.ts, the mapping in src/core/price-list.ts) into installation/cost/prices.json, dated the
 *              day it was fetched. The workers and the API read it (src/core/prices-store.ts, cached an hour)
 *   built-in   DEFAULT_PRICES below, dated `asOf` (when they were taken from the public price pages): the last resort,
 *              for a model or pool the price list did not answer, or when it could not be read
 * A model's entry is chosen by its match (the longest wins) and, between entries with the same match, by that order.
 * Every ledger row records the date and the source of the entry that priced it. When the table in use is older than
 * STALE_DAYS, or the price list could not be read, cost.get says so on screen.
 *
 * Plain data and pure functions (the installer's page loads the overrides' schema too: no Node here).
 *
 * Model entries match on the model id with its routing prefix removed (us., eu., apac., global.): an entry's `match`
 * is a substring ("claude-sonnet-4-5"); the longest match wins, and an entry with `regions` wins over one without
 * when the run's region is listed. A call through a regional (not global) inference profile or an in-region id is
 * priced at `inRegion` when the entry has it (the price list gives both), else at the price times `regional`.
 */
import { z } from 'zod'

export const STALE_DAYS = 180

const Usd = z.number().min(0).max(10_000)
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** Where an entry's prices came from (see above), highest first. */
export const PRICE_SOURCES = ['override', 'fetched', 'built-in'] as const
export type PriceSource = (typeof PRICE_SOURCES)[number]
const Source = z.enum(PRICE_SOURCES)

export const TOKEN_FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead'] as const
export type TokenField = (typeof TOKEN_FIELDS)[number]
const TokenPrices = z.object({ input: Usd, output: Usd, cacheWrite: Usd, cacheRead: Usd }).strict()

export const ModelPriceSchema = z.object({
  /** a substring of the model id, after its routing prefix (us., eu., apac., global.) */
  match: z.string().min(3).max(80),
  /** per million tokens */
  input: Usd,
  output: Usd,
  /** writing the prompt cache (5-minute cache) */
  cacheWrite: Usd,
  cacheRead: Usd,
  /** only in these Bedrock regions (an override for one region) */
  regions: z.array(z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/)).optional(),
  /** multiplier for a regional (not global) endpoint; 1: the same */
  regional: z.number().min(1).max(3).default(1),
  /** the prices for a regional (not global) endpoint, when known (the price list gives them); else × `regional` */
  inRegion: TokenPrices.optional(),
  /** where these prices came from and their date (set when the table is put together: resolvePrices) */
  source: Source.optional(),
  asOf: Day.optional(),
  /** the fields the price list did not give, taken from the built-in entry of the same match */
  filled: z.array(z.enum(TOKEN_FIELDS)).max(4).optional(),
}).strict()
export type ModelPrice = z.output<typeof ModelPriceSchema>

const GpuPrice = z.object({ perHour: Usd, basis: z.string().max(200), source: Source.optional(), asOf: Day.optional() }).strict()
const CpuPrice = z.object({ perVcpuHour: Usd, basis: z.string().max(200), source: Source.optional(), asOf: Day.optional() }).strict()
/** A project's tools function (AWS Lambda, arm64): its memory by the GB-second, each call, and its /tmp above the
 * 512 MB Lambda includes, by the GB-second. */
const ToolsPrice = z.object({
  perGbSecond: Usd, perRequest: Usd, perStorageGbSecond: Usd, basis: z.string().max(200), source: Source.optional(), asOf: Day.optional(),
}).strict()
/** The built-in price of the tools function: Lambda on arm64 in us-east-1 (also a table without one: tables written
 * before the tools function, fetched or overridden, have none). */
export const DEFAULT_TOOLS_PRICE = { perGbSecond: 0.0000133334, perRequest: 0.0000002, perStorageGbSecond: 0.0000000309, basis: 'AWS Lambda on arm64 in us-east-1 (memory GB-seconds, requests, /tmp over 512 MB)' }

export const PriceTableSchema = z.object({
  /** when these prices were taken (YYYY-MM-DD): from the price pages (built-in), or fetched from the price list */
  asOf: Day,
  currency: z.literal('USD').default('USD'),
  models: z.array(ModelPriceSchema).max(60),
  /** an AWS Batch graphics card job holds one whole instance */
  gpu: GpuPrice,
  /** a CPU job is billed for the vCPUs it asked for */
  cpu: CpuPrice,
  /** a job on the project's tools function is billed for its memory and /tmp by the second, and the call */
  tools: ToolsPrice.optional(),
  sources: z.array(z.string().url()).max(10).default([]),
}).strict()
export type PriceTable = z.output<typeof PriceTableSchema>

/** What `cost.prices` may say: any part of the table (models replace by `match`, pools replace whole). */
export const PriceOverridesSchema = z.object({
  asOf: Day.optional(),
  models: z.array(ModelPriceSchema).max(60).optional(),
  gpu: GpuPrice.optional(),
  cpu: CpuPrice.optional(),
  tools: ToolsPrice.optional(),
}).strict()
export type PriceOverrides = z.output<typeof PriceOverridesSchema>

/**
 * The defaults: Anthropic's published per-token list prices, which Bedrock's on-demand prices for global inference
 * profiles follow, with the 10% Bedrock charges for regional endpoints of the models released from late 2025; the
 * GPU pool at g6.xlarge and the CPU pool at c7i, on demand in us-east-1. Dated: check them against the sources.
 */
export const DEFAULT_PRICES: PriceTable = PriceTableSchema.parse({
  asOf: '2025-11-24',
  currency: 'USD',
  models: [
    { match: 'claude-opus-4-5', input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, regional: 1.1 },
    { match: 'claude-opus-4-1', input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
    { match: 'claude-opus-4', input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
    { match: 'claude-sonnet-4-5', input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3, regional: 1.1 },
    { match: 'claude-sonnet-4', input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    { match: 'claude-3-7-sonnet', input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    { match: 'claude-haiku-4-5', input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1, regional: 1.1 },
    { match: 'claude-3-5-haiku', input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  ],
  gpu: { perHour: 0.8048, basis: 'g6.xlarge on demand in us-east-1 (one job holds the instance)' },
  cpu: { perVcpuHour: 0.0446, basis: 'c7i on demand in us-east-1, per vCPU' },
  tools: DEFAULT_TOOLS_PRICE,
  sources: ['https://aws.amazon.com/bedrock/pricing/', 'https://www.anthropic.com/pricing', 'https://aws.amazon.com/ec2/pricing/on-demand/', 'https://aws.amazon.com/lambda/pricing/'],
})

/** The same entry: the same match and the same regions. */
const sameEntry = (a: ModelPrice, b: ModelPrice): boolean => a.match === b.match && JSON.stringify(a.regions ?? []) === JSON.stringify(b.regions ?? [])

/** Every entry and pool of `t` marked with where it came from and its date (an entry's own source and date stay: a
 * fetched table's pool the price list did not answer is the built-in one, and says so). */
function stamp(t: PriceTable, source: PriceSource): PriceTable {
  return {
    ...t,
    models: t.models.map((m) => ({ ...m, source: m.source ?? source, asOf: m.asOf ?? t.asOf })),
    gpu: { ...t.gpu, source: t.gpu.source ?? source, asOf: t.gpu.asOf ?? t.asOf },
    cpu: { ...t.cpu, source: t.cpu.source ?? source, asOf: t.cpu.asOf ?? t.asOf },
    ...(t.tools ? { tools: { ...t.tools, source: t.tools.source ?? source, asOf: t.tools.asOf ?? t.asOf } } : {}),
  }
}

/** `top` laid over `base`: its models replace those with the same match (and regions), its pools replace whole. */
function layer(base: PriceTable, top: { asOf?: string | undefined; models?: ModelPrice[] | undefined; gpu?: PriceTable['gpu'] | undefined; cpu?: PriceTable['cpu'] | undefined; tools?: PriceTable['tools'] | undefined; sources?: string[] | undefined }): PriceTable {
  const over = top.models ?? []
  return PriceTableSchema.parse({
    ...base,
    ...(top.asOf ? { asOf: top.asOf } : {}),
    models: [...over, ...base.models.filter((m) => !over.some((x) => sameEntry(x, m)))].slice(0, 60),
    ...(top.gpu ? { gpu: top.gpu } : {}),
    ...(top.cpu ? { cpu: top.cpu } : {}),
    ...(top.tools ? { tools: top.tools } : {}),
    sources: [...new Set([...(top.sources ?? []), ...base.sources])].slice(0, 10),
  })
}

/** The defaults with an installation's overrides laid over them. */
export function mergePrices(base: PriceTable, o: PriceOverrides | null | undefined): PriceTable {
  if (!o) return base
  return layer(base, o)
}

/** The overrides in TRACE_PRICES (the stack's `cost.prices`), or null when there are none or they do not parse. */
export function overridesFromEnv(env: Record<string, string | undefined> = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}): PriceOverrides | null {
  const raw = env.TRACE_PRICES
  if (!raw) return null
  try {
    return PriceOverridesSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * The table in use: the built-in defaults, the fetched price list over them, the admin's overrides over both, every
 * entry marked with its source and date. Its `asOf` is the overrides' date, else the fetch's, else the defaults'.
 */
export function resolvePrices(fetched: PriceTable | null | undefined, overrides: PriceOverrides | null | undefined): PriceTable {
  let t = stamp(DEFAULT_PRICES, 'built-in')
  if (fetched) t = layer(t, stamp(fetched, 'fetched'))
  if (overrides) {
    const asOf = overrides.asOf ?? t.asOf
    t = layer(t, {
      ...(overrides.asOf ? { asOf: overrides.asOf } : {}),
      ...(overrides.models ? { models: overrides.models.map((m) => ({ ...m, source: 'override' as const, asOf })) } : {}),
      ...(overrides.gpu ? { gpu: { ...overrides.gpu, source: 'override' as const, asOf } } : {}),
      ...(overrides.cpu ? { cpu: { ...overrides.cpu, source: 'override' as const, asOf } } : {}),
      ...(overrides.tools ? { tools: { ...overrides.tools, source: 'override' as const, asOf } } : {}),
    })
  }
  return t
}

/** The table without the price list: TRACE_PRICES (the stack's overrides) over the defaults. */
export function pricesFromEnv(env: Record<string, string | undefined> = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}): PriceTable {
  const o = overridesFromEnv(env)
  return o ? resolvePrices(null, o) : DEFAULT_PRICES
}

/** The table's age in days on `now` (ms). */
export const ageDays = (t: Pick<PriceTable, 'asOf'>, now = Date.now()): number => Math.floor((now - Date.parse(`${t.asOf}T00:00:00Z`)) / 86_400_000)
export const isStale = (t: Pick<PriceTable, 'asOf'>, now = Date.now()): boolean => ageDays(t, now) > STALE_DAYS

/** A model id without its cross-region routing prefix, lower case: "us.anthropic.claude-sonnet-4-5-…" → "anthropic.claude-sonnet-4-5-…". */
export const bareModel = (id: string): string => id.trim().toLowerCase().replace(/^(us|eu|apac|jp|au|us-gov|global)\./, '')
/** Whether the id calls a global inference profile (no regional premium). */
export const isGlobal = (id: string): boolean => /^global\./i.test(id.trim())

/** The entry that prices `model` in `region`, or null. */
export function modelPrice(t: PriceTable, model: string, region?: string | null): ModelPrice | null {
  const m = bareModel(model)
  let best: ModelPrice | null = null
  let score = -1
  for (const e of t.models) {
    if (!m.includes(e.match.toLowerCase())) continue
    if (e.regions && !(region && e.regions.includes(region))) continue
    // the longest match, then a region's own entry, then the higher source (override, fetched, built-in)
    const s = e.match.length * 16 + (e.regions ? 8 : 0) + (3 - PRICE_SOURCES.indexOf(e.source ?? 'built-in'))
    if (s > score) { best = e; score = s }
  }
  return best
}

export interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }

const round = (n: number): number => Math.round(n * 1e6) / 1e6

/** What priced an amount: the entry's source and date; null when the table did not (the Agent SDK's figure, or none). */
export interface PricedBy { source: PriceSource; asOf: string }

/**
 * What one model's tokens cost: from the table (basis 'table'), else the Agent SDK's own estimate (basis 'sdk'),
 * else null (basis 'none'). Always an estimate.
 */
export function modelCost(t: PriceTable, model: string, tok: Tokens, o: { region?: string | null; sdkCost?: number | null } = {}): { amount: number | null; basis: 'table' | 'sdk' | 'none'; match: string | null; by: PricedBy | null } {
  const p = modelPrice(t, model, o.region)
  if (p) {
    const global = isGlobal(model)
    const r = !global && p.inRegion ? p.inRegion : p
    const k = global || p.inRegion ? 1 : p.regional
    const amount = ((tok.input * r.input) + (tok.output * r.output) + (tok.cacheRead * r.cacheRead) + (tok.cacheWrite * r.cacheWrite)) / 1e6 * k
    return { amount: round(amount), basis: 'table', match: p.match, by: { source: p.source ?? 'built-in', asOf: p.asOf ?? t.asOf } }
  }
  if (o.sdkCost !== undefined && o.sdkCost !== null && Number.isFinite(o.sdkCost)) return { amount: round(o.sdkCost), basis: 'sdk', match: null, by: null }
  return { amount: null, basis: 'none', match: null, by: null }
}

/** What priced a pool's jobs. */
export const poolPricedBy = (t: PriceTable, pool: 'gpu' | 'cpu'): PricedBy => ({ source: t[pool].source ?? 'built-in', asOf: t[pool].asOf ?? t.asOf })

/** What a Batch job cost: a graphics card job holds its instance; a CPU job pays for its vCPUs. Always an estimate. */
export function jobCost(t: PriceTable, pool: 'gpu' | 'cpu', seconds: number, vcpus: number): number {
  const h = Math.max(0, seconds) / 3600
  return round(pool === 'gpu' ? h * t.gpu.perHour : h * Math.max(1, vcpus) * t.cpu.perVcpuHour)
}

/** What priced the tools function's jobs (the built-in price when the table has none). */
export const toolsPricedBy = (t: PriceTable): PricedBy => (t.tools ? { source: t.tools.source ?? 'built-in', asOf: t.tools.asOf ?? t.asOf } : { source: 'built-in', asOf: DEFAULT_PRICES.asOf })

/** What a job on the tools function cost: its billed seconds x its memory, the call, and its /tmp over 512 MB. Always
 * an estimate (the function's own start, a cold one's included in the billed time, is counted; nothing else is). */
export function toolsCost(t: PriceTable, seconds: number, memoryMb: number, storageMb: number): number {
  const p = t.tools ?? DEFAULT_TOOLS_PRICE
  const s = Math.max(0, seconds)
  return round(s * (Math.max(128, memoryMb) / 1024) * p.perGbSecond + p.perRequest + s * (Math.max(0, storageMb - 512) / 1024) * p.perStorageGbSecond)
}

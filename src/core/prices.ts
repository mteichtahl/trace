/**
 * The one price table trace estimates cloud cost from: Claude on Amazon Bedrock per million tokens, and the AWS Batch
 * pools (graphics card and CPU jobs) per hour. Every amount computed from it is an ESTIMATE and is marked so wherever
 * it is shown; what AWS actually billed comes from Cost Explorer (src/core/cost.ts actuals), never from here.
 *
 * Why a table and not the Agent SDK's own figure: the SDK prices tokens at Anthropic's list prices, which do not know
 * the Bedrock region (regional endpoints cost more than global ones for newer models) or a negotiated rate. The SDK's
 * figure is kept beside each row (`sdk_cost`) and used only for a model the table does not know.
 *
 * How it is kept current (one place, with a date):
 *   - the defaults below carry `asOf` (when they were taken from the public price pages) and `sources`
 *   - an installation overrides any of it with the stack setting `cost.prices` (src/infra/props.ts, the installer's
 *     answers): a model entry, a pool, the currency, and a new `asOf`. The stack hands the merged table to the workers
 *     as TRACE_PRICES, so a change is one installer run, and every row records the table date it was priced with
 *   - when the table in use is older than STALE_DAYS, cost.get says so on screen ("the price table is from …")
 *
 * Model entries match on the model id with its routing prefix removed (us., eu., apac., global.): an entry's `match`
 * is a substring ("claude-sonnet-4-5"); the longest match wins, and an entry with `regions` wins over one without
 * when the run's region is listed. `regional` multiplies the price when the model is called through a regional (not
 * global) inference profile or in-region id, which Bedrock prices higher for newer models.
 */
import { z } from 'zod'

export const STALE_DAYS = 180

const Usd = z.number().min(0).max(10_000)

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
}).strict()
export type ModelPrice = z.output<typeof ModelPriceSchema>

export const PriceTableSchema = z.object({
  /** when these prices were taken from the price pages (YYYY-MM-DD) */
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.literal('USD').default('USD'),
  models: z.array(ModelPriceSchema).max(60),
  /** an AWS Batch graphics card job holds one whole instance */
  gpu: z.object({ perHour: Usd, basis: z.string().max(200) }).strict(),
  /** a CPU job is billed for the vCPUs it asked for */
  cpu: z.object({ perVcpuHour: Usd, basis: z.string().max(200) }).strict(),
  sources: z.array(z.string().url()).max(10).default([]),
}).strict()
export type PriceTable = z.output<typeof PriceTableSchema>

/** What `cost.prices` may say: any part of the table (models replace by `match`, pools replace whole). */
export const PriceOverridesSchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  models: z.array(ModelPriceSchema).max(60).optional(),
  gpu: z.object({ perHour: Usd, basis: z.string().max(200) }).strict().optional(),
  cpu: z.object({ perVcpuHour: Usd, basis: z.string().max(200) }).strict().optional(),
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
  sources: ['https://aws.amazon.com/bedrock/pricing/', 'https://www.anthropic.com/pricing', 'https://aws.amazon.com/ec2/pricing/on-demand/'],
})

/** The defaults with an installation's overrides laid over them. */
export function mergePrices(base: PriceTable, o: PriceOverrides | null | undefined): PriceTable {
  if (!o) return base
  const models = [...(o.models ?? []), ...base.models.filter((m) => !(o.models ?? []).some((x) => x.match === m.match && JSON.stringify(x.regions ?? []) === JSON.stringify(m.regions ?? [])))]
  return PriceTableSchema.parse({ ...base, ...(o.asOf ? { asOf: o.asOf } : {}), models, ...(o.gpu ? { gpu: o.gpu } : {}), ...(o.cpu ? { cpu: o.cpu } : {}) })
}

/** The table in use: TRACE_PRICES (the stack's merged table) when it parses, else the defaults. */
export function pricesFromEnv(env: Record<string, string | undefined> = process.env): PriceTable {
  const raw = env.TRACE_PRICES
  if (!raw) return DEFAULT_PRICES
  try {
    return mergePrices(DEFAULT_PRICES, PriceOverridesSchema.parse(JSON.parse(raw)))
  } catch {
    return DEFAULT_PRICES
  }
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
    const s = e.match.length * 2 + (e.regions ? 1 : 0)
    if (s > score) { best = e; score = s }
  }
  return best
}

export interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }

const round = (n: number): number => Math.round(n * 1e6) / 1e6

/**
 * What one model's tokens cost: from the table (basis 'table'), else the Agent SDK's own estimate (basis 'sdk'),
 * else null (basis 'none'). Always an estimate.
 */
export function modelCost(t: PriceTable, model: string, tok: Tokens, o: { region?: string | null; sdkCost?: number | null } = {}): { amount: number | null; basis: 'table' | 'sdk' | 'none'; match: string | null } {
  const p = modelPrice(t, model, o.region)
  if (p) {
    const k = isGlobal(model) ? 1 : p.regional
    const amount = ((tok.input * p.input) + (tok.output * p.output) + (tok.cacheRead * p.cacheRead) + (tok.cacheWrite * p.cacheWrite)) / 1e6 * k
    return { amount: round(amount), basis: 'table', match: p.match }
  }
  if (o.sdkCost !== undefined && o.sdkCost !== null && Number.isFinite(o.sdkCost)) return { amount: round(o.sdkCost), basis: 'sdk', match: null }
  return { amount: null, basis: 'none', match: null }
}

/** What a Batch job cost: a graphics card job holds its instance; a CPU job pays for its vCPUs. Always an estimate. */
export function jobCost(t: PriceTable, pool: 'gpu' | 'cpu', seconds: number, vcpus: number): number {
  const h = Math.max(0, seconds) / 3600
  return round(pool === 'gpu' ? h * t.gpu.perHour : h * Math.max(1, vcpus) * t.cpu.perVcpuHour)
}

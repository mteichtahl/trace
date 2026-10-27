/**
 * The Lambda `<prefix>-cost-explorer`: once a day (an EventBridge schedule, src/infra/cost.ts), what AWS billed each
 * project, from Cost Explorer, into the installation's actuals (src/core/cost.ts: installation/cost/actuals.db).
 *
 *   1. the cost allocation tags: ListCostAllocationTags for trace:project and trace:installation. A tag Cost Explorer
 *      can group by must be ACTIVE for cost allocation, which is a billing setting, once per account (or per
 *      organization, in its management account). With `activate` (the stack's cost.explorer.activateTags) an
 *      inactive tag is activated with UpdateCostAllocationTagsStatus. A tag is listed only once billing has seen it
 *      on a resource (up to a day after the first tagged resource exists), and activation applies from then on (it
 *      does not reach back); until then the status says so and the next run tries again. Where the call is refused
 *      (a member account of an organization: only its management account may activate), the status says what a
 *      person does instead: Billing and Cost Management console › Cost allocation tags › activate trace:project
 *   2. GetCostAndUsage, daily, UnblendedCost, grouped by the trace:project tag and by service, for the last
 *      LOOKBACK_DAYS days (Cost Explorer revises recent days for about a day; those days are replaced each run).
 *      Filtered to this installation's trace:installation tag when that tag is active too (otherwise unfiltered, and
 *      the spend not tagged with a project is left out, since it is not only this installation's)
 *   3. the rows and the status (checked, next read, whether the tags are active, a message in plain words) are written
 *      with a conditional put, like every database in the central bucket
 *
 * Each Cost Explorer request costs US$0.01: one run makes two to four (the tags, then the cost pages).
 *
 * The same run then refreshes the price table (refreshPrices, with cost.priceList.enabled), on the same daily
 * schedule: prices change rarely, so once a day is plenty. It asks the AWS Price List Query API (GetProducts, which is
 * free) for Claude on Bedrock in the installation's region and the Batch pools' instances on demand, maps them onto
 * the table (src/core/price-list.ts), and writes installation/cost/prices.json (src/core/prices-store.ts) dated the
 * day it fetched. A failed fetch keeps the last good table and records why and when it tries next; the two steps
 * never stop each other.
 */
import type { CostExplorerClient } from '@aws-sdk/client-cost-explorer'
import type { GetProductsCommandInput, GetProductsCommandOutput } from '@aws-sdk/client-pricing'
import { ActualsStore, type ActualRow, type ExplorerStatus, writeActuals } from '../../core/cost.js'
import { Conflict, S3Backend, type S3Api } from '../../core/central.js'
import { ACTUALS_PREFIX } from '../../core/cost.js'
import {
  BEDROCK_SERVICE, EC2_SERVICE, PRICE_LIST_SOURCE, type PriceListProduct, askedType, ec2Filters, instancePrice, modelsFromPriceList, parsePriceList, pricingEndpoint,
} from '../../core/price-list.js'
import { DEFAULT_PRICES, type PriceTable, PriceTableSchema } from '../../core/prices.js'
import { PRICES_KEY, PRICES_PREFIX, type PriceFile, PriceFileSchema } from '../../core/prices-store.js'

export const PROJECT_TAG = 'trace:project'
export const INSTALLATION_TAG = 'trace:installation'
export const LOOKBACK_DAYS = 14
const DAY_MS = 86_400_000

export type Ce = Pick<CostExplorerClient, 'send'>

export interface CostExplorerDeps {
  ce: Ce
  /** the central bucket */
  bucket: string
  /** this installation's prefix (its trace:installation tag value) */
  prefix: string
  /** activate the tags when they are inactive */
  activate: boolean
  /** when the schedule runs next, from now (ms) */
  nextAt: (now: number) => number
  now: () => number
  s3?: S3Api | undefined
  log: (entry: Record<string, unknown>) => void
  scratch?: string | undefined
}

const day = (t: number): string => new Date(t).toISOString().slice(0, 10)

/** The days Cost Explorer is asked for: [start, end) with end tomorrow (UTC), so today's partial day is included. */
export function window(now: number, days = LOOKBACK_DAYS): { start: string; end: string; days: string[] } {
  const end = Date.parse(`${day(now)}T00:00:00Z`) + DAY_MS
  const start = end - days * DAY_MS
  const list: string[] = []
  for (let t = start; t < end; t += DAY_MS) list.push(day(t))
  return { start: day(start), end: day(end), days: list }
}

type TagState = 'active' | 'inactive' | 'not_found' | 'unknown'

/** The status of each tag key, activating inactive ones when allowed. */
export async function tagStates(ce: Ce, activate: boolean, log: CostExplorerDeps['log']): Promise<{ states: Record<string, TagState>; refused: string | null }> {
  const ceMod = await import('@aws-sdk/client-cost-explorer')
  const keys = [PROJECT_TAG, INSTALLATION_TAG]
  const states: Record<string, TagState> = Object.fromEntries(keys.map((k) => [k, 'not_found' as TagState]))
  let refused: string | null = null
  try {
    const r = await ce.send(new ceMod.ListCostAllocationTagsCommand({ TagKeys: keys, Type: 'UserDefined' }))
    for (const t of r.CostAllocationTags ?? []) if (t.TagKey && t.TagKey in states) states[t.TagKey] = t.Status === 'Active' ? 'active' : 'inactive'
  } catch (e) {
    log({ warning: 'cost-explorer: could not list the cost allocation tags', error: e instanceof Error ? e.message : String(e) })
    for (const k of keys) states[k] = 'unknown'
    return { states, refused: null }
  }
  const inactive = keys.filter((k) => states[k] === 'inactive')
  if (activate && inactive.length) {
    try {
      const u = await ce.send(new ceMod.UpdateCostAllocationTagsStatusCommand({ CostAllocationTagsStatus: inactive.map((TagKey) => ({ TagKey, Status: 'Active' })) }))
      const failed = new Set((u.Errors ?? []).map((x) => x.TagKey))
      for (const k of inactive) if (!failed.has(k)) states[k] = 'active'
      if (failed.size) refused = (u.Errors ?? []).map((x) => `${x.TagKey}: ${x.Message ?? x.Code ?? 'refused'}`).join('; ')
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e)
    }
  }
  return { states, refused }
}

/** The message a person reads under the actuals, from the tags' states. */
export function statusMessage(states: Record<string, TagState>, refused: string | null, activate: boolean): string {
  const p = states[PROJECT_TAG]
  if (p === 'active') return 'Read from Cost Explorer by the trace:project cost allocation tag. A day\'s figures settle about 24 hours later, so the latest days may still change.'
  if (p === 'not_found') return 'Cost Explorer does not list the trace:project tag yet: billing sees a new tag up to a day after the first tagged resource exists. trace tries again at the next read.'
  if (p === 'unknown') return 'Cost Explorer could not be asked about the cost allocation tags; trace tries again at the next read.'
  if (refused) return `The trace:project tag is not active for cost allocation, and trace was not allowed to activate it (${refused.slice(0, 200)}). Activate it once in the Billing and Cost Management console, under Cost allocation tags (in an organization, from its management account).`
  return activate
    ? 'The trace:project tag was just activated for cost allocation; Cost Explorer groups by it from about a day later, and only for cost from then on.'
    : 'The trace:project tag is not active for cost allocation. Activate it once in the Billing and Cost Management console, under Cost allocation tags, or set cost.explorer.activateTags so trace does it.'
}

/** One run: read the window from Cost Explorer and write it (and the status) into the actuals. */
export async function readCosts(d: CostExplorerDeps): Promise<{ rows: number; status: ExplorerStatus }> {
  const ceMod = await import('@aws-sdk/client-cost-explorer')
  const now = d.now()
  const { states, refused } = await tagStates(d.ce, d.activate, d.log)
  const w = window(now)
  const rows: ActualRow[] = []
  let ok = states[PROJECT_TAG] === 'active'
  let message = statusMessage(states, refused, d.activate)
  if (ok) {
    const filtered = states[INSTALLATION_TAG] === 'active'
    try {
      let token: string | undefined
      do {
        const r = await d.ce.send(new ceMod.GetCostAndUsageCommand({
          TimePeriod: { Start: w.start, End: w.end }, Granularity: 'DAILY', Metrics: ['UnblendedCost'],
          GroupBy: [{ Type: 'TAG', Key: PROJECT_TAG }, { Type: 'DIMENSION', Key: 'SERVICE' }],
          ...(filtered ? { Filter: { Tags: { Key: INSTALLATION_TAG, Values: [d.prefix], MatchOptions: ['EQUALS'] } } } : {}),
          ...(token ? { NextPageToken: token } : {}),
        }))
        for (const t of r.ResultsByTime ?? []) {
          const dayOf = t.TimePeriod?.Start ?? ''
          for (const g of t.Groups ?? []) {
            const [tag = '', service = 'Other'] = g.Keys ?? []
            const repo = tag.startsWith(`${PROJECT_TAG}$`) ? tag.slice(PROJECT_TAG.length + 1) : ''
            if (!repo && !filtered) continue
            const amount = Number(g.Metrics?.UnblendedCost?.Amount ?? 0)
            if (!Number.isFinite(amount) || Math.abs(amount) < 0.000001) continue
            rows.push({ repo, day: dayOf, service, amount, estimated: Boolean(t.Estimated) })
          }
        }
        token = r.NextPageToken
      } while (token)
      if (!filtered) message += ' The trace:installation tag is not active, so the figures are not limited to this installation; spend without a project tag is not counted.'
    } catch (e) {
      ok = false
      message = `Cost Explorer did not answer (${(e instanceof Error ? e.message : String(e)).slice(0, 200)}); trace tries again at the next read.`
    }
  }
  const status: ExplorerStatus = { checkedAt: now / 1000, nextAt: d.nextAt(now) / 1000, ok, tag: states[PROJECT_TAG] ?? 'unknown', message }
  const store = new ActualsStore(new S3Backend(d.bucket, ACTUALS_PREFIX, d.s3), d.scratch ? { scratch: d.scratch } : {})
  await store.update((db) => { writeActuals(db, rows, ok ? w.days : [], status, now / 1000); return { result: null } })
  d.log({ event: 'cost-explorer', ok, rows: rows.length, tag: status.tag })
  return { rows: rows.length, status }
}

// ------------------------------------------------------------------ the price table, from the AWS price list

/** GetProducts, as the price refresh uses it (the real client's send, or a test's). */
export type PricingApi = { getProducts(i: GetProductsCommandInput): Promise<Pick<GetProductsCommandOutput, 'PriceList' | 'NextToken'>> }

export interface PriceRefreshDeps {
  pricing: PricingApi
  /** the Price List endpoint asked (us-east-1, eu-central-1 or ap-south-1) */
  endpoint: string
  bucket: string
  /** the installation's region: the prices are for it */
  region: string
  /** the model ids configured (the agents', the web app's chat): their entries are always taken */
  models: readonly string[]
  /** the Batch pools' instance types or families, in order of fit; empty: that pool is off */
  gpuTypes: readonly string[]
  cpuTypes: readonly string[]
  nextAt: (now: number) => number
  now: () => number
  s3?: S3Api | undefined
  log: (entry: Record<string, unknown>) => void
}

/** Every product of one GetProducts query, page by page (at most `maxPages` of 100). */
async function allProducts(api: PricingApi, input: GetProductsCommandInput, maxPages = 20): Promise<PriceListProduct[]> {
  const out: PriceListProduct[] = []
  let token: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const r = await api.getProducts({ ...input, FormatVersion: 'aws_v1', MaxResults: 100, ...(token ? { NextToken: token } : {}) })
    out.push(...parsePriceList(r.PriceList))
    token = r.NextToken
    if (!token) break
  }
  return out
}

/**
 * The table from the price list: Claude on Bedrock in the region (src/core/price-list.ts modelsFromPriceList), the
 * GPU pool at its first instance type, the CPU pool per vCPU at its first family's xlarge. A pool the price list does
 * not answer keeps the built-in price (marked so). Throws when the price list cannot be asked.
 */
export async function fetchPriceTable(d: Omit<PriceRefreshDeps, 'bucket' | 's3' | 'nextAt'>, now: number): Promise<{ table: PriceTable; notes: string[] }> {
  const notes: string[] = []
  const claude = await allProducts(d.pricing, {
    ServiceCode: BEDROCK_SERVICE,
    Filters: [
      { Type: 'TERM_MATCH', Field: 'provider', Value: 'Anthropic' },
      { Type: 'TERM_MATCH', Field: 'regionCode', Value: d.region },
      { Type: 'TERM_MATCH', Field: 'feature', Value: 'On-demand Inference' },
    ],
  })
  const m = modelsFromPriceList(claude, { region: d.region, models: d.models })
  notes.push(...m.notes)
  if (!m.models.length) notes.push(`The price list has no Claude prices for ${d.region}; the built-in table prices every model.`)
  const builtIn = (pool: 'gpu' | 'cpu', why: string) => { notes.push(why); return { ...DEFAULT_PRICES[pool], source: 'built-in' as const, asOf: DEFAULT_PRICES.asOf } }
  const pool = async (types: readonly string[]): Promise<{ type: string; perHour: number; vcpus: number } | null> => {
    const type = types[0] ? askedType(types[0]) : null
    if (!type) return null
    const p = instancePrice(await allProducts(d.pricing, { ServiceCode: EC2_SERVICE, Filters: ec2Filters(type, d.region) }, 2), type, d.region)
    return p ? { type, ...p } : null
  }
  const g = await pool(d.gpuTypes)
  const c = await pool(d.cpuTypes)
  const gpu = g
    ? { perHour: g.perHour, basis: `${g.type} on demand in ${d.region} (one job holds the instance)` }
    : builtIn('gpu', d.gpuTypes.length ? `The price list has no on-demand price for ${askedType(d.gpuTypes[0] ?? '')} in ${d.region}; the graphics card pool keeps the built-in price.` : 'There is no graphics card pool; its built-in price is kept.')
  const cpu = c
    ? { perVcpuHour: Math.round((c.perHour / c.vcpus) * 1e6) / 1e6, basis: `${c.type} on demand in ${d.region}, per vCPU (${c.perHour} an hour for ${c.vcpus})` }
    : builtIn('cpu', d.cpuTypes.length ? `The price list has no on-demand price for ${askedType(d.cpuTypes[0] ?? '')} in ${d.region}; the CPU pool keeps the built-in price.` : 'There is no CPU pool; its built-in price is kept.')
  const table = PriceTableSchema.parse({ asOf: day(now), currency: 'USD', models: m.models, gpu, cpu, sources: [PRICE_LIST_SOURCE] })
  return { table, notes }
}

/**
 * One refresh: fetch the table and write installation/cost/prices.json with a conditional put. A failed fetch keeps
 * the last good table, with why and when it tries next. Never throws for the price list's sake (only when the file
 * cannot be written).
 */
export async function refreshPrices(d: PriceRefreshDeps): Promise<PriceFile> {
  const now = d.now()
  const store = new S3Backend(d.bucket, PRICES_PREFIX, d.s3)
  let fetched: { table: PriceTable; notes: string[] } | null = null
  let error: string | null = null
  try {
    fetched = await fetchPriceTable(d, now)
  } catch (e) {
    error = `${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`.slice(0, 300)
    d.log({ warning: 'prices: the price list could not be read', error })
  }
  for (let attempt = 0; ; attempt++) {
    const got = await store.get(PRICES_KEY)
    let prev: PriceFile | null = null
    try { prev = got ? PriceFileSchema.parse(JSON.parse(new TextDecoder().decode(got.body))) : null } catch { prev = null }
    const file: PriceFile = PriceFileSchema.parse({
      version: 1,
      table: fetched?.table ?? prev?.table ?? null,
      fetchedAt: fetched ? now / 1000 : prev?.fetchedAt ?? null,
      region: d.region, endpoint: d.endpoint,
      notes: (fetched?.notes ?? prev?.notes ?? []).map((n) => n.slice(0, 400)).slice(0, 60),
      tried: { at: now / 1000, ok: Boolean(fetched), error },
      nextAt: d.nextAt(now) / 1000,
    })
    try {
      await store.put(PRICES_KEY, new TextEncoder().encode(JSON.stringify(file)), { contentType: 'application/json', ...(got ? { ifMatch: got.etag } : { ifNoneMatch: true }) })
      d.log({ event: 'prices', ok: file.tried.ok, models: file.table?.models.length ?? 0, asOf: file.table?.asOf ?? null })
      return file
    } catch (e) {
      if (!(e instanceof Conflict) || attempt >= 2) throw e
    }
  }
}

/** The next run of a daily schedule at `hour`:`minute` UTC after `now`. */
export const nextDaily = (hour: number, minute: number) => (now: number): number => {
  const t = new Date(now)
  const at = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), hour, minute)
  return at > now ? at : at + DAY_MS
}

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean)

/** The Lambda handler (the schedule's target): the Cost Explorer read, then the price refresh, each on its own. */
export async function handler(): Promise<void> {
  const bucket = process.env.TRACE_CENTRAL_BUCKET
  const prefix = process.env.TRACE_PREFIX
  if (!bucket || !prefix) throw new Error('TRACE_CENTRAL_BUCKET and TRACE_PREFIX are needed')
  const [h = 6, m = 17] = (process.env.TRACE_COST_SCHEDULE ?? '6:17').split(':').map(Number)
  const log = (e: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify(e)}\n`) }
  const failed: string[] = []
  if (process.env.TRACE_COST_EXPLORER !== '0') {
    try {
      const ceMod = await import('@aws-sdk/client-cost-explorer')
      // Cost Explorer's API has one endpoint, in us-east-1
      const ce = new ceMod.CostExplorerClient({ region: 'us-east-1' })
      await readCosts({ ce, bucket, prefix, activate: process.env.TRACE_COST_ACTIVATE_TAGS === '1', nextAt: nextDaily(h, m), now: Date.now, log, scratch: '/tmp' })
    } catch (e) {
      failed.push(`cost explorer: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (process.env.TRACE_PRICE_LIST === '1') {
    try {
      const region = process.env.TRACE_REGION ?? process.env.AWS_REGION ?? 'us-east-1'
      // the Price List Query API answers in us-east-1, eu-central-1 and ap-south-1 only: the nearest
      const endpoint = process.env.TRACE_PRICING_ENDPOINT ?? pricingEndpoint(region)
      const pm = await import('@aws-sdk/client-pricing')
      const client = new pm.PricingClient({ region: endpoint })
      await refreshPrices({
        pricing: { getProducts: (i) => client.send(new pm.GetProductsCommand(i)) }, endpoint, bucket, region,
        models: list(process.env.TRACE_PRICE_MODELS), gpuTypes: list(process.env.TRACE_GPU_INSTANCE_TYPES), cpuTypes: list(process.env.TRACE_CPU_INSTANCE_TYPES),
        nextAt: nextDaily(h, m), now: Date.now, log,
      })
    } catch (e) {
      failed.push(`prices: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // the schedule retries a failed run (twice, src/infra/cost.ts)
  if (failed.length) throw new Error(failed.join('; '))
}

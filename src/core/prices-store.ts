/**
 * The fetched price table in the central bucket, installation/cost/prices.json: written once a day by the
 * `<prefix>-cost-explorer` Lambda (src/infra/lambda/cost-explorer.ts refreshPrices) from the AWS price list, read by
 * the workers' ledger (src/core/cost.ts) and the API's cost.get and usage.month (src/api/actions-cost.ts).
 *
 * The file keeps the last table that was fetched whole, and beside it how the last try went: a day the price list
 * could not be read leaves yesterday's table in use (and says so), and an installation that never fetched one uses the
 * built-in table (src/core/prices.ts DEFAULT_PRICES). Each container reads the file at most once an hour (CACHE_MS):
 * prices change rarely, and a run or job priced with an hour-old table is priced the same.
 *
 * Who may read it: the API (installation/cost/*, its cost policy) and each worker, this one key only
 * (src/infra/project.ts PricesRead). Only the Lambda writes it, with conditional puts.
 */
import { z } from 'zod'
import { type Backend, backendFor } from './central.js'
import { type PriceOverrides, type PriceTable, PriceTableSchema, overridesFromEnv, resolvePrices } from './prices.js'

/** Under the central bucket: installation/cost/prices.json (the actuals' folder: src/core/cost.ts) */
export const PRICES_PREFIX = 'installation'
export const PRICES_KEY = 'cost/prices.json'
export const CACHE_MS = 3_600_000

export const PriceFileSchema = z.object({
  version: z.literal(1),
  /** the last table fetched whole (its asOf: the day it was fetched), or null before the first */
  table: PriceTableSchema.nullable(),
  /** when that table was fetched (seconds) */
  fetchedAt: z.number().nullable(),
  /** the region it prices, and the Price List endpoint asked */
  region: z.string().max(40),
  endpoint: z.string().max(40),
  /** what the price list lacked, and what was used instead, in plain words */
  notes: z.array(z.string().max(400)).max(60),
  /** the last try: when, whether it worked, why not */
  tried: z.object({ at: z.number(), ok: z.boolean(), error: z.string().max(400).nullable() }),
  /** the next try (seconds) */
  nextAt: z.number().nullable(),
}).strict()
export type PriceFile = z.output<typeof PriceFileSchema>

/** The file, or null when there is none yet. Throws when it cannot be read or does not parse. */
export async function readPriceFile(store: Backend): Promise<PriceFile | null> {
  const got = await store.get(PRICES_KEY)
  if (!got) return null
  return PriceFileSchema.parse(JSON.parse(new TextDecoder().decode(got.body)))
}

/** The installation's prefix of the central bucket from a session's TRACE_HOME (s3://b/central → s3://b/installation;
 * a local TRACE_HOME → <TRACE_HOME>/installation), or null. */
export function installationFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const home = env.TRACE_HOME?.trim().replace(/\/+$/, '')
  if (!home) return null
  const s3 = /^s3:\/\/([^/]+)(\/.*)?$/.exec(home)
  if (s3) {
    const parts = (s3[2] ?? '').split('/').filter(Boolean)
    parts.pop()
    return `s3://${s3[1]}/${[...parts, PRICES_PREFIX].join('/')}`
  }
  return `${home.replace(/^file:\/\//, '')}/${PRICES_PREFIX}`
}

/** What a reader knows of the fetched table: the file (null: none yet) or why it could not be read. */
export interface FetchedPrices { file: PriceFile | null; error: string | null }

const cache = new Map<string, { at: number; value: FetchedPrices }>()

/** Forget what was read (tests; a container never needs to). */
export function clearPriceCache(): void { cache.clear() }

/** The fetched file from `store`, read at most once per `maxAgeMs` in this container. Never throws. */
export async function fetchedPrices(store: Backend, o: { now?: number; maxAgeMs?: number } = {}): Promise<FetchedPrices> {
  const now = o.now ?? Date.now()
  const hit = cache.get(store.url)
  if (hit && now - hit.at < (o.maxAgeMs ?? CACHE_MS)) return hit.value
  let value: FetchedPrices
  try {
    value = { file: await readPriceFile(store), error: null }
  } catch (e) {
    value = { file: null, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }
  }
  cache.set(store.url, { at: now, value })
  return value
}

/** The table in use, and what it was made of: the admin's overrides (TRACE_PRICES), the fetched table, the built-in. */
export interface PricesInUse { table: PriceTable; fetched: FetchedPrices; overrides: PriceOverrides | null }

/**
 * The table a session prices with: TRACE_PRICES over the fetched table over the built-in one. `store` is the
 * installation's prefix of the central bucket (default: from TRACE_HOME); without one, no fetched table.
 */
export async function pricesFor(env: Record<string, string | undefined> = process.env, o: { store?: Backend | null; now?: number } = {}): Promise<PricesInUse> {
  const overrides = overridesFromEnv(env)
  const where = o.store === undefined ? installationFromEnv(env) : null
  const store = o.store === undefined ? (where ? backendFor(where) : null) : o.store
  const fetched = store ? await fetchedPrices(store, o.now !== undefined ? { now: o.now } : {}) : { file: null, error: null }
  return { table: resolvePrices(fetched.file?.table ?? null, overrides), fetched, overrides }
}

/**
 * The Lambda `<prefix>-order-watch`: follows shipped orders' parcels with their carrier (src/core/shipping.ts).
 * Hourly (an EventBridge schedule) it checks the watches whose next check is due; a direct invocation
 * `{ repo, orderId }` (order.check_now, from the API) checks one at once. Carriers send no events to trace, so this is
 * a declared timer, backing off while nothing changes; the wait line says when it checks next.
 *
 *   DHL   GET https://api-eu.dhl.com/track/shipments?trackingNumber=… with the header DHL-API-Key (the `dhl`
 *         integration's secret, which only this function may read). Its status codes pre-transit, transit,
 *         delivered, failure and unknown are trace's carrier states as they are
 *
 * It writes only installation/shipping/ (the watch). It never changes an order: a person records delivery.
 */
import { S3Backend, type S3Api } from '../../core/central.js'
import { type CarrierReading, type CarrierState, SHIPPING_PREFIX, type Watch, WatchStore, due, recordCheck } from '../../core/shipping.js'

type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** One DHL tracking answer as a carrier reading, or an error in words. Pure over the response. */
export async function dhlTrack(tracking: string, key: string, f: Fetch): Promise<{ reading: CarrierReading | null; error: string | null }> {
  let r: Response
  try {
    r = await f(`https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(tracking)}`, { method: 'GET', headers: { 'DHL-API-Key': key, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  } catch (e) {
    return { reading: null, error: `DHL could not be reached (${e instanceof Error ? e.message : String(e)})` }
  }
  if (r.status === 404) return { reading: null, error: 'DHL does not know this tracking number yet (a new label can take a day to appear)' }
  if (r.status === 401 || r.status === 403) return { reading: null, error: 'DHL refused the key: an admin checks it in Admin › Integrations' }
  if (r.status === 429) return { reading: null, error: 'DHL\'s daily limit was reached' }
  if (!r.ok) return { reading: null, error: `DHL answered HTTP ${r.status}` }
  let body: unknown
  try { body = await r.json() } catch { return { reading: null, error: 'DHL\'s answer could not be read' } }
  const sh = (body as { shipments?: { status?: { statusCode?: string; status?: string; description?: string; timestamp?: string }; estimatedTimeOfDelivery?: string }[] }).shipments?.[0]
  if (!sh?.status) return { reading: null, error: 'DHL\'s answer had no status' }
  const code = (sh.status.statusCode ?? 'unknown').toLowerCase().replace('-', '_')
  const state: CarrierState = (['pre_transit', 'transit', 'delivered', 'failure'] as const).find((x) => x === code) ?? 'unknown'
  return { reading: { state, status: (sh.status.description || sh.status.status || code).slice(0, 200), eventAt: sh.status.timestamp ?? null, eta: sh.estimatedTimeOfDelivery ?? null }, error: null }
}

export interface OrderWatchDeps {
  bucket: string
  now: () => number
  /** the carrier's key, or null when the integration is not set */
  dhlKey: () => Promise<string | null>
  fetch: Fetch
  s3?: S3Api | undefined
  log: (e: Record<string, unknown>) => void
  scratch?: string | undefined
}

/** One run: check what is due (or the one asked for), record each outcome. */
export async function checkDue(d: OrderWatchDeps, only?: { repo: string; orderId?: string | undefined }): Promise<Watch[]> {
  const store = new WatchStore(new S3Backend(d.bucket, SHIPPING_PREFIX, d.s3), d.scratch ? { scratch: d.scratch } : {})
  const now = d.now() / 1000
  const list = (await store.read((db) => due(db, now, only))).result
  if (!list.length) return []
  const key = await d.dhlKey()
  const results: { w: Watch; reading: CarrierReading | null; error: string | null }[] = []
  for (const w of list) {
    if (w.carrier !== 'dhl') continue
    if (!key) { results.push({ w, reading: null, error: 'no DHL key is set (Admin › Integrations)' }); continue }
    results.push({ w, ...(await dhlTrack(w.tracking, key, d.fetch)) })
  }
  const out = (await store.update((db) => ({ result: results.map((x) => recordCheck(db, x.w, x.reading, x.error, now)) }))).result
  d.log({ event: 'order-watch', checked: out.length, delivered: out.filter((w) => w.state === 'delivered').length })
  return out
}

/** The handler: the hourly schedule (no detail), or order.check_now ({ repo, orderId }). */
export async function handler(e: { repo?: unknown; orderId?: unknown } = {}): Promise<{ checked: number }> {
  const bucket = process.env.TRACE_CENTRAL_BUCKET
  const secret = process.env.TRACE_DHL_SECRET
  if (!bucket || !secret) throw new Error('TRACE_CENTRAL_BUCKET and TRACE_DHL_SECRET are needed')
  const sm = await import('@aws-sdk/client-secrets-manager')
  const client = new sm.SecretsManagerClient({})
  const only = typeof e.repo === 'string' ? { repo: e.repo, ...(typeof e.orderId === 'string' ? { orderId: e.orderId } : {}) } : undefined
  const out = await checkDue({
    bucket, now: Date.now, fetch: (u, i) => fetch(u, i), scratch: '/tmp', log: (x) => { process.stdout.write(`${JSON.stringify(x)}\n`) },
    dhlKey: async () => {
      try {
        const v = (await client.send(new sm.GetSecretValueCommand({ SecretId: secret }))).SecretString
        const k = v ? (JSON.parse(v) as { DHL_API_KEY?: unknown }).DHL_API_KEY : undefined
        return typeof k === 'string' && k ? k : null
      } catch {
        return null
      }
    },
  }, only)
  return { checked: out.length }
}

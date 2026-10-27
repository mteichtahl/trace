/**
 * Watching a shipped order's parcel with its carrier, on a backed-off timer, because nothing else is possible:
 *
 *   JLCPCB    its order-status API (the Ordering API, api.jlcpcb.com) is for partner companies JLCPCB approves on
 *             their order history and volume, not for an ordinary customer's account, and it sends no events. So
 *             trace does not read JLCPCB at all: the person records the order (order.record) and, from JLCPCB's
 *             shipping notice, the carrier and tracking number (order.update). Reading JLCPCB's notification emails
 *             would need inbound email (Amazon SES receiving, a domain's MX record) that an installation does not
 *             have, so it is not built
 *   carriers  DHL's Shipment Tracking - Unified API is free with a key (developer.dhl.com, 250 calls a day on the
 *             starting plan): the optional integration `dhl` (src/core/integrations-catalog.ts). FedEx and UPS have
 *             tracking APIs too, but each needs an OAuth app with a shipping account; not built, so their parcels
 *             are not checked and the wait says so
 *
 *   where     installation/shipping/watch.db in the central bucket: one row per watched order. The API writes the
 *             request when a tracking number is recorded (conditional put, as every central database); the
 *             `<prefix>-order-watch` Lambda (src/infra/lambda/order-watch.ts) reads and updates it. No worker can
 *             reach installation/*, so an agent cannot mark a parcel delivered
 *   timer     the Lambda runs hourly and checks only the rows whose next check is due: the first an hour after the
 *             number is recorded, then the interval doubles while the carrier's status does not change, up to
 *             MAX_INTERVAL_S, and drops back to BASE_INTERVAL_S when it does; delivered (or the carrier's failure)
 *             ends the watch. `order.check_now` asks for a check at once. The wait line says when it checks next
 *
 * A check never changes the order: when the carrier says delivered, the Build tab says so and the person records it.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Backend } from './central.js'
import { CARRIER_NAMES, type Carrier } from './boards.js'
import { BucketDb } from './journey-store.js'
import { transaction } from './store.js'

export const SHIPPING_PREFIX = 'installation'
export const WATCH_KEY = 'shipping/watch.db'
export const BASE_INTERVAL_S = 3600
export const MAX_INTERVAL_S = 12 * 3600
/** The carriers trace can check (with their integration configured). */
export const CHECKABLE: readonly Carrier[] = ['dhl']

export const CARRIER_STATES = ['pre_transit', 'transit', 'delivered', 'failure', 'unknown'] as const
export type CarrierState = (typeof CARRIER_STATES)[number]

const SQL = `
CREATE TABLE IF NOT EXISTS watch (
  repo TEXT NOT NULL,
  order_id TEXT NOT NULL,
  number TEXT NOT NULL,           -- the fab's order number, for the lines people read
  fab TEXT NOT NULL,
  carrier TEXT NOT NULL,
  tracking TEXT NOT NULL,
  state TEXT,                     -- the carrier's state, once read
  status TEXT,                    -- the carrier's own words
  event_at TEXT,                  -- when the carrier last saw the parcel
  eta TEXT,
  checked_at REAL, next_at REAL, interval_s REAL NOT NULL, checks INTEGER NOT NULL DEFAULT 0,
  error TEXT,                     -- the last check's problem, in words
  ended_at REAL,                  -- delivered, the carrier's failure, or the order no longer watched
  created REAL NOT NULL,
  PRIMARY KEY (repo, order_id)
);`

export const applyWatchSchema = (db: DatabaseSync): void => { db.exec(SQL) }

export class WatchStore extends BucketDb {
  constructor(store: Backend, o: { scratch?: string } = {}) {
    super(store, '', { folder: 'shipping', file: 'watch.db', schema: applyWatchSchema, key: WATCH_KEY }, o)
  }
}

export interface Watch {
  repo: string; orderId: string; number: string; fab: string; carrier: Carrier; tracking: string
  state: CarrierState | null; status: string | null; eventAt: string | null; eta: string | null
  checkedAt: number | null; nextAt: number | null; intervalS: number; checks: number; error: string | null; endedAt: number | null
}

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const row = (r: Record<string, unknown>): Watch => ({
  repo: String(r.repo), orderId: String(r.order_id), number: String(r.number), fab: String(r.fab), carrier: r.carrier as Carrier, tracking: String(r.tracking),
  state: s(r.state) as CarrierState | null, status: s(r.status), eventAt: s(r.event_at), eta: s(r.eta), checkedAt: n(r.checked_at), nextAt: n(r.next_at),
  intervalS: Number(r.interval_s), checks: Number(r.checks), error: s(r.error), endedAt: n(r.ended_at),
})

/** Every watch (of one project, with repo), oldest first. */
export function watches(db: DatabaseSync, repo?: string): Watch[] {
  return ((repo
    ? db.prepare('SELECT * FROM watch WHERE repo=? ORDER BY created').all(repo.toLowerCase())
    : db.prepare('SELECT * FROM watch ORDER BY created').all()) as Record<string, unknown>[]).map(row)
}

/** Start (or restart, for a new tracking number) watching an order. Its first check is due now + BASE_INTERVAL_S. */
export function watchOrder(db: DatabaseSync, w: { repo: string; orderId: string; number: string; fab: string; carrier: Carrier; tracking: string }, now: number): Watch {
  const repo = w.repo.toLowerCase()
  const prior = watches(db, repo).find((x) => x.orderId === w.orderId)
  transaction(db, () => {
    if (prior && prior.tracking === w.tracking && prior.carrier === w.carrier) return
    db.prepare(`INSERT INTO watch (repo, order_id, number, fab, carrier, tracking, interval_s, next_at, created, checks) VALUES (?,?,?,?,?,?,?,?,?,0)
      ON CONFLICT(repo, order_id) DO UPDATE SET carrier=excluded.carrier, tracking=excluded.tracking, state=NULL, status=NULL, event_at=NULL, eta=NULL, checked_at=NULL,
      next_at=excluded.next_at, interval_s=excluded.interval_s, checks=0, error=NULL, ended_at=NULL`)
      .run(repo, w.orderId, w.number, w.fab, w.carrier, w.tracking, BASE_INTERVAL_S, CHECKABLE.includes(w.carrier) ? now + BASE_INTERVAL_S : null, now)
  })
  return watches(db, repo).find((x) => x.orderId === w.orderId) as Watch
}

/** Stop watching (the order was marked delivered or cancelled by a person). */
export function endWatch(db: DatabaseSync, repo: string, orderId: string, now: number): boolean {
  return Number(db.prepare('UPDATE watch SET ended_at=?, next_at=NULL WHERE repo=? AND order_id=? AND ended_at IS NULL').run(now, repo.toLowerCase(), orderId).changes) > 0
}

/** The rows due a check at `now` (or the one asked for). */
export function due(db: DatabaseSync, now: number, only?: { repo: string; orderId?: string | undefined }): Watch[] {
  return watches(db).filter((w) => w.endedAt === null && CHECKABLE.includes(w.carrier)
    && (only ? w.repo === only.repo.toLowerCase() && (!only.orderId || w.orderId === only.orderId) : w.nextAt !== null && w.nextAt <= now))
}

export interface CarrierReading { state: CarrierState; status: string; eventAt: string | null; eta: string | null }

/** The next interval after a check: back to the base on a change, doubled (to the cap) while nothing moves. Pure. */
export function nextInterval(prior: Watch, got: CarrierReading | null): number {
  if (got && got.state !== prior.state) return BASE_INTERVAL_S
  return Math.min(MAX_INTERVAL_S, Math.max(BASE_INTERVAL_S, prior.intervalS * 2))
}

/** Record one check's outcome (a reading, or an error in words). Delivered and failure end the watch. */
export function recordCheck(db: DatabaseSync, w: Watch, got: CarrierReading | null, error: string | null, now: number): Watch {
  const interval = nextInterval(w, got)
  const ends = got && (got.state === 'delivered' || got.state === 'failure')
  db.prepare(`UPDATE watch SET state=COALESCE(?, state), status=COALESCE(?, status), event_at=COALESCE(?, event_at), eta=COALESCE(?, eta), checked_at=?, next_at=?, interval_s=?,
    checks=checks+1, error=?, ended_at=? WHERE repo=? AND order_id=?`)
    .run(got?.state ?? null, got?.status ?? null, got?.eventAt ?? null, got?.eta ?? null, now, ends ? null : now + interval, interval, error, ends ? now : null, w.repo, w.orderId)
  return watches(db, w.repo).find((x) => x.orderId === w.orderId) as Watch
}

// ------------------------------------------------------------------ the wait line a person reads

const ago = (t: number, now: number): string => {
  const m = Math.round((now - t) / 60)
  return m < 1 ? 'just now' : m < 60 ? `${m} minute${m === 1 ? '' : 's'} ago` : m < 2880 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`
}
const inside = (t: number, now: number): string => {
  const m = Math.max(1, Math.round((t - now) / 60))
  return m < 60 ? `in ${m} minute${m === 1 ? '' : 's'}` : `in about ${Math.round(m / 60)} hour${Math.round(m / 60) === 1 ? '' : 's'}`
}

/**
 * The wait for an order, as the Build tab draws it (WaitView): placed and not shipped (the person records it from the
 * fab's notice: no check exists), shipped with a carrier trace checks (when it checks next), or one it cannot check.
 */
export function orderWait(o: { fab: string; number: string; ship: string | null; state: string }, w: Watch | null, o2: { carrierKey: boolean; now: number }) {
  const id = `order-${o.number}`
  if (o.state === 'delivered' || o.state === 'cancelled') return null
  if (!w) {
    return {
      id, what: `${o.fab} to ship order ${o.number}`, source: 'manual' as const, nextCheckAt: null, lastCheckedAt: null, checkable: false,
      text: `Waiting for ${o.fab} to ship order ${o.number}${o.ship ? ` (quoted for ${o.ship})` : ''}. ${o.fab} offers order status only to partner companies, so trace cannot read it: when ${o.fab} emails the shipping notice, record the carrier and tracking number and trace follows the parcel.`,
    }
  }
  const carrier = CARRIER_NAMES[w.carrier]
  const seen = w.status ? ` ${carrier} last said: ${w.status}${w.eventAt ? ` (${w.eventAt.slice(0, 16).replace('T', ' ')})` : ''}.` : ''
  if (!CHECKABLE.includes(w.carrier) || !o2.carrierKey) {
    return {
      id, what: `${carrier} to deliver order ${o.number}`, source: 'manual' as const, nextCheckAt: null, lastCheckedAt: null, checkable: false,
      text: `Order ${o.number} is with ${carrier}, tracking ${w.tracking}.${seen} ${CHECKABLE.includes(w.carrier) ? `trace checks ${carrier} once an admin adds the DHL key (Admin › Integrations).` : `trace cannot check ${carrier} (only DHL is built), so mark the order delivered when it arrives.`}`,
    }
  }
  if (w.endedAt !== null) {
    return {
      id, what: `${carrier} to deliver order ${o.number}`, source: 'timer' as const, nextCheckAt: null, lastCheckedAt: w.checkedAt ? new Date(w.checkedAt * 1000).toISOString() : null, checkable: false,
      text: w.state === 'delivered' ? `${carrier} says order ${o.number} was delivered.${seen} Mark it delivered when the boards are in hand.` : `${carrier} reports a problem with order ${o.number}.${seen} Check with ${carrier} or ${o.fab}.`,
    }
  }
  return {
    id, what: `${carrier} to deliver order ${o.number}`, source: 'timer' as const, checkable: true,
    nextCheckAt: w.nextAt ? new Date(w.nextAt * 1000).toISOString() : null, lastCheckedAt: w.checkedAt ? new Date(w.checkedAt * 1000).toISOString() : null,
    text: `Waiting for ${carrier} to deliver order ${o.number} (tracking ${w.tracking}).${seen}${w.eta ? ` Expected ${w.eta.slice(0, 10)}.` : ''}${w.error ? ` The last check failed: ${w.error}.` : ''} ${w.checkedAt ? `Checked ${ago(w.checkedAt, o2.now)}; ` : ''}${w.nextAt ? `next check ${inside(w.nextAt, o2.now)}` : ''} (${carrier} sends no events, so trace asks on a timer that backs off while nothing changes).`,
  }
}

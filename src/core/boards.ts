/**
 * What happens to the boards once an order is placed, in the journey record (tables in src/core/build-tables.ts):
 * the order's shipping as the person records it, each board by its serial when it arrives, and the incoming
 * inspection's result per board and check. People enter these (order.update, board.record, board.check: src/api/
 * actions-build.ts); trace never places, pays for or marks an order on its own: a carrier check may say the parcel
 * is delivered, and the person records it.
 *
 *   updateOrder   shipped (with carrier and tracking number), delivered, or cancelled, or a corrected ship date;
 *                 logged in the decisions
 *   recordBoard   a board received (serial, order, notes, photos), or its status changed; logged
 *   checkBoard    one inspection check of one board: pass, fail (a fault, with its reference) or marked (a hand-placed
 *                 part left off on purpose); a failed check of a board that is not already failed marks it failed,
 *                 and a board whose checks all pass after its count and label is inspected
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { JourneyError, type OrderRow, type Signer, decide, loadJourney, loadOrders } from './journey.js'
import { transaction } from './store.js'

export const CARRIERS = ['dhl', 'fedex', 'ups', 'other'] as const
export type Carrier = (typeof CARRIERS)[number]
export const CARRIER_NAMES: Readonly<Record<Carrier, string>> = { dhl: 'DHL', fedex: 'FedEx', ups: 'UPS', other: 'the carrier' }
export const BOARD_STATUSES = ['received', 'inspected', 'failed', 'brought_up', 'scrapped'] as const
export type BoardStatus = (typeof BOARD_STATUSES)[number]
export const CHECK_KINDS = ['count', 'visual', 'fault', 'hand', 'label'] as const
export const CHECK_RESULTS = ['pass', 'fail', 'marked'] as const

export const Serial = z.string().trim().regex(/^[A-Za-z0-9._-]{1,40}$/, 'a serial such as SN-001 (letters, digits, dots, dashes)')
export const EvidencePath = z.string().trim().min(3).max(300).regex(/^(runs\/[A-Za-z0-9]+\/[^/]+|[^.][^:]*)$/, 'a run artifact (runs/<run>/<name>) or a file in the repository')

const now = (): number => Date.now() / 1000
const newId = (): string => randomUUID().replaceAll('-', '').slice(0, 16)
const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const list = (v: unknown): string[] => { try { const x: unknown = JSON.parse(String(v ?? '[]')); return Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : [] } catch { return [] } }

// ------------------------------------------------------------------ orders: shipping

export interface Tracking { orderId: string; carrier: Carrier; tracking: string; by: string; at: number }

export function loadTracking(db: DatabaseSync): Tracking[] {
  if (!has(db, 'order_tracking')) return []
  return (db.prepare('SELECT * FROM order_tracking').all() as Record<string, unknown>[]).map((r) => ({ orderId: String(r.order_id), carrier: r.carrier as Carrier, tracking: String(r.tracking), by: String(r.by), at: Number(r.at) }))
}

export interface OrderUpdate {
  /** the order's id or its fab order number */
  order: string
  state?: 'shipped' | 'delivered' | 'cancelled' | undefined
  carrier?: Carrier | undefined
  tracking?: string | undefined
  ship_date?: string | null | undefined
  note?: string | undefined
}

/** The order an id or fab number names. */
export function findOrder(db: DatabaseSync, ref: string): OrderRow | null {
  const r = ref.trim()
  return loadOrders(db).find((o) => o.id === r || o.number === r) ?? null
}

/** Record a change the person saw on the fab's or carrier's page. */
export function updateOrder(db: DatabaseSync, u: OrderUpdate, by: Signer): { order: OrderRow; tracking: Tracking | null; changed: boolean } {
  if (!loadJourney(db)) throw new JourneyError('This project has not started its journey yet.')
  const o = findOrder(db, u.order)
  if (!o) throw new JourneyError(`No order ${u.order} is recorded. Record it first (After you pay).`)
  if (o.state === 'cancelled' && u.state !== 'cancelled') throw new JourneyError(`Order ${o.number} is cancelled.`)
  if (u.tracking !== undefined && !u.carrier) throw new JourneyError('Say which carrier the tracking number is for.')
  if (u.state === 'shipped' && !u.tracking && !loadTracking(db).some((t) => t.orderId === o.id)) throw new JourneyError('Give the tracking number the fab sent with the shipping notice.')
  const order = ['placed', 'shipped', 'delivered'] as const
  if (u.state && u.state !== 'cancelled' && o.state !== 'cancelled' && order.indexOf(u.state) < order.indexOf(o.state as (typeof order)[number])) {
    throw new JourneyError(`Order ${o.number} is already ${o.state}.`)
  }
  const t = now()
  let changed = false
  transaction(db, () => {
    if (u.state && u.state !== o.state) {
      const col = u.state === 'shipped' ? 'shipped_at' : u.state === 'delivered' ? 'delivered_at' : null
      db.prepare(`UPDATE orders SET state=?, ${col ? `${col}=COALESCE(${col}, ?),` : ''} updated=? WHERE id=?`).run(...(col ? [u.state, t, t, o.id] : [u.state, t, o.id]))
      if (u.state === 'delivered' && o.shippedAt === null) db.prepare('UPDATE orders SET shipped_at=? WHERE id=?').run(t, o.id)
      changed = true
    }
    if (u.ship_date !== undefined && u.ship_date !== o.shipDate) {
      if (u.ship_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(u.ship_date)) throw new JourneyError('Give the ship date as a date (2026-11-04).')
      db.prepare('UPDATE orders SET ship_date=?, updated=? WHERE id=?').run(u.ship_date, t, o.id)
      changed = true
    }
    if (u.note) { db.prepare('UPDATE orders SET note=?, updated=? WHERE id=?').run(u.note, t, o.id); changed = true }
    if (u.carrier && u.tracking) {
      db.prepare('INSERT INTO order_tracking (order_id, carrier, tracking, by, at, updated) VALUES (?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET carrier=excluded.carrier, tracking=excluded.tracking, by=excluded.by, at=excluded.at, updated=excluded.updated')
        .run(o.id, u.carrier, u.tracking.trim(), by.label, t, t)
      changed = true
    }
    if (changed) {
      const parts = [
        u.state ? `marked ${u.state}` : '',
        u.carrier && u.tracking ? `${CARRIER_NAMES[u.carrier]} tracking ${u.tracking.trim()}` : '',
        u.ship_date !== undefined && u.ship_date !== o.shipDate ? `ship date ${u.ship_date ?? 'cleared'}` : '',
      ].filter(Boolean)
      decide(db, { kind: `order.${u.state ?? 'updated'}`, stage: 'fabricate', ref: o.id, by: by.label, summary: `Order ${o.number} with ${o.fab}: ${parts.join(', ') || 'note added'}.`, detail: { ...u } })
    }
  })
  return { order: findOrder(db, o.id) as OrderRow, tracking: loadTracking(db).find((x) => x.orderId === o.id) ?? null, changed }
}

// ------------------------------------------------------------------ boards by serial

export interface BoardCheck { id: string; serial: string; check: string; kind: (typeof CHECK_KINDS)[number]; result: (typeof CHECK_RESULTS)[number]; ref: string | null; note: string | null; photo: string | null; by: string; at: number }
export interface BoardRow { serial: string; orderId: string | null; revision: string; receivedAt: number | null; status: BoardStatus; notes: string | null; photos: string[]; by: string; created: number; updated: number; checks: BoardCheck[] }

export function loadBoards(db: DatabaseSync): BoardRow[] {
  if (!has(db, 'boards')) return []
  const checks = has(db, 'board_checks') ? (db.prepare('SELECT * FROM board_checks ORDER BY at, rowid').all() as Record<string, unknown>[]).map((r): BoardCheck => ({
    id: String(r.id), serial: String(r.serial), check: String(r.check_id), kind: r.kind as BoardCheck['kind'], result: r.result as BoardCheck['result'], ref: str(r.ref), note: str(r.note), photo: str(r.photo), by: String(r.by), at: Number(r.at),
  })) : []
  return (db.prepare('SELECT * FROM boards ORDER BY serial').all() as Record<string, unknown>[]).map((r) => ({
    serial: String(r.serial), orderId: str(r.order_id), revision: String(r.revision), receivedAt: r.received_at === null ? null : Number(r.received_at), status: r.status as BoardStatus,
    notes: str(r.notes), photos: list(r.photos), by: String(r.by), created: Number(r.created), updated: Number(r.updated), checks: checks.filter((c) => c.serial === String(r.serial)),
  }))
}

export interface BoardInput { serial: string; order?: string | undefined; status?: BoardStatus | undefined; notes?: string | undefined; photos?: readonly string[] | undefined; received?: boolean | undefined }

/** A board received, or a change to one. The order defaults to the newest delivered (else shipped, else placed) order. */
export function recordBoard(db: DatabaseSync, b: BoardInput, by: Signer): { board: BoardRow; created: boolean } {
  const r = loadJourney(db)
  if (!r) throw new JourneyError('This project has not started its journey yet.')
  const serial = Serial.parse(b.serial)
  const existing = loadBoards(db).find((x) => x.serial === serial)
  const orders = loadOrders(db).filter((o) => o.state !== 'cancelled')
  const order = b.order ? findOrder(db, b.order) : existing?.orderId ? null : orders.find((o) => o.state === 'delivered') ?? orders.find((o) => o.state === 'shipped') ?? orders[0] ?? null
  if (b.order && !order) throw new JourneyError(`No order ${b.order} is recorded.`)
  const t = now()
  transaction(db, () => {
    if (existing) {
      db.prepare('UPDATE boards SET order_id=COALESCE(?, order_id), status=?, notes=COALESCE(?, notes), photos=?, updated=? WHERE serial=?')
        .run(order?.id ?? null, b.status ?? existing.status, b.notes ?? null, JSON.stringify([...new Set([...existing.photos, ...(b.photos ?? [])])]), t, serial)
    } else {
      db.prepare('INSERT INTO boards (serial, order_id, revision, received_at, status, notes, photos, by, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(serial, order?.id ?? null, order?.revision ?? r.journey.revision, b.received === false ? null : t, b.status ?? 'received', b.notes ?? null, JSON.stringify(b.photos ?? []), by.label, t, t)
    }
    decide(db, {
      kind: existing ? 'board.updated' : 'board.received', stage: r.journey.currentStage, ref: serial, by: by.label,
      summary: existing ? `Board ${serial}: ${b.status && b.status !== existing.status ? `now ${b.status.replace('_', ' ')}` : 'updated'}.` : `Board ${serial} received${order ? ` from order ${order.number}` : ''}.`,
      detail: { serial, ...(order ? { order: order.id } : {}), ...(b.status ? { status: b.status } : {}) },
    })
  })
  return { board: loadBoards(db).find((x) => x.serial === serial) as BoardRow, created: !existing }
}

export interface CheckInput { serial: string; check: string; kind: BoardCheck['kind']; result: BoardCheck['result']; ref?: string | undefined; note?: string | undefined; photo?: string | undefined }

/** One inspection check of one board (the board must be recorded). The same check again replaces the earlier result. */
export function checkBoard(db: DatabaseSync, c: CheckInput, by: Signer): { check: BoardCheck; board: BoardRow } {
  const serial = Serial.parse(c.serial)
  const board = loadBoards(db).find((x) => x.serial === serial)
  if (!board) throw new JourneyError(`Board ${serial} is not recorded. Record it as received first.`)
  if (c.kind === 'fault' && c.result === 'fail' && !c.ref?.trim()) throw new JourneyError('Say which part the fault is at (its reference, such as U3).')
  if (c.result === 'marked' && c.kind !== 'hand') throw new JourneyError('Only a hand-placed part can be marked as left off.')
  const t = now()
  const prior = board.checks.find((x) => x.check === c.check)
  const id = prior?.id ?? newId()
  transaction(db, () => {
    db.prepare(`INSERT INTO board_checks (id, serial, check_id, kind, result, ref, note, photo, by, at, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET result=excluded.result, ref=excluded.ref, note=excluded.note, photo=excluded.photo, by=excluded.by, at=excluded.at, updated=excluded.updated`)
      .run(id, serial, c.check, c.kind, c.result, c.ref?.trim() || null, c.note ?? null, c.photo ?? null, by.label, t, t)
    if (c.photo) db.prepare('UPDATE boards SET photos=?, updated=? WHERE serial=?').run(JSON.stringify([...new Set([...board.photos, c.photo])]), t, serial)
    const after = loadBoards(db).find((x) => x.serial === serial) as BoardRow
    const failed = after.checks.some((x) => x.result === 'fail')
    const kinds = new Set(after.checks.map((x) => x.kind))
    const next: BoardStatus = failed ? 'failed' : after.status === 'received' && kinds.has('count') && kinds.has('label') ? 'inspected' : after.status === 'failed' ? 'inspected' : after.status
    if (next !== after.status && ['received', 'inspected', 'failed'].includes(after.status)) db.prepare('UPDATE boards SET status=?, updated=? WHERE serial=?').run(next, t, serial)
    if (c.result === 'fail') decide(db, { kind: 'board.fault', stage: loadJourney(db)?.journey.currentStage ?? null, ref: serial, by: by.label, summary: `Board ${serial}: ${c.check}${c.ref ? ` at ${c.ref}` : ''} failed inspection.`, detail: { check: c.check, ref: c.ref ?? null } })
  })
  const out = loadBoards(db).find((x) => x.serial === serial) as BoardRow
  return { check: out.checks.find((x) => x.id === id) as BoardCheck, board: out }
}

// ------------------------------------------------------------------ the incoming inspection's checks (pure)

/**
 * The three Incoming inspection checks from the boards: count (boards received match the order, each has a serial
 * and at least one photo), faults (every failed check names its reference), hand (every hand-placed part fitted or
 * marked, on every board). Null detail: met.
 */
export function inspectionProblems(boards: readonly BoardRow[], orders: readonly OrderRow[], revision: string, handParts: readonly string[] = []): { count: string | null; faults: string | null; hand: string | null } {
  const mine = boards.filter((b) => b.revision === revision)
  const order = orders.find((o) => o.revision === revision && o.state !== 'cancelled')
  let count: string | null = null
  if (!mine.length) count = 'No boards of this revision are recorded yet.'
  else if (order && mine.filter((b) => b.orderId === order.id || b.orderId === null).length < order.boards) count = `${mine.length} of the ${order.boards} boards ordered are recorded.`
  else {
    const unphotographed = mine.filter((b) => !b.photos.length)
    if (unphotographed.length) count = `${unphotographed.map((b) => b.serial).join(', ')} without a photo.`
  }
  const vague = mine.flatMap((b) => b.checks.filter((c) => c.result === 'fail' && !c.ref).map((c) => `${b.serial} ${c.check}`))
  const faults = !mine.length ? 'No boards are recorded yet.' : vague.length ? `Faults without a reference: ${vague.join(', ')}.` : null
  let hand: string | null = null
  if (!mine.length) hand = 'No boards are recorded yet.'
  else {
    const missing: string[] = []
    for (const b of mine) {
      const done = new Set(b.checks.filter((c) => c.kind === 'hand').map((c) => (c.ref ?? c.check).toUpperCase()))
      for (const p of handParts) if (!done.has(p.toUpperCase())) missing.push(`${b.serial} ${p}`)
    }
    if (missing.length) hand = `Not fitted or marked: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ` and ${missing.length - 6} more` : ''}.`
  }
  return { count, faults, hand }
}

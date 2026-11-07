/**
 * The Build tab's record (docs/ui-design.md "Build"): releases, orders and their shipping, boards by serial with their
 * incoming inspection, the bench and its readings.
 *
 *   build.get        read    releases (journey.snapshot and the signature that cut a release, from the decisions),
 *                            orders (order.record) with their shipping (order.update) and the Wait line for each
 *                            (src/core/shipping.ts orderWait: what trace can and cannot check, and when it checks next),
 *                            the order being prepared once the order gate's stage is reached (orderSheet: its board
 *                            options, today's parts check, its render, and whether it is ready to place, from the
 *                            record); boards by serial with
 *                            each inspection check (src/core/boards.ts); the bench: each hil.instruments entry with
 *                            whether it answered its identity query (hil.idn) and the bring-up readings per board and
 *                            step against their limits (src/core/bench.ts: the run record's, and the bench's live copy)
 *   order.record     write   { order, number, paid, ship }: store a placed order in the journey record, logged
 *   order.update     write   { order, state?, carrier?, tracking?, ship?, note? }: what the person saw on the fab's or
 *                            carrier's page: shipped with a tracking number (and the order is watched with its carrier
 *                            when trace can check that carrier), delivered, cancelled, a corrected ship date. trace
 *                            never marks an order itself
 *   order.check_now  read    { order }: ask the order watch to check the carrier now (when it can); changes nothing
 *   board.record     write   { serial, order?, status?, notes?, photos? }: a board received, or its status changed
 *   board.check      write   { serial, check, kind, result, ref?, note?, photo? }: one incoming inspection check
 *
 * The incoming inspection's skill writes through board.record and board.check; its quality bar is computed from the
 * boards (src/api/skill-checks.ts), as are Bench setup's identity check and Bring-up run's limits.
 */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { type BringupStep, type InstrumentId, type Reading, BRINGUP_STEPS, BenchStore, idsFromRuns, loadIds, loadReadings, stepStates, unionIds, unionReadings } from '../core/bench.js'
import { type BoardRow, BOARD_STATUSES, CARRIERS, CHECK_KINDS, CHECK_RESULTS, EvidencePath, Serial, checkBoard, findOrder, loadBoards, loadTracking, recordBoard, updateOrder } from '../core/boards.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { type JourneyRecord, type OrderRow, type Signer, type StageId, loadJourney, loadOrders, recordOrder } from '../core/journey.js'
import { CHECKABLE, SHIPPING_PREFIX, type Watch, WatchStore, endWatch, orderWait, watchOrder, watches } from '../core/shipping.js'
import { ActionError, type Context, Repo, def, hashOf, hashesOf, label, plainly, storeAt, withJourneyDb, withRecordDb, writeJourney } from './action-kit.js'
import { hasTable, latestRun, runResult } from './record-read.js'
import { readRenders } from './actions-renders.js'
import { orderOptionsOf } from '../tools/kicad/order-options.js'
import { orderEstimateFrom } from '../core/order-estimate.js'

const signer = (ctx: Context): Signer => ({ hash: hashOf(ctx.principal), also: hashesOf(ctx.principal), label: label(ctx.principal) })
const iso = (t: number | null): string | null => (t === null ? null : new Date(t * 1000).toISOString())
const stageOrd = (r: JourneyRecord, id: StageId | string): number => r.stages.find((s) => s.id === id)?.ord ?? -1

// ------------------------------------------------------------------ the stores beside the record

const watchStore = (ctx: Context): WatchStore => new WatchStore(storeAt(ctx, SHIPPING_PREFIX), { scratch: ctx.deps.scratch })
const benchStore = (ctx: Context, repo: string): BenchStore => new BenchStore(storeAt(ctx, PROJECTS_PREFIX), repo, { scratch: ctx.deps.scratch })

/** The order watches of a project (none when the watch cannot be read: the Wait lines then say no check exists). */
async function projectWatches(ctx: Context, repo: string): Promise<Watch[]> {
  try { return (await watchStore(ctx).read((db) => watches(db, repo))).result } catch { return [] }
}

/** Whether the carrier's key is set (an admin's integration). Unknown (cannot be listed): taken as set. */
async function carrierKey(ctx: Context): Promise<boolean> {
  if (!ctx.deps.integrations) return false
  try { return (await (await ctx.deps.integrations()).list()).some((i) => i.name === 'dhl' && i.configured) } catch { return true }
}

/** The bench's live copy (readings and identities as they were taken), or none. */
async function liveBench(ctx: Context, repo: string): Promise<{ readings: Reading[]; ids: InstrumentId[] }> {
  try { return (await benchStore(ctx, repo).read((db) => ({ readings: loadReadings(db), ids: loadIds(db) }))).result } catch { return { readings: [], ids: [] } }
}

// ------------------------------------------------------------------ views

export interface BenchInput {
  instruments: { name: string; kind: string; address: string; limits?: { max_voltage_v?: number; max_current_a?: number } }[]
  ids: InstrumentId[]
  readings: Reading[]
}

/** The bench as the Build tab and the bench skills draw it. Pure. */
export function benchView(b: BenchInput) {
  const idOf = new Map(b.ids.map((i) => [i.instrument, i]))
  const boards = [...new Set(b.readings.map((r) => r.board))]
  return {
    configured: b.instruments.length > 0,
    instruments: b.instruments.map((i) => {
      const id = idOf.get(i.name)
      return {
        name: i.name, kind: i.kind, address: i.address, answered: Boolean(id?.ok),
        ...(id ? { identity: { manufacturer: id.manufacturer, model: id.model, serial: id.serial, firmware: id.firmware, at: iso(id.at), run: id.runId } } : {}),
      }
    }),
    ...(b.instruments.length ? {} : { note: 'No instruments are set up (hil.instruments): Bench setup connects them.' }),
    readings: b.readings.map(readingView),
    boards: boards.map((serial) => ({ serial, steps: stepStates(b.readings.filter((r) => r.board === serial)).map((s) => ({ step: s.step, readings: s.readings, passed: s.passed, failing: s.failing })) })),
  }
}

export const readingView = (r: Reading) => ({
  id: r.id, board: r.board, step: r.step, instrument: r.instrument, quantity: r.quantity, value: r.value, unit: r.unit,
  ...(r.min !== null ? { min: r.min } : {}), ...(r.max !== null ? { max: r.max } : {}), pass: r.pass, at: iso(r.at) as string, by: r.by, run: r.runId,
})

const BOARD_STATE: Record<BoardRow['status'], 'received' | 'inspected' | 'brought_up' | 'failed'> = { received: 'received', inspected: 'inspected', failed: 'failed', brought_up: 'brought_up', scrapped: 'failed' }

export function boardView(b: BoardRow, orders: readonly OrderRow[], readings: readonly Reading[]) {
  const o = orders.find((x) => x.id === b.orderId)
  const mine = readings.filter((r) => r.board === b.serial)
  return {
    serial: b.serial, order: o?.number ?? '', revision: b.revision, state: BOARD_STATE[b.status], status: b.status, received: iso(b.receivedAt),
    ...(b.notes ? { note: b.notes } : {}), photos: b.photos,
    checks: b.checks.map((c) => ({ id: c.id, check: c.check, kind: c.kind, result: c.result, ...(c.ref ? { ref: c.ref } : {}), ...(c.note ? { note: c.note } : {}), ...(c.photo ? { photo: c.photo } : {}), by: c.by, at: iso(c.at) as string })),
    readings: mine.length, failing: mine.filter((r) => !r.pass).length,
  }
}

/** The settings' instruments from the record database (none when unreadable). */
export function instrumentsOf(db: DatabaseSync): BenchInput['instruments'] {
  try {
    const v = hasTable(db, 'settings') ? db.prepare("SELECT value FROM settings WHERE key='hil.instruments'").get() as { value?: string } | undefined : undefined
    const parsed: unknown = v?.value ? JSON.parse(v.value) : []
    return Array.isArray(parsed) ? parsed as BenchInput['instruments'] : []
  } catch { return [] }
}

/** The order's view, with its shipping and its Wait line. */
function orderView(o: OrderRow, tracking: ReturnType<typeof loadTracking>, w: Watch | null, key: boolean, now: number) {
  const t = tracking.find((x) => x.orderId === o.id) ?? null
  return {
    id: o.id, release: o.revision, state: o.state === 'cancelled' ? 'placed' as const : o.state, cancelled: o.state === 'cancelled', boards: o.boards,
    total: o.paid ?? 0, currency: o.currency, number: o.number, paid: o.paid, ship: o.shipDate, placedAt: iso(o.placedAt), placedBy: o.placedBy,
    shippedAt: iso(o.shippedAt), deliveredAt: iso(o.deliveredAt),
    ...(t ? { tracking: { carrier: t.carrier, number: t.tracking, checkable: CHECKABLE.includes(t.carrier) && key, ...(w?.status ? { status: w.status, state: w.state, eventAt: w.eventAt, eta: w.eta } : {}) } } : {}),
    cost: o.paid !== null ? [{ label: `Paid to ${o.fab}`, amount: o.paid }] : [], options: [] as SheetOption[], parts: [] as SheetPart[], files: [] as string[],
    wait: orderWait({ fab: o.fab, number: o.number, ship: o.shipDate, state: o.state }, w, { carrierKey: key, now }),
  }
}

/** One line of the panel and mounting hardware list, as the order sheet shows it. */
export interface HardwareView { qty: number; item: string; kind: 'panel' | 'mounting'; size: string | null; length_mm: number | null; for: string[]; mpn: string | null; lcsc: string | null; source: string; note: string | null }

/**
 * The hardware list a run made (kicad.fab's, else the newest kicad.bom run that made one): its lines, notes and whether
 * its case is stale, or null when no run made one.
 */
export function hardwareOf(fabResult: Record<string, unknown> | null, db: Parameters<typeof latestRun>[0]): { lines: HardwareView[]; notes: string[]; case_stale: boolean; run: string | null } | null {
  const pick = (res: Record<string, unknown> | null): Record<string, unknown> | null => {
    const h = res?.hardware
    return h && typeof h === 'object' && Array.isArray((h as { lines?: unknown }).lines) ? h as Record<string, unknown> : null
  }
  let h = pick(fabResult)
  let run: string | null = h ? (latestRun(db, 'kicad.fab')?.id ?? null) : null
  if (!h) {
    const bom = latestRun(db, 'kicad.bom')
    h = bom ? pick(runResult(db, bom.id)) : null
    run = h ? (bom?.id ?? null) : null
  }
  if (!h) return null
  const lines = (h.lines as Record<string, unknown>[]).map((l) => ({
    qty: Number(l.qty ?? 0), item: String(l.item ?? ''), kind: l.kind === 'panel' ? 'panel' as const : 'mounting' as const,
    size: typeof l.size === 'string' ? l.size : null, length_mm: typeof l.length_mm === 'number' ? l.length_mm : null,
    for: Array.isArray(l.for) ? (l.for as unknown[]).map(String) : [], mpn: typeof l.mpn === 'string' ? l.mpn : null,
    lcsc: typeof l.lcsc === 'string' ? l.lcsc : null, source: String(l.source ?? ''), note: typeof l.note === 'string' ? l.note : null,
  }))
  return { lines, notes: Array.isArray(h.notes) ? (h.notes as unknown[]).map(String) : [], case_stale: h.case_stale === true, run }
}

// ------------------------------------------------------------------ the order being prepared

export interface SheetOption { option: string; value: string; source?: string; decided?: boolean }
export interface SheetPart { ref: string; name: string; lcsc: string; stock: number; need: number; status: string; then: number; now: number }
export interface SheetRender { run: string; name: string; label: string; revision: string }

/** One parts check: its run, when it ran, how many boards it checked, and its lines. */
interface PartsCheck { run: string; started: number; boards: number | null; total: number; lines: { ref: string; mpn: string; code: string; stock: number; need: number; status: string; price: number; lineTotal: number }[] }

/** Every parts check that did not error, newest first, with its lines (parts.bom_check's parts_list_lines). */
export function partsChecks(db: DatabaseSync): PartsCheck[] {
  if (!hasTable(db, 'runs') || !hasTable(db, 'parts_list_lines')) return []
  const runs = db.prepare("SELECT id, started FROM runs WHERE kind='parts.bom_check' AND status != 'error' ORDER BY started DESC, id DESC").all() as { id: string; started: number }[]
  const boards = hasTable(db, 'measurements') ? db.prepare("SELECT value FROM measurements WHERE run_id=? AND name='boards'") : null
  const lines = db.prepare('SELECT * FROM parts_list_lines WHERE run_id=? ORDER BY line')
  return runs.map((r) => {
    const b = boards?.get(r.id) as { value?: number } | undefined
    const ls = (lines.all(r.id) as Record<string, unknown>[]).map((l) => ({
      ref: String(l.refs ?? ''), mpn: String(l.mpn ?? l.part_key ?? ''), code: String(l.order_code ?? ''), stock: Number(l.stock ?? 0), need: Number(l.need ?? 0),
      status: String(l.status ?? ''), price: Number(l.unit_price ?? 0), lineTotal: Number(l.line_total ?? 0),
    }))
    return { run: r.id, started: Number(r.started), boards: typeof b?.value === 'number' ? b.value : null, total: Math.round(ls.reduce((n, l) => n + l.lineTotal, 0) * 100) / 100, lines: ls }
  })
}

const DAY_S = 86400
const day = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10)

/**
 * The order being prepared, from the record (test-esp32 run 2, #217, #226): its board options from the release
 * package's run (kicad.fab's order_options), its parts from the newest parts check at the build quantity (prices then
 * from the newest check before Fabricate, sign-off's), its picture from the newest renders of the revision, and
 * whether it is ready to place: the package built at Fabricate without problems, and every line in stock at a check
 * made today. What is missing is said, one line each. The cost is the order estimate (parts check, board and case at
 * the fab's published prices) and the build plan's target until a quote is recorded, and says so (#227). Pure over the record database.
 */
export function orderSheet(db: DatabaseSync, o: { quantity: number; unitCost: number | null; currency: string; revision: string; fabricateStarted: number | null; now: number }) {
  const missing: string[] = []
  // the release package: the newest kicad.fab run, built once the project reached Fabricate
  const fab = latestRun(db, 'kicad.fab')
  const res = fab ? runResult(db, fab.id) : null
  const current = fab !== null && (o.fabricateStarted === null || fab.started >= o.fabricateStarted)
  const files = current && Array.isArray(res?.files) ? (res.files as unknown[]).map((f) => (typeof f === 'string' ? f : (f as { path?: string }).path ?? '')).filter(Boolean).map((p) => p.split('/').pop() ?? p) : []
  if (!fab) missing.push('The release package is not built yet: kicad.fab builds the Gerbers, BOM and placement file.')
  else if (!current) missing.push(`The newest release package (run ${fab.id}) was built before Fabricate began: build it again from the released design.`)
  else if (fab.status !== 'pass') missing.push(`The release package run ${fab.id} did not pass${fab.summary ? `: ${fab.summary}` : ''}.`)
  else if (!files.length) missing.push(`The release package run ${fab.id} lists no files.`)
  const recorded = current ? orderOptionsOf(res) : null
  const options: SheetOption[] = recorded
    ? [
      ...recorded.filter((x) => x.group === 'pcb').map(({ option, value, source, decided }) => ({ option, value, source, decided })),
      { option: 'PCB quantity', value: String(o.quantity), source: 'the build plan', decided: true },
      ...recorded.filter((x) => x.group === 'pcba').map(({ option, value, source, decided }) => ({ option, value, source, decided })),
      ...(recorded.some((x) => x.group === 'pcba') ? [{ option: 'Assembly quantity', value: String(o.quantity), source: 'the build plan', decided: true }] : []),
    ]
    : []
  const optionsNote = !current || !fab ? null : recorded ? null : `The release package run ${fab.id} recorded no board options (it was made before kicad.fab recorded them): build the package again to have them here.`

  // the parts: the newest check at the build quantity, against sign-off's prices
  const checks = partsChecks(db)
  const atQty = checks.filter((c) => c.boards === o.quantity)
  const check = atQty[0] ?? null
  const before = o.fabricateStarted === null ? [] : atQty.filter((c) => c.started < o.fabricateStarted!)
  const thenOf = new Map((before[0]?.lines ?? []).map((l) => [l.code || l.mpn, l.price]))
  const parts: SheetPart[] = (check?.lines ?? []).map((l) => ({ ref: l.ref, name: l.mpn, lcsc: l.code, stock: l.stock, need: l.need, status: l.status, then: thenOf.get(l.code || l.mpn) ?? l.price, now: l.price }))
  if (!check) {
    const other = checks[0]
    missing.push(other ? `The parts were checked for ${other.boards ?? 'an unknown number of'} boards, not ${o.quantity}: check them again at the build quantity.` : `There is no parts check yet: parts.bom_check checks stock and price at ${o.quantity} boards.`)
  } else {
    const short = parts.filter((p) => p.status !== 'ok' || p.stock < p.need)
    if (!parts.length) missing.push(`The parts check ${check.run} has no lines.`)
    if (short.length) missing.push(`${short.length} of ${parts.length} lines are short or not found at ${o.quantity} boards: ${short.slice(0, 6).map((p) => p.ref || p.name).join(', ')}.`)
    if (o.now - check.started > DAY_S) missing.push(`The parts were last checked on ${day(check.started)}: stock and prices are checked again on the day of the order.`)
  }

  // the board's picture: the newest accepted renders of this revision (else the newest of any)
  const revs = readRenders(db)
  const rr = revs.find((x) => x.revision === o.revision || `Rev ${x.revision}` === o.revision) ?? revs[0] ?? null
  const pic = rr ? (['board-top', 'board', 'board-in-case', 'exploded', 'case'] as const).map((shot) => rr.pictures.find((p) => p.shot === shot)).find(Boolean) ?? null : null
  const render: SheetRender | null = rr && pic ? { run: rr.run, name: pic.name, label: pic.label, revision: rr.revision } : null

  const target = o.unitCost !== null ? Math.round(o.unitCost * o.quantity * 100) / 100 : null
  // the order estimate the gates show (the parts check, board and case at the fab's published prices): the closest to
  // a price until a quote is recorded, so the sheet is not left with the target alone (#227)
  let est: ReturnType<typeof orderEstimateFrom> = null
  try { est = orderEstimateFrom(db, { quantity: o.quantity }) } catch { est = null }
  return {
    ready: missing.length === 0, missing, files, options, optionsNote, parts, render,
    ...(check ? { checkedAt: iso(check.started) as string, checkRun: check.run, partsTotal: check.total } : {}),
    basis: 'target' as const, target,
    estimate: est ? { low: est.low, high: est.high, currency: est.currency, at: iso(est.at) as string, partsRun: est.partsRun, notIn: est.notIn } : null,
  }
}

// ------------------------------------------------------------------ the actions

const OrderRef = z.string().trim().min(1).max(80)

export const BUILD_ACTIONS = {
  'build.get': def('read', Repo, async ({ repo }, ctx) => {
    const [ws, key, live] = await Promise.all([projectWatches(ctx, repo), carrierKey(ctx), liveBench(ctx, repo)])
    return withRecordDb(ctx, repo, (db) => {
      const r = loadJourney(db)
      const notes: string[] = []
      if (!r) return { repo, releases: [], orders: [], boards: [], notes: ['This project has not started its journey yet.'] }
      const now = Date.now() / 1000
      const releases = r.decisions.filter((d) => d.kind === 'journey.snapshot').map((d) => {
        const det = (d.detail ?? {}) as { branch?: string; commit?: string; revision?: string }
        return { id: d.id, revision: det.revision ?? r.journey.revision, at: iso(d.at) as string, commit: det.commit ?? d.ref ?? '', branch: det.branch ?? null, by: d.by ?? 'trace', frozen: true, files: null as number | null }
      })
      const b = r.journey.build
      const all = loadOrders(db)
      const tracking = loadTracking(db)
      const orders: ReturnType<typeof orderView>[] = all.map((o) => orderView(o, tracking, ws.find((w) => w.orderId === o.id) ?? null, key, now))
      const atFab = r.stages.some((s) => s.id === 'fabricate') && stageOrd(r, r.journey.currentStage) >= stageOrd(r, 'fabricate')
      if (atFab && !orders.some((o) => o.release === r.journey.revision && !o.cancelled)) {
        const fab = latestRun(db, 'kicad.fab')
        const res = fab ? runResult(db, fab.id) : null
        const sheet = orderSheet(db, { quantity: b.quantity, unitCost: b.unit_cost, currency: b.currency, revision: r.journey.revision, fabricateStarted: r.stages.find((s) => s.id === 'fabricate')?.started ?? null, now })
        // the panel and mounting hardware list, kept apart from the parts: only when the build plan asks for it
        const hardware = b.hardware ? hardwareOf(res, db) : null
        const { target, partsTotal, ...rest } = sheet
        orders.unshift({
          id: 'next', release: r.journey.revision, state: 'ready' as never, cancelled: false, boards: b.quantity, total: target ?? 0, currency: b.currency, number: '', paid: null, ship: null,
          placedAt: null, placedBy: '', shippedAt: null, deliveredAt: null,
          // no quote is recorded: the build plan's target, said as such, and the parts at the checked prices
          cost: [
            ...(target !== null ? [{ label: `Target: ${b.quantity} boards at ${b.unit_cost} ${b.currency} each (the build plan's, not a quote)`, amount: target, kind: 'target' as const }] : []),
            ...(partsTotal !== undefined ? [{ label: `Parts for ${b.quantity} boards at the checked prices (boards, assembly and shipping not included)`, amount: partsTotal, kind: 'parts' as const }] : []),
          ],
          wait: null, ...rest, target,
          ...(b.hardware ? { hardware } : {}),
        } as never)
        if (b.hardware && !hardware) notes.push('The build plan includes panel and mounting hardware, but no hardware list is made yet: kicad.fab or kicad.bom with hardware makes it.')
        if (b.unit_cost === null) notes.push('No target unit cost is set in the build plan, and no quote is recorded, so the order\'s cost is not known yet.')
      }
      const readings = unionReadings(loadReadings(db), live.readings)
      const ids = unionIds(idsFromRuns(db), live.ids)
      const boards = loadBoards(db)
      if (!boards.length && all.some((o) => o.state === 'delivered')) notes.push('The boards have arrived: record each by its serial in Incoming inspection.')
      return {
        repo, releases, orders, boards: boards.map((x) => boardView(x, all, readings)),
        bench: benchView({ instruments: instrumentsOf(db), ids, readings }),
        notes,
      }
    })
  }),

  'order.record': def('write', Repo.extend({
    order: z.string().min(1).max(80).default('next'),
    number: z.string().trim().min(3).max(80),
    paid: z.number().min(0).max(10_000_000).nullable().default(null),
    ship: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date such as 2026-11-04').nullable().default(null),
    boards: z.number().int().min(1).max(1_000_000).optional(),
    note: z.string().trim().max(1000).optional(),
  }), async (a, ctx) => {
    const out = await plainly(() => writeJourney(ctx, a.repo, (db) => ({ result: recordOrder(db, { number: a.number, paid: a.paid, ship_date: a.ship, boards: a.boards, note: a.note ?? null }, signer(ctx)) })))
    return {
      ok: true, repo: a.repo, created: out.created, version: out.version,
      order: { id: out.order.id, number: out.order.number, boards: out.order.boards, paid: out.order.paid, currency: out.order.currency, ship: out.order.shipDate, state: out.order.state },
      wait: orderWait({ fab: out.order.fab, number: out.order.number, ship: out.order.shipDate, state: out.order.state }, null, { carrierKey: false, now: Date.now() / 1000 }),
    }
  }),

  'order.update': def('write', Repo.extend({
    order: OrderRef,
    state: z.enum(['shipped', 'delivered', 'cancelled']).optional(),
    carrier: z.enum(CARRIERS).optional(),
    tracking: z.string().trim().regex(/^[A-Za-z0-9 -]{6,40}$/, 'the tracking number as the carrier gives it').optional(),
    ship: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date such as 2026-11-04').nullable().optional(),
    note: z.string().trim().min(1).max(1000).optional(),
  }).refine((a) => a.state || a.tracking || a.ship !== undefined || a.note, 'say what changed: state, tracking, ship or note'), async (a, ctx) => {
    const out = await plainly(() => writeJourney(ctx, a.repo, (db) => {
      const r = updateOrder(db, { order: a.order, state: a.state, carrier: a.carrier, tracking: a.tracking?.replace(/\s+/g, ''), ship_date: a.ship, note: a.note }, signer(ctx))
      return { result: r, changed: r.changed }
    }))
    // follow the parcel with its carrier (when trace can), or stop following it once delivered or cancelled
    const now = Date.now() / 1000
    let watch: Watch | null = null
    let watchNote: string | null = null
    try {
      watch = (await watchStore(ctx).update((db) => {
        if (out.order.state === 'delivered' || out.order.state === 'cancelled') { endWatch(db, a.repo, out.order.id, now); return { result: null } }
        if (!out.tracking) return { result: null, changed: false }
        return { result: watchOrder(db, { repo: a.repo, orderId: out.order.id, number: out.order.number, fab: out.order.fab, carrier: out.tracking.carrier, tracking: out.tracking.tracking }, now) }
      })).result
    } catch (e) {
      watchNote = `The tracking number is recorded, but trace could not start following it (${e instanceof Error ? e.message : String(e)}).`
    }
    const key = await carrierKey(ctx)
    return {
      ok: true, repo: a.repo, version: out.version, changed: out.changed,
      order: { id: out.order.id, number: out.order.number, state: out.order.state, ship: out.order.shipDate, shippedAt: iso(out.order.shippedAt), deliveredAt: iso(out.order.deliveredAt) },
      ...(out.tracking ? { tracking: { carrier: out.tracking.carrier, number: out.tracking.tracking } } : {}),
      wait: orderWait({ fab: out.order.fab, number: out.order.number, ship: out.order.shipDate, state: out.order.state }, watch, { carrierKey: key, now }),
      ...(watchNote ? { note: watchNote } : {}),
    }
  }),

  'order.check_now': def('read', Repo.extend({ order: OrderRef }), async (a, ctx) => {
    const order = await withJourneyDb(ctx, a.repo, (db) => findOrder(db, a.order))
    if (!order) throw new ActionError(`No order ${a.order} is recorded.`)
    const w = (await projectWatches(ctx, a.repo)).find((x) => x.orderId === order.id)
    if (!w || w.endedAt !== null || !CHECKABLE.includes(w.carrier)) return { ok: false, reason: 'trace does not follow this order with a carrier, so there is nothing to check.' }
    if (!ctx.deps.orderWatch) return { ok: false, reason: 'This installation has no order watch to ask.' }
    await ctx.deps.orderWatch(a.repo, order.id)
    return { ok: true }
  }),

  'board.record': def('write', Repo.extend({
    serial: Serial,
    order: OrderRef.optional(),
    status: z.enum(BOARD_STATUSES).optional(),
    notes: z.string().trim().max(2000).optional(),
    photos: z.array(EvidencePath).max(20).optional(),
  }), async (a, ctx) => {
    const out = await plainly(() => writeJourney(ctx, a.repo, (db) => ({ result: recordBoard(db, { serial: a.serial, order: a.order, status: a.status, notes: a.notes, photos: a.photos }, signer(ctx)) })))
    return { ok: true, repo: a.repo, version: out.version, created: out.created, board: { serial: out.board.serial, status: out.board.status, photos: out.board.photos } }
  }),

  'board.check': def('write', Repo.extend({
    serial: Serial,
    check: z.string().trim().regex(/^[A-Za-z0-9._-]{1,60}$/, 'a short id such as visual-top or hand-J2'),
    kind: z.enum(CHECK_KINDS),
    result: z.enum(CHECK_RESULTS),
    ref: z.string().trim().regex(/^[A-Za-z]{1,4}\d{1,5}[A-Za-z]?$/, 'a reference designator such as U3').optional(),
    note: z.string().trim().max(1000).optional(),
    photo: EvidencePath.optional(),
  }), async (a, ctx) => {
    const out = await plainly(() => writeJourney(ctx, a.repo, (db) => ({ result: checkBoard(db, { serial: a.serial, check: a.check, kind: a.kind, result: a.result, ref: a.ref, note: a.note, photo: a.photo }, signer(ctx)) })))
    return { ok: true, repo: a.repo, version: out.version, board: { serial: out.board.serial, status: out.board.status }, check: { id: out.check.id, check: out.check.check, result: out.check.result } }
  }),
}

/** The board serials and step names an agent may tag a reading with (for prompts and tests). */
export const READING_STEPS: readonly BringupStep[] = BRINGUP_STEPS

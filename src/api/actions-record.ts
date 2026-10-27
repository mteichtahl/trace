/**
 * The project tabs that read the record (docs/ui-design.md "Project page"): what the screens draw, from what the
 * record holds today, with everything it does not hold yet said plainly (`notes`) rather than made up.
 *
 *   requirements.trace  read    each requirement with its evidence status (verified | failing | untested | waived:
 *                               test items and results, and the journey's waivers) and its tests; the intent lines
 *                               and each requirement's link to one (`intent`, `links`: empty, with `intent_note`, since
 *                               the record keeps no intent yet)
 *   design.get          read    the KiCad files of the default branch: one sheet per schematic file with the findings
 *                               of the latest electrical rule check (by sheet), the board with the latest design rule
 *                               check's findings, its size and layers from the latest kicad.board run, and a picture
 *                               where a run stored one (an SVG or PNG artifact, as runs/<id>/<name> for files.url).
 *                               The block diagram and the pin plan: none is recorded yet (`notes`)
 *   build.get           read    releases (the record copied into the repository: journey.snapshot and the signature
 *                               that cut a release, from the decisions), orders (recorded with order.record), the
 *                               order ready to place once the order gate's stage is reached, boards and the bench as
 *                               far as the record has them
 *   order.record        write   { order, number, paid, ship }: store a placed order in the journey record (table
 *                               orders), logged in the decisions; answers the order and a wait "for JLCPCB to ship",
 *                               marked as one no one checks automatically yet
 *   cost.get            read    the stage timeline (started, finished, days per stage) for anyone on the project; the
 *                               money (orders paid, committed, the forecast from the build plan's quantity x unit
 *                               cost, the budget) for admins only: the design gives Cost and time to admins, and
 *                               reviewers never see cost. Cloud use per run is not recorded (it reaches CloudWatch
 *                               only, as trace.claude.cost), so it is null with a note
 */
import { z } from 'zod'
import { isAdmin } from '../core/access.js'
import { type JourneyRecord, STAGE_NAMES, type StageId, type Signer, loadJourney, loadOrders, recordOrder } from '../core/journey.js'
import { type Context, Repo, def, hashOf, hashesOf, label, plainly, withJourneyDb, withRecordDb, writeJourney } from './action-kit.js'
import { type Finding, checkFindings, latestRun, requirementEvidence, runImages, runResult, sheetFileOf } from './record-read.js'

const signer = (ctx: Context): Signer => ({ hash: hashOf(ctx.principal), also: hashesOf(ctx.principal), label: label(ctx.principal) })
const iso = (t: number | null): string | null => (t === null ? null : new Date(t * 1000).toISOString())
const DAY = 86400

/** A finding as the app's pictures draw it (PictureFinding), with KiCad's position in millimetres. */
const pictureFinding = (f: Finding) => ({
  id: f.id, severity: f.severity, text: f.text, where: f.ref ?? f.where, sheet: f.where, ...(f.x_mm !== null ? { x_mm: f.x_mm, y_mm: f.y_mm } : {}),
  source: { kind: 'run' as const, id: f.run, label: `run ${f.run.slice(0, 8)}` },
})

/** The KiCad files of the default branch (schematics and boards), sorted. */
async function kicadFiles(ctx: Context, repo: string): Promise<{ sch: string[]; pcb: string[]; ref: string }> {
  const gh = await ctx.deps.github()
  const { branch } = await gh.defaultBranch(repo)
  const t = await gh.tree(repo, branch)
  const skip = /(^|\/)(\.git|node_modules)(\/|$)|-backups\/|(^|\/)~?_autosave-/
  const paths = t.files.map((f) => f.path).filter((p) => !skip.test(p)).sort()
  return { sch: paths.filter((p) => p.endsWith('.kicad_sch')), pcb: paths.filter((p) => p.endsWith('.kicad_pcb')), ref: branch }
}

const sheetName = (path: string): string => (path.split('/').pop() ?? path).replace(/\.kicad_sch$/, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase())

export const RECORD_ACTIONS = {
  'requirements.trace': def('read', Repo, async ({ repo }, ctx) => withRecordDb(ctx, repo, (db) => {
    const r = loadJourney(db)
    const requirements = requirementEvidence(db, r)
    const count = (e: string): number => requirements.filter((x) => x.evidence === e).length
    return {
      repo,
      intent: [] as { id: string; topic: string; text: string }[],
      links: [] as { requirement: string; intent: string }[],
      intent_note: 'The record keeps no intent statements yet, so there is nothing for a requirement to link back to. The Intent builder needs to store them (an intent table with each requirement\'s derived-from link) before this column can be drawn.',
      requirements,
      summary: { requirements: requirements.length, verified: count('verified'), failing: count('failing'), untested: count('untested'), waived: count('waived') },
    }
  })),

  'design.get': def('read', Repo, async ({ repo }, ctx) => {
    const files = await kicadFiles(ctx, repo)
    return withRecordDb(ctx, repo, (db) => {
      const r = loadJourney(db)
      const notes: string[] = []
      const erc = checkFindings(db, 'erc', r)
      const drc = checkFindings(db, 'drc', r)
      if (!erc.findings) notes.push(erc.unreadable)
      if (!drc.findings) notes.push(drc.unreadable)
      const images = runImages(db, ['kicad.export', 'render.board'])
      const bySheet = new Map<string, Finding[]>()
      for (const f of erc.findings ?? []) {
        const file = sheetFileOf(f.where, files.sch) ?? '(no schematic file)'
        bySheet.set(file, [...(bySheet.get(file) ?? []), f])
      }
      const sheets = files.sch.map((path) => ({
        id: path, name: sheetName(path),
        // a drawing only where a run stored one: kicad.export writes its SVGs to the clone, not the record
        ...((): { path?: string } => { const img = images.find((i) => i.kind === 'kicad.export' && i.name.toLowerCase().includes(sheetName(path).toLowerCase().replace(/ /g, '-'))); return img ? { path: img.path } : {} })(),
        findings: (bySheet.get(path) ?? []).map(pictureFinding),
      }))
      if (files.sch.length && !sheets.some((s) => s.path)) notes.push('No drawing of the sheets is in the record: kicad.export writes its SVGs into the working copy, not the run record, so they are not kept yet.')
      const boardRun = latestRun(db, 'kicad.board')
      const result = boardRun ? runResult(db, boardRun.id) : null
      const outline = result?.outline as { width_mm?: number; height_mm?: number } | null | undefined
      const top = images.find((i) => i.kind === 'render.board' && /^top\.png$/i.test(i.name)) ?? images.find((i) => i.kind === 'render.board')
      const board = files.pcb.length ? {
        file: files.pcb[0],
        ...(top ? { path: top.path } : {}),
        ...(Array.isArray(result?.layers) ? { layers: (result.layers as unknown[]).filter((x): x is string => typeof x === 'string') } : {}),
        ...(outline?.width_mm ? { size: `${outline.width_mm} × ${outline.height_mm} mm` } : {}),
        findings: (drc.findings ?? []).map(pictureFinding),
      } : undefined
      if (board && !top) notes.push('No picture of the board is in the record yet: render.board stores one when the board is rendered.')
      notes.push('No architecture record is kept yet, so there is no block diagram: Architecture choice needs to store its blocks and connections.')
      notes.push('No pin plan is kept yet: Pin plan review needs to store each pin with its net and function.')
      return {
        repo, ref: files.ref, sheets, ...(board ? { board } : {}),
        checks: {
          erc: erc.run ? { run: erc.run.id, at: iso(erc.run.started), status: erc.run.status, summary: erc.run.summary } : null,
          drc: drc.run ? { run: drc.run.id, at: iso(drc.run.started), status: drc.run.status, summary: drc.run.summary } : null,
        },
        notes,
      }
    })
  }),

  'build.get': def('read', Repo, async ({ repo }, ctx) => withRecordDb(ctx, repo, (db) => {
    const r = loadJourney(db)
    const notes: string[] = []
    if (!r) return { repo, releases: [], orders: [], boards: [], notes: ['This project has not started its journey yet.'] }
    const releases = r.decisions.filter((d) => d.kind === 'journey.snapshot').map((d) => {
      const det = (d.detail ?? {}) as { branch?: string; commit?: string; revision?: string }
      return { id: d.id, revision: det.revision ?? r.journey.revision, at: iso(d.at) as string, commit: det.commit ?? d.ref ?? '', branch: det.branch ?? null, by: d.by ?? 'trace', frozen: true, files: null as number | null }
    })
    const b = r.journey.build
    type OrderOut = {
      id: string; release: string; state: 'ready' | 'placed' | 'shipped' | 'delivered'; cancelled: boolean; boards: number; total: number; currency: string
      number: string; paid: number | null; ship: string | null; placedAt: string | null; placedBy: string
      cost: { label: string; amount: number }[]; options: { option: string; value: string }[]; parts: never[]; files: string[]; wait: ReturnType<typeof shipWait> | null
    }
    const orders: OrderOut[] = loadOrders(db).map((o) => ({
      id: o.id, release: o.revision, state: o.state === 'cancelled' ? 'placed' as const : o.state, cancelled: o.state === 'cancelled', boards: o.boards,
      total: o.paid ?? 0, currency: o.currency, number: o.number, paid: o.paid, ship: o.shipDate, placedAt: iso(o.placedAt), placedBy: o.placedBy,
      cost: o.paid !== null ? [{ label: `Paid to ${o.fab}`, amount: o.paid }] : [], options: [], parts: [], files: [],
      wait: shipWait(o.fab, o.number, o.shipDate),
    }))
    // the order ready to place: from the stage the order gate belongs to, until one is recorded for this revision
    const atFab = r.stages.some((s) => s.id === 'fabricate') && stageOrd(r, r.journey.currentStage) >= stageOrd(r, 'fabricate')
    if (atFab && !orders.some((o) => o.release === r.journey.revision && !o.cancelled)) {
      const fab = latestRun(db, 'kicad.fab')
      const res = fab ? runResult(db, fab.id) : null
      const files = Array.isArray(res?.files) ? (res.files as unknown[]).map((f) => (typeof f === 'string' ? f : (f as { path?: string }).path ?? '')).filter(Boolean).map((p) => p.split('/').pop() ?? p) : []
      orders.unshift({
        id: 'next', release: r.journey.revision, state: 'ready', cancelled: false, boards: b.quantity, total: b.unit_cost !== null ? Math.round(b.unit_cost * b.quantity * 100) / 100 : 0,
        currency: b.currency, number: '', paid: null, ship: null, placedAt: null, placedBy: '',
        cost: b.unit_cost !== null ? [{ label: `${b.quantity} boards at the planned unit cost`, amount: Math.round(b.unit_cost * b.quantity * 100) / 100 }] : [],
        options: [], parts: [], files, wait: null,
      })
      notes.push('The order sheet\'s board options and today\'s stock and prices per line are not in the record: they come from the release package and a fresh parts check.')
      if (b.unit_cost === null) notes.push('No unit cost is set in the build plan, so the order\'s expected total is unknown.')
    }
    notes.push('Boards by serial are not recorded yet: Incoming inspection needs to store each board.')
    return { repo, releases, orders, boards: [], notes }
  })),

  'order.record': def('write', Repo.extend({
    order: z.string().min(1).max(80).default('next'),
    number: z.string().trim().min(3).max(80),
    paid: z.number().min(0).max(10_000_000).nullable().default(null),
    ship: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date such as 2026-11-04').nullable().default(null),
    boards: z.number().int().min(1).max(1_000_000).optional(),
    note: z.string().trim().max(1000).optional(),
  }), async (a, ctx) => {
    const out = await plainly(() => writeJourney(ctx, a.repo, (db) => {
      const o = recordOrder(db, { number: a.number, paid: a.paid, ship_date: a.ship, boards: a.boards, note: a.note ?? null }, signer(ctx))
      return { result: o }
    }))
    return {
      ok: true, repo: a.repo, created: out.created, version: out.version,
      order: { id: out.order.id, number: out.order.number, boards: out.order.boards, paid: out.order.paid, currency: out.order.currency, ship: out.order.shipDate, state: out.order.state },
      wait: shipWait(out.order.fab, out.order.number, out.order.shipDate),
    }
  }),

  'cost.get': def('read', Repo, async ({ repo }, ctx) => withJourneyDb(ctx, repo, (db) => {
    const r = loadJourney(db)
    const money = isAdmin(ctx.principal)
    const notes: string[] = []
    if (!r) return { repo, money, currency: 'USD', spent: { cloud: null, orders: money ? 0 : null }, committed: money ? 0 : null, forecast: null, stages: [], lines: [], notes: ['This project has not started its journey yet.'] }
    const now = Date.now() / 1000
    const cur = stageOrd(r, r.journey.currentStage)
    const stages = r.stages.map((s) => {
      const state = s.ord < cur ? 'done' as const : s.ord === cur ? 'current' as const : 'queued' as const
      const days = s.started !== null ? Math.round((((s.finished ?? now) - s.started) / DAY) * 10) / 10 : 0
      return { stage: STAGE_NAMES[s.id], id: s.id, state, started: iso(s.started), finished: iso(s.finished), days, cloud: null as number | null, forecastDays: null as number | null }
    })
    notes.push('Forecast days per stage are not computed yet: there is no history of how long each stage takes.')
    if (!money) {
      notes.push('Cost is shown to admins only.')
      return { repo, money, currency: r.journey.build.currency, spent: { cloud: null, orders: null }, committed: null, forecast: null, stages, lines: [], notes }
    }
    const b = r.journey.build
    const orders = loadOrders(db).filter((o) => o.state !== 'cancelled')
    const paid = orders.reduce((n, o) => n + (o.paid ?? 0), 0)
    const unpaid = orders.filter((o) => o.paid === null).length
    if (unpaid) notes.push(`${unpaid} recorded order${unpaid === 1 ? ' has' : 's have'} no cost given.`)
    const planned = b.unit_cost !== null ? Math.round(b.unit_cost * b.quantity * 100) / 100 : null
    const placedThisRevision = orders.some((o) => o.revision === r.journey.revision)
    const committed = !placedThisRevision && cur >= stageOrd(r, 'fabricate') && stageOrd(r, 'fabricate') >= 0 && planned !== null ? planned : 0
    if (planned === null) notes.push('No unit cost is set in the build plan, so the build\'s forecast is unknown.')
    notes.push('Cloud use (agents, graphics card and CPU jobs) is not recorded per run or per project: Claude\'s cost reaches CloudWatch only (trace.claude.cost), so it is not counted here.')
    return {
      repo, money, currency: b.currency,
      spent: { cloud: null, orders: Math.round(paid * 100) / 100 },
      committed,
      // the build itself: quantity x unit cost, for the revision not yet ordered
      forecast: placedThisRevision ? 0 : planned,
      ...(b.budget !== null ? { budget: b.budget } : {}),
      quantity: b.quantity, unit_cost: b.unit_cost,
      stages,
      lines: orders.map((o) => ({ id: o.id, at: iso(o.placedAt) as string, what: `Order ${o.number} with ${o.fab}: ${o.boards} boards of revision ${o.revision}`, kind: 'order' as const, amount: o.paid ?? 0 })),
      notes,
    }
  })),
}

function stageOrd(r: JourneyRecord, id: StageId | string): number {
  return r.stages.find((s) => s.id === id)?.ord ?? -1
}

/** The wait for a placed order to ship: nothing checks it on its own yet, so it says so (no next check). */
function shipWait(fab: string, number: string, ship: string | null) {
  return {
    id: `order-${number}`, what: `${fab} to ship order ${number}`, source: 'manual' as const, nextCheckAt: null, lastCheckedAt: null, checkable: false,
    text: `Waiting for ${fab} to ship order ${number}${ship ? ` (quoted for ${ship})` : ''}. No automatic check exists yet: trace does not read ${fab}'s order status, so mark it shipped when it does.`,
  }
}

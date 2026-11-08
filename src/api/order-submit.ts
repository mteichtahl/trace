/**
 * Order submit's steps, from the record (docs/user-journey.md, "Order submit"; test-esp32 #225): what each step shows,
 * so none of them reads "trace has nothing open". Pure: the record is read in actions-skills.ts.
 *
 *   stock     the newest parts.bom_check: each line's stock and price, and what changed since the release approval
 *             was signed (the newest check before that signature)
 *   package   the newest kicad.fab run: its files in the release folder (links into the repository), which to upload
 *   options   each board and assembly option to enter on JLCPCB: those kicad.fab recorded with the package, else from
 *             the board (kicad.board) and the package, with the build plan's quantities; an option no record decides is JLCPCB's default, and says so
 *   matching  each line of the package's parts list (kicad.fab's bom.csv) with its LCSC part
 *   pay       the order gate, the newest JLCPCB quote of this revision (src/core/quotes.ts) and the order recorded
 *   case      the printed case, ordered apart from the boards: the case order sheet (mech.order) when one is prepared,
 *             else the newest case build and that its sheet is not prepared yet (test-esp32-run2 R66: the estimate
 *             counted the case, the order sheet never mentioned it)
 *
 * The draft records what the person did: `entered` (option ids), `matched` and `unplaced` (line keys: matched as
 * intended, or a part JLCPCB will not place).
 */
import type { JourneyRecord, OrderRow } from '../core/journey.js'
import { type QuoteRow, latestQuote } from '../core/quotes.js'
import { parseCsv } from '../tools/kicad/bom.js'
import { orderOptionsOf } from '../tools/kicad/order-options.js'

export interface RunRow { id: string; status: string; summary: string | null; started: number; result: Record<string, unknown> | null }

/** What the record holds for the steps, read in actions-skills.ts. Absent pieces were not in the record. */
export interface OrderRecord {
  /** the newest parts.bom_check */
  parts: RunRow | null
  /** the newest parts.bom_check at or before the release approval's signature */
  signedParts: RunRow | null
  /** the newest kicad.fab run, the folder it wrote (as asked: relative to the repository) and its parts list */
  fab: (RunRow & { outDir: string | null; bomCsv: string | null }) | null
  /** the newest kicad.board run */
  board: { id: string; result: Record<string, unknown> | null } | null
  /** the newest case build (mech.build, with a fit) and case order sheet (mech.order) */
  caseBuild?: { id: string; started: number; result: Record<string, unknown> | null } | null
  caseOrder?: { id: string; started: number; result: Record<string, unknown> | null } | null
}

/** The case's order, apart from the boards'. `sheet`: the prepared order (mech.order) when it is newer than the build. */
export interface CaseOrderView {
  build: string
  process: string | null; material: string | null
  sheet: { run: string; service: string; finish: string | null; quantity: number | null; files: string[]; upload: string | null } | null
}

export interface StockLineView {
  key: string; line: number; mpn: string | null; lcsc: string | null; refs: string | null; need: number; stock: number | null; status: string
  unit_price: number | null
  /** at the release approval (null: not in that check, or no check then) */
  was_price: number | null; was_status: string | null
  /** what changed since then: a line not in that check, its price, or its stock status */
  change: 'new' | 'price' | 'status' | null
}
export interface OrderOption { id: string; group: 'board' | 'assembly'; label: string; value: string; source: string; decided: boolean }
export interface OrderLine { key: string; refs: string; value: string | null; mpn: string | null; lcsc: string | null; qty: number | null }

export interface OrderView {
  stock: {
    run: string; at: string; today: boolean; status: string; summary: string | null
    boards: number | null; build_quantity: number; currency: string | null; total: number | null
    blocking: number; lines: StockLineView[]; changed: number
    signed: { run: string; at: string; total: number | null } | null
  } | null
  package: {
    run: string; at: string; status: string; dir: string | null
    files: { path: string; name: string; bytes: number | null; repo_path: string | null; upload: boolean }[]
    problems: string[]; placements: number | null; hand_placed: string[] | null
  } | null
  options: OrderOption[]
  /** the printed case, ordered apart from the boards (null: the project has no case build) */
  case: CaseOrderView | null
  /** the run the board options come from: kicad.fab's recorded options, else kicad.board; null when neither */
  board_run: string | null
  lines: OrderLine[]
  /** where the lines come from: the package's parts list, or the parts check when there is no package */
  lines_from: 'package' | 'parts' | null
  pay: {
    gate: { id: string; signed: { by: string; at: string } | null } | null
    sheet: 'met' | 'not_met' | 'waived' | null
    order: { number: string; paid: number | null; currency: string; ship: string | null } | null
    /** the newest JLCPCB quote of this revision, as the person read it off JLCPCB */
    quote: { id: string; on: string; total: number; currency: string; quantity: number } | null
  }
}

const iso = (t: number): string => new Date(t * 1000).toISOString()
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const objs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [])

/** The order gate's live signature for this revision, or null. */
export function orderSigned(r: JourneyRecord | null): { by: string; at: number } | null {
  if (!r) return null
  const s = r.signatures.filter((x) => x.gate === 'fabricate.order' && x.revision === r.journey.revision && x.supersededAt === null).sort((a, b) => b.at - a.at)[0]
  return s ? { by: s.by, at: s.at } : null
}

/** When the release approval (the gate whose signature opened Fabricate) was last signed for this revision. */
export function releaseSignedAt(r: JourneyRecord | null): number | null {
  if (!r) return null
  const s = r.signatures.filter((x) => x.gate === 'signoff' && x.revision === r.journey.revision && x.supersededAt === null).sort((a, b) => b.at - a.at)[0]
  return s?.at ?? null
}

/** The stock step: each line of the newest parts check against the one at the release approval. */
function stockOf(r: JourneyRecord | null, rec: OrderRecord, now: number): OrderView['stock'] {
  const p = rec.parts
  if (!p) return null
  const res = p.result
  const was = new Map(objs(rec.signedParts && rec.signedParts.id !== p.id ? rec.signedParts.result?.lines : []).map((l) => [str(l.lcsc) ?? str(l.mpn) ?? '', l]))
  const compared = Boolean(rec.signedParts && rec.signedParts.id !== p.id)
  const lines = objs(res?.lines).map((l): StockLineView => {
    const offer = l.offer && typeof l.offer === 'object' ? l.offer as Record<string, unknown> : null
    const mpn = str(l.mpn)
    const lcsc = str(l.lcsc)
    const before = was.get(lcsc ?? mpn ?? '')
    const price = num(l.unit_price)
    const wasPrice = before ? num(before.unit_price) : null
    const status = String(l.status ?? '')
    const wasStatus = before ? String(before.status ?? '') : null
    const change = !compared ? null : !before ? 'new' : wasStatus !== status ? 'status' : price !== null && wasPrice !== null && Math.abs(price - wasPrice) >= 0.00005 ? 'price' : null
    const line = num(l.line) ?? 0
    return { key: lcsc ?? mpn ?? `line-${line}`, line, mpn, lcsc, refs: str(l.refs), need: num(l.need) ?? 0, stock: num(offer?.stock), status, unit_price: price, was_price: wasPrice, was_status: wasStatus, change }
  })
  const day = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10)
  return {
    run: p.id, at: iso(p.started), today: day(p.started) === day(now), status: p.status, summary: p.summary,
    boards: num(res?.boards), build_quantity: r?.journey.build.quantity ?? 0, currency: str(res?.currency), total: num(res?.total),
    blocking: num(res?.blocking) ?? 0, lines, changed: lines.filter((l) => l.change).length,
    signed: compared && rec.signedParts ? { run: rec.signedParts.id, at: iso(rec.signedParts.started), total: num(rec.signedParts.result?.total) } : null,
  }
}

const UPLOAD = /(-gerbers\.zip|jlc-bom\.csv|jlc-cpl\.csv)$/i

/** The package step: the newest kicad.fab run's files, with their place in the repository when it wrote there. */
function packageOf(rec: OrderRecord): OrderView['package'] {
  const f = rec.fab
  if (!f) return null
  const res = f.result
  // a folder given relative to the repository is where the files were committed; an absolute one was a work folder
  const dir = f.outDir && !f.outDir.startsWith('/') && !f.outDir.includes('..') ? f.outDir.replace(/\/+$/, '') : null
  const files = (Array.isArray(res?.files) ? res.files as unknown[] : []).map((x) => {
    const path = typeof x === 'string' ? x : x && typeof x === 'object' ? String((x as { path?: unknown }).path ?? '') : ''
    const bytes = x && typeof x === 'object' ? num((x as { bytes?: unknown }).bytes) : null
    return { path, name: path.split('/').pop() ?? path, bytes, repo_path: dir && path ? `${dir}/${path}` : null, upload: UPLOAD.test(path) }
  }).filter((x) => x.path)
  // the files to upload first, then the rest in their order (the loose Gerbers last)
  files.sort((a, b) => Number(b.upload) - Number(a.upload) || Number(a.path.includes('/')) - Number(b.path.includes('/')))
  return {
    run: f.id, at: iso(f.started), status: f.status, dir, files,
    problems: (Array.isArray(res?.problems) ? res.problems as unknown[] : []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))),
    placements: num(res?.placements), hand_placed: Array.isArray(res?.hand_placed) ? (res.hand_placed as unknown[]).filter((x): x is string => typeof x === 'string') : null,
  }
}

/**
 * The options to enter on JLCPCB's order page, each with where it comes from: the board's own (layers, size,
 * thickness, copper, track and hole) from kicad.board, the quantity from the build plan, assembly from the package.
 * The colours, finish and impedance control no record decides: JLCPCB's default, marked not decided.
 */
export function orderOptions(r: JourneyRecord | null, rec: OrderRecord): OrderOption[] {
  // the options kicad.fab recorded with the package, as the Build page's order sheet shows them, with the build
  // plan's quantities; a package made before they were recorded falls back to the board check below
  const recorded = orderOptionsOf(rec.fab?.result ?? null)
  if (recorded?.length) {
    const qty = r?.journey.build.quantity ?? null
    const slug = (x: string): string => x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const of = (g: 'pcb' | 'pcba') => recorded.filter((x) => x.group === g).map((x): OrderOption => ({ id: slug(x.option), group: g === 'pcb' ? 'board' : 'assembly', label: x.option, value: x.value, source: x.source, decided: x.decided }))
    const pcba = of('pcba')
    return [
      ...of('pcb'),
      ...(qty !== null ? [{ id: 'quantity', group: 'board' as const, label: 'PCB quantity', value: String(qty), source: 'the build plan', decided: true }] : []),
      ...pcba,
      ...(pcba.length && qty !== null ? [{ id: 'assembled', group: 'assembly' as const, label: 'Assembly quantity', value: String(qty), source: 'the build plan', decided: true }] : []),
    ]
  }
  const b = rec.board?.result ?? null
  const src = rec.board ? `kicad.board ${rec.board.id.slice(0, 8)}` : ''
  const out: OrderOption[] = []
  const add = (o: Omit<OrderOption, 'decided'>, decided = true): void => { out.push({ ...o, decided }) }
  const qty = r?.journey.build.quantity ?? null
  if (b) {
    const layers = num(b.copper_layers)
    if (layers !== null) add({ id: 'layers', group: 'board', label: 'Layers', value: String(layers), source: src })
    const o = b.outline && typeof b.outline === 'object' ? b.outline as Record<string, unknown> : null
    if (num(o?.width_mm) !== null && num(o?.height_mm) !== null) add({ id: 'size', group: 'board', label: 'Dimensions', value: `${num(o?.width_mm)} × ${num(o?.height_mm)} mm`, source: src })
  }
  if (qty !== null) add({ id: 'quantity', group: 'board', label: 'PCB quantity', value: String(qty), source: 'the build plan' })
  if (b) {
    const t = num(b.thickness_mm)
    if (t !== null) add({ id: 'thickness', group: 'board', label: 'PCB thickness', value: `${t} mm`, source: src })
    const outer = objs(b.stackup).find((l) => l.outer === true && num(l.copper_um) !== null)
    const um = outer ? num(outer.copper_um)! : null
    if (um !== null) add({ id: 'copper', group: 'board', label: 'Outer copper weight', value: `${Math.max(1, Math.round(um / 35))} oz (${um} µm)`, source: src })
    const rules = b.design_rules && typeof b.design_rules === 'object' ? (b.design_rules as Record<string, unknown>).rules as Record<string, unknown> | undefined : undefined
    const track = num(rules?.min_track_width)
    const gap = num(rules?.min_clearance)
    if (track !== null && gap !== null) add({ id: 'track', group: 'board', label: 'Min track / spacing', value: `${track} mm / ${gap} mm`, source: `${src}, its design rules` })
    const hole = num(rules?.min_through_hole_diameter)
    if (hole !== null) add({ id: 'hole', group: 'board', label: 'Min hole size', value: `${hole} mm`, source: `${src}, its design rules` })
  }
  const dflt = 'JLCPCB\'s default: no record decides it'
  add({ id: 'impedance', group: 'board', label: 'Impedance control', value: 'No', source: dflt }, false)
  add({ id: 'mask', group: 'board', label: 'Solder mask colour', value: 'Green', source: dflt }, false)
  add({ id: 'silk', group: 'board', label: 'Silkscreen colour', value: 'White', source: dflt }, false)
  add({ id: 'finish', group: 'board', label: 'Surface finish', value: 'HASL', source: dflt }, false)
  const placements = num(rec.fab?.result?.placements)
  if (placements !== null && placements > 0) {
    const fp = b?.footprints && typeof b.footprints === 'object' ? b.footprints as Record<string, unknown> : null
    const bottom = num(fp?.bottom)
    const fabSrc = `kicad.fab ${rec.fab!.id.slice(0, 8)}`
    add({ id: 'assembly', group: 'assembly', label: 'PCB assembly', value: 'Yes', source: `${fabSrc}: ${placements} parts placed` })
    add({ id: 'side', group: 'assembly', label: 'Assembly side', value: bottom ? 'Both sides' : 'Top side', source: bottom === null ? fabSrc : `${src}: ${bottom ? `${bottom} parts on the bottom` : 'no part on the bottom'}` })
    if (qty !== null) add({ id: 'assembled', group: 'assembly', label: 'Boards assembled', value: String(qty), source: 'the build plan' })
  }
  return out
}

/** The run the order options come from, or null when no run gives the board's own options. */
export function optionsRun(rec: OrderRecord): string | null {
  if (orderOptionsOf(rec.fab?.result ?? null)?.length) return rec.fab!.id
  return rec.board?.id ?? null
}

/** The package's parts list (kicad.fab's bom.csv) as lines; else the newest parts check's. */
export function orderLines(rec: OrderRecord): { lines: OrderLine[]; from: OrderView['lines_from'] } {
  const csv = rec.fab?.bomCsv ? parseCsv(rec.fab.bomCsv).filter((row) => row.some((c) => c.trim())) : []
  if (csv.length > 1) {
    const head = csv[0]!.map((h) => h.trim().toLowerCase())
    const at = (name: string): number => head.findIndex((h) => h === name || h.startsWith(name))
    const [iq, ir, iv, im, il] = [at('quantity'), at('reference'), at('value'), at('mpn'), at('lcsc')]
    const cell = (row: string[], i: number): string | null => (i >= 0 ? str(row[i]) : null)
    const lines = csv.slice(1).map((row, n) => {
      const refs = cell(row, ir) ?? `line ${n + 1}`
      return { key: refs, refs, value: cell(row, iv), mpn: cell(row, im), lcsc: cell(row, il), qty: iq >= 0 ? num(Number(row[iq])) : null }
    })
    return { lines, from: 'package' }
  }
  const parts = objs(rec.parts?.result?.lines)
  if (!parts.length) return { lines: [], from: null }
  return {
    lines: parts.map((l, n) => {
      const refs = str(l.refs) ?? `line ${num(l.line) ?? n + 1}`
      return { key: refs, refs, value: null, mpn: str(l.mpn), lcsc: str(l.lcsc), qty: num(l.qty_per_board) }
    }),
    from: 'parts',
  }
}

/** The case's order from the newest build and case order sheet; a sheet older than the build is for an earlier case. */
export function caseOrderOf(rec: OrderRecord): CaseOrderView | null {
  const b = rec.caseBuild
  if (!b) return null
  const proc = b.result?.process
  const p = proc && typeof proc === 'object' ? proc as Record<string, unknown> : null
  const o = rec.caseOrder && rec.caseOrder.started >= b.started ? rec.caseOrder : null
  const ord = o?.result?.order && typeof o.result.order === 'object' ? o.result.order as Record<string, unknown> : null
  return {
    build: b.id,
    process: str(ord?.process) ?? str(p?.process) ?? (typeof proc === 'string' ? str(proc) : null),
    material: str(ord?.material) ?? str(p?.material),
    sheet: o && ord ? {
      run: o.id, service: str(ord.service) === 'jlccnc' ? 'JLCCNC machining' : 'JLC3DP 3D printing', finish: str(ord.finish), quantity: num(ord.quantity),
      files: Array.isArray(ord.files) ? ord.files.filter((f): f is string => typeof f === 'string') : [], upload: str(ord.upload),
    } : null,
  }
}

/** The steps' content from the record (`now`: seconds, for "today"). */
export function orderView(r: JourneyRecord | null, rec: OrderRecord | null, orders: readonly OrderRow[], now: number, quotes: readonly QuoteRow[] = []): OrderView {
  const R: OrderRecord = rec ?? { parts: null, signedParts: null, fab: null, board: null }
  const { lines, from } = orderLines(R)
  const gate = r?.gates.find((g) => g.id === 'fabricate.order')
  const signed = orderSigned(r)
  const sheet = r?.criteria.find((c) => c.id === 'fabricate.order.sheet')
  const sheetWaived = sheet && r?.waivers.some((w) => w.targetKind === 'criterion' && w.target === sheet.id && w.closedAt === null)
  const o = orders.find((x) => x.revision === r?.journey.revision && x.state !== 'cancelled')
  return {
    stock: stockOf(r, R, now), package: packageOf(R), options: orderOptions(r, R), case: caseOrderOf(R), board_run: optionsRun(R), lines, lines_from: from,
    pay: {
      gate: gate ? { id: gate.id, signed: signed ? { by: signed.by, at: iso(signed.at) } : null } : null,
      sheet: sheet ? (sheet.status === 'met' ? 'met' : sheetWaived ? 'waived' : 'not_met') : null,
      order: o ? { number: o.number, paid: o.paid, currency: o.currency, ship: o.shipDate } : null,
      quote: ((q) => (q ? { id: q.id, on: q.on, total: q.total, currency: q.currency, quantity: q.quantity } : null))(r ? latestQuote(quotes, r.journey.revision) : null),
    },
  }
}

const ids = (draft: Record<string, unknown> | null, key: string): string[] => (Array.isArray(draft?.[key]) ? (draft[key] as unknown[]).filter((x): x is string => typeof x === 'string') : [])
/** The options the person ticked as entered. */
export const enteredOf = (draft: Record<string, unknown> | null): string[] => ids(draft, 'entered')
/** The lines the person confirmed matched, and those JLCPCB will not place. */
export const matchedOf = (draft: Record<string, unknown> | null): { matched: string[]; unplaced: string[] } => ({ matched: ids(draft, 'matched'), unplaced: ids(draft, 'unplaced') })

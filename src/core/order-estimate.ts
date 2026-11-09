/**
 * The order estimate: what the build's order will cost (boards, assembly, parts, case, shipping), from what the record
 * holds, and how it stands against the project's cost requirements. It is made as soon as there is a parts check
 * (parts.bom_check), so a cost requirement an order would break is seen at Architect or Capture, while the parts and
 * the case are still cheap to change. In test-esp32 run 2 (#162) the first estimate came at Sign-off, after five stages
 * were signed: US$141 to 244 against a US$100 requirement.
 *
 *   parts      the newest parts check: its total at the build quantity (per board times the quantity when it checked
 *              another quantity, said so)
 *   boards     the newest board (kicad.board: outline and copper layers) priced from FAB_PRICES; before there is a
 *              board, a board up to 100 x 100 mm with two layers, said so
 *   assembly   setup, stencil, a fee per extended part (the parts check's jlc-extended flag; a line it does not know
 *              counts as basic at the low end and extended at the high end) and the solder joints
 *   case       the newest case (mech.build: each part's volume and the process) priced per cm3; none before a case
 *   shipping   a small parcel
 *
 * Fees, the case and shipping come from FAB_PRICES, a table of the fab's published prices built into trace. They are
 * not a quote: the quote at Fabricate is what the order costs, and the estimate says so. The per-board figure is
 * boards, assembly and parts over the quantity (the case and shipping are the order's, not the board's).
 *
 * The limits are the cost requirements (a requirement tagged cost, or about cost, with an amount: "at most 275 USD",
 * "each board shall cost at most 9 USD"), else the build plan's budget and target unit cost. Each is under, at risk (the
 * range spans it) or over. Pure over the record database.
 */
import type { DatabaseSync } from 'node:sqlite'
import { BuildSchema } from './journey.js'

type Range = [number, number]

/** The fab's published prices (JLCPCB), in US$. Dated: they change, and the quote at Fabricate is what counts. */
export const FAB_PRICES = {
  asOf: '2026-10-01',
  fab: 'JLCPCB',
  /** bare boards: at least `base` for the order, else the board area times the quantity at `perCm2` */
  pcb: { 2: { base: [2, 5] as Range, perCm2: [0.01, 0.03] as Range }, 4: { base: [7, 15] as Range, perCm2: [0.035, 0.08] as Range } },
  assembly: { setup: 8, stencil: 1.5, extendedEach: 3, perJoint: 0.0017, jointsPerPart: [2, 6] as Range },
  /** printed case per cm3 of material, by process */
  casePerCm3: { mjf: [0.15, 0.4] as Range, sla: [0.1, 0.3] as Range, fdm: [0.05, 0.2] as Range, other: [0.1, 0.4] as Range },
  shipping: [15, 40] as Range,
} as const

export type LimitKind = 'total' | 'per_board'
export interface CostLimit {
  /** the requirement's id, or null for the build plan's own figure */
  requirement: string | null
  kind: LimitKind
  amount: number
  currency: string
  /** where it comes from, in words */
  source: string
  /**
   * What the limit leaves out of the order, as its requirement or a person's answer about it says ("case printing and
   * the OLED module are outside this budget", "not shipping"): compared without those lines (test-esp32-run2 R35).
   */
  excludes?: ExcludedLine[]
}
export type ExcludedLine = 'shipping' | 'case'
export interface LimitCheck extends CostLimit {
  verdict: 'under' | 'at_risk' | 'over' | 'not_compared'
  text: string
  /** what was compared with the limit, when it is not the order's whole range or the per-board range (excludes) */
  compared?: { low: number; high: number }
}
export interface EstimateLine { key: 'parts' | 'boards' | 'assembly' | 'case' | 'shipping'; what: string; low: number; high: number; source: string }

export interface OrderEstimate {
  currency: 'USD'
  quantity: number
  low: number
  high: number
  perBoard: { low: number; high: number }
  lines: EstimateLine[]
  /** what is not in it, one line each */
  notIn: string[]
  /** the parts check it starts from */
  partsRun: string
  at: number
  limits: LimitCheck[]
  /** the worst verdict over the limits; null when none could be compared */
  verdict: 'under' | 'at_risk' | 'over' | null
  /** one paragraph: the range, what it is from, and each limit */
  text: string
  /** the schematic's parts list since the parts check, when it differs: what the estimate does not count yet */
  partsChanged?: string
}

export interface EstimateInput {
  quantity: number
  parts: { run: string; at: number; boards: number | null; total: number; currency: string; lines: { lcsc: string | null; perBoard: number; extended: boolean | null }[] }
  board: { run: string; widthMm: number; heightMm: number; layers: number } | null
  case: { run: string; volumeMm3: number; process: string | null } | null
  limits: CostLimit[]
}

const cents = (n: number): number => Math.round(n * 100) / 100
const usd = (n: number): string => `US$${Number.isInteger(cents(n)) ? cents(n) : cents(n).toFixed(2)}`
const range = (r: Range): string => (cents(r[0]) === cents(r[1]) ? usd(r[0]) : `${usd(r[0])} to ${usd(r[1])}`)

function pcbPrice(layers: number): { base: Range; perCm2: Range } {
  if (layers <= 2) return FAB_PRICES.pcb[2]
  const k = layers / 4
  const p = FAB_PRICES.pcb[4]
  return { base: [p.base[0] * k, p.base[1] * k], perCm2: [p.perCm2[0] * k, p.perCm2[1] * k] }
}

function caseRate(process: string | null): { rate: Range; name: string } {
  const p = (process ?? '').toLowerCase()
  if (/mjf|multi jet|pa12|nylon/.test(p)) return { rate: FAB_PRICES.casePerCm3.mjf, name: 'MJF' }
  if (/sla|resin/.test(p)) return { rate: FAB_PRICES.casePerCm3.sla, name: 'SLA' }
  if (/fdm|pla|petg/.test(p)) return { rate: FAB_PRICES.casePerCm3.fdm, name: 'FDM' }
  return { rate: FAB_PRICES.casePerCm3.other, name: process ?? 'an unknown process' }
}

/** The estimate from its inputs. Pure. */
export function orderEstimate(i: EstimateInput): OrderEstimate {
  const q = i.quantity
  const lines: EstimateLine[] = []
  const notIn: string[] = []
  const published = `${FAB_PRICES.fab}'s published prices of ${FAB_PRICES.asOf}, not a quote`

  // parts: the check's own total at the build quantity, else per board times the quantity
  const parts = i.parts.boards === q ? i.parts.total : i.parts.boards ? cents((i.parts.total / i.parts.boards) * q) : i.parts.total
  lines.push({
    key: 'parts', what: `Parts for ${q} boards (${i.parts.lines.length} line${i.parts.lines.length === 1 ? '' : 's'} checked)`, low: cents(parts), high: cents(parts),
    source: i.parts.boards === q || !i.parts.boards ? `parts check ${i.parts.run}` : `parts check ${i.parts.run}, made for ${i.parts.boards} boards and scaled to ${q} (prices differ by quantity)`,
  })
  if (i.parts.currency !== 'USD') notIn.push(`The parts check is in ${i.parts.currency}; its total is added as if in US$.`)

  // boards
  const layers = i.board?.layers ?? 2
  const p = pcbPrice(layers)
  if (i.board) {
    const area = (i.board.widthMm * i.board.heightMm) / 100 * q
    lines.push({
      key: 'boards', what: `${q} bare boards, ${layers} layers, ${cents(i.board.widthMm)} x ${cents(i.board.heightMm)} mm`,
      low: cents(Math.max(p.base[0], area * p.perCm2[0])), high: cents(Math.max(p.base[1], area * p.perCm2[1])), source: `board ${i.board.run}; ${published}`,
    })
  } else {
    lines.push({ key: 'boards', what: `${q} bare boards (no board yet: priced as two layers, up to 100 x 100 mm)`, low: cents(p.base[0]), high: cents(Math.max(p.base[1], 100 * q * p.perCm2[1])), source: published })
  }

  // assembly: setup, stencil, extended parts, joints
  const a = FAB_PRICES.assembly
  const placed = i.parts.lines.filter((l) => l.perBoard > 0)
  const known = placed.filter((l) => l.extended === true).length
  const unknown = placed.filter((l) => l.extended === null).length
  const partsPerBoard = placed.reduce((n, l) => n + l.perBoard, 0)
  const joints: Range = [partsPerBoard * q * a.jointsPerPart[0] * a.perJoint, partsPerBoard * q * a.jointsPerPart[1] * a.perJoint]
  const fixed = a.setup + a.stencil
  lines.push({
    key: 'assembly',
    what: `Assembly: setup and stencil, ${unknown ? `${known} to ${known + unknown}` : known} extended part${known + unknown === 1 ? '' : 's'}, about ${partsPerBoard * q} parts placed`,
    low: cents(fixed + known * a.extendedEach + joints[0]), high: cents(fixed + (known + unknown) * a.extendedEach + joints[1]),
    source: unknown ? `${published}; ${unknown} line${unknown === 1 ? '' : 's'} not known as basic or extended (counted both ways)` : published,
  })

  // case
  if (i.case) {
    const c = caseRate(i.case.process)
    const cm3 = i.case.volumeMm3 / 1000
    lines.push({ key: 'case', what: `${q} cases, ${cents(cm3)} cm3 each, ${c.name}`, low: cents(cm3 * q * c.rate[0]), high: cents(cm3 * q * c.rate[1]), source: `case ${i.case.run}; ${published}` })
  } else notIn.push('No case yet: a case is added once one is built (mech.build gives its volume).')

  lines.push({ key: 'shipping', what: 'Shipping, a small parcel', low: FAB_PRICES.shipping[0], high: FAB_PRICES.shipping[1], source: `${published}; depends on the destination` })
  notIn.push('Parts bought apart from the order (a display module, cables) are in it only when they are in the parts check.')

  const low = cents(lines.reduce((n, l) => n + l.low, 0))
  const high = cents(lines.reduce((n, l) => n + l.high, 0))
  const board = lines.filter((l) => l.key === 'parts' || l.key === 'boards' || l.key === 'assembly')
  const perBoard = { low: cents(board.reduce((n, l) => n + l.low, 0) / q), high: cents(board.reduce((n, l) => n + l.high, 0) / q) }

  const limits = i.limits.map((l): LimitCheck => {
    // a total that leaves lines out is compared without them; per board never holds the case or shipping
    const out = l.kind === 'total' ? (l.excludes ?? []).filter((k) => lines.some((x) => x.key === k)) : []
    const kept = lines.filter((x) => !out.includes(x.key as ExcludedLine))
    const r: Range = l.kind === 'total' ? (out.length ? [cents(kept.reduce((n, x) => n + x.low, 0)), cents(kept.reduce((n, x) => n + x.high, 0))] : [low, high]) : [perBoard.low, perBoard.high]
    const name = l.requirement ?? l.source
    const what = l.kind === 'total' ? (out.length ? `the order without ${out.map((k) => (k === 'case' ? 'the case' : k)).join(' or ')}` : 'the order') : 'per board'
    const compared = out.length ? { compared: { low: r[0], high: r[1] } } : {}
    if (l.currency !== 'USD') return { ...l, verdict: 'not_compared', text: `${name} (at most ${l.amount} ${l.currency}) is not compared: the estimate is in US$.` }
    if (r[1] <= l.amount) return { ...l, ...compared, verdict: 'under', text: `${name}: ${what} ${range(r)}, under ${usd(l.amount)}.` }
    if (r[0] > l.amount) return { ...l, ...compared, verdict: 'over', text: `${name}: ${what} ${range(r)}, over ${usd(l.amount)} by ${range([r[0] - l.amount, r[1] - l.amount])}.` }
    return { ...l, ...compared, verdict: 'at_risk', text: `${name}: ${what} ${range(r)}, at risk against ${usd(l.amount)} (up to ${usd(r[1] - l.amount)} over).` }
  })
  const order = ['under', 'at_risk', 'over'] as const
  const compared = limits.filter((l) => l.verdict !== 'not_compared')
  const verdict = compared.length ? order[Math.max(...compared.map((l) => order.indexOf(l.verdict as (typeof order)[number])))] ?? null : null
  const text = [
    `Order estimate for ${q} boards: ${range([low, high])}, ${range([perBoard.low, perBoard.high])} per board (boards, assembly and parts).`,
    `Parts from parts check ${i.parts.run}; the fab's fees, the case and shipping from ${published}.`,
    ...limits.map((l) => l.text),
  ].join(' ')
  return { currency: 'USD', quantity: q, low, high, perBoard, lines, notIn, partsRun: i.parts.run, at: i.parts.at, limits, verdict, text }
}

// ------------------------------------------------------------------ the limits, from the requirements

const MONEY = /(?:(US\$|USD|AU\$|A\$|AUD|EUR|€|GBP|£|\$)\s*(\d+(?:\.\d+)?))|(?:(\d+(?:\.\d+)?)\s*(USD|US\$|AUD|EUR|GBP|dollars?)\b)/i
const PER_BOARD = /\b(?:per|each|every|a)\s+(?:board|unit|pcb|device)\b|\bper[- ]board\b|\/\s*board\b|\bunit cost\b/i
// "USD 100 covers PCB, assembly, parts and extended-part fees …" is a cost limit too: it names no cost word but covers
// fees with an amount (test-esp32-run3 S9: missed, the estimate fell back to the build plan's US$100 with shipping in)
const ABOUT_COST = /\b(?:cost|costs|price|prices|priced|budget|spend|fees?|covers?)\b/i

function currencyOf(sym: string): string {
  const s = sym.toUpperCase()
  if (s === 'AU$' || s === 'A$' || s === 'AUD') return 'AUD'
  if (s === 'EUR' || s === '€') return 'EUR'
  if (s === 'GBP' || s === '£') return 'GBP'
  return 'USD'
}

const LEAVES_OUT = String.raw`(?:not|excludes?|excluding|without|except|outside|apart from|other than|before)`
const LINE_WORDS: Readonly<Record<ExcludedLine, string>> = { shipping: String.raw`(?:shipping|postage|delivery|freight)`, case: String.raw`(?:case|enclosure|housing)(?:\s+printing)?` }

/**
 * What words about a cost limit leave out of it: "not shipping", "excluding shipping", "case printing and the OLED
 * module are outside this budget". Pure.
 */
export function excludedLines(text: string): ExcludedLine[] {
  const out: ExcludedLine[] = []
  for (const [k, w] of Object.entries(LINE_WORDS) as [ExcludedLine, string][]) {
    const before = new RegExp(String.raw`\b${LEAVES_OUT}\b[^.;:]{0,40}?\b${w}\b`, 'i')
    const after = new RegExp(String.raw`\b${w}\b[^.;:]{0,60}?\b(?:(?:is|are)\s+(?:outside|excluded|not (?:included|covered|counted))|(?:is|are)\s+not\s+in)\b`, 'i')
    if (before.test(text) || after.test(text)) out.push(k)
  }
  return out
}

/** A requirement's cost limit, when it states one ("shall cost at most 275 USD"). Pure. */
export function costLimitOf(r: { id: string; text: string; tags?: readonly string[] }): CostLimit | null {
  const about = (r.tags ?? []).some((t) => t.toLowerCase() === 'cost') || ABOUT_COST.test(r.text)
  if (!about) return null
  const m = MONEY.exec(r.text)
  if (!m) return null
  const amount = Number(m[2] ?? m[3])
  if (!Number.isFinite(amount)) return null
  const excludes = excludedLines(r.text)
  return { requirement: r.id, kind: PER_BOARD.test(r.text) ? 'per_board' : 'total', amount, currency: currencyOf(m[1] ?? m[4] ?? 'USD'), source: `${r.id}: ${r.text}`, ...(excludes.length ? { excludes } : {}) }
}

// ------------------------------------------------------------------ from the record

const hasTable = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
const json = (v: unknown): unknown => { try { return typeof v === 'string' ? JSON.parse(v) : null } catch { return null } }
/** Case parts that are bought, not printed: modelled only to check the fit. */
const BOUGHT = /module|oled|display|lcd|screen|battery|pcb|board/i
const newest = (db: DatabaseSync, kind: string): { id: string; started: number; result: unknown } | null => {
  const r = db.prepare("SELECT id, started, result FROM runs WHERE kind=? AND status != 'error' ORDER BY started DESC, id DESC LIMIT 1").get(kind) as Record<string, unknown> | undefined
  return r ? { id: String(r.id), started: Number(r.started), result: json(r.result) } : null
}

/** The cost limits in the record: the live cost requirements, else the build plan's budget and target unit cost. */
export function costLimits(db: DatabaseSync): CostLimit[] {
  const reqs = hasTable(db, 'requirements')
    ? (db.prepare("SELECT id, text, tags FROM requirements WHERE status NOT IN ('rejected', 'obsolete') ORDER BY id").all() as Record<string, unknown>[])
    : []
  const fromReqs = reqs.flatMap((r) => {
    const tags = json(r.tags)
    const l = costLimitOf({ id: String(r.id), text: String(r.text ?? ''), tags: Array.isArray(tags) ? tags.map(String) : [] })
    return l ? [l] : []
  })
  // a person's answer about a cost requirement ("USD 100 covers PCB, assembly, parts …, not shipping") says what it
  // leaves out as much as its own words do (test-esp32-run2 R35)
  const answers = hasTable(db, 'questions')
    ? (db.prepare("SELECT text, answer, answer_reason FROM questions WHERE answered_at IS NOT NULL AND answer IS NOT NULL").all() as Record<string, unknown>[])
    : []
  for (const l of fromReqs) {
    const said = answers.filter((q) => String(q.text ?? '').includes(l.requirement as string)).flatMap((q) => excludedLines(`${String(q.answer ?? '')}. ${String(q.answer_reason ?? '')}`))
    const all = [...new Set([...(l.excludes ?? []), ...said])]
    if (all.length) l.excludes = all
  }
  const build = buildOf(db)
  const out = [...fromReqs]
  if (build && !out.some((l) => l.kind === 'total') && build.budget !== null) out.push({ requirement: null, kind: 'total', amount: build.budget, currency: build.currency, source: 'the build plan\'s budget' })
  if (build && !out.some((l) => l.kind === 'per_board') && build.unit_cost !== null) out.push({ requirement: null, kind: 'per_board', amount: build.unit_cost, currency: build.currency, source: 'the build plan\'s target unit cost' })
  return out
}

function buildOf(db: DatabaseSync) {
  if (!hasTable(db, 'journey')) return null
  const r = db.prepare("SELECT build FROM journey WHERE id='current'").get() as { build?: unknown } | undefined
  if (!r) return null
  const b = BuildSchema.safeParse(json(r.build) ?? {})
  return b.success ? b.data : null
}

/**
 * The order estimate from the record: the newest parts check, board and case, and the cost limits. Null without a
 * parts check. `quantity` defaults to the build plan's, else the parts check's boards.
 */
export function orderEstimateFrom(db: DatabaseSync, o: { quantity?: number; parts?: EstimateInput['parts'] } = {}): OrderEstimate | null {
  if (!hasTable(db, 'runs')) return null
  const parts = o.parts ?? newestParts(db)
  if (!parts) return null
  const quantity = o.quantity ?? buildOf(db)?.quantity ?? parts.boards ?? 1

  const b = newest(db, 'kicad.board')
  const br = (b?.result ?? null) as { outline?: { width_mm?: unknown; height_mm?: unknown }; copper_layers?: unknown } | null
  const board = b && typeof br?.outline?.width_mm === 'number' && typeof br.outline.height_mm === 'number'
    ? { run: b.id, widthMm: br.outline.width_mm, heightMm: br.outline.height_mm, layers: typeof br.copper_layers === 'number' ? br.copper_layers : 2 }
    : null

  const m = newest(db, 'mech.build')
  const mr = (m?.result ?? null) as { case?: { parts?: { name?: unknown; volume_mm3?: unknown }[] }; process?: unknown } | null
  // the printed parts only: a case script may model a bought module (an OLED, a battery) to check the fit
  const printed = (mr?.case?.parts ?? []).filter((p) => !BOUGHT.test(String(p.name ?? '')))
  const vol = printed.reduce((n, p) => n + (typeof p.volume_mm3 === 'number' ? p.volume_mm3 : 0), 0)
  const proc = mr?.process
  const process = typeof proc === 'string' ? proc : proc && typeof proc === 'object' ? String((proc as { process?: unknown }).process ?? '') || null : null
  const kase = m && vol > 0 ? { run: m.id, volumeMm3: vol, process } : null

  const e = orderEstimate({
    quantity,
    parts, board, case: kase, limits: costLimits(db),
  })
  const changed = o.parts ? null : partsDrift(db, parts)
  return changed ? { ...e, partsChanged: changed, text: `${e.text} ${changed}` } : e
}

/**
 * How the schematic's parts list differs from the parts check the estimate stands on, in words, or null: the newest
 * kicad.bom made after the check, by order code and count per board (test-esp32-run2 R51: through Layout the
 * estimate stood on Architect's check, without the four parts Prove added, and nothing said so).
 */
export function partsDrift(db: DatabaseSync, parts: Pick<EstimateInput['parts'], 'run' | 'at' | 'lines'>): string | null {
  const b = newest(db, 'kicad.bom')
  if (!b || b.started <= parts.at) return null
  const rows = ((b.result ?? {}) as { lines?: { qty?: unknown; lcsc?: unknown; value?: unknown }[] }).lines
  if (!Array.isArray(rows) || !rows.length) return null
  const count = (m: Map<string, number>, k: string, n: number): void => { m.set(k, (m.get(k) ?? 0) + n) }
  const now = new Map<string, number>()
  for (const l of rows) count(now, typeof l.lcsc === 'string' && l.lcsc ? l.lcsc : `${String(l.value ?? '?')} (no LCSC code)`, Number(l.qty ?? 0))
  const was = new Map<string, number>()
  for (const l of parts.lines) count(was, l.lcsc ?? '?', l.perBoard)
  const added = [...now].filter(([k, n]) => (was.get(k) ?? 0) < n).map(([k, n]) => `${k} ×${n - (was.get(k) ?? 0)}`)
  const removed = [...was].filter(([k, n]) => k !== '?' && (now.get(k) ?? 0) < n).map(([k, n]) => `${k} ×${n - (now.get(k) ?? 0)}`)
  if (!added.length && !removed.length) return null
  const list = (xs: string[]): string => (xs.length > 4 ? `${xs.slice(0, 4).join(', ')} and ${xs.length - 4} more` : xs.join(', '))
  const what = [added.length ? `adds ${list(added)}` : '', removed.length ? `drops ${list(removed)}` : ''].filter(Boolean).join('; ')
  return `The schematic's parts list has changed since this parts check (its bill of materials of ${new Date(b.started * 1000).toISOString().slice(0, 10)} ${what}), so the estimate leaves those out until the parts are checked again.`
}

/**
 * Before the schematic has a parts list (no kicad.bom yet), the parts check the architecture stands on: the one the
 * chosen option cites (status chosen), else the recommended one's, by its run id in the option's words or scores. A
 * smaller check made later (the display block alone, 2 lines) is not the board: run 3 read US$26.83 to US$83.04 for
 * 10 boards from it while option A's own check gave US$61.74 to US$90.97 (test-esp32-run3 S7). Null: none cited.
 */
export function architectureCheck(db: DatabaseSync): string | null {
  if (newest(db, 'kicad.bom') || !hasTable(db, 'arch_options')) return null
  const o = db.prepare("SELECT id, summary, why FROM arch_options WHERE status != 'withdrawn' ORDER BY (status = 'chosen') DESC, recommended DESC, id LIMIT 1").get() as Record<string, unknown> | undefined
  if (!o) return null
  const scores = hasTable(db, 'arch_scores') ? (db.prepare('SELECT reason FROM arch_scores WHERE option=?').all(String(o.id)) as { reason?: unknown }[]).map((r) => String(r.reason ?? '')) : []
  const words = [String(o.why ?? ''), String(o.summary ?? ''), ...scores].join(' ')
  for (const m of words.matchAll(/parts\.bom_check[\s(:]*([0-9a-f]{12,32})/g)) {
    const id = m[1] as string
    const r = db.prepare("SELECT id FROM runs WHERE kind='parts.bom_check' AND status != 'error' AND (id = ? OR id LIKE ?) LIMIT 1").get(id, `${id}%`) as { id?: string } | undefined
    if (r?.id) return r.id
  }
  return null
}

/** The parts check the estimate reads: the architecture's (architectureCheck) before the schematic, else the newest that did not error. */
function newestParts(db: DatabaseSync): EstimateInput['parts'] | null {
  const cited = architectureCheck(db)
  const check = cited
    ? ((r) => (r ? { id: String(r.id), started: Number(r.started), result: json(r.result) } : null))(db.prepare('SELECT id, started, result FROM runs WHERE id=?').get(cited) as Record<string, unknown> | undefined)
    : newest(db, 'parts.bom_check')
  if (!check) return null
  const res = (check.result ?? {}) as { boards?: unknown; total?: unknown; currency?: unknown }
  const boardsMeasured = hasTable(db, 'measurements') ? (db.prepare("SELECT value FROM measurements WHERE run_id=? AND name='boards'").get(check.id) as { value?: number } | undefined)?.value : undefined
  const boards = typeof res.boards === 'number' ? res.boards : typeof boardsMeasured === 'number' ? boardsMeasured : null
  const rows = hasTable(db, 'parts_list_lines') ? db.prepare('SELECT order_code, per_board, flags, line_total FROM parts_list_lines WHERE run_id=? ORDER BY line').all(check.id) as Record<string, unknown>[] : []
  const lines = rows.map((l) => {
    const f = json(l.flags)
    return estimateLine({ lcsc: l.order_code ? String(l.order_code) : null, qty_per_board: Number(l.per_board ?? 0), flags: Array.isArray(f) ? f.map(String) : [] })
  })
  const total = typeof res.total === 'number' ? res.total : cents(rows.reduce((n, l) => n + Number(l.line_total ?? 0), 0))
  return { run: check.id, at: check.started, boards, total, currency: typeof res.currency === 'string' ? res.currency : 'USD', lines }
}

/** A parts check line as the estimate counts it: placed per board, and extended or basic at JLCPCB when known. */
export function estimateLine(l: { lcsc: string | null; qty_per_board: number; flags: readonly string[] }): EstimateInput['parts']['lines'][number] {
  return { lcsc: l.lcsc, perBoard: l.qty_per_board, extended: l.flags.includes('jlc-extended') ? true : l.flags.includes('jlc-basic') ? false : null }
}

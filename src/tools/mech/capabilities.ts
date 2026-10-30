/**
 * What JLCPCB's mechanical services can make (docs/enclosure-build.md, "Capabilities"): JLC3DP's 3D printing rules
 * and JLCCNC's machining rules, as data, each with the page it was read from and the date. JLC3DP publishes no
 * capability data or API, so the figures were typed in from its guideline pages, and `mech.capabilities_check`
 * re-reads those pages to say, figure by figure, whether each page still states it.
 *
 * Kept current automatically (./capsync.ts, the scheduled `capabilities` workflow): every day trace's own CI re-reads
 * the pages. A figure the page now states differently, in the same shape (the same words with other numbers), is
 * written to ./capabilities.updates.ts and applied here by the figure's `apply`, on a pull request a person reviews.
 * When every figure is still stated, the date is moved on by a pull request that may merge itself. A figure that
 * cannot be read, or changed in a way no `apply` covers, is never changed here: it is reported for a person, and the
 * last reviewed figure stays in force. This file is the reviewed base; ./capabilities.updates.ts is what the check
 * wrote on top of it.
 *
 * Read 29 October 2026 from:
 *   GUIDE  https://jlc3dp.com/help/article/3d-printing-design-guideline (last updated on the page 24 Aug 2026):
 *          build sizes, wall thickness by part size, assembly and moving clearances, model and hole tolerances,
 *          hole design, escape holes, snaps and fasteners, threads
 *   SERVICE https://jlc3dp.com/capabilities/3d-printing-service: general tolerances, lead time
 *   CNC    https://jlccnc.com/help/article/CNC-Machining-Design-Guideline: walls, internal radii, tolerances, threads
 *
 * The table is stale STALE_DAYS after it was last confirmed (`checked`, moved on by the scheduled check); the tools
 * say so.
 */
import { createHash } from 'node:crypto'
import { UPDATES } from './capabilities.updates.js'

export const GUIDE = 'https://jlc3dp.com/help/article/3d-printing-design-guideline'
export const SERVICE = 'https://jlc3dp.com/capabilities/3d-printing-service'
export const CNC_GUIDE = 'https://jlccnc.com/help/article/CNC-Machining-Design-Guideline'
export const SOURCES = [GUIDE, SERVICE, CNC_GUIDE] as const

/** Where a person uploads the files and pays (mech.order). */
export const UPLOAD = { jlc3dp: 'https://jlc3dp.com/3d-printing-quote', jlccnc: 'https://jlccnc.com/cnc-machining-quote' } as const

export const CHECKED = '2026-10-29'
export const STALE_DAYS = 90

export interface ProcessRow {
  service: 'jlc3dp'
  process: 'SLA' | 'MJF' | 'SLS' | 'FDM' | 'SLM'
  /** a group of materials sharing the limits below */
  group: string
  materials: string[]
  max_mm: [number, number, number]
  min_mm: [number, number, number]
  /** [largest part size up to (mm), minimum wall (mm)], ascending */
  wall_by_size: [number, number][]
  assembly_clearance_mm: number
  /** as the page words it, when it gives a range */
  assembly_clearance: string
  moving_clearance_mm: number
  tolerance: string
  hole_tolerance: string
  /** the smallest hole diameter the hole-design table allows (mm) */
  hole_min_d_mm: number
  source: string
  notes: string[]
}

export interface Capabilities {
  checked: string
  sources: readonly string[]
  processes: ProcessRow[]
  general: {
    escape_hole_min_d_mm: number
    snap_fastener_wall_min_mm: number
    min_feature: string
    min_printed_thread: string
    tolerance_best: string
    hole_accuracy: string
    lead_time: string
    source: string
    service_source: string
  }
  cnc: {
    service: 'jlccnc'
    wall_min_mm: { metal: number; plastic: number }
    wall_recommended_mm: { metal: number; plastic: number }
    corner_radius: string
    corner_radius_min_mm: number
    tolerance: string
    thread_length: string
    source: string
  }
}

const SLA = { process: 'SLA' as const, min_mm: [5, 5, 5] as [number, number, number], wall_by_size: [[5, 0.5], [10, 0.8], [50, 1.0], [100, 1.5], [200, 2.0]] as [number, number][],
  assembly_clearance_mm: 0.2, assembly_clearance: '0.2 mm', moving_clearance_mm: 0.5, tolerance: '±0.2 mm up to 100 mm, ±0.3% above', hole_tolerance: '±0.3 mm', hole_min_d_mm: 1.0 }
const NYLON = { min_mm: [5, 5, 5] as [number, number, number], wall_by_size: [[5, 1.0], [10, 1.2], [50, 1.5], [100, 2.0], [200, 2.0]] as [number, number][],
  assembly_clearance_mm: 0.2, assembly_clearance: '0.2–0.4 mm', moving_clearance_mm: 0.6, tolerance: '±0.3 mm up to 100 mm, ±0.4% above', hole_tolerance: '±0.3 mm', hole_min_d_mm: 1.5 }
const FDM = { process: 'FDM' as const, min_mm: [30, 30, 10] as [number, number, number], wall_by_size: [[5, 1.6], [10, 1.6], [50, 1.6], [100, 2.0], [200, 2.5]] as [number, number][],
  assembly_clearance_mm: 0.5, assembly_clearance: '0.5 mm', moving_clearance_mm: 0.5, tolerance: '±0.3 mm up to 100 mm, ±0.4% above', hole_tolerance: '±0.4 mm', hole_min_d_mm: 1.5 }
const FDM_NOTE = 'the guideline gives no FDM wall below 50 mm parts (FDM parts are at least 30 × 30 × 10 mm): its 1.6 mm figure is used there too'

/** The reviewed table as typed in; CAPABILITIES (at the end of this file) is it with ./capabilities.updates.ts applied. */
export const BASE_CAPABILITIES: Capabilities = {
  checked: CHECKED,
  sources: SOURCES,
  processes: [
    { service: 'jlc3dp', ...SLA, group: 'SLA resin, large build', materials: ['Ledo6060', '9600', 'Black Resin', 'JLC Black', '8001', 'CBY'], max_mm: [780, 780, 530], source: GUIDE, notes: [] },
    { service: 'jlc3dp', ...SLA, group: 'SLA resin, smaller build', materials: ['Imagine Black', '8228', 'Grey Resin', 'JLC Temp', '9000HE'], max_mm: [580, 580, 380], source: GUIDE, notes: [] },
    { service: 'jlc3dp', process: 'MJF', ...NYLON, group: 'MJF nylon', materials: ['PA12-HP', 'PA12S', 'PA11-HP'], max_mm: [370, 276, 360], source: GUIDE, notes: [] },
    { service: 'jlc3dp', process: 'MJF', ...NYLON, group: 'MJF nylon PAC', materials: ['PAC-HP'], max_mm: [320, 175, 225], source: GUIDE, notes: [] },
    { service: 'jlc3dp', process: 'SLS', ...NYLON, group: 'SLS nylon', materials: ['3201PA-F', '3301PA'], max_mm: [350, 350, 400], source: GUIDE, notes: [] },
    { service: 'jlc3dp', ...FDM, group: 'FDM, large build', materials: ['ABS', 'PA12-CF', 'PEEK'], max_mm: [580, 480, 480], source: GUIDE, notes: [FDM_NOTE] },
    { service: 'jlc3dp', ...FDM, group: 'FDM, smaller build', materials: ['ASA', 'PLA-P', 'TPU', 'PEBA'], max_mm: [250, 250, 300], source: GUIDE, notes: [FDM_NOTE] },
    {
      service: 'jlc3dp', process: 'SLM', group: 'SLM metal', materials: ['316L', 'Titanium TC4'], max_mm: [390, 290, 390], min_mm: [5, 5, 5],
      wall_by_size: [[5, 1.5], [10, 1.5], [50, 1.5], [100, 2.0], [200, 2.5]], assembly_clearance_mm: 0.5, assembly_clearance: '0.5 mm', moving_clearance_mm: 1.0,
      tolerance: '±0.3 mm up to 100 mm, ±0.4% above', hole_tolerance: '±0.5 mm', hole_min_d_mm: 1.5, source: GUIDE, notes: ['tapping is recommended for 316L parts'],
    },
  ],
  general: {
    escape_hole_min_d_mm: 2.5, snap_fastener_wall_min_mm: 1.5, min_feature: '5 × 5 × 5 mm or 10 × 2 × 2 mm',
    min_printed_thread: 'M6 (smaller screws go into pilot holes, self-tapping, not printed threads)',
    tolerance_best: '±0.2 mm', hole_accuracy: '±0.3 mm', lead_time: '48–120 h', source: GUIDE, service_source: SERVICE,
  },
  cnc: {
    service: 'jlccnc', wall_min_mm: { metal: 0.5, plastic: 1.0 }, wall_recommended_mm: { metal: 0.8, plastic: 1.5 },
    corner_radius: 'R = H / 10 + 0.5 mm for a cavity H deep; R0.5 for H <= 3 mm', corner_radius_min_mm: 0.5,
    tolerance: '±0.1 mm when none is given', thread_length: 'at most 3 × the hole diameter', source: CNC_GUIDE,
  },
}

/** The recommendation, and why: what mech.init uses when the person names no process. */
export const RECOMMENDED = { service: 'jlc3dp', process: 'MJF', material: 'PA12-HP' } as const
export const RECOMMENDED_WHY = 'MJF PA12-HP: strong and isotropic nylon, printed without supports, so a small two-part case comes out'
  + ' dimensionally even with no support marks; it fits small enclosures within its 370 × 276 × 360 mm build, with 0.2–0.4 mm'
  + ' assembly clearance and ±0.3 mm tolerance up to 100 mm (JLC3DP\'s design guideline).'

/** The row for a service, process and material (case-insensitive), or null. CNC has no row: see `cnc`. */
export function processRow(p: { service: string; process: string; material: string }, caps: Capabilities = CAPABILITIES): ProcessRow | null {
  const lc = (s: string): string => s.toLowerCase()
  return caps.processes.find((r) => lc(r.service) === lc(p.service) && lc(r.process) === lc(p.process) && r.materials.some((m) => lc(m) === lc(p.material))) ?? null
}

export const isCnc = (p: { service: string; process: string }): boolean => p.service.toLowerCase() === 'jlccnc' || p.process.toLowerCase().startsWith('cnc')

/** The minimum wall for a part whose largest size is `size_mm`. */
export function minWall(row: ProcessRow, size_mm: number): number {
  for (const [limit, wall] of row.wall_by_size) if (size_mm <= limit) return wall
  return (row.wall_by_size[row.wall_by_size.length - 1] as [number, number])[1]
}

/** How old the table is, and whether that is past STALE_DAYS. */
export function staleness(now: Date = new Date(), caps: Capabilities = CAPABILITIES): { checked: string; age_days: number; stale: boolean; stale_after_days: number } {
  const age = Math.floor((now.getTime() - Date.parse(`${caps.checked}T00:00:00Z`)) / 86_400_000)
  return { checked: caps.checked, age_days: age, stale: age > STALE_DAYS, stale_after_days: STALE_DAYS }
}

/** The capabilities as the engine reads them (capabilities.json): the contract's shape, rows with their limits. */
export function engineCapabilities(caps: Capabilities = CAPABILITIES): Record<string, unknown> {
  return {
    checked: caps.checked,
    processes: caps.processes.map((r) => ({
      service: r.service, process: r.process, materials: r.materials, max_mm: r.max_mm, min_mm: r.min_mm, wall_by_size: r.wall_by_size,
      assembly_clearance_mm: r.assembly_clearance_mm, moving_clearance_mm: r.moving_clearance_mm, tolerance: r.tolerance,
      hole_tolerance: r.hole_tolerance, hole_min_d_mm: r.hole_min_d_mm, source: r.source,
    })),
    general: caps.general,
    cnc: caps.cnc,
  }
}

// ------------------------------------------------------------------ re-reading the pages

/**
 * Each stored figure as a page states it: the page, a label near it, and the figure's text. A figure is `same` when
 * the text follows one of the label's appearances within WINDOW characters (whitespace ignored), `changed` when the
 * label is there but the figure is not, `unreadable` when the page or the label cannot be read. For a figure with
 * numbers, only the first run of the same shape after the label counts (figureMatch): the next row of a table, often
 * with the same numbers, cannot stand in for this one.
 */
export interface Figure {
  id: string
  page: string
  label: string
  text: string
  within?: number
  /** which text of the figure's shape after the label this figure is, when the row states several (0: the first) */
  nth?: number
  /**
   * which appearance of the label on the page this figure follows (0: the first), when the label appears again
   * before other figures (a table's column header, say). Unset: every appearance, and the check reports a change as
   * ambiguous when they disagree. A page that adds an earlier appearance shifts it: the pull request shows the stored
   * and found figures side by side for the reviewer
   */
  occurrence?: number
  /**
   * Puts the numbers of the figure's text, in order, into the table (a copy). Present only where a change of those
   * numbers can be written back safely: a figure without one that changes is reported for a person. Throws when the
   * numbers do not fit (their count, or no row to put them in).
   */
  apply?: (caps: Capabilities, nums: readonly number[]) => void
}

export const WINDOW = 160

function need(nums: readonly number[], n: number): void {
  if (nums.length !== n) throw new Error(`expected ${n} numbers, found ${nums.length}`)
  if (nums.some((x) => !Number.isFinite(x) || x <= 0)) throw new Error('a number is not positive')
}
const triple = (nums: readonly number[]): [number, number, number] => [nums[0] as number, nums[1] as number, nums[2] as number]
function rows(caps: Capabilities, pick: (r: ProcessRow) => boolean, what: string): ProcessRow[] {
  const out = caps.processes.filter(pick)
  if (!out.length) throw new Error(`no row for ${what}`)
  return out
}
const ofProcess = (caps: Capabilities, p: ProcessRow['process']): ProcessRow[] => rows(caps, (r) => r.process === p, p)
/** The wall table's sizes kept, its walls replaced (a new array: rows share their spread-in tables). */
const walls = (r: ProcessRow, w: readonly number[]): [number, number][] => r.wall_by_size.map(([size], i) => [size, w[i] as number])
const mm = (n: number): string => `±${n} mm`

/** A build size: `material` is the table's name for the material the page's label names. */
const build = (m: string, size: string, material: string = m): Figure => ({
  id: `max_mm.${m}`, page: GUIDE, label: m, text: size,
  apply: (c, n) => { need(n, 3); for (const r of rows(c, (x) => x.materials.includes(material), material)) r.max_mm = triple(n) },
})
// the wall table's row is the label's first appearance; the clearance table's column header is a later one
const wallFigure = (p: 'SLA' | 'MJF' | 'SLS' | 'SLM', label: string, text: string): Figure => ({
  id: `wall_by_size.${p}`, page: GUIDE, label, text, occurrence: 0,
  apply: (c, n) => { need(n, 5); for (const r of ofProcess(c, p)) r.wall_by_size = walls(r, n) },
})
const tolerance = (p: 'SLA' | 'MJF', label: string, text: string, within: number): Figure => ({
  id: `tolerance.${p}`, page: GUIDE, label, text, within,
  apply: (c, n) => { need(n, 4); for (const r of ofProcess(c, p)) r.tolerance = `±${n[0]} mm up to ${n[1]} mm, ±${n[2]}% above` },
})

export const BASE_FIGURES: readonly Figure[] = [
  ...['Ledo6060', '9600', 'JLC Black', 'CBY'].map((m) => build(m, '780 × 780 × 530')),
  ...['Imagine Black', '8228', 'Grey Resin', 'JLC Temp', '9000HE'].map((m) => build(m, '580 × 580 × 380')),
  build('PA12', '370 × 276 × 360', 'PA12-HP'), build('PA12S', '370 × 276 × 360'), build('PA11', '370 × 276 × 360', 'PA11-HP'), build('PAC', '320 × 175 × 225', 'PAC-HP'),
  build('3201PA-F', '350 × 350 × 400'), build('3301PA', '350 × 350 × 400'),
  build('316L Stainless Steel', '390 × 290 × 390', '316L'), build('Titanium TC4', '390 × 290 × 390'),
  build('ABS', '580 × 480 × 480'), build('PA12-CF', '580 × 480 × 480'), build('PEEK', '580 × 480 × 480'),
  build('ASA', '250 × 250 × 300'), build('TPU', '250 × 250 × 300'), build('PEBA', '250 × 250 × 300'),
  // the row states the build size first, then the smallest part: the second text of that shape
  { id: 'min_mm.FDM', page: GUIDE, label: 'FDM (Plastic) ABS', text: '30 × 30 × 10', nth: 1, apply: (c, n) => { need(n, 3); for (const r of ofProcess(c, 'FDM')) r.min_mm = triple(n) } },
  wallFigure('SLA', 'Resin (SLA)', '0.5mm 0.8mm 1.0mm 1.5mm 2.0mm'),
  wallFigure('MJF', 'Nylon (MJF)', '1.0mm 1.2mm 1.5mm 2.0mm 2.0mm'),
  wallFigure('SLS', 'Nylon (SLS)', '1.0mm 1.2mm 1.5mm 2.0mm 2.0mm'),
  wallFigure('SLM', 'Metal (SLM)', '1.5mm 1.5mm 1.5mm 2.0mm 2.5mm'),
  {
    // the page gives no FDM wall below 50 mm parts; the smallest one it gives is used there too (FDM_NOTE)
    id: 'wall_by_size.FDM', page: GUIDE, label: 'Plastic (FDM)', text: '/ / 1.6mm 2.0mm 2.5mm',
    apply: (c, n) => { need(n, 3); for (const r of ofProcess(c, 'FDM')) r.wall_by_size = walls(r, [n[0] as number, n[0] as number, ...n]) },
  },
  { id: 'snap_fastener_wall_min_mm', page: GUIDE, label: 'snaps and fasteners', text: 'more than 1.5mm', apply: (c, n) => { need(n, 1); c.general.snap_fastener_wall_min_mm = n[0] as number } },
  { id: 'assembly_clearance', page: GUIDE, label: 'Clearance between parts that will be assembled together', text: 'Minimum Clearance 0.2mm 0.2mm-0.4mm 0.2mm-0.4mm 0.5mm 0.5mm 0.5mm', within: 400 },
  { id: 'moving_clearance', page: GUIDE, label: 'Clearance between moving parts', text: 'Minimum Clearance 0.5mm 0.6mm 0.6mm 1.0mm 1.0mm 0.5mm', within: 400 },
  {
    id: 'min_printed_thread', page: GUIDE, label: 'minimum recommended thread', text: 'M6',
    apply: (c, n) => { need(n, 1); c.general.min_printed_thread = c.general.min_printed_thread.replace(/^M\d+(\.\d+)?/, `M${n[0]}`) },
  },
  { id: 'escape_hole_min_d_mm', page: GUIDE, label: 'minimum escape hole diameter', text: '2.5mm', apply: (c, n) => { need(n, 1); c.general.escape_hole_min_d_mm = n[0] as number } },
  { id: 'hole_min_d_mm.SLA', page: GUIDE, label: 'Resin (SLA) h=', text: '1.0—3.0mm', within: 20, occurrence: 0, apply: (c, n) => { need(n, 2); for (const r of ofProcess(c, 'SLA')) r.hole_min_d_mm = n[0] as number } },
  { id: 'hole_min_d_mm.MJF', page: GUIDE, label: 'Nylon (MJF) /', text: 'h=1.5—4.5mm', within: 20, occurrence: 0, apply: (c, n) => { need(n, 2); for (const r of ofProcess(c, 'MJF')) r.hole_min_d_mm = n[0] as number } },
  tolerance('SLA', 'Model Tolerances', 'Resin (SLA) : ±0.2mm (Within 100mm), ±0.3% (Above 100mm)', 60),
  tolerance('MJF', 'Nylon (MJF) :', '±0.3mm (Within 100mm), ±0.4% (Above 100mm)', 10),
  {
    id: 'hole_tolerance.SLA', page: GUIDE, label: 'Hole Tolerances', text: 'Resin (SLA) : ±0.3mm Nylon (MJF) : ±0.3mm Nylon (SLS) : ±0.3mm Plastic (FDM) : ±0.4mm Metal (SLM) : ±0.5mm', within: 30,
    apply: (c, n) => {
      need(n, 5)
      ;(['SLA', 'MJF', 'SLS', 'FDM', 'SLM'] as const).forEach((p, i) => { for (const r of ofProcess(c, p)) r.hole_tolerance = mm(n[i] as number) })
    },
  },
  { id: 'general.lead_time', page: SERVICE, label: 'Standard Lead Time', text: '48h-120h', apply: (c, n) => { need(n, 2); c.general.lead_time = `${n[0]}–${n[1]} h` } },
  { id: 'general.tolerance_best', page: SERVICE, label: 'Tolerance (Best)', text: '±0.2mm', apply: (c, n) => { need(n, 1); c.general.tolerance_best = mm(n[0] as number) } },
  { id: 'general.hole_accuracy', page: SERVICE, label: 'Minimum Hole Accuracy', text: '±0.3mm', apply: (c, n) => { need(n, 1); c.general.hole_accuracy = mm(n[0] as number) } },
  // the corner radius formula and its minimum are what the engine's CNC rule computes (python/tracebridge/mech), not
  // read from this table: a change there is a code change, so these two have no apply and are reported for a person
  { id: 'cnc.corner_radius', page: CNC_GUIDE, label: 'the formula is given as', text: 'R=(H/10)+0.5' },
  { id: 'cnc.corner_radius_min_mm', page: CNC_GUIDE, label: 'minimum internal radius of', text: 'R 0.5 (mm) with a depth of ≤3 (mm)' },
  {
    id: 'cnc.wall', page: CNC_GUIDE, label: 'recommended wall thickness of metal parts', text: 'should be 0.8 mm (absolute minimum 0.5 mm), and 1.5 mm (absolute minimum 1 mm) for plastic parts',
    apply: (c, n) => {
      need(n, 4)
      c.cnc.wall_recommended_mm = { metal: n[0] as number, plastic: n[2] as number }
      c.cnc.wall_min_mm = { metal: n[1] as number, plastic: n[3] as number }
    },
  },
  { id: 'cnc.tolerance', page: CNC_GUIDE, label: 'standard tolerance', text: '±0.1mm', apply: (c, n) => { need(n, 1); c.cnc.tolerance = c.cnc.tolerance.replace(/^±[\d.]+ ?mm/, mm(n[0] as number)) } },
  { id: 'cnc.thread_length', page: CNC_GUIDE, label: 'thread length is recommended not to exceed', text: 'three times of the hole diameter' },
]

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", times: '×', plusmn: '±', le: '≤', mdash: '—', ndash: '–' }

/** A page's HTML as plain text: scripts and styles dropped, tags as spaces, entities decoded, whitespace collapsed. */
export function pageText(html: string): string {
  return html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m))
    .replace(/\s+/g, ' ').trim()
}

const squash = (s: string): string => s.replace(/\s+/g, '').toLowerCase()
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export type FigureStatus = 'same' | 'changed' | 'unreadable'

/** A pattern for `s` that ignores case and spacing; with `free`, each number in it may be any other number. */
function looseRe(s: string, free: boolean): string {
  let out = ''
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)|(\s+)|([\s\S])/g)) {
    if (m[1] !== undefined) out += free ? '(?<!\\d)(?<!\\d\\.)\\d+(?:\\.\\d+)?(?!\\d)(?!\\.\\d)' : `${escapeRe(m[1])}(?!\\d)`
    else if (m[2] !== undefined) out += '\\s*'
    else out += `${escapeRe(m[3] as string)}\\s*`
  }
  return out
}

/**
 * After each of the label's appearances (case and spacing ignored; a label ending in a letter or digit as a whole
 * word), the first text of the figure's shape: its stored
 * words with each number free to be another, a whole number each time (a table's next cell is not run into it).
 * Empty when the figure has no numbers, or nothing of that shape follows the label within its window; null when the
 * label is not on the page. `nth` picks a later text of the shape, for a row that states several.
 */
export function figureMatches(f: Figure, text: string): string[] | null {
  // a label that ends in a letter or digit is a whole word: "PA12" is not the start of "PA12-HP" or "PA12-CF"
  const label = new RegExp(looseRe(f.label, false) + (/[a-z0-9]$/i.test(f.label) ? '(?![a-z0-9-])' : ''), 'gi')
  const shape = new RegExp(looseRe(f.text, true), 'gi')
  const within = (f.within ?? WINDOW) + 2 * f.text.length + 8
  const out: string[] = []
  let seen = false
  let k = -1
  for (const l of text.matchAll(label)) {
    seen = true
    k++
    if (!/\d/.test(f.text) || (f.occurrence !== undefined && k !== f.occurrence)) continue
    const from = (l.index ?? 0) + l[0].length
    const m = [...text.slice(from, from + within).matchAll(shape)][f.nth ?? 0]
    if (m) out.push(m[0].trim())
  }
  return seen ? out : null
}

/** Whether `text` (a page's plain text, or null when it could not be fetched) still states the figure. */
export function figureStatus(f: Figure, text: string | null): FigureStatus {
  if (text === null) return 'unreadable'
  const matches = figureMatches(f, text)
  if (matches === null) return 'unreadable'
  const want = squash(f.text)
  if (/\d/.test(f.text)) return matches.some((m) => squash(m) === want) ? 'same' : 'changed'
  const t = squash(text)
  const label = squash(f.label)
  const within = (f.within ?? WINDOW) + want.length
  for (let at = t.indexOf(label); at >= 0; at = t.indexOf(label, at + 1)) {
    if (t.slice(at + label.length, at + label.length + within).includes(want)) return 'same'
  }
  return 'changed'
}

// ------------------------------------------------------------------ the table with the scheduled check's updates

/** What the scheduled check wrote on top of the reviewed table (./capabilities.updates.ts). */
export interface CapabilityUpdates {
  /** the day every figure was last found stated on its page (null: the base table's CHECKED stands) */
  checked: string | null
  /** each figure the pages now state differently: the text as found, and the day it was read */
  figures: Record<string, { text: string; read: string }>
}

/** The numbers in a figure's text, in order ("0.5mm 0.8mm" → [0.5, 0.8]; "1.0—3.0mm" → [1, 3]). */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]))
}

/**
 * The base table with `u` applied: each updated figure's numbers put in by its `apply`, and `checked` moved on. A
 * figure id that is not known, or has no `apply`, is an error: ./capsync.ts never writes one.
 */
export function withUpdates(base: Capabilities, u: CapabilityUpdates, figures: readonly Figure[] = BASE_FIGURES): Capabilities {
  const caps = structuredClone(base)
  for (const [id, f] of Object.entries(u.figures)) {
    const fig = figures.find((x) => x.id === id)
    if (!fig?.apply) throw new Error(`capabilities.updates.ts: no figure ${id} with an apply`)
    fig.apply(caps, numbersIn(f.text))
  }
  if (u.checked && u.checked > caps.checked) caps.checked = u.checked
  return caps
}

/** The figures as the pages last stated them: an updated figure's text is what the check found. */
export function currentFigures(figures: readonly Figure[], u: CapabilityUpdates): Figure[] {
  return figures.map((f) => (u.figures[f.id] ? { ...f, text: u.figures[f.id]!.text } : f))
}

export const CAPABILITIES: Capabilities = withUpdates(BASE_CAPABILITIES, UPDATES)
export const FIGURES: readonly Figure[] = currentFigures(BASE_FIGURES, UPDATES)

/**
 * A stamp of the figures the engine reads, without the date: a build is stale when these change (src/tools/mech/stale.ts),
 * not when the scheduled check only confirms them again.
 */
export function capabilitiesStamp(caps: Capabilities = CAPABILITIES): string {
  const { checked: _checked, ...figures } = engineCapabilities(caps) as Record<string, unknown> & { checked: unknown }
  return createHash('sha256').update(JSON.stringify(figures)).digest('hex').slice(0, 16)
}

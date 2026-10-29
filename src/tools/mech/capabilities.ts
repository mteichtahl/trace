/**
 * What JLCPCB's mechanical services can make (docs/enclosure-build.md, "Capabilities"): JLC3DP's 3D printing rules
 * and JLCCNC's machining rules, as data, each with the page it was read from and the date. JLC3DP publishes no
 * capability data or API, so the figures are typed in from its guideline pages, and `mech.capabilities_check`
 * re-reads those pages to say, figure by figure, whether each page still states it. Nothing here is changed
 * automatically: a changed figure is a person's edit to this file, with the new date.
 *
 * Read 29 October 2026 from:
 *   GUIDE  https://jlc3dp.com/help/article/3d-printing-design-guideline (last updated on the page 24 Aug 2026):
 *          build sizes, wall thickness by part size, assembly and moving clearances, model and hole tolerances,
 *          hole design, escape holes, snaps and fasteners, threads
 *   SERVICE https://jlc3dp.com/capabilities/3d-printing-service: general tolerances, lead time
 *   CNC    https://jlccnc.com/help/article/CNC-Machining-Design-Guideline: walls, internal radii, tolerances, threads
 *
 * The table is stale STALE_DAYS after it was read; the tools say so, and a person re-checks it.
 */

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

export const CAPABILITIES: Capabilities = {
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
 * label is there but the figure is not, `unreadable` when the page or the label cannot be read.
 */
export interface Figure { id: string; page: string; label: string; text: string; within?: number }

export const WINDOW = 160

const build = (m: string, size: string): Figure => ({ id: `max_mm.${m}`, page: GUIDE, label: m, text: size })

export const FIGURES: readonly Figure[] = [
  ...['Ledo6060', '9600', 'JLC Black', 'CBY'].map((m) => build(m, '780 × 780 × 530')),
  ...['Imagine Black', '8228', 'Grey Resin', 'JLC Temp', '9000HE'].map((m) => build(m, '580 × 580 × 380')),
  build('PA12', '370 × 276 × 360'), build('PA12S', '370 × 276 × 360'), build('PA11', '370 × 276 × 360'), build('PAC', '320 × 175 × 225'),
  build('3201PA-F', '350 × 350 × 400'), build('3301PA', '350 × 350 × 400'),
  build('316L Stainless Steel', '390 × 290 × 390'), build('Titanium TC4', '390 × 290 × 390'),
  build('ABS', '580 × 480 × 480'), build('PA12-CF', '580 × 480 × 480'), build('PEEK', '580 × 480 × 480'),
  build('ASA', '250 × 250 × 300'), build('TPU', '250 × 250 × 300'), build('PEBA', '250 × 250 × 300'),
  { id: 'min_mm.FDM', page: GUIDE, label: 'FDM (Plastic) ABS', text: '30 × 30 × 10' },
  { id: 'wall_by_size.SLA', page: GUIDE, label: 'Resin (SLA)', text: '0.5mm 0.8mm 1.0mm 1.5mm 2.0mm' },
  { id: 'wall_by_size.MJF', page: GUIDE, label: 'Nylon (MJF)', text: '1.0mm 1.2mm 1.5mm 2.0mm 2.0mm' },
  { id: 'wall_by_size.SLS', page: GUIDE, label: 'Nylon (SLS)', text: '1.0mm 1.2mm 1.5mm 2.0mm 2.0mm' },
  { id: 'wall_by_size.SLM', page: GUIDE, label: 'Metal (SLM)', text: '1.5mm 1.5mm 1.5mm 2.0mm 2.5mm' },
  { id: 'wall_by_size.FDM', page: GUIDE, label: 'Plastic (FDM)', text: '/ / 1.6mm 2.0mm 2.5mm' },
  { id: 'snap_fastener_wall_min_mm', page: GUIDE, label: 'snaps and fasteners', text: 'more than 1.5mm' },
  { id: 'assembly_clearance', page: GUIDE, label: 'Clearance between parts that will be assembled together', text: 'Minimum Clearance 0.2mm 0.2mm-0.4mm 0.2mm-0.4mm 0.5mm 0.5mm 0.5mm', within: 400 },
  { id: 'moving_clearance', page: GUIDE, label: 'Clearance between moving parts', text: 'Minimum Clearance 0.5mm 0.6mm 0.6mm 1.0mm 1.0mm 0.5mm', within: 400 },
  { id: 'min_printed_thread', page: GUIDE, label: 'minimum recommended thread', text: 'M6' },
  { id: 'escape_hole_min_d_mm', page: GUIDE, label: 'minimum escape hole diameter', text: '2.5mm' },
  { id: 'hole_min_d_mm.SLA', page: GUIDE, label: 'Resin (SLA) h=', text: '1.0—3.0mm', within: 20 },
  { id: 'hole_min_d_mm.MJF', page: GUIDE, label: 'Nylon (MJF) /', text: 'h=1.5—4.5mm', within: 20 },
  { id: 'tolerance.SLA', page: GUIDE, label: 'Model Tolerances', text: 'Resin (SLA) : ±0.2mm (Within 100mm), ±0.3% (Above 100mm)', within: 60 },
  { id: 'tolerance.MJF', page: GUIDE, label: 'Nylon (MJF) :', text: '±0.3mm (Within 100mm), ±0.4% (Above 100mm)', within: 10 },
  { id: 'hole_tolerance.SLA', page: GUIDE, label: 'Hole Tolerances', text: 'Resin (SLA) : ±0.3mm Nylon (MJF) : ±0.3mm Nylon (SLS) : ±0.3mm Plastic (FDM) : ±0.4mm Metal (SLM) : ±0.5mm', within: 30 },
  { id: 'general.lead_time', page: SERVICE, label: 'Standard Lead Time', text: '48h-120h' },
  { id: 'general.tolerance_best', page: SERVICE, label: 'Tolerance (Best)', text: '±0.2mm' },
  { id: 'general.hole_accuracy', page: SERVICE, label: 'Minimum Hole Accuracy', text: '±0.3mm' },
  { id: 'cnc.corner_radius', page: CNC_GUIDE, label: 'the formula is given as', text: 'R=(H/10)+0.5' },
  { id: 'cnc.corner_radius_min_mm', page: CNC_GUIDE, label: 'minimum internal radius of', text: 'R 0.5 (mm) with a depth of ≤3 (mm)' },
  { id: 'cnc.wall', page: CNC_GUIDE, label: 'recommended wall thickness of metal parts', text: 'should be 0.8 mm (absolute minimum 0.5 mm), and 1.5 mm (absolute minimum 1 mm) for plastic parts' },
  { id: 'cnc.tolerance', page: CNC_GUIDE, label: 'standard tolerance', text: '±0.1mm' },
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

export type FigureStatus = 'same' | 'changed' | 'unreadable'

/** Whether `text` (a page's plain text, or null when it could not be fetched) still states the figure. */
export function figureStatus(f: Figure, text: string | null): FigureStatus {
  if (text === null) return 'unreadable'
  const t = squash(text)
  const label = squash(f.label)
  const want = squash(f.text)
  const within = (f.within ?? WINDOW) + want.length
  let at = t.indexOf(label)
  if (at < 0) return 'unreadable'
  while (at >= 0) {
    if (t.slice(at + label.length, at + label.length + within).includes(want)) return 'same'
    at = t.indexOf(label, at + 1)
  }
  return 'changed'
}

/**
 * Starting a project from fabrication files (docs/fab-import.md), the app's side, pure so the screen and its tests
 * share it: the three files and what each takes, cutting a file into the parts projects.import_upload takes, the
 * inspection's answer (projects.import_check) in the words the step shows, and the step's checks for the quality bar.
 */
import type { FabDraft } from '@/lib/types-s1'

export type FabFile = 'source' | 'gerbers' | 'bom' | 'cpl'
export type Severity = 'blocking' | 'warning' | 'note'
export type Entry = 'fabricate' | 'bringup'

/** What projects.import_check answers (src/tools/fab/inspect.ts inspectionView, with the files' sizes). */
export interface FabCheck {
  upload: string
  sizes: Record<FabFile, number | null>
  ok: boolean
  summary: {
    board: { layers: number; width_mm: number | null; height_mm: number | null; thickness_mm: number | null; finish: string | null; impedance: boolean | null; smallest_hole_mm: number | null; holes: number }
    tool: string | null
    project: { name: string | null; revision: string | null }
    files: number
    source: { files: number; schematics: number; layouts: number; netlists: number; tool: string | null }
    bom: { lines: number; parts: number; with_lcsc: number; basic: number; extended: number; out_of_stock: number }
    placements: { total: number; top: number; bottom: number; hand_placed: number }
    overview: { chars: number; topics: number; of: number }
  }
  overview: { chars: number; topics: { id: string; title: string; found: boolean; ask: string }[]; found: number; ok: boolean }
  findings: { id: string; severity: Severity; file: FabFile | 'overview'; text: string; fix: string; refs?: string[] }[]
  hand_placed: string[]
  /** the design files the zip held, by kind */
  source_files: { path: string; kind: string; bytes: number }[]
  order_options: { group: 'pcb' | 'pcba'; option: string; value: string; source: string; decided: boolean }[]
  recommended: { entry: Entry; why: string }
  layers: { name: string; kind: string; side: string | null; layer: number | null; bytes: number }[]
}

const MB = 1024 * 1024
/** What each file is, what it takes, and its limit (src/api/actions-import.ts IMPORT_MAX). */
export const FAB_FILES: readonly { id: FabFile; title: string; detail: string; accept: string; max: number; example: string; optional: boolean }[] = [
  { id: 'source', title: 'Design files', detail: 'Schematics, layouts and net lists, zipped together', accept: '.zip', max: 25 * MB, example: 'board-design.zip', optional: false },
  { id: 'gerbers', title: 'Gerbers', detail: 'Every layer and the drill files, zipped together', accept: '.zip', max: 25 * MB, example: 'board-gerbers.zip', optional: true },
  { id: 'bom', title: 'Bill of materials', detail: 'A CSV with designators, values and LCSC parts', accept: '.csv', max: 2 * MB, example: 'board-bom-jlc.csv', optional: true },
  { id: 'cpl', title: 'Pick and place', detail: 'A CSV with each part\'s position, side and rotation', accept: '.csv', max: 2 * MB, example: 'board-cpl-jlc.csv', optional: true },
]
/** One request's part: 3 MB, so as base64 with the rest it stays under the web firewall's 5,000,000 bytes. */
export const PART = 3 * MB
export const MIN_OVERVIEW = 300
export const MAX_OVERVIEW = 40_000

export const mb = (n: number): string => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / MB).toFixed(1)} MB`)

/** A file the step will not take, in words, or null. Pure. */
export function fileRefusal(file: FabFile, name: string, size: number): string | null {
  const f = FAB_FILES.find((x) => x.id === file)!
  if (!name.toLowerCase().endsWith(f.accept)) return file === 'gerbers' ? 'Zip the Gerber and drill files together and give the .zip.' : file === 'source' ? 'Zip the schematic, layout and net list files together and give the .zip.' : 'Give it as a .csv file.'
  if (size === 0) return 'The file is empty.'
  if (size > f.max) return `It is ${mb(size)}; the ${f.title.toLowerCase()} is at most ${mb(f.max)}.`
  return null
}

/**
 * Which file a dropped one is, from its name: a zip naming its design, source, KiCad, schematics or board is the design
 * files, any other zip the Gerbers, a CSV naming placement is the pick and place. Pure.
 */
export function guessFile(name: string): FabFile | null {
  const n = name.toLowerCase()
  if (n.endsWith('.zip')) return /gerber|gbr|fab|jlc/.test(n) ? 'gerbers' : /source|design|kicad|schem|\bsch\b|\bpcb\b|project/.test(n) ? 'source' : 'gerbers'
  if (!n.endsWith('.csv')) return null
  if (/cpl|pos|placement|pick|centroid|xy/.test(n)) return 'cpl'
  if (/bom|bill|materials|parts/.test(n)) return 'bom'
  return null
}

/** The parts a file is sent in. Pure. */
export function partsOf(bytes: Uint8Array, size: number = PART): Uint8Array[] {
  const n = Math.max(1, Math.ceil(bytes.length / size))
  return Array.from({ length: n }, (_, i) => bytes.subarray(i * size, (i + 1) * size))
}

/** A new upload id for a draft (what projects.import_upload keys the parts by). */
export const newUpload = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)

export const blankFab = (): FabDraft => ({ upload: newUpload(), overview: '', built: false, files: {} })

/** The board in one line: "A 10-layer board, 200 × 160 mm, 1.6 mm thick, ENIG". Pure. */
export function boardWords(s: FabCheck['summary']): string {
  const b = s.board
  return [
    `A ${b.layers}-layer board`,
    b.width_mm !== null && b.height_mm !== null ? `${b.width_mm} × ${b.height_mm} mm` : null,
    b.thickness_mm !== null ? `${b.thickness_mm} mm thick` : null,
    b.finish && b.finish !== 'None' ? b.finish : null,
    b.impedance ? 'impedance controlled' : null,
  ].filter(Boolean).join(', ')
}

/** The parts in one line: "133 BOM lines (774 parts), 774 placements: 675 top, 99 bottom". Pure. */
export function partsWords(s: FabCheck['summary']): string {
  const p = s.placements
  return `${s.bom.lines} BOM lines (${s.bom.parts} parts), ${p.total} placements${p.top && p.bottom ? `: ${p.top} top, ${p.bottom} bottom` : p.bottom ? ', all on the bottom' : ''}`
}

/** "2 warnings, 1 note" or "No problems found". Pure. */
export function countWords(c: Pick<FabCheck, 'findings'>): string {
  const n = (s: Severity) => c.findings.filter((f) => f.severity === s).length
  const words = [
    [n('blocking'), 'problem to fix', 'problems to fix'],
    [n('warning'), 'warning', 'warnings'],
    [n('note'), 'note', 'notes'],
  ].filter(([k]) => (k as number) > 0).map(([k, one, many]) => `${k} ${k === 1 ? one : many}`)
  return words.length ? words.join(', ') : 'No problems found'
}

/** The stages an import at `entry` signs on its evidence, by name (the Board template's order). Pure. */
export function signedBefore(entry: Entry): string[] {
  const order = ['Define', 'Architect', 'Capture', 'Prove', 'Layout', 'Sign-off', 'Release', 'Fabricate']
  const upto = entry === 'fabricate' ? 'Fabricate' : 'Bring up'
  const i = order.indexOf(upto)
  // Release has no gate: it is passed with the stage before it
  return (i < 0 ? order : order.slice(0, i)).filter((s) => s !== 'Release')
}

export const ENTRY_WORDS: Readonly<Record<Entry, { title: string; detail: string }>> = {
  fabricate: { title: 'Fabricate', detail: 'The boards are not made yet: trace prepares the JLCPCB order from these files and checks stock again today.' },
  bringup: { title: 'Bring up', detail: 'The boards are built: their bench results become revision A\'s first evidence.' },
}

/** The design files' content in one line: "1 schematic, 1 board layout, 0 net lists, from KiCad". Pure. */
export function sourceWords(s: FabCheck['summary']): string {
  const n = (k: number, one: string): string => `${k} ${one}${k === 1 ? '' : 's'}`
  return `${n(s.source.schematics, 'schematic')}, ${n(s.source.layouts, 'board layout')}, ${n(s.source.netlists, 'net list')}${s.source.tool ? `, from ${s.source.tool}` : ''}`
}

/** The step's checks for the quality bar: design files or Gerbers, the overview, and a check with nothing blocking. Pure. */
export function fabChecks(fab: FabDraft | undefined, check: FabCheck | undefined): { id: string; text: string; ok: boolean }[] {
  const f = fab ?? { upload: '', overview: '', built: false, files: {} }
  const design = !!(f.files.source || f.files.gerbers)
  const current = check && check.upload === f.upload
  return [
    { id: 'fab-files', text: 'Design files or Gerbers given (BOM and pick and place are optional)', ok: design },
    { id: 'fab-overview', text: current ? `Overview covers ${check.overview.found} of ${check.overview.topics.length} topics` : 'Overview covers at least 4 topics', ok: !!current && check.overview.ok },
    { id: 'fab-check', text: 'Files checked, nothing to fix', ok: !!current && check.ok && design },
  ]
}

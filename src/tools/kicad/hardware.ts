/**
 * The panel and mounting hardware list: the things a build needs that the board assembler does not fit, kept as a
 * list of its own beside the parts list (BOM), and produced only when asked for (kicad.bom / kicad.fab `hardware`).
 *
 * Where each line comes from:
 *   case       the newest case build's records (mechanical/out/case.jsonld): one line per case part (base, lid, tube,
 *              end plates; made at JLC3DP or JLCCNC) and the screws that hold the board, grouped by size and length.
 *   board      no case build: one screw line per mounting-hole size on the board (the case engine's table, hole
 *              diameter → M2 / M2.5 / M3 / M4), length left open since it depends on what the board is fixed to.
 *   schematic  parts a designer marked as hardware: a `Hardware` field of "panel" or "mounting" (any case), or a
 *              reference starting MP (KiCad's prefix for mechanical parts). These are kept out of the main BOM (its
 *              `excluded`, reason "hardware") whether or not the hardware list is asked for, so the assembler is never
 *              sent a knob, a panel nut or a standoff.
 *
 * Mounting-hole footprints and symbols themselves are holes, not things to buy, and are never lines.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { toCsv } from './bom.js'
import { lcscOf, manufacturerOf, mpnOf, naturalCompare, type Symbol } from './schematic.js'

export type HardwareKind = 'panel' | 'mounting'
export type HardwareSource = 'case' | 'board' | 'schematic'

export interface HardwareLine {
  quantity: number
  /** what it is, in plain words ("M2.5 pan head screw, 6 mm", "Case lid") */
  item: string
  /** panel: the case and what goes on its faces (knobs, nuts, labels); mounting: what holds the board */
  kind: HardwareKind
  size: string | null
  length_mm: number | null
  /** where it goes: the mounting holes or parts it serves, the case part's name */
  refs: string[]
  mpn: string | null
  manufacturer: string | null
  lcsc: string | null
  source: HardwareSource
  note: string | null
}

export interface Hardware {
  lines: HardwareLine[]
  total_items: number
  /** whether a case build was read (mechanical/out/case.jsonld) */
  case_built: boolean
  /** the case build was for another version of the board: rebuild it (mech.build) before ordering */
  case_stale: boolean
  notes: string[]
}

/** Mounting-hole diameter (mm, below which) → screw size: the case engine's table (python/tracebridge/mech/shell.py SCREWS). */
const SCREWS: readonly (readonly [number, string])[] = [[2.5, 'M2'], [3.0, 'M2.5'], [3.6, 'M3'], [Infinity, 'M4']]
export const screwFor = (d: number): string => (SCREWS.find(([lim]) => d < lim) as readonly [number, string])[1]

/** A part the designer marked as hardware, and which kind; null for an ordinary part. */
export function hardwareKindOf(s: Symbol): HardwareKind | null {
  const f = Object.entries(s.fields).find(([k]) => k.trim().toLowerCase() === 'hardware')?.[1]?.trim().toLowerCase()
  if (f === 'panel' || f === 'mounting') return f
  if (/^MP\d/i.test(s.ref)) return f === 'panel' ? 'panel' : 'mounting'
  return null
}

const PART_NAMES: Record<string, string> = {
  base: 'Case base', lid: 'Case lid', case: 'Case', tube: 'Case tube', 'end-west': 'Case end plate (west)', 'end-east': 'Case end plate (east)',
}

type Node = Record<string, unknown> & { '@id'?: string; '@type'?: string | string[] }
const isType = (n: Node, t: string): boolean => (Array.isArray(n['@type']) ? n['@type'].includes(t) : n['@type'] === t)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const idOf = (v: unknown): string | null => (v && typeof v === 'object' ? str((v as Node)['@id']) : str(v))

/** The newest case build's records, from the repository's mechanical/out/case.jsonld, or null without one. */
export function readCaseRecords(repoRoot: string | null): Node[] | null {
  if (!repoRoot) return null
  const p = join(repoRoot, 'mechanical', 'out', 'case.jsonld')
  if (!existsSync(p)) return null
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8')) as { '@graph'?: unknown }
    return Array.isArray(doc['@graph']) ? doc['@graph'] as Node[] : null
  } catch {
    return null
  }
}

export interface HardwareInput {
  /** the schematic's symbols (for parts marked as hardware) */
  symbols?: readonly Symbol[]
  /** the newest case build's records (readCaseRecords) */
  caseRecords?: readonly Node[] | null
  /** the board's mounting holes, used when there is no case build */
  mountingHoles?: readonly { ref: string | null; d: number }[]
  /** the board file's sha256 now, to tell a case built for an earlier board */
  boardSha256?: string | null
}

function screwItem(size: string, length: number | null): string {
  return `${size} pan head screw${length !== null ? `, ${length} mm` : ''}`
}

function fromCase(g: readonly Node[], notes: string[]): { lines: HardwareLine[]; boardSha: string | null } {
  const lines: HardwareLine[] = []
  const mat = g.find((n) => isType(n, 'Material'))
  const made = [str(mat?.name), str(mat?.process), str(mat?.service)].filter(Boolean).join(', ')
  for (const n of g.filter((x) => isType(x, 'EnclosurePart'))) {
    const kind = str(n.partKind) ?? 'case'
    const bb = Array.isArray(n.boundingBox) ? (n.boundingBox as unknown[]).map(num).filter((x): x is number => x !== null) : []
    lines.push({
      quantity: 1, item: PART_NAMES[kind] ?? `Case part (${kind})`, kind: 'panel', size: bb.length === 3 ? `${bb.map((x) => Math.round(x * 10) / 10).join(' × ')} mm` : null,
      length_mm: null, refs: [kind], mpn: null, manufacturer: null, lcsc: null, source: 'case',
      note: made ? `made from the case files (mechanical/out/case-${kind}.*): ${made}` : `made from the case files (mechanical/out/case-${kind}.*)`,
    })
  }
  // screws: each Fastener, named by the MountingPoint that points at it
  const refOf = new Map<string, string>()
  for (const m of g.filter((x) => isType(x, 'MountingPoint'))) {
    const f = idOf(m.fastener)
    const r = str(m.reference)
    if (f && r) refOf.set(f, r)
  }
  const screws = new Map<string, HardwareLine>()
  for (const f of g.filter((x) => isType(x, 'Fastener'))) {
    const size = str(f.size)
    if (!size) continue
    const length = num(f.length)
    const pilot = num(f.pilotDiameter)
    const ref = refOf.get(str(f['@id']) ?? '') ?? str(f['@id'])?.replace(/^fastener:/, '') ?? '?'
    const key = `${size}|${length ?? ''}`
    const line = screws.get(key)
    if (line) {
      line.quantity++
      line.refs.push(ref)
    } else {
      screws.set(key, {
        quantity: 1, item: screwItem(size, length), kind: 'mounting', size, length_mm: length, refs: [ref],
        mpn: null, manufacturer: null, lcsc: null, source: 'case',
        note: `thread-forming screw for plastic (ISO 7045 pan head or smaller), into the case's ${pilot !== null ? `${pilot} mm ` : ''}pilot holes`,
      })
    }
  }
  for (const l of screws.values()) l.refs.sort(naturalCompare)
  lines.push(...[...screws.values()].sort((a, b) => naturalCompare(a.refs[0] ?? '', b.refs[0] ?? '')))
  const joints = g.filter((x) => isType(x, 'Joint'))
  if (joints.some((j) => str(j.jointKind) === 'press-fit' || str(j.jointKind) === 'snap-fit')) notes.push('The case closes without screws (press or snap fit).')
  const outline = g.find((x) => isType(x, 'BoardOutline'))
  return { lines, boardSha: str(outline?.sha256) }
}

function fromHoles(holes: readonly { ref: string | null; d: number }[], notes: string[]): HardwareLine[] {
  const bySize = new Map<string, HardwareLine>()
  holes.forEach((h, i) => {
    const size = screwFor(h.d)
    const line = bySize.get(size) ?? { quantity: 0, item: screwItem(size, null), kind: 'mounting' as const, size, length_mm: null, refs: [],
      mpn: null, manufacturer: null, lcsc: null, source: 'board' as const, note: 'length depends on what the board is fixed to (a case, a panel or standoffs)' }
    line.quantity++
    line.refs.push(h.ref ?? `hole ${i + 1}`)
    bySize.set(size, line)
  })
  if (bySize.size) notes.push('No case is built yet: screws come from the board\'s mounting holes. Build the case (mech.build) for exact lengths.')
  return [...bySize.values()].map((l) => ({ ...l, refs: l.refs.sort(naturalCompare) }))
}

function fromSchematic(symbols: readonly Symbol[]): HardwareLine[] {
  const byRef = new Map<string, Symbol>()
  for (const s of symbols) {
    if (s.power || s.ref.startsWith('#') || s.dnp || !hardwareKindOf(s)) continue
    const prev = byRef.get(s.ref)
    if (!prev || s.unit < prev.unit) byRef.set(s.ref, s)
  }
  const groups = new Map<string, HardwareLine>()
  for (const s of [...byRef.values()].sort((a, b) => naturalCompare(a.ref, b.ref))) {
    const kind = hardwareKindOf(s) as HardwareKind
    const mpn = mpnOf(s)
    const mfr = manufacturerOf(s)
    const lcsc = lcscOf(s)
    const k = JSON.stringify([kind, s.value, mpn ?? '', mfr ?? '', lcsc ?? ''])
    const line = groups.get(k)
    if (line) {
      line.quantity++
      line.refs.push(s.ref)
    } else {
      groups.set(k, { quantity: 1, item: s.fields.Description?.trim() || s.value, kind, size: null, length_mm: null, refs: [s.ref],
        mpn, manufacturer: mfr, lcsc, source: 'schematic', note: s.fields.Description?.trim() && s.value ? s.value : null })
    }
  }
  return [...groups.values()]
}

/** The panel and mounting hardware list (see the file's comment for what goes in it). */
export function buildHardware(i: HardwareInput): Hardware {
  const notes: string[] = []
  const lines: HardwareLine[] = []
  let caseBuilt = false
  let stale = false
  if (i.caseRecords && i.caseRecords.length) {
    caseBuilt = true
    const c = fromCase(i.caseRecords, notes)
    lines.push(...c.lines)
    if (c.boardSha && i.boardSha256 && c.boardSha !== i.boardSha256) {
      stale = true
      notes.push('The case was built for an earlier version of the board: rebuild it (mech.build) so the case parts and screws match before ordering.')
    }
  } else if (i.mountingHoles?.length) {
    lines.push(...fromHoles(i.mountingHoles, notes))
  }
  lines.push(...fromSchematic(i.symbols ?? []))
  // panel first (what you see), then mounting
  lines.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'panel' ? -1 : 1))
  if (!lines.length) notes.push('No panel or mounting hardware found: no case build, no mounting holes, and no part marked Hardware = panel or mounting (or referenced MP…).')
  return { lines, total_items: lines.reduce((n, l) => n + l.quantity, 0), case_built: caseBuilt, case_stale: stale, notes }
}

export function hardwareCsv(h: Hardware): string {
  return toCsv(['Quantity', 'Item', 'Kind', 'Size', 'Length (mm)', 'For', 'MPN', 'Manufacturer', 'LCSC', 'Source', 'Note'],
    h.lines.map((l) => [l.quantity, l.item, l.kind, l.size, l.length_mm, l.refs.join(' '), l.mpn, l.manufacturer, l.lcsc, l.source, l.note]))
}

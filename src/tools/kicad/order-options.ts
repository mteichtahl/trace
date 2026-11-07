/**
 * The board options to enter on JLCPCB's order form, as kicad.fab records them with the release package (its result's
 * `order_options`). The Build page's order sheet reads them from the run (src/api/actions-build.ts), so they come from
 * the record, not from a file an agent wrote beside the package.
 *
 * Each option says where its value comes from: the board file (layers, size, thickness, copper, the smallest track and
 * hole), the placements and the parts list (assembly side, parts placed, lines), or JLCPCB's own default when nothing
 * in the record decides it (material, colours, finish). A default is marked, so the person sees it was not decided.
 * The quantities are the build plan's, added by the order sheet. Pure.
 */
import type { Placement } from './bom.js'
import type { Board } from './pcb.js'

export interface OrderOption {
  group: 'pcb' | 'pcba'
  option: string
  value: string
  /** where the value comes from, in words */
  source: string
  /** false: JLCPCB's default, not decided anywhere in the record */
  decided: boolean
}

const BOARD = 'the board file'
const DEFAULT = 'JLCPCB\'s default: not decided in the record'
const mm = (n: number): string => `${Math.round(n * 100) / 100} mm`
const OZ_UM = 35

/** Copper thickness (m) as JLCPCB's weight: "1 oz (35 µm)". */
function copperWeight(t: number): string {
  const um = Math.round(t * 1e6)
  const oz = Math.round((um / OZ_UM) * 2) / 2
  return `${oz} oz (${um} µm)`
}

export function boardOrderOptions(b: Board, pl: readonly Placement[], bom: { lines: number; parts: number } | null): OrderOption[] {
  const out: OrderOption[] = []
  const pcb = (option: string, value: string, decided = true, source = decided ? BOARD : DEFAULT): void => { out.push({ group: 'pcb', option, value, source, decided }) }
  pcb('Base material', 'FR-4', false)
  pcb('Layers', String(b.layers.length))
  if (b.outline) pcb('Dimensions', `${Math.round(b.outline.width_mm * 100) / 100} x ${mm(b.outline.height_mm)}`)
  if (b.thickness_mm !== null) pcb('PCB thickness', mm(b.thickness_mm))
  else pcb('PCB thickness', '1.6 mm', false)
  const outer = b.layers.find((l) => l.outer)?.t ?? null
  if (outer !== null) pcb('Outer copper weight', copperWeight(outer))
  else pcb('Outer copper weight', '1 oz (35 µm)', false)
  const inner = b.layers.find((l) => !l.outer)?.t ?? null
  if (b.layers.length > 2) {
    if (inner !== null) pcb('Inner copper weight', copperWeight(inner))
    else pcb('Inner copper weight', '0.5 oz (17 µm)', false)
  }
  const widths = Object.values(b.segments).flat().map((s) => s[4]).filter((w) => w > 0)
  if (widths.length) pcb('Min track width', mm(Math.min(...widths)))
  const vias = Object.values(b.vias).flat()
  const viaDrills = vias.map((v) => v[3]).filter((d): d is number => typeof d === 'number' && d > 0)
  const padDrills = [...Object.values(b.pads).flat(), ...(b.unnetted ?? [])].flatMap((p) => (p.drill ? [Math.min(p.drill[0], p.drill[1])] : [])).filter((d) => d > 0)
  const holes = [...viaDrills, ...padDrills]
  if (holes.length) pcb('Min hole size', mm(Math.min(...holes)))
  if (vias.length) {
    const v = vias.reduce((a, x) => ((x[3] ?? Infinity) < (a[3] ?? Infinity) ? x : a))
    pcb('Smallest via', `${v[3] !== null ? `${mm(v[3])} drill / ` : ''}${mm(v[2])}`)
  }
  pcb('Solder mask colour', 'Green', false)
  pcb('Silkscreen colour', 'White', false)
  pcb('Surface finish', 'HASL', false)
  if (pl.length) {
    const top = pl.filter((p) => p.side === 'top').length
    const bottom = pl.length - top
    const side = bottom === 0 ? 'Top side' : top === 0 ? 'Bottom side' : 'Both sides'
    out.push({ group: 'pcba', option: 'PCBA', value: 'Yes', source: 'the placements', decided: true })
    out.push({ group: 'pcba', option: 'Assembly side', value: `${side} (${pl.length} placed part${pl.length === 1 ? '' : 's'}${top && bottom ? `: ${top} top, ${bottom} bottom` : ''})`, source: 'the placements', decided: true })
  }
  if (bom) out.push({ group: 'pcba', option: 'BOM', value: `${bom.lines} line${bom.lines === 1 ? '' : 's'}, ${bom.parts} part${bom.parts === 1 ? '' : 's'}`, source: 'the parts list', decided: true })
  return out
}

/** The order options a kicad.fab result recorded, or null when the run recorded none (made before they were). */
export function orderOptionsOf(result: Record<string, unknown> | null): OrderOption[] | null {
  const v = result?.order_options
  if (!Array.isArray(v)) return null
  return v.flatMap((o): OrderOption[] => {
    if (!o || typeof o !== 'object') return []
    const r = o as Record<string, unknown>
    if (typeof r.option !== 'string' || typeof r.value !== 'string') return []
    return [{ group: r.group === 'pcba' ? 'pcba' : 'pcb', option: r.option, value: r.value, source: typeof r.source === 'string' ? r.source : '', decided: r.decided !== false }]
  })
}

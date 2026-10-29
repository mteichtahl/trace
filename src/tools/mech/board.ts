/**
 * Board facts for the enclosure engine (docs/enclosure-build.md, "Board facts"): what the Python engine needs from the
 * .kicad_pcb, read from the file alone (no kicad-cli, no 3D models), in KiCad's frame (x right, y down, mm).
 *
 *   outline   the Edge.Cuts loop with the largest area: lines and arcs chained end to end (ends within 0.01 mm),
 *             rects, circles and polygons as they are, arcs and circles sampled every 0.5 mm or less; footprint
 *             Edge.Cuts included. The other loops are cutouts
 *   holes     non-plated pads (npth), every drilled pad of a MountingHole* footprint (mounting), and plated pads with a
 *             drill of 1 mm or more (pth); smaller plated drills and vias are left out
 *   parts     each placed footprint with pads that is not DNP, a mounting hole, a fiducial or only non-plated holes: its courtyard box (the
 *             F/B.CrtYd outline in board coordinates, from src/tools/layout/board.ts), else its pads grown by 0.25 mm;
 *             its height (./heights.ts); whether it is a connector, and the outline side it sits at
 */
import { relative } from 'node:path'
import { readFileSync } from 'node:fs'
import { findRoot } from '../../core/store.js'
import { ToolError } from '../../core/registry.js'
import * as sx from '../kicad/sexpr.js'
import { loadBoard } from '../kicad/pcb.js'
import { readLayout } from '../layout/board.js'
import { area, bbox, loops, type Poly, type Pt } from '../layout/geom.js'
import { partHeight } from './heights.js'

export type Side = 'west' | 'east' | 'north' | 'south'

export interface PartFacts {
  ref: string
  value: string
  footprint: string
  side: 'top' | 'bottom'
  x: number
  y: number
  rotation_deg: number
  mount: 'smd' | 'through_hole' | 'unspecified'
  box: { min_x: number; min_y: number; max_x: number; max_y: number }
  box_source: 'courtyard' | 'pads'
  height_mm: number
  height_source: 'field' | 'table' | 'default'
  below_mm: number
  connector: boolean
  edge: { side: Side; distance_mm: number } | null
}

export interface HoleFacts { x: number; y: number; d: number; kind: 'mounting' | 'npth' | 'pth'; ref: string | null }

export interface BoardFacts {
  version: 1
  board: string
  sha256: string
  thickness_mm: number
  outline: [number, number][]
  cutouts: [number, number][][]
  holes: HoleFacts[]
  parts: PartFacts[]
  warnings: string[]
}

/** Arcs and circles are sampled at most this far apart (mm). */
export const ARC_STEP_MM = 0.5
/** Edge.Cuts ends closer than this join (mm). */
export const JOIN_TOL_MM = 0.01
/** A part whose box is within this of the outline's side sits at that side (mm). */
export const EDGE_NEAR_MM = 1.5
/** Plated holes smaller than this are left out (vias, small pins) (mm). */
export const PTH_MIN_D_MM = 1.0
/** A part without a courtyard: its pads grown by this (mm). */
export const PADS_MARGIN_MM = 0.25
/** Through-hole leads below the far face (mm). */
export const LEADS_MM = 2.0

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4
const CONNECTOR_REF = /^(J|P|USB|CN)\d/i
const CONNECTOR_LIB = /^(Connector|USB|Button|LED_THT)/i
const NOT_PARTS = /^(MountingHole|Fiducial)/i

function rot(px: number, py: number, fx: number, fy: number, deg: number): Pt {
  const th = (deg * Math.PI) / 180
  return [fx + px * Math.cos(th) + py * Math.sin(th), fy - px * Math.sin(th) + py * Math.cos(th)]
}

function pt(node: sx.SList, name: string): Pt | null {
  const c = sx.find(node, name)
  const x = sx.num(c?.[1])
  const y = sx.num(c?.[2])
  return x !== undefined && y !== undefined ? [x, y] : null
}

function layersOf(node: sx.SList): string[] {
  const one = sx.value(node, 'layer')
  if (one !== undefined) return [one]
  const many = sx.find(node, 'layers')
  return many ? sx.atoms(many) : []
}

/** Points along the arc from a through m to b, at most ARC_STEP_MM apart (ends included). */
export function sampleArc(a: Pt, m: Pt, b: Pt, step = ARC_STEP_MM): Pt[] {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]))
  if (Math.abs(d) < 1e-12) return [a, b]
  const ux = ((a[0] ** 2 + a[1] ** 2) * (m[1] - b[1]) + (m[0] ** 2 + m[1] ** 2) * (b[1] - a[1]) + (b[0] ** 2 + b[1] ** 2) * (a[1] - m[1])) / d
  const uy = ((a[0] ** 2 + a[1] ** 2) * (b[0] - m[0]) + (m[0] ** 2 + m[1] ** 2) * (a[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (m[0] - a[0])) / d
  const r = Math.hypot(a[0] - ux, a[1] - uy)
  const ang = (p: Pt): number => Math.atan2(p[1] - uy, p[0] - ux)
  const ta = ang(a)
  const norm = (t: number): number => (((t - ta) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const tm = norm(ang(m))
  const tb = norm(ang(b))
  const sweep = tm <= tb ? tb : tb - 2 * Math.PI
  const n = Math.max(2, Math.ceil((Math.abs(sweep) * r) / step))
  const out: Pt[] = [a]
  for (let i = 1; i < n; i++) {
    const t = ta + (sweep * i) / n
    out.push([ux + r * Math.cos(t), uy + r * Math.sin(t)])
  }
  out.push(b)
  return out
}

export function sampleCircle(c: Pt, r: number, step = ARC_STEP_MM): Pt[] {
  const n = Math.max(16, Math.ceil((2 * Math.PI * r) / step))
  return Array.from({ length: n }, (_, i) => [c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)] as Pt)
}

/** One Edge.Cuts item: open segments to chain, or a closed loop as it is. */
function edgeShape(node: sx.SList): { segs: [Pt, Pt][]; closed: Poly | null } {
  const kind = sx.head(node) ?? ''
  const chain = (ps: Pt[]): [Pt, Pt][] => ps.slice(1).map((p, i) => [ps[i] as Pt, p])
  if (kind.endsWith('_line')) {
    const a = pt(node, 'start')
    const b = pt(node, 'end')
    return { segs: a && b ? [[a, b]] : [], closed: null }
  }
  if (kind.endsWith('_rect')) {
    const a = pt(node, 'start')
    const b = pt(node, 'end')
    if (!a || !b) return { segs: [], closed: null }
    const [x0, x1, y0, y1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])]
    return { segs: [], closed: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] }
  }
  if (kind.endsWith('_arc')) {
    const a = pt(node, 'start')
    const m = pt(node, 'mid')
    const b = pt(node, 'end')
    if (a && m && b) return { segs: chain(sampleArc(a, m, b)), closed: null }
    if (a && b) {
      // KiCad 6 footprint arcs: (start = centre) (end = a point) (angle)
      const r = Math.hypot(b[0] - a[0], b[1] - a[1])
      const ang = ((sx.numValue(node, 'angle') ?? 360) * Math.PI) / 180
      const t0 = Math.atan2(b[1] - a[1], b[0] - a[0])
      const n = Math.max(2, Math.ceil((Math.abs(ang) * r) / ARC_STEP_MM))
      return { segs: chain(Array.from({ length: n + 1 }, (_, i) => [a[0] + r * Math.cos(t0 + (ang * i) / n), a[1] + r * Math.sin(t0 + (ang * i) / n)] as Pt)), closed: null }
    }
    return { segs: [], closed: null }
  }
  if (kind.endsWith('_circle')) {
    const c = pt(node, 'center')
    const e = pt(node, 'end')
    return { segs: [], closed: c && e ? sampleCircle(c, Math.hypot(e[0] - c[0], e[1] - c[1])) : null }
  }
  if (kind.endsWith('_poly')) {
    const ps: Pt[] = []
    for (const q of sx.children(sx.find(node, 'pts') ?? ['pts'])) {
      if (sx.head(q) === 'xy') {
        const x = sx.num(q[1])
        const y = sx.num(q[2])
        if (x !== undefined && y !== undefined) ps.push([x, y])
      } else if (sx.head(q) === 'arc') {
        const a = pt(q, 'start')
        const m = pt(q, 'mid')
        const b = pt(q, 'end')
        if (a && m && b) ps.push(...sampleArc(a, m, b))
      }
    }
    return { segs: [], closed: ps.length >= 3 ? ps : null }
  }
  return { segs: [], closed: null }
}

/** The Edge.Cuts loops of a board file, largest first. */
export function edgeLoops(text: string): Poly[] {
  const tree = sx.parse(text)
  const segs: [Pt, Pt][] = []
  const closed: Poly[] = []
  const add = (s: { segs: [Pt, Pt][]; closed: Poly | null }, map: (p: Pt) => Pt = (p) => p): void => {
    for (const [a, b] of s.segs) segs.push([map(a), map(b)])
    if (s.closed) closed.push(s.closed.map(map))
  }
  for (const g of sx.children(tree)) {
    if ((sx.head(g) ?? '').startsWith('gr_') && layersOf(g).includes('Edge.Cuts')) add(edgeShape(g))
  }
  for (const fp of [...sx.findAll(tree, 'footprint'), ...sx.findAll(tree, 'module')]) {
    const at = sx.xy(fp)
    if (!at) continue
    for (const g of sx.children(fp)) {
      if ((sx.head(g) ?? '').startsWith('fp_') && layersOf(g).includes('Edge.Cuts')) add(edgeShape(g), (p) => rot(p[0], p[1], at[0], at[1], at[2]))
    }
  }
  return [...closed, ...loops(segs, JOIN_TOL_MM)].filter((p) => area(p) > 1e-6).sort((a, b) => area(b) - area(a))
}

/** The outline side nearest a box, when the box is within EDGE_NEAR_MM of it. */
export function nearestSide(box: PartFacts['box'], o: { min_x: number; min_y: number; max_x: number; max_y: number }): PartFacts['edge'] {
  const d: [Side, number][] = [['west', box.min_x - o.min_x], ['east', o.max_x - box.max_x], ['north', box.min_y - o.min_y], ['south', o.max_y - box.max_y]]
  d.sort((a, b) => a[1] - b[1])
  const [side, dist] = d[0] as [Side, number]
  return dist <= EDGE_NEAR_MM ? { side, distance_mm: r4(dist) } : null
}

/** A path as the repository names it (relative to its root), else as given. */
export function repoPath(p: string, root: string = findRoot(p) ?? process.cwd()): string {
  const r = relative(root, p)
  return r && !r.startsWith('..') ? r.split('\\').join('/') : p
}

/** The board facts of a .kicad_pcb (docs/enclosure-build.md, "Board facts"). */
export function boardFacts(pcbPath: string, root?: string): BoardFacts {
  const board = loadBoard(pcbPath)
  const layout = readLayout(pcbPath)
  const warnings: string[] = []
  const ls = edgeLoops(readFileSync(board.path, 'utf8'))
  const outline = ls[0]
  if (!outline) throw new ToolError(`${repoPath(board.path, root)} has no closed outline on Edge.Cuts: draw the board edge as one closed loop`)
  const [ox0, oy0, ox1, oy1] = bbox(outline)
  const ob = { min_x: ox0, min_y: oy0, max_x: ox1, max_y: oy1 }
  let thickness = board.thickness_mm
  if (!thickness || thickness <= 0) {
    thickness = 1.6
    warnings.push('the board file gives no thickness (general/thickness): 1.6 mm assumed')
  }

  const footprintOf = new Map(board.footprints.map((f) => [f.ref, f.footprint]))
  const holes: HoleFacts[] = []
  const pads = [...Object.values(board.pads).flat(), ...(board.unnetted ?? [])]
  const seen = new Set<string>()
  for (const p of pads) {
    if (!p.drill) continue
    const d = Math.min(p.drill[0], p.drill[1])
    const fpName = (footprintOf.get(p.ref) ?? '').split(':').pop() ?? ''
    const kind: HoleFacts['kind'] = /^MountingHole/i.test(fpName) ? 'mounting' : p.kind === 'np_thru_hole' ? 'npth' : 'pth'
    if (kind === 'pth' && d < PTH_MIN_D_MM) continue
    const key = `${r4(p.x)},${r4(p.y)}`
    if (seen.has(key)) continue // a mounting hole's ring of pads around one drill counts once
    seen.add(key)
    holes.push({ x: r4(p.x), y: r4(p.y), d: r4(d), kind, ref: p.ref && p.ref !== '?' ? p.ref : null })
  }

  const parts: PartFacts[] = []
  board.footprints.forEach((f, i) => {
    const placed = layout.footprints[i]
    const name = f.footprint.split(':').pop() ?? ''
    if (f.dnp || !f.pads.length || !placed || NOT_PARTS.test(name) || f.pads.every((q) => q.type === 'np_thru_hole')) return
    let [x0, y0, x1, y1] = bbox(placed.courtyard)
    if (placed.courtyard_from === 'pads') {
      // the pads' own extents, netted or not (the layout reader's fallback sees only netted pads' sizes)
      const mine = pads.filter((q) => q.ref === f.ref)
      if (mine.length) {
        x0 = Math.min(...mine.map((q) => q.x - q.w / 2)) - PADS_MARGIN_MM
        y0 = Math.min(...mine.map((q) => q.y - q.h / 2)) - PADS_MARGIN_MM
        x1 = Math.max(...mine.map((q) => q.x + q.w / 2)) + PADS_MARGIN_MM
        y1 = Math.max(...mine.map((q) => q.y + q.h / 2)) + PADS_MARGIN_MM
      }
    }
    const box = { min_x: r4(x0), min_y: r4(y0), max_x: r4(x1), max_y: r4(y1) }
    const h = partHeight(f.footprint, f.fields)
    if (h.source === 'default') warnings.push(`${f.ref} (${name || 'no footprint name'}) has no Height field and no table entry: assumed ${h.height_mm} mm`)
    const lib = f.footprint.includes(':') ? f.footprint.slice(0, f.footprint.indexOf(':')) : ''
    parts.push({
      ref: f.ref, value: f.value, footprint: f.footprint, side: f.side, x: f.x_mm, y: f.y_mm, rotation_deg: f.rotation_deg, mount: f.mount,
      box, box_source: placed.courtyard_from === 'pads' ? 'pads' : 'courtyard',
      height_mm: h.height_mm, height_source: h.source, below_mm: f.mount === 'through_hole' ? LEADS_MM : 0,
      connector: CONNECTOR_REF.test(f.ref) || CONNECTOR_LIB.test(lib), edge: nearestSide(box, ob),
    })
  })

  return {
    version: 1, board: repoPath(board.path, root), sha256: board.sha256, thickness_mm: thickness,
    outline: outline.map(([x, y]) => [r4(x), r4(y)]), cutouts: ls.slice(1).map((l) => l.map(([x, y]) => [r4(x), r4(y)] as [number, number])),
    holes, parts, warnings,
  }
}

/**
 * What the placement tools need from a .kicad_pcb beyond the board reader in src/tools/kicad/pcb.ts (whose Board gives
 * pads, nets, tracks, outline box and zones): each footprint's courtyard in board coordinates, its sheet (KiCad 7+
 * `sheetname`/`sheetfile`, older `Sheetname`/`Sheetfile` properties) and hierarchical path, the board outline as
 * closed loops from Edge.Cuts (lines, rects, arcs, circles, polygons; footprint Edge.Cuts included), and the
 * keep-out rule areas with their polygons and what they forbid.
 *
 * Courtyards are the footprint's actual F.CrtYd/B.CrtYd outlines: fp_rect, fp_circle and fp_poly are closed shapes
 * as they are, and fp_line/fp_arc segments are joined end to end into closed loops, so an L-shaped courtyard stays an
 * L (a loop inside another of the same footprint is taken as filled). When the lines do not close, the convex hull of
 * the courtyard graphics is used instead, marked `courtyard_from: 'hull'` with a note (it can report an overlap that
 * is not there). A footprint without a courtyard gets its pads' bounding box grown by `fallback_margin_mm`, and is
 * marked so.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ToolError } from '../../core/registry.js'
import * as sx from '../kicad/sexpr.js'
import { loadBoard, type Board } from '../kicad/pcb.js'
import { arcPoints, area, bbox, circlePoints, hull, inside, loops, rectPoly, type Poly, type Pt } from './geom.js'

export interface PlacedFootprint {
  ref: string
  value: string
  footprint: string
  side: 'top' | 'bottom'
  x: number
  y: number
  rotation: number
  /** the courtyard outline in board coordinates: the one closed outline, or the hull of several (edge and area
   * checks) */
  courtyard: Poly
  /** the closed courtyard polygons, for overlaps (one, usually; the hull when the outline does not close) */
  courtyards: Poly[]
  courtyard_from: 'courtyard' | 'hull' | 'pads'
  /** why the hull was used, when it was */
  courtyard_note: string | null
  sheet: string
  sheetfile: string | null
  path: string | null
  dnp: boolean
  pads: Board['footprints'][number]['pads']
}

export interface KeepOut {
  name: string | null
  layers: string[]
  polygon: Poly
  /** what it forbids: footprints, pads, tracks, vias, copperpour */
  not_allowed: string[]
}

export interface Layout {
  board: Board
  footprints: PlacedFootprint[]
  /** the outline loops; the largest is the board, any others are cut-outs */
  outline: Poly | null
  cutouts: Poly[]
  edges: [Pt, Pt][]
  keepouts: KeepOut[]
}

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

/** A graphic item as points (outline) and, for edges, segments. */
function shape(node: sx.SList): { points: Pt[]; segs: [Pt, Pt][] } {
  const kind = sx.head(node) ?? ''
  const segs: [Pt, Pt][] = []
  const chain = (ps: Pt[], close: boolean): void => {
    for (let i = 0; i + 1 < ps.length; i++) segs.push([ps[i] as Pt, ps[i + 1] as Pt])
    if (close && ps.length > 2) segs.push([ps[ps.length - 1] as Pt, ps[0] as Pt])
  }
  if (kind.endsWith('_line')) {
    const a = pt(node, 'start')
    const b = pt(node, 'end')
    if (a && b) chain([a, b], false)
  } else if (kind.endsWith('_rect')) {
    const a = pt(node, 'start')
    const b = pt(node, 'end')
    if (a && b) chain(rectPoly(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])), true)
  } else if (kind.endsWith('_arc')) {
    const a = pt(node, 'start')
    const m = pt(node, 'mid')
    const b = pt(node, 'end')
    if (a && m && b) chain(arcPoints(a, m, b), false)
    else if (a && b) {
      // KiCad 6 footprint arcs: (start = centre) (end = a point) (angle)
      const r = Math.hypot(b[0] - a[0], b[1] - a[1])
      const ang = sx.numValue(node, 'angle') ?? 360
      const t0 = Math.atan2(b[1] - a[1], b[0] - a[0])
      const n = 8
      const ps: Pt[] = Array.from({ length: n + 1 }, (_, i) => [a[0] + r * Math.cos(t0 + ((ang * Math.PI) / 180) * (i / n)), a[1] + r * Math.sin(t0 + ((ang * Math.PI) / 180) * (i / n))] as Pt)
      chain(ps, false)
    }
  } else if (kind.endsWith('_circle')) {
    const c = pt(node, 'center')
    const e = pt(node, 'end')
    if (c && e) chain(circlePoints(c, Math.hypot(e[0] - c[0], e[1] - c[1])), true)
  } else if (kind.endsWith('_poly')) {
    const ps: Pt[] = []
    for (const q of sx.findAll(sx.find(node, 'pts'), 'xy')) {
      const x = sx.num(q[1])
      const y = sx.num(q[2])
      if (x !== undefined && y !== undefined) ps.push([x, y])
    }
    chain(ps, true)
  }
  return { points: segs.flatMap(([a, b]) => [a, b]), segs }
}

/** Closed courtyard polygons from one footprint's courtyard graphics (board coordinates): closed shapes as they are,
 * open segments joined into loops. `open` counts segments that close no loop. */
export function courtyardPolygons(closed: readonly Poly[], segs: readonly [Pt, Pt][], tol = 1e-3): { polys: Poly[]; open: number } {
  const ls = loops(segs, tol)
  const used = ls.reduce((n, l) => n + l.length, 0)
  const all = [...closed.filter((p) => p.length >= 3), ...ls].filter((p) => area(p) > 1e-9)
  // a loop wholly inside another is not a hole a part may sit in: drop it (the outer one is taken as filled)
  const polys = all.filter((p, i) => !all.some((q, j) => j !== i && area(q) > area(p) && p.every((pt) => inside(pt, q))))
  return { polys, open: Math.max(0, segs.length - used) }
}

const memo = new Map<string, Layout>()

export function readLayout(path: string, opts: { fallbackMarginMm?: number } = {}): Layout {
  const p = resolve(path)
  if (!existsSync(p)) throw new ToolError(`${p} does not exist`)
  const raw = readFileSync(p)
  const key = `${createHash('sha256').update(raw).digest('hex')}|${opts.fallbackMarginMm ?? 0.25}`
  const hit = memo.get(key)
  if (hit) return hit
  const board = loadBoard(p)
  const tree = sx.parse(raw.toString('utf8'))
  const margin = opts.fallbackMarginMm ?? 0.25
  const footprints: PlacedFootprint[] = []
  const edges: [Pt, Pt][] = []
  const fps = [...sx.findAll(tree, 'footprint'), ...sx.findAll(tree, 'module')]
  let k = 0 // the board reader skips footprints without (at …); so does this, keeping the two lists aligned
  for (const fp of fps) {
    const at = sx.xy(fp)
    if (!at) continue
    const meta = board.footprints[k++]
    if (!meta) continue
    const [fx, fy, fr] = at
    const crt: Pt[] = []
    const closed: Poly[] = []
    const openSegs: [Pt, Pt][] = []
    const toBoard = (p: Pt): Pt => rot(p[0], p[1], fx, fy, fr)
    for (const g of sx.children(fp)) {
      const h = sx.head(g) ?? ''
      if (!h.startsWith('fp_')) continue
      const ls = layersOf(g)
      const s = shape(g)
      if (ls.some((l) => l.endsWith('.CrtYd'))) {
        crt.push(...s.points.map(toBoard))
        if (/_(rect|circle|poly)$/.test(h)) closed.push(s.segs.map(([a]) => toBoard(a)))
        else for (const [a, b] of s.segs) openSegs.push([toBoard(a), toBoard(b)])
      }
      if (ls.includes('Edge.Cuts')) for (const [a, b] of s.segs) edges.push([toBoard(a), toBoard(b)])
    }
    let courtyard: Poly
    let courtyards: Poly[]
    let note: string | null = null
    let from: PlacedFootprint['courtyard_from'] = 'courtyard'
    const cy = crt.length >= 3 ? courtyardPolygons(closed, openSegs) : { polys: [], open: 0 }
    if (crt.length >= 3 && cy.polys.length && !cy.open) {
      courtyards = cy.polys
      courtyard = cy.polys.length === 1 ? cy.polys[0] as Poly : hull(cy.polys.flat())
    } else if (crt.length >= 3) {
      from = 'hull'
      courtyard = hull(crt)
      courtyards = [courtyard]
      note = `the courtyard outline does not close (${cy.open || openSegs.length} of ${openSegs.length} line/arc segments join no loop): its convex hull was used, which can overstate overlaps`
    } else {
      from = 'pads'
      const pads = board.pads
      const mine = Object.values(pads).flat().filter((q) => q.ref === meta.ref)
      const ps: Pt[] = mine.flatMap((q) => [[q.x - q.w / 2, q.y - q.h / 2], [q.x + q.w / 2, q.y + q.h / 2]] as Pt[])
      const own = meta.pads.map((q) => [q.x_mm, q.y_mm] as Pt)
      const all = ps.length ? ps : own.length ? own : [[fx, fy] as Pt]
      const [x0, y0, x1, y1] = bbox(all)
      courtyard = rectPoly(x0 - margin, y0 - margin, x1 + margin, y1 + margin)
      courtyards = [courtyard]
    }
    const props = new Map(sx.findAll(fp, 'property').map((q) => [sx.atomAt(q, 1) ?? '', sx.atomAt(q, 2) ?? ''] as const))
    footprints.push({
      ref: meta.ref, value: meta.value, footprint: meta.footprint, side: meta.side, x: fx, y: fy, rotation: fr,
      courtyard, courtyards, courtyard_from: from, courtyard_note: note,
      sheet: sx.value(fp, 'sheetname') ?? props.get('Sheetname') ?? props.get('Sheet name') ?? '/',
      sheetfile: sx.value(fp, 'sheetfile') ?? props.get('Sheetfile') ?? null,
      path: sx.value(fp, 'path') ?? null, dnp: meta.dnp, pads: meta.pads,
    })
  }
  for (const g of sx.children(tree)) {
    if ((sx.head(g) ?? '').startsWith('gr_') && layersOf(g).includes('Edge.Cuts')) edges.push(...shape(g).segs)
  }
  const ls = loops(edges).sort((a, b) => area(b) - area(a))
  const keepouts: KeepOut[] = []
  for (const z of sx.findAll(tree, 'zone')) {
    const ko = sx.find(z, 'keepout')
    if (!ko) continue
    const not: string[] = []
    for (const c of sx.children(ko)) {
      const k = sx.head(c)
      if (k && sx.atomAt(c, 1) === 'not_allowed') not.push(k)
    }
    const poly: Pt[] = []
    for (const q of sx.findAll(sx.find(sx.find(z, 'polygon') ?? ['polygon'], 'pts'), 'xy')) {
      const x = sx.num(q[1])
      const y = sx.num(q[2])
      if (x !== undefined && y !== undefined) poly.push([x, y])
    }
    if (poly.length >= 3) keepouts.push({ name: sx.value(z, 'name') ?? null, layers: layersOf(z), polygon: poly, not_allowed: not })
  }
  const out: Layout = { board, footprints, outline: ls[0] ?? null, cutouts: ls.slice(1), edges, keepouts }
  memo.set(key, out)
  return out
}

/** Whether a zone's layers cover a footprint's side. */
export function onSide(layers: readonly string[], side: 'top' | 'bottom'): boolean {
  const cu = side === 'top' ? 'F.Cu' : 'B.Cu'
  return layers.some((l) => l === cu || l === '*.Cu' || l === 'F&B.Cu' || (l.endsWith('.Cu') && l.startsWith(side === 'top' ? 'F' : 'B')))
}

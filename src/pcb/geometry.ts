/**
 * Copper clearance between simple shapes, enough to vet a router's output before it is written into a board: tracks
 * and vias are capsules (a segment with a radius; a via is a zero-length one spanning several layers), pads are
 * their axis-aligned bounding rectangles (conservative for rotated or round pads). A spatial hash keeps the check
 * near-linear on large boards. All lengths are mm.
 */
import type { Board } from '../kicad/pcb.js'

export type Shape =
  | { kind: 'cap'; net: string; layers: readonly string[]; x1: number; y1: number; x2: number; y2: number; r: number; tag?: string }
  | { kind: 'rect'; net: string; layers: readonly string[]; x0: number; y0: number; x1: number; y1: number; tag?: string }

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))

function pointSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const L2 = dx * dx + dy * dy
  const t = L2 === 0 ? 0 : clamp(((px - x1) * dx + (py - y1) * dy) / L2, 0, 1)
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function segsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px))
  const o1 = o(ax, ay, bx, by, cx, cy)
  const o2 = o(ax, ay, bx, by, dx, dy)
  const o3 = o(cx, cy, dx, dy, ax, ay)
  const o4 = o(cx, cy, dx, dy, bx, by)
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0
}

export function segSeg(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  if (segsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0
  return Math.min(pointSeg(ax, ay, cx, cy, dx, dy), pointSeg(bx, by, cx, cy, dx, dy), pointSeg(cx, cy, ax, ay, bx, by), pointSeg(dx, dy, ax, ay, bx, by))
}

function pointRect(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  return Math.hypot(Math.max(x0 - px, 0, px - x1), Math.max(y0 - py, 0, py - y1))
}

function segRect(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): number {
  if (pointRect(ax, ay, x0, y0, x1, y1) === 0 || pointRect(bx, by, x0, y0, x1, y1) === 0) return 0
  const edges: [number, number, number, number][] = [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]]
  return Math.min(...edges.map(([p, q, r, s]) => segSeg(ax, ay, bx, by, p, q, r, s)))
}

/** Edge-to-edge distance between two shapes in the plane (layers are not considered). */
export function gap(a: Shape, b: Shape): number {
  if (a.kind === 'cap' && b.kind === 'cap') return segSeg(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1, b.x2, b.y2) - a.r - b.r
  if (a.kind === 'cap' && b.kind === 'rect') return segRect(a.x1, a.y1, a.x2, a.y2, b.x0, b.y0, b.x1, b.y1) - a.r
  if (a.kind === 'rect' && b.kind === 'cap') return gap(b, a)
  const ra = a as Extract<Shape, { kind: 'rect' }>
  const rb = b as Extract<Shape, { kind: 'rect' }>
  return Math.hypot(Math.max(rb.x0 - ra.x1, 0, ra.x0 - rb.x1), Math.max(rb.y0 - ra.y1, 0, ra.y0 - rb.y1))
}

const bbox = (s: Shape): [number, number, number, number] => s.kind === 'cap'
  ? [Math.min(s.x1, s.x2) - s.r, Math.min(s.y1, s.y2) - s.r, Math.max(s.x1, s.x2) + s.r, Math.max(s.y1, s.y2) + s.r]
  : [s.x0, s.y0, s.x1, s.y1]

/** Shapes indexed by a uniform grid. */
export class ShapeIndex {
  private readonly cells = new Map<string, Shape[]>()
  constructor(private readonly cell = 2) {}

  private keys(s: Shape, grow: number): string[] {
    const [x0, y0, x1, y1] = bbox(s)
    const c = this.cell
    const out: string[] = []
    for (let i = Math.floor((x0 - grow) / c); i <= Math.floor((x1 + grow) / c); i++) {
      for (let j = Math.floor((y0 - grow) / c); j <= Math.floor((y1 + grow) / c); j++) out.push(`${i},${j}`)
    }
    return out
  }

  add(s: Shape): void {
    for (const k of this.keys(s, 0)) (this.cells.get(k) ?? this.cells.set(k, []).get(k) as Shape[]).push(s)
  }

  /** The first shape of another net sharing a layer with `s` and closer than `clearance`, or null. */
  conflict(s: Shape, clearance: number): Shape | null {
    const seen = new Set<Shape>()
    const layers = new Set(s.layers)
    for (const k of this.keys(s, clearance)) {
      for (const o of this.cells.get(k) ?? []) {
        if (seen.has(o)) continue
        seen.add(o)
        if (o.net === s.net || !o.layers.some((l) => layers.has(l))) continue
        if (gap(s, o) < clearance - 1e-4) return o
      }
    }
    return null
  }
}

/** The layers a via between `top` and `bottom` passes through, in stack order. */
export function viaSpan(order: readonly string[], top: string, bottom: string): string[] {
  const a = order.indexOf(top)
  const b = order.indexOf(bottom)
  if (a < 0 || b < 0) return [top, bottom]
  return order.slice(Math.min(a, b), Math.max(a, b) + 1)
}

/** The board's existing copper as shapes: pads, tracks (arcs as their chord: an approximation) and vias. */
export function boardShapes(b: Board): Shape[] {
  const order = b.layers.map((l) => l.name)
  const out: Shape[] = []
  for (const [net, pads] of Object.entries(b.pads)) {
    for (const p of pads) out.push({ kind: 'rect', net, layers: p.layers, x0: p.x - p.w / 2, y0: p.y - p.h / 2, x1: p.x + p.w / 2, y1: p.y + p.h / 2, tag: `pad ${p.ref}.${p.num}` })
  }
  for (const [net, segs] of Object.entries(b.segments)) {
    for (const [x1, y1, x2, y2, w, ly] of segs) out.push({ kind: 'cap', net, layers: [ly], x1, y1, x2, y2, r: w / 2, tag: `track on ${ly}` })
  }
  for (const [net, vias] of Object.entries(b.vias)) {
    for (const [x, y, s, , top, bot] of vias) out.push({ kind: 'cap', net, layers: viaSpan(order, top, bot), x1: x, y1: y, x2: x, y2: y, r: s / 2, tag: 'via' })
  }
  return out
}

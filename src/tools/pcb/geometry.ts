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

// ------------------------------------------------------------------ polygons

/**
 * Simple polygons (a list of corners, closed implicitly), for courtyards and rule areas: proper segment crossing,
 * point in polygon with the boundary told apart, whether two polygons overlap, and the exact area they share
 * (both are ear-clipped into triangles and the triangles clipped pairwise, so concave outlines such as an L are
 * exact). Lengths are mm.
 */
export type PPt = readonly [number, number]

/** The two segments cross at a point inside both (touching, sharing an end, or running collinear is not crossing). */
export function segmentsCross(a: PPt, b: PPt, c: PPt, d: PPt): boolean {
  return segsCross(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])
}

/** Distance from a point to a polygon's outline. */
export function pointOutlineDistance(p: PPt, poly: readonly PPt[]): number {
  let m = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as PPt
    const b = poly[(i + 1) % poly.length] as PPt
    m = Math.min(m, pointSeg(p[0], p[1], a[0], a[1], b[0], b[1]))
  }
  return m
}

/** 'in', 'out', or 'on' (within eps of the outline). Even–odd rule. */
export function pointInPolygon(p: PPt, poly: readonly PPt[], eps = 1e-6): 'in' | 'out' | 'on' {
  if (pointOutlineDistance(p, poly) <= eps) return 'on'
  let r = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as PPt
    const b = poly[j] as PPt
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) r = !r
  }
  return r ? 'in' : 'out'
}

/** Whether the insides of two polygons meet: an edge of one properly crosses an edge of the other, or a corner (or
 * the edge midpoint, for outlines that only share corners) of one lies strictly inside the other. Outlines that only
 * touch do not overlap. */
export function polygonsOverlap(a: readonly PPt[], b: readonly PPt[], eps = 1e-6): boolean {
  if (a.length < 3 || b.length < 3) return false
  for (let i = 0; i < a.length; i++) {
    const p = a[i] as PPt
    const q = a[(i + 1) % a.length] as PPt
    for (let j = 0; j < b.length; j++) if (segmentsCross(p, q, b[j] as PPt, b[(j + 1) % b.length] as PPt)) return true
  }
  const probe = (x: readonly PPt[], y: readonly PPt[]): boolean => x.some((p, i) => {
    const q = x[(i + 1) % x.length] as PPt
    return pointInPolygon(p, y, eps) === 'in' || pointInPolygon([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], y, eps) === 'in'
  })
  if (probe(a, b) || probe(b, a)) return true
  // the same outline (or one whose every corner and midpoint is on the other's): compare an inner point
  const inner = (x: readonly PPt[]): PPt | null => {
    for (const t of triangulate(x)) {
      const c: PPt = [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3]
      if (pointInPolygon(c, x, eps) === 'in') return c
    }
    return null
  }
  const ca = inner(a)
  return ca !== null && pointInPolygon(ca, b, eps) === 'in'
}

export function signedArea(p: readonly PPt[]): number {
  let s = 0
  for (let i = 0; i < p.length; i++) {
    const a = p[i] as PPt
    const b = p[(i + 1) % p.length] as PPt
    s += a[0] * b[1] - b[0] * a[1]
  }
  return s / 2
}

/** The intersection of a polygon with a convex polygon (Sutherland–Hodgman). */
export function clip(subject: readonly PPt[], convex: readonly PPt[]): [number, number][] {
  if (subject.length < 3 || convex.length < 3) return []
  const c = signedArea(convex) < 0 ? [...convex].reverse() : [...convex]
  let out: [number, number][] = subject.map((p) => [p[0], p[1]])
  for (let i = 0; i < c.length && out.length; i++) {
    const a = c[i] as PPt
    const b = c[(i + 1) % c.length] as PPt
    const inside = (p: PPt): boolean => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-12
    const meet = (p: PPt, q: PPt): [number, number] => {
      const a1 = b[1] - a[1]
      const b1 = a[0] - b[0]
      const c1 = a1 * a[0] + b1 * a[1]
      const a2 = q[1] - p[1]
      const b2 = p[0] - q[0]
      const c2 = a2 * p[0] + b2 * p[1]
      const d = a1 * b2 - a2 * b1
      return Math.abs(d) < 1e-15 ? [p[0], p[1]] : [(b2 * c1 - b1 * c2) / d, (a1 * c2 - a2 * c1) / d]
    }
    const input = out
    out = []
    for (let k = 0; k < input.length; k++) {
      const cur = input[k] as [number, number]
      const prev = input[(k + input.length - 1) % input.length] as [number, number]
      if (inside(cur)) {
        if (!inside(prev)) out.push(meet(prev, cur))
        out.push(cur)
      } else if (inside(prev)) out.push(meet(prev, cur))
    }
  }
  return out
}

/** Corners with repeats and collinear runs removed, counter-clockwise (y-up sense). */
function cleaned(poly: readonly PPt[], eps = 1e-9): PPt[] {
  let ps: PPt[] = []
  for (const p of poly) {
    const last = ps[ps.length - 1]
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) ps.push(p)
  }
  while (ps.length > 1 && Math.hypot((ps[0] as PPt)[0] - (ps[ps.length - 1] as PPt)[0], (ps[0] as PPt)[1] - (ps[ps.length - 1] as PPt)[1]) <= eps) ps.pop()
  let changed = true
  while (changed && ps.length > 3) {
    changed = false
    for (let i = 0; i < ps.length; i++) {
      const a = ps[(i + ps.length - 1) % ps.length] as PPt
      const b = ps[i] as PPt
      const c = ps[(i + 1) % ps.length] as PPt
      if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) <= eps * Math.max(1, Math.hypot(c[0] - a[0], c[1] - a[1]))) {
        ps = [...ps.slice(0, i), ...ps.slice(i + 1)]
        changed = true
        break
      }
    }
  }
  return signedArea(ps) < 0 ? ps.reverse() : ps
}

/** Ear-clipping triangulation of a simple polygon (any orientation). A polygon it cannot clip (self-intersecting)
 * falls back to a fan from its first corner. */
export function triangulate(poly: readonly PPt[]): [PPt, PPt, PPt][] {
  const ps = cleaned(poly)
  if (ps.length < 3) return []
  const out: [PPt, PPt, PPt][] = []
  const idx = ps.map((_, i) => i)
  const cross = (o: PPt, a: PPt, b: PPt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const inTri = (p: PPt, a: PPt, b: PPt, c: PPt): boolean => cross(a, b, p) >= -1e-12 && cross(b, c, p) >= -1e-12 && cross(c, a, p) >= -1e-12
  let guard = 0
  while (idx.length > 3 && guard++ < 10_000) {
    let clipped = false
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k + idx.length - 1) % idx.length] as number
      const ib = idx[k] as number
      const ic = idx[(k + 1) % idx.length] as number
      const [a, b, c] = [ps[ia] as PPt, ps[ib] as PPt, ps[ic] as PPt]
      if (cross(a, b, c) <= 1e-12) continue // reflex or flat
      if (idx.some((j) => j !== ia && j !== ib && j !== ic && inTri(ps[j] as PPt, a, b, c))) continue
      out.push([a, b, c])
      idx.splice(k, 1)
      clipped = true
      break
    }
    if (!clipped) break
  }
  if (idx.length === 3) out.push([ps[idx[0] as number] as PPt, ps[idx[1] as number] as PPt, ps[idx[2] as number] as PPt])
  else if (idx.length > 3) for (let k = 1; k + 1 < idx.length; k++) out.push([ps[idx[0] as number] as PPt, ps[idx[k] as number] as PPt, ps[idx[k + 1] as number] as PPt])
  return out
}

const triArea = (t: readonly PPt[]): number => Math.abs(signedArea(t))

const boxOf = (p: readonly PPt[]): [number, number, number, number] => {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const [x, y] of p) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  return [x0, y0, x1, y1]
}

/** The area two simple polygons share (exact for concave ones: triangle by triangle). */
export function polygonOverlapArea(a: readonly PPt[], b: readonly PPt[]): number {
  const ta = triangulate(a)
  const tb = triangulate(b)
  let s = 0
  const bb = tb.map(boxOf)
  for (const t of ta) {
    const [x0, y0, x1, y1] = boxOf(t)
    tb.forEach((u, j) => {
      const [u0, v0, u1, v1] = bb[j] as [number, number, number, number]
      if (x1 <= u0 || u1 <= x0 || y1 <= v0 || v1 <= y0) return
      s += triArea(clip(t, u))
    })
  }
  return s
}

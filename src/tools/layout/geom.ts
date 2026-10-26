/** Plane geometry for placement checks: convex hulls, polygon area and intersection, point-in-polygon, distances.
 * All in mm, board coordinates (y down, as KiCad). */
import { segSeg } from '../../pcb/geometry.js'

export type Pt = [number, number]
export type Poly = Pt[]

/** Convex hull (Andrew's monotone chain), counter-clockwise in a y-up sense; fewer than 3 distinct points as given. */
export function hull(points: readonly Pt[]): Poly {
  const pts = [...new Map(points.map((p) => [`${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`, p] as const)).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (pts.length < 3) return pts
  const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as Pt, lower[lower.length - 1] as Pt, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Pt[] = []
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2] as Pt, upper[upper.length - 1] as Pt, p) <= 0) upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

export function area(p: readonly Pt[]): number {
  let s = 0
  for (let i = 0; i < p.length; i++) {
    const a = p[i] as Pt
    const b = p[(i + 1) % p.length] as Pt
    s += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(s) / 2
}

const signedArea = (p: readonly Pt[]): number => {
  let s = 0
  for (let i = 0; i < p.length; i++) {
    const a = p[i] as Pt
    const b = p[(i + 1) % p.length] as Pt
    s += a[0] * b[1] - b[0] * a[1]
  }
  return s / 2
}

/** The intersection of a polygon with a convex polygon (Sutherland–Hodgman). */
export function clip(subject: readonly Pt[], convex: readonly Pt[]): Poly {
  if (subject.length < 3 || convex.length < 3) return []
  const c = signedArea(convex) < 0 ? [...convex].reverse() : [...convex]
  let out: Pt[] = [...subject]
  for (let i = 0; i < c.length && out.length; i++) {
    const a = c[i] as Pt
    const b = c[(i + 1) % c.length] as Pt
    const inside = (p: Pt): boolean => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-12
    const meet = (p: Pt, q: Pt): Pt => {
      const a1 = b[1] - a[1]
      const b1 = a[0] - b[0]
      const c1 = a1 * a[0] + b1 * a[1]
      const a2 = q[1] - p[1]
      const b2 = p[0] - q[0]
      const c2 = a2 * p[0] + b2 * p[1]
      const d = a1 * b2 - a2 * b1
      return Math.abs(d) < 1e-15 ? p : [(b2 * c1 - b1 * c2) / d, (a1 * c2 - a2 * c1) / d]
    }
    const input = out
    out = []
    for (let k = 0; k < input.length; k++) {
      const cur = input[k] as Pt
      const prev = input[(k + input.length - 1) % input.length] as Pt
      if (inside(cur)) {
        if (!inside(prev)) out.push(meet(prev, cur))
        out.push(cur)
      } else if (inside(prev)) out.push(meet(prev, cur))
    }
  }
  return out
}

export const overlapArea = (a: readonly Pt[], b: readonly Pt[]): number => area(clip(a, hull(b)))

/** Even–odd point in polygon. */
export function inside(p: Pt, poly: readonly Pt[]): boolean {
  let r = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Pt
    const b = poly[j] as Pt
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) r = !r
  }
  return r
}

/** Smallest distance between the outlines of two polygons (0 when their edges cross). */
export function outlineGap(a: readonly Pt[], b: readonly Pt[]): number {
  let m = Infinity
  for (let i = 0; i < a.length; i++) {
    const p = a[i] as Pt
    const q = a[(i + 1) % a.length] as Pt
    for (let j = 0; j < b.length; j++) {
      const r = b[j] as Pt
      const s = b[(j + 1) % b.length] as Pt
      m = Math.min(m, segSeg(p[0], p[1], q[0], q[1], r[0], r[1], s[0], s[1]))
      if (m === 0) return 0
    }
  }
  return m
}

/** Distance from a polygon's outline to the nearest of the given segments (board edges). */
export function gapToSegments(poly: readonly Pt[], segs: readonly [Pt, Pt][]): number {
  let m = Infinity
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Pt
    const q = poly[(i + 1) % poly.length] as Pt
    for (const [r, s] of segs) m = Math.min(m, segSeg(p[0], p[1], q[0], q[1], r[0], r[1], s[0], s[1]))
  }
  return m
}

export function bbox(points: readonly Pt[]): [number, number, number, number] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of points) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  return [x0, y0, x1, y1]
}

export const rectPoly = (x0: number, y0: number, x1: number, y1: number): Poly => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

/** Points along a circular arc through start, mid, end (n segments), or the chord when they are collinear. */
export function arcPoints(a: Pt, m: Pt, b: Pt, n = 8): Pt[] {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]))
  if (Math.abs(d) < 1e-12) return [a, b]
  const ux = ((a[0] ** 2 + a[1] ** 2) * (m[1] - b[1]) + (m[0] ** 2 + m[1] ** 2) * (b[1] - a[1]) + (b[0] ** 2 + b[1] ** 2) * (a[1] - m[1])) / d
  const uy = ((a[0] ** 2 + a[1] ** 2) * (b[0] - m[0]) + (m[0] ** 2 + m[1] ** 2) * (a[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (m[0] - a[0])) / d
  const r = Math.hypot(a[0] - ux, a[1] - uy)
  const ang = (p: Pt): number => Math.atan2(p[1] - uy, p[0] - ux)
  const ta = ang(a)
  let tm = ang(m)
  let tb = ang(b)
  // sweep from a through m to b
  const norm = (t: number): number => ((t - ta) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
  tm = norm(tm)
  tb = norm(tb)
  const sweep = tm <= tb ? tb : tb - 2 * Math.PI
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = ta + (sweep * i) / n
    out.push([ux + r * Math.cos(t), uy + r * Math.sin(t)])
  }
  return out
}

export function circlePoints(c: Pt, r: number, n = 32): Pt[] {
  return Array.from({ length: n }, (_, i) => [c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)] as Pt)
}

/** Join segments end to end into closed loops (ends within `tol`); segments that close no loop are dropped. */
export function loops(segs: readonly [Pt, Pt][], tol = 1e-3): Poly[] {
  const key = (p: Pt): string => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)}`
  const left = segs.map((s) => [...s] as [Pt, Pt])
  const used = new Array<boolean>(left.length).fill(false)
  const byEnd = new Map<string, number[]>()
  left.forEach(([a, b], i) => {
    for (const k of [key(a), key(b)]) (byEnd.get(k) ?? byEnd.set(k, []).get(k) as number[]).push(i)
  })
  const out: Poly[] = []
  for (let i = 0; i < left.length; i++) {
    if (used[i]) continue
    used[i] = true
    const [s0, s1] = left[i] as [Pt, Pt]
    const ring: Pt[] = [s0, s1]
    let end = s1
    for (let guard = 0; guard < left.length; guard++) {
      if (key(end) === key(s0)) break
      const next = (byEnd.get(key(end)) ?? []).find((j) => !used[j])
      if (next === undefined) break
      used[next] = true
      const [a, b] = left[next] as [Pt, Pt]
      end = key(a) === key(end) ? b : a
      ring.push(end)
    }
    if (ring.length >= 4 && key(ring[ring.length - 1] as Pt) === key(s0)) out.push(ring.slice(0, -1))
  }
  return out
}

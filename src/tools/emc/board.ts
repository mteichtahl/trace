/**
 * What the EMC tools need from a board beyond src/tools/kicad/pcb.ts's Board: the copper zones' filled polygons (the real
 * plane shapes, with the voids KiCad left around other nets' copper), the Edge.Cuts outline as segments, each
 * dielectric's loss tangent, and planar geometry helpers (point in polygon, polygon area and clipping, convex hull).
 *
 * KiCad writes a zone's fill as one or more `filled_polygon` outlines per layer, "fractured": holes are joined to
 * the outline by zero-width slits, so an even-odd point-in-polygon test on each outline is exact. A zone that was
 * never filled has only its `polygon` (the outline drawn by the user); that is used instead and reported as
 * unfilled, since it ignores clearances to other copper.
 */
import { readFileSync } from 'node:fs'

import { loadBoard, type Board } from '../kicad/pcb.js'
import * as sx from '../kicad/sexpr.js'

export type Pt = [number, number]
export type Poly = Pt[]

export interface ZoneFill { net: string | null; layer: string; polygons: Poly[]; filled: boolean; name: string | null; keepout: boolean }

export interface BoardGeometry {
  board: Board
  zones: ZoneFill[]
  /** Edge.Cuts as line segments (arcs and circles as 16-segment polylines), mm */
  edges: [number, number, number, number][]
  /** loss tangent of the dielectric below copper layer i (index as Board.layers); null when not given */
  lossTangent: (number | null)[]
}

function pts(node: sx.SList | undefined): Poly {
  const out: Poly = []
  const p = sx.find(node, 'pts')
  for (const q of sx.findAll(p, 'xy')) {
    const x = sx.num(q[1])
    const y = sx.num(q[2])
    if (x !== undefined && y !== undefined) out.push([x, y])
  }
  return out
}

function netOf(z: sx.SList, table: Map<string, string>): string | null {
  const c = sx.find(z, 'net')
  if (c) {
    const a = sx.atomAt(c, 1)
    const b = sx.atomAt(c, 2)
    if (b !== undefined) return b || null
    if (a !== undefined) {
      const named = table.get(a)
      if (named !== undefined) return named || null
      if (!/^\d+$/.test(a)) return a || null
    }
  }
  return sx.value(z, 'net_name') ?? null
}

function arcPoints(a: Pt, m: Pt, b: Pt, n = 16): Pt[] {
  const ax = a[0] - m[0]
  const ay = a[1] - m[1]
  const bx = b[0] - m[0]
  const by = b[1] - m[1]
  const d = 2 * (ax * by - ay * bx)
  if (Math.abs(d) < 1e-12) return [a, b]
  const a2 = ax * ax + ay * ay
  const b2 = bx * bx + by * by
  const cx = m[0] + (by * a2 - ay * b2) / d
  const cy = m[1] + (ax * b2 - bx * a2) / d
  const r = Math.hypot(a[0] - cx, a[1] - cy)
  const t1 = Math.atan2(a[1] - cy, a[0] - cx)
  const tm = Math.atan2(m[1] - cy, m[0] - cx)
  const t2 = Math.atan2(b[1] - cy, b[0] - cx)
  const TAU = 2 * Math.PI
  const mod = (x: number): number => ((x % TAU) + TAU) % TAU
  let sweep = mod(t2 - t1)
  let sign = 1
  if (mod(tm - t1) > sweep) {
    sweep = TAU - sweep
    sign = -1
  }
  return Array.from({ length: n + 1 }, (_, k) => [cx + r * Math.cos(t1 + (sign * sweep * k) / n), cy + r * Math.sin(t1 + (sign * sweep * k) / n)] as Pt)
}

function rot(px: number, py: number, fx: number, fy: number, deg: number): Pt {
  const th = (deg * Math.PI) / 180
  return [fx + px * Math.cos(th) + py * Math.sin(th), fy - px * Math.sin(th) + py * Math.cos(th)]
}

function edgeSegments(node: sx.SList, xf: (p: Pt) => Pt): [number, number, number, number][] {
  const kind = sx.head(node) ?? ''
  const P = (name: string): Pt | null => {
    const c = sx.find(node, name)
    const x = sx.num(c?.[1])
    const y = sx.num(c?.[2])
    return x !== undefined && y !== undefined ? [x, y] : null
  }
  const chain = (ps: Pt[], close = false): [number, number, number, number][] => {
    const t = ps.map(xf)
    const out: [number, number, number, number][] = []
    for (let i = 1; i < t.length; i++) out.push([(t[i - 1] as Pt)[0], (t[i - 1] as Pt)[1], (t[i] as Pt)[0], (t[i] as Pt)[1]])
    if (close && t.length > 2) out.push([(t[t.length - 1] as Pt)[0], (t[t.length - 1] as Pt)[1], (t[0] as Pt)[0], (t[0] as Pt)[1]])
    return out
  }
  if (kind.endsWith('_line')) {
    const a = P('start')
    const b = P('end')
    return a && b ? chain([a, b]) : []
  }
  if (kind.endsWith('_rect')) {
    const a = P('start')
    const b = P('end')
    return a && b ? chain([a, [b[0], a[1]], b, [a[0], b[1]]], true) : []
  }
  if (kind.endsWith('_arc')) {
    const a = P('start')
    const m = P('mid')
    const b = P('end')
    return a && m && b ? chain(arcPoints(a, m, b)) : []
  }
  if (kind.endsWith('_circle')) {
    const c = P('center')
    const e = P('end')
    if (!c || !e) return []
    const r = Math.hypot(e[0] - c[0], e[1] - c[1])
    return chain(Array.from({ length: 32 }, (_, k) => [c[0] + r * Math.cos((k * Math.PI) / 16), c[1] + r * Math.sin((k * Math.PI) / 16)] as Pt), true)
  }
  if (kind.endsWith('_poly')) return chain(pts(node), true)
  return []
}

const layerList = (node: sx.SList): string[] => {
  const one = sx.value(node, 'layer')
  if (one !== undefined) return [one]
  const many = sx.find(node, 'layers')
  return many ? sx.atoms(many) : []
}

export function readGeometry(path: string): BoardGeometry {
  const board = loadBoard(path)
  const tree = sx.parse(readFileSync(board.path, 'utf8'))
  const table = new Map<string, string>()
  for (const n of sx.findAll(tree, 'net')) {
    const code = sx.atomAt(n, 1)
    const name = sx.atomAt(n, 2)
    if (code !== undefined && name !== undefined) table.set(code, name)
  }
  const zones: ZoneFill[] = []
  for (const z of sx.findAll(tree, 'zone')) {
    const net = netOf(z, table)
    const keepout = sx.find(z, 'keepout') !== undefined
    const name = sx.value(z, 'name') ?? null
    const fills = sx.findAll(z, 'filled_polygon')
    const byLayer = new Map<string, Poly[]>()
    for (const f of fills) {
      const ly = sx.value(f, 'layer') ?? layerList(z)[0]
      if (!ly) continue
      const p = pts(f)
      if (p.length >= 3) byLayer.set(ly, [...(byLayer.get(ly) ?? []), p])
    }
    if (byLayer.size) {
      for (const [layer, polygons] of byLayer) zones.push({ net, layer, polygons, filled: true, name, keepout })
    } else {
      const outline = pts(sx.find(z, 'polygon'))
      for (const layer of layerList(z)) if (layer.endsWith('.Cu') && outline.length >= 3) zones.push({ net, layer, polygons: [outline], filled: false, name, keepout })
    }
  }
  const edges: [number, number, number, number][] = []
  for (const g of sx.children(tree)) {
    if ((sx.head(g) ?? '').startsWith('gr_') && layerList(g).includes('Edge.Cuts')) edges.push(...edgeSegments(g, (p) => p))
  }
  for (const fp of [...sx.findAll(tree, 'footprint'), ...sx.findAll(tree, 'module')]) {
    const at = sx.xy(fp)
    if (!at) continue
    for (const g of sx.children(fp)) {
      if ((sx.head(g) ?? '').startsWith('fp_') && layerList(g).includes('Edge.Cuts')) edges.push(...edgeSegments(g, (p) => rot(p[0], p[1], at[0], at[1], at[2])))
    }
  }
  // loss tangents, in stackup order (dielectric rows between copper rows)
  const st = sx.find(sx.find(tree, 'setup'), 'stackup')
  const lossTangent: (number | null)[] = board.layers.map(() => null)
  if (st) {
    let cu = -1
    for (const ly of sx.findAll(st, 'layer')) {
      const type = sx.value(ly, 'type') ?? ''
      if (type === 'copper') cu++
      else if (cu >= 0 && cu < board.layers.length - 1 && (type === 'core' || type === 'prepreg' || (sx.atomAt(ly, 1) ?? '').startsWith('dielectric'))) {
        const t = sx.numValue(ly, 'loss_tangent')
        if (t !== undefined) lossTangent[cu] = t
      }
    }
  }
  return { board, zones, edges, lossTangent }
}

// ------------------------------------------------------------------------------------------- planar helpers

export function pointInPoly(x: number, y: number, poly: Poly): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i] as Pt
    const [xj, yj] = poly[j] as Pt
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export function polyArea(poly: Poly): number {
  let s = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += ((poly[j] as Pt)[0] + (poly[i] as Pt)[0]) * ((poly[j] as Pt)[1] - (poly[i] as Pt)[1])
  return Math.abs(s / 2)
}

/** Sutherland-Hodgman: the part of `poly` inside the axis-aligned box. */
export function clipToBox(poly: Poly, x0: number, y0: number, x1: number, y1: number): Poly {
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ]
  let out = poly
  for (const [inside, cut] of edges) {
    const input = out
    out = []
    for (let i = 0; i < input.length; i++) {
      const cur = input[i] as Pt
      const prev = input[(i + input.length - 1) % input.length] as Pt
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur))
        out.push(cur)
      } else if (inside(prev)) out.push(cut(prev, cur))
    }
    if (!out.length) return []
  }
  return out
}

/** Andrew's monotone chain. */
export function convexHull(points: readonly Pt[]): Poly {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as Pt, lower[lower.length - 1] as Pt, q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: Pt[] = []
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2] as Pt, upper[upper.length - 1] as Pt, q) <= 0) upper.pop()
    upper.push(q)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

/** Liang-Barsky: the part of segment a-b inside the box, or null. */
export function clipSegment(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): [number, number, number, number] | null {
  let t0 = 0
  let t1 = 1
  const dx = bx - ax
  const dy = by - ay
  const tests: [number, number][] = [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const r = q / p
    if (p < 0) {
      if (r > t1) return null
      if (r > t0) t0 = r
    } else {
      if (r < t0) return null
      if (r < t1) t1 = r
    }
  }
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy]
}

// ------------------------------------------------------------------------------------------- net classes

export const GROUND = /^(\/)?(GND\w*|\w*GND|VSS\w*|0|EARTH|CHASSIS|PE)$/i
export const POWER = /^(\/)?(\+?\d+V\d*\w*|\+\w+|-\d+V\d*\w*|V(CC|DD|BAT|IN|SYS|BUS|REF|MAIN|IO|CORE)\w*|\w*(VCC|VDD|VBAT)\w*)$/i
export const CLOCKISH = /(CLK|SCK|SCLK|MCLK|BCLK|LRCLK|XTAL|XIN|XOUT|OSC|USB_D[PNM+-]?|D[PN]$|TXD|RXD|MOSI|MISO|PWM)/i
export const SWITCHING = /(^|[^A-Z0-9])(SW|LX|PH|PHASE|SWN|SW_NODE|HG|LG|HO|LO|HDRV|LDRV|GATE|GH|GL|BST|BOOT)(\d*)($|[^A-Z])/i

export const isGround = (n: string): boolean => GROUND.test(n)
export const isPower = (n: string): boolean => !isGround(n) && POWER.test(n)

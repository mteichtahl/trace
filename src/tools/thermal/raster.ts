/**
 * From a .kicad_pcb to the 2.5D grid (grid.ts) and the 3D voxel mesh (calculix.ts): the board outline, the stackup,
 * each copper layer's coverage rasterised from the zones' filled polygons (scanline, even-odd, so the voids KiCad
 * left around other nets are kept), tracks (capsules) and pads (rectangles), with `samples` x `samples`
 * sub-samples per cell, the vias' barrels per cell, and each part's pads as its heat source.
 *
 * A zone that was never filled is rasterised from its outline (it ignores clearances) and reported. A stackup
 * without thicknesses gets 35 um copper and the board thickness shared between the dielectrics; every assumption is
 * listed in `assumptions`.
 */
import { readGeometry, type BoardGeometry } from '../emc/board.js'
import type { Pad } from '../kicad/pcb.js'
import type { DielectricSpec, GridModel, LayerSpec, PartMap } from './grid.js'
import { COPPER, FR4 } from './materials.js'
import type { PerSurface } from './convection.js'

export interface Material { k_z: number; k_xy: number; rho_cp: number }

export interface RasterOptions {
  cell_mm: number
  samples?: number
  /** per part: power (W) */
  power: ReadonlyMap<string, number>
  laminate?: Partial<Material>
  copper_k?: number
  emissivity: PerSurface
  plating_m?: number
  /** extra film coefficients: a heatsink or cold plate over a rectangle on one side */
  heatsinks?: readonly { x_mm: number; y_mm: number; w_mm: number; h_mm: number; side: 'top' | 'bottom'; h_w_m2k: number; label: string }[]
}

export interface Rasterised {
  model: GridModel
  geometry: BoardGeometry
  assumptions: string[]
  unfilled_zones: string[]
  /** parts with power that had no pads to put it on (their power is spread over their footprint position) */
  unplaced: string[]
  copper_fraction: { layer: string; fraction: number }[]
  vias: number
}

type Seg = [number, number, number, number]

/** Even-odd inside test against an unordered set of closed edge loops (Edge.Cuts). */
function insideEdges(x: number, y: number, edges: readonly Seg[]): boolean {
  let inside = false
  for (const [x1, y1, x2, y2] of edges) {
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside
  }
  return inside
}

/** Fill a polygon (even-odd) into a sub-sample bitmap by scanlines. */
function fillPolygon(bits: Uint8Array, W: number, H: number, x0: number, y0: number, step: number, poly: readonly (readonly [number, number])[]): void {
  const n = poly.length
  const xs: number[] = []
  for (let r = 0; r < H; r++) {
    const y = y0 + (r + 0.5) * step
    xs.length = 0
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = poly[i]!
      const [xj, yj] = poly[j]!
      if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi))
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k]! - x0) / step - 0.5))
      const c1 = Math.min(W - 1, Math.floor((xs[k + 1]! - x0) / step - 0.5))
      for (let c = c0; c <= c1; c++) bits[r * W + c] = bits[r * W + c]! ^ 1
    }
  }
}

function fillRect(bits: Uint8Array, W: number, H: number, x0: number, y0: number, step: number, cx: number, cy: number, w: number, h: number): void {
  const c0 = Math.max(0, Math.ceil((cx - w / 2 - x0) / step - 0.5))
  const c1 = Math.min(W - 1, Math.floor((cx + w / 2 - x0) / step - 0.5))
  const r0 = Math.max(0, Math.ceil((cy - h / 2 - y0) / step - 0.5))
  const r1 = Math.min(H - 1, Math.floor((cy + h / 2 - y0) / step - 0.5))
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) bits[r * W + c] = 1
}

function fillCapsule(bits: Uint8Array, W: number, H: number, x0: number, y0: number, step: number, s: Seg, w: number): void {
  const [ax, ay, bx, by] = s
  const r = w / 2
  const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - x0) / step))
  const c1 = Math.min(W - 1, Math.ceil((Math.max(ax, bx) + r - x0) / step))
  const q0 = Math.max(0, Math.floor((Math.min(ay, by) - r - y0) / step))
  const q1 = Math.min(H - 1, Math.ceil((Math.max(ay, by) + r - y0) / step))
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  for (let q = q0; q <= q1; q++) {
    const py = y0 + (q + 0.5) * step
    for (let c = c0; c <= c1; c++) {
      const px = x0 + (c + 0.5) * step
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
      const ex = px - (ax + t * dx)
      const ey = py - (ay + t * dy)
      if (ex * ex + ey * ey <= r * r) bits[q * W + c] = 1
    }
  }
}

const padOn = (p: Pad, layer: string): boolean => p.layers.some((l) => l === layer || l === '*.Cu' || (l === 'F&B.Cu' && (layer === 'F.Cu' || layer === 'B.Cu')))

export function rasterise(path: string, o: RasterOptions): Rasterised {
  const g = readGeometry(path)
  const b = g.board
  const assumptions: string[] = []
  const cell = o.cell_mm
  const S = o.samples ?? 4
  // ---- outline
  let edges: Seg[] = g.edges
  let bx0: number, by0: number, bx1: number, by1: number
  if (edges.length >= 3) {
    bx0 = Math.min(...edges.flatMap((e) => [e[0], e[2]]))
    bx1 = Math.max(...edges.flatMap((e) => [e[0], e[2]]))
    by0 = Math.min(...edges.flatMap((e) => [e[1], e[3]]))
    by1 = Math.max(...edges.flatMap((e) => [e[1], e[3]]))
  } else if (b.outline) {
    ;({ min_x_mm: bx0, min_y_mm: by0, max_x_mm: bx1, max_y_mm: by1 } = b.outline)
    edges = [[bx0, by0, bx1, by0], [bx1, by0, bx1, by1], [bx1, by1, bx0, by1], [bx0, by1, bx0, by0]]
    assumptions.push('no Edge.Cuts loops: the outline bounding box is the board')
  } else throw new Error('the board has no outline (Edge.Cuts)')
  const nx = Math.max(2, Math.ceil((bx1 - bx0) / cell))
  const ny = Math.max(2, Math.ceil((by1 - by0) / cell))
  const N = nx * ny
  const inside = new Uint8Array(N)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) inside[j * nx + i] = insideEdges(bx0 + (i + 0.5) * cell, by0 + (j + 0.5) * cell, edges) ? 1 : 0
  // ---- stackup
  const names = b.layers.map((l) => l.name)
  if (!names.length) throw new Error('the board has no copper layers')
  const lam: Material = { k_z: o.laminate?.k_z ?? FR4.k_through.value, k_xy: o.laminate?.k_xy ?? FR4.k_inplane.value, rho_cp: o.laminate?.rho_cp ?? FR4.rho.value * FR4.cp.value }
  const layers: LayerSpec[] = b.layers.map((l) => {
    if (l.t === null) assumptions.push(`${l.name}: copper thickness not in the stackup, 35 um assumed`)
    return { name: l.name, t_cu: l.t ?? 35e-6 }
  })
  const totalT = (b.thickness_mm ?? 1.6) * 1e-3
  const diel: DielectricSpec[] = []
  if (layers.length === 1) diel.push({ t: totalT, ...lam })
  for (let l = 0; l + 1 < layers.length; l++) {
    const d = b.layers[l]!.below?.[0]
    if (!d) assumptions.push(`dielectric below ${names[l]}: thickness not in the stackup, the board thickness shared evenly`)
    diel.push({ t: d ?? (totalT - layers.reduce((s, x) => s + x.t_cu, 0)) / (layers.length - 1), ...lam })
  }
  // ---- copper coverage
  const W = nx * S
  const H = ny * S
  const step = cell / S
  const unfilled: string[] = []
  const coverage = names.map((name) => {
    const bits = new Uint8Array(W * H)
    for (const z of g.zones) {
      if (z.layer !== name || z.keepout) continue
      if (!z.filled) unfilled.push(`${z.name ?? z.net ?? '(zone)'} on ${name}`)
      for (const p of z.polygons) {
        const own = new Uint8Array(W * H)
        fillPolygon(own, W, H, bx0, by0, step, p)
        for (let k = 0; k < own.length; k++) if (own[k]) bits[k] = 1
      }
    }
    for (const segs of Object.values(b.segments)) for (const s of segs) if (s[5] === name) fillCapsule(bits, W, H, bx0, by0, step, [s[0], s[1], s[2], s[3]], s[4])
    for (const pads of [...Object.values(b.pads), b.unnetted ?? []]) for (const p of pads) if (padOn(p, name)) fillRect(bits, W, H, bx0, by0, step, p.x, p.y, p.w, p.h)
    for (const vias of Object.values(b.vias)) for (const v of vias) {
      const i0 = names.indexOf(v[4])
      const i1 = names.indexOf(v[5])
      const li = names.indexOf(name)
      if (li >= Math.min(i0, i1) && li <= Math.max(i0, i1)) fillRect(bits, W, H, bx0, by0, step, v[0], v[1], v[2], v[2])
    }
    const cov = new Float64Array(N)
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let n = 0
      for (let q = 0; q < S; q++) for (let c = 0; c < S; c++) n += bits[(j * S + q) * W + i * S + c]!
      cov[j * nx + i] = inside[j * nx + i] ? n / (S * S) : 0
    }
    return cov
  })
  // ---- vias: barrel conductance per cell between successive layers in each via's span
  const kcu = o.copper_k ?? COPPER.k.value
  const plating = o.plating_m ?? 20e-6
  const viaG = diel.slice(0, Math.max(0, layers.length - 1)).map(() => new Float64Array(N))
  let viaCount = 0
  for (const vias of Object.values(b.vias)) for (const v of vias) {
    const i = Math.floor((v[0] - bx0) / cell)
    const j = Math.floor((v[1] - by0) / cell)
    if (i < 0 || j < 0 || i >= nx || j >= ny) continue
    const drill = (v[3] ?? v[2] * 0.5) * 1e-3
    if (v[3] === null) assumptions.push('a via without a drill size: half its pad assumed')
    const area = (Math.PI / 4) * ((drill + 2 * plating) ** 2 - drill ** 2)
    const i0 = Math.max(0, Math.min(names.indexOf(v[4]), names.indexOf(v[5])))
    const i1 = Math.max(names.indexOf(v[4]), names.indexOf(v[5]))
    for (let l = i0; l < i1; l++) viaG[l]![j * nx + i] = viaG[l]![j * nx + i]! + (kcu * area) / diel[l]!.t
    viaCount++
  }
  // through-hole pads conduct like vias
  for (const pads of [...Object.values(b.pads), b.unnetted ?? []]) for (const p of pads) {
    if (!p.drill || !p.layers.some((l) => l === '*.Cu')) continue
    const i = Math.floor((p.x - bx0) / cell)
    const j = Math.floor((p.y - by0) / cell)
    if (i < 0 || j < 0 || i >= nx || j >= ny) continue
    const d = Math.min(p.drill[0], p.drill[1]) * 1e-3
    const area = (Math.PI / 4) * ((d + 2 * plating) ** 2 - d ** 2)
    for (let l = 0; l + 1 < layers.length; l++) viaG[l]![j * nx + i] = viaG[l]![j * nx + i]! + (kcu * area) / diel[l]!.t
  }
  // ---- heat sources
  const byRef = new Map<string, Pad[]>()
  for (const pads of [...Object.values(b.pads), b.unnetted ?? []]) for (const p of pads) byRef.set(p.ref, [...(byRef.get(p.ref) ?? []), p])
  const parts: PartMap[] = []
  const unplaced: string[] = []
  for (const [ref, pw] of o.power) {
    const fp = b.footprints.find((f) => f.ref === ref)
    if (!fp) { unplaced.push(ref); continue }
    const layer = fp.side === 'bottom' ? layers.length - 1 : 0
    const w = new Map<number, number>()
    const pads = byRef.get(ref) ?? []
    const rects = pads.length ? pads.map((p) => [p.x, p.y, p.w, p.h] as const) : [[fp.x_mm, fp.y_mm, cell, cell] as const]
    if (!pads.length) unplaced.push(ref)
    for (const [cx, cy, pw2, ph] of rects) {
      const area = pw2 * ph
      const i0 = Math.max(0, Math.floor((cx - pw2 / 2 - bx0) / cell))
      const i1 = Math.min(nx - 1, Math.floor((cx + pw2 / 2 - bx0) / cell))
      const j0 = Math.max(0, Math.floor((cy - ph / 2 - by0) / cell))
      const j1 = Math.min(ny - 1, Math.floor((cy + ph / 2 - by0) / cell))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const ox = Math.max(0, Math.min(cx + pw2 / 2, bx0 + (i + 1) * cell) - Math.max(cx - pw2 / 2, bx0 + i * cell))
        const oy = Math.max(0, Math.min(cy + ph / 2, by0 + (j + 1) * cell) - Math.max(cy - ph / 2, by0 + j * cell))
        const c = j * nx + i
        if (ox * oy > 0 && inside[c]) w.set(layer * N + c, (w.get(layer * N + c) ?? 0) + (ox * oy) / Math.max(area, 1e-12))
      }
    }
    const total = [...w.values()].reduce((s, x) => s + x, 0)
    if (!total) { unplaced.push(ref); continue }
    parts.push({ ref, layer, power_w: pw, nodes: Int32Array.from(w.keys()), weights: Float64Array.from([...w.values()].map((x) => x / total)) })
  }
  const extraH = (o.heatsinks ?? []).map((hs) => {
    const h = new Float64Array(N)
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = bx0 + (i + 0.5) * cell
      const y = by0 + (j + 0.5) * cell
      if (inside[j * nx + i] && Math.abs(x - hs.x_mm) <= hs.w_mm / 2 && Math.abs(y - hs.y_mm) <= hs.h_mm / 2) h[j * nx + i] = hs.h_w_m2k
    }
    return { layer: hs.side === 'bottom' ? layers.length - 1 : 0, h, label: hs.label }
  })
  const model: GridModel = {
    nx, ny, dx: cell * 1e-3, dy: cell * 1e-3, origin_mm: [bx0, by0], inside, layers, diel, coverage, viaG, parts, extraH,
    copper: { k: kcu, rho_cp: COPPER.rho.value * COPPER.cp.value }, emissivity: o.emissivity,
  }
  const cells = inside.reduce((s, x) => s + x, 0)
  return {
    model, geometry: g, assumptions: [...new Set(assumptions)], unfilled_zones: [...new Set(unfilled)], unplaced: [...new Set(unplaced)], vias: viaCount,
    copper_fraction: names.map((name, l) => ({ layer: name, fraction: cells ? coverage[l]!.reduce((s, x) => s + x, 0) / cells : 0 })),
  }
}

/**
 * The 2.5D board model: a finite-volume grid of nx x ny cells with one node per copper layer, solved with
 * Jacobi-preconditioned CG (sparse.ts). Fast enough to run on every commit.
 *
 *   in-plane       each layer node is a sheet: K = k_Cu t_Cu c + sum over the adjacent dielectrics of k_xy t/2
 *                  (c the cell's copper coverage, each dielectric split half to the layer above and half below);
 *                  neighbours are joined by the series (harmonic) conductance of their half cells
 *   through-plane  between successive layers: k_z A / t of the dielectric, plus the via barrels in the cell
 *                  (k_Cu A_barrel / t each, src/tools/calc/pcb.ts's barrel area)
 *   boundaries     top and bottom faces lose heat by h A (the film coefficient, convection.ts) plus radiation
 *                  eps sigma (T^4 - Ts^4) A, linearised per cell and iterated (Picard); board edges by the edge
 *                  coefficient over the edge area; extra coefficients (a heatsink, a cold plate) on given cells
 *   sources        each part's power spread over its pads' cells on its own layer (from the budget)
 *   transient      implicit (backward) Euler, C = A (rho c_p t) per node, h fixed at the steady-state values
 *
 * Not modelled: component bodies (heat leaving through a part's top), solder mask and air gaps under parts (the
 * pads are taken as perfectly attached), lateral conduction in vias, and anything about airflow beyond h.
 */
import { Csr, pcg } from './sparse.js'
import { hRadiation, type PerSurface } from './convection.js'
import { KELVIN, SIGMA } from './materials.js'

export interface LayerSpec { name: string; t_cu: number }
export interface DielectricSpec { t: number; k_z: number; k_xy: number; rho_cp: number }

export interface PartMap {
  ref: string
  layer: number
  power_w: number
  /** node indices and weights (sum 1): where its power goes, and how its board temperature is averaged */
  nodes: Int32Array
  weights: Float64Array
}

export interface GridModel {
  nx: number
  ny: number
  /** cell size (m) */
  dx: number
  dy: number
  /** the grid's lower-left corner in board coordinates (mm), for maps and probes */
  origin_mm: [number, number]
  inside: Uint8Array
  layers: LayerSpec[]
  /** the dielectrics between successive copper layers (length L - 1), or the whole laminate when L = 1 */
  diel: DielectricSpec[]
  coverage: Float64Array[]
  /** extra vertical conductance per cell between layer l and l + 1 (W/K): via barrels */
  viaG: Float64Array[]
  parts: PartMap[]
  /** other heat (W per node), e.g. trace I^2 R */
  extraPower?: Float64Array
  /** extra film coefficient per cell on a layer's outer face (W/m^2 K): a heatsink or cold plate */
  extraH: { layer: number; h: Float64Array; label: string }[]
  copper: { k: number; rho_cp: number }
  emissivity: PerSurface
}

export const nodeCount = (m: GridModel): number => m.nx * m.ny * m.layers.length

/** The dielectric thickness each layer's node owns (half of each adjacent dielectric). */
export function shares(m: GridModel): { t: number; kxyT: number; rhoCpT: number }[] {
  const L = m.layers.length
  return m.layers.map((_, l) => {
    if (L === 1) { const d = m.diel[0]!; return { t: d.t, kxyT: d.k_xy * d.t, rhoCpT: d.rho_cp * d.t } }
    let t = 0
    let kxyT = 0
    let rhoCpT = 0
    for (const d of [l > 0 ? m.diel[l - 1] : undefined, l < L - 1 ? m.diel[l] : undefined]) {
      if (!d) continue
      t += d.t / 2
      kxyT += (d.k_xy * d.t) / 2
      rhoCpT += (d.rho_cp * d.t) / 2
    }
    return { t, kxyT, rhoCpT }
  })
}

export interface Structure {
  /** conduction only (no boundary terms) */
  K: Csr
  /** per node: area facing the top / bottom sink (m^2), and edge area */
  topArea: Float64Array
  bottomArea: Float64Array
  edgeArea: Float64Array
  /** per node heat capacity (J/K) */
  C: Float64Array
  power: Float64Array
}

export function structure(m: GridModel): Structure {
  const { nx, ny, dx, dy } = m
  const L = m.layers.length
  const N = nx * ny
  const A = dx * dy
  const sh = shares(m)
  const gx = new Float64Array(N * L)
  const gy = new Float64Array(N * L)
  const gz = new Float64Array(N * L)
  const topArea = new Float64Array(N * L)
  const bottomArea = new Float64Array(N * L)
  const edgeArea = new Float64Array(N * L)
  const C = new Float64Array(N * L)
  const sheet = (l: number, c: number): number => m.copper.k * m.layers[l]!.t_cu * m.coverage[l]![c]! + sh[l]!.kxyT
  for (let l = 0; l < L; l++) {
    const off = l * N
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i
        if (!m.inside[c]) continue
        const Ka = sheet(l, c)
        C[off + c] = A * (m.copper.rho_cp * m.layers[l]!.t_cu * m.coverage[l]![c]! + sh[l]!.rhoCpT)
        const edgeT = sh[l]!.t + m.layers[l]!.t_cu
        if (i + 1 < nx && m.inside[c + 1]) {
          const Kb = sheet(l, c + 1)
          gx[off + c] = (2 * dy * Ka * Kb) / (dx * (Ka + Kb))
        }
        if (j + 1 < ny && m.inside[c + nx]) {
          const Kb = sheet(l, c + nx)
          gy[off + c] = (2 * dx * Ka * Kb) / (dy * (Ka + Kb))
        }
        const exposedX = (i === 0 || !m.inside[c - 1] ? 1 : 0) + (i === nx - 1 || !m.inside[c + 1] ? 1 : 0)
        const exposedY = (j === 0 || !m.inside[c - nx] ? 1 : 0) + (j === ny - 1 || !m.inside[c + nx] ? 1 : 0)
        edgeArea[off + c] = edgeT * (exposedX * dy + exposedY * dx)
        if (l === 0) topArea[off + c] = A
        if (l === L - 1) bottomArea[off + c] = A
        if (l < L - 1) {
          const d = m.diel[l]!
          gz[off + c] = (d.k_z * A) / d.t + (m.viaG[l]?.[c] ?? 0)
        }
      }
    }
  }
  const power = new Float64Array(N * L)
  for (const p of m.parts) for (let k = 0; k < p.nodes.length; k++) power[p.nodes[k]!] = power[p.nodes[k]!]! + p.power_w * p.weights[k]!
  if (m.extraPower) for (let k = 0; k < power.length; k++) power[k] = power[k]! + m.extraPower[k]!
  return { K: stencil(N * L, [[1, gx], [nx, gy], [N, gz]]), topArea, bottomArea, edgeArea, C, power }
}

/** The symmetric matrix of a regular stencil: g[k] links node k to node k + offset. */
export function stencil(n: number, links: readonly (readonly [number, Float64Array])[]): Csr {
  const diag = new Float64Array(n)
  const counts = new Int32Array(n)
  for (const [o, g] of links) for (let k = 0; k < n; k++) if (g[k]) { diag[k] = diag[k]! + g[k]!; diag[k + o] = diag[k + o]! + g[k]!; counts[k] = counts[k]! + 1; counts[k + o] = counts[k + o]! + 1 }
  const ptr = new Int32Array(n + 1)
  for (let k = 0; k < n; k++) ptr[k + 1] = ptr[k]! + counts[k]! + 1
  const col = new Int32Array(ptr[n]!)
  const val = new Float64Array(ptr[n]!)
  const fill = Int32Array.from(ptr.subarray(0, n))
  const put = (r: number, c: number, v: number): void => { const p = fill[r]!; col[p] = c; val[p] = v; fill[r] = p + 1 }
  // columns in increasing order: lower neighbours (largest offset first), the diagonal, upper neighbours
  const sorted = [...links].sort((a, b) => b[0] - a[0])
  for (let k = 0; k < n; k++) {
    for (const [o, g] of sorted) if (k - o >= 0 && g[k - o]) put(k, k - o, -g[k - o]!)
    put(k, k, diag[k]!)
    for (let i = sorted.length - 1; i >= 0; i--) { const [o, g] = sorted[i]!; if (g[k]) put(k, k + o, -g[k]!) }
  }
  return new Csr(n, ptr, col, val)
}

export interface Solution {
  T: Float64Array
  cg_iterations: number
  cg_residual: number
  converged: boolean
  picard_iterations: number
  /** heat leaving per surface (W) by convection and by radiation, with the exact (non-linearised) radiation */
  convective_w: PerSurface
  radiative_w: PerSurface
  extra_w: number
  input_w: number
  /** (out - in) / in */
  balance_error: number
  mean_c: PerSurface
}

interface Boundary { g: Float64Array; conv: Float64Array[]; radEps: Float64Array[] }

/** The per-node boundary conductance to the sink for these h values and (for radiation) temperatures. */
function boundary(m: GridModel, s: Structure, h: PerSurface, T: Float64Array | null, sinkC: number, radiation: boolean): Boundary {
  const n = s.C.length
  const g = new Float64Array(n)
  const conv = [new Float64Array(n), new Float64Array(n), new Float64Array(n)]
  const radEps = [new Float64Array(n), new Float64Array(n), new Float64Array(n)]
  const N = m.nx * m.ny
  const areas = [s.topArea, s.bottomArea, s.edgeArea]
  const hs = [h.top, h.bottom, h.edge]
  const eps = [m.emissivity.top, m.emissivity.bottom, m.emissivity.edge]
  for (let k = 0; k < n; k++) {
    if (!s.C[k]) continue
    const t = T ? T[k]! : sinkC
    for (let f = 0; f < 3; f++) {
      const a = areas[f]![k]!
      if (!a) continue
      conv[f]![k] = hs[f]! * a
      if (radiation && eps[f]! > 0) radEps[f]![k] = eps[f]! * a
      g[k] = g[k]! + hs[f]! * a + (radiation && eps[f]! > 0 ? hRadiation(eps[f]!, t, sinkC) * a : 0)
    }
  }
  for (const x of m.extraH) {
    const off = x.layer * N
    for (let c = 0; c < N; c++) if (x.h[c]) g[off + c] = g[off + c]! + x.h[c]! * m.dx * m.dy
  }
  return { g, conv, radEps }
}

function meanOf(m: GridModel, s: Structure, T: Float64Array): PerSurface {
  const avg = (area: Float64Array): number => {
    let a = 0
    let t = 0
    for (let k = 0; k < area.length; k++) if (area[k]) { a += area[k]!; t += area[k]! * T[k]! }
    return a > 0 ? t / a : NaN
  }
  const top = avg(s.topArea)
  const edge = avg(s.edgeArea)
  return { top, bottom: avg(s.bottomArea), edge: Number.isFinite(edge) ? edge : top }
}

function losses(m: GridModel, s: Structure, b: Boundary, T: Float64Array, sinkC: number): { conv: PerSurface; rad: PerSurface; extra: number } {
  const names = ['top', 'bottom', 'edge'] as const
  const conv = { top: 0, bottom: 0, edge: 0 }
  const rad = { top: 0, bottom: 0, edge: 0 }
  const ts = sinkC + KELVIN
  for (let f = 0; f < 3; f++) {
    for (let k = 0; k < T.length; k++) {
      const dT = T[k]! - sinkC
      conv[names[f]!] += b.conv[f]![k]! * dT
      const e = b.radEps[f]![k]!
      if (e) rad[names[f]!] += e * SIGMA * ((T[k]! + KELVIN) ** 4 - ts ** 4)
    }
  }
  let extra = 0
  const N = m.nx * m.ny
  for (const x of m.extraH) for (let c = 0; c < N; c++) if (x.h[c]) extra += x.h[c]! * m.dx * m.dy * (T[x.layer * N + c]! - sinkC)
  return { conv, rad, extra }
}

/** Steady state for fixed convective h (radiation iterated), from an optional starting field. */
export function solveSteady(m: GridModel, s: Structure, h: PerSurface, sinkC: number, o: { radiation?: boolean; x0?: Float64Array; tol?: number } = {}): Solution {
  const radiation = o.radiation ?? true
  const n = s.C.length
  let T: Float64Array = o.x0 ? Float64Array.from(o.x0) : new Float64Array(n).fill(sinkC)
  let iterations = 0
  let residual = 0
  let converged = true
  let picard = 0
  let b = boundary(m, s, h, null, sinkC, radiation)
  for (let pi = 0; pi < 40; pi++) {
    picard++
    const A = s.K.plusDiagonal(b.g)
    const rhs = new Float64Array(n)
    for (let k = 0; k < n; k++) rhs[k] = s.power[k]! + b.g[k]! * sinkC
    // unknown nodes outside the board have empty rows: pin them at the sink
    for (let k = 0; k < n; k++) if (!s.C[k]) rhs[k] = 0
    const r = pcg(pinOutside(A, s), rhs, { x0: T, tol: o.tol ?? 1e-11 })
    iterations += r.iterations
    residual = r.residual
    converged = converged && r.converged
    let change = 0
    for (let k = 0; k < n; k++) change = Math.max(change, Math.abs(r.x[k]! - T[k]!))
    T = r.x
    for (let k = 0; k < n; k++) if (!s.C[k]) T[k] = sinkC
    if (!radiation || change < 1e-4) break
    b = boundary(m, s, h, T, sinkC, radiation)
  }
  const l = losses(m, s, b, T, sinkC)
  const input = s.power.reduce((x, y) => x + y, 0)
  const out = l.conv.top + l.conv.bottom + l.conv.edge + l.rad.top + l.rad.bottom + l.rad.edge + l.extra
  return {
    T, cg_iterations: iterations, cg_residual: residual, converged, picard_iterations: picard, convective_w: l.conv, radiative_w: l.rad, extra_w: l.extra,
    input_w: input, balance_error: input > 0 ? (out - input) / input : 0, mean_c: meanOf(m, s, T),
  }
}

/** Rows of nodes outside the board are empty: give them a unit diagonal so the matrix stays positive definite. */
function pinOutside(A: Csr, s: Structure): Csr {
  const add = new Float64Array(A.n)
  let any = false
  for (let k = 0; k < A.n; k++) if (!s.C[k]) { add[k] = 1; any = true }
  return any ? A.plusDiagonal(add) : A
}

/** A part's board temperature: the weighted mean over its pad nodes. */
export function partTemp(p: PartMap, T: Float64Array): number {
  let t = 0
  for (let k = 0; k < p.nodes.length; k++) t += T[p.nodes[k]!]! * p.weights[k]!
  return t
}

export interface TransientFrame { t_s: number; max_c: number; min_c: number; parts: Record<string, number> }
export interface TransientResult { frames: TransientFrame[]; final: Float64Array; steps: number; cg_iterations: number }

/** Backward Euler from a uniform start at the sink temperature, with h fixed; radiation linearised at the previous step. */
export function solveTransient(m: GridModel, s: Structure, h: PerSurface, sinkC: number, o: { dt_s: number; duration_s: number; record_every?: number; radiation?: boolean; start?: Float64Array }): TransientResult {
  const n = s.C.length
  const steps = Math.ceil(o.duration_s / o.dt_s)
  const every = o.record_every ?? Math.max(1, Math.floor(steps / 200))
  let T: Float64Array = o.start ? Float64Array.from(o.start) : new Float64Array(n).fill(sinkC)
  const frames: TransientFrame[] = []
  const frame = (t: number): void => {
    let mx = -Infinity
    let mn = Infinity
    for (let k = 0; k < n; k++) if (s.C[k]) { mx = Math.max(mx, T[k]!); mn = Math.min(mn, T[k]!) }
    frames.push({ t_s: t, max_c: mx, min_c: mn, parts: Object.fromEntries(m.parts.map((p) => [p.ref, partTemp(p, T)])) })
  }
  frame(0)
  let cgIt = 0
  const cdt = new Float64Array(n)
  for (let k = 0; k < n; k++) cdt[k] = s.C[k]! / o.dt_s
  for (let st = 1; st <= steps; st++) {
    const b = boundary(m, s, h, T, sinkC, o.radiation ?? true)
    const diag = new Float64Array(n)
    for (let k = 0; k < n; k++) diag[k] = b.g[k]! + cdt[k]!
    const A = pinOutside(s.K.plusDiagonal(diag), s)
    const rhs = new Float64Array(n)
    for (let k = 0; k < n; k++) rhs[k] = s.C[k] ? s.power[k]! + b.g[k]! * sinkC + cdt[k]! * T[k]! : 0
    const r = pcg(A, rhs, { x0: T, tol: 1e-10 })
    cgIt += r.iterations
    T = r.x
    for (let k = 0; k < n; k++) if (!s.C[k]) T[k] = sinkC
    if (st % every === 0 || st === steps) frame(Math.min(st * o.dt_s, o.duration_s))
  }
  return { frames, final: T, steps, cg_iterations: cgIt }
}

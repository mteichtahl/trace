/**
 * A two-dimensional field solver for the cross-section of one trace or one edge-coupled pair: what a line's
 * impedance and delay really are on a given stackup, rather than what a closed form estimates.
 *
 * The closed forms in impedance.ts (Hammerstad-Jensen, IPC-2141A) are fitted to one trace over one plane, or one
 * trace between two; a pair between dielectrics of different permittivity, or a trace under solder mask, is outside
 * what they were fitted to. This solves Laplace's equation, div(eps grad phi) = 0, on a graded grid over the
 * cross-section, by finite differences:
 *
 *   - the conductors are rectangles held at fixed potentials (Dirichlet), as are the reference planes and the box;
 *   - each grid cell has its own relative permittivity (the stackup's dielectrics, the solder mask, air);
 *   - the capacitance matrix comes from the field energy, W = 1/2 sum over grid edges of eps (delta phi)^2, with
 *     one conductor at 1 V (C11) and with both at 1 V (C11 + 2 C12 + C22);
 *   - the inductance matrix from the same geometry in vacuum, L = mu0 eps0 C0^-1 (a TEM line's inductance does not
 *     depend on the dielectric).
 *
 * For a symmetric pair this gives the odd and even modes: Zodd = sqrt((L11 - L12)/(C11 - C12)), Zeven =
 * sqrt((L11 + L12)/(C11 + C12)), Zdiff = 2 Zodd, Zcommon = Zeven/2, and each mode's delay per metre
 * sqrt((L11 -+ L12)(C11 -+ C12)).
 *
 * The linear system (a symmetric positive-definite weighted Laplacian) is solved matrix-free by Jacobi-
 * preconditioned conjugate gradients on Float64Arrays. The capacitance comes from the field energy, which is
 * variational, so its error is second order in the potential's.
 *
 * Accuracy: the grid is graded (default 2.5 um at every copper and dielectric boundary, growing by 1.3x per line
 * away from them, up to 8 steps). test/tools/calc/fieldsolve.test.ts checks it against the exact zero-thickness stripline
 * (S. B. Cohn, IRE Trans. MTT-2, 1954) and Hammerstad-Jensen's microstrip (IEEE MTT-S Digest 1980), and shows it
 * converging as the grid is refined. Results are cached per cross-section in the machine's cache database
 * (store.Cache, namespace "fieldsolve").
 */
import { createHash } from 'node:crypto'
import { Cache } from '../../core/store.js'

export const EPS0 = 8.8541878128e-12
export const MU0 = 4e-7 * Math.PI
export const C0 = 299_792_458
export const ETA0 = 376.730313668

const SOLVER_VERSION = 2
const CACHE_NS = 'fieldsolve'

export class SolverError extends Error {
  override name = 'SolverError'
}

/** A horizontal band of dielectric from y0 to y1 (m, y up) of relative permittivity er. */
export interface Slab { readonly y0: number; readonly y1: number; readonly er: number }
/** A rectangle of copper: [x_left, x_right, y_bottom, y_top] in m. */
export type Rect = readonly [number, number, number, number]

/**
 * A cross-section: the traces, the dielectric slabs, the planes below and above (their y, or null for open), the
 * solder mask over the traces (thickness m, er) and grounded copper beside them.
 */
export interface Section {
  readonly traces: readonly Rect[]
  readonly slabs: readonly Slab[]
  readonly planeBelow: number | null
  readonly planeAbove: number | null
  readonly mask?: readonly [number, number] | undefined
  readonly maskSide?: 'top' | 'bottom' | undefined
  readonly grounds?: readonly Rect[] | undefined
}

type Mat = number[][]

/** Per-metre line parameters of a section. */
export class Lines {
  constructor(readonly C: Mat, readonly L: Mat) {}

  get n(): number { return this.C.length }
  private e(m: Mat, i: number, j: number): number {
    const v = m[i]?.[j]
    if (v === undefined) throw new SolverError('a mode impedance needs a pair')
    return v
  }
  /** One trace; or trace 1 with trace 2 held at 0 V. */
  get z0(): number { return Math.sqrt(this.e(this.L, 0, 0) / this.e(this.C, 0, 0)) }
  get zodd(): number { return Math.sqrt((this.e(this.L, 0, 0) - this.e(this.L, 0, 1)) / (this.e(this.C, 0, 0) - this.e(this.C, 0, 1))) }
  get zeven(): number { return Math.sqrt((this.e(this.L, 0, 0) + this.e(this.L, 0, 1)) / (this.e(this.C, 0, 0) + this.e(this.C, 0, 1))) }
  get zdiff(): number { return 2 * this.zodd }
  get zcomm(): number { return this.zeven / 2 }
  /** s/m of the odd (differential) mode. */
  get delayOdd(): number { return Math.sqrt((this.e(this.L, 0, 0) - this.e(this.L, 0, 1)) * (this.e(this.C, 0, 0) - this.e(this.C, 0, 1))) }
  get delayEven(): number { return Math.sqrt((this.e(this.L, 0, 0) + this.e(this.L, 0, 1)) * (this.e(this.C, 0, 0) + this.e(this.C, 0, 1))) }
  /** s/m: the single trace's, or the odd mode's for a pair. */
  get delay(): number { return this.n === 2 ? this.delayOdd : Math.sqrt(this.e(this.L, 0, 0) * this.e(this.C, 0, 0)) }
  get erEff(): number { return (this.delay * C0) ** 2 }
}

/**
 * Grid lines from lo to hi through every mark (a copper or dielectric boundary), spaced `fine` at the marks and
 * growing by `grow` per line away from them, up to `coarse`.
 */
function axis(lo: number, hi: number, marks: readonly number[], fine: number, coarse: number, grow = 1.3): Float64Array {
  const pts = [...new Set([...marks.map((m) => Math.min(Math.max(m, lo), hi)), lo, hi])].sort((a, b) => a - b)
  const out: number[] = [pts[0] as number]
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i] as number
    const b = pts[i + 1] as number
    const gap = b - a
    if (gap <= 0) continue
    const left: number[] = []
    const right: number[] = []
    let x = a
    let step = fine
    while (x + step < a + gap / 2) { x += step; left.push(x); step = Math.min(step * grow, coarse) }
    x = b
    step = fine
    while (x - step > a + gap / 2) { x -= step; right.push(x); step = Math.min(step * grow, coarse) }
    const loEnd = left.length ? (left[left.length - 1] as number) : a
    const hiEnd = right.length ? (right[right.length - 1] as number) : b
    const span = hiEnd - loEnd
    const mid: number[] = []
    if (span > coarse) {
      const k = Math.ceil(span / coarse)
      for (let j = 1; j < k; j++) mid.push(loEnd + (span * j) / k)
    }
    out.push(...left, ...mid, ...right.reverse(), b)
  }
  return Float64Array.from(out)
}

const at = (a: Float64Array, i: number): number => a[i] as number

/** The capacitance matrix (F/m) of the section, from field energies on a graded grid. */
function solveC(sec: Section, dx: number, vacuum: boolean, tol: number): Mat {
  const xs = sec.traces.flatMap((t) => [t[0], t[1]])
  const ys = sec.traces.flatMap((t) => [t[2], t[3]])
  const xLo = Math.min(...xs)
  const xHi = Math.max(...xs)
  const yMin = Math.min(...ys)
  const yMax = Math.max(...ys)
  // the field of a trace over a plane dies within a few heights: the box sits 12 heights out (an open face 12
  // heights above the copper), where moving it further changes Z0 by well under 1 %
  const h = Math.max(yMin - (sec.planeBelow ?? yMin - 0.15e-3), (sec.planeAbove ?? yMax + 0.15e-3) - yMax)
  const margin = Math.max(0.6e-3, 12 * h)
  const yLo = sec.planeBelow ?? yMin - margin
  const yHi = sec.planeAbove ?? yMax + margin
  const x0 = xLo - margin
  const x1 = xHi + margin
  const grounds = sec.grounds ?? []
  const ymarks = [...ys, ...sec.slabs.flatMap((s) => [s.y0, s.y1]), ...grounds.flatMap((g) => [g[2], g[3]])]
  const xmarks = [...xs, ...grounds.flatMap((g) => [g[0], g[1]])]
  if (sec.mask) {
    const mt = sec.mask[0]
    for (const t of sec.traces) { ymarks.push(t[2] - mt, t[3] + mt); xmarks.push(t[0] - mt, t[1] + mt) }
  }
  const coarse = Math.max(dx * 8, 20e-6)
  const X = axis(x0, x1, xmarks, dx, coarse)
  const Y = axis(yLo, yHi, ymarks, dx, coarse)
  const nx = X.length
  const ny = Y.length
  const cx = new Float64Array(nx - 1)
  const hx = new Float64Array(nx - 1)
  for (let i = 0; i < nx - 1; i++) { hx[i] = at(X, i + 1) - at(X, i); cx[i] = (at(X, i + 1) + at(X, i)) / 2 }
  const cy = new Float64Array(ny - 1)
  const hy = new Float64Array(ny - 1)
  for (let j = 0; j < ny - 1; j++) { hy[j] = at(Y, j + 1) - at(Y, j); cy[j] = (at(Y, j + 1) + at(Y, j)) / 2 }
  // cell permittivity, (ny-1) x (nx-1)
  const ncx = nx - 1
  const er = new Float64Array((ny - 1) * ncx).fill(1)
  if (!vacuum) {
    for (const s of sec.slabs) {
      for (let j = 0; j < ny - 1; j++) if (at(cy, j) >= s.y0 && at(cy, j) < s.y1) er.fill(s.er, j * ncx, (j + 1) * ncx)
    }
    if (sec.mask) {
      const [mt, mer] = sec.mask
      const top = (sec.maskSide ?? 'top') === 'top'
      const face = top ? Math.max(...sec.traces.map((t) => t[2])) : Math.min(...sec.traces.map((t) => t[3]))
      for (let j = 0; j < ny - 1; j++) {
        const y = at(cy, j)
        if (top ? y >= face && y < face + mt : y < face && y >= face - mt) er.fill(mer, j * ncx, (j + 1) * ncx)
      }
      for (const [a, b, c, d] of sec.traces) {
        for (let j = 0; j < ny - 1; j++) {
          const y = at(cy, j)
          if (!(y >= c - mt && y < d + mt)) continue
          for (let i = 0; i < ncx; i++) {
            const x = at(cx, i)
            if (x >= a - mt && x < b + mt) er[j * ncx + i] = Math.max(at(er, j * ncx + i), mer)
          }
        }
      }
    }
  }
  const N = nx * ny
  const cond = new Int32Array(N).fill(-1)
  const fixed = new Uint8Array(N)
  const mark = (r: Rect, k: number, lim: boolean) => {
    const a = lim ? Math.max(r[0], x0) : r[0]
    const b = lim ? Math.min(r[1], x1) : r[1]
    let hit = false
    for (let j = 0; j < ny; j++) {
      const y = at(Y, j)
      if (!(y >= r[2] - 1e-12 && y <= r[3] + 1e-12)) continue
      for (let i = 0; i < nx; i++) {
        const x = at(X, i)
        if (x >= a - 1e-12 && x <= b + 1e-12) { const p = j * nx + i; fixed[p] = 1; if (k >= 0) cond[p] = k; hit = true }
      }
    }
    return hit
  }
  sec.traces.forEach((t, k) => { if (!mark(t, k, false)) throw new SolverError(`trace ${k} is thinner than the grid`) })
  for (const g of grounds) mark(g, -1, true)
  for (let i = 0; i < nx; i++) { fixed[i] = 1; fixed[(ny - 1) * nx + i] = 1 }
  for (let j = 0; j < ny; j++) { fixed[j * nx] = 1; fixed[j * nx + nx - 1] = 1 }
  // edge weights: permittivity times dual-cell width over edge length; permittivity of the two cells the edge
  // borders weighted by their share of the dual cell
  const erAt = (j: number, i: number) => (j < 0 || i < 0 || j >= ny - 1 || i >= ncx ? 1 : at(er, j * ncx + i))
  const hyP = (j: number) => (j < 0 || j >= ny - 1 ? 0 : at(hy, j))
  const hxP = (i: number) => (i < 0 || i >= nx - 1 ? 0 : at(hx, i))
  const wh = new Float64Array(ny * (nx - 1))      // horizontal edge (j,i)-(j,i+1)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx - 1; i++) {
      wh[j * (nx - 1) + i] = (erAt(j - 1, i) * hyP(j - 1) + erAt(j, i) * hyP(j)) / 2 / at(hx, i)
    }
  }
  const wv = new Float64Array((ny - 1) * nx)      // vertical edge (j,i)-(j+1,i)
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx; i++) {
      wv[j * nx + i] = (erAt(j, i - 1) * hxP(i - 1) + erAt(j, i) * hxP(i)) / 2 / at(hy, j)
    }
  }
  /** out = -div(eps grad phi) over the full grid. */
  const lap = (phi: Float64Array, out: Float64Array) => {
    out.fill(0)
    for (let j = 0; j < ny; j++) {
      const row = j * nx
      for (let i = 0; i < nx - 1; i++) {
        const f = at(wh, j * (nx - 1) + i) * (at(phi, row + i + 1) - at(phi, row + i))
        out[row + i] = at(out, row + i) - f
        out[row + i + 1] = at(out, row + i + 1) + f
      }
    }
    for (let j = 0; j < ny - 1; j++) {
      const row = j * nx
      for (let i = 0; i < nx; i++) {
        const f = at(wv, row + i) * (at(phi, row + nx + i) - at(phi, row + i))
        out[row + i] = at(out, row + i) - f
        out[row + nx + i] = at(out, row + nx + i) + f
      }
    }
  }
  const diag = new Float64Array(N)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const w = at(wh, j * (nx - 1) + i)
      diag[j * nx + i] = at(diag, j * nx + i) + w
      diag[j * nx + i + 1] = at(diag, j * nx + i + 1) + w
    }
  }
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx; i++) {
      const w = at(wv, j * nx + i)
      diag[j * nx + i] = at(diag, j * nx + i) + w
      diag[(j + 1) * nx + i] = at(diag, (j + 1) * nx + i) + w
    }
  }
  const tmp = new Float64Array(N)

  const energy = (volts: readonly number[]): number => {
    const phi = new Float64Array(N)
    for (let p = 0; p < N; p++) { const k = cond[p] ?? -1; if (k >= 0) phi[p] = volts[k] ?? 0 }
    // right-hand side: the fixed potentials moved across, b = -A_free,fixed phi_fixed
    lap(phi, tmp)
    const r = new Float64Array(N)
    for (let p = 0; p < N; p++) if (!fixed[p]) r[p] = -at(tmp, p)
    // preconditioned CG on the free nodes, phi holds the fixed values throughout
    const x = new Float64Array(N)
    const z = new Float64Array(N)
    const pv = new Float64Array(N)
    const ap = new Float64Array(N)
    let bn = 0
    for (let p = 0; p < N; p++) bn += at(r, p) ** 2
    bn = Math.sqrt(bn)
    if (bn > 0) {
      let rz = 0
      for (let p = 0; p < N; p++) if (!fixed[p]) { z[p] = at(r, p) / at(diag, p); pv[p] = at(z, p); rz += at(r, p) * at(z, p) }
      let it = 0
      for (; it < 100_000; it++) {
        lap(pv, ap)
        let pap = 0
        for (let p = 0; p < N; p++) if (!fixed[p]) pap += at(pv, p) * at(ap, p)
        const alpha = rz / pap
        let rn = 0
        for (let p = 0; p < N; p++) {
          if (fixed[p]) continue
          x[p] = at(x, p) + alpha * at(pv, p)
          r[p] = at(r, p) - alpha * at(ap, p)
          rn += at(r, p) ** 2
        }
        if (Math.sqrt(rn) <= tol * bn) break
        let rzNew = 0
        for (let p = 0; p < N; p++) if (!fixed[p]) { z[p] = at(r, p) / at(diag, p); rzNew += at(r, p) * at(z, p) }
        const beta = rzNew / rz
        rz = rzNew
        for (let p = 0; p < N; p++) if (!fixed[p]) pv[p] = at(z, p) + beta * at(pv, p)
      }
      if (it >= 100_000) throw new SolverError('the field solution did not converge')
      for (let p = 0; p < N; p++) if (!fixed[p]) phi[p] = at(x, p)
    }
    let w = 0
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx - 1; i++) {
      const d = at(phi, j * nx + i + 1) - at(phi, j * nx + i)
      w += at(wh, j * (nx - 1) + i) * d * d
    }
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx; i++) {
      const d = at(phi, (j + 1) * nx + i) - at(phi, j * nx + i)
      w += at(wv, j * nx + i) * d * d
    }
    return 0.5 * EPS0 * w
  }
  if (sec.traces.length === 1) return [[2 * energy([1])]]
  const w1 = energy([1, 0])
  const w2 = energy([0, 1])
  const w12 = energy([1, 1])
  const c11 = 2 * w1
  const c22 = 2 * w2
  const c12 = (2 * w12 - c11 - c22) / 2
  return [[c11, c12], [c12, c22]]
}

function inv(m: Mat): Mat {
  const a = m[0]?.[0] ?? NaN
  if (m.length === 1) return [[1 / a]]
  const b = m[0]?.[1] ?? NaN
  const c = m[1]?.[0] ?? NaN
  const d = m[1]?.[1] ?? NaN
  const det = a * d - b * c
  return [[d / det, -b / det], [-c / det, a / det]]
}

export interface SolveOptions {
  /** Grid step at copper and dielectric boundaries (m), default 2.5 um. */
  readonly dx?: number
  /** Use the machine's cache database (default true). */
  readonly cache?: boolean
  /** Conjugate-gradient relative residual (default 1e-9). */
  readonly tol?: number
}

const memo = new Map<string, Lines>()

/** Per-metre C and L of the section's traces. */
export function solve(sec: Section, opts: SolveOptions = {}): Lines {
  const dx = opts.dx ?? 2.5e-6
  const tol = opts.tol ?? 1e-9
  if (sec.traces.length < 1 || sec.traces.length > 2) throw new SolverError('a section has one trace or one pair')
  if (!(dx > 0)) throw new SolverError('the grid step must be positive')
  const key = createHash('sha256').update(`${SOLVER_VERSION}|${dx}|${tol}|${JSON.stringify(sec)}`).digest('hex').slice(0, 32)
  const hit = memo.get(key)
  if (hit) return hit
  let cache: Cache | null = null
  if (opts.cache ?? true) {
    try { cache = new Cache() } catch { cache = null } // a missing or read-only cache only costs time
  }
  try {
    const stored = cache?.get<{ C: Mat; L: Mat }>(CACHE_NS, key)
    if (stored && Array.isArray(stored.C) && Array.isArray(stored.L)) {
      const l = new Lines(stored.C, stored.L)
      memo.set(key, l)
      return l
    }
    const C = solveC(sec, dx, false, tol)
    const C0m = solveC(sec, dx, true, tol)
    const k = MU0 * EPS0
    const L = inv(C0m).map((row) => row.map((v) => k * v))
    const lines = new Lines(C, L)
    memo.set(key, lines)
    try { cache?.put(CACHE_NS, key, { C, L }) } catch { /* cache is best-effort */ }
    return lines
  } finally {
    cache?.close()
  }
}

// ------------------------------------------------------------------------------------------- building sections
function traces(w: number, t: number, y0: number, s: number | undefined): Rect[] {
  if (s === undefined) return [[-w / 2, w / 2, y0, y0 + t]]
  return [[-s / 2 - w, -s / 2, y0, y0 + t], [s / 2, s / 2 + w, y0, y0 + t]]
}

/** One trace (s undefined) or an edge-coupled pair (gap s) on an outer layer: plane at y = 0, dielectric h thick. */
export function microstrip(w: number, t: number, h: number, er: number, s?: number, mask?: readonly [number, number]): Section {
  return { traces: traces(w, t, h, s), slabs: [{ y0: 0, y1: h, er }], planeBelow: 0, planeAbove: null, mask, maskSide: 'top' }
}

/** A trace h above its plane, buried under dielectric up to `cover` above the plane (cover > h + t), then air. */
export function embeddedMicrostrip(w: number, t: number, h: number, er: number, cover: number, erCover?: number, s?: number): Section {
  return {
    traces: traces(w, t, h, s), slabs: [{ y0: 0, y1: h, er }, { y0: h, y1: cover, er: erCover ?? er }], planeBelow: 0, planeAbove: null,
  }
}

/**
 * A trace (or pair) between two planes: h1 (er1) below the trace's bottom face, h2 (er2) from its bottom face to the
 * plane above (the copper's thickness sits inside h2, as a fabricator's stackup puts prepreg round it).
 */
export function stripline(w: number, t: number, h1: number, er1: number, h2: number, er2?: number, s?: number): Section {
  return {
    traces: traces(w, t, h1, s), slabs: [{ y0: 0, y1: h1, er: er1 }, { y0: h1, y1: h1 + h2, er: er2 ?? er1 }],
    planeBelow: 0, planeAbove: h1 + h2,
  }
}

// ------------------------------------------------------------------------------------------- reference forms
/** Complete elliptic integral of the first kind K(k), by the arithmetic-geometric mean. */
export function ellipK(k: number): number {
  let a = 1
  let b = Math.sqrt(1 - k * k)
  for (let i = 0; i < 40; i++) { const an = (a + b) / 2; b = Math.sqrt(a * b); a = an }
  return Math.PI / (2 * a)
}

/**
 * Cohn's exact Z0 of a zero-thickness strip centred between plates b apart (S. B. Cohn, "Characteristic impedance of
 * the shielded-strip transmission line", IRE Trans. MTT-2, 1954): Z0 = eta0/(4 sqrt(er)) K(k)/K(k'),
 * k = sech(pi w / 2b).
 */
export function striplineExact(w: number, b: number, er: number): number {
  const k = 1 / Math.cosh((Math.PI * w) / (2 * b))
  const kp = Math.sqrt(1 - k * k)
  return (ETA0 / (4 * Math.sqrt(er))) * (ellipK(k) / ellipK(kp))
}

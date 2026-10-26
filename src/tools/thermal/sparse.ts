/**
 * A symmetric sparse matrix (CSR) assembled from conductances, and the preconditioned conjugate gradient solver
 * with a Jacobi (diagonal) preconditioner (Saad, Iterative Methods for Sparse Linear Systems, 2nd ed., alg. 9.1).
 * The thermal network matrix is symmetric positive definite whenever any node has a path to the sink, which CG needs.
 */

export class Assembler {
  private readonly rows: Map<number, number>[]
  constructor(readonly n: number) {
    this.rows = Array.from({ length: n }, () => new Map<number, number>())
  }

  /** A conductance g (W/K) between nodes a and b. */
  link(a: number, b: number, g: number): void {
    if (!(g > 0)) return
    const ra = this.rows[a]!
    const rb = this.rows[b]!
    ra.set(a, (ra.get(a) ?? 0) + g)
    rb.set(b, (rb.get(b) ?? 0) + g)
    ra.set(b, (ra.get(b) ?? 0) - g)
    rb.set(a, (rb.get(a) ?? 0) - g)
  }

  /** A conductance g from node a to a fixed temperature (the sink): adds to the diagonal. */
  ground(a: number, g: number): void {
    if (!(g > 0)) return
    const r = this.rows[a]!
    r.set(a, (r.get(a) ?? 0) + g)
  }

  csr(): Csr {
    let nnz = 0
    for (const r of this.rows) nnz += r.size
    const ptr = new Int32Array(this.n + 1)
    const col = new Int32Array(nnz)
    const val = new Float64Array(nnz)
    let k = 0
    for (let i = 0; i < this.n; i++) {
      ptr[i] = k
      const entries = [...this.rows[i]!.entries()].sort((x, y) => x[0] - y[0])
      for (const [j, v] of entries) { col[k] = j; val[k] = v; k++ }
    }
    ptr[this.n] = k
    return new Csr(this.n, ptr, col, val)
  }
}

export class Csr {
  constructor(readonly n: number, readonly ptr: Int32Array, readonly col: Int32Array, readonly val: Float64Array) {}

  mul(x: Float64Array, out: Float64Array): void {
    const { ptr, col, val } = this
    for (let i = 0; i < this.n; i++) {
      let s = 0
      for (let k = ptr[i]!; k < ptr[i + 1]!; k++) s += val[k]! * x[col[k]!]!
      out[i] = s
    }
  }

  diagonal(): Float64Array {
    const d = new Float64Array(this.n)
    for (let i = 0; i < this.n; i++) for (let k = this.ptr[i]!; k < this.ptr[i + 1]!; k++) if (this.col[k] === i) d[i] = this.val[k]!
    return d
  }

  /** A copy with `add` added to the diagonal (the C/dt term of a transient step). */
  plusDiagonal(add: Float64Array): Csr {
    const val = Float64Array.from(this.val)
    for (let i = 0; i < this.n; i++) for (let k = this.ptr[i]!; k < this.ptr[i + 1]!; k++) if (this.col[k] === i) val[k] = val[k]! + add[i]!
    return new Csr(this.n, this.ptr, this.col, val)
  }
}

export interface CgResult { x: Float64Array; iterations: number; residual: number; converged: boolean }

/** Solve A x = b by Jacobi-preconditioned CG, from x0, to ||r|| <= tol ||b||. */
export function pcg(A: Csr, b: Float64Array, o: { x0?: Float64Array; tol?: number; maxIterations?: number } = {}): CgResult {
  const n = A.n
  const tol = o.tol ?? 1e-10
  const maxIt = o.maxIterations ?? Math.max(1000, 10 * Math.ceil(Math.sqrt(n)) * 20)
  const x = o.x0 ? Float64Array.from(o.x0) : new Float64Array(n)
  const dinv = A.diagonal().map((d) => (d > 0 ? 1 / d : 1))
  const r = new Float64Array(n)
  const z = new Float64Array(n)
  const p = new Float64Array(n)
  const q = new Float64Array(n)
  A.mul(x, q)
  let bnorm = 0
  for (let i = 0; i < n; i++) { r[i] = b[i]! - q[i]!; bnorm += b[i]! * b[i]! }
  bnorm = Math.sqrt(bnorm) || 1
  let rz = 0
  for (let i = 0; i < n; i++) { z[i] = dinv[i]! * r[i]!; p[i] = z[i]!; rz += r[i]! * z[i]! }
  let res = 0
  for (let i = 0; i < n; i++) res += r[i]! * r[i]!
  res = Math.sqrt(res)
  let it = 0
  while (res > tol * bnorm && it < maxIt) {
    A.mul(p, q)
    let pq = 0
    for (let i = 0; i < n; i++) pq += p[i]! * q[i]!
    const alpha = rz / pq
    res = 0
    for (let i = 0; i < n; i++) {
      x[i] = x[i]! + alpha * p[i]!
      r[i] = r[i]! - alpha * q[i]!
      res += r[i]! * r[i]!
    }
    res = Math.sqrt(res)
    let rz2 = 0
    for (let i = 0; i < n; i++) { z[i] = dinv[i]! * r[i]!; rz2 += r[i]! * z[i]! }
    const beta = rz2 / rz
    rz = rz2
    for (let i = 0; i < n; i++) p[i] = z[i]! + beta * p[i]!
    it++
  }
  return { x, iterations: it, residual: res / bnorm, converged: res <= tol * bnorm }
}

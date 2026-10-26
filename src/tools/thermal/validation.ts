/**
 * The validation suite (thermal.validate, and the tests): each solver against closed forms (analytic.ts), at two
 * mesh sizes so the convergence shows.
 *
 *   slab    through-thickness conduction of a 2-layer board, uniform flux on top, top adiabatic, bottom cooled
 *   fin     a 4 mm wide, 1 mm thick, 100 mm long strip heated at one end, both faces cooled, adiabatic tip
 *   plate   a 300 mm square, 1 mm plate with a 10 mm radius central source, both faces cooled (the infinite-plate
 *           Bessel solution; the plate is six fin lengths wide, so its edge does not matter)
 *
 * The CFD reference is Churchill & Chu's vertical-plate Nusselt number at the plate's simulated rise.
 */
import { finRise, plateRise, slabRise } from './analytic.js'
import { type Environment, hVertical } from './convection.js'
import { type GridModel, solveSteady, structure } from './grid.js'
import { runModelCalculix } from './fem.js'

export const churchillChu = (dT: number, L: number, ambientC: number): number => hVertical(dT, L, ambientC + dT / 2).h

export interface ValidationRow { case: string; cell_mm: number; model: number; reference: number; error_pct: number; tolerance_pct: number; pass: boolean; quantity: string }

const TOL = { slab: 0.5, fin: 3, plate: 3 } as const

function base(nx: number, ny: number, cell: number): Omit<GridModel, 'layers' | 'diel' | 'coverage' | 'viaG' | 'parts'> {
  return { nx, ny, dx: cell, dy: cell, origin_mm: [0, 0], inside: new Uint8Array(nx * ny).fill(1), extraH: [], copper: { k: 385, rho_cp: 3.44e6 }, emissivity: { top: 0, bottom: 0, edge: 0 } }
}

type Case = {
  model: GridModel; h: { top: number; bottom: number; edge: number }; reference: number
  /** the 2.5D probe: cell-centred values */
  probe: (T: (layer: number, i: number, j: number) => number) => number
  /** the 3D probe: values at the lattice nodes of the top surface, and the reference there */
  node: (T: (i: number, j: number) => number) => number
  reference3d: number
}

export function slabCase(cell: number): Case {
  const side = 0.02
  const n = Math.round(side / cell)
  const t = 1.5e-3
  const k = 0.3
  const Q = 0.1
  const all = Int32Array.from({ length: n * n }, (_, c) => c)
  const model: GridModel = {
    ...base(n, n, cell), layers: [{ name: 'F.Cu', t_cu: 35e-6 }, { name: 'B.Cu', t_cu: 35e-6 }], diel: [{ t, k_z: k, k_xy: k, rho_cp: 2e6 }],
    coverage: [new Float64Array(n * n).fill(1), new Float64Array(n * n).fill(1)], viaG: [new Float64Array(n * n)],
    parts: [{ ref: 'HEAT', layer: 0, power_w: Q, nodes: all, weights: new Float64Array(n * n).fill(1 / (n * n)) }],
  }
  const ref = slabRise(Q / (side * side), t, k, 10).top
  return { model, h: { top: 0, bottom: 10, edge: 0 }, reference: ref, probe: (T) => T(0, Math.floor(n / 2), Math.floor(n / 2)), node: (T) => T(Math.floor(n / 2), Math.floor(n / 2)), reference3d: ref }
}

export function finCase(cell: number): Case {
  const L = 0.1
  const w = 0.004
  const t = 1e-3
  const k = 200
  const Q = 0.5
  const nx = Math.round(L / cell)
  const ny = Math.max(1, Math.round(w / cell))
  const first = Int32Array.from({ length: ny }, (_, j) => j * nx)
  const model: GridModel = {
    ...base(nx, ny, cell), layers: [{ name: 'P', t_cu: 0 }], diel: [{ t, k_z: k, k_xy: k, rho_cp: 2.4e6 }], coverage: [new Float64Array(nx * ny)], viaG: [],
    parts: [{ ref: 'HEAT', layer: 0, power_w: Q, nodes: first, weights: new Float64Array(ny).fill(1 / ny) }],
  }
  // the tip temperature: the last column's centre is at L - cell/2
  return {
    model, h: { top: 10, bottom: 10, edge: 0 }, reference: finRise(Q, 10, k, ny * cell, t, L, L - cell / 2), probe: (T) => { let s = 0; for (let j = 0; j < ny; j++) s += T(0, nx - 1, j); return s / ny },
    // the bricks' nodes at x = L (the tip itself); the heat enters over the first cell, so the reference is the fin
    // of length L - cell/2 from the source's centre
    node: (T) => { let s = 0; for (let j = 0; j <= ny; j++) s += T(nx, j); return s / (ny + 1) }, reference3d: finRise(Q, 10, k, ny * cell, t, L - cell / 2, L - cell / 2),
  }
}

export function plateCase(cell: number): Case {
  const side = 0.3
  const r0 = 0.01
  const k = 50
  const t = 1e-3
  const Q = 1
  const n = Math.round(side / cell)
  const S = 8
  const w = new Map<number, number>()
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let c = 0
    for (let q = 0; q < S; q++) for (let p = 0; p < S; p++) { const x = (i + (p + 0.5) / S) * cell - side / 2; const y = (j + (q + 0.5) / S) * cell - side / 2; if (x * x + y * y < r0 * r0) c++ }
    if (c) w.set(j * n + i, c)
  }
  const tot = [...w.values()].reduce((a, b) => a + b, 0)
  const model: GridModel = {
    ...base(n, n, cell), layers: [{ name: 'P', t_cu: 0 }], diel: [{ t, k_z: k, k_xy: k, rho_cp: 2.4e6 }], coverage: [new Float64Array(n * n)], viaG: [],
    parts: [{ ref: 'HEAT', layer: 0, power_w: Q, nodes: Int32Array.from(w.keys()), weights: Float64Array.from([...w.values()].map((x) => x / tot)) }],
  }
  const c = n / 2
  const ref = plateRise(Q, r0, k, t, 20)
  return { model, h: { top: 10, bottom: 10, edge: 0 }, reference: ref, probe: (T) => (T(0, c, c) + T(0, c - 1, c) + T(0, c, c - 1) + T(0, c - 1, c - 1)) / 4, node: (T) => T(c, c), reference3d: ref }
}

export const CASES = { slab: { make: slabCase, cells: [2e-3, 1e-3], quantity: 'top-surface rise (K)' }, fin: { make: finCase, cells: [2e-3, 1e-3], quantity: 'tip rise (K)' }, plate: { make: plateCase, cells: [5e-3, 2.5e-3], quantity: 'centre rise (K)' } } as const

const fixed = (h: { top: number; bottom: number; edge: number }): Environment => ({ kind: 'natural', ambient_c: 0, altitude_m: 0, orientation: 'horizontal', airflow_m_s: 0, emissivity: { top: 0, bottom: 0, edge: 0 }, radiation: false, h_override: h, h_multiplier: 1, enclosure: null })

export async function validate(solver: '2.5d' | 'calculix', cases: readonly (keyof typeof CASES)[] = ['slab', 'fin', 'plate']): Promise<ValidationRow[]> {
  const rows: ValidationRow[] = []
  for (const name of cases) {
    const def = CASES[name]
    for (const cell of def.cells) {
      const c = def.make(cell)
      const m = c.model
      const N = m.nx * m.ny
      let value: number
      let reference = c.reference
      if (solver === '2.5d') {
        const sol = solveSteady(m, structure(m), c.h, 0, { radiation: false })
        value = c.probe((l, i, j) => sol.T[l * N + j * m.nx + i]!)
      } else {
        const r = await runModelCalculix(m, { environment: fixed(c.h), sublayers: 2 })
        // the bricks' values are at nodes: probe the top-surface lattice, against the reference at those points
        const px = m.nx + 1
        const py = m.ny + 1
        const top = r.mesh.stats.layers.indexOf(m.layers[0]!.name)
        value = c.node((i, j) => r.temps.get((top * py + j) * px + i + 1) ?? NaN)
        reference = c.reference3d
      }
      const err = (100 * (value - reference)) / reference
      rows.push({ case: name, cell_mm: cell * 1e3, model: value, reference, error_pct: err, tolerance_pct: TOL[name], pass: Math.abs(err) <= TOL[name], quantity: def.quantity })
    }
  }
  return rows
}

/**
 * The board model, end to end: the envelope's environment at one ambient corner, the board rasterised (raster.ts),
 * film coefficients made consistent with the solved temperatures (convection.ts), the 2.5D grid solved (grid.ts),
 * and what comes out of it: per-part board temperatures, the hot spot, the energy balance, the maps (PNG, CSV, VTU,
 * GLB) and, optionally, the transient.
 */
import { type Envelope } from './store.js'
import { type Coefficient, type Environment, type FilmIteration, type PerSurface, type PlateGeometry, type Surface, solveFilm, SURFACES } from './convection.js'
import { colourBar, linePlot, mapImage, encodePng } from './image.js'
import { csv, type HexMesh, texturedSlab, vtu } from './export.js'
import { type GridModel, nodeCount, partTemp, shares, type Solution, solveSteady, solveTransient, structure } from './grid.js'
import { EMISSIVITY } from './materials.js'
import { rasterise, type RasterOptions, type Rasterised } from './raster.js'
import { metrics, type SeriesMetrics } from './transient.js'

/** The environment of an envelope at one ambient temperature, with the calibration multiplier and overrides. */
export function environmentOf(e: Envelope, ambientC: number, o: { h_multiplier?: number; h_override?: Partial<PerSurface>; emissivity?: Partial<PerSurface> } = {}): Environment {
  const mask = EMISSIVITY.solder_mask.value
  return {
    kind: e.environment, ambient_c: ambientC, altitude_m: e.altitude_m, orientation: e.orientation, airflow_m_s: e.airflow_m_s,
    emissivity: { top: o.emissivity?.top ?? e.emissivity?.top ?? mask, bottom: o.emissivity?.bottom ?? e.emissivity?.bottom ?? mask, edge: o.emissivity?.edge ?? e.emissivity?.edge ?? EMISSIVITY.fr4.value },
    radiation: e.radiation || e.environment === 'vacuum', h_override: o.h_override ?? {}, h_multiplier: o.h_multiplier ?? 1, enclosure: e.enclosure ?? null,
  }
}

/** The ambient corners of an envelope, coldest first. */
export const cornersOf = (e: Envelope): number[] => [...new Set([e.ambient_min_c, ...(e.ambient_nominal_c !== undefined ? [e.ambient_nominal_c] : []), e.ambient_max_c])].sort((a, b) => a - b)

export interface PartResult { ref: string; power_w: number; board_c: number; layer: string }

export interface BoardRun {
  raster: Omit<Rasterised, 'model' | 'geometry'>
  model: GridModel
  environment: Environment
  plate: PlateGeometry
  ambient_c: number
  sink_c: number
  coefficients: Record<Surface, Coefficient>
  film_iterations: FilmIteration[]
  film_converged: boolean
  sealed?: unknown
  solution: Solution
  parts: PartResult[]
  hotspot: { x_mm: number; y_mm: number; layer: string; t_c: number }
  grid: { nx: number; ny: number; layers: number; nodes: number; cell_mm: number }
  solve_ms: number
  transient?: { metrics: SeriesMetrics[]; frames: { t_s: number; max_c: number; min_c: number; parts: Record<string, number> }[]; dt_s: number; duration_s: number; steps: number }
}

export interface BoardInput extends Omit<RasterOptions, 'emissivity'> {
  board: string
  environment: Environment
  transient?: { duration_s: number; dt_s: number } | undefined
}

export function plateOf(m: GridModel): PlateGeometry {
  const sh = shares(m)
  return { length_m: m.nx * m.dx, width_m: m.ny * m.dy, thickness_m: sh.reduce((s, x) => s + x.t, 0) + m.layers.reduce((s, l) => s + l.t_cu, 0) }
}

export async function runBoard(i: BoardInput): Promise<BoardRun> {
  const t0 = performance.now()
  const r = rasterise(i.board, { ...i, emissivity: i.environment.emissivity })
  const m = r.model
  const s = structure(m)
  const plate = plateOf(m)
  const total = s.power.reduce((a, b) => a + b, 0)
  let x0: Float64Array | undefined
  const film = await solveFilm(i.environment, plate, total, async (h, sink) => {
    const sol = solveSteady(m, s, h, sink, { radiation: i.environment.radiation, ...(x0 ? { x0 } : {}) })
    x0 = sol.T
    return { result: sol, meanC: sol.mean_c }
  })
  const sol = film.result
  const N = m.nx * m.ny
  let hk = 0
  for (let k = 0; k < sol.T.length; k++) if (s.C[k] && sol.T[k]! > sol.T[hk]!) hk = k
  const hl = Math.floor(hk / N)
  const hc = hk % N
  const hotspot = { x_mm: m.origin_mm[0] + ((hc % m.nx) + 0.5) * m.dx * 1e3, y_mm: m.origin_mm[1] + (Math.floor(hc / m.nx) + 0.5) * m.dy * 1e3, layer: m.layers[hl]!.name, t_c: sol.T[hk]! }
  const out: BoardRun = {
    raster: { assumptions: r.assumptions, unfilled_zones: r.unfilled_zones, unplaced: r.unplaced, copper_fraction: r.copper_fraction, vias: r.vias },
    model: m, environment: i.environment, plate, ambient_c: i.environment.ambient_c, sink_c: film.sink_c, coefficients: film.coefficients,
    film_iterations: film.iterations, film_converged: film.converged, ...(film.sealed ? { sealed: film.sealed } : {}), solution: sol,
    parts: m.parts.map((p) => ({ ref: p.ref, power_w: p.power_w, board_c: partTemp(p, sol.T), layer: m.layers[p.layer]!.name })),
    hotspot, grid: { nx: m.nx, ny: m.ny, layers: m.layers.length, nodes: nodeCount(m), cell_mm: m.dx * 1e3 }, solve_ms: 0,
  }
  if (i.transient) {
    const h = Object.fromEntries(SURFACES.map((k) => [k, film.coefficients[k].h])) as PerSurface
    const tr = solveTransient(m, s, h, film.sink_c, { dt_s: i.transient.dt_s, duration_s: i.transient.duration_s, radiation: i.environment.radiation })
    const series = [
      { name: 'board_max', t: tr.frames.map((f) => f.t_s), y: tr.frames.map((f) => f.max_c), steady: hotspot.t_c },
      ...m.parts.map((p) => ({ name: p.ref, t: tr.frames.map((f) => f.t_s), y: tr.frames.map((f) => f.parts[p.ref]!), steady: partTemp(p, sol.T) })),
    ]
    out.transient = { metrics: series.map((x) => metrics(x, x.steady)), frames: tr.frames, dt_s: i.transient.dt_s, duration_s: i.transient.duration_s, steps: tr.steps }
  }
  out.solve_ms = Math.round(performance.now() - t0)
  return out
}

// ------------------------------------------------------------------ artifacts

export interface Artifact { name: string; data: string | Uint8Array; mime: string }

/** One layer's temperatures as an nx x ny field (NaN outside the board). */
export function layerField(m: GridModel, T: Float64Array, l: number): Float64Array {
  const N = m.nx * m.ny
  const f = new Float64Array(N)
  for (let c = 0; c < N; c++) f[c] = m.inside[c] ? T[l * N + c]! : NaN
  return f
}

/** The 2.5D grid as hexahedra (one slab per layer node, its own thickness), with the temperature per cell. */
export function gridMesh(m: GridModel, T: Float64Array): HexMesh {
  const sh = shares(m)
  const L = m.layers.length
  const z: number[] = [0]
  for (let l = 0; l < L; l++) z.push(z[l]! - (sh[l]!.t + m.layers[l]!.t_cu))
  const px = m.nx + 1
  const py = m.ny + 1
  const points = new Float64Array(px * py * (L + 1) * 3)
  for (let k = 0; k <= L; k++) for (let j = 0; j < py; j++) for (let i = 0; i < px; i++) {
    const o = ((k * py + j) * px + i) * 3
    points[o] = m.origin_mm[0] * 1e-3 + i * m.dx
    points[o + 1] = m.origin_mm[1] * 1e-3 + j * m.dy
    points[o + 2] = z[k]!
  }
  const id = (i: number, j: number, k: number): number => (k * py + j) * px + i
  const hexes: number[] = []
  const temp: number[] = []
  const cov: number[] = []
  const N = m.nx * m.ny
  for (let l = 0; l < L; l++) for (let j = 0; j < m.ny; j++) for (let i = 0; i < m.nx; i++) {
    const c = j * m.nx + i
    if (!m.inside[c]) continue
    hexes.push(id(i, j, l + 1), id(i + 1, j, l + 1), id(i + 1, j + 1, l + 1), id(i, j + 1, l + 1), id(i, j, l), id(i + 1, j, l), id(i + 1, j + 1, l), id(i, j + 1, l))
    temp.push(T[l * N + c]!)
    cov.push(m.coverage[l]![c]!)
  }
  return { points, hexes: Int32Array.from(hexes), cellData: { temperature_c: Float64Array.from(temp), copper_coverage: Float64Array.from(cov) } }
}

export function boardArtifacts(run: BoardRun): Artifact[] {
  const m = run.model
  const T = run.solution.T
  const N = m.nx * m.ny
  let lo = Infinity
  let hi = -Infinity
  for (let k = 0; k < T.length; k++) if (m.inside[k % N]) { lo = Math.min(lo, T[k]!); hi = Math.max(hi, T[k]!) }
  const scale = Math.max(1, Math.min(8, Math.floor(800 / Math.max(m.nx, m.ny))))
  const out: Artifact[] = []
  const pngs: Uint8Array[] = []
  m.layers.forEach((L, l) => {
    const img = mapImage(layerField(m, T, l), m.nx, m.ny, lo, hi, scale)
    const png = encodePng(img.width, img.height, img.rgb)
    pngs.push(png)
    out.push({ name: `map-${L.name.replace(/\./g, '_')}.png`, data: png, mime: 'image/png' })
  })
  out.push({ name: 'colourbar.png', data: colourBar(lo, hi), mime: 'image/png' })
  const rows: (number | string)[][] = []
  for (let l = 0; l < m.layers.length; l++) for (let j = 0; j < m.ny; j++) for (let i = 0; i < m.nx; i++) {
    const c = j * m.nx + i
    if (m.inside[c]) rows.push([m.origin_mm[0] + (i + 0.5) * m.dx * 1e3, m.origin_mm[1] + (j + 0.5) * m.dy * 1e3, m.layers[l]!.name, T[l * N + c]!, m.coverage[l]![c]!])
  }
  out.push({ name: 'temperature.csv', data: csv(['x_mm', 'y_mm', 'layer', 'temperature_c', 'copper_coverage'], rows), mime: 'text/csv' })
  out.push({ name: 'board.vtu', data: vtu(gridMesh(m, T)), mime: 'application/xml' })
  out.push({ name: 'board.glb', data: texturedSlab(m.nx * m.dx, m.ny * m.dy, run.plate.thickness_m, pngs[0]!, pngs[pngs.length - 1]!), mime: 'model/gltf-binary' })
  if (run.transient) {
    const tr = run.transient
    const names = ['board_max', 'board_min', ...m.parts.map((p) => p.ref)]
    out.push({ name: 'transient.csv', data: csv(['time_s', ...names], tr.frames.map((f) => [f.t_s, f.max_c, f.min_c, ...m.parts.map((p) => f.parts[p.ref]!)])), mime: 'text/csv' })
    out.push({ name: 'transient.png', data: linePlot([{ name: 'board_max', t: tr.frames.map((f) => f.t_s), y: tr.frames.map((f) => f.max_c) }, ...m.parts.map((p) => ({ name: p.ref, t: tr.frames.map((f) => f.t_s), y: tr.frames.map((f) => f.parts[p.ref]!) }))]), mime: 'image/png' })
  }
  return out
}

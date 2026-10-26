/**
 * thermal.board with solver=calculix: the rasterised board meshed as bricks (calculix.ts), run through ccx once per
 * film-temperature iteration (the converged h is recorded per surface), then read back into the same shape of
 * result as the 2.5D model: per-part board temperatures, the hot spot, the energy balance and, for a transient,
 * the series per part.
 */
import { type Coefficient, type Environment, type FilmIteration, type PerSurface, type PlateGeometry, type Surface, solveFilm, SURFACES } from './convection.js'
import { buildMesh, type CcxMesh, type InpOptions, parseFrd, runCcx, surfaceLoss, surfaceMeans, writeInp } from './calculix.js'
import { plateOf, type PartResult } from './model.js'
import { rasterise, type RasterOptions, type Rasterised } from './raster.js'
import type { GridModel } from './grid.js'
import { metrics, type SeriesMetrics } from './transient.js'

export interface FemInput extends Omit<RasterOptions, 'emissivity'> {
  board: string
  environment: Environment
  sublayers?: number
  bodies?: { height_m: number } | undefined
  transient?: { duration_s: number; dt_s: number; output_every?: number } | undefined
  threads?: number
  remote?: 'auto' | 'always' | 'never'
  timeout_s?: number
}

export interface FemRun {
  raster: Omit<Rasterised, 'model' | 'geometry'>
  model: GridModel
  mesh: CcxMesh
  plate: PlateGeometry
  ambient_c: number
  sink_c: number
  coefficients: Record<Surface, Coefficient>
  film_iterations: FilmIteration[]
  film_converged: boolean
  temps: Map<number, number>
  parts: PartResult[]
  hotspot: { x_mm: number; y_mm: number; z_mm: number; t_c: number }
  balance: { input_w: number; out_w: number; error: number; convective_w: number; radiative_w: number }
  inp: string
  frd: string
  log: string
  where: 'local' | 'batch'
  ccx_seconds: number
  ccx_runs: number
  transient?: { metrics: SeriesMetrics[]; frames: { t_s: number; max_c: number; min_c: number; parts: Record<string, number> }[] }
}

const mean = (ids: readonly number[], T: Map<number, number>): number => ids.reduce((s, n) => s + (T.get(n) ?? NaN), 0) / Math.max(1, ids.length)

export async function runBoardCalculix(i: FemInput): Promise<FemRun> {
  const r = rasterise(i.board, { ...i, emissivity: i.environment.emissivity })
  return runModelCalculix(r.model, i, { assumptions: r.assumptions, unfilled_zones: r.unfilled_zones, unplaced: r.unplaced, copper_fraction: r.copper_fraction, vias: r.vias })
}

/** The same, from a grid model (the validation cases build theirs directly). */
export async function runModelCalculix(m: GridModel, i: Omit<FemInput, 'board' | keyof RasterOptions>, raster: FemRun['raster'] = { assumptions: [], unfilled_zones: [], unplaced: [], copper_fraction: [], vias: 0 }): Promise<FemRun> {
  const mesh = buildMesh(m, { sublayers: i.sublayers ?? 2, bodies: i.bodies })
  const plate = plateOf(m)
  const total = m.parts.reduce((s, p) => s + p.power_w, 0)
  const holder: { last: { frd: string; log: string; where: 'local' | 'batch'; seconds: number; inp: string; opts: InpOptions; T: Map<number, number> } | null } = { last: null }
  let runs = 0
  let seconds = 0
  const env = i.environment
  const film = await solveFilm(env, plate, total, async (h, sink) => {
    const opts: InpOptions = { h, emissivity: env.emissivity, sink_c: sink, radiation: env.radiation }
    const inp = writeInp(mesh, opts)
    const run = await runCcx(inp, { elements: mesh.stats.elements, threads: i.threads ?? 1, remote: i.remote ?? 'auto', timeoutSeconds: i.timeout_s ?? 3600 })
    runs++
    seconds += run.seconds
    const steps = parseFrd(run.frd)
    const T = steps[steps.length - 1]?.temps
    if (!T?.size) throw new Error('ccx wrote no nodal temperatures')
    holder.last = { ...run, inp, opts, T }
    return { result: T, meanC: surfaceMeans(mesh, T) }
  })
  const fin = holder.last!
  const T = fin.T
  let hot = { id: 0, t: -Infinity }
  for (const [n, t] of T) if (t > hot.t) hot = { id: n, t }
  let hx = 0, hy = 0, hz = 0
  for (let k = 0; k < mesh.nodes.length; k += 4) if (mesh.nodes[k] === hot.id) { hx = mesh.nodes[k + 1]!; hy = mesh.nodes[k + 2]!; hz = mesh.nodes[k + 3]! }
  const loss = surfaceLoss(mesh, T, fin.opts)
  const out = loss.convective_w + loss.radiative_w
  const result: FemRun = {
    raster, model: m, mesh, plate, ambient_c: env.ambient_c, sink_c: film.sink_c, coefficients: film.coefficients, film_iterations: film.iterations, film_converged: film.converged,
    temps: T, parts: m.parts.map((p) => ({ ref: p.ref, power_w: p.power_w, board_c: mean(mesh.partNodes.get(p.ref) ?? [], T), layer: m.layers[p.layer]!.name })),
    hotspot: { x_mm: hx * 1e3, y_mm: hy * 1e3, z_mm: hz * 1e3, t_c: hot.t },
    balance: { input_w: total, out_w: out, error: total > 0 ? (out - total) / total : 0, ...loss },
    inp: fin.inp, frd: fin.frd, log: fin.log, where: fin.where, ccx_seconds: seconds, ccx_runs: runs,
  }
  if (i.transient) {
    const h = Object.fromEntries(SURFACES.map((s) => [s, film.coefficients[s].h])) as PerSurface
    const every = i.transient.output_every ?? Math.max(1, Math.floor(i.transient.duration_s / i.transient.dt_s / 100))
    const opts: InpOptions = { h, emissivity: env.emissivity, sink_c: film.sink_c, radiation: env.radiation, transient: { dt_s: i.transient.dt_s, duration_s: i.transient.duration_s, output_every: every } }
    const inp = writeInp(mesh, opts)
    const run = await runCcx(inp, { elements: mesh.stats.elements, threads: i.threads ?? 1, remote: i.remote ?? 'auto', timeoutSeconds: i.timeout_s ?? 3600 })
    result.ccx_runs++
    result.ccx_seconds += run.seconds
    const steps = parseFrd(run.frd)
    const frames = [{ t_s: 0, max_c: film.sink_c, min_c: film.sink_c, parts: Object.fromEntries(m.parts.map((p) => [p.ref, film.sink_c])) }, ...steps.map((s) => {
      let mx = -Infinity, mn = Infinity
      for (const t of s.temps.values()) { mx = Math.max(mx, t); mn = Math.min(mn, t) }
      return { t_s: s.time, max_c: mx, min_c: mn, parts: Object.fromEntries(m.parts.map((p) => [p.ref, mean(mesh.partNodes.get(p.ref) ?? [], s.temps)])) }
    })]
    const series = [
      { name: 'board_max', t: frames.map((f) => f.t_s), y: frames.map((f) => f.max_c), steady: hot.t },
      ...result.parts.map((p) => ({ name: p.ref, t: frames.map((f) => f.t_s), y: frames.map((f) => f.parts[p.ref]!), steady: p.board_c })),
    ]
    result.transient = { metrics: series.map((s) => metrics(s, s.steady)), frames }
  }
  return result
}

/**
 * Convection and radiation boundary conditions: film coefficients from textbook correlations, evaluated at the film
 * temperature, and made self-consistent with the solved surface temperature (the idea of Antmicro's find_coef.sh,
 * https://github.com/antmicro/thermal-simulation-scripts: iterate until the surface temperature the solver gives
 * matches the one h was computed for).
 *
 * Correlations (Incropera, DeWitt, Bergman & Lavine, Fundamentals of Heat and Mass Transfer, 7th ed.):
 *   vertical plate, natural           Churchill & Chu, eq. 9.26: Nu = {0.825 + 0.387 Ra^(1/6) / [1 + (0.492/Pr)^(9/16)]^(8/27)}^2
 *   horizontal, hot face up           eq. 9.30 / 9.31: Nu = 0.54 Ra^(1/4) (1e4..1e7), 0.15 Ra^(1/3) (1e7..1e11); L = A/P
 *   horizontal, hot face down         eq. 9.32: Nu = 0.52 Ra^(1/5) (1e4..1e9); L = A/P
 *   forced, flat plate, average       eq. 7.30: Nu = 0.664 Re^(1/2) Pr^(1/3) (laminar, Re < 5e5);
 *                                     eq. 7.38: Nu = (0.037 Re^(4/5) - 871) Pr^(1/3) (mixed, 5e5 < Re < 1e8)
 *   Ra = g beta dT L^3 / (nu alpha), beta = 1/T_film (ideal gas), properties at T_film = (T_s + T_inf)/2 (materials.air)
 *
 * What this does not model: there is no CFD. Airflow enters only through h; the air temperature is uniform (the
 * ambient, or for a sealed enclosure the internal air from a lumped wall network); shadowing by components, channel
 * flow between boards and vents' chimney effect are not modelled. Radiation exchanges with surroundings at the sink
 * temperature with a view factor of 1 (no board-to-enclosure view factors).
 */
import { z } from 'zod'
import { air, KELVIN, SIGMA } from './materials.js'

export const G = 9.80665

export const SURFACES = ['top', 'bottom', 'edge'] as const
export type Surface = (typeof SURFACES)[number]
export type PerSurface = Record<Surface, number>

export const ENVIRONMENTS = ['natural', 'forced', 'sealed', 'vacuum'] as const
export type EnvironmentKind = (typeof ENVIRONMENTS)[number]

export const EnclosureSchema = z.object({
  length_m: z.number().positive(), width_m: z.number().positive(), height_m: z.number().positive(),
  wall_thickness_m: z.number().positive().default(0.002),
  wall_k: z.number().positive().default(0.2).describe('wall conductivity W/m K (default 0.2, ABS/PC plastic; aluminium 167)'),
  emissivity: z.number().min(0).max(1).default(0.9),
}).strict()
export type Enclosure = z.output<typeof EnclosureSchema>

export interface Environment {
  kind: EnvironmentKind
  ambient_c: number
  altitude_m: number
  orientation: 'horizontal' | 'vertical'
  airflow_m_s: number
  emissivity: PerSurface
  radiation: boolean
  /** fixed coefficients (W/m^2 K) instead of the correlations, per surface */
  h_override: Partial<PerSurface>
  /** a calibrated multiplier on the convective h (thermal_corrections), 1 when none */
  h_multiplier: number
  enclosure: Enclosure | null
}

export interface PlateGeometry {
  /** along the flow, or the horizontal extent (m) */
  length_m: number
  /** across the flow, or the vertical extent when the board is vertical (m) */
  width_m: number
  thickness_m: number
}

export interface Coefficient {
  h: number
  correlation: string
  nu: number
  ra?: number
  re?: number
  /** outside the correlation's stated range (extrapolated) */
  out_of_range: boolean
  char_length_m: number
  film_c: number
}

function rayleigh(dT: number, L: number, filmC: number, alt: number): { ra: number; k: number; pr: number } {
  const p = air(filmC, alt)
  const beta = 1 / (filmC + KELVIN)
  return { ra: (G * beta * Math.abs(dT) * L ** 3) / (p.nu * p.alpha), k: p.k, pr: p.pr }
}

/** Natural convection on a vertical plate of height L (Churchill & Chu, all Ra). */
export function hVertical(dT: number, L: number, filmC: number, alt = 0): Coefficient {
  const { ra, k, pr } = rayleigh(dT, L, filmC, alt)
  const nu = (0.825 + (0.387 * ra ** (1 / 6)) / (1 + (0.492 / pr) ** (9 / 16)) ** (8 / 27)) ** 2
  return { h: (nu * k) / L, nu, ra, correlation: 'Churchill & Chu, vertical plate (Incropera eq. 9.26)', out_of_range: ra > 1e12, char_length_m: L, film_c: filmC }
}

/** Natural convection on a horizontal plate (L = A/P): `up` is the hot face up (or cold face down). */
export function hHorizontal(dT: number, L: number, filmC: number, up: boolean, alt = 0): Coefficient {
  const { ra, k } = rayleigh(dT, L, filmC, alt)
  if (up) {
    const turbulent = ra > 1e7
    const nu = turbulent ? 0.15 * ra ** (1 / 3) : 0.54 * ra ** 0.25
    return { h: (nu * k) / L, nu, ra, correlation: turbulent ? 'hot face up, 0.15 Ra^(1/3) (Incropera eq. 9.31)' : 'hot face up, 0.54 Ra^(1/4) (Incropera eq. 9.30)', out_of_range: ra < 1e4 || ra > 1e11, char_length_m: L, film_c: filmC }
  }
  const nu = 0.52 * ra ** 0.2
  return { h: (nu * k) / L, nu, ra, correlation: 'hot face down, 0.52 Ra^(1/5) (Incropera eq. 9.32)', out_of_range: ra < 1e4 || ra > 1e9, char_length_m: L, film_c: filmC }
}

/** Forced convection, average over a flat plate of length L in the flow direction. */
export function hForced(U: number, L: number, filmC: number, alt = 0): Coefficient {
  const p = air(filmC, alt)
  const re = (U * L) / p.nu
  const laminar = re < 5e5
  const nu = laminar ? 0.664 * re ** 0.5 * p.pr ** (1 / 3) : (0.037 * re ** 0.8 - 871) * p.pr ** (1 / 3)
  return { h: (nu * p.k) / L, nu, re, correlation: laminar ? 'flat plate, laminar, 0.664 Re^(1/2) Pr^(1/3) (Incropera eq. 7.30)' : 'flat plate, mixed, (0.037 Re^(4/5) - 871) Pr^(1/3) (Incropera eq. 7.38)', out_of_range: re > 1e8, char_length_m: L, film_c: filmC }
}

/** Linearised radiation coefficient to surroundings at the sink: eps sigma (Ts^2 + Ta^2)(Ts + Ta), view factor 1. */
export function hRadiation(eps: number, tsC: number, taC: number): number {
  const ts = tsC + KELVIN
  const ta = taC + KELVIN
  return eps * SIGMA * (ts * ts + ta * ta) * (ts + ta)
}

/**
 * The convective coefficient of a surface at a temperature rise dT over the sink (air) temperature `sinkC`, for this
 * environment. Vacuum gives 0 (radiation only). An override wins; the calibration multiplier applies to the
 * correlation (not to an override).
 */
export function coefficient(env: Environment, plate: PlateGeometry, s: Surface, dT: number, sinkC: number): Coefficient {
  const ov = env.h_override[s]
  const film = sinkC + dT / 2
  if (ov !== undefined) return { h: ov, nu: 0, correlation: 'given (h_override)', out_of_range: false, char_length_m: 0, film_c: film }
  if (env.kind === 'vacuum') return { h: 0, nu: 0, correlation: 'vacuum: no convection', out_of_range: false, char_length_m: 0, film_c: film }
  const d = Math.max(Math.abs(dT), 1e-3)
  const scale = (c: Coefficient): Coefficient => ({ ...c, h: c.h * env.h_multiplier, ...(env.h_multiplier !== 1 ? { correlation: `${c.correlation} x ${env.h_multiplier.toPrecision(3)} (calibration)` } : {}) })
  if (env.kind === 'forced') return scale(hForced(env.airflow_m_s, plate.length_m, film, env.altitude_m))
  // natural (and sealed, inside the enclosure)
  const Lh = (plate.length_m * plate.width_m) / (2 * (plate.length_m + plate.width_m))
  if (env.orientation === 'vertical') return scale(hVertical(d, plate.width_m, film, env.altitude_m))
  if (s === 'bottom') return scale(hHorizontal(d, Lh, film, dT < 0, env.altitude_m))
  return scale(hHorizontal(d, Lh, film, dT >= 0, env.altitude_m)) // top, and the edge takes the top's coefficient
}

/**
 * A sealed enclosure's internal air temperature for a total dissipation Q: Q = (T_int - T_a) / R, with
 * R = 1/(h_in A) + t/(k A) + 1/((h_out + h_rad) A), A the box's outside area, h_in and h_out from Churchill & Chu on
 * the box height at half the rise each. Iterated to self-consistency. A lumped model: the wall is isothermal and the
 * internal air well mixed.
 */
export function sealedInternal(env: Environment, Q: number): { internal_c: number; wall_c: number; r_c_per_w: number; h_in: number; h_out: number; h_rad: number; iterations: number } {
  const e = env.enclosure
  if (!e) throw new Error('a sealed environment needs an enclosure')
  const A = 2 * (e.length_m * e.width_m + e.length_m * e.height_m + e.width_m * e.height_m)
  let rise = 10
  let out = { internal_c: env.ambient_c, wall_c: env.ambient_c, r_c_per_w: 0, h_in: 0, h_out: 0, h_rad: 0, iterations: 0 }
  for (let i = 1; i <= 100; i++) {
    const wallRise = rise / 2
    const hIn = hVertical(rise - wallRise, e.height_m, env.ambient_c + wallRise + (rise - wallRise) / 2, env.altitude_m).h
    const hOut = hVertical(wallRise, e.height_m, env.ambient_c + wallRise / 2, env.altitude_m).h
    const hRad = env.radiation ? hRadiation(e.emissivity, env.ambient_c + wallRise, env.ambient_c) : 0
    const rIn = 1 / (hIn * A)
    const rOut = 1 / ((hOut + hRad) * A)
    const R = rIn + e.wall_thickness_m / (e.wall_k * A) + rOut
    const next = Q * R
    out = { internal_c: env.ambient_c + next, wall_c: env.ambient_c + Q * rOut, r_c_per_w: R, h_in: hIn, h_out: hOut, h_rad: hRad, iterations: i }
    if (Math.abs(next - rise) < 1e-4 * Math.max(1, rise)) break
    rise = 0.5 * (rise + Math.max(next, 1e-3))
  }
  return out
}

// ------------------------------------------------------------------ the film-temperature iteration

export interface FilmIteration { iteration: number; assumed_rise_c: PerSurface; simulated_rise_c: PerSurface; h: PerSurface }

export interface FilmSolution<R> {
  result: R
  coefficients: Record<Surface, Coefficient>
  iterations: FilmIteration[]
  converged: boolean
  sink_c: number
  sealed?: ReturnType<typeof sealedInternal>
}

/**
 * Solve with h made consistent with the solved surface temperatures. `solve(h, sinkC)` runs the model with the given
 * convective coefficients and returns it with each surface's area-weighted mean temperature. The assumed rise is
 * updated by under-relaxed fixed-point iteration until it agrees with the solved rise to `tolC` on every surface
 * (Antmicro's find_coef.sh bisects on h for one surface; this updates every surface at once). Overrides are fixed
 * and do not iterate; vacuum has nothing to iterate on.
 */
export async function solveFilm<R>(env: Environment, plate: PlateGeometry, totalPowerW: number,
  solve: (h: PerSurface, sinkC: number) => Promise<{ result: R; meanC: PerSurface }>,
  o: { tolC?: number; maxIterations?: number; initialRiseC?: number } = {}): Promise<FilmSolution<R>> {
  const tol = o.tolC ?? 0.05
  const maxIt = o.maxIterations ?? 30
  const sealed = env.kind === 'sealed' ? sealedInternal(env, totalPowerW) : undefined
  const sink = sealed ? sealed.internal_c : env.ambient_c
  let assumed: PerSurface = { top: o.initialRiseC ?? 20, bottom: o.initialRiseC ?? 20, edge: o.initialRiseC ?? 20 }
  const iterations: FilmIteration[] = []
  const fixed = env.kind === 'vacuum' || SURFACES.every((s) => env.h_override[s] !== undefined)
  let last: { result: R; meanC: PerSurface } | null = null
  let coeffs = {} as Record<Surface, Coefficient>
  let converged = false
  for (let it = 1; it <= (fixed ? 1 : maxIt); it++) {
    coeffs = Object.fromEntries(SURFACES.map((s) => [s, coefficient(env, plate, s, assumed[s], sink)])) as Record<Surface, Coefficient>
    const h = Object.fromEntries(SURFACES.map((s) => [s, coeffs[s].h])) as PerSurface
    last = await solve(h, sink)
    const simulated = Object.fromEntries(SURFACES.map((s) => [s, last!.meanC[s] - sink])) as PerSurface
    iterations.push({ iteration: it, assumed_rise_c: { ...assumed }, simulated_rise_c: simulated, h })
    const worst = Math.max(...SURFACES.filter((s) => env.h_override[s] === undefined).map((s) => Math.abs(simulated[s] - assumed[s])), 0)
    if (fixed || worst < Math.max(tol, 1e-3 * Math.max(...SURFACES.map((s) => Math.abs(simulated[s]))))) { converged = true; break }
    assumed = Object.fromEntries(SURFACES.map((s) => [s, 0.4 * assumed[s] + 0.6 * simulated[s]])) as PerSurface
  }
  return { result: last!.result, coefficients: coeffs, iterations, converged, sink_c: sink, ...(sealed ? { sealed } : {}) }
}

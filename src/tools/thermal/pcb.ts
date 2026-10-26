/**
 * Board-level thermal calculators: pure functions with their formulas cited, unit-tested against hand calculations
 * (test/tools/thermal).
 *
 *   spreading     a circular isoflux source of radius a centred on a circular plate (radius b, thickness t,
 *                 conductivity k), adiabatic edge, cooled on its far face by h. Separation of variables gives the
 *                 spreading resistance (source mean temperature, above the 1D value) as the series
 *                   R_s = sum_n 4 J1(l_n a)^2 / (pi a^2 b^2 k l_n^3 J0(l_n b)^2 phi_n),   J1(l_n b) = 0,
 *                   phi_n = (tanh(l_n t) + h/(k l_n)) / (1 + h/(k l_n) tanh(l_n t))
 *                 (Kennedy, "Spreading resistance in cylindrical semiconductor devices", J. Appl. Phys. 1960;
 *                 the same series in Song, Lee & Au, "Closed-form equation for thermal constriction/spreading
 *                 resistances with variable resistance boundary condition", IEPS 1994). Total
 *                 R = R_s + t/(k pi b^2) + 1/(h pi b^2). Rectangles are taken as circles of equal area.
 *   via array     n plated barrels in parallel, each L / (k_Cu pi/4 ((d + 2 t)^2 - d^2)) (as calc.via), plus an
 *                 optional fill (k_fill over pi d^2/4) and the laminate between them over the array's area
 *   copper area   a copper pour as an annular fin around a source of radius a, both faces cooled by h:
 *                 G = 2 pi a k t m [K1(ma) I1(mR) - I1(ma) K1(mR)] / [K0(ma) I1(mR) + I0(ma) K1(mR)]
 *                 + 2 h pi a^2, m = sqrt(2 h / (k t)) (Incropera 7th ed. table 3.5 / eq. 3.95, annular fin with an
 *                 adiabatic tip); the radius for a target theta by bisection
 *   trace rise    IPC-2221B 6.2 (src/tools/calc/pcb.ts: I = k dT^0.44 A^0.725) solved for dT. IPC-2152's charts have
 *                 no closed form in the standard and are not implemented: IPC-2221B is the older, generally more
 *                 conservative chart for external traces; a board-level model (thermal.board) is the better answer
 *                 for a trace on a real board
 */
import { ToolError } from '../../core/registry.js'
import { ipc2221Current } from '../calc/pcb.js'
import { besselI, besselJ, besselK, j1Zeros } from './bessel.js'
import { COPPER, FR4 } from './materials.js'

const MIL = 25.4e-6
const OZ_M = 35e-6

export interface SpreadingArgs { source_radius_m: number; plate_radius_m: number; thickness_m: number; k: number; h: number; terms?: number }

export function spreading(a: SpreadingArgs): { spreading_c_per_w: number; one_d_c_per_w: number; convection_c_per_w: number; total_c_per_w: number; terms: number; epsilon: number; tau: number; biot: number } {
  const { source_radius_m: ra, plate_radius_m: b, thickness_m: t, k, h } = a
  if (!(ra > 0 && b > 0 && t > 0 && k > 0 && h > 0)) throw new ToolError('spreading: radii, thickness, k and h must be positive')
  if (ra > b) throw new ToolError('spreading: the source is larger than the plate')
  const n = a.terms ?? 300
  const zeros = j1Zeros(n)
  let rs = 0
  for (const z of zeros) {
    const l = z / b
    const ht = h / (k * l)
    const th = Math.tanh(l * t)
    const phi = (th + ht) / (1 + ht * th)
    rs += (4 * besselJ(1, l * ra) ** 2) / (Math.PI * ra * ra * b * b * k * l ** 3 * besselJ(0, z) ** 2 * phi)
  }
  const oneD = t / (k * Math.PI * b * b)
  const conv = 1 / (h * Math.PI * b * b)
  return { spreading_c_per_w: rs, one_d_c_per_w: oneD, convection_c_per_w: conv, total_c_per_w: rs + oneD + conv, terms: n, epsilon: ra / b, tau: t / b, biot: (h * b) / k }
}

/** The radius of a circle with the area of a w x h rectangle. */
export const equivalentRadius = (w: number, h: number): number => Math.sqrt((w * h) / Math.PI)

export interface ViaArrayArgs {
  count: number
  drill_m: number
  plating_m?: number | undefined
  length_m: number
  /** fill conductivity (W/m K): copper-filled 385, conductive epoxy ~3 to 8, plain epoxy ~0.3; omit for an open barrel */
  fill_k?: number | undefined
  /** the array's footprint (m^2), for the laminate in parallel; omit to ignore the laminate */
  array_area_m2?: number | undefined
  k_laminate?: number | undefined
  k_copper?: number | undefined
}

export function viaArray(a: ViaArrayArgs): { per_via_c_per_w: number; barrel_area_m2: number; vias_c_per_w: number; laminate_c_per_w: number | null; total_c_per_w: number } {
  if (!(a.count >= 1)) throw new ToolError('via array: count must be at least 1')
  const t = a.plating_m ?? 20e-6
  const kcu = a.k_copper ?? COPPER.k.value
  const barrel = (Math.PI / 4) * ((a.drill_m + 2 * t) ** 2 - a.drill_m ** 2)
  const gBarrel = (kcu * barrel) / a.length_m
  const gFill = a.fill_k ? (a.fill_k * Math.PI * a.drill_m ** 2) / 4 / a.length_m : 0
  const perVia = 1 / (gBarrel + gFill)
  const gVias = a.count * (gBarrel + gFill)
  let gLam = 0
  let lam: number | null = null
  if (a.array_area_m2 !== undefined) {
    const holes = a.count * (Math.PI / 4) * (a.drill_m + 2 * t) ** 2
    if (holes >= a.array_area_m2) throw new ToolError('via array: the vias cover more than the array area')
    gLam = ((a.k_laminate ?? FR4.k_through.value) * (a.array_area_m2 - holes)) / a.length_m
    lam = 1 / gLam
  }
  return { per_via_c_per_w: perVia, barrel_area_m2: barrel, vias_c_per_w: 1 / gVias, laminate_c_per_w: lam, total_c_per_w: 1 / (gVias + gLam) }
}

/** Thermal conductance (W/K) of a circular copper pour of radius R around a source of radius a (annular fin, adiabatic tip). */
export function pourConductance(a: number, R: number, t: number, k: number, h: number): number {
  const m = Math.sqrt((2 * h) / (k * t))
  const own = 2 * h * Math.PI * a * a
  if (R <= a) return own
  const x = m * a
  const X = m * R
  // ratio in scaled form to stay finite for large mR: divide numerator and denominator by I1(X)
  const i1X = besselI(1, X)
  const num = besselK(1, x) - (besselI(1, x) * besselK(1, X)) / i1X
  const den = besselK(0, x) + (besselI(0, x) * besselK(1, X)) / i1X
  return 2 * Math.PI * a * k * t * m * (num / den) + own
}

export interface CopperAreaArgs { target_c_per_w: number; source_radius_m: number; copper_oz?: number | undefined; thickness_m?: number | undefined; h: number; k?: number | undefined }

export function copperArea(a: CopperAreaArgs): { radius_m: number | null; area_m2: number | null; side_m: number | null; theta_infinite_c_per_w: number; achievable: boolean; fin_parameter_m: number } {
  const t = a.thickness_m ?? (a.copper_oz ?? 1) * OZ_M
  const k = a.k ?? COPPER.k.value
  const r0 = a.source_radius_m
  const m = Math.sqrt((2 * a.h) / (k * t))
  // an infinite pour: G = 2 pi a k t m K1(ma)/K0(ma) + own
  const gInf = 2 * Math.PI * r0 * k * t * m * (besselK(1, m * r0) / besselK(0, m * r0)) + 2 * a.h * Math.PI * r0 * r0
  const target = 1 / a.target_c_per_w
  if (gInf <= target) return { radius_m: null, area_m2: null, side_m: null, theta_infinite_c_per_w: 1 / gInf, achievable: false, fin_parameter_m: 1 / m }
  let lo = r0
  let hi = r0 + 1 / m
  while (pourConductance(r0, hi, t, k, a.h) < target) hi = r0 + 2 * (hi - r0)
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi)
    if (pourConductance(r0, mid, t, k, a.h) < target) lo = mid
    else hi = mid
  }
  const R = 0.5 * (lo + hi)
  return { radius_m: R, area_m2: Math.PI * R * R, side_m: Math.sqrt(Math.PI) * R, theta_infinite_c_per_w: 1 / gInf, achievable: true, fin_parameter_m: 1 / m }
}

export interface TraceRiseArgs { current_a: number; width_m: number; copper_oz?: number | undefined; layer: 'external' | 'internal' }

/** IPC-2221B 6.2 solved for the rise: dT = (I / (k A^0.725))^(1/0.44), A in mil^2. */
export function traceRise(a: TraceRiseArgs): { temp_rise_c: number; area_mil2: number; in_chart_range: boolean; standard: string } {
  const t = (a.copper_oz ?? 1) * OZ_M
  const area = (a.width_m / MIL) * (t / MIL)
  const kk = a.layer === 'internal' ? 0.024 : 0.048
  const rise = (a.current_a / (kk * area ** 0.725)) ** (1 / 0.44)
  // the inverse must reproduce calc's forward fit
  if (Math.abs(ipc2221Current(area, rise, a.layer === 'internal') - a.current_a) > 1e-9 * Math.max(1, a.current_a)) throw new Error('traceRise: inverse mismatch')
  return {
    temp_rise_c: rise, area_mil2: area,
    in_chart_range: a.current_a <= 35 && a.width_m / MIL <= 400 && rise >= 10 && rise <= 100 && (a.copper_oz ?? 1) >= 0.5 && (a.copper_oz ?? 1) <= 3,
    standard: 'IPC-2221B 6.2 (calc.trace_width\'s fit, inverted); IPC-2152 charts are not implemented',
  }
}

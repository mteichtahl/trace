/**
 * The material figures the thermal tools assume, each with where it comes from. A figure recalled from a reference
 * rather than read from a document in the datasheet library carries `verified: null`: check it against the cited
 * table before relying on it, or override it (every tool takes the figures as inputs).
 *
 *   copper conductivity        385 W/m K, the electrodeposited-copper figure src/tools/calc already uses (K_CU)
 *   FR-4                       in-plane / through-plane conductivity, density, specific heat (laminate datasheets
 *                              vary: Isola 370HR gives 0.4 W/m K through-plane; generic FR-4 0.25 to 0.35)
 *   air                        Incropera et al., Fundamentals of Heat and Mass Transfer, 7th ed., table A.4 (1 atm),
 *                              linearly interpolated in temperature; pressure from the ISA barometric formula
 *   emissivity                 a small table per finish (below)
 */
import { K_CU } from '../calc/common.js'

export interface Cited { value: number; source: string; verified: boolean | null }

const cite = (value: number, source: string, verified: boolean | null = null): Cited => ({ value, source, verified })

export const COPPER = {
  k: cite(K_CU, 'src/tools/calc/common.ts K_CU (electrodeposited copper, as calc.via and calc.trace_width use)', true),
  rho: cite(8933, 'Incropera 7th ed. table A.1, pure copper at 300 K'),
  cp: cite(385, 'Incropera 7th ed. table A.1, pure copper at 300 K'),
}

export const FR4 = {
  k_inplane: cite(0.8, 'typical glass-epoxy laminate in-plane conductivity (woven glass raises it above through-plane); laminate datasheets vary'),
  k_through: cite(0.3, 'typical FR-4 through-plane conductivity (0.25 to 0.4 W/m K across laminate datasheets)'),
  rho: cite(1850, 'typical FR-4 density'),
  cp: cite(1100, 'typical FR-4 specific heat'),
}

/** Mould compound for component bodies (calculix bodies). */
export const MOLD = {
  k: cite(0.7, 'typical epoxy mould compound conductivity (0.6 to 1 W/m K)'),
  rho: cite(1900, 'typical epoxy mould compound density'),
  cp: cite(900, 'typical epoxy mould compound specific heat'),
}

export const ALUMINIUM = {
  k: cite(167, 'aluminium alloy 6061-T6 (MatWeb / ASM handbook)'),
  rho: cite(2700, 'aluminium alloy 6061'),
  cp: cite(896, 'aluminium alloy 6061'),
}

// ------------------------------------------------------------------ emissivity

export const FINISHES = ['solder_mask', 'fr4', 'anodised_aluminium', 'black_anodised_aluminium', 'bare_aluminium', 'polished_copper', 'oxidised_copper', 'black_paint'] as const
export type Finish = (typeof FINISHES)[number]

export interface Emissivity extends Cited { range: [number, number] }

/** Total hemispherical emissivity near room temperature, per finish. */
export const EMISSIVITY: Readonly<Record<Finish, Emissivity>> = {
  solder_mask: { value: 0.9, range: [0.8, 0.95], source: 'liquid photoimageable solder mask, typical published range (IR thermography practice uses 0.9 to 0.95)', verified: null },
  fr4: { value: 0.9, range: [0.85, 0.95], source: 'bare glass-epoxy laminate, typical published range', verified: null },
  anodised_aluminium: { value: 0.82, range: [0.77, 0.9], source: 'Incropera 7th ed. table A.11, anodised aluminium', verified: null },
  black_anodised_aluminium: { value: 0.77, range: [0.77, 0.88], source: 'Antmicro, "Open source thermal simulation, analysis and visualization" (2025-03): 0.77 used for black-anodised aluminium in their vacuum case', verified: null },
  bare_aluminium: { value: 0.09, range: [0.04, 0.1], source: 'Incropera 7th ed. table A.11, aluminium commercial sheet 0.09; highly polished 0.04', verified: null },
  polished_copper: { value: 0.03, range: [0.02, 0.05], source: 'Incropera 7th ed. table A.11, highly polished copper', verified: null },
  oxidised_copper: { value: 0.6, range: [0.5, 0.8], source: 'Incropera 7th ed. table A.11, oxidised copper', verified: null },
  black_paint: { value: 0.95, range: [0.9, 0.98], source: 'flat black paint, typical published range', verified: null },
}

export const SIGMA = 5.670374419e-8 // Stefan-Boltzmann constant, CODATA 2018 (exact in SI 2019)
export const KELVIN = 273.15

// ------------------------------------------------------------------ air

/** Incropera 7th ed. table A.4, air at 1 atm: T (K), k (W/m K), nu (m^2/s), alpha (m^2/s), Pr. */
const AIR: readonly (readonly [number, number, number, number, number])[] = [
  [250, 22.3e-3, 11.44e-6, 15.9e-6, 0.720],
  [300, 26.3e-3, 15.89e-6, 22.5e-6, 0.707],
  [350, 30.0e-3, 20.92e-6, 29.9e-6, 0.700],
  [400, 33.8e-3, 26.41e-6, 38.3e-6, 0.690],
  [450, 37.3e-3, 32.39e-6, 47.2e-6, 0.686],
  [500, 40.7e-3, 38.79e-6, 56.7e-6, 0.684],
]
export const AIR_SOURCE = 'Incropera 7th ed. table A.4 (air, 1 atm), linear interpolation; nu and alpha scaled by 1/pressure (ISA barometric formula)'

export interface AirProps { k: number; nu: number; alpha: number; pr: number; pressure_pa: number }

/** ISA troposphere pressure at an altitude (m): p0 (1 - 2.25577e-5 h)^5.25588 (ICAO Doc 7488). */
export const pressureAt = (altitudeM: number): number => 101325 * (1 - 2.25577e-5 * altitudeM) ** 5.25588

/** Air properties at a film temperature (deg C) and altitude (m). Outside 250..500 K the table's ends are extrapolated linearly. */
export function air(tFilmC: number, altitudeM = 0): AirProps {
  const T = tFilmC + KELVIN
  let i = 0
  while (i < AIR.length - 2 && T > AIR[i + 1]![0]) i++
  const a = AIR[i]!
  const b = AIR[i + 1]!
  const f = (T - a[0]) / (b[0] - a[0])
  const lerp = (j: 1 | 2 | 3 | 4): number => a[j] + f * (b[j] - a[j])
  const p = pressureAt(altitudeM)
  const s = 101325 / p
  return { k: lerp(1), nu: lerp(2) * s, alpha: lerp(3) * s, pr: lerp(4), pressure_pa: p }
}

/**
 * Shared plumbing for the calculators: reading inputs (numbers or component strings such as "4k7" or "100nF"),
 * checking them, picking preferred values from an E-series and working out tolerance corners.
 *
 * Every calculator validates its inputs through these helpers so the messages an agent reads are the same
 * everywhere: which argument, what was wrong, what was expected. Every calculator returns a `Result`: plain JSON
 * with the unit in each key name (`vout_v`, `width_m`) and a one-line `summary` for people.
 */
import { z } from 'zod'
import { ToolError } from '../../core/registry.js'
import { eng, parseValue, preferred, ValueError, type ESeries } from '../../core/units.js'

export { ToolError, eng }
export type { ESeries }

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
export type Out = { [k: string]: Json }
export type Result = Out & { summary: string }

/** A component value: a number in SI units, or a string such as "4k7", "100nF", "3.3V". */
export type Val = number | string

export const zVal = (description: string) => z.union([z.number(), z.string()]).describe(description)
export const zSeries = (description = 'E-series to pick from') =>
  z.enum(['E6', 'E12', 'E24', 'E48', 'E96']).describe(description)
export const zTol = (description: string) =>
  z.union([z.number(), z.string()]).describe(`${description}: a fraction (0.01), a percentage string ("1%") or a number above 0.5 read as percent`)

export interface ValOpts {
  /** default true: the value must be > 0 (or >= 0 with allowZero) */
  readonly positive?: boolean
  readonly allowZero?: boolean
  readonly min?: number
  readonly max?: number
}

/** Read one input: a number or a component string. Throws ToolError naming the argument. */
export function val(name: string, x: Val | undefined | null, opts: ValOpts = {}): number {
  if (x === undefined || x === null) throw new ToolError(`${name}: a value is required`)
  let v: number
  try {
    v = parseValue(x)
  } catch (e) {
    if (e instanceof ValueError) throw new ToolError(`${name}: not a number or component value: ${JSON.stringify(x)}`)
    throw e
  }
  if (!Number.isFinite(v)) throw new ToolError(`${name}: must be finite, got ${JSON.stringify(x)}`)
  if (opts.positive ?? true) {
    if (v < 0 || (v === 0 && !opts.allowZero)) {
      throw new ToolError(`${name}: must be ${opts.allowZero ? 'non-negative' : 'positive'}, got ${JSON.stringify(x)}`)
    }
  }
  if (opts.min !== undefined && v < opts.min) throw new ToolError(`${name}: must be at least ${opts.min}, got ${JSON.stringify(x)}`)
  if (opts.max !== undefined && v > opts.max) throw new ToolError(`${name}: must be at most ${opts.max}, got ${JSON.stringify(x)}`)
  return v
}

/** An optional input: undefined stays undefined, anything else is checked as `val`. */
export function opt(name: string, x: Val | undefined | null, opts: ValOpts = {}): number | undefined {
  return x === undefined || x === null ? undefined : val(name, x, opts)
}

/** A tolerance as a fraction: 0.01, "1%", or 1 (a number above 0.5 is read as percent). */
export function tolFrac(name: string, x: Val | undefined, dflt: number): number {
  if (x === undefined) return dflt
  let v: number
  if (typeof x === 'string' && x.trim().endsWith('%')) v = val(name, x.trim().slice(0, -1), { allowZero: true }) / 100
  else {
    v = val(name, x, { allowZero: true })
    if (v > 0.5) v /= 100
  }
  if (v >= 0.5) throw new ToolError(`${name}: a tolerance under 50 % is expected, got ${JSON.stringify(x)}`)
  return v
}

/** Exactly one of the named inputs is present; returns its name. */
export function exactlyOne(what: string, given: Record<string, unknown>): string {
  const present = Object.entries(given).filter(([, v]) => v !== undefined).map(([k]) => k)
  if (present.length !== 1) throw new ToolError(`${what}: give exactly one of ${Object.keys(given).join(', ')}`)
  return present[0] as string
}

const round12 = (x: number) => Number(x.toPrecision(12))

/** Every preferred value of `series` in the decades around x (two either side), ascending. */
function ladder(x: number, series: ESeries): number[] {
  const d = 10 ** Math.floor(Math.log10(x))
  const out = new Set<number>()
  for (const k of [d / 100, d / 10, d, d * 10, d * 100]) for (const v of preferred(series)) out.add(round12(v * k))
  return [...out].sort((a, b) => a - b)
}

/** The n preferred values at or below x and the n at or above it. */
export function neighbours(x: number, series: ESeries, n = 2): number[] {
  if (!(x > 0) || !Number.isFinite(x)) return []
  const vals = ladder(x, series)
  const below = vals.filter((v) => v <= x * (1 + 1e-12)).slice(-n)
  const above = vals.filter((v) => v >= x * (1 - 1e-12)).slice(0, n)
  return [...new Set([...below, ...above])].sort((a, b) => a - b)
}

/** Every preferred value of `series` from lo to hi inclusive. */
export function valuesBetween(series: ESeries, lo: number, hi: number): number[] {
  const out: number[] = []
  for (let d = 10 ** Math.floor(Math.log10(lo)); d <= hi * 10; d *= 10) {
    for (const v of preferred(series)) {
      const c = round12(v * d)
      if (c >= lo * (1 - 1e-9) && c <= hi * (1 + 1e-9)) out.push(c)
    }
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

/**
 * Min and max of f over every +/- tolerance corner of its inputs. Exact for a function monotonic in each input,
 * which every calculator here is over a tolerance band.
 */
export function corners(f: (...v: number[]) => number, values: readonly number[], tols: readonly number[]): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  const n = values.length
  for (let mask = 0; mask < 1 << n; mask++) {
    const args = values.map((v, i) => v * (1 + ((mask >> i) & 1 ? 1 : -1) * (tols[i] ?? 0)))
    const r = f(...args)
    lo = Math.min(lo, r)
    hi = Math.max(hi, r)
  }
  return [lo, hi]
}

/** Worst-case spread of f as `min_<unit>`, `max_<unit>` and the percentage either side of nominal. */
export function spread(f: (...v: number[]) => number, values: readonly number[], tols: readonly number[], key: string): Out {
  const [lo, hi] = corners(f, values, tols)
  const nom = f(...values)
  return {
    [`min_${key}`]: lo,
    [`max_${key}`]: hi,
    spread_pct: [nom ? (100 * (lo - nom)) / nom : 0, nom ? (100 * (hi - nom)) / nom : 0],
  }
}

/** Percentage error of got against target. */
export const errPct = (got: number, target: number): number => (100 * (got - target)) / target

/** Best `n` candidates by |error_pct| (the key the caller ranks on). */
export function best<T extends { error_pct: number }>(cands: T[], n = 3, key: (c: T) => number = (c) => Math.abs(c.error_pct)): T[] {
  return [...cands].sort((a, b) => key(a) - key(b)).slice(0, n)
}

/** The first candidate of a list known to be non-empty. */
export function first<T>(xs: readonly T[], what: string): T {
  const x = xs[0]
  if (x === undefined) throw new ToolError(`${what}: no preferred value fits`)
  return x
}

// Copper (annealed): resistivity 1.724e-8 ohm m at 20 C, temperature coefficient 0.00393 /C (IEC 60028:1925, the
// International Annealed Copper Standard; ASTM B193). Thermal conductivity ~385 W/(m K) near room temperature.
export const RHO_CU_20 = 1.724e-8
export const ALPHA_CU = 0.00393
export const K_CU = 385
/** Copper resistivity at tC (linear temperature coefficient about 20 C, IEC 60028). */
export const rhoCu = (tC: number): number => RHO_CU_20 * (1 + ALPHA_CU * (tC - 20))

export const fmtPct = (x: number, digits = 2): string => `${x >= 0 ? '+' : ''}${x.toFixed(digits)} %`

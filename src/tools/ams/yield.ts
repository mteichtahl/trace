/**
 * Monte Carlo yield and sensitivity, on top of sim.montecarlo's engine (src/sim/sweep.ts: montecarlo).
 *
 *   yield         the fraction of runs meeting every spec, and each spec's own pass fraction. A run whose
 *                 simulation failed, or whose measurement is missing, counts as a failure. The confidence interval
 *                 is Wilson's score interval (E. B. Wilson, J. Am. Stat. Assoc. 22, 1927), which stays inside [0, 1]
 *                 and is sensible at 0 or N passes; for zero failures in N runs the one-sided 95 % bound is also
 *                 given (1 - 0.05^(1/N), the exact binomial bound; ~3/N, the "rule of three").
 *   sensitivity   which tolerance drives each measure:
 *                   correlation  Pearson r between each part's drawn factor and the measure over the Monte Carlo
 *                                runs (no extra simulations). The draws are independent, so r^2 is the share of
 *                                the measure's variance a linear fit to that part alone explains; the shares add up
 *                                to about the linear model's R^2, and a low total means the response is non-linear
 *                                or interacting. With few runs, |r| below about 2/sqrt(N) is not distinguishable
 *                                from zero.
 *                   oat          one at a time: each part at its +tol and -tol limit with the others nominal (2 runs
 *                                per part); the swing (value at +tol minus value at -tol) and that swing as a share
 *                                of the spec window. Linear-response assumption; it does not see interactions.
 */
import type { MeasureSpec } from '../../sim/measure.js'
import { defaultConcurrency, mapLimit } from '../../sim/proc.js'
import { simulate, SpiceError, type SimulateOptions } from '../../sim/spice.js'
import { measureRun, montecarlo, paramValue, scaleComponent, type MonteCarloResult, type Tolerance } from '../../sim/sweep.js'
import { parseValue } from '../../core/units.js'
import { judge, type SpecLimit } from './spec.js'

/** The standard normal quantile (Acklam's rational approximation, relative error < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('p must be in (0, 1)')
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pl = 0.02425
  const at = (arr: number[], i: number): number => arr[i] as number
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q + at(c, 5)) / ((((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1)
  }
  if (p > 1 - pl) return -normalQuantile(1 - p)
  const q = p - 0.5
  const rr = q * q
  return ((((((at(a, 0) * rr + at(a, 1)) * rr + at(a, 2)) * rr + at(a, 3)) * rr + at(a, 4)) * rr + at(a, 5)) * q) / (((((at(b, 0) * rr + at(b, 1)) * rr + at(b, 2)) * rr + at(b, 3)) * rr + at(b, 4)) * rr + 1)
}

/** Wilson score interval for k successes in n trials at the given two-sided confidence. */
export function wilson(k: number, n: number, confidence = 0.95): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 }
  const z = normalQuantile(1 - (1 - confidence) / 2)
  const p = k / n
  const den = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / den
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) }
}

export function pearson(x: readonly number[], y: readonly number[]): number | null {
  const n = Math.min(x.length, y.length)
  if (n < 3) return null
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) {
    mx += x[i] as number
    my += y[i] as number
  }
  mx /= n
  my /= n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = (x[i] as number) - mx
    const dy = (y[i] as number) - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx === 0 || syy === 0) return null
  return sxy / Math.sqrt(sxx * syy)
}

export interface YieldReport {
  runs: number
  passed: number
  yield: number
  ci: { lo: number; hi: number; confidence: number }
  zero_fail_bound?: number
  per_spec: { measure: string; passed: number; yield: number; ci: { lo: number; hi: number }; min: number | null; max: number | null }[]
}

export function yieldOf(mc: MonteCarloResult, limits: ReadonlyMap<string, SpecLimit>, confidence: number): YieldReport {
  const n = mc.runs.length
  let passed = 0
  const per = new Map<string, number>([...limits.keys()].map((k) => [k, 0]))
  for (const run of mc.runs) {
    let all = true
    for (const [name, lim] of limits) {
      const v = run.error ? null : (run.measurements.find((m) => m.name === name)?.value ?? null)
      const ok = judge(v, lim).pass
      if (ok) per.set(name, (per.get(name) ?? 0) + 1)
      else all = false
    }
    if (all) passed++
  }
  const ci = wilson(passed, n, confidence)
  return {
    runs: n, passed, yield: n ? passed / n : 0, ci: { ...ci, confidence },
    ...(passed === n && n > 0 ? { zero_fail_bound: 1 - (1 - confidence) ** (1 / n) } : {}),
    per_spec: [...limits.keys()].map((name) => {
      const k = per.get(name) ?? 0
      const st = mc.stats.find((s) => s.name === name)
      return { measure: name, passed: k, yield: n ? k / n : 0, ci: wilson(k, n, confidence), min: st?.min ?? null, max: st?.max ?? null }
    }),
  }
}

export interface Sensitivity { part: string; r: number | null; r2: number | null }

export function correlationSensitivity(mc: MonteCarloResult, measure: string, parts: readonly string[]): { ranking: Sensitivity[]; r2_total: number } {
  const ranking = parts.map((part) => {
    const xs: number[] = []
    const ys: number[] = []
    mc.runs.forEach((run, k) => {
      const v = run.measurements.find((m) => m.name === measure)?.value
      const f = mc.factors[k]?.[part]
      if (v === null || v === undefined || !Number.isFinite(v) || f === undefined) return
      xs.push(f)
      ys.push(v)
    })
    const r = pearson(xs, ys)
    return { part, r, r2: r === null ? null : r * r }
  }).sort((a, b) => (b.r2 ?? -1) - (a.r2 ?? -1))
  return { ranking, r2_total: ranking.reduce((s, x) => s + (x.r2 ?? 0), 0) }
}

export interface OatRow { part: string; tol: number; low: number | null; high: number | null; swing: number | null; share_of_window: number | null; error?: string }

/** One-at-a-time: each part at 1 - tol and 1 + tol, the others nominal. */
export async function oatSensitivity(base: SimulateOptions, tolerances: readonly Tolerance[], specs: readonly MeasureSpec[], limits: ReadonlyMap<string, SpecLimit>, concurrency?: number): Promise<Record<string, OatRow[]>> {
  const jobs: { key: string; tol: number; sign: 1 | -1; opts: SimulateOptions }[] = []
  for (const t of tolerances) {
    const key = (t.ref ?? t.param) as string
    for (const sign of [-1, 1] as const) {
      const factor = 1 + sign * t.tol
      if (t.ref) jobs.push({ key, tol: t.tol, sign, opts: { ...base, netlist: scaleComponent(base.netlist, t.ref, factor) } })
      else {
        const p = t.param as string
        const nominal = base.params?.[p] !== undefined ? parseValue(base.params[p] as number | string, { spice: true }) : paramValue(base.netlist, p)
        jobs.push({ key, tol: t.tol, sign, opts: { ...base, params: { ...(base.params ?? {}), [p]: Number((nominal * factor).toPrecision(12)) } } })
      }
    }
  }
  const res = await mapLimit(jobs, concurrency ?? defaultConcurrency(), async (j) => {
    try {
      return { j, ms: measureRun(await simulate(j.opts), specs), error: undefined as string | undefined }
    } catch (e) {
      if (!(e instanceof SpiceError)) throw e
      return { j, ms: [], error: e.message }
    }
  })
  const names = specs.map((s) => s.name ?? `${s.kind}:${s.vector}`)
  const out: Record<string, OatRow[]> = {}
  for (const name of names) {
    const lim = limits.get(name)
    const window = lim && lim.min !== undefined && lim.max !== undefined ? lim.max - lim.min : null
    const rows: OatRow[] = []
    for (const t of tolerances) {
      const key = (t.ref ?? t.param) as string
      const lo = res.find((x) => x.j.key === key && x.j.sign === -1)
      const hi = res.find((x) => x.j.key === key && x.j.sign === 1)
      const low = lo?.ms.find((m) => m.name === name)?.value ?? null
      const high = hi?.ms.find((m) => m.name === name)?.value ?? null
      const swing = low !== null && high !== null ? high - low : null
      const err = lo?.error ?? hi?.error
      rows.push({ part: key, tol: t.tol, low, high, swing, share_of_window: swing !== null && window ? Math.abs(swing) / window : null, ...(err ? { error: err } : {}) })
    }
    out[name] = rows.sort((a, b) => Math.abs(b.swing ?? 0) - Math.abs(a.swing ?? 0))
  }
  return out
}

export { montecarlo }

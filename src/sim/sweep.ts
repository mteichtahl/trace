/**
 * Many simulations of one netlist: a parameter sweep, named corners, and Monte Carlo over component tolerances.
 *
 * Each point is a full ngspice run (simulate in spice.ts) followed by the same measurements, so a sweep is exactly
 * a series of single runs, and every point's numbers come from the tested measurement code. Runs go through a bounded
 * queue (at most os.availableParallelism() ngspice processes at once by default).
 *
 *   sweep        `.param` values: one parameter over a list (or a lin/log range), or several over their cartesian
 *                product. Each value is appended as `.param name=value` (in ngspice the last definition wins), so the
 *                netlist uses `{name}` where the parameter goes.
 *   corners      named sets of parameters ({"slow": {"rv": "1.1k", "temp": 85}, ...}); `temp` sets .options temp.
 *   montecarlo   N runs from a seed. Each varied part is a component (R, C or L, by reference: its value is scaled)
 *                or a parameter, with a tolerance and a distribution: uniform over ±tol, or gaussian with
 *                sigma = tol / sigmas (default 3, so tol is the 3-sigma limit) clipped at ±tol. The report gives each
 *                measurement's min, mean, max and standard deviation, and the run that was worst for it.
 */
import { parseValue } from '../core/units.js'
import { evaluate, type MeasureResult, type MeasureSpec } from './measure.js'
import { defaultConcurrency, mapLimit } from './proc.js'
import { simulate, SpiceError, vectorOf, type Plot, type SimulateOptions, type SpiceRun } from './spice.js'

export type ParamValue = number | string

/** Measurements on a simulation: each spec picks its analysis (`analysis`), default the first that has the vector. */
export function measureRun(run: Pick<SpiceRun, 'plots'>, specs: readonly MeasureSpec[]): MeasureResult[] {
  const out: MeasureResult[] = []
  for (const spec of specs) {
    const plot = pickPlot(run.plots, spec)
    if (typeof plot === 'string') {
      out.push({ name: spec.name ?? `${spec.kind}:${spec.vector}`, kind: spec.kind, value: null, unit: '', error: plot })
      continue
    }
    const x = plot.scale ? (plot.vectors.get(plot.scale) ?? []) : []
    const r = evaluate([spec], x, (n) => vectorOf(plot, n), plot.scale ?? undefined)
    out.push(...r.map((m) => ({ ...m, analysis: plot.analysis })))
  }
  return out
}

const AC_KINDS = new Set(['bandwidth', 'phase_margin', 'gain_margin'])

function pickPlot(plots: readonly Plot[], spec: MeasureSpec): Plot | string {
  if (spec.analysis) {
    const p = plots.find((q) => q.analysis === spec.analysis || q.kind === spec.analysis)
    return p ?? `no ${spec.analysis} analysis in this run (have: ${plots.map((q) => q.analysis).join(', ')})`
  }
  const cands = AC_KINDS.has(spec.kind) ? plots.filter((p) => p.kind === 'ac') : plots
  const base = spec.vector.split('#')[0] ?? spec.vector
  const p = cands.find((q) => vectorOf(q, spec.vector) || vectorOf(q, base))
  return p ?? `no vector ${JSON.stringify(spec.vector)} in ${cands.map((q) => q.analysis).join(', ') || 'any analysis'}`
}

export interface PointResult {
  index: number
  label: string
  params: Record<string, ParamValue>
  measurements: MeasureResult[]
  error?: string
}

interface RunPointsOptions {
  base: SimulateOptions
  specs: readonly MeasureSpec[]
  concurrency?: number
  onRun?: (p: PointResult, run: SpiceRun | null) => void
}

/** Run every point (each a variant of the base options) through the bounded queue. */
async function runPoints(points: { label: string; params: Record<string, ParamValue>; opts: SimulateOptions }[], o: RunPointsOptions): Promise<PointResult[]> {
  return mapLimit(points, o.concurrency ?? defaultConcurrency(), async (pt, index) => {
    try {
      const r = await simulate(pt.opts)
      const res: PointResult = { index, label: pt.label, params: pt.params, measurements: measureRun(r, o.specs) }
      o.onRun?.(res, r)
      return res
    } catch (e) {
      if (!(e instanceof SpiceError)) throw e
      const res: PointResult = { index, label: pt.label, params: pt.params, measurements: [], error: e.message }
      o.onRun?.(res, null)
      return res
    }
  })
}

// ------------------------------------------------------------------------------------------- sweep and corners

export interface SweepAxis {
  param: string
  values?: ParamValue[]
  /** A range instead of a list: from, to, points; log spacing when `log`. */
  from?: number
  to?: number
  points?: number
  log?: boolean
}

export function axisValues(a: SweepAxis): ParamValue[] {
  if (a.values?.length) return a.values
  if (a.from === undefined || a.to === undefined || !a.points) throw new SpiceError(`sweep of ${a.param}: give values, or from, to and points`)
  if (a.points < 2) return [a.from]
  if (a.log) {
    if (a.from <= 0 || a.to <= 0) throw new SpiceError(`log sweep of ${a.param} needs positive from and to`)
    const l0 = Math.log10(a.from)
    const l1 = Math.log10(a.to)
    return Array.from({ length: a.points }, (_, k) => Number((10 ** (l0 + ((l1 - l0) * k) / (a.points! - 1))).toPrecision(12)))
  }
  return Array.from({ length: a.points }, (_, k) => Number((a.from! + ((a.to! - a.from!) * k) / (a.points! - 1)).toPrecision(12)))
}

function withParams(base: SimulateOptions, params: Record<string, ParamValue>): SimulateOptions {
  const p: Record<string, ParamValue> = { ...(base.params ?? {}) }
  let options = base.options
  for (const [k, v] of Object.entries(params)) {
    if (k.toLowerCase() === 'temp') options = `${options ? `${options} ` : ''}temp=${v}`
    else p[k] = v
  }
  return { ...base, params: p, options }
}

export const MAX_POINTS = 2000

export async function sweep(base: SimulateOptions, axes: readonly SweepAxis[], o: Omit<RunPointsOptions, 'base'>): Promise<PointResult[]> {
  let combos: Record<string, ParamValue>[] = [{}]
  for (const a of axes) {
    const vals = axisValues(a)
    combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [a.param]: v })))
    if (combos.length > MAX_POINTS) throw new SpiceError(`the sweep has more than ${MAX_POINTS} points`)
  }
  const pts = combos.map((params) => ({ label: Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' '), params, opts: withParams(base, params) }))
  return runPoints(pts, { ...o, base })
}

export async function corners(base: SimulateOptions, sets: Readonly<Record<string, Record<string, ParamValue>>>, o: Omit<RunPointsOptions, 'base'>): Promise<PointResult[]> {
  const pts = Object.entries(sets).map(([label, params]) => ({ label, params, opts: withParams(base, params) }))
  if (!pts.length) throw new SpiceError('no corners given')
  return runPoints(pts, { ...o, base })
}

// ------------------------------------------------------------------------------------------- Monte Carlo

export interface Tolerance {
  /** A component reference (R1, C3, L2) whose value is scaled, or… */
  ref?: string
  /** …a .param name whose value is scaled. */
  param?: string
  /** Fractional tolerance: 0.01 = 1 %. */
  tol: number
  dist?: 'gaussian' | 'uniform'
  /** For gaussian: how many sigma the tolerance is (default 3). */
  sigmas?: number
}

/** mulberry32: small, fast and the same sequence everywhere for a seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function gaussian(r: () => number): number {
  let u = 0
  while (u === 0) u = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r())
}

/** The factor (1 + deviation) for one tolerance draw. */
export function draw(t: Tolerance, r: () => number): number {
  if (t.dist === 'uniform') return 1 + t.tol * (2 * r() - 1)
  const sigma = t.tol / (t.sigmas ?? 3)
  const d = gaussian(r) * sigma
  return 1 + Math.max(-t.tol, Math.min(t.tol, d))
}

const VALUE_KEY = /^(r|c|l|value)=/i

/** The netlist with component `ref`'s value multiplied by `factor` (R, C, L; a plain or {expression} value). */
export function scaleComponent(netlist: string, ref: string, factor: number): string {
  const lines = netlist.split('\n')
  const want = ref.toLowerCase()
  let found = false
  const out = lines.map((ln) => {
    const toks = ln.trim().split(/\s+/)
    if ((toks[0] ?? '').toLowerCase() !== want) return ln
    if (!/^[rcl]/i.test(want)) throw new SpiceError(`${ref}: only R, C and L values can be varied (vary a .param for others)`)
    found = true
    // value: the first token after the two nodes, or an r=/c=/l=/value= token
    let k = toks.findIndex((t, i) => i >= 3 && VALUE_KEY.test(t))
    let prefix = ''
    if (k >= 0) {
      prefix = (VALUE_KEY.exec(toks[k] as string) ?? [''])[0]
    } else k = 3
    const tok = toks[k]
    if (tok === undefined) throw new SpiceError(`${ref} has no value to vary: ${ln.trim()}`)
    const v = tok.slice(prefix.length)
    let nv: string
    if (v.startsWith('{') && v.endsWith('}')) nv = `{(${v.slice(1, -1)})*${factor}}`
    else {
      let num: number
      try {
        num = parseValue(v, { spice: true })
      } catch {
        throw new SpiceError(`${ref}: cannot read its value ${JSON.stringify(v)} (a model name? vary a .param instead)`)
      }
      nv = String(Number((num * factor).toPrecision(12)))
    }
    toks[k] = prefix + nv
    return toks.join(' ')
  })
  if (!found) throw new SpiceError(`no component ${ref} in the netlist`)
  return out.join('\n')
}

/** The nominal value of a .param in the netlist (the last definition), as a number. */
export function paramValue(netlist: string, name: string): number {
  const re = new RegExp(`^\\s*\\.param\\b.*?\\b${name}\\s*=\\s*([^\\s{}]+|\\{[^}]*\\})`, 'gim')
  let last: string | undefined
  for (const m of netlist.matchAll(re)) last = m[1]
  if (last === undefined) throw new SpiceError(`no .param ${name} in the netlist`)
  try {
    return parseValue(last, { spice: true })
  } catch {
    throw new SpiceError(`.param ${name} = ${last} is an expression: give it a plain value to vary it`)
  }
}

export interface Stat {
  name: string
  unit: string
  n: number
  failed: number
  nominal: number | null
  min: number | null
  mean: number | null
  max: number | null
  sigma: number | null
  min_run: number | null
  max_run: number | null
}

export function stats(points: readonly PointResult[], nominal?: PointResult): Stat[] {
  const names: string[] = []
  for (const p of points) for (const m of p.measurements) if (!names.includes(m.name)) names.push(m.name)
  return names.map((name) => {
    const vals: { v: number; run: number }[] = []
    let unit = ''
    let failed = 0
    for (const p of points) {
      const m = p.measurements.find((q) => q.name === name)
      if (m?.unit) unit = m.unit
      if (m && m.value !== null && Number.isFinite(m.value)) vals.push({ v: m.value, run: p.index })
      else failed++
    }
    const nom = nominal?.measurements.find((q) => q.name === name)?.value ?? null
    if (!vals.length) return { name, unit, n: 0, failed, nominal: nom, min: null, mean: null, max: null, sigma: null, min_run: null, max_run: null }
    let lo = vals[0]!
    let hi = vals[0]!
    let s = 0
    for (const x of vals) {
      if (x.v < lo.v) lo = x
      if (x.v > hi.v) hi = x
      s += x.v
    }
    const mean = s / vals.length
    const sigma = vals.length > 1 ? Math.sqrt(vals.reduce((a, x) => a + (x.v - mean) ** 2, 0) / (vals.length - 1)) : 0
    return { name, unit, n: vals.length, failed, nominal: nom, min: lo.v, mean, max: hi.v, sigma, min_run: lo.run, max_run: hi.run }
  })
}

export interface MonteCarloResult {
  nominal: PointResult
  runs: PointResult[]
  stats: Stat[]
  /** Per run, each varied part's factor. */
  factors: Record<string, number>[]
}

export const MAX_RUNS = 5000

export async function montecarlo(base: SimulateOptions, tolerances: readonly Tolerance[], n: number, seed: number, o: Omit<RunPointsOptions, 'base'>): Promise<MonteCarloResult> {
  if (n < 1 || n > MAX_RUNS) throw new SpiceError(`runs must be 1..${MAX_RUNS}`)
  if (!tolerances.length) throw new SpiceError('no tolerances given')
  for (const t of tolerances) {
    if ((t.ref === undefined) === (t.param === undefined)) throw new SpiceError('each tolerance names exactly one of ref or param')
    if (!(t.tol > 0 && t.tol < 1)) throw new SpiceError(`tolerance of ${t.ref ?? t.param} must be between 0 and 1 (0.01 = 1 %)`)
  }
  const nominalParams: Record<string, number> = {}
  for (const t of tolerances) if (t.param) nominalParams[t.param] = base.params?.[t.param] !== undefined ? parseValue(base.params[t.param] as ParamValue, { spice: true }) : paramValue(base.netlist, t.param)
  // check every component exists before starting N runs
  for (const t of tolerances) if (t.ref) scaleComponent(base.netlist, t.ref, 1)
  const r = rng(seed)
  const factors: Record<string, number>[] = []
  const pts: { label: string; params: Record<string, ParamValue>; opts: SimulateOptions }[] = []
  pts.push({ label: 'nominal', params: {}, opts: base })
  for (let k = 0; k < n; k++) {
    const f: Record<string, number> = {}
    let netlist = base.netlist
    const params: Record<string, ParamValue> = { ...(base.params ?? {}) }
    for (const t of tolerances) {
      const factor = draw(t, r)
      const key = t.ref ?? (t.param as string)
      f[key] = Number(factor.toPrecision(8))
      if (t.ref) netlist = scaleComponent(netlist, t.ref, factor)
      else params[t.param as string] = Number(((nominalParams[t.param as string] as number) * factor).toPrecision(12))
    }
    factors.push(f)
    pts.push({ label: `run ${k + 1}`, params: {}, opts: { ...base, netlist, params } })
  }
  const all = await runPoints(pts, { ...o, base })
  const nominal = all[0] as PointResult
  const runs = all.slice(1).map((p, k) => ({ ...p, index: k + 1, params: factors[k] ?? {} }))
  return { nominal, runs, stats: stats(runs, nominal), factors }
}

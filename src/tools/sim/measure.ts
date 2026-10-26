/**
 * Measurements on simulated (or captured) vectors, in plain TypeScript.
 *
 * Measurements are computed here rather than with ngspice's .meas so that one tested piece of code serves a single
 * simulation, every point of a sweep and a capture alike, and so a failed measurement says why instead of "failed".
 *
 * A measurement is an object: { name: 'vpk', kind: 'peak', vector: 'v(out)', from: 1e-3 }. Common keys:
 *
 *   name      what the result is called (default `kind:vector`)
 *   kind      one of KINDS
 *   vector    the y vector (ngspice name, case-insensitive; 'out' also finds 'v(out)')
 *   ref       a second vector subtracted from it (y = vector - ref); for AC kinds a ratio (dB and phase subtract)
 *   from, to  the window on the x axis (time, frequency or the DC sweep variable)
 *   analysis  which analysis of a run to measure on (tran, ac, dc, op, noise); default: see spice.ts
 *
 * Kinds and their own keys:
 *
 *   peak, trough, pp, average, rms, integral, final     window only
 *   value_at        at
 *   cross           level, edge (rising | falling | either), nth (1 = first), after (default `from`)
 *   rise_time, fall_time
 *                   lo, hi as fractions of the step (default 0.1, 0.9), or lo_level / hi_level absolute. The step runs
 *                   from the value at `from` (default the first point) to the final value.
 *   overshoot       percent of the step beyond the final value
 *   settling        band (fraction of the step, default 0.02) or band_abs: time from `from` until the vector enters,
 *                   and then stays within, the band around the final value
 *   time_above, time_below       level
 *   frequency, period            level (default the window's midpoint): the mean over all full cycles between
 *                                rising crossings, with the cycle count and the shortest and longest period
 *   duty            level: the fraction of the full cycles spent above it
 *   bandwidth       db (default 3): the first frequency, after the reference, at which the gain is `db` below it;
 *                   reference 'first' (default: the lowest frequency), 'max', or a number in dB
 *   phase_margin    180 + phase at the gain crossover (0 dB, falling); phase vector default `<vector>#phase`
 *   gain_margin     minus the gain (dB) at the phase crossover (phase = -180 degrees, unwrapped)
 *
 * A result is { name, kind, value, unit } plus `at` where it applies, or value null with an `error` saying why.
 * Nothing is extrapolated: a crossing the data does not contain is reported missing, not estimated.
 */
import { z } from 'zod'

export const KINDS = [
  'peak', 'trough', 'pp', 'average', 'rms', 'integral', 'final', 'value_at', 'cross', 'rise_time', 'fall_time',
  'overshoot', 'settling', 'time_above', 'time_below', 'frequency', 'period', 'duty', 'bandwidth', 'phase_margin',
  'gain_margin',
] as const
export type Kind = (typeof KINDS)[number]

export const MeasureSpecSchema = z.object({
  name: z.string().optional(),
  kind: z.enum(KINDS),
  vector: z.string().min(1),
  ref: z.string().optional(),
  analysis: z.enum(['op', 'dc', 'ac', 'tran', 'noise']).optional(),
  from: z.number().optional(),
  to: z.number().optional(),
  at: z.number().optional(),
  level: z.number().optional(),
  edge: z.enum(['rising', 'falling', 'either']).optional(),
  nth: z.number().int().min(1).optional(),
  after: z.number().optional(),
  lo: z.number().min(0).max(1).optional(),
  hi: z.number().min(0).max(1).optional(),
  lo_level: z.number().optional(),
  hi_level: z.number().optional(),
  band: z.number().positive().optional(),
  band_abs: z.number().positive().optional(),
  db: z.number().positive().optional(),
  reference: z.union([z.enum(['first', 'max']), z.number()]).optional(),
  phase: z.string().optional(),
}).strict()
export type MeasureSpec = z.output<typeof MeasureSpecSchema>

export interface MeasureResult {
  name: string
  kind: Kind
  value: number | null
  unit: string
  at?: number
  error?: string
  [extra: string]: number | string | null | undefined
}

export class MeasureError extends Error {
  override name = 'MeasureError'
}

type Vec = readonly number[]
const ix = (a: Vec, i: number): number => a[i] as number

// ------------------------------------------------------------------------------------------- primitives

/** Linear interpolation; outside the data is an error, not the end value. */
export function valueAt(x: Vec, y: Vec, at: number): number {
  if (!x.length) throw new MeasureError('no data')
  const first = ix(x, 0)
  const last = ix(x, x.length - 1)
  if (at < first || at > last) throw new MeasureError(`${fmt(at)} is outside the data (${fmt(first)}..${fmt(last)})`)
  let lo = 0
  let hi = x.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ix(x, mid) <= at) lo = mid
    else hi = mid
  }
  const xl = ix(x, lo)
  const xh = ix(x, hi)
  if (xh === xl || at >= xh) return ix(y, at >= xh ? hi : lo)
  return ix(y, lo) + ((at - xl) / (xh - xl)) * (ix(y, hi) - ix(y, lo))
}

/** The points with from <= x <= to, with interpolated end points so a window never loses the edge it starts on. */
export function window(x: Vec, y: Vec, from?: number, to?: number): [number[], number[]] {
  if (from === undefined && to === undefined) return [[...x], [...y]]
  const first = ix(x, 0)
  const last = ix(x, x.length - 1)
  const lo = from ?? first
  const hi = to ?? last
  if (hi < lo) throw new MeasureError(`empty window: from ${fmt(lo)} is after to ${fmt(hi)}`)
  const xs: number[] = []
  const ys: number[] = []
  if (from !== undefined && first < from && from <= last) {
    xs.push(from)
    ys.push(valueAt(x, y, from))
  }
  for (let k = 0; k < x.length; k++) {
    const xi = ix(x, k)
    if (xi >= lo && xi <= hi && !(xs.length && xi <= (xs[xs.length - 1] as number))) {
      xs.push(xi)
      ys.push(ix(y, k))
    }
  }
  if (to !== undefined && first <= to && to < last && (!xs.length || (xs[xs.length - 1] as number) < to)) {
    xs.push(to)
    ys.push(valueAt(x, y, to))
  }
  if (!xs.length) throw new MeasureError(`no points in the window [${fmt(lo)}, ${fmt(hi)}] (data spans ${fmt(first)}..${fmt(last)})`)
  return [xs, ys]
}

export function peak(x: Vec, y: Vec): [number, number] {
  let k = 0
  for (let i = 1; i < y.length; i++) if (ix(y, i) > ix(y, k)) k = i
  return [ix(y, k), ix(x, k)]
}

export function trough(x: Vec, y: Vec): [number, number] {
  let k = 0
  for (let i = 1; i < y.length; i++) if (ix(y, i) < ix(y, k)) k = i
  return [ix(y, k), ix(x, k)]
}

/** Every x at which y crosses `level` (interpolated). */
export function crossings(x: Vec, y: Vec, level: number, edge: 'rising' | 'falling' | 'either' = 'rising'): number[] {
  const out: number[] = []
  for (let k = 1; k < x.length; k++) {
    const a = ix(y, k - 1)
    const b = ix(y, k)
    const up = a < level && level <= b
    const down = a > level && level >= b
    if ((edge === 'rising' && up) || (edge === 'falling' && down) || (edge === 'either' && (up || down))) {
      const x0 = ix(x, k - 1)
      const x1 = ix(x, k)
      out.push(b !== a ? x0 + ((level - a) / (b - a)) * (x1 - x0) : x1)
    }
  }
  return out
}

export function integral(x: Vec, y: Vec): number {
  let s = 0
  for (let k = 1; k < x.length; k++) s += ((ix(y, k - 1) + ix(y, k)) / 2) * (ix(x, k) - ix(x, k - 1))
  return s
}

export function average(x: Vec, y: Vec): number {
  const span = ix(x, x.length - 1) - ix(x, 0)
  return span > 0 ? integral(x, y) / span : ix(y, 0)
}

/** RMS with the trapezoid's square integrated exactly (piecewise linear y). */
export function rms(x: Vec, y: Vec): number {
  const span = ix(x, x.length - 1) - ix(x, 0)
  if (span <= 0) return Math.abs(ix(y, 0))
  let s = 0
  for (let k = 1; k < x.length; k++) {
    const a = ix(y, k - 1)
    const b = ix(y, k)
    s += ((a * a + a * b + b * b) / 3) * (ix(x, k) - ix(x, k - 1))
  }
  return Math.sqrt(s / span)
}

/** Total x span with y above (or below) `level`, crossings interpolated. */
export function timeAbove(x: Vec, y: Vec, level: number, below = false): number {
  let s = 0
  for (let k = 1; k < x.length; k++) {
    const a = below ? level - ix(y, k - 1) : ix(y, k - 1) - level
    const b = below ? level - ix(y, k) : ix(y, k) - level
    const dx = ix(x, k) - ix(x, k - 1)
    if (a >= 0 && b >= 0) s += dx
    else if (a > 0 && b < 0) s += (dx * a) / (a - b)
    else if (b > 0 && a < 0) s += (dx * b) / (b - a)
  }
  return s
}

function step(x: Vec, y: Vec, from?: number): [number, number] {
  return [from !== undefined ? valueAt(x, y, from) : ix(y, 0), ix(y, y.length - 1)]
}

/** [duration, t at the first level, t at the second] of the first full transition after `from`. */
export function edgeTime(x: Vec, y: Vec, rising: boolean, o: { lo?: number; hi?: number; loLevel?: number; hiLevel?: number; from?: number } = {}): [number, number, number] {
  const [initial, final] = step(x, y, o.from)
  let loL = o.loLevel
  let hiL = o.hiLevel
  if (loL === undefined || hiL === undefined) {
    const [lowV, highV] = rising ? [initial, final] : [final, initial]
    if (highV <= lowV) throw new MeasureError(`no ${rising ? 'rising' : 'falling'} step: initial ${fmt(initial)}, final ${fmt(final)}`)
    loL = lowV + (o.lo ?? 0.1) * (highV - lowV)
    hiL = lowV + (o.hi ?? 0.9) * (highV - lowV)
  }
  const after = o.from ?? ix(x, 0)
  const [first, second] = rising ? [loL, hiL] : [hiL, loL]
  const dir = rising ? 'rising' : 'falling'
  const c1 = crossings(x, y, first, dir).filter((t) => t >= after)
  if (!c1.length) throw new MeasureError(`never ${rising ? 'rises' : 'falls'} through ${fmt(first)}`)
  const t1 = c1[0] as number
  const c2 = crossings(x, y, second, dir).filter((t) => t >= t1)
  if (!c2.length) throw new MeasureError(`never ${rising ? 'rises' : 'falls'} through ${fmt(second)}`)
  const t2 = c2[0] as number
  return [t2 - t1, t1, t2]
}

/** [percent, at] beyond the final value, relative to the step. */
export function overshoot(x: Vec, y: Vec, from?: number): [number, number] {
  const [initial, final] = step(x, y, from)
  const s = final - initial
  if (s === 0) throw new MeasureError('no step (initial equals final)')
  const [xs, ys] = window(x, y, from)
  if (s > 0) {
    const [v, at] = peak(xs, ys)
    return [Math.max(0, ((v - final) / s) * 100), at]
  }
  const [v, at] = trough(xs, ys)
  return [Math.max(0, ((final - v) / -s) * 100), at]
}

/** Time from `from` until y enters, and then stays in, final ± band. */
export function settling(x: Vec, y: Vec, o: { band?: number; bandAbs?: number; from?: number } = {}): number {
  const [initial, final] = step(x, y, o.from)
  const tol = o.bandAbs ?? Math.abs(final - initial) * (o.band ?? 0.02)
  if (tol <= 0) throw new MeasureError('the settling band is zero (no step: give band_abs)')
  const start = o.from ?? ix(x, 0)
  let lastOut = -1
  for (let k = 0; k < x.length; k++) if (ix(x, k) >= start && Math.abs(ix(y, k) - final) > tol) lastOut = k
  if (lastOut < 0) return 0
  if (lastOut === x.length - 1) throw new MeasureError('never settles within the band before the end of the data')
  const a = Math.abs(ix(y, lastOut) - final) - tol
  const b = Math.abs(ix(y, lastOut + 1) - final) - tol
  const t = ix(x, lastOut) + (ix(x, lastOut + 1) - ix(x, lastOut)) * (a !== b ? a / (a - b) : 1)
  return Math.max(0, t - start)
}

export interface Cycles {
  period: number
  frequency: number
  cycles: number
  period_min: number
  period_max: number
  level: number
}

export function frequency(x: Vec, y: Vec, level?: number): Cycles {
  const lv = level ?? (Math.max(...y) + Math.min(...y)) / 2
  const r = crossings(x, y, lv, 'rising')
  if (r.length < 2) throw new MeasureError(`fewer than two rising crossings of ${fmt(lv)}: no full cycle`)
  const periods = r.slice(1).map((t, k) => t - (r[k] as number))
  const mean = ((r[r.length - 1] as number) - (r[0] as number)) / (r.length - 1)
  return { period: mean, frequency: 1 / mean, cycles: periods.length, period_min: Math.min(...periods), period_max: Math.max(...periods), level: lv }
}

export function duty(x: Vec, y: Vec, level?: number): number {
  const lv = level ?? (Math.max(...y) + Math.min(...y)) / 2
  const r = crossings(x, y, lv, 'rising')
  if (r.length < 2) throw new MeasureError(`fewer than two rising crossings of ${fmt(lv)}: no full cycle`)
  const a = r[0] as number
  const b = r[r.length - 1] as number
  const [xs, ys] = window(x, y, a, b)
  return timeAbove(xs, ys, lv) / (b - a)
}

/** The frequency at which g crosses `level`, interpolated on log f, searching from index `start`. */
function logCross(f: Vec, g: Vec, level: number, falling: boolean, start = 1): number | null {
  for (let k = Math.max(1, start); k < f.length; k++) {
    const a = ix(g, k - 1)
    const b = ix(g, k)
    if ((falling && a >= level && level > b) || (!falling && a <= level && level < b)) {
      const f0 = ix(f, k - 1)
      const f1 = ix(f, k)
      if (f0 > 0 && f1 > 0) {
        const la = Math.log10(f0)
        const lb = Math.log10(f1)
        return 10 ** (la + ((level - a) / (b - a)) * (lb - la))
      }
      return f0 + ((level - a) / (b - a)) * (f1 - f0)
    }
  }
  return null
}

function interpLog(f: Vec, y: Vec, at: number): number {
  return valueAt(f.map((v) => (v > 0 ? Math.log10(v) : -300)), y, Math.log10(at))
}

/** [frequency, reference dB] where the gain first falls `drop` dB below the reference, after the reference. */
export function bandwidth(f: Vec, db: Vec, drop = 3, reference: 'first' | 'max' | number = 'first'): [number, number] {
  let ref = ix(db, 0)
  let k0 = 0
  if (reference === 'max') {
    for (let i = 1; i < db.length; i++) if (ix(db, i) > ix(db, k0)) k0 = i
    ref = ix(db, k0)
  } else if (typeof reference === 'number') ref = reference
  const fc = logCross(f, db, ref - drop, true, k0 + 1)
  if (fc === null) throw new MeasureError(`the gain never falls ${drop} dB below ${ref.toPrecision(4)} dB within ${fmt(ix(f, 0))}..${fmt(ix(f, f.length - 1))} Hz`)
  return [fc, ref]
}

export function unwrap(phaseDeg: Vec): number[] {
  const out: number[] = []
  let off = 0
  for (const p of phaseDeg) {
    if (out.length) {
      let d = p + off - (out[out.length - 1] as number)
      while (d > 180) { off -= 360; d -= 360 }
      while (d < -180) { off += 360; d += 360 }
    }
    out.push(p + off)
  }
  return out
}

/** [margin degrees, gain-crossover Hz]. */
export function phaseMargin(f: Vec, db: Vec, phase: Vec): [number, number] {
  const fc = logCross(f, db, 0, true)
  if (fc === null) throw new MeasureError('the gain never crosses 0 dB downward: no gain crossover in the data')
  return [180 + interpLog(f, unwrap(phase), fc), fc]
}

/** [margin dB, phase-crossover Hz]. */
export function gainMargin(f: Vec, db: Vec, phase: Vec): [number, number] {
  const fp = logCross(f, unwrap(phase), -180, true)
  if (fp === null) throw new MeasureError('the phase never reaches -180 degrees: no phase crossover in the data')
  return [-interpLog(f, db, fp), fp]
}

export const toDb = (mag: Vec): number[] => mag.map((v) => (v > 0 ? 20 * Math.log10(v) : -400))

// ------------------------------------------------------------------------------------------- evaluation

/** A source of vectors: returns the vector or undefined when it has none by that name. */
export type Lookup = (name: string) => readonly number[] | undefined

export function unitOf(vector: string): string {
  const v = vector.toLowerCase()
  if (v.endsWith('#db')) return 'dB'
  if (v.endsWith('#phase')) return 'deg'
  if (v.startsWith('i(') || v.endsWith('#branch') || v.startsWith('@')) return 'A'
  if (v.startsWith('v(') || v.includes('noise')) return 'V'
  return ''
}

export const xUnit = (xname: string | undefined): string => ({ time: 's', frequency: 'Hz' } as Record<string, string>)[(xname ?? '').toLowerCase()] ?? ''

function need(get: Lookup, name: string): readonly number[] {
  const v = get(name)
  if (!v) throw new MeasureError(`no vector ${JSON.stringify(name)}`)
  return v
}

/** Run each spec over the x vector and the vectors `get` returns. Never throws for a bad measurement. */
export function evaluate(specs: readonly MeasureSpec[], x: readonly number[], get: Lookup, xname?: string): MeasureResult[] {
  return specs.map((spec) => {
    const name = spec.name ?? `${spec.kind}:${spec.vector}`
    try {
      const r: MeasureResult = { name, kind: spec.kind, ...one(spec, x, get, xname) }
      return r
    } catch (e) {
      if (e instanceof MeasureError) return { name, kind: spec.kind, value: null, unit: '', error: e.message }
      throw e
    }
  })
}

interface Partial_ {
  value: number | null
  unit: string
  at?: number
  [extra: string]: number | string | null | undefined
}

function one(spec: MeasureSpec, x: readonly number[], get: Lookup, xname?: string): Partial_ {
  const { kind, vector: vec } = spec
  const xu = xUnit(xname)
  const vu = unitOf(vec)

  if (kind === 'bandwidth' || kind === 'phase_margin' || kind === 'gain_margin') {
    if (xname && xname.toLowerCase() !== 'frequency') throw new MeasureError(`${kind} needs AC data (the x axis is ${xname})`)
    const [db, phase] = gainPhase(spec, get, kind !== 'bandwidth')
    const [f, db2] = window(x, db, spec.from, spec.to)
    if (kind === 'bandwidth') {
      const [fc, ref] = bandwidth(f, db2, spec.db ?? 3, spec.reference ?? 'first')
      return { value: fc, unit: 'Hz', reference_db: ref }
    }
    const [, ph2] = window(x, phase ?? [], spec.from, spec.to)
    if (kind === 'phase_margin') {
      const [pm, fc] = phaseMargin(f, db2, ph2)
      return { value: pm, unit: 'deg', at: fc }
    }
    const [gm, fp] = gainMargin(f, db2, ph2)
    return { value: gm, unit: 'dB', at: fp }
  }

  let y: readonly number[] = need(get, vec)
  if (spec.ref) {
    const r = need(get, spec.ref)
    y = y.map((v, i) => v - (r[i] ?? NaN))
  }
  const xs0 = x.length ? x : [0]
  if (y.length !== xs0.length) throw new MeasureError(`${vec} has ${y.length} points, the x axis ${xs0.length}`)
  if (y.length === 1) {
    const v = y[0] as number
    if (kind === 'peak' || kind === 'trough' || kind === 'average' || kind === 'final' || kind === 'value_at') return { value: v, unit: vu }
    if (kind === 'rms') return { value: Math.abs(v), unit: vu }
    throw new MeasureError(`${kind} needs a swept or transient vector; ${vec} is a single point`)
  }
  switch (kind) {
    case 'value_at': {
      if (spec.at === undefined) throw new MeasureError("value_at needs 'at'")
      return { value: valueAt(xs0, y, spec.at), unit: vu, at: spec.at }
    }
    case 'cross': {
      if (spec.level === undefined) throw new MeasureError("cross needs 'level'")
      const edge = spec.edge ?? 'rising'
      const [xs, ys] = window(xs0, y, spec.after ?? spec.from, spec.to)
      const c = crossings(xs, ys, spec.level, edge)
      const nth = spec.nth ?? 1
      if (c.length < nth) throw new MeasureError(`${vec} crosses ${spec.level} (${edge}) ${c.length} time(s), not ${nth}`)
      return { value: c[nth - 1] as number, unit: xu, count: c.length }
    }
    case 'rise_time':
    case 'fall_time': {
      const [d, a, b] = edgeTime(xs0, y, kind === 'rise_time', { lo: spec.lo, hi: spec.hi, loLevel: spec.lo_level, hiLevel: spec.hi_level, from: spec.from })
      return { value: d, unit: xu, at: a, until: b }
    }
    case 'overshoot': {
      const [pct, at] = overshoot(xs0, y, spec.from)
      return { value: pct, unit: '%', at }
    }
    case 'settling':
      return { value: settling(xs0, y, { band: spec.band, bandAbs: spec.band_abs, from: spec.from }), unit: xu }
    default:
      break
  }
  const [xs, ys] = window(xs0, y, spec.from, spec.to)
  switch (kind) {
    case 'peak': {
      const [v, at] = peak(xs, ys)
      return { value: v, unit: vu, at }
    }
    case 'trough': {
      const [v, at] = trough(xs, ys)
      return { value: v, unit: vu, at }
    }
    case 'pp':
      return { value: Math.max(...ys) - Math.min(...ys), unit: vu }
    case 'final':
      return { value: ys[ys.length - 1] as number, unit: vu, at: xs[xs.length - 1] as number }
    case 'average':
      return { value: average(xs, ys), unit: vu }
    case 'rms':
      return { value: rms(xs, ys), unit: vu }
    case 'integral':
      return { value: integral(xs, ys), unit: vu && xu ? `${vu}·${xu}` : '' }
    case 'time_above':
    case 'time_below':
      if (spec.level === undefined) throw new MeasureError(`${kind} needs 'level'`)
      return { value: timeAbove(xs, ys, spec.level, kind === 'time_below'), unit: xu }
    case 'frequency':
    case 'period': {
      const r = frequency(xs, ys, spec.level)
      return { value: kind === 'frequency' ? r.frequency : r.period, unit: kind === 'frequency' ? 'Hz' : xu, cycles: r.cycles, period_min: r.period_min, period_max: r.period_max, level: r.level }
    }
    case 'duty':
      return { value: duty(xs, ys, spec.level), unit: 'ratio' }
    default:
      throw new MeasureError(`unhandled kind ${kind}`)
  }
}

function base(name: string): string {
  return name.toLowerCase().endsWith('#db') ? name.slice(0, -3) : name
}

function dbOf(get: Lookup, name: string): readonly number[] {
  const b = base(name)
  const direct = get(`${b}#db`)
  if (direct) return direct
  return toDb(need(get, b))
}

function gainPhase(spec: MeasureSpec, get: Lookup, needPhase: boolean): [readonly number[], readonly number[] | null] {
  const b = base(spec.vector)
  let db = dbOf(get, spec.vector)
  let phase: readonly number[] | null = needPhase ? need(get, spec.phase ?? `${b}#phase`) : null
  if (spec.ref) {
    const rdb = dbOf(get, spec.ref)
    db = db.map((v, i) => v - (rdb[i] ?? NaN))
    if (phase) {
      const rp = need(get, `${base(spec.ref)}#phase`)
      phase = phase.map((v, i) => v - (rp[i] ?? NaN))
    }
  }
  return [db, phase]
}

// ------------------------------------------------------------------------------------------- returning vectors

/** At most n points, keeping each series' local minimum and maximum in every bucket so peaks survive. */
export function decimate(x: readonly number[], series: readonly (readonly number[])[], n = 500): [number[], number[][]] {
  if (x.length <= n) return [[...x], series.map((s) => [...s])]
  const buckets = Math.max(1, Math.floor((n - 2) / (2 * Math.max(1, series.length))))
  const size = x.length / buckets
  const keep = new Set<number>([0, x.length - 1])
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor(b * size)
    const hi = Math.min(x.length, Math.floor((b + 1) * size))
    for (const s of series) {
      let kmax = lo
      let kmin = lo
      for (let k = lo; k < hi; k++) {
        if (ix(s, k) > ix(s, kmax)) kmax = k
        if (ix(s, k) < ix(s, kmin)) kmin = k
      }
      if (hi > lo) {
        keep.add(kmax)
        keep.add(kmin)
      }
    }
  }
  const idx = [...keep].sort((a, b) => a - b).slice(0, n)
  idx[idx.length - 1] = x.length - 1
  return [idx.map((i) => ix(x, i)), series.map((s) => idx.map((i) => ix(s, i)))]
}

/** Significant-figure rounding for returned numbers (non-finite → null). */
export function round(v: number, sig = 6): number | null {
  return Number.isFinite(v) ? Number(v.toPrecision(sig)) : null
}

function fmt(v: number): string {
  return Number.isFinite(v) ? String(Number(v.toPrecision(4))) : String(v)
}

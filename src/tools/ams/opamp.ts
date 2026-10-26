/**
 * Op-amp characterisation from a SPICE subcircuit: test benches generated around the device, each an ordinary
 * ngspice run.
 *
 *   loop     loop gain T(f) of the closed loop (non-inverting gain G, the given load) by Middlebrook's double
 *            injection: the loop is broken between the output (a) and the feedback network (b) by a 0 V source
 *            Vprobe (b to a), with a current source Iprobe into a. Run 1 drives Vprobe (AC 1): Tv = -V(a)/V(b).
 *            Run 2 drives Iprobe (AC 1): with i = I(Vprobe), the current into the amplifier side is 1 + i and into
 *            the feedback side -i, so Ti = (1 + i)/(-i). Then T = (Tv Ti - 1)/(Tv + Ti + 2), evaluated in the
 *            equivalent form (i Vb - Va (1 + i)) / (Vb (1 - i) + i Va), finite for an input that draws no current
 *            (R. D. Middlebrook,
 *            "Measurement of loop gain in feedback systems", Int. J. Electronics 38, 1975; the same quantity Tian's
 *            method computes, M. Tian et al., IEEE Circuits & Devices 17(1), 2001). The probe is ideal, so this is
 *            exact for the bench as drawn, loading of the output by the feedback network included. Phase margin is
 *            180 + arg T at the 0 dB crossover (phase unwrapped from the lowest frequency); gain margin is -|T| in dB
 *            where the phase reaches -180.
 *   aol, cmrr, psrr
 *            open loop at the follower's operating point: a 1 GH inductor from the output to the inverting input
 *            sets the DC point and is open at the analysis frequencies; a 1 F capacitor from the inverting input to
 *            a source node lets that input be driven in AC. Differential drive (+0.5 / -0.5) gives Aol; common drive
 *            (1 / 1) gives Acm, CMRR = |Aol / Acm|; a 1 V AC ripple on each supply gives Ap, PSRR = |Aol / Ap| (input-
 *            referred). Valid above about 1 Hz (the servo's corner is far below).
 *   slew     follower, a step of `slew_step` volts centred on Vcm with 1 ns edges: the slew rate is the 10-90 %
 *            average slope of the output, rising and falling.
 *   swing    inverting gain of -1 about Vcm (so the inputs stay at Vcm): the output range over which the output's
 *            error from ideal, less its error at mid-scale, stays within `tol_v`, with the load connected.
 *   icmr     follower, input swept over the rails: the input range around Vcm over which the follower's error, less
 *            its mid-scale offset, stays within `tol_v`. A follower's output must follow, so the range found is
 *            also bounded by the output swing; that is flagged when the two coincide.
 *
 * The device model decides everything: a macro-model that omits a behaviour (supply rejection, input range
 * limits) will report the ideal value for it.
 */
import { parseValue } from '../../core/units.js'
import { defaultConcurrency, mapLimit } from '../../sim/proc.js'
import { simulate, SpiceError, vectorOf, type Plot, type SimulateOptions, type SpiceRun } from '../../sim/spice.js'
import { atLogX, crossingLogX, cx, db, unwrapDeg, type Cx } from './common.js'

export type OpampTest = 'loop' | 'aol' | 'cmrr' | 'psrr' | 'slew' | 'swing' | 'icmr'
export const OPAMP_TESTS: readonly OpampTest[] = ['loop', 'aol', 'cmrr', 'psrr', 'slew', 'swing', 'icmr']

export interface OpampBench {
  /** The subcircuit definition (text) or an .include line for it. */
  device: string
  name: string
  /** Subcircuit port order as roles: inp, inn, out, vcc, vee, or any other name (tied with `tie`). */
  pins: readonly string[]
  tie: Readonly<Record<string, 'vcc' | 'vee' | 'gnd' | number>>
  vcc: number
  vee: number
  vcm: number
  gain: number
  rf: number
  rl: number
  cl: number
  fstart: number
  fstop: number
  perDecade: number
  slewStep: number
  slewTime?: number | undefined
  tolV: number
  freqs: readonly number[]
}

const ROLES = new Set(['inp', 'inn', 'out', 'vcc', 'vee'])

export function validatePins(pins: readonly string[], tie: Readonly<Record<string, unknown>>): void {
  for (const r of ['inp', 'inn', 'out', 'vcc', 'vee']) if (!pins.includes(r)) throw new SpiceError(`pins must include ${r} (the subcircuit's port order as roles: inp inn out vcc vee …)`)
  for (const p of pins) if (!ROLES.has(p) && tie[p] === undefined) throw new SpiceError(`pin ${p}: give tie.${p} (vcc, vee, gnd or a voltage)`)
}

/** The instance line and any tie sources, with the given nodes for the signal roles. */
function instance(b: OpampBench, nodes: { inp: string; inn: string; out: string }): string {
  const lines: string[] = []
  const conn = b.pins.map((p) => {
    if (p === 'inp' || p === 'inn' || p === 'out') return nodes[p]
    if (p === 'vcc' || p === 'vee') return p
    const t = b.tie[p]
    if (t === 'vcc' || t === 'vee') return t
    if (t === 'gnd') return '0'
    lines.push(`Vtie_${p} tie_${p} 0 DC ${t}`)
    return `tie_${p}`
  })
  return [...lines, `XDUT ${conn.join(' ')} ${b.name}`].join('\n')
}

function head(b: OpampBench, title: string, ac: { vcc?: string; vee?: string } = {}): string {
  return [
    `* ${title}: ${b.name}`,
    b.device.trim(),
    `Vcc vcc 0 DC ${b.vcc}${ac.vcc ? ` AC ${ac.vcc}` : ''}`,
    `Vee vee 0 DC ${b.vee}${ac.vee ? ` AC ${ac.vee}` : ''}`,
    `Vref vref 0 DC ${b.vcm}`,
  ].join('\n')
}

function load(b: OpampBench, node: string): string {
  return [`RL ${node} vref ${b.rl}`, ...(b.cl > 0 ? [`CL ${node} vref ${b.cl}`] : [])].join('\n')
}

const acLine = (b: OpampBench): string => `.ac dec ${b.perDecade} ${b.fstart} ${b.fstop}`

/** The loop-gain bench; `mode` picks which probe source carries the AC drive. */
export function loopBench(b: OpampBench, mode: 'v' | 'i'): string {
  const fb = b.gain === 1
    ? [] : [`Rf b inn ${b.rf}`, `Rg inn vref ${b.rf / (b.gain - 1)}`]
  return [
    head(b, 'loop gain (Middlebrook double injection)'),
    'Vin inp vref DC 0',
    instance(b, { inp: 'inp', inn: b.gain === 1 ? 'b' : 'inn', out: 'a' }),
    `Vprobe b a DC 0 AC ${mode === 'v' ? 1 : 0}`,
    `Iprobe 0 a DC 0 AC ${mode === 'i' ? 1 : 0}`,
    ...fb,
    load(b, 'a'),
    acLine(b),
  ].join('\n')
}

export type ServoDrive = 'diff' | 'cm' | 'psrr_pos' | 'psrr_neg'

export function servoBench(b: OpampBench, drive: ServoDrive): string {
  const inp = drive === 'diff' ? 'AC 0.5' : drive === 'cm' ? 'AC 1' : ''
  const inn = drive === 'diff' ? 'AC 0.5 180' : drive === 'cm' ? 'AC 1' : ''
  return [
    head(b, `open loop, DC servo (${drive})`, drive === 'psrr_pos' ? { vcc: '1' } : drive === 'psrr_neg' ? { vee: '1' } : {}),
    `Vin inp vref DC 0 ${inp}`.trimEnd(),
    instance(b, { inp: 'inp', inn: 'inn', out: 'out' }),
    'Lservo out inn 1e9',
    'Cservo inn cmn 1',
    `Vcmn cmn vref DC 0 ${inn}`.trimEnd(),
    load(b, 'out'),
    acLine(b),
  ].join('\n')
}

export function slewBench(b: OpampBench, window: number): string {
  const lo = b.vcm - b.slewStep / 2
  const hi = b.vcm + b.slewStep / 2
  const td = window * 0.1
  return [
    head(b, 'slew rate (follower)'),
    `Vin inp 0 PULSE(${lo} ${hi} ${td} 1n 1n ${window} ${3 * window})`,
    instance(b, { inp: 'inp', inn: 'out', out: 'out' }),
    load(b, 'out'),
    `.tran ${window / 2000} ${2.2 * window + td}`,
  ].join('\n')
}

export function swingBench(b: OpampBench): { netlist: string; lo: number; hi: number } {
  const span = (b.vcc - b.vee) * 0.6
  const lo = b.vcm - span
  const hi = b.vcm + span
  return {
    lo, hi,
    netlist: [
      head(b, 'output swing (inverting, gain -1)'),
      `Vin vin 0 DC ${b.vcm}`,
      `Rin vin inn ${b.rf}`,
      `Rf out inn ${b.rf}`,
      instance(b, { inp: 'vref', inn: 'inn', out: 'out' }),
      load(b, 'out'),
      `.dc Vin ${lo} ${hi} ${(hi - lo) / 1200}`,
    ].join('\n'),
  }
}

export function icmrBench(b: OpampBench): string {
  return [
    head(b, 'input common-mode range (follower)'),
    `Vin inp 0 DC ${b.vcm}`,
    instance(b, { inp: 'inp', inn: 'out', out: 'out' }),
    load(b, 'out'),
    `.dc Vin ${b.vee} ${b.vcc} ${(b.vcc - b.vee) / 1000}`,
  ].join('\n')
}

// ------------------------------------------------------------------------------------------- reading results

function complexVec(p: Plot, name: string): Cx[] {
  const re = vectorOf(p, `${name}#re`) ?? p.vectors.get(`${name.toLowerCase()}#re`)
  const im = vectorOf(p, `${name}#im`) ?? p.vectors.get(`${name.toLowerCase()}#im`)
  if (!re || !im) throw new SpiceError(`no complex vector ${name} in the ${p.analysis} results (have: ${p.names.slice(0, 12).join(', ')})`)
  return re.map((v, i) => [v, im[i] ?? 0] as const)
}

function branch(p: Plot, src: string): Cx[] {
  const s = src.toLowerCase()
  for (const n of [`i(${s})`, `${s}#branch`]) if (p.vectors.has(`${n}#re`)) return complexVec(p, n)
  throw new SpiceError(`no branch current of ${src} in the results`)
}

export interface LoopResult {
  f: number[]
  mag_db: number[]
  phase_deg: number[]
  dc_loop_gain_db: number
  crossover_hz: number | null
  phase_margin_deg: number | null
  phase_crossover_hz: number | null
  gain_margin_db: number | null
}

/** T(f) from the two probe runs (see the module comment). */
export function loopGain(vRun: Plot, iRun: Plot): LoopResult {
  const f = vRun.vectors.get('frequency') ?? []
  const va = complexVec(vRun, 'v(a)')
  const vb = complexVec(vRun, 'v(b)')
  const ip = branch(iRun, 'vprobe')
  // T = (Tv Ti - 1)/(Tv + Ti + 2) with Tv = -va/vb and Ti = (1 + i)/(-i), multiplied through by -i vb so that an
  // input with no DC path (i = 0, Ti infinite) or a feedback side of zero impedance (vb = 0) is not a 0/0:
  //   T = (i vb - va (1 + i)) / (vb (1 - i) + i va)
  const one = cx.real(1)
  const T: Cx[] = f.map((_, k) => {
    const a = va[k] as Cx
    const b = vb[k] as Cx
    const i = ip[k] as Cx
    return cx.div(cx.sub(cx.mul(i, b), cx.mul(a, cx.add(one, i))), cx.add(cx.mul(b, cx.sub(one, i)), cx.mul(i, a)))
  })
  return loopMetrics(f, T.map((t) => db(cx.abs(t))), unwrapDeg(T.map((t) => cx.deg(t))))
}

export function loopMetrics(f: readonly number[], magDb: readonly number[], phase: readonly number[]): LoopResult {
  // the phase is unwrapped from the lowest frequency; normalise its start into (-180, 180]
  const p0 = phase[0] ?? 0
  const shift = Math.round(p0 / 360) * 360
  const ph = phase.map((p) => p - shift)
  const fc = crossingLogX(f, magDb, 0, 'falling')
  const phAt = fc === null ? null : atLogX(f, ph, fc)
  const fp = crossingLogX(f, ph, -180, 'falling')
  const gAt = fp === null ? null : atLogX(f, magDb, fp)
  return {
    f: [...f], mag_db: [...magDb], phase_deg: ph, dc_loop_gain_db: magDb[0] ?? NaN,
    crossover_hz: fc, phase_margin_deg: phAt === null ? null : 180 + phAt,
    phase_crossover_hz: fp, gain_margin_db: gAt === null ? null : -gAt,
  }
}

export function transfer(p: Plot, node = 'out'): { f: number[]; h: Cx[] } {
  return { f: p.vectors.get('frequency') ?? [], h: complexVec(p, `v(${node})`) }
}

/** The first time after t0 at which y crosses `level`, linearly interpolated. */
export function crossingAfter(t: readonly number[], y: readonly number[], level: number, t0: number): number | null {
  for (let i = 1; i < t.length; i++) {
    if ((t[i] as number) < t0) continue
    const a = (y[i - 1] as number) - level
    const b = (y[i] as number) - level
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) {
      const ta = t[i - 1] as number
      const tb = t[i] as number
      return a === b ? tb : ta + (a / (a - b)) * (tb - ta)
    }
  }
  return null
}

/** 10-90 % average slope of a step from lo to hi (or hi to lo) starting at t0. */
export function slewRate(t: readonly number[], y: readonly number[], from: number, to: number, t0: number): number | null {
  const l10 = from + 0.1 * (to - from)
  const l90 = from + 0.9 * (to - from)
  const a = crossingAfter(t, y, l10, t0)
  if (a === null) return null
  const b = crossingAfter(t, y, l90, a)
  if (b === null || b <= a) return null
  return Math.abs(0.8 * (to - from)) / (b - a)
}

/** The contiguous range of x around index `mid` over which |err| <= tol. */
export function contiguousRange(x: readonly number[], err: readonly number[], mid: number, tol: number): [number, number] | null {
  if (Math.abs(err[mid] ?? Infinity) > tol) return null
  let lo = mid
  let hi = mid
  while (lo > 0 && Math.abs(err[lo - 1] as number) <= tol) lo--
  while (hi < x.length - 1 && Math.abs(err[hi + 1] as number) <= tol) hi++
  return [x[lo] as number, x[hi] as number]
}

function nearestIndex(x: readonly number[], v: number): number {
  let best = 0
  for (let i = 1; i < x.length; i++) if (Math.abs((x[i] as number) - v) < Math.abs((x[best] as number) - v)) best = i
  return best
}

// ------------------------------------------------------------------------------------------- the whole check

export interface OpampReport {
  loop?: Omit<LoopResult, 'f' | 'mag_db' | 'phase_deg'> & { gain: number; method: string }
  aol?: { dc_gain_db: number; gbw_hz: number | null; phase_margin_follower_from_aol_deg: number | null }
  cmrr_db?: { f: number; db: number | null }[]
  psrr_pos_db?: { f: number; db: number | null }[]
  psrr_neg_db?: { f: number; db: number | null }[]
  slew?: { rise_v_per_us: number | null; fall_v_per_us: number | null; step_v: number; window_s: number; note?: string }
  swing?: { high_v: number | null; low_v: number | null; tol_v: number; rl: number }
  icmr?: { low_v: number | null; high_v: number | null; tol_v: number; offset_v: number | null; limited_by_output_swing: boolean }
  measurements: { name: string; value: number | null; unit: string }[]
  curves: { loop?: LoopResult; aol?: { f: number[]; mag_db: number[]; phase_deg: number[] } }
  runs: { label: string; run: SpiceRun }[]
  errors: string[]
}

export async function checkOpamp(b: OpampBench, tests: readonly OpampTest[], sim: Omit<SimulateOptions, 'netlist'>, concurrency?: number): Promise<OpampReport> {
  const want = new Set(tests)
  const jobs: { label: string; netlist: string }[] = []
  if (want.has('loop')) jobs.push({ label: 'loop_v', netlist: loopBench(b, 'v') }, { label: 'loop_i', netlist: loopBench(b, 'i') })
  const needAol = want.has('aol') || want.has('cmrr') || want.has('psrr') || want.has('slew')
  if (needAol) jobs.push({ label: 'aol', netlist: servoBench(b, 'diff') })
  if (want.has('cmrr')) jobs.push({ label: 'cm', netlist: servoBench(b, 'cm') })
  if (want.has('psrr')) jobs.push({ label: 'psrr_pos', netlist: servoBench(b, 'psrr_pos') }, { label: 'psrr_neg', netlist: servoBench(b, 'psrr_neg') })
  let swingLoHi: { lo: number; hi: number } | null = null
  if (want.has('swing')) {
    const s = swingBench(b)
    swingLoHi = s
    jobs.push({ label: 'swing', netlist: s.netlist })
  }
  if (want.has('icmr')) jobs.push({ label: 'icmr', netlist: icmrBench(b) })
  const out: OpampReport = { measurements: [], curves: {}, runs: [], errors: [] }
  const results = new Map<string, SpiceRun>()
  const runOne = async (j: { label: string; netlist: string }): Promise<void> => {
    try {
      const r = await simulate({ ...sim, netlist: j.netlist, analyses: undefined })
      results.set(j.label, r)
      out.runs.push({ label: j.label, run: r })
    } catch (e) {
      if (!(e instanceof SpiceError)) throw e
      out.errors.push(`${j.label}: ${e.message}`)
    }
  }
  await mapLimit(jobs, concurrency ?? defaultConcurrency(), runOne)
  const m = (name: string, value: number | null, unit: string): void => { out.measurements.push({ name, value, unit }) }
  const plot = (label: string): Plot | undefined => results.get(label)?.plots[0]

  if (want.has('loop')) {
    const pv = plot('loop_v')
    const pi = plot('loop_i')
    if (pv && pi) {
      const L = loopGain(pv, pi)
      const { f: _f, mag_db: _m, phase_deg: _p, ...rest } = L
      out.loop = { ...rest, gain: b.gain, method: 'Middlebrook double injection (voltage + current), ideal probe' }
      out.curves.loop = L
      m('loop_gain_dc_db', L.dc_loop_gain_db, 'dB')
      m('crossover_hz', L.crossover_hz, 'Hz')
      m('phase_margin_deg', L.phase_margin_deg, 'deg')
      m('gain_margin_db', L.gain_margin_db, 'dB')
    }
  }
  const aolPlot = plot('aol')
  let gbw: number | null = null
  let ad: { f: number[]; h: Cx[] } | null = null
  if (aolPlot) {
    ad = transfer(aolPlot)
    const mag = ad.h.map((h) => db(cx.abs(h)))
    const ph = unwrapDeg(ad.h.map((h) => cx.deg(h)))
    const L = loopMetrics(ad.f, mag, ph)
    gbw = L.crossover_hz
    if (want.has('aol')) {
      out.aol = { dc_gain_db: mag[0] ?? NaN, gbw_hz: gbw, phase_margin_follower_from_aol_deg: L.phase_margin_deg }
      out.curves.aol = { f: ad.f, mag_db: mag, phase_deg: L.phase_deg }
      m('aol_dc_db', mag[0] ?? null, 'dB')
      m('gbw_hz', gbw, 'Hz')
    }
  }
  const ratioDb = (num: { f: number[]; h: Cx[] }, den: Plot | undefined): { f: number; db: number | null }[] | null => {
    if (!den) return null
    const d = transfer(den)
    const ratio = num.h.map((h, k) => db(cx.abs(h) / cx.abs(d.h[k] as Cx)))
    return b.freqs.map((f) => ({ f, db: atLogX(num.f, ratio, f) }))
  }
  if (want.has('cmrr') && ad) {
    const v = ratioDb(ad, plot('cm'))
    if (v) {
      out.cmrr_db = v
      m('cmrr_db', v[0]?.db ?? null, 'dB')
    }
  }
  if (want.has('psrr') && ad) {
    const p = ratioDb(ad, plot('psrr_pos'))
    const n = ratioDb(ad, plot('psrr_neg'))
    if (p) {
      out.psrr_pos_db = p
      m('psrr_pos_db', p[0]?.db ?? null, 'dB')
    }
    if (n) {
      out.psrr_neg_db = n
      m('psrr_neg_db', n[0]?.db ?? null, 'dB')
    }
  }
  if (want.has('slew')) {
    const window = b.slewTime ?? (gbw ? Math.max(100 / gbw, 1e-7) : 1e-4)
    try {
      const r = await simulate({ ...sim, netlist: slewBench(b, window), analyses: undefined })
      out.runs.push({ label: 'slew', run: r })
      const p = r.plots[0] as Plot
      const t = p.vectors.get('time') ?? []
      const y = vectorOf(p, 'v(out)') ?? []
      const lo = b.vcm - b.slewStep / 2
      const hi = b.vcm + b.slewStep / 2
      const td = window * 0.1
      const rise = slewRate(t, y, lo, hi, td)
      const fall = slewRate(t, y, hi, lo, td + window)
      out.slew = {
        rise_v_per_us: rise === null ? null : rise / 1e6, fall_v_per_us: fall === null ? null : fall / 1e6, step_v: b.slewStep, window_s: window,
        ...(rise === null || fall === null ? { note: 'the output did not cross 10 % and 90 % of the step within the window: give slew_time_s (longer), or a smaller slew_step inside the output swing' } : {}),
      }
      m('slew_rise_v_per_us', out.slew.rise_v_per_us, 'V/us')
      m('slew_fall_v_per_us', out.slew.fall_v_per_us, 'V/us')
    } catch (e) {
      if (!(e instanceof SpiceError)) throw e
      out.errors.push(`slew: ${e.message}`)
    }
  }
  const sw = plot('swing')
  if (sw && swingLoHi) {
    const x = sw.vectors.get(sw.scale ?? '') ?? []
    const y = vectorOf(sw, 'v(out)') ?? []
    const mid = nearestIndex(x, b.vcm)
    const e0 = (y[mid] as number) - (2 * b.vcm - (x[mid] as number))
    const err = y.map((v, i) => v - (2 * b.vcm - (x[i] as number)) - e0)
    const range = contiguousRange(x, err, mid, b.tolV)
    // output = 2 vcm - vin: the input range maps to the output range reversed
    const high = range ? 2 * b.vcm - range[0] + e0 : null
    const low = range ? 2 * b.vcm - range[1] + e0 : null
    out.swing = { high_v: high, low_v: low, tol_v: b.tolV, rl: b.rl }
    m('swing_high_v', high, 'V')
    m('swing_low_v', low, 'V')
  }
  const ic = plot('icmr')
  if (ic) {
    const x = ic.vectors.get(ic.scale ?? '') ?? []
    const y = vectorOf(ic, 'v(out)') ?? []
    const mid = nearestIndex(x, b.vcm)
    const off = (y[mid] as number) - (x[mid] as number)
    const err = y.map((v, i) => v - (x[i] as number) - off)
    const range = contiguousRange(x, err, mid, b.tolV)
    const limited = !!(range && out.swing && ((out.swing.high_v !== null && range[1] >= out.swing.high_v - 2 * b.tolV) || (out.swing.low_v !== null && range[0] <= out.swing.low_v + 2 * b.tolV)))
    out.icmr = { low_v: range?.[0] ?? null, high_v: range?.[1] ?? null, tol_v: b.tolV, offset_v: off, limited_by_output_swing: limited }
    m('icmr_low_v', out.icmr.low_v, 'V')
    m('icmr_high_v', out.icmr.high_v, 'V')
    m('offset_v', off, 'V')
  }
  return out
}

export const parseNum = (v: number | string): number => (typeof v === 'number' ? v : parseValue(v, { spice: true }))

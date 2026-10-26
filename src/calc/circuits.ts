/**
 * Resistor networks people size every day: dividers, regulator feedback dividers, op-amp gain resistors and LED
 * series resistors.
 *
 * Each calculator works both ways: from component values to the result, or from a target to the components. When it
 * picks components it picks preferred values from an E-series (IEC 60063), returns the three best by error and shows
 * how far the result can move with the stated tolerances (every +/- corner evaluated). With nothing fixed, both
 * resistors move: every preferred pair in a resistance window is tried.
 */
import {
  best, errPct, eng, first, fmtPct, neighbours, opt, spread, tolFrac, ToolError, val, valuesBetween,
  type ESeries, type Out, type Result, type Val,
} from './common.js'

/** The window searched when both resistors move: [lo, hi] ohms, default 1 kΩ to 1 MΩ. */
function window(lo: Val | undefined, hi: Val | undefined): [number, number] {
  const a = opt('r_min', lo) ?? 1e3
  const b = opt('r_max', hi) ?? 1e6
  if (a >= b) throw new ToolError('r_min: must be below r_max')
  return [a, b]
}

/**
 * Both resistors move: for each preferred value of the second resistor in the window, the two preferred values
 * either side of the ideal first resistor are tried. Ties (equal error) go to the pair nearest the window's
 * geometric middle, which keeps the divider current moderate.
 */
function pairSearch<T extends Out & { error_pct: number }>(
  series: ESeries, lo: number, hi: number, idealA: (b: number) => number, point: (a: number, b: number) => T | null,
  label: (c: T) => number,
): T[] {
  const mid = Math.sqrt(lo * hi)
  const out: T[] = []
  for (const b of valuesBetween(series, lo, hi)) {
    const ia = idealA(b)
    if (!(ia > 0) || !Number.isFinite(ia)) continue
    for (const a of neighbours(ia, series, 1)) {
      if (a < lo * (1 - 1e-9) || a > hi * (1 + 1e-9)) continue
      const p = point(a, b)
      if (p) out.push(p)
    }
  }
  return best(out, 3, (c) => Math.abs(c.error_pct) + 1e-6 * Math.abs(Math.log(label(c) / mid)))
}

// ------------------------------------------------------------------------------------------------- divider
export interface DividerArgs {
  vin: Val
  r1?: Val | undefined
  r2?: Val | undefined
  vout?: Val | undefined
  load_current?: Val | undefined
  tolerance?: Val | undefined
  vin_tolerance?: Val | undefined
  total_current?: Val | undefined
  r_min?: Val | undefined
  r_max?: Val | undefined
  series?: ESeries | undefined
}

/** Loaded divider: Thevenin source Vin R2/(R1+R2) behind R1 || R2, with Iload drawn from the output. */
const vdiv = (vin: number, r1: number, r2: number, il: number): number => (vin * r2) / (r1 + r2) - (il * r1 * r2) / (r1 + r2)

type DivPoint = Out & { r1_ohm: number; r2_ohm: number; vout_v: number; i_r1_a: number; min_vout_v: number; max_vout_v: number; error_pct: number }

/**
 * Resistor divider, R1 from Vin to the output, R2 from the output to ground.
 *
 * Forward (r1, r2): Vout = Vin R2/(R1+R2) - Iload (R1 || R2), from Kirchhoff's laws (the Thevenin equivalent;
 * Horowitz & Hill, The Art of Electronics, 3rd ed., section 1.2.5). Reports each resistor's current and power and
 * the worst-case Vout over resistor and supply tolerance.
 *
 * Inverse (vout): fix one of r1, r2 or total_current (the current drawn from Vin through R1) and the other resistor
 * is solved exactly, including the load current, then rounded to the series; fix none and both resistors move over
 * [r_min, r_max].
 */
export function divider(a: DividerArgs): Result {
  const vin = val('vin', a.vin)
  const il = val('load_current', a.load_current ?? 0, { allowZero: true })
  const tol = tolFrac('tolerance', a.tolerance, 0.01)
  const vtol = tolFrac('vin_tolerance', a.vin_tolerance, 0)
  const r1 = opt('r1', a.r1)
  const r2 = opt('r2', a.r2)
  const vt = opt('vout', a.vout)

  const point = (x: number, y: number): DivPoint | null => {
    const vout = vdiv(vin, x, y, il)
    if (!(vout > 0)) return null
    const i1 = (vin - vout) / x
    const i2 = vout / y
    const sp = spread((p, q, v) => vdiv(v, p, q, il), [x, y, vin], [tol, tol, vtol], 'vout_v')
    return {
      r1_ohm: x, r2_ohm: y, vout_v: vout, i_r1_a: i1, i_r2_a: i2, p_r1_w: i1 * i1 * x, p_r2_w: i2 * i2 * y,
      r_thevenin_ohm: (x * y) / (x + y), ...sp, min_vout_v: sp.min_vout_v as number, max_vout_v: sp.max_vout_v as number,
      error_pct: vt === undefined ? 0 : errPct(vout, vt),
    }
  }

  if (vt === undefined) {
    if (r1 === undefined || r2 === undefined) {
      throw new ToolError('divider: give r1 and r2 (forward), or vout to solve for the resistors')
    }
    const p = point(r1, r2)
    if (!p) throw new ToolError('divider: the load current pulls the output to or below 0 V')
    const { error_pct: _e, ...rest } = p
    return {
      ...rest, tolerance: tol,
      summary: `Vout ${eng(p.vout_v, 'V')} (worst case ${eng(p.min_vout_v, 'V')} to ${eng(p.max_vout_v, 'V')} at ${tol * 100} %), divider current ${eng(p.i_r1_a, 'A')}`,
    }
  }
  const series = a.series ?? 'E24'
  if (vt >= vin) throw new ToolError('vout: must be below vin')
  const itot = opt('total_current', a.total_current)
  const fixed = [r1, r2, itot].filter((x) => x !== undefined).length
  if (fixed > 1) throw new ToolError('divider: to solve for vout, fix at most one of r1, r2, total_current')
  if (itot !== undefined && itot <= il) throw new ToolError('total_current: must exceed load_current')
  // R2 for a given R1: Vout = (Vin - Iload R1) R2 / (R1 + R2)  =>  R2 = Vout R1 / (Vin - Vout - Iload R1)
  const idealR2 = (x: number) => (vt * x) / (vin - vt - il * x)
  // R1 for a given R2: R1 = R2 (Vin - Vout) / (Vout + Iload R2)
  const idealR1 = (y: number) => (y * (vin - vt)) / (vt + il * y)
  let cands: DivPoint[]
  let ideal1: number | null = null
  let ideal2: number | null = null
  let mode: string
  if (fixed === 0) {
    const [lo, hi] = window(a.r_min, a.r_max)
    mode = 'both resistors move'
    cands = pairSearch(series, lo, hi, idealR1, point, (c) => c.r2_ohm)
  } else {
    mode = 'one resistor fixed'
    if (r2 !== undefined) { ideal2 = r2; ideal1 = idealR1(r2) } else {
      ideal1 = r1 ?? (vin - vt) / (itot as number)
      if (vin - vt - il * ideal1 <= 0) throw new ToolError('divider: with this R1 the load current alone drops more than Vin - Vout')
      ideal2 = idealR2(ideal1)
    }
    const c1 = r1 !== undefined ? [r1] : neighbours(ideal1, series, 2)
    const c2 = r2 !== undefined ? [r2] : neighbours(ideal2, series, 2)
    const all: DivPoint[] = []
    for (const x of c1) for (const y of c2) { const p = point(x, y); if (p) all.push(p) }
    cands = itot !== undefined
      ? best(all, 3, (c) => Math.abs(c.error_pct) + 0.1 * Math.abs(errPct(c.i_r1_a, itot)))
      : best(all)
  }
  const b = first(cands, 'divider')
  return {
    target_vout_v: vt, mode, ideal_r1_ohm: ideal1, ideal_r2_ohm: ideal2, series, tolerance: tol, candidates: cands,
    summary: `R1 ${eng(b.r1_ohm, 'Ω')} / R2 ${eng(b.r2_ohm, 'Ω')} (${series}) gives ${eng(b.vout_v, 'V')} (${fmtPct(b.error_pct)}), worst case ${eng(b.min_vout_v, 'V')} to ${eng(b.max_vout_v, 'V')}`,
  }
}

// ------------------------------------------------------------------------------------------------- regulator
export type RegTopology = 'feedback' | 'adjust'
export interface RegulatorArgs {
  vref: Val
  vout?: Val | undefined
  r_top?: Val | undefined
  r_bottom?: Val | undefined
  topology?: RegTopology | undefined
  bias_current?: Val | undefined
  divider_current?: Val | undefined
  tolerance?: Val | undefined
  vref_tolerance?: Val | undefined
  r_min?: Val | undefined
  r_max?: Val | undefined
  series?: ESeries | undefined
}

/**
 * feedback: FB held at Vref, bias current Ifb flows into the FB pin, so R_top carries Vref/R_bottom + Ifb:
 *   Vout = Vref (1 + R_top/R_bottom) + Ifb R_top.
 * adjust (LM317): Vref across R_top (OUT to ADJ), Iadj flows out of ADJ through R_bottom:
 *   Vout = Vref (1 + R_bottom/R_top) + Iadj R_bottom   (TI LM317 datasheet SLVS044, equation 1).
 */
const vreg = (t: RegTopology, vref: number, rt: number, rb: number, ib: number): number =>
  t === 'feedback' ? vref + rt * (vref / rb + ib) : vref + rb * (vref / rt + ib)

type RegPoint = Out & { r_top_ohm: number; r_bottom_ohm: number; vout_v: number; min_vout_v: number; max_vout_v: number; error_pct: number }

/**
 * Feedback divider of an adjustable regulator. topology "feedback" (most switchers and LDOs): R_top from Vout to FB,
 * R_bottom from FB to ground (Kirchhoff's current law at FB; as e.g. TI TPS5430 datasheet SLVS632, "Output Voltage
 * Setpoint"). topology "adjust": LM317 style (SLVS044). Inverse: vout with one of r_top, r_bottom or divider_current
 * (the current in the resistor that sees Vref) fixed, or none and both resistors move over [r_min, r_max].
 */
export function regulatorFeedback(a: RegulatorArgs): Result {
  const topo: RegTopology = a.topology ?? 'feedback'
  const vref = val('vref', a.vref)
  const ib = val('bias_current', a.bias_current ?? 0, { positive: false })
  const tol = tolFrac('tolerance', a.tolerance, 0.01)
  const vtol = tolFrac('vref_tolerance', a.vref_tolerance, 0)
  let rt = opt('r_top', a.r_top)
  let rb = opt('r_bottom', a.r_bottom)
  const vt = opt('vout', a.vout)

  const point = (x: number, y: number): RegPoint => {
    const v = vreg(topo, vref, x, y, ib)
    const sp = spread((p, q, r) => vreg(topo, r, p, q, ib), [x, y, vref], [tol, tol, vtol], 'vout_v')
    return {
      r_top_ohm: x, r_bottom_ohm: y, vout_v: v, divider_current_a: topo === 'feedback' ? vref / y : vref / x, ...sp,
      min_vout_v: sp.min_vout_v as number, max_vout_v: sp.max_vout_v as number, error_pct: vt === undefined ? 0 : errPct(v, vt),
    }
  }
  if (vt === undefined) {
    if (rt === undefined || rb === undefined) throw new ToolError('regulator_feedback: give r_top and r_bottom, or vout to solve')
    const { error_pct: _e, ...p } = point(rt, rb)
    return { ...p, topology: topo, summary: `Vout ${eng(p.vout_v, 'V')} (worst case ${eng(p.min_vout_v, 'V')} to ${eng(p.max_vout_v, 'V')})` }
  }
  const series = a.series ?? 'E24'
  if (vt <= vref) throw new ToolError('vout: must exceed vref')
  const idiv = opt('divider_current', a.divider_current)
  const nFixed = [rt, rb, idiv].filter((x) => x !== undefined).length
  if (nFixed > 1) throw new ToolError('regulator_feedback: to solve, fix at most one of r_top, r_bottom, divider_current')
  // The resistor that sees Vref ("ref") and the one that sets the gain ("gain"):
  // feedback: ref = R_bottom, gain = R_top; adjust: ref = R_top, gain = R_bottom. gain = (Vout - Vref)/(Vref/ref + ib).
  const gainFor = (ref: number) => (vt - vref) / (vref / ref + ib)
  const refFor = (gain: number) => {
    const d = (vt - vref) / gain - ib
    return d > 0 ? vref / d : NaN
  }
  const toTB = (ref: number, gain: number): [number, number] => (topo === 'feedback' ? [gain, ref] : [ref, gain])
  let cands: RegPoint[]
  let idealT: number | null = null
  let idealB: number | null = null
  let mode: string
  if (nFixed === 0) {
    mode = 'both resistors move'
    const [lo, hi] = window(a.r_min, a.r_max)
    cands = pairSearch(series, lo, hi, gainFor, (g, r) => { const [x, y] = toTB(r, g); return point(x, y) },
      (c) => (topo === 'feedback' ? c.r_bottom_ohm : c.r_top_ohm))
  } else {
    mode = 'one resistor fixed'
    if (idiv !== undefined) { if (topo === 'feedback') rb = vref / idiv; else rt = vref / idiv }
    const fixedRef = topo === 'feedback' ? rb : rt
    const fixedGain = topo === 'feedback' ? rt : rb
    let ref: number
    let gain: number
    if (fixedRef !== undefined) { ref = fixedRef; gain = gainFor(ref) } else {
      gain = fixedGain as number
      ref = refFor(gain)
      if (!Number.isFinite(ref)) throw new ToolError('regulator_feedback: the bias current alone exceeds the gain resistor current needed')
    }
    ;[idealT, idealB] = toTB(ref, gain)
    // a resistor given directly is held; one derived from divider_current is rounded to the series
    const holdT = a.r_top !== undefined
    const holdB = a.r_bottom !== undefined
    const ct = holdT ? [idealT] : neighbours(idealT, series, 2)
    const cb = holdB ? [idealB] : neighbours(idealB, series, 2)
    const all: RegPoint[] = []
    for (const x of ct) for (const y of cb) all.push(point(x, y))
    cands = best(all)
  }
  const b = first(cands, 'regulator_feedback')
  return {
    target_vout_v: vt, topology: topo, mode, ideal_r_top_ohm: idealT, ideal_r_bottom_ohm: idealB, series, candidates: cands,
    summary: `R_top ${eng(b.r_top_ohm, 'Ω')} / R_bottom ${eng(b.r_bottom_ohm, 'Ω')} gives ${eng(b.vout_v, 'V')} (${fmtPct(b.error_pct)}), worst case ${eng(b.min_vout_v, 'V')} to ${eng(b.max_vout_v, 'V')}`,
  }
}

// ------------------------------------------------------------------------------------------------- op amp
export interface OpampArgs {
  config: 'inverting' | 'noninverting'
  rf?: Val | undefined
  rg?: Val | undefined
  gain?: Val | undefined
  gbw?: Val | undefined
  tolerance?: Val | undefined
  r_min?: Val | undefined
  r_max?: Val | undefined
  series?: ESeries | undefined
}

/**
 * Inverting G = -Rf/Rg; non-inverting G = 1 + Rf/Rg. Noise gain 1 + Rf/Rg either way; a voltage-feedback amplifier's
 * closed-loop bandwidth is GBW / noise gain (TI, Op Amps for Everyone, SLOD006B, chapters 3 and 8). Inverse: gain
 * (its magnitude for inverting) with rf or rg fixed, or neither and both move.
 */
export function opampGain(a: OpampArgs): Result {
  const inv = a.config === 'inverting'
  const tol = tolFrac('tolerance', a.tolerance, 0.01)
  const gbw = opt('gbw', a.gbw)
  const g = (f: number, r: number) => (inv ? -f / r : 1 + f / r)
  type P = Out & { rf_ohm: number; rg_ohm: number; gain: number; error_pct: number; bandwidth_hz: number | null }
  const target = a.gain === undefined ? undefined : Math.abs(val('gain', a.gain, { positive: false }))
  const point = (f: number, r: number): P => {
    const G = g(f, r)
    const ng = 1 + f / r
    return {
      rf_ohm: f, rg_ohm: r, gain: G, gain_db: 20 * Math.log10(Math.abs(G)), noise_gain: ng,
      ...spread((p, q) => Math.abs(g(p, q)), [f, r], [tol, tol], 'gain_abs'),
      bandwidth_hz: gbw === undefined ? null : gbw / ng, error_pct: target === undefined ? 0 : errPct(Math.abs(G), target),
    }
  }
  const rf = opt('rf', a.rf)
  const rg = opt('rg', a.rg)
  const bw = (p: P) => (p.bandwidth_hz === null ? '' : `, bandwidth ${eng(p.bandwidth_hz, 'Hz')}`)
  if (target === undefined) {
    if (rf === undefined || rg === undefined) throw new ToolError('opamp_gain: give rf and rg, or gain to solve')
    const { error_pct: _e, ...p } = point(rf, rg)
    return { ...p, config: a.config, summary: `gain ${p.gain.toPrecision(4)} (${(p.gain_db as number).toFixed(2)} dB)${bw({ ...p, error_pct: 0 })}` }
  }
  if (target === 0) throw new ToolError('gain: must be non-zero')
  const ratio = inv ? target : target - 1
  if (ratio <= 0) throw new ToolError('gain: a non-inverting gain must exceed 1 (gain 1 is a follower: Rf = 0, no Rg)')
  if (rf !== undefined && rg !== undefined) throw new ToolError('opamp_gain: to solve, fix at most one of rf, rg')
  const series = a.series ?? 'E24'
  let cands: P[]
  if (rf === undefined && rg === undefined) {
    const [lo, hi] = window(a.r_min, a.r_max)
    cands = pairSearch(series, lo, hi, (r) => ratio * r, point, (c) => c.rg_ohm)
  } else {
    const cf = rf !== undefined ? [rf] : neighbours(ratio * (rg as number), series, 2)
    const cg = rg !== undefined ? [rg] : neighbours((rf as number) / ratio, series, 2)
    const all: P[] = []
    for (const f of cf) for (const r of cg) all.push(point(f, r))
    cands = best(all)
  }
  const b = first(cands, 'opamp_gain')
  return {
    target_gain: inv ? -target : target, config: a.config, series, candidates: cands,
    summary: `Rf ${eng(b.rf_ohm, 'Ω')} / Rg ${eng(b.rg_ohm, 'Ω')} gives gain ${b.gain.toPrecision(4)} (${fmtPct(b.error_pct)})${bw(b)}`,
  }
}

// ------------------------------------------------------------------------------------------------- LED
export interface LedArgs {
  vsupply: Val
  vf: Val
  current: Val
  count?: number | undefined
  tolerance?: Val | undefined
  series?: ESeries | undefined
}

/**
 * Series resistor for a string of `count` LEDs: R = (Vsupply - count Vf) / If (Kirchhoff's voltage law). Each
 * candidate shows the current it actually gives, resistor and LED dissipation, and the current range over the
 * resistor tolerance. Vf varies by part and bin: use the datasheet's figure at the chosen current.
 */
export function ledResistor(a: LedArgs): Result {
  const vs = val('vsupply', a.vsupply)
  const vf = val('vf', a.vf)
  const i = val('current', a.current)
  const n = a.count ?? 1
  if (!Number.isInteger(n) || n < 1) throw new ToolError('count: a whole number of LEDs, at least 1')
  const tol = tolFrac('tolerance', a.tolerance, 0.05)
  const series = a.series ?? 'E24'
  const vr = vs - n * vf
  if (vr <= 0) throw new ToolError(`vsupply: ${n} x Vf ${vf} V leaves no headroom from ${vs} V`)
  const ideal = vr / i
  const cands = best(neighbours(ideal, series, 2).map((r) => {
    const ia = vr / r
    return {
      r_ohm: r, current_a: ia, error_pct: errPct(ia, i), p_resistor_w: ia * ia * r, p_led_w: ia * vf,
      min_current_a: vr / (r * (1 + tol)), max_current_a: vr / (r * (1 - tol)), over_target: ia > i * (1 + 1e-9),
    }
  }))
  const b = first(cands, 'led_resistor')
  return {
    ideal_r_ohm: ideal, voltage_across_r_v: vr, series, tolerance: tol, candidates: cands,
    summary: `${eng(b.r_ohm, 'Ω')} (${series}) gives ${eng(b.current_a, 'A')}, resistor dissipates ${eng(b.p_resistor_w, 'W')}`,
  }
}


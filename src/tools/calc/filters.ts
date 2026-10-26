/**
 * Filters and timing: first-order RC/RL filters, LC resonance and the second-order LC low-pass, unity-gain
 * Sallen-Key active filters, and RC charge/discharge timing including the 555 timer.
 *
 * Forward calculations take component values; design calculations take a target frequency or time and pick
 * preferred values (resistors from E24 and capacitors/inductors from E12 by default), returning the three best by
 * error, each with what it actually achieves and its spread over the component tolerances.
 */
import {
  best, corners, errPct, eng, first, fmtPct, neighbours, opt, tolFrac, ToolError, val, valuesBetween,
  type ESeries, type Out, type Result, type Val,
} from './common.js'

const TAU = 2 * Math.PI

// ------------------------------------------------------------------------------------------------- RC / RL
export interface RcFilterArgs {
  kind?: 'rc' | 'rl' | undefined
  response?: 'lowpass' | 'highpass' | undefined
  r?: Val | undefined
  c?: Val | undefined
  l?: Val | undefined
  fc?: Val | undefined
  frequency?: Val | undefined
  settle_pct?: Val | undefined
  r_series?: ESeries | undefined
  c_series?: ESeries | undefined
  tolerance_r?: Val | undefined
  tolerance_c?: Val | undefined
}

/**
 * First-order RC or RL filter (Horowitz & Hill, The Art of Electronics 3rd ed., sections 1.4.2 and 1.7.1):
 *   tau = RC or L/R, fc = 1/(2 pi tau).
 *   low-pass |H| = 1/sqrt(1 + (f/fc)^2), phase -atan(f/fc); high-pass |H| = (f/fc)/sqrt(1 + (f/fc)^2), phase
 *   90 deg - atan(f/fc).
 *   Step response: within N % of final after tau ln(100/N); 10-90 % rise time tau ln 9 = 2.197 tau.
 * Give two of r, c (or l), fc: with fc and one component the other is picked from its series.
 */
export function rcFilter(a: RcFilterArgs): Result {
  const kind = a.kind ?? 'rc'
  const resp = a.response ?? 'lowpass'
  const r = opt('r', a.r)
  const x = kind === 'rc' ? opt('c', a.c) : opt('l', a.l)
  const xName = kind === 'rc' ? 'c' : 'l'
  const xUnit = kind === 'rc' ? 'F' : 'H'
  const fcT = opt('fc', a.fc)
  const f = opt('frequency', a.frequency)
  const settle = val('settle_pct', a.settle_pct ?? 1, { max: 99.999 })
  const tr = tolFrac('tolerance_r', a.tolerance_r, 0.01)
  const tx = tolFrac('tolerance_c', a.tolerance_c, kind === 'rc' ? 0.1 : 0.2)
  const tauOf = (rv: number, xv: number) => (kind === 'rc' ? rv * xv : xv / rv)
  const fcOf = (rv: number, xv: number) => 1 / (TAU * tauOf(rv, xv))

  type RcPoint = Out & { r_ohm: number; fc_hz: number; x: number }
  const xKey = `${xName}_${xUnit.toLowerCase()}`
  const analyse = (rv: number, xv: number): RcPoint => {
    const tau = tauOf(rv, xv)
    const fc = 1 / (TAU * tau)
    const [lo, hi] = corners(fcOf, [rv, xv], [tr, tx])
    const out: RcPoint = {
      r_ohm: rv, x: xv, [xKey]: xv, fc_hz: fc, min_fc_hz: lo, max_fc_hz: hi, tau_s: tau,
      settle_pct: settle, settle_time_s: tau * Math.log(100 / settle), rise_10_90_s: tau * Math.log(9),
    }
    if (f !== undefined) {
      const u = f / fc
      const mag = resp === 'lowpass' ? 1 / Math.sqrt(1 + u * u) : u / Math.sqrt(1 + u * u)
      out.frequency_hz = f
      out.gain = mag
      out.gain_db = 20 * Math.log10(mag)
      out.attenuation_db = -20 * Math.log10(mag)
      out.phase_deg = ((resp === 'lowpass' ? -Math.atan(u) : Math.PI / 2 - Math.atan(u)) * 180) / Math.PI
    }
    return out
  }
  const given = [r, x, fcT].filter((v) => v !== undefined).length
  if (given !== 2) throw new ToolError(`rc_filter: give exactly two of r, ${xName}, fc`)
  const tail = (p: Out) =>
    p.attenuation_db !== undefined ? `, ${(p.gain_db as number).toFixed(2)} dB at ${eng(p.frequency_hz as number, 'Hz')}` : ''
  if (fcT === undefined) {
    const p = analyse(r as number, x as number)
    return { kind, response: resp, ...p, summary: `fc ${eng(p.fc_hz, 'Hz')} (tau ${eng(p.tau_s as number, 's')})${tail(p)}` }
  }
  // tau = 1/(2 pi fc); rc: tau = RC; rl: tau = L/R
  const tau = 1 / (TAU * fcT)
  const rS: ESeries = a.r_series ?? 'E24'
  const xS: ESeries = a.c_series ?? 'E12'
  const cands = best(
    r !== undefined
      ? neighbours(kind === 'rc' ? tau / r : tau * r, xS, 2).map((xv) => ({ ...analyse(r, xv), error_pct: errPct(fcOf(r, xv), fcT) }))
      : neighbours(kind === 'rc' ? tau / (x as number) : (x as number) / tau, rS, 2)
          .map((rv) => ({ ...analyse(rv, x as number), error_pct: errPct(fcOf(rv, x as number), fcT) })),
  )
  const b = first(cands, 'rc_filter')
  return {
    kind, response: resp, target_fc_hz: fcT, tau_s: tau, candidates: cands,
    summary: `R ${eng(b.r_ohm, 'Ω')}, ${xName.toUpperCase()} ${eng(b.x, xUnit)} gives fc ${eng(b.fc_hz, 'Hz')} (${fmtPct(b.error_pct)})${tail(b)}`,
  }
}

// ------------------------------------------------------------------------------------------------- LC
export interface LcFilterArgs {
  l?: Val | undefined
  c?: Val | undefined
  r_series?: Val | undefined
  fc?: Val | undefined
  load?: Val | undefined
  series?: ESeries | undefined
}

/**
 * LC resonance and the second-order LC low-pass.
 *
 * With l and c: f0 = 1/(2 pi sqrt(LC)) (Thomson), characteristic impedance Z0 = sqrt(L/C), and with a series
 * resistance R the series-resonant Q = Z0 / R (Horowitz & Hill 3rd ed. section 1.7.14).
 *
 * With fc and load: series L, shunt C across the load R, driven from a low-impedance source (a switcher or
 * amplifier output). H(s) = 1/(1 + sL/R + s^2 LC); a Butterworth response needs w0 = 2 pi fc and Q = R sqrt(C/L)
 * = 1/sqrt(2), so L = sqrt(2) R / w0 and C = 1 / (sqrt(2) R w0) (singly-terminated Butterworth, n = 2; Williams &
 * Taylor, Electronic Filter Design Handbook, 4th ed., table 11-2). Picks L and C from the series and reports the f0
 * and Q each pair actually gives.
 */
export function lcFilter(a: LcFilterArgs): Result {
  const fc = opt('fc', a.fc)
  if (fc === undefined) {
    const l = val('l', a.l)
    const c = val('c', a.c)
    const rs = opt('r_series', a.r_series)
    const f0 = 1 / (TAU * Math.sqrt(l * c))
    const z0 = Math.sqrt(l / c)
    const q = rs === undefined ? null : z0 / rs
    const out: Out = { l_h: l, c_f: c, f0_hz: f0, z0_ohm: z0, q, bandwidth_hz: q === null ? null : f0 / q }
    if (a.load !== undefined) {
      const rl = val('load', a.load)
      out.q_load = rl * Math.sqrt(c / l)
    }
    return { ...out, summary: `f0 ${eng(f0, 'Hz')}, Z0 ${eng(z0, 'Ω')}${q === null ? '' : `, Q ${q.toPrecision(3)}`}` }
  }
  const rl = val('load', a.load)
  const series = a.series ?? 'E12'
  const w0 = TAU * fc
  const lI = (Math.SQRT2 * rl) / w0
  const cI = 1 / (Math.SQRT2 * rl * w0)
  const all: (Out & { error_pct: number; q_error_pct: number; f0_hz: number; q: number; l_h: number; c_f: number })[] = []
  for (const l of neighbours(lI, series, 2)) {
    for (const c of neighbours(cI, series, 2)) {
      const f0 = 1 / (TAU * Math.sqrt(l * c))
      const q = rl * Math.sqrt(c / l)
      all.push({ l_h: l, c_f: c, f0_hz: f0, q, error_pct: errPct(f0, fc), q_error_pct: errPct(q, Math.SQRT1_2) })
    }
  }
  const cands = best(all, 3, (p) => Math.abs(p.error_pct) + 0.5 * Math.abs(p.q_error_pct))
  const b = first(cands, 'lc_filter')
  return {
    target_fc_hz: fc, load_ohm: rl, ideal_l_h: lI, ideal_c_f: cI, series, candidates: cands,
    summary: `L ${eng(b.l_h, 'H')}, C ${eng(b.c_f, 'F')} gives f0 ${eng(b.f0_hz, 'Hz')} (${fmtPct(b.error_pct)}), Q ${b.q.toPrecision(3)} (Butterworth 0.707)`,
  }
}

// ------------------------------------------------------------------------------------------------- Sallen-Key
/**
 * Normalised second-order coefficients, H(s) = 1/(1 + a1 s/wc + b1 (s/wc)^2), each normalised so that |H| = -3 dB
 * at wc (TI, Op Amps for Everyone, SLOD006B, chapter 16, table 16-4 (Bessel) and 16-5 (Butterworth)).
 */
const COEFF = { butterworth: { a1: Math.SQRT2, b1: 1 }, bessel: { a1: 1.3617, b1: 0.618 } } as const

/**
 * -3 dB frequency (Hz) of a second-order section. Low-pass: H = 1/(1 + A s + B s^2); |H|^2 = 1/2 gives
 * B^2 x^2 + (A^2 - 2B) x - 1 = 0 with x = w^2. High-pass: H = 1/(1 + A/s + B/s^2) is the same form in 1/s, so the
 * same root gives 1/w^2.
 */
function f3db(response: 'lowpass' | 'highpass', A: number, B: number): number {
  const bq = A * A - 2 * B
  const x = (-bq + Math.sqrt(bq * bq + 4 * B * B)) / (2 * B * B)
  return (response === 'lowpass' ? Math.sqrt(x) : 1 / Math.sqrt(x)) / TAU
}

export interface ActiveFilterArgs {
  response: 'lowpass' | 'highpass'
  fc: Val
  alignment?: 'butterworth' | 'bessel' | undefined
  c?: Val | undefined
  c_min?: Val | undefined
  c_max?: Val | undefined
  r_min?: Val | undefined
  r_max?: Val | undefined
  r_series?: ESeries | undefined
  c_series?: ESeries | undefined
  tolerance_r?: Val | undefined
  tolerance_c?: Val | undefined
}

/**
 * Unity-gain Sallen-Key low-pass or high-pass (TI SLOD006B, sections 16.3.1.2 and 16.4.1; TI SLOA024B, "Analysis
 * of the Sallen-Key Architecture").
 *
 * Low-pass: R1 and R2 in series from the input, C1 from their junction to the output (feedback), C2 from the
 * non-inverting input to ground. H(s) = 1/(1 + s C2 (R1 + R2) + s^2 R1 R2 C1 C2). For a target (a1, b1, fc) with
 * C1 >= C2 4 b1 / a1^2, R1,2 = (a1 C1 -/+ sqrt(a1^2 C1^2 - 4 b1 C1 C2)) / (4 pi fc C1 C2).
 *
 * High-pass: equal series capacitors C, R1 from their junction to the output, R2 from the non-inverting input to
 * ground. Derived from nodal analysis: H(s) = 1/(1 + A/s + B/s^2), A = 2/(R2 C), B = 1/(R1 R2 C^2); so
 * R2 = 1/(pi fc C a1) and R1 = a1/(4 pi fc C b1).
 *
 * Capacitors are picked from c_series (E12) over [c_min, c_max] (or the given c), resistors rounded to r_series
 * (E24) within [r_min, r_max]; candidates are ranked by -3 dB frequency error plus Q error, and each reports its
 * worst-case fc over the component tolerances.
 */
export function activeFilter(a: ActiveFilterArgs): Result {
  const fc = val('fc', a.fc)
  const align = a.alignment ?? 'butterworth'
  const { a1, b1 } = COEFF[align]
  const qT = Math.sqrt(b1) / a1
  const rS: ESeries = a.r_series ?? 'E24'
  const cS: ESeries = a.c_series ?? 'E12'
  const cFix = opt('c', a.c)
  const cLo = opt('c_min', a.c_min) ?? 100e-12
  const cHi = opt('c_max', a.c_max) ?? 1e-6
  const rLo = opt('r_min', a.r_min) ?? 1e3
  const rHi = opt('r_max', a.r_max) ?? 1e6
  if (cLo >= cHi) throw new ToolError('c_min: must be below c_max')
  if (rLo >= rHi) throw new ToolError('r_min: must be below r_max')
  const tr = tolFrac('tolerance_r', a.tolerance_r, 0.01)
  const tc = tolFrac('tolerance_c', a.tolerance_c, 0.05)
  const caps = cFix !== undefined ? [cFix] : valuesBetween(cS, cLo, cHi)
  const inR = (r: number) => r >= rLo * (1 - 1e-9) && r <= rHi * (1 + 1e-9)
  type P = Out & { r1_ohm: number; r2_ohm: number; c1_f: number; c2_f: number; fc_hz: number; q: number; error_pct: number; q_error_pct: number }
  const coef = (r1: number, r2: number, c1: number, c2: number): [number, number] =>
    a.response === 'lowpass' ? [c2 * (r1 + r2), r1 * r2 * c1 * c2] : [(c1 + c2) / (c1 * c2 * r2), 1 / (r1 * r2 * c1 * c2)]
  const fcOf = (r1: number, r2: number, c1: number, c2: number) => {
    const [A, B] = coef(r1, r2, c1, c2)
    return f3db(a.response, A, B)
  }
  const make = (r1: number, r2: number, c1: number, c2: number): P => {
    const [A, B] = coef(r1, r2, c1, c2)
    const q = Math.sqrt(B) / A
    const f = f3db(a.response, A, B)
    const [lo, hi] = corners(fcOf, [r1, r2, c1, c2], [tr, tr, tc, tc])
    return {
      r1_ohm: r1, r2_ohm: r2, c1_f: c1, c2_f: c2, fc_hz: f, f0_hz: 1 / (TAU * Math.sqrt(a.response === 'lowpass' ? B : 1 / B)),
      q, min_fc_hz: lo, max_fc_hz: hi, error_pct: errPct(f, fc), q_error_pct: errPct(q, qT),
    }
  }
  const all: P[] = []
  const wc = TAU * fc
  if (a.response === 'lowpass') {
    for (const c2 of caps) {
      const c1min = (c2 * 4 * b1) / (a1 * a1)
      for (const c1 of valuesBetween(cS, c1min, Math.max(c1min, cHi) * 10).slice(0, 4)) {
        const disc = a1 * a1 * c1 * c1 - 4 * b1 * c1 * c2
        if (disc < 0) continue
        const r1i = (a1 * c1 - Math.sqrt(disc)) / (2 * wc * c1 * c2)
        const r2i = (a1 * c1 + Math.sqrt(disc)) / (2 * wc * c1 * c2)
        for (const r1 of neighbours(r1i, rS, 1)) for (const r2 of neighbours(r2i, rS, 1)) {
          if (inR(r1) && inR(r2)) all.push(make(r1, r2, c1, c2))
        }
      }
    }
  } else {
    for (const c of caps) {
      const r2i = 2 / (wc * c * a1)
      const r1i = a1 / (2 * wc * c * b1)
      for (const r1 of neighbours(r1i, rS, 1)) for (const r2 of neighbours(r2i, rS, 1)) {
        if (inR(r1) && inR(r2)) all.push(make(r1, r2, c, c))
      }
    }
  }
  if (!all.length) throw new ToolError('active_filter: no preferred values fit the resistor and capacitor windows; widen r_min/r_max or c_min/c_max')
  const cands = best(all, 3, (p) => Math.abs(p.error_pct) + Math.abs(p.q_error_pct))
  const b = first(cands, 'active_filter')
  return {
    response: a.response, alignment: align, target_fc_hz: fc, target_q: qT, candidates: cands,
    topology: a.response === 'lowpass'
      ? 'unity-gain Sallen-Key: R1, R2 in series from input; C1 junction to output; C2 +input to ground'
      : 'unity-gain Sallen-Key: C1, C2 in series from input; R1 junction to output; R2 +input to ground',
    summary: `R1 ${eng(b.r1_ohm, 'Ω')}, R2 ${eng(b.r2_ohm, 'Ω')}, C1 ${eng(b.c1_f, 'F')}, C2 ${eng(b.c2_f, 'F')}: fc ${eng(b.fc_hz, 'Hz')} (${fmtPct(b.error_pct)}), Q ${b.q.toFixed(3)}`,
  }
}

// ------------------------------------------------------------------------------------------------- RC timing
export interface RcTimingArgs {
  mode: 'charge' | 'discharge' | 'astable555' | 'monostable555'
  r?: Val | undefined
  c?: Val | undefined
  r1?: Val | undefined
  r2?: Val | undefined
  vsupply?: Val | undefined
  v_start?: Val | undefined
  v_end?: Val | undefined
  frequency?: Val | undefined
  duty?: Val | undefined
  time?: Val | undefined
  r_series?: ESeries | undefined
  tolerance_r?: Val | undefined
  tolerance_c?: Val | undefined
}

/**
 * RC timing.
 *   charge: from v_start towards vsupply, t = RC ln((Vs - V0)/(Vs - V)); discharge: from v_start towards 0,
 *   t = RC ln(V0/V) (the exponential step response, Horowitz & Hill 3rd ed. section 1.4.2).
 *   555 astable (TI NE555 datasheet SLFS022, section 8.3): t_high = ln2 (R1 + R2) C, t_low = ln2 R2 C,
 *   f = 1/(ln2 (R1 + 2 R2) C) ~ 1.44/((R1 + 2 R2) C); duty = (R1 + R2)/(R1 + 2 R2), always above 50 %.
 *   555 monostable: t = ln3 R C ~ 1.1 R C.
 * Inverse for the 555: give c and frequency (+ duty) or time, and resistors are picked from r_series.
 */
export function rcTiming(a: RcTimingArgs): Result {
  const tr = tolFrac('tolerance_r', a.tolerance_r, 0.01)
  const tc = tolFrac('tolerance_c', a.tolerance_c, 0.1)
  const rS: ESeries = a.r_series ?? 'E24'
  if (a.mode === 'charge' || a.mode === 'discharge') {
    const r = val('r', a.r)
    const c = val('c', a.c)
    const tau = r * c
    const ve = val('v_end', a.v_end, { allowZero: false })
    let t: number
    if (a.mode === 'charge') {
      const vs = val('vsupply', a.vsupply)
      const v0 = val('v_start', a.v_start ?? 0, { allowZero: true })
      if (!(ve > v0 && ve < vs)) throw new ToolError('v_end: must lie between v_start and vsupply when charging')
      t = tau * Math.log((vs - v0) / (vs - ve))
    } else {
      const v0 = val('v_start', a.v_start)
      if (!(ve < v0)) throw new ToolError('v_end: must be below v_start when discharging')
      t = tau * Math.log(v0 / ve)
    }
    const k = t / tau
    return {
      mode: a.mode, tau_s: tau, time_s: t, time_constants: k, min_time_s: k * tau * (1 - tr) * (1 - tc),
      max_time_s: k * tau * (1 + tr) * (1 + tc), summary: `${eng(t, 's')} (${k.toFixed(3)} tau, tau ${eng(tau, 's')})`,
    }
  }
  const LN2 = Math.LN2
  if (a.mode === 'monostable555') {
    const c = val('c', a.c)
    const tOf = (r: number, cc: number) => Math.log(3) * r * cc
    const rv = opt('r', a.r)
    const pt = (r: number) => {
      const [lo, hi] = corners(tOf, [r, c], [tr, tc])
      return { r_ohm: r, c_f: c, time_s: tOf(r, c), min_time_s: lo, max_time_s: hi }
    }
    if (rv !== undefined) {
      const p = pt(rv)
      return { mode: a.mode, ...p, summary: `pulse ${eng(p.time_s, 's')} (1.1 RC)` }
    }
    const t = val('time', a.time)
    const cands = best(neighbours(t / (Math.log(3) * c), rS, 2).map((r) => ({ ...pt(r), error_pct: errPct(tOf(r, c), t) })))
    const b = first(cands, 'rc_timing')
    return { mode: a.mode, target_time_s: t, candidates: cands, summary: `R ${eng(b.r_ohm, 'Ω')} with ${eng(c, 'F')} gives ${eng(b.time_s, 's')} (${fmtPct(b.error_pct)})` }
  }
  // astable
  const c = val('c', a.c)
  const fOf = (r1: number, r2: number, cc: number) => 1 / (LN2 * (r1 + 2 * r2) * cc)
  const pt = (r1: number, r2: number) => {
    const [lo, hi] = corners(fOf, [r1, r2, c], [tr, tr, tc])
    return {
      r1_ohm: r1, r2_ohm: r2, c_f: c, frequency_hz: fOf(r1, r2, c), t_high_s: LN2 * (r1 + r2) * c, t_low_s: LN2 * r2 * c,
      duty: (r1 + r2) / (r1 + 2 * r2), min_frequency_hz: lo, max_frequency_hz: hi,
    }
  }
  const r1v = opt('r1', a.r1)
  const r2v = opt('r2', a.r2)
  if (r1v !== undefined && r2v !== undefined) {
    const p = pt(r1v, r2v)
    return { mode: a.mode, ...p, summary: `${eng(p.frequency_hz, 'Hz')}, duty ${(p.duty * 100).toFixed(1)} %` }
  }
  const f = val('frequency', a.frequency)
  const d = val('duty', a.duty ?? 0.6)
  const duty = d > 1 ? d / 100 : d
  if (!(duty > 0.5 && duty < 1)) throw new ToolError('duty: the basic 555 astable runs above 50 % and below 100 % (add a diode across R2 for less)')
  const period = 1 / f
  const r2i = ((1 - duty) * period) / (LN2 * c)
  const r1i = (duty * period) / (LN2 * c) - r2i
  const all = []
  for (const r1 of neighbours(r1i, rS, 2)) for (const r2 of neighbours(r2i, rS, 2)) {
    const p = pt(r1, r2)
    all.push({ ...p, error_pct: errPct(p.frequency_hz, f), duty_error_pct: errPct(p.duty, duty) })
  }
  const cands = best(all, 3, (p) => Math.abs(p.error_pct) + 0.5 * Math.abs(p.duty_error_pct))
  const b = first(cands, 'rc_timing')
  return {
    mode: a.mode, target_frequency_hz: f, target_duty: duty, ideal_r1_ohm: r1i, ideal_r2_ohm: r2i, candidates: cands,
    summary: `R1 ${eng(b.r1_ohm, 'Ω')}, R2 ${eng(b.r2_ohm, 'Ω')}, C ${eng(c, 'F')}: ${eng(b.frequency_hz, 'Hz')} (${fmtPct(b.error_pct)}), duty ${(b.duty * 100).toFixed(1)} %`,
  }
}

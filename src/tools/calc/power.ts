/**
 * Power and interface calculators: LDO dissipation and junction temperature, buck and boost converter sizing,
 * crystal load capacitors, I2C pull-up range, ADC resolution figures, battery life, wire gauge and dBm/W/V
 * conversions.
 *
 * Converter figures are the ideal-converter (continuous conduction) equations with an efficiency factor, as the
 * cited application notes give them: good for first sizing, to be checked against the controller's datasheet.
 */
import {
  best, errPct, eng, first, fmtPct, neighbours, opt, tolFrac, ToolError, val, rhoCu,
  type ESeries, type Out, type Result, type Val,
} from './common.js'

// ---------------------------------------------------------------------------------------------- LDO thermal
export interface LdoArgs {
  vin: Val
  vout: Val
  current: Val
  iq?: Val | undefined
  theta_ja?: Val | undefined
  theta_jc?: Val | undefined
  theta_cs?: Val | undefined
  theta_sa?: Val | undefined
  ambient?: Val | undefined
  tj_max?: Val | undefined
}

/**
 * Linear regulator: P = (Vin - Vout) Iout + Vin Iq; Tj = Ta + P theta (TI SLVA118A "Digital designer's guide to
 * linear voltage regulators and thermal management", and TI SPRA953 "Semiconductor and IC package thermal metrics"
 * on what theta-JA means). With theta_jc, the path is theta_jc + theta_cs + theta_sa (case, interface, heatsink).
 * Max ambient = Tj,max - P theta.
 */
export function ldoThermal(a: LdoArgs): Result {
  const vin = val('vin', a.vin)
  const vout = val('vout', a.vout)
  if (vout >= vin) throw new ToolError('vout: must be below vin')
  const i = val('current', a.current)
  const iq = val('iq', a.iq ?? 0, { allowZero: true })
  const ta = val('ambient', a.ambient ?? 25, { positive: false })
  const tjMax = val('tj_max', a.tj_max ?? 125, { positive: false })
  const ja = opt('theta_ja', a.theta_ja)
  const jc = opt('theta_jc', a.theta_jc)
  let theta: number
  let path: string
  if (jc !== undefined) {
    const sa = val('theta_sa', a.theta_sa)
    const cs = val('theta_cs', a.theta_cs ?? 0, { allowZero: true })
    theta = jc + cs + sa
    path = 'theta_jc + theta_cs + theta_sa'
  } else if (ja !== undefined) {
    theta = ja
    path = 'theta_ja'
  } else throw new ToolError('theta_ja: required (or theta_jc with theta_sa for a heatsink)')
  const p = (vin - vout) * i + vin * iq
  const tj = ta + p * theta
  const pMax = (tjMax - ta) / theta
  return {
    power_w: p, theta_c_per_w: theta, thermal_path: path, tj_c: tj, tj_max_c: tjMax, margin_c: tjMax - tj,
    max_ambient_c: tjMax - p * theta, max_power_at_ambient_w: pMax, max_current_at_ambient_a: (pMax - vin * iq) / (vin - vout),
    efficiency: (vout * i) / (vin * (i + iq)), ok: tj <= tjMax,
    summary: `${eng(p, 'W')} dissipated, Tj ${tj.toFixed(1)} °C at ${ta} °C ambient (${tj <= tjMax ? 'OK' : 'OVER'} ${tjMax} °C); max ambient ${(tjMax - p * theta).toFixed(1)} °C`,
  }
}

// ---------------------------------------------------------------------------------------------- buck / boost
/** Efficiency as a fraction in (0, 1]: 0.9 or 90 (a number above 1 is read as percent). */
function efficiency(x: Val | undefined, dflt: number): number {
  if (x === undefined) return dflt
  let e = val('efficiency', typeof x === 'string' ? x.replace('%', '') : x)
  if (e > 1) e /= 100
  if (!(e > 0 && e <= 1)) throw new ToolError('efficiency: a fraction in (0, 1] or a percentage up to 100')
  return e
}
export interface ConverterArgs {
  vin: Val
  vout: Val
  iout: Val
  fsw: Val
  efficiency?: Val | undefined
  ripple_ratio?: Val | undefined
  inductor?: Val | undefined
  ripple_v?: Val | undefined
  esr?: Val | undefined
  vin_max?: Val | undefined
  vin_min?: Val | undefined
  l_series?: ESeries | undefined
}

/** Preferred inductors (E6 or E12, at or above the minimum, then one below), each with its ripple and peak. */
function pickL(lMin: number, series: ESeries, rip: (l: number) => number, peak: (l: number) => number): Out[] {
  return neighbours(lMin, series, 2).map((l) => ({ l_h: l, ripple_a: rip(l), peak_a: peak(l), at_or_above_minimum: l >= lMin * (1 - 1e-9) }))
    .sort((x, y) => Number(y.at_or_above_minimum) - Number(x.at_or_above_minimum) || (x.l_h as number) - (y.l_h as number)).slice(0, 3)
}

/**
 * Buck converter (TI SLVA477B, "Basic Calculation of a Buck Converter's Power Stage"):
 *   D = Vout / (Vin eta)                                   (eq. 1)
 *   dI_L = (Vin - Vout) D / (fsw L); L = Vout (Vin - Vout)/(dI_L fsw Vin), dI_L = ripple_ratio x Iout (eq. 5, 6)
 *   I_peak = Iout + dI_L/2                                  (eq. 4)
 *   Cout,min = dI_L / (8 fsw dVout) (eq. 9), and ESR,max = dVout / dI_L (eq. 10)
 *   Input RMS current Iin,rms = Iout sqrt(D (1 - D)) (TI SLVA477B section 7 / SLTA055).
 * The inductor is sized at vin_max (largest ripple), as SLVA477B recommends.
 */
export function buck(a: ConverterArgs): Result {
  const vin = val('vin', a.vin)
  const vout = val('vout', a.vout)
  if (vout >= vin) throw new ToolError('vout: a buck needs vout below vin')
  const iout = val('iout', a.iout)
  const fsw = val('fsw', a.fsw)
  const effective = efficiency(a.efficiency, 0.9)
  const vinMax = val('vin_max', a.vin_max ?? vin)
  const rr = val('ripple_ratio', a.ripple_ratio ?? 0.3, { max: 2 })
  const d = Math.min(vout / (vin * effective), 1)
  const dI = rr * iout
  const lMin = (vout * (vinMax - vout)) / (dI * fsw * vinMax)
  // SLVA477B eq. 5 rearranged: dI_L = Vout (Vin - Vout) / (Vin fsw L) (the ideal duty Vout/Vin, as the note uses)
  const ripOf = (l: number, v = vin) => (vout * (v - vout)) / (v * fsw * l)
  const lGiven = opt('inductor', a.inductor)
  const l = lGiven ?? lMin
  const ripple = ripOf(l)
  const ripMax = ripOf(l, vinMax)
  const out: Out = {
    duty: d, inductor_min_h: lMin, inductor_h: l, ripple_a: ripple, ripple_at_vin_max_a: ripMax, peak_a: iout + ripMax / 2,
    input_rms_a: iout * Math.sqrt(d * (1 - d)), input_avg_a: (vout * iout) / (vin * effective),
    inductor_candidates: lGiven === undefined ? pickL(lMin, a.l_series ?? 'E6', (x) => ripOf(x, vinMax), (x) => iout + ripOf(x, vinMax) / 2) : null,
  }
  const dv = opt('ripple_v', a.ripple_v)
  if (dv !== undefined) {
    out.cout_min_f = ripMax / (8 * fsw * dv)
    out.esr_max_ohm = dv / ripMax
    const esr = opt('esr', a.esr)
    if (esr !== undefined) out.ripple_v_with_esr = ripMax / (8 * fsw * (out.cout_min_f as number)) + ripMax * esr
  }
  return {
    ...out,
    summary: `D ${(d * 100).toFixed(1)} %, L ≥ ${eng(lMin, 'H')} for ${(rr * 100).toFixed(0)} % ripple, peak ${eng(iout + ripMax / 2, 'A')}` +
      (out.cout_min_f !== undefined ? `, Cout ≥ ${eng(out.cout_min_f as number, 'F')} (ESR ≤ ${eng(out.esr_max_ohm as number, 'Ω')})` : '') +
      `, input RMS ${eng(out.input_rms_a as number, 'A')}`,
  }
}

/**
 * Boost converter (TI SLVA372C, "Basic Calculation of a Boost Converter's Power Stage"):
 *   D = 1 - Vin eta / Vout                                    (eq. 1)
 *   Iout,max = (ILIM - dI_L/2)(1 - D)                         (eq. 2)
 *   dI_L = Vin D / (fsw L); L = Vin (Vout - Vin)/(dI_L fsw Vout), dI_L = ripple_ratio x Iout/(1 - D)  (eq. 3, 5, 6)
 *   I_peak = Iout/(1 - D) + dI_L/2 (switch and inductor peak)
 *   Cout,min = Iout D / (fsw dVout) (eq. 9), ESR contribution dV = (Iout/(1 - D) + dI_L/2) ESR (eq. 10)
 *   Input (inductor) RMS: sqrt(Iin^2 + dI_L^2/12), Iin = Iout/(1 - D).
 * Sized at vin_min (largest switch current), as SLVA372C recommends.
 */
export function boost(a: ConverterArgs): Result {
  const vin = val('vin', a.vin)
  const vout = val('vout', a.vout)
  if (vout <= vin) throw new ToolError('vout: a boost needs vout above vin')
  const iout = val('iout', a.iout)
  const fsw = val('fsw', a.fsw)
  const eta = efficiency(a.efficiency, 0.85)
  const vinMin = val('vin_min', a.vin_min ?? vin)
  const rr = val('ripple_ratio', a.ripple_ratio ?? 0.3, { max: 2 })
  const dOf = (v: number) => Math.max(0, 1 - (v * eta) / vout)
  const d = dOf(vin)
  const dMax = dOf(vinMin)
  const iinMax = iout / (1 - dMax)
  const dI = rr * iinMax
  const lMin = (vinMin * (vout - vinMin)) / (dI * fsw * vout)
  // SLVA372C eq. 5: dI_L = Vin (Vout - Vin) / (fsw L Vout)
  const ripOf = (l: number, v = vin) => (v * (vout - v)) / (fsw * l * vout)
  const lGiven = opt('inductor', a.inductor)
  const l = lGiven ?? lMin
  const ripMax = ripOf(l, vinMin)
  const peak = iinMax + ripMax / 2
  const out: Out = {
    duty: d, duty_at_vin_min: dMax, inductor_min_h: lMin, inductor_h: l, ripple_a: ripOf(l), ripple_at_vin_min_a: ripMax,
    input_avg_a: iinMax, peak_a: peak, input_rms_a: Math.sqrt(iinMax ** 2 + ripMax ** 2 / 12),
    inductor_candidates: lGiven === undefined ? pickL(lMin, a.l_series ?? 'E6', (x) => ripOf(x, vinMin), (x) => iinMax + ripOf(x, vinMin) / 2) : null,
  }
  const dv = opt('ripple_v', a.ripple_v)
  if (dv !== undefined) {
    out.cout_min_f = (iout * dMax) / (fsw * dv)
    out.esr_max_ohm = dv / peak
    const esr = opt('esr', a.esr)
    if (esr !== undefined) out.ripple_v_with_esr = dv + peak * esr
  }
  return {
    ...out,
    summary: `D ${(d * 100).toFixed(1)} %, L ≥ ${eng(lMin, 'H')} for ${(rr * 100).toFixed(0)} % ripple, peak switch current ${eng(peak, 'A')}` +
      (out.cout_min_f !== undefined ? `, Cout ≥ ${eng(out.cout_min_f as number, 'F')}` : ''),
  }
}

// ---------------------------------------------------------------------------------------------- crystal
export interface CrystalArgs {
  cl?: Val | undefined
  c1?: Val | undefined
  c2?: Val | undefined
  stray?: Val | undefined
  frequency?: Val | undefined
  esr?: Val | undefined
  c0?: Val | undefined
  gm?: Val | undefined
  series?: ESeries | undefined
}

/**
 * Pierce oscillator load capacitors (ST AN2867, "Oscillator design guide for STM8AF/AL/S, STM32 MCUs and MPUs",
 * section 3.2): CL = C1 C2/(C1 + C2) + Cstray; with C1 = C2 = C, C = 2 (CL - Cstray). Cstray (pins and board) is
 * typically 2 to 7 pF; it must be given, not guessed.
 * Gain margin (AN2867 section 3.4): gm_crit = 4 ESR (2 pi F)^2 (C0 + CL)^2; gain margin = gm / gm_crit, which should
 * exceed 5.
 */
export function crystalCaps(a: CrystalArgs): Result {
  const stray = val('stray', a.stray, { allowZero: true })
  const c1 = opt('c1', a.c1)
  const c2 = opt('c2', a.c2)
  const out: Out = { stray_f: stray }
  let cl: number
  let summary: string
  if (c1 !== undefined || c2 !== undefined) {
    if (c1 === undefined || c2 === undefined) throw new ToolError('c1: give both c1 and c2 to compute CL')
    cl = (c1 * c2) / (c1 + c2) + stray
    out.c1_f = c1
    out.c2_f = c2
    out.cl_f = cl
    summary = `CL ${eng(cl, 'F')} from ${eng(c1, 'F')} and ${eng(c2, 'F')} with ${eng(stray, 'F')} stray`
    const want = opt('cl', a.cl)
    if (want !== undefined) { out.target_cl_f = want; out.error_pct = errPct(cl, want) }
  } else {
    cl = val('cl', a.cl)
    if (cl <= stray) throw new ToolError('stray: must be below cl')
    const ideal = 2 * (cl - stray)
    const series = a.series ?? 'E12'
    const cands = best(neighbours(ideal, series, 2).map((c) => {
      const got = c / 2 + stray
      return { c_f: c, cl_f: got, error_pct: errPct(got, cl) }
    }))
    const b = first(cands, 'crystal_caps')
    out.cl_f = cl
    out.ideal_c_f = ideal
    out.series = series
    out.candidates = cands
    summary = `C1 = C2 = ${eng(b.c_f, 'F')} (${series}) gives CL ${eng(b.cl_f, 'F')} (${fmtPct(b.error_pct)}); ideal ${eng(ideal, 'F')}`
  }
  const gm = opt('gm', a.gm)
  if (gm !== undefined) {
    const f = val('frequency', a.frequency)
    const esr = val('esr', a.esr)
    const c0 = val('c0', a.c0, { allowZero: true })
    const crit = 4 * esr * (2 * Math.PI * f) ** 2 * (c0 + cl) ** 2
    out.gm_crit_a_per_v = crit
    out.gain_margin = gm / crit
    out.gain_margin_ok = gm / crit > 5
    summary += `; gain margin ${(gm / crit).toFixed(1)} (${gm / crit > 5 ? 'OK, > 5' : 'LOW, AN2867 asks > 5'})`
  }
  return { ...out, summary }
}

// ---------------------------------------------------------------------------------------------- I2C
/**
 * I2C-bus specification and user manual, NXP UM10204 rev. 7.0 (2021): table 10 (characteristics of SDA/SCL), section
 * 7.1 (pull-up resistor sizing, equations 1 and 2).
 *   Rp,min = (VDD - VOL,max) / IOL; Rp,max = tr / (0.8473 Cb).
 *   standard: tr 1000 ns, Cb 400 pF, VOL 0.4 V at IOL 3 mA; fast: 300 ns, 400 pF, 3 mA; fast-plus: 120 ns, 550 pF,
 *   20 mA. The 0.8473 is ln(0.7/0.3): rise from 0.3 VDD to 0.7 VDD.
 */
const I2C = {
  standard: { tr: 1000e-9, cb: 400e-12, iol: 3e-3, f: 100e3 },
  fast: { tr: 300e-9, cb: 400e-12, iol: 3e-3, f: 400e3 },
  fast_plus: { tr: 120e-9, cb: 550e-12, iol: 20e-3, f: 1e6 },
} as const

export interface I2cArgs {
  vdd: Val
  capacitance: Val
  mode?: keyof typeof I2C | undefined
  vol?: Val | undefined
  iol?: Val | undefined
  rise_time?: Val | undefined
  series?: ESeries | undefined
}

export function i2cPullup(a: I2cArgs): Result {
  const mode = a.mode ?? 'fast'
  const spec = I2C[mode]
  const vdd = val('vdd', a.vdd)
  const cb = val('capacitance', a.capacitance)
  const vol = val('vol', a.vol ?? (vdd > 2 ? 0.4 : 0.2 * vdd))
  const iol = val('iol', a.iol ?? spec.iol)
  const tr = val('rise_time', a.rise_time ?? spec.tr)
  if (tr > spec.tr) throw new ToolError(`rise_time: ${mode} mode allows at most ${eng(spec.tr, 's')} (UM10204 table 10)`)
  const rMin = (vdd - vol) / iol
  const rMax = tr / (0.8473 * cb)
  const series = a.series ?? 'E24'
  const out: Out = {
    mode, vdd_v: vdd, capacitance_f: cb, capacitance_limit_f: spec.cb, over_capacitance: cb > spec.cb, rp_min_ohm: rMin,
    rp_max_ohm: rMax, rise_time_limit_s: tr, feasible: rMin <= rMax,
  }
  if (rMin > rMax) {
    return { ...out, candidates: [], summary: `no pull-up works: Rp,min ${eng(rMin, 'Ω')} exceeds Rp,max ${eng(rMax, 'Ω')}; cut bus capacitance or use a current-source pull-up` }
  }
  // candidates: preferred values within [rMin, rMax], favouring the geometric middle
  const vals = neighbours(Math.sqrt(rMin * rMax), series, 4).filter((r) => r >= rMin && r <= rMax)
  const cands = vals.map((r) => ({
    rp_ohm: r, rise_time_s: 0.8473 * r * cb, sink_current_a: (vdd - vol) / r, error_pct: 100 * Math.log(r / Math.sqrt(rMin * rMax)),
  }))
  const picks = best(cands)
  out.candidates = picks
  const b = picks[0]
  return {
    ...out,
    summary: `Rp ${eng(rMin, 'Ω')} to ${eng(rMax, 'Ω')} (${mode})` + (b ? `; ${eng(b.rp_ohm, 'Ω')} gives tr ${eng(b.rise_time_s, 's')}` : ''),
  }
}

// ---------------------------------------------------------------------------------------------- ADC
export interface AdcArgs {
  bits?: number | undefined
  vref: Val
  snr_db?: Val | undefined
  sinad_db?: Val | undefined
  resolution?: Val | undefined
  bipolar?: boolean | undefined
}

/**
 * ADC figures (Analog Devices MT-001 "Taking the mystery out of the infamous formula SNR = 6.02N + 1.76 dB" and
 * MT-003 "Understand SINAD, ENOB, SNR, THD..."):
 *   LSB = FSR / 2^N; quantisation noise q/sqrt(12) rms; ideal SNR = 6.02 N + 1.76 dB;
 *   ENOB = (SINAD - 1.76)/6.02; bits for a resolution r: ceil(log2(FSR / r)).
 * FSR is vref (unipolar) or 2 vref (bipolar).
 */
export function adc(a: AdcArgs): Result {
  const vref = val('vref', a.vref)
  const fsr = a.bipolar ? 2 * vref : vref
  const out: Out = { vref_v: vref, full_scale_v: fsr }
  const parts: string[] = []
  if (a.bits !== undefined) {
    if (!Number.isInteger(a.bits) || a.bits < 1 || a.bits > 32) throw new ToolError('bits: a whole number from 1 to 32')
    const lsb = fsr / 2 ** a.bits
    out.bits = a.bits
    out.lsb_v = lsb
    out.quantisation_noise_v_rms = lsb / Math.sqrt(12)
    out.ideal_snr_db = 6.02 * a.bits + 1.76
    parts.push(`${a.bits} bits: LSB ${eng(lsb, 'V')}, ideal SNR ${(6.02 * a.bits + 1.76).toFixed(2)} dB`)
  }
  const sn = opt('sinad_db', a.sinad_db) ?? opt('snr_db', a.snr_db)
  if (sn !== undefined) {
    const enob = (sn - 1.76) / 6.02
    out.enob = enob
    out.effective_lsb_v = fsr / 2 ** enob
    parts.push(`ENOB ${enob.toFixed(2)} from ${sn} dB`)
  }
  const res = opt('resolution', a.resolution)
  if (res !== undefined) {
    const n = Math.ceil(Math.log2(fsr / res) - 1e-12)
    out.resolution_v = res
    out.bits_required = n
    parts.push(`${n} bits resolve ${eng(res, 'V')}`)
  }
  if (!parts.length) throw new ToolError('adc: give bits, snr_db/sinad_db or resolution')
  return { ...out, summary: parts.join('; ') }
}

// ---------------------------------------------------------------------------------------------- power
export interface Phase { current: Val; duration: Val }
export interface PowerArgs {
  mode: 'battery' | 'awg' | 'convert'
  capacity?: Val | undefined
  profile?: Phase[] | undefined
  derating?: Val | undefined
  self_discharge_per_month?: Val | undefined
  awg?: number | undefined
  length?: Val | undefined
  current?: Val | undefined
  temperature?: Val | undefined
  dbm?: Val | undefined
  watts?: Val | undefined
  volts_rms?: Val | undefined
  impedance?: Val | undefined
}

/**
 * Ampacity of a single insulated copper conductor in free air, for 60 C / 75 C / 90 C insulation, at 30 C ambient
 * (NFPA 70, National Electrical Code 2023, table 310.17; AWG 18 and 16 are listed for 90 C insulation only). Gauges
 * outside the table get no ampacity: it depends on insulation, bundling and allowed rise, and is not guessed.
 */
const NEC_FREE_AIR: Readonly<Record<number, readonly [number | null, number | null, number]>> = {
  18: [null, null, 18], 16: [null, null, 24], 14: [25, 30, 35], 12: [30, 35, 40], 10: [40, 50, 55], 8: [60, 70, 80],
  6: [80, 95, 105], 4: [105, 125, 140], 3: [120, 145, 165], 2: [140, 170, 190], 1: [165, 195, 220],
  0: [195, 230, 260], [-1]: [225, 265, 300], [-2]: [260, 310, 350], [-3]: [300, 360, 405],
}

/** Diameter of AWG n (ASTM B258: d = 0.127 mm x 92^((36 - n)/39)); 0 = 1/0, -1 = 2/0, ... */
export const awgDiameter = (n: number): number => 0.127e-3 * 92 ** ((36 - n) / 39)

/**
 * battery: life = derated capacity / average current, average = sum(I t)/sum(t) over the duty cycle profile; the
 * self-discharge (fraction of capacity per month) adds an equivalent current C x rate / 730 h.
 * awg: diameter (ASTM B258), area, resistance per metre at temperature (IEC 60028 resistivity), ampacity (NEC table
 * 310.17, free air) where the table lists the gauge, and with length and current the drop and loss.
 * convert: P = 1 mW x 10^(dBm/10); V_rms = sqrt(P R) (default 50 ohm).
 */
export function power(a: PowerArgs): Result {
  if (a.mode === 'battery') {
    const cap = val('capacity', a.capacity)
    const prof = a.profile
    if (!prof || !prof.length) throw new ToolError('profile: a list of {current (A), duration (s)} phases is required')
    let q = 0
    let t = 0
    prof.forEach((p, i) => {
      const c = val(`profile[${i}].current`, p.current, { allowZero: true })
      const d = val(`profile[${i}].duration`, p.duration)
      q += c * d
      t += d
    })
    const avg = q / t
    const der = tolFrac('derating', a.derating, 0)
    const sd = val('self_discharge_per_month', a.self_discharge_per_month ?? 0, { allowZero: true })
    const usable = cap * (1 - der)            // capacity in A h
    const sdCurrent = (cap * (sd > 1 ? sd / 100 : sd)) / 730
    const total = avg + sdCurrent
    if (total <= 0) throw new ToolError('profile: the average current is zero; battery life is unbounded')
    const hours = usable / total
    return {
      capacity_ah: cap, usable_capacity_ah: usable, average_current_a: avg, self_discharge_equiv_a: sdCurrent, period_s: t,
      life_h: hours, life_days: hours / 24,
      summary: `average ${eng(avg, 'A')}: ${hours.toFixed(1)} h (${(hours / 24).toFixed(1)} days) from ${eng(usable, 'Ah')} usable`,
    }
  }
  if (a.mode === 'awg') {
    const n = a.awg
    if (n === undefined || !Number.isInteger(n) || n < -3 || n > 40) throw new ToolError('awg: a whole gauge from 40 to -3 (0 = 1/0, -1 = 2/0, -2 = 3/0, -3 = 4/0)')
    const d = awgDiameter(n)
    const area = (Math.PI / 4) * d * d
    const temp = val('temperature', a.temperature ?? 20, { positive: false })
    const rpm = rhoCu(temp) / area
    const nec = NEC_FREE_AIR[n]
    const out: Out = {
      awg: n, diameter_m: d, area_m2: area, area_mm2: area * 1e6, resistance_per_m_ohm: rpm, temperature_c: temp,
      ampacity_60c_a: nec?.[0] ?? null, ampacity_75c_a: nec?.[1] ?? null, ampacity_90c_a: nec?.[2] ?? null,
      ampacity_source: nec ? 'NEC 2023 table 310.17 (single conductor, free air, 30 °C ambient)' : null,
    }
    const len = opt('length', a.length)
    const i = opt('current', a.current)
    let tail = ''
    if (len !== undefined) {
      out.resistance_ohm = rpm * len
      tail = `, ${eng(rpm * len, 'Ω')} over ${eng(len, 'm')}`
      if (i !== undefined) { out.voltage_drop_v = rpm * len * i; out.power_w = i * i * rpm * len; tail += ` (drop ${eng(rpm * len * i, 'V')})` }
    }
    return { ...out, summary: `AWG ${n}: ${(d * 1e3).toFixed(3)} mm, ${(area * 1e6).toFixed(3)} mm², ${eng(rpm, 'Ω')}/m${tail}` }
  }
  const z = val('impedance', a.impedance ?? 50)
  const given = [a.dbm, a.watts, a.volts_rms].filter((x) => x !== undefined).length
  if (given !== 1) throw new ToolError('power: give exactly one of dbm, watts, volts_rms')
  let w: number
  if (a.dbm !== undefined) w = 1e-3 * 10 ** (val('dbm', a.dbm, { positive: false }) / 10)
  else if (a.watts !== undefined) w = val('watts', a.watts)
  else w = val('volts_rms', a.volts_rms) ** 2 / z
  const dbm = 10 * Math.log10(w / 1e-3)
  const v = Math.sqrt(w * z)
  return {
    watts: w, dbm, dbw: dbm - 30, volts_rms: v, volts_peak: v * Math.SQRT2, volts_pp: 2 * v * Math.SQRT2, impedance_ohm: z,
    dbuv: 20 * Math.log10(v / 1e-6),
    summary: `${dbm.toFixed(2)} dBm = ${eng(w, 'W')} = ${eng(v, 'V')} rms into ${eng(z, 'Ω')}`,
  }
}

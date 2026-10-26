/**
 * Every calculator against worked examples from its cited source or values worked by hand (the working is in each
 * comment), E-series picks, forward/inverse round trips, tolerance spreads and input validation.
 */
import { describe, expect, it } from 'vitest'
import { divider, ledResistor, opampGain, regulatorFeedback } from '../../src/calc/circuits.js'
import { neighbours, tolFrac, val } from '../../src/calc/common.js'
import { activeFilter, lcFilter, rcFilter, rcTiming } from '../../src/calc/filters.js'
import {
  asymStriplineIPC, diffMicrostrip, embeddedIPC, impedance, ipc2221Area, ipc2221Current, microstripHJ, microstripIPC,
  striplineIPC, traceWidth, via,
} from '../../src/calc/pcb.js'
import { adc, awgDiameter, boost, buck, crystalCaps, i2cPullup, ldoThermal, power } from '../../src/calc/power.js'
import { striplineExact } from '../../src/calc/fieldsolve.js'
import { tools } from '../../src/calc/tools.js'
import { Registry, ToolError } from '../../src/core/registry.js'
import { preferred, type ESeries } from '../../src/core/units.js'

const ctx = { hardware: false, via: 'test' } as const
const close = (got: unknown, want: number, rel = 1e-3) => {
  expect(typeof got).toBe('number')
  expect(Math.abs((got as number) / want - 1)).toBeLessThan(rel)
}
type Cand = Record<string, number | boolean>
const cands = (r: Record<string, unknown>): Cand[] => r.candidates as Cand[]
const top = (r: Record<string, unknown>): Cand => {
  const c = cands(r)[0]
  if (!c) throw new Error('no candidate')
  return c
}
/** A value is in the series if its mantissa is one of the decade's values. */
const inSeries = (x: number, s: ESeries) => {
  const m = x / 10 ** Math.floor(Math.log10(x) + 1e-9)
  return preferred(s).some((v) => Math.abs(v - m) < 1e-6)
}

describe('registry wiring', () => {
  it('registers all eighteen tools by their exact names', () => {
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'calc.active_filter', 'calc.adc', 'calc.boost', 'calc.buck', 'calc.crystal_caps', 'calc.divider', 'calc.i2c_pullup',
      'calc.impedance', 'calc.lc_filter', 'calc.ldo_thermal', 'calc.led_resistor', 'calc.opamp_gain', 'calc.power',
      'calc.rc_filter', 'calc.rc_timing', 'calc.regulator_feedback', 'calc.trace_width', 'calc.via',
    ])
    for (const t of tools) expect(Registry.jsonSchema(t).type).toBe('object')
  })

  it('accepts component strings and returns a summary through the registry', async () => {
    const reg = new Registry(tools)
    const r = (await reg.call('calc.divider', { vin: '5V', r1: '4k7', r2: '4k7' }, ctx)) as Record<string, unknown>
    close(r.vout_v, 2.5)
    expect(r.summary).toMatch(/2\.5 V/)
    await expect(reg.call('calc.divider', { vin: 5, r1: 'banana', r2: 1 }, ctx)).rejects.toThrow(/r1: not a number/)
    await expect(reg.call('calc.divider', { vin: -5, r1: 1, r2: 1 }, ctx)).rejects.toThrow(/vin: must be positive/)
    await expect(reg.call('calc.divider', { vin: 5, r1: 1, r2: 1, bogus: 1 }, ctx)).rejects.toThrow(ToolError)
  })
})

describe('common helpers', () => {
  it('reads values and tolerances and names the argument on error', () => {
    expect(val('r', '4k7')).toBe(4700)
    expect(val('c', '100nF')).toBeCloseTo(1e-7, 20)
    expect(() => val('r', Number.POSITIVE_INFINITY)).toThrow(/r:/)
    expect(() => val('r', 0)).toThrow(/r: must be positive/)
    expect(tolFrac('t', '1%', 0)).toBeCloseTo(0.01)
    expect(tolFrac('t', 5, 0)).toBeCloseTo(0.05)
    expect(tolFrac('t', 0.02, 0)).toBeCloseTo(0.02)
    expect(() => tolFrac('t', '60%', 0)).toThrow(/under 50/)
  })
  it('lists preferred neighbours either side', () => {
    expect(neighbours(5000, 'E24', 2)).toEqual([4300, 4700, 5100, 5600])
    expect(neighbours(4700, 'E12', 1)).toEqual([4700])
  })
})

describe('calc.divider', () => {
  it('forward, with load and tolerance corners', () => {
    // 10 V, 10k/10k, 0.1 mA load: 5 V - 0.1 mA x 5 kΩ = 4.5 V
    const r = divider({ vin: 10, r1: '10k', r2: '10k', load_current: '100u' })
    close(r.vout_v, 4.5)
    close(r.r_thevenin_ohm, 5000)
    // unloaded, 1 %: min 10 x 9.9/(10.1 + 9.9) = 4.95, max 5.05
    const u = divider({ vin: 10, r1: '10k', r2: '10k', tolerance: '1%' })
    close(u.min_vout_v, 4.95)
    close(u.max_vout_v, 5.05)
    close(u.i_r1_a, 5e-4)
    close(u.p_r1_w, 2.5e-3)
  })
  it('solves with one resistor fixed and round-trips', () => {
    const r = divider({ vin: 12, vout: 3.3, r2: '10k' })
    close(r.ideal_r1_ohm, (10e3 * 8.7) / 3.3)
    for (const c of cands(r)) {
      expect(inSeries(c.r1_ohm as number, 'E24')).toBe(true)
      expect(c.r2_ohm).toBe(10e3)
      const fwd = divider({ vin: 12, r1: c.r1_ohm as number, r2: c.r2_ohm as number })
      close(fwd.vout_v, c.vout_v as number, 1e-12)
    }
    const errs = cands(r).map((c) => Math.abs(c.error_pct as number))
    expect(errs).toEqual([...errs].sort((a, b) => a - b))
    expect(cands(r)).toHaveLength(3)
  })
  it('both resistors move and land closer than a fixed one', () => {
    const fixed = divider({ vin: 12, vout: 3.3, r2: '10k' })
    const both = divider({ vin: 12, vout: 3.3 })
    expect(both.mode).toBe('both resistors move')
    expect(Math.abs(top(both).error_pct as number)).toBeLessThan(Math.abs(top(fixed).error_pct as number))
    expect(Math.abs(top(both).error_pct as number)).toBeLessThan(0.1)
    for (const c of cands(both)) {
      expect(c.r1_ohm).toBeGreaterThanOrEqual(1e3)
      expect(c.r2_ohm).toBeLessThanOrEqual(1e6)
    }
  })
  it('solves for a total-current budget', () => {
    // 5 V to 2.5 V at 100 uA: R1 = 25 k ideal, R2 = 25 k
    const r = divider({ vin: 5, vout: 2.5, total_current: '100u' })
    close(r.ideal_r1_ohm, 25e3)
    close(r.ideal_r2_ohm, 25e3)
  })
  it('validates', () => {
    expect(() => divider({ vin: 5, vout: 6, r2: 1e3 })).toThrow(/below vin/)
    expect(() => divider({ vin: 5, r1: 1e3 })).toThrow(ToolError)
    expect(() => divider({ vin: 5, vout: 2, r1: 1e3, r2: 1e3 })).toThrow(/at most one/)
  })
})

describe('calc.regulator_feedback', () => {
  it('LM317 worked example (SLVS044 eq. 1): 240 Ω / 720 Ω, Iadj 50 uA', () => {
    // 1.25 (1 + 720/240) + 50 uA x 720 = 5.036 V
    const r = regulatorFeedback({ vref: 1.25, r_top: 240, r_bottom: 720, topology: 'adjust', bias_current: '50u' })
    close(r.vout_v, 5.036)
  })
  it('feedback topology with FB bias current', () => {
    // 0.8 (1 + 30k/10k) + 100 nA x 30k = 3.2 + 0.003
    const r = regulatorFeedback({ vref: 0.8, r_top: '30k', r_bottom: '10k', bias_current: '100n' })
    close(r.vout_v, 3.203)
  })
  it('both move: 0.8 V to 3.3 V exactly (75k / 24k in E24)', () => {
    const r = regulatorFeedback({ vref: 0.8, vout: 3.3 })
    expect(Math.abs(top(r).error_pct as number)).toBeLessThan(1e-9)
    const t = top(r)
    expect((t.r_top_ohm as number) / (t.r_bottom_ohm as number)).toBeCloseTo(2.5 / 0.8, 9)
  })
  it('one fixed, and the worst case includes Vref tolerance', () => {
    const r = regulatorFeedback({ vref: 0.8, vout: 3.3, r_bottom: '10k', vref_tolerance: '1%', tolerance: '1%' })
    expect(top(r).r_bottom_ohm).toBe(10e3)
    close(r.ideal_r_top_ohm, 31250)
    const t = top(r)
    expect((t.max_vout_v as number) / (t.vout_v as number) - 1).toBeGreaterThan(0.015)
  })
  it('validates', () => {
    expect(() => regulatorFeedback({ vref: 1.25, vout: 1 })).toThrow(/exceed vref/)
  })
})

describe('calc.opamp_gain', () => {
  it('forward with GBW (SLOD006B): inverting 10k/1k is -10, noise gain 11', () => {
    const r = opampGain({ config: 'inverting', rf: '10k', rg: '1k', gbw: '1M' })
    expect(r.gain).toBeCloseTo(-10, 12)
    close(r.bandwidth_hz, 1e6 / 11)
    close(r.gain_db, 20)
  })
  it('solves both ways', () => {
    const n = opampGain({ config: 'noninverting', gain: 11, rg: '1k' })
    expect(top(n).rf_ohm).toBe(10e3)
    const both = opampGain({ config: 'noninverting', gain: 4.3 })
    expect(Math.abs(top(both).error_pct as number)).toBeLessThan(0.5)
    expect(() => opampGain({ config: 'noninverting', gain: 1 })).toThrow(/exceed 1/)
  })
})

describe('calc.led_resistor', () => {
  it('5 V, 2 V, 20 mA: 150 Ω exactly, 60 mW', () => {
    const r = ledResistor({ vsupply: 5, vf: 2, current: '20m' })
    expect(top(r).r_ohm).toBe(150)
    close(top(r).p_resistor_w as number, 0.06)
    close(top(r).p_led_w as number, 0.04)
  })
  it('a string of three, and no headroom', () => {
    // 12 V - 3 x 3.1 V = 2.7 V; at 15 mA: 180 Ω
    const r = ledResistor({ vsupply: 12, vf: 3.1, current: '15m', count: 3 })
    expect(top(r).r_ohm).toBe(180)
    expect(() => ledResistor({ vsupply: 5, vf: 3, current: 0.01, count: 2 })).toThrow(/headroom/)
  })
})

describe('calc.rc_filter', () => {
  it('1k / 100n: fc 1.5915 kHz; -20.04 dB a decade up; -3.01 dB, 45 deg at fc', () => {
    const r = rcFilter({ r: '1k', c: '100n', frequency: 15915.494 })
    close(r.fc_hz, 1591.5494)
    close(r.attenuation_db, 20.0432)
    const h = rcFilter({ r: '1k', c: '100n', response: 'highpass', frequency: 1591.5494 })
    close(h.gain_db, -3.0103)
    close(h.phase_deg, 45)
    // settle to 1 %: tau ln 100 = 4.605 tau; 10-90 % = 2.197 tau
    close(r.settle_time_s, 1e-4 * Math.log(100))
    close(r.rise_10_90_s, 1e-4 * Math.log(9))
  })
  it('RL and design inverse', () => {
    // L/R: 10 mH / 100 Ω = 100 us
    close(rcFilter({ kind: 'rl', r: 100, l: '10m' }).tau_s, 1e-4)
    const d = rcFilter({ fc: '1k', c: '10n' })
    expect(top(d).r_ohm).toBe(16e3)
    expect(Math.abs(top(d).error_pct as number)).toBeLessThan(1)
    expect(top(d).max_fc_hz).toBeGreaterThan(top(d).fc_hz as number)
    expect(() => rcFilter({ r: 1 })).toThrow(/exactly two/)
  })
})

describe('calc.lc_filter', () => {
  it('resonance, Z0 and Q', () => {
    // 10 uH, 100 nF: f0 = 1/(2 pi sqrt(1e-12)) = 159.15 kHz, Z0 = 10 Ω, Q = 10/0.5 = 20
    const r = lcFilter({ l: '10u', c: '100n', r_series: 0.5 })
    close(r.f0_hz, 159154.94)
    close(r.z0_ohm, 10)
    close(r.q, 20)
  })
  it('Butterworth low-pass into 8 Ω at 10 kHz: L = sqrt2 R/w0, C = 1/(sqrt2 R w0)', () => {
    const r = lcFilter({ fc: '10k', load: 8 })
    close(r.ideal_l_h, (Math.SQRT2 * 8) / (2 * Math.PI * 1e4))
    close(r.ideal_c_f, 1 / (Math.SQRT2 * 8 * 2 * Math.PI * 1e4))
    for (const c of cands(r)) expect(inSeries(c.l_h as number, 'E12') && inSeries(c.c_f as number, 'E12')).toBe(true)
  })
})

describe('calc.active_filter', () => {
  /** |H(j w)| of the returned components, written out from the Sallen-Key transfer functions. */
  function gainAt(r: Cand, response: 'lowpass' | 'highpass', f: number): number {
    const w = 2 * Math.PI * f
    const [r1, r2, c1, c2] = [r.r1_ohm, r.r2_ohm, r.c1_f, r.c2_f] as number[] as [number, number, number, number]
    if (response === 'lowpass') {
      const re = 1 - w * w * r1 * r2 * c1 * c2
      const im = w * c2 * (r1 + r2)
      return 1 / Math.hypot(re, im)
    }
    const A = (c1 + c2) / (c1 * c2 * r2)
    const B = 1 / (r1 * r2 * c1 * c2)
    return 1 / Math.hypot(1 - B / (w * w), -A / w)
  }
  it('Butterworth low-pass at 1 kHz: -3 dB at fc, Q 0.707', () => {
    const r = activeFilter({ response: 'lowpass', fc: '1k' })
    const t = top(r)
    expect(Math.abs(t.error_pct as number)).toBeLessThan(2)
    expect(Math.abs((t.q as number) - Math.SQRT1_2)).toBeLessThan(0.02)
    expect(gainAt(t, 'lowpass', t.fc_hz as number)).toBeCloseTo(Math.SQRT1_2, 6)
    expect(inSeries(t.r1_ohm as number, 'E24') && inSeries(t.c1_f as number, 'E12')).toBe(true)
    expect(t.min_fc_hz).toBeLessThan(t.fc_hz as number)
  })
  it('Bessel high-pass at 100 Hz: -3 dB at fc, Q 0.577 (SLOD006B table 16-4)', () => {
    const r = activeFilter({ response: 'highpass', fc: 100, alignment: 'bessel' })
    const t = top(r)
    expect(Math.abs(t.error_pct as number)).toBeLessThan(2)
    expect(Math.abs((t.q as number) - Math.sqrt(0.618) / 1.3617)).toBeLessThan(0.02)
    expect(gainAt(t, 'highpass', t.fc_hz as number)).toBeCloseTo(Math.SQRT1_2, 6)
    expect(t.c1_f).toBe(t.c2_f)
  })
  it('refuses windows nothing fits', () => {
    expect(() => activeFilter({ response: 'lowpass', fc: '1M', r_min: '100k', r_max: '1M', c_min: '100n', c_max: '1u' })).toThrow(/widen/)
  })
})

describe('calc.trace_width (IPC-2221B 6.2)', () => {
  it('1 A, 10 °C rise, 1 oz external: about 11.8 mil; internal about 30.7 mil', () => {
    // A = (1/(0.048 x 10^0.44))^(1/0.725) = 16.3 mil^2; / 1.378 mil = 11.83 mil
    const e = traceWidth({ current: 1, temp_rise: 10, layer: 'external' })
    close(e.width_mil, 11.83, 3e-3)
    const i = traceWidth({ current: 1, temp_rise: 10, layer: 'internal' })
    close(i.width_mil, 30.77, 3e-3)
  })
  it('round-trips and reports resistance at copper temperature', () => {
    close(ipc2221Current(ipc2221Area(3, 20, false), 20, false), 3, 1e-12)
    const w = traceWidth({ current: 2, temp_rise: 20, layer: 'external', copper_oz: 2 })
    const back = traceWidth({ width: w.width_m as number, temp_rise: 20, layer: 'external', copper_oz: 2 })
    close(back.current_a, 2, 1e-9)
    // 0.3 mm x 35 um at 35 °C, 100 mm: rho(35) = 1.724e-8 x 1.05895; R = rho L / A
    const l = traceWidth({ width: '0.3m', temp_rise: 10, layer: 'external', length: 0.1 })
    close(l.resistance_ohm, (1.724e-8 * (1 + 0.00393 * 15) * 0.1) / (0.3e-3 * 35e-6))
    close(l.voltage_drop_v, (l.resistance_ohm as number) * (l.current_a as number))
    expect(() => traceWidth({ temp_rise: 10, layer: 'external' })).toThrow(/exactly one/)
  })
})

describe('calc.via', () => {
  it('inductance: Johnson & Graham example, 0.063 in board, 0.016 in hole, about 1.2 nH', () => {
    const r = via({ drill: 0.016 * 0.0254, length: 0.063 * 0.0254 })
    close(r.inductance_johnson_h, 5.08e-9 * 0.063 * (Math.log((4 * 0.063) / 0.016) + 1))
    expect(r.inductance_johnson_h as number).toBeGreaterThan(1.15e-9)
    expect(r.inductance_johnson_h as number).toBeLessThan(1.25e-9)
    // Goldfarb-Pucel, the closed form evaluated independently: h = 1.6002 mm, r = 0.2032 mm
    const h = 0.063 * 0.0254, rr = 0.008 * 0.0254, q = Math.hypot(rr, h)
    close(r.inductance_goldfarb_pucel_h, 2e-7 * (h * Math.log((h + q) / rr) + 1.5 * (rr - q)))
    // it is known to come out well below Johnson's rule of thumb (about 0.45 nH against 1.2 nH here)
    expect(r.inductance_goldfarb_pucel_h as number).toBeGreaterThan(0.4e-9)
    expect(r.inductance_goldfarb_pucel_h as number).toBeLessThan(0.5e-9)
  })
  it('capacitance: Johnson & Graham 0.028 in pad, 0.050 in antipad, er 4.4: 0.50 pF', () => {
    const r = via({ drill: 0.016 * 0.0254, length: 0.063 * 0.0254, pad: 0.028 * 0.0254, antipad: 0.05 * 0.0254, er: 4.4 })
    close(r.capacitance_f, (1.41 * 4.4 * 0.063 * 0.028) / 0.022 * 1e-12)
  })
  it('current, resistance and vias needed for 0.3 mm drill, 20 um plating, 1.6 mm', () => {
    // barrel area pi/4 (0.34^2 - 0.3^2) mm^2 = 0.020106 mm^2 = 31.16 mil^2; internal k: 0.80 A at 10 °C rise
    const r = via({ drill: '0.3m', length: '1.6m', current: 2 })
    close(r.barrel_area_m2, 2.0106e-8)
    close(r.max_current_a, 0.024 * 10 ** 0.44 * 31.165 ** 0.725, 2e-3)
    close(r.resistance_ohm, (1.724e-8 * (1 + 0.00393 * 15) * 1.6e-3) / 2.0106e-8)
    expect(r.vias_needed).toBe(3)
    expect(() => via({ drill: 1e-4, length: 1e-3, pad: 2e-4, antipad: 1e-4 })).toThrow(/antipad/)
  })
})

describe('calc.impedance closed forms', () => {
  it('Hammerstad-Jensen: thickness lowers Z0, t = 0 is the zero-thickness form', () => {
    const [z0] = microstripHJ(0.3e-3, 0.17e-3, 0, 4.3)
    const [zt, ee] = microstripHJ(0.3e-3, 0.17e-3, 35e-6, 4.3)
    expect(zt).toBeLessThan(z0)
    expect(ee).toBeGreaterThan(1)
    expect(ee).toBeLessThan(4.3)
    // w/h = 1 on er 9.8 (alumina): about 48.5 Ω in Hammerstad-Jensen's paper and Pozar's examples (eq. 3.197)
    const [za] = microstripHJ(1, 1, 0, 9.8)
    expect(za).toBeGreaterThan(47.5)
    expect(za).toBeLessThan(49.5)
  })
  it('IPC-2141A forms, worked by hand', () => {
    // microstrip: 87/sqrt(5.71) ln(1.0166/0.275) = 47.60 Ω
    close(microstripIPC(0.3e-3, 0.17e-3, 35e-6, 4.3), 47.60, 2e-3)
    // stripline: 60/sqrt(4.2) ln(2.4/(0.67 pi 0.195)) = 51.70 Ω
    close(striplineIPC(0.2e-3, 0.6e-3, 35e-6, 4.2), 51.70, 2e-3)
    // embedded: er' = 4.3 (1 - exp(-1.55 x 0.25/0.17)); Z0 = 60/sqrt(er') ln(1.0166/0.275)
    const [ze, ere] = embeddedIPC(0.3e-3, 0.17e-3, 35e-6, 4.3, 0.25e-3)
    close(ere, 4.3 * (1 - Math.exp((-1.55 * 0.25) / 0.17)))
    close(ze, (60 / Math.sqrt(ere)) * Math.log(1.0166 / 0.275), 2e-3)
    // asymmetric with h1 = h2 reduces to 80/sqrt(er) ln(1.9 (2h + t)/(0.8w + t)) x 0.75
    close(asymStriplineIPC(0.15e-3, 0.2e-3, 0.2e-3, 35e-6, 4.2), (80 / Math.sqrt(4.2)) * Math.log((1.9 * 0.435) / 0.155) * 0.75)
    expect(diffMicrostrip(50, 20, 1)).toBeCloseTo(100, 3)
    close(diffMicrostrip(50, 0.15e-3, 0.1e-3), 100 * (1 - 0.48 * Math.exp(-1.44)))
  })
  it('thin symmetric stripline tracks Cohn within 5 %', () => {
    const z = striplineIPC(0.2e-3, 0.6e-3, 1e-6, 4.2)
    expect(Math.abs(z / striplineExact(0.2e-3, 0.6e-3, 4.2) - 1)).toBeLessThan(0.05)
  })
  it('solves width by bisection and round-trips', () => {
    const s = impedance({ structure: 'microstrip', target_z0: 50, height: '0.17m', er: 4.3 })
    close(s.z0_ohm, 50, 1e-4)
    const f = impedance({ structure: 'microstrip', width: s.width_m as number, height: '0.17m', er: 4.3 })
    close(f.z0_ohm, 50, 1e-4)
    const d = impedance({ structure: 'stripline', differential: true, target_z0: 100, gap: '0.2m', height: '0.5m', er: 4.2 })
    close(d.zdiff_ohm, 100, 1e-4)
    expect(() => impedance({ structure: 'microstrip', target_z0: 500, height: '0.1m', er: 4 })).toThrow(/outside/)
  })
  it('requires what each structure needs', () => {
    expect(() => impedance({ structure: 'asymmetric_stripline', width: 1e-4, height: 1e-4, er: 4 })).toThrow(/height2/)
    expect(() => impedance({ structure: 'embedded_microstrip', width: 1e-4, height: 1e-4, er: 4 })).toThrow(/cover/)
    expect(() => impedance({ structure: 'microstrip', differential: true, width: 1e-4, height: 1e-4, er: 4 })).toThrow(/gap/)
    expect(() => impedance({ structure: 'microstrip', width: 1e-4, height: 1e-4, er: 4, mask_thickness: 1e-5 })).toThrow(/fieldsolve/)
  })
})

describe('calc.impedance fieldsolve', () => {
  it('agrees with the closed form for a pair, and solder mask lowers Zdiff', () => {
    const geo = { structure: 'microstrip' as const, differential: true, width: '0.15m', gap: '0.15m', height: '0.1m', er: 4.2, grid: '5u' }
    const cf = impedance({ ...geo, grid: undefined })
    const fs = impedance({ ...geo, mode: 'fieldsolve' })
    expect(Math.abs((fs.zdiff_ohm as number) / (cf.zdiff_ohm as number) - 1)).toBeLessThan(0.06)
    expect(fs.zeven_ohm as number).toBeGreaterThan(fs.zodd_ohm as number)
    const masked = impedance({ ...geo, mode: 'fieldsolve', mask_thickness: '15u', mask_er: 3.8 })
    expect(masked.zdiff_ohm as number).toBeLessThan(fs.zdiff_ohm as number)
  })
  it('solves width for a target on a coarse grid', () => {
    const r = impedance({ structure: 'stripline', target_z0: 50, height: '0.4m', thickness: '0.5u', er: 4, mode: 'fieldsolve', grid: '10u' })
    close(r.z0_ohm, 50, 5e-3)
  })
})

describe('calc.ldo_thermal', () => {
  it('5 V to 3.3 V at 0.5 A, 60 °C/W: 0.85 W, Tj 76 °C, max ambient 74 °C', () => {
    const r = ldoThermal({ vin: 5, vout: 3.3, current: 0.5, theta_ja: 60 })
    close(r.power_w, 0.85)
    close(r.tj_c, 76)
    close(r.max_ambient_c, 74)
    expect(r.ok).toBe(true)
  })
  it('quiescent current and a heatsink path', () => {
    // (12 - 5) x 1 + 12 x 5 mA = 7.06 W through 2 + 0.5 + 8 °C/W = 10.5: Tj = 40 + 74.13
    const r = ldoThermal({ vin: 12, vout: 5, current: 1, iq: '5m', theta_jc: 2, theta_cs: 0.5, theta_sa: 8, ambient: 40 })
    close(r.power_w, 7.06)
    close(r.tj_c, 40 + 7.06 * 10.5)
    expect(() => ldoThermal({ vin: 5, vout: 3.3, current: 1 })).toThrow(/theta_ja/)
  })
})

describe('calc.buck (TI SLVA477B)', () => {
  it('12 V to 3.3 V, 2 A, 500 kHz, 30 % ripple, 10 mV', () => {
    // D = 3.3/(12 x 0.9) = 0.3056; L = 3.3 x 8.7/(0.6 x 500k x 12) = 7.975 uH; Cout = 0.6/(8 x 500k x 10m) = 15 uF;
    // ESR <= 10m/0.6 = 16.7 mΩ; Iin,rms = 2 sqrt(D (1 - D)) = 0.921 A
    const r = buck({ vin: 12, vout: 3.3, iout: 2, fsw: '500k', ripple_v: '10m' })
    close(r.duty, 3.3 / 10.8)
    close(r.inductor_min_h, 7.975e-6)
    close(r.peak_a, 2.3)
    close(r.cout_min_f, 15e-6)
    close(r.esr_max_ohm, 0.01 / 0.6)
    close(r.input_rms_a, 2 * Math.sqrt((3.3 / 10.8) * (1 - 3.3 / 10.8)))
    const l = (r.inductor_candidates as Cand[])[0]
    expect(l?.at_or_above_minimum).toBe(true)
    expect(l?.l_h).toBe(10e-6)
    expect(() => buck({ vin: 3, vout: 5, iout: 1, fsw: 1e6 })).toThrow(/below vin/)
  })
})

describe('calc.boost (TI SLVA372C)', () => {
  it('3.3 V to 12 V, 0.5 A, 1 MHz, 85 %', () => {
    // D = 1 - 3.3 x 0.85/12 = 0.76625; Iin = 0.5/(1 - D) = 2.139 A; dI = 0.3 Iin = 0.6417 A;
    // L = 3.3 x 8.7/(0.6417 x 1M x 12) = 3.728 uH; Cout = 0.5 x 0.76625/(1M x 50m) = 7.66 uF
    const r = boost({ vin: 3.3, vout: 12, iout: 0.5, fsw: '1M', ripple_v: '50m' })
    close(r.duty, 0.76625)
    close(r.input_avg_a, 0.5 / 0.23375)
    close(r.inductor_min_h, 3.728e-6, 2e-3)
    close(r.cout_min_f, 7.6625e-6)
    close(r.peak_a, 0.5 / 0.23375 + (0.3 * 0.5) / 0.23375 / 2)
    expect(() => boost({ vin: 12, vout: 5, iout: 1, fsw: 1e6 })).toThrow(/above vin/)
  })
})

describe('calc.crystal_caps (ST AN2867)', () => {
  it('CL 12 pF with 5 pF stray: C = 2 (12 - 5) = 14 pF, 15 pF nearest in E12', () => {
    const r = crystalCaps({ cl: '12p', stray: '5p' })
    close(r.ideal_c_f, 14e-12)
    expect(top(r).c_f).toBe(15e-12)
    close(top(r).cl_f as number, 12.5e-12)
  })
  it('CL from caps, and the gain margin', () => {
    close(crystalCaps({ c1: '22p', c2: '22p', stray: '3p' }).cl_f, 14e-12)
    // gm_crit = 4 x 80 x (2 pi 8M)^2 x (7p + 12p)^2 = 2.919e-4 A/V; 5 mA/V gives margin 17.1
    const g = crystalCaps({ cl: '12p', stray: '5p', frequency: '8M', esr: 80, c0: '7p', gm: '5m' })
    close(g.gm_crit_a_per_v, 4 * 80 * (2 * Math.PI * 8e6) ** 2 * (19e-12) ** 2)
    close(g.gain_margin, 5e-3 / (4 * 80 * (2 * Math.PI * 8e6) ** 2 * (19e-12) ** 2))
    expect(g.gain_margin_ok).toBe(true)
    expect(() => crystalCaps({ cl: '12p' })).toThrow(/stray/)
  })
})

describe('calc.i2c_pullup (NXP UM10204)', () => {
  it('standard mode at the 400 pF limit: Rp,max = 1000 ns/(0.8473 x 400 pF) = 2.95 kΩ', () => {
    const r = i2cPullup({ vdd: 3.3, capacitance: '400p', mode: 'standard' })
    close(r.rp_max_ohm, 1e-6 / (0.8473 * 400e-12))
    close(r.rp_min_ohm, 2.9 / 3e-3)
  })
  it('fast mode at 200 pF and fast-plus at 550 pF', () => {
    const f = i2cPullup({ vdd: 3.3, capacitance: '200p' })
    close(f.rp_max_ohm, 1770.3, 1e-3)
    for (const c of cands(f)) {
      expect(c.rp_ohm).toBeGreaterThanOrEqual(f.rp_min_ohm as number)
      expect(c.rp_ohm).toBeLessThanOrEqual(f.rp_max_ohm as number)
      expect(inSeries(c.rp_ohm as number, 'E24')).toBe(true)
    }
    const p = i2cPullup({ vdd: 5, capacitance: '550p', mode: 'fast_plus' })
    close(p.rp_min_ohm, 4.6 / 0.02)
    close(p.rp_max_ohm, 120e-9 / (0.8473 * 550e-12))
  })
  it('reports when no resistor works', () => {
    const r = i2cPullup({ vdd: 5, capacitance: '400p', mode: 'fast_plus', iol: '3m' })
    expect(r.feasible).toBe(false)
    expect(() => i2cPullup({ vdd: 3.3, capacitance: '100p', rise_time: '2u' })).toThrow(/at most/)
  })
})

describe('calc.adc (ADI MT-001, MT-003)', () => {
  it('12 bits on 3.3 V; ENOB from 70 dB; bits for 1 mV', () => {
    const r = adc({ bits: 12, vref: 3.3, sinad_db: 70, resolution: '1m' })
    close(r.lsb_v, 3.3 / 4096)
    close(r.ideal_snr_db, 74)
    close(r.enob, (70 - 1.76) / 6.02)
    expect(r.bits_required).toBe(12)
    close(r.quantisation_noise_v_rms, 3.3 / 4096 / Math.sqrt(12))
    close(adc({ bits: 16, vref: 2.5, bipolar: true }).lsb_v, 5 / 65536)
    expect(() => adc({ vref: 3.3 })).toThrow(/give bits/)
  })
})

describe('calc.rc_timing', () => {
  it('charging to 1 - 1/e of the supply takes one time constant', () => {
    const r = rcTiming({ mode: 'charge', r: '10k', c: '1u', vsupply: 5, v_end: 5 * (1 - Math.exp(-1)) })
    close(r.time_s, 0.01)
    const d = rcTiming({ mode: 'discharge', r: '10k', c: '1u', v_start: 5, v_end: 5 * Math.exp(-2) })
    close(d.time_s, 0.02)
    expect(() => rcTiming({ mode: 'charge', r: 1, c: 1, vsupply: 5, v_end: 6 })).toThrow(/between/)
  })
  it('555 (TI SLFS022): astable and monostable', () => {
    // R1 1k, R2 10k, C 100n: f = 1/(ln2 x 21k x 100n) = 687 Hz; duty 11/21
    const a = rcTiming({ mode: 'astable555', r1: '1k', r2: '10k', c: '100n' })
    close(a.frequency_hz, 1 / (Math.LN2 * 21e3 * 100e-9))
    close(a.duty, 11 / 21)
    // monostable 10k, 10n: 1.0986 x 100 us
    close(rcTiming({ mode: 'monostable555', r: '10k', c: '10n' }).time_s, Math.log(3) * 1e-4)
    const inv = rcTiming({ mode: 'astable555', c: '10n', frequency: '1k', duty: 0.6 })
    expect(Math.abs(top(inv).error_pct as number)).toBeLessThan(2)
    const fwd = rcTiming({ mode: 'astable555', r1: top(inv).r1_ohm as number, r2: top(inv).r2_ohm as number, c: '10n' })
    close(fwd.frequency_hz, top(inv).frequency_hz as number, 1e-12)
    expect(() => rcTiming({ mode: 'astable555', c: '10n', frequency: '1k', duty: 0.4 })).toThrow(/above 50/)
  })
})

describe('calc.power', () => {
  it('battery life from a duty-cycled profile', () => {
    // (20 mA x 1 s + 10 uA x 59 s)/60 s = 343.2 uA; 2.2 Ah/343.2 uA = 6411 h
    const r = power({ mode: 'battery', capacity: 2.2, profile: [{ current: '20m', duration: 1 }, { current: '10u', duration: 59 }] })
    close(r.average_current_a, 0.02059 / 60)
    close(r.life_h, 2.2 / (0.02059 / 60))
    const d = power({ mode: 'battery', capacity: 2.2, derating: '20%', profile: [{ current: '1m', duration: 1 }] })
    close(d.life_h, 1760)
    expect(() => power({ mode: 'battery', capacity: 1 })).toThrow(/profile/)
  })
  it('AWG (ASTM B258) and NEC ampacity', () => {
    close(awgDiameter(24), 0.5106e-3, 1e-3)
    close(awgDiameter(10), 2.588e-3, 1e-3)
    const r = power({ mode: 'awg', awg: 24, length: 1, current: 1 })
    close(r.resistance_per_m_ohm, 0.0842, 3e-3)   // 84.2 Ω/km for AWG 24 at 20 °C
    expect(r.ampacity_90c_a).toBeNull()
    const w = power({ mode: 'awg', awg: 12 })
    expect(w.ampacity_75c_a).toBe(35)
    expect(() => power({ mode: 'awg', awg: 50 })).toThrow(/gauge/)
  })
  it('dBm, W and V', () => {
    close(power({ mode: 'convert', dbm: 0 }).volts_rms, Math.sqrt(1e-3 * 50))
    close(power({ mode: 'convert', watts: 1 }).dbm, 30)
    close(power({ mode: 'convert', volts_rms: 1, impedance: 600 }).dbm, 10 * Math.log10(1 / 600 / 1e-3))
    expect(() => power({ mode: 'convert', dbm: 0, watts: 1 })).toThrow(/exactly one/)
  })
})

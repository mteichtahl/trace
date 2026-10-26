import { describe, expect, it } from 'vitest'

import { decimate, evaluate, type MeasureSpec, unwrap } from '../../../src/tools/sim/measure.js'

const range = (n: number, dt: number): number[] => Array.from({ length: n }, (_, k) => k * dt)
const lookup = (vs: Record<string, number[]>) => (n: string) => vs[n.toLowerCase()]

describe('measurements on synthetic vectors', () => {
  const tau = 1e-3
  const t = range(5001, 2e-6) // 10 ms
  const step = t.map((x) => 1 - Math.exp(-x / tau))
  const get = lookup({ 'v(out)': step })
  const run = (specs: MeasureSpec[]) => evaluate(specs, t, get, 'time')

  it('peak, final, value_at, average', () => {
    const [pk, fin, at, avg] = run([
      { kind: 'peak', vector: 'v(out)' },
      { kind: 'final', vector: 'v(out)' },
      { kind: 'value_at', vector: 'v(out)', at: tau },
      { kind: 'average', vector: 'v(out)', from: 9e-3, to: 10e-3 },
    ])
    expect(pk?.value).toBeCloseTo(1 - Math.exp(-10), 6)
    expect(fin?.unit).toBe('V')
    expect(at?.value).toBeCloseTo(1 - Math.exp(-1), 5)
    expect(avg?.value).toBeGreaterThan(0.9999)
  })

  it('10-90 rise time of a first-order step is ln(9)·tau', () => {
    const [rt] = run([{ kind: 'rise_time', vector: 'v(out)' }])
    expect(rt?.value).toBeCloseTo(Math.log(9) * tau, 5)
    expect(rt?.unit).toBe('s')
  })

  it('cross: interpolated, nth, missing reported not guessed', () => {
    const [c1, c2] = run([
      { kind: 'cross', vector: 'v(out)', level: 0.5 },
      { kind: 'cross', vector: 'v(out)', level: 0.5, nth: 2 },
    ])
    expect(c1?.value).toBeCloseTo(Math.log(2) * tau, 6)
    expect(c2?.value).toBeNull()
    expect(c2?.error).toMatch(/1 time/)
  })

  it('settling time to 2 % of a first-order step is ~ln(50)·tau', () => {
    const [s] = run([{ kind: 'settling', vector: 'v(out)', band: 0.02 }])
    // the band is around the final value at 10 ms, not 1: within half a percent of ln(50)·tau
    expect(s?.value).toBeGreaterThan(Math.log(50) * tau * 0.99)
    expect(s?.value).toBeLessThan(Math.log(50) * tau * 1.01)
  })

  it('overshoot of an underdamped second-order step', () => {
    const zeta = 0.2
    const wn = 2 * Math.PI * 1000
    const wd = wn * Math.sqrt(1 - zeta ** 2)
    const y = t.map((x) => 1 - Math.exp(-zeta * wn * x) * (Math.cos(wd * x) + (zeta / Math.sqrt(1 - zeta ** 2)) * Math.sin(wd * x)))
    const [os] = evaluate([{ kind: 'overshoot', vector: 'y' }], t, lookup({ y }), 'time')
    const expected = 100 * Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta ** 2))
    expect(os?.value).toBeCloseTo(expected, 1)
  })

  it('frequency, duty, rms, time_above, integral of a sine and a PWM', () => {
    const f = 1000
    const s = t.map((x) => Math.sin(2 * Math.PI * f * x))
    const pwm = t.map((x) => ((x * f) % 1 < 0.25 ? 1 : 0))
    const [fr, rms, ta, du, integ] = evaluate([
      { kind: 'frequency', vector: 's', level: 0 },
      { kind: 'rms', vector: 's' },
      { kind: 'time_above', vector: 'pwm', level: 0.5 },
      { kind: 'duty', vector: 'pwm' },
      { kind: 'integral', vector: 'pwm' },
    ], t, lookup({ s, pwm }), 'time')
    expect(fr?.value).toBeCloseTo(1000, 0)
    expect(fr?.cycles).toBeGreaterThanOrEqual(8)
    expect(rms?.value).toBeCloseTo(1 / Math.SQRT2, 3)
    expect(ta?.value).toBeCloseTo(2.5e-3, 4)
    expect(du?.value).toBeCloseTo(0.25, 2)
    expect(integ?.value).toBeCloseTo(2.5e-3, 4)
  })

  it('bandwidth, phase margin and gain margin from AC data', () => {
    // a three-pole loop: L(s) = K / (1 + s/p)^3 with p = 1 kHz, K = 4
    const fr = Array.from({ length: 401 }, (_, k) => 10 ** (1 + (5 * k) / 400))
    const K = 4
    const db: number[] = []
    const ph: number[] = []
    for (const f of fr) {
      const w = f / 1000
      db.push(20 * Math.log10(K) - 30 * Math.log10(1 + w * w))
      ph.push(-3 * (Math.atan(w) * 180) / Math.PI)
    }
    const wrapped = ph.map((p) => ((p + 180) % 360 + 360) % 360 - 180)
    const [bw, pm, gm] = evaluate([
      { kind: 'bandwidth', vector: 'v(o)' },
      { kind: 'phase_margin', vector: 'v(o)' },
      { kind: 'gain_margin', vector: 'v(o)' },
    ], fr, lookup({ 'v(o)#db': db, 'v(o)#phase': wrapped }), 'frequency')
    // -3 dB of (1+w²)^-1.5: w² = 2^(1/3) - 1
    expect(bw?.value).toBeCloseTo(1000 * Math.sqrt(2 ** (1 / 3) - 1), -1)
    // gain crossover: 4 = (1+w²)^1.5 → w = sqrt(4^(2/3) - 1)
    const wc = Math.sqrt(4 ** (2 / 3) - 1)
    expect(pm?.value).toBeCloseTo(180 - 3 * (Math.atan(wc) * 180) / Math.PI, 0)
    // phase crossover at w = tan(60°) = √3: |L| = 4 / 8 → gain margin 6.02 dB
    expect(gm?.value).toBeCloseTo(20 * Math.log10(2), 1)
    expect(gm?.at).toBeCloseTo(1000 * Math.sqrt(3), -1)
  })

  it('reports problems as errors, not numbers', () => {
    const [a, b, c] = run([
      { kind: 'peak', vector: 'v(nope)' },
      { kind: 'value_at', vector: 'v(out)', at: 1 },
      { kind: 'bandwidth', vector: 'v(out)' },
    ])
    expect(a?.value).toBeNull()
    expect(a?.error).toMatch(/no vector/)
    expect(b?.error).toMatch(/outside the data/)
    expect(c?.error).toMatch(/needs AC data/)
  })

  it('unwrap and decimate', () => {
    expect(unwrap([170, -170, -150])).toEqual([170, 190, 210])
    const x = range(10_000, 1)
    const y = x.map((v) => (v === 5000 ? 100 : Math.sin(v / 100)))
    const [dx, [dy]] = decimate(x, [y], 500)
    expect(dx.length).toBeLessThanOrEqual(500)
    expect(Math.max(...(dy ?? []))).toBe(100) // the spike survives
    expect(dx[dx.length - 1]).toBe(9999)
  })
})

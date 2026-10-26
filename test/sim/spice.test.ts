import { describe, expect, it } from 'vitest'

import { allTools } from '../../src/tools.js'
import { buildDeck, ngspice, parseRaw, splitNetlist } from '../../src/sim/spice.js'
import { draw, montecarlo, rng, scaleComponent, stats } from '../../src/sim/sweep.js'

// Canned ngspice 42 output (ASCII raw): an AC analysis of an RC low-pass, three variables, complex.
const AC_RAW = `Title: rc test
Date: Mon Oct 26 06:18:45  2026
Plotname: AC Analysis
Flags: complex
No. Variables: 3
No. Points: 3
Variables:
\t0\tfrequency\tfrequency grid=3
\t1\tv(out)\tvoltage
\t2\ti(v1)\tcurrent
Values:
 0\t1.000000000000000e+01,0.000000000000000e+00
\t9.960676810368635e-01,-6.258477809769107e-02
\t-3.932318963136613e-06,-6.258477809769108e-05

 1\t1.000000000000000e+02,0.000000000000000e+00
\t7.169567998935228e-01,-4.504772424727052e-01
\t-2.830432001064773e-04,-4.504772424727052e-04

 2\t1.000000000000000e+03,0.000000000000000e+00
\t2.470452306442096e-02,-1.552230961240130e-01
\t-9.752954769355791e-04,-1.552230961240130e-04
`

const OP_RAW = `Title: q
Date: Mon Oct 26 06:35:50  2026
Plotname: Operating Point
Flags: real
No. Variables: 3
No. Points: 1
Variables:
\t0\tv(in)\tvoltage
\t1\tv(out)\tvoltage
\t2\ti(v1)\tcurrent
Values:
 0\t1.000000000000000e+00
\t5.000000000000000e-01
\t-5.000000000000000e-04
`

describe('ngspice raw files', () => {
  it('parses complex AC data into magnitude, dB and phase', () => {
    const [p] = parseRaw(AC_RAW)
    expect(p?.kind).toBe('ac')
    expect(p?.complex).toBe(true)
    expect(p?.points).toBe(3)
    expect(p?.vectors.get('frequency')).toEqual([10, 100, 1000])
    const mag = p?.vectors.get('v(out)') ?? []
    expect(mag[1]).toBeCloseTo(Math.hypot(0.7169567998935228, -0.4504772424727052), 12)
    const db = p?.vectors.get('v(out)#db') ?? []
    expect(db[2]).toBeCloseTo(20 * Math.log10(Math.hypot(0.02470452306442096, -0.155223096124013)), 9)
    const ph = p?.vectors.get('v(out)#phase') ?? []
    expect(ph[1]).toBeCloseTo((Math.atan2(-0.4504772424727052, 0.7169567998935228) * 180) / Math.PI, 9)
  })

  it('parses an operating point and several plots in one file', () => {
    const plots = parseRaw(`${OP_RAW}${AC_RAW}`)
    expect(plots.map((p) => p.kind)).toEqual(['op', 'ac'])
    expect(plots[0]?.scale).toBeNull()
    expect(plots[0]?.vectors.get('v(out)')).toEqual([0.5])
    expect(plots[0]?.vectors.get('i(v1)')).toEqual([-5e-4])
  })

  it('builds a deck: analyses from the netlist, .end and .control handled, params appended', () => {
    const s = splitNetlist('rc\nR1 in out {rv}\n.tran 1u 1m\n.end\n')
    expect(s.analyses).toEqual(['.tran 1u 1m'])
    const d = buildDeck({ netlist: 'rc\nR1 in out {rv}\nC1 out 0 1u\n.tran 1u 1m\n.end', params: { rv: '2k' }, noConfigModels: true })
    expect(d.deck).toMatch(/\.param rv=2k\n/)
    expect(d.deck).toMatch(/\.control\nset filetype=ascii[\s\S]*\ntran 1u 1m\nwrite r0\.raw all/)
    expect(d.deck.trimEnd().endsWith('.end')).toBe(true)
    expect(() => buildDeck({ netlist: 'rc\nR1 a 0 1k\n', params: { nope: 1 }, analyses: ['.op'], noConfigModels: true })).toThrow(/does not appear/)
    expect(() => buildDeck({ netlist: 'rc\nR1 a 0 1k\n', noConfigModels: true })).toThrow(/no analysis/)
  })

  it('scales components for Monte Carlo', () => {
    const n = 'x\nR1 a b 4k7\nC1 b 0 {cval}\nL1 b c l=10u\n'
    expect(scaleComponent(n, 'R1', 1.1)).toMatch(/R1 a b 5170\n/)
    expect(scaleComponent(n, 'c1', 0.9)).toMatch(/C1 b 0 \{\(cval\)\*0\.9\}/)
    expect(scaleComponent(n, 'L1', 2)).toMatch(/L1 b c l=0\.00002/)
    expect(() => scaleComponent(n, 'R9', 1)).toThrow(/no component R9/)
  })

  it('draws a reproducible, bounded gaussian', () => {
    const a = rng(42)
    const b = rng(42)
    const xs = Array.from({ length: 20_000 }, () => draw({ tol: 0.03 }, a))
    expect(draw({ tol: 0.03 }, b)).toBe(xs[0])
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1))
    expect(mean).toBeCloseTo(1, 3)
    expect(sd).toBeGreaterThan(0.0097)
    expect(sd).toBeLessThan(0.0102) // sigma = tol/3, a little less after clipping at ±3σ
    expect(Math.max(...xs)).toBeLessThanOrEqual(1.03)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0.97)
  })

  it('statistics over points', () => {
    const st = stats([
      { index: 1, label: 'a', params: {}, measurements: [{ name: 'v', kind: 'peak', value: 1, unit: 'V' }] },
      { index: 2, label: 'b', params: {}, measurements: [{ name: 'v', kind: 'peak', value: 3, unit: 'V' }] },
      { index: 3, label: 'c', params: {}, measurements: [{ name: 'v', kind: 'peak', value: null, unit: '', error: 'x' }] },
    ])
    expect(st[0]).toMatchObject({ name: 'v', n: 2, failed: 1, min: 1, max: 3, mean: 2, min_run: 1, max_run: 2 })
    expect(st[0]?.sigma).toBeCloseTo(Math.SQRT2, 12)
  })
})

const HAS_NGSPICE = ngspice() !== null
const ctx = { hardware: false, via: 'test' } as const

const RC = `rc low-pass
V1 in 0 DC 0 AC 1 PULSE(0 1 0 1n 1n 1 2)
R1 in out {rv}
C1 out 0 100n
.param rv=1k
`

describe.skipIf(!HAS_NGSPICE)('ngspice', () => {
  const reg = allTools()

  it('RC low-pass: transient rise time and AC -3 dB at 1/(2πRC)', async () => {
    const r = (await reg.call('sim.spice', {
      netlist: RC,
      analyses: ['.tran 1u 2m', '.ac dec 200 10 1meg'],
      measurements: [
        { name: 'trise', kind: 'rise_time', vector: 'v(out)', analysis: 'tran' },
        { name: 'vfinal', kind: 'final', vector: 'v(out)', analysis: 'tran' },
        { name: 'f3db', kind: 'bandwidth', vector: 'v(out)' },
      ],
      vectors: ['v(out)'],
    }, ctx)) as { run_id: string; measurements: { name: string; value: number }[]; analyses: { analysis: string; data?: Record<string, number[]> }[] }
    const m = Object.fromEntries(r.measurements.map((x) => [x.name, x.value]))
    const tau = 1e3 * 100e-9
    const fc = 1 / (2 * Math.PI * tau)
    expect(Math.abs((m.f3db as number) - fc) / fc).toBeLessThan(0.02)
    expect(Math.abs((m.trise as number) - Math.log(9) * tau) / (Math.log(9) * tau)).toBeLessThan(0.02)
    expect(m.vfinal).toBeGreaterThan(0.999)
    expect(r.run_id).toMatch(/^[0-9a-f]{16}$/)
    const tran = r.analyses.find((a) => a.analysis === 'tran')
    expect((tran?.data?.time ?? []).length).toBeLessThanOrEqual(500)
    // the run is recorded and can be re-measured
    const again = (await reg.call('sim.measure', { run_id: r.run_id, measurements: [{ name: 'f3db', kind: 'bandwidth', vector: 'v(out)' }] }, ctx)) as { measurements: { value: number }[] }
    expect(again.measurements[0]?.value).toBeCloseTo(m.f3db as number, 6)
  })

  it('diode and BJT operating point', async () => {
    const r = (await reg.call('sim.spice', {
      netlist: `bias
V1 vcc 0 DC 5
R1 vcc a 1k
D1 a 0 dmod
.model dmod d(is=1e-14 n=1)
RB vcc b 430k
RC vcc c 1k
Q1 c b 0 qmod
.model qmod npn(bf=100 is=1e-15)
`,
      analyses: ['.op'],
      measurements: [{ name: 'vd', kind: 'final', vector: 'v(a)' }, { name: 'vc', kind: 'final', vector: 'c' }],
    }, ctx)) as { measurements: { name: string; value: number }[]; analyses: { voltages?: Record<string, number> }[] }
    const m = Object.fromEntries(r.measurements.map((x) => [x.name, x.value]))
    // diode at ~4.3 mA: n·Vt·ln(I/Is) ≈ 0.026·ln(4.3e-3/1e-14) ≈ 0.69 V
    expect(m.vd).toBeGreaterThan(0.65)
    expect(m.vd).toBeLessThan(0.73)
    // IB ≈ (5 - 0.7)/430k = 10 µA → IC ≈ 1 mA → VC ≈ 4 V
    expect(m.vc).toBeGreaterThan(3.8)
    expect(m.vc).toBeLessThan(4.2)
    expect(r.analyses[0]?.voltages?.['v(b)']).toBeGreaterThan(0.6)
  })

  it('noise gives a spectral density and an integrated total', async () => {
    const r = (await reg.call('sim.spice', {
      netlist: 'n\nV1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n',
      analyses: ['.noise v(out) V1 dec 10 10 100k'],
      measurements: [{ name: 'en', kind: 'value_at', vector: 'onoise_spectrum', at: 10 }],
    }, ctx)) as { measurements: { value: number }[]; analyses: { analysis: string }[] }
    expect(r.analyses.map((a) => a.analysis)).toEqual(['noise', 'noise_total'])
    // 1 kΩ at 27 °C: sqrt(4kTR) = 4.07 nV/√Hz, well below the corner
    expect(r.measurements[0]?.value).toBeCloseTo(4.07e-9, 10)
  })

  it('a broken netlist fails with the first error line, and the log is stored', async () => {
    await expect(reg.call('sim.spice', { netlist: 'bad\nR1 a 0 1k\nX1 a 0 nosuch\n', analyses: ['.op'] }, ctx)).rejects.toThrow(/unknown subckt/i)
  })

  it('sweep and corners run each point and summarise', async () => {
    const r = (await reg.call('sim.sweep', {
      netlist: RC, analyses: ['.ac dec 50 10 1meg'],
      measurements: [{ name: 'f3db', kind: 'bandwidth', vector: 'v(out)' }],
      axes: [{ param: 'rv', values: ['1k', '2k', '4k'] }],
    }, ctx)) as { points: number; rows: { label: string; f3db: number }[] }
    expect(r.points).toBe(3)
    const f = r.rows.map((x) => x.f3db)
    expect((f[0] as number) / (f[1] as number)).toBeCloseTo(2, 1)
    expect((f[1] as number) / (f[2] as number)).toBeCloseTo(2, 1)
    const c = (await reg.call('sim.sweep', {
      netlist: RC, analyses: ['.op'], measurements: [{ name: 't', kind: 'final', vector: 'v(out)' }],
      corners: { cold: { temp: -40 }, hot: { temp: 85, rv: '2k' } },
    }, ctx)) as { rows: { label: string }[] }
    expect(c.rows.map((x) => x.label)).toEqual(['cold', 'hot'])
  })

  it('Monte Carlo with a fixed seed is reproducible and its spread matches the tolerance', async () => {
    const args = {
      netlist: 'div\nV1 in 0 DC 10\nR1 in out 10k\nR2 out 0 10k\n',
      analyses: ['.op'],
      measurements: [{ name: 'vout', kind: 'final', vector: 'v(out)' }],
      tolerances: [{ ref: 'R1', tol: 0.03 }, { ref: 'R2', tol: 0.03 }],
      runs: 60, seed: 7,
    }
    const a = (await reg.call('sim.montecarlo', args, ctx)) as { stats: { name: string; nominal: number; mean: number; sigma: number; min: number; max: number }[]; worst: Record<string, unknown> }
    const b = (await reg.call('sim.montecarlo', args, ctx)) as typeof a
    expect(a.stats).toEqual(b.stats)
    const s = a.stats[0]
    expect(s?.nominal).toBeCloseTo(5, 9)
    expect(s?.mean).toBeCloseTo(5, 1)
    // vout = 10·R2/(R1+R2): sigma ≈ 10/4 · sqrt(2) · 0.01 = 0.0354
    expect(s?.sigma).toBeGreaterThan(0.025)
    expect(s?.sigma).toBeLessThan(0.045)
    expect(s?.min).toBeGreaterThan(5 * (1 - 0.03 * 2))
    expect(a.worst.vout).toBeDefined()
  })

  it('montecarlo function: the same factors drive the same results', async () => {
    const base = { netlist: 'div\nV1 in 0 DC 10\nR1 in out 10k\nR2 out 0 {r2}\n.param r2=10k\n', analyses: ['.op'], noConfigModels: true }
    const r = await montecarlo(base, [{ param: 'r2', tol: 0.1, dist: 'uniform' }], 5, 3, { specs: [{ name: 'v', kind: 'final', vector: 'v(out)' }], concurrency: 2 })
    for (const p of r.runs) {
      const f = p.params.r2 as number
      expect(p.measurements[0]?.value).toBeCloseTo((10 * f) / (1 + f), 6)
    }
  })
})

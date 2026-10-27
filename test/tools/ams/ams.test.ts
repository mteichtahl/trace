import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { allTools } from '../../../src/tools/index.js'
import { ngspice } from '../../../src/tools/sim/spice.js'
import { applyLibCorner, libSections, supplyValues } from '../../../src/tools/ams/corners.js'
import { contiguousRange, loopMetrics, slewRate } from '../../../src/tools/ams/opamp.js'
import { integratePsd, noiseDevices } from '../../../src/tools/ams/noise.js'
import { judge } from '../../../src/tools/ams/spec.js'
import { merge } from '../../../src/core/dbmerge.js'
import { openProject } from '../../../src/core/store.js'
import { normalQuantile, pearson, wilson } from '../../../src/tools/ams/yield.js'
import { parseModelHeader, planInputs, shimDir, verilator, vlData, wrapper } from '../../../src/tools/ams/mixed.js'
import { crossingLogX, unwrapDeg } from '../../../src/tools/ams/common.js'

const ctx = { hardware: false, via: 'test' } as const
const reg = allTools()
const call = (name: string, args: unknown): Promise<Record<string, any>> => reg.call(name, args, ctx) as Promise<Record<string, any>>

describe('ams pure helpers', () => {
  it('normal quantile and Wilson interval match tabulated values', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5)
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9)
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 5)
    // Wilson 95 %: 8 of 10 -> [0.4902, 0.9433] (Newcombe 1998, Table I method 3, recomputed)
    const w = wilson(8, 10)
    expect(w.lo).toBeCloseTo(0.4902, 3)
    expect(w.hi).toBeCloseTo(0.9433, 3)
    const z = wilson(0, 20)
    expect(z.lo).toBe(0)
    expect(z.hi).toBeCloseTo(0.1611, 3)
  })

  it('tracectl db merge keeps the newer ams_specs row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-ams-merge-'))
    const mk = (name: string, rows: [string, string, number, number][]): string => {
      const p = join(dir, name, '.trace', 'project.db')
      const prev = process.env.TRACE_PROJECT_DB
      process.env.TRACE_PROJECT_DB = p
      const db = openProject()
      for (const [set, m, max, t] of rows) db.prepare('INSERT INTO ams_specs (spec_set, measure, max, updated) VALUES (?,?,?,?)').run(set, m, max, t)
      db.close()
      process.env.TRACE_PROJECT_DB = prev
      return p
    }
    const base = mk('base', [['s', 'a', 1, 1]])
    const ours = mk('ours', [['s', 'a', 2, 2], ['s', 'b', 5, 2]])
    const theirs = mk('theirs', [['s', 'a', 3, 3], ['s', 'c', 7, 3]])
    expect(merge(base, ours, theirs)).toEqual([])
    const prev = process.env.TRACE_PROJECT_DB
    process.env.TRACE_PROJECT_DB = ours
    const db = openProject()
    const rows = db.prepare('SELECT measure, max FROM ams_specs ORDER BY measure').all()
    db.close()
    process.env.TRACE_PROJECT_DB = prev
    expect(rows.map((x) => [x.measure, x.max])).toEqual([['a', 3], ['b', 5], ['c', 7]])
  })

  it('pearson r', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12)
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12)
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNull()
  })

  it('judges values against min/max with signed margins', () => {
    expect(judge(5, { min: 4, max: 10 })).toEqual({ pass: true, margin: 1, limit: 'min' })
    expect(judge(11, { min: 4, max: 10 })).toEqual({ pass: false, margin: -1, limit: 'max' })
    expect(judge(null, { min: 1 }).pass).toBe(false)
  })

  it('integrates power-law PSD segments exactly', () => {
    // white: 1e-18 V^2/Hz from 10 to 1000 Hz -> 9.9e-16
    expect(integratePsd([10, 100, 1000], [1e-18, 1e-18, 1e-18])).toBeCloseTo(9.9e-16, 25)
    // 1/f: k/f from 1 to 1000 -> k ln(1000)
    const f = [1, 10, 100, 1000]
    expect(integratePsd(f, f.map((x) => 1e-12 / x))).toBeCloseTo(1e-12 * Math.log(1000), 20)
    // a band inside the data
    expect(integratePsd([10, 1000], [1, 1], 100, 200)).toBeCloseTo(100, 9)
  })

  it('groups noise contributors and their parts', () => {
    const d = noiseDevices(['frequency', 'onoise_spectrum', 'onoise_r1', 'onoise_r1_thermal', 'onoise_r1_1overf', 'onoise_q1', 'onoise_q1_rb', 'onoise_q1_ic'])
    expect([...d.keys()]).toEqual(['r1', 'q1'])
    expect(d.get('q1')).toEqual(['q1_rb', 'q1_ic'])
  })

  it('reads .lib sections and switches a netlist to a corner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-ams-lib-'))
    writeFileSync(join(dir, 'c.lib'), '.lib tt\n.param k=1\n.endl tt\n.lib FF\n.param k=0.8\n.endl FF\n')
    expect(libSections('.lib tt\n.endl\n.lib ss\n.endl')).toEqual(['tt', 'ss'])
    const r = applyLibCorner('t\n.lib c.lib tt\nR1 a 0 {k}\n', dir, { section: 'ff' })
    expect(r.netlist).toContain(`.lib ${join(dir, 'c.lib')} ff`)
    expect(() => applyLibCorner('t\n.lib c.lib tt\n', dir, { section: 'xx' })).toThrow(/section xx/)
    expect(supplyValues({ param: 'vdd', nominal: 3.3, tol: 0.1 })).toEqual([2.97, 3.3, 3.63])
  })

  it('loop metrics: crossover, phase margin and gain margin of a known T(f)', () => {
    // T = 1000 / ((1 + s/w1)(1 + s/w2)^2): computed on a log grid
    const f: number[] = []
    for (let k = 0; k <= 400; k++) f.push(10 ** (0 + (k * 8) / 400))
    const mag: number[] = []
    const ph: number[] = []
    for (const x of f) {
      const p1 = Math.atan(x / 100)
      const p2 = Math.atan(x / 1e5)
      mag.push(20 * Math.log10(1000 / (Math.hypot(1, x / 100) * (1 + (x / 1e5) ** 2))))
      ph.push(-((p1 + 2 * p2) * 180) / Math.PI)
    }
    const m = loopMetrics(f, mag, unwrapDeg(ph))
    // |T| = 1 near 9.6e4 (solved numerically below); the phase crossover is at w where p1 + 2 p2 = 180
    const fc = crossingLogX(f, mag, 0, 'falling') as number
    expect(m.crossover_hz).toBeCloseTo(fc, 6)
    const pm = 180 - (Math.atan(fc / 100) + 2 * Math.atan(fc / 1e5)) * (180 / Math.PI)
    expect(m.phase_margin_deg as number).toBeCloseTo(pm, 1)
    expect(m.gain_margin_db).not.toBeNull()
  })

  it('slew and contiguous ranges', () => {
    const t = [0, 1, 2, 3, 4, 5, 6]
    const y = [0, 0, 1, 2, 3, 3, 3] // 1 V/s from t=1 to t=4
    expect(slewRate(t, y, 0, 3, 0)).toBeCloseTo(1, 9)
    expect(contiguousRange([0, 1, 2, 3, 4], [1, 0, 0, 0.001, 1], 2, 0.01)).toEqual([1, 3])
  })
})

describe('d_cosim wrapper generation', () => {
  it('parses a Verilator model header the way vlnggen does', () => {
    const h = '  VL_IN8(&clk,0,0);\n  VL_IN16(&sample,11,0);\n  VL_OUT8(&avg_valid,0,0);\n  VL_OUT16(&avg,11,0);\n  VL_INOUT8(&io,0,0);\n'
    const ports = parseModelHeader(h)
    expect(ports.map((p) => `${p.dir}:${p.name}:${p.msb}:${p.lsb}:${p.size}`)).toEqual(['in:clk:0:0:8', 'in:sample:11:0:16', 'out:avg_valid:0:0:8', 'out:avg:11:0:16', 'inout:io:0:0:8'])
    expect(vlData(ports, 'out')).toContain('VL_DATA(16,avg,11,0)')
  })

  it('flattens multi-bit inputs into one-bit ports and maps drives', () => {
    const ports = parseModelHeader('VL_IN8(&clk,0,0); VL_IN8(&rst,0,0); VL_IN8(&valid,0,0); VL_IN16(&sample,3,0); VL_OUT16(&avg,3,0);')
    const w = wrapper('moving_average', ports, { WIDTH: 4 })
    expect(w).toContain('input wire sample_trbit3')
    expect(w).toContain('.sample({sample_trbit3, sample_trbit2, sample_trbit1, sample_trbit0})')
    expect(w).toContain('moving_average #(.WIDTH(4)) u_dut')
    const flat = parseModelHeader('VL_IN8(&clk,0,0); VL_IN8(&rst,0,0); VL_IN8(&valid,0,0); VL_IN8(&sample_trbit3,0,0); VL_IN8(&sample_trbit2,0,0); VL_IN8(&sample_trbit1,0,0); VL_IN8(&sample_trbit0,0,0); VL_OUT16(&avg,3,0);')
    const plan = planInputs(flat, { adc: { input: 'x', bits: 4, vref_v: 1, port: 'sample' }, clock: { port: 'clk', freq_hz: 1e3 }, drive: { valid: 1 }, resetCycles: 2, tstop: 1 })
    expect(plan.resets).toEqual(['rst'])
    expect(plan.bits.find((b) => b.port === 'sample_trbit2')?.src).toBe('adcbit_2')
    expect(plan.bits.find((b) => b.port === 'valid')?.src).toBe('drv_valid')
  })
})

// ------------------------------------------------------------------------------------------- with ngspice

/** A behavioural op-amp with known numbers: GBW 1 MHz (gm 1 mS, 159.155 pF), A0 1e5, second pole 3 MHz, slew
 * 100 uA / 159.155 pF = 0.6283 V/us, CMRR 80 dB, PSRR+ 70 dB, PSRR- 60 dB, input range vee+0.3 .. vcc-1.2 (soft),
 * output clamped 0.1 V inside the rails behind 50 ohm. */
const OPAMP = `.subckt OPX inp inn vcc vee out
Bwin win 0 V = (1/(1+exp(-(v(inp)-v(vee)-0.3)/0.02))) * (1/(1+exp((v(inp)-v(vcc)+1.2)/0.02)))
Bgm 0 n1 I = 100u*tanh(1m*(v(inp)-v(inn) + ((v(inp)+v(inn))/2)/1e4 + (v(vcc)-5)/3162.28 + v(vee)/1000)/100u) * v(win)
R1 n1 0 100meg
C1 n1 0 159.155p
E2 n2 0 n1 0 1
R2 n2 n3 1k
C2 n3 0 53.0516p
Bo oi 0 V = max(min(v(n3), v(vcc)-0.1), v(vee)+0.1)
Ro oi out 50
.ends OPX
`

describe.skipIf(!ngspice())('ams with ngspice', () => {
  it('ams.opamp_check finds the macro-model\'s designed numbers', async () => {
    const r = await call('ams.opamp_check', { subckt: OPAMP, name: 'OPX', pins: ['inp', 'inn', 'vcc', 'vee', 'out'], vcc: 5, vee: 0, rl: 10e3, cl: 0, points_per_decade: 100, specs: { phase_margin_deg: { min: 60 } } })
    expect(r.errors).toBeUndefined()
    // follower: T = Aol (beta = 1, RL >> Ro); crossover 0.953 MHz and PM 72.4 deg (solved by hand from the poles)
    expect(r.loop.crossover_hz).toBeGreaterThan(0.93e6)
    expect(r.loop.crossover_hz).toBeLessThan(0.97e6)
    expect(r.loop.phase_margin_deg).toBeCloseTo(72.36, 0)
    expect(r.loop.dc_loop_gain_db).toBeCloseTo(100 + 20 * Math.log10(10e3 / 10050), 0)
    expect(r.aol.dc_gain_db).toBeCloseTo(100 + 20 * Math.log10(10e3 / 10050), 0)
    expect(r.aol.gbw_hz).toBeGreaterThan(0.93e6)
    expect(r.cmrr_db[0].db).toBeCloseTo(80, 0)
    expect(r.psrr_pos_db[0].db).toBeCloseTo(70, 0)
    expect(r.psrr_neg_db[0].db).toBeCloseTo(60, 0)
    expect(r.slew.rise_v_per_us).toBeGreaterThan(0.55)
    expect(r.slew.rise_v_per_us).toBeLessThan(0.66)
    expect(r.slew.fall_v_per_us).toBeGreaterThan(0.55)
    expect(r.swing.high_v).toBeGreaterThan(4.85)
    expect(r.swing.high_v).toBeLessThan(4.9)
    expect(r.swing.low_v).toBeGreaterThan(0.1)
    expect(r.swing.low_v).toBeLessThan(0.15)
    expect(r.icmr.low_v).toBeGreaterThan(0.1)
    expect(r.icmr.low_v).toBeLessThan(0.3)
    expect(r.icmr.high_v).toBeGreaterThan(3.75)
    expect(r.icmr.high_v).toBeLessThan(4)
    expect(r.pass).toBe(true)
  })

  it('ams.noise matches 4kTR and ngspice\'s own totals, and ranks the contributors', async () => {
    const r = await call('ams.noise', {
      netlist: 'divider noise\nV1 in 0 DC 0 AC 1\nR1 in out 1k\nR2 out 0 10k\nC1 out 0 1n\n',
      output: 'out', source: 'V1', fstart: 10, fstop: 1e6, points_per_decade: 50, spot: [100],
    })
    const kT = 1.380649e-23 * 300.15
    expect(r.spot[0].output_v_per_rthz).toBeCloseTo(Math.sqrt(4 * kT * (1e3 * 1e4) / 11e3), 11)
    expect(Math.abs(r.ngspice_totals.integration_difference)).toBeLessThan(0.01)
    expect(r.contributors[0].device).toBe('r1')
    expect(r.contributors[0].share_of_power).toBeCloseTo(10 / 11, 2)
    expect(r.contributors[0].parts[0].name).toBe('thermal')
  })

  it('ams.spec stores limits that ams.corners judges against; the worst corner is the one with least margin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-ams-corners-'))
    writeFileSync(join(dir, 'proc.lib'), '* process corners\n.lib tt\n.param rscale=1\n.endl tt\n.lib ff\n.param rscale=0.8\n.endl ff\n.lib ss\n.param rscale=1.2\n.endl ss\n')
    writeFileSync(join(dir, 'rc.cir'), 'rc corners\n.lib proc.lib tt\n.param vdd=3.3\nV1 in 0 DC {vdd} AC 1\nR1 in out {10k*rscale}\nC1 out 0 10n\n.op\n.ac dec 50 10 1meg\n')
    await call('ams.spec', { action: 'set', spec_set: 'rc', rows: [{ measure: 'f3db', min: 1400, max: 1800, unit: 'Hz' }, { measure: 'vout', min: 2.9, max: 3.7, unit: 'V' }] })
    const got = await call('ams.spec', { action: 'get', spec_set: 'rc' })
    expect(got.specs.map((s: { measure: string }) => s.measure)).toEqual(['f3db', 'vout'])
    const r = await call('ams.corners', {
      path: join(dir, 'rc.cir'), spec_set: 'rc',
      measurements: [{ name: 'f3db', kind: 'bandwidth', vector: 'v(out)' }, { name: 'vout', kind: 'value_at', vector: 'v(out)', analysis: 'op' }],
      model_corners: [{ name: 'tt', lib: { section: 'tt' } }, { name: 'ff', lib: { section: 'ff' } }, { name: 'ss', lib: { section: 'ss' } }],
      supplies: [{ param: 'vdd', nominal: 3.3, tol: 0.1 }], temps: [-40, 27, 85],
    })
    expect(r.corners).toBe(27)
    expect(r.pass).toBe(false)
    const f3 = r.worst.find((w: { measure: string }) => w.measure === 'f3db')
    expect(f3.corner).toMatch(/^ff /)
    expect(f3.failing).toBe(18)
    expect(f3.value).toBeCloseTo(1 / (2 * Math.PI * 8e3 * 10e-9), -1)
    const vout = r.worst.find((w: { measure: string }) => w.measure === 'vout')
    expect(vout.pass).toBe(true)
    expect(vout.value).toBeCloseTo(2.97, 6)
  })

  it('ams.montecarlo_yield: yield with a confidence interval and the dominant tolerance', async () => {
    const r = await call('ams.montecarlo_yield', {
      netlist: 'rc yield\nV1 in 0 DC 0 AC 1\nR1 in out 10k\nC1 out 0 10n\n.ac dec 100 100 100k\n',
      measurements: [{ name: 'f3db', kind: 'bandwidth', vector: 'v(out)' }],
      specs: { f3db: { min: 1591.55 * 0.98, max: 1591.55 * 1.02 } },
      tolerances: [{ ref: 'R1', tol: 0.01 }, { ref: 'C1', tol: 0.05 }], runs: 300, seed: 7, sensitivity: 'both',
    })
    // f ~ 1/(RC): sigma = sqrt((1/3)^2 + (5/3)^2) % = 1.700 %, so +-2 % is +-1.177 sigma: 76.1 % expected
    expect(r.ci.lo).toBeLessThan(0.761)
    expect(r.ci.hi).toBeGreaterThan(0.761)
    expect(r.yield).toBeGreaterThan(0.68)
    expect(r.yield).toBeLessThan(0.84)
    expect(r.sensitivity.f3db.correlation[0].part).toBe('C1')
    expect(r.sensitivity.f3db.correlation[0].r2).toBeGreaterThan(0.9)
    expect(r.sensitivity.f3db.oat[0].part).toBe('C1')
  })
})

describe.skipIf(!ngspice() || !verilator() || !shimDir())('ams.mixed: d_cosim with Verilator', () => {
  it('runs the sensor-node front end into the moving average, bit exact', async () => {
    const ex = resolve('examples/sensor-node')
    const r = await call('ams.mixed', {
      path: join(ex, 'sim/front-end.cir'),
      verilog: [join(ex, 'logic/moving_average.v')], top: 'moving_average', parameters: { WIDTH: 12 },
      adc: { input: 'adc_in', bits: 12, vref_v: 3.3, port: 'sample' },
      clock: { port: 'clk', freq_hz: 10e3 },
      drive: { valid: 1 },
      tstop: 5e-3,
      measurements: [{ name: 'code_final', kind: 'final', vector: 'v(adc_code)' }, { name: 'avg_final', kind: 'final', vector: 'v(avg_code)' }],
      max_samples: 5000,
    })
    expect(r.cosim).toBe(true)
    expect(r.resets).toEqual(['rst'])
    const code = r.measurements.find((m: { name: string }) => m.name === 'code_final').value
    // 12 V full scale: the divider and clamp give 2.9946 V at the pin (examples/sensor-node README), 3716 counts
    expect(code).toBeGreaterThanOrEqual(3714)
    expect(code).toBeLessThanOrEqual(3718)
    expect(r.measurements.find((m: { name: string }) => m.name === 'avg_final').value).toBe(code)
    // the moving average, sample by sample, from the codes the design latched (reset covers the first two edges)
    const rows = r.samples as { adc_code: number; avg: number }[]
    let mismatches = 0
    for (let k = 2; k < rows.length; k++) {
      const window = [0, 1, 2, 3].map((j) => (k - j >= 2 ? (rows[k - j] as { adc_code: number }).adc_code : 0))
      const expected = Math.floor(window.reduce((s, v) => s + v, 0) / 4)
      if (Math.abs((rows[k] as { avg: number }).avg - expected) > 0) mismatches++
    }
    expect(mismatches).toBe(0)
  })
})

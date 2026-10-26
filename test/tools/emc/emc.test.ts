import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { allTools } from '../../../src/tools/index.js'
import { microstrip } from '../../../src/tools/kicad/pcb.js'
import { clipToBox, convexHull, pointInPoly, polyArea, readGeometry } from '../../../src/tools/emc/board.js'
import { cisprLimit } from '../../../src/tools/emc/limits.js'
import { DEFAULTS, precheck } from '../../../src/tools/emc/precheck.js'
import { canImport, openemsPython, siPython } from '../../../src/tools/emc/python.js'
import { axisLines, buildModel, modelScript } from '../../../src/tools/emc/setup.js'
import { cmCurrentFor, cmField, dBuV, dmField, envelope, envelopeCorners, harmonic, K_CM, K_DM } from '../../../src/tools/emc/spectrum.js'
import { backendFor } from '../../../src/gpu/jobs.js'
import { openemsRuns, openemsSpeed } from '../../../src/tools/emc/python.js'
import { writeEmcBoard } from './boards.js'

const ctx = { hardware: false, via: 'test' } as const
const reg = allTools()
const call = (name: string, args: unknown): Promise<Record<string, any>> => reg.call(name, args, ctx) as Promise<Record<string, any>>

describe('emc spectrum closed forms (hand-computed)', () => {
  const p = { amplitude: 1, freq: 10e6, duty: 0.5, rise: 0.8e-9 } // tr (0-100 %) = 1 ns
  it('trapezoid harmonics', () => {
    // c1 = 2 A d |sinc(pi/2)| |sinc(pi tr f)| = 0.636620 * 0.999836
    expect(harmonic(p, 1)).toBeCloseTo(0.6366198 * 0.9998355, 6)
    expect(harmonic(p, 2)).toBeCloseTo(0, 12) // 50 % duty: even harmonics vanish
    expect(harmonic(p, 3)).toBeCloseTo(0.2122066 * 0.9985199, 6)
    const c = envelopeCorners(p)
    expect(c.f1).toBeCloseTo(6.366198e6, 0)
    expect(c.f2).toBeCloseTo(318.3099e6, -2)
    expect(c.low).toBeCloseTo(1, 12)
    expect(envelope(p, 1e9)).toBeCloseTo((1 * c.f1 * c.f2) / 1e18, 9)
    expect(() => harmonic({ ...p, rise: 60e-9 }, 1)).toThrow(/edges/)
  })

  it('radiation constants and fields', () => {
    expect(K_DM).toBeCloseTo(1.31687e-14, 18)
    expect(K_CM).toBeCloseTo(6.28319e-7, 11)
    // 1 cm^2 loop, 10 mA, 100 MHz, 3 m, free space: 1.31687e-14 * 1e16 * 1e-4 * 1e-2 / 3 = 4.3896e-5 V/m
    expect(dmField(100e6, 1e-4, 10e-3, 3, false) / 4.38957e-5).toBeCloseTo(1, 4)
    expect(dmField(100e6, 1e-4, 10e-3, 3, true) / (2 * 4.38957e-5)).toBeCloseTo(1, 4)
    expect(dBuV(4.38957e-5)).toBeCloseTo(32.848, 2) // 43.9 uV/m
    // 1 m wire, 1 uA, 100 MHz, 3 m, free space: 6.28319e-7 * 1e8 * 1e-6 / 3 = 2.0944e-5 V/m
    expect(cmField(100e6, 1, 1e-6, 3, false).e / 2.09440e-5).toBeCloseTo(1, 5)
    const capped = cmField(300e6, 1, 1e-6, 3, false)
    expect(capped.capped).toBe(true)
    expect(capped.length_used).toBeCloseTo(299792458 / 300e6 / 2, 9)
    // the current that meets 40 dBuV/m (100 uV/m) at 3 m, 100 MHz, 1 m, with ground: 1e-4 * 3 / (1.2566e-6 * 1e8) = 2.387 uA
    expect(cmCurrentFor(100e6, 1, 1e-4, 3, true) / 2.3873e-6).toBeCloseTo(1, 4)
  })

  it('CISPR 32 limits', () => {
    expect(cisprLimit('B', 100e6, 3)?.db_uv_m).toBe(40)
    expect(cisprLimit('B', 500e6, 3)?.db_uv_m).toBe(47)
    expect(cisprLimit('B', 230e6, 3)?.db_uv_m).toBe(40) // the lower limit at the transition
    expect(cisprLimit('B', 100e6, 10)?.db_uv_m).toBe(30)
    expect(cisprLimit('A', 100e6, 10)?.db_uv_m).toBe(40)
    expect(cisprLimit('A', 2e9, 3)?.db_uv_m).toBe(56)
    expect(cisprLimit('B', 2e9, 10)?.db_uv_m).toBeCloseTo(50 + 20 * Math.log10(0.3), 6)
    expect(cisprLimit('B', 10e6, 3)).toBeNull()
  })

  it('emc.spectrum: a clock against class B', async () => {
    const r = await call('emc.spectrum', { signal: { amplitude: 3.3, freq_hz: 50e6, rise_s: 1e-9 }, dm: { loop_area_mm2: 100 }, fmax: 1e9 })
    expect(r.envelope.f2_hz / (1 / (Math.PI * 1.25e-9))).toBeCloseTo(1, 4)
    const h1 = r.harmonics.find((h: { n: number }) => h.n === 1)
    const i1 = harmonic({ amplitude: 3.3, freq: 50e6, rise: 1e-9 }, 1) / 50
    expect(h1.dm_dbuv_m).toBeCloseTo(dBuV(dmField(50e6, 100e-6, i1, 3, true) / Math.SQRT2), 2)
    expect(typeof r.pass).toBe('boolean')
  })
})

describe('emc.run routing and log reading', () => {
  it('sends a big CPU job to the queue only when asked and a queue exists', () => {
    const saved = { q: process.env.TRACE_GPU_QUEUE, m: process.env.TRACE_GPU_REMOTE }
    try {
      delete process.env.TRACE_GPU_REMOTE
      delete process.env.TRACE_GPU_QUEUE
      expect(backendFor({ gpu: false, remote: true })).toBe('local')
      process.env.TRACE_GPU_QUEUE = 'q'
      expect(backendFor({ gpu: false, remote: true })).toBe('batch')
      expect(backendFor({ gpu: false, remote: false })).toBe('local')
      process.env.TRACE_GPU_REMOTE = 'never'
      expect(backendFor({ gpu: false, remote: true })).toBe('local')
    } finally {
      if (saved.q === undefined) delete process.env.TRACE_GPU_QUEUE
      else process.env.TRACE_GPU_QUEUE = saved.q
      if (saved.m === undefined) delete process.env.TRACE_GPU_REMOTE
      else process.env.TRACE_GPU_REMOTE = saved.m
    }
  })

  it('reads openEMS\'s log', () => {
    const log = 'Create FDTD operator (compressed SSE + multi-threading)\nRunFDTD: end-criteria of -30.00dB reached after 2665 timesteps (-35.49dB)\nTime for 2665 iterations with 372060.00 cells : 26.79 sec\nSpeed: 37.01 MCells/s\nCreate FDTD operator\nTime for 1000 iterations with 5 cells : 1 sec\n'
    expect(openemsSpeed(log)).toBe(37.01)
    expect(openemsRuns(log)).toEqual({ timesteps: [2665, 1000], endCriterionMet: [true, false] })
  })
})

describe('emc geometry helpers', () => {
  it('polygons', () => {
    const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]]
    expect(pointInPoly(5, 5, sq)).toBe(true)
    expect(pointInPoly(15, 5, sq)).toBe(false)
    expect(polyArea(sq)).toBe(100)
    expect(polyArea(clipToBox(sq, 5, 5, 20, 20))).toBeCloseTo(25, 9)
    expect(polyArea(convexHull([[0, 0], [4, 0], [4, 3], [0, 3], [2, 1]]))).toBeCloseTo(12, 9)
  })

  it('mesh lines: fine inside the region, graded outside, PML cells beyond the margin', () => {
    const l = axisLines([2, 2.05, 7], 0, 10, -5, 15, 1, 3, 1.5, 8)
    const steps = l.slice(1).map((x, i) => x - (l[i] as number))
    expect(Math.max(...steps.filter((_, i) => (l[i] as number) >= 0 && (l[i + 1] as number) <= 10))).toBeLessThanOrEqual(1 + 1e-9)
    expect(l).toContain(7)
    expect(l.filter((x) => x > 15).length).toBe(8) // PML_8 beyond the margin
    expect(Math.max(...steps)).toBeLessThanOrEqual(3 + 1e-9)
    for (let i = 1; i < steps.length; i++) expect((steps[i] as number) / (steps[i - 1] as number)).toBeLessThan(1.6)
  })
})

// a 4-layer board with deliberate problems; In1 is split (GND left, +3V3 right, 2 mm gap), In2 is GND
const PLANE_L: [number, number][] = [[1, 1], [19, 1], [19, 29], [1, 29]]
const PLANE_R: [number, number][] = [[21, 1], [39, 1], [39, 29], [21, 29]]
const FULL: [number, number][] = [[1, 1], [39, 1], [39, 29], [1, 29]]
const precheckBoard = (): string => writeEmcBoard({
  layers: 4, h: 0.2, width: 40, height: 30,
  zones: [{ net: 'GND', layer: 'In1.Cu', poly: PLANE_L }, { net: '+3V3', layer: 'In1.Cu', poly: PLANE_R }, { net: 'GND', layer: 'In2.Cu', poly: FULL }],
  segments: [
    { net: '/CLK', layer: 'F.Cu', x1: 5, y1: 10, x2: 30, y2: 10, w: 0.2 },
    { net: '/CLK', layer: 'B.Cu', x1: 30, y1: 10, x2: 30, y2: 20, w: 0.2 },
    { net: '/DATA', layer: 'F.Cu', x1: 5, y1: 20, x2: 15, y2: 20, w: 0.2 },
    { net: '/DATA', layer: 'B.Cu', x1: 15, y1: 20, x2: 15, y2: 25, w: 0.2 },
    { net: '/DATA2', layer: 'F.Cu', x1: 5, y1: 15, x2: 12, y2: 15, w: 0.2 },
    { net: '/DATA2', layer: 'B.Cu', x1: 12, y1: 15, x2: 12, y2: 18, w: 0.2 },
    { net: '/SCK2', layer: 'F.Cu', x1: 3, y1: 1.3, x2: 10, y2: 1.3, w: 0.2 },
  ],
  vias: [{ net: '/CLK', x: 30, y: 10 }, { net: '/DATA', x: 15, y: 20 }, { net: '/DATA2', x: 12, y: 15 }, { net: 'GND', x: 12.8, y: 15.5 }],
  footprints: [
    { ref: 'U1', x: 25, y: 25, pads: [{ num: '1', x: -1, y: 0, w: 0.6, h: 0.6, net: '+3V3' }, { num: '2', x: 1, y: 0, w: 0.6, h: 0.6, net: 'GND' }] },
    { ref: 'C1', x: 35, y: 25, pads: [{ num: '1', x: -0.5, y: 0, w: 0.6, h: 0.6, net: '+3V3' }, { num: '2', x: 0.5, y: 0, w: 0.6, h: 0.6, net: 'GND' }] },
    { ref: 'U3', x: 8, y: 25, pads: [{ num: '1', x: 0, y: 0, w: 1, h: 1, net: '/SW' }, { num: '2', x: 0, y: 2, w: 1, h: 1, net: 'GND' }] },
    { ref: 'L1', x: 14, y: 25, pads: [{ num: '1', x: 0, y: 0, w: 2, h: 2, net: '/SW' }, { num: '2', x: 4, y: 0, w: 2, h: 2, net: '/VOUT' }] },
  ],
})

describe('emc.precheck', () => {
  it('finds the planted problems, with locations and evidence', async () => {
    const r = await call('emc.precheck', { board: precheckBoard(), edges: [{ net: '/CLK', freq_hz: 50e6, rise_s: 1e-9, amplitude_v: 3.3 }], max_findings: 1000 })
    const f = r.findings as { rule: string; severity: string; net: string; at: { x_mm: number; y_mm: number } | null; evidence: Record<string, any>; message: string }[]
    const gap = f.find((x) => x.rule === 'return_path' && x.net === '/CLK' && x.evidence.gap_mm !== undefined)
    expect(gap?.severity).toBe('error') // a clock
    expect(gap?.at?.x_mm).toBeGreaterThan(19)
    expect(gap?.at?.x_mm).toBeLessThan(21)
    expect(gap?.evidence.gap_mm).toBeGreaterThan(1.7)
    expect(gap?.evidence.reference_layer).toBe('In1.Cu')
    const split = f.find((x) => x.rule === 'return_path' && x.net === '/CLK' && x.evidence.from === 'GND')
    expect(split?.evidence.to).toBe('+3V3')
    // CLK's via: F.Cu over In1 (+3V3 there) to B.Cu over In2 (GND): a reference-net change with no capacitor
    const clkVia = f.find((x) => x.rule === 'stitching' && x.net === '/CLK')
    expect(clkVia?.evidence.from.net).toBe('+3V3')
    expect(clkVia?.evidence.to.net).toBe('GND')
    // DATA: GND on In1 to GND on In2 with the nearest GND via 5.0 mm away; DATA2 has one 0.94 mm away
    expect(f.find((x) => x.rule === 'stitching' && x.net === '/DATA')?.evidence.nearest_stitch_mm).toBeCloseTo(Math.hypot(2.2, 4.5), 2)
    expect(f.find((x) => x.rule === 'stitching' && x.net === '/DATA2')).toBeUndefined()
    // SCK2 1.2 mm from the edge (guideline 3 mm)
    const edge = f.find((x) => x.rule === 'edge_proximity' && x.net === '/SCK2')
    expect(edge?.evidence.distance_mm).toBeCloseTo(1.2, 2)
    // U1's +3V3 pin (x 24) is 10.5 mm from C1's +3V3 pad (x 34.5)
    const dec = f.find((x) => x.rule === 'decoupling' && x.message.includes('U1'))
    expect(dec?.evidence.distance_mm).toBeCloseTo(10.5, 3)
    // the switching node: pads U3.1 and L1.1 plus U3's ground pad
    const sw = f.find((x) => x.rule === 'switching_loop' && x.net === '/SW')
    expect(sw?.evidence.copper_mm2).toBeCloseTo(1 + 4, 6)
    expect(sw?.evidence.parts).toEqual(['U3', 'L1'])
    // the edge-rate estimate, recomputed by hand from the reported Z0 and loop
    const spec = r.edge_spectrum[0]
    expect(spec.length_mm).toBeCloseTo(35, 6)
    expect(spec.height_mm).toBeCloseTo(0.2, 6)
    expect(spec.z0_ohm).toBeCloseTo(microstrip(0.2, 0.2, 0.035, 4.4)[0], 1)
    const i1 = harmonic({ amplitude: 3.3, freq: 50e6, rise: 1e-9 }, 1) / spec.z0_ohm
    const e1 = dBuV(dmField(50e6, 35e-3 * 0.2e-3, i1, 3, true) / Math.SQRT2)
    const rows = precheck(readGeometry(precheckBoard()), { ...DEFAULTS, rules: ['edge_spectrum'], edges: [{ net: '/CLK', freq_hz: 50e6, rise_s: 1e-9, amplitude_v: 3.3 }] }).spectrum[0] as { worst: { e_dbuv_m: number } }
    expect(rows.worst.e_dbuv_m).toBeGreaterThan(e1 - 30) // the worst harmonic is at least as strong as a deep-envelope one
    expect(r.counts.error).toBeGreaterThan(0)
  })

  it('runs on the sensor-node board: F.Cu tracks over the B.Cu pour cross the voids B.Cu tracks cut', async () => {
    const r = await call('emc.precheck', { board: resolve('examples/sensor-node/hardware/sensor-node.kicad_pcb'), max_findings: 1000 })
    expect(r.planes).toEqual([{ layer: 'B.Cu', nets: ['GND'], filled: true }])
    expect(r.counts.error + r.counts.warn + r.counts.info).toBeGreaterThan(0)
    for (const x of r.findings as { at: unknown; evidence: unknown }[]) expect(x.evidence).toBeTruthy()
  })
})

// ------------------------------------------------------------------------------------------- openEMS

/** A 20 mm microstrip, 1.9 mm wide on 1.0 mm FR4 (er 4.4): about 50 ohm, with an SMD pad at each end. */
const lineBoard = (): string => writeEmcBoard({
  layers: 2, h: 1.0, width: 40, height: 20,
  zones: [{ net: 'GND', layer: 'B.Cu', poly: [[0.5, 0.5], [39.5, 0.5], [39.5, 19.5], [0.5, 19.5]] }],
  segments: [{ net: '/RF', layer: 'F.Cu', x1: 10, y1: 10, x2: 30, y2: 10, w: 1.9 }],
  footprints: [
    { ref: 'J1', x: 10, y: 10, pads: [{ num: '1', x: 0, y: 0, w: 1.9, h: 1.9, net: '/RF' }] },
    { ref: 'J2', x: 30, y: 10, pads: [{ num: '1', x: 0, y: 0, w: 1.9, h: 1.9, net: '/RF' }] },
  ],
})

describe('emc.setup (model generation)', () => {
  it('is deterministic and reports its choices', () => {
    const b = lineBoard()
    const input = { board: b, nets: ['/RF'], ports: [{ at: 'J1.1' }, { at: 'J2.1' }], fstop: 3e9, points: 300, fine_cell_mm: 0.475 }
    const m1 = buildModel(input)
    const m2 = buildModel(input)
    expect(modelScript(m1.model)).toBe(modelScript(m2.model))
    const s = m1.summary
    expect(s.boundary.kind).toMatch(/PML_8/)
    expect(s.boundary.margin_mm).toBe(8) // max(5 mm, 8 x 1.0 mm)
    expect(s.ports.map((p) => p.ref_layer)).toEqual(['B.Cu', 'B.Cu'])
    expect(s.mesh.cells).toBe((s.mesh.nx - 1) * (s.mesh.ny - 1) * (s.mesh.nz - 1))
    expect(s.dielectrics).toEqual([{ z0_mm: 0, z1_mm: 1, er: 4.4, tand: 0.02, assumed: [] }])
    expect(s.memory_mb_est).toBe(Math.round((s.mesh.cells * 108) / 1e6))
    expect(m1.model.freqs[0]).toBeCloseTo(1e7, 3)
    expect(m1.model.ports[0]?.start[2]).toBe(0)
    expect(m1.model.ports[0]?.stop[2]).toBe(1)
    expect(() => buildModel({ ...input, nets: ['/NOPE'] })).toThrow(/no net/)
  })

  it('models the sensor-node ADC_IN net between its SMD pads, and refuses a lumped port on a through-hole pad', () => {
    const board = resolve('examples/sensor-node/hardware/sensor-node.kicad_pcb')
    expect(() => buildModel({ board, nets: ['/ADC_IN'], ports: [{ at: 'R3.2' }, { at: 'J2.3' }], fstop: 3e9 })).toThrow(/through-hole/)
    const m = buildModel({ board, nets: ['/ADC_IN'], ports: [{ at: 'R3.2' }, { at: 'C1.1' }], fstop: 3e9 })
    expect(m.summary.reference_nets).toEqual(['GND'])
    expect(m.summary.dielectrics[0]?.er).toBe(4.5)
    expect(m.summary.boundary.margin_mm).toBeCloseTo(8 * 1.51, 3)
    expect(m.summary.mesh.fine_cell_mm).toBe(0.125) // half the 0.25 mm track
    expect(m.model.layers.find((l) => l.name === 'B.Cu')?.polygons.length).toBeGreaterThan(0) // the clipped GND pour
  })
})

const haveOpenems = await canImport(openemsPython(), ['CSXCAD', 'openEMS', 'numpy'])
const haveSkrf = await canImport(siPython(), ['skrf', 'numpy'])

describe.skipIf(!haveOpenems)('emc.setup + emc.run with openEMS', () => {
  it('simulates a 50 ohm microstrip: S-parameters, Touchstone, TDR', async () => {
    const zA = microstrip(1.9, 1.0, 0.035, 4.4)[0]
    const s = await call('emc.setup', { board: lineBoard(), nets: ['/RF'], ports: [{ at: 'J1.1' }, { at: 'J2.1' }], fstop: 3e9, points: 300, fine_cell_mm: 0.475, cells_per_dielectric: 4, end_criteria_db: -30, radiated: { frequencies: [2.5e9] } })
    expect(s.build).toMatch(/built/)
    expect(s.summary.boundary.margin_reason).toMatch(/lambda\/4 at 2500 MHz/)
    const r = await call('emc.run', { setup_run_id: s.run_id, frequencies: [0.5e9, 1e9], drive: { amplitude_v: 3.3, freq_hz: 100e6, rise_s: 1e-9 } })
    expect(r.where).toBe('local')
    expect(r.touchstone).toBe('sparams.s2p')
    const at1 = r.losses.find((l: { f_hz: number }) => l.f_hz === 1e9)
    expect(at1.insertion_loss_db).toBeLessThan(1.5)
    expect(at1.insertion_loss_db).toBeGreaterThan(-0.1)
    expect(at1.return_loss_db).toBeGreaterThan(6)
    // the line's impedance in the middle of the TDR profile is near the closed form (Hammerstad-Jensen ~ zA)
    const t = r.tdr[0]
    expect(t.z_min_ohm).toBeLessThan(zA * 1.3)
    expect(t.z_max_ohm).toBeGreaterThan(zA * 0.7)
    expect(r.timesteps.length).toBe(2)
    expect(r.warning).toBeUndefined()
    // the far field: a pre-compliance estimate, with ground reflection 6.02 dB above free space
    expect(r.radiated.label).toMatch(/PRE-COMPLIANCE/)
    const ff = r.radiated.rows[0]
    expect(ff.f_hz).toBe(2.5e9)
    expect(ff.e_with_ground_dbuv_m - ff.e_free_space_dbuv_m).toBeCloseTo(6.02, 2)
    expect(ff.limit_dbuv_m).toBe(50)
    expect(ff.radiated_fraction_of_incident).toBeGreaterThan(0)
    expect(ff.radiated_fraction_of_incident).toBeLessThan(0.1)
    if (haveSkrf) {
      const si = await call('emc.si', { run_id: r.run_id, z_target: 50, tol: 0.3, insertion_loss: [{ from: 1, to: 2, budget_db: 3, f_max: 2e9 }] })
      expect(si.insertion_loss[0].pass).toBe(true)
      expect(si.ports).toBe(2)
    }
  }, 900_000)
})

describe.skipIf(!haveSkrf)('emc.si on a synthetic Touchstone', () => {
  it('finds a 75 ohm section and the crosstalk', async () => {
    // an ideal 50 ohm line with a 75 ohm section in the middle, plus a weakly coupled victim, written as a 4-port
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const d = mkdtempSync(join(tmpdir(), 'trace-si-'))
    const n = 400
    const df = 50e6
    const lines = ['# Hz S RI R 50']
    const c = 299792458
    for (let k = 1; k <= n; k++) {
      const f = k * df
      // cascade: 50 ohm line 50 mm, 75 ohm 20 mm, 50 ohm 50 mm (lossless, er_eff 1 for simplicity) via ABCD
      const sec = (z: number, len: number): [number, number, number, number, number, number, number, number] => {
        const b = (2 * Math.PI * f * len) / c
        return [Math.cos(b), 0, 0, z * Math.sin(b), 0, Math.sin(b) / z, Math.cos(b), 0]
      }
      type C = [number, number]
      const mul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]
      const add = (a: C, b: C): C => [a[0] + b[0], a[1] + b[1]]
      const m2 = (x: C[], y: C[]): C[] => [add(mul(x[0] as C, y[0] as C), mul(x[1] as C, y[2] as C)), add(mul(x[0] as C, y[1] as C), mul(x[1] as C, y[3] as C)), add(mul(x[2] as C, y[0] as C), mul(x[3] as C, y[2] as C)), add(mul(x[2] as C, y[1] as C), mul(x[3] as C, y[3] as C))]
      const toM = (s: number[]): C[] => [[s[0] as number, s[1] as number], [s[2] as number, s[3] as number], [s[4] as number, s[5] as number], [s[6] as number, s[7] as number]]
      const M = m2(m2(toM(sec(50, 0.05)), toM(sec(75, 0.02))), toM(sec(50, 0.05)))
      const [A, B, C2, D] = M as [C, C, C, C]
      const z0 = 50
      const den: C = add(add(A, [B[0] / z0, B[1] / z0]), add([C2[0] * z0, C2[1] * z0], D))
      const div = (a: C, b: C): C => { const q = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / q, (a[1] * b[0] - a[0] * b[1]) / q] }
      const s11 = div(add(add(A, [B[0] / z0, B[1] / z0]), [-(C2[0] * z0) - D[0], -(C2[1] * z0) - D[1]]), den)
      const s21 = div([2, 0], den)
      const x: C = [0.01, 0] // -40 dB NEXT and FEXT, flat
      const row: C[][] = [[s11, s21, x, x], [s21, s11, x, x], [x, x, s11, s21], [x, x, s21, s11]]
      const parts = row.map((rr) => rr.map((v) => `${v[0]} ${v[1]}`).join(' '))
      lines.push(`${f} ${parts[0]}`, parts[1] as string, parts[2] as string, parts[3] as string)
    }
    const file = join(d, 'line.s4p')
    writeFileSync(file, `${lines.join('\n')}\n`)
    const r = await call('emc.si', {
      touchstone: file, z_target: 50, tol: 0.1, er_eff: 1, tdr_ports: [1],
      insertion_loss: [{ from: 1, to: 2, budget_db: 0.5 }],
      crosstalk: [{ aggressor: { net: 'A', near: 1, far: 2 }, victim: { net: 'V', near: 3, far: 4 }, limit_db: -30 }],
    })
    const disc = r.tdr[0].discontinuities
    expect(disc.length).toBeGreaterThanOrEqual(1)
    expect(disc[0].z_ohm).toBeGreaterThan(65)
    expect(disc[0].z_ohm).toBeLessThan(80)
    expect(disc[0].d0_m).toBeGreaterThan(0.04)
    expect(disc[0].d0_m).toBeLessThan(0.06)
    expect(r.crosstalk[0].next.worst_db).toBeCloseTo(-40, 6)
    expect(r.crosstalk[0].pass).toBe(true)
    expect(r.insertion_loss[0].worst.il_db).toBeGreaterThan(0)
    expect(readFileSync(file, 'utf8').startsWith('# Hz')).toBe(true)
  })
})

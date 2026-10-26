import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { merge } from '../../../src/core/dbmerge.js'
import { open, Work } from '../../../src/core/store.js'
import { allTools } from '../../../src/tools/index.js'
import { traceWidth } from '../../../src/tools/calc/pcb.js'
import { finRise, plateRise, slabRise } from '../../../src/tools/thermal/analytic.js'
import { besselI, besselJ, besselK, j1Zeros } from '../../../src/tools/thermal/bessel.js'
import { assemble } from '../../../src/tools/thermal/budget.js'
import { buildMesh, ccxInstalled, parseFrd, writeInp } from '../../../src/tools/thermal/calculix.js'
import { coefficient, hForced, hHorizontal, hRadiation, hVertical, sealedInternal, type Environment } from '../../../src/tools/thermal/convection.js'
import { proposeLimits } from '../../../src/tools/thermal/datasheet.js'
import { allowedAt, checkPoint, pointsFromTable } from '../../../src/tools/thermal/derating.js'
import { csv, texturedSlab, vtu } from '../../../src/tools/thermal/export.js'
import { colour, colourBar, encodePng } from '../../../src/tools/thermal/image.js'
import { readResult, writeJob, main as jobMain } from '../../../src/tools/thermal/job.js'
import { junction } from '../../../src/tools/thermal/junction.js'
import { air, pressureAt } from '../../../src/tools/thermal/materials.js'
import { fitMultiplier, rtdTemperature } from '../../../src/tools/thermal/measure.js'
import { boardSetup, estimateCells, foamFile, openfoamInstalled, parseDat, readResults, verticalPlateCase, writeCase, CfdSetup } from '../../../src/tools/thermal/openfoam.js'
import { copperArea, pourConductance, spreading, traceRise, viaArray } from '../../../src/tools/thermal/pcb.js'
import { runBoard } from '../../../src/tools/thermal/model.js'
import { compare, metrics, seriesFromCsv } from '../../../src/tools/thermal/transient.js'
import { validate, plateCase } from '../../../src/tools/thermal/validation.js'
import { solveSteady, structure } from '../../../src/tools/thermal/grid.js'
import { hotBoard, U1_LIMITS } from './boards.js'

type Dict = Record<string, any>
const reg = allTools()
const call = (name: string, args: unknown, hardware = false): Promise<Dict> => reg.call(name, args, { hardware, via: 'test' }) as Promise<Dict>
const rel = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b)
const hasCcx = ccxInstalled()
const has = (cmd: string): boolean => { try { execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 20_000 }); return true } catch { return false } }
const hasNgspice = has('ngspice')

const env = (o: Partial<Environment> = {}): Environment => ({
  kind: 'natural', ambient_c: 25, altitude_m: 0, orientation: 'horizontal', airflow_m_s: 0, emissivity: { top: 0.9, bottom: 0.9, edge: 0.9 },
  radiation: true, h_override: {}, h_multiplier: 1, enclosure: null, ...o,
})

// ------------------------------------------------------------------ closed forms

describe('Bessel functions (Abramowitz & Stegun tables 9.1, 9.8)', () => {
  it('match tabulated values', () => {
    expect(besselJ(0, 1)).toBeCloseTo(0.7651976866, 9)
    expect(besselJ(1, 1)).toBeCloseTo(0.4400505857, 9)
    expect(besselI(0, 1)).toBeCloseTo(1.2660658778, 9)
    expect(besselI(1, 1)).toBeCloseTo(0.5651591040, 9)
    expect(besselK(0, 1)).toBeCloseTo(0.4210244382, 9)
    expect(besselK(1, 1)).toBeCloseTo(0.6019072302, 9)
    expect(besselK(0, 0.1)).toBeCloseTo(2.4270690247, 8)
    expect(j1Zeros(3).map((x) => Number(x.toFixed(4)))).toEqual([3.8317, 7.0156, 10.1735])
  })
})

describe('thermal.pcb calculators (hand calculations)', () => {
  it('via array: barrel area, theta per via and in parallel', () => {
    // A = pi/4 ((0.34 mm)^2 - (0.30 mm)^2) = 2.0106e-8 m^2; theta = 1.6 mm / (385 x A) = 206.70 C/W
    const r = viaArray({ count: 4, drill_m: 0.3e-3, length_m: 1.6e-3 })
    expect(r.barrel_area_m2).toBeCloseTo(2.0106e-8, 11)
    expect(r.per_via_c_per_w).toBeCloseTo(206.70, 1)
    expect(r.total_c_per_w).toBeCloseTo(206.70 / 4, 2)
    // copper-filled: + 385 x pi/4 (0.3 mm)^2 / 1.6 mm in parallel
    const f = viaArray({ count: 1, drill_m: 0.3e-3, length_m: 1.6e-3, fill_k: 385 })
    expect(f.per_via_c_per_w).toBeCloseTo(1 / (1 / 206.70 + (385 * Math.PI * 0.09e-6 / 4) / 1.6e-3), 1)
    // the laminate in parallel over 4 mm^2
    const l = viaArray({ count: 4, drill_m: 0.3e-3, length_m: 1.6e-3, array_area_m2: 4e-6 })
    expect(l.laminate_c_per_w).toBeCloseTo(1.6e-3 / (0.3 * (4e-6 - 4 * (Math.PI / 4) * 0.34e-3 ** 2)), 1)
  })

  it('spreading: the half-space limit 8/(3 pi^2 k a), the 1D terms, and nothing to spread when the source covers the plate', () => {
    const s = spreading({ source_radius_m: 1e-3, plate_radius_m: 50e-3, thickness_m: 50e-3, k: 1, h: 1e6 })
    // epsilon = 0.02: the isoflux half-space value is 270.19 C/W; the finite plate lowers it by about (1 - eps)^1.5 = 0.970
    expect(rel(s.spreading_c_per_w, 8 / (3 * Math.PI ** 2 * 1e-3) * (1 - 0.02) ** 1.5)).toBeLessThan(0.005)
    expect(s.one_d_c_per_w).toBeCloseTo(50e-3 / (Math.PI * 2.5e-3), 6)
    expect(spreading({ source_radius_m: 10e-3, plate_radius_m: 10e-3, thickness_m: 1e-3, k: 1, h: 10 }).spreading_c_per_w).toBeLessThan(1e-9)
  })

  it('copper area: the fin conductance and the bisection agree', () => {
    const t = 35e-6
    const r = copperArea({ target_c_per_w: 40, source_radius_m: 2e-3, copper_oz: 1, h: 10 })
    expect(r.achievable).toBe(true)
    expect(1 / pourConductance(2e-3, r.radius_m!, t, 385, 10)).toBeCloseTo(40, 3)
    // a source alone: G = 2 h pi a^2
    expect(pourConductance(2e-3, 2e-3, t, 385, 10)).toBeCloseTo(2 * 10 * Math.PI * 4e-6, 12)
    // too ambitious: an infinite 1 oz pour around a 2 mm source cannot reach 1 C/W
    expect(copperArea({ target_c_per_w: 1, source_radius_m: 2e-3, h: 10 }).achievable).toBe(false)
  })

  it('trace rise inverts calc.trace_width (IPC-2221B)', () => {
    const w = traceWidth({ current: 2, temp_rise: 20, layer: 'external' }).width_m as number
    expect(traceRise({ current_a: 2, width_m: w, layer: 'external' }).temp_rise_c).toBeCloseTo(20, 6)
  })
})

describe('convection and radiation', () => {
  it('Churchill & Chu by hand at a 35 C film (Incropera table A.4 interpolated)', () => {
    // 308.15 K: f = 0.163 between 300 and 350 K
    const f = 8.15 / 50
    const k = 26.3e-3 + f * 3.7e-3
    const nu = 15.89e-6 + f * 5.03e-6
    const al = 22.5e-6 + f * 7.4e-6
    const pr = 0.707 - f * 0.007
    const ra = (9.80665 / 308.15) * 20 * 0.1 ** 3 / (nu * al)
    const Nu = (0.825 + (0.387 * ra ** (1 / 6)) / (1 + (0.492 / pr) ** (9 / 16)) ** (8 / 27)) ** 2
    const c = hVertical(20, 0.1, 35)
    expect(c.ra).toBeCloseTo(ra, -2)
    expect(c.h).toBeCloseTo((Nu * k) / 0.1, 6)
    expect(c.h).toBeGreaterThan(4.9)
    expect(c.h).toBeLessThan(5.2) // Antmicro quote 5.14 W/m^2 K for their case at 25 C ambient
  })

  it('horizontal faces, forced flow, radiation, altitude', () => {
    const up = hHorizontal(20, 0.0125, 35, true)
    const down = hHorizontal(20, 0.0125, 35, false)
    expect(up.h).toBeGreaterThan(down.h)
    expect(up.correlation).toMatch(/0.54 Ra/)
    // laminar plate: Nu = 0.664 Re^0.5 Pr^(1/3)
    const p = air(25)
    const re = (2 * 0.05) / p.nu
    expect(hForced(2, 0.05, 25).h).toBeCloseTo((0.664 * re ** 0.5 * p.pr ** (1 / 3) * p.k) / 0.05, 6)
    // eps sigma (Ts^2 + Ta^2)(Ts + Ta) at 50 and 25 C
    expect(hRadiation(0.9, 50, 25)).toBeCloseTo(0.9 * 5.670374419e-8 * (323.15 ** 2 + 298.15 ** 2) * (323.15 + 298.15), 9)
    expect(pressureAt(0)).toBeCloseTo(101325, 6)
    expect(pressureAt(3000)).toBeCloseTo(70109, -2)
    expect(hVertical(20, 0.1, 35, 3000).h).toBeLessThan(hVertical(20, 0.1, 35, 0).h)
    expect(coefficient(env({ kind: 'vacuum' }), { length_m: 0.05, width_m: 0.05, thickness_m: 1.6e-3 }, 'top', 20, 25).h).toBe(0)
    expect(coefficient(env({ h_override: { top: 12 } }), { length_m: 0.05, width_m: 0.05, thickness_m: 1.6e-3 }, 'top', 20, 25).h).toBe(12)
  })

  it('a sealed enclosure: the internal air rises with the power, self-consistently', () => {
    const e = env({ kind: 'sealed', enclosure: { length_m: 0.1, width_m: 0.08, height_m: 0.04, wall_thickness_m: 0.002, wall_k: 0.2, emissivity: 0.9 } })
    const s = sealedInternal(e, 2)
    expect(s.internal_c).toBeGreaterThan(25)
    expect((s.internal_c - 25) / 2).toBeCloseTo(s.r_c_per_w, 3)
  })
})

describe('junction temperatures and derating', () => {
  const lim = { ref: 'U1', tj_max_c: 125, theta_ja: 50, psi_jb: 10, psi_jt: 2, citations: {} }
  it('theta-JA, psi-JB with the board, psi-JT with the top; at-risk between the derated limit and Tj_max', () => {
    const a = junction({ ref: 'U1', power_w: 1, limits: lim, ambient_c: 60, derating: { kind: 'offset', value_c: 20 } })
    expect(a).toMatchObject({ method: 'theta_ja', tj_c: 110, margin_c: 15, derated_limit_c: 105, derated_margin_c: -5, status: 'at-risk' })
    expect(a.caveat).toMatch(/JEDEC test board/)
    expect(junction({ ref: 'U1', power_w: 1, limits: lim, ambient_c: 60, board_c: 80, derating: { kind: 'offset', value_c: 20 } })).toMatchObject({ method: 'psi_jb', tj_c: 90, status: 'pass' })
    expect(junction({ ref: 'U1', power_w: 1, limits: lim, ambient_c: 60, board_c: 80, top_c: 85, derating: { kind: 'offset', value_c: 20 } })).toMatchObject({ method: 'psi_jt', tj_c: 87 })
    expect(junction({ ref: 'U1', power_w: 2, limits: lim, ambient_c: 60, derating: { kind: 'fraction', value: 0.8 } })).toMatchObject({ tj_c: 160, derated_limit_c: 100, status: 'fail' })
    expect(junction({ ref: 'U9', power_w: 1, limits: undefined, ambient_c: 60, derating: { kind: 'offset', value_c: 20 } }).status).toBe('unknown')
  })

  it('derating curves: interpolation, margin, out of range', () => {
    const c: [number, number][] = [[-55, 0.1], [70, 0.1], [155, 0]]
    expect(allowedAt(c, 112.5).y).toBeCloseTo(0.05, 12)
    expect(checkPoint(c, 100, 0.03)).toMatchObject({ status: 'pass' })
    expect(checkPoint(c, 140, 0.03).status).toBe('fail')
    expect(checkPoint(c, 170, 0.0).status).toBe('out-of-range')
    expect(pointsFromTable([['T (°C)', 'P (W)'], ['70', '0.10'], ['155', '0'], ['note', '']], 0, 1)).toEqual([[70, 0.1], [155, 0]])
  })
})

describe('budget', () => {
  it('LDO, buck, priority of explicit over datasheet, rail totals', () => {
    const b = assemble([
      { method: 'regulator', ref: 'U1', rail: '5V', kind: 'ldo', vin: 5, vout: 3.3, iout: 0.5, iq: 5e-3 },
      { method: 'regulator', ref: 'U2', rail: '12V', kind: 'buck', vin: 12, vout: 3.3, iout: 2, efficiency: 0.9, citation: { source: 'efficiency curve, fixture' } },
      { method: 'datasheet', ref: 'U3', rail: '3V3', mpn: 'X', voltage_v: 3.3, current_a: 0.1, citation: { mpn: 'X', sha256: 'abcdef12', page: 4 } },
      { method: 'explicit', ref: 'U3', rail: '3V3', power_w: 0.25, citation: { source: 'measured' } },
    ])
    const by = new Map(b.lines.map((l) => [l.ref, l]))
    expect(by.get('U1')!.power_w).toBeCloseTo(1.7 * 0.5 + 5 * 5e-3, 12)
    expect(by.get('U2')!.power_w).toBeCloseTo((3.3 * 2 * 0.1) / 0.9, 12)
    expect(by.get('U3')).toMatchObject({ method: 'explicit', power_w: 0.25, alternatives: [{ method: 'datasheet', power_w: expect.closeTo(0.33, 9) as unknown }] })
    expect(b.total_w).toBeCloseTo(0.875 + 0.73333333 + 0.25, 6)
    expect(b.rails.map((r) => r.rail).sort()).toEqual(['12V', '3V3', '5V'])
  })

  it.skipIf(!hasNgspice)('a SPICE operating point: resistor and diode power', async () => {
    const r = await call('thermal.budget', { entries: [], spice: { netlist: '* op\nV1 in 0 5\nR1 in out 100\nD1 out 0 DX\n.model DX D(IS=1e-14)\n.end\n', devices: [{ ref: 'R1', device: 'R1', rail: '5V' }, { ref: 'D1', device: 'D1', rail: '5V' }] } })
    const r1 = r.lines.find((l: Dict) => l.ref === 'R1')
    const d1 = r.lines.find((l: Dict) => l.ref === 'D1')
    // V(out) ~ 0.65 V: I ~ 43.5 mA; R1: I^2 R ~ 0.19 W; D1: ~0.028 W; together 5 V x I
    expect(r1.power_w + d1.power_w).toBeCloseTo(5 * (r1.power_w / 100) ** 0.5, 3)
    expect(r1.citation.run_id).toBe(r.spice_run_id)
  })
})

describe('measurement helpers', () => {
  it('IEC 60751 Pt100: 100 C = 138.5055 ohm, 0 C = 100 ohm, -100 C = 60.2558 ohm', () => {
    expect(rtdTemperature(138.5055)).toBeCloseTo(100, 3)
    expect(rtdTemperature(100)).toBeCloseTo(0, 9)
    expect(rtdTemperature(60.2558)).toBeCloseTo(-100, 2)
  })

  it('fits an h multiplier by bisection', async () => {
    // a toy model: rise = 30 / mult
    const f = await fitMultiplier([25 + 30 / 0.7], 25, async (m) => [25 + 30 / m])
    expect(f.converged).toBe(true)
    expect(f.multiplier).toBeCloseTo(0.7, 2)
  })

  it('transient metrics and comparison', () => {
    const t = Array.from({ length: 101 }, (_, i) => i * 10)
    const s = { name: 'a', t, y: t.map((x) => 25 + 50 * (1 - Math.exp(-x / 100))) }
    const m = metrics(s, 75)
    expect(m.t90_s).toBeCloseTo(100 * Math.log(10), -1)
    expect(m.t_steady_s).toBeCloseTo(100 * Math.log(100), -1)
    const c = compare(s, { ...s, name: 'b', y: s.y.map((y) => y + 1) })
    expect(c.max_abs_c).toBeCloseTo(1, 9)
    expect(seriesFromCsv('time_s,U1\n0,25\n10,30\n')[0]).toEqual({ name: 'U1', t: [0, 10], y: [25, 30] })
  })
})

describe('datasheet figures', () => {
  it('proposes only figures every matching row agrees on, with the citation', async () => {
    const reader = async (_mpn: string, query: string) => ({
      mpn: 'tlv1117', sha256: 'a'.repeat(64),
      result: query.includes('junction temperature')
        ? { sha256: 'a'.repeat(64), query, total: 1, rows: [{ page: 4, raw: 'Operating junction temperature TJ -40 125 °C', parsed: true, min: '-40', max: '125', unit: '°C' }] }
        : { sha256: 'a'.repeat(64), query, total: 2, rows: [{ page: 7, raw: 'RθJA 104', parsed: true, typ: '104' }, { page: 7, raw: 'RθJA 61 (DCY)', parsed: true, typ: '61' }] },
    })
    const p = await proposeLimits('TLV1117', ['tj_max_c', 'theta_ja'], reader)
    expect(p[0]).toMatchObject({ field: 'tj_max_c', value: 125, agree: true, citation: { mpn: 'tlv1117', page: 4 } })
    expect(p[1]).toMatchObject({ field: 'theta_ja', value: null, agree: false, citation: null })
  })
})

// ------------------------------------------------------------------ the solvers

describe('2.5D model: validation against closed forms at two mesh sizes', () => {
  it('slab, fin and plate within tolerance, and finer is not worse on the plate', async () => {
    const rows = await validate('2.5d')
    for (const r of rows) expect(Math.abs(r.error_pct), `${r.case} at ${r.cell_mm} mm: ${r.model} vs ${r.reference}`).toBeLessThanOrEqual(r.tolerance_pct)
    const plate = rows.filter((r) => r.case === 'plate')
    expect(plate).toHaveLength(2)
    expect(rows.find((r) => r.case === 'slab')!.reference).toBeCloseTo(slabRise(250, 1.5e-3, 0.3, 10).top, 9)
    expect(finRise(0.5, 10, 200, 0.004, 1e-3, 0.1, 0.1)).toBeGreaterThan(0)
    expect(plateRise(1, 0.01, 50, 1e-3, 20)).toBeCloseTo(plate[0]!.reference, 12)
  })

  it('conserves energy to solver precision', () => {
    const c = plateCase(5e-3)
    const s = solveSteady(c.model, structure(c.model), c.h, 0, { radiation: false })
    expect(Math.abs(s.balance_error)).toBeLessThan(1e-8)
  })
})

describe.skipIf(!hasCcx)('CalculiX (ccx): validation and deck', () => {
  it('slab, fin and plate within tolerance at two mesh sizes', async () => {
    const rows = await validate('calculix')
    for (const r of rows) expect(Math.abs(r.error_pct), `${r.case} at ${r.cell_mm} mm: ${r.model} vs ${r.reference}`).toBeLessThanOrEqual(r.tolerance_pct)
  }, 300_000)
})

describe('CalculiX deck and results (no ccx needed)', () => {
  it('writes heat-transfer bricks, films, radiation, fluxes; parses an .frd', () => {
    const c = plateCase(50e-3)
    const mesh = buildMesh(c.model, { sublayers: 1 })
    const inp = writeInp(mesh, { h: { top: 10, bottom: 10, edge: 5 }, emissivity: { top: 0.9, bottom: 0.9, edge: 0.9 }, sink_c: 25, radiation: true })
    expect(inp).toMatch(/\*ELEMENT,TYPE=DC3D8/)
    expect(inp).toMatch(/\*CONDUCTIVITY,TYPE=ORTHO/)
    expect(inp).toMatch(/\*HEAT TRANSFER,STEADY STATE/)
    expect(inp).toMatch(/\*FILM\n\d+,F2,25\.,10\./)
    expect(inp).toMatch(/\*RADIATE\n\d+,R/)
    expect(inp).toMatch(/\*DFLUX\n\d+,S2,/)
    const frd = '    1C\n  100CL  101 1.000000000           2                     0    1           1\n -4  NDTEMP      1    1\n -5  T           1    1    0    0\n -1         1 3.50000E+01\n -1         2-1.25000E+01\n -3\n 9999\n'
    const r = parseFrd(frd)
    expect(r[0]!.time).toBe(1)
    expect([...r[0]!.temps]).toEqual([[1, 35], [2, -12.5]])
  })
})

// ------------------------------------------------------------------ outputs

describe('outputs', () => {
  it('PNG, colour bar, GLB, VTU, CSV', () => {
    const png = encodePng(2, 1, new Uint8Array([255, 0, 0, 0, 0, 255]))
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(new DataView(png.buffer).getUint32(16)).toBe(2)
    expect(colour(0)).toEqual([68, 1, 84])
    expect(colourBar(25, 80).length).toBeGreaterThan(100)
    const glb = texturedSlab(0.05, 0.04, 1.6e-3, png, png)
    const v = new DataView(glb.buffer)
    expect(v.getUint32(0, true)).toBe(0x46546c67)
    expect(v.getUint32(8, true)).toBe(glb.length)
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + v.getUint32(12, true)))) as Dict
    expect(json.images).toHaveLength(2)
    expect(json.extensionsUsed).toContain('KHR_materials_unlit')
    const x = vtu({ points: new Float64Array(24), hexes: Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7]), cellData: { t: new Float64Array([1]) } })
    expect(x).toMatch(/NumberOfPoints="8" NumberOfCells="1"/)
    expect(csv(['a', 'b'], [[1, 'x,y']])).toBe('a,b\n1,"x,y"\n')
  })
})

// ------------------------------------------------------------------ the hot board, through the tools

describe('the hot board: fails bare, passes with a pour and thermal vias', () => {
  const bare = hotBoard('bare')
  const poured = hotBoard('poured')
  beforeAll(async () => {
    await call('thermal.envelope', { action: 'set', name: 'hot', ambient_min_c: 0, ambient_max_c: 50, environment: 'natural', derating: { kind: 'offset', value_c: 20 }, source: 'test fixture' })
    await call('thermal.envelope', { action: 'set_parts', name: 'hot', parts: [U1_LIMITS] })
    await call('thermal.budget', { scenario: 'ldo-1w', entries: [{ method: 'regulator', ref: 'U1', rail: '5V', kind: 'ldo', vin: 5, vout: 3, iout: 0.5, citation: { source: 'test fixture' } }] })
  })
  afterAll(() => { for (const p of [bare, poured]) rmSync(dirname(p), { recursive: true, force: true }) })

  it('refuses a part limit without a citation', async () => {
    await expect(call('thermal.envelope', { action: 'set_parts', name: 'hot', parts: [{ ref: 'U2', tj_max_c: 125 }] })).rejects.toThrow(/citation/)
  })

  it('the budget is 1 W, stored', async () => {
    expect((await call('thermal.budget', { action: 'get', scenario: 'ldo-1w' })).total_w).toBeCloseTo(1, 9)
  })

  it('bare: the check fails', async () => {
    const r = await call('thermal.check', { envelope: 'hot', scenario: 'ldo-1w', board: bare, cell_mm: 1 })
    expect(r.verdict).toBe('fail')
    expect(r.at_risk[0]).toMatchObject({ ref: 'U1', method: 'psi_jb', status: 'fail', worst_corner_c: 50 })
    const w = new Work()
    try {
      const run = w.run(r.run_id)!
      expect(run.measurements.map((m) => m.name)).toEqual(expect.arrayContaining(['U1.tj_c', 'U1.derated_margin_c', 'U1.tj_c@0', 'U1.tj_c@50', 'worst_derated_margin_c']))
      expect(run.artifacts.map((a) => a.name)).toContain('check.csv')
    } finally { w.close() }
  }, 120_000)

  it('poured, with vias: the check passes, and the board run has its maps, model and report', async () => {
    const r = await call('thermal.check', { envelope: 'hot', scenario: 'ldo-1w', board: poured, cell_mm: 1 })
    expect(r.verdict).toBe('pass')
    expect(r.parts[0].derated_margin_c).toBeGreaterThan(0)
    const b = await call('thermal.board', { envelope: 'hot', scenario: 'ldo-1w', board: poured, cell_mm: 1 })
    expect(Math.abs(b.energy.balance_error)).toBeLessThan(1e-3)
    expect(b.film.converged).toBe(true)
    expect(b.h.top.correlation).toMatch(/hot face up/)
    expect(b.vias).toBe(16)
    expect(b.hotspot.layer).toBe('F.Cu')
    const w = new Work()
    try {
      const names = w.run(b.run_id)!.artifacts.map((a) => a.name)
      expect(names).toEqual(expect.arrayContaining(['map-F_Cu.png', 'map-B_Cu.png', 'colourbar.png', 'temperature.csv', 'board.vtu', 'board.glb', 'report.md']))
      const md = new TextDecoder().decode(w.getArtifact(b.run_id, 'report.md')!)
      expect(md).toMatch(/## Boundary conditions/)
      expect(md).toMatch(/## Energy balance/)
      expect(md).toMatch(/No CFD/)
    } finally { w.close() }
    // the bare board is much hotter
    const bb = await call('thermal.board', { envelope: 'hot', scenario: 'ldo-1w', board: bare, cell_mm: 1 })
    expect(bb.parts[0].board_c - b.parts[0].board_c).toBeGreaterThan(40)
  }, 120_000)

  it('a transient: rises toward the steady state, with t90 and a CSV; compare against itself is zero', async () => {
    const b = await call('thermal.board', { envelope: 'hot', scenario: 'ldo-1w', board: poured, cell_mm: 2, transient: { duration_s: 3000, dt_s: 20 } })
    const m = b.transient.metrics.find((x: Dict) => x.name === 'U1')
    expect(m.t90_s).toBeGreaterThan(30)
    expect(m.reached).toBeGreaterThan(0.9)
    const c = await call('thermal.compare', { a: { run: b.run_id, column: 'U1' }, b: { run: b.run_id, column: 'U1' } })
    expect(c.max_abs_c).toBe(0)
  }, 120_000)

  it('thermal.measure needs hardware; manual readings compare with the model; a heater calibration stores an h multiplier', async () => {
    const model = await call('thermal.board', { envelope: 'hot', scenario: 'ldo-1w', board: poured, cell_mm: 2, ambient_c: 25 })
    await expect(call('thermal.measure', { points: [{ name: 'tc1', source: { kind: 'manual', value_c: 50 } }] })).rejects.toThrow(/hardware/)
    // "measured": 5 C hotter than the model, as if h were lower than the correlation's
    const measured = model.parts[0].board_c + 5
    const r = await call('thermal.measure', {
      model_run: model.run_id, ambient_c: 25,
      points: [{ name: 'tc_u1', ref: 'U1', source: { kind: 'manual', value_c: measured, note: 'K thermocouple on the tab' } }],
      calibrate: { envelope: 'hot', heater_power_w: 1, heater_ref: 'U1' },
    }, true)
    expect(r.points[0].error_c).toBeCloseTo(-5, 6)
    expect(r.calibration.converged).toBe(true)
    expect(r.calibration.multiplier).toBeLessThan(1)
    const corr = await call('thermal.envelope', { action: 'corrections', name: 'hot' })
    expect(corr.corrections[0]).toMatchObject({ name: 'h_multiplier', evidence: [model.run_id, r.run_id] })
    // the next board run uses it, and says so
    const next = await call('thermal.board', { envelope: 'hot', scenario: 'ldo-1w', board: poured, cell_mm: 2, ambient_c: 25 })
    expect(next.parts[0].board_c).toBeGreaterThan(model.parts[0].board_c)
    expect(next.assumptions.join(' ')).toMatch(/calibration/)
    await call('thermal.envelope', { action: 'clear_correction', name: 'hot' })
  }, 300_000)

  it.skipIf(!hasCcx)('CalculiX agrees with the 2.5D model on the poured board', async () => {
    const two = await call('thermal.board', { envelope: 'hot', scenario: 'ldo-1w', board: poured, cell_mm: 1 })
    const fem = await call('thermal.board', { envelope: 'hot', scenario: 'ldo-1w', board: poured, cell_mm: 1, solver: 'calculix' })
    expect(Math.abs(fem.energy.error)).toBeLessThan(0.01)
    const rise2 = two.parts[0].board_c - 50
    const riseF = fem.parts[0].board_c - 50
    // different model forms (sheets vs bricks, linearised vs exact radiation, edge films): within 15 %
    console.log(`hot board U1 rise: 2.5d ${rise2.toFixed(2)} K, calculix ${riseF.toFixed(2)} K (${(100 * (riseF - rise2) / rise2).toFixed(1)} %)`)
    expect(rel(riseF, rise2)).toBeLessThan(0.15)
    const w = new Work()
    try { expect(w.run(fem.run_id)!.artifacts.map((a) => a.name)).toEqual(expect.arrayContaining(['model.inp', 'board.vtu', 'board.glb', 'report.md'])) } finally { w.close() }
  }, 300_000)

  it('the job file round trip (the CPU-queue path, run in process)', async () => {
    const d = mkdtempSync(join(tmpdir(), 'thermal-job-'))
    try {
      const a = { environment: env({ ambient_c: 50 }), power: { U1: 1 }, cell_mm: 2 }
      writeJob(join(d, 'job.db'), readFileSync(poured, 'utf8'), a)
      await jobMain(join(d, 'job.db'), join(d, 'result.db'))
      const remote = readResult(join(d, 'result.db'), poured, a)
      const local = await runBoard({ board: poured, ...a, power: new Map([['U1', 1]]) })
      expect(remote.parts[0]!.board_c).toBeCloseTo(local.parts[0]!.board_c, 6)
      expect(remote.solution.T.length).toBe(local.solution.T.length)
    } finally { rmSync(d, { recursive: true, force: true }) }
  }, 120_000)
})

// ------------------------------------------------------------------ the sensor-node example

describe('examples/sensor-node: its stored envelope and budget', () => {
  const SAMPLE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'sensor-node')
  let dir = ''
  const envDb = process.env.TRACE_PROJECT_DB
  beforeAll(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'sensor-thermal-')), 'sensor-node')
    mkdirSync(join(dir, '.trace'), { recursive: true })
    mkdirSync(join(dir, 'hardware'), { recursive: true })
    copyFileSync(join(SAMPLE, '.trace', 'project.db'), join(dir, '.trace', 'project.db'))
    copyFileSync(join(SAMPLE, 'hardware', 'sensor-node.kicad_pcb'), join(dir, 'hardware', 'sensor-node.kicad_pcb'))
    process.env.TRACE_PROJECT_DB = join(dir, '.trace', 'project.db')
  })
  afterAll(() => {
    if (envDb === undefined) delete process.env.TRACE_PROJECT_DB
    else process.env.TRACE_PROJECT_DB = envDb
    rmSync(dirname(dir), { recursive: true, force: true })
  })

  it('a quick check on the real board: tiny margins of nothing, and D2 unknown for want of a sourced limit', async () => {
    const env0 = await call('thermal.envelope', { action: 'get', name: 'bench' })
    expect(env0.parts.map((p: Dict) => p.ref)).toEqual(['D2', 'R1', 'R2', 'R4'])
    const r = await call('thermal.check', { envelope: 'bench', scenario: 'nominal', board: join(dir, 'hardware', 'sensor-node.kicad_pcb'), cell_mm: 0.5 })
    expect(r.verdict).toBe('unknown')
    expect(r.parts.find((p: Dict) => p.ref === 'D2').status).toBe('unknown')
    for (const ref of ['R1', 'R2', 'R4']) expect(r.parts.find((p: Dict) => p.ref === ref).status).toBe('pass')
    expect(r.board_runs).toHaveLength(2)
    const d = await call('thermal.derating', { action: 'check', ref: 'R4', curve: 'power_vs_ambient', x: 60, y: 0.0033 })
    expect(d.status).toBe('pass')
  }, 120_000)
})

// ------------------------------------------------------------------ the database

describe('project tables merge by key, newer wins', () => {
  it('thermal_envelopes', () => {
    const d = mkdtempSync(join(tmpdir(), 'thermal-merge-'))
    try {
      const mk = (name: string, updated: number, max: number): string => {
        const p = join(d, `${name}.db`)
        const prev = process.env.TRACE_PROJECT_DB
        process.env.TRACE_PROJECT_DB = p
        try {
          // registering happens at import; open through the store so every table exists
          const w = new Work(p)
          w.close()
          const db = open(p, { wal: false })
          db.prepare("INSERT INTO thermal_envelopes (name, ambient_min_c, ambient_max_c, environment, derating, updated) VALUES ('e', 0, ?, 'natural', '{\"kind\":\"offset\",\"value_c\":20}', ?)").run(max, updated)
          db.close()
        } finally { process.env.TRACE_PROJECT_DB = prev }
        return p
      }
      const base = mk('base', 1, 40)
      const ours = mk('ours', 2, 50)
      const theirs = mk('theirs', 3, 70)
      merge(base, ours, theirs)
      const db = open(ours, { readonly: true })
      expect((db.prepare("SELECT ambient_max_c FROM thermal_envelopes WHERE name='e'").get() as Dict).ambient_max_c).toBe(70)
      db.close()
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

// ------------------------------------------------------------------ CFD (OpenFOAM)

const board = { x0: 0, y0: 0, x1: 0.05, y1: 0.05, thickness: 1.6e-3, k_eff: 20, rho: 1850, cp: 1100, emissivity: 0.9 }

describe('the OpenFOAM case generator (dictionaries; no solver needed)', () => {
  it('natural convection: regions, solver, fields, sources, function objects', () => {
    const c = writeCase(boardSetup(board, [{ ref: 'U1', x0: 0.02, y0: 0.02, x1: 0.03, y1: 0.03, power_w: 1 }], { ambient_c: 25, vertical: false, flow: { kind: 'natural' }, radiation: 'fvDOM' }))
    const f = c.files
    expect(c.solver).toBe('chtMultiRegionSimpleFoam')
    expect(f.get('constant/regionProperties')).toMatch(/fluid \(air\)\n\s+solid \(board part_U1\)/)
    expect(f.get('system/controlDict')).toMatch(/application\s+chtMultiRegionSimpleFoam;/)
    expect(f.get('system/controlDict')).toMatch(/type\s+wallHeatFlux;/)
    expect(f.get('system/controlDict')).toMatch(/type\s+solverInfo;/)
    expect(f.get('system/controlDict')).toMatch(/weightField\s+phi;/)
    expect(f.get('constant/air/turbulenceProperties')).toMatch(/simulationType\s+laminar;/)
    expect(f.get('constant/air/radiationProperties')).toMatch(/radiationModel\s+fvDOM;/)
    expect(f.get('constant/air/boundaryRadiationProperties')).toMatch(/air_to_board/)
    expect(f.get('system/part_U1/fvOptions')).toMatch(/h\s+\(1 0\);/)
    expect(f.get('0.orig/air/IDefault')).toMatch(/greyDiffusiveRadiation/)
    expect(f.get('0.orig/air/T')).toMatch(/#includeEtc "caseDicts\/setConstraintTypes"/)
    expect(f.has('system/board/fvOptions')).toBe(false)
    expect(f.get('0.orig/air/p_rgh')).toMatch(/prghTotalPressure/)
    expect(f.get('0.orig/air/T')).toMatch(/turbulentTemperatureRadCoupledMixed/)
    expect(f.get('0.orig/board/T')).toMatch(/kappaMethod\s+solidThermo;/)
    expect(f.get('system/snappyHexMeshDict')).toMatch(/cellZoneInside\s+inside;/)
    expect(f.get('system/snappyHexMeshDict')).toMatch(/#includeEtc "caseDicts\/mesh\/generation\/meshQualityDict.cfg"/)
    expect(f.get('Allrun')).toMatch(/splitMeshRegions -cellZones -overwrite/)
    // every dictionary's braces and parentheses balance
    for (const [k, v] of f) {
      if (k === 'Allrun') continue
      const body = v.replace(/\/\*[\s\S]*?\*\//g, '')
      expect((body.match(/\{/g) ?? []).length, k).toBe((body.match(/\}/g) ?? []).length)
      expect((body.match(/\(/g) ?? []).length, k).toBe((body.match(/\)/g) ?? []).length)
    }
    expect(c.cells).toBe(estimateCells(c.setup))
  })

  it('forced flow: k-omega SST, a fan curve, MPI, transient', () => {
    const c = writeCase(boardSetup(board, [], { ambient_c: 25, vertical: false, flow: { kind: 'fan', inlet: 'x-', outlet: 'x+', curve: [[0, 30], [0.002, 15], [0.004, 0]] }, radiation: 'none', steady: false, procs: 4 }))
    expect(c.solver).toBe('chtMultiRegionFoam')
    expect(c.files.get('constant/air/turbulenceProperties')).toMatch(/kOmegaSST/)
    expect(c.files.get('0.orig/air/p_rgh')).toMatch(/fanPressure[\s\S]*\(0\.002 15\)/)
    expect(c.files.get('0.orig/air/k')).toBeDefined()
    expect(c.files.get('Allrun')).toMatch(/mpirun --allow-run-as-root -np 4 chtMultiRegionFoam -parallel/)
    expect(c.files.get('system/decomposeParDict')).toMatch(/numberOfSubdomains\s+4;/)
    expect(() => CfdSetup.parse({ ...c.setup, flow: { kind: 'fixed', inlet: 'x-', outlet: 'x+', flow_m3_s: -1 } })).toThrow()
  })

  it('the vertical-plate validation case at two mesh levels', () => {
    const a = writeCase(verticalPlateCase(0).setup)
    const b = writeCase(verticalPlateCase(1).setup)
    expect(b.setup.cell_m).toBeCloseTo(a.setup.cell_m / 2, 12)
    expect(b.cells).toBeGreaterThan(2 * a.cells)
    expect(verticalPlateCase(0).reference(45)).toBeCloseTo(hVertical(20, 0.1, 35).h, 9)
  })

  it('reads a postProcessing tree: region temperatures, h_eff, residuals, energy balance', () => {
    const s = CfdSetup.parse(boardSetup(board, [], { ambient_c: 25, vertical: false, flow: { kind: 'natural' }, radiation: 'none' }))
    s.solids[0]!.power_w = 1
    const d = mkdtempSync(join(tmpdir(), 'pp-'))
    try {
      const put = (fo: string, file: string, text: string): void => { mkdirSync(join(d, fo, '0'), { recursive: true }); writeFileSync(join(d, fo, '0', file), text) }
      put('wallHeatFlux', 'wallHeatFlux.dat', '# Time patch min max integral\n100 air_to_board -1 1 -0.98\n100 wall_zmin 0 0 0\n')
      put('T_board', 'fieldMinMax.dat', '# Time field min max\n100 T 300 330.15\n')
      put('Tmean_board', 'volFieldValue.dat', '# Time volAverage(T)\n100 328.15\n')
      put('surface_board', 'surfaceFieldValue.dat', '# Time areaAverage(T)\n100 323.15\n')
      put('area_board', 'surfaceFieldValue.dat', '# Time areaIntegrate(T)\n100 1.680\n')
      put('residuals', 'solverInfo.dat', '# Time U_solver Ux_initial h_initial p_rgh_initial\n100 DILU 1e-6 1e-7 1e-6\n')
      put('enthalpy_open_zmax', 'surfaceFieldValue.dat', '# Time weightedSum(h)\n100 0.97\n')
      const r = readResults(d, s)
      expect(r.regions[0]).toMatchObject({ name: 'board', max_c: expect.closeTo(57, 6) as unknown, mean_c: expect.closeTo(55, 6) as unknown, heat_w: 0.98 })
      // A = 1.680 / 323.15; h = 0.98 / (A x 25)
      expect(r.regions[0]!.h_eff).toBeCloseTo(0.98 / ((1.68 / 323.15) * 25), 6)
      expect(r.residuals.converged).toBe(true)
      expect(r.balance.out_w).toBeCloseTo(0.97, 9)
      expect(r.balance.error).toBeCloseTo(-0.03, 9)
      expect(parseDat('# a  b\n1 2\n').columns).toEqual(['a', 'b'])
      expect(foamFile('dictionary', 'x', { a: 1 })).toMatch(/object\s+x;\n}\n\na\s+1;/)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('thermal.board solver=cfd write_only stores the case without running', async () => {
    const p = hotBoard('poured')
    try {
      const r = await call('thermal.board', { envelope_inline: { ambient_min_c: 0, ambient_max_c: 40 }, power: { U1: 1 }, board: p, cell_mm: 2, solver: 'cfd', cfd: { write_only: true } })
      expect(r).toMatchObject({ solver: 'cfd', written_only: true, solver_app: 'chtMultiRegionSimpleFoam' })
      const w = new Work()
      try { expect(w.run(r.run_id)!.artifacts.map((a) => a.name)).toEqual(expect.arrayContaining(['case/system/controlDict', 'case/constant/regionProperties', 'case/Allrun'])) } finally { w.close() }
    } finally { rmSync(dirname(p), { recursive: true, force: true }) }
  })

  // No OpenFOAM in the sandbox this was written in: this runs only where the solver (or OPENFOAM_BASHRC) is present.
  it.skipIf(!openfoamInstalled() || !process.env.TRACE_THERMAL_CFD_TESTS)('a real run: the vertical plate against Churchill & Chu within 15 % at two mesh levels', async () => {
    const r = await call('thermal.validate', { solver: 'cfd', remote: 'never' })
    for (const row of r.rows) expect(Math.abs(row.error_pct)).toBeLessThanOrEqual(15)
  }, 6 * 3600_000)
})


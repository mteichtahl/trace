/**
 * The sensor-node example (examples/sensor-node) run end to end through the tool registry, so it cannot rot: KiCad
 * checks, BOM, the calculators that chose its values, SPICE against those calculators, the Verilog testbench, and the
 * firmware target. It works on a temporary copy (kicad-cli writes .kicad_prl files beside a project it opens, and
 * every run is recorded in the copy's .trace/project.db).
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { load } from '../../src/core/config.js'
import { Work } from '../../src/core/store.js'
import { allTools } from '../../src/tools.js'

const SAMPLE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'sensor-node')
const has = (cmd: string): boolean => {
  try {
    execFileSync(cmd, [cmd === 'iverilog' ? '-V' : '--version'], { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch {
    return false
  }
}
const hasKicad = has('kicad-cli')
const hasNgspice = has('ngspice')
const hasIverilog = has('iverilog')
const hasMake = has('make') && has('cc')

type Dict = Record<string, unknown>
interface Measure { name: string; value: number | null }

const reg = allTools()
const call = async (name: string, args: Dict): Promise<Dict> => (await reg.call(name, args, { hardware: false, via: 'test' })) as Dict
const measure = (r: Dict, name: string): number => {
  const m = (r.measurements as Measure[]).find((x) => x.name === name)
  if (!m || m.value === null) throw new Error(`no measurement ${name}: ${JSON.stringify(r.measurements)}`)
  return m.value
}

let dir = ''
const cwd = process.cwd()
const envDb = process.env.TRACE_PROJECT_DB

beforeAll(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'sensor-node-')), 'sensor-node')
  cpSync(SAMPLE, dir, { recursive: true, filter: (src) => !/\.kicad_prl$|[\\/]build$/.test(src) })
  // the copy is the project: its settings and run record
  process.env.TRACE_PROJECT_DB = join(dir, '.trace', 'project.db')
  process.chdir(dir)
})

afterAll(() => {
  process.chdir(cwd)
  if (envDb === undefined) delete process.env.TRACE_PROJECT_DB
  else process.env.TRACE_PROJECT_DB = envDb
  rmSync(dirname(dir), { recursive: true, force: true })
})

describe('sensor-node: settings', () => {
  it('names the KiCad project, the model folder and the firmware target', () => {
    const cfg = load()
    expect(cfg.electronics.projects).toEqual(['hardware/sensor-node.kicad_pro'])
    expect(cfg.electronics.models).toEqual(['sim/models'])
    expect(cfg.firmware.targets.map((t) => [t.name, t.path, t.preset, t.build])).toEqual([['adc-convert', 'firmware', 'make', 'make all test']])
  })

  it('leaves the owner\'s rules empty', () => {
    expect(statSync(join(dir, '.trace', 'rules.md')).size).toBe(0)
  })
})

describe('sensor-node: the values come from the calculators', () => {
  it('calc.divider: 39k/13k gives 3.0 V from 12 V', async () => {
    const pick = await call('calc.divider', { vin: 12, vout: 3, series: 'E24' })
    expect((pick.candidates as Dict[])[0]).toMatchObject({ r1_ohm: 39000, r2_ohm: 13000, vout_v: 3 })
  })

  it('calc.rc_filter: 16k total with 10 nF is ~1 kHz; R3 6k2 plus the divider\'s 9.75k gives 998 Hz', async () => {
    const pick = await call('calc.rc_filter', { fc: 1000, c: 1e-8 })
    expect((pick.candidates as Dict[])[0]).toMatchObject({ r_ohm: 16000 })
    const div = await call('calc.divider', { vin: 12, r1: 39000, r2: 13000 })
    expect(div.r_thevenin_ohm).toBe(9750)
    const f = await call('calc.rc_filter', { r: 9750 + 6200, c: 1e-8 })
    expect(f.fc_hz as number).toBeCloseTo(997.84, 1)
  })

  it('calc.led_resistor: 680 ohm for about 2 mA', async () => {
    const r = await call('calc.led_resistor', { vsupply: 3.3, vf: 2.0, current: 0.002 })
    expect((r.candidates as Dict[])[0]).toMatchObject({ r_ohm: 680 })
  })
})

describe('sensor-node: the schematic and BOM (offline)', () => {
  it('kicad.components lists the ten parts with part numbers', async () => {
    const r = await call('kicad.components', {})
    expect((r.components as Dict[]).map((c) => c.ref)).toEqual(['C1', 'C2', 'D1', 'D2', 'J1', 'J2', 'R1', 'R2', 'R3', 'R4'])
    for (const c of r.components as Dict[]) {
      expect(c.mpn, `${String(c.ref)} MPN`).toBeTruthy()
      expect(c.manufacturer, `${String(c.ref)} manufacturer`).toBeTruthy()
      expect(c.lcsc, `${String(c.ref)} LCSC`).toMatch(/^C\d+$/)
    }
  })

  it('kicad.bom groups one line per part number', async () => {
    const r = await call('kicad.bom', { jlc: true })
    expect(r).toMatchObject({ total_parts: 10, unique_lines: 10, missing_part_number: 0, lines_without_lcsc: 0, excluded_total: 0 })
    const lines = (r.lines as Dict[]).map((l) => [(l.refs as string[]).join(','), l.value, l.mpn, l.lcsc])
    expect(lines).toEqual([
      ['C1', '10n', 'CL10B103KB8NNNC', 'C1589'],
      ['C2', '100n', 'CC0603KRX7R9BB104', 'C14663'],
      ['D1', 'BAT54S', 'BAT54S-7-F', 'C83574'],
      ['D2', 'RED', 'KT-0603R', 'C2286'],
      ['J1', 'SENSOR_IN', 'PZ254V-11-02P', 'C492401'],
      ['J2', 'MCU', 'PZ254V-11-04P', 'C2691448'],
      ['R1', '39k', '0603WAF3902T5E', 'C23153'],
      ['R2', '13k', '0603WAF1302T5E', 'C22797'],
      ['R3', '6k2', '0603WAF6201T5E', 'C4260'],
      ['R4', '680', '0603WAF6800T5E', 'C23228'],
    ])
  })

  it('kicad.board: 40 x 25 mm, two layers, a filled GND pour, every part placed', async () => {
    const r = await call('kicad.board', {})
    expect(r).toMatchObject({ outline: { width_mm: 40, height_mm: 25 }, copper_layers: 2, footprints: { total: 10 }, zones: { copper: 1 } })
    const len = await call('kicad.net_length', { nets: ['/ADC_IN', '/DIV', '/VIN'], from: 'R3.2', to: 'J2.3' })
    const adc = (len.nets as Dict[])[0]
    expect(adc?.unreached_pads).toEqual([])
    expect(len.path).toMatchObject({ from: 'R3.2', to: 'J2.3', vias: 0 })
  })
})

describe.skipIf(!hasKicad)('sensor-node: KiCad checks', () => {
  it('ERC: 0 errors and 0 warnings, nothing excluded', async () => {
    const r = await call('kicad.erc', {})
    expect(r).toMatchObject({ errors: 0, warnings: 0, excluded: 0 })
  })

  it('DRC with schematic parity: 0 errors, 0 unconnected, 0 parity issues', async () => {
    const r = await call('kicad.drc', {})
    expect(r).toMatchObject({ errors: 0, warnings: 0, unconnected: 0, parity_issues: 0 })
  })

  it('kicad.netlist: seven nets wired as drawn', async () => {
    const r = await call('kicad.netlist', {})
    const nets = Object.fromEntries((r.nets as Dict[]).map((n) => [n.name, (n.nodes as string[]).map((x) => x.replace(/\(.*\)$/, '')).sort()]))
    expect(nets).toEqual({
      '+3V3': ['C2.1', 'D1.2', 'J2.1'],
      '/ADC_IN': ['C1.1', 'D1.3', 'J2.3', 'R3.2'],
      '/DIV': ['R1.2', 'R2.1', 'R3.1'],
      '/LED': ['J2.4', 'R4.1'],
      '/LED_A': ['D2.2', 'R4.2'],
      '/VIN': ['J1.1', 'R1.1'],
      GND: ['C1.2', 'C2.2', 'D1.1', 'D2.1', 'J1.2', 'J2.2', 'R2.2'],
    })
  })
})

describe.skipIf(!hasNgspice)('sensor-node: SPICE against the calculators', () => {
  it('the divider\'s DC point matches calc.divider within 1 %', async () => {
    const calc = await call('calc.divider', { vin: 12, r1: 39000, r2: 13000 })
    const r = await call('sim.spice', { path: 'sim/front-end.cir', analyses: ['.op'],
      measurements: [{ name: 'vdiv', kind: 'value_at', vector: 'v(div)', analysis: 'op' }, { name: 'vadc', kind: 'value_at', vector: 'v(adc_in)', analysis: 'op' }] })
    const want = calc.vout_v as number
    expect(Math.abs(measure(r, 'vdiv') / want - 1)).toBeLessThan(0.01)
    expect(Math.abs(measure(r, 'vadc') / want - 1)).toBeLessThan(0.01)
  })

  it('the -3 dB point at mid-scale matches calc.rc_filter within 3 %', async () => {
    const calc = await call('calc.rc_filter', { r: 9750 + 6200, c: 1e-8 })
    const r = await call('sim.spice', { path: 'sim/front-end.cir', analyses: ['.op', '.ac dec 50 1 1meg'], params: { vin_dc: 6 },
      measurements: [{ name: 'f3db', kind: 'bandwidth', vector: 'v(adc_in)' }] })
    expect(Math.abs(measure(r, 'f3db') / (calc.fc_hz as number) - 1)).toBeLessThan(0.03)
  })

  it('the step response rises and settles as calc.rc_filter says', async () => {
    const calc = await call('calc.rc_filter', { r: 9750 + 6200, c: 1e-8 })
    const r = await call('sim.spice', { path: 'sim/front-end.cir', analyses: ['.tran 2u 5m'],
      measurements: [{ name: 'rise', kind: 'rise_time', vector: 'v(adc_in)' }, { name: 'settle', kind: 'settling', vector: 'v(adc_in)', from: 0.001, band: 0.01 }] })
    expect(Math.abs(measure(r, 'rise') / (calc.rise_10_90_s as number) - 1)).toBeLessThan(0.03)
    expect(Math.abs(measure(r, 'settle') / (calc.settle_time_s as number) - 1)).toBeLessThan(0.05)
  })

  it.skipIf(!hasKicad)('the schematic itself simulates to the same answer (sim.kicad_spice with overrides)', async () => {
    const r = await call('sim.kicad_spice', {
      schematic: 'hardware/sensor-node.kicad_sch', analyses: ['.op', '.ac dec 50 1 1meg'],
      replace: { J1: 'V1 /VIN 0 DC 6 AC 1', J2: 'V2 +3V3 0 DC 3.3', D1: 'XD1 GND +3V3 /ADC_IN BAT54S', D2: null, R4: null },
      measurements: [{ name: 'vadc', kind: 'value_at', vector: 'v(/adc_in)', analysis: 'op' }, { name: 'f3db', kind: 'bandwidth', vector: 'v(/adc_in)' }],
    })
    const hand = await call('sim.spice', { path: 'sim/front-end.cir', analyses: ['.op', '.ac dec 50 1 1meg'], params: { vin_dc: 6 },
      measurements: [{ name: 'vadc', kind: 'value_at', vector: 'v(adc_in)', analysis: 'op' }, { name: 'f3db', kind: 'bandwidth', vector: 'v(adc_in)' }] })
    expect(measure(r, 'vadc')).toBeCloseTo(measure(hand, 'vadc'), 6)
    expect(measure(r, 'f3db')).toBeCloseTo(measure(hand, 'f3db'), 3)
    expect(r.netlist).toMatchObject({ replaced: ['J1', 'D1', 'J2'], removed: ['R4', 'D2'] })
  })
})

describe.skipIf(!hasIverilog)('sensor-node: logic', () => {
  it('the moving-average testbench passes', async () => {
    const r = await call('sim.logic', { files: ['logic/moving_average.v', 'logic/moving_average_tb.v'], top: 'moving_average_tb', pass: 'ALL TESTS PASSED' })
    expect(r.passed).toBe(true)
    expect(r.output).toContain('checked 254 samples')
  })
})

describe.skipIf(!hasMake || !reg.get('firmware.build'))('sensor-node: firmware', () => {
  it('firmware.build runs make all test and passes', async () => {
    const r = await call('firmware.build', { target: 'adc-convert' })
    expect(r).toMatchObject({ ok: true, errors: 0, warnings: 0 })
    const log = new TextDecoder().decode(new Work().getArtifact(r.run_id as string, 'build.log') ?? new Uint8Array())
    expect(log).toContain('ALL TESTS PASSED')
  })

  it.skipIf(!hasKicad)('`trace check`\'s steps all pass: ERC, DRC and the firmware build', async () => {
    const results: [string, boolean][] = []
    for (const kind of ['kicad.erc', 'kicad.drc']) {
      const r = await call(kind, { project: join(dir, 'hardware/sensor-node.kicad_pro') })
      results.push([kind, r.errors === 0])
    }
    const fw = await call('firmware.build', { target: 'adc-convert' })
    results.push(['firmware.build', fw.ok === true])
    expect(results).toEqual([['kicad.erc', true], ['kicad.drc', true], ['firmware.build', true]])
  })
})

describe('sensor-node: the run record', () => {
  it('every tool run above is in the project database', () => {
    const kinds = new Set(new Work().runs(undefined, 200).map((r) => r.kind))
    expect(kinds.has('kicad.bom')).toBe(true)
    if (hasNgspice) expect(kinds.has('sim.spice')).toBe(true)
  })
})

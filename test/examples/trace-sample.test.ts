/**
 * The installer's sample project (templates/sample) run end to end through the tool registry, so it cannot rot: the
 * files as the installer commits them (sampleFiles: dot-x becomes .x), onboarded the way onboardSample does it
 * (core/onboard.ts detect + settingsFor + writeFiles with templates/sample/settings.json), seeded (seedSample), and then
 * every tool this machine can run, with the numbers the README and the tour quote. Each block skips cleanly when its
 * program (ngspice, iverilog, verilator, yosys, nextpnr, kicad-cli, ccx, cocotb, scikit-rf, pdfplumber) is missing.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { load, resolve as resolveSettings, setValue } from '../../src/core/config.js'
import { detect, settingsFor, writeFiles } from '../../src/core/onboard.js'
import { open, PROJECT_SCHEMA, Work } from '../../src/core/store.js'
import { checkSampleTests, SAMPLE_REQUIREMENTS, SAMPLE_TESTS, seedSample } from '../../src/installer/sample-seed.js'
import { sampleFiles, sampleSettings, tour } from '../../src/installer/sample.js'
import { getSpecs } from '../../src/tools/ams/spec.js'
import { listDevices } from '../../src/tools/protocol/spec.js'
import { getBudget, getCurves, getEnvelope, getPartLimits } from '../../src/tools/thermal/store.js'
import { VerifyDb } from '../../src/tools/verify/db.js'
import { allTools } from '../../src/tools/index.js'

const works = (cmd: string, args: string[]): boolean => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch {
    return false
  }
}
const PY = process.env.TRACE_PYTHON || 'python3'
const pyHas = (mod: string): boolean => works(PY, ['-c', `import ${mod}`])
const hasNgspice = works('ngspice', ['--version'])
const hasIverilog = works('iverilog', ['-V'])
const hasVerilator = works('verilator', ['--version'])
const hasYosys = works('yosys', ['-V'])
const hasNextpnr = works('nextpnr-ice40', ['--version']) && works('icepack', ['-h'])
const hasSmt = works('yosys-smtbmc', ['--help']) && (works('z3', ['--version']) || works('yices-smt2', ['--version']) || works('boolector', ['--version']))
const hasKicad = works('kicad-cli', ['version'])
const hasCcx = works('sh', ['-c', 'command -v ccx'])
const hasMake = works('make', ['--version']) && works('cc', ['--version'])
const hasCocotb = hasIverilog && pyHas('cocotb')
const hasSkrf = pyHas('skrf')
const hasPdf = pyHas('pdfplumber') && pyHas('pypdf')

type Dict = Record<string, any>
interface Measure { name: string; value: number | null }
const reg = allTools()
const call = async (name: string, args: Dict): Promise<Dict> => (await reg.call(name, args, { hardware: false, via: 'test' })) as Dict
const measure = (r: Dict, name: string): number => {
  const m = (r.measurements as Measure[]).find((x) => x.name === name)
  if (!m || m.value === null) throw new Error(`no measurement ${name}: ${JSON.stringify(r.measurements)}`)
  return m.value
}

let dir = ''
let lib = ''
let seeded: string[] = []
const cwd = process.cwd()
const envDb = process.env.TRACE_PROJECT_DB

beforeAll(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'trace-sample-'))
  dir = join(tmp, 'repo')
  lib = join(tmp, 'library')
  // the repository as pushSample commits it
  for (const f of sampleFiles()) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true })
    writeFileSync(join(dir, f.path), f.content)
  }
  // onboarding as onboardSample does it: the database first (it marks the project root), then tracectl onboard's files
  mkdirSync(join(dir, '.trace'), { recursive: true })
  const db = open(join(dir, '.trace', 'project.db'), { wal: false })
  db.exec(PROJECT_SCHEMA)
  db.close()
  const d = await detect(dir, 'main', () => '')
  writeFiles(dir, d, { ...settingsFor(d, 'sample-owner'), ...sampleSettings() })
  seeded = seedSample(dir)
  process.env.TRACE_PROJECT_DB = join(dir, '.trace', 'project.db')
  process.chdir(dir)
}, 60_000)

afterAll(() => {
  process.chdir(cwd)
  if (envDb === undefined) delete process.env.TRACE_PROJECT_DB
  else process.env.TRACE_PROJECT_DB = envDb
  rmSync(dirname(dir), { recursive: true, force: true })
})

// ------------------------------------------------------------------ the files, settings and seed

describe('trace-sample: onboarding and seed', () => {
  it('commits the dot-files under their real names and keeps installer-only files out', () => {
    const paths = sampleFiles().map((f) => f.path)
    expect(paths).toEqual(expect.arrayContaining(['.gitignore', '.trace/rules.md', 'README.md', 'docs/spec.md', 'hardware/trace-sample.kicad_pro', 'layout/trace-sample.kicad_pcb']))
    expect(paths.some((p) => p.includes('dot-') || p === 'tour.json')).toBe(false)
    expect(readFileSync(join(dir, '.trace', 'rules.md'), 'utf8')).toMatch(/fictional parts/)
  })

  it('every key in settings.json is a valid setting, set one by one as tracectl config set would', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'trace-sample-settings-'))
    try {
      mkdirSync(join(scratch, '.trace'))
      const db = open(join(scratch, '.trace', 'project.db'), { wal: false })
      db.exec(PROJECT_SCHEMA)
      db.close()
      const s = sampleSettings()
      for (const [k, v] of Object.entries(s)) setValue(k, v, scratch, 'test')
      expect(resolveSettings(s).errors).toEqual([])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('the onboarded project has the sample\'s settings, with the bench emulator\'s instruments', () => {
    const cfg = load(dir)
    expect(cfg.electronics.projects).toEqual(['hardware/trace-sample.kicad_pro'])
    expect(cfg.electronics.models).toEqual(['sim/models'])
    expect(cfg.electronics.autoroute.orthoroute_min_layers).toBe(2)
    expect(cfg.firmware.targets.map((t) => [t.name, t.path, t.preset, t.serial])).toEqual([['trace-sample-fw', 'firmware', 'make', 'bench-uart']])
    expect(cfg.hil.instruments.map((i) => [i.name, i.kind, i.address])).toEqual([
      ['bench-psu', 'psu', 'TCPIP::127.0.0.1::5555::SOCKET'], ['bench-scope', 'scope', 'TCPIP::127.0.0.1::5556::SOCKET'], ['bench-dmm', 'dmm', 'TCPIP::127.0.0.1::5557::SOCKET']])
    expect(cfg.hil.instruments[0]?.limits).toMatchObject({ max_voltage_v: 13, max_current_a: 0.1 })
    expect(cfg.hil.can).toEqual([expect.objectContaining({ name: 'bench-can', interface: 'virtual', channel: 'bench' })])
    expect(cfg.hil.serial[0]).toMatchObject({ name: 'bench-uart', baud: 115200 })
    expect(cfg.parts.providers).toEqual(['lcsc'])
    expect(cfg.worker.escalate_to).toBe('@sample-owner')
  })

  it('seeds requirements, a plan with every method, coverage, AMS and protocol specs and the thermal record', async () => {
    await checkSampleTests()
    expect(seeded).toHaveLength(6)
    const v = new VerifyDb(dir)
    try {
      expect(v.requirements().map((r) => r.id).sort()).toEqual(SAMPLE_REQUIREMENTS.map((r) => r.id).sort())
      expect(new Set(v.requirements().map((r) => r.kind))).toEqual(new Set(['functional', 'electrical', 'timing', 'emc']))
      const tests = v.tests()
      expect(tests).toHaveLength(SAMPLE_TESTS.length)
      expect(new Set(tests.map((t) => t.method))).toEqual(new Set(['sim', 'formal', 'spice', 'hil', 'inspection', 'drc']))
      // every requirement has a test, and the spec file names every requirement
      const spec = readFileSync(join(dir, 'docs', 'spec.md'), 'utf8')
      for (const r of v.requirements()) {
        expect(tests.some((t) => t.requirements.includes(r.id)), r.id).toBe(true)
        expect(spec, r.id).toContain(`**${r.id}**`)
      }
      expect(v.points()).toHaveLength(8)
    } finally {
      v.close()
    }
    expect(getSpecs('front-end').map((s) => s.measure)).toEqual(['f3db', 'vadc_mid'])
    expect(getSpecs('buffer').map((s) => s.measure).sort()).toEqual(['gbw_hz', 'phase_margin_deg', 'slew_rise_v_per_us'])
    const devices = listDevices()
    expect(devices.map((d) => d.device).sort()).toEqual(['TRC-TMP1', 'sample-console', 'sample-status'])
    for (const d of devices) expect(d.unverified, d.device).toBe(d.parameters)
    expect(getEnvelope('enclosure')).toMatchObject({ ambient_min_c: 0, ambient_max_c: 50, environment: 'natural', orientation: 'vertical' })
    expect(getPartLimits('enclosure').map((p) => p.ref).sort()).toEqual(['R1', 'R2', 'U1', 'U2'])
    expect(getBudget('nominal').find((b) => b.ref === 'U1')?.power_w).toBeCloseTo(0.43758, 4)
    expect(getCurves('U1')).toHaveLength(1)
  })

  it('seeding twice changes nothing', () => {
    const v = new VerifyDb(dir)
    const before = [v.requirements().length, v.tests().length, v.points().length]
    v.close()
    seedSample(dir)
    const w = new VerifyDb(dir)
    try {
      expect([w.requirements().length, w.tests().length, w.points().length]).toEqual(before)
    } finally {
      w.close()
    }
  })

  it('the tour is the installer\'s and names real files', () => {
    expect(tour().length).toBe(20)
  })

  it('verify.requirements extract finds the spec\'s requirements', async () => {
    const r = await call('verify.requirements', { action: 'extract', path: 'docs/spec.md' })
    const text = (r.candidates as Dict[]).map((c) => c.text as string).join('\n')
    for (const id of ['REQ-PWR-001', 'REQ-ANA-002', 'REQ-IF-001', 'REQ-THM-001']) {
      const req = SAMPLE_REQUIREMENTS.find((x) => x.id === id)!
      expect(text, id).toContain(req.text.slice(0, 30))
    }
  })
})

// ------------------------------------------------------------------ calculators and parts data (offline)

describe('trace-sample: the values come from the calculators', () => {
  it('divider, filter, I2C pull-up, LDO', async () => {
    expect((await call('calc.divider', { vin: 12, vout: 3, series: 'E24' })).candidates[0]).toMatchObject({ r1_ohm: 39000, r2_ohm: 13000 })
    expect((await call('calc.rc_filter', { r: 15950, c: 1e-8 })).fc_hz).toBeCloseTo(997.84, 1)
    const pu = await call('calc.i2c_pullup', { vdd: 3.3, capacitance: 50e-12, mode: 'fast' })
    expect(pu.rp_max_ohm).toBeGreaterThan(4700)
    const ldo = await call('calc.ldo_thermal', { vin: 12, vout: 3.3, current: 0.0434, iq: 0.005, theta_ja: 90, ambient: 50 })
    expect(ldo.power_w).toBeCloseTo(0.43758, 4)
    expect(ldo.tj_c).toBeCloseTo(89.38, 1)
  })

  it('the board: 60 x 40 mm, 2 layers, 17 parts, the ADC line and the length rules', async () => {
    expect(await call('kicad.board', {})).toMatchObject({ outline: { width_mm: 60, height_mm: 40 }, copper_layers: 2, footprints: { total: 17 } })
    const comps = (await call('kicad.components', {})).components as Dict[]
    for (const c of comps) expect(c.lcsc, String(c.ref)).toMatch(/^C\d+$/)
    const len = await call('kicad.net_length', { nets: ['/ADC_IN'] })
    expect(len.nets[0].length_mm).toBeCloseTo(38.88, 1)
    const lm = await call('pcb.length_match', { project: 'hardware/trace-sample.kicad_pro', groups: [{ name: 'i2c', nets: ['/SDA', '/SCL'], tolerance_mm: 5 }] })
    expect(lm.passed).toBe(true)
    expect(lm.dru_rules.map((r: Dict) => r.name)).toEqual(['adc line length', 'header bus length'])
    const fp = await call('pcb.floorplan', { blocks: [{ name: 'power', refs: ['U1', 'C3', 'C4'] }] })
    expect(fp.blocks[0].count).toBe(3)
    expect((await call('pcb.placement_check', {})).passed).toBe(true)
    const plan = await call('pcb.autoroute', { project: 'layout/trace-sample.kicad_pcb', plan_only: true, engine: 'both' })
    expect(plan.plan.stages).toEqual(['orthoroute', 'freerouting'])
  })

  it('EMC without a solver: precheck, spectrum and the field-solver setup', async () => {
    const pre = await call('emc.precheck', { board: 'hardware/trace-sample.kicad_pcb' })
    expect(pre.counts.error).toBe(0)
    const sp = await call('emc.spectrum', { signal: { amplitude: 3.3, freq_hz: 400000, rise_s: 2e-7 }, dm: { loop_area_mm2: 200 }, fmin: 30e6, fmax: 1e9, cispr_class: 'B' })
    expect(Math.min(...(sp.harmonics as Dict[]).map((h) => h.dm_margin_db as number))).toBeGreaterThan(6)
    const setup = await call('emc.setup', { board: 'hardware/trace-sample.kicad_pcb', nets: ['/ADC_IN'], ports: [{ at: 'U2.1' }, { at: [153, 119.24], layer: 'F.Cu' }], fstop: 1e9, points: 200 })
    expect(setup.summary.ports).toHaveLength(2)
    expect(setup.summary.vias).toBe(4)
  })

  it('protocols: the captures decode and pass', async () => {
    const i2c = await call('sim.wave_decode', { file: 'protocol/i2c-tmp1-read.vcd', protocol: 'i2c', signals: { scl: 'scl', sda: 'sda' }, speed: 'fast' })
    expect(i2c.items[1]).toMatchObject({ addr: '0x48', rw: 'R', data: ['0x0c', '0x80'] })
    const uart = await call('sim.wave_decode', { file: 'protocol/uart-console.csv', protocol: 'uart', signals: { rx: 'tx' }, baud: 115200 })
    expect(uart.text).toMatch(/^adc raw=3722 mv=11998/)
    const can = await call('sim.wave_decode', { file: 'protocol/can-status.vcd', protocol: 'can', signals: { can: 'can' }, bitrate: 500000 })
    expect(can.items[0]).toMatchObject({ id: '0x321', data: ['0x0e', '0x8a', '0x2e', '0xde'], crc_ok: true })
    const tm = await call('sim.wave_timing', { file: 'protocol/i2c-tmp1-read.vcd', checks: [{ kind: 'pulse', signal: 'scl', min_high: 0.6e-6, min_low: 1.3e-6 }] })
    expect(tm.pass).toBe(true)
    for (const [file, args] of [['protocol/i2c-tmp1-read.vcd', { protocol: 'i2c', standard: 'fast', device: 'TRC-TMP1' }], ['protocol/uart-console.csv', { protocol: 'uart', signals: { rx: 'tx' }, baud: 115200 }]] as const) {
      expect((await call('protocol.check', { file, ...args })).pass, file).toBe(true)
    }
  })

  it('thermal: the stored budget on the board (2.5D), the junctions, the bench log', async () => {
    const j = await call('thermal.junction', { envelope: 'enclosure', scenario: 'nominal' })
    const u1 = (j.results as Dict[]).filter((r) => r.ref === 'U1')
    expect(u1.map((r) => r.status)).toEqual(['pass', 'pass', 'pass'])
    expect(u1.at(-1)?.tj_c).toBeCloseTo(89.38, 1)
    const b = await call('thermal.board', { envelope: 'enclosure', scenario: 'nominal', board: 'hardware/trace-sample.kicad_pcb', cell_mm: 2, ambient_c: 25, transient: { duration_s: 1800, dt_s: 30 } })
    const steady = (b.parts as Dict[]).find((p) => p.ref === 'U1')!.board_c as number
    expect(steady).toBeGreaterThan(55)
    expect(steady).toBeLessThan(72)
    expect(Math.abs(b.energy.balance_error)).toBeLessThan(1e-3)
    const log = readFileSync('thermal/u1-bench-log.csv', 'utf8').split('\n').filter((l) => /^\d/.test(l)).map((l) => l.split(',').map(Number))
    const cmp = await call('thermal.compare', { a: { run: b.run_id, column: 'U1' }, b: { column: 'u1_tab_c', points: log.map((r) => [r[0], r[1]]) } })
    expect(Math.abs(cmp.end_diff_c)).toBeLessThan(5)
    expect((await call('thermal.derating', { action: 'check', ref: 'U1', curve: 'power_vs_ambient', x: 50, y: 0.438 })).status).toBe('pass')
    expect((await call('thermal.validate', { solver: '2.5d', cases: ['slab'] })).rows.every((r: Dict) => r.pass)).toBe(true)
  }, 60_000)
})

// ------------------------------------------------------------------ with the simulators

describe.skipIf(!hasNgspice)('trace-sample: analog', () => {
  it('front end: 2.995 V at 12 V, 994 Hz at mid-scale, 0.35 ms rise; the schematic agrees', async () => {
    const full = await call('sim.spice', { path: 'sim/front-end.cir', analyses: ['.op', '.tran 2u 5m'],
      measurements: [{ name: 'vadc', kind: 'value_at', vector: 'v(adc_in)', analysis: 'op' }, { name: 'rise', kind: 'rise_time', vector: 'v(adc_in)', analysis: 'tran' }] })
    expect(measure(full, 'vadc')).toBeCloseTo(2.995, 2)
    expect(measure(full, 'rise')).toBeCloseTo(0.000349, 5)
    const m = await call('sim.measure', { run_id: full.run_id, measurements: [{ name: 'settle', kind: 'settling', vector: 'v(adc_in)', analysis: 'tran', from: 0.001, band: 0.01 }] })
    expect(measure(m, 'settle')).toBeLessThan(0.001)
    const mid = await call('sim.spice', { path: 'sim/front-end.cir', params: { vin_dc: 6 }, analyses: ['.op', '.ac dec 50 1 1meg'], measurements: [{ name: 'f3db', kind: 'bandwidth', vector: 'v(adc_in)' }] })
    expect(measure(mid, 'f3db')).toBeCloseTo(993.6, 0)
    if (hasKicad) {
      const k = await call('sim.kicad_spice', { schematic: 'hardware/trace-sample.kicad_sch', analyses: ['.op', '.ac dec 50 1 1meg'],
        replace: { J1: 'V1 /VIN 0 DC 6 AC 1', U1: 'VU1 +3V3 0 DC 3.3', D1: 'XD1 GND +3V3 /FILT BAT54S', U2: 'XU2 /FILT /ADC_IN +3V3 GND /ADC_IN TRC_OPA1', J2: null, J3: null, D2: null, R4: null },
        measurements: [{ name: 'vadc', kind: 'value_at', vector: 'v(/adc_in)', analysis: 'op' }, { name: 'f3db', kind: 'bandwidth', vector: 'v(/adc_in)' }] })
      expect(measure(k, 'vadc')).toBeCloseTo(1.5, 3)
      expect(measure(k, 'f3db')).toBeCloseTo(measure(mid, 'f3db'), 1)
    }
  })

  it('sweep and Monte Carlo of the divider', async () => {
    const s = await call('sim.sweep', { path: 'sim/front-end.cir', analyses: ['.op'], axes: [{ param: 'vin_dc', values: [3, 6, 9, 12] }], measurements: [{ name: 'vadc', kind: 'value_at', vector: 'v(adc_in)', analysis: 'op' }] })
    expect((s.rows as Dict[]).map((r) => Math.round(r.vadc * 100) / 100)).toEqual([0.75, 1.5, 2.25, 3])
    const mc = await call('sim.montecarlo', { path: 'sim/front-end.cir', analyses: ['.op'], measurements: [{ name: 'vadc', kind: 'value_at', vector: 'v(adc_in)', analysis: 'op' }], tolerances: [{ ref: 'R1', tol: 0.01 }, { ref: 'R2', tol: 0.01 }], runs: 40, seed: 7 })
    expect(mc.stats[0].min).toBeGreaterThan(2.95)
    expect(mc.stats[0].max).toBeLessThan(3.05)
  })

  it('AMS: corners against the seeded spec set, yield, the buffer, noise', async () => {
    const c = await call('ams.corners', { path: 'sim/front-end-corners.cir', spec_set: 'front-end',
      measurements: [{ name: 'vadc_mid', kind: 'value_at', vector: 'v(adc_in)', analysis: 'op' }, { name: 'f3db', kind: 'bandwidth', vector: 'v(adc_in)' }],
      model_corners: [{ name: 'tt', lib: { section: 'tt' } }, { name: 'ff', lib: { section: 'ff' } }, { name: 'ss', lib: { section: 'ss' } }],
      supplies: [{ param: 'vdd', nominal: 3.3, tol: 0.05 }], temps: [-20, 25, 70] })
    expect(c).toMatchObject({ pass: true, corners: 27 })
    expect(c.worst.find((w: Dict) => w.measure === 'f3db').value).toBeCloseTo(902.5, 0)
    const y = await call('ams.montecarlo_yield', { path: 'sim/front-end.cir', params: { vin_dc: 6 }, analyses: ['.op', '.ac dec 50 1 1meg'], spec_set: 'front-end',
      measurements: [{ name: 'vadc_mid', kind: 'value_at', vector: 'v(adc_in)', analysis: 'op' }, { name: 'f3db', kind: 'bandwidth', vector: 'v(adc_in)' }],
      tolerances: [{ ref: 'R1', tol: 0.01 }, { ref: 'R2', tol: 0.01 }, { ref: 'R3', tol: 0.01 }, { ref: 'C1', tol: 0.1 }], runs: 60, seed: 42 })
    expect(y.yield).toBe(1)
    const op = await call('ams.opamp_check', { path: 'sim/models/TRC_OPA1.lib', name: 'TRC_OPA1', pins: ['inp', 'inn', 'vcc', 'vee', 'out'], vcc: 3.3, vee: 0, rl: 1e6, cl: 10e-12, spec_set: 'buffer' })
    expect(op.loop.phase_margin_deg).toBeCloseTo(76.2, 0)
    expect(op.aol.gbw_hz).toBeGreaterThan(0.95e6)
    expect(op.slew.rise_v_per_us).toBeCloseTo(0.595, 2)
    expect(op.pass).toBe(true)
    const n = await call('ams.noise', { path: 'sim/noise.cir', output: 'adc_in', source: 'V1', fstart: 1, fstop: 1e6, spot: [1000] })
    expect(n.output_noise_vrms).toBeCloseTo(26e-6, 6)
    expect(n.contributors[0].device).toBe('r.xu2.rn')
  })

  it('power: the LDO budget from its operating point, and the I2C bus edges', async () => {
    const b = await call('thermal.budget', { spice: { file: 'power/ldo.cir', devices: [{ ref: 'U1', device: 'U1', vector: 'v(p_u1)', rail: 'VIN' }, { ref: 'R1', device: 'R1', rail: 'VIN' }] } })
    expect(b.lines[0].power_w).toBeCloseTo(0.43758, 4)
    const bus = await call('protocol.bus_analog', { kind: 'open_drain', vdd: 3.3, rp: 4700, cb: 50e-12, speed: 'fast' })
    expect(bus.measured.t_r).toBeCloseTo(199e-9, 8)
    expect(bus.checks.every((c: Dict) => c.pass)).toBe(true)
  })

  it.skipIf(!hasVerilator)('mixed signal: the front end into the moving average (d_cosim when available)', async () => {
    const r = await call('ams.mixed', { path: 'sim/front-end.cir', verilog: ['logic/moving_average.v'], top: 'moving_average', parameters: { WIDTH: 12 },
      adc: { input: 'adc_in', bits: 12, vref_v: 3.3, port: 'sample' }, clock: { port: 'clk', freq_hz: 10e3 }, drive: { valid: 1 }, tstop: 5e-3,
      measurements: [{ name: 'code_final', kind: 'final', vector: 'v(adc_code)' }, { name: 'avg_final', kind: 'final', vector: 'v(avg_code)' }], max_samples: 100 })
    const code = measure(r, 'code_final')
    expect(code).toBeGreaterThanOrEqual(3714)
    expect(code).toBeLessThanOrEqual(3718)
    if (r.cosim) expect(measure(r, 'avg_final')).toBe(code)
  }, 60_000)
})

describe.skipIf(!hasIverilog)('trace-sample: logic', () => {
  it('the moving average and the FPGA top pass their testbenches', async () => {
    const a = await call('sim.logic', { files: ['logic/moving_average.v', 'logic/moving_average_tb.v'], top: 'moving_average_tb', pass: 'ALL TESTS PASSED' })
    expect(a.passed).toBe(true)
    const t = await call('sim.logic', { files: ['logic/moving_average.v', 'logic/spi_adc_slave.v', 'logic/sample_top.v', 'logic/sample_top_tb.v'], top: 'sample_top_tb', pass: 'ALL TESTS PASSED' })
    expect(t.passed).toBe(true)
    expect(t.output).toEqual(expect.arrayContaining(['TRACE_COVER avg_settled', 'TRACE_COVER led_on', 'TRACE_COVER uart_report']))
    const w = await call('sim.wave_read', { run_id: t.run_id, signals: ['sample_top_tb.tx'] })
    expect(w.signal_count).toBeGreaterThan(0)
  })

  it.skipIf(!hasVerilator)('verilator lints the FPGA top clean of errors', async () => {
    const r = await call('verify.verilator', { files: ['logic/moving_average.v', 'logic/sample_top.v'], top: 'sample_top', mode: 'lint' })
    expect(r.passed).toBe(true)
    expect(r.lint.errors).toBe(0)
  })

  it.skipIf(!hasCocotb)('cocotb: three tests pass', async () => {
    const r = await call('verify.cocotb', { files: ['logic/moving_average.v'], top: 'moving_average', modules: ['logic/test_moving_average.py'] })
    expect(r.reason).toMatch(/3 passed/)
  }, 60_000)

  it.skipIf(!hasSmt)('formal: bmc passes and the cover is reached', async () => {
    const bmc = await call('verify.formal', { files: ['logic/moving_average.v', 'logic/moving_average_props.sv'], top: 'moving_average_props', mode: 'bmc', depth: 5 })
    expect(bmc.status).toBe('PASS')
  }, 60_000)

  it.skipIf(!hasYosys)('FPGA: yosys synthesis; nextpnr closes 12 MHz and icepack writes the bitstream', async () => {
    const s = await call('fpga.synth', { family: 'ice40', files: ['logic/moving_average.v', 'logic/sample_top.v'], top: 'sample_top' })
    expect(s.utilisation.resources.lut).toBeGreaterThan(150)
    expect(s.utilisation.resources.lut).toBeLessThan(260)
    if (!hasNextpnr) return
    const p = await call('fpga.pnr', { family: 'ice40', device: 'up5k', package: 'sg48', synth_run: s.run_id, constraints: 'fpga/sample_top.pcf', clocks: { clk: 12 } })
    expect(p.timing.closure).toBe('closed')
    expect(p.timing.clocks[0].achieved_mhz).toBeGreaterThan(30)
    expect((await call('fpga.timing', { run_id: p.run_id })).closure).toBe('closed')
    const bit = await call('fpga.bitstream', { family: 'ice40', run_id: p.run_id })
    expect(bit.run_id).toBeTruthy()
  }, 60_000)
})

describe.skipIf(!hasKicad)('trace-sample: KiCad', () => {
  it('ERC and DRC (with parity) are clean, and the fab package has every placement', async () => {
    expect(await call('kicad.erc', {})).toMatchObject({ errors: 0, warnings: 0 })
    expect(await call('kicad.drc', {})).toMatchObject({ errors: 0, unconnected: 0, parity_issues: 0 })
    const bom = await call('kicad.bom', { jlc: true })
    expect(bom).toMatchObject({ total_parts: 17, unique_lines: 15, missing_part_number: 0, lines_without_lcsc: 0 })
    const fab = await call('kicad.fab', { out_dir: 'build/fab' })
    expect(fab).toMatchObject({ placements: 17, warnings: [] })
    const net = await call('kicad.netlist', {})
    expect(net).toMatchObject({ nets_total: 12, components_total: 17, single_pin_nets: 0 })
  }, 60_000)
})

describe.skipIf(!hasCcx)('trace-sample: CalculiX', () => {
  it('agrees with the 2.5D model on U1\'s rise within 20 % (1 mm cells)', async () => {
    const a = { envelope: 'enclosure', scenario: 'nominal', board: 'hardware/trace-sample.kicad_pcb', cell_mm: 1, ambient_c: 25 }
    const two = await call('thermal.board', a)
    const fem = await call('thermal.board', { ...a, solver: 'calculix' })
    const rise = (r: Dict): number => (r.parts as Dict[]).find((p) => p.ref === 'U1')!.board_c - 25
    expect(Math.abs(rise(fem) / rise(two) - 1)).toBeLessThan(0.2)
  }, 120_000)
})

describe.skipIf(!hasSkrf)('trace-sample: signal integrity from the Touchstone file', () => {
  it('the 128 ohm line shows on a 50 ohm TDR; insertion loss to 500 MHz is under 2 dB', async () => {
    const r = await call('emc.si', { touchstone: 'emc/adc_in-line.s2p', z_target: 50, tol: 0.3, insertion_loss: [{ from: 1, to: 2, budget_db: 2, f_max: 5e8 }] })
    expect(r.ok).toBe(true)
    expect(r.insertion_loss[0].pass).toBe(true)
  })
})

describe.skipIf(!hasPdf)('trace-sample: the fictional datasheets', () => {
  it('datasheets read, protocol.spec_extract re-cites TRC-TMP1, the thermal limits come from TRC-OPA1', async () => {
    for (const mpn of ['TRC-OPA1', 'TRC-TMP1']) expect((await call('datasheets.add', { mpn, file: `docs/datasheets/${mpn}.pdf`, library: lib })).outcome).toBe('added')
    const p = await call('datasheets.params', { mpn: 'TRC-OPA1', query: 'gain-bandwidth', library: lib })
    expect(p.rows[0]).toMatchObject({ symbol: 'GBW', typ: '1.0', unit: 'MHz' })
    const x = await call('protocol.spec_extract', { mpn: 'TRC-TMP1', protocol: 'i2c', library: lib })
    expect((x.candidates as Dict[]).map((c) => c.parameter)).toEqual(expect.arrayContaining(['f_scl', 't_low', 'tsu_dat', 't_buf']))
    expect((x.candidates as Dict[]).find((c) => c.parameter === 'tsu_dat')?.min).toBeCloseTo(100e-9, 15)
    const env = await call('thermal.envelope', { action: 'from_datasheet', name: 'enclosure', ref: 'U2', mpn: 'TRC-OPA1', library: lib })
    expect(Object.fromEntries((env.proposals as Dict[]).map((q) => [q.field, q.value]))).toMatchObject({ tj_max_c: 150, theta_ja: 220 })
  }, 60_000)
})

describe.skipIf(!hasMake)('trace-sample: firmware', () => {
  it('detects the make target, builds and tests it, and sizes the image', async () => {
    expect((await call('firmware.detect', { path: 'firmware' })).targets[0]).toMatchObject({ name: 'trace-sample-fw', preset: 'make' })
    const b = await call('firmware.build', { target: 'trace-sample-fw' })
    expect(b).toMatchObject({ ok: true, errors: 0 })
    const log = new TextDecoder().decode(new Work().getArtifact(b.run_id as string, 'build.log') ?? new Uint8Array())
    expect(log).toContain('console line "adc raw=3722 mv=11998"')
    expect(log).toContain('ALL TESTS PASSED')
    const s = await call('firmware.size', { target: 'trace-sample-fw' })
    expect(s.text).toBeGreaterThan(0)
  }, 60_000)
})

describe('trace-sample: the seeded plan runs', () => {
  it.skipIf(!hasNgspice || !hasIverilog || !hasKicad || !hasMake)('verify.run on the items that need no hardware and no person: all pass', async () => {
    const ids = SAMPLE_TESTS.filter((t) => t.method !== 'hil' && t.method !== 'inspection' && !(t.tool === 'verify.cocotb' && !hasCocotb) && !(t.tool === 'verify.formal' && !hasSmt) && !(t.tool === 'fpga.synth' && !hasYosys)).map((t) => t.id)
    const r = await call('verify.run', { ids })
    expect({ fail: r.fail, error: r.error, blocked: r.blocked }).toEqual({ fail: 0, error: 0, blocked: 0 })
    expect(r.pass).toBe(ids.length)
  }, 120_000)

  it('hardware items are blocked without TRACE_HARDWARE', async () => {
    const r = await call('verify.run', { ids: ['TST-HIL-001'] })
    expect(r.blocked).toBe(1)
  })
})

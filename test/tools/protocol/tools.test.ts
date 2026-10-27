/**
 * The protocol tools through the registry: specs (stored, extracted from a reportlab datasheet fixture), checks of
 * model runs against the standard and a spec, the analog bus in ngspice against the RC closed forms, UM10204's
 * pull-up equations, the SPI timing budget against a hand calculation, diagrams, testbenches run in Icarus, captures
 * from a fake scope, and protocol checks as verify.run test items.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { bridge } from '../../../src/core/bridge.js'
import { setValue } from '../../../src/core/config.js'
import { ToolError } from '../../../src/core/registry.js'
import { merge } from '../../../src/core/dbmerge.js'
import { openProject, projectTables, Work } from '../../../src/core/store.js'
import { allTools } from '../../../src/tools/index.js'
import { FakeScpi } from '../hil/fake-scpi.js'
import { PYTHON } from '../datasheets/fixture.js'

type Obj = Record<string, unknown>
const reg = allTools()
const ctx = { hardware: false, via: 'test' } as const
const call = async (name: string, args: Obj, hardware = false): Promise<Obj> => (await reg.call(name, args, { ...ctx, hardware })) as Obj
const has = (cmd: string, arg = '--version'): boolean => {
  try { execFileSync(cmd, [arg], { stdio: 'ignore', timeout: 20_000 }); return true } catch { return false }
}
const hasNgspice = has('ngspice')
const hasIverilog = has('iverilog', '-V')
const rowOf = (r: Obj, p: string): Obj => {
  const row = (r.rows as Obj[]).find((x) => x.parameter === p)
  if (!row) throw new Error(`no row ${p}: ${JSON.stringify(r.rows)}`)
  return row
}

afterAll(() => bridge().close())

const timingPdf = (): string => {
  const out = join(mkdtempSync(join(tmpdir(), 'trace-tpdf-')), 'tpx7705.pdf')
  execFileSync(PYTHON, [join(import.meta.dirname, '..', '..', '..', 'python', 'tests', 'fixture_pdf.py'), out, 'timing'])
  return out
}

describe('protocol.spec', () => {
  it('stores SI values from the units given, marks citations without part/sha256/page unverified, refuses unknown parameters', async () => {
    const r = await call('protocol.spec', {
      action: 'set', device: 'adc-x', protocol: 'spi', rows: [
        { parameter: 'f_sck', max: 20, unit: 'MHz', citation: { source: 'typed in from a PDF on a desk' } },
        { parameter: 'tsu', min: 5, unit: 'ns', citation: { source: 'X datasheet', mpn: 'X', sha256: 'a'.repeat(64), page: 7 } },
        { parameter: 'modes', value: [0, 3], citation: { source: 'X datasheet' } },
      ],
    })
    expect(r.unverified).toEqual(['f_sck', 'modes'])
    const g = await call('protocol.spec', { action: 'get', device: 'adc-x' })
    const rows = g.rows as Obj[]
    expect(rows.find((x) => x.parameter === 'f_sck')).toMatchObject({ max: 20e6, unit: 'Hz' })
    expect(rows.find((x) => x.parameter === 'tsu')).toMatchObject({ min: 5e-9, unit: 's', citation: { verified: true, page: 7 } })
    await expect(call('protocol.spec', { action: 'set', device: 'adc-x', protocol: 'spi', rows: [{ parameter: 'tsetup', min: 1, unit: 'ns', citation: { source: 's' } }] })).rejects.toThrow(/no parameter "tsetup"/)
    await expect(call('protocol.spec', { action: 'set', device: 'adc-x', protocol: 'spi', rows: [{ parameter: 'tsu', min: 1, unit: 'nanos', citation: { source: 's' } }] })).rejects.toThrow(/unit "nanos"/)
    expect(((await call('protocol.spec', { action: 'list' })).devices as Obj[]).some((d) => d.device === 'adc-x')).toBe(true)
    expect(projectTables().some((x) => x.table === 'protocol_specs')).toBe(true)
  })

  it('tracectl db merge keeps the newer protocol_specs row and the union of the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-proto-merge-'))
    const mk = (name: string, rows: [string, number, number][]): string => {
      const p = join(dir, name, '.trace', 'project.db')
      const prev = process.env.TRACE_PROJECT_DB
      process.env.TRACE_PROJECT_DB = p
      const db = openProject()
      for (const [param, min, t] of rows) db.prepare("INSERT INTO protocol_specs (device, protocol, parameter, min, unit, citation, updated) VALUES ('d','spi',?,?,'s','{}',?)").run(param, min, t)
      db.close()
      process.env.TRACE_PROJECT_DB = prev
      return p
    }
    const base = mk('base', [['tsu', 1, 1]])
    const ours = mk('ours', [['tsu', 2, 2], ['th', 5, 2]])
    const theirs = mk('theirs', [['tsu', 3, 3], ['tcss', 7, 3]])
    expect(merge(base, ours, theirs)).toEqual([])
    const prev = process.env.TRACE_PROJECT_DB
    process.env.TRACE_PROJECT_DB = ours
    const db = openProject()
    const rows = db.prepare('SELECT parameter, min FROM protocol_specs ORDER BY parameter').all()
    db.close()
    process.env.TRACE_PROJECT_DB = prev
    expect(rows.map((x) => [x.parameter, x.min])).toEqual([['tcss', 7], ['th', 5], ['tsu', 3]])
  })
})

describe('protocol.spec_extract on a reportlab datasheet', () => {
  const lib = mkdtempSync(join(tmpdir(), 'trace-lib-'))
  it('proposes I2C and SPI specs by symbol rules, with page citations; unparsed rows come back raw', async () => {
    await call('datasheets.add', { mpn: 'TPX7705', file: timingPdf(), library: lib })
    const i2c = await call('protocol.spec_extract', { mpn: 'TPX7705', protocol: 'i2c', library: lib })
    const c = i2c.candidates as Obj[]
    const by = (p: string): Obj => c.find((x) => x.parameter === p) as Obj
    expect(by('tsu_dat')).toMatchObject({ min: 1e-7, unit: 's', page: 2, symbol: 'tSU;DAT' })
    expect(by('tsu_sta')).toMatchObject({ min: 6e-7, symbol: 't SU:STA' })
    expect(by('thd_dat')).toMatchObject({ min: 0, max: 9e-7, symbol: 'tHD(DAT)' })
    expect(by('f_scl')).toMatchObject({ max: 400e3, unit: 'Hz' })
    expect(by('c_b')).toMatchObject({ max: 4e-10, unit: 'F' })
    expect(by('t_buf').citation).toMatchObject({ mpn: 'TPX7705', page: 2 })
    expect((by('t_buf').citation as Obj).sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(c.map((x) => x.parameter).sort()).toEqual(['c_b', 'f_scl', 't_buf', 't_high', 't_low', 'thd_dat', 'thd_sta', 'tsu_dat', 'tsu_sta', 'tsu_sto'])
    expect((i2c.unparsed as Obj[]).map((x) => x.parameter)).toEqual(['t_sp'])
    // the SPI table is on page 3 (page 2's tLOW / tHIGH would read as SCK low / high times)
    const spi = await call('protocol.spec_extract', { mpn: 'TPX7705', protocol: 'spi', pages: [3], library: lib })
    const s = spi.candidates as Obj[]
    expect(Object.fromEntries(s.map((x) => [x.parameter, x.min ?? x.max]))).toEqual({ f_sck: 2e7, tcss: 1e-8, tcsh: 1e-8, tcsd: 5e-8, tsu: 5e-9, th: 5e-9, tv: 2e-8, tho: 2e-9 })
    expect((spi.unparsed as Obj[])[0]).toMatchObject({ parameter: 'tdis', reason: expect.stringMatching(/furlongs/) })
    // the agent confirms: store the candidates with their citations, and they are verified
    const rows = s.map((x) => ({ parameter: x.parameter, ...(x.min !== undefined ? { min: x.min } : {}), ...(x.max !== undefined ? { max: x.max } : {}), unit: x.unit, citation: x.citation }))
    const st = await call('protocol.spec', { action: 'set', device: 'TPX7705', protocol: 'spi', rows: [...rows, { parameter: 'modes', value: [0, 3], citation: { source: 'TPX7705 p.3 timing diagram (fixture)' } }] })
    expect(st.unverified).toEqual(['modes'])
    const ir = c.filter((x) => x.duplicate_of === undefined).map((x) => ({ parameter: x.parameter, ...(x.min !== undefined ? { min: x.min } : {}), ...(x.max !== undefined ? { max: x.max } : {}), unit: x.unit, citation: x.citation }))
    expect((await call('protocol.spec', { action: 'set', device: 'TPX7705', protocol: 'i2c', rows: ir })).unverified).toEqual([])
  })
})

describe('protocol.model and protocol.check', () => {
  it('a Fast-mode model passes UM10204; a too-short tLOW fails with the edge it was measured at', async () => {
    const m = await call('protocol.model', { protocol: 'i2c', config: { speed: 'fast' }, transactions: [{ addr: 0x50, write: [0x10], read: 2 }, { addr: 0x51, write: [1] }] })
    expect(m.roundtrip).toEqual({ match: true })
    expect(m.artifacts).toEqual(['model.vcd', 'model.csv', 'annotations.json'])
    const ok = await call('protocol.check', { run_id: m.run_id, protocol: 'i2c', standard: 'fast' })
    expect(ok.pass).toBe(true)
    expect(rowOf(ok, 't_low')).toMatchObject({ status: 'pass', source: 'UM10204 fast' })
    expect((rowOf(ok, 't_low').margin as number)).toBeGreaterThan(0)
    const bad = await call('protocol.model', { protocol: 'i2c', config: { speed: 'fast', t_low: 1.0e-6, t_high: 1.5e-6 }, transactions: [{ addr: 0x50, write: [0x10] }] })
    const ck = await call('protocol.check', { run_id: bad.run_id, protocol: 'i2c', standard: 'fast' })
    expect(ck.pass).toBe(false)
    const tl = rowOf(ck, 't_low')
    expect(tl).toMatchObject({ status: 'fail', measured: 1e-6, limit: { min: 1.3e-6 } })
    expect(tl.margin).toBeCloseTo(-0.3e-6, 12)
    expect((tl.at as Obj).transaction).toBe(0)
    expect((tl.at as Obj).t1 as number - ((tl.at as Obj).t0 as number)).toBeCloseTo(1e-6, 12)
    // recorded with per-parameter measurements and margins
    const w = new Work()
    const rec = w.run(ck.run_id as string)
    w.close()
    expect(rec?.kind).toBe('protocol.check')
    expect(rec?.measurements.find((x) => x.name === 't_low.margin')?.value).toBeCloseTo(-0.3e-6, 12)
  })

  it('an SPI model against a stored device spec: slave output too slow fails tV; mode outside the spec fails compatibility', async () => {
    await call('protocol.spec', { action: 'set', device: 'adc-y', protocol: 'spi', rows: [
      { parameter: 'tv', max: 20, unit: 'ns', citation: { source: 'fixture' } }, { parameter: 'tcss', min: 10, unit: 'ns', citation: { source: 'fixture' } },
      { parameter: 'f_sck', max: 10, unit: 'MHz', citation: { source: 'fixture' } }, { parameter: 'modes', value: [0, 3], citation: { source: 'fixture' } },
    ] })
    const good = await call('protocol.model', { protocol: 'spi', config: { mode: 0, f_sck: 5e6, tv_slave: 15e-9, t_css: 50e-9 }, transactions: [{ mosi: [0xa5], miso: [0x3c] }] })
    const g = await call('protocol.check', { run_id: good.run_id, protocol: 'spi', device: 'adc-y' })
    expect(g.pass).toBe(true)
    expect(rowOf(g, 'tv')).toMatchObject({ status: 'pass', measured: 1.5e-8 })
    const slow = await call('protocol.model', { protocol: 'spi', config: { mode: 0, f_sck: 5e6, tv_slave: 25e-9 }, transactions: [{ mosi: [0xa5], miso: [0x3c] }] })
    const s = await call('protocol.check', { run_id: slow.run_id, protocol: 'spi', device: 'adc-y' })
    expect(rowOf(s, 'tv')).toMatchObject({ status: 'fail', measured: 2.5e-8 })
    const m1 = await call('protocol.model', { protocol: 'spi', config: { mode: 1, f_sck: 5e6 }, transactions: [{ mosi: [1] }] })
    const c1 = await call('protocol.check', { run_id: m1.run_id, protocol: 'spi', device: 'adc-y', mode: 1 })
    expect(c1.pass).toBe(false)
    expect(((c1.modes as Obj).notes as string[])[0]).toMatch(/mode 1 is not one the responder supports/)
  })

  it('UART: a 4 % clock error fails the derived ±2.6 % mid-bit tolerance; 1 % passes', async () => {
    const run = async (err: number): Promise<Obj> => {
      const m = await call('protocol.model', { protocol: 'uart', config: { baud: 115200, baud_error: err }, transactions: [{ text: 'trace' }] })
      return call('protocol.check', { run_id: m.run_id, protocol: 'uart' })
    }
    const ok = await run(0.01)
    expect(ok.pass).toBe(true)
    expect(rowOf(ok, 'baud_error').measured).toBeCloseTo(1, 1)
    expect((rowOf(ok, 'baud_error').limit as Obj).max).toBeCloseTo(2.6316, 3)
    expect((await run(0.04)).pass).toBe(false)
  })

  it('1-Wire standard and overdrive models pass their own speed\'s limits', async () => {
    for (const speed of ['standard', 'overdrive']) {
      const m = await call('protocol.model', { protocol: 'onewire', config: { speed }, transactions: [{ reset: true, write: [0xcc, 0x44], read: [0x5a] }] })
      const c = await call('protocol.check', { run_id: m.run_id, protocol: 'onewire', standard: speed })
      expect(c.pass, JSON.stringify(c.rows)).toBe(true)
    }
  })

  it('sim.wave_decode reads the CAN, 1-Wire and I2S model runs', async () => {
    const can = await call('protocol.model', { protocol: 'can', config: { bitrate: 250e3 }, transactions: [{ id: 0x18fef100, extended: true, data: [1, 2, 3] }] })
    const d = await call('sim.wave_decode', { run_id: can.run_id, protocol: 'can', signals: { can: 'can' }, bitrate: 250e3 })
    expect((d.items as Obj[])[0]).toMatchObject({ id: '0x18fef100', extended: true, crc_ok: true, ack: true, data: ['0x01', '0x02', '0x03'] })
    const ow = await call('protocol.model', { protocol: 'onewire', transactions: [{ reset: true, write: [0x33] }] })
    expect(((await call('sim.wave_decode', { run_id: ow.run_id, protocol: 'onewire', signals: { dq: 'dq' } })).items as Obj[]).map((x) => x.value ?? x.kind)).toEqual(['reset', '0x33'])
    const i2s = await call('protocol.model', { protocol: 'i2s', transactions: [{ left: -2, right: 7 }] })
    expect((await call('sim.wave_decode', { run_id: i2s.run_id, protocol: 'i2s', signals: { sck: 'sck', ws: 'ws', sd: 'sd' } })).items).toEqual([expect.objectContaining({ left: -2, right: 7 })])
  })
})

describe.skipIf(!hasNgspice)('protocol.bus_analog and protocol.pullup (ngspice)', () => {
  it('open drain: the SPICE 30-70 % rise time is 0.8473 RpCb, and receiver delays reach the digital check', async () => {
    const r = await call('protocol.bus_analog', { kind: 'open_drain', vdd: 3.3, rp: 2.2e3, cb: 200e-12, speed: 'fast' })
    const tr = (r.measured as Obj).t_r as number
    expect(tr / (0.8473 * 2.2e3 * 200e-12) - 1).toBeLessThan(0.01)
    expect(Math.abs(r.t_r_vs_rc_pct as number)).toBeLessThan(1)
    // rising to VIH = 0.7 VDD takes ln(1/0.3) RC = 1.204 RC
    expect(((r.effective as Obj).rise_delay as number) / (Math.log(1 / 0.3) * 2.2e3 * 200e-12) - 1).toBeLessThan(0.01)
    expect((r.checks as Obj[]).find((c) => c.name === 't_r')).toMatchObject({ pass: false }) // 373 ns > 300 ns at Fast-mode
    const m = await call('protocol.model', { protocol: 'i2c', config: { speed: 'standard' }, transactions: [{ addr: 0x50, write: [0x0f] }] })
    const ck = await call('protocol.check', { run_id: m.run_id, protocol: 'i2c', standard: 'standard', analog_runs: [{ role: 'sda', run_id: r.run_id }, { role: 'scl', run_id: r.run_id }] })
    expect(rowOf(ck, 't_r')).toMatchObject({ status: 'pass', measured: expect.closeTo(tr, 12) })
    const bare = await call('protocol.check', { run_id: m.run_id, protocol: 'i2c', standard: 'standard' })
    // a slower rising edge on both lines makes the high phase shorter by rise_delay - fall_delay
    expect((rowOf(ck, 't_high').measured as number)).toBeLessThan(rowOf(bare, 't_high').measured as number)
  })

  it('push-pull RC: 10-90 % is 2.197 RC; a transmission line delays by length × delay per m', async () => {
    const rc = await call('protocol.bus_analog', { kind: 'push_pull', vdd: 3.3, r_drv: 1e3, c_in: 100e-12, t_edge: 0.1e-9 })
    expect(((rc.measured as Obj).t_r as number) / (2.1972 * 1e3 * 100e-12) - 1).toBeLessThan(0.01)
    const tl = await call('protocol.bus_analog', { kind: 'push_pull', vdd: 3.3, r_drv: 50, c_in: 2e-12, t_edge: 0.2e-9, trace: { model: 'tline', length_m: 0.2 }, impedance: { structure: 'microstrip', width: 0.3e-3, height: 0.2e-3, er: 4.3 }, stimulus: { pattern: '0101', bit_time: 20e-9 } })
    const lineDelay = (tl.expected as Obj).line_delay as number
    expect(lineDelay).toBeGreaterThan(1e-9)
    // the far end crosses VIH after the flight time (matched source: one trip)
    expect(((tl.effective as Obj).rise_delay as number)).toBeGreaterThan(lineDelay * 0.95)
    expect(((tl.effective as Obj).rise_delay as number)).toBeLessThan(lineDelay * 1.6)
  })

  it('RS-232: ±5.5 V into 5 kΩ and 1 nF meets the levels and the 30 V/µs slew limit; 50 V/µs does not', async () => {
    const ok = await call('protocol.bus_analog', { kind: 'rs232', rs232: { slew: 10e6 }, stimulus: { pattern: '0110', bit_time: 1 / 19200 } })
    expect(ok.pass, JSON.stringify(ok.checks)).toBe(true)
    expect((ok.checks as Obj[]).map((c) => c.name)).toEqual(['space_level', 'mark_level', 'slew'])
    const fast = await call('protocol.bus_analog', { kind: 'rs232', rs232: { slew: 50e6, c_cable: 50e-12 }, stimulus: { pattern: '01', bit_time: 1 / 19200 } })
    expect((fast.checks as Obj[]).find((c) => c.name === 'slew')).toMatchObject({ pass: false })
  })

  it('protocol.pullup: UM10204 equations 1 and 2, and the simulated pick', async () => {
    const std = await call('protocol.pullup', { vdd: 5, cb: 400e-12, mode: 'standard' })
    expect(std.rp_min_ohm).toBeCloseTo(4.6 / 3e-3, 6) // 1533 Ω
    expect(std.rp_max_ohm).toBeCloseTo(1e-6 / (0.8473 * 400e-12), 3) // 2950 Ω
    expect(std.citation).toMatchObject({ verified: null })
    const fast = await call('protocol.pullup', { vdd: 3.3, cb: 400e-12, mode: 'fast' })
    expect(fast.feasible).toBe(false) // 967 Ω > 885 Ω: no pull-up meets 300 ns at 400 pF from 3.3 V
    const sim = await call('protocol.pullup', { vdd: 3.3, cb: 100e-12, mode: 'fast', simulate: true })
    const s = sim.simulated as Obj
    expect(Math.abs((s.t_r as number) / (s.t_r_closed_form as number) - 1)).toBeLessThan(0.01)
    expect(s.pass).toBe(true)
  })
})

describe('protocol.compat', () => {
  it('reproduces the SPI hand calculation at 10 MHz and flags missing figures', async () => {
    const cite = { source: 'hand calculation fixture' }
    await call('protocol.spec', { action: 'set', device: 'mcu-m', protocol: 'spi', role: 'initiator', rows: [
      { parameter: 'tv', max: 5, unit: 'ns', citation: cite }, { parameter: 'tho', min: 1, unit: 'ns', citation: cite },
      { parameter: 'tsu_mi', min: 10, unit: 'ns', citation: cite }, { parameter: 'th_mi', min: 0, unit: 'ns', citation: cite },
      { parameter: 'f_sck', max: 50, unit: 'MHz', citation: cite }, { parameter: 'modes', value: [0, 1, 2, 3], citation: cite },
      { parameter: 'tcss', min: 30, unit: 'ns', citation: cite },
    ] })
    await call('protocol.spec', { action: 'set', device: 'adc-s', protocol: 'spi', rows: [
      { parameter: 'tsu', min: 5, unit: 'ns', citation: cite }, { parameter: 'th', min: 5, unit: 'ns', citation: cite },
      { parameter: 'tv', max: 20, unit: 'ns', citation: cite }, { parameter: 'tho', min: 2, unit: 'ns', citation: cite },
      { parameter: 'f_sck', max: 20, unit: 'MHz', citation: cite }, { parameter: 'modes', value: [0, 3], citation: cite },
      { parameter: 'tcss', min: 10, unit: 'ns', citation: cite },
    ] })
    const r = await call('protocol.compat', { protocol: 'spi', initiator: 'mcu-m', responder: 'adc-s', f: 10e6, flight: { sck: { delay: 1e-9 }, mosi: { delay: 1e-9 }, miso: { delay: 1e-9 } } })
    const slack = (name: string): number => ((r.rows as Obj[]).find((x) => String(x.check).startsWith(name))?.slack as Obj).bound as number
    // H = 50 ns. write setup 50 + 1 - (5 + 1) - 5 = 40; write hold 50 + 1 + 1 - 1 - 5 = 46; read setup 50 - (1 + 20 + 1) - 10 = 18;
    // read hold 50 + 1 + 2 + 1 - 0 = 54 (ns)
    expect(slack('write setup')).toBeCloseTo(40e-9, 15)
    expect(slack('write hold')).toBeCloseTo(46e-9, 15)
    expect(slack('read setup')).toBeCloseTo(18e-9, 15)
    expect(slack('read hold')).toBeCloseTo(54e-9, 15)
    expect(r.f_max_read).toBeCloseTo(0.5 / 32e-9, 0) // 15.625 MHz
    expect(slack('tcss')).toBeCloseTo(20e-9, 15)
    expect(r.pass).toBe(true)
    expect(r.skipped).toEqual(expect.arrayContaining(['t_sck_high the responder needs', 'tcsh: initiator gives, responder needs']))
    // at 20 MHz the read path fails (H = 25 ns < 32 ns)
    const fast = await call('protocol.compat', { protocol: 'spi', initiator: 'mcu-m', responder: 'adc-s', f: 20e6, flight: { sck: { delay: 1e-9 }, mosi: { delay: 1e-9 }, miso: { delay: 1e-9 } } })
    expect(fast.pass).toBe(false)
    // flight from a length and calc.impedance: delay = length × delay per m, ±10 %
    const ln = await call('protocol.compat', { protocol: 'spi', initiator: 'mcu-m', responder: 'adc-s', f: 10e6, impedance: { structure: 'microstrip', width: 0.25e-3, height: 1.51e-3, er: 4.5 }, flight: { sck: { length_m: 0.1 }, miso: { length_m: 0.1 } } })
    const fl = ln.flights as Record<string, { min: number; max: number }>
    expect(fl.sck?.max).toBeCloseTo(0.1 * 5.6757e-9 * 1.1, 13)
  })
})

describe('protocol.diagram', () => {
  it('draws a model run with its decode rows and a check\'s arrows, zooms to a transaction, writes WaveDrom JSON', async () => {
    const m = await call('protocol.model', { protocol: 'i2c', config: { speed: 'fast', t_low: 1.0e-6, t_high: 1.5e-6 }, transactions: [{ addr: 0x50, write: [0x10] }, { addr: 0x50, read: 1 }] })
    const ck = await call('protocol.check', { run_id: m.run_id, protocol: 'i2c', standard: 'fast' })
    const d = await call('protocol.diagram', { run_id: m.run_id, check_run_id: ck.run_id, transaction: 1, cursors: [{ t: 30e-6, label: 'here' }] })
    expect((d.panels as Obj[])[0]).toMatchObject({ lanes: ['scl', 'sda'] })
    expect(((d.panels as Obj[])[0] as Obj).arrows as number).toBeGreaterThan(3)
    const w = new Work()
    const svg = new TextDecoder().decode(w.getArtifact(d.run_id as string, 'diagram.svg') as Uint8Array)
    w.close()
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('ADDR 0x50 R')
    expect(svg).toContain('tLOW 1 µs (≥ 1.3 µs)')
    expect(svg).toContain('#cf222e') // the failing arrow is red
    const wd = JSON.parse(d.wavedrom as string) as { signal: { name: string; wave: string }[] }
    expect(wd.signal.map((s) => s.name)).toEqual(['scl', 'sda'])
    expect(wd.signal[0]?.wave).toMatch(/^[01.]+$/)
    expect(d.png).toSatisfy((p: Obj) => (typeof p.skipped === 'string' && /rasteriser/.test(p.skipped)) || typeof p.bytes === 'number')
  })

  it('spec mode draws the datasheet timing at the spec limits, and compares with a capture', async () => {
    const d = await call('protocol.diagram', { spec: { device: 'adc-y', protocol: 'spi' } })
    expect(((d.panels as Obj[])[0] as Obj).title).toMatch(/adc-y: SPI spec timing/)
    const w = new Work()
    const svg = new TextDecoder().decode(w.getArtifact(d.run_id as string, 'diagram.svg') as Uint8Array)
    w.close()
    expect(svg).toContain('tV ≤ 20 ns (spec, unverified)')
    expect(svg).toContain('tCSS ≥ 10 ns')
    const m = await call('protocol.model', { protocol: 'spi', config: { f_sck: 5e6, tv_slave: 15e-9 }, transactions: [{ mosi: [1], miso: [2] }] })
    const both = await call('protocol.diagram', { run_id: m.run_id, spec: { device: 'adc-y', protocol: 'spi' } })
    expect(both.panels as Obj[]).toHaveLength(2)
  })
})

describe.skipIf(!hasIverilog)('protocol.testbench (Icarus)', () => {
  const UART_RX = `module uart_rx #(parameter CLKS = 16) (input clk, input rx, output reg [7:0] data, output reg valid);
  reg [7:0] cnt = 0; reg [3:0] bits = 0; reg busy = 0; reg [7:0] sh = 0;
  initial begin valid = 0; data = 0; end
  always @(posedge clk) begin
    valid <= 0;
    if (!busy) begin if (!rx) begin busy <= 1; cnt <= CLKS + CLKS/2 - 1; bits <= 0; end end
    else if (cnt != 0) cnt <= cnt - 1;
    else if (bits < 8) begin sh <= {rx, sh[7:1]}; bits <= bits + 1; cnt <= CLKS - 1; end
    else begin busy <= 0; if (rx) begin data <= sh; valid <= 1; end end
  end
endmodule
`
  const I2C_TARGET = `module i2c_target #(parameter [6:0] ADDR = 7'h50) (input scl, input sda_in, output reg sda_low);
  reg [7:0] sh; reg [3:0] n; reg on, mine, rd, ack; reg [7:0] tx;
  initial begin sda_low = 0; on = 0; end
  always @(negedge sda_in) if (scl === 1'b1) begin on = 1; n = 0; mine = 0; rd = 0; ack = 0; sda_low = 0; end
  always @(posedge sda_in) if (scl === 1'b1) begin on = 0; sda_low = 0; end
  always @(posedge scl) if (on && !ack) begin sh = {sh[6:0], sda_in}; n = n + 1; end
  always @(negedge scl) if (on) begin
    if (ack) begin
      ack = 0; n = 0;
      if (rd && mine) begin tx = tx + 8'h11; sda_low = ~tx[7]; end else sda_low = 0;
    end else if (n == 8) begin
      if (!mine && !rd && sh[7:1] == ADDR) begin mine = 1; rd = sh[0]; sda_low = 1; ack = 1; if (rd) tx = 8'h3c - 8'h11; end
      else if (mine && !rd) begin sda_low = 1; ack = 1; end
      else begin sda_low = 0; ack = 1; end
      if (rd && mine) tx = tx;
    end else if (rd && mine) sda_low = ~tx[7 - n];
  end
endmodule
`
  it('UART: replays the TX line into an RX DUT and checks every byte', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-tb-'))
    const f = join(dir, 'uart_rx.v')
    ;(await import('node:fs')).writeFileSync(f, UART_RX)
    const baud = 1e6
    const r = await call('protocol.testbench', { protocol: 'uart', config: { baud }, transactions: [{ text: 'OK!' }], dut: { module: 'uart_rx', ports: { rx: 'rx', data: 'data', valid: 'valid' }, clock: { port: 'clk', hz: 16 * baud } }, run: true, dut_files: [f] })
    expect(r.passed, JSON.stringify(r.output)).toBe(true)
    const bad = await call('protocol.testbench', { protocol: 'uart', config: { baud: baud * 1.06 }, transactions: [{ text: 'OK!' }], dut: { module: 'uart_rx', ports: { rx: 'rx', data: 'data', valid: 'valid' }, clock: { port: 'clk', hz: 16 * baud } }, run: true, dut_files: [f] })
    expect(bad.passed).toBe(false)
  })

  it('I2C: a target DUT acknowledges its address and returns data; a wrong address is caught', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-tb-'))
    const f = join(dir, 'i2c_target.v')
    ;(await import('node:fs')).writeFileSync(f, I2C_TARGET)
    const dut = { module: 'i2c_target', ports: { scl: 'scl', sda_in: 'sda_in', sda_low: 'sda_low' } }
    const ok = await call('protocol.testbench', { protocol: 'i2c', config: { speed: 'fast' }, transactions: [{ addr: 0x50, write: [0x12, 0x34] }, { addr: 0x50, read: 2, read_data: [0x3c, 0x4d] }], dut, run: true, dut_files: [f] })
    expect(ok.passed, JSON.stringify(ok.output)).toBe(true)
    // the model expects an ACK from 0x51, which this target does not answer
    const bad = await call('protocol.testbench', { protocol: 'i2c', transactions: [{ addr: 0x51, write: [1] }], dut, run: true, dut_files: [f] })
    expect(bad.passed).toBe(false)
    expect((bad.output as string[]).join('\n')).toMatch(/MISMATCH/)
  })
})

describe('protocol.capture', () => {
  it('is hardware: refused without it', async () => {
    await expect(call('protocol.capture', { source: 'sigrok', roles: { scl: 'D0' } })).rejects.toThrow(/drives real hardware/)
  })

  it('says when sigrok-cli is not installed', async () => {
    if (has('sigrok-cli')) return
    await expect(call('protocol.capture', { source: 'sigrok', roles: { scl: 'D0', sda: 'D1' } }, true)).rejects.toThrow(/sigrok-cli is not installed/)
  })

  it('turns a scope capture into a VCD by threshold and decodes it', async () => {
    const fake = new FakeScpi('rigol-ds1104z')
    const addr = await fake.start()
    try {
      setValue('hil.instruments', [{ name: 'scope', kind: 'scope', address: addr }])
      const r = await call('protocol.capture', { source: 'scope', instrument: 'scope', roles: { sig: 'CH1' }, threshold: 0, scope: { fetch: [1] } }, true)
      const w = new Work()
      const vcd = new TextDecoder().decode(w.getArtifact(r.run_id as string, 'capture.vcd') as Uint8Array)
      w.close()
      const { parseVcdText } = await import('../../../src/tools/sim/wave.js')
      const s = parseVcdText(vcd).get('sig')
      // 1200 points at 5 µs: 6 ms of a 1 kHz square, so about 12 edges
      expect(s.edges('any').length).toBeGreaterThanOrEqual(10)
      expect(s.edges('any').length).toBeLessThanOrEqual(13)
      expect((r.evidence as string[]).length).toBe(1)
    } finally {
      await fake.stop()
    }
  })
})

describe('verify.run with a protocol check as a test item', () => {
  it('records the verdict and its evidence run', async () => {
    const m = await call('protocol.model', { protocol: 'i2c', config: { speed: 'fast' }, transactions: [{ addr: 0x50, write: [1, 2] }] })
    const req = await call('verify.requirements', { action: 'add', requirements: [{ text: 'The I2C bus meets UM10204 Fast-mode timing', kind: 'timing', acceptance: 'protocol.check pass, tLOW margin >= 0', source: 'UM10204 Table 10' }] })
    const reqId = (req.added as string[])[0] as string
    const plan = await call('verify.plan', { action: 'add', tests: [{ title: 'I2C fast-mode timing', requirements: [reqId], method: 'sim', tool: 'protocol.check', args: { run_id: m.run_id, protocol: 'i2c', standard: 'fast' }, expect: [{ measurement: 't_low.margin', min: 0 }] }] })
    const testId = (plan.added as string[])[0] as string
    const v = await call('verify.run', { ids: [testId] })
    const res = (v.results as Obj[])[0] as Obj
    expect(res.status).toBe('pass')
    expect((res.evidence as string[])[0]).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('the tools say what they are', () => {
  it('every protocol tool is registered, and only capture drives hardware', () => {
    const names = reg.list().filter((t) => t.name.startsWith('protocol.')).map((t) => t.name)
    expect(names).toEqual(['protocol.bus_analog', 'protocol.capture', 'protocol.check', 'protocol.compat', 'protocol.diagram', 'protocol.model', 'protocol.pullup', 'protocol.spec', 'protocol.spec_extract', 'protocol.testbench'])
    for (const n of names) expect(reg.get(n)?.hardware, n).toBe(n === 'protocol.capture')
  })

  it('a bad model input is a ToolError naming the field', async () => {
    await expect(call('protocol.model', { protocol: 'spi', config: { mode: 5 }, transactions: [{ mosi: [1] }] })).rejects.toBeInstanceOf(ToolError)
    await expect(call('protocol.model', { protocol: 'i2c', transactions: [{ addr: 200 }] })).rejects.toThrow(/out of range/)
  })
})

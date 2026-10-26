/**
 * examples/sensor-node section 7: the SPI ADC on ADC_IN, through the protocol tools on a temporary copy of the sample.
 * Its interface spec is in the sample's .trace/project.db as a marked fixture (no real SPI ADC datasheet is in the
 * shared library). The MCU's read is modelled, checked against the ADC's spec, budgeted against the MCU's spec,
 * drawn, and replayed into the Verilog DUT (logic/spi_adc_slave.v) by the committed, generated testbench.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Work } from '../../src/core/store.js'
import { allTools } from '../../src/tools/index.js'

const SAMPLE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'sensor-node')
type Obj = Record<string, unknown>
const reg = allTools()
const call = async (name: string, args: Obj): Promise<Obj> => (await reg.call(name, args, { hardware: false, via: 'test' })) as Obj
const hasIverilog = ((): boolean => { try { execFileSync('iverilog', ['-V'], { stdio: 'ignore' }); return true } catch { return false } })()

/** The MCU reads the ADC twice: command 0x8000 / 0x8001 out, the 12-bit code 3723 (12 V in, README section 4) back. */
export const READ = {
  protocol: 'spi',
  config: { mode: 0, bits: 16, f_sck: 1e6, tv_slave: 100e-9, tho_slave: 10e-9, t_css: 500e-9, t_csh: 500e-9, t_csd: 1e-6 },
  transactions: [{ mosi: [0x8000], miso: [0x0e8b] }, { mosi: [0x8001], miso: [0x0e8b] }],
}
const DUT = { module: 'spi_adc_slave', ports: { sck: 'sck', cs: 'cs_n', mosi: 'mosi', miso: 'miso' }, ties: { sample: "12'd3723" } }
const ADC = 'SPI-ADC-12 (fixture)'
const MCU = 'sensor-mcu (fixture)'

let dir = ''
const cwd = process.cwd()
const envDb = process.env.TRACE_PROJECT_DB

beforeAll(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'sensor-node-proto-')), 'sensor-node')
  cpSync(SAMPLE, dir, { recursive: true, filter: (src) => !/\.kicad_prl$|[\\/]build$/.test(src) })
  process.env.TRACE_PROJECT_DB = join(dir, '.trace', 'project.db')
  process.chdir(dir)
})

afterAll(() => {
  process.chdir(cwd)
  if (envDb === undefined) delete process.env.TRACE_PROJECT_DB
  else process.env.TRACE_PROJECT_DB = envDb
  rmSync(dirname(dir), { recursive: true, force: true })
})

describe('sensor-node: the SPI ADC', () => {
  it('the fixture specs are in the sample database, every figure marked unverified', async () => {
    const adc = await call('protocol.spec', { action: 'get', device: ADC })
    expect(adc.parameters).toBe(12)
    expect(adc.unverified).toBe(12)
    expect(((adc.rows as Obj[])[0]?.citation as Obj).source).toMatch(/^fixture: /)
    expect((await call('protocol.spec', { action: 'get', device: MCU })).parameters).toBe(9)
  })

  it('models the read, checks it against the ADC spec (and the MCU\'s modes), budgets it, and draws it', async () => {
    const m = await call('protocol.model', READ)
    expect(m.roundtrip).toEqual({ match: true })
    const ck = await call('protocol.check', { run_id: m.run_id, protocol: 'spi', device: ADC, initiator: MCU })
    expect(ck.pass).toBe(true)
    const row = (p: string): Obj => (ck.rows as Obj[]).find((r) => r.parameter === p) as Obj
    expect(row('tv')).toMatchObject({ status: 'pass', measured: 1e-7, margin: 2.5e-8 })
    expect(row('tcss')).toMatchObject({ status: 'pass', measured: 5e-7 })
    expect(row('f_sck')).toMatchObject({ status: 'pass', measured: 1e6 })
    expect(((ck.modes as Obj).notes as string[]).join(' ')).toMatch(/share mode\(s\) 0, 3/)
    // the budget at 1 MHz over 50 mm of 0.25 mm microstrip on the board's 1.51 mm core (calc.impedance, FR-4 er 4.5)
    const b = await call('protocol.compat', { protocol: 'spi', initiator: MCU, responder: ADC, f: 1e6, impedance: { structure: 'microstrip', width: 0.25e-3, height: 1.51e-3, er: 4.5 }, flight: { sck: { length_m: 0.05 }, mosi: { length_m: 0.05 }, miso: { length_m: 0.05 } } })
    expect(b.pass).toBe(true)
    // read path: 0.5 / (fl_sck + tV,s + fl_miso + tSU,m) = 0.5 / (0.31 + 125 + 0.31 + 20 ns) ≈ 3.43 MHz
    expect(b.f_max_read as number).toBeGreaterThan(3.4e6)
    expect(b.f_max_read as number).toBeLessThan(3.45e6)
    const d = await call('protocol.diagram', { run_id: m.run_id, check_run_id: ck.run_id, transaction: 0, spec: { device: ADC, protocol: 'spi' } })
    expect(d.panels as Obj[]).toHaveLength(2)
    const w = new Work()
    const svg = new TextDecoder().decode(w.getArtifact(d.run_id as string, 'diagram.svg') as Uint8Array)
    w.close()
    expect(svg).toContain('MOSI 0x8000 / MISO 0xe8b')
    expect(svg).toContain('tV 100 ns (≤ 125 ns)')
  })

  it.skipIf(!hasIverilog)('the committed testbench is what protocol.testbench generates, it passes on the DUT, and its coverage closes the requirement', async () => {
    const tb = await call('protocol.testbench', { ...READ, protocol: 'spi', dut: DUT })
    expect(tb.text).toBe(readFileSync(join(dir, 'logic', 'spi_adc_slave_tb.v'), 'utf8'))
    const req = await call('verify.requirements', { action: 'add', requirements: [{ text: 'The ADC returns its latched 12-bit code MSB first in SPI mode 0', kind: 'functional', source: 'examples/sensor-node README section 7' }] })
    const reqId = (req.added as string[])[0] as string
    await call('verify.coverage', { define: [
      { requirements: [reqId], kind: 'functional', match: 'spi_tx_0' }, { requirements: [reqId], kind: 'functional', match: 'spi_tx_1' },
      { requirements: [reqId], kind: 'functional', match: 'spi_response_1' },
    ] })
    const plan = await call('verify.plan', { action: 'add', tests: [{ title: 'SPI ADC read', requirements: [reqId], method: 'sim', tool: 'sim.logic', args: { files: ['logic/spi_adc_slave.v', 'logic/spi_adc_slave_tb.v'], top: 'spi_adc_slave_tb', pass: 'ALL TESTS PASSED', fail: 'MISMATCH' } }] })
    const v = await call('verify.run', { ids: plan.added as string[] })
    expect(((v.results as Obj[])[0] as Obj).status).toBe('pass')
    const cov = await call('verify.coverage', {})
    const r = (cov.requirements as Obj[]).find((x) => x.id === reqId) as Obj
    expect(r.verdict).toBe('verified')
    // a DUT returning another code fails, bit by bit
    const bad = await call('protocol.testbench', { ...READ, protocol: 'spi', dut: { ...DUT, ties: { sample: "12'd3722" } }, run: true, dut_files: ['logic/spi_adc_slave.v'] })
    expect(bad.passed).toBe(false)
  })
})

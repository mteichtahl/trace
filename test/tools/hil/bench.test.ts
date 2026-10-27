/**
 * The bench emulator (src/tools/hil/emulator): its settings are valid project settings, and the real hil tools
 * (through the one registry the CLI and MCP server share) drive it with hardware allowed, as they would a real bench.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConfigSchema, load, resolve, setValue } from '../../../src/core/config.js'
import { bridge } from '../../../src/core/bridge.js'
import { Work } from '../../../src/core/store.js'
import { DIVIDER, TAU, firmwareReading } from '../../../src/tools/hil/emulator/board.js'
import { startBench, writeBenchSettings, type Bench } from '../../../src/tools/hil/emulator/bench.js'
import { serialUnavailable } from '../../../src/tools/hil/emulator/serial.js'
import { allTools } from '../../../src/tools/index.js'

type Obj = Record<string, unknown>
const reg = allTools()
const call = async (name: string, args: Obj): Promise<Obj> => (await reg.call(name, args, { hardware: true, via: 'test' })) as Obj

const canReach = (port: number): Promise<boolean> => new Promise((r) => {
  const s = connect({ host: '127.0.0.1', port })
  s.once('connect', () => { s.destroy(); r(true) })
  s.once('error', () => r(false))
})

describe('the bench settings', () => {
  it('are exactly what the project settings take, on the default ports', async () => {
    // the default ports, unless something on this machine (a running `tracectl hil emulate`) already has them
    const free = !(await canReach(5555) || await canReach(5556) || await canReach(5557))
    const bench = await startBench(free ? {} : { ports: { psu: 0, scope: 0, dmm: 0 } })
    try {
      const s = bench.settings
      expect(Object.keys(s).sort()).toEqual(['hil.can', 'hil.instruments'])
      const ports = free ? [5555, 5556, 5557] : [bench.psu.port, bench.scope.port, bench.dmm.port]
      expect(s['hil.instruments'].map((i) => [i.name, i.kind, i.address])).toEqual([
        ['bench-psu', 'psu', `TCPIP::127.0.0.1::${ports[0]}::SOCKET`],
        ['bench-scope', 'scope', `TCPIP::127.0.0.1::${ports[1]}::SOCKET`],
        ['bench-dmm', 'dmm', `TCPIP::127.0.0.1::${ports[2]}::SOCKET`],
      ])
      expect(s['hil.instruments'][0]?.limits).toEqual({ max_voltage_v: 13, max_current_a: 0.1 })
      expect(s['hil.can']).toEqual([{ name: 'bench-can', interface: 'virtual', channel: 'bench' }])
      // the real schema, with its cross-checks (a PSU needs both limits, names are unique across hil sections)
      const parsed = ConfigSchema.safeParse({ hil: { instruments: s['hil.instruments'], can: s['hil.can'] } })
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
      expect(resolve(s as unknown as Record<string, unknown>).errors).toEqual([])
    } finally {
      await bench.stop()
    }
  })
})

describe('the hil tools against the bench', () => {
  let bench: Bench
  beforeAll(async () => {
    bench = await startBench({ ports: { psu: 0, scope: 0, dmm: 0 } })
    // an unrelated instrument the project already had survives writing the bench's
    setValue('hil.instruments', [{ name: 'lab-dmm', kind: 'dmm', address: 'TCPIP::10.0.0.9::5025::SOCKET' }])
    expect(writeBenchSettings(bench.settings)).toEqual(['hil.instruments', 'hil.can'])
  })
  afterAll(async () => {
    await bench.stop()
    for (const p of [bench.psu.port, bench.scope.port, bench.dmm.port]) expect(await canReach(p)).toBe(false)
  })

  it('kept the project’s other entries, and writing again replaces rather than duplicates', () => {
    writeBenchSettings(bench.settings)
    expect(load().hil.instruments.map((i) => i.name)).toEqual(['lab-dmm', 'bench-psu', 'bench-scope', 'bench-dmm'])
    expect(load().hil.can.map((c) => c.name)).toEqual(['bench-can'])
  })

  it('identifies each instrument', async () => {
    expect(await call('hil.idn', { instrument: 'bench-psu' })).toMatchObject({ model: 'DP832', dialect: 'psu:rigol-dp800', transport: 'socket' })
    expect(await call('hil.idn', { instrument: 'bench-scope' })).toMatchObject({ model: 'DS1104Z', dialect: 'scope:rigol-ds1000z' })
    expect(await call('hil.idn', { instrument: 'bench-dmm' })).toMatchObject({ model: '34465A', dialect: 'dmm:keysight-344xx' })
  })

  it('reads 0 V on ADC_IN with the supply off, VIN·13/52 with it on, and refuses more than 13 V', async () => {
    const off = await call('hil.dmm', { instrument: 'bench-dmm', function: 'vdc' })
    expect(off.value).toBe(0)
    const p = await call('hil.psu', { instrument: 'bench-psu', channel: 1, voltage: 12, current: 0.05, output: 'on' })
    expect(p).toMatchObject({ dialect: 'rigol-dp800', set: { voltage_v: 12, current_a: 0.05 }, output: 'on' })
    expect((p.measured as Obj).voltage_v).toBeCloseTo(12, 3)
    expect((p.measured as Obj).current_a).toBeCloseTo(12 / 52_000, 4)
    const on = await call('hil.dmm', { instrument: 'bench-dmm', function: 'vdc', samples: 3 })
    expect(on.value as number).toBeCloseTo(3.0, 6)
    expect(on.status === undefined || on.overload === false).toBe(true)
    await expect(call('hil.psu', { instrument: 'bench-psu', channel: 1, voltage: 14 })).rejects.toThrow(/above the limit 13 V/)
  })

  it('shows the VIN step on scope CH1 through the RC filter, and the square wave on CH2', async () => {
    await call('hil.psu', { instrument: 'bench-psu', channel: 1, output: 'off' })
    await call('hil.psu', { instrument: 'bench-psu', channel: 1, voltage: 12, output: 'on' })
    const cap = await call('hil.scope_capture', { instrument: 'bench-scope', setup: [{ channel: 1, scale_v: 1 }], fetch: [1, 2], max_points: 200 })
    expect(cap.triggered).toBe(true)
    const [ch1, ch2] = cap.channels as Obj[]
    const s1 = ch1!.stats as Obj
    expect(s1.vmin as number).toBeCloseTo(0, 1)
    expect(s1.vmax as number).toBeCloseTo(12 * DIVIDER, 1)
    // 10-90 % of a single-pole RC is 2.2 τ
    expect(s1.rise_s as number).toBeGreaterThan(1.8 * TAU)
    expect(s1.rise_s as number).toBeLessThan(2.6 * TAU)
    const s2 = ch2!.stats as Obj
    expect(s2.vpp as number).toBeCloseTo(3.2, 1)
    expect(s2.freq_hz as number).toBeCloseTo(1000, -1)
    const m = await call('hil.scope_measure', { instrument: 'bench-scope', channel: 1, measurements: ['vmax', 'rise'] })
    const ms = m.measurements as Record<string, { value: number; from: string }>
    expect(ms.vmax).toMatchObject({ from: 'instrument' })
    expect(ms.vmax!.value).toBeCloseTo(3, 1)
    expect(ms.rise!.from).toBe('waveform')
  })

  it('serves thermal.measure through the DMM (temperature and a Pt100 as resistance)', async () => {
    const r = await call('thermal.measure', { points: [
      { name: 'board', predicted_c: 26, source: { kind: 'dmm_temp', instrument: 'bench-dmm', samples: 2 } },
      { name: 'rtd', source: { kind: 'dmm_rtd', instrument: 'bench-dmm', samples: 1 } },
    ] })
    const w = new Work()
    const run = w.run(String(r.run_id))!
    w.close()
    expect(run.measurements.find((x) => x.name === 'board.measured_c')?.value).toBeCloseTo(25, 6)
    expect(run.measurements.find((x) => x.name === 'rtd.measured_c')?.value).toBeCloseTo(25, 3)
  })

  it('runs a verify.plan item with method hil, and is blocked without hardware', async () => {
    await call('hil.psu', { instrument: 'bench-psu', channel: 1, voltage: 12, current: 0.05, output: 'on' })
    const req = await call('verify.requirements', { action: 'add', requirements: [{ text: 'ADC_IN is 3.0 V ± 2 % at 12 V VIN', kind: 'electrical', acceptance: 'hil.dmm vdc on ADC_IN within 2.94-3.06 V', source: 'sample board divider R1/R2' }] })
    const reqId = (req.added as string[])[0]!
    const plan = await call('verify.plan', { action: 'add', tests: [{ title: 'ADC_IN at 12 V VIN', requirements: [reqId], method: 'hil', tool: 'hil.dmm', args: { instrument: 'bench-dmm', function: 'vdc' }, expect: [{ measurement: 'vdc', min: 2.94, max: 3.06 }] }] })
    const id = (plan.added as string[])[0]!
    const v = await call('verify.run', { ids: [id] })
    expect((v.results as Obj[])[0]).toMatchObject({ status: 'pass' })
    const blocked = (await reg.call('verify.run', { ids: [id] }, { hardware: false, via: 'test' })) as Obj
    expect((blocked.results as Obj[])[0]).toMatchObject({ status: 'blocked' })
  })
})

const python = process.env.TRACE_PYTHON && existsSync(process.env.TRACE_PYTHON) ? process.env.TRACE_PYTHON : 'python3'
const hasPythonCan = spawnSync(python, ['-c', 'import can'], { timeout: 10_000 }).status === 0

describe.skipIf(!hasPythonCan)('bench-can (python-can virtual)', () => {
  afterAll(() => bridge().close())
  it('carries frames between hil.can_send and hil.can_capture in one process', async () => {
    const bench = await startBench({ ports: { psu: 0, scope: 0, dmm: 0 } })
    try {
      writeBenchSettings(bench.settings)
      const capturing = call('hil.can_capture', { bus: 'bench-can', seconds: 1 })
      await new Promise((r) => setTimeout(r, 300))
      await call('hil.can_send', { bus: 'bench-can', frames: [{ id: '0x123', data: '0102' }] })
      const r = await capturing
      expect(r.frames).toBe(1)
    } finally {
      await bench.stop()
    }
  })
})

const noSerial = serialUnavailable()

describe.skipIf(noSerial !== null)('bench-uart (the firmware console on a pty)', () => {
  let bench: Bench
  beforeAll(async () => {
    bench = await startBench({ ports: { psu: 0, scope: 0, dmm: 0 }, serial: true })
    writeBenchSettings(bench.settings)
  })
  afterAll(async () => {
    await bench.stop()
    expect(existsSync(bench.settings['hil.serial']![0]!.port)).toBe(false)
  })

  it('is a valid hil.serial entry', () => {
    const s = bench.settings['hil.serial']!
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ name: 'bench-uart', baud: 115200 })
    expect(bench.serialDevice).toMatch(/^\/dev\//)
    expect(ConfigSchema.safeParse({ hil: { serial: s, instruments: bench.settings['hil.instruments'], can: bench.settings['hil.can'] } }).success).toBe(true)
  })

  it('is silent while unpowered, boots at power-up, logs each second and answers READ', async () => {
    await call('hil.psu', { instrument: 'bench-psu', channel: 1, output: 'off' })
    const quiet = await call('hil.serial_capture', { serial: 'bench-uart', seconds: 1.2 })
    expect(quiet.bytes).toBe(0)
    await call('hil.psu', { instrument: 'bench-psu', channel: 1, voltage: 12, current: 0.05, output: 'on' })
    const want = firmwareReading(12)
    expect(want.raw).toBe(3722)
    const log = await call('hil.serial_capture', { serial: 'bench-uart', seconds: 2.5, until: 'adc raw=\\d+ mv=\\d+\\r?\\n' })
    expect(log.stopped_on_match).toBe(true)
    expect((log.tail as string)).toMatch(new RegExp(`adc raw=${want.raw} mv=${want.mv}`))
    const ex = await call('hil.serial_expect', { serial: 'bench-uart', steps: [
      { send: 'READ', expect: 'adc raw=(?<raw>\\d+) mv=(?<mv>\\d+)' },
      { send: 'ID', expect: 'trace-sample fw' },
    ] })
    expect(ex.ok).toBe(true)
    expect((ex.steps as Obj[])[0]?.groups).toEqual({ raw: String(want.raw), mv: String(want.mv) })
  })

  it('serves thermal.measure from firmware telemetry', async () => {
    const r = await call('thermal.measure', { points: [{ name: 'mcu', source: { kind: 'serial', serial: 'bench-uart', seconds: 6, regex: 'mcu_c=([-0-9.]+)' } }] })
    expect(r.run_id).toBeTruthy()
    const w = new Work()
    const run = w.run(String(r.run_id))!
    w.close()
    expect(run.measurements.find((x) => x.name === 'mcu.measured_c')?.value).toBe(25)
  })
})

describe.skipIf(noSerial === null)('bench-uart where it cannot run', () => {
  it('says why', () => {
    expect(noSerial).toMatch(/python3|pseudo-terminal|relay/)
  })
})

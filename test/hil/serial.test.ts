// @ts-expect-error the package's exports map hides its (correct) types from NodeNext resolution
import { MockBinding, type MockPortBinding } from '@serialport/binding-mock'
import type { BindingInterface } from '@serialport/bindings-cpp'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { resolve, setValue } from '../../src/core/config.js'
import { Registry } from '../../src/core/registry.js'
import { Work } from '../../src/core/store.js'
import { resolvePort, unescape, useBinding } from '../../src/hil/serial.js'
import { tools } from '../../src/hil/tools.js'

const reg = new Registry(tools)
const hw = { hardware: true, via: 'test' as const }
type Obj = Record<string, unknown>
const call = async (name: string, args: Obj): Promise<Obj> => (await reg.call(name, args, hw)) as Obj

/** A pretend device on the mock port: it answers what is written to it. */
type Device = (line: string, reply: (s: string) => void) => void
let device: Device = () => undefined
let opened: MockPortBinding | null = null

const binding: BindingInterface = {
  list: () => MockBinding.list(),
  open: async (opts) => {
    const p = await MockBinding.open(opts)
    opened = p
    const write = p.write.bind(p)
    let pending = ''
    p.write = async (buf: Buffer) => {
      await write(buf)
      pending += buf.toString('utf8')
      let i: number
      while ((i = pending.search(/\r?\n/)) >= 0) {
        const line = pending.slice(0, i)
        pending = pending.slice(pending[i] === '\r' ? i + 2 : i + 1)
        setTimeout(() => device(line, (s) => p.emitData(Buffer.from(s))), 2)
      }
    }
    return p
  },
} as BindingInterface

beforeEach(() => {
  MockBinding.reset()
  MockBinding.createPort('/dev/ttyACM0', { vendorId: '2E8A', productId: '000A' })
  MockBinding.createPort('/dev/ttyUSB0', { vendorId: '0403', productId: '6001' })
  useBinding(binding)
  device = () => undefined
  opened = null
})
afterAll(() => useBinding(null))

describe('serial', () => {
  it('lists ports and resolves USB VID:PID[:serial]', async () => {
    const r = await call('hil.ports', {})
    expect((r.serial as Obj[]).map((p) => [p.path, p.vid, p.pid])).toEqual([['/dev/ttyACM0', '2e8a', '000a'], ['/dev/ttyUSB0', '0403', '6001']])
    expect(await resolvePort('2e8a:000a')).toBe('/dev/ttyACM0')
    expect(await resolvePort('0403:6001:2')).toBe('/dev/ttyUSB0') // the mock numbers serials 1, 2, …
    await expect(resolvePort('dead:beef')).rejects.toThrow(/no serial port matches USB dead:beef/)
    expect(await resolvePort('/dev/ttyS9')).toBe('/dev/ttyS9')
  })

  it('runs an expect script with named groups, and records the transcript', async () => {
    setValue('hil.serial', [{ name: 'dut', port: '2e8a:000a', baud: 115200 }])
    device = (line, reply) => {
      if (line === 'version') reply('fw 1.4.2 (abc123)\r\n> ')
      else if (line === 'adc 3') reply('adc3 = 2047\r\n> ')
    }
    const r = await call('hil.serial_expect', {
      serial: 'dut',
      steps: [{ send: 'version', expect: 'fw (?<ver>\\d+\\.\\d+\\.\\d+)' }, { send: 'adc 3', expect: 'adc3 = (?<raw>\\d+)' }],
    })
    expect(r.ok).toBe(true)
    const steps = r.steps as Obj[]
    expect(steps[0]?.groups).toEqual({ ver: '1.4.2' })
    expect(steps[1]?.groups).toEqual({ raw: '2047' })
    expect(opened?.recording.toString() ?? '').toBe('')
    const w = new Work()
    const run = w.run(String(r.run_id))!
    const transcript = new TextDecoder().decode(w.getArtifact(run.id, 'transcript.txt')!)
    w.close()
    expect(run.status).toBe('pass')
    expect(transcript).toContain('adc3 = 2047')
  })

  it('stops at an unmet expect after its timeout, with what arrived', async () => {
    device = (line, reply) => { if (line === 'ping') reply('nope\r\n') }
    const t0 = Date.now()
    const r = await call('hil.serial_expect', { port: '/dev/ttyACM0', steps: [{ send: 'ping', expect: 'pong', timeout_s: 0.3 }, { send: 'never' }] })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(r.ok).toBe(false)
    const steps = r.steps as Obj[]
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ ok: false, got: expect.stringContaining('nope') })
    const w = new Work()
    expect(w.run(String(r.run_id))?.status).toBe('fail')
    w.close()
  })

  it('captures for a time or until a regex, flagging panics, and the log is in the record', async () => {
    device = (line, reply) => {
      if (line === 'go') {
        reply('boot\r\n')
        setTimeout(() => reply('INFO tick\r\npanicked at src/main.rs:42:5: index out of bounds\r\n'), 20)
        setTimeout(() => reply('DONE\r\n'), 40)
      }
    }
    const r = await call('hil.serial_capture', { port: '/dev/ttyACM0', seconds: 2, until: 'DONE', send: 'go\\n' })
    expect(r.stopped_on_match).toBe(true)
    expect(r.seconds as number).toBeLessThan(1.5)
    expect(r.faults).toEqual(['panicked at src/main.rs:42:5: index out of bounds'])
    const w = new Work()
    const log = new TextDecoder().decode(w.getArtifact(String(r.run_id), 'serial.log')!)
    w.close()
    expect(log).toContain('boot')
    const quiet = await call('hil.serial_capture', { port: '/dev/ttyUSB0', seconds: 0.2 })
    expect(quiet).toMatchObject({ bytes: 0, stopped_on_match: false, faults: [] })
  })

  it('refuses an unknown port name and a port that does not exist', async () => {
    await expect(call('hil.serial_capture', { serial: 'nope', seconds: 0.1 })).rejects.toThrow(/no serial port "nope" in hil.serial/)
    await expect(call('hil.serial_capture', { port: '/dev/ttyNOPE', seconds: 0.1 })).rejects.toThrow(/could not open \/dev\/ttyNOPE/)
  })

  it('unescapes sends', () => {
    expect(unescape('a\\r\\n\\x41\\t')).toBe('a\r\nA\t')
  })
})

describe('hil settings validation', () => {
  it('reports each bad item and field', () => {
    const e = resolve({
      'hil.serial': [{ name: 'a b', port: '/dev/x', baud: '9600' }],
      'hil.can': [{ name: 'c', interface: 'nope', channel: 'can0' }],
      'hil.instruments': [
        { name: 's', kind: 'scope', address: '10.0.0.1' },
        { name: 'd', kind: 'dmm', address: 'tcp://h:5025', color: 'red' },
      ],
    }).errors.join('\n')
    expect(e).toMatch(/hil.serial.0.name: letters, digits/)
    expect(e).toMatch(/hil.serial.0.baud/)
    expect(e).toMatch(/hil.can.0.interface/)
    expect(e).toMatch(/hil.instruments.0.address: expected TCPIP::host::port::SOCKET/)
    expect(e).toMatch(/hil.instruments.1.*color/)
    // checks across items run once every item is well formed
    const x = resolve({
      'hil.can': [{ name: 'c', interface: 'virtual', channel: 'x' }],
      'hil.instruments': [
        { name: 'p', kind: 'psu', address: 'TCPIP::h::5025::SOCKET', limits: { max_voltage_v: 5 } },
        { name: 'c', kind: 'dmm', address: 'tcp://h:5025' },
      ],
    }).errors.join('\n')
    expect(x).toMatch(/hil.instruments.0.limits: a PSU needs max_voltage_v and max_current_a/)
    expect(x).toMatch(/hil.instruments.1.name: c is also hil.can\[0\]/)
    const ok = resolve({ 'hil.instruments': [{ name: 'p', kind: 'psu', address: 'TCPIP::h::5025::SOCKET', limits: { max_voltage_v: 5, max_current_a: 1, per_channel: { '2': { max_voltage_v: 3.3 } } } }] })
    expect(ok.errors).toEqual([])
    expect(ok.config.hil.instruments[0]?.timeout_s).toBe(5)
  })
})

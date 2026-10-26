import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setValue } from '../../src/core/config.js'
import { Registry } from '../../src/core/registry.js'
import { Work } from '../../src/core/store.js'
import { ByteBuffer, Timeout } from '../../src/hil/bytes.js'
import { pickDialect } from '../../src/hil/instruments/base.js'
import { DMM_DIALECTS } from '../../src/hil/instruments/dmm.js'
import { PSU_DIALECTS, checkRequest } from '../../src/hil/instruments/psu.js'
import { SCOPE_DIALECTS, decimate, parsePreamble10, scaleKeysight, scaleRigol, scaleSiglent, scaleTek, stats } from '../../src/hil/instruments/scope.js'
import { instrument } from '../../src/hil/resources.js'
import { blockLength, drainErrors, makeBlock, parseAddress, parseBlock, parseIdn, withTransport } from '../../src/hil/scpi.js'
import { tools } from '../../src/hil/tools.js'
import { FakeScpi } from './fake-scpi.js'

const reg = new Registry(tools)
const hw = { hardware: true, via: 'test' as const }
type Obj = Record<string, unknown>
const call = async (name: string, args: Obj): Promise<Obj> => (await reg.call(name, args, hw)) as Obj

describe('SCPI framing', () => {
  it('parses addresses', () => {
    expect(parseAddress('TCPIP::10.0.0.5::5025::SOCKET')).toEqual({ kind: 'socket', host: '10.0.0.5', port: 5025 })
    expect(parseAddress('tcp://scope.lan:5555')).toEqual({ kind: 'socket', host: 'scope.lan', port: 5555 })
    expect(parseAddress('ASRL/dev/ttyUSB0::INSTR')).toEqual({ kind: 'serial', path: '/dev/ttyUSB0', baud: 9600 })
    expect(parseAddress('ASRL/dev/ttyUSB0@115200::INSTR')).toMatchObject({ baud: 115200 })
    expect(parseAddress('TCPIP0::10.0.0.6::inst0::INSTR').kind).toBe('visa')
    expect(parseAddress('TCPIP::10.0.0.6::hislip0').kind).toBe('visa')
    expect(parseAddress('USB0::0x1AB1::0x04CE::DS1ZA1::INSTR').kind).toBe('visa')
    expect(parseAddress('GPIB0::5::INSTR').kind).toBe('visa')
    expect(() => parseAddress('10.0.0.5')).toThrow(/not an instrument address/)
  })

  it('finds and parses IEEE 488.2 definite-length blocks, waiting for split chunks', () => {
    const payload = Buffer.from([0, 1, 2, 0x0a, 255, 0x23])
    const block = Buffer.concat([makeBlock(payload), Buffer.from('\n')])
    expect(block.subarray(0, 3).toString()).toBe('#16')
    expect(blockLength(block.subarray(0, 1))).toBeNull()
    expect(blockLength(block.subarray(0, 5))).toBeNull()
    expect(blockLength(block)).toBe(block.length)
    expect(parseBlock(block)).toEqual(payload) // a 0x0a inside the payload is data, not a terminator
    const big = makeBlock(Buffer.alloc(123456, 7))
    expect(big.subarray(0, 8).toString()).toBe('#6123456')
    expect(parseBlock(big).length).toBe(123456)
    expect(parseBlock(Buffer.from('#0abc\n'))).toEqual(Buffer.from('abc'))
    expect(() => blockLength(Buffer.from('1.23\n'))).toThrow(/expected an IEEE 488.2 block/)
    expect(() => parseBlock(Buffer.from('#3100abc'))).toThrow(/short/)
  })

  it('reads lines, regex matches and exact counts with deadlines', async () => {
    const b = new ByteBuffer()
    setTimeout(() => b.push(Buffer.from('hel')), 5)
    setTimeout(() => b.push(Buffer.from('lo\nworld')), 15)
    expect((await b.line(1000)).toString()).toBe('hello\n')
    const m = await (async () => { setTimeout(() => b.push(Buffer.from(' 42 ok')), 5); return b.until(/(\d+) ok/, 1000) })()
    expect(m.match[1]).toBe('42')
    await expect(b.exact(10, 50)).rejects.toBeInstanceOf(Timeout)
  })

  it('splits *IDN?', () => {
    expect(parseIdn('RIGOL TECHNOLOGIES,DP832,DP8C1,00.01.16\n')).toMatchObject({ manufacturer: 'RIGOL TECHNOLOGIES', model: 'DP832', serial: 'DP8C1', firmware: '00.01.16' })
  })
})

describe('dialects', () => {
  const id = (raw: string) => parseIdn(raw)
  it('are chosen from *IDN? or the configured model', () => {
    expect(pickDialect(PSU_DIALECTS, 'psu', undefined, id('RIGOL TECHNOLOGIES,DP832,x,y')).id).toBe('rigol-dp800')
    expect(pickDialect(PSU_DIALECTS, 'psu', undefined, id('Keysight Technologies,E36312A,x,y')).id).toBe('keysight-e36')
    expect(pickDialect(PSU_DIALECTS, 'psu', undefined, id('Agilent Technologies,E3631A,0,1.5')).id).toBe('keysight-e36')
    expect(pickDialect(PSU_DIALECTS, 'psu', undefined, id('Siglent Technologies,SPD3303X-E,x,y')).id).toBe('siglent-spd')
    expect(pickDialect(PSU_DIALECTS, 'psu', undefined, id('Rohde&Schwarz,HMC8043,x,y')).id).toBe('rs-hmc')
    expect(pickDialect(PSU_DIALECTS, 'psu', undefined, id('Rohde&Schwarz,NGE103B,x,y')).id).toBe('rs-ngx')
    expect(pickDialect(PSU_DIALECTS, 'psu', undefined, id('ACME,PS1,x,y')).id).toBe('generic')
    expect(pickDialect(PSU_DIALECTS, 'psu', 'DP832', null).id).toBe('rigol-dp800')
    expect(pickDialect(PSU_DIALECTS, 'psu', 'siglent-spd', null).id).toBe('siglent-spd')
    expect(() => pickDialect(PSU_DIALECTS, 'psu', 'nonsense', null)).toThrow(/unknown psu model/)
    expect(pickDialect(SCOPE_DIALECTS, 'scope', undefined, id('RIGOL TECHNOLOGIES,DS1104Z,x,y')).id).toBe('rigol-ds1000z')
    expect(pickDialect(SCOPE_DIALECTS, 'scope', undefined, id('RIGOL TECHNOLOGIES,MSO5074,x,y')).id).toBe('rigol-mso5000')
    expect(pickDialect(SCOPE_DIALECTS, 'scope', undefined, id('Siglent Technologies,SDS1104X-E,x,y')).id).toBe('siglent-sds')
    expect(pickDialect(SCOPE_DIALECTS, 'scope', undefined, id('KEYSIGHT TECHNOLOGIES,DSOX1204G,x,y')).id).toBe('keysight-infiniivision')
    expect(pickDialect(SCOPE_DIALECTS, 'scope', undefined, id('TEKTRONIX,MSO44,x,y')).id).toBe('tek-mso')
    expect(pickDialect(DMM_DIALECTS, 'dmm', undefined, id('Keysight Technologies,34465A,x,y')).id).toBe('keysight-344xx')
  })

  it('generate each vendor’s command text', () => {
    const d = (k: string) => PSU_DIALECTS.find((x) => x.id === k)!
    expect(d('rigol-dp800').setVoltage(2, 3.3)).toBe(':SOUR2:VOLT 3.3')
    expect(d('rigol-dp800').output(3, true)).toEqual([':OUTP CH3,ON'])
    expect(d('keysight-e36').select(2)).toEqual(['INST:NSEL 2'])
    expect(d('keysight-e36').setCurrent(2, 0.25)).toBe('CURR 0.25')
    expect(d('siglent-spd').setVoltage(1, 5)).toBe('CH1:VOLT 5')
    expect(d('siglent-spd').output(2, false)).toEqual(['OUTP CH2,OFF'])
    expect(d('rs-hmc').output(1, true)).toEqual(['INST:NSEL 1', 'OUTP:CHAN ON', 'OUTP:MAST ON'])
    expect(d('rs-ngx').output(2, true)).toEqual(['INST:NSEL 2', 'OUTP:SEL ON', 'OUTP:GEN ON'])
    const s = (k: string) => SCOPE_DIALECTS.find((x) => x.id === k)!
    expect(s('rigol-ds1000z').channel({ channel: 1, scale_v: 0.5, coupling: 'ac', probe: 10 })).toEqual([':CHAN1:PROB 10', ':CHAN1:COUP AC', ':CHAN1:SCAL 0.5'])
    expect(s('rigol-ds1000z').trigger({ source: 2, level_v: 1.65, slope: 'falling' })).toEqual([':TRIG:MODE EDGE', ':TRIG:EDGE:SOUR CHAN2', ':TRIG:EDGE:SLOP NEG', ':TRIG:EDGE:LEV 1.65'])
    expect(s('siglent-sds').channel({ channel: 2, scale_v: 0.2, coupling: 'dc' })).toEqual(['C2:CPL D1M', 'C2:VDIV 0.2V'])
    expect(s('keysight-infiniivision').timebase(1e-3, 0)).toEqual([':TIM:SCAL 0.001', ':TIM:POS 0'])
    expect(s('tek-mso').trigger({ source: 1, level_v: 0.5 })).toEqual(['TRIG:A:TYP EDGE', 'TRIG:A:EDGE:SOU CH1', 'TRIG:A:EDGE:SLO RIS', 'TRIG:A:LEV:CH1 0.5'])
    expect(DMM_DIALECTS[0]!.configure('vdc', 10, 1)).toEqual(['CONF:VOLT:DC 10', 'VOLT:DC:NPLC 1'])
    expect(DMM_DIALECTS[0]!.configure('res', 'auto')).toEqual(['CONF:RES AUTO'])
    expect(() => DMM_DIALECTS[0]!.configure('vac', 'auto', 10)).toThrow(/no NPLC/)
  })
})

describe('waveform scaling', () => {
  it('turns codes into volts and seconds per vendor preamble', () => {
    const p = parsePreamble10('0,0,4,1,1.0e-6,-2.0e-6,0,0.04,0,127')
    const r = scaleRigol(new Uint8Array([127, 152, 102, 127]), p)
    expect(Array.from(r.v)).toEqual([0, 1.0000000000000002, -1, 0].map((x) => expect.closeTo(x, 9)) as unknown as number[])
    expect(r.t0).toBeCloseTo(-2e-6)
    expect(r.dt).toBe(1e-6)
    const k = scaleKeysight(new Uint8Array([128, 228]), parsePreamble10('0,0,2,1,1e-9,0,0,0.01,0.5,128'))
    expect(k.v[0]).toBeCloseTo(0.5)
    expect(k.v[1]).toBeCloseTo(1.5)
    const t = scaleTek(new Uint8Array([0, 100, 156]), { xincr: 2e-9, xzero: -1e-6, pt_off: 0, ymult: 0.02, yoff: 0, yzero: 0 })
    expect(t.v[1]).toBeCloseTo(2) // 100 * 0.02
    expect(t.v[2]).toBeCloseTo(-2) // 156 is -100 signed
    const s = scaleSiglent(new Uint8Array([25, 231]), { vdiv: 1, offset: 0, tdiv: 1e-3, sample_rate: 1e6, delay: 0, codes_per_div: 25, hdivs: 14 })
    expect(s.v[0]).toBeCloseTo(1)
    expect(s.v[1]).toBeCloseTo(-1)
    expect(s.t0).toBeCloseTo(-7e-3)
  })

  it('computes statistics over every sample and decimates keeping peaks', () => {
    const n = 10_000, dt = 1e-6
    const v = new Float64Array(n)
    for (let i = 0; i < n; i++) v[i] = ((i * dt * 1000) % 1) < 0.25 ? 3.3 : 0 // 1 kHz, 25 % duty
    v[4321] = 5 // a spike
    const st = stats({ t0: 0, dt, v })
    expect(st.vmax).toBe(5)
    expect(st.freq_hz).toBeCloseTo(1000, 0)
    expect(st.duty_pct).toBeCloseTo(25, 0)
    const d = decimate({ t0: 0, dt, v }, 200)
    expect(d.v.length).toBeLessThanOrEqual(200)
    expect(Math.max(...d.v)).toBe(5)
  })
})

describe('against the fake instrument', () => {
  let fake: FakeScpi
  let addr: string
  afterEach(async () => fake.stop())

  describe('PSU (Rigol DP832)', () => {
    beforeEach(async () => {
      fake = new FakeScpi('rigol-dp832')
      addr = await fake.start()
      setValue('hil.instruments', [
        { name: 'psu', kind: 'psu', address: addr, channels: [1, 2, 3], limits: { max_voltage_v: 5.5, max_current_a: 1, per_channel: { '3': { max_voltage_v: 3.4 } } } },
      ])
    })

    it('sets, enables, reads back and measures; records the run', async () => {
      const r = await call('hil.psu', { instrument: 'psu', channel: 1, voltage: 3.3, current: 0.5, output: 'on' })
      expect(r).toMatchObject({ dialect: 'rigol-dp800', set: { voltage_v: 3.3, current_a: 0.5 }, output: 'on', measured: { voltage_v: 3.3, current_a: 0.033 } })
      expect(fake.commands()).toEqual([':SOUR1:CURR 0.5', ':SOUR1:VOLT 3.3', ':SOUR1:VOLT?', ':SOUR1:CURR?', ':OUTP CH1,ON', ':OUTP? CH1', ':MEAS:VOLT? CH1', ':MEAS:CURR? CH1'])
      const w = new Work()
      const run = w.run(String(r.run_id))!
      w.close()
      expect(run.kind).toBe('hil.psu')
      expect(run.status).toBe('pass')
      expect(run.measurements.find((m) => m.name === 'voltage')?.value).toBeCloseTo(3.3)
      expect(run.artifacts.map((a) => a.name)).toContain('session.txt')
    })

    it('refuses set-points above the limits (and the channel’s tighter one) before sending anything', async () => {
      await expect(call('hil.psu', { instrument: 'psu', channel: 1, voltage: 12 })).rejects.toThrow(/12 V is above the limit 5.5 V/)
      await expect(call('hil.psu', { instrument: 'psu', channel: 2, current: 2 })).rejects.toThrow(/2 A is above the limit 1 A/)
      await expect(call('hil.psu', { instrument: 'psu', channel: 3, voltage: 5 })).rejects.toThrow(/above the limit 3.4 V/)
      await expect(call('hil.psu', { instrument: 'psu', channel: 4, voltage: 1 })).rejects.toThrow(/no channel 4/)
      expect(fake.log).toEqual([])
    })

    it('refuses to enable an output whose front-panel set-point is above the limits', async () => {
      fake.psu[0]!.v = 24
      await expect(call('hil.psu', { instrument: 'psu', channel: 1, output: 'on' })).rejects.toThrow(/refused to enable the output.*24 V/)
      expect(fake.psu[0]!.on).toBe(false)
      expect(fake.commands()).not.toContain(':OUTP CH1,ON')
    })

    it('turns off before changing set-points, and always allows off + measure', async () => {
      fake.psu[1]!.on = true
      fake.psu[1]!.v = 5
      const r = await call('hil.psu', { instrument: 'psu', channel: 2, output: 'off', voltage: 1.8 })
      expect(r).toMatchObject({ output: 'off', set: { voltage_v: 1.8 } })
      expect(fake.commands().slice(0, 2)).toEqual([':OUTP CH2,OFF', ':SOUR2:VOLT 1.8'])
    })
  })

  describe('PSU without limits', () => {
    it('is refused by settings validation and, ad hoc, never enabled', async () => {
      fake = new FakeScpi('keysight-e36312a')
      addr = await fake.start()
      expect(() => setValue('hil.instruments', [{ name: 'p', kind: 'psu', address: addr }])).toThrow(/a PSU needs max_voltage_v and max_current_a/)
      const adhoc = instrument(undefined, addr, 'psu')
      expect(() => checkRequest(adhoc, { channel: 1, output: 'on' })).toThrow(/no limits are configured.*address given directly/)
      expect(() => checkRequest(adhoc, { channel: 1, voltage: 1 })).toThrow(/no limits/)
      expect(() => checkRequest(adhoc, { channel: 1, output: 'off' })).not.toThrow()
    })
  })

  describe('PSU (Keysight E36312A)', () => {
    it('selects the channel with INST:NSEL and reads back', async () => {
      fake = new FakeScpi('keysight-e36312a')
      addr = await fake.start()
      setValue('hil.instruments', [{ name: 'ks', kind: 'psu', address: addr, channels: [1, 2, 3], limits: { max_voltage_v: 6, max_current_a: 1 } }])
      const r = await call('hil.psu', { instrument: 'ks', channel: 2, voltage: 5, current: 0.2, output: 'on' })
      expect(r).toMatchObject({ dialect: 'keysight-e36', set: { voltage_v: 5, current_a: 0.2 }, output: 'on' })
      expect(fake.commands().slice(0, 3)).toEqual(['INST:NSEL 2', 'CURR 0.2', 'VOLT 5'])
      expect(fake.psu[1]!.on).toBe(true)
      expect(fake.psu[0]!.on).toBe(false)
    })
  })

  describe('scope (Rigol DS1104Z)', () => {
    beforeEach(async () => {
      fake = new FakeScpi('rigol-ds1104z')
      addr = await fake.start()
      setValue('hil.instruments', [{ name: 'scope', kind: 'scope', address: addr }])
    })

    it('sets up, triggers a single acquisition, fetches and scales the waveform, stores the CSV', async () => {
      const r = await call('hil.scope_capture', {
        instrument: 'scope', setup: [{ channel: 1, scale_v: 1, coupling: 'dc' }], timebase_s: 1e-4,
        trigger: { source: 1, level_v: 0 }, fetch: [1], max_points: 100,
      })
      expect(r.triggered).toBe(true)
      const ch = (r.channels as Obj[])[0]!
      expect(ch.points).toBe(1200)
      const st = ch.stats as Obj
      expect(st.vpp as number).toBeCloseTo(3.2, 1)
      expect(st.freq_hz as number).toBeCloseTo(1000, -1)
      expect((ch.v as number[]).length).toBeLessThanOrEqual(100)
      expect(ch.t0_s).toBeCloseTo(-6e-4)
      expect(fake.commands()).toContain(':SING')
      const w = new Work()
      const csv = new TextDecoder().decode(w.getArtifact(String(r.run_id), 'waveform.csv')!)
      w.close()
      expect(csv.split('\n')[0]).toBe('t_s,CH1_v')
      expect(csv.trim().split('\n')).toHaveLength(1201)
    })

    it('reports no trigger rather than waiting for ever', async () => {
      fake.neverTrigger = true
      const t0 = Date.now()
      const r = await call('hil.scope_capture', { instrument: 'scope', wait_s: 0.5 })
      expect(Date.now() - t0).toBeLessThan(3000)
      expect(r.triggered).toBe(false)
      expect(fake.commands()).not.toContain(':WAV:DATA?')
    })

    it('measures with the scope’s own items and falls back to the waveform', async () => {
      const r = await call('hil.scope_measure', { instrument: 'scope', channel: 1, measurements: ['vpp', 'freq', 'rise'] })
      const m = r.measurements as Record<string, { value: number | null; from: string }>
      expect(m.vpp).toMatchObject({ value: 3.2, from: 'instrument' })
      expect(m.freq).toMatchObject({ value: 1000, from: 'instrument' })
      expect(m.rise?.from).toBe('waveform') // the fake answers 9.9E37 for RTIM
    })
  })

  describe('raw SCPI, *IDN?, DMM', () => {
    it('runs commands, reports the error queue and refuses raw SCPI on a PSU', async () => {
      fake = new FakeScpi('keysight-34465a')
      addr = await fake.start()
      setValue('hil.instruments', [
        { name: 'dmm', kind: 'dmm', address: addr },
        { name: 'psu', kind: 'psu', address: addr, limits: { max_voltage_v: 5, max_current_a: 1 } },
      ])
      const r = await call('hil.scpi', { instrument: 'dmm', commands: ['*IDN?', 'BOGUS:CMD 1'] })
      expect((r.replies as Obj[])[0]?.reply).toMatch(/34465A/)
      expect(r.errors).toEqual(['-113,"Undefined header"'])
      await expect(call('hil.scpi', { instrument: 'psu', commands: ['VOLT 30'] })).rejects.toThrow(/bypass its limits/)
      const id = await call('hil.idn', { instrument: 'dmm' })
      expect(id).toMatchObject({ model: '34465A', transport: 'socket', dialect: 'dmm:keysight-344xx' })
      const d = await call('hil.dmm', { instrument: 'dmm', function: 'vdc', range: 10, nplc: 1, samples: 3 })
      expect(d).toMatchObject({ function: 'vdc', unit: 'V', samples: 3, overload: false })
      expect(d.value as number).toBeCloseTo(3.3012, 4)
      expect(fake.commands()).toContain('CONF:VOLT:DC 10')
    })

    it('times out on a silent instrument and drains errors with a bound', async () => {
      fake = new FakeScpi('keysight-34465a')
      addr = await fake.start()
      fake.silent = /^READ\?$/
      await expect(withTransport(addr, 200, (t) => t.query('READ?'))).rejects.toThrow(/no answer to "READ\?"/)
      fake.silent = null
      for (let i = 0; i < 50; i++) fake.errors.push('-100,"Command error"')
      const errs = await withTransport(addr, 1000, (t) => drainErrors(t, 8))
      expect(errs).toHaveLength(8)
    })

    it('fails to connect quickly to a closed port', async () => {
      await expect(withTransport('TCPIP::127.0.0.1::1::SOCKET', 1000, (t) => t.query('*IDN?'))).rejects.toThrow(/127.0.0.1::1/)
      fake = new FakeScpi('keysight-34465a') // for afterEach
      await fake.start()
    })
  })
})

describe('the hardware gate', () => {
  it('refuses hardware tools without hardware allowed', async () => {
    await expect(reg.call('hil.psu', { instrument: 'x' }, { hardware: false, via: 'test' })).rejects.toThrow(/drives real hardware/)
    expect(reg.list().filter((t) => !t.hardware).map((t) => t.name)).toEqual(['hil.ports'])
  })
})

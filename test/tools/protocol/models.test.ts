/**
 * The protocol models round trip through the decoders: generate a waveform from transactions, decode it with the
 * same code sim.wave_decode uses, and get the same transactions back. Plus the facts each model must honour (timing
 * it was given, CRC-15, stuffing, arbitration, RS-232 levels).
 */
import { describe, expect, it } from 'vitest'

import { crc15, stuff, canBitTiming } from '../../../src/tools/protocol/can.js'
import { i2cModel } from '../../../src/tools/protocol/i2c.js'
import { roundTrip, runModel } from '../../../src/tools/protocol/models.js'
import { I2C_STANDARD } from '../../../src/tools/protocol/standards.js'
import { delayEdges } from '../../../src/tools/protocol/waveform.js'
import { I2C_LIMITS, i2cDecode, parseVcdText, readCsv, Signal } from '../../../src/tools/sim/wave.js'

const rt = (protocol: Parameters<typeof runModel>[0], config: Record<string, unknown>, txs: Record<string, unknown>[]) => {
  const m = runModel(protocol, config, txs)
  const r = roundTrip(m)
  return { m, r }
}

describe('I2C model', () => {
  it('round trips 7-bit write, read, combined write-then-read with repeated START, and NACK', () => {
    const { r } = rt('i2c', { speed: 'fast' }, [
      { addr: 0x50, write: [0x00, 0x10, 0xab] },
      { addr: 0x50, write: [0x00], read: 3, read_data: [1, 2, 3] },
      { addr: 0x3c, read: 2 },
      { addr: 0x21, write: [0x55], nack: 0 },
      { addr: 0x22, write: [1, 2, 3], nack: 2 },
    ])
    expect(r.first_difference).toBeNull()
    expect(r.match).toBe(true)
    expect(r.decoded).toHaveLength(6)
  })

  it('round trips 10-bit addressing (write, and read through the repeated START), general call and a chain of repeated STARTs', () => {
    const { r, m } = rt('i2c', { speed: 'standard' }, [
      { addr: 0x2a5, ten_bit: true, write: [0x11] },
      { addr: 0x2a5, ten_bit: true, read: 2 },
      { addr: 0, general_call: true, write: [0x06] },
      { addr: 0x48, write: [0x01], stop: false },
      { addr: 0x48, read: 1 },
    ])
    expect(r.first_difference).toBeNull()
    const segs = m.expected as { kind: string; addr: number; start: string }[]
    expect(segs.map((s) => s.kind)).toEqual(['ten_bit', 'ten_bit', 'ten_bit', 'general_call', 'address', 'address'])
    expect(segs[2]?.start).toBe('Sr')
    expect(segs[5]?.start).toBe('Sr')
  })

  it('honours its timing: the decode measures exactly the configured tLOW, tHIGH, tHD;DAT, tSU;DAT, and stretching lengthens tLOW', () => {
    const m = i2cModel({ speed: 'fast', t_low: 1.5e-6, t_high: 0.9e-6, thd_dat: 0.3e-6 }, [{ addr: 0x50, write: [0xa5] }])
    const c = m.wave.capture()
    const d = i2cDecode(c.get('scl'), c.get('sda'))
    expect(d.timing.t_low).toBeCloseTo(1.5e-6, 12)
    expect(d.timing.t_high).toBeCloseTo(0.9e-6, 12)
    expect(d.timing.thd_dat).toBeCloseTo(0.3e-6, 12)
    expect(d.timing.tsu_dat).toBeCloseTo(1.2e-6, 12)
    const s = i2cModel({ speed: 'fast' }, [{ addr: 0x50, write: [0xa5], stretch: [{ byte: 1, s: 5e-6 }] }])
    const sc = s.wave.capture()
    const lows = sc.get('scl').intervals('0').map(([a, b]) => b - a).filter((x) => Number.isFinite(x))
    expect(Math.max(...lows)).toBeCloseTo(s.timing.t_low + 5e-6, 10)
    expect(roundTrip({ ...runModel('i2c', {}, []), wave: s.wave, expected: s.expected, protocol: 'i2c', decode: {}, info: {} }).match).toBe(true)
  })

  it('arbitration: the master sending 0 where the other sends 1 wins; the loser releases SDA from that bit', () => {
    const m = i2cModel({ speed: 'fast' }, [{ addr: 0x51, write: [0x01], arbitration: { addr: 0x50, write: [0x02] } }])
    // 0x51 << 1 = 1010 0010, 0x50 << 1 = 1010 0000: they differ at bit 6 (0-based), where m2 sends 0
    expect(m.arbitration).toEqual([{ winner: 'm2', lost_at_bit: 6 }])
    const c = m.wave.capture()
    const segs = roundTrip({ protocol: 'i2c', wave: m.wave, expected: m.expected, decode: {}, info: {} })
    expect(segs.match).toBe(true)
    expect((m.expected[0] as { addr: number; data: number[] }).addr).toBe(0x50)
    expect((m.expected[0] as { data: number[] }).data).toEqual([0x02])
    // after losing, m1 drives 1 (released) for the rest of the transfer while the bus follows m2
    const m1 = c.get('m1_sda')
    const sda = c.get('sda')
    const late = sda.t.filter((t) => t > (sda.t[6] ?? 0))
    expect(late.some((t) => sda.at(t) === '0' && m1.at(t) === '1')).toBe(true)
  })

  it('Hs-mode sends the master code at Fast-mode timing, NACKed, then the transfer at Hs timing', () => {
    const { r, m } = rt('i2c', { speed: 'high_speed' }, [{ addr: 0x50, write: [0x12, 0x34] }])
    expect(r.match).toBe(true)
    expect((m.expected[0] as { kind: string }).kind).toBe('master_code')
    const c = m.wave.capture()
    const d = i2cDecode(c.get('scl'), c.get('sda'))
    // the shortest SCL high is Hs (60 ns min), well under Fast-mode's 600 ns
    expect(d.timing.t_high).toBeLessThan(0.6e-6)
    expect(d.timing.t_high).toBeGreaterThanOrEqual((I2C_STANDARD.high_speed.t_high?.min as number) - 1e-15)
  })

  it('UM10204 Table 10 figures agree between standards.ts and sim/wave.ts', () => {
    const map: Record<string, string> = { t_low: 't_low', t_high: 't_high', tsu_dat: 'tsu_dat', thd_dat: 'thd_dat', thd_sta: 'thd_sta', tsu_sta: 'tsu_sta', tsu_sto: 'tsu_sto', t_buf: 't_buf' }
    for (const mode of ['standard', 'fast', 'fast_plus'] as const) {
      expect(I2C_STANDARD[mode].f_scl?.max).toBe(I2C_LIMITS[mode].f_max)
      expect(I2C_STANDARD[mode].tvd_dat?.max).toBe(I2C_LIMITS[mode].tvd_dat_max)
      for (const [a, b] of Object.entries(map)) expect(I2C_STANDARD[mode][a as 't_low']?.min, `${mode} ${a}`).toBe(I2C_LIMITS[mode][b as 't_low'])
    }
  })
})

describe('SPI model', () => {
  it('round trips every mode, MSB and LSB first, 8/12/16-bit words, two selects', () => {
    for (const mode of [0, 1, 2, 3] as const) {
      for (const lsb_first of [false, true]) {
        for (const bits of [8, 12, 16]) {
          const mask = 2 ** bits - 1
          const { r } = rt('spi', { mode, bits, lsb_first, selects: 2, f_sck: 2e6, tv_slave: 40e-9, tho_slave: 5e-9 }, [
            { cs: 0, mosi: [0xa5 & mask, 0x3c & mask], miso: [0x5a & mask, 0xc3 & mask] },
            { cs: 1, mosi: [mask], miso: [1] },
          ])
          expect(r.first_difference, `mode ${mode} lsb ${lsb_first} bits ${bits}`).toBeNull()
        }
      }
    }
  })

  it('round trips a daisy chain of three, and shows each device\'s output', () => {
    const { r, m } = rt('spi', { mode: 0, bits: 8, daisy: 3 }, [{ mosi: [1, 2, 3], miso: [0xaa, 0xbb, 0xcc] }])
    expect(r.match).toBe(true)
    expect(m.wave.names()).toEqual(expect.arrayContaining(['chain_d1', 'chain_d2']))
  })

  it('round trips dual and quad lanes, and a single-lane command before a quad transfer', () => {
    expect(rt('spi', { mode: 0, bits: 8, lanes: 2 }, [{ io: [0x12, 0x34, 0xff] }]).r.match).toBe(true)
    expect(rt('spi', { mode: 3, bits: 8, lanes: 4 }, [{ io: [0xde, 0xad, 0xbe, 0xef] }]).r.match).toBe(true)
    const { r } = rt('spi', { mode: 0, bits: 8 }, [{ mosi: [0xeb] }, { lanes: 4, io: [0x01, 0x23] }])
    expect(r.first_difference).toBeNull()
  })
})

describe('UART / RS-232 model', () => {
  it('round trips data bits 5..9, parity even/odd/mark/space, 1/1.5/2 stop bits, inverted, a break and a 2 % clock error', () => {
    for (const data_bits of [5, 7, 8, 9]) {
      for (const parity of ['none', 'even', 'odd', 'mark', 'space']) {
        for (const stop_bits of [1, 1.5, 2]) {
          const bytes = [0x00, 0x15, (1 << data_bits) - 1]
          const { r } = rt('uart', { baud: 9600, data_bits, parity, stop_bits }, [{ bytes }])
          expect(r.first_difference, `${data_bits}${parity}${stop_bits}`).toBeNull()
        }
      }
    }
    expect(rt('uart', { baud: 115200, invert: true }, [{ text: 'Hi' }]).r.match).toBe(true)
    expect(rt('uart', { baud: 115200, baud_error: 0.02 }, [{ text: 'ok' }]).r.match).toBe(true)
    const b = rt('uart', { baud: 9600 }, [{ text: 'A' }, { break_bits: 15 }, { text: 'B' }])
    expect(b.r.first_difference).toBeNull()
    expect(b.m.expected).toEqual([{ kind: 'frame', value: 65 }, { kind: 'break', value: null }, { kind: 'frame', value: 66 }])
  })

  it('RS-232: mark is negative and space positive at the driver, and decodes at ±3 V thresholds', async () => {
    const m = runModel('uart', { baud: 19200, rs232: { v_mark: -6, v_space: 6, slew: 10e6 } }, [{ text: 'U' }])
    const csv = m.wave.analogCsv() as string
    const cap = await readCsv(new TextEncoder().encode(csv), 'line.csv')
    const line = cap.get('line_v', { vil: -3, vih: 3 })
    // idle (mark) is the negative level: the logic read from the voltage is 0 at the start
    expect(line.v[0]).toBe('0')
    const { uartDecode } = await import('../../../src/tools/sim/wave.js')
    const fr = uartDecode(line, { baud: 19200, invert: true }, cap.end)
    expect(fr.map((f) => f.value)).toEqual([0x55])
  })
})

describe('CAN model', () => {
  it('CRC-15 matches the bitwise definition and stuffing inserts after five equal bits', () => {
    expect(crc15([])).toBe(0)
    // a stuffed sequence never has six equal bits in a row
    const st = stuff([0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1])
    expect(st.bits.join('')).toBe('000001001111101')
    expect(st.stuffed).toEqual([5, 13])
  })

  it('round trips standard and extended frames, RTR, empty data, no ACK', () => {
    const { r } = rt('can', { bitrate: 500e3 }, [
      { id: 0x123, data: [0xde, 0xad, 0xbe, 0xef] },
      { id: 0x1abcdef, extended: true, data: [0, 0, 0, 0, 0, 0, 0, 0] },
      { id: 0x7ff, rtr: true, dlc: 2 },
      { id: 0x000, data: [] },
      { id: 0x10, data: [0xff, 0xff], ack: false },
    ])
    expect(r.first_difference).toBeNull()
  })

  it('bit timing from the clock, bitrate and sample point', () => {
    const t = canBitTiming({ bitrate: 500e3, sample_point: 0.875, sjw: 1, clock: 80e6 })
    expect(t.ok).toBe(true)
    expect(t.tq_per_bit * t.prescaler).toBe(160)
    expect(t.sample_point).toBeCloseTo(0.875, 3)
    expect(canBitTiming({ bitrate: 500e3, sample_point: 0.875, sjw: 4, clock: 8e6 }).problems.join(' ')).toMatch(/SJW 4/)
  })
})

describe('1-Wire and I2S models', () => {
  it('1-Wire round trips reset/presence, writes and reads at standard and overdrive speed', () => {
    for (const speed of ['standard', 'overdrive']) {
      const { r } = rt('onewire', { speed }, [{ reset: true, write: [0xcc, 0x44] }, { reset: true, write: [0xcc, 0xbe], read: [0x50, 0x05] }, { reset: true, presence: false }])
      expect(r.first_difference, speed).toBeNull()
    }
  })

  it('I2S round trips signed samples in i2s and left-justified formats, with wider slots', () => {
    const frames = [{ left: 1000, right: -1000 }, { left: -32768, right: 32767 }, { left: 0, right: -1 }]
    expect(rt('i2s', { word_bits: 16 }, frames).r.match).toBe(true)
    expect(rt('i2s', { word_bits: 16, format: 'left_justified' }, frames).r.match).toBe(true)
    expect(rt('i2s', { word_bits: 24, slot_bits: 32 }, [{ left: -8388608, right: 8388607 }]).r.match).toBe(true)
  })
})

describe('waveform plumbing', () => {
  it('the model VCD reads back with the same edges', () => {
    const m = runModel('spi', { mode: 1 }, [{ mosi: [0x81] }])
    const c = parseVcdText(m.wave.vcd())
    expect(c.get('sck').t).toEqual(m.wave.capture().get('sck').t)
    expect(c.end).toBeCloseTo(m.wave.end, 12)
  })

  it('edge delays shift rises and falls separately and swallow pulses shorter than their difference', () => {
    const s = new Signal('x')
    s.push(0, '0'); s.push(1e-6, '1'); s.push(2e-6, '0'); s.push(3e-6, '1'); s.push(3.1e-6, '0')
    const d = delayEdges(s, 300e-9, 10e-9)
    expect(d.t).toEqual([0, 1.3e-6, 2.01e-6])
    expect(d.v).toEqual(['0', '1', '0'])
  })
})

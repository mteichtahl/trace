import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { allTools } from '../../src/tools.js'
import { i2cDecode, parseVcdText, readCsv, readVcd, spiDecode, uartDecode, writeVcd } from '../../src/sim/wave.js'

type Changes = [number, string][]
const dir = mkdtempSync(join(tmpdir(), 'trace-wave-'))
const ctx = { hardware: false, via: 'test' } as const

// ------------------------------------------------------------------------------------------- generators

/** SPI master: each byte clocked MSB first in `mode`, CS low around each transfer. */
function spi(transfers: { mosi: number[]; miso: number[] }[], mode: 0 | 1 | 2 | 3, half = 50e-9): Record<string, Changes> {
  const cpol = mode >= 2 ? 1 : 0
  const cpha = mode % 2
  const sck: Changes = [[0, String(cpol)]]
  const mosi: Changes = [[0, '0']]
  const miso: Changes = [[0, '0']]
  const cs: Changes = [[0, '1']]
  let t = 100e-9
  for (const tr of transfers) {
    cs.push([t, '0'])
    t += half
    for (let k = 0; k < tr.mosi.length; k++) {
      for (let b = 7; b >= 0; b--) {
        const mo = String(((tr.mosi[k] as number) >> b) & 1)
        const mi = String(((tr.miso[k] as number) >> b) & 1)
        if (cpha === 0) {
          mosi.push([t - half / 2, mo])
          miso.push([t - half / 2, mi])
          sck.push([t, String(1 - cpol)])
          t += half
          sck.push([t, String(cpol)])
          t += half
        } else {
          sck.push([t, String(1 - cpol)])
          mosi.push([t + half / 4, mo])
          miso.push([t + half / 4, mi])
          t += half
          sck.push([t, String(cpol)])
          t += half
        }
      }
    }
    cs.push([t, '1'])
    t += 4 * half
  }
  return { sck, mosi, miso, cs }
}

/** I2C master: START, address + R/W, data bytes (each ACKed unless listed in nack), STOP. Open-drain: '0'/'1'. */
function i2c(frames: { addr: number; read: boolean; data: number[]; nackAddr?: boolean }[], q = 2.5e-6): Record<string, Changes> {
  const scl: Changes = [[0, '1']]
  const sda: Changes = [[0, '1']]
  let t = 10e-6
  const bit = (v: number): void => {
    sda.push([t + q / 2, String(v)]) // data changes while SCL is low
    t += q
    scl.push([t, '1'])
    t += 2 * q
    scl.push([t, '0'])
    t += q
  }
  for (const f of frames) {
    sda.push([t, '0']) // START: SDA falls while SCL is high
    t += 2 * q
    scl.push([t, '0'])
    t += q
    const bytes = [(f.addr << 1) | (f.read ? 1 : 0), ...f.data]
    bytes.forEach((b, i) => {
      for (let k = 7; k >= 0; k--) bit((b >> k) & 1)
      bit(i === 0 && f.nackAddr ? 1 : 0)
    })
    sda.push([t + q / 2, '0'])
    t += q
    scl.push([t, '1'])
    t += 2 * q
    sda.push([t, '1']) // STOP
    t += 10 * q
  }
  return { scl, sda }
}

function uart(bytes: number[], baud: number, parity: 'none' | 'even' = 'none'): Changes {
  const bit = 1 / baud
  const out: Changes = [[0, '1']]
  let t = 5 * bit
  for (const b of bytes) {
    const bits = [0]
    for (let k = 0; k < 8; k++) bits.push((b >> k) & 1)
    if (parity === 'even') bits.push(bits.slice(1).reduce((s, x) => s + x, 0) % 2)
    bits.push(1)
    for (const v of bits) {
      out.push([t, String(v)])
      t += bit
    }
    t += 2 * bit
  }
  return out
}

function dedupe(sig: Record<string, Changes>): Record<string, Changes> {
  const out: Record<string, Changes> = {}
  for (const [k, ch] of Object.entries(sig)) {
    const sorted = [...ch].sort((a, b) => a[0] - b[0])
    out[k] = sorted.filter((c, i) => i === 0 || c[1] !== (sorted[i - 1] as [number, string])[1])
  }
  return out
}

// ------------------------------------------------------------------------------------------- tests

describe('VCD', () => {
  it('round-trips through writeVcd and the streaming reader, buses included', async () => {
    const sig = { clk: [[0, '0'], [1e-9, '1'], [2e-9, '0']] as Changes, bus: [[0, '0000'], [1.5e-9, '1010']] as Changes }
    const path = join(dir, 'rt.vcd')
    writeFileSync(path, writeVcd(sig, { widths: { bus: 4 } }))
    const c = await readVcd(path)
    expect(c.get('clk').t).toEqual([0, 1e-9, 2e-9])
    expect(c.get('top.clk').v).toEqual(['0', '1', '0'])
    expect(c.get('bus').v).toEqual(['0000', '1010'])
    expect(c.get('bus').width).toBe(4)
  })

  it('reads Icarus-style headers with scopes, short vectors and comments', () => {
    const c = parseVcdText(`$date today $end
$timescale 10ns $end
$scope module tb $end
$var reg 1 ! clk $end
$scope module dut $end
$var wire 8 " data [7:0] $end
$var wire 1 # clk $end
$upscope $end
$upscope $end
$enddefinitions $end
$comment
 anything
$end
#0
$dumpvars
0!
b0 "
0#
$end
#3
1!
1#
b101 "
#7
x!
`)
    expect(c.timescale).toBe(1e-8)
    expect(c.get('tb.clk').t).toEqual([0, 3e-8, 7e-8])
    expect(c.get('dut.clk').v).toEqual(['0', '1'])
    expect(c.get('data').v).toEqual(['00000000', '00000101'])
    expect(c.has('clk')).toBe(false) // ambiguous leaf
  })

  it('reads a logic-analyser CSV with a unit in the time header', async () => {
    const path = join(dir, 'la.csv')
    writeFileSync(path, 'Time [us],D0,D1,A0\n0,0,1,0.1\n1,1,1,3.2\n2,1,0,3.3\n3,0,0,0.0\n')
    const c = await readCsv(path)
    expect(c.get('D0').t).toEqual([0, 1e-6, 3e-6])
    expect(c.get('A0', { threshold: 1.65 }).v).toEqual(['0', '1', '0'])
    expect(() => c.get('A0')).toThrow(/threshold/)
  })
})

describe('protocol decoders', () => {
  it('SPI in all four modes, both directions', () => {
    for (const mode of [0, 1, 2, 3] as const) {
      const c = parseVcdText(writeVcd(dedupe(spi([{ mosi: [0xa5, 0x3c], miso: [0x5a, 0xff] }, { mosi: [0x01], miso: [0x80] }], mode))))
      const tx = spiDecode({ sck: c.get('sck'), mosi: c.get('mosi'), miso: c.get('miso'), cs: c.get('cs') }, { mode })
      expect(tx.map((x) => x.mosi), `mode ${mode}`).toEqual([[0xa5, 0x3c], [0x01]])
      expect(tx.map((x) => x.miso), `mode ${mode}`).toEqual([[0x5a, 0xff], [0x80]])
    }
  })

  it('SPI LSB first reverses the bits', () => {
    const c = parseVcdText(writeVcd(dedupe(spi([{ mosi: [0x01], miso: [0x00] }], 0))))
    expect(spiDecode({ sck: c.get('sck'), mosi: c.get('mosi'), cs: c.get('cs') }, { lsbFirst: true })[0]?.mosi).toEqual([0x80])
  })

  it('I2C: address, R/W, ACK/NACK, data and timing', () => {
    const c = parseVcdText(writeVcd(dedupe(i2c([{ addr: 0x48, read: false, data: [0x01, 0xc0] }, { addr: 0x21, read: true, data: [], nackAddr: true }]))))
    const d = i2cDecode(c.get('scl'), c.get('sda'))
    expect(d.frames).toHaveLength(2)
    const [a, b] = d.frames
    expect((a?.bytes[0]?.value ?? 0) >> 1).toBe(0x48)
    expect(a?.bytes.map((x) => x.value)).toEqual([0x90, 0x01, 0xc0])
    expect(a?.bytes.every((x) => x.ack)).toBe(true)
    expect(a?.stopped).toBe(true)
    expect(b?.bytes[0]).toEqual({ value: (0x21 << 1) | 1, ack: false })
    // the generator: SCL low 2q = 5 µs, high 2q = 5 µs, data changes 1.5q after SCL falls (q/2 before it rises)
    expect(d.timing.t_low).toBeCloseTo(5e-6, 9)
    expect(d.timing.t_high).toBeCloseTo(5e-6, 9)
    expect(d.timing.thd_dat).toBeCloseTo(3.75e-6, 9)
    expect(d.timing.tsu_dat).toBeCloseTo(1.25e-6, 9)
    expect(d.timing.framing).toBe(0)
  })

  it('UART 8N1 and 8E1, with a framing error detected', () => {
    const baud = 115200
    const c = parseVcdText(writeVcd({ rx: uart([0x48, 0x69, 0x00, 0xff], baud) }, { timescale: '1ns' }))
    expect(uartDecode(c.get('rx'), { baud }).map((f) => f.value)).toEqual([0x48, 0x69, 0x00, 0xff])
    const e = parseVcdText(writeVcd({ rx: uart([0x07], baud, 'even') }, { timescale: '1ns' }))
    const [fe] = uartDecode(e.get('rx'), { baud, parity: 'even' })
    expect(fe).toEqual({ t: expect.any(Number), value: 0x07 })
    // read 8E1 as 8N1: the parity bit (1 for 0x07) lands where the stop bit is expected: fine; read 0x00 8E1 → stop ok.
    const bad = parseVcdText(writeVcd({ rx: [[0, '1'], [1e-5, '0'], [2e-3, '1']] }, { timescale: '1ns' }))
    expect(uartDecode(bad.get('rx'), { baud: 9600 })[0]?.framing_error).toBe(true)
  })
})

describe('wave tools', () => {
  const reg = allTools()
  const spiPath = join(dir, 'spi.vcd')
  writeFileSync(spiPath, writeVcd(dedupe(spi([{ mosi: [0xde, 0xad], miso: [0xbe, 0xef] }], 0))))

  it('sim.wave_read summarises signals', async () => {
    const r = (await reg.call('sim.wave_read', { file: spiPath }, ctx)) as { signal_count: number; signals: { name: string; pulses?: { rising: number } }[] }
    expect(r.signal_count).toBe(4)
    expect(r.signals.find((s) => s.name === 'top.sck')?.pulses?.rising).toBe(16)
  })

  it('sim.wave_decode: SPI by role, from a file', async () => {
    const r = (await reg.call('sim.wave_decode', { file: spiPath, protocol: 'spi', signals: { sck: 'sck', mosi: 'mosi', miso: 'miso', cs: 'cs' } }, ctx)) as { transfers: number; items: { mosi: string[]; miso: string[] }[] }
    expect(r.transfers).toBe(1)
    expect(r.items[0]).toMatchObject({ mosi: ['0xde', '0xad'], miso: ['0xbe', '0xef'] })
  })

  it('sim.wave_decode: I2C checked against fast mode', async () => {
    const p = join(dir, 'i2c.vcd')
    writeFileSync(p, writeVcd(dedupe(i2c([{ addr: 0x50, read: false, data: [0x12] }], 0.4e-6))))
    const r = (await reg.call('sim.wave_decode', { file: p, protocol: 'i2c', signals: { scl: 'scl', sda: 'sda' }, speed: 'fast' }, ctx)) as { items: { addr: string; rw: string; data: string[] }[]; pass: boolean; check: { parameter: string; ok: boolean }[] }
    expect(r.items[0]).toMatchObject({ addr: '0x50', rw: 'W', data: ['0x12'] })
    // SCL low here is 0.8 µs, below fast mode's 1.3 µs minimum
    expect(r.check.find((c) => c.parameter === 't_low')?.ok).toBe(false)
    expect(r.pass).toBe(false)
  })

  it('sim.wave_timing: setup/hold, CS to clock, overlap and pulses', async () => {
    const r = (await reg.call('sim.wave_timing', {
      file: spiPath,
      checks: [
        { kind: 'setup_hold', data: 'mosi', clock: 'sck', gate: 'cs', setup_min: 20e-9, hold_min: 20e-9 },
        { kind: 'cs_clock', cs: 'cs', clock: 'sck', lead_min: 40e-9 },
        { kind: 'overlap', signals: ['cs', 'miso'], active: '0' },
        { kind: 'pulse', signal: 'sck', min_high: 40e-9 },
      ],
    }, ctx)) as { pass: boolean; checks: Record<string, unknown>[] }
    const [sh, cs, ov, pu] = r.checks
    expect(sh).toMatchObject({ setup: 2.5e-8, pass: true })
    expect(sh?.hold).toBeGreaterThanOrEqual(5e-8)
    expect(cs).toMatchObject({ transactions: 1, lead: 5e-8, pass: true })
    expect(ov?.pass).toBe(false) // cs and miso are both low at times: overlap is found
    expect(pu?.pass).toBe(true)
    expect(r.pass).toBe(false)
  })

  it('a missing signal is a readable error', async () => {
    await expect(reg.call('sim.wave_decode', { file: spiPath, protocol: 'spi', signals: { sck: 'nope' } }, ctx)).rejects.toThrow(/sck: the capture has no signal "nope"/)
  })
})

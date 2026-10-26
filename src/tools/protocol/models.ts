/**
 * The models behind one interface, and the round trip: what a model run means as transactions, and what the
 * decoders (sim/wave.ts, sim/decode.ts) read back from its waveform, in the same normalised form, so the two can be
 * compared field by field.
 */
import { canDecode, i2sDecode, onewireDecode, spiDecodeLanes } from '../sim/decode.js'
import { Capture, i2cDecode, spiDecode, uartDecode, type Signal } from '../sim/wave.js'
import { CanConfigSchema, canModel } from './can.js'
import { i2cModel, i2cSegments } from './i2c.js'
import { I2sConfigSchema, i2sModel } from './i2s.js'
import { OneWireConfigSchema, onewireModel } from './onewire.js'
import type { Protocol } from './spec.js'
import { SpiConfigSchema, spiModel } from './spi.js'
import { UartConfigSchema, uartModel } from './uart.js'
import { ModelError, type WaveBuilder } from './waveform.js'

export interface ModelRun {
  protocol: Protocol
  wave: WaveBuilder
  /** the transactions as the decoders will see them (normalised) */
  expected: unknown[]
  /** decoder settings the waveform needs (mode, baud, …) */
  decode: Record<string, unknown>
  /** extra facts about the run (resolved timing, arbitration outcome, CAN bit timing) */
  info: Record<string, unknown>
}

export function runModel(protocol: Protocol, config: Record<string, unknown>, txs: readonly Record<string, unknown>[]): ModelRun {
  switch (protocol) {
    case 'i2c': {
      const r = i2cModel(config as never, txs as never)
      return { protocol, wave: r.wave, expected: r.expected, decode: {}, info: { timing: r.timing, ...(r.arbitration.length ? { arbitration: r.arbitration } : {}) } }
    }
    case 'spi': {
      const c = SpiConfigSchema.parse(config)
      const r = spiModel(c, txs as never)
      return { protocol, wave: r.wave, expected: r.expected, decode: { mode: c.mode, bits: c.bits, lsb_first: c.lsb_first, cs_active_high: c.cs_active_high, selects: c.selects }, info: { sample_edge: r.sample } }
    }
    case 'uart': {
      const c = UartConfigSchema.parse(config)
      const r = uartModel(c, txs as never)
      return { protocol, wave: r.wave, expected: r.expected, decode: { baud: c.baud, data_bits: c.data_bits, parity: c.parity, stop_bits: c.stop_bits, invert: c.invert }, info: { bit_time: 1 / (c.baud * (1 + c.baud_error)), ...(c.rs232 ? { rs232: c.rs232 } : {}) } }
    }
    case 'can': {
      const c = CanConfigSchema.parse(config)
      const r = canModel(c, txs as never)
      return { protocol, wave: r.wave, expected: r.expected, decode: { bitrate: c.bitrate, sample_point: c.sample_point }, info: { bit_timing: r.timing } }
    }
    case 'onewire': {
      const c = OneWireConfigSchema.parse(config)
      const r = onewireModel(c, txs as never)
      return { protocol, wave: r.wave, expected: r.expected.map((e) => (e.kind === 'reset' ? { kind: 'reset', presence: e.presence } : { kind: 'byte', value: e.value })), decode: { speed: c.speed }, info: { timing: r.timing } }
    }
    case 'i2s': {
      const c = I2sConfigSchema.parse(config)
      const r = i2sModel(c, txs as never)
      return { protocol, wave: r.wave, expected: r.expected, decode: { word_bits: c.word_bits, format: c.format }, info: { f_bclk: r.f_bclk } }
    }
  }
}

const sig = (c: Capture, n: string): Signal => c.get(n)

/** Decode a capture of a model's signals (same names) into the normalised transactions. */
export function decodeNormalised(protocol: Protocol, c: Capture, d: Record<string, unknown>, expected?: readonly unknown[]): unknown[] {
  switch (protocol) {
    case 'i2c':
      return i2cSegments(i2cDecode(sig(c, 'scl'), sig(c, 'sda')).frames)
    case 'spi': {
      const mode = (d.mode ?? 0) as 0 | 1 | 2 | 3
      const bits = (d.bits ?? 8) as number
      const opts = { mode, bits, lsbFirst: Boolean(d.lsb_first), csActiveHigh: Boolean(d.cs_active_high) }
      const selects = (d.selects ?? 1) as number
      const css = selects === 0 ? [null] : selects === 1 ? ['cs'] : Array.from({ length: selects }, (_, k) => `cs${k}`)
      const out: { start: number; v: { cs: number; lanes: number; mosi: number[]; miso: number[]; io: number[] } }[] = []
      const exp = (expected ?? []) as { lanes?: number }[]
      const lanesUsed = [...new Set(exp.map((e) => e.lanes ?? 1))]
      css.forEach((cs, k) => {
        const csSig = cs ? sig(c, cs) : undefined
        for (const lanes of lanesUsed.length ? lanesUsed : [1]) {
          if (lanes === 1) {
            for (const t of spiDecode({ sck: sig(c, 'sck'), mosi: c.has('mosi') ? sig(c, 'mosi') : undefined, miso: c.has('miso') ? sig(c, 'miso') : undefined, ...(csSig ? { cs: csSig } : {}) } as never, opts, c.end)) {
              if (c.has('io0') && t.mosi.length === 0) continue
              out.push({ start: t.start, v: { cs: k, lanes: 1, mosi: t.mosi.map((x) => x ?? -1), miso: t.miso.map((x) => x ?? -1), io: [] } })
            }
          } else {
            const io = Array.from({ length: lanes }, (_, i) => sig(c, `io${i}`))
            for (const t of spiDecodeLanes({ sck: sig(c, 'sck'), io, cs: csSig }, opts)) out.push({ start: t.start, v: { cs: k, lanes, mosi: [], miso: [], io: t.words.map((x) => x ?? -1) } })
          }
        }
      })
      // a window decoded both ways (mixed lanes): keep the reading whose lane count the transfer used
      out.sort((a, b) => a.start - b.start)
      const merged: typeof out = []
      for (const o of out) {
        const prev = merged[merged.length - 1]
        if (prev && Math.abs(prev.start - o.start) < 1e-15) {
          const want = (exp[merged.length - 1]?.lanes ?? 1)
          if (o.v.lanes === want) merged[merged.length - 1] = o
          continue
        }
        merged.push(o)
      }
      return merged.map((x) => x.v)
    }
    case 'uart': {
      const fr = uartDecode(sig(c, 'tx'), { baud: d.baud as number, dataBits: d.data_bits as number, parity: d.parity as 'none', stopBits: d.stop_bits as 1, invert: Boolean(d.invert) }, c.end)
      return fr.map((f) => (f.framing_error && f.value === 0 ? { kind: 'break', value: null } : { kind: 'frame', value: f.value }))
    }
    case 'can':
      return canDecode(sig(c, 'can'), { bitrate: d.bitrate as number, samplePoint: d.sample_point as number }, c.end).map((f) => ({ id: f.id, extended: f.extended, rtr: f.rtr, dlc: f.dlc, data: f.data, crc: f.crc, ack: f.ack }))
    case 'onewire':
      return onewireDecode(sig(c, 'dq'), { speed: d.speed as 'standard' }).events.map((e) => (e.kind === 'reset' ? { kind: 'reset', presence: e.presence } : { kind: 'byte', value: e.value }))
    case 'i2s':
      return i2sDecode({ sck: sig(c, 'sck'), ws: sig(c, 'ws'), sd: sig(c, 'sd') }, { wordBits: d.word_bits as number, format: d.format as 'i2s' }).frames.map((f) => ({ left: f.left, right: f.right }))
  }
}

/** Compare: equal when every transaction's fields match. The first difference, when not. */
export function compareTransactions(expected: readonly unknown[], decoded: readonly unknown[]): { match: boolean; first_difference: { index: number; expected: unknown; decoded: unknown } | null } {
  const n = Math.max(expected.length, decoded.length)
  for (let i = 0; i < n; i++) {
    const a = JSON.stringify(expected[i] ?? null)
    const b = JSON.stringify(decoded[i] ?? null)
    if (a !== b) return { match: false, first_difference: { index: i, expected: expected[i] ?? null, decoded: decoded[i] ?? null } }
  }
  return { match: true, first_difference: null }
}

export function roundTrip(m: ModelRun): { match: boolean; first_difference: { index: number; expected: unknown; decoded: unknown } | null; decoded: unknown[] } {
  let decoded: unknown[]
  try {
    decoded = decodeNormalised(m.protocol, m.wave.capture(), m.decode, m.expected)
  } catch (e) {
    throw new ModelError(`decoding the model's own waveform failed: ${(e as Error).message}`)
  }
  return { ...compareTransactions(m.expected, decoded), decoded }
}

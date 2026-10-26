/**
 * Classical CAN 2.0A (11-bit) and 2.0B (29-bit) frames, ISO 11898-1: SOF, arbitration field (ID, SRR and IDE for
 * extended, RTR), control field (IDE / r0, r1 for extended, DLC), data, CRC-15 (polynomial 0x4599 over SOF to the
 * end of data, before stuffing), CRC delimiter, ACK slot (driven dominant by a receiver), ACK delimiter, 7 recessive
 * EOF bits and a 3-bit intermission. Bit stuffing: after five equal bits from SOF to the end of the CRC sequence the
 * transmitter inserts the complement. The bus line `can` is logic: 0 = dominant, 1 = recessive.
 *
 * Bit timing: the bit is sync (1 tq) + tseg1 (prop + phase 1) + tseg2 (phase 2) time quanta; the sample point is
 * after tseg1. canBitTiming finds tq from a controller clock and prescaler, or the whole set from a bitrate and
 * a sample point, and checks SJW <= min(4, tseg2) as Classical CAN controllers require. The model's edges fall on
 * nominal bit boundaries; the decoder samples each bit at the sample point and resynchronises on recessive to
 * dominant edges by at most SJW.
 */
import { z } from 'zod'

import { ModelError, WaveBuilder } from './waveform.js'

export const CanConfigSchema = z.object({
  bitrate: z.number().positive().default(500e3),
  sample_point: z.number().gt(0.5).lt(1).default(0.875),
  sjw: z.number().int().min(1).max(4).default(1).describe('synchronisation jump width, tq'),
  clock: z.number().positive().default(80e6).describe('controller clock (Hz), for the time quantum'),
  t_idle: z.number().min(0).optional().describe('idle time before the first frame (default 11 bit times)'),
}).strict()
export type CanConfig = z.input<typeof CanConfigSchema>

export const CanFrameSchema = z.object({
  id: z.number().int().min(0).max(0x1fffffff),
  extended: z.boolean().optional(),
  rtr: z.boolean().optional(),
  data: z.array(z.number().int().min(0).max(255)).max(8).optional(),
  dlc: z.number().int().min(0).max(15).optional().describe('default data length (RTR: what is requested)'),
  ack: z.boolean().optional().describe('a receiver acknowledges (default true)'),
}).strict()
export type CanFrame = z.input<typeof CanFrameSchema>

export interface CanBitTiming { tq: number; prescaler: number; tq_per_bit: number; tseg1: number; tseg2: number; sjw: number; sample_point: number; bitrate: number; ok: boolean; problems: string[] }

export function canBitTiming(c: { bitrate: number; sample_point: number; sjw: number; clock: number }): CanBitTiming {
  const problems: string[] = []
  // the prescaler that gives 8 to 25 tq per bit with the sample point closest to the one asked for
  let best: CanBitTiming | null = null
  for (let brp = 1; brp <= 1024; brp++) {
    const n = c.clock / (brp * c.bitrate)
    if (Math.abs(n - Math.round(n)) > 1e-9 || n < 8 || n > 25) continue
    const N = Math.round(n)
    const tseg1 = Math.round(c.sample_point * N) - 1
    const tseg2 = N - 1 - tseg1
    if (tseg2 < 1 || tseg1 < 2) continue
    const sp = (1 + tseg1) / N
    const cand: CanBitTiming = { tq: brp / c.clock, prescaler: brp, tq_per_bit: N, tseg1, tseg2, sjw: c.sjw, sample_point: sp, bitrate: c.bitrate, ok: true, problems: [] }
    if (!best || Math.abs(sp - c.sample_point) < Math.abs(best.sample_point - c.sample_point) - 1e-12) best = cand
  }
  if (!best) {
    problems.push(`no prescaler of ${c.clock} Hz gives a whole 8..25 tq per bit at ${c.bitrate} bit/s`)
    return { tq: NaN, prescaler: NaN, tq_per_bit: NaN, tseg1: NaN, tseg2: NaN, sjw: c.sjw, sample_point: c.sample_point, bitrate: c.bitrate, ok: false, problems }
  }
  if (c.sjw > Math.min(4, best.tseg2)) problems.push(`SJW ${c.sjw} tq exceeds min(4, tseg2 = ${best.tseg2})`)
  return { ...best, ok: problems.length === 0, problems }
}

/** CRC-15/CAN over a bit sequence (polynomial x^15 + x^14 + x^10 + x^8 + x^7 + x^4 + x^3 + 1). */
export function crc15(bits: readonly (0 | 1)[]): number {
  let crc = 0
  for (const b of bits) {
    const next = b ^ ((crc >> 14) & 1)
    crc = (crc << 1) & 0x7fff
    if (next) crc ^= 0x4599
  }
  return crc
}

const bitsN = (v: number, n: number): (0 | 1)[] => Array.from({ length: n }, (_, k) => (Math.floor(v / 2 ** (n - 1 - k)) & 1) as 0 | 1)

/** The frame's bits from SOF to the end of data (unstuffed), and the CRC. */
export function canFrameBits(f: z.output<typeof CanFrameSchema>): { bits: (0 | 1)[]; crc: number; dlc: number } {
  const data = f.data ?? []
  const dlc = f.dlc ?? data.length
  if (!f.rtr && dlc !== data.length && dlc <= 8) throw new ModelError(`DLC ${dlc} but ${data.length} data bytes`)
  const ext = f.extended ?? f.id > 0x7ff
  if (!ext && f.id > 0x7ff) throw new ModelError(`id 0x${f.id.toString(16)} needs extended`)
  const bits: (0 | 1)[] = [0] // SOF
  if (ext) {
    bits.push(...bitsN(f.id >>> 18, 11), 1, 1, ...bitsN(f.id & 0x3ffff, 18), f.rtr ? 1 : 0, 0, 0) // base, SRR, IDE, ext, RTR, r1, r0
  } else {
    bits.push(...bitsN(f.id, 11), f.rtr ? 1 : 0, 0, 0) // RTR, IDE, r0
  }
  bits.push(...bitsN(dlc, 4))
  if (!f.rtr) for (const d of data) bits.push(...bitsN(d, 8))
  return { bits, crc: crc15(bits), dlc }
}

/** Insert stuff bits: after five equal bits, their complement. */
export function stuff(bits: readonly (0 | 1)[]): { bits: (0 | 1)[]; stuffed: number[] } {
  const out: (0 | 1)[] = []
  const stuffed: number[] = []
  let run = 0
  let last = -1
  for (const b of bits) {
    out.push(b)
    if (b === last) run++
    else { run = 1; last = b }
    if (run === 5) {
      const s = (1 - b) as 0 | 1
      stuffed.push(out.length)
      out.push(s)
      last = s
      run = 1
    }
  }
  return { bits: out, stuffed }
}

export interface CanExpected { id: number; extended: boolean; rtr: boolean; dlc: number; data: number[]; crc: number; ack: boolean }

export function canModel(cfgIn: CanConfig, frames: readonly CanFrame[]): { wave: WaveBuilder; expected: CanExpected[]; timing: CanBitTiming } {
  const c = CanConfigSchema.parse(cfgIn)
  const timing = canBitTiming(c)
  const bit = 1 / c.bitrate
  const w = new WaveBuilder('can')
  w.declare('can', '1', { driven: true })
  let t = c.t_idle ?? 11 * bit
  const expected: CanExpected[] = []
  frames.forEach((raw, i) => {
    const f = CanFrameSchema.parse(raw)
    const { bits, crc, dlc } = canFrameBits(f)
    const st = stuff([...bits, ...bitsN(crc, 15)])
    const ack = f.ack ?? true
    const tail: (0 | 1)[] = [1, ack ? 0 : 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] // CRC delim, ACK, ACK delim, EOF ×7, IFS ×3
    const all = [...st.bits, ...tail]
    const t0 = t
    all.forEach((b, k) => w.set('can', t0 + k * bit, String(b)))
    const ext = f.extended ?? f.id > 0x7ff
    w.note({ t0, t1: t0 + bit, lane: 'can', label: 'SOF', kind: 'start', tx: i })
    w.note({ t0: t0 + bit, t1: t0 + (st.bits.length) * bit, lane: 'can', label: `${ext ? 'EXT' : 'STD'} 0x${f.id.toString(16)}${f.rtr ? ' RTR' : ''} DLC ${dlc}${f.rtr ? '' : ` [${(f.data ?? []).map((d) => d.toString(16).padStart(2, '0')).join(' ')}]`} CRC 0x${crc.toString(16)}`, kind: 'data', tx: i })
    w.note({ t0: t0 + (st.bits.length + 1) * bit, t1: t0 + (st.bits.length + 2) * bit, lane: 'can', label: ack ? 'ACK' : 'no ACK', kind: ack ? 'ack' : 'nack', tx: i })
    w.note({ t0: t0 + (st.bits.length + 3) * bit, t1: t0 + (st.bits.length + 10) * bit, lane: 'can', label: 'EOF', kind: 'stop', tx: i })
    if (ack) w.expect({ t: t0 + (st.bits.length + 1 + timing.sample_point) * bit, signal: 'can', expected: '0', label: `frame ${i} ACK slot` })
    expected.push({ id: f.id, extended: ext, rtr: Boolean(f.rtr), dlc, data: f.rtr ? [] : [...(f.data ?? [])], crc, ack })
    t = t0 + all.length * bit
  })
  w.idle(t + bit)
  return { wave: w, expected, timing }
}

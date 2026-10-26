/**
 * UART / RS-232 model: bytes in, a TX line out.
 *
 * A frame is a start bit (space, logic 0), 5 to 9 data bits LSB first, an optional parity bit (even, odd, mark,
 * space), and 1, 1.5 or 2 stop bits (mark, logic 1); the line idles at mark. A break holds space for a given number
 * of bit times (at least a whole frame, or it is a framing error). `invert` idles the logic line low (after an
 * inverting level shifter). `baud_error` is the transmitter's clock error (+0.02 = 2 % fast), so a receiver's
 * tolerance can be tested.
 *
 * RS-232 (`rs232`): the line driver's output voltage as an analog line `line_v`, mark negative and space positive
 * (TIA-232-F: logic 1 = mark < -3 V, logic 0 = space > +3 V at the receiver), each transition a ramp at the driver's
 * slew rate. It goes to its own CSV artifact; sim.wave_decode reads it with vil = -3, vih = +3 and invert = true
 * (space is the high voltage). protocol.bus_analog adds the cable and the receiver load.
 */
import { z } from 'zod'

import { ModelError, WaveBuilder } from './waveform.js'

export const UartConfigSchema = z.object({
  baud: z.number().positive().default(115200),
  data_bits: z.number().int().min(5).max(9).default(8),
  parity: z.enum(['none', 'even', 'odd', 'mark', 'space']).default('none'),
  stop_bits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).default(1),
  invert: z.boolean().default(false),
  baud_error: z.number().min(-0.2).max(0.2).default(0).describe("the transmitter's rate error, fraction (0.02 = 2 % fast)"),
  gap_bits: z.number().min(0).default(0).describe('idle bit times between frames'),
  t_idle: z.number().min(0).optional().describe('idle time before the first frame (default two bit times)'),
  rs232: z.object({
    v_mark: z.number().max(0).default(-5.5).describe('mark (logic 1, idle) level, V'),
    v_space: z.number().min(0).default(5.5).describe('space (logic 0) level, V'),
    slew: z.number().positive().default(10e6).describe('driver slew rate, V/s (TIA-232-F allows at most 30 V/µs)'),
  }).strict().optional(),
}).strict()
export type UartConfig = z.input<typeof UartConfigSchema>

export const UartTxSchema = z.object({
  bytes: z.array(z.number().int().min(0).max(511)).optional(),
  text: z.string().optional().describe('ASCII text, sent as bytes'),
  break_bits: z.number().positive().optional().describe('a break: space for this many bit times'),
}).strict()
export type UartTx = z.input<typeof UartTxSchema>

export interface UartExpected { kind: 'frame' | 'break'; value: number | null }

export function uartModel(cfgIn: UartConfig, txs: readonly UartTx[]): { wave: WaveBuilder; expected: UartExpected[] } {
  const c = UartConfigSchema.parse(cfgIn)
  const bit = 1 / (c.baud * (1 + c.baud_error))
  const w = new WaveBuilder('uart')
  const mark = c.invert ? '0' : '1'
  const space = c.invert ? '1' : '0'
  w.declare('tx', mark, { driven: true })
  const expected: UartExpected[] = []
  let t = c.t_idle ?? 2 * bit
  const levels: [number, 0 | 1][] = [[0, 1]] // logic level (1 = mark) changes, for the RS-232 line
  const put = (at: number, logic: 0 | 1): void => {
    w.set('tx', at, logic ? mark : space)
    const last = levels[levels.length - 1] as [number, 0 | 1]
    if (last[1] !== logic) levels.push([at, logic])
  }
  const mask = (1 << c.data_bits) - 1
  for (const raw of txs) {
    const x = UartTxSchema.parse(raw)
    if (x.break_bits !== undefined) {
      put(t, 0)
      const end = t + x.break_bits * bit
      w.note({ t0: t, t1: end, lane: 'uart', label: 'BREAK', kind: 'error' })
      put(end, 1)
      expected.push({ kind: 'break', value: null })
      t = end + bit * (1 + c.gap_bits)
      continue
    }
    const bytes = [...(x.bytes ?? []), ...[...(x.text ?? '')].map((ch) => ch.charCodeAt(0))]
    for (const v of bytes) {
      if (v > mask) throw new ModelError(`0x${v.toString(16)} does not fit ${c.data_bits} data bits`)
      const t0 = t
      put(t, 0)
      let ones = 0
      for (let k = 0; k < c.data_bits; k++) {
        const b = ((v >> k) & 1) as 0 | 1
        ones += b
        put(t0 + bit * (1 + k), b)
      }
      let pos = 1 + c.data_bits
      if (c.parity !== 'none') {
        const p = c.parity === 'even' ? ones % 2 : c.parity === 'odd' ? 1 - (ones % 2) : c.parity === 'mark' ? 1 : 0
        put(t0 + bit * pos, p as 0 | 1)
        pos++
      }
      put(t0 + bit * pos, 1)
      const end = t0 + bit * (pos + c.stop_bits)
      const label = v >= 32 && v < 127 ? `0x${v.toString(16).padStart(2, '0')} '${String.fromCharCode(v)}'` : `0x${v.toString(16).padStart(2, '0')}`
      w.note({ t0, t1: end, lane: 'uart', label, kind: 'data' })
      expected.push({ kind: 'frame', value: v })
      t = end + bit * c.gap_bits
    }
  }
  w.idle(t + bit)
  if (c.rs232) {
    const { v_mark, v_space, slew } = c.rs232
    const lv = (l: 0 | 1): number => (l ? v_mark : v_space)
    const ramp = Math.abs(v_space - v_mark) / slew
    if (ramp > bit / 2) throw new ModelError(`RS-232: a ${ramp * 1e6} µs transition is over half a bit (${(bit * 1e6).toFixed(3)} µs): raise the slew rate or lower the baud`)
    w.analogPoint('line_v', 0, lv(1))
    for (const [at, l] of levels.slice(1)) {
      const from = lv(l ? 0 : 1)
      const to = lv(l)
      // the ramp starts at the logic change and is sampled in eight steps, so a threshold crossing is resolved
      for (let k = 0; k <= 8; k++) w.analogPoint('line_v', at + (ramp * k) / 8, from + ((to - from) * k) / 8)
    }
    w.analogPoint('line_v', w.end, lv(levels[levels.length - 1]?.[1] ?? 1))
  }
  return { wave: w, expected }
}

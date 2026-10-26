/**
 * I2S model (Philips I2S bus specification, 1986 / 1996): SCK (bit clock), WS (word select: 0 = left, 1 = right) and
 * SD (serial data, two's complement, MSB first). The transmitter changes SD and WS on SCK's falling edge and the
 * receiver samples on the rising edge; in `i2s` format the MSB comes one SCK period after WS changes, in
 * `left_justified` with it. Each channel occupies `slot_bits` clocks, the word in its first `word_bits`, zeros after.
 */
import { z } from 'zod'

import { ModelError, WaveBuilder } from './waveform.js'

export const I2sConfigSchema = z.object({
  sample_rate: z.number().positive().default(48e3),
  word_bits: z.number().int().min(4).max(32).default(16),
  slot_bits: z.number().int().min(4).max(32).optional().describe('clocks per channel (default word_bits)'),
  format: z.enum(['i2s', 'left_justified']).default('i2s'),
}).strict()
export type I2sConfig = z.input<typeof I2sConfigSchema>

export const I2sFrameSchema = z.object({ left: z.number().int(), right: z.number().int() }).strict()
export type I2sFrame = z.input<typeof I2sFrameSchema>

export function i2sModel(cfgIn: I2sConfig, frames: readonly I2sFrame[]): { wave: WaveBuilder; expected: { left: number; right: number }[]; f_bclk: number } {
  const c = I2sConfigSchema.parse(cfgIn)
  const slot = c.slot_bits ?? c.word_bits
  if (slot < c.word_bits) throw new ModelError('slot_bits must be at least word_bits')
  const fb = c.sample_rate * 2 * slot
  const T = 1 / fb
  const w = new WaveBuilder('i2s')
  w.declare('sck', '0', { driven: true })
  w.declare('ws', '1', { driven: true })
  w.declare('sd', '0', { driven: true })
  const lim = 2 ** (c.word_bits - 1)
  const delay = c.format === 'i2s' ? 1 : 0
  // the bit stream, one entry per SCK period: [ws, sd]
  const stream: [string, string][] = [['1', '0']] // one idle right-channel period, so the first WS change is seen
  for (const raw of frames) {
    const f = I2sFrameSchema.parse(raw)
    for (const [ch, v] of [['0', f.left], ['1', f.right]] as const) {
      if (v < -lim || v >= lim) throw new ModelError(`sample ${v} does not fit ${c.word_bits} bits`)
      const u = v < 0 ? v + 2 * lim : v
      for (let k = 0; k < slot; k++) stream.push([ch, k < c.word_bits ? String(Math.floor(u / 2 ** (c.word_bits - 1 - k)) & 1) : '0'])
    }
  }
  // WS leads the data by `delay` periods; one idle (right-channel) period first
  const t0 = T
  const n = stream.length + 1
  for (let k = 0; k < n + delay; k++) {
    const fall = t0 + k * T
    const wsv = (stream[k] ?? stream[stream.length - 1] ?? ['1', '0'])[0]
    const sdv = (stream[k - delay] ?? ['0', '0'])[1]
    w.set('sck', fall, '0')
    if (k < stream.length) w.set('ws', fall, wsv)
    w.set('sd', fall, k - delay >= 0 && k - delay < stream.length ? sdv : '0')
    w.set('sck', fall + T / 2, '1')
  }
  frames.forEach((_, i) => {
    const a = t0 + (1 + i * 2 * slot + delay) * T
    w.note({ t0: a, t1: a + slot * T, lane: 'i2s', label: `L ${frames[i]?.left}`, kind: 'data', tx: i })
    w.note({ t0: a + slot * T, t1: a + 2 * slot * T, lane: 'i2s', label: `R ${frames[i]?.right}`, kind: 'data', tx: i })
  })
  w.idle(t0 + (n + delay + 1) * T)
  return { wave: w, expected: frames.map((f) => ({ left: f.left, right: f.right })), f_bclk: fb }
}

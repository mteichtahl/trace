/**
 * 1-Wire model (Maxim AN126 timings A..J, standard and overdrive, standards.ts): a reset pulse and the responder's
 * presence pulse, write-1 and write-0 slots, and read slots (the master pulls low for A, releases; a responder sending
 * 0 holds the line low until rd0 from the slot start). Bytes go LSB first. The line `dq` is the wired-AND bus (1 =
 * released, pulled up). Every time can be overridden.
 */
import { z } from 'zod'

import { ONEWIRE, type OneWireTiming } from './standards.js'
import { WaveBuilder } from './waveform.js'

const t = z.number().min(0).optional()
export const OneWireConfigSchema = z.object({
  speed: z.enum(['standard', 'overdrive']).default('standard'),
  a: t, b: t, c: t, d: t, e: t, f: t, g: t, h: t, i: t, j: t, pdh: t, pdl: t, rd0: t,
  t_idle: z.number().min(0).optional(),
}).strict()
export type OneWireConfig = z.input<typeof OneWireConfigSchema>

export const OneWireTxSchema = z.object({
  reset: z.boolean().optional().describe('a reset pulse, and the presence pulse unless presence is false'),
  presence: z.boolean().optional(),
  write: z.array(z.number().int().min(0).max(255)).optional(),
  read: z.array(z.number().int().min(0).max(255)).optional().describe("read slots: the responder's bytes"),
}).strict()
export type OneWireTx = z.input<typeof OneWireTxSchema>

export interface OneWireExpected { kind: 'reset' | 'byte'; presence?: boolean; value?: number; dir?: 'w' | 'r' }

export function onewireModel(cfgIn: OneWireConfig, txs: readonly OneWireTx[]): { wave: WaveBuilder; expected: OneWireExpected[]; timing: OneWireTiming } {
  const c = OneWireConfigSchema.parse(cfgIn)
  const base = ONEWIRE[c.speed]
  const T: OneWireTiming = { a: c.a ?? base.a, b: c.b ?? base.b, c: c.c ?? base.c, d: c.d ?? base.d, e: c.e ?? base.e, f: c.f ?? base.f, g: c.g ?? base.g, h: c.h ?? base.h, i: c.i ?? base.i, j: c.j ?? base.j, pdh: c.pdh ?? base.pdh, pdl: c.pdl ?? base.pdl, rd0: c.rd0 ?? base.rd0 }
  const w = new WaveBuilder('onewire')
  w.declare('dq', '1', { driven: true })
  const expected: OneWireExpected[] = []
  let now = c.t_idle ?? T.h / 4
  txs.forEach((raw, k) => {
    const x = OneWireTxSchema.parse(raw)
    if (x.reset) {
      now += T.g
      const t0 = now
      w.set('dq', now, '0')
      now += T.h
      w.set('dq', now, '1')
      const presence = x.presence ?? true
      if (presence) {
        w.set('dq', now + T.pdh, '0')
        w.set('dq', now + T.pdh + T.pdl, '1')
        w.expect({ t: now + T.i, signal: 'dq', expected: '0', label: `reset ${k} presence` })
      }
      w.note({ t0, t1: now, lane: 'onewire', label: 'RESET', kind: 'start', tx: k })
      if (presence) w.note({ t0: now + T.pdh, t1: now + T.pdh + T.pdl, lane: 'onewire', label: 'PRESENCE', kind: 'ack', tx: k })
      now += T.i + T.j
      expected.push({ kind: 'reset', presence })
    }
    for (const v of x.write ?? []) {
      const t0 = now
      for (let b = 0; b < 8; b++) {
        const one = (v >> b) & 1
        w.set('dq', now, '0')
        w.set('dq', now + (one ? T.a : T.c), '1')
        now += one ? T.a + T.b : T.c + T.d
      }
      w.note({ t0, t1: now, lane: 'onewire', label: `W 0x${v.toString(16).padStart(2, '0')}`, kind: 'data', tx: k })
      expected.push({ kind: 'byte', value: v, dir: 'w' })
    }
    for (const v of x.read ?? []) {
      const t0 = now
      for (let b = 0; b < 8; b++) {
        const one = (v >> b) & 1
        w.set('dq', now, '0')
        // a 1: the master's own short low; a 0: the responder keeps it low until rd0
        w.set('dq', now + (one ? T.a : Math.max(T.rd0, T.a)), '1')
        w.expect({ t: now + T.a + T.e, signal: 'dq', expected: one ? '1' : '0', label: `tx ${k} read bit ${b}` })
        now += T.a + T.e + T.f
      }
      w.note({ t0, t1: now, lane: 'onewire', label: `R 0x${v.toString(16).padStart(2, '0')}`, kind: 'data', tx: k })
      expected.push({ kind: 'byte', value: v, dir: 'r' })
    }
  })
  w.idle(now + T.h / 4)
  return { wave: w, expected, timing: T }
}

/**
 * Decode rows for a capture that did not come from a model (a simulator's VCD, a logic analyser): the decoders'
 * results placed in time, so protocol.diagram draws START, ADDR 0x50 W, ACK, DATA ... over any capture. A model run
 * carries its own annotations, written as it generated the edges.
 */
import { canDecode, i2sDecode, onewireDecode } from '../sim/decode.js'
import { i2cDecode, Signal, spiDecode, uartDecode } from '../sim/wave.js'
import { i2cSegments } from './i2c.js'
import type { Annotation } from './waveform.js'

const hex = (v: number | null): string => (v === null ? '??' : `0x${v.toString(16).padStart(2, '0')}`)

export function annotateI2c(scl: Signal, sda: Signal): Annotation[] {
  const d = i2cDecode(scl, sda)
  const segs = i2cSegments(d.frames)
  const out: Annotation[] = []
  const rises = scl.edges('rising')
  const falls = scl.edges('falling')
  d.frames.forEach((f, i) => {
    const end = Number.isFinite(f.end) ? f.end : Math.max(f.t, ...falls)
    out.push({ t0: f.t, t1: f.t + (falls.find((x) => x > f.t) ?? f.t) - f.t, lane: 'i2c', label: f.repeated ? 'Sr' : 'S', kind: f.repeated ? 'restart' : 'start', tx: i })
    // the bit clocks of this frame: SCL highs that end inside it
    const bits = rises.filter((r) => r > f.t && r < end && (falls.find((x) => x > r) ?? Infinity) < end)
    const seg = segs[i]
    f.bytes.forEach((b, k) => {
      const r0 = bits[k * 9]
      const r7 = bits[k * 9 + 7]
      const r8 = bits[k * 9 + 8]
      if (r0 === undefined || r7 === undefined) return
      const f7 = falls.find((x) => x > r7) ?? r7
      const label = k === 0 && seg ? (seg.kind === 'general_call' ? 'GC 0x00 W' : seg.kind === 'master_code' ? `HS code ${hex(b.value)}` : seg.addr !== null && seg.kind === 'address' ? `ADDR 0x${seg.addr.toString(16).padStart(2, '0')} ${seg.rw}` : `ADDR byte ${hex(b.value)}`) : hex(b.value)
      out.push({ t0: r0 - (r0 - (falls.filter((x) => x < r0).pop() ?? r0)) / 2, t1: f7, lane: 'i2c', label, kind: k === 0 ? 'addr' : 'data', tx: i })
      if (r8 !== undefined) out.push({ t0: f7, t1: falls.find((x) => x > r8) ?? r8, lane: 'i2c', label: b.ack ? 'ACK' : 'NACK', kind: b.ack ? 'ack' : 'nack', tx: i })
    })
    if (f.stopped) out.push({ t0: rises.filter((x) => x < f.end).pop() ?? f.end, t1: f.end, lane: 'i2c', label: 'P', kind: 'stop', tx: i })
  })
  return out
}

export function annotateSpi(sig: { sck: Signal; mosi?: Signal | undefined; miso?: Signal | undefined; cs?: Signal | undefined }, o: { mode: 0 | 1 | 2 | 3; bits: number; lsbFirst?: boolean; csActiveHigh?: boolean }, end: number): Annotation[] {
  const tx = spiDecode(sig as { sck: Signal; mosi?: Signal; miso?: Signal; cs?: Signal }, { mode: o.mode, bits: o.bits, lsbFirst: o.lsbFirst ?? false, csActiveHigh: o.csActiveHigh ?? false }, end)
  const sampleRising = (o.mode >= 2) === (o.mode % 2 === 1)
  const edges = sig.sck.edges(sampleRising ? 'rising' : 'falling')
  const out: Annotation[] = []
  tx.forEach((t, i) => {
    out.push({ t0: t.start, t1: t.end, lane: 'spi', label: 'CS', kind: 'frame', tx: i })
    const es = edges.filter((x) => x > t.start && x < t.end)
    const n = Math.max(t.mosi.length, t.miso.length)
    for (let k = 0; k < n; k++) {
      const a = es[k * o.bits]
      const b = es[(k + 1) * o.bits - 1]
      if (a === undefined || b === undefined) continue
      const parts = [sig.mosi ? `MOSI ${hex(t.mosi[k] ?? null)}` : '', sig.miso ? `MISO ${hex(t.miso[k] ?? null)}` : ''].filter(Boolean)
      out.push({ t0: a, t1: b, lane: 'spi', label: parts.join(' / '), kind: 'data', tx: i })
    }
  })
  return out
}

export function annotateUart(line: Signal, o: { baud: number; dataBits?: number; parity?: 'none' | 'even' | 'odd' | 'mark' | 'space'; stopBits?: 1 | 1.5 | 2; invert?: boolean }, end: number): Annotation[] {
  const fr = uartDecode(line, o, end)
  const bit = 1 / o.baud
  const len = bit * (1 + (o.dataBits ?? 8) + (o.parity && o.parity !== 'none' ? 1 : 0) + (o.stopBits ?? 1))
  return fr.map((f, i) => ({
    t0: f.t, t1: f.t + len, lane: 'uart', tx: i,
    label: f.framing_error && f.value === 0 ? 'BREAK?' : `${hex(f.value)}${f.value !== null && f.value >= 32 && f.value < 127 ? ` '${String.fromCharCode(f.value)}'` : ''}${f.parity_error ? ' parity!' : ''}${f.framing_error && f.value !== 0 ? ' framing!' : ''}`,
    kind: f.framing_error || f.parity_error ? 'error' : 'data',
  }))
}

export function annotateCan(line: Signal, o: { bitrate: number; samplePoint?: number }, end: number): Annotation[] {
  return canDecode(line, o, end).map((f, i) => ({
    t0: f.t, t1: f.end, lane: 'can', tx: i, kind: f.errors.length ? 'error' : 'data',
    label: `${f.extended ? 'EXT' : 'STD'} ${f.id === null ? '?' : `0x${f.id.toString(16)}`}${f.rtr ? ' RTR' : ''} [${f.data.map((d) => d.toString(16).padStart(2, '0')).join(' ')}]${f.ack ? ' ACK' : ' no ACK'}${f.errors.length ? ` ${f.errors[0]}` : ''}`,
  }))
}

export function annotateOnewire(dq: Signal, speed: 'standard' | 'overdrive'): Annotation[] {
  const d = onewireDecode(dq, { speed })
  const slot = speed === 'overdrive' ? 10e-6 : 70e-6
  return d.events.map((e, i) => ({
    t0: e.t, t1: e.kind === 'reset' ? e.t + (speed === 'overdrive' ? 70e-6 : 480e-6) : e.t + 8 * slot, lane: 'onewire', tx: i,
    label: e.kind === 'reset' ? `RESET${e.presence ? ' + PRESENCE' : ' (no presence)'}` : hex(e.value ?? null), kind: e.kind === 'reset' ? 'start' : 'data',
  }))
}

export function annotateI2s(sig: { sck: Signal; ws: Signal; sd: Signal }, o: { wordBits: number; format?: 'i2s' | 'left_justified' }): Annotation[] {
  const d = i2sDecode(sig, o)
  const rises = sig.sck.edges('rising')
  const period = rises.length > 1 ? (rises[1] as number) - (rises[0] as number) : 0
  return d.frames.map((f, i) => ({ t0: f.t, t1: f.t + 2 * o.wordBits * period, lane: 'i2s', tx: i, label: `L ${f.left ?? '?'} / R ${f.right ?? '?'}`, kind: 'data' }))
}

/**
 * More decoders for captures (sim/wave.ts has SPI, I2C and UART): CAN 2.0A/B, 1-Wire, I2S, and SPI on two or four
 * data lanes. They work on the same Signal structures, so a simulated VCD, a logic analyser's capture and a
 * protocol model's run decode alike.
 *
 *   CAN       hard sync on the SOF edge after at least 11 recessive bits (or the start of the capture), each bit sampled
 *             at the sample point, resynchronised on recessive-to-dominant edges by at most SJW; stuff bits removed
 *             (a sixth equal bit is a stuff error); ID, IDE, RTR, DLC, data, CRC-15 checked, ACK slot, delimiters
 *             and EOF checked (form errors).
 *   1-Wire    every low pulse: a reset (longer than 80 % of the speed's reset minimum) and the presence pulse after
 *             it, or a time slot read as 1 (released before the master's sample instant, 15 µs or 2 µs) or 0; bytes LSB first. Slot
 *             timings are measured for protocol.check.
 *   I2S       SD and WS sampled on SCK rising edges; a word starts one bit after WS changes (i2s) or with it
 *             (left_justified), MSB first, two's complement; left (WS 0) and right (WS 1) paired in order.
 *   SPI lanes the sampling edge as for single-lane SPI; each clock carries one bit per lane, the highest lane first.
 */
import { Signal, WaveError } from './wave.js'

// ------------------------------------------------------------------ CAN

export interface CanDecoded {
  t: number
  end: number
  id: number | null
  extended: boolean
  rtr: boolean
  dlc: number | null
  data: number[]
  crc: number | null
  crc_ok: boolean | null
  ack: boolean | null
  stuff_bits: number
  errors: string[]
}

const crc15 = (bits: readonly number[]): number => {
  let crc = 0
  for (const b of bits) {
    const next = b ^ ((crc >> 14) & 1)
    crc = (crc << 1) & 0x7fff
    if (next) crc ^= 0x4599
  }
  return crc
}

export function canDecode(line: Signal, o: { bitrate: number; samplePoint?: number; sjw?: number }, end = Infinity): CanDecoded[] {
  if (!(o.bitrate > 0)) throw new WaveError('CAN needs bitrate')
  const bit = 1 / o.bitrate
  const sp = o.samplePoint ?? 0.875
  const sjwT = (o.sjw ?? 1) * bit / 16
  const falls = line.edges('falling')
  const lastT = Math.min(end, line.t[line.t.length - 1] ?? 0) + 20 * bit
  const out: CanDecoded[] = []
  let resume = -Infinity
  for (const tf of falls) {
    if (tf < resume) continue
    // idle before it: recessive for 11 bit times (or since the capture began)
    const before = line.before(tf)
    if (before !== '1') continue
    const k = line.t.indexOf(tf)
    const prevChange = k > 0 ? (line.t[k - 1] as number) : -Infinity
    if (tf - prevChange < 11 * bit - bit / 4 && k > 1) continue
    let bitStart = tf
    const errors: string[] = []
    const raw = (): number => {
      const v = line.at(bitStart + sp * bit)
      // resynchronise on a recessive-to-dominant edge near the next boundary
      const next = bitStart + bit
      const e = falls.find((x) => x > next - bit / 2 && x < next + bit / 2)
      bitStart = e !== undefined ? next + Math.max(-sjwT, Math.min(sjwT, e - next)) : next
      return v === '0' ? 0 : v === '1' ? 1 : -1
    }
    let run = 0
    let last = -1
    let stuffBits = 0
    let destuff = true
    const all: number[] = []
    const nextBit = (): number => {
      let b = raw()
      if (destuff && run === 5) {
        // this one must be a stuff bit
        if (b === last) errors.push(`stuff error at bit ${all.length}`)
        stuffBits++
        last = b
        run = 1
        b = raw()
      }
      if (b === last) run++
      else { run = 1; last = b }
      all.push(b)
      return b
    }
    const take = (n: number): number => {
      let v = 0
      for (let i = 0; i < n; i++) v = v * 2 + Math.max(0, nextBit())
      return v
    }
    const sof = nextBit()
    if (sof !== 0) continue
    let id = take(11)
    const b12 = nextBit()
    const ide = nextBit()
    let rtr = b12 === 1
    if (ide === 1) {
      if (b12 !== 1) errors.push('SRR is not recessive')
      id = id * 2 ** 18 + take(18)
      rtr = nextBit() === 1
      nextBit() // r1
      nextBit() // r0
    } else nextBit() // r0
    const dlc = take(4)
    const nData = rtr ? 0 : Math.min(dlc, 8)
    const data: number[] = []
    for (let i = 0; i < nData; i++) data.push(take(8))
    const covered = [...all]
    const crc = take(15)
    if (run === 5) { // a stuff bit after the last CRC bit
      const sb = raw()
      if (sb === last) errors.push('stuff error after the CRC')
      stuffBits++
    }
    destuff = false
    const crcOk = !all.includes(-1) && crc15(covered) === crc
    if (!crcOk) errors.push('CRC mismatch')
    if (raw() !== 1) errors.push('CRC delimiter not recessive')
    const ackBit = raw()
    if (raw() !== 1) errors.push('ACK delimiter not recessive')
    for (let i = 0; i < 7; i++) if (raw() !== 1) { errors.push('EOF not recessive'); break }
    out.push({ t: tf, end: bitStart, id, extended: ide === 1, rtr, dlc, data, crc, crc_ok: crcOk, ack: ackBit === 0, stuff_bits: stuffBits, errors })
    resume = bitStart
    if (bitStart > lastT) break
  }
  return out
}

// ------------------------------------------------------------------ 1-Wire

export interface OneWireEvent { t: number; kind: 'reset' | 'byte'; presence?: boolean; value?: number; bits?: number }

export interface OneWireTimingStats {
  /** each worst value with where it was: [value, t0, t1] */
  t_rstl_min: [number, number, number] | null
  t_pdh_max: [number, number, number] | null
  t_pdl_min: [number, number, number] | null
  t_slot_min: [number, number, number] | null
  t_low1_max: [number, number, number] | null
  t_low0_min: [number, number, number] | null
  /** a responder's read-0: low past the sample instant but shorter than 3/4 of the minimum slot */
  t_rd0_min: [number, number, number] | null
  t_rd0_max: [number, number, number] | null
  t_rec_min: [number, number, number] | null
}

export function onewireDecode(dq: Signal, o: { speed?: 'standard' | 'overdrive' }): { events: OneWireEvent[]; timing: OneWireTimingStats } {
  const od = o.speed === 'overdrive'
  const resetMin = (od ? 48e-6 : 480e-6) * 0.8
  // a slot reads 0 when the line is still low at the master's sample instant, A + E of AN126: 15 µs, overdrive 2 µs
  const thr = od ? 2e-6 : 15e-6
  const presWindow = od ? 10e-6 : 75e-6
  const lows = dq.intervals('0').filter(([a, b]) => a !== dq.t[0] && b !== Infinity)
  const events: OneWireEvent[] = []
  const tm: OneWireTimingStats = { t_rstl_min: null, t_pdh_max: null, t_pdl_min: null, t_slot_min: null, t_low1_max: null, t_low0_min: null, t_rd0_min: null, t_rd0_max: null, t_rec_min: null }
  // a master's write-0 holds the line low for most of a slot (60 µs, overdrive 6 µs minimum); a responder's read-0
  // releases it well before that: 3/4 of the slot minimum tells them apart
  const write0 = od ? 4.5e-6 : 45e-6
  const worst = (k: keyof OneWireTimingStats, v: number, a: number, b: number, max: boolean): void => {
    const cur = tm[k]
    if (!cur || (max ? v > cur[0] : v < cur[0])) tm[k] = [v, a, b]
  }
  let cur = 0
  let nbits = 0
  let byteStart = 0
  let lastSlot: [number, number] | null = null
  for (let i = 0; i < lows.length; i++) {
    const [a, b] = lows[i] as [number, number]
    const d = b - a
    if (d >= resetMin) {
      worst('t_rstl_min', d, a, b, false)
      const p = lows[i + 1]
      const presence = p !== undefined && p[0] - b <= presWindow
      if (presence && p) {
        worst('t_pdh_max', p[0] - b, b, p[0], true)
        worst('t_pdl_min', p[1] - p[0], p[0], p[1], false)
        i++
      }
      events.push({ t: a, kind: 'reset', presence })
      cur = 0
      nbits = 0
      lastSlot = null
      continue
    }
    if (lastSlot) {
      worst('t_slot_min', a - lastSlot[0], lastSlot[0], a, false)
      worst('t_rec_min', a - lastSlot[1], lastSlot[1], a, false)
    }
    lastSlot = [a, b]
    const one = d < thr
    if (one) worst('t_low1_max', d, a, b, true)
    else if (d >= write0) worst('t_low0_min', d, a, b, false)
    else { worst('t_rd0_min', d, a, b, false); worst('t_rd0_max', d, a, b, true) }
    if (nbits === 0) byteStart = a
    cur |= (one ? 1 : 0) << nbits
    nbits++
    if (nbits === 8) {
      events.push({ t: byteStart, kind: 'byte', value: cur })
      cur = 0
      nbits = 0
    }
  }
  if (nbits) events.push({ t: byteStart, kind: 'byte', value: cur, bits: nbits })
  return { events, timing: tm }
}

// ------------------------------------------------------------------ I2S

export function i2sDecode(sig: { sck: Signal; ws: Signal; sd: Signal }, o: { wordBits: number; format?: 'i2s' | 'left_justified' }): { frames: { t: number; left: number | null; right: number | null }[]; words: number } {
  const n = o.wordBits
  if (n < 4 || n > 32) throw new WaveError('I2S word_bits must be 4..32')
  const delay = (o.format ?? 'i2s') === 'i2s' ? 1 : 0
  const rises = sig.sck.edges('rising')
  const ws = rises.map((t) => sig.ws.before(t))
  const sd = rises.map((t) => sig.sd.before(t))
  const words: { t: number; ch: string; v: number | null }[] = []
  for (let k = 1; k < rises.length; k++) {
    if (ws[k] === ws[k - 1]) continue
    const s = k + delay
    if (s + n > rises.length) break
    let v = 0
    let bad = false
    for (let i = 0; i < n; i++) {
      const b = sd[s + i]
      if (b !== '0' && b !== '1') bad = true
      v = v * 2 + (b === '1' ? 1 : 0)
    }
    if (v >= 2 ** (n - 1)) v -= 2 ** n
    words.push({ t: rises[s] as number, ch: ws[k] as string, v: bad ? null : v })
  }
  const frames: { t: number; left: number | null; right: number | null }[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as { t: number; ch: string; v: number | null }
    if (w.ch !== '0') continue
    const r = words[i + 1]
    frames.push({ t: w.t, left: w.v, right: r && r.ch === '1' ? r.v : null })
  }
  return { frames, words: words.length }
}

// ------------------------------------------------------------------ SPI on 2 or 4 lanes

export function spiDecodeLanes(sig: { sck: Signal; io: readonly Signal[]; cs?: Signal | undefined }, o: { mode?: 0 | 1 | 2 | 3; bits?: number; lsbFirst?: boolean; csActiveHigh?: boolean }): { start: number; end: number; words: (number | null)[]; leftover_bits: number }[] {
  const mode = o.mode ?? 0
  const lanes = sig.io.length
  if (lanes !== 2 && lanes !== 4) throw new WaveError('lanes: give io0..io1 (dual) or io0..io3 (quad)')
  const bits = o.bits ?? 8
  if (bits % lanes) throw new WaveError(`a ${bits}-bit word does not split over ${lanes} lanes`)
  const sampleRising = (mode >= 2) === (mode % 2 === 1)
  const edges = sig.sck.edges(sampleRising ? 'rising' : 'falling')
  const windows: [number, number][] = sig.cs ? sig.cs.intervals(o.csActiveHigh ? '1' : '0') : [[-Infinity, Infinity]]
  const out: { start: number; end: number; words: (number | null)[]; leftover_bits: number }[] = []
  for (const [a, b] of windows) {
    const es = edges.filter((t) => t > a && t < b)
    if (!es.length) continue
    const stream: string[] = []
    for (const t of es) for (let lane = lanes - 1; lane >= 0; lane--) stream.push((sig.io[lane] as Signal).before(t))
    const words: (number | null)[] = []
    for (let k = 0; k + bits <= stream.length; k += bits) {
      const chunk = stream.slice(k, k + bits)
      if (chunk.some((x) => x !== '0' && x !== '1')) { words.push(null); continue }
      const s = o.lsbFirst ? [...chunk].reverse().join('') : chunk.join('')
      words.push(parseInt(s, 2))
    }
    out.push({ start: Number.isFinite(a) ? a : (es[0] as number), end: Number.isFinite(b) ? b : (es[es.length - 1] as number), words, leftover_bits: stream.length % bits })
  }
  return out
}

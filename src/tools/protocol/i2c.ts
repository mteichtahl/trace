/**
 * I2C bus-functional model: transactions in, SCL and SDA edges out (UM10204 bus protocol, section 3.1).
 *
 * Covered: START, repeated START (a transaction with stop: false, or a write-then-read combined format), STOP; 7- and
 * 10-bit addressing (11110 A9 A8 R/W, then A7..A0; a 10-bit read writes both address bytes, repeats START and sends
 * 11110 A9 A8 1); read and write; ACK and NACK (the responder NACKs a chosen byte, the master NACKs the last byte it
 * reads); clock stretching (the responder holds SCL low before a chosen bit); arbitration between two masters that
 * start together (wired-AND SDA, the master that sends 1 and sees 0 releases the bus; both share SCL); general call
 * (address 0x00, W); Hs-mode (the master code 0000 1xxx sent at Fast-mode timing and not acknowledged, a repeated
 * START, then the transfer at Hs timing until STOP).
 *
 * Every time is configurable. Defaults come from the speed mode's UM10204 minimums (standards.ts): the clock period
 * 1/fSCL split between tLOW and tHIGH in the ratio of their minimums, SDA changing tHD;DAT = tLOW/4 after SCL falls
 * (so tSU;DAT = 3 tLOW/4), and tHD;STA, tSU;STA, tSU;STO, tBUF 10 % above their minimums. Edges are ideal (zero rise
 * time): protocol.bus_analog gives the real ones, and protocol.check applies them.
 */
import { z } from 'zod'

import type { I2cFrame } from '../sim/wave.js'
import { I2C_SPEEDS, I2C_STANDARD, type I2cSpeed } from './standards.js'
import { ModelError, WaveBuilder } from './waveform.js'

const byte = z.number().int().min(0).max(255)

export const I2cConfigSchema = z.object({
  speed: z.enum(I2C_SPEEDS).default('fast'),
  f_scl: z.number().positive().optional().describe('SCL frequency (Hz); default the mode maximum'),
  t_low: z.number().positive().optional(),
  t_high: z.number().positive().optional(),
  thd_dat: z.number().min(0).optional().describe('SCL fall to SDA change'),
  thd_sta: z.number().positive().optional(),
  tsu_sta: z.number().positive().optional(),
  tsu_sto: z.number().positive().optional(),
  t_buf: z.number().positive().optional(),
  t_idle: z.number().min(0).optional().describe('bus idle before the first START (default tBUF)'),
}).strict()
export type I2cConfig = z.input<typeof I2cConfigSchema>

export const I2cTxSchema = z.object({
  addr: z.number().int().min(0).max(1023).describe('7-bit address (or 10-bit with ten_bit)'),
  ten_bit: z.boolean().optional(),
  general_call: z.boolean().optional().describe('address 0x00 W (addr is ignored)'),
  write: z.array(byte).optional().describe('bytes the master writes'),
  read: z.number().int().min(0).max(4096).optional().describe('bytes the master reads (after the write, with a repeated START: combined format)'),
  read_data: z.array(byte).optional().describe("the responder's bytes for the read (default 0xA5, 0x5A, ...)"),
  nack: z.number().int().min(0).optional().describe('the responder NACKs this byte: 0 = the address, k = the k-th written byte; the master then STOPs'),
  stop: z.boolean().optional().describe('end with STOP (default true); false: the next transaction starts with a repeated START'),
  stretch: z.array(z.object({ byte: z.number().int().min(0), bit: z.number().int().min(0).max(8).optional(), s: z.number().positive() }).strict()).optional()
    .describe('clock stretching: the responder holds SCL low for s longer before bit `bit` (default 0) of byte `byte` (0 = the address byte of the first phase)'),
  arbitration: z.object({ addr: z.number().int().min(0).max(127), write: z.array(byte).optional() }).strict().optional()
    .describe('a second master starting the same START with this 7-bit write; the lower bits win'),
  master_code: z.number().int().min(0).max(7).optional().describe('Hs-mode master code low bits (0000 1xxx); default 0'),
}).strict()
export type I2cTx = z.input<typeof I2cTxSchema>

interface Timing { f: number; t_low: number; t_high: number; thd_dat: number; thd_sta: number; tsu_sta: number; tsu_sto: number; t_buf: number }

export function i2cTiming(c: z.output<typeof I2cConfigSchema>, speedOverride?: I2cSpeed): Timing {
  const speed = speedOverride ?? c.speed
  const lim = I2C_STANDARD[speed]
  const fMax = lim.f_scl?.max as number
  const own = speedOverride === undefined
  const f = (own ? c.f_scl : undefined) ?? fMax
  const T = 1 / f
  const lowMin = lim.t_low?.min as number
  const highMin = lim.t_high?.min as number
  let t_low = (own ? c.t_low : undefined) ?? T * (lowMin / (lowMin + highMin))
  let t_high = (own ? c.t_high : undefined) ?? T - t_low
  if (own && c.t_low !== undefined && c.t_high === undefined) t_high = Math.max(T - t_low, highMin)
  if (own && c.t_high !== undefined && c.t_low === undefined) t_low = Math.max(T - t_high, lowMin)
  const hdMax = lim.thd_dat?.max
  const thd_dat = (own ? c.thd_dat : undefined) ?? Math.min(t_low / 4, hdMax !== undefined ? hdMax / 2 : Infinity)
  if (thd_dat >= t_low) throw new ModelError(`I2C: tHD;DAT ${thd_dat} s must be shorter than tLOW ${t_low} s (SDA changes while SCL is low)`)
  const up = (k: 'thd_sta' | 'tsu_sta' | 'tsu_sto' | 't_buf', floor: number): number => {
    const v = own ? c[k] : undefined
    return v ?? Math.max((lim[k]?.min ?? 0) * 1.1, floor)
  }
  return { f, t_low, t_high, thd_dat, thd_sta: up('thd_sta', t_high), tsu_sta: up('tsu_sta', t_high), tsu_sto: up('tsu_sto', t_high), t_buf: up('t_buf', t_low) }
}

type Driver = 'm' | 's'
interface Bit { v: 0 | 1; by: Driver; /** each master's own drive (arbitration) */ d?: readonly [0 | 1, 0 | 1] }
interface ByteOut { v: number; by: Driver; ack: Driver | null; ackV: 0 | 1; kind: 'addr' | 'data'; /** the two masters' drives, while arbitrating */ drive?: readonly [number, number] }

/** The decoded form both the model's expectation and a decode come to: one segment per START / repeated START. */
export interface I2cSegment {
  start: 'S' | 'Sr'
  kind: 'address' | 'ten_bit' | 'general_call' | 'master_code'
  addr: number | null
  rw: 'R' | 'W' | null
  addr_ack: boolean | null
  data: (number | null)[]
  acks: (boolean | null)[]
  stop: boolean
}

const bitsOf = (b: number): (0 | 1)[] => Array.from({ length: 8 }, (_, k) => ((b >> (7 - k)) & 1) as 0 | 1)

export interface I2cModelResult {
  wave: WaveBuilder
  expected: I2cSegment[]
  arbitration: { winner: 'm1' | 'm2'; lost_at_bit: number | null }[]
  timing: Timing
}

/** Run the model. Signals: scl, sda (the wired bus), and m1_sda / m2_sda (each master's own drive) when two masters arbitrate. */
export function i2cModel(cfgIn: I2cConfig, txs: readonly I2cTx[]): I2cModelResult {
  const cfg = I2cConfigSchema.parse(cfgIn)
  const tm = i2cTiming(cfg)
  const hs = cfg.speed === 'high_speed' || cfg.speed === 'high_speed_400pf'
  const fsTm = hs ? i2cTiming(cfg, 'fast') : tm
  const w = new WaveBuilder('i2c')
  w.declare('scl', '1', { driven: true })
  w.declare('sda', '1')
  // the master's own drive of SDA (released while the responder drives): what a testbench replays into a DUT
  w.declare('sda_m', '1', { driven: true, hidden: true })
  const arbitrating = txs.some((x) => x.arbitration)
  if (arbitrating) {
    w.declare('m1_sda', '1')
    w.declare('m2_sda', '1')
  }
  const expected: I2cSegment[] = []
  const arb: I2cModelResult['arbitration'] = []
  let t = cfg.t_idle ?? tm.t_buf
  let busIdle = true // SCL and SDA high, after STOP (or at the start)
  let sclLowSince = 0 // when SCL last fell (valid when !busIdle)
  let txIndex = 0
  let inHs = false

  const setSda = (at: number, v: 0 | 1, d?: readonly [0 | 1, 0 | 1], by: Driver = 'm'): void => {
    w.set('sda', at, String(v))
    w.set('sda_m', at, by === 'm' ? String(v) : '1')
    if (arbitrating) {
      w.set('m1_sda', at, String(d ? d[0] : v))
      w.set('m2_sda', at, String(d ? d[1] : 1))
    }
  }

  /** START (from idle) or repeated START (SCL low after a ninth bit). Leaves SCL low; returns its fall time. */
  const start = (T: Timing): number => {
    if (busIdle) {
      setSda(t, 0)
      w.note({ t0: t, t1: t + T.thd_sta, lane: 'i2c', label: 'S', kind: 'start', tx: txIndex })
      const fall = t + T.thd_sta
      w.set('scl', fall, '0')
      busIdle = false
      return fall
    }
    const a = sclLowSince + T.thd_dat
    setSda(a, 1)
    const rise = sclLowSince + T.t_low
    w.set('scl', rise, '1')
    const sdaFall = rise + T.tsu_sta
    setSda(sdaFall, 0)
    const fall = sdaFall + T.thd_sta
    w.note({ t0: rise, t1: fall, lane: 'i2c', label: 'Sr', kind: 'restart', tx: txIndex })
    w.set('scl', fall, '0')
    return fall
  }

  /** Clock bits out from SCL low at `fall`; returns the last SCL fall. */
  const clock = (bits: readonly Bit[], T: Timing, from: number, stretchBefore: ReadonlyMap<number, number>, label?: (k: number, t0: number, t1: number) => void): number => {
    let fall = from
    bits.forEach((b, k) => {
      const change = fall + T.thd_dat
      setSda(change, b.v, b.d, b.by)
      const stretch = stretchBefore.get(k) ?? 0
      const rise = fall + T.t_low + stretch
      if (stretch) w.note({ t0: fall + T.t_low, t1: rise, lane: 'i2c', label: 'stretch', kind: 'info', tx: txIndex })
      w.set('scl', rise, '1')
      if (b.by === 's') w.expect({ t: rise + T.t_high / 2, signal: 'sda', expected: b.v ? '1' : '0', label: `tx ${txIndex} bit ${k}` })
      const nf = rise + T.t_high
      w.set('scl', nf, '0')
      label?.(k, change, nf)
      fall = nf
    })
    return fall
  }

  const stopAt = (T: Timing): void => {
    const a = sclLowSince + T.thd_dat
    setSda(a, 0)
    const rise = sclLowSince + T.t_low
    w.set('scl', rise, '1')
    const up = rise + T.tsu_sto
    setSda(up, 1)
    w.note({ t0: rise, t1: up, lane: 'i2c', label: 'P', kind: 'stop', tx: txIndex })
    t = up + T.t_buf
    busIdle = true
    inHs = false
  }

  /** One phase: address byte(s) and data, each with its ninth (ACK) bit. Returns the last SCL fall. */
  const phase = (seg: I2cSegment, bytes: readonly ByteOut[], T: Timing, stretch: ReadonlyMap<number, number>, from: number): number => {
    let fall = from
    bytes.forEach((b, i) => {
      const d = b.drive
      const bits: Bit[] = bitsOf(b.v).map((v, k) => ({ v, by: b.by, ...(d ? { d: [((d[0] >> (7 - k)) & 1) as 0 | 1, ((d[1] >> (7 - k)) & 1) as 0 | 1] as const } : {}) }))
      if (b.ack) bits.push({ v: b.ackV, by: b.ack, ...(d ? { d: [1, 1] as const } : {}) })
      const st = new Map<number, number>()
      for (const [key, s] of stretch) if (Math.floor(key / 16) === i) st.set(key % 16, s)
      let t0 = 0
      fall = clock(bits, T, fall, st, (k, a, z) => {
        if (k === 0) t0 = a
        if (k === 7) w.note({ t0, t1: z, lane: 'i2c', label: b.kind === 'addr' ? addrLabel(seg, b.v) : `0x${b.v.toString(16).padStart(2, '0')}`, kind: b.kind, tx: txIndex })
        if (k === 8) w.note({ t0: a, t1: z, lane: 'i2c', label: b.ackV ? 'NACK' : 'ACK', kind: b.ackV ? 'nack' : 'ack', tx: txIndex })
      })
    })
    return fall
  }

  for (const raw of txs) {
    const x = I2cTxSchema.parse(raw)
    const rd = x.read ?? 0
    const wr = x.write ?? []
    const readData = x.read_data ?? Array.from({ length: rd }, (_, k) => (k % 2 ? 0x5a : 0xa5))
    if (readData.length < rd) throw new ModelError(`transaction ${txIndex}: read ${rd} bytes but read_data has ${readData.length}`)
    if (x.ten_bit && x.addr > 1023) throw new ModelError('10-bit address out of range')
    if (!x.ten_bit && !x.general_call && x.addr > 127) throw new ModelError(`transaction ${txIndex}: 7-bit address 0x${x.addr.toString(16)} out of range (set ten_bit)`)
    const stretch = new Map<number, number>((x.stretch ?? []).map((s) => [s.byte * 16 + (s.bit ?? 0), s.s]))

    // Hs-mode: the master code at F/S timing, not acknowledged, then a repeated START at Hs timing
    if (hs && !inHs) {
      const fall0 = start(fsTm)
      const seg: I2cSegment = { start: 'S', kind: 'master_code', addr: null, rw: null, addr_ack: false, data: [], acks: [], stop: false }
      expected.push(seg)
      sclLowSince = phase(seg, [{ v: 0x08 | (x.master_code ?? 0), by: 'm', ack: 'm', ackV: 1, kind: 'addr' }], fsTm, new Map(), fall0)
      inHs = true
    }
    const T = tm
    const first = busIdle ? 'S' : 'Sr'
    let fall = start(T)
    const segs: I2cSegment[] = []
    let ok = true
    let byteIndex = 0
    // arbitration: both masters send address and data until one sends 1 and sees 0; the bus carries the winner's bits
    let addr = x.addr
    let wrEff = wr
    let drives: [number, number][] | null = null
    if (x.arbitration) {
      if (x.ten_bit || x.general_call) throw new ModelError(`transaction ${txIndex}: arbitration is modelled for 7-bit writes only`)
      const s1 = [(x.addr << 1) | 0, ...wr]
      const s2 = [(x.arbitration.addr << 1) | 0, ...(x.arbitration.write ?? [])]
      const b1 = s1.flatMap(bitsOf)
      const b2 = s2.flatMap(bitsOf)
      let lost: number | null = null
      for (let k = 0; k < Math.min(b1.length, b2.length); k++) if (b1[k] !== b2[k]) { lost = k; break }
      const m2wins = lost !== null && b2[lost] === 0
      const win = m2wins ? s2 : s1
      const loseBits = m2wins ? b1 : b2
      addr = (win[0] as number) >> 1
      wrEff = win.slice(1)
      const loserDrive = (byteNo: number): number => {
        let v = 0
        for (let i = 0; i < 8; i++) {
          const k = byteNo * 8 + i
          const bit = lost !== null && k > lost ? 1 : (loseBits[k] ?? 1)
          v = (v << 1) | bit
        }
        return v
      }
      drives = win.map((v, n) => (m2wins ? [loserDrive(n), v] : [v, loserDrive(n)]))
      arb.push({ winner: m2wins ? 'm2' : 'm1', lost_at_bit: lost })
    }
    const nackAt = x.nack
    if (x.general_call || wrEff.length > 0 || rd === 0 || x.ten_bit === true) {
      const kind: I2cSegment['kind'] = x.general_call ? 'general_call' : x.ten_bit ? 'ten_bit' : 'address'
      const seg: I2cSegment = { start: first, kind, addr: x.general_call ? 0 : addr, rw: 'W', addr_ack: nackAt !== 0, data: [], acks: [], stop: false }
      segs.push(seg)
      const addrBytes = x.general_call ? [0] : x.ten_bit ? [0xf0 | ((addr >> 7) & 0x06), addr & 0xff] : [(addr << 1) | 0]
      const bytes: ByteOut[] = addrBytes.map((v, k) => ({ v, by: 'm', ack: 's', ackV: nackAt === 0 && k === addrBytes.length - 1 ? 1 : 0, kind: 'addr' }))
      wrEff.forEach((v, k) => bytes.push({ v, by: 'm', ack: 's', ackV: nackAt === k + 1 ? 1 : 0, kind: 'data' }))
      if (drives) bytes.forEach((b, k) => { const d = drives?.[k]; if (d) b.drive = d })
      const cut = nackAt === undefined ? bytes : bytes.slice(0, nackAt + addrBytes.length)
      fall = phase(seg, cut, T, stretch, fall)
      for (const b of cut.slice(addrBytes.length)) { seg.data.push(b.v); seg.acks.push(b.ackV === 0) }
      ok = nackAt === undefined || nackAt > wrEff.length
      byteIndex = cut.length
    }
    if (ok && rd > 0) {
      sclLowSince = fall
      const readStart: 'S' | 'Sr' = segs.length ? 'Sr' : first
      if (segs.length) fall = start(T)
      const seg: I2cSegment = { start: readStart, kind: x.ten_bit ? 'ten_bit' : 'address', addr: x.addr, rw: 'R', addr_ack: true, data: [], acks: [], stop: false }
      segs.push(seg)
      const addrByte = x.ten_bit ? 0xf1 | ((x.addr >> 7) & 0x06) : (x.addr << 1) | 1
      const bytes: ByteOut[] = [{ v: addrByte, by: 'm', ack: 's', ackV: 0, kind: 'addr' }]
      readData.slice(0, rd).forEach((v, k) => bytes.push({ v, by: 's', ack: 'm', ackV: k === rd - 1 ? 1 : 0, kind: 'data' }))
      const st = new Map<number, number>()
      for (const [key, s] of stretch) if (Math.floor(key / 16) >= byteIndex) st.set(key - byteIndex * 16, s)
      fall = phase(seg, bytes, T, st, fall)
      for (const b of bytes.slice(1)) { seg.data.push(b.v); seg.acks.push(b.ackV === 0) }
    }
    sclLowSince = fall
    const stop = !ok || (x.stop ?? true)
    const last = segs[segs.length - 1]
    if (last) last.stop = stop
    expected.push(...segs)
    if (stop) stopAt(T)
    txIndex++
  }
  if (!busIdle) stopAt(tm)
  w.idle(t)
  return { wave: w, expected, arbitration: arb, timing: tm }
}

function addrLabel(seg: I2cSegment, v: number): string {
  if (seg.kind === 'general_call' && v === 0) return 'GC 0x00 W'
  if (seg.kind === 'master_code') return `HS code 0x${v.toString(16).padStart(2, '0')}`
  if ((v & 0xf8) === 0xf0) return `10b hi ${(v >> 1) & 3} ${v & 1 ? 'R' : 'W'}`
  if (seg.kind === 'ten_bit' && seg.rw === 'W') return `10b lo 0x${v.toString(16).padStart(2, '0')}`
  return `ADDR 0x${(v >> 1).toString(16).padStart(2, '0')} ${v & 1 ? 'R' : 'W'}`
}

/** A decode's frames (sim/wave.ts i2cDecode) as segments: 10-bit addresses joined, general call and Hs master codes
 * named. A 10-bit read (11110xx1 after a repeated START) takes its low address byte from the write before it. */
export function i2cSegments(frames: readonly I2cFrame[]): I2cSegment[] {
  const out: I2cSegment[] = []
  for (const f of frames) {
    const b0 = f.bytes[0]
    const seg: I2cSegment = { start: f.repeated ? 'Sr' : 'S', kind: 'address', addr: null, rw: null, addr_ack: b0?.ack ?? null, data: [], acks: [], stop: f.stopped }
    let rest = f.bytes.slice(1)
    const v = b0?.value ?? null
    if (v === null) { /* unknown address byte */ } else if (v === 0) {
      seg.kind = 'general_call'
      seg.addr = 0
      seg.rw = 'W'
    } else if ((v & 0xf8) === 0x08) {
      seg.kind = 'master_code'
    } else if ((v & 0xf8) === 0xf0) {
      seg.kind = 'ten_bit'
      seg.rw = v & 1 ? 'R' : 'W'
      const hi = (v >> 1) & 3
      if (seg.rw === 'W') {
        const lo = rest[0]
        seg.addr = lo && lo.value !== null ? (hi << 8) | lo.value : null
        seg.addr_ack = lo ? lo.ack : seg.addr_ack
        rest = rest.slice(1)
      } else {
        const prev = [...out].reverse().find((s) => s.kind === 'ten_bit' && s.addr !== null && ((s.addr >> 8) & 3) === hi)
        seg.addr = prev?.addr ?? null
      }
    } else {
      seg.addr = v >> 1
      seg.rw = v & 1 ? 'R' : 'W'
    }
    seg.data = rest.map((b) => b.value)
    seg.acks = rest.map((b) => b.ack)
    out.push(seg)
  }
  return out
}

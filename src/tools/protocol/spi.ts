/**
 * SPI bus-functional model: transfers in, CS / SCK / data edges out.
 *
 * Mode = CPOL × 2 + CPHA. CPOL is SCK's idle level. CPHA = 0: each bit is on the line before the leading edge, sampled
 * on the leading edge, changed on the trailing edge (the first bit is driven when CS goes active, the master's first
 * bit tV after it). CPHA = 1: changed on the leading edge, sampled on the trailing edge. Words of 1 to 32 bits, MSB or
 * LSB first; several chip selects (cs0, cs1, …; a transfer names its select); daisy chains of N devices (one select,
 * N words per transfer, the chain's internal links shown as chain_d1 … so device k's input is visible); dual and quad
 * lanes (io0 … io3, two or four bits per clock, MSB on the highest lane), per transfer.
 *
 * Timing, all configurable: fSCK and duty; tCSS (CS active to the first edge), tCSH (last edge to CS inactive), tCSD
 * (CS inactive between transfers); an inter-word gap (SCK held idle between words); the master's output delay tV,m
 * (MOSI after its launching edge) and the responder's tV (MISO valid after the launching edge) and tHO (MISO held
 * after it; between tHO and tV the line is 'x', unknown, as a datasheet draws it).
 */
import { z } from 'zod'

import { ModelError, WaveBuilder } from './waveform.js'

const word = z.number().int().min(0).max(0xffffffff)

export const SpiConfigSchema = z.object({
  mode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).default(0),
  bits: z.number().int().min(1).max(32).default(8),
  lsb_first: z.boolean().default(false),
  f_sck: z.number().positive().default(1e6),
  duty: z.number().gt(0).lt(1).default(0.5).describe('fraction of the period SCK spends in its active (non-idle) phase'),
  selects: z.number().int().min(0).max(8).default(1).describe('chip selects cs0..; 0: no CS line'),
  cs_active_high: z.boolean().default(false),
  daisy: z.number().int().min(1).max(16).default(1).describe('devices in a daisy chain on one select'),
  lanes: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1),
  t_css: z.number().min(0).optional().describe('CS active to the first SCK edge (default half a period)'),
  t_csh: z.number().min(0).optional().describe('last SCK edge to CS inactive (default half a period)'),
  t_csd: z.number().min(0).optional().describe('CS inactive between transfers (default one period)'),
  t_word: z.number().min(0).default(0).describe('extra idle SCK time between words in a transfer'),
  tv_master: z.number().min(0).default(0).describe('MOSI change after the launching edge (or CS active)'),
  tv_slave: z.number().min(0).default(0).describe('MISO valid after the launching edge (or CS active)'),
  tho_slave: z.number().min(0).optional().describe('MISO held after the launching edge, then x until tV (default = tV: no x window)'),
  t_idle: z.number().min(0).optional().describe('idle time before the first transfer (default one period)'),
}).strict()
export type SpiConfig = z.input<typeof SpiConfigSchema>

export const SpiTxSchema = z.object({
  cs: z.number().int().min(0).max(7).optional().describe('which select (default 0)'),
  mosi: z.array(word).optional().describe('words the master sends (single lane)'),
  miso: z.array(word).optional().describe('words the responder returns (single lane; default 0)'),
  io: z.array(word).optional().describe('dual/quad: the words carried on the lanes'),
  lanes: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional().describe('override the lanes for this transfer'),
}).strict()
export type SpiTx = z.input<typeof SpiTxSchema>

export interface SpiExpected { cs: number; lanes: number; mosi: number[]; miso: number[]; io: number[] }

export interface SpiModelResult {
  wave: WaveBuilder
  expected: SpiExpected[]
  /** the sampling edge: what a decoder needs */
  sample: 'rising' | 'falling'
}

const bitAt = (v: number, k: number, bits: number, lsb: boolean): 0 | 1 => ((lsb ? v >>> k : v >>> (bits - 1 - k)) & 1) as 0 | 1

export function spiModel(cfgIn: SpiConfig, txs: readonly SpiTx[]): SpiModelResult {
  const c = SpiConfigSchema.parse(cfgIn)
  const T = 1 / c.f_sck
  const cpol = c.mode >= 2 ? 1 : 0
  const cpha = c.mode % 2
  const idle = String(cpol)
  const active = String(1 - cpol)
  const tActive = T * c.duty
  const tIdle = T - tActive
  const tCss = c.t_css ?? T / 2
  const tCsh = c.t_csh ?? T / 2
  const tCsd = c.t_csd ?? T
  const tho = Math.min(c.tho_slave ?? c.tv_slave, c.tv_slave)
  const anyMulti = c.lanes > 1 || txs.some((x) => (x.lanes ?? 1) > 1)
  const maxLanes = Math.max(c.lanes, ...txs.map((x) => x.lanes ?? 1))
  const w = new WaveBuilder('spi')
  const csName = (k: number): string => (c.selects === 1 ? 'cs' : `cs${k}`)
  const csIdle = c.cs_active_high ? '0' : '1'
  const csOn = c.cs_active_high ? '1' : '0'
  w.declare('sck', idle, { driven: true })
  for (let k = 0; k < c.selects; k++) w.declare(csName(k), csIdle, { driven: true })
  if (!anyMulti || txs.some((x) => (x.lanes ?? c.lanes) === 1)) {
    w.declare('mosi', '0', { driven: true })
    w.declare('miso', 'z')
  }
  if (anyMulti) for (let k = 0; k < maxLanes; k++) w.declare(`io${k}`, 'z')
  for (let d = 1; d < c.daisy; d++) w.declare(`chain_d${d}`, '0')
  const expected: SpiExpected[] = []
  let t = c.t_idle ?? T
  txs.forEach((raw, ti) => {
    const x = SpiTxSchema.parse(raw)
    const cs = x.cs ?? 0
    if (c.selects > 0 && cs >= c.selects) throw new ModelError(`transfer ${ti}: cs ${cs} but only ${c.selects} select(s)`)
    const lanes = x.lanes ?? c.lanes
    const mask = c.bits === 32 ? 0xffffffff : (2 ** c.bits) - 1
    for (const v of [...(x.mosi ?? []), ...(x.miso ?? []), ...(x.io ?? [])]) if (v > mask) throw new ModelError(`transfer ${ti}: word 0x${v.toString(16)} does not fit ${c.bits} bits`)
    if (lanes > 1 && c.daisy > 1) throw new ModelError('daisy chains are single-lane')
    if (lanes > 1 && c.bits % lanes !== 0) throw new ModelError(`a ${c.bits}-bit word does not split over ${lanes} lanes`)
    const mosi = lanes === 1 ? (x.mosi ?? []) : []
    const nWords = lanes === 1 ? Math.max(mosi.length, x.miso?.length ?? 0) : (x.io ?? []).length
    if (!nWords) throw new ModelError(`transfer ${ti}: no words`)
    if (c.daisy > 1 && nWords % c.daisy !== 0) throw new ModelError(`transfer ${ti}: a chain of ${c.daisy} devices takes a multiple of ${c.daisy} words, not ${nWords}`)
    const mosiW = Array.from({ length: nWords }, (_, k) => mosi[k] ?? 0)
    const misoW = Array.from({ length: nWords }, (_, k) => x.miso?.[k] ?? 0)
    const ioW = x.io ?? []
    // the chain: device d's output is the chain's contents d words further on (README of spi.ts)
    const chain = Array.from({ length: c.daisy - 1 }, (_, d) => [...misoW.slice(c.daisy - 1 - d), ...mosiW].slice(0, nWords))
    expected.push({ cs, lanes, mosi: lanes === 1 ? mosiW : [], miso: lanes === 1 ? misoW : [], io: lanes > 1 ? [...ioW] : [] })

    const csAt = t
    if (c.selects > 0) w.set(csName(cs), csAt, csOn)
    const perClock = lanes
    const clocks = (c.bits / perClock) | 0
    if (c.bits % perClock !== 0) throw new ModelError('bits must divide by lanes')
    // what each line carries on clock k of word n
    const out = (n: number, k: number): { mosi: string; miso: string; io: string[]; chain: string[] } => {
      if (lanes === 1) {
        return {
          mosi: String(bitAt(mosiW[n] as number, k, c.bits, c.lsb_first)), miso: String(bitAt(misoW[n] as number, k, c.bits, c.lsb_first)), io: [],
          chain: chain.map((ws) => String(bitAt(ws[n] as number, k, c.bits, c.lsb_first))),
        }
      }
      const v = ioW[n] as number
      const io = Array.from({ length: lanes }, (_, lane) => {
        // clock k carries bits [k*lanes .. k*lanes+lanes-1] in transmission order; the highest lane takes the first
        const bitIndex = k * lanes + (lanes - 1 - lane)
        return String(bitAt(v, bitIndex, c.bits, c.lsb_first))
      })
      return { mosi: '0', miso: 'z', io, chain: [] }
    }
    const drive = (at: number, n: number, k: number, who: 'm' | 's' | 'both'): void => {
      const o = out(n, k)
      if (lanes === 1) {
        if (who !== 's') w.set('mosi', at + c.tv_master, o.mosi)
        if (who !== 'm') {
          if (tho < c.tv_slave && w.at('miso', at) !== 'z') w.set('miso', at + tho, 'x')
          w.set('miso', at + c.tv_slave, o.miso)
        }
        if (who !== 'm') o.chain.forEach((v, d) => w.set(`chain_d${d + 1}`, at + c.tv_slave, v))
      } else if (who !== 's') o.io.forEach((v, lane) => w.set(`io${lane}`, at + c.tv_master, v))
    }
    let edgeT = csAt + tCss
    const first0 = cpha === 0
    if (first0) drive(csAt, 0, 0, 'both')
    let lastEdge = edgeT
    for (let n = 0; n < nWords; n++) {
      if (n > 0) edgeT += c.t_word
      const wordStart = edgeT
      for (let k = 0; k < clocks; k++) {
        const lead = edgeT
        const trail = lead + tActive
        w.set('sck', lead, active)
        w.set('sck', trail, idle)
        const sampleAt = cpha === 0 ? lead : trail
        const launchAt = cpha === 0 ? trail : lead
        if (cpha === 1) drive(launchAt, n, k, 'both')
        else {
          // CPHA 0: the next bit goes out on this trailing edge
          const nk = k + 1 < clocks ? [n, k + 1] : n + 1 < nWords ? [n + 1, 0] : null
          if (nk) drive(launchAt, nk[0] as number, nk[1] as number, 'both')
        }
        if (lanes === 1) w.expect({ t: sampleAt, signal: 'miso', expected: out(n, k).miso as '0' | '1', label: `transfer ${ti} word ${n} bit ${k}` })
        lastEdge = trail
        edgeT = lead + T
      }
      const lab = lanes === 1 ? `${c.daisy > 1 ? `dev${c.daisy - 1 - (n % c.daisy)} ` : ''}MOSI 0x${(mosiW[n] as number).toString(16)} / MISO 0x${(misoW[n] as number).toString(16)}` : `IO×${lanes} 0x${(ioW[n] as number).toString(16)}`
      w.note({ t0: wordStart, t1: lastEdge, lane: 'spi', label: lab, kind: 'data', tx: ti })
      edgeT = lastEdge + tIdle
    }
    const csOff = lastEdge + tCsh
    if (c.selects > 0) {
      w.set(csName(cs), csOff, csIdle)
      w.note({ t0: csAt, t1: csOff, lane: 'spi', label: `CS${c.selects > 1 ? cs : ''}`, kind: 'frame', tx: ti })
    }
    // the responder lets go of MISO when it is deselected
    if (lanes === 1) w.set('miso', csOff + c.tv_slave, 'z')
    else for (let lane = 0; lane < lanes; lane++) w.set(`io${lane}`, csOff + c.tv_master, 'z')
    t = csOff + tCsd
  })
  w.idle(t)
  const sampleRising = (cpol === 0) === (cpha === 0)
  return { wave: w, expected, sample: sampleRising ? 'rising' : 'falling' }
}

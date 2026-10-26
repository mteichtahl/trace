/**
 * Junction temperature per part at an ambient corner, from the package's thermal metrics (JEDEC JESD51 family;
 * TI SPRA953 "Semiconductor and IC Package Thermal Metrics" explains each), with the caveat of the one used:
 *
 *   psi_jt    Tj = T_top + P psi_JT       a measured (or modelled) package-top temperature; the best estimate when
 *                                          the top is measured, since psi barely depends on the board
 *   psi_jb    Tj = T_board + P psi_JB     the board temperature under the part (thermal.board); psi_JB is a
 *                                          characterisation parameter, much less board-dependent than theta_JA
 *   theta_jb  Tj = T_board + P theta_JB   the same with theta_JB (measured with a ring cold plate, JESD51-8): it
 *                                          assumes nearly all heat leaves through the board, so it over-estimates
 *   theta_jc  Tj = Ta + P (theta_JC + theta_CS + theta_SA)   a heatsink on the case; theta_JC (top) assumes all
 *                                          heat leaves through the case top
 *   theta_ja  Tj = Ta + P theta_JA        a JEDEC test board (JESD51-7 2s2p, or 1s), not this board: it can be off
 *                                          by a factor of two either way on a real layout
 *
 * Status: pass when Tj is at or below the derated limit; at-risk between the derated limit and Tj_max; fail above
 * Tj_max; unknown when there is no Tj_max or no usable metric.
 */
import { deratedLimit, type Derating, type PartLimit } from './store.js'

export const METHODS = ['auto', 'psi_jt', 'psi_jb', 'theta_jb', 'theta_jc', 'theta_ja'] as const
export type Method = (typeof METHODS)[number]
export type Status = 'pass' | 'at-risk' | 'fail' | 'unknown'

export const CAVEATS: Readonly<Record<Exclude<Method, 'auto'>, string>> = {
  psi_jt: 'psi_JT from the package top temperature: good when the top is measured; psi depends weakly on the board',
  psi_jb: 'psi_JB from the modelled board temperature under the part: depends on the board model\'s accuracy (thermal.board)',
  theta_jb: 'theta_JB assumes nearly all heat leaves through the board (JESD51-8 ring cold plate): conservative',
  theta_jc: 'theta_JC + interface + heatsink: assumes the heat leaves through the case into the heatsink',
  theta_ja: 'theta_JA is measured on a JEDEC test board (JESD51-7), not this board: it can be off by 2x either way',
}

export interface Heatsink { theta_cs: number; theta_sa: number; source: string }

export interface JunctionInput {
  ref: string
  power_w: number
  limits: PartLimit | undefined
  ambient_c: number
  derating: Derating
  /** the board temperature under the part (thermal.board) */
  board_c?: number | undefined
  /** a measured package-top temperature */
  top_c?: number | undefined
  heatsink?: Heatsink | undefined
  method?: Method | undefined
}

export interface JunctionResult {
  ref: string
  ambient_c: number
  power_w: number
  method: Exclude<Method, 'auto'> | null
  theta_c_per_w: number | null
  reference_c: number | null
  reference: 'ambient' | 'board' | 'top' | null
  tj_c: number | null
  tj_max_c: number | null
  derated_limit_c: number | null
  margin_c: number | null
  derated_margin_c: number | null
  status: Status
  caveat: string | null
  /** below the part's minimum (Tj_min) at this corner */
  below_min: boolean
  citations: Record<string, unknown>
  why?: string
}

function pick(i: JunctionInput): { method: Exclude<Method, 'auto'>; theta: number; ref: number; refName: 'ambient' | 'board' | 'top' } | { why: string } {
  const L = i.limits
  const want = i.method ?? 'auto'
  const can: Record<Exclude<Method, 'auto'>, (() => { theta: number; ref: number; refName: 'ambient' | 'board' | 'top' } | null)> = {
    psi_jt: () => (L?.psi_jt !== undefined && i.top_c !== undefined ? { theta: L.psi_jt, ref: i.top_c, refName: 'top' } : null),
    psi_jb: () => (L?.psi_jb !== undefined && i.board_c !== undefined ? { theta: L.psi_jb, ref: i.board_c, refName: 'board' } : null),
    theta_jb: () => (L?.theta_jb !== undefined && i.board_c !== undefined ? { theta: L.theta_jb, ref: i.board_c, refName: 'board' } : null),
    theta_jc: () => (L?.theta_jc !== undefined && i.heatsink ? { theta: L.theta_jc + i.heatsink.theta_cs + i.heatsink.theta_sa, ref: i.ambient_c, refName: 'ambient' } : null),
    theta_ja: () => (L?.theta_ja !== undefined ? { theta: L.theta_ja, ref: i.ambient_c, refName: 'ambient' } : null),
  }
  const order: Exclude<Method, 'auto'>[] = want === 'auto' ? ['psi_jt', 'psi_jb', 'theta_jb', 'theta_jc', 'theta_ja'] : [want]
  for (const m of order) {
    const r = can[m]()
    if (r) return { method: m, ...r }
  }
  return { why: want === 'auto' ? 'no usable metric: give theta_ja, or psi_jb/theta_jb with a board model, or psi_jt with a measured top' : `${want} needs its figure${want === 'psi_jt' ? ' and a measured top temperature' : want === 'theta_jc' ? ' and a heatsink' : want === 'theta_ja' ? '' : ' and a board temperature (thermal.board)'}` }
}

export function junction(i: JunctionInput): JunctionResult {
  const tjMax = i.limits?.tj_max_c ?? null
  const derated = tjMax === null ? null : deratedLimit(tjMax, i.derating)
  const p = pick(i)
  const base = { ref: i.ref, ambient_c: i.ambient_c, power_w: i.power_w, tj_max_c: tjMax, derated_limit_c: derated, citations: i.limits?.citations ?? {} }
  if ('why' in p) {
    return { ...base, method: null, theta_c_per_w: null, reference_c: null, reference: null, tj_c: null, margin_c: null, derated_margin_c: null, status: 'unknown', caveat: null, below_min: false, why: p.why }
  }
  const tj = p.ref + i.power_w * p.theta
  const margin = tjMax === null ? null : tjMax - tj
  const dmargin = derated === null ? null : derated - tj
  const status: Status = tjMax === null ? 'unknown' : tj > tjMax ? 'fail' : (dmargin as number) < 0 ? 'at-risk' : 'pass'
  const tjMin = i.limits?.tj_min_c
  return {
    ...base, method: p.method, theta_c_per_w: p.theta, reference_c: p.ref, reference: p.refName, tj_c: tj, margin_c: margin, derated_margin_c: dmargin,
    status, caveat: CAVEATS[p.method] + (i.heatsink && p.method === 'theta_jc' ? ` (heatsink: ${i.heatsink.source})` : ''),
    below_min: tjMin !== undefined && i.ambient_c < tjMin,
    ...(tjMax === null ? { why: 'no Tj_max for this part in the envelope (thermal.envelope action=set_part)' } : {}),
  }
}

/** The worst of several statuses (fail > at-risk > unknown > pass). */
export function worst(statuses: readonly Status[]): Status {
  for (const s of ['fail', 'at-risk', 'unknown'] as const) if (statuses.includes(s)) return s
  return 'pass'
}

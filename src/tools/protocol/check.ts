/**
 * Judge a capture against interface limits: a device's stored spec (protocol.spec), the bus standard's own limits
 * when there is none (UM10204 for I2C, AN126 / device figures for 1-Wire, the derived mid-bit tolerance for UART),
 * or limits given inline; inline wins over the spec, the spec over the standard.
 *
 * Each parameter's verdict compares the measured worst value with the limit that bounds it: a measured minimum with
 * the spec's min, a measured maximum with its max (a parameter with both, like I2C Hs tHD;DAT, is judged on both).
 * The margin is the distance to the limit, positive inside. A limit with nothing measured is reported as `not_seen`,
 * which does not fail the check but is listed (a capture without a repeated START cannot show tSU;STA).
 *
 * Mode compatibility: the mode a capture is decoded in against the modes the responder's spec lists, and the
 * initiator's against the responder's when both are stored.
 */
import { ToolError } from '../../core/registry.js'
import type { Measured } from './measure.js'
import { specMap, type Protocol, type SpecRow } from './spec.js'
import { I2C_STANDARD, ONEWIRE_LIMITS, uartTolerance, type Citation, type I2cSpeed, type Limit } from './standards.js'

export interface LimitRow { min?: number; max?: number; unit: string; source: string; cite: Citation | null }

export interface CheckRow {
  parameter: string
  measured: number | null
  unit: string
  limit: { min?: number; max?: number }
  margin: number | null
  pass: boolean | null
  status: 'pass' | 'fail' | 'not_seen' | 'info'
  source: string
  verified: true | null
  at?: { t0?: number | undefined; t1?: number | undefined; from?: string | undefined; to?: string | undefined; tx?: number | undefined }
  count: number
}

const fromLimit = (l: Limit, source: string): LimitRow => ({ ...(l.min !== undefined ? { min: l.min } : {}), ...(l.max !== undefined ? { max: l.max } : {}), unit: l.unit, source, cite: l.cite })

/** The limits that apply: the standard's (when a mode is named), then the device spec's, then inline ones. */
export function limitsFor(protocol: Protocol, o: { device?: string | undefined; standard?: string | undefined; frameBits?: number | undefined; vdd?: number | undefined; inline?: Record<string, { min?: number | undefined; max?: number | undefined; unit?: string | undefined }> | undefined }): { limits: Map<string, LimitRow>; spec: Map<string, SpecRow> | null } {
  const out = new Map<string, LimitRow>()
  if (protocol === 'i2c' && o.standard) {
    const std = I2C_STANDARD[o.standard as I2cSpeed]
    if (!std) throw new ToolError(`no I2C speed mode ${o.standard}`)
    for (const [k, l] of Object.entries(std)) {
      if (!l || ['c_b', 't_sp', 'vol', 'iol', 'vil', 'vih', 'tvd_ack'].includes(k)) continue
      out.set(k, fromLimit(l, `UM10204 ${o.standard}`))
    }
  }
  if (protocol === 'onewire') {
    const std = ONEWIRE_LIMITS[(o.standard as 'standard' | 'overdrive') ?? 'standard']
    if (!std) throw new ToolError(`no 1-Wire speed ${o.standard}`)
    for (const [k, l] of Object.entries(std)) out.set(k, fromLimit(l, `1-Wire ${o.standard ?? 'standard'}`))
  }
  if (protocol === 'uart' && o.frameBits) {
    const tol = uartTolerance(o.frameBits)
    out.set('baud_error', { max: tol.per_end_pct, unit: '%', source: `derived: ±0.5 bit over ${o.frameBits - 0.5} bits, split between the two ends`, cite: null })
  }
  // errors must be zero, whatever the source
  for (const k of ['framing_errors', 'parity_errors', 'unknown_bits', 'frame_errors', 'not_acknowledged']) out.set(k, { max: 0, unit: '', source: 'protocol', cite: null })
  let spec: Map<string, SpecRow> | null = null
  if (o.device) {
    spec = specMap(o.device, protocol)
    for (const [k, r] of spec) {
      if (r.min === undefined && r.max === undefined) continue
      let mn = r.min
      let mx = r.max
      if (r.unit === 'VDD') {
        if (o.vdd === undefined) continue
        mn = mn === undefined ? undefined : mn * o.vdd
        mx = mx === undefined ? undefined : mx * o.vdd
      }
      if (k === 'baud_tol') {
        out.set('baud_error', { ...(mx !== undefined ? { max: mx } : {}), unit: '%', source: `spec ${o.device}`, cite: r.citation })
        continue
      }
      out.set(k, { ...(mn !== undefined ? { min: mn } : {}), ...(mx !== undefined ? { max: mx } : {}), unit: r.unit === 'VDD' ? 'V' : r.unit, source: `spec ${o.device}`, cite: r.citation })
    }
  }
  // a maximum on tHD;DAT (Hs-mode) bounds the latest SDA change after SCL falls: that is what tvd_dat measures
  const hd = out.get('thd_dat')
  if (protocol === 'i2c' && hd?.max !== undefined) {
    const vd = out.get('tvd_dat')
    if (!vd || vd.max === undefined || hd.max < vd.max) out.set('tvd_dat', { max: hd.max, unit: 's', source: `${hd.source} (tHD;DAT max)`, cite: hd.cite })
  }
  for (const [k, l] of Object.entries(o.inline ?? {})) out.set(k, { ...(l.min !== undefined ? { min: l.min } : {}), ...(l.max !== undefined ? { max: l.max } : {}), unit: l.unit ?? 's', source: 'inline', cite: null })
  return { limits: out, spec }
}

export function judgeAll(measured: readonly Measured[], limits: ReadonlyMap<string, LimitRow>, txAt?: (t: number) => number | undefined): CheckRow[] {
  const rows: CheckRow[] = []
  const seen = new Set<string>()
  for (const m of measured) {
    seen.add(m.parameter)
    const l = limits.get(m.parameter)
    const at = { t0: m.t0, t1: m.t1, from: m.from, to: m.to, tx: m.tx }
    if (!l) {
      rows.push({ parameter: m.parameter, measured: m.value, unit: m.unit, limit: {}, margin: null, pass: null, status: 'info', source: 'measured only', verified: null, at, count: m.count })
      continue
    }
    const v = m.value
    // each side of the limit against the measured extreme on that side (the worst value when only it is known)
    const lo = m.range ? m.range.min : m.worst === 'min' ? v : null
    const hi = m.range ? m.range.max : m.worst === 'max' ? v : null
    const sides: { margin: number; value: number; at?: [number, number] | undefined }[] = []
    if (l.min !== undefined && lo !== null) sides.push({ margin: lo - l.min, value: lo, at: m.range?.at_min })
    if (l.max !== undefined && hi !== null) sides.push({ margin: l.max - hi, value: hi, at: m.range?.at_max })
    const worstSide = sides.length ? sides.reduce((x, y) => (y.margin < x.margin ? y : x)) : null
    const margin = worstSide ? worstSide.margin : null
    if (worstSide?.at) { at.t0 = worstSide.at[0]; at.t1 = worstSide.at[1]; at.tx = txAt?.(worstSide.at[0]) ?? at.tx }
    const shown = worstSide ? worstSide.value : v
    // rounding noise is not a violation: times are ps-rounded sums, so allow 1e-9 of the limit (and 1 fs)
    const tol = Math.max(1e-15, 1e-9 * Math.max(Math.abs(l.min ?? 0), Math.abs(l.max ?? 0)))
    const pass = v === null ? false : margin === null ? true : margin >= -tol
    rows.push({ parameter: m.parameter, measured: shown, unit: m.unit || l.unit, limit: { ...(l.min !== undefined ? { min: l.min } : {}), ...(l.max !== undefined ? { max: l.max } : {}) }, margin, pass, status: pass ? 'pass' : 'fail', source: l.source, verified: l.cite?.verified ?? null, at, count: m.count })
  }
  for (const [k, l] of limits) {
    if (seen.has(k) || l.source === 'protocol') continue
    rows.push({ parameter: k, measured: null, unit: l.unit, limit: { ...(l.min !== undefined ? { min: l.min } : {}), ...(l.max !== undefined ? { max: l.max } : {}) }, margin: null, pass: null, status: 'not_seen', source: l.source, verified: l.cite?.verified ?? null, count: 0 })
  }
  return rows
}

/** SPI modes: the capture's against the responder's list, and the initiator's list against it. */
export function modeCompat(mode: number | undefined, responder: Map<string, SpecRow> | null, initiator: Map<string, SpecRow> | null): { ok: boolean | null; notes: string[] } {
  const notes: string[] = []
  const modesOf = (s: Map<string, SpecRow> | null): number[] | null => {
    const v = s?.get('modes')?.value
    return Array.isArray(v) ? v.map(Number) : null
  }
  const r = modesOf(responder)
  const i = modesOf(initiator)
  let ok: boolean | null = null
  if (r && mode !== undefined) {
    ok = r.includes(mode)
    notes.push(ok ? `mode ${mode} is one the responder supports (${r.join(', ')})` : `mode ${mode} is not one the responder supports (${r.join(', ')})`)
  }
  if (r && i) {
    const common = i.filter((m) => r.includes(m))
    notes.push(common.length ? `initiator and responder share mode(s) ${common.join(', ')}` : `no mode in common: initiator ${i.join(', ')}, responder ${r.join(', ')}`)
    ok = (ok ?? true) && common.length > 0
  }
  return { ok, notes }
}

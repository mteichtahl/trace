/**
 * Initiator against responder, from their specs: the classic interface timing budget, at the corners.
 *
 * SPI (both sides of every path, with the half period H = min(duty, 1 - duty) / f the worst phase the clock gives):
 *
 *   write (MOSI, judged at the responder)
 *     setup  H + fl_sck(min) - tV,m(max) - fl_mosi(max) - tSU,s          >= 0
 *     hold   H + tHO,m(min) + fl_mosi(min) - fl_sck(max) - tH,s            >= 0
 *   read  (MISO, judged at the initiator; the responder launches on the clock it receives)
 *     setup  H - fl_sck(max) - tV,s(max) - fl_miso(max) - tSU,m           >= 0
 *     hold   H + fl_sck(min) + tHO,s(min) + fl_miso(min) - tH,m            >= 0
 *
 * so the read path sets fmax = min(duty, 1 - duty) / (fl_sck + tV,s + fl_miso + tSU,m). Also fSCK against both
 * devices' maxima, SCK high and low times, tCSS / tCSH / tCSD the initiator gives against what the responder needs,
 * and the modes they share. For an initiator's spec, tsu/th are its MISO input requirement and tv/tho its MOSI
 * output; for a responder's, the other way round (tsu_mi / th_mi name the initiator's input explicitly).
 *
 * I2C: every timing the initiator generates (tLOW, tHIGH, tSU;DAT, tHD;STA, tSU;STA, tSU;STO, tBUF, minimums it
 * guarantees) against the responder's minimum; fSCL; the read path tLOW,m - tr - tVD;DAT,s - tSU;DAT,m >= 0 (the
 * responder's data must settle within the low phase), with tr from the spec or protocol.bus_analog.
 *
 * Corners: `slow` takes every delay at its maximum, `fast` at its minimum, `bound` the worst mix for each check
 * (the figure the verdict rests on). A missing figure is listed and its check skipped, never assumed.
 */
import type { SpecRow } from './spec.js'

export interface Range { min: number; max: number }
export interface Flights { sck: Range; mosi: Range; miso: Range }

export interface BudgetRow {
  check: string
  formula: string
  corners: { bound: number | null; slow: number | null; fast: number | null }
  pass: boolean | null
  missing?: string[]
}

const get = (s: Map<string, SpecRow>, k: string, side: 'min' | 'max' | 'typ'): number | undefined => s.get(k)?.[side]

/** A delay's range from a spec row: min and max when both are there, else the one given for both. */
function delayRange(s: Map<string, SpecRow>, k: string): Range | null {
  const r = s.get(k)
  if (!r) return null
  const mn = r.min ?? r.typ ?? r.max
  const mx = r.max ?? r.typ ?? r.min
  return mn === undefined || mx === undefined ? null : { min: mn, max: mx }
}

export function spiBudget(o: { initiator: Map<string, SpecRow>; responder: Map<string, SpecRow>; f: number; duty?: Range | undefined; flight: Flights }): { rows: BudgetRow[]; f_max_read: number | null; f_max_write: number | null; half_period: number } {
  const T = 1 / o.f
  const duty = o.duty ?? { min: 0.5, max: 0.5 }
  const H = Math.min(duty.min, 1 - duty.max) * T
  const m = o.initiator
  const s = o.responder
  const tvM = delayRange(m, 'tv')
  const thoM = delayRange(m, 'tho')
  const tsuS = get(s, 'tsu', 'min')
  const thS = get(s, 'th', 'min')
  const tvS = delayRange(s, 'tv')
  const thoS = delayRange(s, 'tho')
  const tsuM = get(m, 'tsu_mi', 'min') ?? get(m, 'tsu', 'min')
  const thM = get(m, 'th_mi', 'min') ?? get(m, 'th', 'min')
  const fl = o.flight
  const rows: BudgetRow[] = []
  const row = (check: string, formula: string, need: Record<string, unknown>, f: (sel: 'bound' | 'slow' | 'fast') => number): void => {
    const missing = Object.entries(need).filter(([, v]) => v === undefined || v === null).map(([k]) => k)
    if (missing.length) {
      rows.push({ check, formula, corners: { bound: null, slow: null, fast: null }, pass: null, missing })
      return
    }
    const c = { bound: f('bound'), slow: f('slow'), fast: f('fast') }
    rows.push({ check, formula, corners: c, pass: c.bound >= -1e-15 - 1e-9 * Math.abs(c.bound) })
  }
  type Sel = 'bound' | 'slow' | 'fast'
  const pick = (r: Range, sel: Sel, worst: 'min' | 'max'): number => (sel === 'slow' ? r.max : sel === 'fast' ? r.min : r[worst])
  row('write setup at the responder', 'H + fl_sck(min) - tV,m(max) - fl_mosi(max) - tSU,s', { 'initiator tv': tvM, 'responder tsu': tsuS },
    (sel) => H + pick(fl.sck, sel, 'min') - pick(tvM as Range, sel, 'max') - pick(fl.mosi, sel, 'max') - (tsuS as number))
  row('write hold at the responder', 'H + tHO,m(min) + fl_mosi(min) - fl_sck(max) - tH,s', { 'initiator tho': thoM, 'responder th': thS },
    (sel) => H + pick(thoM as Range, sel, 'min') + pick(fl.mosi, sel, 'min') - pick(fl.sck, sel, 'max') - (thS as number))
  row('read setup at the initiator', 'H - fl_sck(max) - tV,s(max) - fl_miso(max) - tSU,m', { 'responder tv': tvS, 'initiator tsu_mi (or tsu)': tsuM },
    (sel) => H - pick(fl.sck, sel, 'max') - pick(tvS as Range, sel, 'max') - pick(fl.miso, sel, 'max') - (tsuM as number))
  row('read hold at the initiator', 'H + fl_sck(min) + tHO,s(min) + fl_miso(min) - tH,m', { 'responder tho': thoS, 'initiator th_mi (or th)': thM },
    (sel) => H + pick(fl.sck, sel, 'min') + pick(thoS as Range, sel, 'min') + pick(fl.miso, sel, 'min') - (thM as number))
  const fS = get(s, 'f_sck', 'max')
  const fM = get(m, 'f_sck', 'max')
  row('fSCK within the responder maximum', 'fSCK,s(max) - f', { 'responder f_sck': fS }, () => (fS as number) - o.f)
  row('fSCK within the initiator maximum', 'fSCK,m(max) - f', { 'initiator f_sck': fM }, () => (fM as number) - o.f)
  for (const [k, phase] of [['t_sck_high', duty.min], ['t_sck_low', 1 - duty.max]] as const) {
    const need = get(s, k, 'min')
    row(`${k} the responder needs`, `${k === 't_sck_high' ? 'duty(min)' : '(1 - duty(max))'} × T - ${k},s`, { [`responder ${k}`]: need }, () => phase * T - (need as number))
  }
  for (const k of ['tcss', 'tcsh', 'tcsd'] as const) {
    const give = get(m, k, 'min')
    const need = get(s, k, 'min')
    row(`${k}: initiator gives, responder needs`, `${k},m(min) - ${k},s(min)`, { [`initiator ${k}`]: give, [`responder ${k}`]: need }, () => (give as number) - (need as number))
  }
  const readNeed = tvS && tsuM !== undefined ? fl.sck.max + tvS.max + fl.miso.max + tsuM : null
  const writeNeed = tvM && tsuS !== undefined ? tvM.max + fl.mosi.max + tsuS - fl.sck.min : null
  const half = Math.min(duty.min, 1 - duty.max)
  return { rows, f_max_read: readNeed && readNeed > 0 ? half / readNeed : null, f_max_write: writeNeed && writeNeed > 0 ? half / writeNeed : null, half_period: H }
}

export function i2cBudget(o: { initiator: Map<string, SpecRow>; responder: Map<string, SpecRow>; f?: number | undefined; t_r?: number | undefined }): { rows: BudgetRow[] } {
  const m = o.initiator
  const s = o.responder
  const rows: BudgetRow[] = []
  const add = (check: string, formula: string, need: Record<string, number | undefined>, v: () => number): void => {
    const missing = Object.entries(need).filter(([, x]) => x === undefined).map(([k]) => k)
    if (missing.length) rows.push({ check, formula, corners: { bound: null, slow: null, fast: null }, pass: null, missing })
    else { const b = v(); rows.push({ check, formula, corners: { bound: b, slow: b, fast: b }, pass: b >= -1e-15 }) }
  }
  for (const k of ['t_low', 't_high', 'tsu_dat', 'thd_dat', 'thd_sta', 'tsu_sta', 'tsu_sto', 't_buf']) {
    const give = get(m, k, 'min')
    const need = get(s, k, 'min')
    add(`${k}: initiator gives, responder needs`, `${k},m(min) - ${k},s(min)`, { [`initiator ${k}`]: give, [`responder ${k}`]: need }, () => (give as number) - (need as number))
  }
  const f = o.f ?? get(m, 'f_scl', 'max')
  const fS = get(s, 'f_scl', 'max')
  add('fSCL within the responder maximum', 'fSCL,s(max) - f', { f, 'responder f_scl': fS }, () => (fS as number) - (f as number))
  const tLow = get(m, 't_low', 'min')
  const tvd = get(s, 'tvd_dat', 'max')
  const tr = o.t_r ?? get(s, 't_r', 'max') ?? get(m, 't_r', 'max')
  const tsuM = get(m, 'tsu_dat', 'min')
  add('read: responder data settles within tLOW', 'tLOW,m(min) - tr - tVD;DAT,s(max) - tSU;DAT,m(min)', { 'initiator t_low': tLow, 'responder tvd_dat': tvd, t_r: tr, 'initiator tsu_dat': tsuM },
    () => (tLow as number) - (tr as number) - (tvd as number) - (tsuM as number))
  const cbS = get(s, 'c_b', 'max')
  const cbM = get(m, 'c_b', 'max')
  if (cbS !== undefined && cbM !== undefined) add('bus capacitance limits agree', 'informational: the lower Cb max governs', { cbS, cbM }, () => 0)
  return { rows }
}

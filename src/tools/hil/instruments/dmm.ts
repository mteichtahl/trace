/**
 * Bench multimeters: one reading of DC/AC voltage or current, resistance (2- or 4-wire), frequency, continuity or diode,
 * with range and integration time (NPLC).
 *
 * Most DMMs (Keysight 344xx, Keithley 2000/DMM6500, Rigol DM3000, Siglent SDM, R&S HMC8012) accept the SCPI-99 form
 * CONF:<function> <range>; <function>:NPLC <n>; READ?, so one dialect covers them. Keithley's 2110/DMM6500 use the
 * same text. Functions without NPLC (AC, frequency) simply skip it.
 */
import { ToolError } from '../../../core/registry.js'
import { num } from '../scpi.js'
import type { DialectMatch } from './base.js'

export type DmmFunction = 'vdc' | 'vac' | 'idc' | 'iac' | 'res' | 'fres' | 'freq' | 'cont' | 'diode'

export interface DmmDialect extends DialectMatch {
  configure(fn: DmmFunction, range: number | 'auto', nplc?: number): string[]
  read: string
}

const SCPI: Record<DmmFunction, { conf: string; nplc: string | null; unit: string }> = {
  vdc: { conf: 'VOLT:DC', nplc: 'VOLT:DC:NPLC', unit: 'V' },
  vac: { conf: 'VOLT:AC', nplc: null, unit: 'V' },
  idc: { conf: 'CURR:DC', nplc: 'CURR:DC:NPLC', unit: 'A' },
  iac: { conf: 'CURR:AC', nplc: null, unit: 'A' },
  res: { conf: 'RES', nplc: 'RES:NPLC', unit: 'Ohm' },
  fres: { conf: 'FRES', nplc: 'FRES:NPLC', unit: 'Ohm' },
  freq: { conf: 'FREQ', nplc: null, unit: 'Hz' },
  cont: { conf: 'CONT', nplc: null, unit: 'Ohm' },
  diode: { conf: 'DIOD', nplc: null, unit: 'V' },
}

export const dmmUnit = (fn: DmmFunction): string => SCPI[fn].unit

const scpi99 = (fn: DmmFunction, range: number | 'auto', nplc?: number): string[] => {
  const s = SCPI[fn]
  const noRange = fn === 'cont' || fn === 'diode'
  const out = [`CONF:${s.conf}${noRange ? '' : ` ${range === 'auto' ? 'AUTO' : String(range)}`}`]
  if (nplc !== undefined) {
    if (!s.nplc) throw new ToolError(`${fn} has no NPLC setting`)
    out.push(`${s.nplc} ${nplc}`)
  }
  return out
}

export const DMM_DIALECTS: readonly DmmDialect[] = [
  { id: 'keysight-344xx', idn: /(AGILENT|KEYSIGHT|HEWLETT).*,\s*344\d\d/i, configure: scpi99, read: 'READ?' },
  { id: 'keithley', idn: /KEITHLEY.*,\s*(MODEL\s*)?(2000|2001|2002|2010|2100|2110|DMM6500|DMM7510)/i, configure: scpi99, read: 'READ?' },
  { id: 'rigol-dm3000', idn: /RIGOL.*,\s*DM3\d+/i, configure: scpi99, read: 'READ?' },
  { id: 'siglent-sdm', idn: /SIGLENT.*,\s*SDM\d+/i, configure: scpi99, read: 'READ?' },
  { id: 'generic', idn: /$^/, configure: scpi99, read: 'READ?' },
]

/** A DMM reading; ±9.9E37 means overload. */
export function parseReading(s: string): number | null {
  const v = num(s)
  return Math.abs(v) >= 9e37 ? null : v
}

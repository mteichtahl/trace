/**
 * The shape every result chart is drawn from: the chat's PlotData (title, axes, series of [x, y] points, an optional
 * limit) with what a results file adds: a log x axis, and the name of the panel when a file draws as several (a
 * magnitude and a phase, voltages and currents) shown one at a time.
 */
import type { PlotData } from '@/components/chat/cards'

export type ResultPlot = PlotData & {
  /** draw x on a log axis (frequency sweeps) */
  xLog?: boolean
  /** the panel's word in the switch ("Magnitude", "Phase", "Voltage") */
  panel?: string
}

/** Units drawn as plain numbers, never with an engineering prefix (no "mdB" or "k°"). */
const PLAIN = new Set(['dB', '°', '°C', '%', 'dBm', 'dBµV', 'dBuV/m', ''])

/** A value for an axis or a tooltip: 4.7 k, 2.2 µ with the unit; dB and degrees as plain numbers. */
export function fmtValue(v: number, unit?: string, digits = 3): string {
  if (!Number.isFinite(v)) return String(v)
  const u = unit ?? ''
  if (PLAIN.has(u)) {
    const a = Math.abs(v)
    const s = a !== 0 && (a < 1e-3 || a >= 1e6) ? v.toExponential(digits - 1) : String(Number(v.toPrecision(digits)))
    return u ? `${s} ${u}` : s
  }
  return engShort(v, u, digits)
}

const PREFIXES: [number, string][] = [
  [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'],
]
function engShort(v: number, unit: string, digits: number): string {
  if (v === 0) return `0 ${unit}`.trim()
  const a = Math.abs(v)
  const [s, p] = PREFIXES.find(([k]) => a >= k * 0.9995) ?? PREFIXES[PREFIXES.length - 1]!
  return `${Number((v / s).toPrecision(digits))} ${p}${unit}`.trim()
}

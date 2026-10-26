/**
 * Component values as designs write them ("3m", "23.2k", "330u", "4k7", "10MEG") and as people read them ("20.7 A").
 *
 * Prefixes follow KiCad and SPICE: lower-case "m" is milli; mega is "M" in KiCad, "MEG"/"meg" in SPICE. A bare SPICE
 * "m"/"M" is milli (SPICE ignores case), so parseValue(s, { spice: true }) reads "1M" as 1e-3 and "1MEG" as 1e6, while
 * the default (KiCad) reading takes "1M" as 1e6. Anything that is not clearly a value throws: a value is never guessed.
 */

export class ValueError extends Error {
  override name = 'ValueError'
}

const PREFIX: Readonly<Record<string, number>> = {
  f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, '': 1,
  k: 1e3, K: 1e3, M: 1e6, MEG: 1e6, meg: 1e6, Meg: 1e6, G: 1e9, T: 1e12,
}
const UNIT = '(?:F|H|R|Ω|ohms?|Ohms?|V|A|W|Hz|s)?'
const VALUE = new RegExp(`^\\s*([-+]?[0-9]*\\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\\s*(MEG|[Mm]eg|[fpnuµμmkKMGT]?)\\s*${UNIT}\\s*$`)
// "4k7" / "2R2" / "1M5": the prefix letter is the decimal point
const RKM = new RegExp(`^\\s*([0-9]+)([pnuµμmkKMGR])([0-9]+)\\s*${UNIT}\\s*$`)

/** '3m' → 0.003, '23.2k' → 23200, '330u' → 3.3e-4, '4k7' → 4700, '10M' → 1e7, '100nF' → 1e-7. */
export function parseValue(s: string | number, opts: { spice?: boolean } = {}): number {
  if (typeof s === 'number') {
    if (!Number.isFinite(s)) throw new ValueError(`not a finite value: ${s}`)
    return s
  }
  const text = s.trim()
  let m = VALUE.exec(text)
  if (m) {
    let p = m[2] ?? ''
    if (opts.spice && (p === 'M' || p === 'm')) p = 'm'
    return Number(m[1]) * (PREFIX[p] ?? NaN)
  }
  m = RKM.exec(text)
  if (m) {
    const p = m[2] ?? ''
    const mult = p === 'R' ? 1 : PREFIX[opts.spice && p === 'M' ? 'm' : p] ?? NaN
    return Number(`${m[1]}.${m[3]}`) * mult
  }
  throw new ValueError(`not a component value: ${JSON.stringify(s)}`)
}

const ENG: ReadonlyArray<readonly [number, string]> = [
  [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'],
]
const UNITLESS = new Set(['%', '', 'x', 'ratio', '°C', 'dB', 'deg', 'LSB', 'bits', 'count'])

/** Significant digits like printf's %g, without exponent noise for normal magnitudes. */
export function sig(x: number, digits = 3): string {
  return String(Number(x.toPrecision(digits)))
}

/** 20.71 → '20.7 A'; 0.0104 s → '10.4 ms'; 3.3e-4 F → '330 µF'. */
export function eng(x: number | null | undefined, unit = '', digits = 3): string {
  if (x === null || x === undefined) return '—'
  if (!Number.isFinite(x)) return String(x)
  if (UNITLESS.has(unit)) return `${sig(x, digits)}${unit ? ` ${unit}` : ''}`
  if (x === 0) return `0 ${unit}`.trim()
  const a = Math.abs(x)
  for (const [scale, p] of ENG) if (a >= scale * 0.9995) return `${sig(x / scale, digits)} ${p}${unit}`.trim()
  return `${sig(x, digits)} ${unit}`.trim()
}

/** E-series preferred values (IEC 60063), one decade. */
export type ESeries = 'E6' | 'E12' | 'E24' | 'E48' | 'E96'

const E: Record<ESeries, readonly number[]> = {
  E6: [1.0, 1.5, 2.2, 3.3, 4.7, 6.8],
  E12: [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2],
  E24: [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1],
  // IEC 60063's E48 and E96 are exactly 10^(i/n) rounded to three significant figures.
  E48: Array.from({ length: 48 }, (_, i) => Math.round(10 ** (i / 48) * 100) / 100),
  E96: Array.from({ length: 96 }, (_, i) => Math.round(10 ** (i / 96) * 100) / 100),
}

export function preferred(series: ESeries): readonly number[] {
  return E[series]
}

/** The preferred value in `series` closest to x (by ratio). */
export function nearest(x: number, series: ESeries = 'E24'): number {
  if (!(x > 0) || !Number.isFinite(x)) throw new ValueError(`no preferred value for ${x}`)
  const decade = 10 ** Math.floor(Math.log10(x))
  let best = NaN
  let err = Infinity
  for (const d of [decade / 10, decade, decade * 10]) {
    for (const v of E[series]) {
      const c = v * d
      const e = Math.abs(Math.log(c / x))
      if (e < err) { err = e; best = c }
    }
  }
  return Number(best.toPrecision(12))
}

/** Every preferred value in `series` from lo to hi inclusive. */
export function seriesValues(series: ESeries, lo: number, hi: number): number[] {
  const out: number[] = []
  for (let d = 10 ** Math.floor(Math.log10(lo)); d <= hi; d *= 10) {
    for (const v of E[series]) {
      const c = Number((v * d).toPrecision(12))
      if (c >= lo * (1 - 1e-9) && c <= hi * (1 + 1e-9)) out.push(c)
    }
  }
  return out
}

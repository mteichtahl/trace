/**
 * Closed-form EMI estimates: the spectrum of a trapezoidal pulse train, and the far field radiated by a small
 * current loop (differential mode) and by a short wire carrying common-mode current. Pure functions.
 *
 * Trapezoidal pulse train (C. R. Paul, "Introduction to Electromagnetic Compatibility", 2nd ed., Wiley 2006, §3.2):
 * amplitude A, period T, pulse width tau measured at the 50 % points, equal rise and fall time tr. The n-th
 * harmonic's amplitude (one-sided, peak) is
 *
 *     c_n = 2 A (tau/T) |sinc(n pi tau/T)| |sinc(n pi tr/T)|,   sinc(x) = sin(x)/x,
 *
 * bounded by the envelope 2 A tau/T, falling at -20 dB/decade from f1 = 1/(pi tau) and at -40 dB/decade from
 * f2 = 1/(pi tr). Unequal rise and fall times are treated as both equal to the shorter one, which over-estimates
 * the spectrum above f2 (conservative).
 *
 * Radiated far field (H. W. Ott, "Electromagnetic Compatibility Engineering", Wiley 2009, §12.1 and §12.2; the same
 * results follow from the small-loop and short-dipole fields):
 *
 *   differential mode, a loop of area S (m^2) with current I (A) at frequency f, distance r, maximum over angle:
 *       |E| = 1.316e-14 f^2 S I / r          free space  (eta0 pi f^2 S I / (c^2 r))
 *       x 2 (2.632e-14) over a reflecting ground plane, as on an open-area test site / semi-anechoic chamber
 *   common mode, a wire of length L (m) with common-mode current I:
 *       |E| = 6.283e-7 f L I / r             free space  (mu0 f L I / (2 r)), valid for L << lambda
 *       x 2 (1.257e-6) over a ground plane
 *     For L > lambda/2 the wire is no longer short; the estimate uses L = lambda/2 there (a half-wave resonant
 *     wire), as Ott suggests, and says so.
 *
 * The far-field forms need r beyond about lambda/(2 pi); at 3 m that is above ~16 MHz. A harmonic's peak amplitude
 * is converted to rms (/sqrt 2) before comparison with limits; for a steady harmonic the peak, quasi-peak and
 * average detectors read the same, so detector differences are ignored.
 */
export const C0 = 299_792_458
export const ETA0 = 376.730313668
export const MU0 = 1.25663706212e-6
/** Small loop, free space: eta0 pi / c^2. */
export const K_DM = (ETA0 * Math.PI) / (C0 * C0)
/** Short dipole, free space: mu0 / 2. */
export const K_CM = MU0 / 2

export interface Trapezoid {
  /** pulse amplitude (V or A), 0 to A */
  amplitude: number
  /** repetition frequency (Hz) */
  freq: number
  /** pulse width at 50 % as a fraction of the period (0.5 for a clock) */
  duty?: number
  /** 10-90 % rise time (s); for the spectrum the 0-100 % time is taken as tr / 0.8 */
  rise: number
  fall?: number
}

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(x) / x)

/** The 0-100 % transition time used by the trapezoid from a 10-90 % rise time. */
export const fullTransition = (t1090: number): number => t1090 / 0.8

function parts(p: Trapezoid): { A: number; T: number; d: number; tr: number } {
  if (!(p.freq > 0) || !(p.rise > 0) || !(p.amplitude > 0)) throw new RangeError('trapezoid needs amplitude, freq and rise > 0')
  const d = p.duty ?? 0.5
  if (!(d > 0 && d < 1)) throw new RangeError('duty must be between 0 and 1')
  const tr = fullTransition(Math.min(p.rise, p.fall ?? p.rise))
  const T = 1 / p.freq
  if (tr >= d * T || tr >= (1 - d) * T) throw new RangeError('the edges are longer than the pulse: not a trapezoid')
  return { A: p.amplitude, T, d, tr }
}

/** Amplitude (peak) of harmonic n. */
export function harmonic(p: Trapezoid, n: number): number {
  const { A, T, d, tr } = parts(p)
  return 2 * A * d * Math.abs(sinc(n * Math.PI * d)) * Math.abs(sinc((n * Math.PI * tr) / T))
}

export function envelopeCorners(p: Trapezoid): { f1: number; f2: number; low: number } {
  const { A, T, d, tr } = parts(p)
  return { f1: 1 / (Math.PI * d * T), f2: 1 / (Math.PI * tr), low: 2 * A * d }
}

/** The envelope's amplitude at frequency f. */
export function envelope(p: Trapezoid, f: number): number {
  const { f1, f2, low } = envelopeCorners(p)
  if (f <= f1) return low
  if (f <= f2) return (low * f1) / f
  return (low * f1 * f2) / (f * f)
}

/** Harmonics n*f in [fmin, fmax] with their amplitudes (at most `limit`, lowest first). */
export function harmonics(p: Trapezoid, fmin: number, fmax: number, limit = 10_000): { n: number; f: number; amplitude: number; envelope: number }[] {
  const out: { n: number; f: number; amplitude: number; envelope: number }[] = []
  for (let n = Math.max(1, Math.ceil(fmin / p.freq)); n * p.freq <= fmax && out.length < limit; n++) {
    out.push({ n, f: n * p.freq, amplitude: harmonic(p, n), envelope: envelope(p, n * p.freq) })
  }
  return out
}

/** Differential-mode loop: |E| (V/m, same amplitude convention as I) at distance r. */
export function dmField(f: number, area: number, current: number, r: number, groundReflection = true): number {
  return (groundReflection ? 2 : 1) * K_DM * f * f * area * current / r
}

/** Common-mode wire: |E| (V/m) at distance r; L capped at lambda/2. */
export function cmField(f: number, length: number, current: number, r: number, groundReflection = true): { e: number; length_used: number; capped: boolean } {
  const half = C0 / f / 2
  const L = Math.min(length, half)
  return { e: (groundReflection ? 2 : 1) * K_CM * f * L * current / r, length_used: L, capped: length > half }
}

/** The common-mode current (A) that gives field e (V/m) at r. */
export function cmCurrentFor(f: number, length: number, e: number, r: number, groundReflection = true): number {
  const L = Math.min(length, C0 / f / 2)
  return e * r / ((groundReflection ? 2 : 1) * K_CM * f * L)
}

/** The loop area (m^2) that gives field e (V/m) at r with current I. */
export function dmAreaFor(f: number, current: number, e: number, r: number, groundReflection = true): number {
  return e * r / ((groundReflection ? 2 : 1) * K_DM * f * f * current)
}

export const dBuV = (v: number): number => 20 * Math.log10(v / 1e-6)
export const dBuA = (a: number): number => 20 * Math.log10(a / 1e-6)
export const fromdBuV = (db: number): number => 1e-6 * 10 ** (db / 20)
export const peakToRms = (v: number): number => v / Math.SQRT2

/** Whether r is in the far field at f (r > lambda / 2 pi). */
export const farField = (f: number, r: number): boolean => r > C0 / f / (2 * Math.PI)

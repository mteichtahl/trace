/**
 * Bessel functions for the thermal closed forms (fins, spreading resistance, the plate validation case), from their
 * integral representations, evaluated by the trapezoid rule. The integrands are periodic (J, I) or decay double
 * exponentially (K), so the trapezoid rule converges exponentially and a few hundred points reach double precision
 * for the arguments used here (0 < x < ~600). DLMF 10.9.2 (J_n), 10.32.3 (I_n), 10.32.9 (K_n).
 *
 *   J_n(x) = (1/pi) int_0^pi cos(n t - x sin t) dt
 *   I_n(x) = (1/pi) int_0^pi exp(x cos t) cos(n t) dt
 *   K_n(x) = int_0^inf exp(-x cosh u) cosh(n u) du
 *
 * Pure functions; unit-tested against tabulated values (Abramowitz & Stegun tables 9.1 and 9.8).
 */

function trapPeriodic(f: (t: number) => number, n: number): number {
  // int_0^pi of an even, 2pi-periodic integrand: the trapezoid rule with end weights 1/2 is spectrally accurate
  const h = Math.PI / n
  let s = 0.5 * (f(0) + f(Math.PI))
  for (let k = 1; k < n; k++) s += f(k * h)
  return s * h
}

const points = (x: number): number => Math.min(4000, 64 + Math.ceil(2 * Math.abs(x)))

export function besselJ(n: 0 | 1, x: number): number {
  return trapPeriodic((t) => Math.cos(n * t - x * Math.sin(t)), points(x)) / Math.PI
}

/** I_n(x) * exp(-x): bounded for large x. */
export function besselIScaled(n: 0 | 1, x: number): number {
  if (x < 0) throw new RangeError('besselI: x must be >= 0')
  return trapPeriodic((t) => Math.exp(x * (Math.cos(t) - 1)) * Math.cos(n * t), points(x)) / Math.PI
}

export const besselI = (n: 0 | 1, x: number): number => besselIScaled(n, x) * Math.exp(x)

/** K_n(x) * exp(x): bounded for large x. */
export function besselKScaled(n: 0 | 1, x: number): number {
  if (!(x > 0)) throw new RangeError('besselK: x must be > 0')
  // exp(-x (cosh u - 1)) cosh(n u): truncate where the integrand is below 1e-18 of its peak
  const umax = Math.acosh(1 + 42 / x) + 1
  const m = 400 + Math.ceil(umax * 40)
  const h = umax / m
  const f = (u: number): number => Math.exp(-x * (Math.cosh(u) - 1)) * Math.cosh(n * u)
  let s = 0.5 * (f(0) + f(umax))
  for (let k = 1; k < m; k++) s += f(k * h)
  return s * h
}

export const besselK = (n: 0 | 1, x: number): number => besselKScaled(n, x) * Math.exp(-x)

/** The first `count` positive zeros of J1 (3.8317, 7.0156, …), by Newton from McMahon's asymptotic start. */
export function j1Zeros(count: number): number[] {
  const out: number[] = []
  for (let s = 1; s <= count; s++) {
    let x = (s + 0.25) * Math.PI - 3 / (8 * (s + 0.25) * Math.PI)
    for (let it = 0; it < 50; it++) {
      const j1 = besselJ(1, x)
      const d = besselJ(0, x) - j1 / x // J1'(x)
      const step = j1 / d
      x -= step
      if (Math.abs(step) < 1e-13 * x) break
    }
    out.push(x)
  }
  return out
}

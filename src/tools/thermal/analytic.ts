/**
 * Closed-form solutions the board models are validated against (test/tools/thermal, and thermal.board's
 * `validate` option, which reports the agreement in its result):
 *
 *   slab      1D conduction through a layer of thickness t, uniform flux q'' in at the top, the bottom cooled by h:
 *             T_top - T_inf = q'' (t / k + 1 / h)
 *   fin       a strip (width w, thickness t, length L) heated by Q at x = 0, both faces cooled by h, adiabatic tip
 *             (Incropera 7th ed. table 3.4 case B): theta(x) = Q cosh(m (L - x)) / (M' sinh(m L)),
 *             M' = sqrt(h P k A_c), m = sqrt(h P / (k A_c)), P = 2 w (edges neglected), A_c = w t
 *   plate     an infinite plate (k, t) cooled on both faces (h_top + h_bottom = H) with a uniform source Q over a
 *             disc of radius r0. With m^2 = H / (k t), x = m r0 and q_s = Q / (pi r0^2): inside, theta = q_s/H + B I0(m r);
 *             outside, theta = A K0(m r); continuity of theta and of the radial flux at r0 give
 *             A = (q_s/H) / (K0(x) + K1(x) I0(x) / I1(x)), B = -A K1(x) / I1(x), so the centre is
 *             theta(0) = q_s/H - A K1(x)/I1(x) (derived here; the outer part is the classical K0 plate solution,
 *             Carslaw & Jaeger, Conduction of Heat in Solids, 2nd ed., section 7.1 / fin theory)
 */
import { besselI, besselK } from './bessel.js'

export function slabRise(qFlux: number, t: number, k: number, h: number): { top: number; bottom: number } {
  return { bottom: qFlux / h, top: qFlux * (t / k + 1 / h) }
}

export function finRise(Q: number, h: number, k: number, w: number, t: number, L: number, x: number): number {
  const P = 2 * w
  const Ac = w * t
  const m = Math.sqrt((h * P) / (k * Ac))
  const M = Math.sqrt(h * P * k * Ac)
  return (Q * Math.cosh(m * (L - x))) / (M * Math.sinh(m * L))
}

export function plateRise(Q: number, r0: number, k: number, t: number, H: number, r = 0): number {
  const m = Math.sqrt(H / (k * t))
  const x = m * r0
  const qs = Q / (Math.PI * r0 * r0)
  const tp = qs / H
  const A = tp / (besselK(0, x) + (besselK(1, x) * besselI(0, x)) / besselI(1, x))
  if (r >= r0) return A * besselK(0, m * r)
  const B = (-A * besselK(1, x)) / besselI(1, x)
  return tp + B * besselI(0, m * r)
}

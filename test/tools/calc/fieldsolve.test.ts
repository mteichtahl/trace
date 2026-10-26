/**
 * The field solver against exact and published closed forms, ported from the solver's original accuracy tests:
 * Cohn's exact zero-thickness stripline within 2 %, Hammerstad-Jensen's microstrip within 3 %, convergence as the
 * grid is refined, and the ordering of odd/even modes with coupling. Grids are as coarse as each bound allows.
 */
import { describe, expect, it } from 'vitest'
import * as FS from '../../../src/tools/calc/fieldsolve.js'
import { microstripHJ } from '../../../src/tools/calc/pcb.js'
import { Cache } from '../../../src/core/store.js'

/** Hammerstad and Jensen's zero-thickness microstrip (IEEE MTT-S Digest 1980), written out independently here. */
function hammerstadJensen(w: number, h: number, er: number): number {
  const u = w / h
  const a = 1 + Math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + Math.log(1 + (u / 18.1) ** 3) / 18.7
  const b = 0.564 * ((er - 0.9) / (er + 3)) ** 0.053
  const ee = (er + 1) / 2 + ((er - 1) / 2) * (1 + 10 / u) ** (-a * b)
  const f = 6 + (2 * Math.PI - 6) * Math.exp(-((30.666 / u) ** 0.7528))
  const z1 = 60 * Math.log(f / u + Math.sqrt(1 + (2 / u) ** 2))
  return z1 / Math.sqrt(ee)
}

describe('field solver', () => {
  it('matches Cohn\'s exact stripline within 2 %', () => {
    const b = 0.4e-3, t = 0.5e-6, er = 4
    for (const w of [0.1e-3, 0.2e-3, 0.4e-3]) {
      const z = FS.solve(FS.stripline(w, t, b / 2 - t / 2, er, b / 2 + t / 2), { dx: 2.5e-6, cache: false }).z0
      expect(Math.abs(z / FS.striplineExact(w, b, er) - 1)).toBeLessThan(0.02)
    }
  })

  it('matches Hammerstad-Jensen microstrip within 3 %', () => {
    const h = 0.1e-3, er = 4.3
    for (const w of [0.1e-3, 0.2e-3, 0.4e-3]) {
      const l = FS.solve(FS.microstrip(w, 0.5e-6, h, er), { dx: 5e-6, cache: false })
      expect(Math.abs(l.z0 / hammerstadJensen(w, h, er) - 1)).toBeLessThan(0.03)
      expect(l.erEff).toBeGreaterThan(1)
      expect(l.erEff).toBeLessThan(er)
    }
  })

  it('converges as the grid is refined', () => {
    const sec = FS.microstrip(0.1e-3, 35e-6, 0.1e-3, 4.16, 0.12e-3, [15e-6, 3.8])
    const a = FS.solve(sec, { dx: 5e-6, cache: false })
    const b = FS.solve(sec, { dx: 2.5e-6, cache: false })
    expect(Math.abs(a.zdiff / b.zdiff - 1)).toBeLessThan(0.01)
    expect(Math.abs(a.zodd / b.zodd - 1)).toBeLessThan(0.01)
  })

  it('orders odd and even modes with coupling', () => {
    const w = 0.1e-3, t = 35e-6, h = 0.1e-3, er = 4.16, dx = 5e-6
    const single = FS.solve(FS.microstrip(w, t, h, er), { dx, cache: false }).z0
    const near = FS.solve(FS.microstrip(w, t, h, er, 0.1e-3), { dx, cache: false })
    const far = FS.solve(FS.microstrip(w, t, h, er, 0.5e-3), { dx, cache: false })
    expect(near.zodd).toBeLessThan(far.zodd)
    expect(near.zeven).toBeGreaterThan(far.zeven)
    expect(near.zodd).toBeLessThan(single)
    expect(near.zeven).toBeGreaterThan(single)
    expect(Math.abs(far.zodd / single - 1)).toBeLessThan(0.05)
    expect(near.zdiff).toBeCloseTo(2 * near.zodd, 9)
    expect(near.zcomm).toBeCloseTo(near.zeven / 2, 9)
  })

  it('agrees with the thickness-corrected closed form for a 1 oz trace', () => {
    const [zHJ] = microstripHJ(0.3e-3, 0.17e-3, 35e-6, 4.3)
    const z = FS.solve(FS.microstrip(0.3e-3, 35e-6, 0.17e-3, 4.3), { dx: 5e-6, cache: false }).z0
    expect(Math.abs(z / zHJ - 1)).toBeLessThan(0.03)
  })

  it('caches solved sections in the cache database', () => {
    const sec = FS.microstrip(0.21e-3, 18e-6, 0.11e-3, 4.0)
    const l = FS.solve(sec, { dx: 10e-6 })
    const c = new Cache()
    const n = Number((c.db.prepare("SELECT count(*) AS n FROM cache WHERE ns='fieldsolve'").get() as { n: number }).n)
    c.close()
    expect(n).toBeGreaterThan(0)
    expect(FS.solve(sec, { dx: 10e-6 }).z0).toBe(l.z0)
  })

  it('refuses a section it cannot solve', () => {
    expect(() => FS.solve({ traces: [], slabs: [], planeBelow: 0, planeAbove: null }, { cache: false })).toThrow(FS.SolverError)
    expect(() => FS.solve(FS.microstrip(1e-4, 1e-6, 1e-4, 4), { dx: 0, cache: false })).toThrow(/grid step/)
  })

  it('computes the elliptic-integral reference correctly', () => {
    expect(FS.ellipK(0)).toBeCloseTo(Math.PI / 2, 12)
    expect(FS.ellipK(Math.SQRT1_2)).toBeCloseTo(1.854074677301372, 10)   // K(1/sqrt 2), Abramowitz & Stegun 17.3
  })
})

/**
 * CISPR 32 (Ed. 2.0, 2015; EN 55032) radiated emission limits, in dBuV/m.
 *
 *   below 1 GHz (quasi-peak), Table A.2 (class A) and Table A.4 (class B), at 10 m and at 3 m:
 *       class A  30-230 MHz 40 (10 m) / 50 (3 m)   230-1000 MHz 47 / 57
 *       class B  30-230 MHz 30 (10 m) / 40 (3 m)   230-1000 MHz 37 / 47
 *   above 1 GHz at 3 m (average and peak), Table A.3 (class A) and Table A.5 (class B):
 *       class A  1-3 GHz 56 avg / 76 peak          3-6 GHz 60 avg / 80 peak
 *       class B  1-3 GHz 50 avg / 70 peak          3-6 GHz 54 avg / 74 peak
 *
 * At a boundary frequency the lower limit applies. The tables are transcribed here, not taken from a licensed copy
 * at run time: check them against the edition your test house uses (later editions and national deviations exist),
 * and remember the upper frequency of the above-1 GHz test depends on the highest internal frequency of the product.
 * Another distance is scaled from the nearest tabulated one by 20 log10(d_table / d) (1/r far field), an
 * approximation the standard itself does not make.
 */
export type CisprClass = 'A' | 'B'

interface Band { f0: number; f1: number; qp10?: number; qp3?: number; avg3?: number; peak3?: number }

const TABLE: Record<CisprClass, Band[]> = {
  A: [
    { f0: 30e6, f1: 230e6, qp10: 40, qp3: 50 },
    { f0: 230e6, f1: 1e9, qp10: 47, qp3: 57 },
    { f0: 1e9, f1: 3e9, avg3: 56, peak3: 76 },
    { f0: 3e9, f1: 6e9, avg3: 60, peak3: 80 },
  ],
  B: [
    { f0: 30e6, f1: 230e6, qp10: 30, qp3: 40 },
    { f0: 230e6, f1: 1e9, qp10: 37, qp3: 47 },
    { f0: 1e9, f1: 3e9, avg3: 50, peak3: 70 },
    { f0: 3e9, f1: 6e9, avg3: 54, peak3: 74 },
  ],
}

export interface Limit { db_uv_m: number; detector: 'quasi-peak' | 'average'; table_distance_m: number; distance_m: number; band: string }

/**
 * The limit at f for a measurement distance. Below 1 GHz the quasi-peak limit, above 1 GHz the average limit (the
 * stricter one for a steady harmonic, whose peak and average are the same). null outside 30 MHz-6 GHz.
 */
export function cisprLimit(cls: CisprClass, f: number, distance = 3): Limit | null {
  const bands = TABLE[cls]
  // the lower limit applies at a transition frequency: a band is (f0, f1], the first one [f0, f1]
  const b = bands.find((x, i) => (f > x.f0 || (i === 0 && f >= x.f0)) && f <= x.f1)
  if (!b) return null
  const band = `${b.f0 / 1e6}-${b.f1 / 1e6} MHz`
  if (b.avg3 !== undefined) {
    return { db_uv_m: b.avg3 + 20 * Math.log10(3 / distance), detector: 'average', table_distance_m: 3, distance_m: distance, band }
  }
  const use10 = Math.abs(Math.log(distance / 10)) < Math.abs(Math.log(distance / 3))
  const base = use10 ? (b.qp10 as number) : (b.qp3 as number)
  const d0 = use10 ? 10 : 3
  return { db_uv_m: base + 20 * Math.log10(d0 / distance), detector: 'quasi-peak', table_distance_m: d0, distance_m: distance, band }
}

export const CISPR_SOURCE = 'CISPR 32:2015 (Ed. 2.0) Annex A, Tables A.2-A.5, transcribed; verify against your edition'

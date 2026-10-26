/**
 * Noise: ngspice's small-signal .noise analysis (thermal, shot and flicker noise of every device model, linearised at
 * the operating point), integrated over a band and broken down by device.
 *
 * The analysis is run as `.noise V(out[,ref]) SRC dec N f1 f2 1`: the trailing 1 (pts_per_summary) makes ngspice
 * write each noise generator's output-referred density (onoise_<device>, and its parts such as _thermal and
 * _1overf) next to the totals. Densities are V/sqrt(Hz) (A/sqrt(Hz) for a current input source's input-referred
 * noise). Integration is done here, segment by segment in log-log (each segment a power law, which is exact for
 * 1/f and white segments and for a single-pole roll-off between points), and compared with ngspice's own
 * onoise_total / inoise_total over the analysis band as a cross-check.
 *
 * Input-referred noise is ngspice's inoise_spectrum: the output noise divided by the gain from SRC to the output at
 * each frequency. Peak-to-peak figures use 6.6 x rms (Gaussian noise exceeds it 0.1 % of the time); that is a
 * convention, not a bound.
 */
import { simulate, vectorOf, type Plot, type SimulateOptions, type SpiceRun } from '../../sim/spice.js'

/** Integral of a density squared (power spectral density) between fa and fb, power-law per segment. */
export function integratePsd(f: readonly number[], psd: readonly number[], fa?: number, fb?: number): number {
  if (f.length < 2) return 0
  const lo = Math.max(fa ?? (f[0] as number), f[0] as number)
  const hi = Math.min(fb ?? (f[f.length - 1] as number), f[f.length - 1] as number)
  if (!(hi > lo)) return 0
  let sum = 0
  for (let i = 1; i < f.length; i++) {
    let f0 = f[i - 1] as number
    let f1 = f[i] as number
    let y0 = psd[i - 1] as number
    let y1 = psd[i] as number
    if (f1 <= lo || f0 >= hi) continue
    const k = y0 > 0 && y1 > 0 && f0 > 0 ? Math.log(y1 / y0) / Math.log(f1 / f0) : null
    const at = (x: number): number => (k === null ? y0 + ((y1 - y0) * (x - f0)) / (f1 - f0) : y0 * (x / f0) ** k)
    if (f0 < lo) {
      const y = at(lo)
      f0 = lo
      y0 = y
    }
    if (f1 > hi) {
      const y = at(hi)
      f1 = hi
      y1 = y
    }
    if (k === null || !(y0 > 0) || !(y1 > 0)) sum += ((y0 + y1) / 2) * (f1 - f0)
    else if (Math.abs(k + 1) < 1e-9) sum += y0 * f0 * Math.log(f1 / f0)
    else sum += ((y0 * f0) / (k + 1)) * ((f1 / f0) ** (k + 1) - 1)
  }
  return sum
}

export interface Contributor { device: string; rms: number; share: number; parts: { name: string; rms: number }[] }

export interface NoiseResult {
  band: [number, number]
  output_rms: number
  output_pp_est: number
  input_rms: number | null
  ngspice_output_total: number | null
  ngspice_input_total: number | null
  spot: { f: number; output_density: number | null; input_density: number | null }[]
  contributors: Contributor[]
  /** frequency axis and densities, for plotting/decimation */
  f: number[]
  onoise: number[]
  inoise: number[] | null
}

/** The device names that have their own onoise_ vector, and the parts (sub-terms such as _thermal) of each: a name
 * that extends another contributor's name with "_suffix" is a part of it. */
export function noiseDevices(names: readonly string[]): Map<string, string[]> {
  const cands = names.filter((n) => n.startsWith('onoise_') && n !== 'onoise_spectrum').map((n) => n.slice(7))
  const parentOf = (c: string): string | undefined => cands.filter((p) => p !== c && c.startsWith(`${p}_`)).sort((a, b) => b.length - a.length)[0]
  const out = new Map<string, string[]>()
  for (const c of cands) if (parentOf(c) === undefined) out.set(c, [])
  for (const c of cands) {
    const p = parentOf(c)
    if (p === undefined) continue
    let root = p
    while (parentOf(root) !== undefined) root = parentOf(root) as string
    out.get(root)?.push(c)
  }
  return out
}

export function analyseNoise(spec: Plot, total: Plot | undefined, band: [number, number], spot: readonly number[], top: number): NoiseResult {
  const f = spec.vectors.get('frequency') ?? []
  const on = spec.vectors.get('onoise_spectrum') ?? []
  const inn = spec.vectors.get('inoise_spectrum') ?? null
  const sq = (v: readonly number[]): number[] => v.map((x) => x * x)
  const outPow = integratePsd(f, sq(on), band[0], band[1])
  const inPow = inn ? integratePsd(f, sq(inn), band[0], band[1]) : null
  const devices = noiseDevices(spec.names)
  const contributors: Contributor[] = []
  for (const [dev, parts] of devices) {
    const v = spec.vectors.get(`onoise_${dev}`)
    if (!v) continue
    const p = integratePsd(f, sq(v), band[0], band[1])
    contributors.push({
      device: dev, rms: Math.sqrt(p), share: outPow > 0 ? p / outPow : 0,
      parts: parts.map((name) => ({ name: name.slice(dev.length + 1), rms: Math.sqrt(integratePsd(f, sq(spec.vectors.get(`onoise_${name}`) ?? []), band[0], band[1])) }))
        .filter((x) => x.rms > 0).sort((a, b) => b.rms - a.rms),
    })
  }
  contributors.sort((a, b) => b.rms - a.rms)
  const interp = (vec: readonly number[] | null, at: number): number | null => {
    if (!vec) return null
    for (let i = 1; i < f.length; i++) {
      const fa = f[i - 1] as number
      const fb = f[i] as number
      if (at >= fa && at <= fb) {
        const ya = vec[i - 1] as number
        const yb = vec[i] as number
        if (ya > 0 && yb > 0) return ya * (yb / ya) ** (Math.log(at / fa) / Math.log(fb / fa))
        return ya + ((yb - ya) * (at - fa)) / (fb - fa)
      }
    }
    return null
  }
  const tv = (name: string): number | null => (total ? (vectorOf(total, name)?.[0] ?? null) : null)
  return {
    band, output_rms: Math.sqrt(outPow), output_pp_est: 6.6 * Math.sqrt(outPow), input_rms: inPow === null ? null : Math.sqrt(inPow),
    ngspice_output_total: tv('onoise_total'), ngspice_input_total: tv('inoise_total'),
    spot: spot.map((s) => ({ f: s, output_density: interp(on, s), input_density: interp(inn, s) })),
    contributors: contributors.slice(0, top), f: [...f], onoise: [...on], inoise: inn ? [...inn] : null,
  }
}

export function noiseAnalysis(output: string, source: string, band: [number, number], perDecade: number): string {
  const out = /^v\(/i.test(output.trim()) ? output.trim() : `v(${output.trim()})`
  return `.noise ${out} ${source} dec ${perDecade} ${band[0]} ${band[1]} 1`
}

export async function runNoise(base: SimulateOptions, output: string, source: string, band: [number, number], perDecade: number): Promise<{ run: SpiceRun; spec: Plot; total: Plot | undefined }> {
  const run = await simulate({ ...base, analyses: [noiseAnalysis(output, source, band, perDecade)] })
  const spec = run.plots.find((p) => p.kind === 'noise')
  if (!spec) throw new Error('ngspice wrote no noise spectrum')
  return { run, spec, total: run.plots.find((p) => p.kind === 'noise_total') }
}

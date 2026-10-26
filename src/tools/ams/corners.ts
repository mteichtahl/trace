/**
 * PVT corners: the product of model corners (process), supply values (voltage) and temperatures, each a full ngspice
 * run measured with the sim.* measurement code and judged against specs.
 *
 *   process   a model corner is a `.lib` section (tt / ff / ss / fs / sf, or whatever the library names) and/or
 *             `.param` overrides. With `lib.section` alone, every `.lib FILE SECTION` line in the netlist whose FILE
 *             defines that section is switched to it; when the netlist has none, the project's model libraries
 *             (config electronics.models) that define the section are added with `.lib FILE SECTION`.
 *   voltage   each supply is a `.param` (the netlist uses `{vdd}` in its source): a list of values, or nominal ± a
 *             fractional tolerance (three points).
 *   temp      `.options temp=T` (degrees C) per run, so every model's temperature equations apply.
 *
 * The worst corner of a measure is the one with the least margin to its spec (src/tools/ams/spec.ts: judge).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { load } from '../../core/config.js'
import type { MeasureResult, MeasureSpec } from '../../sim/measure.js'
import { defaultConcurrency, mapLimit } from '../../sim/proc.js'
import { simulate, SpiceError, type SimulateOptions, type SpiceRun } from '../../sim/spice.js'
import { measureRun } from '../../sim/sweep.js'
import { addOptions } from './common.js'
import { judge, type SpecLimit, type Verdict } from './spec.js'

export interface ModelCorner {
  name: string
  lib?: { file?: string | undefined; section: string } | undefined
  params?: Record<string, number | string> | undefined
}

export interface Supply {
  param: string
  values?: (number | string)[] | undefined
  nominal?: number | undefined
  /** fractional, 0.05 = ±5 % */
  tol?: number | undefined
}

/** The section names a SPICE library file defines (`.lib NAME` … `.endl`). */
export function libSections(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/^\s*\.lib\s+(\S+)\s*$/gim)) {
    const name = (m[1] ?? '').replace(/^"|"$/g, '')
    if (name && !out.includes(name.toLowerCase())) out.push(name.toLowerCase())
  }
  return out
}

const LIB_LINE = /^(\s*\.lib\s+)("?)([^\s"]+)\2(\s+)(\S+)(.*)$/i

/** The project's model library files that have .lib sections (config electronics.models, files or folders). */
export function projectLibraries(): string[] {
  const cfg = load()
  const root = cfg.root ?? process.cwd()
  const out: string[] = []
  for (const m of cfg.electronics.models) {
    const p = isAbsolute(m) ? m : join(root, m)
    if (!existsSync(p)) continue
    const files = statSync(p).isDirectory() ? readdirSync(p).sort().map((f) => join(p, f)).filter((f) => statSync(f).isFile()) : [p]
    for (const f of files) {
      try {
        if (libSections(readFileSync(f, 'utf8')).length) out.push(f)
      } catch {
        /* unreadable: skipped */
      }
    }
  }
  return out
}

function sectionsOf(file: string): string[] {
  try {
    return libSections(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

/**
 * The netlist switched to a model corner's library section. Returns the netlist and what was done, for the report.
 * Throws SpiceError when the section is nowhere to be found.
 */
export function applyLibCorner(netlist: string, baseDir: string, lib: { file?: string | undefined; section: string }): { netlist: string; done: string } {
  const want = lib.section.toLowerCase()
  const fileAbs = lib.file !== undefined ? resolve(baseDir, lib.file) : undefined
  if (fileAbs !== undefined && !existsSync(fileAbs)) throw new SpiceError(`library ${fileAbs} does not exist`)
  if (fileAbs !== undefined && !sectionsOf(fileAbs).includes(want)) throw new SpiceError(`library ${fileAbs} has no section ${lib.section} (it has: ${sectionsOf(fileAbs).join(', ') || 'none'})`)
  let switched = 0
  const lines = netlist.split('\n').map((ln) => {
    const m = LIB_LINE.exec(ln)
    if (!m) return ln
    const f = resolve(baseDir, m[3] as string)
    const match = fileAbs !== undefined ? f === fileAbs : sectionsOf(f).includes(want)
    if (!match) return ln
    switched++
    return `${m[1]}${m[2]}${f}${m[2]}${m[4]}${lib.section}${m[6]}`
  })
  if (switched) return { netlist: lines.join('\n'), done: `switched ${switched} .lib line(s) to section ${lib.section}` }
  const files = fileAbs !== undefined ? [fileAbs] : projectLibraries().filter((f) => sectionsOf(f).includes(want))
  if (!files.length) throw new SpiceError(`no .lib line in the netlist and no project model library (electronics.models) defines section ${lib.section}`)
  return { netlist: `${netlist.trimEnd()}\n${files.map((f) => `.lib ${f} ${lib.section}`).join('\n')}\n`, done: `added .lib ${files.join(', ')} ${lib.section}` }
}

export function supplyValues(s: Supply): (number | string)[] {
  if (s.values?.length) return s.values
  if (s.nominal === undefined) throw new SpiceError(`supply ${s.param}: give values, or nominal (and tol)`)
  if (!s.tol) return [s.nominal]
  const v = (x: number): number => Number(x.toPrecision(10))
  return [v(s.nominal * (1 - s.tol)), s.nominal, v(s.nominal * (1 + s.tol))]
}

export interface CornerPoint {
  index: number
  label: string
  model: string
  supplies: Record<string, number | string>
  temp: number
  measurements: MeasureResult[]
  verdicts: Record<string, Verdict>
  pass: boolean
  error?: string
  libNote?: string
}

export interface CornersPlan {
  points: { label: string; model: string; supplies: Record<string, number | string>; temp: number; opts: SimulateOptions; libNote?: string }[]
}

export const MAX_CORNERS = 2000

export function planCorners(base: SimulateOptions, models: readonly ModelCorner[], supplies: readonly Supply[], temps: readonly number[]): CornersPlan {
  const ms = models.length ? models : [{ name: 'nom' }]
  const ts = temps.length ? temps : [27]
  let combos: Record<string, number | string>[] = [{}]
  for (const s of supplies) {
    const vals = supplyValues(s)
    if (!new RegExp(`\\b${s.param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(base.netlist)) {
      throw new SpiceError(`supply parameter ${s.param} does not appear in the netlist (use {${s.param}} in its source)`)
    }
    combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [s.param]: v })))
  }
  const total = ms.length * combos.length * ts.length
  if (total > MAX_CORNERS) throw new SpiceError(`${total} corners: more than ${MAX_CORNERS}`)
  const points: CornersPlan['points'] = []
  for (const m of ms) {
    let netlist = base.netlist
    let libNote: string | undefined
    if (m.lib) {
      const r = applyLibCorner(netlist, base.baseDir ?? process.cwd(), m.lib)
      netlist = r.netlist
      libNote = r.done
    }
    for (const c of combos) {
      for (const t of ts) {
        const params = { ...(base.params ?? {}), ...(m.params ?? {}), ...c }
        const label = [m.name, ...Object.entries(c).map(([k, v]) => `${k}=${v}`), `${t}C`].join(' ')
        points.push({
          label, model: m.name, supplies: c, temp: t, ...(libNote ? { libNote } : {}),
          opts: { ...base, netlist, params, options: addOptions(base.options, `temp=${t}`) },
        })
      }
    }
  }
  return { points }
}

export async function runCorners(plan: CornersPlan, specs: readonly MeasureSpec[], limits: ReadonlyMap<string, SpecLimit>, concurrency?: number, onRun?: (p: CornerPoint, r: SpiceRun | null) => void): Promise<CornerPoint[]> {
  return mapLimit(plan.points, concurrency ?? defaultConcurrency(), async (pt, index) => {
    const base = { index, label: pt.label, model: pt.model, supplies: pt.supplies, temp: pt.temp, ...(pt.libNote ? { libNote: pt.libNote } : {}) }
    try {
      const run = await simulate(pt.opts)
      const measurements = measureRun(run, specs)
      const verdicts: Record<string, Verdict> = {}
      for (const [name, lim] of limits) verdicts[name] = judge(measurements.find((m) => m.name === name)?.value ?? null, lim)
      const p: CornerPoint = { ...base, measurements, verdicts, pass: Object.values(verdicts).every((v) => v.pass) }
      onRun?.(p, run)
      return p
    } catch (e) {
      if (!(e instanceof SpiceError)) throw e
      const verdicts: Record<string, Verdict> = {}
      for (const name of limits.keys()) verdicts[name] = { pass: false, margin: null, limit: null }
      const p: CornerPoint = { ...base, measurements: [], verdicts, pass: false, error: e.message }
      onRun?.(p, null)
      return p
    }
  })
}

export interface Worst { measure: string; corner: string | null; value: number | null; margin: number | null; limit: 'min' | 'max' | null; pass: boolean; failing: number }

/** Per spec: the corner with the least margin (a failed simulation counts as the worst). */
export function worstCorners(points: readonly CornerPoint[], limits: ReadonlyMap<string, SpecLimit>): Worst[] {
  return [...limits.keys()].map((name) => {
    let worst = null as CornerPoint | null
    let wm = Infinity
    let failing = 0
    for (const p of points) {
      const v = p.verdicts[name]
      if (!v) continue
      if (!v.pass) failing++
      const m = v.margin === null ? -Infinity : v.margin
      if (m < wm) {
        wm = m
        worst = p
      }
    }
    const v = worst?.verdicts[name]
    return {
      measure: name, corner: worst?.label ?? null, value: worst?.measurements.find((m) => m.name === name)?.value ?? null,
      margin: v?.margin ?? null, limit: v?.limit ?? null, pass: failing === 0, failing,
    }
  })
}

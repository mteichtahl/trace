/**
 * What the ams.* tools share: reading a circuit (netlist text or file), the circuit inputs every tool takes, running
 * many ngspice jobs through the bounded queue, and small numeric helpers (interpolation on a log-frequency axis,
 * phase unwrapping, crossings) used by the op-amp and noise benches.
 *
 * Every simulation here is a plain ngspice batch run through src/tools/sim/spice.ts (simulate), so the netlist wrapping,
 * model includes (config electronics.models), raw-file parsing and error reporting are the same as sim.spice's.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'

import { ToolError } from '../../core/registry.js'
import { round } from '../sim/measure.js'
import type { Recorder } from '../sim/record.js'
import { SpiceError, type SimulateOptions, type SpiceRun } from '../sim/spice.js'

export const ParamValue = z.union([z.number(), z.string()])

/** The circuit inputs, as sim.spice takes them. */
export const circuitInput = {
  netlist: z.string().optional().describe('the circuit as SPICE text (first line is the title; no .control, no .end needed)'),
  path: z.string().optional().describe('or a netlist file on disk (its .include/.lib paths resolve against its folder)'),
  params: z.record(z.string(), ParamValue).optional().describe('.param overrides applied to every run, e.g. {"rload": "10k"}'),
  models: z.array(z.string()).optional().describe('extra model files or folders to .include (the config electronics.models are always included)'),
  options: z.string().optional().describe('.options line contents for every run, e.g. "reltol=1e-4"'),
  timeout_s: z.number().positive().max(3600).optional().describe('per ngspice run (default 300)'),
}

export interface CircuitArgs {
  netlist?: string | undefined
  path?: string | undefined
  params?: Record<string, number | string> | undefined
  models?: string[] | undefined
  options?: string | undefined
  timeout_s?: number | undefined
}

export interface Circuit {
  text: string
  baseDir: string
  subject: string
}

export function readCircuit(a: { netlist?: string | undefined; path?: string | undefined }, what = 'netlist'): Circuit {
  if ((a.netlist === undefined) === (a.path === undefined)) throw new ToolError(`give exactly one of ${what} or path`)
  if (a.path !== undefined) {
    const p = resolve(a.path)
    let text: string
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      throw new ToolError(`cannot read ${p}`)
    }
    return { text, baseDir: dirname(p), subject: a.path }
  }
  const text = a.netlist as string
  return { text, baseDir: process.cwd(), subject: (text.split('\n')[0] ?? '').trim().slice(0, 80) || 'netlist' }
}

export function baseOptions(c: Circuit, a: CircuitArgs, analyses?: readonly string[]): SimulateOptions {
  return {
    netlist: c.text, analyses, params: a.params, models: a.models, options: a.options, baseDir: c.baseDir,
    timeoutMs: a.timeout_s !== undefined ? a.timeout_s * 1000 : undefined,
  }
}

/** Append `.options` contents to an options string. */
export function addOptions(base: string | undefined, more: string): string {
  return base ? `${base} ${more}` : more
}

/** A ToolError from a failed simulation, with the netlist and log stored on the run. */
export function spiceFail(rec: Recorder, e: unknown, label = ''): never {
  if (e instanceof SpiceError) {
    if (e.netlist) rec.artifact(`${label}netlist.cir`, e.netlist)
    if (e.log) rec.artifact(`${label}ngspice.log`, e.log)
    rec.fail(e)
    throw new ToolError(`${label ? `${label.replace(/[-.]$/, '')}: ` : ''}${e.message} (run ${rec.id}: the netlist and ngspice log are stored)`)
  }
  rec.fail(e)
  throw e
}

export function storeRun(rec: Recorder, r: SpiceRun, label: string): void {
  rec.artifact(`${label}.cir`, r.netlist)
  rec.artifact(`${label}.log`, r.log)
}

export const r = (v: number | null | undefined, digits = 6): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : round(v, digits))

// ------------------------------------------------------------------------------------------- numeric helpers

/** Degrees, unwrapped so that consecutive points never jump by more than 180. */
export function unwrapDeg(ph: readonly number[]): number[] {
  const out: number[] = []
  let off = 0
  for (let i = 0; i < ph.length; i++) {
    const p = ph[i] as number
    if (i > 0) {
      const prev = (ph[i - 1] as number) + off
      while (p + off - prev > 180) off -= 360
      while (p + off - prev < -180) off += 360
    }
    out.push(p + off)
  }
  return out
}

/** The first x where y crosses `level` going in `dir`, by linear interpolation in log10(x) (x > 0). */
export function crossingLogX(x: readonly number[], y: readonly number[], level: number, dir: 'falling' | 'rising' | 'either' = 'either'): number | null {
  for (let i = 1; i < x.length; i++) {
    const y0 = (y[i - 1] as number) - level
    const y1 = (y[i] as number) - level
    const falls = y0 > 0 && y1 <= 0
    const rises = y0 < 0 && y1 >= 0
    if ((dir === 'falling' && !falls) || (dir === 'rising' && !rises) || (dir === 'either' && !falls && !rises)) continue
    const lx0 = Math.log10(x[i - 1] as number)
    const lx1 = Math.log10(x[i] as number)
    const t = y0 === y1 ? 0 : y0 / (y0 - y1)
    return 10 ** (lx0 + t * (lx1 - lx0))
  }
  return null
}

/** y at x, interpolated linearly in log10(x); null outside the data. */
export function atLogX(x: readonly number[], y: readonly number[], at: number): number | null {
  if (!x.length || at < (x[0] as number) || at > (x[x.length - 1] as number)) return null
  for (let i = 1; i < x.length; i++) {
    const xa = x[i - 1] as number
    const xb = x[i] as number
    if (at <= xb) {
      if (xb === xa) return y[i] as number
      const t = (Math.log10(at) - Math.log10(xa)) / (Math.log10(xb) - Math.log10(xa))
      return (y[i - 1] as number) + t * ((y[i] as number) - (y[i - 1] as number))
    }
  }
  return y[y.length - 1] as number
}

/** y at x, linear interpolation; null outside. */
export function atX(x: readonly number[], y: readonly number[], at: number): number | null {
  if (!x.length || at < (x[0] as number) || at > (x[x.length - 1] as number)) return null
  for (let i = 1; i < x.length; i++) {
    const xa = x[i - 1] as number
    const xb = x[i] as number
    if (at <= xb) return xb === xa ? (y[i] as number) : (y[i - 1] as number) + ((at - xa) / (xb - xa)) * ((y[i] as number) - (y[i - 1] as number))
  }
  return y[y.length - 1] as number
}

/** The value of a number given as a SPICE string ("10k") or a number. */
export function num(v: number | string, parse: (s: string) => number): number {
  return typeof v === 'number' ? v : parse(v)
}

/** Complex numbers as [re, im], for the loop-gain algebra. */
export type Cx = readonly [number, number]
export const cx = {
  add: (a: Cx, b: Cx): Cx => [a[0] + b[0], a[1] + b[1]],
  sub: (a: Cx, b: Cx): Cx => [a[0] - b[0], a[1] - b[1]],
  mul: (a: Cx, b: Cx): Cx => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]],
  div: (a: Cx, b: Cx): Cx => {
    const d = b[0] * b[0] + b[1] * b[1]
    return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]
  },
  neg: (a: Cx): Cx => [-a[0], -a[1]],
  abs: (a: Cx): number => Math.hypot(a[0], a[1]),
  deg: (a: Cx): number => (Math.atan2(a[1], a[0]) * 180) / Math.PI,
  real: (v: number): Cx => [v, 0],
}

export function db(v: number): number {
  return v > 0 ? 20 * Math.log10(v) : -400
}

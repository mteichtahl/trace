/**
 * The simulation tools: analog (ngspice) and digital (Icarus Verilog) simulation, measurements, sweeps, Monte Carlo,
 * and the waveform readers, protocol decoders and timing checks that work the same on a simulated VCD and on a logic
 * analyser's capture.
 *
 * Every tool that runs a simulator records the run in the project database (netlist, log, raw output, VCD, testbench
 * output as artifacts; measurements as rows) and returns its `run_id`. The wave tools read a capture from a file
 * path, or from an earlier run's artifact (`run_id` + `artifact`). Responses are compact: measurement results come
 * first, vectors are returned only when asked for and decimated to at most `max_points` (peaks kept), and long lists
 * are capped with their full counts.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'

import { defineTool, ToolError, type AnyTool } from '../../core/registry.js'
import { exportSpice } from './kicad_spice.js'
import { LogicError, simulateLogic } from './logic.js'
import { decimate, evaluate, MeasureSpecSchema, round, type MeasureResult } from './measure.js'
import { artifactNames, defaultCapture, Recorder, readArtifact } from './record.js'
import { opTable, parseRaw, simulate, SpiceError, type Plot, type SimulateOptions, type SpiceRun } from './spice.js'
import { corners, measureRun, montecarlo, stats, sweep, type PointResult, type Stat } from './sweep.js'
import * as wave from './wave.js'

// ------------------------------------------------------------------------------------------- shared inputs

const ParamValue = z.union([z.number(), z.string()])

const circuit = {
  netlist: z.string().optional().describe('the circuit as SPICE text (first line is the title; no .control, no .end needed)'),
  path: z.string().optional().describe('or a netlist file on disk (its .include paths resolve against its folder)'),
  analyses: z.array(z.string()).optional().describe('analysis lines, e.g. [".op", ".ac dec 50 1 1meg", ".tran 1u 5m"]; default: those in the netlist'),
  save: z.array(z.string()).optional().describe('vectors to keep, e.g. ["v(out)", "i(v1)"]; default all'),
  params: z.record(z.string(), ParamValue).optional().describe('.param overrides, e.g. {"rload": "10k"}'),
  models: z.array(z.string()).optional().describe('extra model files or folders to .include (the config electronics.models are always included)'),
  options: z.string().optional().describe('.options line contents, e.g. "reltol=1e-4 temp=85"'),
  timeout_s: z.number().positive().max(3600).optional().describe('per ngspice run (default 300)'),
}

const measurements = z.array(MeasureSpecSchema).optional()
  .describe('measurements, e.g. [{"name":"vpk","kind":"peak","vector":"v(out)","from":1e-3}, {"kind":"bandwidth","vector":"v(out)"}]; kinds: peak trough pp average rms integral final value_at cross rise_time fall_time overshoot settling time_above time_below frequency period duty bandwidth phase_margin gain_margin')

type CircuitArgs = {
  netlist?: string | undefined
  path?: string | undefined
  analyses?: string[] | undefined
  save?: string[] | undefined
  params?: Record<string, number | string> | undefined
  models?: string[] | undefined
  options?: string | undefined
  timeout_s?: number | undefined
}

function baseOptions(a: CircuitArgs): { opts: SimulateOptions; subject: string } {
  if ((a.netlist === undefined) === (a.path === undefined)) throw new ToolError('give exactly one of netlist or path')
  let text: string
  let baseDir = process.cwd()
  let subject: string
  if (a.path !== undefined) {
    const p = resolve(a.path)
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      throw new ToolError(`cannot read ${p}`)
    }
    baseDir = dirname(p)
    subject = a.path
  } else {
    text = a.netlist as string
    subject = (text.split('\n')[0] ?? '').trim().slice(0, 80) || 'netlist'
  }
  return {
    subject,
    opts: {
      netlist: text, analyses: a.analyses, save: a.save, params: a.params, models: a.models, options: a.options, baseDir,
      timeoutMs: a.timeout_s !== undefined ? a.timeout_s * 1000 : undefined,
    },
  }
}

function measurementSummary(ms: readonly MeasureResult[]): string {
  return ms.slice(0, 4).map((m) => (m.value === null ? `${m.name}: —` : `${m.name}=${round(m.value, 4)}${m.unit ? ` ${m.unit}` : ''}`)).join(', ')
}

function compactMeasurements(ms: readonly MeasureResult[]): Record<string, unknown>[] {
  return ms.map((m) => {
    const o: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(m)) o[k] = typeof v === 'number' ? round(v) : v
    return o
  })
}

function plotSummary(p: Plot, vectors: readonly string[] | 'all' | undefined, maxPoints: number): Record<string, unknown> {
  const out: Record<string, unknown> = { analysis: p.analysis, points: p.points, scale: p.scale }
  const names = p.names.filter((n) => n !== p.scale)
  if (p.kind === 'op' || p.kind === 'noise_total') {
    const t = opTable(p)
    return { ...out, voltages: roundRec(t.voltages), currents: roundRec(t.currents), ...(t.truncated ? { truncated: true } : {}) }
  }
  const x = p.scale ? (p.vectors.get(p.scale) ?? []) : []
  out.range = [round(x[0] ?? NaN), round(x[x.length - 1] ?? NaN)]
  out.vectors = names.length > 60 ? [...names.slice(0, 60), `… ${names.length} in all`] : names
  if (vectors) {
    const want = vectors === 'all' ? names.slice(0, 8) : vectors.map((v) => v.toLowerCase())
    const series: number[][] = []
    const got: string[] = []
    for (const w of want) {
      const v = p.vectors.get(w) ?? p.vectors.get(`v(${w})`)
      if (!v) continue
      got.push(w)
      series.push(v)
      if (p.complex && !w.includes('#')) {
        const ph = p.vectors.get(`${p.vectors.has(w) ? w : `v(${w})`}#phase`)
        const db = p.vectors.get(`${p.vectors.has(w) ? w : `v(${w})`}#db`)
        if (db) { got.push(`${w}#db`); series.push(db) }
        if (ph) { got.push(`${w}#phase`); series.push(ph) }
      }
    }
    if (got.length) {
      const [dx, ds] = decimate(x, series, maxPoints)
      out.data = { [p.scale ?? 'x']: dx.map((v) => round(v)), ...Object.fromEntries(got.map((g, i) => [g, (ds[i] ?? []).map((v) => round(v))])) }
      if (dx.length < x.length) out.decimated = `${x.length} → ${dx.length} points (local min/max kept)`
    }
  }
  return out
}

function roundRec(r: Record<string, number>): Record<string, number | null> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, round(v)]))
}

function storeRun(rec: Recorder, r: SpiceRun): void {
  rec.artifact('netlist.cir', r.netlist)
  rec.artifact('ngspice.log', r.log)
  for (const [a, text] of r.raw) rec.artifact(`${a}.raw`, text)
}

function spiceFail(rec: Recorder, e: unknown): never {
  if (e instanceof SpiceError) {
    if (e.netlist) rec.artifact('netlist.cir', e.netlist)
    if (e.log) rec.artifact('ngspice.log', e.log)
    rec.fail(e)
    throw new ToolError(`${e.message} (run ${rec.id}: netlist.cir and ngspice.log are stored)`)
  }
  rec.fail(e)
  throw e
}

// ------------------------------------------------------------------------------------------- sim.spice

export const spiceTool = defineTool({
  name: 'sim.spice',
  description: 'Run ngspice (batch) on a netlist with .op/.dc/.ac/.tran/.noise analyses; returns measurements first, the operating point, and vectors on request (decimated). The run (netlist, log, raw data) is recorded; returns run_id.',
  input: z.object({
    ...circuit,
    measurements,
    vectors: z.union([z.array(z.string()), z.literal('all')]).optional().describe('vectors to return as data (AC adds #db and #phase); omit for none'),
    max_points: z.number().int().min(10).max(5000).optional().describe('cap on returned points per vector (default 500)'),
  }),
  run: async (a) => {
    const { opts, subject } = baseOptions(a)
    const rec = new Recorder('sim.spice', subject, a)
    let r: SpiceRun
    try {
      r = await simulate(opts)
    } catch (e) {
      spiceFail(rec, e)
    }
    storeRun(rec, r)
    const ms = measureRun(r, a.measurements ?? [])
    rec.measurements(ms)
    const failed = ms.filter((m) => m.value === null).length
    const result = {
      run_id: rec.id,
      measurements: compactMeasurements(ms),
      analyses: r.plots.map((p) => plotSummary(p, a.vectors, a.max_points ?? 500)),
      ...(r.warnings.length ? { warnings: r.warnings } : {}),
      ms: r.ms,
    }
    rec.finish(failed ? 'fail' : 'pass', `${r.plots.map((p) => p.analysis).join('+')}${ms.length ? `: ${measurementSummary(ms)}` : ''}`, { measurements: result.measurements })
    return result
  },
})

// ------------------------------------------------------------------------------------------- sim.measure

export const measureTool = defineTool({
  name: 'sim.measure',
  description: 'Measurements on vectors: on an earlier sim.spice run (run_id; its stored raw data is re-read) or on data given inline (x + vectors). Same measurement kinds as sim.spice.',
  input: z.object({
    measurements: z.array(MeasureSpecSchema).min(1),
    run_id: z.string().optional().describe('a sim.spice / sim.kicad_spice run'),
    x: z.array(z.number()).optional().describe('inline data: the x axis'),
    xname: z.enum(['time', 'frequency', 'sweep']).optional().describe('what x is (default time)'),
    vectors: z.record(z.string(), z.array(z.number())).optional().describe('inline data: {name: values}; for AC give "<name>#db" and "<name>#phase"'),
  }),
  run: (a) => {
    if ((a.run_id === undefined) === (a.x === undefined)) throw new ToolError('give run_id, or x with vectors')
    if (a.run_id !== undefined) {
      const plots = storedPlots(a.run_id)
      const ms = measureRun({ plots }, a.measurements)
      return { run_id: a.run_id, measurements: compactMeasurements(ms) }
    }
    const x = a.x as number[]
    const vecs = new Map(Object.entries(a.vectors ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    for (const [k, v] of vecs) if (v.length !== x.length) throw new ToolError(`${k} has ${v.length} values, x has ${x.length}`)
    const ms = evaluate(a.measurements, x, (n) => vecs.get(n.toLowerCase()) ?? vecs.get(`v(${n.toLowerCase()})`), a.xname ?? 'time')
    return { measurements: compactMeasurements(ms) }
  },
})

/** The plots of an earlier run, re-read from its stored raw files. */
function storedPlots(runId: string): Plot[] {
  const raws = artifactNames(runId).filter((n) => n.endsWith('.raw'))
  if (!raws.length) throw new ToolError(`run ${runId} has no simulation data (.raw artifacts)`)
  const dec = new TextDecoder()
  return raws.map((n) => {
    const parsed = parseRaw(dec.decode(readArtifact(runId, n)))[0]
    if (!parsed) throw new ToolError(`run ${runId}: ${n} is empty`)
    return { ...parsed, analysis: n.slice(0, -4) }
  })
}

// ------------------------------------------------------------------------------------------- sweeps

function pointsTable(points: readonly PointResult[], limit: number): Record<string, unknown>[] {
  return points.slice(0, limit).map((p) => ({
    label: p.label,
    ...(p.error ? { error: p.error } : {}),
    ...Object.fromEntries(p.measurements.map((m) => [m.name, m.value === null ? null : round(m.value)])),
  }))
}

function pointsCsv(points: readonly PointResult[], paramNames: readonly string[]): string {
  const names: string[] = []
  for (const p of points) for (const m of p.measurements) if (!names.includes(m.name)) names.push(m.name)
  const esc = (s: string): string => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s)
  const rows = [['index', 'label', ...paramNames, ...names, 'error'].map(esc).join(',')]
  for (const p of points) {
    rows.push([String(p.index), p.label, ...paramNames.map((k) => String(p.params[k] ?? '')), ...names.map((n) => {
      const v = p.measurements.find((m) => m.name === n)?.value
      return v === null || v === undefined ? '' : String(v)
    }), p.error ?? ''].map(esc).join(','))
  }
  return `${rows.join('\n')}\n`
}

function compactStat(s: Stat): Record<string, unknown> {
  return { name: s.name, unit: s.unit, n: s.n, ...(s.failed ? { failed: s.failed } : {}), nominal: round(s.nominal ?? NaN), min: round(s.min ?? NaN), mean: round(s.mean ?? NaN), max: round(s.max ?? NaN), sigma: round(s.sigma ?? NaN), min_run: s.min_run, max_run: s.max_run }
}

export const sweepTool = defineTool({
  name: 'sim.sweep',
  description: 'Parameter sweep or corners: re-run a netlist for each .param value (one axis, or the product of several) or each named corner, measuring every point. Runs ngspice processes in parallel (bounded). Recorded; returns run_id.',
  input: z.object({
    ...circuit,
    measurements: z.array(MeasureSpecSchema).min(1),
    axes: z.array(z.object({
      param: z.string(),
      values: z.array(ParamValue).optional(),
      from: z.number().optional(),
      to: z.number().optional(),
      points: z.number().int().min(1).max(2000).optional(),
      log: z.boolean().optional(),
    }).strict()).optional().describe('sweep axes, e.g. [{"param":"rload","values":["1k","10k"]}] or [{"param":"cf","from":1e-9,"to":1e-6,"points":7,"log":true}]'),
    corners: z.record(z.string(), z.record(z.string(), ParamValue)).optional().describe('named parameter sets, e.g. {"cold":{"temp":-40,"vin":11},"hot":{"temp":85,"vin":13}} (temp sets the simulation temperature)'),
    concurrency: z.number().int().min(1).max(64).optional(),
    max_rows: z.number().int().min(1).max(2000).optional().describe('rows returned (default 50; all are stored as points.csv)'),
  }),
  run: async (a) => {
    if (!a.axes?.length === !a.corners) throw new ToolError('give axes or corners (one of them)')
    const { opts, subject } = baseOptions(a)
    const rec = new Recorder('sim.sweep', subject, a)
    let points: PointResult[]
    let first: SpiceRun | null = null
    const failLogs: string[] = []
    const onRun = (p: PointResult, r: SpiceRun | null): void => {
      if (r && !first) first = r
      if (p.error && failLogs.length < 5) failLogs.push(`${p.label}: ${p.error}`)
    }
    try {
      points = a.corners ? await corners(opts, a.corners, { specs: a.measurements, concurrency: a.concurrency, onRun })
        : await sweep(opts, a.axes ?? [], { specs: a.measurements, concurrency: a.concurrency, onRun })
    } catch (e) {
      spiceFail(rec, e)
    }
    const r0: SpiceRun | null = first
    if (r0) rec.artifact('netlist.cir', (r0 as SpiceRun).netlist)
    const paramNames = a.corners ? [...new Set(Object.values(a.corners).flatMap((c) => Object.keys(c)))] : (a.axes ?? []).map((x) => x.param)
    rec.artifact('points.csv', pointsCsv(points, paramNames), 'text/csv')
    const st = stats(points)
    for (const s of st) for (const k of ['min', 'mean', 'max'] as const) rec.measure(`${s.name}.${k}`, s[k], s.unit)
    const errors = points.filter((p) => p.error).length
    const maxRows = a.max_rows ?? 50
    const result = {
      run_id: rec.id,
      summary: st.map(compactStat),
      points: points.length,
      ...(errors ? { failed_points: errors, first_failures: failLogs } : {}),
      rows: pointsTable(points, maxRows),
      ...(points.length > maxRows ? { truncated: `${points.length} points, ${maxRows} shown (all in points.csv)` } : {}),
    }
    rec.finish(errors ? 'fail' : 'pass', `${points.length} points${errors ? `, ${errors} failed` : ''}`, { summary: result.summary })
    return result
  },
})

export const montecarloTool = defineTool({
  name: 'sim.montecarlo',
  description: 'Monte Carlo over component tolerances: N runs from a seed, each R/C/L (by reference) or .param scaled by a gaussian (tol = 3 sigma by default, clipped) or uniform deviation; reports min/mean/max/sigma of every measurement and the worst runs. Parallel, bounded. Recorded; returns run_id.',
  input: z.object({
    ...circuit,
    measurements: z.array(MeasureSpecSchema).min(1),
    tolerances: z.array(z.object({
      ref: z.string().optional().describe('component reference, e.g. R1'),
      param: z.string().optional().describe('or a .param name'),
      tol: z.number().gt(0).lt(1).describe('fractional, 0.01 = 1 %'),
      dist: z.enum(['gaussian', 'uniform']).optional(),
      sigmas: z.number().positive().optional().describe('gaussian: tol is this many sigma (default 3)'),
    }).strict()).min(1),
    runs: z.number().int().min(1).max(5000),
    seed: z.number().int().optional().describe('default 1'),
    concurrency: z.number().int().min(1).max(64).optional(),
    max_rows: z.number().int().min(0).max(5000).optional().describe('per-run rows returned (default 0; all are stored as runs.csv)'),
  }),
  run: async (a) => {
    const { opts, subject } = baseOptions(a)
    const rec = new Recorder('sim.montecarlo', subject, a)
    let mc: Awaited<ReturnType<typeof montecarlo>>
    let first: SpiceRun | null = null
    try {
      mc = await montecarlo(opts, a.tolerances, a.runs, a.seed ?? 1, { specs: a.measurements, concurrency: a.concurrency, onRun: (_p, r) => { if (r && !first) first = r } })
    } catch (e) {
      spiceFail(rec, e)
    }
    const r0: SpiceRun | null = first
    if (r0) rec.artifact('netlist.cir', (r0 as SpiceRun).netlist)
    const keys = a.tolerances.map((t) => (t.ref ?? t.param) as string)
    rec.artifact('runs.csv', pointsCsv([mc.nominal, ...mc.runs], keys), 'text/csv')
    for (const s of mc.stats) {
      for (const k of ['min', 'mean', 'max', 'sigma'] as const) rec.measure(`${s.name}.${k}`, s[k], s.unit)
    }
    const errors = mc.runs.filter((p) => p.error).length
    const worst = (run: number | null): Record<string, unknown> | null => {
      if (run === null) return null
      const p = mc.runs[run - 1]
      return p ? { run, factors: p.params } : null
    }
    const result = {
      run_id: rec.id,
      stats: mc.stats.map(compactStat),
      worst: Object.fromEntries(mc.stats.map((s) => [s.name, { min: worst(s.min_run), max: worst(s.max_run) }])),
      runs: mc.runs.length,
      seed: a.seed ?? 1,
      ...(mc.nominal.error ? { nominal_error: mc.nominal.error } : {}),
      ...(errors ? { failed_runs: errors, first_failures: mc.runs.filter((p) => p.error).slice(0, 5).map((p) => `${p.label}: ${p.error}`) } : {}),
      ...(a.max_rows ? { rows: pointsTable(mc.runs, a.max_rows) } : {}),
    }
    rec.finish(errors || mc.nominal.error ? 'fail' : 'pass', `${mc.runs.length} runs, seed ${a.seed ?? 1}${errors ? `, ${errors} failed` : ''}`, { stats: result.stats })
    return result
  },
})

// ------------------------------------------------------------------------------------------- sim.kicad_spice

export const kicadSpiceTool = defineTool({
  name: 'sim.kicad_spice',
  description: 'Export a KiCad schematic to SPICE with kicad-cli (using its symbols\' simulation models), apply overrides (replace/remove components, add sources, loads, models, directives), and simulate it like sim.spice. Recorded; returns run_id.',
  input: z.object({
    schematic: z.string().describe('.kicad_sch path'),
    analyses: z.array(z.string()).min(1),
    replace: z.record(z.string(), z.union([z.string(), z.null()])).optional().describe('reference → replacement line, or null to remove, e.g. {"J1": "V1 VIN 0 DC 12", "U3": null}'),
    add: z.array(z.string()).optional().describe('lines to append: sources, loads, .model, .include, .param, .options'),
    drop_unmodelled: z.boolean().optional().describe('comment out components without a simulation model instead of failing'),
    save: z.array(z.string()).optional(),
    models: z.array(z.string()).optional(),
    measurements,
    vectors: z.union([z.array(z.string()), z.literal('all')]).optional(),
    max_points: z.number().int().min(10).max(5000).optional(),
    timeout_s: z.number().positive().max(3600).optional(),
  }),
  run: async (a) => {
    const rec = new Recorder('sim.kicad_spice', a.schematic, a)
    let r: SpiceRun
    let exported: Awaited<ReturnType<typeof exportSpice>>
    try {
      exported = await exportSpice({ schematic: a.schematic, replace: a.replace, add: a.add, dropUnmodelled: a.drop_unmodelled })
      rec.artifact('kicad-export.cir', exported.exported)
      r = await simulate({ netlist: exported.netlist, analyses: a.analyses, save: a.save, models: a.models, baseDir: dirname(resolve(a.schematic)), timeoutMs: a.timeout_s !== undefined ? a.timeout_s * 1000 : undefined })
    } catch (e) {
      spiceFail(rec, e)
    }
    storeRun(rec, r)
    const ms = measureRun(r, a.measurements ?? [])
    rec.measurements(ms)
    const result = {
      run_id: rec.id,
      measurements: compactMeasurements(ms),
      netlist: { components: exported.components, replaced: exported.replaced, removed: exported.removed, ...(exported.unmodelled.length ? { dropped_unmodelled: exported.unmodelled.slice(0, 30), dropped_count: exported.unmodelled.length } : {}) },
      analyses: r.plots.map((p) => plotSummary(p, a.vectors, a.max_points ?? 500)),
      ...(r.warnings.length ? { warnings: r.warnings } : {}),
    }
    rec.finish(ms.some((m) => m.value === null) ? 'fail' : 'pass', `${a.schematic}: ${r.plots.map((p) => p.analysis).join('+')}${ms.length ? ` ${measurementSummary(ms)}` : ''}`, { measurements: result.measurements })
    return result
  },
})

// ------------------------------------------------------------------------------------------- sim.logic

export const logicTool = defineTool({
  name: 'sim.logic',
  description: 'Icarus Verilog: compile (iverilog -g2012) and run (vvp) a design and testbench; returns pass/fail (from $fatal/$error, exit status, and optional PASS/FAIL regexes), the $display output and messages. The VCD (the testbench\'s, or a whole-hierarchy dump added when it has none) is stored as an artifact for sim.wave_*. Returns run_id.',
  input: z.object({
    files: z.array(z.string()).optional().describe('Verilog/SystemVerilog source paths'),
    sources: z.array(z.object({ name: z.string(), text: z.string() }).strict()).optional().describe('or inline sources'),
    top: z.string().optional().describe('top module (default: the single root module)'),
    include_dirs: z.array(z.string()).optional(),
    defines: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    pass: z.string().optional().describe('regex the output must match to pass, e.g. "ALL TESTS PASSED"'),
    fail: z.string().optional().describe('regex that marks failure, e.g. "MISMATCH|FAIL"'),
    plusargs: z.array(z.string()).optional(),
    dump: z.boolean().optional().describe('add a $dumpvars module when the sources have no $dumpfile (default true)'),
    max_lines: z.number().int().min(0).max(5000).optional().describe('output lines returned (default 100; all are stored)'),
    timeout_s: z.number().positive().max(3600).optional(),
  }),
  run: async (a) => {
    const srcs = [...(a.files ?? []).map((path) => ({ path })), ...(a.sources ?? [])]
    if (!srcs.length) throw new ToolError('give files or sources')
    const rec = new Recorder('sim.logic', a.top ?? (a.files?.[0] ?? a.sources?.[0]?.name), a)
    let r: Awaited<ReturnType<typeof simulateLogic>>
    try {
      r = await simulateLogic({ sources: srcs, top: a.top, includeDirs: a.include_dirs, defines: a.defines, pass: a.pass, fail: a.fail, plusargs: a.plusargs, dump: a.dump, timeoutMs: a.timeout_s !== undefined ? a.timeout_s * 1000 : undefined })
    } catch (e) {
      rec.fail(e)
      if (e instanceof LogicError) throw new ToolError(e.message)
      throw e
    }
    for (const s of r.sources) rec.artifact(`src/${s.name}`, s.text)
    rec.artifact('compile.log', r.compileLog)
    rec.artifact('output.log', r.output)
    if (r.vcd) rec.artifact(r.vcdName ?? 'dump.vcd', r.vcd, 'text/x-vcd')
    const lines = r.output.split('\n').filter((l) => l.length)
    const maxLines = a.max_lines ?? 100
    const result = {
      run_id: rec.id,
      passed: r.passed,
      reason: r.reason,
      top: r.top,
      messages: r.messages.slice(0, 50),
      ...(r.messages.length > 50 ? { message_count: r.messages.length } : {}),
      output: lines.length > maxLines ? [...lines.slice(0, Math.ceil(maxLines / 2)), `… ${lines.length - maxLines} lines …`, ...lines.slice(-Math.floor(maxLines / 2))] : lines,
      output_lines: lines.length,
      ...(r.compileLog.trim() ? { compile: r.compileLog.trim().split('\n').slice(0, 30) } : {}),
      vcd: r.vcd ? { artifact: r.vcdName, bytes: r.vcd.length } : null,
      ms: r.ms,
    }
    rec.finish(r.passed ? 'pass' : 'fail', `${r.top || 'logic'}: ${r.reason}`, { passed: r.passed, reason: r.reason })
    return result
  },
})

// ------------------------------------------------------------------------------------------- wave tools

const source = {
  file: z.string().optional().describe('a capture on disk: .vcd (Icarus, sigrok, Saleae) or .csv (time column first)'),
  run_id: z.string().optional().describe('or an earlier run whose artifact holds the capture'),
  artifact: z.string().optional().describe('with run_id: the artifact name (default the run\'s .vcd)'),
  threshold: z.number().optional().describe('analog CSV columns: logic threshold (V)'),
  vil: z.number().optional(),
  vih: z.number().optional(),
}

async function loadCapture(a: { file?: string | undefined; run_id?: string | undefined; artifact?: string | undefined }, keep?: ReadonlySet<string>): Promise<wave.Capture> {
  if ((a.file === undefined) === (a.run_id === undefined)) throw new ToolError('give file, or run_id (+ artifact)')
  try {
    if (a.file !== undefined) return await wave.read(resolve(a.file), a.file, keep)
    const name = a.artifact ?? defaultCapture(a.run_id as string)
    const bytes = readArtifact(a.run_id as string, name)
    return await wave.read(bytes, name, keep)
  } catch (e) {
    if (e instanceof wave.WaveError) throw new ToolError(e.message)
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') throw new ToolError(`no file ${a.file}`)
    throw e
  }
}

function wrap<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof wave.WaveError) throw new ToolError(e.message)
    throw e
  }
}

const levels = (a: { threshold?: number | undefined; vil?: number | undefined; vih?: number | undefined }): { threshold?: number; vil?: number; vih?: number } => ({
  ...(a.threshold !== undefined ? { threshold: a.threshold } : {}), ...(a.vil !== undefined ? { vil: a.vil } : {}), ...(a.vih !== undefined ? { vih: a.vih } : {}),
})

export const waveReadTool = defineTool({
  name: 'sim.wave_read',
  description: 'Summarise a capture (VCD or CSV, from a file or a run artifact): every signal with its change count, first/last value, and for one-bit signals edges, pulse widths, period, frequency and duty; bus values; analog ranges.',
  input: z.object({
    ...source,
    signals: z.array(z.string()).optional().describe('only these signals'),
    limit: z.number().int().min(1).max(1000).optional().describe('signals listed (default 64)'),
  }),
  run: async (a) => {
    const c = await loadCapture(a)
    return wrap(() => wave.summarize(c, { limit: a.limit, only: a.signals }))
  },
})

const fmtByte = (v: number | null): string | null => (v === null ? null : `0x${v.toString(16).padStart(2, '0')}`)

export const waveDecodeTool = defineTool({
  name: 'sim.wave_decode',
  description: 'Decode a protocol from a capture (file or run artifact): SPI (modes 0-3, CS, MSB/LSB, word size), I2C (START/STOP, address, R/W, ACK, data, UM10204 timing checked against standard/fast/fast_plus), UART (baud, data bits, parity, stop bits, inverted). Signals are given by role.',
  input: z.object({
    ...source,
    protocol: z.enum(['spi', 'i2c', 'uart']),
    signals: z.record(z.string(), z.string()).describe('role → signal: spi {sck, mosi?, miso?, cs?}; i2c {scl, sda}; uart {rx} (or tx)'),
    mode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional().describe('SPI mode'),
    bits: z.number().int().min(1).max(32).optional().describe('SPI word size (default 8)'),
    lsb_first: z.boolean().optional(),
    cs_active_high: z.boolean().optional(),
    speed: z.enum(['standard', 'fast', 'fast_plus']).optional().describe('I2C: check the timing against this mode'),
    baud: z.number().positive().optional(),
    data_bits: z.number().int().min(5).max(9).optional(),
    parity: z.enum(['none', 'even', 'odd']).optional(),
    stop_bits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional(),
    invert: z.boolean().optional(),
    from: z.number().optional().describe('start time (s)'),
    to: z.number().optional().describe('end time (s)'),
    limit: z.number().int().min(1).max(5000).optional().describe('items returned (default 100)'),
  }),
  run: async (a) => {
    const c = await loadCapture(a, new Set(Object.values(a.signals)))
    const limit = a.limit ?? 100
    const lv = levels(a)
    const inWin = (t: number): boolean => (a.from === undefined || t >= a.from) && (a.to === undefined || t <= a.to)
    return wrap(() => {
      const s = wave.remap(c, a.signals, lv)
      if (a.protocol === 'spi') {
        if (!s.sck) throw new ToolError('spi needs signals.sck')
        const tx = wave.spiDecode({ sck: s.sck, mosi: s.mosi, miso: s.miso, cs: s.cs }, { mode: a.mode, bits: a.bits, lsbFirst: a.lsb_first, csActiveHigh: a.cs_active_high }, c.end).filter((t) => inWin(t.start))
        const words = tx.reduce((n, t) => n + Math.max(t.mosi.length, t.miso.length), 0)
        return {
          protocol: 'spi', mode: a.mode ?? 0, transfers: tx.length, words,
          items: tx.slice(0, limit).map((t) => ({ t: round(t.start), end: round(t.end), ...(s.mosi ? { mosi: t.mosi.map(fmtByte) } : {}), ...(s.miso ? { miso: t.miso.map(fmtByte) } : {}), ...(t.leftover_bits ? { leftover_bits: t.leftover_bits } : {}) })),
          ...(tx.length > limit ? { truncated: `${tx.length} transfers, ${limit} shown` } : {}),
        }
      }
      if (a.protocol === 'i2c') {
        if (!s.scl || !s.sda) throw new ToolError('i2c needs signals.scl and signals.sda')
        const d = wave.i2cDecode(s.scl, s.sda, a.from, a.to)
        const t = d.timing
        const timing: Record<string, number | null> = {}
        for (const [k, v] of Object.entries(t)) timing[k] = typeof v === 'number' && Number.isFinite(v) ? round(v) : null
        return {
          protocol: 'i2c', frames: d.frames.length,
          nacked: d.frames.filter((f) => f.bytes[0]?.ack === false).length,
          items: d.frames.slice(0, limit).map((f) => {
            const first = f.bytes[0]
            return {
              t: round(f.t), ...(f.repeated ? { repeated: true } : {}),
              addr: first && first.value !== null ? `0x${(first.value >> 1).toString(16).padStart(2, '0')}` : null,
              rw: first && first.value !== null ? (first.value & 1 ? 'R' : 'W') : null,
              ack: first?.ack ?? null,
              data: f.bytes.slice(1).map((b) => fmtByte(b.value)),
              acks: f.bytes.slice(1).map((b) => b.ack),
              stopped: f.stopped,
            }
          }),
          ...(d.frames.length > limit ? { truncated: `${d.frames.length} frames, ${limit} shown` } : {}),
          timing,
          ...(a.speed ? { check: wave.i2cCheck(t, a.speed), pass: wave.i2cCheck(t, a.speed).every((x) => x.ok) && t.framing === 0 && t.unknown === 0 } : {}),
        }
      }
      const line = s.rx ?? s.tx ?? s.line
      if (!line) throw new ToolError('uart needs signals.rx (or tx)')
      if (a.baud === undefined) throw new ToolError('uart needs baud')
      const fr = wave.uartDecode(line, { baud: a.baud, dataBits: a.data_bits, parity: a.parity, stopBits: a.stop_bits, invert: a.invert }, c.end).filter((f) => inWin(f.t))
      const text = fr.map((f) => (f.value !== null && f.value >= 32 && f.value < 127 ? String.fromCharCode(f.value) : '.')).join('')
      return {
        protocol: 'uart', baud: a.baud, frames: fr.length,
        errors: { framing: fr.filter((f) => f.framing_error).length, parity: fr.filter((f) => f.parity_error).length },
        text: text.slice(0, limit * 4),
        items: fr.slice(0, limit).map((f) => ({ t: round(f.t), value: fmtByte(f.value), ...(f.framing_error ? { framing_error: true } : {}), ...(f.parity_error ? { parity_error: true } : {}) })),
        ...(fr.length > limit ? { truncated: `${fr.length} frames, ${limit} shown` } : {}),
      }
    })
  },
})

export const waveTimingTool = defineTool({
  name: 'sim.wave_timing',
  description: 'Timing checks on a capture (file or run artifact): setup/hold of data around a clock edge (optionally gated by a select), chip select to clock lead/lag, select spacing, selects or drivers active at once (one-hot / bus contention), pulse widths and period. Limits in seconds; each check reports worst values and pass.',
  input: z.object({
    ...source,
    checks: z.array(z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('setup_hold'), name: z.string().optional(), data: z.string(), clock: z.string(), edge: z.enum(['rising', 'falling']).optional(), gate: z.string().optional(), gate_active: z.enum(['0', '1']).optional(), setup_min: z.number().optional(), hold_min: z.number().optional(), from: z.number().optional(), to: z.number().optional() }).strict(),
      z.object({ kind: z.literal('cs_clock'), name: z.string().optional(), cs: z.string(), clock: z.string(), active: z.enum(['0', '1']).optional(), lead_min: z.number().optional(), lag_min: z.number().optional() }).strict(),
      z.object({ kind: z.literal('cs_spacing'), name: z.string().optional(), selects: z.array(z.string()).min(1), active: z.enum(['0', '1']).optional(), min: z.number().optional() }).strict(),
      z.object({ kind: z.literal('overlap'), name: z.string().optional(), signals: z.array(z.string()).min(2), active: z.enum(['0', '1']).optional(), from: z.number().optional(), to: z.number().optional() }).strict(),
      z.object({ kind: z.literal('pulse'), name: z.string().optional(), signal: z.string(), min_high: z.number().optional(), min_low: z.number().optional(), min_period: z.number().optional(), max_period: z.number().optional() }).strict(),
    ])).min(1),
  }),
  run: async (a) => {
    const c = await loadCapture(a)
    const lv = levels(a)
    const g = (n: string): wave.Signal => c.get(n, lv)
    return wrap(() => {
      const results = a.checks.map((k) => {
        const name = k.name ?? k.kind
        switch (k.kind) {
          case 'setup_hold':
            return { name, ...wave.setupHold(g(k.data), g(k.clock), { edge: k.edge, gate: k.gate ? g(k.gate) : undefined, gateActive: k.gate_active, setupMin: k.setup_min, holdMin: k.hold_min, t0: k.from, t1: k.to }) }
          case 'cs_clock':
            return { name, ...wave.csToClock(g(k.cs), g(k.clock), { active: k.active, leadMin: k.lead_min, lagMin: k.lag_min }) }
          case 'cs_spacing':
            return { name, ...wave.csSpacing(k.selects.map(g), { active: k.active, min: k.min }) }
          case 'overlap':
            return { name, ...wave.overlap(k.signals.map(g), { active: k.active, t0: k.from, t1: k.to, end: c.end }) }
          case 'pulse':
            return { name, ...wave.pulseCheck(g(k.signal), c.end, { minHigh: k.min_high, minLow: k.min_low, minPeriod: k.min_period, maxPeriod: k.max_period }) }
        }
      })
      const verdicts = results.map((r) => (r as Record<string, unknown>).pass).filter((p): p is boolean => typeof p === 'boolean')
      return { pass: verdicts.length ? verdicts.every(Boolean) : null, checks: results }
    })
  },
})

export const tools: AnyTool[] = [
  spiceTool, measureTool, sweepTool, montecarloTool, kicadSpiceTool, logicTool, waveReadTool, waveDecodeTool, waveTimingTool,
] as unknown as AnyTool[]

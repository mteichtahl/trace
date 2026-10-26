/**
 * The analog and mixed-signal tools (ams.*), for the Analog/Mixed-Signal agent. All of them run ngspice (batch, the
 * version on PATH or $NGSPICE; built and tested against ngspice 42) through src/sim, so circuits, models and
 * measurements work exactly as in sim.spice, and every run is recorded in the project database with its netlists
 * and logs as artifacts and its results as measurements.
 */
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

import { defineTool, ToolError, type AnyTool } from '../../core/registry.js'
import { decimate, MeasureSpecSchema, round, type MeasureSpec } from '../../sim/measure.js'
import { Recorder } from '../../sim/record.js'
import { ngspice, simulate, SpiceError, splitNetlist, vectorOf, type SimulateOptions, type SpiceRun } from '../../sim/spice.js'
import { measureRun, type MonteCarloResult } from '../../sim/sweep.js'
import { baseOptions, circuitInput, r, readCircuit, spiceFail } from './common.js'
import { planCorners, runCorners, worstCorners, type CornerPoint } from './corners.js'
import { buildCosim, clockSamples, CosimError, mixedNetlist, shimDir, verilator, type CosimLibrary, type Drive } from './mixed.js'
import { analyseNoise, runNoise } from './noise.js'
import { checkOpamp, OPAMP_TESTS, validatePins, type OpampBench, type OpampTest } from './opamp.js'
import { deleteSpec, getSpecs, judge, putSpec, relativeMargin, resolveSpecs, SpecLimit } from './spec.js'
import { correlationSensitivity, montecarlo, oatSensitivity, yieldOf } from './yield.js'

const needNgspice = (): void => {
  if (!ngspice()) throw new ToolError('ngspice not found (apt install ngspice / brew install ngspice; or set NGSPICE)')
}

const specsInput = {
  spec_set: z.string().optional().describe('judge against this stored spec set (ams.spec)'),
  specs: z.record(z.string(), SpecLimit).optional().describe('inline limits by measure name, e.g. {"f3db": {"min": 900, "max": 1100, "unit": "Hz"}}; override the stored set'),
}

const measurementsInput = z.array(MeasureSpecSchema).min(1)
  .describe('measurements (as sim.spice), e.g. [{"name":"vout","kind":"value_at","vector":"v(out)","analysis":"op"}]; each spec\'s key is a measurement name')

function csv(rows: readonly Record<string, unknown>[]): string {
  const cols: string[] = []
  for (const row of rows) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k)
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  return `${[cols.join(','), ...rows.map((row) => cols.map((c) => esc(row[c])).join(','))].join('\n')}\n`
}

// ------------------------------------------------------------------------------------------- ams.spec

export const specTool = defineTool({
  name: 'ams.spec',
  description: 'Analog spec store in the project database (table ams_specs): per spec set and measure, min/typ/max limits, unit, the conditions they apply under, notes and source. action=set (one, or many with `rows`), get (a set), list (every set), delete. ams.corners, ams.montecarlo_yield and ams.opamp_check judge against a set by name.',
  input: z.object({
    action: z.enum(['set', 'get', 'list', 'delete']),
    spec_set: z.string().optional().describe('the set, e.g. "front-end"'),
    measure: z.string().optional().describe('set/delete one: the measure name'),
    min: z.number().optional(),
    typ: z.number().optional(),
    max: z.number().optional(),
    unit: z.string().optional(),
    conditions: z.record(z.string(), z.unknown()).optional().describe('e.g. {"temp_c": [-40, 85], "vdd": 3.3, "rl": "10k"}'),
    notes: z.string().optional(),
    source: z.string().optional().describe('where the limit comes from (requirement id, datasheet page)'),
    rows: z.array(z.object({
      measure: z.string(), min: z.number().optional(), typ: z.number().optional(), max: z.number().optional(), unit: z.string().optional(),
      conditions: z.record(z.string(), z.unknown()).optional(), notes: z.string().optional(), source: z.string().optional(),
    }).strict()).optional().describe('set many in one call'),
  }),
  run: (a) => {
    if (a.action === 'list') {
      const all = getSpecs()
      const sets = new Map<string, number>()
      for (const s of all) sets.set(s.spec_set, (sets.get(s.spec_set) ?? 0) + 1)
      return { sets: [...sets].map(([spec_set, measures]) => ({ spec_set, measures })) }
    }
    if (a.spec_set === undefined) throw new ToolError(`${a.action} needs spec_set`)
    if (a.action === 'get') return { spec_set: a.spec_set, specs: getSpecs(a.spec_set) }
    if (a.action === 'delete') return { deleted: deleteSpec(a.spec_set, a.measure) }
    const rows = a.rows ?? (a.measure !== undefined ? [{ measure: a.measure, min: a.min, typ: a.typ, max: a.max, unit: a.unit, conditions: a.conditions, notes: a.notes, source: a.source }] : [])
    if (!rows.length) throw new ToolError('set needs measure (with min/typ/max) or rows')
    const saved = rows.map((row) => putSpec({ spec_set: a.spec_set as string, ...row }))
    return { spec_set: a.spec_set, saved }
  },
})

// ------------------------------------------------------------------------------------------- ams.corners

function cornerRow(p: CornerPoint): Record<string, unknown> {
  return {
    corner: p.label, model: p.model, ...p.supplies, temp: p.temp, pass: p.pass, ...(p.error ? { error: p.error } : {}),
    ...Object.fromEntries(p.measurements.map((m) => [m.name, m.value === null ? null : round(m.value)])),
  }
}

export const cornersTool = defineTool({
  name: 'ams.corners',
  description: 'PVT corners with ngspice: the product of model corners (a .lib section such as tt/ff/ss from the netlist\'s or the project\'s electronics.models libraries, and/or .param overrides), supply values (a .param per supply: values, or nominal ± tol) and temperatures (.options temp). Every corner is a full simulation measured like sim.spice; returns a table, per-spec worst corner (least margin) and pass/fail. Only as good as the model libraries: corners the models do not describe are not simulated. Recorded; returns run_id.',
  input: z.object({
    ...circuitInput,
    analyses: z.array(z.string()).optional().describe('analysis lines; default those in the netlist'),
    measurements: measurementsInput,
    ...specsInput,
    model_corners: z.array(z.object({
      name: z.string(),
      lib: z.object({ file: z.string().optional().describe('library file (default: any .lib line / project library defining the section)'), section: z.string() }).strict().optional(),
      params: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
    }).strict()).optional().describe('e.g. [{"name":"tt","lib":{"section":"tt"}},{"name":"ss","lib":{"section":"ss"}}] or [{"name":"slow","params":{"rpoly":"1.1k"}}]; default one nominal corner'),
    supplies: z.array(z.object({
      param: z.string(), values: z.array(z.union([z.number(), z.string()])).optional(), nominal: z.number().optional(), tol: z.number().min(0).lt(1).optional(),
    }).strict()).optional().describe('e.g. [{"param":"vdd","nominal":3.3,"tol":0.1}] (the netlist uses {vdd})'),
    temps: z.array(z.number()).optional().describe('degrees C, default [27]'),
    concurrency: z.number().int().min(1).max(64).optional(),
    max_rows: z.number().int().min(1).max(2000).optional().describe('rows returned (default 100; all are stored as corners.csv)'),
  }),
  run: async (a) => {
    needNgspice()
    const c = readCircuit(a)
    const limits = resolveSpecs(a.spec_set, a.specs)
    const rec = new Recorder('ams.corners', c.subject, a)
    let points: CornerPoint[]
    let first: SpiceRun | null = null
    try {
      const plan = planCorners(baseOptions(c, a, a.analyses), a.model_corners ?? [], a.supplies ?? [], a.temps ?? [])
      points = await runCorners(plan, a.measurements, limits, a.concurrency, (_p, run) => { if (run && !first) first = run })
    } catch (e) {
      if (e instanceof SpiceError) spiceFail(rec, e)
      throw rec.fail(e)
    }
    const f: SpiceRun | null = first
    if (f) rec.artifact('netlist.cir', (f as SpiceRun).netlist)
    const rows = points.map(cornerRow)
    rec.artifact('corners.csv', csv(rows), 'text/csv')
    const worst = worstCorners(points, limits)
    for (const w of worst) {
      rec.measure(`${w.measure}.worst`, w.value, limits.get(w.measure)?.unit ?? '', { corner: w.corner, margin: w.margin })
      rec.measure(`${w.measure}.worst_margin`, w.margin)
    }
    const failedSims = points.filter((p) => p.error).length
    const pass = limits.size ? points.every((p) => p.pass) : failedSims === 0
    const maxRows = a.max_rows ?? 100
    const result = {
      run_id: rec.id,
      pass,
      corners: points.length,
      ...(failedSims ? { failed_simulations: failedSims, first_failures: points.filter((p) => p.error).slice(0, 5).map((p) => `${p.label}: ${p.error}`) } : {}),
      worst: worst.map((w) => ({ ...w, value: r(w.value), margin: r(w.margin), relative_margin: r(relativeMargin({ pass: w.pass, margin: w.margin, limit: w.limit }, limits.get(w.measure) ?? {})), spec: limits.get(w.measure) })),
      ...(points.find((p) => p.libNote) ? { libraries: [...new Set(points.map((p) => p.libNote).filter(Boolean))] } : {}),
      rows: rows.slice(0, maxRows),
      ...(rows.length > maxRows ? { truncated: `${rows.length} corners, ${maxRows} shown (all in corners.csv)` } : {}),
      ...(!limits.size ? { note: 'no specs given: nothing judged (give spec_set or specs)' } : {}),
    }
    rec.finish(pass ? 'pass' : 'fail', `${points.length} corners${worst.length ? `; worst: ${worst.map((w) => `${w.measure} ${w.pass ? 'ok' : 'FAIL'} @ ${w.corner}`).slice(0, 3).join(', ')}` : ''}`, { pass, worst: result.worst })
    return result
  },
})

// ------------------------------------------------------------------------------------------- ams.montecarlo_yield

export const yieldTool = defineTool({
  name: 'ams.montecarlo_yield',
  description: 'Monte Carlo yield against specs (ngspice, sim.montecarlo\'s engine: R/C/L by reference or .param, gaussian with tol = 3 sigma clipped, or uniform): overall and per-spec yield with a Wilson score confidence interval, plus sensitivity ranking per measure — Pearson correlation of each part\'s drawn factor with the measure over the runs (free), and/or one-at-a-time ±tol runs (2 per part; linear, no interactions). Independent draws: correlated tolerances (matched pairs, a common lot) are not modelled. Recorded; returns run_id.',
  input: z.object({
    ...circuitInput,
    analyses: z.array(z.string()).optional(),
    measurements: measurementsInput,
    ...specsInput,
    tolerances: z.array(z.object({
      ref: z.string().optional().describe('component reference, e.g. R1'),
      param: z.string().optional().describe('or a .param name'),
      tol: z.number().gt(0).lt(1).describe('fractional, 0.01 = 1 %'),
      dist: z.enum(['gaussian', 'uniform']).optional(),
      sigmas: z.number().positive().optional().describe('gaussian: tol is this many sigma (default 3)'),
    }).strict()).min(1),
    runs: z.number().int().min(10).max(5000),
    seed: z.number().int().optional().describe('default 1'),
    confidence: z.number().gt(0.5).lt(1).optional().describe('two-sided, default 0.95'),
    sensitivity: z.enum(['correlation', 'oat', 'both', 'none']).optional().describe('default correlation'),
    concurrency: z.number().int().min(1).max(64).optional(),
  }),
  run: async (a) => {
    needNgspice()
    const c = readCircuit(a)
    const limits = resolveSpecs(a.spec_set, a.specs)
    if (!limits.size) throw new ToolError('give spec_set or specs: yield needs limits')
    const names = a.measurements.map((m) => m.name ?? `${m.kind}:${m.vector}`)
    for (const k of limits.keys()) if (!names.includes(k)) throw new ToolError(`spec ${k} has no measurement of that name (measurements: ${names.join(', ')})`)
    const base = baseOptions(c, a, a.analyses)
    const rec = new Recorder('ams.montecarlo_yield', c.subject, a)
    let mc: MonteCarloResult
    let first: SpiceRun | null = null
    try {
      mc = await montecarlo(base, a.tolerances, a.runs, a.seed ?? 1, { specs: a.measurements, concurrency: a.concurrency, onRun: (_p, run) => { if (run && !first) first = run } })
    } catch (e) {
      if (e instanceof SpiceError) spiceFail(rec, e)
      throw rec.fail(e)
    }
    const f: SpiceRun | null = first
    if (f) rec.artifact('netlist.cir', (f as SpiceRun).netlist)
    const parts = a.tolerances.map((t) => (t.ref ?? t.param) as string)
    rec.artifact('runs.csv', csv(mc.runs.map((p) => ({ run: p.index, ...p.params, ...Object.fromEntries(p.measurements.map((m) => [m.name, m.value])), ...(p.error ? { error: p.error } : {}) }))), 'text/csv')
    const conf = a.confidence ?? 0.95
    const y = yieldOf(mc, limits, conf)
    rec.measure('yield', y.yield, '', { ci: y.ci })
    for (const s of y.per_spec) rec.measure(`${s.measure}.yield`, s.yield, '', { ci: s.ci })
    const mode = a.sensitivity ?? 'correlation'
    const sensitivity: Record<string, unknown> = {}
    if (mode === 'correlation' || mode === 'both') {
      for (const name of limits.keys()) {
        const s = correlationSensitivity(mc, name, parts)
        sensitivity[name] = { correlation: s.ranking.map((x) => ({ part: x.part, r: r(x.r, 4), r2: r(x.r2, 4) })), r2_total: r(s.r2_total, 4), noise_floor_abs_r: r(2 / Math.sqrt(mc.runs.length), 3) }
      }
    }
    if (mode === 'oat' || mode === 'both') {
      try {
        const oat = await oatSensitivity(base, a.tolerances, a.measurements, limits, a.concurrency)
        for (const name of limits.keys()) {
          const prev = (sensitivity[name] ?? {}) as Record<string, unknown>
          sensitivity[name] = { ...prev, oat: (oat[name] ?? []).map((x) => ({ ...x, low: r(x.low), high: r(x.high), swing: r(x.swing), share_of_window: r(x.share_of_window, 4) })) }
        }
      } catch (e) {
        if (e instanceof SpiceError) spiceFail(rec, e, 'oat-')
        throw rec.fail(e)
      }
    }
    const errors = mc.runs.filter((p) => p.error).length
    const result = {
      run_id: rec.id,
      yield: r(y.yield, 5), passed: y.passed, runs: y.runs,
      ci: { lo: r(y.ci.lo, 5), hi: r(y.ci.hi, 5), confidence: conf, method: 'Wilson score interval' },
      ...(y.zero_fail_bound !== undefined ? { zero_fail_bound: { failure_rate_at_most: r(y.zero_fail_bound, 4), confidence: conf, method: 'exact binomial, 0 failures' } } : {}),
      per_spec: y.per_spec.map((s) => ({ ...s, yield: r(s.yield, 5), ci: { lo: r(s.ci.lo, 5), hi: r(s.ci.hi, 5) }, min: r(s.min), max: r(s.max), spec: limits.get(s.measure) })),
      nominal: Object.fromEntries(mc.nominal.measurements.map((m) => [m.name, r(m.value)])),
      ...(mc.nominal.error ? { nominal_error: mc.nominal.error } : {}),
      sensitivity,
      seed: a.seed ?? 1,
      ...(errors ? { failed_runs: errors, note: 'failed simulations count as yield failures' } : {}),
    }
    rec.finish(y.passed === y.runs ? 'pass' : 'fail', `yield ${(y.yield * 100).toFixed(2)} % (${y.passed}/${y.runs}), ${Math.round(conf * 100)} % CI ${(y.ci.lo * 100).toFixed(2)}–${(y.ci.hi * 100).toFixed(2)} %`, { yield: result.yield, ci: result.ci })
    return result
  },
})

// ------------------------------------------------------------------------------------------- ams.opamp_check

export const opampTool = defineTool({
  name: 'ams.opamp_check',
  description: 'Op-amp characterisation from its SPICE subcircuit with generated ngspice benches: loop gain of the closed loop (gain G, load RL/CL) by Middlebrook double injection (voltage + current probe, two .ac runs; exact for an ideal probe) giving crossover, phase and gain margin; open-loop gain and GBW, CMRR and PSRR± (.ac, DC-servoed open loop, input-referred); slew rate (follower step, 10-90 % slope); output swing (inverting -1, error within tol_v); input common-mode range (follower). Results are the model\'s: a macro-model that omits a behaviour reports it ideal. Recorded; returns run_id.',
  input: z.object({
    subckt: z.string().optional().describe('the .subckt text'),
    path: z.string().optional().describe('or a model file holding it (included)'),
    name: z.string().describe('subcircuit name'),
    pins: z.array(z.string()).min(5).describe('its port order as roles, e.g. ["inp","inn","vcc","vee","out"]; other names need `tie`'),
    tie: z.record(z.string(), z.union([z.enum(['vcc', 'vee', 'gnd']), z.number()])).optional().describe('extra pins, e.g. {"en": "vcc"}'),
    vcc: z.number().describe('positive supply (V)'),
    vee: z.number().describe('negative supply (V), e.g. 0'),
    vcm: z.number().optional().describe('input common mode / output reference (default mid-supply)'),
    gain: z.number().min(1).optional().describe('closed-loop non-inverting gain for the loop test (default 1)'),
    rf: z.number().positive().optional().describe('feedback resistor (default 10k)'),
    rl: z.number().positive().optional().describe('load to vcm (default 10k)'),
    cl: z.number().min(0).optional().describe('load capacitance (F, default 0)'),
    tests: z.array(z.enum(OPAMP_TESTS as unknown as [OpampTest, ...OpampTest[]])).optional().describe('default all: loop aol cmrr psrr slew swing icmr'),
    fstart: z.number().positive().optional().describe('AC start (Hz, default 1)'),
    fstop: z.number().positive().optional().describe('AC stop (Hz, default 1G)'),
    points_per_decade: z.number().int().min(5).max(500).optional().describe('default 50'),
    freqs: z.array(z.number().positive()).optional().describe('frequencies CMRR/PSRR are reported at (default [10, 1k, 100k])'),
    slew_step: z.number().positive().optional().describe('step amplitude (V, default 40 % of the supply span)'),
    slew_time_s: z.number().positive().optional().describe('time allowed for each edge (default 100/GBW)'),
    tol_v: z.number().positive().optional().describe('swing/ICMR error tolerance (V, default 10 mV)'),
    ...specsInput,
    models: z.array(z.string()).optional(),
    options: z.string().optional(),
    timeout_s: z.number().positive().max(3600).optional(),
    curve_points: z.number().int().min(0).max(2000).optional().describe('points of the loop-gain and Aol curves returned (default 0; all are stored)'),
  }),
  run: async (a) => {
    needNgspice()
    if ((a.subckt === undefined) === (a.path === undefined)) throw new ToolError('give exactly one of subckt or path')
    const tie = a.tie ?? {}
    try {
      validatePins(a.pins, tie)
    } catch (e) {
      throw new ToolError((e as Error).message)
    }
    if (!(a.vcc > a.vee)) throw new ToolError('vcc must be above vee')
    const bench: OpampBench = {
      device: a.subckt ?? `.include ${resolve(a.path as string)}`, name: a.name, pins: a.pins, tie,
      vcc: a.vcc, vee: a.vee, vcm: a.vcm ?? (a.vcc + a.vee) / 2, gain: a.gain ?? 1, rf: a.rf ?? 10e3, rl: a.rl ?? 10e3, cl: a.cl ?? 0,
      fstart: a.fstart ?? 1, fstop: a.fstop ?? 1e9, perDecade: a.points_per_decade ?? 50, slewStep: a.slew_step ?? 0.4 * (a.vcc - a.vee),
      slewTime: a.slew_time_s, tolV: a.tol_v ?? 10e-3, freqs: a.freqs ?? [10, 1e3, 1e5],
    }
    const limits = a.spec_set !== undefined || a.specs ? resolveSpecs(a.spec_set, a.specs) : new Map<string, SpecLimit>()
    const rec = new Recorder('ams.opamp_check', a.name, a)
    let rep: Awaited<ReturnType<typeof checkOpamp>>
    try {
      rep = await checkOpamp(bench, a.tests ?? OPAMP_TESTS, { models: a.models, options: a.options, timeoutMs: a.timeout_s !== undefined ? a.timeout_s * 1000 : undefined })
    } catch (e) {
      if (e instanceof SpiceError) spiceFail(rec, e)
      throw rec.fail(e)
    }
    for (const run of rep.runs) {
      rec.artifact(`${run.label}.cir`, run.run.netlist)
      rec.artifact(`${run.label}.log`, run.run.log)
    }
    if (rep.curves.loop) rec.artifact('loop_gain.csv', csv(rep.curves.loop.f.map((f, i) => ({ f, mag_db: rep.curves.loop?.mag_db[i], phase_deg: rep.curves.loop?.phase_deg[i] }))), 'text/csv')
    if (rep.curves.aol) rec.artifact('aol.csv', csv(rep.curves.aol.f.map((f, i) => ({ f, mag_db: rep.curves.aol?.mag_db[i], phase_deg: rep.curves.aol?.phase_deg[i] }))), 'text/csv')
    for (const m of rep.measurements) rec.measure(m.name, m.value, m.unit)
    const verdicts = [...limits].map(([name, lim]) => {
      const v = rep.measurements.find((m) => m.name === name)?.value ?? null
      const j = judge(v, lim)
      return { measure: name, value: r(v), ...lim, pass: j.pass, margin: r(j.margin) }
    })
    const curve = (n: number): Record<string, unknown> | undefined => {
      if (!n) return undefined
      const out: Record<string, unknown> = {}
      for (const [k, c] of Object.entries(rep.curves)) {
        const [x, s] = decimate(c.f, [c.mag_db, c.phase_deg], n)
        out[k] = { f: x.map((v) => r(v, 5)), mag_db: (s[0] ?? []).map((v) => r(v, 5)), phase_deg: (s[1] ?? []).map((v) => r(v, 5)) }
      }
      return out
    }
    const rnd = (o: unknown): unknown => JSON.parse(JSON.stringify(o, (_k, v: unknown) => (typeof v === 'number' ? r(v) : v)))
    const curves = curve(a.curve_points ?? 0)
    const pass = verdicts.length ? verdicts.every((v) => v.pass) && !rep.errors.length : !rep.errors.length
    const result = {
      run_id: rec.id,
      ...(rnd({ loop: rep.loop, aol: rep.aol, cmrr_db: rep.cmrr_db, psrr_pos_db: rep.psrr_pos_db, psrr_neg_db: rep.psrr_neg_db, slew: rep.slew, swing: rep.swing, icmr: rep.icmr }) as Record<string, unknown>),
      measurements: rep.measurements.map((m) => ({ ...m, value: r(m.value) })),
      ...(verdicts.length ? { specs: verdicts, pass } : {}),
      ...(rep.errors.length ? { errors: rep.errors } : {}),
      ...(curves ? { curves } : {}),
      bench: { vcc: bench.vcc, vee: bench.vee, vcm: bench.vcm, gain: bench.gain, rl: bench.rl, cl: bench.cl },
    }
    const pm = rep.loop?.phase_margin_deg
    rec.finish(pass ? 'pass' : 'fail', `${a.name}: ${pm !== undefined && pm !== null ? `PM ${pm.toFixed(1)}°` : ''}${rep.aol?.gbw_hz ? ` GBW ${(rep.aol.gbw_hz / 1e6).toPrecision(3)} MHz` : ''}${rep.errors.length ? ` (${rep.errors.length} bench(es) failed)` : ''}`, { measurements: result.measurements })
    return result
  },
})

// ------------------------------------------------------------------------------------------- ams.noise

export const noiseTool = defineTool({
  name: 'ams.noise',
  description: 'Noise with ngspice .noise (thermal, shot and flicker noise of the device models, small-signal at the operating point): integrated output and input-referred noise (Vrms) over a band, spot densities, and the top contributing devices with their thermal/flicker parts (per-device output densities from pts_per_summary, integrated in log-log segments and checked against ngspice\'s own totals). Linear analysis: no large-signal, aliasing or quantisation noise. Recorded; returns run_id.',
  input: z.object({
    ...circuitInput,
    output: z.string().describe('the output node, e.g. "out" or "out,ref" (differential)'),
    source: z.string().describe('the input source the input-referred noise is referred to, e.g. "V1"'),
    fstart: z.number().positive().describe('band start (Hz)'),
    fstop: z.number().positive().describe('band stop (Hz)'),
    points_per_decade: z.number().int().min(5).max(1000).optional().describe('default 50'),
    spot: z.array(z.number().positive()).optional().describe('frequencies for spot densities'),
    top: z.number().int().min(1).max(100).optional().describe('contributors returned (default 10)'),
    spec_rms: z.number().positive().optional().describe('pass when the integrated output noise is at most this (Vrms)'),
  }),
  run: async (a) => {
    needNgspice()
    if (!(a.fstop > a.fstart)) throw new ToolError('fstop must be above fstart')
    const c = readCircuit(a)
    const base: SimulateOptions = baseOptions(c, a)
    const rec = new Recorder('ams.noise', c.subject, a)
    let res: Awaited<ReturnType<typeof runNoise>>
    try {
      res = await runNoise(base, a.output, a.source, [a.fstart, a.fstop], a.points_per_decade ?? 50)
    } catch (e) {
      if (e instanceof SpiceError) spiceFail(rec, e)
      throw rec.fail(e)
    }
    rec.artifact('netlist.cir', res.run.netlist)
    rec.artifact('ngspice.log', res.run.log)
    for (const [k, text] of res.run.raw) rec.artifact(`${k}.raw`, text)
    const n = analyseNoise(res.spec, res.total, [a.fstart, a.fstop], a.spot ?? [], a.top ?? 10)
    rec.measure('output_noise_rms', n.output_rms, 'V')
    rec.measure('input_noise_rms', n.input_rms, 'V')
    const pass = a.spec_rms === undefined ? null : n.output_rms <= a.spec_rms
    const crossCheck = n.ngspice_output_total ? n.output_rms / n.ngspice_output_total - 1 : null
    const result = {
      run_id: rec.id,
      band_hz: n.band,
      output_noise_vrms: r(n.output_rms), output_noise_pp_est_v: r(n.output_pp_est),
      input_noise_rms: r(n.input_rms),
      ngspice_totals: { output: r(n.ngspice_output_total), input: r(n.ngspice_input_total), integration_difference: r(crossCheck, 3) },
      spot: n.spot.map((s) => ({ f: s.f, output_v_per_rthz: r(s.output_density), input_per_rthz: r(s.input_density) })),
      contributors: n.contributors.map((x) => ({ device: x.device, vrms: r(x.rms), share_of_power: r(x.share, 4), parts: x.parts.map((p) => ({ ...p, rms: r(p.rms) })) })),
      ...(pass !== null ? { pass, spec_rms: a.spec_rms } : {}),
      note: 'pp estimate = 6.6 x rms (Gaussian, exceeded 0.1 % of the time)',
    }
    rec.finish(pass === false ? 'fail' : 'pass', `noise ${a.fstart}-${a.fstop} Hz: ${(n.output_rms * 1e6).toPrecision(4)} uVrms out; top ${n.contributors[0]?.device ?? '-'}`, { output_noise_vrms: result.output_noise_vrms })
    return result
  },
})

// ------------------------------------------------------------------------------------------- ams.mixed

const DriveSchema = z.union([z.literal(0), z.literal(1), z.array(z.tuple([z.number().min(0), z.union([z.literal(0), z.literal(1)])])).min(1)])

export const mixedTool = defineTool({
  name: 'ams.mixed',
  description: 'Mixed-signal co-simulation in one ngspice transient: the analog netlist, an ideal behavioural ADC (floor((V(in)-V(ref))/LSB), XSPICE adc_bridge into the design, sampled at the design\'s clock edge; no S/H, latency or INL/DNL), and a Verilog design compiled by Verilator into a d_cosim library (ngspice 42+; two-state, cycle-based: Verilog # delays are not simulated). Outputs return through dac_bridge as v(<port>_code) vectors; returns per-clock samples, measurements and the build details. Without Verilator it runs the analog + ADC part only and says so (cosim: false). Recorded; returns run_id.',
  input: z.object({
    ...circuitInput,
    verilog: z.array(z.string()).min(1).describe('Verilog source files'),
    top: z.string().describe('the design\'s top module'),
    parameters: z.record(z.string(), z.union([z.number(), z.string()])).optional().describe('top-level parameters, e.g. {"WIDTH": 12}'),
    adc: z.object({
      input: z.string().describe('analog node converted, e.g. "adc_in"'),
      ref: z.string().optional().describe('reference node (default ground)'),
      bits: z.number().int().min(1).max(24),
      vref_v: z.number().positive().describe('full-scale voltage'),
      port: z.string().describe('the design input that takes the code, e.g. "sample"'),
    }).strict(),
    clock: z.object({ port: z.string(), freq_hz: z.number().positive() }).strict(),
    drive: z.record(z.string(), DriveSchema).optional().describe('other inputs: 0, 1, or [[t, level], ...] steps, e.g. {"valid": 1}; unlisted reset ports (rst, reset, rst_n…) are held active for reset_cycles, other unlisted inputs are tied 0'),
    reset_cycles: z.number().int().min(0).max(1000).optional().describe('default 2'),
    tstop: z.number().positive().describe('transient length (s)'),
    tstep: z.number().positive().optional().describe('default 1/50 of the clock period'),
    measurements: z.array(MeasureSpecSchema).optional().describe('on the tran results, e.g. [{"name":"avg_final","kind":"final","vector":"v(avg_code)"}]'),
    max_samples: z.number().int().min(0).max(5000).optional().describe('per-clock samples returned (default 40; all are stored as samples.csv)'),
    require_cosim: z.boolean().optional().describe('fail instead of falling back when Verilator is unavailable'),
  }),
  run: async (a) => {
    needNgspice()
    const c = readCircuit(a)
    const rec = new Recorder('ams.mixed', `${a.top} + ${c.subject}`, a)
    let lib: CosimLibrary | null = null
    let fallback: string | null = null
    try {
      if (!verilator() || !shimDir()) {
        fallback = !verilator() ? 'verilator is not installed' : 'the ngspice d_cosim shim sources are not installed'
        if (a.require_cosim) throw new ToolError(`co-simulation unavailable: ${fallback}`)
      } else {
        lib = await buildCosim(a.verilog.map((v) => resolve(v)), a.top, a.parameters ?? {})
        rec.artifact(`${'trace_cosim_top'}.v`, lib.wrapper)
        if (lib.log) rec.artifact('verilator.log', lib.log)
      }
    } catch (e) {
      if (e instanceof CosimError) {
        rec.fail(e)
        throw new ToolError(`co-simulation build failed: ${e.message}`)
      }
      throw rec.fail(e)
    }
    const spec = { adc: a.adc, clock: a.clock, drive: (a.drive ?? {}) as Record<string, Drive>, resetCycles: a.reset_cycles ?? 2, tstop: a.tstop, tstep: a.tstep }
    let run: SpiceRun
    let net: ReturnType<typeof mixedNetlist>
    try {
      net = mixedNetlist(splitNetlist(c.text).body, spec, lib)
      run = await simulate({ ...baseOptions(c, a), netlist: net.netlist, analyses: [net.analysis] })
    } catch (e) {
      if (lib) rmSync(lib.dir, { recursive: true, force: true })
      if (e instanceof CosimError) {
        rec.fail(e)
        throw new ToolError(e.message)
      }
      if (e instanceof SpiceError) spiceFail(rec, e)
      throw rec.fail(e)
    }
    if (lib) rmSync(lib.dir, { recursive: true, force: true })
    rec.artifact('netlist.cir', run.netlist)
    rec.artifact('ngspice.log', run.log)
    for (const [k, text] of run.raw) rec.artifact(`${k}.raw`, text)
    const tran = run.plots.find((p) => p.kind === 'tran')
    if (!tran) throw new ToolError('ngspice wrote no transient results')
    const t = tran.vectors.get('time') ?? []
    const atEdge: Record<string, number[]> = {}
    const after: Record<string, number[]> = {}
    const add = (to: Record<string, number[]>, label: string, name: string): void => {
      const v = vectorOf(tran, name)
      if (v) to[label] = v
    }
    add(atEdge, 'adc_in_v', `v(${a.adc.input})`)
    add(atEdge, 'adc_code', 'v(adc_code)')
    for (const o of net.outputs) add(after, o.port, o.vector)
    const samples = clockSamples(t, atEdge, after, net.period, net.edge, a.tstop).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, k === 'adc_in_v' || k === 't' ? round(v) : Math.round(v)])))
    rec.artifact('samples.csv', csv(samples), 'text/csv')
    const ms = measureRun(run, (a.measurements ?? []) as MeasureSpec[])
    rec.measurements(ms)
    const maxS = a.max_samples ?? 40
    const result = {
      run_id: rec.id,
      cosim: lib !== null,
      ...(fallback ? { limitation: `${fallback}: the Verilog design was NOT simulated; only the analog netlist and the ADC ran (install verilator for d_cosim)` } : {}),
      ...(lib ? { library: { cached: lib.cached, ports: lib.ports.map((p) => `${p.dir} ${p.name}${p.msb || p.lsb ? `[${p.msb}:${p.lsb}]` : ''}`), d_cosim_order: 'inputs then outputs, Vlng.h order, MSB first' } } : {}),
      outputs: net.outputs.map((o) => o.vector),
      ...(net.tied.length ? { tied_low: net.tied } : {}),
      ...(net.resets.length ? { resets: net.resets, reset_cycles: spec.resetCycles } : {}),
      measurements: ms.map((m) => ({ ...m, value: r(m.value) })),
      samples: samples.length > maxS ? [...samples.slice(0, Math.ceil(maxS / 2)), ...samples.slice(-Math.floor(maxS / 2))] : samples,
      sample_count: samples.length,
      sampled: 'one row per rising clock edge: ADC input and code at the edge, design outputs half a period later',
      ...(run.warnings.length ? { warnings: run.warnings.slice(0, 10) } : {}),
    }
    const failed = ms.some((m) => m.value === null)
    rec.finish(failed ? 'fail' : 'pass', `${a.top}: ${lib ? 'd_cosim' : 'analog+ADC only'}, ${samples.length} clock samples${ms.length ? `, ${ms.slice(0, 3).map((m) => `${m.name}=${m.value === null ? '—' : round(m.value, 5)}`).join(', ')}` : ''}`, { cosim: result.cosim, measurements: result.measurements })
    return result
  },
})

export const tools: AnyTool[] = [specTool, cornersTool, yieldTool, opampTool, noiseTool, mixedTool] as unknown as AnyTool[]

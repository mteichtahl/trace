/**
 * The FPGA implementation tools, for the Implementation agent (see ./flow.ts for the flow itself):
 *
 *   fpga.synth      yosys synthesis for ice40 / ecp5 / gowin / xilinx (generic synth_xilinx): cell counts by type and
 *                   by resource; the netlist is kept (gzipped) as an artifact for fpga.pnr
 *   fpga.pnr        nextpnr place and route with PCF / LPF / CST constraints, a seed, placer, per-clock targets and
 *                   floorplan regions; Fmax per clock against its target, the critical paths, device utilisation
 *   fpga.timing     the structured timing summary of a pnr run (or a nextpnr report.json): per-clock closure status,
 *                   slack, margin, and where the critical paths spend their time (logic, routing, setup)
 *   fpga.closure    the same place and route over several seeds and/or placer options, run by a fixed rule (no model),
 *                   reporting every attempt and keeping the best: timing closed first, then the largest worst slack
 *   fpga.bitstream  icepack / ecppack / gowin_pack on a pnr run's output (or a file)
 *
 * Each records a run and returns its run_id; large outputs (netlist JSON, .asc, .config) are stored gzipped
 * (`<name>.gz`), and written to out_dir as well when it is given.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { defineTool, ToolError, type AnyTool } from '../../core/registry.js'
import { Work, type Json } from '../../core/store.js'
import { mapLimit } from '../../sim/proc.js'
import { Recorder } from '../../sim/record.js'
import { tail } from '../verify/job.js'
import { FAMILIES, gunzip, gz, pack, placeAndRoute, PNR_OUTPUT, RegionSchema, synthesize, timingFromReport, type PnrOptions, type PnrRun, type Timing } from './flow.js'

const Defines = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
const PnrFamily = z.enum(['ice40', 'ecp5', 'gowin'])

/** A stored artifact of an earlier run written to a temporary file (gunzipped when stored as <name>.gz). */
function artifactFile(runId: string, name: string, dir: string): string {
  const w = new Work()
  try {
    const rec = w.run(runId)
    if (!rec) throw new ToolError(`no run ${runId}`)
    const raw = w.getArtifact(runId, `${name}.gz`)
    const plain = raw ? gunzip(raw) : w.getArtifact(runId, name)
    if (!plain) throw new ToolError(`run ${runId} (${rec.kind}) has no ${name} (it has: ${rec.artifacts.map((a) => a.name).join(', ') || 'none'})`)
    const p = join(dir, name)
    writeFileSync(p, plain)
    return p
  } finally {
    w.close()
  }
}

function runKind(runId: string): string | null {
  const w = new Work()
  try {
    return w.run(runId)?.kind ?? null
  } finally {
    w.close()
  }
}

function writeOut(dir: string | undefined, name: string, data: Uint8Array | string): string | null {
  if (!dir) return null
  const d = resolve(dir)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, name), data)
  return join(d, name)
}

// ------------------------------------------------------------------ fpga.synth

export const synthTool = defineTool({
  name: 'fpga.synth',
  description: 'Yosys synthesis for an FPGA family (ice40 synth_ice40, ecp5 synth_ecp5, gowin synth_gowin, xilinx synth_xilinx): cell counts by type and by resource (lut, ff, carry, bram, dsp, io, pll, …), warnings. The netlist JSON is stored for fpga.pnr (synth_run); device percentages come from fpga.pnr. Returns run_id.',
  input: z.object({
    family: z.enum(FAMILIES),
    files: z.array(z.string()).min(1).describe('Verilog/SystemVerilog sources'),
    top: z.string(),
    include_dirs: z.array(z.string()).optional(),
    defines: Defines.optional(),
    parameters: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe('top-level parameters (chparam)'),
    options: z.array(z.string()).default([]).describe('extra synth_<family> flags, e.g. ["-dsp"] (ice40 UP5K multipliers), ["-abc9"]'),
    xilinx_family: z.string().optional().describe('xilinx: synth_xilinx -family (default xc7)'),
    out_dir: z.string().optional().describe('also write netlist.json (and netlist.edif for xilinx) here'),
    timeout_s: z.number().positive().max(6 * 3600).default(1800),
  }),
  run: async (a) => {
    const rec = new Recorder('fpga.synth', `${a.family}:${a.top}`, a)
    try {
      const r = await synthesize(a)
      rec.artifact('yosys.log', tail(r.log, 2_000_000))
      if (r.statText) rec.artifact('stat.txt', r.statText)
      if (r.netlist) rec.artifact('netlist.json.gz', gz(r.netlist), 'application/gzip')
      if (r.edif) rec.artifact('netlist.edif.gz', gz(r.edif), 'application/gzip')
      for (const [k, n] of Object.entries(r.utilisation?.resources ?? {})) rec.measure(`cells.${k}`, n)
      if (r.utilisation) rec.measure('cells', r.utilisation.cells)
      const written = [r.netlist ? writeOut(a.out_dir, 'netlist.json', r.netlist) : null, r.edif ? writeOut(a.out_dir, 'netlist.edif', r.edif) : null].filter(Boolean)
      rec.finish(r.ok ? 'pass' : 'fail', `${a.top} (${a.family}): ${r.reason}`, { ok: r.ok, utilisation: r.utilisation as unknown as Json })
      return {
        run_id: rec.id, passed: r.ok, reason: r.reason, family: a.family, top: a.top, utilisation: r.utilisation,
        warnings: r.warnings.slice(0, 30), warning_count: r.warnings.length, ...(written.length ? { written } : {}),
        where: r.where, seconds: Math.round(r.seconds * 10) / 10,
      }
    } catch (e) {
      throw rec.fail(e)
    }
  },
})

// ------------------------------------------------------------------ fpga.pnr

const pnrInput = {
  family: PnrFamily,
  device: z.string().describe('ice40: up5k, hx8k, …; ecp5: 25k, 45k, 85k, um5g-85k, …; gowin: the part, e.g. GW1NR-LV9QN88PC6/I5'),
  package: z.string().optional().describe('ice40/ecp5 package, e.g. sg48, CABGA381'),
  gowin_family: z.string().optional().describe('gowin: GW1N-9C, GW2A-18C, …'),
  synth_run: z.string().optional().describe('the fpga.synth run whose netlist to place'),
  netlist: z.string().optional().describe('or a yosys netlist JSON file'),
  constraints: z.string().optional().describe('the pin constraints: .pcf (ice40), .lpf (ecp5), .cst (gowin)'),
  allow_unconstrained: z.boolean().default(false).describe('let the placer choose pins that have no constraint'),
  freq_mhz: z.number().positive().optional().describe('target for every clock (nextpnr --freq)'),
  clocks: z.record(z.string(), z.number().positive()).optional().describe('per-clock targets in MHz, by net name: {"clk": 48}'),
  placer: z.string().optional().describe('heap or sa'),
  regions: z.array(RegionSchema).optional().describe('floorplan: [{"name":"filt","x0":1,"y0":1,"x1":8,"y1":8,"cells":["u_filt*"]}]'),
  extra_args: z.array(z.string()).default([]).describe('more nextpnr flags, e.g. ["--opt-timing"]'),
  timeout_s: z.number().positive().max(12 * 3600).default(3600),
}

function netlistOf(a: { synth_run?: string | undefined; netlist?: string | undefined }, dir: string): string {
  if ((a.synth_run === undefined) === (a.netlist === undefined)) throw new ToolError('give synth_run or netlist')
  if (a.netlist) return resolve(a.netlist)
  return artifactFile(a.synth_run as string, 'netlist.json', dir)
}

function pnrOptions(a: { family: PnrOptions['family']; device: string; package?: string | undefined; gowin_family?: string | undefined; constraints?: string | undefined; allow_unconstrained: boolean; freq_mhz?: number | undefined; clocks?: Record<string, number> | undefined; regions?: PnrOptions['regions']; extra_args: string[]; timeout_s: number }, netlist: string, seed: number, placer: string | undefined): PnrOptions {
  return { family: a.family, device: a.device, package: a.package, gowin_family: a.gowin_family, netlist, constraints: a.constraints, allow_unconstrained: a.allow_unconstrained, freq_mhz: a.freq_mhz, clocks: a.clocks, seed, placer, regions: a.regions, extra_args: a.extra_args, timeout_s: a.timeout_s }
}

function storePnr(rec: Recorder, r: PnrRun): void {
  rec.artifact('nextpnr.log', tail(r.log, 4_000_000))
  if (r.report) rec.artifact('report.json', r.report, 'application/json')
  if (r.output) rec.artifact(`${r.output.name}.gz`, gz(r.output.bytes), 'application/gzip')
  for (const c of r.timing?.clocks ?? []) {
    rec.measure(`fmax.${c.clock}`, c.achieved_mhz, 'MHz', { target_mhz: c.target_mhz, status: c.status })
    if (c.slack_ns !== null) rec.measure(`slack.${c.clock}`, c.slack_ns, 'ns')
  }
  for (const [k, u] of Object.entries(r.utilisation)) if (u.used) rec.measure(`util.${k}`, u.used, '', { available: u.available, percent: u.percent })
}

const compactTiming = (t: Timing | null, paths: number): unknown => t && { ...t, critical_paths: t.critical_paths.slice(0, paths) }

export const pnrTool = defineTool({
  name: 'fpga.pnr',
  description: 'nextpnr place and route (ice40, ecp5, gowin via himbaechel or nextpnr-gowin) of a synthesized netlist with PCF/LPF/CST constraints, a seed, optional placer, per-clock targets and floorplan regions. Returns timing per clock (achieved Fmax vs target, slack, met/failed), the critical paths (logic vs routing delay, worst nets), device utilisation, and stores the routed output for fpga.bitstream. Runs with --timing-allow-fail: closure is judged from the report. Returns run_id.',
  input: z.object({
    ...pnrInput,
    seed: z.number().int().min(0).default(1),
    max_paths: z.number().int().min(0).max(50).default(3),
    out_dir: z.string().optional().describe('also write the routed output and report.json here'),
  }),
  run: async (a) => {
    const tmp = mkdtempSync(join(tmpdir(), 'trace-fpga-'))
    const rec = new Recorder('fpga.pnr', `${a.family}:${a.device}`, a)
    try {
      const r = await placeAndRoute(pnrOptions(a, netlistOf(a, tmp), a.seed, a.placer))
      storePnr(rec, r)
      const written = [r.output ? writeOut(a.out_dir, r.output.name, r.output.bytes) : null, r.report ? writeOut(a.out_dir, 'report.json', r.report) : null].filter(Boolean)
      const passed = r.ok && r.timing?.closure !== 'failing'
      rec.finish(passed ? 'pass' : 'fail', r.reason, { ok: r.ok, closure: r.timing?.closure ?? null, clocks: (r.timing?.clocks ?? []) as unknown as Json })
      return {
        run_id: rec.id, passed, reason: r.reason, routed: r.ok, program: r.program, seed: a.seed,
        timing: compactTiming(r.timing, a.max_paths), utilisation: r.utilisation, ...(Object.keys(r.regions).length ? { regions_constrained: r.regions } : {}),
        warnings: r.warnings.slice(0, 20), warning_count: r.warnings.length, output: r.output ? { artifact: `${r.output.name}.gz`, bytes: r.output.bytes.length } : null,
        ...(written.length ? { written } : {}), where: r.where, seconds: Math.round(r.seconds * 10) / 10,
      }
    } catch (e) {
      throw rec.fail(e)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  },
})

// ------------------------------------------------------------------ fpga.timing

export const timingTool = defineTool({
  name: 'fpga.timing',
  description: 'Structured timing summary of a place and route: per clock the achieved Fmax, target, slack and margin, and a closure status (met / failed / unconstrained), the overall closure (closed / failing / unconstrained), the worst slack, and the critical paths split into logic, routing and setup delay with their worst nets. From an fpga.pnr or fpga.closure run, or a nextpnr report.json.',
  input: z.object({
    run_id: z.string().optional().describe('an fpga.pnr / fpga.closure run'),
    report: z.string().optional().describe('or a nextpnr --report JSON file'),
    targets: z.record(z.string(), z.number().positive()).optional().describe('targets in MHz by clock, overriding the report\'s constraints'),
    max_paths: z.number().int().min(0).max(100).default(5),
  }),
  run: (a) => {
    if ((a.run_id === undefined) === (a.report === undefined)) throw new ToolError('give run_id or report')
    const tmp = mkdtempSync(join(tmpdir(), 'trace-fpga-'))
    try {
      const path = a.report ? resolve(a.report) : artifactFile(a.run_id as string, 'report.json', tmp)
      let text: string
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        throw new ToolError(`cannot read ${path}`)
      }
      const t = timingFromReport(text, { targets: a.targets })
      if (!t) throw new ToolError(`${a.report ?? `run ${a.run_id}`}: not a nextpnr timing report`)
      const failing = t.clocks.filter((c) => c.status === 'failed')
      return {
        ...(a.run_id ? { run_id: a.run_id } : {}), closure: t.closure, worst_slack_ns: t.worst_slack_ns, clocks: t.clocks,
        critical_paths: t.critical_paths.slice(0, a.max_paths),
        summary: t.closure === 'closed' ? `timing closed on ${t.clocks.length} clock(s), worst slack ${t.worst_slack_ns} ns`
          : t.closure === 'failing' ? `failing: ${failing.map((c) => `${c.clock} ${c.achieved_mhz}/${c.target_mhz} MHz (${c.slack_ns} ns)`).join(', ')}`
            : 'no clock has a target: give freq_mhz or clocks to fpga.pnr, or targets here',
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  },
})

// ------------------------------------------------------------------ fpga.closure

interface Attempt { seed: number; placer: string | null; args: string[]; closure: string | null; worst_slack_ns: number | null; clocks: { clock: string; achieved_mhz: number; target_mhz: number | null }[]; routed: boolean; reason: string; seconds: number }

/** Higher is better: routed, then closed, then worst slack (or, unconstrained, the slowest clock's Fmax). */
export function attemptScore(a: Pick<Attempt, 'routed' | 'closure' | 'worst_slack_ns' | 'clocks'>): number[] {
  return [a.routed ? 1 : 0, a.closure === 'closed' ? 1 : 0, a.worst_slack_ns ?? (a.clocks.length ? Math.min(...a.clocks.map((c) => c.achieved_mhz)) : -Infinity)]
}

const better = (x: number[], y: number[]): boolean => {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const a = x[i] ?? -Infinity
    const b = y[i] ?? -Infinity
    if (a !== b) return a > b
  }
  return false
}

export const closureTool = defineTool({
  name: 'fpga.closure',
  description: 'Timing closure by a fixed search (no model): place and route the same netlist for each seed × placer × extra-argument variant, in a set order, and keep the best attempt (routed, then timing closed, then largest worst slack). Every attempt is reported; the best one\'s routed output and report are stored (for fpga.timing and fpga.bitstream). Optionally stops at the first attempt that closes. Returns run_id.',
  input: z.object({
    ...pnrInput,
    seeds: z.array(z.number().int().min(0)).optional().describe('seeds to try (default 1..seed_count)'),
    seed_count: z.number().int().min(1).max(200).default(8),
    placers: z.array(z.string()).optional().describe('placers to try, e.g. ["heap", "sa"] (default: nextpnr\'s own)'),
    variants: z.array(z.array(z.string())).optional().describe('extra-argument sets to try, e.g. [[], ["--opt-timing"]]'),
    stop_when_closed: z.boolean().default(false),
    concurrency: z.number().int().min(1).max(64).default(2).describe('attempts run at once'),
    max_paths: z.number().int().min(0).max(50).default(3),
    out_dir: z.string().optional(),
  }),
  run: async (a) => {
    const tmp = mkdtempSync(join(tmpdir(), 'trace-fpga-'))
    const rec = new Recorder('fpga.closure', `${a.family}:${a.device}`, a)
    try {
      const net = netlistOf(a, tmp)
      const seeds = a.seeds?.length ? a.seeds : Array.from({ length: a.seed_count }, (_, i) => i + 1)
      const placers: (string | undefined)[] = a.placers?.length ? a.placers : [a.placer]
      const variants = a.variants?.length ? a.variants : [[]]
      const combos = variants.flatMap((v) => placers.flatMap((p) => seeds.map((s) => ({ seed: s, placer: p, args: v }))))
      if (combos.length > 500) throw new ToolError(`${combos.length} attempts: at most 500`)
      let closedAt = Infinity
      const results = await mapLimit(combos, a.concurrency, async (c, i) => {
        if (a.stop_when_closed && i > closedAt) return null
        const r = await placeAndRoute(pnrOptions({ ...a, extra_args: [...a.extra_args, ...c.args] }, net, c.seed, c.placer))
        const at: Attempt = {
          seed: c.seed, placer: c.placer ?? null, args: c.args, closure: r.timing?.closure ?? null, worst_slack_ns: r.timing?.worst_slack_ns ?? null,
          clocks: (r.timing?.clocks ?? []).map((k) => ({ clock: k.clock, achieved_mhz: k.achieved_mhz, target_mhz: k.target_mhz })), routed: r.ok, reason: r.reason, seconds: Math.round(r.seconds * 10) / 10,
        }
        if (at.closure === 'closed') closedAt = Math.min(closedAt, i)
        return { at, run: r, index: i }
      })
      // with stop_when_closed, attempts after the first that closed are dropped even when they ran (concurrency), so
      // the answer is the same however the jobs interleave; ties go to the earlier attempt
      const kept = results.filter((x): x is { at: Attempt; run: PnrRun; index: number } => x !== null && (!a.stop_when_closed || x.index <= closedAt))
      let b: { score: number[]; run: PnrRun; attempt: Attempt } | null = null
      for (const x of kept) {
        const score = attemptScore(x.at)
        if (!b || better(score, b.score)) b = { score, run: x.run, attempt: x.at }
      }
      const done = kept.map((x) => x.at)
      if (!b) throw new ToolError('no attempt ran')
      storePnr(rec, b.run)
      const written = [b.run.output ? writeOut(a.out_dir, b.run.output.name, b.run.output.bytes) : null, b.run.report ? writeOut(a.out_dir, 'report.json', b.run.report) : null].filter(Boolean)
      const closed = done.filter((x) => x.closure === 'closed').length
      const summary = `best: seed ${b.attempt.seed}${b.attempt.placer ? `, ${b.attempt.placer}` : ''}${b.attempt.args.length ? `, ${b.attempt.args.join(' ')}` : ''}: ${b.run.reason}; ${closed}/${done.length} attempts closed`
      const passed = b.run.ok && b.run.timing?.closure !== 'failing'
      rec.measure('attempts', done.length)
      rec.measure('attempts.closed', closed)
      rec.artifact('attempts.json', JSON.stringify(done, null, 1), 'application/json')
      rec.finish(passed ? 'pass' : 'fail', summary, { best: b.attempt as unknown as Json, closed, attempts: done.length })
      return {
        run_id: rec.id, passed, summary, best: { ...b.attempt, timing: compactTiming(b.run.timing, a.max_paths), utilisation: b.run.utilisation },
        attempts: done, closed, output: b.run.output ? { artifact: `${b.run.output.name}.gz`, bytes: b.run.output.bytes.length } : null,
        ...(written.length ? { written } : {}),
      }
    } catch (e) {
      throw rec.fail(e)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  },
})

// ------------------------------------------------------------------ fpga.bitstream

export const bitstreamTool = defineTool({
  name: 'fpga.bitstream',
  description: 'Pack a routed design into a bitstream: icepack (ice40 .asc → .bin), ecppack (ecp5 .config → .bit, optionally compressed), gowin_pack (gowin pnr JSON → .fs). From an fpga.pnr / fpga.closure run or a file. The bitstream is stored as an artifact and written to out when given. Returns run_id.',
  input: z.object({
    family: PnrFamily,
    run_id: z.string().optional().describe('the fpga.pnr or fpga.closure run'),
    input: z.string().optional().describe('or the routed file (.asc, .config, pnr .json)'),
    gowin_family: z.string().optional().describe('gowin: e.g. GW1N-9C'),
    compress: z.boolean().default(false),
    extra_args: z.array(z.string()).default([]),
    out: z.string().optional().describe('write the bitstream to this path'),
    timeout_s: z.number().positive().max(3600).default(600),
  }),
  run: async (a) => {
    if ((a.run_id === undefined) === (a.input === undefined)) throw new ToolError('give run_id or input')
    const tmp = mkdtempSync(join(tmpdir(), 'trace-fpga-'))
    const rec = new Recorder('fpga.bitstream', a.family, a)
    try {
      if (a.run_id) {
        const k = runKind(a.run_id)
        if (k !== 'fpga.pnr' && k !== 'fpga.closure') throw new ToolError(`run ${a.run_id} is ${k ?? 'missing'}, not an fpga.pnr or fpga.closure run`)
      }
      const input = a.input ? resolve(a.input) : artifactFile(a.run_id as string, PNR_OUTPUT[a.family], tmp)
      const r = await pack({ family: a.family, input, gowin_family: a.gowin_family, compress: a.compress, extra_args: a.extra_args, timeout_s: a.timeout_s })
      if (r.log.trim()) rec.artifact('pack.log', tail(r.log, 200_000))
      if (r.bitstream) rec.artifact(r.name, r.bitstream, 'application/octet-stream')
      let written: string | null = null
      if (a.out && r.bitstream) {
        const p = resolve(a.out)
        mkdirSync(join(p, '..'), { recursive: true })
        writeFileSync(p, r.bitstream)
        written = p
      }
      rec.finish(r.ok ? 'pass' : 'fail', r.reason, { ok: r.ok })
      return { run_id: rec.id, passed: r.ok, reason: r.reason, artifact: r.bitstream ? r.name : null, bytes: r.bitstream?.length ?? 0, ...(written ? { written } : {}), where: r.where }
    } catch (e) {
      throw rec.fail(e)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  },
})

export const tools: AnyTool[] = [synthTool, pnrTool, timingTool, closureTool, bitstreamTool] as unknown as AnyTool[]

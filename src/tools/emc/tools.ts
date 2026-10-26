/**
 * The EMC and field-simulation tools (emc.*), for the EMC/Simulation agent.
 *
 *   emc.spectrum   closed forms only (spectrum.ts, limits.ts)
 *   emc.precheck   rules on the board's geometry (precheck.ts), no solver
 *   emc.setup      an openEMS model of a board region (setup.ts), written as one Python script
 *   emc.run        runs that model through runJob, kind openems (python/emc/openems_model.py)
 *   emc.si         Touchstone post-processing with scikit-rf (python/emc/si.py)
 *
 * Solver: openEMS (FDTD, multithreaded CPU, its Python interface over CSXCAD), built and tested against openEMS
 * v0.37.0 / CSXCAD 0.7.0; scikit-rf 2.2.0.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'

import { defineTool, ToolError, type AnyTool } from '../../core/registry.js'
import { scratchDir, Work } from '../../core/store.js'
import { runJob, backendFor } from '../../gpu/jobs.js'
import { run as runProc } from '../sim/proc.js'
import { readArtifact, Recorder } from '../sim/record.js'
import { readGeometry } from './board.js'
import { cisprLimit, CISPR_SOURCE, type CisprClass } from './limits.js'
import { canImport, expectResult, openemsPython, openemsRuns, openemsSpeed, siPython } from './python.js'
import { CLOCKISH, SWITCHING } from './board.js'
import { DEFAULTS, precheck, RULES, type PrecheckOptions, type Rule } from './precheck.js'
import { buildModel, modelScript, pythonDir, SetupError, type SetupInput, type Summary } from './setup.js'
import {
  cmCurrentFor, cmField, dBuA, dBuV, dmField, fromdBuV, envelope, envelopeCorners, farField, harmonic, harmonics, peakToRms, type Trapezoid,
} from './spectrum.js'

const r = (v: number | null | undefined, d = 5): number | null => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toPrecision(d)))

const Cls = z.enum(['A', 'B'])

const Signal = z.object({
  amplitude: z.number().positive().describe('pulse amplitude, 0 to peak (V, or A with unit "A")'),
  unit: z.enum(['V', 'A']).optional().describe('default V'),
  freq_hz: z.number().positive(),
  rise_s: z.number().positive().describe('10-90 % rise time'),
  fall_s: z.number().positive().optional(),
  duty: z.number().gt(0).lt(1).optional().describe('default 0.5'),
  impedance_ohm: z.number().positive().optional().describe('V to A for the radiation estimates: I = V / Z (default 50)'),
}).strict()

// ------------------------------------------------------------------------------------------- emc.spectrum

export const spectrumTool = defineTool({
  name: 'emc.spectrum',
  description: 'EMI closed forms, no solver: trapezoidal pulse-train harmonics and envelope (Paul, Introduction to EMC, §3.2: 2Ad, -20 dB/dec from 1/(pi tau), -40 dB/dec from 1/(pi tr)); differential-mode loop radiation E = 1.316e-14 f² A I / r and common-mode wire radiation E = 6.283e-7 f L I / r (Ott, EMC Engineering 2009, §12.1-12.2; x2 with ground reflection; L capped at lambda/2), the cable common-mode current that meets a limit, all against CISPR 32 class A/B at the given distance. Far-field, maximum-over-angle estimates for pre-compliance, not predictions of a test result.',
  input: z.object({
    signal: Signal.optional().describe('a trapezoidal pulse train: its harmonics drive the estimates'),
    frequency_hz: z.number().positive().optional().describe('or one frequency (with dm.current_a / cm.current_ua)'),
    fmin: z.number().positive().optional().describe('default 30 MHz'),
    fmax: z.number().positive().optional().describe('default 1 GHz'),
    max_harmonics: z.number().int().min(1).max(5000).optional().describe('harmonics returned (default 40, strongest margins first when limits apply)'),
    dm: z.object({ loop_area_mm2: z.number().positive(), current_a: z.number().positive().optional().describe('with frequency_hz') }).strict().optional(),
    cm: z.object({ cable_length_m: z.number().positive(), current_ua: z.number().positive().optional().describe('common-mode current, with frequency_hz; or the signal\'s current scaled by cm_fraction'), cm_fraction: z.number().gt(0).max(1).optional() }).strict().optional(),
    distance_m: z.number().positive().optional().describe('default 3'),
    cispr_class: Cls.optional().describe('default B'),
    ground_reflection: z.boolean().optional().describe('x2 (6 dB) for a reflecting ground, as on a test site (default true)'),
  }),
  run: (a) => {
    const dist = a.distance_m ?? 3
    const cls = a.cispr_class ?? 'B'
    const gr = a.ground_reflection ?? true
    const out: Record<string, unknown> = { distance_m: dist, cispr_class: cls, ground_reflection: gr, limits: CISPR_SOURCE }
    const fmin = a.fmin ?? 30e6
    const fmax = a.fmax ?? 1e9
    const evalAt = (f: number, iAmp: number | null): Record<string, unknown> => {
      const lim = cisprLimit(cls, f, dist)
      const row: Record<string, unknown> = { f_hz: r(f), ...(lim ? { limit_dbuv_m: r(lim.db_uv_m, 4) } : {}), ...(farField(f, dist) ? {} : { near_field: true }) }
      if (a.dm && iAmp !== null) {
        const e = dBuV(peakToRms(dmField(f, a.dm.loop_area_mm2 * 1e-6, iAmp, dist, gr)))
        row.dm_dbuv_m = r(e, 4)
        if (lim) row.dm_margin_db = r(lim.db_uv_m - e, 4)
      }
      if (a.cm) {
        const icm = a.cm.current_ua !== undefined ? a.cm.current_ua * 1e-6 * Math.SQRT2 : iAmp !== null ? iAmp * (a.cm.cm_fraction ?? 1) : null
        if (icm !== null) {
          const c = cmField(f, a.cm.cable_length_m, icm, dist, gr)
          const e = dBuV(peakToRms(c.e))
          row.cm_dbuv_m = r(e, 4)
          if (lim) row.cm_margin_db = r(lim.db_uv_m - e, 4)
          if (c.capped) row.cm_length_capped_m = r(c.length_used, 4)
        }
        if (lim) row.cm_max_current_ua_rms = r(cmCurrentFor(f, a.cm.cable_length_m, fromdBuV(lim.db_uv_m), dist, gr) * 1e6, 4)
      }
      return row
    }
    if (a.signal) {
      const s = a.signal
      const p: Trapezoid = { amplitude: s.amplitude, freq: s.freq_hz, duty: s.duty, rise: s.rise_s, fall: s.fall_s }
      let corners: ReturnType<typeof envelopeCorners>
      try {
        corners = envelopeCorners(p)
      } catch (e) {
        throw new ToolError((e as Error).message)
      }
      const toI = (v: number): number => (s.unit === 'A' ? v : v / (s.impedance_ohm ?? 50))
      const hs = harmonics(p, fmin, fmax, 100_000)
      const unit = s.unit ?? 'V'
      const rows = hs.map((h) => ({
        n: h.n, ...evalAt(h.f, toI(h.amplitude)), amplitude: r(h.amplitude), envelope: r(h.envelope),
        [unit === 'V' ? 'dbuv' : 'dbua']: r(unit === 'V' ? dBuV(peakToRms(h.amplitude)) : dBuA(peakToRms(h.amplitude)), 4),
      }))
      const margin = (x: Record<string, unknown>): number => Math.min(Number(x.dm_margin_db ?? Infinity), Number(x.cm_margin_db ?? Infinity))
      const limited = rows.some((x) => Number.isFinite(margin(x)))
      const shown = limited ? [...rows].sort((x, y) => margin(x) - margin(y)) : rows
      const max = a.max_harmonics ?? 40
      out.envelope = { low_amplitude: r(corners.low), f1_hz: r(corners.f1), f2_hz: r(corners.f2), unit, transition_used_s: r(Math.min(s.rise_s, s.fall_s ?? s.rise_s) / 0.8), note: 'trapezoid tr is the 0-100 % edge, taken as the 10-90 % rise / 0.8; unequal edges use the faster' }
      out.harmonics = shown.slice(0, max)
      out.harmonic_count = rows.length
      if (limited) {
        const w = shown[0] as Record<string, unknown>
        out.worst = w
        out.pass = margin(w) >= 0
      }
      return out
    }
    if (a.frequency_hz === undefined) throw new ToolError('give signal, or frequency_hz with dm.current_a / cm.current_ua')
    const row = evalAt(a.frequency_hz, a.dm?.current_a ?? null)
    return { ...out, ...row, note: 'currents are amplitudes (peak) for dm.current_a, rms for cm.current_ua; fields are rms' }
  },
})

// ------------------------------------------------------------------------------------------- emc.precheck

export const precheckTool = defineTool({
  name: 'emc.precheck',
  description: 'Rule-based EMI precheck of a KiCad board from its geometry (no field solver): return-path gaps and plane-split crossings under signal tracks (zone fills sampled along each track), switching-node copper and hot-loop hull area, fast nets near the board edge, layer changes without a stitching via (or capacitor) for the reference, decoupling distance per IC power pin, and an edge-rate spectrum estimate (trapezoid harmonics, I = V/Z0, loop = length x height, Ott DM formula) against CISPR 32 for nets given in `edges` (pre-compliance estimate; common-mode radiation not included). Each finding has a location and its evidence; thresholds are guidelines with stated defaults. Recorded; returns run_id.',
  input: z.object({
    board: z.string().describe('.kicad_pcb path'),
    rules: z.array(z.enum(RULES as unknown as [Rule, ...Rule[]])).optional().describe('default all'),
    fast_nets: z.array(z.string()).optional().describe('nets treated as fast (default: clock-like names)'),
    switch_nets: z.array(z.string()).optional().describe('switching nodes (default: SW, LX, PHASE, HG/LG, GATE, BST… by name)'),
    reference_nets: z.array(z.string()).optional().describe('extra plane nets besides ground/power names'),
    edges: z.array(z.object({ net: z.string(), freq_hz: z.number().positive(), rise_s: z.number().positive(), amplitude_v: z.number().positive(), duty: z.number().gt(0).lt(1).optional() }).strict()).optional()
      .describe('for edge_spectrum: e.g. [{"net":"/SCK","freq_hz":8e6,"rise_s":2e-9,"amplitude_v":3.3}]'),
    edge_mm: z.number().positive().optional().describe(`default ${DEFAULTS.edgeMm}`),
    stitch_mm: z.number().positive().optional().describe(`default ${DEFAULTS.stitchMm}`),
    decap_mm: z.number().positive().optional().describe(`default ${DEFAULTS.decapMm}`),
    min_gap_mm: z.number().positive().optional().describe(`default ${DEFAULTS.minGapMm}`),
    antipad_mm: z.number().min(0).optional().describe(`default ${DEFAULTS.antipadMm}`),
    sample_mm: z.number().min(0.01).max(5).optional().describe(`default ${DEFAULTS.sampleMm}`),
    sw_copper_mm2: z.number().positive().optional(),
    sw_loop_mm2: z.number().positive().optional(),
    cispr_class: Cls.optional(),
    distance_m: z.number().positive().optional(),
    warn_margin_db: z.number().optional(),
    max_findings: z.number().int().min(1).max(5000).optional().describe('default 100 (all are stored)'),
  }),
  run: (a) => {
    const rec = new Recorder('emc.precheck', a.board, a)
    try {
      const g = readGeometry(resolve(a.board))
      const o: PrecheckOptions = {
        ...DEFAULTS, rules: a.rules ?? RULES, fastNets: a.fast_nets ?? [], fastPattern: CLOCKISH, switchNets: a.switch_nets ?? [], switchPattern: SWITCHING,
        referenceNets: a.reference_nets ?? [], edgeMm: a.edge_mm ?? DEFAULTS.edgeMm, stitchMm: a.stitch_mm ?? DEFAULTS.stitchMm, decapMm: a.decap_mm ?? DEFAULTS.decapMm,
        minGapMm: a.min_gap_mm ?? DEFAULTS.minGapMm, antipadMm: a.antipad_mm ?? DEFAULTS.antipadMm, sampleMm: a.sample_mm ?? DEFAULTS.sampleMm,
        swCopperMm2: a.sw_copper_mm2 ?? DEFAULTS.swCopperMm2, swLoopMm2: a.sw_loop_mm2 ?? DEFAULTS.swLoopMm2, edges: a.edges ?? [],
        cisprClass: (a.cispr_class ?? 'B') as CisprClass, distanceM: a.distance_m ?? 3, warnMarginDb: a.warn_margin_db ?? 6,
      }
      const rep = precheck(g, o)
      rec.artifact('findings.json', JSON.stringify(rep.findings, null, 1), 'application/json')
      for (const s of ['error', 'warn', 'info'] as const) rec.measure(`findings.${s}`, rep.counts[s])
      const max = a.max_findings ?? 100
      const result = {
        run_id: rec.id, counts: rep.counts, planes: rep.planes, notes: rep.notes,
        findings: rep.findings.slice(0, max), ...(rep.findings.length > max ? { truncated: `${rep.findings.length} findings, ${max} shown (all stored)` } : {}),
        ...(rep.spectrum.length ? { edge_spectrum: rep.spectrum } : {}),
      }
      rec.finish(rep.counts.error ? 'fail' : 'pass', `${rep.counts.error} errors, ${rep.counts.warn} warnings, ${rep.counts.info} notes`, { counts: rep.counts })
      return result
    } catch (e) {
      throw rec.fail(e)
    }
  },
})

// ------------------------------------------------------------------------------------------- emc.setup

const PortInput = z.object({
  name: z.string().optional(),
  at: z.union([z.string(), z.tuple([z.number(), z.number()])]).describe('a pad "R3.2", or [x, y] board mm'),
  layer: z.string().optional().describe('copper layer (default the pad\'s)'),
  ref_layer: z.string().optional().describe('reference plane layer (default the nearest layer with a reference zone)'),
  type: z.enum(['lumped', 'msl']).optional().describe('default lumped'),
  z0: z.number().positive().optional().describe('default 50'),
  direction: z.enum(['x+', 'x-', 'y+', 'y-']).optional().describe('msl: the direction the line runs into the structure'),
  length_mm: z.number().positive().optional().describe('msl feed length (default 5)'),
  width_mm: z.number().positive().optional(),
}).strict()

const SetupSchema = z.object({
  board: z.string().describe('.kicad_pcb path'),
  nets: z.array(z.string()).min(1).describe('nets to simulate, e.g. ["/ADC_IN"]'),
  reference_nets: z.array(z.string()).optional().describe('default: ground nets by name'),
  region: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).strict().optional().describe('board mm; default the nets\' copper + region_margin_mm'),
  region_margin_mm: z.number().min(0).optional(),
  include_other_copper: z.boolean().optional().describe('include every net\'s copper in the region (default only the nets and reference nets)'),
  ports: z.array(PortInput).min(1),
  fstart: z.number().positive().optional().describe('reporting start (Hz)'),
  fstop: z.number().positive().describe('highest frequency (Hz)'),
  points: z.number().int().min(16).max(20000).optional().describe('frequency points (default 500)'),
  cells_per_wavelength: z.number().min(5).max(100).optional().describe('default 20'),
  max_cell_mm: z.number().positive().optional(),
  fine_cell_mm: z.number().positive().optional().describe('override the fine cell (default min(lambda/(N sqrt(er)), narrowest track/2))'),
  cells_per_dielectric: z.number().int().min(1).max(50).optional().describe('default 4'),
  grading: z.number().min(1.05).max(2).optional().describe('cell growth outside the region (default 1.4)'),
  boundary: z.enum(['pml', 'mur']).optional().describe('default pml (PML_8)'),
  margin_mm: z.number().positive().optional().describe('structure to boundary (default chosen and reported)'),
  excite: z.enum(['all', 'first']).optional().describe('excite every port in turn for the full S-matrix (default), or only port 1'),
  radiated: z.object({
    frequencies: z.array(z.number().positive()).optional(),
    drive: z.object({ amplitude_v: z.number().positive(), freq_hz: z.number().positive(), rise_s: z.number().positive(), duty: z.number().gt(0).lt(1).optional() }).strict().optional(),
    distance_m: z.number().positive().optional().describe('default 3'),
    max_frequencies: z.number().int().min(1).max(64).optional().describe('default 12'),
  }).strict().optional().describe('far field by NF2FF: at these frequencies, or at the strongest harmonics of `drive`'),
  nr_ts: z.number().int().min(1000).max(1e8).optional(),
  end_criteria_db: z.number().max(-10).min(-100).optional().describe('default -40'),
  threads: z.number().int().min(0).max(512).optional().describe('openEMS threads (0 = all cores)'),
  keep_fields: z.boolean().optional(),
}).strict()

function setupInput(a: z.output<typeof SetupSchema>): SetupInput {
  return { ...a, board: resolve(a.board) }
}

async function validateLocally(script: string): Promise<{ ok: boolean; xml?: string; error?: string; skipped?: string }> {
  const py = openemsPython()
  if (!(await canImport(py, ['CSXCAD', 'openEMS']))) return { ok: false, skipped: `${py} cannot import CSXCAD/openEMS: the model was not built here` }
  const dir = scratchDir('trace-emc-build-')
  try {
    writeFileSync(join(dir, 'model.py'), script)
    const res = await runProc(py, [join(dir, 'model.py'), 'build', join(dir, 'out')], { cwd: dir, timeoutMs: 300_000 })
    try {
      expectResult(res.stdout, res.stderr, 'openEMS model build')
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    return { ok: true, xml: readFileSync(join(dir, 'out', 'model.xml'), 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const setupTool = defineTool({
  name: 'emc.setup',
  description: 'Build an openEMS (FDTD) model of a KiCad board region: the chosen nets\' and reference nets\' tracks, pads, vias and zone fills clipped to the region, the board\'s stackup as dielectric boxes (epsilon_r, loss tangent), lumped or MSL ports, PML_8 (or MUR) boundaries at a chosen margin, a graded rectilinear mesh, a Gaussian excitation to fstop, optional NF2FF far-field box. Deterministic. Writes the self-contained Python model (artifact model.py) and reports every choice: boundaries, margin, mesh size and cell count, timestep, estimated memory and run time (estimates, stated assumptions). Builds the CSX geometry locally to check it when openEMS is installed (artifact model.xml). Recorded; returns run_id for emc.run.',
  input: SetupSchema,
  run: async (a) => {
    const rec = new Recorder('emc.setup', `${a.board} ${a.nets.join(',')}`, a)
    try {
      let built: ReturnType<typeof buildModel>
      try {
        built = buildModel(setupInput(a))
      } catch (e) {
        if (e instanceof SetupError) throw new ToolError(e.message)
        throw e
      }
      const script = modelScript(built.model)
      rec.artifact('model.py', script, 'text/x-python')
      const v = await validateLocally(script)
      if (v.xml) rec.artifact('model.xml', v.xml, 'application/xml')
      const s = built.summary
      rec.measure('cells', s.mesh.cells)
      rec.measure('memory_mb_est', s.memory_mb_est, 'MB')
      rec.measure('time_s_est', s.time_s_est, 's')
      const result = {
        run_id: rec.id, summary: s,
        build: v.ok ? 'CSX geometry built with CSXCAD (model.xml stored)' : v.skipped ?? `failed: ${v.error}`,
        next: `emc.run setup_run_id=${rec.id}`,
      }
      if (v.error) {
        rec.finish('fail', `model build failed: ${v.error.slice(0, 200)}`, result)
        throw new ToolError(`the model was written (run ${rec.id}, model.py) but CSXCAD could not build it: ${v.error}`)
      }
      rec.finish('pass', `${s.mesh.cells.toLocaleString('en')} cells, ${s.ports.length} port(s), ${s.boundary.kind}, ~${s.memory_mb_est} MB`, result)
      return result
    } catch (e) {
      throw rec.fail(e)
    }
  },
})

// ------------------------------------------------------------------------------------------- emc.run

interface StoredSetup { summary: Summary; script: string }

function storedSetup(runId: string): StoredSetup {
  const w = new Work()
  try {
    const rec = w.run(runId)
    if (!rec || rec.kind !== 'emc.setup') throw new ToolError(`run ${runId} is not an emc.setup run`)
    const res = rec.result as { summary?: Summary } | null
    if (!res?.summary) throw new ToolError(`run ${runId} has no model summary (did it fail?)`)
    return { summary: res.summary, script: new TextDecoder().decode(readArtifact(runId, 'model.py')) }
  } finally {
    w.close()
  }
}

function sAt(freqs: readonly number[], re: readonly number[], im: readonly number[], f: number): number | null {
  if (f < (freqs[0] as number) || f > (freqs[freqs.length - 1] as number)) return null
  for (let i = 1; i < freqs.length; i++) {
    if (f <= (freqs[i] as number)) {
      const t = (f - (freqs[i - 1] as number)) / ((freqs[i] as number) - (freqs[i - 1] as number))
      const m0 = Math.hypot(re[i - 1] as number, im[i - 1] as number)
      const m1 = Math.hypot(re[i] as number, im[i] as number)
      return m0 + t * (m1 - m0)
    }
  }
  return null
}

const RunResult = z.object({
  freqs: z.array(z.number()),
  s: z.record(z.string(), z.object({ re: z.array(z.number().nullable()), im: z.array(z.number().nullable()) })),
  touchstone: z.string().optional(),
  tdr: z.array(z.object({ port: z.number(), t: z.array(z.number()).optional(), z: z.array(z.number()).optional(), d: z.array(z.number()).optional(), rise_s: z.number().optional(), error: z.string().optional() })),
  far_field: z.array(z.object({ f: z.number(), dmax: z.number(), prad_over_pinc: z.number().nullable(), e_peak_per_sqrt_w_inc: z.number().nullable(), radius_m: z.number() })).optional(),
  seconds: z.number(),
  excited: z.array(z.number()),
}).loose()

export const runTool = defineTool({
  name: 'emc.run',
  description: 'Run an emc.setup model with openEMS through runJob (kind openems; CPU, multithreaded): locally, or on the AWS Batch queue when TRACE_GPU_QUEUE is set and the model has more cells than TRACE_OPENEMS_LOCAL_MAX_CELLS (default 2e6) or openEMS is not installed here. Returns S-parameters (Touchstone artifact when every port was excited), insertion and return loss at the given frequencies, the TDR impedance profile per port (frequency-domain step response, resolution ~1/fstop), and for a radiated setup the far field from NF2FF scaled to the drive\'s harmonics from a matched 50-ohm source, as a dBuV/m PRE-COMPLIANCE ESTIMATE at the setup\'s distance (free space, and +6 dB for ground reflection) against CISPR 32 class A/B. FDTD accuracy is set by the mesh; see the setup summary. Recorded; returns run_id.',
  input: z.object({
    setup_run_id: z.string().describe('an emc.setup run'),
    frequencies: z.array(z.number().positive()).optional().describe('report IL/RL here (default 5 points over the band)'),
    drive: z.object({ amplitude_v: z.number().positive(), freq_hz: z.number().positive(), rise_s: z.number().positive(), duty: z.number().gt(0).lt(1).optional() }).strict().optional().describe('radiated: the signal driving port 1 (default the setup\'s radiated.drive)'),
    cispr_class: Cls.optional(),
    remote: z.enum(['auto', 'always', 'never']).optional().describe('default auto (by cell count)'),
    timeout_s: z.number().int().min(60).max(8 * 3600).optional().describe('default 7200'),
    max_points: z.number().int().min(10).max(5000).optional().describe('TDR profile points returned (default 200)'),
  }),
  run: async (a) => {
    const st = storedSetup(a.setup_run_id)
    const s = st.summary
    const rec = new Recorder('emc.run', a.setup_run_id, a)
    const dir = scratchDir('trace-emc-run-')
    try {
      writeFileSync(join(dir, 'model.py'), st.script)
      const threshold = Number(process.env.TRACE_OPENEMS_LOCAL_MAX_CELLS ?? 2e6)
      const mode = a.remote ?? 'auto'
      let wantRemote = mode === 'always' || (mode === 'auto' && s.mesh.cells > threshold)
      // a small model on a machine without openEMS (an AgentCore runtime) still goes to the queue when there is one
      if (!wantRemote && mode === 'auto' && process.env.TRACE_GPU_QUEUE && !(await canImport(openemsPython(), ['CSXCAD', 'openEMS']))) wantRemote = true
      const where = backendFor({ gpu: false, remote: wantRemote })
      const py = where === 'local' ? openemsPython() : 'openems-python'
      if (where === 'local' && !(await canImport(py, ['CSXCAD', 'openEMS']))) {
        throw new ToolError(`${py} cannot import openEMS/CSXCAD here${process.env.TRACE_GPU_QUEUE ? '' : ' (and TRACE_GPU_QUEUE is not set, so the queue cannot take it)'}: install openEMS with its Python modules and set TRACE_OPENEMS_PYTHON`)
      }
      const nports = s.ports.length
      const ts = `sparams.s${nports}p`
      const job = await runJob({
        kind: 'openems', argv: [py, '{in:model.py}', 'run', '{dir}/out'], inputs: { 'model.py': join(dir, 'model.py') },
        outputs: [ts, 'model.xml'], gpu: false, remote: wantRemote, timeoutSeconds: a.timeout_s ?? 7200,
      })
      const log = `${job.stdout}\n${job.stderr}`
      rec.artifact('openems.log', log.slice(-400_000))
      const raw = expectResult(job.stdout, job.stderr, 'openEMS')
      const res = RunResult.parse(raw)
      if (job.outputs[ts]) rec.artifact(ts, readFileSync(job.outputs[ts] as string), 'application/x-touchstone')
      if (job.outputs['model.xml']) rec.artifact('model.xml', readFileSync(job.outputs['model.xml'] as string), 'application/xml')
      const f = res.freqs
      const band = [s.frequencies.start, s.frequencies.stop]
      const at = a.frequencies ?? Array.from({ length: 5 }, (_, k) => Number((band[0] as number + (((band[1] as number) - (band[0] as number)) * k) / 4).toPrecision(6)))
      const col = (i: number, j: number): { re: number[]; im: number[] } | null => {
        const c = res.s[`S${i}${j}`]
        return c ? { re: c.re.map((v) => v ?? NaN), im: c.im.map((v) => v ?? NaN) } : null
      }
      const losses = at.map((fr) => {
        const row: Record<string, unknown> = { f_hz: fr }
        const s11 = col(1, 1)
        if (s11) {
          const m = sAt(f, s11.re, s11.im, fr)
          row.return_loss_db = m === null ? null : r(-20 * Math.log10(m), 4)
        }
        const s21 = col(2, 1)
        if (s21) {
          const m = sAt(f, s21.re, s21.im, fr)
          row.insertion_loss_db = m === null ? null : r(-20 * Math.log10(m), 4)
        }
        return row
      })
      for (const l of losses) {
        if (typeof l.return_loss_db === 'number') rec.measure(`rl_db@${l.f_hz}`, l.return_loss_db, 'dB')
        if (typeof l.insertion_loss_db === 'number') rec.measure(`il_db@${l.f_hz}`, l.insertion_loss_db, 'dB')
      }
      const maxPts = a.max_points ?? 200
      const tdr = res.tdr.map((t) => {
        if (t.error || !t.t || !t.z) return { port: t.port, error: t.error ?? 'no profile' }
        const skip = 2 * (t.rise_s ?? 0)
        const body = t.z.filter((_, k) => (t.t?.[k] ?? 0) >= skip)
        const step = Math.max(1, Math.ceil(t.t.length / maxPts))
        return {
          port: t.port, z_min_ohm: r(Math.min(...body), 4), z_max_ohm: r(Math.max(...body), 4), rise_s: r(t.rise_s ?? null, 3),
          profile: { t_s: t.t.filter((_, k) => k % step === 0).map((v) => r(v, 4)), z_ohm: t.z.filter((_, k) => k % step === 0).map((v) => r(v, 4)), ...(t.d ? { d_m: t.d.filter((_, k) => k % step === 0).map((v) => r(v, 4)) } : {}) },
        }
      })
      for (const t of tdr) if ('z_min_ohm' in t) {
        rec.measure(`tdr_p${t.port}_z_min`, t.z_min_ohm ?? null, 'ohm')
        rec.measure(`tdr_p${t.port}_z_max`, t.z_max_ohm ?? null, 'ohm')
      }
      let radiated: Record<string, unknown> | undefined
      if (res.far_field?.length) {
        const drive = a.drive
        const cls = (a.cispr_class ?? 'B') as CisprClass
        const z0 = s.ports[0]?.z0 ?? 50
        const rows = res.far_field.map((ff) => {
          const row: Record<string, unknown> = { f_hz: ff.f, directivity_dbi: r(10 * Math.log10(ff.dmax), 4), radiated_fraction_of_incident: r(ff.prad_over_pinc, 4) }
          const lim = cisprLimit(cls, ff.f, ff.radius_m)
          if (lim) row.limit_dbuv_m = r(lim.db_uv_m, 4)
          if (drive && ff.e_peak_per_sqrt_w_inc !== null) {
            const p: Trapezoid = { amplitude: drive.amplitude_v, freq: drive.freq_hz, duty: drive.duty, rise: drive.rise_s }
            const n = Math.round(ff.f / drive.freq_hz)
            const vn = Math.abs(n * drive.freq_hz - ff.f) < 1e-6 * ff.f ? harmonic(p, n) : envelope(p, ff.f)
            const pinc = (vn / 2) ** 2 / (2 * z0) // a matched source of open-circuit amplitude vn
            const eFree = dBuV(peakToRms(ff.e_peak_per_sqrt_w_inc * Math.sqrt(pinc)))
            row.source_amplitude_v = r(vn, 4)
            row.e_free_space_dbuv_m = r(eFree, 4)
            row.e_with_ground_dbuv_m = r(eFree + 6.02, 4)
            if (lim) row.margin_db = r(lim.db_uv_m - (eFree + 6.02), 4)
          }
          return row
        })
        const worst = rows.filter((x) => typeof x.margin_db === 'number').sort((x, y) => (x.margin_db as number) - (y.margin_db as number))[0]
        if (worst) rec.measure('radiated_worst_margin_db', worst.margin_db as number, 'dB', worst)
        radiated = {
          label: 'PRE-COMPLIANCE ESTIMATE, not a test result', distance_m: res.far_field[0]?.radius_m, cispr_class: cls, limits: CISPR_SOURCE,
          assumptions: drive ? 'port 1 driven by a matched source (port impedance) whose open-circuit voltage is the trapezoid harmonic; the board region only (no cables, enclosure or the rest of the board); free-space NF2FF, +6 dB for a reflecting ground; maximum over theta/phi in 5 degree steps' : 'no drive given: directivity and radiated fraction only',
          rows, ...(worst ? { worst } : {}),
        }
      }
      const speed = openemsSpeed(log)
      const runsInfo = openemsRuns(log)
      const unmet = runsInfo.endCriterionMet.filter((x) => !x).length
      const result = {
        run_id: rec.id, setup_run_id: a.setup_run_id, where: job.where, ...(job.jobId ? { batch_job: job.jobId } : {}),
        seconds: r(res.seconds, 4), ...(speed !== null ? { openems_speed_mcells_per_s: speed } : {}), estimated_seconds: s.time_s_est,
        timesteps: runsInfo.timesteps, estimated_timesteps: s.timesteps_est,
        ...(unmet ? { warning: `${unmet} run(s) stopped at nr_ts before the energy end criterion: the pulse had not died away, so S-parameters are truncated (raise nr_ts)` } : {}),
        excited_ports: res.excited, touchstone: res.touchstone ?? null,
        losses, tdr, ...(radiated ? { radiated } : {}),
        ...(res.touchstone ? {} : { note: 'only port 1 was excited (setup excite=first): no full S-matrix, no Touchstone file' }),
      }
      rec.finish('pass', `openEMS ${job.where} ${r(res.seconds, 3)} s; ${losses.map((l) => `${l.f_hz} Hz: RL ${l.return_loss_db ?? '-'} IL ${l.insertion_loss_db ?? '-'}`).slice(0, 2).join('; ')}`, { losses, tdr: tdr.map((t) => ({ ...t, profile: undefined })) })
      return result
    } catch (e) {
      throw rec.fail(e)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
})

// ------------------------------------------------------------------------------------------- emc.si

export const siTool = defineTool({
  name: 'emc.si',
  description: 'Signal-integrity quick checks on S-parameters with scikit-rf (any Touchstone file, or an emc.run result): impedance discontinuities from the TDR of chosen ports (frequency-domain step response, resolution ~1/fmax, runs outside z_target ± tol with time and distance), insertion loss between port pairs against a budget, and crosstalk NEXT/FEXT between named nets\' ports (worst over the band, against a limit). Results are only as good as the S-parameters and their bandwidth. Recorded; returns run_id.',
  input: z.object({
    touchstone: z.string().optional().describe('a .sNp file'),
    run_id: z.string().optional().describe('or an emc.run run (its Touchstone artifact)'),
    z_ref: z.number().positive().optional().describe('renormalise to this reference impedance first'),
    z_target: z.number().positive().optional().describe('impedance the TDR is judged against (default 50)'),
    tol: z.number().gt(0).lt(1).optional().describe('fraction of z_target (default 0.1)'),
    er_eff: z.number().min(1).optional().describe('to turn TDR time into distance'),
    tdr_ports: z.array(z.number().int().min(1)).optional().describe('default [1]'),
    insertion_loss: z.array(z.object({ from: z.number().int().min(1), to: z.number().int().min(1), budget_db: z.number().optional(), f_max: z.number().positive().optional() }).strict()).optional()
      .describe('e.g. [{"from":1,"to":2,"budget_db":1.5,"f_max":5e9}]'),
    crosstalk: z.array(z.object({
      name: z.string().optional(),
      aggressor: z.object({ net: z.string().optional(), near: z.number().int().min(1), far: z.number().int().min(1).optional() }).strict(),
      victim: z.object({ net: z.string().optional(), near: z.number().int().min(1), far: z.number().int().min(1).optional() }).strict(),
      limit_db: z.number().optional().describe('e.g. -30'),
    }).strict()).optional(),
    max_points: z.number().int().min(10).max(5000).optional(),
  }),
  run: async (a) => {
    if ((a.touchstone === undefined) === (a.run_id === undefined)) throw new ToolError('give touchstone or run_id')
    const py = siPython()
    if (!(await canImport(py, ['skrf', 'numpy']))) throw new ToolError(`${py} cannot import scikit-rf (pip install scikit-rf; or set TRACE_PYTHON)`)
    const rec = new Recorder('emc.si', a.touchstone ?? a.run_id, a)
    const dir = scratchDir('trace-emc-si-')
    try {
      let file: string
      if (a.touchstone !== undefined) file = resolve(a.touchstone)
      else {
        const w = new Work()
        let name: string | undefined
        try {
          name = w.run(a.run_id as string)?.artifacts.map((x) => x.name).find((n) => /\.s\d+p$/i.test(n))
        } finally {
          w.close()
        }
        if (!name) throw new ToolError(`run ${a.run_id} has no Touchstone artifact`)
        mkdirSync(dir, { recursive: true })
        file = join(dir, name)
        writeFileSync(file, readArtifact(a.run_id as string, name))
      }
      const job = {
        touchstone: file, z_ref: a.z_ref, z_target: a.z_target ?? 50, tol: a.tol ?? 0.1, er_eff: a.er_eff, tdr_ports: a.tdr_ports ?? [1],
        il: a.insertion_loss ?? [], xtalk: (a.crosstalk ?? []).map((c) => ({ ...c, name: c.name ?? `${c.aggressor.net ?? `P${c.aggressor.near}`} -> ${c.victim.net ?? `P${c.victim.near}`}` })), max_points: a.max_points ?? 200,
      }
      writeFileSync(join(dir, 'job.json'), JSON.stringify(job))
      const p = await runProc(py, [`${pythonDir()}si.py`, join(dir, 'job.json')], { cwd: dir, timeoutMs: 300_000 })
      const res = expectResult(p.stdout, p.stderr, 'emc.si')
      const verdicts = [...((res.insertion_loss as { pass?: boolean }[] | undefined) ?? []), ...((res.crosstalk as { pass?: boolean }[] | undefined) ?? [])].map((x) => x.pass).filter((x): x is boolean => typeof x === 'boolean')
      const disc = ((res.tdr as { discontinuities?: unknown[] }[] | undefined) ?? []).reduce((n, t) => n + (t.discontinuities?.length ?? 0), 0)
      const pass = verdicts.every(Boolean) && disc === 0
      for (const t of (res.tdr as { port: number; z_min: number | null; z_max: number | null }[] | undefined) ?? []) {
        rec.measure(`tdr_p${t.port}_z_min`, t.z_min, 'ohm')
        rec.measure(`tdr_p${t.port}_z_max`, t.z_max, 'ohm')
      }
      rec.finish(pass ? 'pass' : 'fail', `${disc} discontinuities, ${verdicts.filter((v) => !v).length} budget failures`, { pass })
      return { run_id: rec.id, pass, ...res }
    } catch (e) {
      throw rec.fail(e)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
})

export const tools: AnyTool[] = [spectrumTool, precheckTool, setupTool, runTool, siTool] as unknown as AnyTool[]

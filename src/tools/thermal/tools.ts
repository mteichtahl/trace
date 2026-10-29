/**
 * The thermal tools (thermal.*), for the Thermal specialist. Every run is recorded in the project database with its
 * inputs, artifacts (maps, CSV, VTU, GLB, the Markdown report, solver decks and logs) and measurements, and returns
 * its run_id. Every figure names its source: a datasheet citation, the design files, a formula, or a run id.
 *
 *   thermal.envelope   the operating envelope and the parts' thermal limits (tables thermal_envelopes, thermal_part_limits)
 *   thermal.budget     the power budget per part, with totals per rail and for the board (thermal_budget)
 *   thermal.junction   Tj per part at each ambient corner, with margins
 *   thermal.pcb        copper spreading, via arrays, copper area for a target theta, trace rise
 *   thermal.board      the board model: 2.5D grid (fast), CalculiX 3D FEM, or OpenFOAM CFD
 *   thermal.check      budget + junction (+ board) across the envelope's corners: one verdict, margins as measurements
 *   thermal.validate   the solvers against closed forms at two mesh sizes
 *   thermal.measure    bench temperatures through the HIL tools, against the model; heater calibration (hardware)
 *   thermal.derating   derating curves from datasheets and the operating point against them (thermal_derating)
 *   thermal.compare    two time series (runs, or a run against measurements) overlaid
 *   thermal.render     a thermal.board run's temperature-coloured model through Blender (render pipeline)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { defineTool, ToolError, type AnyTool } from '../../core/registry.js'
import { scratchDir, Work } from '../../core/store.js'
import { needPcb, resolveProject } from '../kicad/project.js'
import { Recorder, readArtifact } from '../sim/record.js'
import { renderGeneratedModel } from '../render/tools.js'
import { DeviceWant } from '../render/device.js'
import { assemble, BudgetEntry, type BudgetLine, spiceLines, SpiceSource } from './budget.js'
import { ccxHexMesh } from './calculix.js'
import { EnclosureSchema, ENVIRONMENTS, type Environment, type PerSurface, SURFACES } from './convection.js'
import { proposeLimits, libraryReader } from './datasheet.js'
import { checkPoint, pointsFromTable } from './derating.js'
import { csv, texturedSlab, vtu } from './export.js'
import { runBoardCalculix } from './fem.js'
import { colourBar, encodePng, linePlot, mapImage } from './image.js'
import { junction, METHODS, worst, type JunctionResult } from './junction.js'
import { runBoardWhere } from './job.js'
import { EMISSIVITY, FINISHES } from './materials.js'
import { errorStats, fitMultiplier, PointSource, read, type PointResult } from './measure.js'
import { boardArtifacts, type BoardRun, cornersOf, environmentOf } from './model.js'
import { boardSetup, runCfd, caseListing, verticalPlateCase, writeCase, OPENFOAM_RELEASE, type CfdSetup } from './openfoam.js'
import { copperArea, equivalentRadius, spreading, traceRise, viaArray } from './pcb.js'
import { rasterise } from './raster.js'
import { BOARD_CAVEATS, report } from './report.js'
import {
  CitationSchema, deleteCorrection, deleteEnvelope, DeratingSchema, EmissivityInput, EnvelopeSchema, type Envelope, getBudget, getCorrections, getCurves, getEnvelope,
  getPartLimits, LIMIT_FIELDS, listEnvelopes, PartLimitSchema, putBudget, putCorrection, putCurve, putEnvelope, putPartLimit,
} from './store.js'
import { compare, seriesFromCsv } from './transient.js'
import { validate } from './validation.js'
import { PdfReader } from '../datasheets/pdf.js'
import { library } from '../datasheets/library.js'
import type { Backend } from '../../gpu/jobs.js'

const r4 = (x: number | null | undefined): number | null => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toPrecision(5)))

function gitSha(): string | null {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null } catch { return null }
}

// ------------------------------------------------------------------ shared inputs

const boardIn = {
  board: z.string().optional().describe('.kicad_pcb path (relative to the repository)'),
  project: z.string().optional().describe('or a .kicad_pro / folder; omit both for the configured or only project'),
}

async function boardPath(a: { board?: string | undefined; project?: string | undefined }): Promise<string> {
  if (a.board) return resolve(a.board)
  return needPcb(await resolveProject(a.project))
}

const InlineEnvelope = EnvelopeSchema.omit({ name: true }).extend({ name: z.string().default('inline') })

const envIn = {
  envelope: z.string().optional().describe('a stored envelope (thermal.envelope action=set)'),
  envelope_inline: InlineEnvelope.optional().describe('or the envelope inline (not stored); same fields as thermal.envelope set'),
}

function envelopeOf(a: { envelope?: string | undefined; envelope_inline?: z.output<typeof InlineEnvelope> | undefined }): Envelope {
  if (a.envelope_inline) return a.envelope_inline
  if (!a.envelope) throw new ToolError('give envelope (a stored one) or envelope_inline')
  const e = getEnvelope(a.envelope)
  if (!e) throw new ToolError(`no envelope ${JSON.stringify(a.envelope)} (thermal.envelope action=list)`)
  return e
}

const powerIn = {
  scenario: z.string().optional().describe('a stored power budget (thermal.budget action=set)'),
  power: z.record(z.string(), z.number().min(0)).optional().describe('or the power per part inline, {"U1": 1.0} (W)'),
  use_max: z.boolean().default(false).describe('use each part\'s maximum power where the budget has one'),
}

function powerOf(a: { scenario?: string | undefined; power?: Record<string, number> | undefined; use_max: boolean }): { power: Map<string, number>; lines: BudgetLine[] | null; source: string } {
  if (a.power) return { power: new Map(Object.entries(a.power)), lines: null, source: 'inline power' }
  if (!a.scenario) throw new ToolError('give scenario (a stored budget) or power')
  const rows = getBudget(a.scenario)
  if (!rows.length) throw new ToolError(`no budget ${JSON.stringify(a.scenario)} (thermal.budget action=set)`)
  return {
    power: new Map(rows.map((r) => [r.ref, a.use_max && r.power_max_w !== null ? r.power_max_w : r.power_w])),
    lines: rows.map((r) => ({ ref: r.ref, rail: r.rail, power_w: r.power_w, power_max_w: r.power_max_w, method: r.method as BudgetLine['method'], citation: r.citation })),
    source: `budget ${a.scenario}`,
  }
}

const surfaceH = z.object({ top: z.number().min(0), bottom: z.number().min(0), edge: z.number().min(0) }).partial().strict()

const modelIn = {
  ambient_c: z.number().optional().describe('the ambient corner (default: the envelope\'s maximum)'),
  cell_mm: z.number().min(0.05).max(20).optional().describe('grid cell (default: about 40k cells per layer, at least 0.25 mm)'),
  samples: z.number().int().min(1).max(8).default(4).describe('copper coverage sub-samples per cell side'),
  h_override: surfaceH.optional().describe('fixed convective h (W/m^2 K) per surface, instead of the correlations'),
  use_correction: z.boolean().default(true).describe('apply the envelope\'s stored calibration (h multiplier, CFD h per surface)'),
  emissivity: EmissivityInput.optional(),
  laminate: z.object({ k_z: z.number().positive(), k_xy: z.number().positive(), rho_cp: z.number().positive() }).partial().strict().optional().describe('laminate figures (W/m K, J/m^3 K) from its datasheet'),
  heatsinks: z.array(z.object({ x_mm: z.number(), y_mm: z.number(), w_mm: z.number().positive(), h_mm: z.number().positive(), side: z.enum(['top', 'bottom']).default('top'), h_w_m2k: z.number().positive(), label: z.string().default('heatsink') }).strict()).optional()
    .describe('a heatsink or cold plate as an extra film coefficient over a rectangle (h = 1 / (theta_sa x area) for a heatsink of theta_sa)'),
  transient: z.object({ duration_s: z.number().positive(), dt_s: z.number().positive() }).strict().optional().describe('also a transient from ambient: temperature against time'),
  remote: z.enum(['auto', 'always', 'never']).default('auto').describe('auto: the CPU queue for large models (cfd: always, unless never)'),
}

function autoCell(path: string): number {
  const g = rasterise(path, { cell_mm: 5, power: new Map(), emissivity: { top: 0, bottom: 0, edge: 0 }, samples: 1 })
  const area = g.model.nx * g.model.ny * 25
  return Math.max(0.25, Math.ceil(Math.sqrt(area / 40_000) * 4) / 4)
}

function corrected(e: Envelope, a: { use_correction: boolean; h_override?: Partial<PerSurface> | undefined }): { mult: number; override: Partial<PerSurface>; notes: string[]; evidence: string[] } {
  if (!a.use_correction || e.name === 'inline') return { mult: 1, override: a.h_override ?? {}, notes: [], evidence: [] }
  const c = getCorrections(e.name)
  const notes: string[] = []
  const evidence: string[] = []
  let mult = 1
  const override: Partial<PerSurface> = {}
  for (const x of c) {
    if (x.name === 'h_multiplier') { mult = x.value; notes.push(`h x ${x.value.toPrecision(4)} (calibration, runs ${x.evidence.join(', ')})`); evidence.push(...x.evidence) }
    const s = /^h_(top|bottom|edge)$/.exec(x.name)?.[1] as keyof PerSurface | undefined
    if (s) { override[s] = x.value; notes.push(`h_${s} = ${x.value.toPrecision(4)} W/m^2 K (CFD, runs ${x.evidence.join(', ')})`); evidence.push(...x.evidence) }
  }
  return { mult, override: { ...override, ...(a.h_override ?? {}) }, notes, evidence }
}

// ------------------------------------------------------------------ thermal.envelope

export const envelopeTool = defineTool({
  name: 'thermal.envelope',
  description: 'The thermal operating envelope in the project database (table thermal_envelopes): ambient min/max (and an optional nominal corner), environment (natural convection, forced airflow in m/s, a sealed enclosure with its dimensions, or vacuum: radiation only), orientation, altitude (air density), emissivity per surface, and the derating policy (Tj <= Tj_max - offset, or Tj <= fraction x Tj_max in deg C). And the parts\' limits (table thermal_part_limits): Tj_max/min, theta-JA/JC/JB, psi-JT/JB, each with a citation: a datasheet {mpn, sha256, page} or {source} for a manual figure. action=set, get, list, delete, set_parts (rows), parts, from_datasheet (proposes figures from the datasheet library\'s tables, each cited; stored with apply=true only where every matching row agrees), corrections (the stored calibrations), clear_correction.',
  input: z.object({
    action: z.enum(['set', 'get', 'list', 'delete', 'set_parts', 'parts', 'from_datasheet', 'corrections', 'clear_correction']),
    name: z.string().optional().describe('the envelope'),
    ambient_min_c: z.number().optional(), ambient_max_c: z.number().optional(), ambient_nominal_c: z.number().optional(),
    environment: z.enum(ENVIRONMENTS).optional(), airflow_m_s: z.number().min(0).optional(), enclosure: EnclosureSchema.optional(),
    orientation: z.enum(['horizontal', 'vertical']).optional(), altitude_m: z.number().optional(), derating: DeratingSchema.optional(),
    emissivity: EmissivityInput.optional(), finish: z.enum(FINISHES).optional().describe('or a finish from the emissivity table for every surface'),
    radiation: z.boolean().optional(), notes: z.string().optional(), source: z.string().optional(),
    parts: z.array(PartLimitSchema).optional().describe('set_parts: [{ref, mpn, tj_max_c, theta_ja, ..., citations: {tj_max_c: {mpn, sha256, page}}}]'),
    ref: z.string().optional().describe('from_datasheet: the part'), mpn: z.string().optional(),
    fields: z.array(z.enum(LIMIT_FIELDS)).optional(), apply: z.boolean().default(false), library: z.string().optional(),
    correction: z.string().optional().describe('clear_correction: its name (all when omitted)'),
  }),
  run: async (a) => {
    if (a.action === 'list') return { envelopes: listEnvelopes() }
    if (!a.name) throw new ToolError(`${a.action} needs name`)
    switch (a.action) {
      case 'get': {
        const e = getEnvelope(a.name)
        if (!e) throw new ToolError(`no envelope ${JSON.stringify(a.name)}`)
        return { envelope: e, parts: getPartLimits(a.name), corrections: getCorrections(a.name) }
      }
      case 'delete': return { deleted: deleteEnvelope(a.name) }
      case 'parts': return { envelope: a.name, parts: getPartLimits(a.name) }
      case 'corrections': return { envelope: a.name, corrections: getCorrections(a.name) }
      case 'clear_correction': return { deleted: deleteCorrection(a.name, a.correction) }
      case 'set': {
        const old = getEnvelope(a.name)
        const em = a.finish ? { top: EMISSIVITY[a.finish].value, bottom: EMISSIVITY[a.finish].value, edge: EMISSIVITY[a.finish].value } : a.emissivity ?? old?.emissivity
        const e = putEnvelope({
          name: a.name, ambient_min_c: a.ambient_min_c ?? old?.ambient_min_c ?? NaN, ambient_max_c: a.ambient_max_c ?? old?.ambient_max_c ?? NaN,
          ...(a.ambient_nominal_c ?? old?.ambient_nominal_c) !== undefined ? { ambient_nominal_c: (a.ambient_nominal_c ?? old?.ambient_nominal_c)! } : {},
          environment: a.environment ?? old?.environment ?? 'natural', airflow_m_s: a.airflow_m_s ?? old?.airflow_m_s ?? 0,
          ...(a.enclosure ?? old?.enclosure ? { enclosure: (a.enclosure ?? old?.enclosure)! } : {}),
          orientation: a.orientation ?? old?.orientation ?? 'horizontal', altitude_m: a.altitude_m ?? old?.altitude_m ?? 0,
          derating: a.derating ?? old?.derating ?? { kind: 'offset', value_c: 20 }, ...(em ? { emissivity: em } : {}),
          radiation: a.radiation ?? old?.radiation ?? true, ...(a.notes ?? old?.notes ? { notes: (a.notes ?? old?.notes)! } : {}), ...(a.source ?? old?.source ? { source: (a.source ?? old?.source)! } : {}),
        })
        return { envelope: e, ...(a.finish ? { emissivity_source: EMISSIVITY[a.finish].source } : {}) }
      }
      case 'set_parts': {
        if (!a.parts?.length) throw new ToolError('set_parts needs parts')
        return { envelope: a.name, saved: a.parts.map((p) => putPartLimit(a.name!, p)) }
      }
      case 'from_datasheet': {
        if (!a.mpn || !a.ref) throw new ToolError('from_datasheet needs ref and mpn')
        const proposals = await proposeLimits(a.mpn, a.fields ?? ['tj_max_c', 'theta_ja', 'theta_jc', 'theta_jb', 'psi_jt', 'psi_jb'], libraryReader(a.library))
        let saved = null
        if (a.apply) {
          const have = getPartLimits(a.name).find((p) => p.ref === a.ref)
          const agreed = proposals.filter((p) => p.agree && p.value !== null && p.citation)
          if (agreed.length) {
            saved = putPartLimit(a.name, {
              ...(have ?? {}), ref: a.ref, mpn: a.mpn, ...Object.fromEntries(agreed.map((p) => [p.field, p.value])),
              citations: { ...(have?.citations ?? {}), ...Object.fromEntries(agreed.map((p) => [p.field, p.citation])) },
            })
          }
        }
        return { ref: a.ref, mpn: a.mpn, proposals, saved, note: 'a figure is proposed only where every matching row agrees; read the rows of the others (datasheets.tables) and set them with set_parts' }
      }
    }
  },
})

// ------------------------------------------------------------------ thermal.budget

export const budgetTool = defineTool({
  name: 'thermal.budget',
  description: 'The power budget: dissipation per part with where each figure came from, in priority order: an explicit entry; a SPICE operating point (ngspice .op: P from @dev[p] for R/Q/M/J, V(a,k) x @d[id] for diodes, or a named vector; recorded, each figure cites the run id); regulator calculations (LDO (Vin - Vout) Iout + Vin Iq per calc.ldo_thermal / TI SLVA118A; buck/boost Pout (1 - eta)/eta, with eta from the datasheet curve, or 0.85 assumed and flagged); datasheet typical/max (cited). A part given twice keeps the higher-priority figure and lists the others. Totals per rail and for the board. action=compute (and store with scenario), get (a stored scenario).',
  input: z.object({
    action: z.enum(['compute', 'get']).default('compute'),
    scenario: z.string().optional().describe('store the result under this name (thermal_budget), or read it'),
    entries: z.array(BudgetEntry).default([]),
    spice: SpiceSource.optional(),
  }),
  run: async (a) => {
    if (a.action === 'get') {
      if (!a.scenario) throw new ToolError('get needs scenario')
      const rows = getBudget(a.scenario)
      return { scenario: a.scenario, ...assemble(rows.map((r) => ({ method: 'explicit' as const, ref: r.ref, ...(r.rail ? { rail: r.rail } : {}), power_w: r.power_w, ...(r.power_max_w !== null ? { power_max_w: r.power_max_w } : {}), citation: { source: `stored ${r.method}: ${JSON.stringify(r.citation)}` } }))) }
    }
    const sp = a.spice ? await spiceLines(a.spice, (p) => readFileSync(resolve(p), 'utf8')) : null
    const b = assemble(a.entries, sp?.lines ?? [])
    if (!b.lines.length) throw new ToolError('the budget is empty: give entries or spice')
    if (a.scenario) putBudget(b.lines.map((l) => ({ ref: l.ref, rail: l.rail, power_w: l.power_w, power_max_w: l.power_max_w, method: l.method, citation: { ...((l.citation as object | null) ?? {}), ...(l.formula ? { formula: l.formula } : {}), ...(l.assumption ? { assumption: l.assumption } : {}) } })), a.scenario)
    return {
      ...(a.scenario ? { scenario: a.scenario } : {}), ...(sp ? { spice_run_id: sp.run_id } : {}),
      total_w: r4(b.total_w), total_max_w: r4(b.total_max_w), rails: b.rails.map((x) => ({ ...x, power_w: r4(x.power_w), power_max_w: r4(x.power_max_w) })),
      lines: b.lines.map((l) => ({ ...l, power_w: r4(l.power_w), power_max_w: r4(l.power_max_w) })),
      assumptions: b.lines.filter((l) => l.assumption).map((l) => `${l.ref}: ${l.assumption}`),
    }
  },
})

// ------------------------------------------------------------------ thermal.junction

const HeatsinkIn = z.object({ theta_cs: z.number().min(0), theta_sa: z.number().positive(), source: z.string().min(1).describe('where theta_cs (interface) and theta_sa come from') }).strict()

export const junctionTool = defineTool({
  name: 'thermal.junction',
  description: 'Junction temperature per part at each ambient corner of the envelope, with margin to Tj_max and to the derated limit, and pass / at-risk / fail / unknown. Uses (auto, in this order) psi_JT with a measured top temperature, psi_JB or theta_JB with the board temperature under the part from a thermal.board run, theta_JC + interface + heatsink, else theta_JA; and says which and its caveat (theta_JA is a JEDEC test-board figure, not this board: it can be off by 2x either way). Limits and metrics come from the envelope\'s part limits, with their citations. Recorded.',
  input: z.object({
    ...envIn, ...powerIn,
    board_run: z.string().optional().describe('a thermal.board run id: the board temperature under each part (its ambient must be the corner; otherwise the rise is shifted to each corner)'),
    top_c: z.record(z.string(), z.number()).optional().describe('measured package-top temperatures by part'),
    heatsinks: z.record(z.string(), HeatsinkIn).optional(),
    method: z.record(z.string(), z.enum(METHODS)).optional().describe('force a method per part'),
  }),
  run: async (a) => {
    const e = envelopeOf(a)
    const { power, source } = powerOf(a)
    const limits = new Map((e.name === 'inline' ? [] : getPartLimits(e.name)).map((p) => [p.ref, p]))
    let board: Map<string, number> | null = null
    let boardAmbient: number | null = null
    if (a.board_run) {
      const w = new Work()
      try {
        const r = w.run(a.board_run)
        if (!r || !r.kind.startsWith('thermal.board')) throw new ToolError(`${a.board_run} is not a thermal.board run`)
        const res = r.result as { parts?: { ref: string; board_c: number }[]; ambient_c?: number }
        board = new Map((res.parts ?? []).map((p) => [p.ref, p.board_c]))
        boardAmbient = res.ambient_c ?? null
      } finally { w.close() }
    }
    const rec = new Recorder('thermal.junction', e.name, a)
    const results: JunctionResult[] = []
    for (const ta of cornersOf(e)) {
      for (const [ref, pw] of power) {
        const b = board?.get(ref)
        results.push(junction({
          ref, power_w: pw, limits: limits.get(ref), ambient_c: ta, derating: e.derating,
          ...(b !== undefined && boardAmbient !== null ? { board_c: b + (ta - boardAmbient) } : {}),
          ...(a.top_c?.[ref] !== undefined ? { top_c: a.top_c[ref] } : {}), ...(a.heatsinks?.[ref] ? { heatsink: a.heatsinks[ref] } : {}), ...(a.method?.[ref] ? { method: a.method[ref] } : {}),
        }))
      }
    }
    for (const j of results) {
      rec.measure(`${j.ref}.tj_c@${j.ambient_c}`, j.tj_c, 'C', { method: j.method })
      rec.measure(`${j.ref}.derated_margin_c@${j.ambient_c}`, j.derated_margin_c, 'C')
    }
    const verdict = worst(results.map((j) => j.status))
    const out = { run_id: rec.id, envelope: e.name, power_source: source, verdict, ...(board ? { board_note: 'board temperatures from the run shifted by (corner - run ambient): exact only where h does not change with the corner' } : {}), results: results.map((j) => ({ ...j, tj_c: r4(j.tj_c), margin_c: r4(j.margin_c), derated_margin_c: r4(j.derated_margin_c) })) }
    rec.finish(verdict === 'pass' ? 'pass' : 'fail', `${verdict}: ${results.filter((j) => j.status !== 'pass').map((j) => `${j.ref}@${j.ambient_c} ${j.status}`).join(', ') || 'every part within the derated limit'}`, out)
    return out
  },
})

// ------------------------------------------------------------------ thermal.pcb

export const pcbTool = defineTool({
  name: 'thermal.pcb',
  description: 'Board-level thermal calculators (pure, cited formulas; see src/tools/thermal/pcb.ts): calc=spreading (spreading resistance of a circular isoflux source on a circular plate cooled by h, the separation-of-variables series of Kennedy 1960 / Song, Lee & Au 1994; rectangles as circles of equal area), via_array (n plated barrels in parallel, optional fill, laminate in parallel), copper_area (the pour radius/area for a target theta: annular fin with both faces cooled, Incropera table 3.5), trace_rise (IPC-2221B 6.2 inverted from calc.trace_width; IPC-2152 is not implemented). Lengths in metres.',
  input: z.object({
    calc: z.enum(['spreading', 'via_array', 'copper_area', 'trace_rise']),
    source_w_m: z.number().positive().optional(), source_h_m: z.number().positive().optional(), source_radius_m: z.number().positive().optional(),
    plate_w_m: z.number().positive().optional(), plate_h_m: z.number().positive().optional(), plate_radius_m: z.number().positive().optional(),
    thickness_m: z.number().positive().optional(), k: z.number().positive().optional(), h: z.number().positive().optional(),
    count: z.number().int().min(1).optional(), drill_m: z.number().positive().optional(), plating_m: z.number().positive().optional(), length_m: z.number().positive().optional(),
    fill_k: z.number().positive().optional(), array_area_m2: z.number().positive().optional(), k_laminate: z.number().positive().optional(),
    target_c_per_w: z.number().positive().optional(), copper_oz: z.number().positive().optional(),
    current_a: z.number().positive().optional(), width_m: z.number().positive().optional(), layer: z.enum(['external', 'internal']).default('external'),
  }),
  run: (a) => {
    const need = <T>(v: T | undefined, n: string): T => { if (v === undefined) throw new ToolError(`${a.calc} needs ${n}`); return v }
    const srcR = (): number => a.source_radius_m ?? equivalentRadius(need(a.source_w_m, 'source_radius_m or source_w_m/source_h_m'), need(a.source_h_m, 'source_h_m'))
    switch (a.calc) {
      case 'spreading': {
        const b = a.plate_radius_m ?? equivalentRadius(need(a.plate_w_m, 'plate_radius_m or plate_w_m/plate_h_m'), need(a.plate_h_m, 'plate_h_m'))
        const r = spreading({ source_radius_m: srcR(), plate_radius_m: b, thickness_m: need(a.thickness_m, 'thickness_m'), k: need(a.k, 'k'), h: need(a.h, 'h') })
        return { ...r, formula: 'R = sum 4 J1(l a)^2 / (pi a^2 b^2 k l^3 J0(l b)^2 phi) + t/(k pi b^2) + 1/(h pi b^2)', summary: `spreading ${r.spreading_c_per_w.toPrecision(4)} °C/W + 1D ${r.one_d_c_per_w.toPrecision(3)} + convection ${r.convection_c_per_w.toPrecision(3)} = ${r.total_c_per_w.toPrecision(4)} °C/W` }
      }
      case 'via_array': {
        const r = viaArray({ count: need(a.count, 'count'), drill_m: need(a.drill_m, 'drill_m'), plating_m: a.plating_m, length_m: need(a.length_m, 'length_m'), fill_k: a.fill_k, array_area_m2: a.array_area_m2, k_laminate: a.k_laminate })
        return { ...r, summary: `${a.count} vias: ${r.total_c_per_w.toPrecision(4)} °C/W (${r.per_via_c_per_w.toPrecision(4)} each)` }
      }
      case 'copper_area': {
        const r = copperArea({ target_c_per_w: need(a.target_c_per_w, 'target_c_per_w'), source_radius_m: srcR(), copper_oz: a.copper_oz, thickness_m: a.thickness_m, h: need(a.h, 'h (both faces each)'), k: a.k })
        return { ...r, summary: r.achievable ? `a pour of radius ${((r.radius_m as number) * 1e3).toFixed(1)} mm (${((r.area_m2 as number) * 1e6).toFixed(0)} mm^2, a ${((r.side_m as number) * 1e3).toFixed(1)} mm square) reaches ${a.target_c_per_w} °C/W` : `not reachable with this copper: an infinite pour gives ${r.theta_infinite_c_per_w.toPrecision(4)} °C/W` }
      }
      case 'trace_rise': {
        const r = traceRise({ current_a: need(a.current_a, 'current_a'), width_m: need(a.width_m, 'width_m'), copper_oz: a.copper_oz, layer: a.layer })
        return { ...r, summary: `${a.current_a} A in ${((a.width_m as number) * 1e3).toFixed(3)} mm ${a.layer}: ${r.temp_rise_c.toFixed(1)} °C rise (IPC-2221B)` }
      }
    }
  },
})

// ------------------------------------------------------------------ thermal.board

const BoardInput = z.object({
  ...boardIn, ...envIn, ...powerIn, ...modelIn,
  solver: z.enum(['2.5d', 'calculix', 'cfd']).default('2.5d'),
  sublayers: z.number().int().min(1).max(8).default(2).describe('calculix: element layers per dielectric'),
  bodies: z.object({ height_m: z.number().positive() }).strict().optional().describe('calculix and cfd: component bodies (mould compound) of this height over each powered part'),
  threads: z.number().int().min(1).max(64).default(1).describe('calculix: OMP threads; cfd: MPI ranks (decomposePar when above 1)'),
  cfd: z.object({
    flow: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('natural') }).strict(),
      z.object({ kind: z.literal('fixed'), inlet: z.enum(['x-', 'x+', 'y-', 'y+', 'z-', 'z+']), outlet: z.enum(['x-', 'x+', 'y-', 'y+', 'z-', 'z+']), flow_m3_s: z.number().positive() }).strict(),
      z.object({ kind: z.literal('fan'), inlet: z.enum(['x-', 'x+', 'y-', 'y+', 'z-', 'z+']), outlet: z.enum(['x-', 'x+', 'y-', 'y+', 'z-', 'z+']), curve: z.array(z.tuple([z.number().min(0), z.number()])).min(2) }).strict(),
    ]).optional().describe('default: natural, or a fixed flow from the envelope\'s airflow'),
    radiation: z.enum(['none', 'fvDOM', 'P1']).default('none'),
    cell_m: z.number().positive().optional(), refinement: z.number().int().min(0).max(5).default(2), margin: z.number().min(0.2).max(5).default(1),
    iterations: z.number().int().min(10).max(1e6).default(2000), enclosure_stl: z.string().optional(),
    probes: z.array(z.object({ name: z.string(), at: z.tuple([z.number(), z.number(), z.number()]) }).strict()).default([]),
    store_h: z.boolean().default(true).describe('store the CFD-derived effective h per surface as the envelope\'s correction (fed back into the 2.5D and CalculiX models)'),
    write_only: z.boolean().default(false).describe('write the case (as artifacts) without running it'),
  }).strict().optional(),
})
type BoardArgs = z.output<typeof BoardInput>

interface Prepared { path: string; env: Envelope; environment: Environment; ambient: number; power: Map<string, number>; powerSource: string; cell: number; notes: string[]; evidence: string[] }

async function prepare(a: BoardArgs, extra: { h_multiplier?: number; ambient?: number } = {}): Promise<Prepared> {
  const path = await boardPath(a)
  const env = envelopeOf(a)
  const ambient = extra.ambient ?? a.ambient_c ?? env.ambient_max_c
  const c = corrected(env, a)
  const environment = environmentOf(env, ambient, { h_multiplier: extra.h_multiplier ?? c.mult, h_override: c.override, ...(a.emissivity ? { emissivity: a.emissivity } : {}) })
  const p = powerOf(a)
  return { path, env, environment, ambient, power: p.power, powerSource: p.source, cell: a.cell_mm ?? autoCell(path), notes: c.notes, evidence: c.evidence }
}

async function run25d(a: BoardArgs, p: Prepared): Promise<BoardRun & { where: Backend }> {
  const g = rasterise(p.path, { cell_mm: p.cell, power: new Map(), emissivity: p.environment.emissivity, samples: 1 })
  const cells = g.model.nx * g.model.ny * g.model.layers.length
  return runBoardWhere({ board: p.path, environment: p.environment, power: p.power, cell_mm: p.cell, samples: a.samples, ...(a.laminate ? { laminate: a.laminate } : {}), ...(a.heatsinks ? { heatsinks: a.heatsinks } : {}), ...(a.transient ? { transient: a.transient } : {}) }, cells, a.remote)
}

/** Run thermal.board's computation (also used by thermal.check and by thermal.measure's refit). */
export async function boardRun(a: BoardArgs, rec: Recorder, extra: { h_multiplier?: number; ambient?: number; artifacts?: boolean } = {}): Promise<Record<string, unknown> & { parts: { ref: string; board_c: number; power_w: number }[]; hotspot_c: number; ambient_c: number }> {
  const p = await prepare(a, extra)
  const artifacts = extra.artifacts ?? true
  const caveats = [...BOARD_CAVEATS]
  if (a.solver === '2.5d') {
    const run = await run25d(a, p)
    if (artifacts) for (const x of boardArtifacts(run)) rec.artifact(x.name, x.data, x.mime)
    const sol = run.solution
    const out = {
      solver: '2.5d', where: run.where, board: p.path, envelope: p.env.name, ambient_c: p.ambient, sink_c: run.sink_c, power_source: p.powerSource,
      grid: run.grid, solve_ms: run.solve_ms, cg_iterations: sol.cg_iterations, cg_residual: sol.cg_residual, converged: sol.converged,
      h: Object.fromEntries(SURFACES.map((s) => [s, { h: r4(run.coefficients[s].h), correlation: run.coefficients[s].correlation, out_of_range: run.coefficients[s].out_of_range, ra: r4(run.coefficients[s].ra), re: r4(run.coefficients[s].re) }])),
      film: { iterations: run.film_iterations.length, converged: run.film_converged }, ...(run.sealed ? { sealed: run.sealed } : {}),
      energy: { input_w: r4(sol.input_w), convective_w: sol.convective_w, radiative_w: sol.radiative_w, extra_w: r4(sol.extra_w), balance_error: sol.balance_error },
      hotspot: run.hotspot, hotspot_c: run.hotspot.t_c, parts: run.parts.map((x) => ({ ...x, board_c: Number(x.board_c.toFixed(3)) })),
      copper: run.raster.copper_fraction, vias: run.raster.vias, assumptions: [...run.raster.assumptions, ...p.notes, ...(run.raster.unfilled_zones.length ? [`unfilled zones (outline used, clearances ignored): ${run.raster.unfilled_zones.join(', ')}`] : []), ...(run.raster.unplaced.length ? [`parts without pads on the board: ${run.raster.unplaced.join(', ')}`] : [])],
      ...(run.transient ? { transient: { metrics: run.transient.metrics.map((m) => ({ ...m, t90_s: r4(m.t90_s), t_steady_s: r4(m.t_steady_s) })), steps: run.transient.steps, dt_s: run.transient.dt_s } } : {}),
      calibration_evidence: p.evidence, caveats,
    }
    if (artifacts) {
      rec.artifact('report.md', report({
        title: `Thermal board model: ${p.env.name} at ${p.ambient} °C`, run_id: rec.id, solver: '2.5D finite volume (thermal.board)', board: p.path, envelope: p.env.name, environment: p.environment,
        ambient_c: p.ambient, sink_c: run.sink_c, coefficients: run.coefficients, film_iterations: run.film_iterations, film_converged: run.film_converged,
        mesh: { cells: `${run.grid.nx} x ${run.grid.ny} x ${run.grid.layers} layers (${run.grid.nodes} nodes)`, cell: `${run.grid.cell_mm} mm`, solver: `Jacobi-preconditioned CG, ${sol.cg_iterations} iterations, residual ${sol.cg_residual.toExponential(2)}` },
        ...(a.laminate ? { materials: { laminate: JSON.stringify(a.laminate) } } : {}),
        balance: { input_w: sol.input_w, out_w: sol.input_w * (1 + sol.balance_error), error: sol.balance_error }, parts: run.parts, hotspot: run.hotspot,
        ...(run.transient ? { transient: run.transient.metrics } : {}), assumptions: out.assumptions, caveats,
      }), 'text/markdown')
    }
    return out
  }
  if (a.solver === 'calculix') {
    const f = await runBoardCalculix({ board: p.path, environment: p.environment, power: p.power, cell_mm: p.cell, samples: a.samples, sublayers: a.sublayers, bodies: a.bodies, threads: a.threads, remote: a.remote, ...(a.laminate ? { laminate: a.laminate } : {}), ...(a.heatsinks ? { heatsinks: a.heatsinks } : {}), ...(a.transient ? { transient: a.transient } : {}) })
    const m = f.model
    caveats.splice(1, 1, a.bodies ? 'Component bodies are mould-compound boxes over the pads; real package internals (die, lead frame, exposed pad) are not modelled.' : 'Component bodies are not modelled (bodies off): heat enters the board through the pads.')
    if (artifacts) {
      rec.artifact('model.inp', f.inp)
      rec.artifact('ccx.log', f.log)
      rec.artifact('board.vtu', vtu(ccxHexMesh(f.mesh, f.temps)), 'application/xml')
      // top and bottom surface maps from the nodes of the outer copper layers' outer faces
      const kTop = f.mesh.stats.layers.indexOf(m.layers[0]!.name)
      const kBot = f.mesh.stats.layers.lastIndexOf(m.layers[m.layers.length - 1]!.name) + 1
      const px = m.nx + 1
      const py = m.ny + 1
      const field = (k: number): Float64Array => Float64Array.from({ length: m.nx * m.ny }, (_, c) => {
        if (!m.inside[c]) return NaN
        const i = c % m.nx
        const j = Math.floor(c / m.nx)
        const id = (ii: number, jj: number): number => f.temps.get((k * py + jj) * px + ii + 1) ?? NaN
        return (id(i, j) + id(i + 1, j) + id(i + 1, j + 1) + id(i, j + 1)) / 4
      })
      const top = field(kTop)
      const bot = field(kBot)
      const all = [...top, ...bot].filter(Number.isFinite)
      const lo = Math.min(...all)
      const hi = Math.max(...all)
      const scale = Math.max(1, Math.min(8, Math.floor(800 / Math.max(m.nx, m.ny))))
      const png = (v: Float64Array): Uint8Array => { const im = mapImage(v, m.nx, m.ny, lo, hi, scale); return encodePng(im.width, im.height, im.rgb) }
      const pt = png(top)
      const pb = png(bot)
      rec.artifact('map-top.png', pt, 'image/png')
      rec.artifact('map-bottom.png', pb, 'image/png')
      rec.artifact('colourbar.png', colourBar(lo, hi), 'image/png')
      rec.artifact('board.glb', texturedSlab(m.nx * m.dx, m.ny * m.dy, f.plate.thickness_m, pt, pb), 'model/gltf-binary')
      if (f.transient) {
        rec.artifact('transient.csv', csv(['time_s', 'board_max', 'board_min', ...m.parts.map((x) => x.ref)], f.transient.frames.map((x) => [x.t_s, x.max_c, x.min_c, ...m.parts.map((q) => x.parts[q.ref]!)])), 'text/csv')
        rec.artifact('transient.png', linePlot([{ name: 'board_max', t: f.transient.frames.map((x) => x.t_s), y: f.transient.frames.map((x) => x.max_c) }]), 'image/png')
      }
    }
    const out = {
      solver: 'calculix', where: f.where, board: p.path, envelope: p.env.name, ambient_c: p.ambient, sink_c: f.sink_c, power_source: p.powerSource,
      mesh: { ...f.mesh.stats, cell_mm: p.cell, sublayers: a.sublayers }, ccx_runs: f.ccx_runs, ccx_seconds: r4(f.ccx_seconds),
      h: Object.fromEntries(SURFACES.map((s) => [s, { h: r4(f.coefficients[s].h), correlation: f.coefficients[s].correlation }])), film: { iterations: f.film_iterations.length, converged: f.film_converged },
      energy: f.balance, hotspot: f.hotspot, hotspot_c: f.hotspot.t_c, parts: f.parts.map((x) => ({ ...x, board_c: Number(x.board_c.toFixed(3)) })),
      assumptions: [...f.raster.assumptions, ...p.notes], ...(f.transient ? { transient: { metrics: f.transient.metrics } } : {}), calibration_evidence: p.evidence, caveats,
    }
    if (artifacts) {
      rec.artifact('report.md', report({
        title: `Thermal board model (CalculiX): ${p.env.name} at ${p.ambient} °C`, run_id: rec.id, solver: 'CalculiX ccx, DC3D8 bricks', board: p.path, envelope: p.env.name, environment: p.environment,
        ambient_c: p.ambient, sink_c: f.sink_c, coefficients: f.coefficients, film_iterations: f.film_iterations, film_converged: f.film_converged,
        mesh: { elements: f.mesh.stats.elements, nodes: f.mesh.stats.nodes, materials: f.mesh.stats.materials, 'element layers': f.mesh.stats.layers.join(', '), cell: `${p.cell} mm` },
        balance: { input_w: f.balance.input_w, out_w: f.balance.out_w, error: f.balance.error }, parts: f.parts, hotspot: { ...f.hotspot, layer: 'mesh node' },
        ...(f.transient ? { transient: f.transient.metrics } : {}), assumptions: out.assumptions, caveats,
      }), 'text/markdown')
    }
    return out
  }
  return cfdRun(a, p, rec, artifacts)
}

async function cfdRun(a: BoardArgs, p: Prepared, rec: Recorder, artifacts: boolean): Promise<Record<string, unknown> & { parts: { ref: string; board_c: number; power_w: number }[]; hotspot_c: number; ambient_c: number }> {
  const g = rasterise(p.path, { cell_mm: p.cell, power: p.power, emissivity: p.environment.emissivity, samples: a.samples })
  const m = g.model
  const thick = m.diel.reduce((s, d) => s + d.t, 0) + m.layers.reduce((s, l) => s + l.t_cu, 0)
  // the board's in-plane effective conductivity: thickness-weighted copper (mean coverage) and laminate
  const kEff = (m.layers.reduce((s, l, i) => s + m.copper.k * l.t_cu * (g.copper_fraction[i]?.fraction ?? 0), 0) + m.diel.reduce((s, d) => s + d.k_xy * d.t, 0)) / thick
  const N = m.nx * m.ny
  const parts = m.parts.map((q) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const nd of q.nodes) { const c = nd % N; const i = c % m.nx; const j = Math.floor(c / m.nx); x0 = Math.min(x0, i); x1 = Math.max(x1, i + 1); y0 = Math.min(y0, j); y1 = Math.max(y1, j + 1) }
    return { ref: q.ref, x0: m.origin_mm[0] * 1e-3 + x0 * m.dx, y0: m.origin_mm[1] * 1e-3 + y0 * m.dy, x1: m.origin_mm[0] * 1e-3 + x1 * m.dx, y1: m.origin_mm[1] * 1e-3 + y1 * m.dy, power_w: q.power_w }
  })
  const flow: CfdSetup['flow'] = a.cfd?.flow ?? (p.env.environment === 'forced' ? { kind: 'fixed', inlet: 'x-', outlet: 'x+', flow_m3_s: p.env.airflow_m_s * (m.ny * m.dy * 4 * Math.max(m.nx * m.dx, m.ny * m.dy)) } : { kind: 'natural' })
  const setup = boardSetup({ x0: m.origin_mm[0] * 1e-3, y0: m.origin_mm[1] * 1e-3, x1: m.origin_mm[0] * 1e-3 + m.nx * m.dx, y1: m.origin_mm[1] * 1e-3 + m.ny * m.dy, thickness: thick, k_eff: kEff, rho: 1850, cp: 1100, emissivity: p.environment.emissivity.top }, parts, {
    ambient_c: p.ambient, vertical: p.env.orientation === 'vertical', flow, radiation: a.cfd?.radiation ?? 'none', ...(a.cfd?.cell_m ? { cell_m: a.cfd.cell_m } : {}), refinement: a.cfd?.refinement ?? 2,
    body_height_m: a.bodies?.height_m ?? 1e-3, margin: a.cfd?.margin ?? 1, steady: !a.transient, procs: a.threads, probes: a.cfd?.probes ?? [], iterations: a.cfd?.iterations ?? 2000,
  })
  if (a.cfd?.enclosure_stl) Object.assign(setup, { enclosure_stl: resolve(a.cfd.enclosure_stl) })
  const caveats = [
    'Turbulence: laminar for natural convection, k-omega SST with wall functions for forced flow; check y+ and the flow regime.',
    'Fan curves are idealised: uniform over the inlet, no swirl or blade model.',
    'The mesh is only as good as the geometry: parts are boxes over their pads, the board one isotropic solid with its in-plane effective conductivity (through-thickness conduction over-stated).',
    'Run times are minutes to hours: CFD runs go to the CPU queue by default.',
  ]
  const c = writeCase(setup)
  if (artifacts) rec.artifact('case-files.txt', caseListing(c.files))
  if (artifacts) for (const [k, v] of c.files) rec.artifact(`case/${k}`, v)
  if (a.cfd?.write_only) {
    return { solver: 'cfd', written_only: true, openfoam: OPENFOAM_RELEASE, cells_estimate: c.cells, solver_app: c.solver, files: c.files.size, board: p.path, ambient_c: p.ambient, parts: [], hotspot_c: NaN, k_eff: r4(kEff), caveats }
  }
  const run = await runCfd(setup, { remote: a.remote })
  if (artifacts) {
    if (run.vtk) rec.artifact('vtk.tar.gz', run.vtk, 'application/gzip')
    if (run.logs) rec.artifact('logs.tar.gz', run.logs, 'application/gzip')
    if (run.post) rec.artifact('postProcessing.tar.gz', run.post, 'application/gzip')
  }
  const r = run.result
  const board = r.regions.find((x) => x.name === 'board')
  const partsOut = parts.map((q) => ({ ref: q.ref, power_w: q.power_w, board_c: r.regions.find((x) => x.name === `part_${q.ref.replace(/[^A-Za-z0-9_]/g, '_')}`)?.mean_c ?? board?.mean_c ?? NaN }))
  const hot = Math.max(...r.regions.map((x) => x.max_c ?? -Infinity))
  if (board?.h_eff && a.cfd?.store_h !== false && p.env.name !== 'inline') {
    for (const s of SURFACES) putCorrection({ envelope: p.env.name, name: `h_${s}`, value: board.h_eff, details: { from: 'cfd', note: 'the whole board\'s effective h (wallHeatFlux / (area x (surface mean - ambient))), applied to every surface', area_m2: board.area_m2, heat_w: board.heat_w, surface_c: board.surface_c }, evidence: [rec.id] })
  }
  if (artifacts && board) {
    rec.artifact('report.md', [
      `# Thermal CFD run: ${p.env.name} at ${p.ambient} °C`, '', `Run \`${rec.id}\`, ${OPENFOAM_RELEASE}, ${c.solver}, about ${c.cells} cells, ${run.where}.`, '',
      '## Regions', '', '| Region | max (°C) | mean (°C) | surface (°C) | heat out (W) | h_eff (W/m² K) |', '| --- | --- | --- | --- | --- | --- |',
      ...r.regions.map((x) => `| ${x.name} | ${x.max_c?.toFixed(2) ?? '—'} | ${x.mean_c?.toFixed(2) ?? '—'} | ${x.surface_c?.toFixed(2) ?? '—'} | ${x.heat_w?.toFixed(4) ?? '—'} | ${x.h_eff?.toFixed(3) ?? '—'} |`),
      '', '## Convergence', '', `${r.residuals.iterations} iterations; last initial residuals ${JSON.stringify(r.residuals.last)}; ${r.residuals.converged ? 'converged' : '**not converged**'}.`,
      '', `Energy: in ${r.balance.input_w} W, out ${r.balance.out_w.toFixed(4)} W (walls ${r.balance.walls_w.toFixed(4)}, enthalpy ${r.balance.enthalpy_w.toFixed(4)}), error ${r.balance.error === null ? '—' : (r.balance.error * 100).toFixed(2)} %.`,
      '', '## Caveats', '', ...caveats.map((x) => `- ${x}`), '',
    ].join('\n'), 'text/markdown')
  }
  return {
    solver: 'cfd', openfoam: OPENFOAM_RELEASE, solver_app: c.solver, where: run.where, seconds: r4(run.seconds), cells_estimate: c.cells, board: p.path, envelope: p.env.name, ambient_c: p.ambient,
    regions: r.regions, residuals: r.residuals, energy: r.balance, probes: r.probes, hotspot_c: hot, parts: partsOut, k_eff: r4(kEff),
    ...(board?.h_eff ? { h_eff_board: r4(board.h_eff), stored_h: a.cfd?.store_h !== false && p.env.name !== 'inline' } : {}), caveats,
  }
}

export const boardTool = defineTool({
  name: 'thermal.board',
  description: 'A board-level steady-state (optionally transient) thermal model from the .kicad_pcb, with the power from a budget and the envelope\'s environment at one ambient corner. solver=2.5d (default, fast, for every commit): a finite-volume grid, one node per copper layer (copper coverage rasterised from zones, tracks and pads; vias as vertical conductances; the stackup from the board setup), Jacobi-preconditioned CG. solver=calculix: 3D FEM with CalculiX ccx (bricks per copper layer and dielectric sublayer, coverage-weighted and orthotropic conductivity, optional component bodies), through runJob kind calculix. solver=cfd: OpenFOAM v2412 conjugate heat transfer (chtMultiRegionSimpleFoam / chtMultiRegionFoam) through runJob kind openfoam on the CPU queue, giving temperatures per region, probes, residuals, the energy balance and the effective h per surface, which is stored as the envelope\'s correction and fed back into the fast models; CFD limits: laminar for natural convection and k-omega SST for forced flow, idealised fan curves (uniform, no swirl), parts as boxes and the board as one isotropic solid (the mesh is only as good as that geometry), and runs of minutes to hours. For 2.5d and calculix, convection is the film coefficient from textbook correlations (natural: Churchill & Chu vertical, horizontal up/down; forced: flat plate) iterated on the film temperature until consistent (the converged h per surface is returned), plus linearised (2.5d) or exact (calculix) radiation; sealed enclosures through a lumped wall network; vacuum is radiation only. NO airflow is computed by 2.5d or calculix (no CFD); component bodies are not in the 2.5d model. Returns per-part board temperature under each footprint, the hot spot, the energy balance check, grid size and solve time; artifacts: temperature maps (PNG) and colour bar, CSV, VTU (ParaView), GLB (for thermal.render), the Markdown report, and the solver deck/logs. Recorded.',
  input: BoardInput,
  run: async (a) => {
    const rec = new Recorder(`thermal.board`, a.board ?? a.project ?? 'project', a)
    try {
      const out = await boardRun(a, rec)
      for (const p of out.parts) rec.measure(`${p.ref}.board_c`, p.board_c, 'C')
      rec.measure('hotspot_c', out.hotspot_c, 'C')
      const energy = (out as { energy?: { balance_error?: number; error?: number | null } }).energy
      const bal = energy?.balance_error ?? energy?.error ?? null
      if (bal !== null && bal !== undefined) rec.measure('energy_balance_error', bal, '')
      const ok = (out as { written_only?: boolean }).written_only || bal === null || bal === undefined || Math.abs(bal) < 0.02
      const result = { run_id: rec.id, ...out }
      rec.finish(ok ? 'pass' : 'fail', `${String(out.solver)}: hot spot ${Number.isFinite(out.hotspot_c) ? out.hotspot_c.toFixed(1) : '—'} °C at ${out.ambient_c} °C ambient; ${out.parts.map((x) => `${x.ref} ${Number.isFinite(x.board_c) ? x.board_c.toFixed(1) : '—'} °C`).join(', ')}`.slice(0, 300), result)
      return result
    } catch (e) {
      throw rec.fail(e)
    }
  },
})

// ------------------------------------------------------------------ thermal.check

export const checkTool = defineTool({
  name: 'thermal.check',
  description: 'One thermal verdict for the design across the envelope: the power budget, Tj per part at every ambient corner (thermal.junction\'s rules), and, with a board, the board model (thermal.board, 2.5d by default) run at each corner so psi_JB / theta_JB use the modelled board temperature. Verdict: pass (every part within the derated limit at every corner), at-risk (within Tj_max but past the derated limit), fail (above Tj_max), unknown (a part has no limit or no usable metric). Every part\'s Tj and margins are recorded as measurements (<ref>.tj_c, <ref>.margin_c, <ref>.derated_margin_c as the worst over the corners, and per corner), with the commit, so trends show across commits (trace.runs kind thermal.check). Returns the parts at risk, worst first.',
  input: BoardInput.extend({
    board_model: z.boolean().default(true).describe('run the board model when a board is given or configured'),
    heatsinks_junction: z.record(z.string(), HeatsinkIn).optional().describe('heatsinks on parts (theta_JC path)'),
    method: z.record(z.string(), z.enum(METHODS)).optional(),
    top_c: z.record(z.string(), z.number()).optional(),
  }),
  run: async (a) => {
    const e = envelopeOf(a)
    const { power, source } = powerOf(a)
    const limits = new Map((e.name === 'inline' ? [] : getPartLimits(e.name)).map((p) => [p.ref, p]))
    const work = new Work()
    const sha = gitSha()
    const id = work.start('thermal.check', { subject: e.name, args: a, ...(sha ? { gitSha: sha } : {}) })
    work.close()
    const rec = new RecorderOn(id)
    try {
      const corners = cornersOf(e)
      const results: JunctionResult[] = []
      const boards: { ambient_c: number; run: string; hotspot_c: number; balance?: unknown }[] = []
      let withBoard = a.board_model && Boolean(a.board || a.project)
      if (a.board_model && !withBoard) { try { await boardPath(a); withBoard = true } catch { withBoard = false } }
      for (const ta of corners) {
        let boardC: Map<string, number> | null = null
        if (withBoard) {
          const sub = new Recorder('thermal.board', a.board ?? a.project ?? 'project', { ...a, ambient_c: ta, via: `thermal.check ${id}` })
          try {
            const out = await boardRun({ ...a, ambient_c: ta }, sub, { ambient: ta })
            boardC = new Map(out.parts.map((p) => [p.ref, p.board_c]))
            for (const p of out.parts) sub.measure(`${p.ref}.board_c`, p.board_c, 'C')
            sub.measure('hotspot_c', out.hotspot_c, 'C')
            sub.finish('pass', `board at ${ta} °C: hot spot ${out.hotspot_c.toFixed(1)} °C`, { ...out, run_id: sub.id })
            boards.push({ ambient_c: ta, run: sub.id, hotspot_c: out.hotspot_c, balance: (out as { energy?: unknown }).energy })
          } catch (err) { throw sub.fail(err) }
        }
        for (const [ref, pw] of power) {
          results.push(junction({
            ref, power_w: pw, limits: limits.get(ref), ambient_c: ta, derating: e.derating,
            ...(boardC?.has(ref) ? { board_c: boardC.get(ref)! } : {}), ...(a.top_c?.[ref] !== undefined ? { top_c: a.top_c[ref] } : {}),
            ...(a.heatsinks_junction?.[ref] ? { heatsink: a.heatsinks_junction[ref] } : {}), ...(a.method?.[ref] ? { method: a.method[ref] } : {}),
          }))
        }
      }
      for (const j of results) {
        rec.measure(`${j.ref}.tj_c@${j.ambient_c}`, j.tj_c, 'C', { method: j.method, status: j.status })
        rec.measure(`${j.ref}.derated_margin_c@${j.ambient_c}`, j.derated_margin_c, 'C')
      }
      const perPart = [...power.keys()].map((ref) => {
        const js = results.filter((j) => j.ref === ref)
        const w = js.reduce((x, y) => ((y.derated_margin_c ?? -Infinity) < (x.derated_margin_c ?? -Infinity) ? y : x), js[0]!)
        rec.measure(`${ref}.tj_c`, Math.max(...js.map((j) => j.tj_c ?? -Infinity).filter(Number.isFinite)), 'C')
        rec.measure(`${ref}.margin_c`, w.margin_c, 'C')
        rec.measure(`${ref}.derated_margin_c`, w.derated_margin_c, 'C', { corner: w.ambient_c })
        return { ref, worst_corner_c: w.ambient_c, tj_c: r4(w.tj_c), tj_max_c: w.tj_max_c, derated_limit_c: w.derated_limit_c, margin_c: r4(w.margin_c), derated_margin_c: r4(w.derated_margin_c), status: worst(js.map((j) => j.status)), method: w.method, caveat: w.caveat, ...(w.why ? { why: w.why } : {}), below_min: js.some((j) => j.below_min) }
      }).sort((x, y) => (x.derated_margin_c ?? -Infinity) - (y.derated_margin_c ?? -Infinity))
      const verdict = worst(perPart.map((p) => p.status))
      const minMargin = Math.min(...perPart.map((p) => p.derated_margin_c ?? Infinity))
      rec.measure('worst_derated_margin_c', Number.isFinite(minMargin) ? minMargin : null, 'C')
      rec.measure('verdict_pass', verdict === 'pass' ? 1 : 0)
      const out = {
        run_id: id, envelope: e.name, verdict, corners, power_source: source, total_power_w: r4([...power.values()].reduce((s, x) => s + x, 0)), commit: sha,
        at_risk: perPart.filter((p) => p.status !== 'pass'), parts: perPart, board_runs: boards,
        derating: e.derating, note: verdict === 'unknown' ? 'parts without Tj_max or a usable metric: add them with thermal.envelope set_parts (cited)' : undefined,
      }
      rec.artifact('check.csv', csv(['ref', 'ambient_c', 'power_w', 'method', 'tj_c', 'tj_max_c', 'derated_limit_c', 'margin_c', 'derated_margin_c', 'status'], results.map((j) => [j.ref, j.ambient_c, j.power_w, j.method ?? '', j.tj_c ?? NaN, j.tj_max_c ?? NaN, j.derated_limit_c ?? NaN, j.margin_c ?? NaN, j.derated_margin_c ?? NaN, j.status])), 'text/csv')
      rec.finish(verdict === 'pass' ? 'pass' : 'fail', `${verdict}: ${out.at_risk.map((p) => `${p.ref} ${p.status} (${p.derated_margin_c?.toFixed(1)} °C to derated)`).join(', ') || `every part within the derated limit; least margin ${minMargin.toFixed(1)} °C`}`, out)
      return out
    } catch (err) {
      throw rec.fail(err)
    }
  },
})

/** A Recorder-like writer for a run started elsewhere (thermal.check starts its run with the commit). */
class RecorderOn {
  constructor(readonly id: string) {}
  private with<T>(f: (w: Work) => T): T { const w = new Work(); try { return f(w) } finally { w.close() } }
  measure(name: string, value: number | null, unit = '', detail?: unknown): void { this.with((w) => w.measure(this.id, name, value !== null && Number.isFinite(value) ? value : null, unit, detail)) }
  artifact(name: string, data: string | Uint8Array, mime?: string): void { if (data.length) this.with((w) => w.artifact(this.id, name, data, mime)) }
  finish(status: 'pass' | 'fail' | 'error', summary: string, result: unknown): void { this.with((w) => w.finish(this.id, status, summary.slice(0, 300), result)) }
  fail(e: unknown): unknown { try { this.finish('error', e instanceof Error ? e.message : String(e), { error: String(e) }) } catch { /* best effort */ } return e }
}

// ------------------------------------------------------------------ thermal.validate

export const validateTool = defineTool({
  name: 'thermal.validate',
  description: 'Validate a solver against closed forms at two mesh sizes (src/tools/thermal/validation.ts): 1D conduction through a 2-layer board (slab), a fin heated at one end with an adiabatic tip (Incropera table 3.4), and a plate with a central disc source (the infinite-plate Bessel solution). Reports the model value, the reference, the error and the stated tolerance per case and mesh, so mesh convergence shows. solver=cfd writes the textbook vertical-plate natural-convection case at two mesh levels (compared with Churchill & Chu) and runs it when OpenFOAM or the CPU queue is available. Recorded.',
  input: z.object({ solver: z.enum(['2.5d', 'calculix', 'cfd']).default('2.5d'), cases: z.array(z.enum(['slab', 'fin', 'plate'])).optional(), remote: z.enum(['auto', 'always', 'never']).default('auto'), write_only: z.boolean().default(false) }),
  run: async (a) => {
    const rec = new Recorder('thermal.validate', a.solver, a)
    try {
      if (a.solver === 'cfd') {
        const levels = [0, 1].map((l) => verticalPlateCase(l))
        const rows: Record<string, unknown>[] = []
        for (const [i, c] of levels.entries()) {
          const w = writeCase(c.setup)
          rec.artifact(`level${i}/case-files.txt`, caseListing(w.files))
          if (a.write_only) { rows.push({ level: i, cells_estimate: w.cells, ran: false }); continue }
          const run = await runCfd(c.setup, { remote: a.remote })
          const plate = run.result.regions[0]!
          const ref = plate.surface_c !== null ? c.reference(plate.surface_c) : NaN
          rows.push({ level: i, cells_estimate: w.cells, ran: true, h_eff: plate.h_eff, churchill_chu: ref, error_pct: plate.h_eff ? (100 * (plate.h_eff - ref)) / ref : null, tolerance_pct: 15 })
        }
        const out = { run_id: rec.id, solver: 'cfd', openfoam: OPENFOAM_RELEASE, rows }
        rec.finish(a.write_only ? 'pass' : rows.every((r) => r.error_pct !== null && Math.abs(r.error_pct as number) <= 15) ? 'pass' : 'fail', a.write_only ? 'vertical-plate cases written (not run)' : `vertical plate: ${rows.map((r) => `${(r.error_pct as number | null)?.toFixed(1)} %`).join(', ')}`, out)
        return out
      }
      const rows = await validate(a.solver, a.cases)
      for (const r of rows) rec.measure(`${r.case}@${r.cell_mm}mm.error_pct`, r.error_pct, '%')
      const out = { run_id: rec.id, solver: a.solver, rows: rows.map((r) => ({ ...r, model: r4(r.model), reference: r4(r.reference), error_pct: r4(r.error_pct) })), all_pass: rows.every((r) => r.pass) }
      rec.finish(out.all_pass ? 'pass' : 'fail', rows.map((r) => `${r.case}@${r.cell_mm}mm ${r.error_pct.toFixed(2)}%`).join(', '), out)
      return out
    } catch (e) { throw rec.fail(e) }
  },
})

// ------------------------------------------------------------------ thermal.measure

export const measureTool = defineTool({
  name: 'thermal.measure',
  description: 'Bench temperatures at stated points through the HIL plumbing (needs hardware allowed): the DMM\'s temperature function (CONF:TEMP TC,K / RTD / FRTD / THER), a platinum RTD read as resistance (IEC 60751 Callendar-Van Dusen), any SCPI query, firmware serial telemetry (a regex), or a manual reading with a note. Each point is compared with the model: a thermal.board run\'s per-part board temperature (by ref) or a stated prediction; error = predicted - measured, and its share of the rise. Calibration (heater): with a heater at a stated power, the measured ambient and a 2.5d thermal.board run, the model is re-run with a multiplier on its convective h until its mean rise matches the measured mean rise; the multiplier is stored as the envelope\'s correction with both run ids (a calibration of this board in this setup, not a measurement of h). Recorded.',
  hardware: true,
  input: z.object({
    points: z.array(z.object({ name: z.string(), ref: z.string().optional().describe('the part whose modelled board temperature this point is compared with'), predicted_c: z.number().optional(), source: PointSource }).strict()).min(1),
    model_run: z.string().optional().describe('a thermal.board run id to compare with'),
    ambient_c: z.number().optional().describe('the measured ambient during the test'),
    calibrate: z.object({ envelope: z.string(), heater_ref: z.string().optional(), heater_power_w: z.number().positive().describe('the heater\'s stated power (W), as set on the PSU') }).strict().optional(),
  }),
  run: async (a) => {
    const rec = new Recorder('thermal.measure', a.model_run ?? 'bench', a)
    try {
      let predicted = new Map<string, number>()
      let modelArgs: BoardArgs | null = null
      let modelAmbient: number | null = null
      if (a.model_run) {
        const w = new Work()
        try {
          const r = w.run(a.model_run)
          if (!r || r.kind !== 'thermal.board') throw new ToolError(`${a.model_run} is not a thermal.board run`)
          const res = r.result as { parts?: { ref: string; board_c: number }[]; ambient_c?: number; solver?: string }
          predicted = new Map((res.parts ?? []).map((p) => [p.ref, p.board_c]))
          modelAmbient = res.ambient_c ?? null
          if (res.solver === '2.5d') modelArgs = BoardInput.parse(r.args)
        } finally { w.close() }
      }
      const points: PointResult[] = []
      const logs: string[] = []
      for (const p of a.points) {
        const rd = await read(p.source)
        logs.push(`## ${p.name}: ${rd.how}`, ...rd.log)
        const pred = p.predicted_c ?? (p.ref ? predicted.get(p.ref) : undefined) ?? null
        const amb = a.ambient_c ?? modelAmbient
        const err = pred === null ? null : pred - rd.value_c
        points.push({ name: p.name, ref: p.ref, measured_c: rd.value_c, predicted_c: pred, error_c: err, error_pct_of_rise: err !== null && amb !== null && rd.value_c - amb !== 0 ? (100 * err) / (rd.value_c - amb) : null, how: rd.how })
        rec.measure(`${p.name}.measured_c`, rd.value_c, 'C', { how: rd.how, samples: rd.samples })
        if (err !== null) rec.measure(`${p.name}.error_c`, err, 'C')
      }
      rec.artifact('readings.log', logs.join('\n'))
      const stats = errorStats(points)
      let calibration: Record<string, unknown> | null = null
      if (a.calibrate) {
        if (a.ambient_c === undefined) throw new ToolError('calibration needs the measured ambient_c')
        if (!modelArgs) throw new ToolError('calibration needs model_run: a 2.5d thermal.board run (its inputs are re-run with the h multiplier)')
        const refs = a.points.filter((p) => p.ref)
        if (!refs.length) throw new ToolError('calibration needs points with ref (the parts the thermocouples sit on)')
        const power = { ...(modelArgs.power ?? Object.fromEntries(powerOf(modelArgs).power)) }
        if (a.calibrate.heater_ref) power[a.calibrate.heater_ref] = a.calibrate.heater_power_w
        const args: BoardArgs = { ...modelArgs, power, scenario: undefined, ambient_c: a.ambient_c, use_correction: false }
        const measured = refs.map((p) => points.find((x) => x.name === p.name)!.measured_c)
        const fit = await fitMultiplier(measured, a.ambient_c, async (mult) => {
          const out = await boardRun(args, rec, { h_multiplier: mult, ambient: a.ambient_c, artifacts: false })
          return refs.map((p) => out.parts.find((x) => x.ref === p.ref)?.board_c ?? NaN)
        })
        calibration = { ...fit, envelope: a.calibrate.envelope, heater_power_w: a.calibrate.heater_power_w, heater_ref: a.calibrate.heater_ref ?? null }
        if (fit.converged) {
          putCorrection({ envelope: a.calibrate.envelope, name: 'h_multiplier', value: fit.multiplier, details: { fit, points, ambient_c: a.ambient_c, heater_power_w: a.calibrate.heater_power_w }, evidence: [a.model_run!, rec.id] })
          rec.measure('h_multiplier', fit.multiplier, '')
        }
      }
      const out = { run_id: rec.id, points, error: stats, ...(calibration ? { calibration } : {}) }
      rec.finish('pass', `${points.length} point(s)${stats.n ? `, error mean ${stats.mean_c!.toFixed(2)} °C, max ${stats.max_abs_c!.toFixed(2)} °C` : ''}${calibration ? `, h multiplier ${(calibration.multiplier as number).toPrecision(4)}` : ''}`, out)
      return out
    } catch (e) { throw rec.fail(e) }
  },
})

// ------------------------------------------------------------------ thermal.derating

export const deratingTool = defineTool({
  name: 'thermal.derating',
  description: 'Derating curves (table thermal_derating): the allowed power or current against ambient or temperature, as a datasheet gives it, with its citation. action=set (points, or from_table: read a datasheet table\'s two columns through datasheets.tables, cited mpn/sha256/page), get, check (an operating point against the curve: allowed value by linear interpolation, margin, pass/fail; outside the curve\'s range is reported out-of-range, never passed).',
  input: z.object({
    action: z.enum(['set', 'get', 'check']),
    ref: z.string().optional(), curve: z.string().optional().describe('e.g. power_vs_ambient, current_vs_temperature'),
    x_unit: z.string().optional(), y_unit: z.string().optional(),
    points: z.array(z.tuple([z.number(), z.number()])).optional(), citation: CitationSchema.optional(),
    from_table: z.object({ mpn: z.string(), page: z.number().int().min(1), table: z.number().int().min(0).default(0), x_col: z.number().int().min(0), y_col: z.number().int().min(0), library: z.string().optional() }).strict().optional(),
    x: z.number().optional().describe('check: the temperature'), y: z.number().optional().describe('check: the operating value'),
  }),
  run: async (a) => {
    if (a.action === 'get') return { curves: getCurves(a.ref) }
    if (!a.ref || !a.curve) throw new ToolError(`${a.action} needs ref and curve`)
    if (a.action === 'set') {
      let points = a.points
      let citation = a.citation
      if (a.from_table) {
        const L = library(a.from_table.library)
        const { entry, version } = await L.version(a.from_table.mpn)
        const t = await new PdfReader().tables(await L.localPath(version.sha256), version.sha256, a.from_table.page)
        const tb = t.tables[a.from_table.table]
        if (!tb) throw new ToolError(`page ${a.from_table.page} has ${t.tables.length} table(s)`)
        points = pointsFromTable(tb.rows, a.from_table.x_col, a.from_table.y_col)
        citation = { mpn: entry.key, sha256: version.sha256, page: a.from_table.page }
      }
      if (!points || !citation) throw new ToolError('set needs points with citation, or from_table')
      return { saved: putCurve({ ref: a.ref, curve: a.curve, x_unit: a.x_unit ?? null, y_unit: a.y_unit ?? null, points, citation }) }
    }
    const c = getCurves(a.ref).find((x) => x.curve === a.curve)
    if (!c) throw new ToolError(`no curve ${a.ref}/${a.curve}`)
    if (a.x === undefined || a.y === undefined) throw new ToolError('check needs x and y')
    return { ref: a.ref, curve: a.curve, ...checkPoint(c.points, a.x, a.y), x_unit: c.x_unit, y_unit: c.y_unit, citation: c.citation }
  },
})

// ------------------------------------------------------------------ thermal.compare

export const compareTool = defineTool({
  name: 'thermal.compare',
  description: 'Overlay two temperature time series, as Antmicro\'s tpost compare-csv does: each from a run\'s CSV artifact (transient.csv of thermal.board, or any CSV with time in the first column) or inline points (measurements). The second is interpolated onto the first\'s times; returns max |difference|, RMS, mean and end difference, and stores the overlay plot and the merged CSV. Recorded.',
  input: z.object({
    a: z.object({ run: z.string().optional(), artifact: z.string().default('transient.csv'), column: z.string(), points: z.array(z.tuple([z.number(), z.number()])).optional() }).strict(),
    b: z.object({ run: z.string().optional(), artifact: z.string().default('transient.csv'), column: z.string(), points: z.array(z.tuple([z.number(), z.number()])).optional() }).strict(),
  }),
  run: (a) => {
    const load = (s: typeof a.a, tag: string) => {
      if (s.points) return { name: `${tag}:${s.column}`, t: s.points.map((p) => p[0]), y: s.points.map((p) => p[1]) }
      if (!s.run) throw new ToolError(`${tag}: give run (with artifact) or points`)
      const all = seriesFromCsv(new TextDecoder().decode(readArtifact(s.run, s.artifact)), `${tag}:`)
      const f = all.find((x) => x.name === `${tag}:${s.column}`)
      if (!f) throw new ToolError(`${tag}: ${s.artifact} of ${s.run} has no column ${s.column} (it has ${all.map((x) => x.name.slice(tag.length + 1)).join(', ')})`)
      return f
    }
    const sa = load(a.a, 'a')
    const sb = load(a.b, 'b')
    const c = compare(sa, sb)
    const rec = new Recorder('thermal.compare', `${sa.name} vs ${sb.name}`, a)
    rec.artifact('compare.png', linePlot([sa, sb]), 'image/png')
    rec.artifact('compare.csv', csv(['time_s', sa.name, sb.name], sa.t.map((t, i) => [t, sa.y[i]!, sb.t.length ? (sb.y[sb.t.findIndex((x) => x >= t)] ?? NaN) : NaN])), 'text/csv')
    rec.measure('max_abs_c', c.max_abs_c, 'C')
    rec.measure('rms_c', c.rms_c, 'C')
    rec.finish('pass', `${sb.name} - ${sa.name}: max ${c.max_abs_c.toFixed(2)} °C, RMS ${c.rms_c.toFixed(2)} °C`, c)
    return { run_id: rec.id, ...c }
  },
})

// ------------------------------------------------------------------ thermal.render

export const renderTool = defineTool({
  name: 'thermal.render',
  description: 'Render a thermal.board run\'s temperature-coloured board (its board.glb: the slab with the top and bottom temperature maps as textures) through the Blender pipeline (runJob kind blender: local, or the GPU queue), as stills (views) or a turntable; the colour-scale bar is copied from the run. Slow on a CPU; only when renders are wanted. Recorded with the images as artifacts.',
  input: z.object({
    run: z.string().describe('a thermal.board run id'),
    views: z.array(z.enum(['top', 'bottom', 'iso', 'front', 'back', 'left', 'right'])).min(1).max(7).default(['top', 'iso']),
    turntable_frames: z.number().int().min(2).max(360).optional().describe('a turntable instead of stills'),
    width: z.number().int().min(16).max(7680).optional(), height: z.number().int().min(16).max(4320).optional(), samples: z.number().int().min(1).max(4096).optional(),
    device: DeviceWant.optional(), timeout_s: z.number().int().min(10).max(4 * 3600).default(1800),
  }),
  run: async (a) => {
    const glb = readArtifact(a.run, 'board.glb')
    const dir = scratchDir('trace-thermal-render-')
    try {
      const p = join(dir, 'thermal.glb')
      writeFileSync(p, glb)
      const r = await renderGeneratedModel({
        kind: 'thermal.render', path: p, args: a, views: a.views, ...(a.turntable_frames ? { frames: a.turntable_frames } : {}),
        width: a.width, height: a.height, samples: a.samples, device: a.device, timeout_s: a.timeout_s,
      })
      const id = String(r.run_id)
      const w = new Work()
      try {
        const bar = w.getArtifact(a.run, 'colourbar.png')
        if (bar) w.artifact(id, 'colourbar.png', bar, 'image/png')
      } finally { w.close() }
      return { ...r, from_run: a.run, colourbar: 'colourbar.png' }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
})

/** The thermal tools. */
export const tools: AnyTool[] = [envelopeTool, budgetTool, junctionTool, pcbTool, boardTool, checkTool, validateTool, measureTool, deratingTool, compareTool, renderTool] as unknown as AnyTool[]

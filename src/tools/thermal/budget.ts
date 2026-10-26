/**
 * The power budget: the dissipation of each part, with where each figure came from, and totals per rail and for the
 * board. Sources, in priority order (a part given by several keeps the first; the others are listed as
 * alternatives so a person can see the disagreement):
 *
 *   explicit    a figure someone stated, with its source
 *   spice       an ngspice operating point (sim.spice's simulate): P from the device's power vector (@r1[p],
 *               @q1[p], @m1[p]); for a diode V(a, k) x @d1[id] (ngspice 42's @d[p] is not usable); or any vector
 *               named by `vector`. The run is recorded; each figure cites its run id
 *   regulator   LDO: (Vin - Vout) Iout + Vin Iq (calc.ldo_thermal, TI SLVA118A); buck/boost:
 *               P_loss = Pout (1 - eta) / eta with eta from the datasheet's efficiency curve (cited) or, without
 *               one, a stated assumption (flagged)
 *   datasheet   a typical/maximum dissipation, or V x I_typ/I_max, from a datasheet page (mpn, sha256, page)
 */
import { z } from 'zod'
import { ToolError } from '../../core/registry.js'
import { ldoThermal } from '../calc/power.js'
import { Recorder } from '../sim/record.js'
import { simulate, SpiceError } from '../sim/spice.js'
import { CitationSchema } from './store.js'

const ref = z.string().min(1).describe('reference designator, e.g. U3')
const rail = z.string().optional().describe('the rail the part draws from (for the per-rail totals)')

export const ExplicitEntry = z.object({
  method: z.literal('explicit'), ref, rail, power_w: z.number().min(0), power_max_w: z.number().min(0).optional(),
  citation: CitationSchema.describe('{source: "..."} or a datasheet {mpn, sha256, page}'),
}).strict()

export const RegulatorEntry = z.object({
  method: z.literal('regulator'), ref, rail,
  kind: z.enum(['ldo', 'buck', 'boost']),
  vin: z.number().positive(), vout: z.number().positive(), iout: z.number().min(0), iout_max: z.number().min(0).optional(),
  iq: z.number().min(0).optional().describe('LDO quiescent / ground current (A)'),
  efficiency: z.number().gt(0).max(1).optional().describe('buck/boost efficiency at this operating point'),
  citation: CitationSchema.optional().describe('where Iq or the efficiency comes from (datasheet page)'),
}).strict()

export const DatasheetEntry = z.object({
  method: z.literal('datasheet'), ref, rail, mpn: z.string(),
  power_w: z.number().min(0).optional(), power_max_w: z.number().min(0).optional(),
  voltage_v: z.number().positive().optional(), current_a: z.number().min(0).optional(), current_max_a: z.number().min(0).optional(),
  citation: CitationSchema,
}).strict()

export const BudgetEntry = z.discriminatedUnion('method', [ExplicitEntry, RegulatorEntry, DatasheetEntry])
export type BudgetEntry = z.output<typeof BudgetEntry>

export const SpiceSource = z.object({
  netlist: z.string().optional().describe('netlist text'),
  file: z.string().optional().describe('or a netlist file'),
  devices: z.array(z.object({ ref, device: z.string().describe('the SPICE instance name, e.g. R1, Q2, D1'), rail, vector: z.string().optional().describe('a power vector to use instead, e.g. @m1[p]') }).strict()).min(1),
  params: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
}).strict()
export type SpiceSource = z.output<typeof SpiceSource>

export interface BudgetLine {
  ref: string
  rail: string | null
  power_w: number
  power_max_w: number | null
  method: 'explicit' | 'spice' | 'regulator' | 'datasheet'
  citation: unknown
  formula?: string
  assumption?: string
  alternatives?: { method: string; power_w: number }[]
}

const PRIORITY = ['explicit', 'spice', 'regulator', 'datasheet'] as const

function regulatorLine(e: z.output<typeof RegulatorEntry>): BudgetLine {
  if (e.kind === 'ldo') {
    if (e.vout >= e.vin) throw new ToolError(`${e.ref}: an LDO needs vout below vin`)
    const r = ldoThermal({ vin: e.vin, vout: e.vout, current: e.iout, iq: e.iq ?? 0, theta_ja: 1 })
    const max = e.iout_max !== undefined ? ldoThermal({ vin: e.vin, vout: e.vout, current: e.iout_max, iq: e.iq ?? 0, theta_ja: 1 }).power_w as number : null
    return {
      ref: e.ref, rail: e.rail ?? null, power_w: r.power_w as number, power_max_w: max, method: 'regulator', citation: e.citation ?? { source: 'calc.ldo_thermal (TI SLVA118A)' },
      formula: `(${e.vin} - ${e.vout}) V x ${e.iout} A + ${e.vin} V x ${e.iq ?? 0} A`, ...(e.iq === undefined ? { assumption: 'Iq not given: taken as 0' } : {}),
    }
  }
  const eta = e.efficiency ?? 0.85
  const loss = (i: number): number => (e.vout * i * (1 - eta)) / eta
  return {
    ref: e.ref, rail: e.rail ?? null, power_w: loss(e.iout), power_max_w: e.iout_max !== undefined ? loss(e.iout_max) : null, method: 'regulator',
    citation: e.citation ?? { source: 'P_loss = Pout (1 - eta) / eta' }, formula: `${e.vout} V x ${e.iout} A x (1 - ${eta}) / ${eta}`,
    ...(e.efficiency === undefined || !e.citation ? { assumption: e.efficiency === undefined ? 'efficiency not given: 0.85 assumed (read it from the datasheet\'s efficiency curve at this load)' : 'efficiency has no citation' } : {}),
  }
}

function datasheetLine(e: z.output<typeof DatasheetEntry>): BudgetLine {
  let p = e.power_w
  let formula: string | undefined
  if (p === undefined) {
    if (e.voltage_v === undefined || e.current_a === undefined) throw new ToolError(`${e.ref}: a datasheet entry needs power_w, or voltage_v with current_a`)
    p = e.voltage_v * e.current_a
    formula = `${e.voltage_v} V x ${e.current_a} A`
  }
  const pMax = e.power_max_w ?? (e.voltage_v !== undefined && e.current_max_a !== undefined ? e.voltage_v * e.current_max_a : null)
  return { ref: e.ref, rail: e.rail ?? null, power_w: p, power_max_w: pMax, method: 'datasheet', citation: { ...e.citation, mpn_part: e.mpn }, ...(formula ? { formula } : {}) }
}

/** The instance's nodes from its netlist line (the tokens after the name), for a diode's voltage. */
function nodesOf(netlist: string, device: string): string[] {
  const re = new RegExp(`^\\s*${device.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\S+)\\s+(\\S+)`, 'im')
  const m = re.exec(netlist)
  return m ? [m[1]!, m[2]!] : []
}

/** Run one operating point and read each device's dissipation. Recorded as a run of kind thermal.budget.spice. */
export async function spiceLines(src: SpiceSource, readFile: (p: string) => string): Promise<{ lines: BudgetLine[]; run_id: string }> {
  const netlist = src.netlist ?? (src.file ? readFile(src.file) : undefined)
  if (!netlist) throw new ToolError('spice: give netlist or file')
  const save: string[] = []
  const plan = src.devices.map((d) => {
    const dev = d.device.toLowerCase()
    if (d.vector) { save.push(d.vector.toLowerCase()); return { d, kind: 'vector' as const, vec: d.vector.toLowerCase() } }
    if (dev.startsWith('d')) {
      const [a, k] = nodesOf(netlist, d.device)
      if (!a || !k) throw new ToolError(`spice: ${d.device} is not in the netlist`)
      save.push(`@${dev}[id]`, ...[a, k].map((n) => n.toLowerCase()).filter((n) => n !== '0' && n !== 'gnd').map((n) => `v(${n})`))
      return { d, kind: 'diode' as const, vec: `@${dev}[id]`, a: a.toLowerCase(), k: k.toLowerCase() }
    }
    if (!/^[rqmj]/.test(dev)) throw new ToolError(`spice: ${d.device}: give \`vector\` (only R, Q, M, J and D instances have a known power vector)`)
    save.push(`@${dev}[p]`)
    return { d, kind: 'vector' as const, vec: `@${dev}[p]` }
  })
  const rec = new Recorder('thermal.budget.spice', src.file ?? 'netlist', { devices: src.devices, params: src.params })
  try {
    const run = await simulate({ netlist, analyses: ['.op'], save: [...new Set(save)], ...(src.params ? { params: src.params } : {}), ...(src.file ? { baseDir: process.cwd() } : {}) })
    rec.artifact('netlist.cir', run.netlist)
    rec.artifact('ngspice.log', run.log)
    const plot = run.plots[0]
    if (!plot) throw new ToolError('spice: no operating point came back')
    const v = (name: string): number => {
      const x = plot.vectors.get(name)?.[0]
      if (x === undefined || !Number.isFinite(x)) throw new ToolError(`spice: ${name} is not in the operating point (or not finite)`)
      return x
    }
    const vn = (n: string): number => (n === '0' || n === 'gnd' ? 0 : v(`v(${n})`))
    const lines: BudgetLine[] = plan.map((p) => {
      const pw = p.kind === 'diode' ? (vn(p.a) - vn(p.k)) * v(p.vec) : v(p.vec)
      rec.measure(`${p.d.ref}.power_w`, pw, 'W', { device: p.d.device })
      return { ref: p.d.ref, rail: p.d.rail ?? null, power_w: Math.abs(pw), power_max_w: null, method: 'spice', citation: { run_id: rec.id, vector: p.vec }, formula: p.kind === 'diode' ? `V(${p.a},${p.k}) x ${p.vec}` : p.vec }
    })
    rec.finish('pass', `operating point: ${lines.map((l) => `${l.ref} ${(l.power_w * 1e3).toPrecision(3)} mW`).join(', ')}`.slice(0, 300), { lines })
    return { lines, run_id: rec.id }
  } catch (e) {
    if (e instanceof SpiceError) { if (e.log) rec.artifact('ngspice.log', e.log); throw rec.fail(new ToolError(e.message)) }
    throw rec.fail(e)
  }
}

export interface Budget { lines: BudgetLine[]; rails: { rail: string; power_w: number; power_max_w: number; parts: string[] }[]; total_w: number; total_max_w: number }

/** Merge entries and SPICE lines by priority, then total them. */
export function assemble(entries: readonly BudgetEntry[], spice: readonly BudgetLine[] = []): Budget {
  const all: BudgetLine[] = [
    ...entries.filter((e) => e.method === 'explicit').map((e): BudgetLine => ({ ref: e.ref, rail: e.rail ?? null, power_w: e.power_w, power_max_w: e.power_max_w ?? null, method: 'explicit', citation: e.citation })),
    ...spice,
    ...entries.filter((e) => e.method === 'regulator').map(regulatorLine),
    ...entries.filter((e) => e.method === 'datasheet').map(datasheetLine),
  ]
  const byRef = new Map<string, BudgetLine>()
  for (const m of PRIORITY) {
    for (const l of all.filter((x) => x.method === m)) {
      const have = byRef.get(l.ref)
      if (!have) byRef.set(l.ref, { ...l })
      else (have.alternatives ??= []).push({ method: l.method, power_w: l.power_w })
    }
  }
  const lines = [...byRef.values()].sort((a, b) => b.power_w - a.power_w)
  const rails = new Map<string, { rail: string; power_w: number; power_max_w: number; parts: string[] }>()
  for (const l of lines) {
    const k = l.rail ?? '(no rail)'
    const r = rails.get(k) ?? { rail: k, power_w: 0, power_max_w: 0, parts: [] }
    r.power_w += l.power_w
    r.power_max_w += l.power_max_w ?? l.power_w
    r.parts.push(l.ref)
    rails.set(k, r)
  }
  return {
    lines, rails: [...rails.values()].sort((a, b) => b.power_w - a.power_w),
    total_w: lines.reduce((s, l) => s + l.power_w, 0), total_max_w: lines.reduce((s, l) => s + (l.power_max_w ?? l.power_w), 0),
  }
}

/**
 * The case's settings, `mechanical/case.json` (docs/enclosure-build.md, "Case settings"): the source of truth for its
 * shape (the Python engine re-checks it). Every value has a recommendation, the default here; a value changed away
 * from it carries a reason in `reasons`, keyed by its path (`params.wall_mm`, `clearance.parts.J1`), and mech.settings
 * refuses the change without one, as every choice against a recommendation in trace does.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ToolError } from '../../core/registry.js'
import { isRepoRelative, readRepoFile, writeRepoFile } from './paths.js'

export const MECH_DIR = 'mechanical'
export const CASE_JSON = `${MECH_DIR}/case.json`
export const CASE_PY = `${MECH_DIR}/case.py`
export const OUT_DIR = `${MECH_DIR}/out`

const mm = z.number().finite()
const positive = mm.positive()
const nonNeg = mm.min(0)
const Ref = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,30}$/, 'a part reference such as J1')

export const ProcessSchema = z.object({
  service: z.string().min(1).default('jlc3dp'),
  process: z.string().min(1).default('MJF'),
  material: z.string().min(1).default('PA12-HP'),
}).prefault({})

export const ParamsSchema = z.object({
  wall_mm: positive.default(2.0),
  floor_mm: positive.default(2.0),
  lid_mm: positive.default(2.0),
  corner_radius_mm: nonNeg.default(3.0),
  standoff_d_mm: positive.default(7.0),
  lip_mm: positive.default(2.0),
  lip_h_mm: positive.default(3.0),
}).prefault({})

export const PartClearance = z.object({ mm: nonNeg, reason: z.string().min(3) })

export const ClearanceSchema = z.object({
  edge_mm: nonNeg.default(0.5),
  above_tallest_mm: nonNeg.default(1.0),
  below_mm: nonNeg.default(1.0),
  parts: z.record(Ref, PartClearance).default({}),
}).prefault({})

export const OpeningsSchema = z.object({
  skip: z.array(Ref).default([]),
  extra_mm: nonNeg.default(0.5),
}).prefault({})

/** A path in the repository, relative to its root: no absolute path, no '..' or '.' segment, no backslash. */
const RepoPath = z.string().min(1).max(512).refine(isRepoRelative, { message: "a path relative to the repository's root (no leading '/', no '..' segment, no backslash)" })

export const CaseSettingsSchema = z.object({
  version: z.literal(1).default(1),
  board: RepoPath,
  template: z.literal('printed-shell').default('printed-shell'),
  source: z.enum(['script', 'file']).default('script'),
  file: RepoPath.optional(),
  process: ProcessSchema,
  params: ParamsSchema,
  clearance: ClearanceSchema,
  openings: OpeningsSchema,
  quantity: z.number().int().min(1).max(100_000).default(5),
  reasons: z.record(z.string(), z.string()).default({}),
}).loose().superRefine((s, ctx) => {
  if (s.source === 'file' && !s.file) ctx.addIssue({ code: 'custom', path: ['file'], message: 'source "file" names the handed-in STEP in `file`' })
})
export type CaseSettings = z.output<typeof CaseSettingsSchema>

/** The recommendation for a new case on a board. */
export function defaults(board: string, process?: Partial<CaseSettings['process']>): CaseSettings {
  return CaseSettingsSchema.parse({ board, ...(process ? { process } : {}) })
}

/** The settings' recommended values, by path (`params.wall_mm` → 2), from the schema's defaults. */
export function recommendations(): Record<string, unknown> {
  const d = defaults('x') as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of ['process', 'params', 'clearance', 'openings'] as const) {
    for (const [kk, v] of Object.entries(d[k] as Record<string, unknown>)) if (kk !== 'parts') out[`${k}.${kk}`] = v
  }
  out.quantity = d.quantity
  return out
}

/** The paths mech.settings may set (scalars and the skip list; per-part clearances go through `clearance`). */
export const SETTABLE = Object.keys(recommendations())

/** Read a path (`params.wall_mm`) of the settings. */
export function getPath(s: CaseSettings, path: string): unknown {
  let node: unknown = s
  for (const k of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[k]
  }
  return node
}

function setPath(s: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let node = s
  for (const k of keys.slice(0, -1)) node = (node[k] ??= {}) as Record<string, unknown>
  node[keys[keys.length - 1] as string] = value
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * The settings with `path` set to `value`. A value that differs from the recommendation needs a reason (at least three
 * characters, kept in `reasons[path]`); a value set back to the recommendation drops its reason.
 */
export function withValue(s: CaseSettings, path: string, value: unknown, reason?: string): CaseSettings {
  if (!SETTABLE.includes(path)) throw new ToolError(`mech.settings: ${path} is not a setting; one of ${SETTABLE.join(', ')} (per-part clearances: clearance)`)
  const rec = recommendations()[path]
  const next = structuredClone(s) as unknown as Record<string, unknown>
  setPath(next, path, value)
  const reasons = { ...(s.reasons ?? {}) }
  if (same(value, rec)) delete reasons[path]
  else {
    const why = (reason ?? '').trim() || reasons[path]
    if (!why || why.length < 3) throw new ToolError(`mech.settings: ${path} = ${JSON.stringify(value)} differs from the recommendation (${JSON.stringify(rec)}): give the reason`)
    reasons[path] = why
  }
  next.reasons = reasons
  const r = CaseSettingsSchema.safeParse(next)
  if (!r.success) throw new ToolError(`mech.settings: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return r.data
}

/** The settings with a per-part clearance (mm null: removed). The reason is kept with the clearance and in `reasons`. */
export function withClearance(s: CaseSettings, ref: string, value: number | null, reason?: string): CaseSettings {
  const next = structuredClone(s)
  const key = `clearance.parts.${ref}`
  if (value === null) {
    delete next.clearance.parts[ref]
    delete next.reasons[key]
  } else {
    const why = (reason ?? '').trim() || next.clearance.parts[ref]?.reason || ''
    if (why.length < 3) throw new ToolError(`mech.settings: a clearance of ${value} mm for ${ref} needs its reason (what needs the room: a mating face, a heatsink)`)
    next.clearance.parts[ref] = { mm: value, reason: why }
    next.reasons[key] = why
  }
  const r = CaseSettingsSchema.safeParse(next)
  if (!r.success) throw new ToolError(`mech.settings: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return r.data
}

/** Values that differ from the recommendation without a reason (a hand-edited case.json). */
export function missingReasons(s: CaseSettings): string[] {
  const rec = recommendations()
  const out = Object.entries(rec).filter(([p, v]) => !same(getPath(s, p), v) && !(s.reasons[p] ?? '').trim()).map(([p]) => p)
  for (const [ref, c] of Object.entries(s.clearance.parts)) if (!c.reason.trim() && !(s.reasons[`clearance.parts.${ref}`] ?? '').trim()) out.push(`clearance.parts.${ref}`)
  return out
}

/** Every value as it stands, with its recommendation and reason. */
export function describe(s: CaseSettings): { path: string; value: unknown; recommended: unknown; changed: boolean; reason: string | null }[] {
  const rows = Object.entries(recommendations()).map(([path, rec]) => {
    const value = getPath(s, path)
    return { path, value, recommended: rec, changed: !same(value, rec), reason: s.reasons[path] ?? null }
  })
  for (const [ref, c] of Object.entries(s.clearance.parts)) rows.push({ path: `clearance.parts.${ref}`, value: c.mm, recommended: null, changed: true, reason: c.reason })
  return rows
}

export function readSettings(root: string): CaseSettings | null {
  const p = join(root, CASE_JSON)
  if (!existsSync(p)) return null
  const text = readRepoFile(root, CASE_JSON).toString('utf8')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new ToolError(`${CASE_JSON} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  const r = CaseSettingsSchema.safeParse(raw)
  if (!r.success) throw new ToolError(`${CASE_JSON}: ${r.error.issues.map((i) => `${i.path.join('.') || 'settings'}: ${i.message}`).join('; ')}`)
  return r.data
}

export function needSettings(root: string): CaseSettings {
  const s = readSettings(root)
  if (!s) throw new ToolError(`this project has no ${CASE_JSON}: run mech.init first`)
  return s
}

export function writeSettings(root: string, s: CaseSettings): string {
  return writeRepoFile(root, CASE_JSON, `${JSON.stringify(s, null, 2)}\n`)
}

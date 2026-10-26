/**
 * The thermal tools' tables in the project database (src/core/store.ts ensureProjectSchema), each merged by
 * `trace db merge` by key, keeping the more recently updated row:
 *
 *   thermal_envelopes    name → the operating envelope: ambient min/max, environment (natural, forced, sealed,
 *                        vacuum), airflow, enclosure, orientation, altitude, the derating policy, notes, source
 *   thermal_part_limits  (envelope, ref) → Tj_max, Tj_min, theta-JA/JC/JB, psi-JT/JB, with a citation per figure
 *                        (datasheet mpn/sha256/page, or a manual `source`)
 *   thermal_budget       (scenario, ref) → power (typ, max), its rail, and where the figure came from
 *   thermal_derating     (ref, curve) → a derating curve's points with their citation
 *   thermal_corrections  (envelope, name) → a fitted correction (e.g. h_multiplier from a heater calibration, or a
 *                        per-surface h from a CFD run) with the evidence run ids
 *
 * Lists and mappings are JSON text inside a column (an encoding, not a file).
 */
import { z } from 'zod'
import { ToolError } from '../../core/registry.js'
import { dec, enc, ensureProjectSchema, openProject } from '../../core/store.js'
import { EnclosureSchema, ENVIRONMENTS } from './convection.js'

const upsert = (table: string, keys: string, cols: readonly string[]): string =>
  `INSERT INTO ${table} SELECT * FROM theirs.${table} WHERE true ON CONFLICT(${keys}) DO UPDATE SET ${cols.map((c) => `${c}=excluded.${c}`).join(', ')} WHERE excluded.updated > ${table}.updated`

const ENV_COLS = ['ambient_min_c', 'ambient_max_c', 'environment', 'airflow_m_s', 'enclosure', 'orientation', 'altitude_m', 'derating', 'details', 'notes', 'source', 'updated', 'by'] as const
ensureProjectSchema({
  table: 'thermal_envelopes',
  sql: `CREATE TABLE IF NOT EXISTS thermal_envelopes (
  name TEXT PRIMARY KEY,
  ambient_min_c REAL NOT NULL, ambient_max_c REAL NOT NULL,
  environment TEXT NOT NULL,      -- natural | forced | sealed | vacuum
  airflow_m_s REAL,
  enclosure TEXT,                 -- JSON text: {length_m, width_m, height_m, wall_thickness_m, wall_k, emissivity}
  orientation TEXT,               -- horizontal | vertical
  altitude_m REAL,
  derating TEXT NOT NULL,         -- JSON text: {"kind":"offset","value_c":20} or {"kind":"fraction","value":0.8}
  details TEXT,                   -- JSON text: emissivity per surface, nominal ambient
  notes TEXT, source TEXT, updated REAL NOT NULL, by TEXT
);`,
  merge: upsert('thermal_envelopes', 'name', ENV_COLS),
})

const LIMIT_COLS = ['mpn', 'package', 'tj_max_c', 'tj_min_c', 'theta_ja', 'theta_jc', 'theta_jb', 'psi_jt', 'psi_jb', 'citations', 'notes', 'updated', 'by'] as const
ensureProjectSchema({
  table: 'thermal_part_limits',
  sql: `CREATE TABLE IF NOT EXISTS thermal_part_limits (
  envelope TEXT NOT NULL, ref TEXT NOT NULL,
  mpn TEXT, package TEXT,
  tj_max_c REAL, tj_min_c REAL, theta_ja REAL, theta_jc REAL, theta_jb REAL, psi_jt REAL, psi_jb REAL,
  citations TEXT,                 -- JSON text: {"tj_max_c": {"mpn","sha256","page"} | {"source": "..."}, ...}
  notes TEXT, updated REAL NOT NULL, by TEXT,
  PRIMARY KEY (envelope, ref)
);`,
  merge: upsert('thermal_part_limits', 'envelope, ref', LIMIT_COLS),
})

const BUDGET_COLS = ['rail', 'power_w', 'power_max_w', 'method', 'citation', 'updated', 'by'] as const
ensureProjectSchema({
  table: 'thermal_budget',
  sql: `CREATE TABLE IF NOT EXISTS thermal_budget (
  scenario TEXT NOT NULL, ref TEXT NOT NULL,
  rail TEXT, power_w REAL NOT NULL, power_max_w REAL,
  method TEXT NOT NULL,           -- explicit | spice | regulator | datasheet
  citation TEXT,                  -- JSON text: where the figure came from (run id, datasheet page, calc formula)
  updated REAL NOT NULL, by TEXT,
  PRIMARY KEY (scenario, ref)
);`,
  merge: upsert('thermal_budget', 'scenario, ref', BUDGET_COLS),
})

const DERATING_COLS = ['x_unit', 'y_unit', 'points', 'citation', 'updated', 'by'] as const
ensureProjectSchema({
  table: 'thermal_derating',
  sql: `CREATE TABLE IF NOT EXISTS thermal_derating (
  ref TEXT NOT NULL, curve TEXT NOT NULL,   -- e.g. power_vs_ambient, current_vs_temperature
  x_unit TEXT, y_unit TEXT,
  points TEXT NOT NULL,           -- JSON text: [[x, y], ...]
  citation TEXT, updated REAL NOT NULL, by TEXT,
  PRIMARY KEY (ref, curve)
);`,
  merge: upsert('thermal_derating', 'ref, curve', DERATING_COLS),
})

const CORR_COLS = ['value', 'details', 'evidence', 'updated', 'by'] as const
ensureProjectSchema({
  table: 'thermal_corrections',
  sql: `CREATE TABLE IF NOT EXISTS thermal_corrections (
  envelope TEXT NOT NULL, name TEXT NOT NULL,   -- h_multiplier, h_top, h_bottom, h_edge
  value REAL NOT NULL,
  details TEXT,                   -- JSON text: the fit (points, error before/after) or the CFD surface data
  evidence TEXT NOT NULL,         -- JSON text: run ids
  updated REAL NOT NULL, by TEXT,
  PRIMARY KEY (envelope, name)
);`,
  merge: upsert('thermal_corrections', 'envelope, name', CORR_COLS),
})

const who = (): string | null => process.env.USER ?? null
const now = (): number => Date.now() / 1000

// ------------------------------------------------------------------ envelope

export const DeratingSchema = z.union([
  z.object({ kind: z.literal('offset'), value_c: z.number().min(0).describe('Tj <= Tj_max - value_c') }).strict(),
  z.object({ kind: z.literal('fraction'), value: z.number().gt(0).max(1).describe('Tj (deg C) <= value x Tj_max (deg C)') }).strict(),
])
export type Derating = z.output<typeof DeratingSchema>

export const EmissivityInput = z.object({ top: z.number().min(0).max(1), bottom: z.number().min(0).max(1), edge: z.number().min(0).max(1) }).partial().strict()

export const EnvelopeSchema = z.object({
  name: z.string().min(1).max(100),
  ambient_min_c: z.number().min(-100).max(200),
  ambient_max_c: z.number().min(-100).max(200),
  ambient_nominal_c: z.number().optional().describe('an extra corner between min and max (default none)'),
  environment: z.enum(ENVIRONMENTS).default('natural'),
  airflow_m_s: z.number().min(0).max(100).default(0).describe('forced: air speed along the board (m/s)'),
  enclosure: EnclosureSchema.optional().describe('sealed: the box around the board'),
  orientation: z.enum(['horizontal', 'vertical']).default('horizontal'),
  altitude_m: z.number().min(-500).max(20000).default(0),
  derating: DeratingSchema.default({ kind: 'offset', value_c: 20 }),
  emissivity: EmissivityInput.optional().describe('per surface; default solder mask 0.9 (materials.EMISSIVITY)'),
  radiation: z.boolean().default(true),
  notes: z.string().optional(),
  source: z.string().optional().describe('where the envelope comes from (requirement id, product spec)'),
}).strict()
export type Envelope = z.output<typeof EnvelopeSchema> & { updated?: number; by?: string | null }

export function putEnvelope(e: z.input<typeof EnvelopeSchema>): Envelope {
  const v = EnvelopeSchema.parse(e)
  if (v.ambient_min_c > v.ambient_max_c) throw new ToolError(`${v.name}: ambient_min_c ${v.ambient_min_c} is above ambient_max_c ${v.ambient_max_c}`)
  if (v.environment === 'sealed' && !v.enclosure) throw new ToolError(`${v.name}: a sealed environment needs the enclosure's dimensions`)
  if (v.environment === 'forced' && !(v.airflow_m_s > 0)) throw new ToolError(`${v.name}: forced airflow needs airflow_m_s > 0`)
  const db = openProject()
  try {
    db.prepare(`INSERT OR REPLACE INTO thermal_envelopes (name, ambient_min_c, ambient_max_c, environment, airflow_m_s, enclosure, orientation, altitude_m, derating, details, notes, source, updated, by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.name, v.ambient_min_c, v.ambient_max_c, v.environment, v.airflow_m_s, v.enclosure ? enc(v.enclosure) : null,
      v.orientation, v.altitude_m, enc(v.derating), enc({ emissivity: v.emissivity ?? null, ambient_nominal_c: v.ambient_nominal_c ?? null, radiation: v.radiation }), v.notes ?? null, v.source ?? null, now(), who())
  } finally {
    db.close()
  }
  return getEnvelope(v.name)!
}

export function getEnvelope(name: string): Envelope | null {
  const db = openProject()
  try {
    const r = db.prepare('SELECT * FROM thermal_envelopes WHERE name=?').get(name) as Record<string, unknown> | undefined
    if (!r) return null
    const d = dec<{ emissivity: Record<string, number> | null; ambient_nominal_c: number | null; radiation: boolean }>(r.details) ?? { emissivity: null, ambient_nominal_c: null, radiation: true }
    return {
      name: String(r.name), ambient_min_c: Number(r.ambient_min_c), ambient_max_c: Number(r.ambient_max_c),
      ...(d.ambient_nominal_c !== null ? { ambient_nominal_c: d.ambient_nominal_c } : {}),
      environment: z.enum(ENVIRONMENTS).parse(r.environment), airflow_m_s: Number(r.airflow_m_s ?? 0),
      ...(r.enclosure ? { enclosure: EnclosureSchema.parse(dec(r.enclosure)) } : {}),
      orientation: r.orientation === 'vertical' ? 'vertical' : 'horizontal', altitude_m: Number(r.altitude_m ?? 0),
      derating: DeratingSchema.parse(dec(r.derating)), ...(d.emissivity ? { emissivity: d.emissivity } : {}), radiation: d.radiation,
      ...(r.notes !== null ? { notes: String(r.notes) } : {}), ...(r.source !== null ? { source: String(r.source) } : {}),
      updated: Number(r.updated), by: r.by === null ? null : String(r.by),
    }
  } finally {
    db.close()
  }
}

export function listEnvelopes(): { name: string; ambient_min_c: number; ambient_max_c: number; environment: string; parts: number }[] {
  const db = openProject()
  try {
    return db.prepare(`SELECT e.name, e.ambient_min_c, e.ambient_max_c, e.environment, (SELECT count(*) FROM thermal_part_limits p WHERE p.envelope = e.name) AS parts FROM thermal_envelopes e ORDER BY e.name`).all()
      .map((r) => ({ name: String(r.name), ambient_min_c: Number(r.ambient_min_c), ambient_max_c: Number(r.ambient_max_c), environment: String(r.environment), parts: Number(r.parts) }))
  } finally {
    db.close()
  }
}

export function deleteEnvelope(name: string): number {
  const db = openProject()
  try {
    db.prepare('DELETE FROM thermal_part_limits WHERE envelope=?').run(name)
    db.prepare('DELETE FROM thermal_corrections WHERE envelope=?').run(name)
    return Number(db.prepare('DELETE FROM thermal_envelopes WHERE name=?').run(name).changes)
  } finally {
    db.close()
  }
}

/** The derated junction limit for a Tj_max. */
export function deratedLimit(tjMax: number, d: Derating): number {
  return d.kind === 'offset' ? tjMax - d.value_c : d.value * tjMax
}

// ------------------------------------------------------------------ part limits

export const CitationSchema = z.union([
  z.object({ mpn: z.string(), sha256: z.string().regex(/^[0-9a-f]{8,64}$/i), page: z.number().int().min(1), note: z.string().optional() }).strict(),
  z.object({ source: z.string().min(1), note: z.string().optional() }).strict(),
])
export type Citation = z.output<typeof CitationSchema>

export const LIMIT_FIELDS = ['tj_max_c', 'tj_min_c', 'theta_ja', 'theta_jc', 'theta_jb', 'psi_jt', 'psi_jb'] as const
export type LimitField = (typeof LIMIT_FIELDS)[number]

export const PartLimitSchema = z.object({
  ref: z.string().min(1),
  mpn: z.string().optional(),
  package: z.string().optional(),
  tj_max_c: z.number().optional(), tj_min_c: z.number().optional(),
  theta_ja: z.number().positive().optional(), theta_jc: z.number().positive().optional(), theta_jb: z.number().positive().optional(),
  psi_jt: z.number().min(0).optional(), psi_jb: z.number().min(0).optional(),
  citations: z.partialRecord(z.enum(LIMIT_FIELDS), CitationSchema).default({}).describe('per figure: {mpn, sha256, page} from the datasheet library, or {source} for a manual figure'),
  notes: z.string().optional(),
}).strict()
export type PartLimit = z.output<typeof PartLimitSchema>

export function putPartLimit(envelope: string, p: z.input<typeof PartLimitSchema>): PartLimit {
  const v = PartLimitSchema.parse(p)
  for (const f of LIMIT_FIELDS) if (v[f] !== undefined && !v.citations[f]) throw new ToolError(`${v.ref}.${f}: every figure needs a citation (a datasheet {mpn, sha256, page}, or {source} for a manual override)`)
  if (!getEnvelope(envelope)) throw new ToolError(`no envelope ${JSON.stringify(envelope)} (set it first)`)
  const db = openProject()
  try {
    db.prepare(`INSERT OR REPLACE INTO thermal_part_limits (envelope, ref, mpn, package, tj_max_c, tj_min_c, theta_ja, theta_jc, theta_jb, psi_jt, psi_jb, citations, notes, updated, by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(envelope, v.ref, v.mpn ?? null, v.package ?? null, v.tj_max_c ?? null, v.tj_min_c ?? null, v.theta_ja ?? null, v.theta_jc ?? null,
      v.theta_jb ?? null, v.psi_jt ?? null, v.psi_jb ?? null, enc(v.citations), v.notes ?? null, now(), who())
  } finally {
    db.close()
  }
  return v
}

export function getPartLimits(envelope: string): PartLimit[] {
  const db = openProject()
  try {
    return db.prepare('SELECT * FROM thermal_part_limits WHERE envelope=? ORDER BY ref').all(envelope).map((r) => {
      const out: Record<string, unknown> = { ref: r.ref, citations: dec(r.citations) ?? {} }
      for (const k of ['mpn', 'package', 'notes'] as const) if (r[k] !== null) out[k] = String(r[k])
      for (const f of LIMIT_FIELDS) if (r[f] !== null) out[f] = Number(r[f])
      return PartLimitSchema.parse(out)
    })
  } finally {
    db.close()
  }
}

// ------------------------------------------------------------------ budget

export interface BudgetRow { scenario: string; ref: string; rail: string | null; power_w: number; power_max_w: number | null; method: string; citation: unknown }

export function putBudget(rows: readonly Omit<BudgetRow, 'scenario'>[], scenario: string, replace = true): void {
  const db = openProject()
  try {
    db.exec('BEGIN IMMEDIATE')
    if (replace) db.prepare('DELETE FROM thermal_budget WHERE scenario=?').run(scenario)
    const st = db.prepare('INSERT OR REPLACE INTO thermal_budget (scenario, ref, rail, power_w, power_max_w, method, citation, updated, by) VALUES (?,?,?,?,?,?,?,?,?)')
    for (const r of rows) st.run(scenario, r.ref, r.rail, r.power_w, r.power_max_w, r.method, enc(r.citation), now(), who())
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* not in a transaction */ }
    throw e
  } finally {
    db.close()
  }
}

export function getBudget(scenario: string): BudgetRow[] {
  const db = openProject()
  try {
    return db.prepare('SELECT * FROM thermal_budget WHERE scenario=? ORDER BY ref').all(scenario).map((r) => ({
      scenario: String(r.scenario), ref: String(r.ref), rail: r.rail === null ? null : String(r.rail), power_w: Number(r.power_w),
      power_max_w: r.power_max_w === null ? null : Number(r.power_max_w), method: String(r.method), citation: dec(r.citation),
    }))
  } finally {
    db.close()
  }
}

// ------------------------------------------------------------------ derating curves

export interface DeratingCurve { ref: string; curve: string; x_unit: string | null; y_unit: string | null; points: [number, number][]; citation: Citation }

export function putCurve(c: DeratingCurve): DeratingCurve {
  const pts = [...c.points].sort((a, b) => a[0] - b[0])
  if (pts.length < 2) throw new ToolError(`${c.ref}/${c.curve}: a curve needs at least two points`)
  const db = openProject()
  try {
    db.prepare('INSERT OR REPLACE INTO thermal_derating (ref, curve, x_unit, y_unit, points, citation, updated, by) VALUES (?,?,?,?,?,?,?,?)')
      .run(c.ref, c.curve, c.x_unit, c.y_unit, enc(pts), enc(c.citation), now(), who())
  } finally {
    db.close()
  }
  return { ...c, points: pts }
}

export function getCurves(ref?: string): DeratingCurve[] {
  const db = openProject()
  try {
    const rows = ref === undefined ? db.prepare('SELECT * FROM thermal_derating ORDER BY ref, curve').all() : db.prepare('SELECT * FROM thermal_derating WHERE ref=? ORDER BY curve').all(ref)
    return rows.map((r) => ({
      ref: String(r.ref), curve: String(r.curve), x_unit: r.x_unit === null ? null : String(r.x_unit), y_unit: r.y_unit === null ? null : String(r.y_unit),
      points: dec<[number, number][]>(r.points), citation: CitationSchema.parse(dec(r.citation)),
    }))
  } finally {
    db.close()
  }
}

// ------------------------------------------------------------------ corrections

export interface Correction { envelope: string; name: string; value: number; details: unknown; evidence: string[]; updated: number }

export function putCorrection(c: Omit<Correction, 'updated'>): Correction {
  if (!c.evidence.length) throw new ToolError('a correction needs the run ids it was fitted from')
  const db = openProject()
  try {
    db.prepare('INSERT OR REPLACE INTO thermal_corrections (envelope, name, value, details, evidence, updated, by) VALUES (?,?,?,?,?,?,?)')
      .run(c.envelope, c.name, c.value, enc(c.details), enc(c.evidence), now(), who())
  } finally {
    db.close()
  }
  return { ...c, updated: now() }
}

export function getCorrections(envelope: string): Correction[] {
  const db = openProject()
  try {
    return db.prepare('SELECT * FROM thermal_corrections WHERE envelope=? ORDER BY name').all(envelope).map((r) => ({
      envelope: String(r.envelope), name: String(r.name), value: Number(r.value), details: dec(r.details), evidence: dec<string[]>(r.evidence), updated: Number(r.updated),
    }))
  } finally {
    db.close()
  }
}

export function deleteCorrection(envelope: string, name?: string): number {
  const db = openProject()
  try {
    return Number((name === undefined ? db.prepare('DELETE FROM thermal_corrections WHERE envelope=?').run(envelope) : db.prepare('DELETE FROM thermal_corrections WHERE envelope=? AND name=?').run(envelope, name)).changes)
  } finally {
    db.close()
  }
}

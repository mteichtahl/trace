/**
 * Analog specifications, kept in the project database: one row per (spec set, measure), with min / typ / max limits,
 * the unit, and the conditions the limit applies under (supply, temperature, load: free-form, stored as JSON text).
 *
 *   ams_specs   spec_set, measure, min, typ, max, unit, conditions, notes, source, updated, by
 *
 * A spec set is a named group, e.g. "front-end" or "opamp-u3"; a measure name is what a measurement is called in
 * sim.* / ams.* (`name` of a measurement spec, or ams.opamp_check's fixed names such as phase_margin_deg). The
 * ams.corners and ams.montecarlo_yield tools take `spec_set` to judge their measurements against these rows.
 *
 * `trace db merge` merges the table by key, keeping the more recently updated row.
 */
import { z } from 'zod'

import { ToolError } from '../../core/registry.js'
import { dec, enc, ensureProjectSchema, openProject, type Json } from '../../core/store.js'

ensureProjectSchema({
  table: 'ams_specs',
  sql: `
CREATE TABLE IF NOT EXISTS ams_specs (
  spec_set TEXT NOT NULL,
  measure TEXT NOT NULL,
  min REAL, typ REAL, max REAL,
  unit TEXT,
  conditions TEXT,                -- JSON text: {"temp_c": [-40, 85], "vdd": 3.3, "load": "10k"}
  notes TEXT,
  source TEXT,                    -- where the limit comes from (datasheet section, requirement id)
  updated REAL NOT NULL,
  by TEXT,
  PRIMARY KEY (spec_set, measure)
);`,
  merge: `INSERT INTO ams_specs SELECT * FROM theirs.ams_specs WHERE true
  ON CONFLICT(spec_set, measure) DO UPDATE SET min=excluded.min, typ=excluded.typ, max=excluded.max, unit=excluded.unit,
    conditions=excluded.conditions, notes=excluded.notes, source=excluded.source, updated=excluded.updated, by=excluded.by
  WHERE excluded.updated > ams_specs.updated`,
})

export const SpecLimit = z.object({
  min: z.number().optional(),
  typ: z.number().optional(),
  max: z.number().optional(),
  unit: z.string().optional(),
}).strict()
export type SpecLimit = z.output<typeof SpecLimit>

export interface Spec extends SpecLimit {
  spec_set: string
  measure: string
  conditions: Json
  notes: string | null
  source: string | null
  updated: number
  by: string | null
}

function rowToSpec(row: Record<string, unknown>): Spec {
  const n = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v))
  const out: Spec = {
    spec_set: String(row.spec_set), measure: String(row.measure), conditions: dec(row.conditions),
    notes: row.notes === null ? null : String(row.notes), source: row.source === null ? null : String(row.source),
    updated: Number(row.updated), by: row.by === null ? null : String(row.by),
  }
  const mn = n(row.min)
  const ty = n(row.typ)
  const mx = n(row.max)
  if (mn !== undefined) out.min = mn
  if (ty !== undefined) out.typ = ty
  if (mx !== undefined) out.max = mx
  if (row.unit !== null && row.unit !== undefined && row.unit !== '') out.unit = String(row.unit)
  return out
}

export function putSpec(s: { spec_set: string; measure: string; min?: number | undefined; typ?: number | undefined; max?: number | undefined; unit?: string | undefined; conditions?: unknown; notes?: string | undefined; source?: string | undefined; by?: string | undefined }): Spec {
  if (s.min === undefined && s.max === undefined && s.typ === undefined) throw new ToolError(`${s.spec_set}/${s.measure}: give at least one of min, typ, max`)
  if (s.min !== undefined && s.max !== undefined && s.min > s.max) throw new ToolError(`${s.spec_set}/${s.measure}: min ${s.min} is above max ${s.max}`)
  const db = openProject()
  try {
    db.prepare(`INSERT OR REPLACE INTO ams_specs (spec_set, measure, min, typ, max, unit, conditions, notes, source, updated, by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(s.spec_set, s.measure, s.min ?? null, s.typ ?? null, s.max ?? null, s.unit ?? null,
      s.conditions === undefined ? null : enc(s.conditions), s.notes ?? null, s.source ?? null, Date.now() / 1000, s.by ?? process.env.USER ?? null)
    const row = db.prepare('SELECT * FROM ams_specs WHERE spec_set=? AND measure=?').get(s.spec_set, s.measure)
    return rowToSpec(row as Record<string, unknown>)
  } finally {
    db.close()
  }
}

export function getSpecs(specSet?: string): Spec[] {
  const db = openProject()
  try {
    const rows = specSet === undefined
      ? db.prepare('SELECT * FROM ams_specs ORDER BY spec_set, measure').all()
      : db.prepare('SELECT * FROM ams_specs WHERE spec_set=? ORDER BY measure').all(specSet)
    return rows.map((x) => rowToSpec(x as Record<string, unknown>))
  } finally {
    db.close()
  }
}

export function deleteSpec(specSet: string, measure?: string): number {
  const db = openProject()
  try {
    const res = measure === undefined
      ? db.prepare('DELETE FROM ams_specs WHERE spec_set=?').run(specSet)
      : db.prepare('DELETE FROM ams_specs WHERE spec_set=? AND measure=?').run(specSet, measure)
    return Number(res.changes)
  } finally {
    db.close()
  }
}

/** The limits to judge against: the stored set (when named), overridden by inline limits. */
export function resolveSpecs(specSet: string | undefined, inline: Record<string, SpecLimit> | undefined): Map<string, SpecLimit> {
  const out = new Map<string, SpecLimit>()
  if (specSet !== undefined) {
    const rows = getSpecs(specSet)
    if (!rows.length) throw new ToolError(`no specs in set ${JSON.stringify(specSet)} (add them with ams.spec action=set)`)
    for (const s of rows) out.set(s.measure, { ...(s.min !== undefined ? { min: s.min } : {}), ...(s.typ !== undefined ? { typ: s.typ } : {}), ...(s.max !== undefined ? { max: s.max } : {}), ...(s.unit ? { unit: s.unit } : {}) })
  }
  for (const [k, v] of Object.entries(inline ?? {})) out.set(k, v)
  return out
}

export interface Verdict {
  pass: boolean
  /** Distance to the nearest limit, positive inside (in the measure's unit); null when the value is missing. */
  margin: number | null
  /** The limit the margin is measured against. */
  limit: 'min' | 'max' | null
}

/** A value against a spec: pass when min <= value <= max (typ is informational). A missing value fails. */
export function judge(value: number | null, s: SpecLimit): Verdict {
  if (value === null || !Number.isFinite(value)) return { pass: false, margin: null, limit: null }
  const lo = s.min !== undefined ? value - s.min : Infinity
  const hi = s.max !== undefined ? s.max - value : Infinity
  if (lo === Infinity && hi === Infinity) return { pass: true, margin: null, limit: null }
  return lo <= hi ? { pass: lo >= 0, margin: lo, limit: 'min' } : { pass: hi >= 0, margin: hi, limit: 'max' }
}

/** A margin as a fraction of the spec window (max - min), or of |limit| for a one-sided spec. */
export function relativeMargin(v: Verdict, s: SpecLimit): number | null {
  if (v.margin === null || v.limit === null) return null
  const span = s.min !== undefined && s.max !== undefined ? s.max - s.min : Math.abs((v.limit === 'min' ? s.min : s.max) as number)
  return span > 0 ? v.margin / span : null
}

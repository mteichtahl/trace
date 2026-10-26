/**
 * Interface timing specs, kept in the project database: one row per (device, protocol, parameter).
 *
 *   protocol_specs   device, protocol, parameter, role, min, typ, max, unit, value, conditions, citation, notes,
 *                    updated, by
 *
 * `device` is a name the project chooses (an MPN, or "u3-adc"); `role` says which side the figures describe
 * (responder: a slave's input requirements and output timing; initiator: a master's). Numbers are stored in SI base
 * units (s, Hz, F, V, A, %), converted from the unit they were given in, so a check never mixes ns and µs; `value`
 * holds a non-numeric parameter as JSON (the SPI modes a device supports, say).
 *
 * Every row has a citation {source, mpn?, sha256?, page?, verified}: `verified` is true only when part, sha256 and
 * page are all given (a datasheet in the shared library, read at that page), else null. protocol.spec_extract
 * proposes rows with full citations; a figure typed in from elsewhere stays verified: null.
 *
 * `trace db merge` merges the table by key, keeping the more recently updated row.
 */
import { z } from 'zod'

import { ToolError } from '../../core/registry.js'
import { dec, enc, ensureProjectSchema, openProject, type Json } from '../../core/store.js'
import { PARAMS, type Citation } from './standards.js'

ensureProjectSchema({
  table: 'protocol_specs',
  sql: `
CREATE TABLE IF NOT EXISTS protocol_specs (
  device TEXT NOT NULL,
  protocol TEXT NOT NULL,          -- i2c | spi | uart | can | onewire | i2s
  parameter TEXT NOT NULL,         -- tsu_dat, f_scl, tcss, modes, ... (standards.ts PARAMS)
  role TEXT NOT NULL DEFAULT 'responder',   -- responder | initiator
  min REAL, typ REAL, max REAL,
  unit TEXT,                       -- SI base unit: s, Hz, F, V, A, %, VDD (a fraction of the supply)
  value TEXT,                      -- JSON text for a non-numeric parameter, e.g. [0, 3]
  conditions TEXT,                 -- JSON text: {"vdd": 3.3, "cb_pf": 100, "temp_c": [-40, 85]}
  citation TEXT NOT NULL,          -- JSON text: {source, mpn, sha256, page, verified}
  notes TEXT,
  updated REAL NOT NULL,
  by TEXT,
  PRIMARY KEY (device, protocol, parameter)
);`,
  merge: `INSERT INTO protocol_specs SELECT * FROM theirs.protocol_specs WHERE true
  ON CONFLICT(device, protocol, parameter) DO UPDATE SET role=excluded.role, min=excluded.min, typ=excluded.typ, max=excluded.max,
    unit=excluded.unit, value=excluded.value, conditions=excluded.conditions, citation=excluded.citation, notes=excluded.notes,
    updated=excluded.updated, by=excluded.by
  WHERE excluded.updated > protocol_specs.updated`,
})

export const PROTOCOLS = ['i2c', 'spi', 'uart', 'can', 'onewire', 'i2s'] as const
export type Protocol = (typeof PROTOCOLS)[number]

/** A value in a unit → SI. Unknown units are refused, so "uS" or "mhz" typos do not slip through as seconds. */
const SCALE: Readonly<Record<string, [number, string]>> = {
  s: [1, 's'], ms: [1e-3, 's'], us: [1e-6, 's'], 'µs': [1e-6, 's'], 'μs': [1e-6, 's'], ns: [1e-9, 's'], ps: [1e-12, 's'],
  hz: [1, 'Hz'], khz: [1e3, 'Hz'], mhz: [1e6, 'Hz'], ghz: [1e9, 'Hz'],
  f: [1, 'F'], uf: [1e-6, 'F'], 'µf': [1e-6, 'F'], nf: [1e-9, 'F'], pf: [1e-12, 'F'],
  v: [1, 'V'], mv: [1e-3, 'V'], a: [1, 'A'], ma: [1e-3, 'A'], ua: [1e-6, 'A'], 'µa': [1e-6, 'A'],
  '%': [1, '%'], vdd: [1, 'VDD'], 'xvdd': [1, 'VDD'], bps: [1, 'Hz'], kbps: [1e3, 'Hz'], mbps: [1e6, 'Hz'], baud: [1, 'Hz'],
  '': [1, ''],
}

export function toSI(unit: string | undefined): { scale: number; unit: string } {
  const u = (unit ?? '').trim().replace(/\s+/g, '').toLowerCase().replace(/^×/, 'x')
  const hit = SCALE[u]
  if (!hit) throw new ToolError(`unit ${JSON.stringify(unit)} is not one protocol.spec knows (s ms us ns ps, Hz kHz MHz, F nF pF, V mV, A mA uA, %, VDD)`)
  return { scale: hit[0], unit: hit[1] }
}

export const CitationIn = z.object({
  source: z.string().min(1).describe('where the figure comes from: a datasheet title and table, a requirement id'),
  mpn: z.string().optional(),
  sha256: z.string().regex(/^[0-9a-fA-F]{8,64}$/).optional(),
  page: z.number().int().min(1).optional(),
}).strict()

export const SpecRowIn = z.object({
  parameter: z.string().min(1),
  min: z.number().optional(),
  typ: z.number().optional(),
  max: z.number().optional(),
  unit: z.string().optional().describe('the unit the numbers are in (ns, µs, kHz, pF, ...); stored as SI'),
  value: z.unknown().optional().describe('a non-numeric parameter, e.g. modes [0, 3]'),
  conditions: z.record(z.string(), z.unknown()).optional(),
  citation: CitationIn,
  notes: z.string().max(2000).optional(),
}).strict()
export type SpecRowIn = z.output<typeof SpecRowIn>

export interface SpecRow {
  device: string
  protocol: Protocol
  parameter: string
  role: 'responder' | 'initiator'
  min?: number
  typ?: number
  max?: number
  unit: string
  value?: Json
  conditions: Json
  citation: Citation
  notes: string | null
  updated: number
  by: string | null
}

export function citationOf(c: z.output<typeof CitationIn>): Citation {
  const full = Boolean(c.mpn && c.sha256 && c.page)
  return { source: c.source, ...(c.mpn ? { mpn: c.mpn } : {}), ...(c.sha256 ? { sha256: c.sha256.toLowerCase() } : {}), ...(c.page ? { page: c.page } : {}), verified: full ? true : null }
}

function fromRow(r: Record<string, unknown>): SpecRow {
  const n = (v: unknown): number | undefined => (v === null || v === undefined ? undefined : Number(v))
  const out: SpecRow = {
    device: String(r.device), protocol: String(r.protocol) as Protocol, parameter: String(r.parameter), role: String(r.role) as SpecRow['role'],
    unit: r.unit === null ? '' : String(r.unit), conditions: dec(r.conditions), citation: dec<Citation>(r.citation),
    notes: r.notes === null ? null : String(r.notes), updated: Number(r.updated), by: r.by === null ? null : String(r.by),
  }
  const mn = n(r.min)
  const ty = n(r.typ)
  const mx = n(r.max)
  if (mn !== undefined) out.min = mn
  if (ty !== undefined) out.typ = ty
  if (mx !== undefined) out.max = mx
  if (r.value !== null && r.value !== undefined) out.value = dec(r.value)
  return out
}

export function putSpecRows(device: string, protocol: Protocol, role: SpecRow['role'], rows: readonly SpecRowIn[], by?: string): SpecRow[] {
  const known = PARAMS[protocol] ?? []
  const db = openProject()
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) {
        if (!known.includes(r.parameter)) throw new ToolError(`${protocol} has no parameter ${JSON.stringify(r.parameter)} (known: ${known.join(', ')})`)
        const numeric = r.min !== undefined || r.typ !== undefined || r.max !== undefined
        if (!numeric && r.value === undefined) throw new ToolError(`${device}/${r.parameter}: give min, typ, max or value`)
        const { scale, unit } = toSI(r.unit)
        const sc = (v: number | undefined): number | null => (v === undefined ? null : v * scale)
        const mn = sc(r.min)
        const mx = sc(r.max)
        if (mn !== null && mx !== null && mn > mx) throw new ToolError(`${device}/${r.parameter}: min ${r.min} is above max ${r.max}`)
        db.prepare(`INSERT OR REPLACE INTO protocol_specs (device, protocol, parameter, role, min, typ, max, unit, value, conditions, citation, notes, updated, by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(device, protocol, r.parameter, role, mn, sc(r.typ), mx, numeric ? unit : null,
          r.value === undefined ? null : enc(r.value), r.conditions === undefined ? null : enc(r.conditions), enc(citationOf(r.citation)),
          r.notes ?? null, Date.now() / 1000, by ?? process.env.USER ?? null)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return getSpec(device, protocol, db)
  } finally {
    db.close()
  }
}

export function getSpec(device: string, protocol?: Protocol, dbIn?: ReturnType<typeof openProject>): SpecRow[] {
  const db = dbIn ?? openProject()
  try {
    const rows = protocol === undefined
      ? db.prepare('SELECT * FROM protocol_specs WHERE device=? ORDER BY protocol, parameter').all(device)
      : db.prepare('SELECT * FROM protocol_specs WHERE device=? AND protocol=? ORDER BY parameter').all(device, protocol)
    return rows.map((r) => fromRow(r as Record<string, unknown>))
  } finally {
    if (!dbIn) db.close()
  }
}

export function listDevices(): { device: string; protocol: string; role: string; parameters: number; unverified: number }[] {
  const db = openProject()
  try {
    return db.prepare(`SELECT device, protocol, role, count(*) AS parameters,
      sum(CASE WHEN json_extract(citation, '$.verified') IS NULL THEN 1 ELSE 0 END) AS unverified
      FROM protocol_specs GROUP BY device, protocol ORDER BY device, protocol`).all() as unknown as { device: string; protocol: string; role: string; parameters: number; unverified: number }[]
  } finally {
    db.close()
  }
}

export function deleteSpec(device: string, protocol?: Protocol, parameter?: string): number {
  const db = openProject()
  try {
    const r = parameter !== undefined && protocol !== undefined
      ? db.prepare('DELETE FROM protocol_specs WHERE device=? AND protocol=? AND parameter=?').run(device, protocol, parameter)
      : protocol !== undefined
        ? db.prepare('DELETE FROM protocol_specs WHERE device=? AND protocol=?').run(device, protocol)
        : db.prepare('DELETE FROM protocol_specs WHERE device=?').run(device)
    return Number(r.changes)
  } finally {
    db.close()
  }
}

/** The stored spec as a map parameter → row, or a ToolError naming what is there. */
export function specMap(device: string, protocol: Protocol): Map<string, SpecRow> {
  const rows = getSpec(device, protocol)
  if (!rows.length) throw new ToolError(`no ${protocol} spec for ${JSON.stringify(device)} (add it with protocol.spec action=set, or propose one with protocol.spec_extract)`)
  return new Map(rows.map((r) => [r.parameter, r]))
}

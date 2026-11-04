/**
 * The engineering values a document states (docs/scribe.md "Key engineering values"), read from what trace recorded,
 * never typed in: each row has its value, limit and margin where there is one, its basis (estimated, simulated or
 * measured) and the record it came from, so "no source, no number" holds by construction.
 *
 *   power    the newest power budget (thermal_budget, thermal.budget): each supply rail and the board in total.
 *            A figure from a SPICE operating point is simulated and cites that run; an explicit, regulator or
 *            datasheet figure is estimated and cites the budget
 *   thermal  the newest thermal.check run: each part's worst junction temperature against its rating (value plus its
 *            margin), simulated when the run modelled the board, estimated otherwise; and the newest thermal.measure
 *            run's readings, measured
 *   load     nothing records loads yet: the kind is there so a document asks for it, and its rows stay pending
 *
 * Pure reads of the project database; `valuesTable` writes the rows as the table Scribe's markers expect.
 */
import type { DatabaseSync } from 'node:sqlite'
import { eng } from '../core/units.js'
import type { Basis, ValueKind } from './catalog.js'
import { VALUE_COLUMNS } from './markers.js'

export interface ValueRow {
  kind: ValueKind
  quantity: string
  value: string
  limit: string
  margin: string
  basis: Basis
  /** run:<id> or budget:<scenario> */
  source: string
}

const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
const num = (v: number, unit: string): string => eng(v, unit)
const json = (s: unknown): Record<string, unknown> => { try { return typeof s === 'string' ? JSON.parse(s) as Record<string, unknown> : {} } catch { return {} } }

function power(db: DatabaseSync): ValueRow[] {
  if (!has(db, 'thermal_budget')) return []
  const newest = db.prepare('SELECT scenario FROM thermal_budget ORDER BY updated DESC LIMIT 1').get() as { scenario: string } | undefined
  if (!newest) return []
  const rows = db.prepare('SELECT ref, rail, power_w, power_max_w, method, citation FROM thermal_budget WHERE scenario=?').all(newest.scenario) as
    { ref: string; rail: string | null; power_w: number; power_max_w: number | null; method: string; citation: string | null }[]
  const budget = `budget:${newest.scenario}`
  const sourceOf = (r: (typeof rows)[number]): { basis: Basis; source: string } => {
    const run = json(r.citation).run_id
    return r.method === 'spice' && typeof run === 'string' ? { basis: 'simulated', source: `run:${run}` } : { basis: 'estimated', source: budget }
  }
  const out: ValueRow[] = []
  const rails = new Map<string, typeof rows>()
  for (const r of rows) rails.set(r.rail ?? 'unassigned', [...(rails.get(r.rail ?? 'unassigned') ?? []), r])
  for (const [rail, rs] of [...rails].sort(([a], [b]) => a.localeCompare(b))) {
    const p = rs.reduce((s, r) => s + r.power_w, 0)
    const all = rs.map(sourceOf)
    // a rail is simulated only when every figure on it is; one source when they share one, else the budget
    const basis: Basis = all.every((x) => x.basis === 'simulated') ? 'simulated' : 'estimated'
    const sources = [...new Set(all.map((x) => x.source))]
    out.push({ kind: 'power', quantity: `Power on ${rail}`, value: num(p, 'W'), limit: '', margin: '', basis, source: sources.length === 1 ? sources[0]! : budget })
  }
  const total = rows.reduce((s, r) => s + r.power_w, 0)
  const worst = rows.reduce((s, r) => s + (r.power_max_w ?? r.power_w), 0)
  out.push({ kind: 'power', quantity: 'Board power, typical', value: num(total, 'W'), limit: '', margin: '', basis: 'estimated', source: budget })
  if (worst > total) out.push({ kind: 'power', quantity: 'Board power, worst case', value: num(worst, 'W'), limit: '', margin: '', basis: 'estimated', source: budget })
  return out
}

function newestRun(db: DatabaseSync, kind: string): { id: string } | undefined {
  return db.prepare("SELECT id FROM runs WHERE kind=? AND status IN ('pass','fail') ORDER BY started DESC LIMIT 1").get(kind) as { id: string } | undefined
}

function thermal(db: DatabaseSync): ValueRow[] {
  if (!has(db, 'runs') || !has(db, 'measurements')) return []
  const out: ValueRow[] = []
  const check = newestRun(db, 'thermal.check')
  if (check) {
    const ms = db.prepare('SELECT name, value FROM measurements WHERE run_id=?').all(check.id) as { name: string; value: number | null }[]
    const by = new Map(ms.map((m) => [m.name, m.value]))
    const modelled = ms.some((m) => m.name.endsWith('.board_c'))
    const refs = [...new Set(ms.map((m) => /^([^@.]+)\.tj_c$/.exec(m.name)?.[1]).filter((x): x is string => !!x))].sort()
    for (const ref of refs) {
      const tj = by.get(`${ref}.tj_c`)
      const margin = by.get(`${ref}.margin_c`)
      if (tj === null || tj === undefined) continue
      out.push({
        kind: 'thermal', quantity: `\`${ref}\` junction temperature, worst case`, value: num(tj, '°C'),
        limit: margin !== null && margin !== undefined ? num(tj + margin, '°C') : '', margin: margin !== null && margin !== undefined ? num(margin, '°C') : '',
        basis: modelled ? 'simulated' : 'estimated', source: `run:${check.id}`,
      })
    }
  }
  const measured = newestRun(db, 'thermal.measure')
  if (measured) {
    const ms = db.prepare("SELECT name, value FROM measurements WHERE run_id=? AND name LIKE '%.measured_c'").all(measured.id) as { name: string; value: number | null }[]
    for (const m of ms) {
      if (m.value === null) continue
      out.push({ kind: 'thermal', quantity: `\`${m.name.replace(/\.measured_c$/, '')}\` temperature on the bench`, value: num(m.value, '°C'), limit: '', margin: '', basis: 'measured', source: `run:${measured.id}` })
    }
  }
  return out
}

/** Every value trace has recorded, by kind (load is always empty for now). */
export function recordedValues(db: DatabaseSync): Record<ValueKind, ValueRow[]> {
  return { power: power(db), thermal: thermal(db), load: [] }
}

const cell = (s: string): string => s.replace(/\|/g, '\\|')

/** The rows as a values table with its marker, ready to put in a section; `pending` adds rows still to be worked out. */
export function valuesTable(kind: ValueKind, rows: readonly ValueRow[], pending: readonly string[] = []): string {
  const head = VALUE_COLUMNS.map((c) => c[0]!.toUpperCase() + c.slice(1))
  const lines = [
    `<!-- scribe:values kind="${kind}" -->`,
    `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`,
    ...rows.filter((r) => r.kind === kind).map((r) => `| ${[r.quantity, r.value, r.limit, r.margin, r.basis, r.source].map(cell).join(' | ')} |`),
    ...pending.map((q) => `| ${cell(q)} | pending | | | pending | |`),
  ]
  return lines.join('\n')
}

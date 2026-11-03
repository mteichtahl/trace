/**
 * The mapping against the live schema (docs/ontology-plan.md P2.4): every column trace creates in the journey record,
 * the agents' facts and the job index is mapped or left out with a reason, every mapped column exists, every table of
 * those databases is mapped or left out, and every table the project database registers is mapped or waits for a
 * named phase. Adding a column or a table without deciding where it goes fails here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyJourneySchema, EvidenceSchema, JOURNEY_TABLES, OptionSchema } from '../../src/core/journey.js'
import { applyAgentFactsSchema } from '../../src/core/agent-facts.js'
import { JOB_CONTROLS_SQL, applyJobIndexSchema } from '../../src/core/job-index.js'
import { PROJECT_SCHEMA, projectTables } from '../../src/core/store.js'
import { type DbName, IGNORED_TABLES, LATER_TABLES, TABLES, keyColumns, tableMap } from '../../src/ontology/mapping.js'

function schemaOf(db: DbName): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  if (db === 'journey') { applyJourneySchema(d, { store: true }); d.exec(JOB_CONTROLS_SQL) }
  if (db === 'facts') applyAgentFactsSchema(d)
  if (db === 'jobs') applyJobIndexSchema(d)
  return d
}
const tablesOf = (d: DatabaseSync): string[] => (d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name)
const columnsOf = (d: DatabaseSync, t: string): string[] => (d.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map((r) => r.name)

/** Every source file that registers project tables, so all of them are registered before projectTables() is read. */
function registeringModules(dir = join(process.cwd(), 'src')): string[] {
  const out: string[] = []
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) out.push(...registeringModules(p))
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts') && /ensureProjectSchema\(/.test(readFileSync(p, 'utf8'))) out.push(p)
  }
  return out
}

describe('the mapping and the schema', () => {
  for (const db of ['journey', 'facts', 'jobs'] as const) {
    it(`maps every table and column of ${db}.db, and nothing that is gone`, () => {
      const d = schemaOf(db)
      const live = tablesOf(d)
      for (const t of live) {
        const m = tableMap(db, t)
        if (!m) { expect(IGNORED_TABLES[`${db}.${t}`], `${db}.${t} is neither mapped nor ignored`).toBeTruthy(); continue }
        const cols = columnsOf(d, t)
        for (const c of cols) expect(m.columns[c], `${db}.${t}.${c} has no rule`).toBeTruthy()
        for (const c of Object.keys(m.columns)) expect(cols, `${db}.${t}.${c} is mapped but not in the table`).toContain(c)
        for (const k of keyColumns(m)) expect(cols, `${db}.${t} key ${k}`).toContain(k)
      }
      for (const m of TABLES.filter((x) => x.db === db)) expect(live, `${db}.${m.table} is mapped but not created`).toContain(m.table)
      for (const k of Object.keys(IGNORED_TABLES).filter((x) => x.startsWith(`${db}.`))) expect(live).toContain(k.slice(db.length + 1))
    })
  }

  it('every journey table, the history tables included, is mapped', () => {
    for (const t of JOURNEY_TABLES) expect(tableMap('journey', t), t).toBeTruthy()
  })

  it('every table the project database registers is mapped with the journey or waits for a named phase', async () => {
    for (const f of registeringModules()) await import(f)
    const base = [...PROJECT_SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((x) => x[1] as string)
    expect(base).toEqual(['settings', 'runs', 'measurements', 'artifacts'])
    const registered = projectTables().map((t) => t.table)
    expect(registered.length).toBeGreaterThan(40)
    for (const t of registered) {
      if ((JOURNEY_TABLES as readonly string[]).includes(t)) continue
      expect(LATER_TABLES[t], `project table ${t} is not mapped and waits for no phase`).toBeTruthy()
    }
    for (const t of Object.keys(LATER_TABLES)) expect(registered, `${t} waits for a phase but is not registered`).toContain(t)
  })

  it('maps every field of the JSON objects it reads (evidence, options)', () => {
    const fieldsOf = (table: string, col: string): string[] => {
      const r = tableMap('journey', table)?.columns[col]
      return r && 'objects' in r ? Object.keys(r.objects.fields).sort() : []
    }
    expect(fieldsOf('gate_criteria', 'evidence')).toEqual(Object.keys(EvidenceSchema.shape).sort())
    expect(fieldsOf('questions', 'options')).toEqual(Object.keys(OptionSchema.shape).sort())
  })
})

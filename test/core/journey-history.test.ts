/**
 * The journey's history tables (docs/ontology.md "Replay"; docs/ontology-plan.md P2.8): signing, returning, reopening
 * and changing the project's about each add exactly the rows that say so, rows are never changed or removed, the same
 * change merged in from another copy of the record is one row, and a project older than its history gets the start of
 * it rebuilt from its decisions log and signatures, marked as rebuilt.
 */
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyJourneySchema, backfillHistory, HISTORY_TABLES, returnGate, setCriterion, startJourney, startRevision, updateAbout } from '../../src/core/journey.js'
import { merge } from '../../src/core/dbmerge.js'
import { ADMIN, signThrough, tempDb } from '../ontology/fixture.js'

type Row = Record<string, unknown>
let db: DatabaseSync
const all = (t: string): Row[] => db.prepare(`SELECT * FROM ${t} ORDER BY at, id`).all() as Row[]
const snapshot = (): Record<string, Row[]> => Object.fromEntries(HISTORY_TABLES.map((t) => [t, all(t)]))
/** The rows added since `before`, after checking every row it had is still there unchanged. */
function added(before: Record<string, Row[]>): Record<string, Row[]> {
  const out: Record<string, Row[]> = {}
  for (const t of HISTORY_TABLES) {
    const now = all(t)
    const ids = new Set(now.map((r) => r.id))
    for (const r of before[t] ?? []) {
      expect(ids.has(r.id), `${t} ${String(r.id)} was removed`).toBe(true)
      expect(now.find((x) => x.id === r.id), `${t} ${String(r.id)} was changed`).toEqual(r)
    }
    const had = new Set((before[t] ?? []).map((r) => r.id))
    out[t] = now.filter((r) => !had.has(r.id))
  }
  return out
}
const pick = (rows: Row[] | undefined, ...cols: string[]): Row[] => (rows ?? []).map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])))

beforeEach(() => {
  db = tempDb('journey.db')
  applyJourneySchema(db, { store: true })
  startJourney(db, { template: 'board', by: ADMIN.label, name: 'Soil sensor' })
})

describe('the journey\'s history', () => {
  it('starts empty: a journey starting is in the decisions log, not the history', () => {
    expect(snapshot()).toEqual({ criterion_history: [], stage_history: [], journey_history: [] })
  })

  it('a criterion set adds one row with its status, evidence and who; setting it the same again adds none', () => {
    let before = snapshot()
    setCriterion(db, 'define.accepted', 'met', [{ kind: 'run', ref: 'r1' }], 'trace')
    const a = added(before)
    expect(pick(a.criterion_history, 'criterion', 'gate', 'revision', 'status', 'source', 'by', 'reconstructed')).toEqual([
      { criterion: 'define.accepted', gate: 'define', revision: 'A', status: 'met', source: 'checker', by: 'trace', reconstructed: 0 },
    ])
    expect(JSON.parse(String(a.criterion_history?.[0]?.evidence))).toEqual([{ kind: 'run', ref: 'r1' }])
    before = snapshot()
    setCriterion(db, 'define.accepted', 'met', [{ kind: 'run', ref: 'r1' }], 'trace')
    expect(added(before).criterion_history).toEqual([])
    setCriterion(db, 'define.accepted', 'not_met', [], ADMIN.label)
    expect(pick(added(before).criterion_history, 'status', 'source', 'by')).toEqual([{ status: 'not_met', source: 'person', by: ADMIN.label }])
  })

  it('signing a stage\'s last gate finishes it and starts the next: the stage events and the current stage move', () => {
    const before = snapshot()
    signThrough(db, 'define')
    const a = added(before)
    expect(a.criterion_history).toHaveLength(2)
    expect(pick(a.stage_history, 'stage', 'event', 'revision')).toEqual(expect.arrayContaining([
      { stage: 'define', event: 'finished', revision: 'A' }, { stage: 'architect', event: 'started', revision: 'A' },
    ]))
    expect(a.stage_history).toHaveLength(2)
    expect(pick(a.journey_history, 'field', 'old', 'new', 'by')).toEqual([{ field: 'current_stage', old: 'define', new: 'architect', by: null }])
  })

  it('returning a gate and reopening a stage adds the reopening with its reason and who', () => {
    signThrough(db, 'define')
    signThrough(db, 'architect')
    const before = snapshot()
    returnGate(db, 'capture', ADMIN, { reason: 'The power block is wrong.', reopen: 'architect' })
    const a = added(before)
    expect(pick(a.stage_history, 'stage', 'event', 'reason', 'by')).toEqual(expect.arrayContaining([
      { stage: 'architect', event: 'reopened', reason: 'The power block is wrong.', by: ADMIN.label },
    ]))
    expect(pick(a.journey_history, 'field', 'old', 'new')).toEqual([{ field: 'current_stage', old: 'capture', new: 'architect' }])
  })

  it('a new revision clears the later stages and records the revision', () => {
    for (const g of ['define', 'architect', 'capture']) signThrough(db, g)
    const before = snapshot()
    startRevision(db, 'architect', 'A new sensor', ADMIN.label)
    const a = added(before)
    expect(pick(a.journey_history, 'field', 'old', 'new').sort((x, y) => String(x.field).localeCompare(String(y.field)))).toEqual([
      { field: 'current_stage', old: 'prove', new: 'architect' }, { field: 'revision', old: 'A', new: 'B' },
    ])
    expect(a.stage_history?.some((r) => r.stage === 'architect' && r.event === 'reopened' && r.revision === 'B')).toBe(true)
    expect(a.stage_history?.some((r) => r.event === 'cleared')).toBe(true)
  })

  it('changing the project\'s about records each field with who changed it', () => {
    const before = snapshot()
    updateAbout(db, { name: 'Soil sensor 2', description: 'Outdoor' }, 'pat@example.com')
    expect(pick(added(before).journey_history, 'field', 'old', 'new', 'by').sort((x, y) => String(x.field).localeCompare(String(y.field)))).toEqual([
      { field: 'description', old: null, new: 'Outdoor', by: 'pat@example.com' },
      { field: 'name', old: 'Soil sensor', new: 'Soil sensor 2', by: 'pat@example.com' },
    ])
  })

  it('the same change merged in from another copy of the record is one row', () => {
    const ours = (db.prepare('PRAGMA database_list').get() as { file: string }).file
    const base = `${ours}.base`
    const theirs = `${ours}.theirs`
    db.close()
    copyFileSync(ours, base)
    copyFileSync(ours, theirs)
    const other = new DatabaseSync(theirs)
    applyJourneySchema(other)
    setCriterion(other, 'define.accepted', 'met', [{ kind: 'run', ref: 'r9' }], 'trace')
    other.close()
    expect(merge(base, ours, theirs)).toEqual([])
    db = new DatabaseSync(ours)
    expect(pick(all('criterion_history'), 'criterion', 'status')).toEqual([{ criterion: 'define.accepted', status: 'met' }])
    db.close()
    expect(merge(base, ours, theirs)).toEqual([])
    db = new DatabaseSync(ours)
    expect(all('criterion_history')).toHaveLength(1)
  })

  it('rebuilds the start of history for a project older than it, marked, once, and never over real history', () => {
    signThrough(db, 'define')
    returnGate(db, 'architect', ADMIN, { reason: 'Requirement 4 is wrong.', reopen: 'define' })
    for (const t of HISTORY_TABLES) db.exec(`DELETE FROM ${t}`)
    backfillHistory(db)
    const stages = pick(all('stage_history'), 'stage', 'event', 'reconstructed')
    expect(stages).toEqual(expect.arrayContaining([{ stage: 'define', event: 'started', reconstructed: 1 }, { stage: 'define', event: 'reopened', reconstructed: 1 }]))
    const crits = all('criterion_history')
    expect(crits.map((r) => r.criterion).sort()).toEqual(['define.accepted', 'define.measurable'])
    expect(crits.every((r) => r.reconstructed === 1 && r.source === 'signature' && r.status === 'met')).toBe(true)
    const once = snapshot()
    backfillHistory(db)
    expect(snapshot()).toEqual(once)
    // history the triggers wrote from here on: a later signature is never rebuilt over it
    setCriterion(db, 'define.accepted', 'not_met', [], ADMIN.label)
    signThrough(db, 'define')
    db.exec('DELETE FROM criterion_history WHERE reconstructed = 1')
    backfillHistory(db)
    const rebuilt = all('criterion_history').filter((r) => r.reconstructed === 1)
    expect(rebuilt).toHaveLength(2)
    expect(new Set(rebuilt.map((r) => String(r.id).split('@')[0])).size).toBe(1)
  })
})

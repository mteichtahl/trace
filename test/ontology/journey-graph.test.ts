/**
 * P2.7: graph.neighbourhood reads the journey through the ontology (src/ontology/journey-graph.ts), not its tables.
 * The journey read from the graph is the journey record, field for field: gates, criteria with their evidence in order,
 * signatures (one superseded by a return), a waiver, an answered question and the decisions log.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { addWaiver, answerQuestion, applyJourneySchema, askQuestion, loadJourney, recordOpen, returnGate, setCriterion, signGate, startJourney } from '../../src/core/journey.js'
import { journeyGraph } from '../../src/ontology/journey-graph.js'
import { ADMIN, tempDb } from './fixture.js'

const O = { installation: 'test', project: 'acme/graph-journey' }
let clock = Date.UTC(2026, 9, 1, 9, 0, 0)
const tick = (): void => { clock += 61_500; vi.setSystemTime(clock) }
let db: DatabaseSync

function sign(gate: string): void {
  for (const c of loadJourney(db)!.criteria.filter((x) => x.gate === gate)) {
    tick()
    if (c.status !== 'met') setCriterion(db, c.id, 'met', [{ kind: 'run', ref: `run-${c.id}`, label: `the run for ${c.id}` }, { kind: 'file', ref: 'docs/a:b.md' }], c.owner === 'trace' ? 'trace' : ADMIN.label)
    recordOpen(db, { criterion: c.id }, ADMIN.hash)
  }
  tick()
  signGate(db, gate, ADMIN)
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock)
  db = tempDb('journey.db')
  applyJourneySchema(db, { store: true })
  startJourney(db, { template: 'board', by: ADMIN.label, name: 'Graph journey' })
  sign('define')
  tick()
  const q = askQuestion(db, { askedBy: 'the Analog specialist', text: 'Which regulator?', blocks: 'the power block', jobId: 'job-1', options: [{ id: 'a', label: 'A regulator', recommended: true, why: 'quiet' }, { id: 'b', label: 'A buck', why: 'efficient' }] })
  tick()
  answerQuestion(db, q, ADMIN, { option: 'b', reason: 'the battery has to last a year' })
  askQuestion(db, { askedBy: 'the Analog specialist', text: 'Which connector?', blocks: 'the IO block', jobId: 'job-2', options: [{ id: 'a', label: 'JST', recommended: true, why: 'small' }, { id: 'b', label: 'Molex', why: 'sturdy' }] })
  sign('architect')
  tick()
  addWaiver(db, { target: { kind: 'criterion', id: 'capture.stock' }, reason: 'One part is short.', risk: 'The order may slip.', severity: 'degraded', caught_where: 'Fabricate', scope: 'this revision only' }, ADMIN)
  tick()
  returnGate(db, 'capture', ADMIN, { reason: 'A second regulator.', reopen: 'architect' })
  sign('architect')
  tick()
  setCriterion(db, 'capture.erc', 'not_met', [{ kind: 'finding', ref: 'erc:U3.4', label: 'U3 pin 4 is unconnected.' }], 'trace')
})
afterAll(() => { vi.useRealTimers() })

describe('the journey through the ontology (P2.7)', () => {
  it('is the journey record, field for field', () => {
    const r = loadJourney(db)!
    const g = journeyGraph(db, O)!
    expect(g.revision).toBe(r.journey.revision)
    expect(g.gates).toEqual(r.gates.map((x) => ({ id: x.id, stage: x.stage, ord: x.ord, name: x.name })))
    expect(g.criteria).toEqual(r.criteria.map((c) => ({ id: c.id, gate: c.gate, ord: c.ord, text: c.text, owner: c.owner, status: c.status, evidence: c.evidence.map((e) => ({ kind: e.kind, ref: e.ref, ...(e.label ? { label: e.label } : {}) })), checkedBy: c.checkedBy })))
    expect(g.signatures).toEqual(r.signatures.map((s) => ({ id: s.id, gate: s.gate, revision: s.revision, by: s.by, at: s.at, supersededAt: s.supersededAt })))
    expect(g.signatures.some((s) => s.supersededAt !== null)).toBe(true)
    expect(g.waivers).toEqual(r.waivers.map((w) => ({ id: w.id, targetKind: w.targetKind, target: w.target, reason: w.reason, severity: w.severity, scope: w.scope, by: w.by, at: w.at, closedAt: w.closedAt })))
    expect(g.questions).toEqual(r.questions.map((q) => ({ id: q.id, text: q.text, askedBy: q.askedBy, askedAt: q.askedAt, answer: q.answer, answeredBy: q.answeredBy, answeredAt: q.answeredAt })))
    expect(g.questions.filter((q) => q.answeredAt === null)).toHaveLength(1)
    expect(g.decisions.map((d) => d.id).sort()).toEqual(r.decisions.map((d) => d.id).sort())
    expect(g.decisions).toEqual([...g.decisions].sort((a, b) => b.at - a.at))
    for (const d of g.decisions) expect(d).toEqual((({ id, at, kind, ref, summary }) => ({ id, at, kind, ref, summary }))(r.decisions.find((x) => x.id === d.id)!))
  })

  it('as it stood at a moment, like the graph', () => {
    const r = loadJourney(db)!
    const first = r.signatures[0]!
    const g = journeyGraph(db, { ...O, asOf: first.at })!
    expect(g.signatures.map((s) => s.id)).toEqual([first.id])
    expect(g.waivers).toEqual([])
    expect(g.questions).toEqual([])
  })

  it('is null without a journey', () => {
    const empty = tempDb('empty.db')
    applyJourneySchema(empty, { store: true })
    expect(journeyGraph(empty, O)).toBeNull()
  })
})

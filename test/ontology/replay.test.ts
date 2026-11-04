/**
 * Replay (docs/ontology-plan.md P8.1, P8.2, P8.6): a journey played through Define and Architect, a question answered
 * against its recommendation, a waiver, Capture's gate returned with Architect reopened and signed again, the agents'
 * facts and a run, each a minute apart. Its events come in time order, each typed by the ontology; and the record as
 * it stood at each signature's moment shows exactly the criteria that signature recorded.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { addWaiver, answerQuestion, askQuestion, loadJourney, recordOpen, returnGate, setCriterion, signGate, startJourney } from '../../src/core/journey.js'
import { applyJourneySchema } from '../../src/core/journey.js'
import { applyAgentFactsSchema } from '../../src/core/agent-facts.js'
import { criteriaAsOf, journeyEvents, recordAsOf } from '../../src/ontology/replay.js'
import { CREATED } from '../../src/ontology/as-of.js'
import { buildGraph, nodeIri } from '../../src/ontology/graph.js'
import { freshness, latestFreshness } from '../../src/ontology/lineage.js'
import { TABLES } from '../../src/ontology/mapping.js'
import { Work } from '../../src/core/store.js'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readVocabulary } from '../../src/ontology/vocab.js'
import { ADMIN, tempDb } from './fixture.js'

const O = { installation: 'test', project: 'acme/replay' }
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0)
let clock = T0
const tick = (): number => { clock += 60_000; vi.setSystemTime(clock); return clock / 1000 }

let db: DatabaseSync
let facts: DatabaseSync
const at: Record<string, number> = {}

function sign(gate: string): void {
  for (const c of loadJourney(db)!.criteria.filter((x) => x.gate === gate)) {
    tick()
    if (c.status !== 'met') setCriterion(db, c.id, 'met', [{ kind: 'run', ref: `run-${c.id}`, label: `the run that checked ${c.id}` }], c.owner === 'trace' ? 'trace' : ADMIN.label)
    recordOpen(db, { criterion: c.id }, ADMIN.hash)
  }
  at[`${gate}-${Object.keys(at).filter((k) => k.startsWith(gate)).length}`] = tick()
  signGate(db, gate, ADMIN)
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  db = tempDb('journey.db')
  applyJourneySchema(db, { store: true })
  startJourney(db, { template: 'board', by: ADMIN.label, name: 'Replayed' })
  sign('define')
  tick()
  const q = askQuestion(db, { askedBy: 'the Analog specialist', text: 'Which regulator?', blocks: 'the power block', jobId: 'job-1', options: [{ id: 'a', label: 'A regulator', recommended: true, why: 'quiet' }, { id: 'b', label: 'A buck', why: 'efficient' }] })
  at.asked = clock / 1000
  at.answered = tick()
  answerQuestion(db, q, ADMIN, { option: 'b', reason: 'the battery has to last a year' })
  sign('architect')
  at.waived = tick()
  addWaiver(db, { target: { kind: 'criterion', id: 'capture.stock' }, reason: 'One part is short; five boards can wait for it.', risk: 'The order may slip a week.', severity: 'degraded', caught_where: 'Fabricate', scope: 'this revision only' }, ADMIN)
  at.returned = tick()
  returnGate(db, 'capture', ADMIN, { reason: 'The power block needs a second regulator.', reopen: 'architect' })
  sign('architect')
  // later, a Define criterion is marked not met again: the Define signature still shows what it recorded then
  tick()
  const d = loadJourney(db)!.criteria.find((c) => c.gate === 'define')!
  setCriterion(db, d.id, 'not_met', [], ADMIN.label)
  facts = tempDb('facts.db')
  applyAgentFactsSchema(facts)
  at.checked = tick()
  facts.prepare('INSERT INTO criterion_checks (id, criterion, status, evidence, note, checked_at, by, job_id, revision) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('cc-1', 'capture.erc', 'met', JSON.stringify([{ kind: 'run', ref: 'run-erc' }]), null, at.checked, 'the Implementation specialist', 'job-1', loadJourney(db)!.journey.revision)
})
afterAll(() => { vi.useRealTimers() })

describe('the event stream (P8.1)', () => {
  it('every event in time order, typed by the ontology, with a caption and the stage it fell in', () => {
    const v = readVocabulary()
    const ev = journeyEvents({ journey: db, facts }, O)
    expect(ev.map((e) => e.t)).toEqual([...ev.map((e) => e.t)].sort((a, b) => a - b))
    for (const e of ev) {
      expect(v.classes.has(e.class), `${e.id}: ${e.class}`).toBe(true)
      expect(e.record).toMatch(/^urn:trace:test:acme%2Freplay:/)
      expect(e.caption.length, e.id).toBeGreaterThan(5)
      expect(new Set(ev.map((x) => x.id)).size).toBe(ev.length)
    }
    const kinds = ev.map((e) => e.kind)
    expect(kinds[0]).toBe('journey.started')
    expect(kinds).toEqual(expect.arrayContaining(['stage.started', 'stage.finished', 'stage.reopened', 'criterion.met', 'gate.signed', 'gate.unsigned', 'gate.returned', 'waiver.taken', 'question.asked', 'question.answered', 'criterion.checked_met']))
    // the order the record happened in: Define signed before the question, Architect signed, the waiver, the return
    const first = (k: string): number => kinds.indexOf(k)
    expect(first('gate.signed')).toBeLessThan(first('question.answered'))
    expect(first('waiver.taken')).toBeLessThan(first('gate.returned'))
    const signed = ev.filter((e) => e.kind === 'gate.signed')
    expect(signed.map((e) => [e.node, e.status, e.who])).toEqual([['gate:define', 'verified', ADMIN.label], ['gate:architect', 'verified', ADMIN.label], ['gate:architect', 'verified', ADMIN.label]])
    expect(signed[0]!.caption).toMatch(/signed the .* gate$/)
    const answer = ev.find((e) => e.kind === 'question.answered')!
    expect(answer).toMatchObject({ node: expect.stringMatching(/^decision:q-/), stage: 'architect', links: [`person:${ADMIN.label}`] })
    expect(ev.find((e) => e.kind === 'waiver.taken')).toMatchObject({ status: 'waived', links: ['criterion:capture.stock', `person:${ADMIN.label}`], class: 'Waiver' })
    expect(ev.find((e) => e.kind === 'criterion.checked_met')).toMatchObject({ node: 'criterion:capture.erc', status: 'verified', class: 'CriterionCheck', who: 'the Implementation specialist' })
  })
})

describe('the record as it stood (P8.2, P8.6)', () => {
  it('at each signature\'s moment, the gate\'s criteria are exactly what that signature recorded', () => {
    const sigs = loadJourney(db)!.signatures
    expect(sigs).toHaveLength(3)
    for (const s of sigs) {
      const then = recordAsOf(db, facts, s.at)!
      const recorded = (s.criteria as { id: string; status: string }[]).map((c) => ({ id: c.id, status: c.status }))
      expect(recorded.length).toBeGreaterThan(1)
      expect(criteriaAsOf(then, s.gate), `${s.gate} at ${new Date(s.at * 1000).toISOString()}`).toEqual(recorded)
      // the signature itself stands then, and later ones do not exist yet
      expect(then.signatures.at(-1)!.id).toBe(s.id)
      expect(then.signatures.every((x) => x.at <= s.at)).toBe(true)
    }
  })

  it('only what existed by then: the question unanswered before its answer, no waiver before it was taken, a signature standing until its stage reopened', () => {
    const before = recordAsOf(db, facts, at.answered! - 1)!
    expect(before.questions.find((q) => q.text === 'Which regulator?')).toMatchObject({ answeredAt: null, answer: null })
    expect(recordAsOf(db, facts, at.answered!)!.questions.find((q) => q.text === 'Which regulator?')?.answer).toBeTruthy()
    expect(recordAsOf(db, facts, at.waived! - 1)!.waivers).toEqual([])
    expect(criteriaAsOf(recordAsOf(db, facts, at.waived!)!, 'capture').find((c) => c.id === 'capture.stock')?.status).toBe('waived')
    const archSigned = recordAsOf(db, facts, at.returned! - 1)!.signatures.filter((x) => x.gate === 'architect')
    expect(archSigned.map((x) => x.supersededAt)).toEqual([null])
    expect(recordAsOf(db, facts, at.returned!)!.signatures.filter((x) => x.gate === 'architect' && x.supersededAt === null)).toEqual([])
    // the stages: Architect reopened at the return, Capture current then
    const back = recordAsOf(db, facts, at.returned!)!
    expect(back.stages.find((s) => s.id === 'architect')?.reopenedAt).toBe(at.returned)
    // the agents' check counts from when it was made
    expect(recordAsOf(db, facts, at.checked! - 1)!.criteria.find((c) => c.id === 'capture.erc')?.status).toBe('not_met')
    expect(recordAsOf(db, facts, at.checked!)!.criteria.find((c) => c.id === 'capture.erc')?.status).toBe('met')
  })

  it('before the journey began, nothing stood', () => {
    const r = recordAsOf(db, facts, T0 / 1000 - 1)!
    expect(r.signatures).toEqual([])
    expect(r.criteria.every((c) => c.status === 'not_met')).toBe(true)
    expect(r.stages.every((s) => s.started === null)).toBe(true)
  })
})

describe('the graph and lineage as they stood (P8.2)', () => {
  const T = 'https://trace-eda.com/ns/trace#'
  const graph = (t?: number) => buildGraph({ journey: db }, { ...O, ...(t === undefined ? {} : { asOf: t }) }).store
  const value = (store: ReturnType<typeof graph>, s: string, p: string): string[] => store.getQuads(s, `${T}${p}`, null, null).map((q) => q.object.value)

  it('every mapped table says when its rows came into being', () => {
    for (const t of TABLES) expect(CREATED[t.table], t.table).toBeTruthy()
  })

  it('the graph at a moment holds only what existed then, each criterion as it stood', () => {
    const typed = (store: ReturnType<typeof graph>, cls: string) => store.getSubjects('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${T}${cls}`, null)
    expect(typed(graph(at.waived! - 1), 'Waiver')).toEqual([])
    expect(typed(graph(at.waived!), 'Waiver')).toHaveLength(1)
    expect(typed(graph(at['architect-0']! - 1), 'Signature')).toHaveLength(1)
    const sig = loadJourney(db)!.signatures[0]!
    const then = graph(sig.at)
    for (const c of sig.criteria as { id: string; status: string }[]) {
      expect(value(then, nodeIri(O, 'criterion', c.id), 'status'), c.id).toEqual([c.status === 'met' ? 'met' : 'not_met'])
    }
    // now, the Define criterion marked not met later reads not met; then, it read met
    const d = loadJourney(db)!.criteria.find((c) => c.gate === 'define')!
    expect(value(graph(), nodeIri(O, 'criterion', d.id), 'status')).toEqual(['not_met'])
    expect(value(then, nodeIri(O, 'criterion', d.id), 'status')).toEqual(['met'])
    // an answer given later is not there before it
    const q = loadJourney(db)!.questions.find((x) => x.text === 'Which regulator?')!
    expect(value(graph(at.answered! - 1), nodeIri(O, 'question', q.id), 'answeredAt')).toEqual([])
    expect(value(graph(at.answered!), nodeIri(O, 'question', q.id), 'answeredAt')).toHaveLength(1)
  })

  it('lineage as of a moment: the newest run then, not now', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-replay-lineage-'))
    mkdirSync(join(dir, '.git'))
    const w = new Work(join(dir, 'project.db'))
    const net1 = w.start('kicad.netlist', { subject: 'hw/a.kicad_sch' })
    w.inputs(net1, [{ kind: 'file', ref: 'hw/a.kicad_sch', sha256: null }])
    w.artifact(net1, 'netlist.net', '(export 1)')
    w.finish(net1, 'pass', 'netlist')
    const t1 = tick()
    const lay = w.start('layout.check', { subject: 'hw/a.kicad_sch' })
    const h = (w.db.prepare('SELECT sha256 FROM artifact_hashes WHERE run_id=?').get(net1) as { sha256: string }).sha256
    w.inputs(lay, [{ kind: 'artifact', ref: net1, name: 'netlist.net', sha256: h }])
    w.finish(lay, 'pass', 'checked')
    const t2 = tick()
    const net2 = w.start('kicad.netlist', { subject: 'hw/a.kicad_sch' })
    w.inputs(net2, [{ kind: 'file', ref: 'hw/a.kicad_sch', sha256: null }])
    w.artifact(net2, 'netlist.net', '(export 2)')
    w.finish(net2, 'pass', 'netlist')
    const read = () => null
    expect(freshness(w.db, lay, read).state).toBe('stale')
    // just before the netlist was made again, the layout check stood on the newest netlist then
    expect(freshness(w.db, lay, read, new Map(), new Set(), t2 - 1).state).toBe('current')
    expect(latestFreshness(w.db, read, t1 - 1).map((f) => f.run)).toEqual([net1])
    expect(latestFreshness(w.db, read, t2 - 1).map((f) => f.run).sort()).toEqual([lay, net1].sort())
    expect(latestFreshness(w.db, read).map((f) => f.run).sort()).toEqual([lay, net2].sort())
    w.close()
  })
})

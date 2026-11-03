/**
 * A project's records for the ontology's tests, made through trace's own writers (src/core/journey.ts, agent-facts.ts,
 * job-index.ts) so they are what trace really stores: a board journey signed through Define and Architect, a question
 * answered against its recommendation, a waiver, Capture's gate returned with Architect reopened, the agents' facts (a question,
 * criterion checks, stuck work, a hand-off) and the job index.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  addWaiver, answerQuestion, applyJourneySchema, askQuestion, loadJourney, recordOpen, recordOrder, returnGate, setCriterion, signGate,
  startJourney, updateAbout, type JourneyRecord,
} from '../../src/core/journey.js'
import { applyAgentFactsSchema } from '../../src/core/agent-facts.js'
import { JOB_CONTROLS_SQL, applyJobIndexSchema } from '../../src/core/job-index.js'

export const ADMIN = { hash: 'a'.repeat(16), label: 'admin@example.com' }

export function tempDb(name: string): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'trace-ontology-'))
  mkdirSync(join(dir, '.git'))
  return new DatabaseSync(join(dir, name))
}

export const rec = (db: DatabaseSync): JourneyRecord => loadJourney(db) as JourneyRecord

export function signThrough(db: DatabaseSync, gate: string): void {
  for (const c of rec(db).criteria.filter((x) => x.gate === gate)) {
    setCriterion(db, c.id, 'met', [{ kind: 'run', ref: `run-${c.id}`, label: `the run that checked ${c.id}` }], c.owner === 'trace' ? 'trace' : ADMIN.label)
    recordOpen(db, { criterion: c.id }, ADMIN.hash)
  }
  signGate(db, gate, ADMIN)
}

/** The journey record (journey.db) of a board project part way through, as the API writes it. */
export function journeyDb(): DatabaseSync {
  const db = tempDb('journey.db')
  applyJourneySchema(db, { store: true })
  db.exec(JOB_CONTROLS_SQL)
  startJourney(db, { template: 'board', by: ADMIN.label, name: 'Soil sensor', build: { quantity: 5 } })
  signThrough(db, 'define')
  const q = askQuestion(db, {
    askedBy: 'the Analog specialist', text: 'Which regulator?', blocks: 'the power block', jobId: 'job-1',
    options: [{ id: 'a', label: 'A low-dropout regulator', recommended: true, why: 'quiet and cheap' }, { id: 'b', label: 'A buck converter', why: 'efficient', gives_up: 'more noise' }],
  })
  answerQuestion(db, q, ADMIN, { option: 'b', reason: 'the battery has to last a year' })
  signThrough(db, 'architect')
  addWaiver(db, { target: { kind: 'criterion', id: 'capture.stock' }, reason: 'One part is short; five boards can wait for it.', risk: 'The order may slip a week.', severity: 'degraded', caught_where: 'Fabricate', scope: 'this revision only' }, ADMIN)
  returnGate(db, 'capture', ADMIN, { reason: 'The power block needs a second regulator.', reopen: 'architect' })
  updateAbout(db, { name: 'Soil sensor, outdoor' }, ADMIN.label)
  recordOrder(db, { number: 'SO-1', boards: 5, paid: 23.5, ship_date: '2026-11-20' }, ADMIN)
  db.prepare('INSERT INTO job_controls (job, held, ord, discarded, by, at) VALUES (?,?,?,?,?,?)').run('job-2', 1, 1, 0, ADMIN.label, Date.now() / 1000)
  return db
}

/** The agents' facts (facts.db), as the agents' tools write them. */
export function factsDb(): DatabaseSync {
  const db = tempDb('facts.db')
  applyAgentFactsSchema(db)
  const t = Date.now() / 1000
  db.prepare('INSERT INTO agent_questions (id, asked_by, agent, asked_of_sub, asked_part, stage, text, blocks, options, sources, job_id, asked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('aq-1', 'the Layout specialist', 'impl', null, 'contributors', 'layout', 'Two layers or four?', 'routing',
      JSON.stringify([{ id: 'two', label: 'Two layers', recommended: true, why: 'cheaper' }]), JSON.stringify([{ kind: 'file', ref: 'hardware/x.kicad_pcb', label: 'the board' }]), 'job-1', t)
  db.prepare('INSERT INTO criterion_checks (id, criterion, status, evidence, note, checked_at, by, job_id, revision) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('cc-1', 'capture.erc', 'met', JSON.stringify([{ kind: 'run', ref: 'run-erc', label: 'the electrical rule check' }]), null, t, 'impl', 'job-1', 'A')
  db.prepare('INSERT INTO stuck (id, job_id, agent, agent_label, why, recommendation, options, sources, stage, at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('st-1', 'job-1', 'impl', 'the Implementation specialist', 'The footprint is missing.', 'Draw it from the datasheet.', '[]', '[]', 'capture', t)
  db.prepare(`INSERT INTO handoffs (id, from_agent, from_label, from_job, to_kind, question, evidence, blocks, recommendation, acceptance, depth, state, created_at, job_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('ho-1', 'impl', 'the Implementation specialist', 'job-1', 'verify', 'Is the regulator stable?', '[]', 'the power block', null,
    JSON.stringify(['a phase margin']), 1, 'started', t, 'job-2')
  return db
}

/** The job index (jobs.db), as the runtimes write it. */
export function jobsDb(): DatabaseSync {
  const db = tempDb('jobs.db')
  applyJobIndexSchema(db)
  const t = Date.now() / 1000
  const add = db.prepare('INSERT INTO jobs (id, kind, agent, title, state, queued_at, started_at, branch, handoff, parent_job, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  add.run('job-1', 'task', 'impl', 'Lay out the board', 'running', t, t, 'claude/task-layout', null, null, t)
  add.run('job-2', 'task', 'verify', 'Answer the hand-off', 'queued', t, null, null, 'ho-1', 'job-1', t)
  return db
}

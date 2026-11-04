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

/** The repository's project database (.trace/project.db): settings, runs, the design and verification records, a bench reading. */
export async function projectDb(): Promise<DatabaseSync> {
  const { openProject } = await import('../../src/core/store.js')
  // the modules that register the design, verification and bench tables
  await import('../../src/tools/design/db.js')
  await import('../../src/tools/verify/db.js')
  await import('../../src/core/bench.js')
  const dir = mkdtempSync(join(tmpdir(), 'trace-ontology-project-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  const t = Date.now() / 1000
  const run = db.prepare('INSERT INTO runs (id, kind, subject, started, finished, status, summary, args, result, git_sha, agent, job) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  run.run('run-drc', 'kicad.drc', 'hardware/sensor-node.kicad_pro', t, t, 'pass', '0 errors', '{}', '{"errors":0}', 'abc123', 'impl', 'job-1')
  run.run('run-verify', 'verify.run', 'TST-1', t, t, 'pass', 'passed', '{"test":"TST-1"}', '{}', 'abc123', 'verify', null)
  db.prepare('INSERT INTO measurements (run_id, name, value, unit, detail) VALUES (?,?,?,?,?)').run('run-drc', 'errors', 0, null, null)
  db.prepare('INSERT INTO artifacts (run_id, name, mime, bytes) VALUES (?,?,?,?)').run('run-drc', 'drc-report', 'application/json', new Uint8Array([123, 125]))
  db.prepare('INSERT INTO settings (key, value, updated, by) VALUES (?,?,?,?)').run('build.quantity', '5', t, ADMIN.label)
  db.prepare('INSERT INTO intent_statements (id, topic, kind, text, source, testable, status, created, updated, by) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('INT-1a2b3c', 'power', 'statement', 'Runs a year on two AA cells.', '{"kind":"person"}', 1, 'proposed', t, t, ADMIN.label)
  db.prepare('INSERT INTO requirements (id, text, kind, acceptance, status, tags, created, updated, by) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('REQ-PWR-001', 'The board shall run from 2.0 V to 3.3 V.', 'electrical', 'The rail holds within 3.2 to 3.4 V.', 'accepted', '["power"]', t, t, ADMIN.label)
  db.prepare('INSERT INTO requirement_intent (requirement, intent, removed, updated, by) VALUES (?,?,?,?,?)').run('REQ-PWR-001', 'INT-1a2b3c', 0, t, 'verify')
  db.prepare('INSERT INTO arch_options (id, name, summary, recommended, why, gives_up, risks, status, created, updated, by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('A', 'Low-dropout supply', 'A regulator and a microcontroller', 1, 'quiet', 'efficiency', '["a short battery life"]', 'proposed', t, t, 'impl')
  db.prepare('INSERT INTO arch_criteria (id, name, weight, status, updated, by) VALUES (?,?,?,?,?,?)').run('power', 'Power', 2, 'proposed', t, 'impl')
  db.prepare('INSERT INTO arch_scores (option, criterion, score, reason, updated, by) VALUES (?,?,?,?,?,?)').run('A', 'power', 4, 'low quiescent current', t, 'impl')
  const block = db.prepare('INSERT INTO arch_blocks (option, id, name, role, parts, requirements, status, updated, by) VALUES (?,?,?,?,?,?,?,?,?)')
  block.run('A', 'power', 'Power', 'supply', '[{"mpn":"TPS7A02","role":"regulator","key":true}]', '["REQ-PWR-001"]', 'proposed', t, 'impl')
  block.run('A', 'mcu', 'Microcontroller', 'control', '[{"mpn":"STM32L031"}]', '[]', 'proposed', t, 'impl')
  db.prepare('INSERT INTO arch_connections (option, id, from_block, to_block, kind, label, status, updated, by) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('A', 'c1', 'power', 'mcu', 'rail', '3.3 V, 10 mA', 'proposed', t, 'impl')
  db.prepare('INSERT INTO pin_plan (part, pin, name, function, net, kind, alternates, status, updated, by) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('J1', '1', 'VDD', 'power', 'GND', 'power', '[]', 'proposed', t, 'impl')
  db.prepare('INSERT INTO sheet_requirements (sheet, block, requirements, updated, by) VALUES (?,?,?,?,?)').run('hardware/sensor-node.kicad_sch', 'power', '["REQ-PWR-001"]', t, 'impl')
  db.prepare('INSERT INTO test_items (id, title, requirements, method, tool, args, status, last_run, created, updated, by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('TST-1', 'The rail holds', '["REQ-PWR-001"]', 'drc', 'kicad.drc', '{}', 'pass', 'run-verify', t, t, 'verify')
  db.prepare('INSERT INTO test_results (run_id, test_id, status, evidence, reason, at) VALUES (?,?,?,?,?,?)').run('run-verify', 'TST-1', 'pass', '["run-drc"]', null, t)
  db.prepare('INSERT INTO coverage_points (id, requirements, kind, match, goal, created, updated, by) VALUES (?,?,?,?,?,?,?,?)').run('COV-1', '["REQ-PWR-001"]', 'functional', 'rail_ok', 1, t, t, 'verify')
  db.prepare('INSERT INTO parts_list_lines (run_id, line, mpn, part_key, order_code, refs, per_board, need, status, flags, stock, unit_price, line_total, currency, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('run-drc', 1, 'TPS7A02', 'TPS7A02', 'C2862740', 'U1', 1, 5, 'ok', '["end-of-life"]', 1200, 0.42, 2.1, 'USD', null)
  db.prepare('INSERT INTO coverage_hits (run_id, kind, name, hits) VALUES (?,?,?,?)').run('run-verify', 'functional', 'rail_ok', 3)
  db.prepare('INSERT INTO bringup_readings (id, board, step, instrument, quantity, value, unit, min, max, pass, at, by, run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('rd-1', 'SN-001', 'rails', 'dmm', '3V3 rail at TP4', 3.31, 'V', 3.2, 3.4, 1, t, 'impl', 'run-verify')
  return db
}

/** The installation's parts database, with one part and one offer. */
export async function partsDb(): Promise<DatabaseSync> {
  const { PARTS_SCHEMA } = await import('../../src/tools/parts/db.js')
  const { mpnKey } = await import('../../src/tools/datasheets/mpn.js')
  const db = tempDb('central.db')
  db.exec(PARTS_SCHEMA)
  const t = Date.now() / 1000
  db.prepare('INSERT INTO parts (key, mpn, manufacturer, description, package, lifecycle, attributes, datasheet_url, updated) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(mpnKey('TPS7A02'), 'TPS7A02', 'Texas Instruments', 'Low-dropout regulator', 'X2SON-4', 'active', '{}', 'https://www.ti.com/lit/ds/symlink/tps7a02.pdf', t)
  db.prepare('INSERT INTO part_offers (part_key, provider, seller, provider_part, mpn, stock, moq, price_breaks, url, offer, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(mpnKey('TPS7A02'), 'jlcpcb', 'JLCPCB', 'C2862740', 'TPS7A02', 1200, 1, '[{"qty":1,"price":0.4,"currency":"USD"}]', null, '{}', t)
  return db
}

/** The sample project's board (examples/sensor-node), read the way every trace tool reads it. */
export async function sampleBoard(): Promise<{ path: string; board: import('../../src/tools/kicad/pcb.js').Board }> {
  const { loadBoard } = await import('../../src/tools/kicad/pcb.js')
  const path = 'hardware/sensor-node.kicad_pcb'
  return { path, board: loadBoard(join(process.cwd(), 'examples', 'sensor-node', path)) }
}

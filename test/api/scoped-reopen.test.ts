/**
 * A reopen for changed requirements redoes only what the change reaches (src/api/reopen-scope.ts; test-esp32 log
 * #62, #71, #112, #114, #116). In the test run one acceptance limit changed after Prove (REQ-39855b, ±3 % to
 * 3.1-3.6 V): Define reopened, as it must, but re-signing each gate started that stage's agents again (a new
 * "propose the architecture" job, a schematic job and a docs job each time), and each gate stayed locked until they
 * finished and their changes were accepted. Now the gates are still signed again, and a stage whose work the change
 * does not reach keeps its evidence and starts nothing; Prove runs again only the changed requirement's tests.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { hashOf, journeyStore } from '../../src/api/action-kit.js'
import { editWords, requirementReopens, stageScope, type Trace } from '../../src/api/reopen-scope.js'
import { addWaiver, loadJourney, type JourneyRecord, recordOpen, setCriterion, signGate, startJourney } from '../../src/core/journey.js'
import { recordDesignDecision } from '../../src/tools/design/decisions.js'
import { register } from '../../src/core/onboard.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { backendFor } from '../../src/core/central.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const REPO = 'acme/scoped-reopen'
const ADMIN = { sub: 'sr-admin', email: 'sr-admin@example.com', groups: ['trace-admins'] }
const github = new FakeGitHub([REPO])
const started: { request: string; agent?: string }[] = []
const scratch = mkdtempSync(join(tmpdir(), 'trace-scoped-reopen-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-scoped-reopen-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })
const deps: ActionDeps = {
  github: async () => github, cognito: () => new FakeCognito(), tools: () => new Registry([]), scratch,
  jobs: async () => ({
    repositoryOf: () => null,
    startJob: async (p) => { started.push({ request: p.request, ...(p.agent ? { agent: p.agent } : {}) }); return { accepted: true, jobId: `job-${started.length}` } },
    jobStatus: async () => [],
  }),
  store: (p) => backendFor(join(bucket, p)),
}
const ctx = (): Context => ({ principal: ADMIN, deps })
const signer = { hash: hashOf(ADMIN), label: ADMIN.email }
const OLD = 'Regulator rated >= 600 mA; output 3.3 V within +/-3 % at 0 to 500 mA load.'
const NEW = 'Regulator rated >= 600 mA; output between 3.1 V and 3.6 V at 0 to 500 mA load.'
const RAIL = 'The 3.3 V regulator is rated for at least 600 mA output.'

/** The default branch's project database: the requirements, the chosen architecture's blocks, the sheets and tests. */
function putDesign(acceptance: string, status: 'accepted' | 'proposed', o: { railWords?: string } = {}): void {
  const dir = mkdtempSync(join(scratch, 'design-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  const q = db.prepare('INSERT INTO requirements (id, text, kind, acceptance, status, created, updated) VALUES (?,?,?,?,?,0,?)')
  q.run('REQ-39855b', o.railWords ?? RAIL, 'electrical', acceptance, status, Date.now() / 1000)
  q.run('REQ-0a1b2c', 'The display shows the reading.', 'functional', 'Reading shown within 1 s.', 'accepted', 0)
  db.prepare("INSERT INTO arch_options (id, name, summary, status, created, updated) VALUES ('A', 'LDO', 'An LDO rail', 'proposed', 0, 0)").run()
  const b = db.prepare("INSERT INTO arch_blocks (option, id, name, parts, requirements, status, updated) VALUES ('A', ?, ?, '[]', ?, 'proposed', 0)")
  b.run('power', 'power', JSON.stringify(['REQ-39855b']))
  b.run('display', 'display', JSON.stringify(['REQ-0a1b2c']))
  db.prepare("INSERT INTO sheet_requirements (sheet, block, requirements, updated) VALUES ('hardware/power.kicad_sch', 'power', ?, 0)").run(JSON.stringify(['REQ-39855b']))
  const t = db.prepare("INSERT INTO test_items (id, title, requirements, method, status, created, updated) VALUES (?, ?, ?, 'inspection', 'pass', 0, 0)")
  t.run('TST-008', 'Regulator limits', JSON.stringify(['REQ-39855b']))
  t.run('TST-009', 'Rail on the bench', JSON.stringify(['REQ-39855b']))
  t.run('TST-001', 'Display reading', JSON.stringify(['REQ-0a1b2c']))
  // the runs every criterion cites: their changes are accepted
  for (const g of ['architect', 'capture', 'prove']) for (const k of ['blocks', 'mapped', 'stock', 'erc', 'datasheets', 'pins', 'verified', 'failing']) {
    db.prepare("INSERT INTO runs (id, kind, started, status) VALUES (?, 'verify.run', 1, 'pass')").run(`run-${g}.${k}`)
  }
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
}

const update = async <T>(fn: (db: DatabaseSync) => T): Promise<T> => (await journeyStore(ctx(), REPO).update((db) => ({ result: fn(db) }))).result
const rec = async (): Promise<JourneyRecord> => (await journeyStore(ctx(), REPO).read((db) => loadJourney(db) as JourneyRecord)).result
const meet = (db: DatabaseSync, gate: string): void => {
  for (const c of loadJourney(db)!.criteria.filter((x) => x.gate === gate)) {
    if (c.id !== 'capture.erc') setCriterion(db, c.id, 'met', [{ kind: 'run', ref: `run-${c.id}` }], 'seed')
    recordOpen(db, { criterion: c.id }, signer.hash)
  }
}
const agree = (db: DatabaseSync, acceptance: string, text = RAIL): void => {
  recordDesignDecision(db, { kind: 'requirement', target: 'REQ-39855b', choice: 'accepted', detail: { text, acceptance } }, signer)
  recordDesignDecision(db, { kind: 'requirement', target: 'REQ-0a1b2c', choice: 'accepted', detail: { text: 'The display shows the reading.', acceptance: 'Reading shown within 1 s.' } }, signer)
}
const sign = async (gate: string): Promise<Record<string, any>> => (await perform('gate.sign', { repo: REPO, gate }, ctx())).result as Record<string, any>
const journey = async (): Promise<Record<string, any>> => (await perform('journey.get', { repo: REPO }, ctx())).result as Record<string, any>

beforeAll(async () => {
  await register(REPO, null)
  putDesign(OLD, 'accepted')
  // the project signed through Prove, with the requirements agreed and option A chosen; the rule check is waived so
  // the schematic review reads only this test's record
  await update((db) => {
    startJourney(db, { template: 'board', by: 'seed', name: 'Rail' })
    agree(db, OLD)
    recordDesignDecision(db, { kind: 'architecture.choice', target: 'architecture', choice: 'A', detail: { option: 'A', reason: 'simplest' } }, signer)
    const w = addWaiver(db, { target: { kind: 'criterion', id: 'capture.erc' }, reason: 'the rule check runs on the bench copy', risk: 'a wiring slip is caught later', severity: 'cosmetic', caught_where: 'bring up', scope: 'this revision only' }, signer)
    for (const g of ['define', 'architect', 'capture', 'prove']) {
      meet(db, g)
      if (g === 'capture') recordOpen(db, { waiver: w.id }, signer.hash)
      signGate(db, g, signer, { acknowledged: g === 'capture' ? [w.id] : [] })
    }
  })
})

describe('a requirement whose acceptance limit changed after Prove (test-esp32 #62, #71)', () => {
  it('still takes the project back to Define, and keeps what the reopen took back with it', async () => {
    expect((await rec()).journey.currentStage).toBe('layout')
    putDesign(NEW, 'proposed')
    await expect(sign('layout')).rejects.toThrow(/requirement REQ-39855b was changed after the requirements baseline/)
    const r = await rec()
    expect(r.journey.currentStage).toBe('define')
    expect(r.criteria.find((c) => c.id === 'architect.blocks')?.status).toBe('not_met')
    const reopens = requirementReopens(r, 'architect')
    expect(reopens).toMatchObject([{ stage: 'define', from: 'layout', requirements: ['REQ-39855b'] }])
    expect(reopens![0]!.rewound.map((k) => k.id)).toEqual(expect.arrayContaining(['define.accepted', 'architect.blocks', 'architect.mapped', 'capture.pins', 'prove.verified']))
  })

  it('shows on the Overview which gates are signed again, and that their evidence stands', async () => {
    const j = await journey()
    expect(j.resign).toMatchObject({ requirements: ['REQ-39855b'], edits: 'REQ-39855b changed only its acceptance criterion' })
    const state = Object.fromEntries(j.resign.gates.map((g: any) => [g.gate, g.state]))
    expect(state).toEqual({ define: 'agree', architect: 'kept', capture: 'kept', prove: 'redo', layout: 'kept' })
    const why = (g: string): string => j.resign.gates.find((x: any) => x.gate === g).why
    expect(why('define')).toBe('Agree REQ-39855b again in Requirements review, then sign it.')
    expect(why('architect')).toMatch(/^The chosen architecture stands: only the acceptance criterion of REQ-39855b changed, and Prove checks the design against it\. Sign it again; nothing is redone\.$/)
    expect(why('prove')).toBe('Done again: REQ-39855b changed only its acceptance criterion: TST-008, TST-009 are run again.')
  })

  it('re-signing Define starts no Architect agent and no docs job: its evidence is kept, so its gate is ready at once', async () => {
    putDesign(NEW, 'proposed')
    await update((db) => { agree(db, NEW); meet(db, 'define') })
    const n = started.length
    const s = await sign('define')
    expect(s.advanced_to).toBe('architect')
    expect(started.slice(n)).toEqual([])
    expect(s.reopen).toMatchObject({ stage: 'architect', kept: true, requirements: ['REQ-39855b'] })
    expect(s.summary).toMatch(/Architect started\. The chosen architecture stands: only the acceptance criterion of REQ-39855b changed, .* Sign its gate again; nothing is redone\.$/)
    const r = await rec()
    expect(r.criteria.filter((c) => c.gate === 'architect').map((c) => [c.id, c.status, c.evidence[0]?.ref])).toEqual([
      ['architect.blocks', 'met', 'run-architect.blocks'], ['architect.mapped', 'met', 'run-architect.mapped'], ['architect.stock', 'met', 'run-architect.stock'],
    ])
    expect(r.decisions.find((d) => d.kind === 'stage.kept')).toMatchObject({ stage: 'architect', summary: expect.stringMatching(/^Architect keeps its work after the change of requirements/), detail: { requirements: ['REQ-39855b'] } })
    const j = await journey()
    expect(j.gates.find((g: any) => g.id === 'architect')).toMatchObject({ may_sign: true })
    expect(j.resign.gates.find((g: any) => g.gate === 'define').state).toBe('signed')
  })

  it('Capture likewise; Prove runs again only the changed requirement\'s tests', async () => {
    let n = started.length
    expect((await sign('architect')).advanced_to).toBe('capture')
    expect(started.slice(n)).toEqual([])
    n = started.length
    const s = await sign('capture')
    expect(s.advanced_to).toBe('prove')
    expect(s.reopen).toMatchObject({ stage: 'prove', kept: false })
    expect(started.slice(n).map((x) => x.agent)).toEqual(['verify'])
    const q = started.at(-1)!.request
    expect(q).toMatch(/^Prove is open again because requirements changed after the baseline \(REQ-39855b changed only its acceptance criterion\)/)
    expect(q).toMatch(/Redo only what it reaches \(TST-008, TST-009\)/)
    expect(q).toMatch(/say in your result what you kept and why/)
    // the stage's own request follows, whole
    expect(q).toMatch(/The schematic review gate was signed: the project is in Prove/)
    expect((await rec()).decisions.find((d) => d.kind === 'stage.rework')).toMatchObject({ stage: 'prove', detail: { reach: ['TST-008', 'TST-009'] } })
  })
})

describe('stageScope', () => {
  const t = (edits: Trace['edits']): Trace => ({ edits, blocks: { 'REQ-39855b': ['power'] }, sheets: { 'REQ-39855b': ['hardware/power.kicad_sch'] }, tests: { 'REQ-39855b': ['TST-008'] } })

  it('a change of a requirement\'s words reaches the blocks and sheets that serve it, and everything built on them', () => {
    const tr = t({ 'REQ-39855b': ['words'] })
    const a = stageScope('architect', ['REQ-39855b'], tr)
    expect(a).toMatchObject({ kept: false, reach: ['REQ-39855b'] })
    expect(a.why).toBe('REQ-39855b changed, and power of the chosen architecture serves it')
    expect(stageScope('capture', ['REQ-39855b'], tr, [a])).toMatchObject({ kept: false, why: 'the architect work it builds on is done again' })
  })

  it('a change of words of a requirement nothing serves keeps the design, and the layout is laid out again', () => {
    const tr = t({ 'REQ-77': ['words'] })
    const a = stageScope('architect', ['REQ-77'], tr)
    expect(a).toMatchObject({ kept: true, why: 'The chosen architecture stands: no block of the chosen architecture serves REQ-77.' })
    const c = stageScope('capture', ['REQ-77'], tr, [a])
    expect(c.kept).toBe(true)
    expect(stageScope('layout', ['REQ-77'], tr, [a, c])).toMatchObject({ kept: false })
  })

  it('a new requirement reaches the architecture, and one with nothing chosen yet is done in full', () => {
    expect(stageScope('architect', ['REQ-9'], t({ 'REQ-9': ['new'] })).kept).toBe(false)
    expect(stageScope('architect', ['REQ-39855b'], { ...t({ 'REQ-39855b': ['acceptance'] }), blocks: null })).toMatchObject({ kept: false, why: 'no architecture is chosen on the default branch yet' })
  })

  it('says how each requirement changed', () => {
    expect(editWords(['A', 'B', 'C'], { edits: { A: ['acceptance'], B: ['acceptance'], C: ['words', 'acceptance'] } })).toBe('C changed its words; A and B changed only their acceptance criteria')
  })
})

describe('a reopen for anything else', () => {
  it('keeps nothing: the stage\'s work starts in full, as before', () => {
    const r = {
      stages: [{ id: 'define', ord: 0, started: 1 }, { id: 'architect', ord: 1, started: 2 }], gates: [{ id: 'architect', stage: 'architect' }],
      decisions: [{ kind: 'gate.signed', ref: 'architect', at: 3 }, { kind: 'stage.reopened', stage: 'define', at: 4, detail: null }],
    } as unknown as JourneyRecord
    expect(requirementReopens(r, 'architect')).toBeNull()
  })
})

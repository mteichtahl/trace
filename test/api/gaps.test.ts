/**
 * The actions the web app's screens were built against: job.control, requirements.trace, design.get, build.get,
 * order.record, cost.get, skill.*, policy.* with me.get's locks, users.list's last seen and name, users.history,
 * and files.list's history and findings.
 */
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, type JobsApi, perform } from '../../src/api/actions.js'
import { journeyStore } from '../../src/api/action-kit.js'
import { CHECKS } from '../../src/api/skill-checks.js'
import { listen } from '../../src/api/server.js'
import { assign, seen, setClass } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { askQuestion, decide, setCriterion, startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { SKILL_DEFS } from '../../src/core/skills.js'
import { openProject } from '../../src/core/store.js'
import '../../src/tools/verify/db.js'
import { FakeCognito, FakeGitHub, accessToken, verifier } from './fixtures.js'

const ADMIN = { sub: 'g-admin', email: 'g-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'g-user', email: 'g-user@example.com', groups: ['trace-users'] }
const REVIEWER = { sub: 'g-rev', email: 'g-rev@example.com', groups: ['trace-users'] }
const OUTSIDER = { sub: 'g-out', email: 'g-out@example.com', groups: ['trace-users'] }
const NEWCOMER = { sub: 'g-new', email: 'g-new@example.com', groups: ['trace-users'] }

const REPO = 'acme/gaps'
const github = new FakeGitHub([REPO, 'acme/empty'])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-gaps-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-gaps-bucket-'))

// one running job on acme/gaps; cancel aborts it
const JOB = 'trace-api-00000000-000000000000000000000000.job-1'
const jobState = { state: 'running' }
const cancels: string[] = []
const jobsApi: JobsApi = {
  repositoryOf: (id) => (id === JOB ? REPO : null),
  startJob: async (p) => ({ accepted: true, jobId: `task:${p.request.slice(0, 20)}` }),
  jobStatus: async (id) => (id === JOB ? [{ id: JOB, kind: 'task', repository: REPO, state: jobState.state }] : []),
  cancel: async (id, reason) => {
    cancels.push(reason)
    if (jobState.state !== 'running') return { ok: false, state: jobState.state, reason: 'The job has already aborted.' }
    jobState.state = 'aborted'
    return { ok: true, state: 'aborted', kept: 'Commits the agent had already pushed stay on their branch.' }
  },
}
const deps: ActionDeps = {
  github: async () => github, cognito: () => cognito, jobs: async () => jobsApi, tools: () => new Registry([]), scratch,
  store: (prefix) => backendFor(join(bucket, prefix)),
}
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<unknown> => (await perform(action, args, { principal: who, deps })).result

const ERC = JSON.stringify({
  kicad_version: '10.0.7', coordinate_units: 'mm',
  sheets: [
    { path: '/', violations: [{ type: 'pin_not_connected', severity: 'error', description: 'Pin not connected', items: [{ description: 'Symbol U1 Pin 3 [GPIO]', pos: { x: 10, y: 20 } }] }] },
    { path: '/Power/', violations: [{ type: 'lib_symbol_issues', severity: 'warning', description: 'Symbol not in library', items: [{ description: 'Symbol U2 [LDO]', pos: { x: 30, y: 40 } }] }] },
  ],
})
const DRC = JSON.stringify({ coordinate_units: 'mm', violations: [{ type: 'clearance', severity: 'error', description: 'Clearance violation', items: [{ description: 'Pad 1 of R4 on F.Cu', pos: { x: 5, y: 6 } }] }], unconnected_items: [], schematic_parity: [] })

function seed(repo: string, fn: (db: DatabaseSync) => void): void {
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  fn(db)
  db.close()
  github.files.set(`${repo}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  rmSync(dir, { recursive: true, force: true })
}

let server: Server
let url = ''
async function call(token: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}

beforeAll(async () => {
  cognito.add(ADMIN.email, ADMIN.sub, 'trace-admins', 'Grace Admin')
  for (const p of [USER, REVIEWER, OUTSIDER, NEWCOMER]) cognito.add(p.email, p.sub, 'trace-users')
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await assign(ADMIN, REVIEWER, REPO, { part: 'reviewer', class: 'user' })
  await setClass(ADMIN, REVIEWER, 'user')
  await seen(USER)
  seed(REPO, (db) => {
    startJourney(db, { template: 'board', by: 'seed', name: 'Gaps', build: { quantity: 10, unit_cost: 12.5, budget: 500 } })
    const t = Date.now() / 1000
    const req = db.prepare('INSERT INTO requirements (id, text, kind, acceptance, source, status, created, updated) VALUES (?,?,?,?,?,?,?,?)')
    req.run('REQ-001', 'Range of 2 km line of sight', 'functional', 'at least 2 km at 1% packet loss', 'intent', 'accepted', t, t)
    req.run('REQ-002', 'Runs 2 years on 2 AA cells', 'electrical', 'at least 2 years', null, 'accepted', t, t)
    req.run('REQ-003', 'Survives rain', 'functional', null, 'intent', 'proposed', t, t)
    req.run('REQ-004', 'Has a display', 'functional', null, 'intent', 'rejected', t, t)
    const test = db.prepare('INSERT INTO test_items (id, title, requirements, method, status, created, updated) VALUES (?,?,?,?,?,?,?)')
    test.run('TST-001', 'Bench range test', '["REQ-001"]', 'hil', 'fail', t, t)
    test.run('TST-002', 'Current budget', '["REQ-002"]', 'spice', 'pass', t, t)
    const runRow = db.prepare('INSERT INTO runs (id, kind, subject, started, status, summary, result) VALUES (?,?,?,?,?,?,?)')
    runRow.run('run-erc', 'kicad.erc', 'hw/gaps.kicad_pro', t - 10, 'fail', 'ERC: 1 errors, 1 warnings', null)
    runRow.run('run-drc', 'kicad.drc', 'hw/gaps.kicad_pro', t - 5, 'fail', 'DRC: 1 errors', null)
    runRow.run('run-board', 'kicad.board', 'hw/gaps.kicad_pro', t - 4, 'pass', '12 footprints', JSON.stringify({ outline: { width_mm: 50, height_mm: 30 }, layers: ['F.Cu', 'B.Cu'], stackup_known: true }))
    runRow.run('run-render', 'render.board', 'hw/gaps.kicad_pcb', t - 3, 'pass', 'rendered', null)
    runRow.run('run-bom', 'kicad.bom', 'hw/gaps.kicad_pro', t - 2, 'pass', '12 parts', JSON.stringify({ missing_part_number: 0, lines_without_lcsc: 2 }))
    const art = db.prepare('INSERT INTO artifacts VALUES (?,?,?,?)')
    art.run('run-erc', 'erc-report.json', 'application/json', new TextEncoder().encode(ERC))
    art.run('run-drc', 'drc-report.json', 'application/json', new TextEncoder().encode(DRC))
    art.run('run-render', 'top.png', 'image/png', new Uint8Array([137, 80, 78, 71]))
    db.prepare("INSERT INTO settings (key, value, updated) VALUES ('hil.instruments', ?, ?)").run(JSON.stringify([{ name: 'bench-psu', kind: 'psu', address: 'tcp://10.0.0.5:5025', limits: { max_voltage_v: 5 } }]), t)
    setCriterion(db, 'define.accepted', 'met', [{ kind: 'run', ref: 'run-erc' }], 'trace')
    askQuestion(db, { askedBy: 'the Analog specialist', text: 'What is the supply range?', blocks: 'sizing the regulator', options: [{ id: 'a', label: '2.7 to 3.6 V', recommended: true, why: 'datasheet' }, { id: 'b', label: '1.8 to 3.6 V' }] })
  })
  seed('acme/empty', () => undefined)
  const text = (s: string): Uint8Array => new TextEncoder().encode(s)
  github.files.set(`${REPO}:main:hw/gaps.kicad_pro`, text('{}'))
  github.files.set(`${REPO}:main:hw/gaps.kicad_sch`, text('(kicad_sch)'))
  github.files.set(`${REPO}:main:hw/power.kicad_sch`, text('(kicad_sch)'))
  github.files.set(`${REPO}:main:hw/gaps.kicad_pcb`, text('(kicad_pcb)'))
  github.files.set(`${REPO}:main:README.md`, text('# Gaps'))
  github.history.set(`${REPO}:hw/gaps.kicad_pcb`, [
    { sha: 'c2c2c2c2c2c2c2c2', at: '2026-10-26T10:00:00Z', by: 'Priya', message: 'Move the antenna' },
    { sha: 'c1c1c1c1c1c1c1c1', at: '2026-10-20T10:00:00Z', by: 'trace', message: 'Place the parts' },
  ])
  server = await listen({ verifier: verifier(), deps, log: () => undefined }, 0, '127.0.0.1')
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/invocations`
})
afterAll(() => { server.close(); rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

describe('access to the new actions', () => {
  const outsider = accessToken(OUTSIDER.sub, OUTSIDER.groups)
  const reviewer = accessToken(REVIEWER.sub, REVIEWER.groups)
  const user = accessToken(USER.sub, USER.groups)
  const reads: [string, Record<string, unknown>][] = [
    ['requirements.trace', {}], ['design.get', {}], ['build.get', {}], ['cost.get', {}], ['skill.get', { skill: 'waiver' }],
    ['skill.draft', { skill: 'waiver', data: { reason: 'x' } }], ['skill.drafts', {}],
  ]
  const writes: [string, Record<string, unknown>][] = [['order.record', { number: 'Y1-0001', paid: 1 }], ['skill.submit', { skill: 'waiver', draft: {} }]]

  it('an unassigned project and one that does not exist get the same "no access", before GitHub is touched', async () => {
    for (const [action, args] of [...reads, ...writes]) {
      github.calls = []
      const a = await call(outsider, { action, repo: REPO, ...args })
      const b = await call(outsider, { action, repo: 'acme/does-not-exist', ...args })
      expect(a, action).toEqual({ status: 403, body: { ok: false, error: 'no access' } })
      expect(b, action).toEqual(a)
      expect(github.calls, action).toEqual([])
    }
    // a job of a project they are not on, and one that does not exist
    const j = await call(outsider, { action: 'job.control', id: JOB, op: 'cancel' })
    expect(j).toEqual({ status: 403, body: { ok: false, error: 'no access' } })
    expect(await call(outsider, { action: 'job.control', id: 'nope', op: 'cancel' })).toEqual(j)
  })

  it('writes need the contributor part; a reviewer reads and drafts only; policy and history are for admins', async () => {
    for (const [action, args] of writes) expect((await call(reviewer, { action, repo: REPO, ...args })).status, action).toBe(403)
    expect((await call(reviewer, { action: 'job.control', id: JOB, op: 'cancel' })).status).toBe(403)
    expect((await call(reviewer, { action: 'skill.get', repo: REPO, skill: 'waiver' })).status).toBe(200)
    expect((await call(user, { action: 'policy.set', key: 'display.theme', reason: 'Our brand is dark.' })).status).toBe(403)
    expect((await call(user, { action: 'users.history', who: REVIEWER.email })).status).toBe(403)
    expect(cancels).toEqual([])
  })
})

describe('job.control', () => {
  it('cancels a running job the index does not list (the job view says it can), and says plainly what it cannot do', async () => {
    // this installation's API cannot pause (no pause in its jobs), and the job is not in the project's index
    expect(await run(USER, 'job', { id: JOB })).toMatchObject({ id: JOB, state: 'running', controls: ['cancel'] })
    expect(await run(USER, 'job.control', { id: JOB, op: 'pause' })).toEqual({ ok: false, op: 'pause', repo: REPO, reason: expect.stringMatching(/can only be cancelled/) })
    expect(await run(USER, 'job.control', { id: JOB, op: 'move_up' })).toEqual({ ok: false, op: 'move_up', repo: REPO, reason: expect.stringMatching(/can only be cancelled/) })
    expect(await run(USER, 'job.control', { id: JOB, op: 'cancel' })).toEqual({ ok: true, op: 'cancel', repo: REPO, state: 'aborted', kept: expect.stringMatching(/already pushed/) })
    expect(cancels).toEqual([`cancelled by ${USER.email}`])
    expect(await run(USER, 'job', { id: JOB })).toMatchObject({ state: 'aborted', controls: [] })
    expect(await run(ADMIN, 'job.control', { id: JOB, op: 'cancel' })).toMatchObject({ ok: false, reason: 'The job has already aborted.' })
  })
})

describe('requirements.trace', () => {
  it('gives each live requirement its evidence status, counting a journey waiver, and says no intent is recorded yet', async () => {
    await journeyStore({ principal: ADMIN, deps }, REPO).update((db) => {
      db.prepare("INSERT INTO waivers (id, stage, gate, target_kind, target, reason, risk, severity, caught_where, scope, by, at, updated) VALUES ('w-rain', 'define', NULL, 'requirement', 'REQ-003', 'Rain proofing is the enclosure''s job.', 'Water ingress.', 'degraded', 'Bench', 'this revision only', 'seed', 1, 1)").run()
      return { result: null }
    })
    const r = await run(REVIEWER, 'requirements.trace', { repo: REPO }) as { intent: unknown[]; links: unknown[]; intent_note: string; requirements: { id: string; evidence: string; why: string }[]; summary: Record<string, number> }
    expect(r.intent).toEqual([])
    expect(r.links).toEqual([])
    expect(r.intent_note).toMatch(/No intent statements are recorded yet/)
    expect(r.requirements.map((q) => [q.id, q.evidence])).toEqual([['REQ-001', 'failing'], ['REQ-002', 'verified'], ['REQ-003', 'waived']])
    expect(r.requirements[0]?.why).toBe('TST-001 failed on its last run.')
    expect(r.summary).toEqual({ requirements: 3, verified: 1, failing: 1, untested: 0, waived: 1, intent: 0, accepted: 0, uncovered: 0, unlinked: 3 })
  })
})

describe('design.get', () => {
  it('lists the sheets and the board with the latest checks\' findings, the board picture a run stored, and says what is missing', async () => {
    const d = await run(USER, 'design.get', { repo: REPO }) as {
      sheets: { id: string; name: string; findings: { id: string; severity: string; x_mm?: number; sheet: string }[] }[]
      board: { file: string; path: string; size: string; layers: string[]; findings: { severity: string }[] }
      checks: { erc: { run: string } }; notes: string[]
    }
    expect(d.sheets.map((s) => [s.id, s.name, s.findings.map((f) => [f.severity, f.x_mm])])).toEqual([
      ['hw/gaps.kicad_sch', 'Gaps', [['blocks', 10]]], ['hw/power.kicad_sch', 'Power', [['fix', 30]]],
    ])
    expect(d.board).toMatchObject({ file: 'hw/gaps.kicad_pcb', path: 'runs/run-render/top.png', size: '50 × 30 mm', layers: ['F.Cu', 'B.Cu'], findings: [{ severity: 'blocks' }] })
    expect(d.checks.erc.run).toBe('run-erc')
    expect(d.notes.join(' ')).toMatch(/No architecture is recorded yet/)
    expect(d.notes.join(' ')).toMatch(/No pin plan is recorded yet/)
    expect(d.notes.join(' ')).toMatch(/kicad.export with sch_svg/)
  })
})

describe('orders, build and cost', () => {
  it('order.record stores the order in the journey, logs it, and answers a ship wait that says JLCPCB cannot be read', async () => {
    const o = await run(USER, 'order.record', { repo: REPO, order: 'next', number: 'Y12-4471058A', paid: 131.4, ship: '2026-11-04' }) as { created: boolean; order: Record<string, unknown>; wait: { what: string; text: string; nextCheckAt: null } }
    expect(o).toMatchObject({ ok: true, created: true, order: { number: 'Y12-4471058A', boards: 10, paid: 131.4, currency: 'USD', ship: '2026-11-04', state: 'placed' } })
    expect(o.wait).toMatchObject({ what: 'JLCPCB to ship order Y12-4471058A', nextCheckAt: null })
    expect(o.wait.text).toMatch(/order status only to partner companies.*record the carrier and tracking number/)
    // the same number again corrects it rather than adding another
    expect(await run(USER, 'order.record', { repo: REPO, number: 'Y12-4471058A', paid: 133, ship: '2026-11-05' })).toMatchObject({ created: false, order: { paid: 133 } })
    await expect(run(USER, 'order.record', { repo: REPO, number: 'Y12', ship: 'soon' })).rejects.toThrow(/2026-11-04/)
    const j = await run(USER, 'journey.get', { repo: REPO }) as { decisions: { kind: string; summary: string }[] }
    expect(j.decisions.slice(0, 2).map((x) => x.kind)).toEqual(['order.updated', 'order.placed'])
  })

  it('build.get lists the releases from the snapshots, the orders recorded, and what the record does not hold', async () => {
    await journeyStore({ principal: ADMIN, deps }, REPO).update((db) => {
      decide(db, { kind: 'journey.snapshot', stage: null, ref: 'abc1234def', by: ADMIN.email, summary: 'copied', detail: { branch: 'trace/release-a-1', commit: 'abc1234def', revision: 'A' } })
      return { result: null }
    })
    const b = await run(REVIEWER, 'build.get', { repo: REPO }) as { releases: Record<string, unknown>[]; orders: Record<string, unknown>[]; boards: unknown[]; notes: string[] }
    expect(b.releases).toEqual([expect.objectContaining({ revision: 'A', commit: 'abc1234def', by: ADMIN.email, frozen: true })])
    expect(b.orders).toEqual([expect.objectContaining({ number: 'Y12-4471058A', state: 'placed', total: 133, ship: '2026-11-05' })])
    expect(b.boards).toEqual([])
  })

  it('cost.get: the stage timeline for everyone, money for admins only, cloud use from the ledger with the reason', async () => {
    const a = await run(ADMIN, 'cost.get', { repo: REPO }) as { money: boolean; spent: { cloud: number; orders: number }; forecast: number; budget: number; stages: { stage: string; state: string; started: string | null }[]; lines: { kind: string; amount: number }[]; notes: string[] }
    expect(a).toMatchObject({ money: true, spent: { cloud: 0, orders: 133 }, forecast: 0, budget: 500 })
    expect(a.stages[0]).toMatchObject({ stage: 'Define', state: 'current', started: expect.any(String) })
    expect(a.lines).toEqual([expect.objectContaining({ kind: 'order', amount: 133 })])
    expect(a.notes.join(' ')).toMatch(/Cloud estimates .* are estimates/)
    const u = await run(USER, 'cost.get', { repo: REPO }) as Record<string, unknown>
    expect(u).toMatchObject({ money: false, spent: { cloud: null, orders: null }, committed: null, forecast: null, lines: [] })
    expect((u.stages as unknown[]).length).toBe(9)
  })
})

describe('guided skills', () => {
  it('the API checks every check of the twenty skills the app shows, and no other', () => {
    expect(SKILL_DEFS).toHaveLength(20)
    for (const s of SKILL_DEFS) for (const c of s.checks) if (c.id !== 'reasons') expect(CHECKS[`${s.id}/${c.id}`], `${s.id}/${c.id}`).toBeTypeOf('function')
    const known = new Set(SKILL_DEFS.flatMap((s) => s.checks.map((c) => `${s.id}/${c.id}`)))
    for (const k of Object.keys(CHECKS)) expect(known.has(k), k).toBe(true)
  })

  it('skill.get computes the bar from the record, and says what cannot be checked yet', async () => {
    const sch = await run(USER, 'skill.get', { repo: REPO, skill: 'schematic-finish' }) as { checks: { id: string; status: string; detail?: string; unavailable?: string }[]; findings: unknown[]; met: number; total: number }
    const by = Object.fromEntries(sch.checks.map((c) => [c.id, c]))
    expect(by.erc).toMatchObject({ status: 'not_met', detail: '1 error left: fix or waive each.' })
    expect(by.mpn).toMatchObject({ status: 'not_met', detail: '2 lines without an LCSC code.' })
    expect(by.notes).toMatchObject({ status: 'not_met', unavailable: expect.stringMatching(/draft notes/) })
    expect(by.reasons).toMatchObject({ status: 'met' })
    expect(sch.findings).toHaveLength(2)
    const req = await run(USER, 'skill.get', { repo: REPO, skill: 'requirements-review' }) as { checks: { id: string; status: string; detail?: string }[] }
    expect(req.checks.find((c) => c.id === 'criterion')).toMatchObject({ status: 'not_met', detail: expect.stringMatching(/REQ-003/) })
    expect(req.checks.find((c) => c.id === 'sources')).toMatchObject({ status: 'not_met', detail: '1 requirement without a source: REQ-002.' })
    const bench = await run(USER, 'skill.get', { repo: REPO, skill: 'bench-setup' }) as { checks: { id: string; status: string; detail?: string }[] }
    expect(bench.checks.find((c) => c.id === 'limits')).toMatchObject({ status: 'not_met', detail: 'bench-psu without both a voltage and a current limit.' })
    const gate = await run(USER, 'skill.get', { repo: REPO, skill: 'gate-signing' }) as { gate: string; checks: { id: string; status: string }[] }
    expect(gate.gate).toBe('define')
    expect(gate.checks.find((c) => c.id === 'admin')).toMatchObject({ status: 'not_met' })
    const q = await run(USER, 'skill.get', { repo: REPO, skill: 'question-answer' }) as { question: { text: string; recommended: { id: string } } }
    expect(q.question).toMatchObject({ text: 'What is the supply range?', recommended: { id: 'a' } })
  })

  it('a draft is kept per person in the journey store, and reviewers may draft', async () => {
    expect(await run(REVIEWER, 'skill.draft', { repo: REPO, skill: 'waiver', step: 2, data: { reason: 'mine' } })).toMatchObject({ kept: true })
    expect(await run(USER, 'skill.draft', { repo: REPO, skill: 'waiver', step: 1, data: { what: 'requirement:REQ-001' } })).toMatchObject({ kept: true })
    expect(await run(REVIEWER, 'skill.get', { repo: REPO, skill: 'waiver' })).toMatchObject({ step: 2, draft: { reason: 'mine' } })
    expect(await run(USER, 'skill.get', { repo: REPO, skill: 'waiver' })).toMatchObject({ step: 1, draft: { what: 'requirement:REQ-001' } })
    expect(await run(USER, 'skill.drafts', { repo: REPO })).toMatchObject({ drafts: [{ skill: 'waiver', name: 'Waiver', step: 1, steps: 5 }] })
    expect(await run(USER, 'me.get')).not.toHaveProperty('preferences.drafts')
  })

  it('skill.submit refuses what the bar does not pass, and takes the waiver through waiver.add when it does', async () => {
    await expect(run(USER, 'skill.submit', { repo: REPO, skill: 'waiver', draft: { what: 'requirement:REQ-001', reason: 'not needed' } })).rejects.toThrow(/cannot be submitted yet\. Not met: Reason given/)
    await expect(run(USER, 'skill.submit', { repo: REPO, skill: 'intent-builder', draft: {} })).rejects.toThrow(/Intent builder cannot be submitted yet\. Not met: Every topic answered or marked \(No intent statements are recorded yet/)
    const draft = { what: 'requirement:REQ-001', reason: 'The range is tested at the field trial.', risk: 'A short range in the field.', severity: 'degraded', caught: 'later', where: 'Bring up', scope: 'revision' }
    const r = await run(USER, 'skill.submit', { repo: REPO, skill: 'waiver', draft }) as { ok: boolean; ref: string }
    expect(r).toMatchObject({ ok: true, skill: 'waiver', ref: expect.any(String) })
    const t = await run(USER, 'requirements.trace', { repo: REPO }) as { requirements: { id: string; evidence: string }[] }
    expect(t.requirements.find((q) => q.id === 'REQ-001')?.evidence).toBe('waived')
    // the draft is gone; the decision is logged
    expect(await run(USER, 'skill.drafts', { repo: REPO })).toMatchObject({ drafts: [] })
    const j = await run(USER, 'journey.get', { repo: REPO }) as { decisions: { kind: string }[] }
    expect(j.decisions.slice(0, 2).map((d) => d.kind)).toEqual(['skill.submitted', 'waiver.added'])
  })

  it('Question answer submits through question.answer', async () => {
    expect(await run(USER, 'skill.submit', { repo: REPO, skill: 'question-answer', draft: { option: 'a', lasts: 'once' } })).toMatchObject({ ok: true })
    const j = await run(USER, 'journey.get', { repo: REPO }) as { questions: { answered: { answer: string } | null }[] }
    expect(j.questions[0]?.answered?.answer).toBe('2.7 to 3.6 V')
  })
})

describe('policy, locks, people', () => {
  it('an admin locks a setting; me.get answers the locks and me.set refuses the locked key with the reason', async () => {
    expect(await run(ADMIN, 'policy.set', { key: 'display.theme', reason: 'Our screens are calibrated for the light theme.' })).toMatchObject({ changed: true, locks: { 'display.theme': expect.any(String) } })
    expect(await run(USER, 'me.get')).toMatchObject({ locks: { 'display.theme': 'Our screens are calibrated for the light theme.' } })
    await expect(run(USER, 'me.set', { key: 'prefs.display.theme', value: 'dark' })).rejects.toThrow('An admin has fixed display.theme for everyone: Our screens are calibrated for the light theme.')
    await expect(run(USER, 'me.set', { key: 'prefs.display', value: { theme: 'dark' } })).rejects.toThrow(/fixed display.theme/)
    expect(await run(USER, 'me.set', { key: 'prefs.display.density', value: 'compact' })).toMatchObject({ changed: true })
    expect(await run(ADMIN, 'policy.set', { key: 'display.theme', reason: null })).toMatchObject({ changed: true, locks: {} })
    expect(await run(USER, 'me.set', { key: 'prefs.display.theme', value: 'dark' })).toMatchObject({ changed: true })
  })

  it('users.list carries last seen and Cognito\'s name; users.history reads the assignment log in words', async () => {
    const users = await run(ADMIN, 'users.list') as { email: string; last_seen: string | null; name?: string }[]
    expect(users.find((u) => u.email === USER.email)?.last_seen).toEqual(expect.any(String))
    expect(users.find((u) => u.email === NEWCOMER.email)?.last_seen).toBeNull()
    expect(users.find((u) => u.email === ADMIN.email)?.name).toBe('Grace Admin')
    const h = await run(ADMIN, 'users.history', { who: REVIEWER.email }) as { entries: { action: string; repo: string | null; text: string }[] }
    expect(h.entries.map((e) => e.text)).toEqual([`${ADMIN.email} made them a user.`, `${ADMIN.email} added them to ${REPO} as a reviewer.`])
    await expect(run(ADMIN, 'users.history', { who: 'nobody@example.com' })).rejects.toThrow(/no such person/)
  })
})

describe('files', () => {
  it('files.list rows carry the revision, the release they are frozen in, the history and the findings', async () => {
    github.files.set(`${REPO}:abc1234def:hw/gaps.kicad_sch`, github.files.get(`${REPO}:main:hw/gaps.kicad_sch`) as Uint8Array)
    const r = await run(USER, 'files.list', { repo: REPO }) as { files: { path: string; revision?: string; release?: string; frozen?: boolean; commit?: string; versions?: unknown[]; findings?: { id: string; x_mm: number; sheet?: string }[] }[] }
    const by = new Map(r.files.map((f) => [f.path, f]))
    expect(by.get('hw/gaps.kicad_sch')).toMatchObject({ revision: 'A', release: 'A', frozen: true, findings: [{ x_mm: 10, sheet: '/' }] })
    expect(by.get('hw/power.kicad_sch')).toMatchObject({ findings: [{ x_mm: 30, sheet: '/Power/' }] })
    expect(by.get('hw/power.kicad_sch')).not.toHaveProperty('frozen')
    expect(by.get('hw/gaps.kicad_pcb')).toMatchObject({ commit: 'c2c2c2c2c2c2c2c2', at: '2026-10-26T10:00:00Z', versions: [{ commit: 'c2c2c2c2c2c2c2c2', by: 'Priya' }, { commit: 'c1c1c1c1c1c1c1c1' }], findings: [{ x_mm: 5 }] })
  })

  it('files.url reads an earlier commit, and refuses "." and ".." segments before anything else', async () => {
    github.files.set(`${REPO}:c1c1c1c1c1c1c1c1:hw/gaps.kicad_pcb`, new TextEncoder().encode('(old)'))
    expect(await run(USER, 'files.url', { repo: REPO, path: 'hw/gaps.kicad_pcb', commit: 'c1c1c1c1c1c1c1c1' })).toMatchObject({ commit: 'c1c1c1c1c1c1c1c1', base64: Buffer.from('(old)').toString('base64') })
    for (const path of ['.trace/./project.db', './README.md', 'hw/../.trace/project.db', 'a//b', 'hw\\x']) await expect(run(USER, 'files.url', { repo: REPO, path }), path).rejects.toThrow(/a path inside the repository/)
    await expect(run(USER, 'files.url', { repo: REPO, path: 'README.md', commit: 'main' })).rejects.toThrow(/commit sha/)
  })
})

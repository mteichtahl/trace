/** The web app's actions: parts, the journey, inbox, chats, preferences, graph, files and creating a project. */
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentMemory, type ProjectMemories, type SendClient } from '../../src/agents/runtime/memory.js'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { bucketStore, journeyStore } from '../../src/api/action-kit.js'
import { kindOf } from '../../src/api/actions-files.js'
import { neighbourhood, type GraphLink, type GraphNode } from '../../src/api/actions-graph.js'
import { listen } from '../../src/api/server.js'
import { AccessDenied, assign, standing } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { askQuestion, setCriterion, startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import '../../src/tools/verify/db.js'
import { FakeCognito, FakeGitHub, accessToken, verifier } from './fixtures.js'

const ADMIN = { sub: 'w-admin', email: 'w-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'w-user', email: 'w-user@example.com', groups: ['trace-users'] }
const REVIEWER = { sub: 'w-rev', email: 'w-rev@example.com', groups: ['trace-users'] }
const GUEST = { sub: 'w-guest', email: 'w-guest@example.com', groups: ['trace-guests'] }
const OUTSIDER = { sub: 'w-out', email: 'w-out@example.com', groups: ['trace-users'] }

const github = new FakeGitHub(['acme/web', 'acme/other', 'acme/secret', 'acme/fresh'])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-web-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-bucket-'))
const onboarded: { repo: string; create: unknown }[] = []

const memClient: SendClient = {
  send: async (cmd) => {
    const ns = 'namespace' in cmd.input ? cmd.input.namespace ?? '' : ''
    const all = [
      { ns: '/trace/acme/web/verify/facts/', text: 'REQ-001 range was checked at 2 km.' },
      { ns: '/trace/acme/web/person/0000000000000000/preferences/', text: 'Someone else prefers long answers.' },
    ]
    return { memoryRecordSummaries: all.filter((r) => r.ns.startsWith(ns)).map((r, i) => ({ memoryRecordId: `mem-${i}`, content: { text: r.text }, namespaces: [r.ns], createdAt: new Date(0), score: 0.9 })) }
  },
}
const memories: ProjectMemories = { forProject: (repo) => (repo.toLowerCase() === 'acme/web' ? new AgentMemory('trace_m_0000aaaa-abcdefghij', memClient) : null) }

const deps: ActionDeps = {
  github: async () => github,
  cognito: () => cognito,
  jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  tools: () => new Registry([]),
  scratch,
  memory: () => memories,
  store: (prefix) => backendFor(join(bucket, prefix)),
  onboard: async (repo, o) => {
    onboarded.push({ repo, create: o.create })
    if (!o.create) await github.createBranch(repo, 'trace/onboard', 'sha-main')
    return { repo, state: o.create ? 'created' : 'opened', pr: o.create ? null : `https://github.com/${repo}/pull/1`, settings: o.apply ? ['allowed auto-merge'] : [], notes: [] }
  },
}
const ctx = (principal: Context['principal']): Context => ({ principal, deps })
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<unknown> => (await perform(action, args, ctx(who))).result

/** Put a project database with a journey (and a requirement, a test, a run) on the default branch of `repo`. */
function seedProject(repo: string, fn: (db: DatabaseSync) => void = () => undefined): void {
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
  for (const p of [ADMIN, USER, REVIEWER, GUEST, OUTSIDER]) cognito.add(p.email, p.sub, p.groups[0])
  await assign(ADMIN, USER, 'acme/web', { class: 'user' })
  await assign(ADMIN, REVIEWER, 'acme/web', { part: 'reviewer', class: 'user' })
  await assign(ADMIN, GUEST, 'acme/web', { class: 'guest' })
  await assign(ADMIN, USER, 'acme/other', { class: 'user' })
  seedProject('acme/web', (db) => {
    startJourney(db, { template: 'board', by: 'seed', name: 'Soil sensor' })
    const t = Date.now() / 1000
    db.prepare("INSERT INTO requirements (id, text, kind, status, created, updated) VALUES ('REQ-001', 'Range of 2 km line of sight', 'functional', 'accepted', ?, ?)").run(t, t)
    db.prepare("INSERT INTO test_items (id, title, requirements, method, created, updated) VALUES ('TST-001', 'Bench range test', '[\"REQ-001\"]', 'hil', ?, ?)").run(t, t)
    db.prepare("INSERT INTO runs (id, kind, subject, started, status, summary) VALUES ('run-1', 'verify.run', 'TST-001', ?, 'fail', 'range 1.4 km')").run(t)
    db.prepare("INSERT INTO runs (id, kind, subject, started, status, summary) VALUES ('run-0', 'hil.scope_capture', 'antenna', ?, 'pass', 'captured')").run(t)
    db.prepare("INSERT INTO test_results (run_id, test_id, status, evidence, at) VALUES ('run-1', 'TST-001', 'fail', '[\"run-0\"]', ?)").run(t)
    db.prepare("INSERT INTO artifacts VALUES ('run-0', 'capture.csv', 'text/csv', ?)").run(new TextEncoder().encode('t,v\n0,1\n'))
    setCriterion(db, 'define.accepted', 'met', [{ kind: 'run', ref: 'run-1' }], 'trace')
    setCriterion(db, 'define.measurable', 'met', [{ kind: 'record', ref: 'requirements' }], 'trace')
    askQuestion(db, { askedBy: 'the Analog specialist', text: 'What is the supply range?', blocks: 'sizing the regulator', options: [{ id: 'a', label: '2.7 to 3.6 V', recommended: true, why: 'datasheet' }, { id: 'b', label: '1.8 to 3.6 V' }] })
  })
  seedProject('acme/other')
  github.files.set('acme/web:main:hw/board.kicad_sch', new TextEncoder().encode('(kicad_sch)'))
  github.files.set('acme/web:main:hw/board.kicad_pcb', new TextEncoder().encode('(kicad_pcb)'))
  github.files.set('acme/web:main:fab/gerbers.zip', new Uint8Array([1, 2, 3]))
  github.files.set('acme/web:main:fw/src/main.c', new TextEncoder().encode('int main(){}'))
  github.files.set('acme/web:main:docs/spec.pdf', new Uint8Array([37, 80, 68, 70]))
  github.files.set('acme/web:main:node_modules/x/index.js', new Uint8Array([1]))
  github.files.set('acme/web:main:big/render.mp4', new Uint8Array([0]))
  github.sizes.set('acme/web:main:big/render.mp4', 50 * 1024 * 1024)
  server = await listen({ verifier: verifier(), deps, log: () => undefined }, 0, '127.0.0.1')
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/invocations`
})
afterAll(() => { server.close(); rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

describe('access to the new actions', () => {
  const outsider = accessToken('w-out', ['trace-users'])
  const nobody = accessToken('w-nobody', [])
  const repoActions: [string, Record<string, unknown>][] = [
    ['project.members', {}], ['journey.get', {}], ['journey.criterion.open', { criterion: 'define.accepted' }], ['gate.return', { gate: 'define', reason: 'something to change' }],
    ['question.answer', { question: 'x', option: 'a' }], ['waiver.add', { target: { kind: 'criterion', id: 'define.accepted' }, reason: 'r', risk: 'r', severity: 'cosmetic', caught_where: null }],
    ['chats.list', {}], ['chats.get', { thread: 'abcdefgh' }], ['chats.append', { messages: [{ text: 'hi' }] }], ['chats.rename', { thread: 'abcdefgh', title: 't' }], ['chats.recall', {}],
    ['graph.neighbourhood', { focus: 'requirement:REQ-001' }], ['files.list', {}], ['files.url', { path: 'README.md' }],
  ]

  it('an unassigned project and one that does not exist get the same "no access", before GitHub is touched', async () => {
    for (const [action, args] of repoActions) {
      github.calls = []
      const a = await call(outsider, { action, repo: 'acme/web', ...args })
      const b = await call(outsider, { action, repo: 'acme/does-not-exist', ...args })
      expect(a, action).toEqual({ status: 403, body: { ok: false, error: 'no access' } })
      expect(b, action).toEqual(a)
      expect((await call(nobody, { action, repo: 'acme/web', ...args })).status).toBe(403)
      expect(github.calls).toEqual([])
    }
  })

  it('writes need the contributor part; signing needs an admin; creating a project needs an admin', async () => {
    const reviewer = accessToken('w-rev', ['trace-users'])
    const user = accessToken('w-user', ['trace-users'])
    for (const [action, args] of [
      ['gate.return', { gate: 'define', reason: 'something to change' }], ['question.answer', { question: 'x', option: 'a' }],
      ['waiver.add', { target: { kind: 'criterion', id: 'define.accepted' }, reason: 'rrrrrrrrrrr', risk: 'rrrrrr', severity: 'cosmetic', caught_where: null }],
    ] as const) {
      expect((await call(reviewer, { action, repo: 'acme/web', ...args })).status, action).toBe(403)
    }
    expect((await call(user, { action: 'gate.sign', repo: 'acme/web', gate: 'define' })).status).toBe(403)
    expect((await call(user, { action: 'projects.create', repo: 'acme/fresh', name: 'x', template: 'board' })).status).toBe(403)
    expect(onboarded).toEqual([])
  })
})

describe('parts through the API', () => {
  it('projects answers role and part; users.list shows each person\'s parts; a guest cannot be a contributor', async () => {
    expect(await run(REVIEWER, 'projects')).toEqual([{ repo: 'acme/web', role: 'read', part: 'reviewer' }])
    expect(await standing(REVIEWER, 'acme/web')).toEqual({ role: 'read', part: 'reviewer' })
    await expect(run(ADMIN, 'assign', { who: GUEST.email, repo: 'acme/web', part: 'contributor' })).rejects.toThrow(/A guest can only be a reviewer/)
    expect(await run(ADMIN, 'assign', { who: REVIEWER.email, repo: 'acme/other', part: 'reviewer' })).toMatchObject({ part: 'reviewer' })
    const users = await run(ADMIN, 'users.list') as { email: string; parts: { repo: string; part: string }[] }[]
    expect(users.find((u) => u.email === REVIEWER.email)?.parts).toEqual([{ repo: 'acme/other', part: 'reviewer' }, { repo: 'acme/web', part: 'reviewer' }])
    expect(users.find((u) => u.email === GUEST.email)?.parts).toEqual([{ repo: 'acme/web', part: 'reviewer' }])
  })

  it('project.members lists the people with their parts, admins first and marked', async () => {
    const r = await run(GUEST, 'project.members', { repo: 'acme/web' }) as { members: { email: string; part: string; admin: boolean; can_sign: boolean }[] }
    expect(r.members[0]).toMatchObject({ email: ADMIN.email, admin: true, can_sign: true, part: 'contributor' })
    expect(r.members.slice(1).map((m) => [m.email, m.part])).toEqual([[GUEST.email, 'reviewer'], [REVIEWER.email, 'reviewer'], [USER.email, 'contributor']])
  })
})

describe('the journey through the API', () => {
  it('journey.get: a project with no journey says how one starts', async () => {
    expect(await run(USER, 'journey.get', { repo: 'acme/other' })).toMatchObject({ started: false, next: expect.stringMatching(/choosing a template/) })
  })

  it('journey.get answers the stages, the next step for this person, and the question', async () => {
    const r = await run(USER, 'journey.get', { repo: 'acme/web' }) as { started: boolean; you: unknown; current_stage: string; next: { kind: string; button: string }; questions: { for_you: boolean }[] }
    expect(r).toMatchObject({ started: true, you: { admin: false, part: 'contributor' }, current_stage: 'define', template_name: 'Board' })
    expect(r.next).toMatchObject({ kind: 'answer', button: 'Use 2.7 to 3.6 V' })
    const rev = await run(REVIEWER, 'journey.get', { repo: 'acme/web' }) as { next: { yours: boolean }; questions: { for_you: boolean }[] }
    expect(rev.next.yours).toBe(false)
    expect(rev.questions[0]?.for_you).toBe(false)
  })

  it('imported the journey an older install kept in the repository, once, into the central bucket', () => {
    expect(readFileSync(join(bucket, 'projects', 'acme', 'web', 'journey', 'journey.db')).length).toBeGreaterThan(0)
  })

  it('opening evidence, answering, signing: each a new version in the bucket, nothing written to GitHub', async () => {
    github.calls = []
    const opened = await run(ADMIN, 'journey.criterion.open', { repo: 'acme/web', criterion: 'define.accepted' }) as { version: number }
    expect(opened).toMatchObject({ opened: 'define.accepted', version: expect.any(Number) })
    expect(opened).not.toHaveProperty('commit')
    // opening it again changes nothing: the same version
    expect(await run(ADMIN, 'journey.criterion.open', { repo: 'acme/web', criterion: 'define.accepted' })).toMatchObject({ version: opened.version })
    // a reviewer may open evidence too
    expect(await run(REVIEWER, 'journey.criterion.open', { repo: 'acme/web', criterion: 'define.accepted' })).toMatchObject({ version: opened.version + 1 })
    await expect(run(ADMIN, 'gate.sign', { repo: 'acme/web', gate: 'define' })).rejects.toThrow(/Open the evidence for 1 more criterion/)
    await run(ADMIN, 'journey.criterion.open', { repo: 'acme/web', criterion: 'define.measurable' })
    const q = (await run(USER, 'journey.get', { repo: 'acme/web' }) as { questions: { id: string }[] }).questions[0]?.id
    await expect(run(USER, 'question.answer', { repo: 'acme/web', question: q, option: 'b' })).rejects.toThrow(/why you chose otherwise/)
    expect(await run(USER, 'question.answer', { repo: 'acme/web', question: q, option: 'a' })).toMatchObject({ question: { answered: { answer: '2.7 to 3.6 V', by: USER.email } } })
    const signed = await run(ADMIN, 'gate.sign', { repo: 'acme/web', gate: 'define', notes: 'Looks right.' }) as { advanced_to: string; summary: string }
    expect(signed).toMatchObject({ advanced_to: 'architect', summary: 'Gate signed. Architect started.', released: false, snapshot: null })
    expect(github.calls.filter((c) => c.startsWith('putFile') || c.startsWith('createBranch'))).toEqual([])
    const r = await run(GUEST, 'journey.get', { repo: 'acme/web' }) as { current_stage: string; decisions: { kind: string; by: string }[] }
    expect(r.current_stage).toBe('architect')
    expect(r.decisions.slice(0, 2).map((d) => [d.kind, d.by])).toEqual([['gate.signed', ADMIN.email], ['question.answered', USER.email]])
  })

  it('waiver.add and gate.return by a contributor', async () => {
    const w = await run(USER, 'waiver.add', { repo: 'acme/web', target: { kind: 'criterion', id: 'architect.stock' }, reason: 'The part is on order with a date.', risk: 'A late build.', severity: 'degraded', caught_where: 'Sign-off' }) as { waiver: { id: string; scope: string } }
    expect(w.waiver.scope).toBe('this revision only')
    await expect(run(USER, 'waiver.add', { repo: 'acme/web', target: { kind: 'criterion', id: 'architect.mapped' }, reason: 'not needed', risk: 'x', severity: 'safety', caught_where: null })).rejects.toThrow(/not needed/)
    expect(await run(USER, 'gate.return', { repo: 'acme/web', gate: 'architect', reason: 'Two requirements map to no block.' })).toMatchObject({ gate: { returned: { reason: 'Two requirements map to no block.' } } })
  })
})

describe('inbox', () => {
  it('aggregates the person\'s projects from the bucket, without asking GitHub', async () => {
    await journeyStore({ principal: ADMIN, deps }, 'acme/other').update((db) => {
      startJourney(db, { template: 'firmware', by: 'seed', name: 'Motor driver' })
      askQuestion(db, { askedBy: 'the Firmware specialist', kind: 'stuck', text: 'The build needs a linker script.' })
      return { result: null }
    })
    github.calls = []
    const r = await run(USER, 'inbox') as { summary: string; items: { kind: string; repo: string }[]; unavailable: unknown[] }
    expect(r.items).toEqual([expect.objectContaining({ kind: 'stuck', repo: 'acme/other' })])
    expect(r.summary).toBe('1 thing needs you.')
    expect(github.calls).toEqual([])
    expect(await run(GUEST, 'inbox')).toMatchObject({ items: [], summary: 'Nothing needs you. trace will tell you when something does.' })
    await expect(run({ sub: 'x', email: null, groups: [] }, 'inbox')).rejects.toThrow(AccessDenied)
  })
})

describe('chats', () => {
  it('are shared on the project, recalled per person, and kept in the central bucket', async () => {
    const a = await run(USER, 'chats.append', { repo: 'acme/web', messages: [{ text: 'Why this regulator?' }, { role: 'assistant', text: 'It carries 1 A.' }] }) as { thread: { id: string; title: string } }
    expect(a.thread.title).toBe('Why this regulator?')
    // a reviewer sees it and may add to it
    expect((await run(REVIEWER, 'chats.list', { repo: 'acme/web' }) as { threads: unknown[] }).threads).toHaveLength(1)
    await run(REVIEWER, 'chats.append', { repo: 'acme/web', thread: a.thread.id, messages: [{ text: 'And the heat?' }] })
    expect((await run(GUEST, 'chats.get', { repo: 'acme/web', thread: a.thread.id }) as { messages: { text: string }[] }).messages.map((m) => m.text)).toEqual(['Why this regulator?', 'It carries 1 A.', 'And the heat?'])
    expect((await run(USER, 'chats.recall', { repo: 'acme/web' }) as { messages: { text: string }[] }).messages.map((m) => m.text)).toEqual(['Why this regulator?'])
    expect(await run(USER, 'chats.rename', { repo: 'acme/web', thread: a.thread.id, title: 'Regulator' })).toMatchObject({ thread: { title: 'Regulator' } })
    await expect(run(USER, 'chats.get', { repo: 'acme/web', thread: 'abcdefgh0000' })).rejects.toThrow(/no conversation/)
    // another project's threads are its own
    expect((await run(USER, 'chats.list', { repo: 'acme/other' }) as { threads: unknown[] }).threads).toEqual([])
    expect(JSON.parse(readFileSync(join(bucket, 'projects', 'acme', 'web', 'chats', 'index.json'), 'utf8'))).toMatchObject({ threads: [{ id: a.thread.id }] })
  })
})

describe('me', () => {
  it('reads and changes only the asker\'s own preferences', async () => {
    expect(await run(GUEST, 'me.set', { key: 'views.requirements', value: { columns: ['id', 'text'], sort: 'id' } })).toMatchObject({ changed: true })
    expect(await run(GUEST, 'me.get', { key: 'views.requirements' })).toMatchObject({ value: { columns: ['id', 'text'], sort: 'id' } })
    expect((await run(USER, 'me.get') as { preferences: object }).preferences).toEqual({})
    await expect(run(GUEST, 'me.set', { key: 'x', value: 'y'.repeat(70_000) })).rejects.toThrow(/at most 64 KB/)
    await expect(run({ sub: 'x', email: null, groups: [] }, 'me.get')).rejects.toThrow(AccessDenied)
  })
})

describe('graph.neighbourhood', () => {
  it('draws the record around a focus in the app\'s vocabulary, with memories this person may see', async () => {
    const r = await run(GUEST, 'graph.neighbourhood', { repo: 'acme/web', focus: 'requirement:REQ-001', depth: 2, memory: true }) as { nodes: { id: string; kind: string; status?: string; to?: string; distance: number }[]; links: { id: string; source: string; target: string; kind: string }[] }
    const ids = r.nodes.map((n) => n.id)
    expect(ids[0]).toBe('requirement:REQ-001')
    expect(ids).toEqual(expect.arrayContaining(['test:TST-001', 'run:run-1', 'run:run-0', 'gate:define', 'memory:mem-0']))
    expect(ids).not.toContain('memory:mem-1')
    // the test item (still planned) serves the requirement; its failed run fails it; the run rests on the capture; the gate cites the run
    expect(r.links.map(({ source, target, kind }) => ({ source, target, kind }))).toEqual(expect.arrayContaining([
      { source: 'test:TST-001', target: 'requirement:REQ-001', kind: 'serves' }, { source: 'run:run-1', target: 'requirement:REQ-001', kind: 'fails' },
      { source: 'run:run-1', target: 'run:run-0', kind: 'uses' }, { source: 'gate:define', target: 'run:run-1', kind: 'cites' },
      { source: 'memory:mem-0', target: 'requirement:REQ-001', kind: 'related' },
    ]))
    const byId = new Map(r.nodes.map((n) => [n.id, n]))
    expect(byId.get('requirement:REQ-001')).toMatchObject({ kind: 'requirement', status: 'untested', to: '/p/acme~web/requirements/REQ-001' })
    expect(byId.get('test:TST-001')).toMatchObject({ kind: 'run' })
    expect(byId.get('gate:define')).toMatchObject({ kind: 'decision' })
    const one = await run(GUEST, 'graph.neighbourhood', { repo: 'acme/web', focus: 'REQ-001', depth: 1 }) as { focus: string; nodes: { id: string }[] }
    expect(one.focus).toBe('requirement:REQ-001')
    expect(one.nodes.map((n) => n.id).sort()).toEqual(['requirement:REQ-001', 'run:run-1', 'test:TST-001'])
    await expect(run(GUEST, 'graph.neighbourhood', { repo: 'acme/web', focus: 'requirement:NOPE' })).rejects.toThrow(/Nothing called/)
  })

  it('caps at 150 nodes, gathering the rest into groups by kind', () => {
    const nodes = new Map<string, GraphNode>([['requirement:R', { id: 'requirement:R', kind: 'requirement', label: 'R' }]])
    const links: GraphLink[] = []
    for (let i = 0; i < 400; i++) {
      nodes.set(`run:${i}`, { id: `run:${i}`, kind: 'run', label: String(i) })
      links.push({ id: `l${i}`, source: `run:${i}`, target: 'requirement:R', kind: 'proves' })
    }
    const n = neighbourhood({ nodes, links }, 'requirement:R', 2)
    expect(n.nodes.length).toBe(150)
    expect(n.groups).toEqual([expect.objectContaining({ id: 'group:run', kind: 'run', parent: 'requirement:R', count: 251, label: '+251 more runs' })])
  })
})

describe('files', () => {
  it('lists the repository by kind, with run evidence, and leaves machinery out', async () => {
    const r = await run(GUEST, 'files.list', { repo: 'acme/web' }) as { groups: { kind: string; files: { path: string }[] }[]; counts: Record<string, number> }
    const by = Object.fromEntries(r.groups.map((g) => [g.kind, g.files.map((f) => f.path)]))
    expect(by.design).toEqual(['hw/board.kicad_pcb', 'hw/board.kicad_sch'])
    expect(by.fabrication).toEqual(['fab/gerbers.zip'])
    expect(by.firmware).toEqual(['fw/src/main.c'])
    expect(by.documents).toEqual(['docs/spec.pdf'])
    expect(by.evidence).toEqual(['runs/run-0/capture.csv'])
    expect(JSON.stringify(r)).not.toContain('node_modules')
    expect(JSON.stringify(r)).not.toContain('project.db')
    expect(kindOf('out/board-top-pos.csv')).toBe('fabrication')
  })

  it('files.url: bytes up to 8 MB, GitHub\'s link above, and evidence from the record', async () => {
    expect(await run(GUEST, 'files.url', { repo: 'acme/web', path: 'hw/board.kicad_sch' })).toMatchObject({ kind: 'design', base64: Buffer.from('(kicad_sch)').toString('base64') })
    expect(await run(GUEST, 'files.url', { repo: 'acme/web', path: 'big/render.mp4' })).toMatchObject({ url: expect.stringMatching(/^https:\/\/raw\.githubusercontent\.com\//), size: 50 * 1024 * 1024 })
    expect(await run(GUEST, 'files.url', { repo: 'acme/web', path: 'runs/run-0/capture.csv' })).toMatchObject({ kind: 'evidence', mime: 'text/csv', base64: Buffer.from('t,v\n0,1\n').toString('base64') })
    await expect(run(GUEST, 'files.url', { repo: 'acme/web', path: '../etc/passwd' })).rejects.toThrow()
    await expect(run(GUEST, 'files.url', { repo: 'acme/web', path: '.trace/project.db' })).rejects.toThrow(/no file/)
    await expect(run(GUEST, 'files.url', { repo: 'acme/web', path: 'nope.txt' })).rejects.toThrow(/no file/)
  })
})

describe('projects.create', () => {
  it('onboards, registers, assigns with parts, starts the journey in the bucket, and waits for the installation', async () => {
    const r = await run(ADMIN, 'projects.create', {
      repo: 'Acme/Fresh', name: 'Fresh board', template: 'mixed', later: ['certify'],
      people: [{ who: USER.email, part: 'reviewer' }, { who: GUEST.email, part: 'contributor' }, { who: 'new-person@example.com' }, { who: ADMIN.email }],
      build: { quantity: 25 },
    }) as { ok: boolean; steps: { id: string; state: string; detail: string }[]; people: { who: string; part: string | null; error: string | null; invited: boolean }[]; waits: { text: string }[]; journey: { template: string; build: { quantity: number } } }
    expect(onboarded.at(-1)).toEqual({ repo: 'acme/fresh', create: null })
    expect(r.steps.map((s) => [s.id, s.state])).toEqual([['repository', 'done'], ['registry', 'done'], ['people', 'failed'], ['journey', 'done'], ['cloud', 'waiting']])
    expect(r.people).toEqual([
      { who: USER.email, sub: USER.sub, part: 'reviewer', invited: false, error: null },
      { who: GUEST.email, sub: null, part: null, invited: false, error: expect.stringMatching(/A guest can only be a reviewer/) },
      { who: 'new-person@example.com', sub: 'sub-new-person@example.com', part: 'contributor', invited: true, error: null },
      { who: ADMIN.email, sub: ADMIN.sub, part: 'contributor', invited: false, error: null },
    ])
    expect(r.waits[0]?.text).toBe('The project\'s agent and knowledge base are added at the next update of the installation.')
    expect(r.journey).toMatchObject({ template: 'mixed', build: { quantity: 25 } })
    expect(r.steps.find((s) => s.id === 'journey')?.detail).toBe('Started from the Mixed template at Define.')
    expect(github.files.has('acme/fresh:trace/onboard:.trace/project.db')).toBe(false)
    expect(readFileSync(join(bucket, 'projects', 'acme', 'fresh', 'journey', 'journey.db')).length).toBeGreaterThan(0)
    expect(await standing(USER, 'acme/fresh')).toEqual({ role: 'read', part: 'reviewer' })
    const pending = JSON.parse(readFileSync(join(bucket, 'installation', 'pending-projects', 'acme', 'fresh.json'), 'utf8')) as { repo: string; requested_by: string }
    expect(pending).toMatchObject({ repo: 'acme/fresh', requested_by: ADMIN.email })
    // safe to send again: the journey is kept, not restarted
    const again = await run(ADMIN, 'projects.create', { repo: 'acme/fresh', name: 'Fresh board', template: 'board' }) as { steps: { id: string; state: string; detail: string }[] }
    expect(again.steps.find((s) => s.id === 'journey')).toMatchObject({ state: 'skipped', detail: expect.stringMatching(/already has a journey/) })
  })

  it('stops the dependent steps when onboarding fails', async () => {
    const failing: ActionDeps = { ...deps, onboard: async () => { throw new Error('git: not found (install git)') } }
    const r = (await perform('projects.create', { repo: 'acme/secret', name: 'S', template: 'board' }, { principal: ADMIN, deps: failing })).result as { ok: boolean; steps: { state: string }[] }
    expect(r.ok).toBe(false)
    expect(r.steps.map((s) => s.state)).toEqual(['failed', 'skipped', 'skipped', 'skipped', 'skipped'])
  })
})

describe('the central bucket beside TRACE_HOME', () => {
  it('maps a prefix next to the central store', () => {
    expect(bucketStore('projects', 's3://b/central').url).toBe('s3://b/projects')
    expect(bucketStore('installation', 's3://b/x/central').url).toBe('s3://b/x/installation')
    const d = mkdtempSync(join(tmpdir(), 'trace-bs-'))
    writeFileSync(join(d, 'x'), '')
    expect(bucketStore('projects', d).url).toBe(join(d, 'projects'))
  })
})

describe('the release copy', () => {
  it('signing the gate that cuts a release copies the record into the repository and logs the commit', async () => {
    const c = { principal: ADMIN, deps }
    await journeyStore(c, 'acme/secret').update((db) => {
      startJourney(db, { template: 'firmware', by: 'seed', name: 'Firmware only' })
      for (const g of ['define', 'architect', 'prove']) for (const row of db.prepare('SELECT id FROM gate_criteria WHERE gate=?').all(g)) setCriterion(db, String(row.id), 'met', [], 'trace')
      return { result: null }
    })
    seedProject('acme/secret')
    const open = async (gate: string): Promise<void> => {
      const v = await run(ADMIN, 'journey.get', { repo: 'acme/secret' }) as { gates: { id: string; criteria: { id: string }[] }[] }
      for (const k of v.gates.find((g) => g.id === gate)?.criteria ?? []) await run(ADMIN, 'journey.criterion.open', { repo: 'acme/secret', criterion: k.id })
    }
    for (const g of ['define', 'architect']) { await open(g); expect(await run(ADMIN, 'gate.sign', { repo: 'acme/secret', gate: g })).toMatchObject({ snapshot: null }) }
    await open('prove')
    github.calls = []
    const signed = await run(ADMIN, 'gate.sign', { repo: 'acme/secret', gate: 'prove' }) as { released: boolean; advanced_to: string; snapshot: { branch: string; commit: string }; summary: string }
    expect(signed).toMatchObject({ released: true, advanced_to: 'bringup', snapshot: { branch: expect.stringMatching(/^trace\/release-a-/), commit: 'c0ffee0000000000' } })
    expect(signed.summary).toMatch(/copied into the repository/)
    expect(github.calls.some((x) => x.startsWith('putFile acme/secret main'))).toBe(false)
    // the copy: the repository's own tables kept, the journey's replaced by the live record
    const bytes = github.files.get(`acme/secret:${signed.snapshot.branch}:.trace/project.db`)
    const dir = mkdtempSync(join(scratch, 'snap-'))
    writeFileSync(join(dir, 'p.db'), bytes ?? new Uint8Array())
    const db = new DatabaseSync(join(dir, 'p.db'))
    expect(db.prepare("SELECT current_stage FROM journey WHERE id='current'").get()?.current_stage).toBe('bringup')
    expect(db.prepare('SELECT count(*) AS n FROM gate_signatures').get()?.n).toBe(3)
    db.close()
    const log = await run(ADMIN, 'journey.get', { repo: 'acme/secret' }) as { decisions: { kind: string; ref: string }[] }
    expect(log.decisions[0]).toMatchObject({ kind: 'journey.snapshot', ref: 'c0ffee0000000000' })
  })

  it('journey.snapshot is for admins, and needs a journey', async () => {
    expect((await call(accessToken('w-user', ['trace-users']), { action: 'journey.snapshot', repo: 'acme/web' })).status).toBe(403)
    expect(await run(ADMIN, 'journey.snapshot', { repo: 'acme/web', reason: 'a check' })).toMatchObject({ branch: expect.stringMatching(/^trace\/release-/), revision: 'A', version: expect.any(Number) })
    await expect(run(ADMIN, 'journey.snapshot', { repo: 'acme/fresh2' })).rejects.toThrow()
  })
})

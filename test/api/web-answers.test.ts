/**
 * Real answers of the actions the web app reads through lib/readers.ts, written to web/src/lib/api-answers.json so the
 * app's tests read what the API actually answers, not what was assumed. Regenerate with
 * `TRACE_WRITE_ANSWERS=1 npx vitest run test/api/web-answers.test.ts`; without it this test checks the file is current
 * in its keys and shapes.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { assign, seen } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { askQuestion, setCriterion, startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { JobIndexStore, putJob } from '../../src/core/job-index.js'
import { AgentFactsStore } from '../../src/core/agent-facts.js'
import { addHandoff, answerHandoff, handoffTitle, markStarted } from '../../src/core/handoffs.js'
import { projectHash } from '../../src/core/project.js'
import { openProject } from '../../src/core/store.js'
import { DesignDb } from '../../src/tools/design/db.js'
import '../../src/tools/verify/db.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'a-admin', email: 'admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'a-user', email: 'user@example.com', groups: ['trace-users'] }
const REPO = 'acme/answers'
const github = new FakeGitHub([REPO])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-answers-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-answers-bucket-'))
const deps: ActionDeps = { github: async () => github, cognito: () => cognito, jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [], cancel: async () => ({ ok: true, state: 'aborted' }), pause: async () => ({ ok: true, state: 'running' }) }), tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)) }
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<unknown> => (await perform(action, args, { principal: who, deps })).result
const OUT = join(import.meta.dirname, '../../web/src/lib/api-answers.json')
/** The queued hand-off the answers decline (seeded below). */
let pending = ''

const handoffIds: string[] = []
/** Times and ids change on every run: fixed, so the file only changes when a shape does. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stable(x)]))
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v)) return '2026-10-27T00:00:00.000Z'
  // a hand-off's id (ho + 14 hex): its order kept, so the two seeded ones stay apart
  if (typeof v === 'string' && /^ho[0-9a-f]{14}$/.test(v)) return `ho${String(handoffIds.indexOf(v) === -1 ? handoffIds.push(v) - 1 : handoffIds.indexOf(v)).padStart(14, '0')}`
  if (typeof v === 'string' && /[0-9a-f]{16}/.test(v)) return v.replace(/[0-9a-f]{16,}/g, (m) => '0123456789abcdef0123456789abcdef'.slice(0, m.length))
  if (typeof v === 'string' && /^\d+ (minute|hour|day)s? ago$|^just now$/.test(v)) return 'just now'
  return v
}

beforeAll(async () => {
  cognito.add(ADMIN.email, ADMIN.sub, 'trace-admins', 'Ada Admin')
  cognito.add(USER.email, USER.sub, 'trace-users')
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await seen(USER)
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Answers' })
  setCriterion(db, 'define.accepted', 'met', [{ kind: 'run', ref: 'run-1', label: 'the requirements list' }], 'trace')
  askQuestion(db, { askedBy: 'the Analog specialist', text: 'What is the supply range?', blocks: 'sizing the regulator', options: [{ id: 'a', label: '2.7 to 3.6 V', recommended: true, why: 'datasheet' }, { id: 'b', label: '1.8 to 3.6 V' }] })
  // the design record: intent with a requirement derived from it, an architecture, a pin plan, a sheet's requirements
  const t = Date.now() / 1000
  db.prepare("INSERT INTO requirements (id, text, kind, acceptance, source, status, created, updated) VALUES ('REQ-1', 'Range of 2 km line of sight', 'functional', 'at least 2 km', 'intent', 'accepted', ?, ?)").run(t, t)
  const d = new DesignDb(dir)
  d.addIntent([{ id: 'INT-range', topic: 'performance', text: 'Reaches a gateway 2 km away.', source: { kind: 'person', ref: 'Ada' } }])
  d.link('REQ-1', ['INT-range'])
  d.setOption({ id: 'A', name: 'One chip', summary: 'An STM32WL with the radio inside.', recommended: true, why: 'Fewer parts.' })
  d.setBlocks('A', [{ id: 'mcu', name: 'MCU and radio', parts: [{ mpn: 'STM32WLE5JCI6', key: true }], requirements: ['REQ-1'], x: 0.5, y: 0.5 }])
  d.setPins([{ part: 'U1', pin: '30', name: 'PA9', function: 'USART1_TX', peripheral: 'USART1', use: 'GPS', net: '/GPS_RX', alternates: ['USART1_TX'] }])
  d.setSheet({ sheet: 'hw/answers.kicad_sch', requirements: ['REQ-1'] })
  d.close()
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  github.files.set(`${REPO}:main:README.md`, new TextEncoder().encode('# Answers'))
  github.files.set(`${REPO}:main:hw/answers.kicad_sch`, new TextEncoder().encode('(kicad_sch)'))
  rmSync(dir, { recursive: true, force: true })
  // the project's job index (src/core/job-index.ts): one running task of the person's, one queued behind it, one done
  const S = (c: string): string => `trace-api-${projectHash(REPO)}-${c.repeat(24)}`
  const now = Date.now() / 1000
  await new JobIndexStore(backendFor(join(bucket, 'projects')), REPO).update((db) => {
    putJob(db, 'job-run', { kind: 'task', agent: 'verify', title: 'Check the ERC', state: 'running', session: S('a'), requestedBySub: USER.sub, requestedBy: USER.email, step: 'running ERC on the main sheet', queuedAt: now - 300, startedAt: now - 300, beatAt: now, branch: 'claude/task-erc' }, now)
    putJob(db, 'job-q', { kind: 'task', agent: 'verify', title: 'Check the DRC', state: 'queued', session: S('b'), requestedBySub: USER.sub, requestedBy: USER.email, step: 'queued: the verify agent is already working on this project ("Check the ERC")', queuedAt: now - 60 }, now)
    putJob(db, 'job-done', { kind: 'task', agent: 'verify', title: 'Check the BOM', state: 'succeeded', session: S('c'), queuedAt: now - 3000, startedAt: now - 3000, endedAt: now - 2400, summary: 'verify: done in 9 turns' }, now)
    return { result: null }
  })
  // a hand-off between specialists: the Thermal specialist asked the Analog one; its job is queued, and one answered
  const projects = backendFor(join(bucket, 'projects'))
  const OPEN = { enabled: ['verify', 'impl', 'ams', 'emc', 'render', 'thermal'] as const, limits: { perJob: 3, perProject: 10 }, declined: new Set<string>() }
  const asked = { evidence: [{ kind: 'run', ref: 'run-1', label: 'the thermal run' }], blocks: 'the junction temperature check of U3', acceptance: ['the dissipation in watts at 500 mA, with the run id'] }
  const [q, a] = (await new AgentFactsStore(projects, REPO).update((db) => {
    const one = addHandoff(db, { agent: 'thermal', label: 'the Thermal specialist', jobId: 'job-th' }, { to: 'ams', question: 'What is the worst-case dissipation of the LDO U3 at 85 °C ambient?', ...asked }, OPEN)
    const two = addHandoff(db, { agent: 'thermal', label: 'the Thermal specialist', jobId: 'job-th' }, { to: 'ams', question: 'What is the quiescent current of U3 at 85 °C, from its datasheet?', ...asked }, OPEN)
    markStarted(db, one.id, 'job-ho')
    markStarted(db, two.id, 'job-ho2')
    answerHandoff(db, two.id, 'job-ho2', { answered: true, text: '15 µA typical at 85 °C (datasheet page 5).', evidence: [{ kind: 'run', ref: 'run-1' }], confidence: 0.9, acceptanceMet: true })
    return { result: [one, two] }
  })).result
  pending = q!.id
  await new JobIndexStore(projects, REPO).update((db) => {
    putJob(db, 'job-ho', { kind: 'task', agent: 'ams', title: handoffTitle('thermal', q!.question), handoff: q!.id, state: 'queued', session: S('d'), requestedBy: 'the Thermal specialist (job job-th)', queuedAt: now - 30 }, now)
    putJob(db, 'job-ho2', { kind: 'task', agent: 'ams', title: handoffTitle('thermal', a!.question), handoff: a!.id, state: 'succeeded', session: S('e'), requestedBy: 'the Thermal specialist (job job-th)', queuedAt: now - 900, startedAt: now - 900, endedAt: now - 600, summary: 'ams: done in 4 turns' }, now)
    return { result: null }
  })
})
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

describe('the answers the web app reads', () => {
  it('are current in web/src/lib/api-answers.json', async () => {
    await run(ADMIN, 'waiver.add', { repo: REPO, target: { kind: 'criterion', id: 'define.measurable' }, reason: 'Two criteria wait for the bench.', risk: 'A late finding.', severity: 'degraded', caught_where: 'Bring up' })
    const t = await run(USER, 'chats.append', { repo: REPO, messages: [{ text: 'Why this regulator?' }] }) as { thread: { id: string }; ids: string[] }
    await run(USER, 'chats.reply', { repo: REPO, thread: t.thread.id, after: t.ids[0], messages: [
      { role: 'assistant', text: 'Let me look.', parts: { toolCalls: [{ id: 'tu1', name: 'journey_get', args: '{"repo":"acme/answers"}' }] } },
      { role: 'tool', text: '{"stage":"define"}', parts: { toolCallId: 'tu1', name: 'journey_get' } },
      { role: 'assistant', text: 'It carries 1 A.' },
    ] })
    await run(ADMIN, 'chats.append', { repo: REPO, thread: t.thread.id, messages: [{ text: 'And the heat?' }] })
    const answers = stable({
      'journey.get': { args: { repo: REPO }, result: await run(USER, 'journey.get', { repo: REPO }) },
      'jobs.list': { args: { repo: REPO }, result: await run(USER, 'jobs.list', { repo: REPO }) },
      'handoff.decline': { args: { repo: REPO, id: pending, reason: 'The bench measures it on Friday.' }, result: await run(USER, 'handoff.decline', { repo: REPO, id: pending, reason: 'The bench measures it on Friday.' }) },
      inbox: { args: {}, result: await run(USER, 'inbox') },
      'me.get': { args: {}, result: await run(USER, 'me.get') },
      'project.members': { args: { repo: REPO }, result: await run(USER, 'project.members', { repo: REPO }) },
      'users.list': { args: {}, result: await run(ADMIN, 'users.list') },
      'files.list': { args: { repo: REPO }, result: await run(USER, 'files.list', { repo: REPO }) },
      'files.url': { args: { repo: REPO, path: 'README.md' }, result: await run(USER, 'files.url', { repo: REPO, path: 'README.md' }) },
      'chats.list': { args: { repo: REPO }, result: await run(USER, 'chats.list', { repo: REPO }) },
      'chats.get': { args: { repo: REPO, thread: t.thread.id }, result: await run(USER, 'chats.get', { repo: REPO, thread: t.thread.id }) },
      'chats.append': { args: { repo: REPO, messages: [{ text: 'A new question' }] }, result: await run(USER, 'chats.append', { repo: REPO, messages: [{ text: 'A new question' }] }) },
      'chats.rename': { args: { repo: REPO, thread: t.thread.id, title: 'Regulator' }, result: await run(USER, 'chats.rename', { repo: REPO, thread: t.thread.id, title: 'Regulator' }) },
      'chats.recall': { args: { repo: REPO }, result: await run(USER, 'chats.recall', { repo: REPO }) },
      'requirements.trace': { args: { repo: REPO }, result: await run(USER, 'requirements.trace', { repo: REPO }) },
      'design.decide': { args: { repo: REPO, decision: { kind: 'intent', statement: 'INT-range', choice: 'accept' } }, result: await run(USER, 'design.decide', { repo: REPO, decision: { kind: 'intent', statement: 'INT-range', choice: 'accept' } }) },
      'design.get': { args: { repo: REPO }, result: await run(USER, 'design.get', { repo: REPO }) },
      // the build and cost record (src/api/actions-build.ts, actions-cost.ts): an order shipped, a board inspected
      ...(await (async () => {
        await run(USER, 'order.record', { repo: REPO, number: 'Y12-0001', paid: 40, ship: '2026-11-04' })
        await run(USER, 'order.update', { repo: REPO, order: 'Y12-0001', state: 'shipped', carrier: 'dhl', tracking: '1234567890' })
        await run(USER, 'board.record', { repo: REPO, serial: 'SN-001', photos: ['runs/abc/top.jpg'] })
        await run(USER, 'board.check', { repo: REPO, serial: 'SN-001', check: 'count', kind: 'count', result: 'pass' })
        return {
          'build.get': { args: { repo: REPO }, result: await run(USER, 'build.get', { repo: REPO }) },
          'cost.get': { args: { repo: REPO }, result: await run(ADMIN, 'cost.get', { repo: REPO }) },
          'usage.month': { args: { month: '2026-10' }, result: await run(ADMIN, 'usage.month', { month: '2026-10' }) },
        }
      })()),
      // the small gaps: what Admin › Installation and New project read, and what the backend reads for voice and chat
      'installation.layout': { args: {}, result: (await perform('installation.layout', {}, { principal: USER, deps: { ...deps, layout: 'flat' } })).result },
      'prompts.chat': { args: {}, result: await run(USER, 'prompts.chat') },
      'voice.vocabulary': { args: { repo: REPO, language: 'en-AU' }, result: (await perform('voice.vocabulary', { repo: REPO, language: 'en-AU' }, { principal: USER, deps: { ...deps, installationPrefix: 'trace', vocabularies: async () => ({ get: async () => ({ state: 'READY' as const }) }) } })).result },
    }) as Record<string, unknown>
    if (process.env.TRACE_WRITE_ANSWERS) writeFileSync(OUT, `${JSON.stringify(answers, null, 2)}\n`)
    const kept = JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>
    expect(kept).toEqual(answers)
  })
})

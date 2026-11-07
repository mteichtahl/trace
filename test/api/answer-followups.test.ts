/**
 * An answer is never dropped with the job that was to apply it (test-esp32 log #131): question.answer keeps it as a
 * follow-up, and journey.get starts a new carry-on on the same branch when that job stopped with its runtime, was lost,
 * or never reached the queue, until a job applies it. A person's cancel stops it; an applied one starts nothing.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, type JobsApi, perform } from '../../src/api/actions.js'
import { jobIndex } from '../../src/api/actions-jobs.js'
import { journeyStore } from '../../src/api/action-kit.js'
import { parseHandle } from '../../src/api/workers.js'
import { assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { AgentFactsStore, addAgentQuestion } from '../../src/core/agent-facts.js'
import { loadFollowups } from '../../src/core/answer-followups.js'
import { putJob } from '../../src/core/job-index.js'
import { loadJourney, startJourney } from '../../src/core/journey.js'
import { projectHash } from '../../src/core/project.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'f-admin', email: 'f-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'f-user', email: 'f-user@example.com', groups: ['trace-users'] }
const REPO = 'acme/followups'
const H = projectHash(REPO)
const S = (n: string): string => `trace-api-${H}-${n.repeat(24).slice(0, 24)}`
const BRANCH = 'claude/task-wifi-docs'
const github = new FakeGitHub([REPO])
const scratch = mkdtempSync(join(tmpdir(), 'trace-followups-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-followups-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

type Started = Parameters<JobsApi['startJob']>[0]
const started: Started[] = []
let next = 0
const jobsApi: JobsApi = {
  repositoryOf: (id) => { const h = parseHandle(id); return h?.hash === H ? REPO : null },
  startJob: async (p) => { started.push(p); next++; return { accepted: true, jobId: `${S(String(next))}.job-c${next}` } },
  jobStatus: async () => [],
}
const deps: ActionDeps = { github: async () => github, cognito: () => new FakeCognito(), jobs: async () => jobsApi, tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)) }
const ctx = (principal: Context['principal']): Context => ({ principal, deps })
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  (await perform(action, args, ctx(who))).result as Record<string, unknown>
const followups = async () => (await journeyStore(ctx(ADMIN), REPO).read((d) => loadFollowups(d))).result
const index = (fn: (put: (id: string, f: Parameters<typeof putJob>[2]) => void, now: number) => void) => jobIndex(ctx(ADMIN), REPO).update((d) => {
  const now = Date.now() / 1000
  fn((id, f) => putJob(d, id, { kind: 'task', agent: 'docs', title: id, state: 'queued', ...f }, now), now)
  return { result: null }
})

let question = ''
beforeAll(async () => {
  await assign(ADMIN, USER, REPO, { class: 'user' })
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Follow-ups' })
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  const record = (await journeyStore(ctx(ADMIN), REPO).read((d) => loadJourney(d))).result
  // the Documentation specialist asked in its job, then ended: its change is open on its branch
  await new AgentFactsStore(backendFor(join(bucket, 'projects')), REPO).update((d) => {
    question = addAgentQuestion(d, { agent: 'docs', label: 'the Documentation specialist', jobId: 'job-ask' }, {
      text: 'How does a user clear the saved Wi-Fi network?', options: [{ id: 'a', label: 'Reopen the setup access point after 60 s', recommended: true, why: 'no button on the case' }, { id: 'b', label: 'A button held for 5 s', why: 'a known pattern' }],
    }, record)
    return { result: null }
  })
  await index((put, now) => put('job-ask', { state: 'succeeded', branch: BRANCH, session: S('a'), queuedAt: now - 3600, startedAt: now - 3600, endedAt: now - 1800 }))
})

describe('an answer whose job is lost', () => {
  it('question.answer starts the carry-on on the asking job\'s branch and keeps the answer until it is applied', async () => {
    const r = await run(USER, 'question.answer', { repo: REPO, question, option: 'a', lasts: 'rule' })
    expect(r).toMatchObject({ jobId: `${S('1')}.job-c1` })
    expect(started.at(-1)).toMatchObject({ kind: 'task', agent: 'docs', branch: BRANCH, request: expect.stringMatching(/is answered/) })
    expect(await followups()).toEqual([expect.objectContaining({ question, branch: BRANCH, agent: 'docs', job: 'job-c1', attempts: 1, state: 'pending', bySub: USER.sub })])
  })

  it('while it waits in the queue, nothing else starts', async () => {
    await index((put, now) => put('job-c1', { branch: BRANCH, session: S('1'), queuedAt: now - 60, step: 'queued: the impl agent is already working on this project' }))
    const before = started.length
    await run(USER, 'journey.get', { repo: REPO })
    expect(started.length).toBe(before)
  })

  it('its queued job stopped with its runtime: journey.get starts it again, as a new attempt, carrying the answer', async () => {
    await index((put, now) => put('job-c1', { state: 'aborted', error: 'the runtime is shutting down', endedAt: now - 5 }))
    const before = started.length
    const j = await run(USER, 'journey.get', { repo: REPO })
    expect(started.length).toBe(before + 1)
    expect(started.at(-1)).toMatchObject({ agent: 'docs', branch: BRANCH, attempt: 2, requestedBySub: USER.sub, request: expect.stringMatching(/Reopen the setup access point after 60 s[\s\S]*An earlier job started to apply this answer stopped before it did \(job job-c1 was stopped \(the runtime is shutting down\)\)/) })
    expect(j.answers_restarted).toEqual([expect.stringMatching(/Documentation specialist again/)])
    expect(await followups()).toEqual([expect.objectContaining({ job: 'job-c2', attempts: 2, state: 'pending' })])
    // a second look at once starts nothing more: the new job is starting
    await run(USER, 'journey.get', { repo: REPO })
    expect(started.length).toBe(before + 1)
  })

  it('once a job on the branch applied it, it is settled and nothing starts', async () => {
    await index((put, now) => put('job-c2', { state: 'succeeded', branch: BRANCH, session: S('2'), queuedAt: now - 30, startedAt: now - 30, endedAt: now - 1 }))
    const before = started.length
    await run(USER, 'journey.get', { repo: REPO })
    expect(started.length).toBe(before)
    expect(await followups()).toEqual([expect.objectContaining({ job: 'job-c2', state: 'applied' })])
  })
})

describe('an answer to a job that ran on another specialist\'s branch (test-esp32 log #144)', () => {
  const HANDOFF = 'claude/handoff-hoac40d08bf1664e'
  let asked = ''
  it('its carry-on opens a change of its own, stacked on that branch, not more commits in the other\'s change', async () => {
    // the Documentation specialist answered a hand-off on its branch; the Implementation specialist, sent there to
    // check the answer, asked about the case and ended
    const record = (await journeyStore(ctx(ADMIN), REPO).read((d) => loadJourney(d))).result
    await new AgentFactsStore(backendFor(join(bucket, 'projects')), REPO).update((d) => {
      asked = addAgentQuestion(d, { agent: 'impl', label: 'the Implementation specialist', jobId: 'job-impl-ask' }, {
        text: 'How is the case made?', options: [{ id: 'a', label: 'A printed two-part shell', recommended: true, why: 'cheap at one-off quantities' }, { id: 'b', label: 'A bought enclosure', why: 'no printing' }],
      }, record)
      return { result: null }
    })
    await index((put, now) => {
      put('job-docs-ho', { agent: 'docs', handoff: 'hoac40d08bf1664e', state: 'succeeded', branch: HANDOFF, session: S('h'), queuedAt: now - 7200, startedAt: now - 7200, endedAt: now - 6000 })
      put('job-impl-ask', { agent: 'impl', state: 'succeeded', branch: HANDOFF, session: S('i'), queuedAt: now - 5000, startedAt: now - 5000, endedAt: now - 4000 })
    })
    const r = await run(USER, 'question.answer', { repo: REPO, question: asked, option: 'a', lasts: 'once' })
    const job = started.at(-1) as Started
    expect(job).toMatchObject({ kind: 'task', agent: 'impl', stackOn: HANDOFF, request: expect.stringMatching(/holds the Documentation specialist's work, so this work is a change of its own[\s\S]*Never push to claude\/handoff-/) })
    expect(job.branch).toBeUndefined()
    expect(String(r.summary)).toMatch(/carries on with it, in a change of its own on top of the one it checked\./)
    const n = workerId(String(r.jobId))
    expect((await followups()).find((x) => x.question === asked)).toMatchObject({ branch: HANDOFF, stackOn: HANDOFF, job: n, agent: 'impl' })

    // once its job names its branch, that is where the answer goes
    await index((put, now) => put(n, { agent: 'impl', state: 'running', branch: 'claude/task-case-answer', session: S('k'), queuedAt: now - 20, startedAt: now - 20, beatAt: now - 5 }))
    const before = started.length
    await run(USER, 'journey.get', { repo: REPO })
    expect(started.length).toBe(before)
    expect((await followups()).find((x) => x.question === asked)).toMatchObject({ branch: 'claude/task-case-answer', stackOn: null })
  })
})

const workerId = (handle: string): string => handle.split('.').at(-1) as string

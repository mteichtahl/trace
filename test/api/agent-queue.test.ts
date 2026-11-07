/**
 * Work asked for while a new project's agent is being set up (test-esp32 log #2, #80): queued, not refused, and started
 * by itself once the project has its agent (src/api/agent-queue.ts). The person submits the intent, or confirms a task
 * in a chat, straight after creating the project; nothing waits on a disabled button for the installation update.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { QUEUED_DRAFTING, REQUIREMENTS_FROM_INTENT } from '../../src/api/actions-skills.js'
import type { JobsApi } from '../../src/api/action-kit.js'
import {
  WAITS_FOR_AGENT, WAITS_FOR_EARLIER, parseQueue, parseQueued, queueStart, queuedHandle, queuedId, readQueue, startQueued, withAgentQueue,
} from '../../src/api/agent-queue.js'
import { assign, seen } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { DesignDb } from '../../src/tools/design/db.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

type Start = Parameters<JobsApi['startJob']>[0]
const task = (request: string, o: Partial<Start> = {}): Start => ({ kind: 'task', repository: 'acme/new', request, requestedBy: 'p@example.com', ...o })

/** A worker's jobs API that knows whether the project has its agent, and what it was asked to start. */
function fakeWorkers(o: { agent: () => boolean }) {
  const started: Start[] = []
  const inner: JobsApi = {
    repositoryOf: () => null,
    hasAgent: () => o.agent(),
    jobStatus: async (id) => (id ? [{ id, kind: 'task', state: 'running', repository: 'acme/new' }] : []),
    startJob: async (p) => {
      if (!o.agent()) throw new Error('acme/new\'s agent is not set up yet')
      started.push(p)
      return { accepted: true, jobId: `job-${started.length}` }
    },
  }
  return { inner, started }
}

describe('a queued start\'s handle and file', () => {
  it('names its project in the handle, so access is checked before anything is read', () => {
    const h = queuedHandle('Acme/New', 'abcdef012345')
    expect(h).toBe('queued~acme~new~abcdef012345')
    expect(parseQueued(h)).toEqual({ repo: 'acme/new', id: 'abcdef012345' })
    expect(parseQueued('trace-api-12345678-abcdefabcdefabcdefabcdef.job-1')).toBeNull()
    expect(parseQueued('queued~acme~new~nothex')).toBeNull()
  })

  it('the same request is the same start; another agent, branch or attempt is another', () => {
    expect(queuedId(task('Draft it'))).toBe(queuedId(task('Draft it')))
    expect(queuedId(task('Draft it'))).not.toBe(queuedId(task('Draft it', { agent: 'verify' })))
    expect(queuedId(task('Draft it'))).not.toBe(queuedId(task('Draft it', { attempt: 2 })))
    expect(parseQueue('not json')).toEqual({ queued: [], started: [] })
  })
})

describe('the jobs API with the queue in front of it', () => {
  it('queues a start while the project has no agent, answers accepted and queued, and lists it once', async () => {
    const store = backendFor(mkdtempSync(join(tmpdir(), 'trace-queue-')))
    let agent = false
    const w = fakeWorkers({ agent: () => agent })
    const jobs = withAgentQueue(w.inner, () => store, { holdS: 0 })
    const r = await jobs.startJob(task('Draft the requirements'))
    expect(r).toMatchObject({ accepted: true, queued: true, reason: `Queued: it ${WAITS_FOR_AGENT}.` })
    expect(parseQueued(r.jobId)).toMatchObject({ repo: 'acme/new' })
    // asked again (a second press): the one queued start
    expect((await jobs.startJob(task('Draft the requirements'))).jobId).toBe(r.jobId)
    expect((await readQueue(store, 'acme/new')).queued).toHaveLength(1)
    expect(w.started).toEqual([])
    expect(jobs.repositoryOf(r.jobId)).toBe('acme/new')
    expect(await jobs.jobStatus(r.jobId)).toMatchObject([{ id: r.jobId, state: 'queued', step: `queued: ${WAITS_FOR_AGENT}`, queue: { position: 1, of: 1 } }])
    // nothing starts while there is still no agent
    expect(await startQueued(jobs, store, 'acme/new')).toEqual([])
    // once it has its agent: started as it was asked, once, and the handle follows the job it became
    agent = true
    expect(await startQueued(jobs, store, 'acme/new')).toMatchObject([{ job: 'job-1' }])
    // a second look finds it claimed (a look at the same moment loses the conditional write and reads it claimed too)
    expect(await startQueued(jobs, store, 'acme/new')).toEqual([])
    expect(w.started).toEqual([task('Draft the requirements')])
    expect(await readQueue(store, 'acme/new')).toMatchObject({ queued: [], started: [{ job: 'job-1' }] })
    expect(await jobs.jobStatus(r.jobId)).toMatchObject([{ id: r.jobId, state: 'running', startedAs: 'job-1' }])
    // and a new start goes straight to the worker
    expect(await jobs.startJob(task('Another'))).toEqual({ accepted: true, jobId: 'job-2' })
  })

  it('a queued start can be cancelled before it starts, and then never starts', async () => {
    const store = backendFor(mkdtempSync(join(tmpdir(), 'trace-queue-')))
    let agent = false
    const w = fakeWorkers({ agent: () => agent })
    const jobs = withAgentQueue(w.inner, () => store)
    const r = await jobs.startJob(task('Check the stock'))
    expect(await jobs.cancel!(r.jobId, 'cancelled by p')).toMatchObject({ ok: true, state: 'aborted' })
    agent = true
    expect(await startQueued(jobs, store, 'acme/new')).toEqual([])
    expect(w.started).toEqual([])
  })

  it('a start that fails once the agent is there is recorded with why, not dropped silently', async () => {
    const store = backendFor(mkdtempSync(join(tmpdir(), 'trace-queue-')))
    await queueStart(store, task('Broken'))
    const jobs: JobsApi = { repositoryOf: () => null, hasAgent: () => true, jobStatus: async () => [], startJob: async () => ({ accepted: false, jobId: '', reason: 'the project is paused' }) }
    expect(await startQueued(jobs, store, 'acme/new')).toMatchObject([{ job: null, error: 'the project is paused' }])
  })

  it('queued work starts one at a time in the order asked, the next on top of the earlier change (test-esp32-run2 R9)', async () => {
    const store = backendFor(mkdtempSync(join(tmpdir(), 'trace-queue-')))
    let agent = false
    const states = new Map<string, { state: string; branch?: string }>()
    const started: Start[] = []
    const inner: JobsApi = {
      repositoryOf: () => null,
      hasAgent: () => agent,
      jobStatus: async (id) => (id && states.has(id) ? [{ id, kind: 'task', repository: 'acme/new', ...states.get(id)! }] : []),
      startJob: async (p) => {
        started.push(p)
        const id = `job-${started.length}`
        states.set(id, { state: 'running', branch: `claude/task-${started.length}` })
        return { accepted: true, jobId: id }
      },
    }
    const jobs = withAgentQueue(inner, () => store, { holdS: 0 })
    const a = await jobs.startJob(task('Record the intent statements I1 to I23'))
    const b = await jobs.startJob(task('Add I24 and change I20'))
    const c = await jobs.startJob(task('Ship it', { branch: 'claude/own' }))
    agent = true
    // the first only: the second waits for it, and says so
    expect(await startQueued(jobs, store, 'acme/new')).toMatchObject([{ job: 'job-1' }])
    expect(await startQueued(jobs, store, 'acme/new')).toEqual([])
    expect(started.map((p) => p.request)).toEqual(['Record the intent statements I1 to I23'])
    expect(await jobs.jobStatus(b.jobId)).toMatchObject([{ state: 'queued', queue: { position: 1, of: 2, startsWhen: WAITS_FOR_EARLIER }, waitsForAgent: false }])
    // paused (a question to answer): still waits
    states.set('job-1', { state: 'paused', branch: 'claude/task-1' })
    expect(await startQueued(jobs, store, 'acme/new')).toEqual([])
    // the first ended: the second starts, stacked on its change (the worker stacks only on an open one)
    states.set('job-1', { state: 'succeeded', branch: 'claude/task-1' })
    expect(await startQueued(jobs, store, 'acme/new')).toMatchObject([{ job: 'job-2' }])
    expect(started[1]).toEqual(task('Add I24 and change I20', { stackOn: 'claude/task-1' }))
    expect(await jobs.jobStatus(a.jobId)).toMatchObject([{ state: 'succeeded', startedAs: 'job-1' }])
    // a start given its own branch keeps it
    states.set('job-2', { state: 'failed' })
    expect(await startQueued(jobs, store, 'acme/new')).toMatchObject([{ job: 'job-3' }])
    expect(started[2]).toEqual(task('Ship it', { branch: 'claude/own' }))
    expect(c.jobId).toMatch(/^queued~/)
    expect((await readQueue(store, 'acme/new')).queued).toEqual([])
  })

  it('a job never heard of again does not hold the queue', async () => {
    const store = backendFor(mkdtempSync(join(tmpdir(), 'trace-queue-')))
    await queueStart(store, task('One'))
    await queueStart(store, task('Two'))
    const asked: string[] = []
    const jobs: JobsApi = { repositoryOf: () => null, hasAgent: () => true, jobStatus: async () => [], startJob: async (p) => { asked.push(p.request); return { accepted: true, jobId: `j-${asked.length}` } } }
    await startQueued(jobs, store, 'acme/new')
    await startQueued(jobs, store, 'acme/new')
    expect(asked).toEqual(['One', 'Two'])
  })

  it('an installation whose jobs API cannot tell is left as it is', () => {
    const inner: JobsApi = { repositoryOf: () => null, jobStatus: async () => [], startJob: async () => ({ accepted: true, jobId: 'j' }) }
    expect(withAgentQueue(inner, () => backendFor(tmpdir()))).toBe(inner)
  })
})

// ------------------------------------------------------------------ through the actions: a new project's Define

const ADMIN = { sub: 'q-admin', email: 'q-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'q-user', email: 'q-user@example.com', groups: ['trace-users'] }
const REPO = 'acme/fresh'
const github = new FakeGitHub([REPO])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-queue-api-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-queue-bucket-'))
let hasAgent = false
const started: Start[] = []
const inner: JobsApi = {
  repositoryOf: () => null, hasAgent: () => hasAgent,
  jobStatus: async () => [],
  startJob: async (p) => {
    if (!hasAgent) throw new Error(`${REPO}'s agent is not set up yet`)
    started.push(p)
    return { accepted: true, jobId: `job-${started.length}` }
  },
}
const store = (p: string) => backendFor(join(bucket, p))
const deps: ActionDeps = {
  github: async () => github, cognito: () => cognito,
  jobs: async () => withAgentQueue(inner, () => store('projects'), { holdS: 0 }),
  tools: () => new Registry([]), scratch, store,
}
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<unknown> => (await perform(action, args, { principal: who, deps })).result
type Journey = { next: { kind: string; summary: string; job_id?: string; why: string }; drafting?: { state: string; job: { id: string; state: string } | null } }

beforeAll(async () => {
  cognito.add(ADMIN.email, ADMIN.sub, 'trace-admins')
  cognito.add(USER.email, USER.sub, 'trace-users')
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await seen(USER)
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Fresh' })
  const d = new DesignDb(dir)
  d.addIntent([
    { id: 'INT-purpose', topic: 'purpose', text: 'A 20 × 20 mm board where a TLC555 flashes a red LED once every 2 seconds.' },
    { id: 'INT-env', topic: 'environment', text: 'Indoor desk use, 0 to 40 °C ambient.' },
    { id: 'INT-power', topic: 'power', text: 'Runs from 5 V ± 0.25 V on a USB-C socket.' },
    { id: 'INT-usb', topic: 'interfaces', text: 'USB-C power input.', interface: { type: 'power input', connector: 'USB-C receptacle', protocol: 'none (sink, 5.1 kΩ on CC1 and CC2)', rate: 'not applicable', direction: 'in' } },
    { id: 'INT-flash', topic: 'performance', text: 'Flashes at 0.5 Hz ± 10 %.' },
    { id: 'INT-size', topic: 'physical', text: 'The board is at most 20 × 20 mm.' },
    { id: 'INT-comp', topic: 'compliance', text: 'None required: internal prototype.' },
    { id: 'INT-build', topic: 'build', text: '10 boards assembled at JLCPCB.' },
    { id: 'INT-part', topic: 'constraints', text: 'Use the CMOS TLC555 timer.' },
    { id: 'INT-refs', topic: 'references', text: 'docs/requirements.md' },
  ])
  d.close()
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  rmSync(dir, { recursive: true, force: true })
})

describe('a new project\'s Define while its agent is being set up', () => {
  it('Submit records the intent and queues the drafting; it starts by itself once the agent is there', async () => {
    const r = await run(USER, 'skill.submit', { repo: REPO, skill: 'intent-builder', draft: {} }) as { ok: boolean; jobId?: string; jobError?: string; queued?: boolean; started: string[] }
    // not "trace could not start drafting": queued, with its handle, and said so
    expect(r).toMatchObject({ ok: true, queued: true, started: [QUEUED_DRAFTING] })
    expect(r.jobError).toBeUndefined()
    expect(parseQueued(r.jobId ?? '')).toMatchObject({ repo: REPO })
    expect(started).toEqual([])

    // the project says what happens, and offers no "Draft the requirements again" over it, however long the update takes
    const waiting = await run(USER, 'journey.get', { repo: REPO }) as Journey
    expect(waiting.drafting).toMatchObject({ state: 'waiting', job: { id: r.jobId, state: 'queued' } })
    expect(waiting.next).toMatchObject({ kind: 'working', summary: 'Your intent is submitted. trace drafts the requirements from it once this project\'s agent is set up.', job_id: r.jobId })
    await expect(run(USER, 'requirements.draft', { repo: REPO })).rejects.toThrow(/queued already/)
    const list = await run(USER, 'jobs.list', { repo: REPO }) as { jobs: { id: string; state: string; queue: { startsWhen: string } | null; controls: string[] }[] }
    expect(list.jobs).toMatchObject([{ id: r.jobId, state: 'queued', queue: { startsWhen: WAITS_FOR_AGENT }, controls: ['cancel'] }])

    // the update adds the agent: the next look starts the drafting as Submit asked it, once
    hasAgent = true
    const now = await run(USER, 'journey.get', { repo: REPO }) as Journey
    expect(started).toEqual([{ kind: 'task', repository: REPO, request: REQUIREMENTS_FROM_INTENT, agent: 'verify', requestedBy: USER.email, requestedBySub: USER.sub }])
    // and it reads as drafting while the new job is not in the index yet, not as stopped
    expect(now.drafting?.state).toBe('drafting')
    await run(USER, 'journey.get', { repo: REPO })
    expect(started).toHaveLength(1)
  })

  it('a chat\'s task is queued too, and answered so', async () => {
    hasAgent = false
    const r = await run(USER, 'task', { repo: REPO, request: 'Check that every part is in stock.' }) as { accepted: boolean; queued?: boolean; jobId: string; reason?: string }
    expect(r).toMatchObject({ accepted: true, queued: true, reason: `Queued: it ${WAITS_FOR_AGENT}.` })
    // followed like any job, as the project's (the id names it)
    expect(await run(USER, 'job', { id: r.jobId })).toMatchObject({ id: r.jobId, state: 'queued' })
    // and taken out again by the person who can write there
    expect(await run(USER, 'job.control', { id: r.jobId, op: 'cancel' })).toMatchObject({ ok: true, state: 'aborted' })
    hasAgent = true
    await run(USER, 'jobs.list', { repo: REPO })
    expect(started.filter((s) => s.request.startsWith('Check that every part'))).toEqual([])
  })
})

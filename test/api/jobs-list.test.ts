/**
 * jobs.list, journey.get's jobs and job.control's real ops (src/api/actions-jobs.ts) over a project's job index:
 * access (read to list, contributor to control, "no access" alike for a stranger and a project that does not exist),
 * pause (a running task through its worker; a queued one held), resume (a held one released; a paused one carried on
 * as a new task on its branch), move up, and cancel (a paused one discarded). And the worker invocation `pause`
 * through remoteJobs.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, type JobsApi, perform } from '../../src/api/actions.js'
import { jobIndex } from '../../src/api/actions-jobs.js'
import { journeyStore } from '../../src/api/action-kit.js'
import { parseHandle, parseWorkerRuntimes, remoteJobs } from '../../src/api/workers.js'
import { AccessDenied, assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { AgentFactsStore, addStuck } from '../../src/core/agent-facts.js'
import { loadControls, putJob } from '../../src/core/job-index.js'
import { startJourney } from '../../src/core/journey.js'
import { projectHash } from '../../src/core/project.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'j-admin', email: 'j-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'j-user', email: 'j-user@example.com', groups: ['trace-users'] }
const REVIEWER = { sub: 'j-rev', email: 'j-rev@example.com', groups: ['trace-users'] }
const OUTSIDER = { sub: 'j-out', email: 'j-out@example.com', groups: ['trace-users'] }
const REPO = 'acme/jobs'
const H = projectHash(REPO)
const S = (n: string): string => `trace-api-${H}-${n.repeat(24).slice(0, 24)}`
const github = new FakeGitHub([REPO])
const scratch = mkdtempSync(join(tmpdir(), 'trace-jobs-list-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-jobs-list-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

const asked: { op: string; id: string; by?: string }[] = []
const startedTasks: unknown[] = []
const jobsApi: JobsApi = {
  repositoryOf: (id) => { const h = parseHandle(id); return h?.hash === H ? REPO : null },
  startJob: async (p) => { startedTasks.push(p); return { accepted: true, jobId: `${S('f')}.job-new` } },
  jobStatus: async () => [],
  cancel: async (id) => { asked.push({ op: 'cancel', id }); return { ok: true, state: 'aborted', kept: 'Commits already pushed stay.' } },
  pause: async (id, by) => { asked.push({ op: 'pause', id, by }); return { ok: true, state: 'running', kept: 'It stops before its next step.' } },
}
const deps: ActionDeps = { github: async () => github, cognito: () => new FakeCognito(), jobs: async () => jobsApi, tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)) }
const ctx = (principal: Context['principal']): Context => ({ principal, deps })
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  (await perform(action, args, ctx(who))).result as Record<string, unknown>

beforeAll(async () => {
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await assign(ADMIN, REVIEWER, REPO, { part: 'reviewer', class: 'user' })
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Jobs' })
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  const now = Date.now() / 1000
  await jobIndex(ctx(ADMIN), REPO).update((d) => {
    const put = (id: string, f: Parameters<typeof putJob>[2]) => putJob(d, id, { kind: 'task', agent: 'verify', title: id, state: 'queued', ...f }, now)
    put('job-run', { state: 'running', session: S('a'), startedAt: now - 300, beatAt: now, requestedBySub: USER.sub, requestedBy: USER.email, step: 'running ERC' })
    put('job-q1', { session: S('b'), queuedAt: now - 20 })
    put('job-q2', { session: S('c'), queuedAt: now - 10 })
    put('job-p', { state: 'paused', agent: 'impl', session: S('d'), branch: 'claude/task-route', pausedBy: USER.email, pausedAt: now - 60, claudeSession: 'aaaa-bbbb',
      payload: JSON.stringify({ kind: 'task', repository: REPO, request: 'Route the board', requestedBy: USER.email, requestedBySub: USER.sub, agent: 'impl' }) })
    put('job-wi', { kind: 'work-item', agent: 'emc', state: 'running', session: 'trace-acme-jobs-5-abcdef1234567890', beatAt: now })
    put('job-done', { state: 'succeeded', session: S('e'), startedAt: now - 1000, endedAt: now - 400 })
    return { result: null }
  })
  await new AgentFactsStore(backendFor(join(bucket, 'projects')), REPO).update((d) => {
    addStuck(d, { agent: 'thermal', label: 'the Thermal specialist', jobId: null }, { why: 'No ambient temperature in the requirements.', recommendation: 'Ask the contributors.' }, null)
    return { result: null }
  })
})

describe('jobs.list', () => {
  it('lists the project\'s jobs in order with their controls, each agent\'s status, and refuses strangers alike', async () => {
    const r = await run(USER, 'jobs.list', { repo: REPO })
    const jobs = r.jobs as Record<string, unknown>[]
    expect(jobs.map((j) => j.workerJobId)).toEqual(['job-run', 'job-wi', 'job-p', 'job-q1', 'job-q2', 'job-done'])
    expect(jobs[0]).toMatchObject({ id: `${S('a')}.job-run`, yours: true, typicalS: 600, step: 'running ERC', controls: ['pause', 'cancel'] })
    expect(jobs[1]).toMatchObject({ id: `p${H}.trace-acme-jobs-5-abcdef1234567890.job-wi`, controls: ['cancel'] })
    expect(jobs[3]).toMatchObject({ queue: { position: 1, of: 2 }, controls: ['pause', 'cancel'] })
    expect(jobs[4]).toMatchObject({ queue: { position: 2, of: 2 }, controls: ['pause', 'move_up', 'cancel'] })
    const agents = Object.fromEntries((r.agents as { id: string; status: string }[]).map((a) => [a.id, a.status]))
    expect(agents).toMatchObject({ verify: 'working', emc: 'working', thermal: 'stuck', impl: 'idle', ams: 'idle' })
    // a reviewer reads it all, with no controls
    expect(((await run(REVIEWER, 'jobs.list', { repo: REPO })).jobs as { controls: string[] }[]).every((j) => j.controls.length === 0)).toBe(true)
    await expect(run(OUTSIDER, 'jobs.list', { repo: REPO })).rejects.toThrow(AccessDenied)
    await expect(run(OUTSIDER, 'jobs.list', { repo: 'acme/does-not-exist' })).rejects.toThrow(AccessDenied)
  })

  it('is journey.get\'s jobs', async () => {
    const j = await run(USER, 'journey.get', { repo: REPO })
    expect((j.jobs as { workerJobId: string }[]).map((x) => x.workerJobId)).toEqual(['job-run', 'job-wi', 'job-p', 'job-q1', 'job-q2', 'job-done'])
  })
})

describe('job.control', () => {
  it('pauses a running task through its worker, and holds a queued one (people\'s controls, in the journey record)', async () => {
    expect(await run(USER, 'job.control', { id: `${S('a')}.job-run`, op: 'pause' })).toMatchObject({ ok: true, pausing: true, kept: expect.stringMatching(/next step/) })
    expect(asked.at(-1)).toEqual({ op: 'pause', id: `${S('a')}.job-run`, by: USER.email })
    expect(await run(USER, 'job.control', { id: `${S('c')}.job-q2`, op: 'pause' })).toMatchObject({ ok: true, held: true })
    const controls = (await journeyStore(ctx(USER), REPO).read((d) => loadControls(d))).result
    expect(controls.get('job-q2')).toMatchObject({ held: true, by: USER.email })
    const q2 = ((await run(USER, 'jobs.list', { repo: REPO })).jobs as Record<string, unknown>[]).find((j) => j.workerJobId === 'job-q2')
    expect(q2).toMatchObject({ held: true, controls: ['resume', 'move_up', 'cancel'], queue: { startsWhen: `held by ${USER.email}: it starts when someone resumes it` } })
    expect(await run(USER, 'job.control', { id: `${S('c')}.job-q2`, op: 'resume' })).toMatchObject({ ok: true, held: false })
  })

  it('moves a queued job up its agent\'s queue, and says so when it is first already', async () => {
    expect(await run(USER, 'job.control', { id: `${S('c')}.job-q2`, op: 'move_up' })).toMatchObject({ ok: true, position: 1 })
    const order = ((await run(USER, 'jobs.list', { repo: REPO })).jobs as Record<string, unknown>[]).filter((j) => j.state === 'queued').map((j) => j.workerJobId)
    expect(order).toEqual(['job-q2', 'job-q1'])
    expect(await run(USER, 'job.control', { id: `${S('c')}.job-q2`, op: 'move_up' })).toMatchObject({ ok: false, reason: 'It is first in its queue already.' })
  })

  it('resumes a paused job as a new task on its branch, carrying it on; a work item cannot be paused', async () => {
    const r = await run(USER, 'job.control', { id: `${S('d')}.job-p`, op: 'resume' })
    expect(r).toMatchObject({ ok: true, jobId: `${S('f')}.job-new`, kept: 'It carries on from claude/task-route, with its conversation.' })
    expect(startedTasks.at(-1)).toEqual({ kind: 'task', repository: REPO, request: 'Route the board', requestedBy: USER.email, requestedBySub: USER.sub, agent: 'impl', branch: 'claude/task-route', resume: { job: 'job-p', by: USER.email } })
    expect(await run(USER, 'job.control', { id: `p${H}.trace-acme-jobs-5-abcdef1234567890.job-wi`, op: 'pause' })).toMatchObject({ ok: false, reason: expect.stringMatching(/workflow's job can only be cancelled/) })
  })

  it('cancels a paused job by discarding it (its branch stays), and a running one on its worker', async () => {
    // a second paused job, not resumed yet
    await jobIndex(ctx(ADMIN), REPO).update((d) => { putJob(d, 'job-p2', { kind: 'task', agent: 'ams', title: 'p2', state: 'paused', session: S('9'), branch: 'claude/task-p2' }, Date.now() / 1000); return { result: null } })
    expect(await run(USER, 'job.control', { id: `${S('9')}.job-p2`, op: 'cancel' })).toMatchObject({ ok: true, state: 'aborted', kept: expect.stringMatching(/claude\/task-p2; it will not be resumed/) })
    const p2 = ((await run(USER, 'jobs.list', { repo: REPO })).jobs as Record<string, unknown>[]).find((j) => j.workerJobId === 'job-p2')
    expect(p2).toMatchObject({ state: 'aborted', controls: [] })
    expect(await run(USER, 'job.control', { id: `${S('a')}.job-run`, op: 'cancel' })).toMatchObject({ ok: true, state: 'aborted' })
  })

  it('needs the contributor part, and answers "no access" for a stranger\'s or an unknown job alike', async () => {
    await expect(run(REVIEWER, 'job.control', { id: `${S('b')}.job-q1`, op: 'cancel' })).rejects.toThrow(AccessDenied)
    await expect(run(OUTSIDER, 'job.control', { id: `${S('b')}.job-q1`, op: 'cancel' })).rejects.toThrow(AccessDenied)
    await expect(run(OUTSIDER, 'job.control', { id: 'trace-api-00000000-000000000000000000000000.job-1', op: 'cancel' })).rejects.toThrow(AccessDenied)
    // a job id of this project with another project named alongside it: no access
    await expect(run(USER, 'job.control', { id: `${S('b')}.job-q1`, op: 'cancel', repo: 'acme/other' })).rejects.toThrow(AccessDenied)
  })
})

describe('the worker invocation', () => {
  it('pause reaches the job\'s own session; a workflow\'s job without a known session cannot be reached', async () => {
    const calls: { session: string; body: Record<string, unknown> }[] = []
    const client = {
      async send(cmd: InvokeAgentRuntimeCommand) {
        const body = JSON.parse(new TextDecoder().decode(cmd.input.payload as Uint8Array)) as Record<string, unknown>
        calls.push({ session: cmd.input.runtimeSessionId ?? '', body })
        return { statusCode: 200, response: { transformToString: async () => JSON.stringify({ ok: true, state: 'running', pausing: true, kept: 'kept' }) } }
      },
    }
    const api = remoteJobs({ runtimes: parseWorkerRuntimes(`${REPO}=trace_w_${H}-AbCdEf1234`), region: 'us-east-1', account: '123456789012', client })
    expect(await api.pause?.(`${S('a')}.job-run`, USER.email)).toEqual({ ok: true, state: 'running', kept: 'kept' })
    expect(calls).toEqual([{ session: S('a'), body: expect.objectContaining({ kind: 'pause', jobId: 'job-run', by: USER.email }) }])
    expect(api.repositoryOf(`p${H}..job-x`)).toBe(REPO)
    expect(await api.cancel?.(`p${H}..job-x`, 'x')).toMatchObject({ ok: false, reason: expect.stringMatching(/does not know where this job runs/) })
  })
})

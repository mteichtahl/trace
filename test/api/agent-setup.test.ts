/**
 * project.agent: whether a project's own agent (its worker runtime) is set up yet, and how its setting up stands, so
 * the web app can say so before a person writes answers that cannot be saved. A project created in the web app gets
 * its agent with the next installation update (projects.create's pending record, src/installer/pending.ts).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { ADDED_CHECK_S, ADDED_MS, LATE_SLACK_MS, LEFT_OUT_MS, SETUP_CHECK_S, STALLED_CHECK_S, SETUP_MS, TYPICAL_MIN_MS, type RunJob, agentSetup, failedJob, logTail, typicalUpdateMs, updateRunFor, updateSteps } from '../../src/api/actions-projects.js'
import type { GitHubApi, RunSummary } from '../../src/api/github.js'
import { parseWorkerRuntimes, remoteJobs } from '../../src/api/workers.js'
import { AccessDenied, assign, seen } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { Registry } from '../../src/core/registry.js'
import type { PendingRecord } from '../../src/installer/pending.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const NOW = Date.parse('2026-11-02T10:00:00Z')
const REQUESTED = '2026-11-02T09:40:00.000Z'
const rec = (o: Partial<PendingRecord> = {}): PendingRecord => ({ repo: 'acme/new', requested_at: REQUESTED, status: 'pending', attempts: 0, ...o })
const run = (o: Partial<RunSummary> = {}): RunSummary => ({
  id: 1, name: 'ci', path: '.github/workflows/ci.yml', event: 'workflow_dispatch', status: 'in_progress', conclusion: null, branch: 'main',
  url: 'https://github.com/mteichtahl/trace/actions/runs/1', created_at: '2026-11-02T09:41:00Z', ...o,
})

describe('agentSetup', () => {
  const base = { repo: 'acme/new', hasAgent: false, record: rec(), run: null, selfUpdate: true, admin: false, now: NOW }

  it('a project with its runtime is ready, and nothing is looked at again', () => {
    expect(agentSetup({ ...base, hasAgent: true })).toMatchObject({ ready: true, state: 'ready', next_check_s: null })
  })

  it('waiting for the update: says what is happening, about when it is ready (an hour from the update starting) and when to look again', () => {
    const queued = agentSetup({ ...base, run: run({ status: 'queued' }) })
    expect(queued).toMatchObject({ ready: false, state: 'setting_up', update: { status: 'queued' }, next_check_s: SETUP_CHECK_S })
    expect(queued.text).toMatch(/waiting for its turn to start; once it starts it usually takes under an hour/)
    const running = agentSetup({ ...base, run: run() })
    expect(running.text).toMatch(/is running: it is adding this project's agent to the installation/)
    expect(running.expected_by).toBe(new Date(Date.parse('2026-11-02T09:41:00Z') + SETUP_MS).toISOString())
    // the run could not be read: from the request, "usually within the hour"
    const asked = agentSetup(base)
    expect(asked.text).toMatch(/usually takes under an hour/)
    expect(asked.expected_by).toBe(new Date(Date.parse(REQUESTED) + SETUP_MS).toISOString())
    // finished: marked added within a minute or so, so looked at sooner
    expect(agentSetup({ ...base, run: run({ status: 'completed', conclusion: 'success' }) })).toMatchObject({ next_check_s: ADDED_CHECK_S, text: expect.stringMatching(/has finished; trace is checking/) })
  })

  it('the estimate is this installation\'s own: how long its recent updates took, not an hour (log #2: it took 15 minutes)', () => {
    const typical = 12 * 60_000
    const running = agentSetup({ ...base, run: run(), typicalMs: typical })
    expect(running.expected_by).toBe(new Date(Date.parse('2026-11-02T09:41:00Z') + typical).toISOString())
    expect(agentSetup({ ...base, run: run({ status: 'queued' }), typicalMs: typical }).text).toMatch(/usually takes about 12 minutes/)
    expect(agentSetup({ ...base, typicalMs: typical }).text).toMatch(/usually takes about 12 minutes/)
    // a little past the estimate is not late yet; well past it is
    const from = Date.parse('2026-11-02T09:41:00Z')
    expect(agentSetup({ ...base, run: run(), typicalMs: typical, now: from + typical + LATE_SLACK_MS / 2 }).text).not.toMatch(/longer than usual/)
    expect(agentSetup({ ...base, run: run(), typicalMs: typical, now: from + typical + LATE_SLACK_MS + 60_000 }).text).toMatch(/longer than usual/)
  })

  it('says when it is taking longer than usual, and when an earlier update with it failed', () => {
    expect(agentSetup({ ...base, run: run(), now: NOW + 2 * SETUP_MS }).text).toMatch(/taking longer than usual/)
    expect(agentSetup({ ...base, record: rec({ attempts: 1 }), run: run() }).text).toMatch(/An earlier update with it failed; this one tries again/)
  })

  it('a failed run, a failed record or no record at all wait for a person: said so, looked at less often', () => {
    const failedRun = agentSetup({ ...base, run: run({ status: 'completed', conclusion: 'failure' }) })
    expect(failedRun).toMatchObject({ state: 'setting_up', update: { status: 'failed' }, next_check_s: STALLED_CHECK_S })
    expect(failedRun.text).toMatch(/update failed.*An admin can start the update again or run the installer/)
    const failed = agentSetup({ ...base, record: rec({ status: 'failed', attempts: 2, last_error: 'cdk deploy: limit' }) })
    expect(failed).toMatchObject({ state: 'failed', next_check_s: STALLED_CHECK_S, expected_by: null })
    expect(failed.text).not.toMatch(/cdk deploy/)
    expect(agentSetup({ ...base, admin: true, record: rec({ status: 'failed', attempts: 2, last_error: 'cdk deploy: limit' }) }).text).toMatch(/last: cdk deploy: limit/)
    expect(agentSetup({ ...base, record: null })).toMatchObject({ state: 'missing', next_check_s: STALLED_CHECK_S })
  })

  it('added by the update: the API picks up the new runtime within minutes, so it is looked at sooner', () => {
    expect(agentSetup({ ...base, record: rec({ status: 'added' }) })).toMatchObject({ state: 'finishing', next_check_s: ADDED_CHECK_S })
  })

  it('added but never ready: the estimate runs from added_at, then it says it is late and looks less often', () => {
    const added = '2026-11-02T09:55:00.000Z'
    const soon = agentSetup({ ...base, record: rec({ status: 'added', added_at: added }) })
    expect(soon).toMatchObject({ state: 'finishing', next_check_s: ADDED_CHECK_S, expected_by: new Date(Date.parse(added) + ADDED_MS).toISOString() })
    const later = agentSetup({ ...base, record: rec({ status: 'added', added_at: added }), now: Date.parse(added) + ADDED_MS + 60_000 })
    expect(later).toMatchObject({ state: 'finishing', next_check_s: STALLED_CHECK_S, expected_by: soon.expected_by })
    expect(later.text).toMatch(/taking longer than usual.*an admin can run the installer/)
  })

  it('the run finished long ago and the request is still pending: the update left it out, said plainly (with the flat limit when that is the layout)', () => {
    const done = run({ status: 'completed', conclusion: 'success', updated_at: '2026-11-02T09:30:00Z' })
    const recently = agentSetup({ ...base, run: { ...done, updated_at: new Date(NOW - LEFT_OUT_MS / 2).toISOString() } })
    expect(recently).toMatchObject({ state: 'setting_up', update: { status: 'finished' } })
    const flat = agentSetup({ ...base, run: done, layout: 'flat' })
    expect(flat).toMatchObject({ state: 'failed', next_check_s: STALLED_CHECK_S })
    expect(flat.text).toMatch(/finished without adding this project's agent\. This installation keeps every project in one stack.*fewer than 15.*An admin can add it by running the installer/)
    const nested = agentSetup({ ...base, run: done, layout: 'nested' })
    expect(nested.text).toBe('The installation update finished without adding this project\'s agent. An admin can add it by running the installer.')
  })

  it('the link to the update\'s run and how to start it again are an admin\'s only', () => {
    const failedRun = run({ status: 'completed', conclusion: 'failure' })
    const reviewer = agentSetup({ ...base, run: failedRun })
    expect(reviewer.update).not.toHaveProperty('url')
    expect(reviewer.text).not.toMatch(/Actions|Run workflow/)
    expect(JSON.stringify(agentSetup({ ...base, run: run() }))).not.toMatch(/github\.com/)
    const admin = agentSetup({ ...base, admin: true, run: failedRun })
    expect(admin.update?.url).toBe(failedRun.url)
    expect(admin.text).toMatch(/Actions → ci → Run workflow/)
  })

  it('without the self-update: the installer adds it, and there is no estimate', () => {
    const r = agentSetup({ ...base, selfUpdate: false })
    expect(r.text).toMatch(/next time an admin runs the installer/)
    expect(r.expected_by).toBeNull()
  })
})

describe('updateRunFor', () => {
  it('the newest ci run on the self-update\'s branch started after the request', () => {
    const runs = [
      run({ id: 1, created_at: '2026-11-02T08:00:00Z' }),
      run({ id: 2, created_at: '2026-11-02T09:45:00Z', branch: 'other' }),
      run({ id: 3, created_at: '2026-11-02T09:42:00Z', path: '.github/workflows/release.yml' }),
      run({ id: 4, created_at: '2026-11-02T09:41:00Z' }),
    ]
    expect(updateRunFor(runs, 'main', REQUESTED)?.id).toBe(4)
    expect(updateRunFor(runs.slice(0, 1), 'main', REQUESTED)).toBeNull()
  })
})

describe('typicalUpdateMs', () => {
  const done = (id: number, created: string, minutes: number, o: Partial<RunSummary> = {}): RunSummary =>
    run({ id, status: 'completed', conclusion: 'success', created_at: created, updated_at: new Date(Date.parse(created) + minutes * 60_000).toISOString(), ...o })

  it('the median of the latest successful update runs, those started by hand (projects.create\'s) first', () => {
    const runs = [
      done(1, '2026-11-01T10:00:00Z', 9), done(2, '2026-11-01T11:00:00Z', 15), done(3, '2026-11-01T12:00:00Z', 11),
      // a push to main runs the tests too: left out while there are runs started by hand
      done(4, '2026-11-01T13:00:00Z', 30, { event: 'push' }),
      // failed, another branch, another workflow: never counted
      done(5, '2026-11-01T14:00:00Z', 2, { conclusion: 'failure' }), done(6, '2026-11-01T14:00:00Z', 2, { branch: 'dev' }),
      done(7, '2026-11-01T14:00:00Z', 2, { path: '.github/workflows/release-images.yml' }),
      run({ id: 8, created_at: '2026-11-01T15:00:00Z' }),
    ]
    expect(typicalUpdateMs(runs, 'main')).toBe(11 * 60_000)
    expect(typicalUpdateMs(runs.filter((r) => r.event === 'push'), 'main')).toBe(30 * 60_000)
  })

  it('none finished, or none with a time: null (the hour); never under a few minutes', () => {
    expect(typicalUpdateMs([run()], 'main')).toBeNull()
    expect(typicalUpdateMs([run({ status: 'completed', conclusion: 'success' })], 'main')).toBeNull()
    expect(typicalUpdateMs([done(1, '2026-11-01T10:00:00Z', 1)], 'main')).toBe(TYPICAL_MIN_MS)
  })
})

describe('the update\'s steps, read from its run\'s jobs', () => {
  const step = (number: number, name: string, status: string, conclusion: string | null = null) => ({ number, name, status, conclusion })
  const jobs: RunJob[] = [
    { id: 11, name: 'typescript', status: 'completed', conclusion: 'success', steps: [step(1, 'Set up job', 'completed', 'success'), step(2, 'npm ci', 'completed', 'success'), step(3, 'Post Run actions/checkout@v4', 'completed', 'success'), step(4, 'Complete job', 'completed', 'success')] },
    { id: 12, name: 'update-installation', status: 'in_progress', conclusion: null, steps: [step(2, 'Deploy', 'queued'), step(1, 'Test', 'in_progress')] },
    { id: 13, name: 'tests pass', status: 'queued', conclusion: null },
  ]

  it('each job\'s steps in order, GitHub\'s bookkeeping left out, named by job when there are several', () => {
    expect(updateSteps(jobs)).toEqual([
      { name: 'typescript › npm ci', state: 'done' },
      { name: 'update-installation › Test', state: 'running' },
      { name: 'update-installation › Deploy', state: 'waiting' },
      { name: 'tests pass', state: 'waiting' },
    ])
    expect(updateSteps(jobs.slice(1, 2)).map((s) => s.name)).toEqual(['Test', 'Deploy'])
    expect(updateSteps([{ id: 1, name: 'x', status: 'completed', conclusion: 'skipped' }])).toEqual([{ name: 'x', state: 'done' }])
  })

  it('a failed step is failed, and its job is the one whose log is read', () => {
    const failing: RunJob[] = [jobs[0]!, { id: 12, name: 'update-installation', status: 'completed', conclusion: 'failure', steps: [step(1, 'Test', 'completed', 'success'), step(2, 'Deploy', 'completed', 'failure')] }]
    expect(updateSteps(failing).at(-1)).toEqual({ name: 'update-installation › Deploy', state: 'failed' })
    expect(failedJob(failing)?.id).toBe(12)
    expect(failedJob(jobs)).toBeNull()
  })

  it('the log\'s last 40 lines, without GitHub\'s timestamps', () => {
    const text = Array.from({ length: 100 }, (_, i) => `2026-11-02T09:50:${String(i % 60).padStart(2, '0')}.1234567Z line ${i}`).join('\r\n') + '\n'
    const tail = logTail(text).split('\n')
    expect(tail).toHaveLength(40)
    expect(tail[0]).toBe('line 60')
    expect(tail.at(-1)).toBe('line 99')
  })

  it('agentSetup gives the steps to everyone and the log to admins only', () => {
    const progress = { steps: updateSteps(jobs), failed_log: 'Error: cdk deploy failed' }
    const base = { repo: 'acme/new', hasAgent: false, record: rec(), run: run({ status: 'completed', conclusion: 'failure' }), selfUpdate: true, now: NOW, progress }
    const user = agentSetup({ ...base, admin: false })
    expect(user.update).toMatchObject({ steps: progress.steps, failed_log: null })
    expect(agentSetup({ ...base, admin: true }).update).toMatchObject({ steps: progress.steps, failed_log: 'Error: cdk deploy failed' })
    expect(agentSetup({ ...base, admin: false, progress: null }).update).not.toHaveProperty('steps')
  })
})

describe('the workers know which projects have an agent', () => {
  it('hasAgent: a project in TRACE_WORKER_RUNTIMES, any case', () => {
    const jobs = remoteJobs({ runtimes: parseWorkerRuntimes('acme/board=trace_w_aaaaaaaa-AbCdEf1234'), region: 'us-east-1', account: '123456789012' })
    expect(jobs.hasAgent?.('Acme/Board')).toBe(true)
    expect(jobs.hasAgent?.('acme/new')).toBe(false)
  })
})

describe('project.agent', () => {
  const ADMIN = { sub: 'ag-admin', email: 'ag-admin@example.com', groups: ['trace-admins'] }
  const USER = { sub: 'ag-user', email: 'ag-user@example.com', groups: ['trace-users'] }
  const REVIEWER = { sub: 'ag-rev', email: 'ag-rev@example.com', groups: ['trace-users'] }
  const OUTSIDER = { sub: 'ag-out', email: 'ag-out@example.com', groups: ['trace-users'] }
  const fake = new FakeGitHub(['acme/new', 'acme/old'])
  let runs: () => Promise<RunSummary[]> = async () => []
  // the update's runs on GitHub, as each test sets them
  const github: GitHubApi = Object.assign(Object.create(fake) as FakeGitHub, { workflowRuns: () => runs() })
  const cognito = new FakeCognito()
  const bucket = mkdtempSync(join(tmpdir(), 'trace-agent-setup-'))
  const deps: ActionDeps = {
    github: async () => github, cognito: () => cognito,
    jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [], hasAgent: (r) => r.toLowerCase() === 'acme/old' }),
    tools: () => new Registry([]), scratch: mkdtempSync(join(tmpdir(), 'trace-agent-setup-s-')), store: (p) => backendFor(join(bucket, p)),
  }
  const call = async (who: Context['principal'], repo: string): Promise<Record<string, unknown>> => (await perform('project.agent', { repo }, { principal: who, deps })).result as Record<string, unknown>
  const before = process.env.TRACE_SELF_UPDATE

  beforeAll(async () => {
    cognito.add(USER.email, USER.sub, 'trace-users')
    cognito.add(REVIEWER.email, REVIEWER.sub, 'trace-users')
    for (const r of ['acme/new', 'acme/old']) await assign(ADMIN, USER, r, { class: 'user' })
    await assign(ADMIN, REVIEWER, 'acme/new', { class: 'user', part: 'reviewer' })
    await seen(USER)
    await seen(REVIEWER)
    mkdirSync(join(bucket, 'installation', 'pending-projects', 'acme'), { recursive: true })
    writeFileSync(join(bucket, 'installation', 'pending-projects', 'acme', 'new.json'), JSON.stringify({ repo: 'acme/new', requested_at: new Date().toISOString(), needs: ['worker runtime'] }))
  })
  afterEach(() => { if (before === undefined) delete process.env.TRACE_SELF_UPDATE; else process.env.TRACE_SELF_UPDATE = before })

  it('has the same access as reading the project: an outsider gets "no access"', async () => {
    await expect(perform('project.agent', { repo: 'acme/new' }, { principal: OUTSIDER, deps })).rejects.toThrow(AccessDenied)
  })

  it('a project with its runtime: ready', async () => {
    expect(await call(USER, 'acme/old')).toMatchObject({ repo: 'acme/old', ready: true, state: 'ready' })
  })

  it('a new project: being set up, from its pending record and the update\'s run on GitHub', async () => {
    process.env.TRACE_SELF_UPDATE = 'mteichtahl/trace@main'
    runs = async () => [run({ created_at: new Date().toISOString() })]
    const r = await call(USER, 'acme/new')
    expect(r).toMatchObject({ ready: false, state: 'setting_up', update: { status: 'running' }, next_check_s: SETUP_CHECK_S })
    expect(r.text).toMatch(/installation update is running/)
    expect(r.update).not.toHaveProperty('url')
    // a reviewer is told how it stands, never given trace's own repository's run or how to start it
    runs = async () => [run({ status: 'completed', conclusion: 'failure', created_at: new Date().toISOString() })]
    const rev = await call(REVIEWER, 'acme/new')
    expect(rev).toMatchObject({ update: { status: 'failed' } })
    expect(rev.update).not.toHaveProperty('url')
    expect(rev.text).not.toMatch(/Actions|Run workflow/)
    expect((await call(ADMIN, 'acme/new')).update).toMatchObject({ url: expect.stringMatching(/^https:\/\/github\.com\//) })
    // the steps come from the run's jobs, and the failed job's log tail to an admin (GitHub's request and requestText)
    const asked: string[] = []
    Object.assign(github, {
      request: async (method: string, path: string) => {
        asked.push(`${method} ${path}`)
        return { jobs: [{ id: 77, name: 'update-installation', status: 'completed', conclusion: 'failure', steps: [{ number: 1, name: 'Deploy', status: 'completed', conclusion: 'failure' }] }] }
      },
      requestText: async (path: string) => { asked.push(`text ${path}`); return { text: 'one\ntwo\nError: limit', truncated: false } },
    })
    const withSteps = await call(ADMIN, 'acme/new')
    expect(withSteps.update).toMatchObject({ steps: [{ name: 'Deploy', state: 'failed' }], failed_log: 'one\ntwo\nError: limit' })
    expect(asked).toEqual([expect.stringMatching(/^GET \/repos\/mteichtahl\/trace\/actions\/runs\/1\/jobs/), 'text /repos/mteichtahl/trace/actions/jobs/77/logs'])
    expect((await call(USER, 'acme/new')).update).toMatchObject({ steps: [{ name: 'Deploy', state: 'failed' }], failed_log: null })
    // GitHub not answering leaves the estimate from the request
    runs = async () => { throw new Error('rate limited') }
    expect(await call(USER, 'acme/new')).toMatchObject({ state: 'setting_up', update: null, expected_by: expect.any(String) })
  })

  it('an installation whose jobs cannot say takes every project as having one', async () => {
    const plain: ActionDeps = { ...deps, jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }) }
    expect((await perform('project.agent', { repo: 'acme/new' }, { principal: USER, deps: plain })).result).toMatchObject({ ready: true })
  })
})

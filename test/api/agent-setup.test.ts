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
import { ADDED_CHECK_S, SETUP_CHECK_S, STALLED_CHECK_S, SETUP_MS, agentSetup, updateRunFor } from '../../src/api/actions-projects.js'
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
    expect(queued.text).toMatch(/queued on GitHub/)
    const running = agentSetup({ ...base, run: run() })
    expect(running.text).toMatch(/is running: it tests trace and then deploys this project's agent/)
    expect(running.expected_by).toBe(new Date(Date.parse('2026-11-02T09:41:00Z') + SETUP_MS).toISOString())
    // the run could not be read: from the request, "usually within the hour"
    const asked = agentSetup(base)
    expect(asked.text).toMatch(/usually within the hour/)
    expect(asked.expected_by).toBe(new Date(Date.parse(REQUESTED) + SETUP_MS).toISOString())
    expect(agentSetup({ ...base, run: run({ status: 'completed', conclusion: 'success' }) }).text).toMatch(/has finished; trace is checking/)
  })

  it('says when it is taking longer than usual, and when an earlier update with it failed', () => {
    expect(agentSetup({ ...base, run: run(), now: NOW + 2 * SETUP_MS }).text).toMatch(/taking longer than usual/)
    expect(agentSetup({ ...base, record: rec({ attempts: 1 }), run: run() }).text).toMatch(/An earlier update with it failed; this one tries again/)
  })

  it('a failed run, a failed record or no record at all wait for a person: said so, looked at less often', () => {
    const failedRun = agentSetup({ ...base, run: run({ status: 'completed', conclusion: 'failure' }) })
    expect(failedRun).toMatchObject({ state: 'setting_up', update: { status: 'failed' }, next_check_s: STALLED_CHECK_S })
    expect(failedRun.text).toMatch(/update failed.*Run workflow.*installer/)
    const failed = agentSetup({ ...base, record: rec({ status: 'failed', attempts: 2, last_error: 'cdk deploy: limit' }) })
    expect(failed).toMatchObject({ state: 'failed', next_check_s: STALLED_CHECK_S, expected_by: null })
    expect(failed.text).not.toMatch(/cdk deploy/)
    expect(agentSetup({ ...base, admin: true, record: rec({ status: 'failed', attempts: 2, last_error: 'cdk deploy: limit' }) }).text).toMatch(/last: cdk deploy: limit/)
    expect(agentSetup({ ...base, record: null })).toMatchObject({ state: 'missing', next_check_s: STALLED_CHECK_S })
  })

  it('added by the update: the API picks up the new runtime within minutes, so it is looked at sooner', () => {
    expect(agentSetup({ ...base, record: rec({ status: 'added' }) })).toMatchObject({ state: 'finishing', next_check_s: ADDED_CHECK_S })
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
    for (const r of ['acme/new', 'acme/old']) await assign(ADMIN, USER, r, { class: 'user' })
    await seen(USER)
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
    // GitHub not answering leaves the estimate from the request
    runs = async () => { throw new Error('rate limited') }
    expect(await call(USER, 'acme/new')).toMatchObject({ state: 'setting_up', update: null, expected_by: expect.any(String) })
  })

  it('an installation whose jobs cannot say takes every project as having one', async () => {
    const plain: ActionDeps = { ...deps, jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }) }
    expect((await perform('project.agent', { repo: 'acme/new' }, { principal: USER, deps: plain })).result).toMatchObject({ ready: true })
  })
})

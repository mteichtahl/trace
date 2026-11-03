/**
 * The build's health (src/api/actions-health.ts): health.get from fake GitHub answers (passing; failing, with
 * ci-doctor's judgement and without; running after a failure), trace's work item on it with its attempt, the open
 * requests for a fix with the job on each and the ones trace gave up on; health.log's 200 KB cap and its refusal of a
 * job from another repository; who may read them; and the few GitHub calls a look costs, kept a short while.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, type JobsApi, perform } from '../../src/api/actions.js'
import { jobIndex } from '../../src/api/actions-jobs.js'
import { LOG_MAX, buildState, cleanLog, doctorWords, failingJobs, logTail, stepWords } from '../../src/api/actions-health.js'
import { agentFactsStore } from '../../src/api/action-kit.js'
import { GitHubError } from '../../src/api/github.js'
import { GitHubCache } from '../../src/api/github-cache.js'
import { AccessDenied, assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { indexedHandle, putJob } from '../../src/core/job-index.js'
import { projectHash } from '../../src/core/project.js'
import { syncStuckWork } from '../../src/core/stuck-work.js'
import { Registry } from '../../src/core/registry.js'
import { SERVICE_ACTIONS } from '../../src/api/service-policy.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'h-admin', email: 'h-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'h-user', email: 'h-user@example.com', groups: ['trace-users'] }
const OUTSIDER = { sub: 'h-out', email: 'h-out@example.com', groups: ['trace-users'] }
const REPO = 'acme/health'
const P = '/repos/acme/health'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

/** A GitHub with the generic calls answered from a table of paths (prefix match on the path without its query). */
class HealthGitHub extends FakeGitHub {
  answers = new Map<string, unknown>()
  texts = new Map<string, string>()
  asked: string[] = []
  async request(method: string, path: string): Promise<unknown> {
    this.asked.push(`${method} ${path}`)
    const bare = path.split('?')[0]!
    const a = this.answers.get(bare)
    if (a === undefined) throw new GitHubError(404, `GitHub ${method} ${bare}: 404`)
    return a
  }
  async requestText(path: string, max: number): Promise<{ text: string; truncated: boolean }> {
    this.asked.push(`TEXT ${path}`)
    const t = this.texts.get(path)
    if (t === undefined) throw new GitHubError(404, 'gone')
    const b = Buffer.from(t)
    return b.length > max ? { text: b.subarray(b.length - max).toString('utf8'), truncated: true } : { text: t, truncated: false }
  }
}

const github = new HealthGitHub([REPO])
const scratch = mkdtempSync(join(tmpdir(), 'trace-health-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-health-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })
const H = projectHash(REPO)
const jobsApi: JobsApi = { repositoryOf: () => REPO, startJob: async () => ({ accepted: true, jobId: 'x' }), jobStatus: async () => [] }
const deps: ActionDeps = { github: async () => github, cognito: () => new FakeCognito(), jobs: async () => jobsApi, tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)) }
const ctx = (principal: Context['principal'], d: Partial<ActionDeps> = {}): Context => ({ principal, deps: { ...deps, ...d } })
const run = async (who: Context['principal'], action: string, args: Record<string, unknown>, d: Partial<ActionDeps> = {}): Promise<Record<string, unknown>> =>
  (await perform(action, args, ctx(who, d))).result as Record<string, unknown>

const runRow = (id: number, sha: string, o: Record<string, unknown> = {}) => ({ id, event: 'push', status: 'completed', conclusion: 'success', head_sha: sha, head_branch: 'main', created_at: `2026-11-03T0${id % 10}:00:00Z`, ...o })
const LOG = [
  '2026-11-03T01:00:00.0000000Z ##[group]Run kicad-cli sch erc',
  '2026-11-03T01:00:01.0000000Z Checking power.kicad_sch',
  '2026-11-03T01:00:02.0000000Z \x1b[31mERC: pin 4 of U3 is not connected\x1b[0m',
  '2026-11-03T01:00:03.0000000Z ##[error]Process completed with exit code 1.',
  '2026-11-03T01:00:04.0000000Z Post job cleanup.',
].join('\n')
const DOCTOR_BODY = `The build failed on ${SHA_A.slice(0, 12)} ([run](https://github.com/acme/health/actions/runs/3), attempt 1).\n\n- [erc](https://github.com/acme/health/actions/runs/3/job/31): real (step "Run ERC")\n\nThe worker picks this up (fix, validate, push).\n<!-- trace: ci-doctor default-branch -->`

function failingBuild(): void {
  github.answers.set(`${P}/actions/workflows/build.yml/runs`, { workflow_runs: [runRow(3, SHA_A, { conclusion: 'failure' }), runRow(2, 'c'.repeat(40)), runRow(1, 'd'.repeat(40), { event: 'pull_request', conclusion: 'failure' })] })
  github.answers.set(`${P}/actions/runs/3/jobs`, { jobs: [
    { id: 31, name: 'erc', status: 'completed', conclusion: 'failure', steps: [{ name: 'Set up job', status: 'completed', conclusion: 'success' }, { name: 'Run ERC', status: 'completed', conclusion: 'failure' }] },
    { id: 32, name: 'tests pass', status: 'completed', conclusion: 'failure', steps: [{ name: 'gate', status: 'completed', conclusion: 'failure' }] },
    { id: 33, name: 'drc', status: 'completed', conclusion: 'success', steps: [] },
  ] })
  github.texts.set(`${P}/actions/jobs/31/logs`, LOG)
}

beforeAll(async () => {
  await assign(ADMIN, USER, REPO, { class: 'user' })
  const now = Date.now() / 1000
  await jobIndex(ctx(ADMIN), REPO).update((d) => {
    putJob(d, 'job-fix', { kind: 'work-item', agent: 'impl', title: 'Issue #9: Build failing on main', number: 9, state: 'running', session: 'trace-acme-health-9-abcdef1234567890', startedAt: Date.parse('2026-11-03T04:00:00Z') / 1000, beatAt: now }, now)
    putJob(d, 'job-old', { kind: 'work-item', agent: 'impl', title: 'Issue #9: Build failing on main', number: 9, state: 'failed', startedAt: Date.parse('2026-11-03T01:00:00Z') / 1000, endedAt: now - 600 }, now - 600)
    putJob(d, 'job-ask', { kind: 'work-item', agent: 'verify', title: 'Issue #11: Check the LDO', number: 11, state: 'queued', session: 'trace-acme-health-11-abcdef1234567890', queuedAt: now - 30 }, now)
    return { result: null }
  })
  await agentFactsStore(ctx(ADMIN), REPO).update((d) => ({ result: syncStuckWork(d, [{ kind: 'agent-fix', number: 12, sha: 'issue', title: 'Rename the nets', attempts: 3, lastReport: null }]) }))
})

beforeEach(() => {
  github.answers.clear(); github.texts.clear(); github.asked = []
  github.answers.set(`${P}/issues`, [
    { number: 9, title: 'Build failing on main (push)', body: DOCTOR_BODY, created_at: '2026-11-03T03:05:00Z' },
    { number: 11, title: 'Check the LDO', body: 'please', created_at: '2026-11-02T10:00:00Z' },
    { number: 12, title: 'Rename the nets', body: null, created_at: '2026-11-02T11:00:00Z' },
    { number: 13, title: 'Add a test point', body: '', created_at: '2026-11-02T12:00:00Z' },
    { number: 14, title: 'a pull request', created_at: '2026-11-02T12:00:00Z', pull_request: {} },
  ])
})

describe('the rules', () => {
  it('the build stands where its newest run on the default branch is; a run in progress keeps the failure before it', () => {
    const r = (id: number, o: Record<string, unknown>) => ({ id, event: 'push', status: 'completed', head_sha: String(id), created_at: `2026-11-0${id}T00:00:00Z`, ...o })
    expect(buildState([]).state).toBe('none')
    expect(buildState([r(2, { conclusion: 'success' })])).toMatchObject({ state: 'passing', shown: null })
    expect(buildState([r(3, { status: 'in_progress', conclusion: null }), r(2, { conclusion: 'failure' })])).toMatchObject({ state: 'running', latest: { id: 3 }, shown: { id: 2 } })
    expect(buildState([r(3, { status: 'queued', conclusion: null }), r(2, { conclusion: 'success' })])).toMatchObject({ state: 'running', shown: null })
    // a cancelled run says nothing: the one before it decides
    expect(buildState([r(3, { conclusion: 'cancelled' }), r(2, { conclusion: 'failure' })])).toMatchObject({ state: 'failing', shown: { id: 2 } })
  })

  it('the summary gate is left out unless it alone failed; the step and the log in plain words', () => {
    const j = (name: string, conclusion: string) => ({ id: 1, name, status: 'completed', conclusion })
    expect(failingJobs([j('erc', 'failure'), j('tests pass', 'failure')], 'tests pass').map((x) => x.name)).toEqual(['erc'])
    expect(failingJobs([j('tests pass', 'failure')], 'tests pass').map((x) => x.name)).toEqual(['tests pass'])
    expect(stepWords([{ name: 'erc', step: 'Run ERC' }, { name: 'drc', step: null }])).toBe('The "erc" job failed at its step "Run ERC". One other job failed too.')
    expect(stepWords([{ name: 'erc', step: null }])).toMatch(/before it started a step/)
    expect(logTail(LOG)).toBe('Run kicad-cli sch erc\nChecking power.kicad_sch\nERC: pin 4 of U3 is not connected\nError: Process completed with exit code 1.')
    expect(logTail(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')).split('\n')).toHaveLength(40)
    expect(cleanLog('##[endgroup]\nx')).toEqual(['x'])
  })

  it('reads ci-doctor\'s judgement of the very commit, and keeps no link', () => {
    expect(doctorWords([DOCTOR_BODY], SHA_A)).toBe('trace looked at the failure: "erc" failed at its step "Run ERC". It is a problem in the project itself, not in the machines that build it.')
    expect(doctorWords([DOCTOR_BODY], SHA_B)).toBeNull()
    const flaky = DOCTOR_BODY.replace('real (step "Run ERC")', 'flaky (ECONNRESET)').replace('The worker', 'It looked flaky but failed again after a re-run, so it is treated as real.\n\nThe worker')
    expect(doctorWords([flaky], SHA_A)).toMatch(/outside the design \(ECONNRESET\).*failed again when run once more/)
    expect(doctorWords([DOCTOR_BODY], SHA_A)).not.toMatch(/github\.com/)
  })
})

describe('health.get', () => {
  it('passing: nothing failing, nothing fixing; the open requests with where each stands', async () => {
    github.answers.set(`${P}/actions/workflows/build.yml/runs`, { workflow_runs: [runRow(4, SHA_B)] })
    const h = await run(USER, 'health.get', { repo: REPO })
    expect(h.build).toEqual({ state: 'passing', sha: SHA_B, at: '2026-11-03T04:00:00Z', failing: [], why: null, fixing: null })
    expect(h.asks).toEqual([
      { number: 11, title: 'Check the LDO', state: 'working', job_id: `p${H}.trace-acme-health-11-abcdef1234567890.job-ask`, opened_at: '2026-11-02T10:00:00Z' },
      { number: 12, title: 'Rename the nets', state: 'stuck', job_id: null, opened_at: '2026-11-02T11:00:00Z' },
      { number: 13, title: 'Add a test point', state: 'waiting', job_id: null, opened_at: '2026-11-02T12:00:00Z' },
    ])
    // the runs, the requests: two GitHub calls (and no job's log)
    expect(github.asked.filter((x) => x.startsWith('GET'))).toHaveLength(2)
  })

  it('failing: the failing job and step, its log extract, ci-doctor\'s words, and trace\'s work item with its attempt', async () => {
    failingBuild()
    const h = await run(USER, 'health.get', { repo: REPO })
    expect(h.build).toMatchObject({
      state: 'failing', sha: SHA_A,
      failing: [{ job_id: 31, name: 'erc', step: 'Run ERC', tail: expect.stringMatching(/ERC: pin 4 of U3 is not connected\nError: Process completed with exit code 1\.$/) }],
      why: expect.stringMatching(/^trace looked at the failure: "erc" failed at its step "Run ERC"\./),
      fixing: { job_id: indexedHandle(REPO, 'trace-acme-health-9-abcdef1234567890', 'job-fix'), attempt: 1, of: 3 },
    })
    expect((h.asks as { number: number }[]).map((a) => a.number)).toEqual([11, 12, 13])
  })

  it('failing without a ci-doctor note: the failing step in plain words', async () => {
    failingBuild()
    github.answers.set(`${P}/issues`, [])
    const h = await run(USER, 'health.get', { repo: REPO })
    expect(h.build).toMatchObject({ state: 'failing', why: 'The "erc" job failed at its step "Run ERC".', fixing: null })
  })

  it('running after a failure: the failure stays shown while trace\'s fix is built', async () => {
    failingBuild()
    const runs = github.answers.get(`${P}/actions/workflows/build.yml/runs`) as { workflow_runs: unknown[] }
    github.answers.set(`${P}/actions/workflows/build.yml/runs`, { workflow_runs: [runRow(5, SHA_B, { status: 'in_progress', conclusion: null }), ...runs.workflow_runs] })
    const h = await run(USER, 'health.get', { repo: REPO })
    expect(h.build).toMatchObject({ state: 'running', sha: SHA_B, failing: [{ name: 'erc' }], fixing: { attempt: 1 } })
  })

  it('a repository without the build workflow yet: none', async () => {
    const h = await run(USER, 'health.get', { repo: REPO })
    expect(h.build).toMatchObject({ state: 'none', sha: null, failing: [] })
  })

  it('keeps GitHub\'s answers a short while: a second look costs nothing', async () => {
    failingBuild()
    const cache = new GitHubCache()
    await run(USER, 'health.get', { repo: REPO }, { githubCache: cache })
    const n = github.asked.length
    await run(USER, 'health.get', { repo: REPO }, { githubCache: cache })
    expect(github.asked.length).toBe(n)
  })

  it('refuses a stranger and a project that does not exist alike; a connected system may read it', async () => {
    await expect(run(OUTSIDER, 'health.get', { repo: REPO })).rejects.toThrow(AccessDenied)
    await expect(run(OUTSIDER, 'health.get', { repo: 'acme/nope' })).rejects.toThrow(AccessDenied)
    expect(SERVICE_ACTIONS['health.get']).toBe('read')
    expect(SERVICE_ACTIONS['health.log']).toBe('read')
  })
})

describe('health.log', () => {
  it('answers a job\'s log, at most its last 200 KB, cleaned', async () => {
    github.answers.set(`${P}/actions/jobs/31`, { id: 31, name: 'erc', status: 'completed', conclusion: 'failure', run_url: `https://api.github.com${P}/actions/runs/3` })
    github.texts.set(`${P}/actions/jobs/31/logs`, `${'x'.repeat(LOG_MAX)}\n${LOG}`)
    const l = await run(USER, 'health.log', { repo: REPO, job_id: 31 })
    expect(l.name).toBe('erc')
    expect(l.truncated).toBe(true)
    expect(String(l.text).length).toBeLessThanOrEqual(LOG_MAX)
    expect(String(l.text)).toMatch(/Error: Process completed with exit code 1\./)
    github.texts.set(`${P}/actions/jobs/31/logs`, LOG)
    expect(await run(USER, 'health.log', { repo: REPO, job_id: 31 })).toMatchObject({ truncated: false, text: expect.stringMatching(/^Run kicad-cli sch erc\n/) })
  })

  it('refuses a job from another repository\'s runs, and one GitHub does not know', async () => {
    github.answers.set(`${P}/actions/jobs/77`, { id: 77, name: 'secret', status: 'completed', run_url: 'https://api.github.com/repos/other/private/actions/runs/1' })
    github.texts.set(`${P}/actions/jobs/77/logs`, 'not yours')
    await expect(run(USER, 'health.log', { repo: REPO, job_id: 77 })).rejects.toThrow(`${REPO} has no build job 77.`)
    expect(github.asked).not.toContain(`TEXT ${P}/actions/jobs/77/logs`)
    await expect(run(USER, 'health.log', { repo: REPO, job_id: 78 })).rejects.toThrow(`${REPO} has no build job 78.`)
  })
})

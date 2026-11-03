/**
 * What trace is doing (src/api/actions-progress.ts): a change's checks with their live steps, the newest line of a
 * check on CodeBuild, a check's log while it runs (its stream) and once it ended (GitHub's), a job's log (its stream,
 * else the index's last lines), a tool run's log and when it has ended, everything running across a person's projects,
 * secrets masked, the CloudWatch link for admins only, and who may read any of it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, type JobsApi, perform } from '../../src/api/actions.js'
import { jobIndex } from '../../src/api/actions-jobs.js'
import { stepsOf, streamForJob } from '../../src/api/actions-progress.js'
import { GitHubError, type PullStatus } from '../../src/api/github.js'
import { GitHubCache } from '../../src/api/github-cache.js'
import { type RawEvent, memoryRunLogs } from '../../src/api/run-logs-reader.js'
import { AccessDenied, assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { putJob } from '../../src/core/job-index.js'
import { PROJECTS_PREFIX } from '../../src/core/project.js'
import { quietStepKey, readQuiet } from '../../src/core/quiet.js'
import { checkStream, jobStream, toolStream } from '../../src/core/run-logs.js'
import { Registry } from '../../src/core/registry.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'pg-admin', email: 'pg-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'pg-user', email: 'pg-user@example.com', groups: ['trace-users'] }
const OUTSIDER = { sub: 'pg-out', email: 'pg-out@example.com', groups: ['trace-users'] }
const REPO = 'acme/progress'
const P = '/repos/acme/progress'
const SHA = 'e'.repeat(40)

class ProgressGitHub extends FakeGitHub {
  answers = new Map<string, unknown>()
  texts = new Map<string, string>()
  asked: string[] = []
  pulls = new Map<number, PullStatus>()
  async request(method: string, path: string): Promise<unknown> {
    this.asked.push(`${method} ${path}`)
    const full = this.answers.get(path)
    if (full !== undefined) return full
    const a = this.answers.get(path.split('?')[0]!)
    if (a === undefined) throw new GitHubError(404, `GitHub ${method} ${path}: 404`)
    return a
  }
  async requestText(path: string): Promise<{ text: string; truncated: boolean }> {
    this.asked.push(`TEXT ${path}`)
    const t = this.texts.get(path)
    if (t === undefined) throw new GitHubError(404, 'gone')
    return { text: t, truncated: false }
  }
  override async pullStatus(_repo: string, number: number): Promise<PullStatus | null> { return this.pulls.get(number) ?? null }
}

const github = new ProgressGitHub([REPO])
const scratch = mkdtempSync(join(tmpdir(), 'trace-progress-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-progress-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })
const streams = new Map<string, RawEvent[]>()
const logs = memoryRunLogs(streams)
let toolCalls: unknown[] = []
const jobsApi: JobsApi = { repositoryOf: () => REPO, startJob: async () => ({ accepted: true, jobId: 'x' }), jobStatus: async () => [], runTool: async (p) => { toolCalls.push(p); return { ok: true } } }
const deps: ActionDeps = {
  github: async () => github, cognito: () => new FakeCognito(), jobs: async () => jobsApi, tools: () => new Registry([]), scratch,
  store: (p) => backendFor(join(bucket, p)), runLogs: () => logs,
}
const ctx = (principal: Context['principal'], d: Partial<ActionDeps> = {}): Context => ({ principal, deps: { ...deps, ...d } })
const run = async (who: Context['principal'], action: string, args: Record<string, unknown>, d: Partial<ActionDeps> = {}): Promise<Record<string, unknown>> =>
  (await perform(action, args, ctx(who, d))).result as Record<string, unknown>

const now = Date.now()
const ago = (s: number): string => new Date(now - s * 1000).toISOString()
const ev = (sAgo: number, text: string): RawEvent => ({ at: now - sAgo * 1000, text })

function pull(): void {
  github.pulls.set(212, { number: 212, title: 'Move U4', url: '', state: 'open', draft: false, mergeable: 'unknown', head: 'claude/x', sha: SHA, updated_at: ago(60), checks: { total: 3, passed: 1, failed: 0, running: 2, skipped: 0, failing: [] } })
  github.answers.set(`${P}/actions/runs?head_sha=${SHA}&per_page=50`, { workflow_runs: [
    { id: 70, name: 'build', path: '.github/workflows/build.yml', workflow_id: 7, run_attempt: 1, status: 'in_progress', head_sha: SHA, head_branch: 'claude/x', created_at: ago(300), pull_requests: [{ number: 212 }] },
    { id: 71, name: 'trace PRs', path: '.github/workflows/trace-prs.yml', workflow_id: 8, run_attempt: 1, status: 'in_progress', head_sha: SHA, created_at: ago(300), pull_requests: [] },
  ] })
  github.answers.set(`${P}/actions/runs/70/jobs`, { jobs: [
    { id: 701, run_id: 70, run_attempt: 1, name: 'check', status: 'in_progress', created_at: ago(200), started_at: ago(180), labels: ['codebuild-trace-ci-abc-70-1', 'check'], run_url: `https://api.github.com${P}/actions/runs/70`,
      steps: [
        { name: 'Set up job', status: 'completed', conclusion: 'success', started_at: ago(180), completed_at: ago(178) },
        { name: 'Run tracectl check', status: 'in_progress', started_at: ago(170) },
        { name: 'Post job cleanup', status: 'queued' },
      ] },
    { id: 702, run_id: 70, run_attempt: 1, name: 'simulation', status: 'queued', created_at: ago(40), labels: ['ubuntu-24.04'], steps: [] },
    { id: 703, run_id: 70, run_attempt: 1, name: 'tests pass', status: 'completed', conclusion: 'success', started_at: ago(250), completed_at: ago(202), labels: ['ubuntu-24.04'], run_url: `https://api.github.com${P}/actions/runs/70`, steps: [] },
  ] })
  github.answers.set(`${P}/actions/workflows/7/runs`, { workflow_runs: [{ id: 60, status: 'completed', conclusion: 'success', head_sha: 'f'.repeat(40), created_at: ago(9000) }] })
  github.answers.set(`${P}/actions/runs/60/jobs`, { jobs: [{ id: 601, run_id: 60, name: 'check', status: 'completed', conclusion: 'success', started_at: ago(9000), completed_at: ago(8640), labels: [] }] })
}

beforeAll(async () => {
  await assign(ADMIN, USER, REPO, { class: 'user' })
  const t = Date.now() / 1000
  await jobIndex(ctx(ADMIN), REPO).update((d) => {
    putJob(d, 'job-route', { kind: 'task', agent: 'impl', title: 'Routing the board', state: 'running', session: null, startedAt: t - 600, beatAt: t - 5, step: 'OrthoRoute on the dense core' }, t)
    putJob(d, 'job-old', { kind: 'task', agent: 'verify', title: 'Old check', state: 'succeeded', startedAt: t - 9000, endedAt: t - 8000, tail: JSON.stringify(['2026-11-03T10:00:00.000Z checked R14', 'done']) }, t - 8000)
    return { result: null }
  })
})

beforeEach(() => {
  github.answers.clear(); github.texts.clear(); github.asked = []; github.pulls.clear(); streams.clear(); toolCalls = []
  pull()
})

describe('pure helpers', () => {
  it('says which step a job is on, between steps too', () => {
    expect(stepsOf({ status: 'in_progress', steps: [{ name: 'a', status: 'completed', conclusion: 'success' }, { name: 'b', status: 'in_progress' }] }).stepIndex).toBe(2)
    expect(stepsOf({ status: 'in_progress', steps: [{ name: 'a', status: 'completed', conclusion: 'success' }, { name: 'b', status: 'queued' }] }).step).toBe('b')
    expect(stepsOf({ status: 'completed', steps: [{ name: 'a', status: 'completed', conclusion: 'failure' }] }).steps[0]!.state).toBe('failed')
  })
  it('finds a job\'s stream by its key, its name, or its matrix name', () => {
    const names = [checkStream(REPO, 1, 1, 'check'), checkStream(REPO, 1, 1, 'tests-pass')]
    expect(streamForJob(names, 'check')).toBe(names[0])
    expect(streamForJob(names, 'tests pass')).toBe(names[1])
    expect(streamForJob([checkStream(REPO, 1, 1, 'build')], 'build (rust)')).toBe(checkStream(REPO, 1, 1, 'build'))
    expect(streamForJob(names, 'deploy')).toBeNull()
  })
})

describe('change.runs', () => {
  it('lists the checks with their steps, usual length and newest line, without trace\'s own loop', async () => {
    streams.set(checkStream(REPO, 70, 1, 'check'), [ev(30, '▸ Design rule check'), ev(2, 'drc: 1,204 of 2,480 items checked, token=ghp_abcdefghijklmnopqrstuvwx')])
    const r = await run(USER, 'change.runs', { repo: REPO, number: 212 }) as { sha: string; jobs: Record<string, unknown>[] }
    expect(r.sha).toBe(SHA)
    expect(r.jobs.map((j) => [j.name, j.state])).toEqual([['check', 'running'], ['simulation', 'queued'], ['tests pass', 'passed']])
    const check = r.jobs[0]!
    expect(check).toMatchObject({ run: 'check:701', step: 'Run tracectl check', stepIndex: 2, stepCount: 3, typicalS: 360, runner: 'aws', usualQuietS: 120 })
    expect(check.newest).toMatch(/^drc: 1,204 of 2,480 items checked/)
    expect(check.newest).not.toContain('ghp_')
    expect(check.heardAt).toBe(new Date(now - 2000).toISOString())
    expect(r.jobs[1]!.queuedS).toBeGreaterThanOrEqual(39)
    expect(github.asked.some((a) => a.includes('/runs/71/'))).toBe(false)
  })
  it('is refused to someone not on the project', async () => {
    await expect(run(OUTSIDER, 'change.runs', { repo: REPO, number: 212 })).rejects.toBeInstanceOf(AccessDenied)
  })
})

describe('run.log', () => {
  it('reads a running check\'s stream from a cursor, and the CloudWatch link only for admins', async () => {
    streams.set(checkStream(REPO, 70, 1, 'check'), [ev(30, '▸ Design rule check'), ev(20, 'drc: 412 of 2,480'), ev(2, '⚠ silkscreen over mask')])
    github.answers.set(`${P}/actions/jobs/701`, (await github.request('GET', `${P}/actions/runs/70/jobs`) as { jobs: unknown[] }).jobs[0])
    const a = await run(USER, 'run.log', { repo: REPO, run: 'check:701', limit: 2 }) as { lines: { text: string; mark: string | null }[]; next: string; done: boolean; source: string; step: string; cloudwatch?: string }
    expect(a.source).toBe('cloudwatch')
    expect(a.lines.map((l) => l.text)).toEqual(['▸ Design rule check', 'drc: 412 of 2,480'])
    expect(a.done).toBe(false)
    expect(a.step).toBe('Run tracectl check')
    expect(a.cloudwatch).toBeUndefined()
    const b = await run(ADMIN, 'run.log', { repo: REPO, run: 'check:701', after: a.next }) as { lines: { mark: string | null }[]; cloudwatch?: string }
    expect(b.lines.map((l) => l.mark)).toEqual(['warn'])
    expect(b.cloudwatch).toMatch(/^https:\/\/us-east-1\.console\.aws\.amazon\.com\/cloudwatch\//)
  })
  it('gives a finished check GitHub\'s whole log, and learns its quiet', async () => {
    github.answers.set(`${P}/actions/jobs/703`, { id: 703, run_id: 70, name: 'tests pass', status: 'completed', conclusion: 'success', started_at: ago(250), completed_at: ago(202), labels: [], run_url: `https://api.github.com${P}/actions/runs/70` })
    github.texts.set(`${P}/actions/jobs/703/logs`, ['2026-11-03T01:00:00.0000000Z ##[group]Run gate', '2026-11-03T01:00:30.0000000Z all passed'].join('\n'))
    const r = await run(USER, 'run.log', { repo: REPO, run: 'check:703' }) as { source: string; lines: { text: string }[]; done: boolean }
    expect(r).toMatchObject({ source: 'github', done: true })
    expect(r.lines.map((l) => l.text)).toEqual(['##[group]Run gate', 'all passed'])
    await new Promise((res) => { setTimeout(res, 50) })
    const q = await readQuiet(backendFor(join(bucket, PROJECTS_PREFIX)), REPO)
    expect(q.steps[quietStepKey('check', 'tests pass', 'Run gate')]).toEqual([30])
  })
  it('says why a check on GitHub\'s machines has no lines yet', async () => {
    github.answers.set(`${P}/actions/jobs/705`, { id: 705, run_id: 70, name: 'lint', status: 'in_progress', labels: ['ubuntu-24.04'], steps: [], run_url: `https://api.github.com${P}/actions/runs/70` })
    const r = await run(USER, 'run.log', { repo: REPO, run: 'check:705' }) as { source: string; note: string; done: boolean }
    expect(r).toMatchObject({ source: 'none', done: false })
    expect(r.note).toMatch(/arrives when it finishes/)
  })
  it('refuses a check of another repository', async () => {
    github.answers.set(`${P}/actions/jobs/9`, { id: 9, run_id: 1, name: 'x', status: 'completed', labels: [], run_url: 'https://api.github.com/repos/evil/other/actions/runs/1' })
    await expect(run(USER, 'run.log', { repo: REPO, run: 'check:9' })).rejects.toThrow(/no check 9/)
  })
  it('reads a job\'s stream, by the API\'s handle or the worker\'s id', async () => {
    streams.set(jobStream(REPO, 'job-route'), [ev(60, '▸ Routing the board'), ev(5, 'OrthoRoute: 48 of 62 nets')])
    const r = await run(USER, 'run.log', { repo: REPO, run: 'job:pabc.sess.job-route' }) as { source: string; lines: unknown[]; done: boolean; step: string }
    expect(r).toMatchObject({ source: 'cloudwatch', done: false, step: 'OrthoRoute on the dense core' })
    expect(r.lines).toHaveLength(2)
  })
  it('falls back to the index\'s last lines for a job with no stream', async () => {
    const r = await run(USER, 'run.log', { repo: REPO, run: 'job:job-old' }) as { source: string; lines: { at: string; text: string }[]; done: boolean }
    expect(r.source).toBe('tail')
    expect(r.lines.map((l) => l.text)).toEqual(['checked R14', 'done'])
    expect(r.lines[0]!.at).toBe('2026-11-03T10:00:00.000Z')
    expect(r.done).toBe(true)
  })
  it('reads a tool run and knows when it has ended', async () => {
    streams.set(toolStream(REPO, 't1abcdefg01234567'), [ev(10, '▸ sim.transient'), ev(5, 'ngspice: t = 6.2 ms of 10 ms')])
    const running = await run(USER, 'run.log', { repo: REPO, run: 'tool:t1abcdefg01234567' }) as { done: boolean; step: string }
    expect(running).toMatchObject({ done: false, step: 'sim.transient' })
    streams.get(toolStream(REPO, 't1abcdefg01234567'))!.push(ev(1, '✓ done in 9 s'))
    expect((await run(USER, 'run.log', { repo: REPO, run: 'tool:t1abcdefg01234567' }) as { done: boolean }).done).toBe(true)
  })
  it('is refused to someone not on the project, and refuses a malformed run', async () => {
    await expect(run(OUTSIDER, 'run.log', { repo: REPO, run: 'job:job-route' })).rejects.toBeInstanceOf(AccessDenied)
    await expect(run(USER, 'run.log', { repo: REPO, run: 'check:abc' })).rejects.toThrow(/job:<id>/)
  })
})

describe('activity.list', () => {
  it('lists running checks, jobs and tool calls on the person\'s projects', async () => {
    github.answers.set(`${P}/actions/runs?status=in_progress&per_page=20`, { workflow_runs: [
      { id: 70, name: 'build', path: '.github/workflows/build.yml', workflow_id: 7, run_attempt: 1, status: 'in_progress', head_sha: SHA, head_branch: 'claude/x', created_at: ago(300), pull_requests: [{ number: 212 }] },
      { id: 71, name: 'trace PRs', path: '.github/workflows/trace-prs.yml', workflow_id: 8, status: 'in_progress', head_sha: SHA, created_at: ago(300), pull_requests: [] },
    ] })
    github.answers.set(`${P}/actions/runs?status=queued&per_page=20`, { workflow_runs: [] })
    streams.set(toolStream(REPO, 't1abcdefg01234567'), [ev(20, '▸ sim.transient'), ev(3, 'ngspice: t = 6.2 ms')])
    streams.set(toolStream(REPO, 't1abcdefg00000000'), [ev(200, '▸ kicad.erc'), ev(190, '✓ done in 10 s')])
    const r = await run(USER, 'activity.list', {}, { githubCache: new GitHubCache() }) as { items: Record<string, unknown>[] }
    const items = r.items.filter((i) => i.repo === REPO)
    expect(items.map((i) => [i.kind, i.title, i.state])).toEqual([
      ['check', 'check on #212', 'running'], ['check', 'simulation on #212', 'queued'],
      ['job', 'Routing the board', 'running'],
      ['tool', 'sim.transient', 'running'],
    ])
    expect(items[0]).toMatchObject({ run: 'check:701', change: 212, stepIndex: 2, stepCount: 3 })
    expect(items[2]).toMatchObject({ run: 'job:job-route', overdueAt: expect.any(String) as unknown as string })
  })
  it('shows nothing of projects the person is not on', async () => {
    const r = await run(OUTSIDER, 'activity.list', {}) as { items: unknown[] }
    expect(r.items).toEqual([])
  })
})

describe('tool', () => {
  it('passes the run id on to the worker, and refuses a made-up one', async () => {
    const tools = new Registry([{ name: 'sim.transient', description: 'x', input: (await import('zod')).z.object({}), hardware: false, run: () => null }])
    await run(USER, 'tool', { repo: REPO, name: 'sim.transient', args: {}, run_id: 't1abcdefg01234567' }, { tools: () => tools })
    expect(toolCalls).toEqual([{ kind: 'tool', repository: REPO, name: 'sim.transient', args: {}, runId: 't1abcdefg01234567' }])
    await expect(run(USER, 'tool', { repo: REPO, name: 'sim.transient', run_id: '../x' }, { tools: () => tools })).rejects.toThrow(/tool run id/)
  })
})

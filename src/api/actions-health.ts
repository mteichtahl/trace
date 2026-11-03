/**
 * The build's health in the app (docs/stay-in-trace.md "3. A broken build, stuck work, asking for a fix"). A failed
 * build was explained only in a GitHub issue that ci-doctor opened (src/harness/ci-doctor.ts), with links to logs;
 * now the project overview says in plain words what failed, shows the end of the failing step's log, and whether
 * trace is fixing it.
 *
 *   health.get   read   { repo } → HealthView
 *                         build    the default branch's latest run of the build workflow (cfg.build.workflow, on
 *                                  cfg.branch, from a push, a schedule or a dispatch: what ci-doctor watches there):
 *                                  passing, failing, running or none. While it runs, the run before it says what was
 *                                  failing (the card stays while trace's fix is built). Each failing job (the summary
 *                                  gate, cfg.build.required_check, only when nothing else failed: it fails whenever
 *                                  another job did) with its failing step and the last TAIL_LINES lines of its log
 *                                  up to the error. `why`: ci-doctor's judgement when its open issue names this commit,
 *                                  else the failing step, in plain words. `fixing`: trace's work item on it (the job
 *                                  index's rows for ci-doctor's issue), its attempt and worker.max_attempts
 *                         asks     the open agent-fix requests (other than ci-doctor's own, which is `fixing`), each
 *                                  with the job working on it: working (a job running or queued), stuck (the worker
 *                                  gave up on it: src/core/stuck-work.ts) or waiting
 *   health.log   read   { repo, job_id } → { name, text, truncated }: one job's whole log, its last LOG_MAX bytes.
 *                         A job that is not one of this repository's runs is refused ("no such job")
 *
 * Asking trace for a fix is the existing `task` action: nothing here opens an issue.
 *
 * GitHub's allowance: an overview looks every minute or so, so every call is kept a short while per repository
 * (src/api/github-cache.ts): the runs and the requests TTL_MS, a finished job's steps and log tail longer (they cannot
 * change), and each look counts against the person's budget. At most MAX_TAILS failing jobs' logs are read.
 *
 * GitHub's pages are never in the answer: the app shows no GitHub link to anyone but admins (decision C).
 */
import { z } from 'zod'
import { type TraceConfig, readSettings, resolve } from '../core/config.js'
import { type JobRow, indexedHandle, isLive, loadJobs } from '../core/job-index.js'
import { stuckRequests } from '../core/stuck-work.js'
import { ActionError, type Context, PROJECT_DB_PATH, Repo, agentFactsStore, def, tempDb } from './action-kit.js'
import { jobIndex } from './actions-jobs.js'
import { GitHubError, type GitHubApi } from './github.js'
import { SETTINGS_TTL_MS, cached } from './github-cache.js'

/** Lines of a failing step's log the overview shows. */
export const TAIL_LINES = 40
/** health.log's limit: the end of the log. */
export const LOG_MAX = 200 * 1024
/** How much of a failing job's log is read to find its tail. */
const TAIL_READ = 64 * 1024
/** At most this many failing jobs' logs are read for one look. */
export const MAX_TAILS = 3
/** A finished job does not change: its steps and log are kept this long. */
const DONE_TTL_MS = 5 * 60_000
/** ci-doctor's marker on its default-branch issue (src/harness/ci-doctor.ts MAIN_MARKER). */
export const DOCTOR_MARKER = '<!-- trace: ci-doctor default-branch -->'

export interface HealthView {
  build: {
    state: 'passing' | 'failing' | 'running' | 'none'; sha: string | null; at: string | null
    failing: { job_id: number; name: string; step: string | null; tail: string }[]
    why: string | null
    fixing: { job_id: string | null; attempt: number; of: number } | null
  }
  asks: { number: number; title: string; state: 'waiting' | 'working' | 'stuck'; job_id: string | null; opened_at: string }[]
}

// ------------------------------------------------------------------ what GitHub answers

export const Run = z.object({
  id: z.number(), event: z.string(), status: z.string().nullable(), conclusion: z.string().nullable().optional(),
  head_sha: z.string(), head_branch: z.string().nullable().optional(), created_at: z.string(), updated_at: z.string().optional(),
}).loose()
export type Run = z.infer<typeof Run>
const Runs = z.object({ workflow_runs: z.array(Run) }).loose()

export const Job = z.object({
  id: z.number(), name: z.string(), status: z.string(), conclusion: z.string().nullable().optional(),
  steps: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable().optional() }).loose()).nullable().optional(),
}).loose()
export type Job = z.infer<typeof Job>
const Jobs = z.object({ jobs: z.array(Job) }).loose()

export const Issue = z.object({
  number: z.number(), title: z.string(), body: z.string().nullable().optional(), created_at: z.string(), pull_request: z.unknown().optional(),
}).loose()
export type Issue = z.infer<typeof Issue>
const Comment = z.object({ body: z.string().nullable().optional(), created_at: z.string().optional() }).loose()

// ------------------------------------------------------------------ the rules, as plain functions

/** The runs ci-doctor watches on the default branch (a push, a schedule, a dispatch), newest first. */
export const branchRuns = (runs: readonly Run[], branch: string): Run[] =>
  runs.filter((r) => (r.head_branch ?? branch) === branch && ['push', 'schedule', 'workflow_dispatch'].includes(r.event))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))

const finished = (r: Run): boolean => r.status === 'completed'
const failed = (c: string | null | undefined): boolean => c === 'failure' || c === 'timed_out'

/**
 * Where the build stands: the newest run; while it runs, the newest finished run before it says whether it was
 * failing (`shown`: the run whose jobs explain it). Cancelled and skipped runs say nothing about the design: passed
 * over.
 */
export function buildState(runs: readonly Run[]): { state: HealthView['build']['state']; latest: Run | null; shown: Run | null } {
  const latest = runs[0] ?? null
  if (!latest) return { state: 'none', latest: null, shown: null }
  const done = runs.find((r) => finished(r) && (r.conclusion === 'success' || failed(r.conclusion))) ?? null
  if (!finished(latest)) return { state: 'running', latest, shown: done && failed(done.conclusion) ? done : null }
  if (!done) return { state: 'none', latest, shown: null }
  return { state: failed(done.conclusion) ? 'failing' : 'passing', latest: done, shown: failed(done.conclusion) ? done : null }
}

/** The jobs that failed, without the summary gate unless it alone failed (it fails whenever another job did). */
export function failingJobs(jobs: readonly Job[], gate: string): Job[] {
  const bad = jobs.filter((j) => failed(j.conclusion))
  return bad.length > 1 ? bad.filter((j) => j.name !== gate) : bad
}

/** A job's failing step's name (null: it never started one). */
export const failingStep = (j: Job): string | null => (j.steps ?? []).find((s) => failed(s.conclusion))?.name ?? null

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?/

/** A log as people read it: no timestamps, colours or GitHub's group markers; an error line says "Error:". */
export function cleanLog(text: string): string[] {
  return text.replace(/\r/g, '').split('\n').map((l) => l.replace(STAMP, '').replace(ANSI, ''))
    .filter((l) => !/^##\[(group|endgroup)\]/.test(l) || /^##\[group\]Run /.test(l))
    .map((l) => l.replace(/^##\[group\]/, '').replace(/^##\[error\]/, 'Error: ').replace(/^##\[(warning|notice|debug)\]/, ''))
}

/**
 * The failing step's extract: TAIL_LINES lines ending at the job's last error line (what comes after it is the
 * runner tidying up), else the log's last lines. Without a trailing empty line.
 */
export function logTail(text: string, n = TAIL_LINES): string {
  const lines = cleanLog(text)
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  let end = lines.length
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.startsWith('Error: ')) { end = i + 1; break }
  return lines.slice(Math.max(0, end - n), end).join('\n')
}

/** The failing step in plain words: `The "erc" job failed at its step "Run ERC".` */
export function stepWords(failing: readonly { name: string; step: string | null }[]): string | null {
  const f = failing[0]
  if (!f) return null
  const one = f.step ? `The "${f.name}" job failed at its step "${f.step}".` : `The "${f.name}" job failed before it started a step: the machine running it was lost.`
  const more = failing.length - 1
  return more > 0 ? `${one} ${more === 1 ? 'One other job' : `${more} other jobs`} failed too.` : one
}

/**
 * ci-doctor's judgement of the build on `sha`, from its issue's body or comments (the newest that names the commit),
 * in plain words; null when none names it. Only its own lines are read ("- [job](…): real (step "X")"), and no link
 * is kept: the app shows no GitHub page.
 */
export function doctorWords(texts: readonly string[], sha: string): string | null {
  const short = sha.slice(0, 12)
  const t = [...texts].reverse().find((x) => x.includes(`The build failed on ${short}`))
  if (!t) return null
  const verdicts = [...t.matchAll(/^- \[([^\]\n]{1,200})\]\([^)\n]*\): (flaky|dispatch|real) \(([^\n]{0,300})\)$/gm)]
    .map((m) => ({ job: m[1] as string, kind: m[2] as string, detail: m[3] as string }))
  if (!verdicts.length) return null
  const again = /It looked flaky but failed again after a re-run/.test(t)
  const words = verdicts.slice(0, 3).map((v) => {
    if (v.kind === 'real') {
      const step = /^step "(.*)"$/.exec(v.detail)?.[1]
      return step && step !== '?' ? `"${v.job}" failed at its step "${step}"` : `"${v.job}" failed`
    }
    return `"${v.job}" failed for a reason outside the design (${v.detail})`
  })
  const lead = `trace looked at the failure: ${words.join('; ')}.`
  const real = verdicts.some((v) => v.kind === 'real')
  return [lead, again ? 'It looked like a passing glitch, but it failed again when run once more, so it is treated as real.' : '', real ? 'It is a problem in the project itself, not in the machines that build it.' : ''].filter(Boolean).join(' ')
}

/** The rows of the job index working on issue or pull request `n` (work items, not a delegated worker), newest first. */
const rowsFor = (rows: readonly JobRow[], n: number): JobRow[] =>
  rows.filter((r) => r.number === n && r.kind === 'work-item' && !r.parentJob)
    .sort((a, b) => (b.startedAt ?? b.queuedAt ?? b.updatedAt) - (a.startedAt ?? a.queuedAt ?? a.updatedAt))

const working = (r: JobRow, at: number): boolean => r.state === 'queued' || isLive(r, at)

/**
 * trace's work item on the failed build (ci-doctor's issue `n`): its newest job, and which attempt it is (its work
 * items since the failing run started, at least one once a job exists).
 */
export function fixingOf(repo: string, rows: readonly JobRow[], n: number | null, since: string | null, of: number): HealthView['build']['fixing'] {
  if (n === null) return null
  const mine = rowsFor(rows, n)
  const t = since ? Date.parse(since) / 1000 : 0
  const attempt = mine.filter((r) => (r.startedAt ?? r.queuedAt ?? r.updatedAt) >= t).length
  const newest = mine[0]
  return { job_id: newest ? indexedHandle(repo, newest.session, newest.id) : null, attempt: Math.min(attempt, of), of }
}

/** The open agent-fix requests (ci-doctor's own left out: it is the build's `fixing`), each with where it stands. */
export function asksOf(repo: string, issues: readonly Issue[], rows: readonly JobRow[], stuck: ReadonlySet<number>, at: number): HealthView['asks'] {
  return issues.filter((i) => i.pull_request === undefined && !(i.body ?? '').includes(DOCTOR_MARKER))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((i) => {
      const live = rowsFor(rows, i.number).find((r) => working(r, at))
      const state = live ? 'working' as const : stuck.has(i.number) ? 'stuck' as const : 'waiting' as const
      return { number: i.number, title: i.title.slice(0, 200), state, job_id: live ? indexedHandle(repo, live.session, live.id) : null, opened_at: i.created_at }
    })
}

// ------------------------------------------------------------------ reading GitHub

/** The calls health needs, or a plain refusal when this installation's client has none. */
function healthApi(gh: GitHubApi): GitHubApi & Required<Pick<GitHubApi, 'request' | 'requestText'>> {
  if (typeof gh.request !== 'function' || typeof gh.requestText !== 'function') throw new ActionError('This installation cannot show the build in the app yet. An admin updates the installation.')
  return gh as GitHubApi & Required<Pick<GitHubApi, 'request' | 'requestText'>>
}

const repoPath = (repo: string): string => { const [o, n] = repo.split('/'); return `/repos/${encodeURIComponent(o ?? '')}/${encodeURIComponent(n ?? '')}` }

/** The project's settings on its default branch (the defaults when they cannot be read), kept SETTINGS_TTL_MS. */
async function healthSettings(ctx: Context, repo: string): Promise<{ cfg: TraceConfig; branch: string }> {
  return cached(ctx.deps.githubCache, repo, 'health-settings', async () => {
    const gh = await ctx.deps.github()
    const { branch } = await gh.defaultBranch(repo)
    let settings: Record<string, unknown> = {}
    const bytes = await gh.rawFile(repo, PROJECT_DB_PATH, branch).catch(() => null)
    if (bytes) {
      const t = tempDb(ctx.deps.scratch, bytes)
      try { settings = readSettings(t.db) } catch { settings = {} } finally { t.cleanup() }
    }
    return { cfg: resolve(settings).config, branch }
  }, SETTINGS_TTL_MS)
}

/** GitHub's "not found" (a workflow file that does not exist yet): nothing to show, not a failure. */
const notFound = (e: unknown): boolean => e instanceof GitHubError && e.status === 404

async function health(ctx: Context, repo: string): Promise<HealthView> {
  const gh = healthApi(await ctx.deps.github())
  const { cfg, branch } = await healthSettings(ctx, repo)
  const p = repoPath(repo)
  const get = <T>(key: string, path: string, schema: z.ZodType<T>, ttl?: number): Promise<T> =>
    cached(ctx.deps.githubCache, repo, key, async () => schema.parse(await gh.request('GET', path)), ttl)
  const at = Date.now() / 1000
  const [runs, issues, rows, stuck] = await Promise.all([
    get('health-runs', `${p}/actions/workflows/${encodeURIComponent(cfg.build.workflow)}/runs?branch=${encodeURIComponent(branch)}&per_page=10`, Runs)
      .catch((e: unknown) => { if (notFound(e)) return { workflow_runs: [] }; throw e }),
    get('health-asks', `${p}/issues?labels=${encodeURIComponent(cfg.labels.agent_fix)}&state=open&sort=created&direction=asc&per_page=50`, z.array(Issue)),
    jobIndex(ctx, repo).read((db) => loadJobs(db)).then((x) => x.result, () => [] as JobRow[]),
    agentFactsStore(ctx, repo).read((db) => stuckRequests(db)).then((x) => x.result, () => new Set<number>()),
  ])
  const { state, latest, shown } = buildState(branchRuns(runs.workflow_runs, branch))
  const doctor = issues.find((i) => i.pull_request === undefined && (i.body ?? '').includes(DOCTOR_MARKER)) ?? null
  const build: HealthView['build'] = { state, sha: latest?.head_sha ?? null, at: latest ? latest.updated_at ?? latest.created_at : null, failing: [], why: null, fixing: null }

  if (shown) {
    const done = await get(`health-jobs:${shown.id}`, `${p}/actions/runs/${shown.id}/jobs?per_page=100`, Jobs, DONE_TTL_MS)
    const bad = failingJobs(done.jobs, cfg.build.required_check)
    const tails = await Promise.all(bad.map((j, i) => (i < MAX_TAILS && (j.steps ?? []).length
      ? cached(ctx.deps.githubCache, repo, `health-tail:${j.id}`, async () => logTail((await gh.requestText(`${p}/actions/jobs/${j.id}/logs`, TAIL_READ)).text), DONE_TTL_MS).catch(() => '')
      : Promise.resolve(''))))
    build.failing = bad.map((j, i) => ({ job_id: j.id, name: j.name, step: failingStep(j), tail: tails[i] ?? '' }))
    // ci-doctor's judgement: its issue's body, then (when the body names an older commit) its comments
    let said: string | null = null
    if (doctor) {
      said = doctorWords([doctor.body ?? ''], shown.head_sha)
      if (!said) {
        const cs = await get(`health-doctor:${doctor.number}`, `${p}/issues/${doctor.number}/comments?per_page=100`, z.array(Comment)).catch(() => [])
        said = doctorWords([doctor.body ?? '', ...cs.map((c) => c.body ?? '')], shown.head_sha)
      }
    }
    build.why = said ?? stepWords(build.failing) ?? 'The build failed.'
    build.fixing = fixingOf(repo, rows, doctor?.number ?? null, shown.created_at, cfg.worker.max_attempts)
  }
  return { build, asks: asksOf(repo, issues, rows, stuck, at) }
}

/** One Actions job as GitHub describes it, with the run it belongs to, its commit and its times. */
export const JobFull = Job.extend({
  run_url: z.string().optional(), head_sha: z.string().optional(), workflow_name: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(), completed_at: z.string().nullable().optional(), html_url: z.string().nullable().optional(),
})
export type JobFull = z.infer<typeof JobFull>

/**
 * One Actions job of this repository's runs, or an ActionError ("no build job") when GitHub does not know it, will not
 * show it, or names another repository's run for it.
 */
export async function repoJob(ctx: Context, repo: string, id: number): Promise<JobFull> {
  const gh = healthApi(await ctx.deps.github())
  let job: JobFull
  try {
    job = JobFull.parse(await gh.request('GET', `${repoPath(repo)}/actions/jobs/${id}`))
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 404 || e.status === 403)) throw new ActionError(`${repo} has no build job ${id}.`)
    throw e
  }
  // GitHub names the run the job belongs to: it must be this repository's
  const runRepo = /\/repos\/([^/]+\/[^/]+)\/actions\/runs\/\d+$/.exec(job.run_url ?? '')?.[1]
  if (!runRepo || decodeURIComponent(runRepo).toLowerCase() !== repo.toLowerCase()) throw new ActionError(`${repo} has no build job ${id}.`)
  return job
}

/**
 * The end of one job's log (at most `max` bytes), cleaned (cleanLog), kept a while once the job finished. The caller has
 * made sure the job is this repository's. Throws GitHub's error (404/410: no longer kept).
 */
export async function jobLogEnd(ctx: Context, repo: string, id: number, status: string, max = LOG_MAX): Promise<{ text: string; truncated: boolean }> {
  const gh = healthApi(await ctx.deps.github())
  const { text, truncated } = await cached(ctx.deps.githubCache, repo, `health-log:${id}:${status}:${max}`, () => gh.requestText(`${repoPath(repo)}/actions/jobs/${id}/logs`, max), status === 'completed' ? DONE_TTL_MS : undefined)
  return { text: cleanLog(text).join('\n'), truncated }
}

/** One job's whole log (its end, LOG_MAX), after checking it is one of this repository's runs. */
async function jobLog(ctx: Context, repo: string, id: number): Promise<{ name: string; text: string; truncated: boolean }> {
  const job = await repoJob(ctx, repo, id)
  try {
    return { name: job.name, ...await jobLogEnd(ctx, repo, id, job.status) }
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 404 || e.status === 410)) throw new ActionError(`The log of "${job.name}" is no longer kept: GitHub keeps logs for a limited time.`)
    throw e
  }
}

/** Count one GitHub-touching look against this principal's budget (src/api/github-cache.ts). */
const spend = (ctx: Context): void => { ctx.deps.githubBudget?.take(ctx.principal.sub) }

export const HEALTH_ACTIONS = {
  'health.get': def('read', Repo, async ({ repo }, ctx) => { spend(ctx); return health(ctx, repo) }),
  'health.log': def('read', Repo.extend({ job_id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }), async ({ repo, job_id: id }, ctx) => { spend(ctx); return jobLog(ctx, repo, id) }),
}

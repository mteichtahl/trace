/**
 * What trace is doing, while it does it (docs/progress-and-logs.md): the log of any run, the live steps of a change's
 * checks, and everything running across a person's projects.
 *
 *   run.log        read  { repo, run, after?, limit? } → RunLogView: one run's lines from a cursor, masked
 *                    job:<id>     its stream (the worker runtime writes it), else the job index's last lines
 *                    tool:<id>    its stream; ended once its last line is the runtime's ✓ or ✗
 *                    check:<id>   a GitHub Actions job: while it runs, the stream trace's own steps write on a
 *                                 CodeBuild runner; once it has ended, GitHub's own log (whole), learned for quiet
 *   change.runs    read  { repo, number } → the head commit's GitHub Actions jobs with their steps, the step running
 *                         now, the job's usual length, and (on CodeBuild) its stream's newest line
 *   activity.list  signed-in {} → every running, queued or paused job, running check and running tool call on the
 *                         person's projects
 *
 * GitHub's allowance: every GitHub answer is kept a short while per repository (src/api/github-cache.ts): a running
 * job's a few seconds, a finished one's minutes, a workflow's usual job lengths an hour. activity.list counts against
 * nobody's budget (it is the top bar's, like Home), so its looks are kept longest.
 *
 * Secrets: every line passes through maskSecrets (src/core/run-logs.ts) before it leaves; the CloudWatch link is
 * given to admins only (decision D).
 */
import { z } from 'zod'
import { isAdmin, projectsFor } from '../core/access.js'
import { type JobRow, heardOf, loadJobs } from '../core/job-index.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { learnQuiet, quietStepKey, readQuiet, type QuietProfile, usualQuietS } from '../core/quiet.js'
import {
  type LogLine, type RunRef, checkStreamPrefix, currentStep, githubLogLines, jobStream, parseRunRef, parseStream, stepGaps, toLogLine,
  toolStream, toolStreamPrefix,
} from '../core/run-logs.js'
import { ActionError, type Context, Repo, def, storeAt } from './action-kit.js'
import { type IndexedJob, jobIndex, listJobs } from './actions-jobs.js'
import { GitHubError, type GitHubApi } from './github.js'
import { cached } from './github-cache.js'
import { type RunLogsReader, consoleLink } from './run-logs-reader.js'

/** How much of a finished job's GitHub log is read (its end). */
export const GITHUB_LOG_MAX = 2 * 1024 * 1024
const RUNNING_TTL_MS = 4_000
const DONE_TTL_MS = 10 * 60_000
const TYPICAL_TTL_MS = 60 * 60_000
const ACTIVITY_TTL_MS = 8_000
/** A tool stream not written for this long is not running, whatever its last line says (its runtime went away). */
const TOOL_SILENT_S = 15 * 60
/** At most this many projects are looked at for activity.list. */
const MAX_PROJECTS = 25
const NEWEST_CHARS = 200
/** Lines reach CloudWatch a moment after they are written: a run's log is complete this long after it ended. */
const SETTLE_S = 15
/** A tool run's last line, as the runtime writes it (src/agents/runtime/tool.ts). */
const END = /^(✓ done|✗ )/

// ------------------------------------------------------------------ what GitHub answers

const Step = z.object({
  name: z.string(), status: z.string(), conclusion: z.string().nullable().optional(), number: z.number().optional(),
  started_at: z.string().nullable().optional(), completed_at: z.string().nullable().optional(),
}).loose()
export const GhJob = z.object({
  id: z.number(), run_id: z.number(), run_attempt: z.number().optional(), name: z.string(), status: z.string(), conclusion: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(), started_at: z.string().nullable().optional(), completed_at: z.string().nullable().optional(),
  workflow_name: z.string().nullable().optional(), labels: z.array(z.string()).default([]), runner_name: z.string().nullable().optional(),
  run_url: z.string().optional(), steps: z.array(Step).nullable().optional(),
}).loose()
export type GhJob = z.infer<typeof GhJob>
const GhJobs = z.object({ jobs: z.array(GhJob) }).loose()
const GhRun = z.object({
  id: z.number(), name: z.string().nullable().optional(), path: z.string().optional(), workflow_id: z.number().optional(), run_attempt: z.number().optional(),
  status: z.string().nullable(), conclusion: z.string().nullable().optional(), head_sha: z.string(), head_branch: z.string().nullable().optional(),
  created_at: z.string(), event: z.string().optional(), pull_requests: z.array(z.object({ number: z.number() }).loose()).default([]),
}).loose()
type GhRun = z.infer<typeof GhRun>
const GhRuns = z.object({ workflow_runs: z.array(GhRun) }).loose()

type Gh = GitHubApi & Required<Pick<GitHubApi, 'request' | 'requestText'>>
function ghOf(gh: GitHubApi): Gh {
  if (typeof gh.request !== 'function' || typeof gh.requestText !== 'function') throw new ActionError('This installation cannot show the checks in the app yet. An admin updates the installation.')
  return gh as Gh
}
const repoPath = (repo: string): string => { const [o, n] = repo.split('/'); return `/repos/${encodeURIComponent(o ?? '')}/${encodeURIComponent(n ?? '')}` }

// ------------------------------------------------------------------ views

export type CheckState = 'queued' | 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled'
export interface CheckStep { name: string; state: Exclude<CheckState, 'cancelled'>; startedAt: string | null; completedAt: string | null }
export interface CheckJob {
  id: number; run: RunRef; name: string; workflow: string; state: CheckState
  startedAt: string | null; completedAt: string | null
  steps: CheckStep[]; step: string | null; stepIndex: number | null; stepCount: number
  typicalS: number | null; queuedS: number | null
  heardAt: string | null; newest: string | null; usualQuietS: number; runner: 'aws' | 'github' | null
}
export interface RunLogView {
  repo: string; run: string; source: 'cloudwatch' | 'github' | 'tail' | 'none'
  lines: LogLine[]; next: string | null; done: boolean
  heardAt: string | null; step: string | null; usualQuietS: number
  /** why there are no lines yet, in words (a check on GitHub's own machines) */
  note?: string
  /** admins only: the CloudWatch console's page for the stream */
  cloudwatch?: string
}
export interface ActivityItem {
  kind: 'check' | 'job' | 'tool'; repo: string; run: RunRef; title: string; state: 'running' | 'queued' | 'paused'
  step: string | null; stepIndex: number | null; stepCount: number | null
  startedAt: string | null; typicalS: number | null
  heardAt: string | null; newest: string | null; usualQuietS: number
  overdueAt?: string; lostAt?: string; change?: number
}

export function jobState(status: string, conclusion: string | null | undefined): CheckState {
  if (status === 'in_progress') return 'running'
  if (status !== 'completed') return 'queued'
  switch (conclusion) {
    case 'success': return 'passed'
    case 'failure': case 'timed_out': case 'startup_failure': case 'action_required': return 'failed'
    case 'cancelled': return 'cancelled'
    default: return 'skipped'
  }
}

const isoOr = (s: string | null | undefined): string | null => (s && !s.startsWith('0001') ? s : null)
const runnerOf = (j: Pick<GhJob, 'labels' | 'runner_name'>): 'aws' | 'github' | null =>
  (j.labels.some((l) => l.startsWith('codebuild-')) || (j.runner_name ?? '').startsWith('codebuild') ? 'aws' : j.labels.length || j.runner_name ? 'github' : null)
const seconds = (a: string | null | undefined, b: string | null | undefined): number | null => {
  const x = a ? Date.parse(a) : NaN; const y = b ? Date.parse(b) : NaN
  return Number.isFinite(x) && Number.isFinite(y) && y >= x ? Math.round((y - x) / 1000) : null
}
const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

/** A GitHub job's steps and where it stands. Pure. */
export function stepsOf(j: Pick<GhJob, 'steps' | 'status'>): { steps: CheckStep[]; step: string | null; stepIndex: number | null } {
  const steps: CheckStep[] = (j.steps ?? []).map((s) => {
    const st = jobState(s.status, s.conclusion)
    return { name: s.name, state: st === 'cancelled' ? 'failed' : st, startedAt: isoOr(s.started_at), completedAt: isoOr(s.completed_at) }
  })
  if (j.status !== 'in_progress') return { steps, step: null, stepIndex: null }
  let i = steps.findIndex((s) => s.state === 'running')
  // between steps: the first one not yet done
  if (i < 0) i = steps.findIndex((s) => s.state === 'queued')
  return i < 0 ? { steps, step: null, stepIndex: null } : { steps, step: steps[i]!.name, stepIndex: i + 1 }
}

/** The stream trace's steps write for this job (gha/…/<GITHUB_JOB>), among a run attempt's streams. Pure. */
export function streamForJob(names: readonly string[], jobName: string): string | null {
  const keyed = names.map((n) => ({ n, p: parseStream(n) })).filter((x): x is { n: string; p: Extract<ReturnType<typeof parseStream>, { kind: 'check' }> } => x.p?.kind === 'check')
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const want = norm(jobName)
  const hit = keyed.find((x) => x.p.job === jobName) ?? keyed.find((x) => norm(x.p.job) === want)
    // a matrix job ("check (rust)") or a job given a display name: its key starts it
    ?? keyed.find((x) => want.startsWith(`${norm(x.p.job)}-`))
  return hit?.n ?? (keyed.length === 1 && names.length === 1 ? keyed[0]!.n : null)
}

// ------------------------------------------------------------------ cursors

type Cursor = { k: 'cw'; s: string; t: string | null } | { k: 'gh'; o: number } | { k: 'tail'; o: number }
const enc = (c: Cursor): string => Buffer.from(JSON.stringify(c)).toString('base64url')
function dec(s: string | null | undefined): Cursor | null {
  if (!s) return null
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor
    if (c && (c.k === 'cw' || c.k === 'gh' || c.k === 'tail')) return c
  } catch { /* a cursor from elsewhere: start again */ }
  return null
}

// ------------------------------------------------------------------ helpers

const reader = (ctx: Context): RunLogsReader | null => ctx.deps.runLogs?.() ?? null
const quietOf = (ctx: Context, repo: string): Promise<QuietProfile | null> =>
  (ctx.deps.githubCache ? ctx.deps.githubCache.get(repo, 'progress-quiet', () => readQuiet(storeAt(ctx, PROJECTS_PREFIX), repo), 60_000) : readQuiet(storeAt(ctx, PROJECTS_PREFIX), repo)).catch(() => null)
const usual = (q: QuietProfile | null, kind: 'job' | 'tool' | 'check', what: string, step: string | null): number => usualQuietS(q, quietStepKey(kind, what, step ?? 'Starting'))
const short = (t: string): string => (t.length > NEWEST_CHARS ? `${t.slice(0, NEWEST_CHARS - 1)}…` : t)

/** A job's worker id from a run ref's id: the API's handle ("<session>.<jobId>") or the worker's id itself. */
export const workerJobId = (id: string): string => id.split('.').pop() || id

async function ghJob(ctx: Context, repo: string, id: number): Promise<GhJob> {
  const gh = ghOf(await ctx.deps.github())
  const key = `progress-job:${id}`
  const read = (): Promise<GhJob> => gh.request('GET', `${repoPath(repo)}/actions/jobs/${id}`).then((j) => GhJob.parse(j))
  let job: GhJob
  try {
    job = await cached(ctx.deps.githubCache, repo, key, read, RUNNING_TTL_MS)
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 404 || e.status === 403)) throw new ActionError(`${repo} has no check ${id}.`)
    throw e
  }
  // GitHub names the run the job belongs to: it must be this repository's
  const runRepo = /\/repos\/([^/]+\/[^/]+)\/actions\/runs\/\d+$/.exec(job.run_url ?? '')?.[1]
  if (runRepo && decodeURIComponent(runRepo).toLowerCase() !== repo.toLowerCase()) throw new ActionError(`${repo} has no check ${id}.`)
  return job
}

async function githubLog(ctx: Context, repo: string, id: number): Promise<LogLine[]> {
  const gh = ghOf(await ctx.deps.github())
  return cached(ctx.deps.githubCache, repo, `progress-log:${id}`, async () => {
    try {
      return githubLogLines((await gh.requestText(`${repoPath(repo)}/actions/jobs/${id}/logs`, GITHUB_LOG_MAX)).text)
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 404 || e.status === 410)) return []
      throw e
    }
  }, DONE_TTL_MS)
}

/** Learn a finished check's quiet once (never fails the caller). */
async function learnCheck(ctx: Context, repo: string, job: GhJob, lines?: LogLine[]): Promise<void> {
  try {
    const all = lines ?? await githubLog(ctx, repo, job.id)
    await learnQuiet(storeAt(ctx, PROJECTS_PREFIX), repo, `check:${job.id}`, 'check', job.name, stepGaps(all))
  } catch { /* quiet is a nicety: never a failure */ }
}

// ------------------------------------------------------------------ run.log

const RunLogArgs = Repo.extend({ run: z.string().min(5).max(320), after: z.string().max(8000).nullish(), limit: z.number().int().min(1).max(1000).default(500) })

export async function runLog(ctx: Context, a: z.output<typeof RunLogArgs>): Promise<RunLogView> {
  const ref = parseRunRef(a.run)
  if (!ref) throw new ActionError('run: job:<id>, tool:<id> or check:<id>')
  const { repo } = a
  const r = reader(ctx)
  const admin = isAdmin(ctx.principal)
  const cursor = dec(a.after)
  const q = await quietOf(ctx, repo)
  const fromStream = async (stream: string, c: Cursor | null): Promise<{ lines: LogLine[]; next: string | null; exists: boolean }> => {
    if (!r) return { lines: [], next: null, exists: false }
    const got = await r.read(stream, { after: c?.k === 'cw' ? c.t : null, limit: a.limit })
    return { lines: got.events.map((e) => toLogLine(e.at, e.text)), next: got.next === null ? null : enc({ k: 'cw', s: stream, t: got.next }), exists: got.exists }
  }
  const link = (stream: string): { cloudwatch?: string } => (admin && r ? { cloudwatch: consoleLink(r, stream) } : {})

  if (ref.kind === 'job') {
    const id = workerJobId(ref.id)
    const { result: rows } = await jobIndex(ctx, repo).read((db) => loadJobs(db))
    const row: JobRow | undefined = rows.find((x) => x.id === id)
    if (!row) throw new ActionError(`${repo} has no job ${ref.id}.`)
    const done = !['running', 'queued', 'paused'].includes(row.state)
    // lines reach the log a moment after they are written: a job counts as finished for its log a little after it ended
    const settled = done && (row.endedAt === null || Date.now() / 1000 - row.endedAt > SETTLE_S)
    const heardAt = row.state === 'running' ? new Date(heardOf(row).heardAt * 1000).toISOString() : null
    const stream = jobStream(repo, id)
    const got = await fromStream(stream, cursor?.k === 'tail' ? null : cursor)
    if (got.exists || cursor?.k === 'cw') {
      return {
        repo, run: a.run, source: 'cloudwatch', lines: got.lines, next: got.next, done: settled && got.lines.length < a.limit,
        heardAt: got.lines.length ? got.lines[got.lines.length - 1]!.at : heardAt, step: row.step, usualQuietS: usual(q, 'job', row.agent ?? row.kind, currentStep(got.lines) ?? row.step), ...link(stream),
      }
    }
    // no stream (a job from before streams, or an installation without the group): the index's last lines
    let tail: string[] = []
    try { const t: unknown = row.tail ? JSON.parse(row.tail) : []; if (Array.isArray(t)) tail = t.filter((x): x is string => typeof x === 'string') } catch { /* none */ }
    const from = cursor?.k === 'tail' ? cursor.o : 0
    const at = new Date(row.updatedAt * 1000).toISOString()
    const lines = tail.slice(from).map((l) => { const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/.exec(l); return toLogLine(m ? m[1]! : at, m ? m[2]! : l) })
    return { repo, run: a.run, source: tail.length ? 'tail' : 'none', lines, next: enc({ k: 'tail', o: tail.length }), done, heardAt, step: row.step, usualQuietS: usual(q, 'job', row.agent ?? row.kind, row.step), ...(tail.length ? {} : { note: 'trace keeps no log for this job.' }) }
  }

  if (ref.kind === 'tool') {
    const stream = toolStream(repo, ref.id)
    const [got, newest] = await Promise.all([fromStream(stream, cursor), r ? r.newest(stream) : Promise.resolve(null)])
    if (!got.exists && !r) return { repo, run: a.run, source: 'none', lines: [], next: null, done: true, heardAt: null, step: null, usualQuietS: usual(q, 'tool', '', null), note: 'This installation keeps no tool logs yet.' }
    const ended = newest ? END.test(newest.text.trimStart()) || (Date.now() - newest.at) / 1000 > TOOL_SILENT_S : !got.exists
    const last = got.lines[got.lines.length - 1]
    const what = /^▸ (\S+)/.exec(got.lines[0]?.text ?? '')?.[1] ?? ''
    return {
      repo, run: a.run, source: got.exists ? 'cloudwatch' : 'none', lines: got.lines, next: got.next,
      done: ended && got.lines.length < a.limit && (last ? END.test(last.text.trimStart()) || (Date.now() - (newest?.at ?? 0)) / 1000 > TOOL_SILENT_S : cursor !== null || !got.exists),
      heardAt: newest ? new Date(newest.at).toISOString() : null, step: currentStep(got.lines), usualQuietS: usual(q, 'tool', what, currentStep(got.lines)), ...link(stream),
    }
  }

  // a check
  const job = await ghJob(ctx, repo, Number(ref.id))
  const state = jobState(job.status, job.conclusion)
  const { step } = stepsOf(job)
  const uq = usual(q, 'check', job.name, step)
  const ended = job.status === 'completed'
  // carry on the stream it was reading, even after the job ended; else a finished job's whole log from GitHub
  if (cursor?.k === 'cw' || (!ended && cursor?.k !== 'gh')) {
    let stream = cursor?.k === 'cw' ? cursor.s : null
    if (!stream && r) {
      const names = (await cached(ctx.deps.githubCache, repo, `progress-streams:${job.run_id}:${job.run_attempt ?? 1}`, () => r.streams(checkStreamPrefix(repo, job.run_id, job.run_attempt ?? 1), { limit: 50 }), RUNNING_TTL_MS)).map((s) => s.name)
      stream = streamForJob(names, job.name)
    }
    if (stream) {
      const got = await fromStream(stream, cursor)
      const settled = ended && (seconds(job.completed_at, new Date().toISOString()) ?? 0) > SETTLE_S
      return { repo, run: a.run, source: 'cloudwatch', lines: got.lines, next: got.next, done: settled && got.lines.length < a.limit, heardAt: got.lines.length ? got.lines[got.lines.length - 1]!.at : null, step, usualQuietS: uq, ...link(stream) }
    }
    if (!ended) {
      const note = state === 'queued' ? 'It is waiting for a build machine.'
        : runnerOf(job) === 'aws' ? 'Its own steps have said nothing yet; the steps above show where it is.'
          : 'This check runs on GitHub\'s machines: its log arrives when it finishes. The steps above show where it is.'
      return { repo, run: a.run, source: 'none', lines: [], next: null, done: false, heardAt: null, step, usualQuietS: uq, note }
    }
  }
  const all = await githubLog(ctx, repo, job.id)
  const from = cursor?.k === 'gh' ? cursor.o : 0
  const lines = all.slice(from, from + a.limit)
  const nextO = from + lines.length
  if (from === 0 && state !== 'cancelled') void learnCheck(ctx, repo, job, all)
  return {
    repo, run: a.run, source: 'github', lines, next: enc({ k: 'gh', o: nextO }), done: nextO >= all.length, heardAt: null, step: null, usualQuietS: uq,
    ...(all.length ? {} : { note: 'GitHub no longer keeps this check\'s log.' }),
  }
}

// ------------------------------------------------------------------ change.runs

async function runsForSha(ctx: Context, repo: string, sha: string): Promise<GhRun[]> {
  const gh = ghOf(await ctx.deps.github())
  const runs = await cached(ctx.deps.githubCache, repo, `progress-runs:${sha}`, async () => GhRuns.parse(await gh.request('GET', `${repoPath(repo)}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=50`)).workflow_runs, RUNNING_TTL_MS)
  // the latest run of each workflow (a re-run replaces the one before)
  const latest = new Map<string, GhRun>()
  for (const r of runs) {
    const k = String(r.workflow_id ?? r.path ?? r.name ?? r.id)
    const had = latest.get(k)
    if (!had || r.id > had.id || (r.id === had.id && (r.run_attempt ?? 1) > (had.run_attempt ?? 1))) latest.set(k, r)
  }
  return [...latest.values()]
}

async function jobsOfRun(ctx: Context, repo: string, run: Pick<GhRun, 'id' | 'status'>): Promise<GhJob[]> {
  const gh = ghOf(await ctx.deps.github())
  return cached(ctx.deps.githubCache, repo, `progress-run-jobs:${run.id}:${run.status}`, async () => GhJobs.parse(await gh.request('GET', `${repoPath(repo)}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).jobs,
    run.status === 'completed' ? DONE_TTL_MS : RUNNING_TTL_MS)
}

/** A workflow's usual job lengths on this project: the median of each job's last successful runs, kept an hour. */
async function typicalJobs(ctx: Context, repo: string, workflowId: number | undefined): Promise<Map<string, number>> {
  if (!workflowId) return new Map()
  const gh = ghOf(await ctx.deps.github())
  const got = await cached(ctx.deps.githubCache, repo, `progress-typical:${workflowId}`, async () => {
    const runs = GhRuns.parse(await gh.request('GET', `${repoPath(repo)}/actions/workflows/${workflowId}/runs?status=success&per_page=3`)).workflow_runs
    const jobs = (await Promise.all(runs.map((r) => gh.request('GET', `${repoPath(repo)}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`).then((j) => GhJobs.parse(j).jobs).catch(() => [])))).flat()
    const by: Record<string, number[]> = {}
    for (const j of jobs) { const s = seconds(j.started_at, j.completed_at); if (s !== null && j.conclusion === 'success') (by[j.name] ??= []).push(s) }
    return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, median(v) ?? 0]))
  }, TYPICAL_TTL_MS).catch(() => ({} as Record<string, number>))
  return new Map(Object.entries(got))
}

/** The jobs of the given runs as CheckJobs, with the stream's newest line for the running ones on CodeBuild. */
async function checkJobs(ctx: Context, repo: string, runs: readonly GhRun[], q: QuietProfile | null, now: number): Promise<{ job: CheckJob; run: GhRun }[]> {
  const r = reader(ctx)
  const out = await Promise.all(runs.map(async (run) => {
    const [jobs, typical] = await Promise.all([jobsOfRun(ctx, repo, run), typicalJobs(ctx, repo, run.workflow_id)])
    const anyRunningAws = jobs.some((j) => j.status === 'in_progress' && runnerOf(j) === 'aws')
    const names = anyRunningAws && r
      ? (await cached(ctx.deps.githubCache, repo, `progress-streams:${run.id}:${run.run_attempt ?? 1}`, () => r.streams(checkStreamPrefix(repo, run.id, run.run_attempt ?? 1), { limit: 50 }), RUNNING_TTL_MS).catch(() => [])).map((s) => s.name)
      : []
    return Promise.all(jobs.map(async (j) => {
      const { steps, step, stepIndex } = stepsOf(j)
      const state = jobState(j.status, j.conclusion)
      let heardAt: string | null = null
      let newest: string | null = null
      const stream = state === 'running' ? streamForJob(names, j.name) : null
      if (stream && r) {
        const n = await cached(ctx.deps.githubCache, repo, `progress-newest:${stream}`, () => r.newest(stream), RUNNING_TTL_MS).catch(() => null)
        if (n) { heardAt = new Date(n.at).toISOString(); newest = short(toLogLine(n.at, n.text).text) }
      }
      const job: CheckJob = {
        id: j.id, run: `check:${j.id}`, name: j.name, workflow: run.name ?? j.workflow_name ?? '', state,
        startedAt: state === 'queued' ? null : isoOr(j.started_at), completedAt: isoOr(j.completed_at),
        steps, step, stepIndex, stepCount: steps.length,
        typicalS: typical.get(j.name) ?? null,
        queuedS: state === 'queued' ? Math.max(0, Math.round((now - Date.parse(j.created_at ?? run.created_at)) / 1000)) : null,
        heardAt, newest, usualQuietS: usual(q, 'check', j.name, step), runner: runnerOf(j),
      }
      return { job, run, gh: j }
    }))
  }))
  const flat = out.flat()
  // learn the quiet of a couple of finished checks not learned yet (in the background: never slows the page)
  const unseen = flat.filter((x) => (x.job.state === 'passed' || x.job.state === 'failed') && !q?.seen.includes(x.job.run)).slice(0, 2)
  for (const u of unseen) void learnCheck(ctx, repo, u.gh)
  return flat.map(({ job, run }) => ({ job, run }))
}

/** The trace loop's own workflows (opening pull requests, merging, the worker): its housekeeping, not a check. */
const loopWorkflow = (r: Pick<GhRun, 'path' | 'name'>): boolean => /(^|\/)trace-[^/]*\.ya?ml$/.test(r.path ?? '') || /^trace\b/i.test(r.name ?? '')

export async function changeRuns(ctx: Context, repo: string, number: number): Promise<{ repo: string; number: number; sha: string; jobs: CheckJob[]; updatedAt: string }> {
  const gh = await ctx.deps.github()
  if (!gh.pullStatus) throw new ActionError('This installation cannot read pull requests.')
  const s = await cached(ctx.deps.githubCache, repo, `progress-pull:${number}`, () => gh.pullStatus!(repo, number), RUNNING_TTL_MS)
  if (!s) throw new ActionError(`${repo} has no change #${number}`)
  const now = Date.now()
  const [runs, q] = await Promise.all([runsForSha(ctx, repo, s.sha).catch((e: unknown) => { if (e instanceof GitHubError && e.status === 403) return []; throw e }), quietOf(ctx, repo)])
  const jobs = (await checkJobs(ctx, repo, runs.filter((r) => !loopWorkflow(r)), q, now)).map((x) => x.job)
  const rank: Record<CheckState, number> = { running: 0, queued: 1, failed: 2, passed: 3, cancelled: 4, skipped: 5 }
  jobs.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name))
  return { repo, number, sha: s.sha, jobs, updatedAt: new Date(now).toISOString() }
}

// ------------------------------------------------------------------ activity.list

function jobItem(repo: string, j: IndexedJob, q: QuietProfile | null): ActivityItem | null {
  if (j.state !== 'running' && j.state !== 'queued' && j.state !== 'paused') return null
  return {
    kind: 'job', repo, run: `job:${j.workerJobId}`, title: j.title, state: j.state,
    step: j.state === 'queued' ? (j.queue?.startsWhen ?? j.step) : j.step, stepIndex: null, stepCount: null,
    startedAt: j.startedAt, typicalS: j.typicalS, heardAt: j.heard?.at ?? null, newest: j.step ? short(j.step) : null,
    usualQuietS: usual(q, 'job', j.agent ?? j.kind, j.step),
    ...(j.heard ? { overdueAt: j.heard.overdueAt, lostAt: j.heard.lostAt } : {}),
  }
}

async function checkItems(ctx: Context, repo: string, q: QuietProfile | null, now: number): Promise<ActivityItem[]> {
  const gh = ghOf(await ctx.deps.github())
  const read = (status: string): Promise<GhRun[]> => cached(ctx.deps.githubCache, repo, `progress-active:${status}`, async () => GhRuns.parse(await gh.request('GET', `${repoPath(repo)}/actions/runs?status=${status}&per_page=20`)).workflow_runs, ACTIVITY_TTL_MS)
  const runs = (await Promise.all([read('in_progress'), read('queued')])).flat().filter((r) => !loopWorkflow(r))
  const seen = new Set<number>()
  const unique = runs.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
  const jobs = await checkJobs(ctx, repo, unique, q, now)
  return jobs.filter(({ job }) => job.state === 'running' || job.state === 'queued').map(({ job, run }) => {
    const number = run.pull_requests[0]?.number
    return {
      kind: 'check' as const, repo, run: job.run, title: `${job.name} on ${number ? `#${number}` : (run.head_branch ?? 'a branch')}`, state: job.state === 'queued' ? 'queued' as const : 'running' as const,
      step: job.state === 'queued' ? 'waiting for a build machine' : job.step, stepIndex: job.stepIndex, stepCount: job.stepCount || null,
      startedAt: job.startedAt, typicalS: job.typicalS, heardAt: job.heardAt, newest: job.newest, usualQuietS: job.usualQuietS,
      ...(number ? { change: number } : {}),
    }
  })
}

async function toolItems(ctx: Context, repo: string, q: QuietProfile | null, now: number): Promise<ActivityItem[]> {
  const r = reader(ctx)
  if (!r) return []
  const streams = await cached(ctx.deps.githubCache, repo, 'progress-tool-streams', () => r.streams(toolStreamPrefix(repo), { limit: 8, descending: true }), ACTIVITY_TTL_MS)
  const recent = streams.filter((s) => s.lastEventAt !== null && (now - s.lastEventAt) / 1000 < TOOL_SILENT_S)
  const items = await Promise.all(recent.map(async (s): Promise<ActivityItem | null> => {
    const p = parseStream(s.name)
    if (p?.kind !== 'tool') return null
    const [first, newest] = await Promise.all([r.read(s.name, { limit: 1 }), r.newest(s.name)])
    if (!newest || END.test(newest.text.trimStart())) return null
    const name = /^▸ (\S+)/.exec(first.events[0]?.text ?? '')?.[1] ?? 'A tool'
    return {
      kind: 'tool', repo, run: `tool:${p.id}`, title: name, state: 'running', step: short(toLogLine(newest.at, newest.text).text), stepIndex: null, stepCount: null,
      startedAt: s.firstEventAt ? new Date(s.firstEventAt).toISOString() : null, typicalS: null,
      heardAt: new Date(newest.at).toISOString(), newest: short(toLogLine(newest.at, newest.text).text), usualQuietS: usual(q, 'tool', name, null),
    }
  }))
  return items.filter((x): x is ActivityItem => x !== null)
}

export async function activity(ctx: Context): Promise<{ items: ActivityItem[]; waits: number; updatedAt: string; unreadable?: string[] }> {
  const now = Date.now()
  const projects = (await projectsFor(ctx.principal)).slice(0, MAX_PROJECTS)
  const unreadable: string[] = []
  const per = await Promise.all(projects.map(async ({ repo }) => {
    const q = await quietOf(ctx, repo)
    const parts = await Promise.allSettled([
      listJobs(ctx, repo, { at: now / 1000 }).then(({ jobs }) => jobs.map((j) => jobItem(repo, j, q)).filter((x): x is ActivityItem => x !== null)),
      checkItems(ctx, repo, q, now),
      toolItems(ctx, repo, q, now),
    ])
    const items: ActivityItem[] = []
    for (const p of parts) {
      if (p.status === 'fulfilled') items.push(...p.value)
      else if (!unreadable.includes(repo)) unreadable.push(repo)
    }
    return items
  }))
  const rank = { running: 0, paused: 1, queued: 2 } as const
  const kinds = { check: 0, job: 1, tool: 2 } as const
  const items = per.flat().sort((a, b) => kinds[a.kind] - kinds[b.kind] || rank[a.state] - rank[b.state] || (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))
  return { items, waits: 0, updatedAt: new Date(now).toISOString(), ...(unreadable.length ? { unreadable } : {}) }
}

export const PROGRESS_ACTIONS = {
  'run.log': def('read', RunLogArgs, async (a, ctx) => runLog(ctx, a)),
  'change.runs': def('read', Repo.extend({ number: z.number().int().min(1) }), async ({ repo, number }, ctx) => changeRuns(ctx, repo, number)),
  'activity.list': def('signed-in', z.object({}), async (_a, ctx) => activity(ctx)),
}

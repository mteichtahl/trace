/**
 * Checks that cannot start (test-esp32 log #146): a change's workflow runs sit queued and no runner ever picks them up.
 * In run 2 a project's jobs waited 20 hours on its CodeBuild runner (`runs-on: codebuild-<project>-…`, src/infra/
 * runner.ts) because every build CodeBuild started for them failed in DOWNLOAD_SOURCE: "GitHub rejected the runner
 * credential because it lacks the required permission (administration=write). Re-authorize the CodeConnections
 * connection". GitHub keeps such a job queued for a day and CodeBuild never tries it again, yet the change cards said
 * "Checks running, 0 of 2 done" and the Overview "trace is working".
 *
 *   noticed      a workflow run of the repository queued for STUCK_AFTER_S or more (one GitHub call per repository,
 *                kept a minute: stuckLook). A change whose head commit has one has stuck checks (stuckFor)
 *   why          the runner its jobs ask for: the repository's TRACE_CODEBUILD_PROJECT variable (none: GitHub's own
 *                runners), and, when the API may read them (ActionDeps.runnerBuilds, CodeBuild's ListBuildsForProject
 *                and BatchGetBuilds on the installation's runner projects only), that project's newest builds: the
 *                failed phase and CodeBuild's own message (runnerFault). Only CodeBuild's words count: a credential
 *                fault is named as one only when its message says so
 *   what to do   in plain words, for an admin (stuckView's `fix`): re-authorize the GitHub connection with
 *                administration access, fix the runner project, or look at GitHub's runners
 *   run again    a job GitHub queued is never offered to a runner again, so once the cause is fixed the runs must be
 *                cancelled and run again (restartStuck): every stuck queued run is cancelled (a queued run holds its
 *                concurrency group, and the runs behind it in the group wait on it), and the newest of each workflow
 *                and branch is run again. trace does it itself every AUTO_RETRY_S while checks are stuck on a CodeBuild
 *                runner (a retry that fails costs one short build, and is how trace notices the fix), and at once when
 *                a person presses "Run the checks again" (changes.rerun_stuck, change.rerun)
 */
import { z } from 'zod'
import { RUNNER_VARIABLE } from '../core/project.js'
import type { Context } from './action-kit.js'
import { GitHubError, type GitHubApi } from './github.js'
import { cached } from './github-cache.js'

/** A run queued this long has no runner coming: GitHub hands a queued job to a runner within minutes when one exists. */
export const STUCK_AFTER_S = 30 * 60
/** How often trace itself cancels and runs again the checks stuck on a CodeBuild runner, per repository. */
export const AUTO_RETRY_S = 30 * 60
/** How long what was looked up is kept: the queued runs and the runner's builds change slowly. */
export const LOOK_TTL_MS = 60_000
/** At most this many stuck runs are cancelled and run again in one go. */
export const MAX_RESTART = 10

/** One workflow run of the repository that is queued. */
export interface QueuedRun { id: number; name: string; workflow: number | null; branch: string | null; sha: string; queued_at: string }

/** One build of a CodeBuild runner project, newest first: its status, and the phase that failed with CodeBuild's message. */
export interface RunnerBuild { at: string; status: string; phase: string | null; message: string | null }

/** The runner a repository's jobs ask for. */
export interface RunnerState {
  /** the CodeBuild runner project (the repository's TRACE_CODEBUILD_PROJECT); null: GitHub's own runners, or not known */
  project: string | null
  /** its newest builds, newest first; null: trace may not read them (or there is no project) */
  builds: RunnerBuild[] | null
}

/** A change's checks that cannot start, as the API answers them (ChangeSummary.stuck). */
export interface StuckChecks {
  /** how many of its workflow runs wait for a runner */
  runs: number
  /** since when the oldest has waited */
  since: string
  /** the CodeBuild runner project they wait for; null: GitHub's own runners */
  runner: string | null
  /** why they cannot start, in plain words, starting lower case ("the CodeBuild runner cannot …") */
  why: string
  /** the runner's builds fail on its GitHub connection: an admin re-authorizes it */
  connection: boolean
  /** what fixes it, in plain words, for an admin */
  fix: string
}

/** What one look at the repository found: its stuck queued runs, and (only when there are some) its runner. */
export interface StuckLook { runs: QueuedRun[]; runner: RunnerState | null }

const RunsBody = z.object({
  workflow_runs: z.array(z.object({
    id: z.number(), name: z.string().nullable().optional(), workflow_id: z.number().nullable().optional(), head_branch: z.string().nullable().optional(),
    head_sha: z.string(), status: z.string().nullable().optional(), created_at: z.string(), run_started_at: z.string().nullable().optional(),
  }).loose()),
}).loose()

/** The repository's queued workflow runs, from GitHub's answer to GET actions/runs?status=queued. Pure. */
export function queuedRuns(body: unknown): QueuedRun[] {
  const r = RunsBody.safeParse(body)
  if (!r.success) return []
  return r.data.workflow_runs.filter((w) => (w.status ?? 'queued') === 'queued').map((w) => ({
    id: w.id, name: w.name ?? '', workflow: w.workflow_id ?? null, branch: w.head_branch ?? null, sha: w.head_sha,
    // a run attempted again is queued from its new attempt's start, not from when the first attempt was made
    queued_at: w.run_started_at ?? w.created_at,
  }))
}

/** The runs queued STUCK_AFTER_S or more by `at` (seconds). Pure. */
export const stuckRuns = (runs: readonly QueuedRun[], at: number): QueuedRun[] =>
  runs.filter((r) => { const t = Date.parse(r.queued_at) / 1000; return Number.isFinite(t) && at - t >= STUCK_AFTER_S })

/** A change's stuck runs, by its head commit: how many, and since when the oldest waits; null when none. Pure. */
export function stuckOn(runs: readonly QueuedRun[], sha: string | null | undefined, at: number): { runs: number; since: string } | null {
  if (!sha) return null
  const mine = stuckRuns(runs, at).filter((r) => r.sha === sha)
  if (!mine.length) return null
  return { runs: mine.length, since: mine.map((r) => r.queued_at).sort()[0]! }
}

/** CodeBuild's builds as the runner reads them, newest first. Pure (the SDK's shapes, loosely). */
export function runnerBuildsOf(builds: readonly {
  startTime?: Date | string | undefined; buildStatus?: string | undefined
  phases?: readonly { phaseType?: string | undefined; phaseStatus?: string | undefined; contexts?: readonly { message?: string | undefined; statusCode?: string | undefined }[] | undefined }[] | undefined
}[]): RunnerBuild[] {
  return builds.map((b) => {
    const failed = (b.phases ?? []).find((p) => p.phaseStatus && p.phaseStatus !== 'SUCCEEDED' && p.phaseStatus !== 'IN_PROGRESS')
    const message = failed?.contexts?.map((c) => c.message ?? '').filter(Boolean).join(' ').trim() || null
    const at = b.startTime instanceof Date ? b.startTime.toISOString() : b.startTime ?? ''
    return { at, status: b.buildStatus ?? 'UNKNOWN', phase: failed?.phaseType ?? null, message: message ? message.slice(0, 500) : null }
  }).sort((a, b) => b.at.localeCompare(a.at))
}

const FAILED = new Set(['FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED'])
// CodeBuild's own words for a runner that cannot get its GitHub token through the connection
const CONNECTION = /administration|lacks the required permission|re-?authori[sz]e the (?:codeconnections |codestar )?connection|GetConnectionToken|runner credential/i

/**
 * Why the runner's builds fail, from its newest builds: null when the newest did not fail (or there are none, or trace
 * may not read them). `connection`: CodeBuild says the GitHub connection's credential was refused. Pure.
 */
export function runnerFault(builds: readonly RunnerBuild[] | null): { why: string; connection: boolean; failed: number } | null {
  const newest = builds?.[0]
  if (!builds || !newest || !FAILED.has(newest.status)) return null
  let failed = 0
  while (failed < builds.length && FAILED.has(builds[failed]!.status)) failed++
  const said = newest.message ?? ''
  if (CONNECTION.test(said)) {
    const admin = /administration/i.test(said)
    return { why: `the CodeBuild runner cannot get a GitHub runner token, because ${admin ? 'its GitHub connection lacks administration access' : 'GitHub refused its connection\'s credential'}`, connection: true, failed }
  }
  const where = newest.phase ? ` in ${newest.phase}` : ''
  return { why: `the CodeBuild runner's builds fail${where}${said ? ` ("${said.slice(0, 200).replace(/\s+/g, ' ').trim()}")` : ''}`, connection: false, failed }
}

/** How long since `since`, in words: "40 minutes", "20 hours", "2 days". */
export function waitedFor(since: string, at: number): string {
  const s = Math.max(0, at - Date.parse(since) / 1000)
  const n = (x: number, one: string): string => `${x} ${one}${x === 1 ? '' : 's'}`
  if (s < 90 * 60) return n(Math.max(1, Math.round(s / 60)), 'minute')
  if (s < 36 * 3600) return n(Math.round(s / 3600), 'hour')
  return n(Math.round(s / 86400), 'day')
}

/** What re-authorizing the connection is, for an admin. */
export const CONNECTION_FIX = 'An admin re-authorizes the GitHub connection with administration access: in the AWS console, open Developer Tools, Settings, Connections, choose the connection and update it, then on GitHub accept the AWS Connector for GitHub app\'s request for "Administration: read and write".'
/** What follows once the cause is fixed. */
export const RERUN_AFTER = 'trace then runs the stuck checks again itself, or at once with "Run the checks again".'

/** A change's stuck checks in plain words, from its stuck runs and the runner. Pure. */
export function stuckView(on: { runs: number; since: string }, runner: RunnerState | null, at: number): StuckChecks {
  const them = on.runs === 1 ? 'it' : 'them'
  const waited = `no runner has picked ${them} up in ${waitedFor(on.since, at)}`
  const base = { runs: on.runs, since: on.since, runner: runner?.project ?? null }
  if (!runner?.project) {
    return { ...base, why: waited, connection: false, fix: 'They wait for GitHub\'s own runners. An admin checks the repository\'s Actions settings on GitHub (its runners and its minutes) and GitHub\'s status page, then runs them again.' }
  }
  const fault = runnerFault(runner.builds)
  if (fault?.connection) return { ...base, why: fault.why, connection: true, fix: `${CONNECTION_FIX} ${RERUN_AFTER}` }
  if (fault) return { ...base, why: fault.why, connection: false, fix: `An admin opens the CodeBuild project ${runner.project} in the AWS console: its failed builds say what to fix. ${RERUN_AFTER}` }
  if (runner.builds === null) {
    return { ...base, why: waited, connection: false, fix: `They wait for the CodeBuild runner ${runner.project}, whose builds trace may not read. An admin opens it in the AWS console: if its builds fail in DOWNLOAD_SOURCE because GitHub rejected the runner credential, re-authorize the GitHub connection with administration access (Developer Tools, Settings, Connections). ${RERUN_AFTER}` }
  }
  return { ...base, why: `${waited}, and the CodeBuild runner ${runner.project} started no build that failed for ${them}`, connection: false, fix: `GitHub may not be telling CodeBuild about queued jobs. An admin runs the installation's update, which gives the runner its webhook again. ${RERUN_AFTER}` }
}

/** "Its checks cannot start: …. They have waited 20 hours." for the change's recommendation and blockers. */
export function stuckWords(s: StuckChecks, at: number): string {
  return `Its checks cannot start: ${s.why}. ${s.runs === 1 ? 'It has' : 'They have'} waited ${waitedFor(s.since, at)}. ${s.fix}`
}

// ------------------------------------------------------------------ looking, kept a minute

/** The runner the repository's jobs ask for, and its newest builds when the API may read them (kept LOOK_TTL_MS). */
export async function runnerState(ctx: Context, gh: GitHubApi, repo: string): Promise<RunnerState> {
  return cached(ctx.deps.githubCache, repo, 'runner', async () => {
    const project = (await gh.repoVariable?.(repo, RUNNER_VARIABLE).catch(() => null))?.trim() || null
    const builds = project && ctx.deps.runnerBuilds ? await ctx.deps.runnerBuilds(project).catch(() => null) : null
    return { project, builds }
  }, LOOK_TTL_MS)
}

/**
 * The repository's stuck queued runs and, when there are any, its runner (kept LOOK_TTL_MS). Null when GitHub will not
 * list the runs (a token without "Actions: read", an installation without `request`): then nothing is said about it.
 */
export async function stuckLook(ctx: Context, repo: string, at = Date.now() / 1000): Promise<StuckLook | null> {
  const gh = await ctx.deps.github()
  if (typeof gh.request !== 'function') return null
  const [o, n] = repo.split('/')
  return cached(ctx.deps.githubCache, repo, 'stuck-look', async () => {
    const body = await gh.request!('GET', `/repos/${encodeURIComponent(o ?? '')}/${encodeURIComponent(n ?? '')}/actions/runs?status=queued&per_page=100`).catch(() => undefined)
    if (body === undefined) return null
    const runs = stuckRuns(queuedRuns(body), at)
    return { runs, runner: runs.length ? await runnerState(ctx, gh, repo) : null }
  }, LOOK_TTL_MS)
}

/** A change's stuck checks from a look, by its head commit; null when none. */
export const stuckFor = (look: StuckLook | null, sha: string | null | undefined, at = Date.now() / 1000): StuckChecks | null => {
  const on = look ? stuckOn(look.runs, sha, at) : null
  return on ? stuckView(on, look!.runner, at) : null
}

// ------------------------------------------------------------------ running them again

/** What restartStuck did: runs cancelled, runs started again, and runs that were still stopping (run again later). */
export interface RestartResult { cancelled: number; rerun: number; later: number }

/**
 * Cancel the stuck queued runs and run again the newest of each workflow and branch (an older one of the same was
 * superseded, and only held the concurrency group). `only`: the head commits to act for (null: every stuck run).
 * A cancelled run can be run again only once GitHub has stopped it: it is looked at up to `tries` times, `wait` apart;
 * one still stopping is counted in `later` and run again on the next pass. GitHub's refusals are thrown as they come.
 */
export async function restartStuck(gh: Required<Pick<GitHubApi, 'request'>>, repo: string, runs: readonly QueuedRun[], o: { only?: ReadonlySet<string> | null; sleep: (ms: number) => Promise<void>; tries?: number; wait?: number }): Promise<RestartResult> {
  const [owner, name] = repo.split('/')
  const base = `/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}/actions/runs`
  const mine = runs.filter((r) => !o.only || o.only.has(r.sha)).slice(0, MAX_RESTART)
  // the newest of each workflow and branch is run again; the older ones were superseded
  const newest = new Map<string, QueuedRun>()
  for (const r of mine) {
    const k = `${r.workflow ?? r.name}\n${r.branch ?? ''}`
    const had = newest.get(k)
    if (!had || had.queued_at < r.queued_at || (had.queued_at === r.queued_at && had.id < r.id)) newest.set(k, r)
  }
  let cancelled = 0
  for (const r of mine) {
    try {
      await gh.request('POST', `${base}/${r.id}/cancel`)
      cancelled++
    } catch (e) {
      // it stopped on its own meanwhile (409: it is completed already): it can still be run again
      if (!(e instanceof GitHubError && e.status === 409)) throw e
    }
  }
  let rerun = 0
  let later = 0
  const tries = o.tries ?? 5
  for (const r of newest.values()) {
    let done = false
    for (let i = 0; i < tries && !done; i++) {
      const s = z.object({ status: z.string().nullable().optional() }).loose().safeParse(await gh.request('GET', `${base}/${r.id}`).catch(() => null))
      done = s.success && s.data.status === 'completed'
      if (!done && i < tries - 1) await o.sleep(o.wait ?? 2_000)
    }
    if (!done) { later++; continue }
    await gh.request('POST', `${base}/${r.id}/rerun`)
    rerun++
  }
  return { cancelled, rerun, later }
}

// trace's own tries, per repository, in this process: at most one every AUTO_RETRY_S
const tried = new Map<string, number>()

/** Whether trace tries the repository's stuck checks again now on its own, and if so marks it tried. */
export function dueRetry(repo: string, look: StuckLook | null, at: number): boolean {
  if (!look?.runs.length || !look.runner?.project) return false
  const last = tried.get(repo.toLowerCase())
  if (last !== undefined && at - last < AUTO_RETRY_S) return false
  tried.set(repo.toLowerCase(), at)
  return true
}

/** Forget trace's own tries (tests). */
export const forgetRetries = (): void => { tried.clear() }

// ------------------------------------------------------------------ CodeBuild

/**
 * The newest builds of a CodeBuild runner project, through the SDK: ListBuildsForProject (newest first) then
 * BatchGetBuilds for the first `n`. The API's role may do both on the installation's runner projects only
 * (`<prefix>-ci-*`, src/infra/api-grants.ts); anything else is refused by IAM, and reads as "may not read them".
 */
export function codeBuildRunnerBuilds(region: string, n = 5): (project: string) => Promise<RunnerBuild[]> {
  return async (project) => {
    const cb = await import('@aws-sdk/client-codebuild')
    const client = new cb.CodeBuildClient({ region })
    const ids = ((await client.send(new cb.ListBuildsForProjectCommand({ projectName: project, sortOrder: 'DESCENDING' }))).ids ?? []).slice(0, n)
    if (!ids.length) return []
    const got = await client.send(new cb.BatchGetBuildsCommand({ ids }))
    return runnerBuildsOf(got.builds ?? [])
  }
}

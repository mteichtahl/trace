/**
 * Deploys in the app (docs/stay-in-trace.md "2. Deploys"). A deploy request used to be a GitHub issue that a person
 * approved by commenting `/approve <sha>`, and a rollback was a workflow button. Now a person sees the request, trace's
 * recommendation, what runs now and what happened lately on the project's Build tab, and decides there.
 *
 *   deploys.get      read               { repo } → DeploysView: whether deploys are on, the environment, what runs now,
 *                                       the open request with the commits since what runs now, a deploy running now
 *                                       and the step it is on, the last results, and trace's recommendation
 *   deploy.approve   write + allowed    { repo, sha } → { started, approval, next }: `sha` is the commit the person was
 *                                       shown. Refused unless it is the open request's commit, its build passed and it
 *                                       is the newest commit that passed (the rules `approve` in src/harness/deploy.ts
 *                                       holds the workflow to). Writes the approval record, records deploy.approved,
 *                                       and starts trace-deploy.yml with the record's name and the commit
 *   deploy.skip      write + allowed    { repo, reason } → { skipped }: closes the request as not planned, posts the
 *                                       reason as a quote, records deploy.skipped
 *   deploy.rollback  write + allowed    { repo, to } → { started, approval }: `to` is a commit that ran in the
 *                                       environment before (recent's deployed entries). Writes a rollback approval,
 *                                       records deploy.rollback, starts the workflow; its rollback job puts `to` back
 *
 * "Allowed": a trace admin, or a person whose email is in the project's setting deploy.people. A Contributor who is not
 * one of them reads deploys and cannot decide; a connected system reads only (src/api/service-policy.ts).
 *
 * The approval (src/core/deploy-approvals.ts) is written with a conditional put to the central bucket, under the
 * journey's folder, which only the API may write: an agent can never approve, because it cannot write the record, and
 * the workflow deploys nothing for a name that has no record, another repository's, another commit's or an expired one.
 *
 * What the app shows is read from GitHub without the app ever showing an issue: the deploy issues the workflow opened
 * (their author is the workflow's own account, github-actions[bot], as guard trusts them: an issue a person opened, or
 * one a person can edit to look like a record, is never read), the deploy workflow's runs and jobs, and the build's
 * runs. A skip is read from the decisions log too. Each call to GitHub is kept a short while (src/api/github-cache.ts);
 * deciding reads everything fresh.
 *
 * What is posted on GitHub as trace's account (a skip's reason) goes through neutralise/quote (src/api/actions-changes.ts)
 * and names the person by publicName: never their email.
 */
import { z } from 'zod'
import { isAdmin, isService } from '../core/access.js'
import { type TraceConfig, readSettings, resolve } from '../core/config.js'
import { APPROVAL_TTL_MS, type DeployApproval, DeployApprovals } from '../core/deploy-approvals.js'
import { type DecisionRow, decide, loadJourney } from '../core/journey.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { ActionError, type Context, PROJECT_DB_PATH, Repo, def, label, storeAt, tempDb, withJourneyDb, writeJourney } from './action-kit.js'
import { publicName, quote } from './actions-changes.js'
import type { GitHubApi } from './github.js'
import { SETTINGS_TTL_MS, cached } from './github-cache.js'

// ------------------------------------------------------------------ the view

export type DeployResult = 'deployed' | 'failed' | 'rolled_back' | 'skipped'

export interface DeploysView {
  enabled: boolean; environment: string; url: string | null; auto: boolean
  /** this person, now */
  may_approve: boolean
  /** what the environment runs (the newest deployed record) */
  running: { sha: string; at: string | null } | null
  /** the open deploy request, or null */
  request: {
    sha: string; opened_at: string; held: boolean; held_reasons: string[]
    /** since the running one, newest first, at most 30 */
    commits: { sha: string; subject: string }[]
    build_passed: boolean
  } | null
  in_progress: { sha: string; started_at: string; by: string; step: string | null } | null
  /** the last 10, newest first */
  recent: { sha: string; result: DeployResult; at: string; by: string }[]
  recommendation: { verdict: 'deploy' | 'wait' | 'none'; why: string }
}

/** The deploy workflow (templates/workflows/trace-deploy.yml) as the installer writes it. */
export const DEPLOY_WORKFLOW = 'trace-deploy.yml'
/** The workflow's own account: the only author whose deploy issues are read (src/harness/deploy.ts guard). */
export const WORKFLOW_LOGIN = 'github-actions[bot]'

const DEPLOY_SHA = /<!-- trace-deploy-sha: ([0-9a-f]{40}) -->/
const DEPLOYED_SHA = /<!-- trace-deployed-sha: ([0-9a-f]{40}) -->/
const DEPLOYED_BY = /<!-- trace-deployed-by: ([^\n]*?) -->/
const FAILED = /<!-- trace-deploy-failed: ([0-9a-f]{40}) (\S+) -->/
const ROLLBACK = /<!-- trace-rollback -->/
const ROLLBACK_FAILED = /<!-- trace-rollback-failed: ([0-9a-f]{40})(?: (\S+))? -->/

/** One deploy issue as GitHub lists it: exactly the fields read here. */
export const DeployIssue = z.object({
  number: z.number(),
  state: z.string(),
  state_reason: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  user: z.object({ login: z.string() }).loose().nullable().optional(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() }).loose()])).default([]),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable().optional(),
  pull_request: z.unknown().optional(),
}).loose()
export type DeployIssue = z.infer<typeof DeployIssue>

/** A workflow run as GitHub lists it: the fields read here. */
export const RunRow = z.object({
  id: z.number(), event: z.string(), status: z.string().nullable(), conclusion: z.string().nullable().optional(),
  head_sha: z.string(), created_at: z.string(), run_started_at: z.string().nullable().optional(),
}).loose()
export type RunRow = z.infer<typeof RunRow>

/** A run's job: its name, state and steps. */
export const JobRow = z.object({
  name: z.string(), status: z.string(),
  steps: z.array(z.object({ name: z.string(), status: z.string() }).loose()).nullable().optional(),
}).loose()
export type JobRow = z.infer<typeof JobRow>

/** Everything the view is made of: what GitHub, the store and the log said. */
export interface DeployFacts {
  cfg: Pick<TraceConfig['deploy'], 'enabled' | 'environment' | 'url' | 'auto'> & { people: string[] }
  labels: { deploy: string; deploy_held: string }
  issues: DeployIssue[]
  /** the open request's held reasons (the risk check's lines), when held */
  heldReasons: string[]
  /** commits since what runs now, oldest first (as GitHub's compare lists them) */
  commits: { sha: string; subject: string }[]
  buildPassed: boolean
  /** the newest commit whose build passed on the default branch */
  newest: string | null
  /** the deploy workflow's run going on now, with its jobs */
  running: { run: RunRow; jobs: JobRow[] } | null
  approvals: { name: string; approval: DeployApproval }[]
  decisions: Pick<DecisionRow, 'kind' | 'at' | 'ref' | 'by' | 'detail'>[]
}

const labelNames = (ls: DeployIssue['labels']): string[] => ls.map((l) => (typeof l === 'string' ? l : l.name))

/** Only the deploy issues the workflow opened: a person's issue, or a pull request, is never a deploy record. */
export const trusted = (issues: readonly DeployIssue[]): DeployIssue[] => issues.filter((i) => i.user?.login === WORKFLOW_LOGIN && !i.pull_request)

/** The open request: the workflow's newest open deploy issue that names a commit. */
export function openRequest(issues: readonly DeployIssue[]): { issue: DeployIssue; sha: string } | null {
  const open = trusted(issues).filter((i) => i.state === 'open').sort((a, b) => b.created_at.localeCompare(a.created_at))
  for (const i of open) {
    const sha = DEPLOY_SHA.exec(i.body ?? '')?.[1]
    if (sha) return { issue: i, sha }
  }
  return null
}

/** Who a record names: the marker the report wrote, else "someone" (an older record). */
const byOf = (body: string): string => DEPLOYED_BY.exec(body)?.[1]?.trim() || 'someone on GitHub'

/**
 * What happened lately, newest first, at most `max`: deploys and rollbacks the workflow recorded, failures it marked,
 * and requests skipped (from the decisions log when trace skipped it, else a request closed as not planned).
 */
export function recentResults(issues: readonly DeployIssue[], decisions: DeployFacts['decisions'], max = 10): DeploysView['recent'] {
  const out: DeploysView['recent'] = []
  const skippedHere = new Map<string, DeployFacts['decisions'][number]>()
  for (const d of decisions) if (d.kind === 'deploy.skipped' && d.ref) skippedHere.set(d.ref, d)
  for (const i of trusted(issues)) {
    const body = i.body ?? ''
    const deployed = DEPLOYED_SHA.exec(body)?.[1]
    const when = i.closed_at ?? i.updated_at
    if (deployed) out.push({ sha: deployed, result: ROLLBACK.test(body) ? 'rolled_back' : 'deployed', at: when, by: byOf(body) })
    const failed = FAILED.exec(body)
    if (failed) out.push({ sha: failed[1]!, result: 'failed', at: failed[2]!, by: byOf(body) })
    const rbFailed = ROLLBACK_FAILED.exec(body)
    if (rbFailed) out.push({ sha: rbFailed[1]!, result: 'failed', at: rbFailed[2] ?? when, by: byOf(body) })
    if (i.state === 'closed' && i.state_reason === 'not_planned' && !deployed && !rbFailed) {
      const sha = DEPLOY_SHA.exec(body)?.[1]
      const d = skippedHere.get(String(i.number))
      const name = d && typeof d.detail === 'object' && d.detail && 'by_name' in d.detail ? String((d.detail as { by_name: unknown }).by_name) : null
      if (sha) out.push({ sha, result: 'skipped', at: d ? new Date(d.at * 1000).toISOString() : when, by: name ?? 'someone on GitHub' })
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, max)
}

/** What runs now: the newest record that put a commit in the environment (a deploy or a rollback). */
export function runningNow(recent: DeploysView['recent']): DeploysView['running'] {
  const r = recent.find((x) => x.result === 'deployed' || x.result === 'rolled_back')
  return r ? { sha: r.sha, at: r.at } : null
}

/** Plain words for the deploy workflow's steps (their names in templates/workflows/trace-deploy.yml). */
export const STEP_WORDS: Readonly<Record<string, string>> = {
  check: 'Checking the approval', 'Set up job': 'Starting', 'Run actions/checkout': 'Getting the code', cmd: 'Reading the commands',
  guard: 'Checking what runs now', 'deploy.setup': 'Setting up', 'deploy.risk_check': 'Checking the risk', 'deploy.command': 'Deploying',
  'deploy.smoke': 'Checking it works', 'Roll back?': 'Deciding whether to roll back', Report: 'Reporting',
  'deploy.rollback (or deploy.command and deploy.smoke on the earlier commit)': 'Rolling back',
}

/**
 * The deploy running now, from the workflow's run and jobs: a deploy or rollback job going on (or the in-trace check of
 * an approval). Which commit and who: the newest approval given in trace a little before the run started, else the open
 * request's commit (an automatic deploy, or a person's /approve). A run whose request finds nothing to deploy is not one.
 */
export function inProgress(running: DeployFacts['running'], approvals: DeployFacts['approvals'], request: { sha: string } | null, auto: boolean): DeploysView['in_progress'] {
  if (!running) return null
  const live = running.jobs.filter((j) => j.status === 'in_progress' || j.status === 'queued')
  const job = live.find((j) => /^(deploy to|roll .* back|in-trace)/.test(j.name))
  if (!job) return null
  const started = running.run.run_started_at ?? running.run.created_at
  const t = Date.parse(started)
  const a = approvals.find((x) => Math.abs(Date.parse(x.approval.at) - t) < 10 * 60_000 && Date.parse(x.approval.at) <= t + 60_000)
  const step = (job.steps ?? []).find((s) => s.status === 'in_progress')?.name ?? null
  const words = step ? (STEP_WORDS[step] ?? step) : /^roll/.test(job.name) ? 'Rolling back' : null
  if (a) return { sha: a.approval.sha, started_at: started, by: a.approval.by_name, step: words }
  if (!request) return null
  const by = running.run.event === 'workflow_run' && auto ? 'trace (automatic)' : 'someone on GitHub'
  return { sha: request.sha, started_at: started, by, step: words }
}

/** trace's recommendation, with its reason. */
export function recommend(v: Omit<DeploysView, 'recommendation' | 'may_approve'>, newest: string | null): DeploysView['recommendation'] {
  if (!v.enabled) return { verdict: 'none', why: 'Deploys are off for this project. An admin turns them on in the project\'s settings (deploy.enabled).' }
  if (v.in_progress) return { verdict: 'none', why: 'A deploy is running now. Wait for it to finish before deciding anything else.' }
  const r = v.request
  if (!r) return { verdict: 'none', why: v.running ? `Nothing is waiting: ${v.environment} runs the newest commit that passed its build.` : 'Nothing is waiting. A request appears here when the build passes on the main branch.' }
  if (!r.build_passed) return { verdict: 'wait', why: 'Its build has not passed yet. Wait for it to pass.' }
  if (newest && newest !== r.sha) return { verdict: 'wait', why: 'A newer commit passed its build. The request moves to it in a moment; decide then.' }
  if (r.held) return { verdict: 'wait', why: `The risk check would not deploy it on its own${r.held_reasons[0] ? `: ${r.held_reasons[0]}` : ''}. Deploy it only once you have read why.` }
  const n = r.commits.length
  return { verdict: 'deploy', why: `Its build passed and it is the newest commit that passed.${n ? ` It brings ${n} change${n === 1 ? '' : 's'} since what runs now.` : ''}` }
}

/** The whole view from the facts, for this person. */
export function deploysView(f: DeployFacts, mayApprove: boolean): DeploysView {
  const req = openRequest(f.issues)
  const recent = recentResults(f.issues, f.decisions)
  const base = {
    enabled: f.cfg.enabled, environment: f.cfg.environment, url: f.cfg.url || null, auto: f.cfg.auto,
    running: runningNow(recent),
    request: req ? {
      sha: req.sha, opened_at: req.issue.created_at, held: labelNames(req.issue.labels).includes(f.labels.deploy_held), held_reasons: f.heldReasons,
      commits: f.commits.slice().reverse().slice(0, 30), build_passed: f.buildPassed,
    } : null,
    in_progress: inProgress(f.running, f.approvals, req, f.cfg.auto),
    recent,
  }
  return { ...base, may_approve: mayApprove && f.cfg.enabled, recommendation: recommend(base, f.newest) }
}

/** The risk check's lines from the workflow's "Held for a person" comment (src/harness/deploy.ts hold). */
export function heldReasonsOf(comments: readonly { body?: string | null; user?: { login: string } | null }[]): string[] {
  const c = comments.slice().reverse().find((x) => x.user?.login === WORKFLOW_LOGIN && (x.body ?? '').startsWith('**Held for a person:**'))
  if (!c) return []
  const lines = (c.body ?? '').split('\n').slice(1)
  const end = lines.findIndex((l) => l.startsWith('Nothing was deployed.'))
  return (end < 0 ? lines : lines.slice(0, end)).map((l) => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean).slice(0, 10)
}

// ------------------------------------------------------------------ who may decide

/** Whether this person may approve, skip or roll back: a trace admin, or their email in deploy.people. Never a system. */
export function mayDecide(p: Context['principal'], people: readonly string[]): boolean {
  if (isService(p)) return false
  if (isAdmin(p)) return true
  const email = p.email?.trim().toLowerCase()
  return !!email && people.map((x) => x.trim().toLowerCase()).includes(email)
}

// ------------------------------------------------------------------ reading GitHub

/** The GitHub calls deploys need, or a plain refusal when this installation's client has none. */
function deploysApi(gh: GitHubApi): GitHubApi & Required<Pick<GitHubApi, 'request'>> {
  if (typeof gh.request !== 'function') throw new ActionError('This installation cannot show deploys in the app yet. An admin updates the installation.')
  return gh as GitHubApi & Required<Pick<GitHubApi, 'request'>>
}

const repoPath = (repo: string): string => { const [o, n] = repo.split('/'); return `/repos/${encodeURIComponent(o ?? '')}/${encodeURIComponent(n ?? '')}` }

/** The project's settings on its default branch (the defaults when they cannot be read), kept SETTINGS_TTL_MS. */
async function projectSettings(ctx: Context, repo: string): Promise<{ cfg: TraceConfig; branch: string }> {
  return cached(ctx.deps.githubCache, repo, 'deploy-settings', async () => {
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

export const approvalStore = (ctx: Context): DeployApprovals => new DeployApprovals(storeAt(ctx, PROJECTS_PREFIX))

/** Everything deploys.get shows, from GitHub, the approvals and the log. `fresh`: nothing kept is used (deciding). */
export async function deployFacts(ctx: Context, repo: string, o: { fresh?: boolean } = {}): Promise<{ facts: DeployFacts; branch: string; cfg: TraceConfig }> {
  const gh = deploysApi(await ctx.deps.github())
  const { cfg, branch } = await projectSettings(ctx, repo)
  const keep = o.fresh ? undefined : ctx.deps.githubCache
  const get = <T>(key: string, path: string, schema: z.ZodType<T>): Promise<T> => cached(keep, repo, key, async () => schema.parse(await gh.request('GET', path)))
  const p = repoPath(repo)
  const facts: DeployFacts = {
    cfg: { enabled: cfg.deploy.enabled, environment: cfg.deploy.environment, url: cfg.deploy.url, auto: cfg.deploy.auto, people: cfg.deploy.people },
    labels: { deploy: cfg.labels.deploy, deploy_held: cfg.labels.deploy_held },
    issues: [], heldReasons: [], commits: [], buildPassed: false, newest: null, running: null, approvals: [], decisions: [],
  }
  if (!cfg.deploy.enabled) return { facts, branch, cfg }
  const Runs = z.object({ workflow_runs: z.array(RunRow) }).loose()
  const [issues, newestRuns, deployRuns, approvals, decisions] = await Promise.all([
    get('deploy-issues', `${p}/issues?labels=${encodeURIComponent(cfg.labels.deploy)}&state=all&sort=updated&direction=desc&per_page=50`, z.array(DeployIssue)),
    get('deploy-newest', `${p}/actions/workflows/${encodeURIComponent(cfg.build.workflow)}/runs?branch=${encodeURIComponent(cfg.branch)}&status=success&per_page=20`, Runs).catch(() => ({ workflow_runs: [] })),
    get('deploy-runs', `${p}/actions/workflows/${DEPLOY_WORKFLOW}/runs?per_page=10`, Runs).catch(() => ({ workflow_runs: [] })),
    approvalStore(ctx).recent(repo, 10).catch(() => []),
    withJourneyDb(ctx, repo, (db) => loadJourney(db)?.decisions.filter((d) => d.kind.startsWith('deploy.')) ?? []).catch(() => []),
  ])
  facts.issues = issues
  facts.approvals = approvals
  facts.decisions = decisions
  facts.newest = newestRuns.workflow_runs.filter((r) => r.event === 'push' || r.event === 'workflow_dispatch').sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.head_sha ?? null
  const req = openRequest(issues)
  const running = runningNow(recentResults(issues, decisions))
  const live = deployRuns.workflow_runs.find((r) => r.status === 'in_progress' || r.status === 'queued')
  await Promise.all([
    (async () => {
      if (!req) return
      const passed = await get(`deploy-build:${req.sha}`, `${p}/actions/workflows/${encodeURIComponent(cfg.build.workflow)}/runs?head_sha=${req.sha}&status=success&per_page=10`, Runs).catch(() => ({ workflow_runs: [] }))
      facts.buildPassed = passed.workflow_runs.some((r) => r.event === 'push' || r.event === 'workflow_dispatch')
    })(),
    (async () => {
      if (!req || !running || running.sha === req.sha) return
      const C = z.object({ commits: z.array(z.object({ sha: z.string(), commit: z.object({ message: z.string() }).loose() }).loose()) }).loose()
      const c = await get(`deploy-compare:${running.sha}:${req.sha}`, `${p}/compare/${running.sha}...${req.sha}`, C).catch(() => null)
      facts.commits = (c?.commits ?? []).map((x) => ({ sha: x.sha, subject: x.commit.message.split('\n')[0] ?? '' }))
    })(),
    (async () => {
      if (!req || !labelNames(req.issue.labels).includes(cfg.labels.deploy_held)) return
      const Comments = z.array(z.object({ body: z.string().nullable().optional(), user: z.object({ login: z.string() }).loose().nullable().optional() }).loose())
      facts.heldReasons = heldReasonsOf(await get(`deploy-held:${req.issue.number}`, `${p}/issues/${req.issue.number}/comments?per_page=50`, Comments).catch(() => []))
    })(),
    (async () => {
      if (!live) return
      const J = z.object({ jobs: z.array(JobRow) }).loose()
      const jobs = await get(`deploy-jobs:${live.id}`, `${p}/actions/runs/${live.id}/jobs`, J).catch(() => ({ jobs: [] }))
      facts.running = { run: live, jobs: jobs.jobs }
    })(),
  ])
  return { facts, branch, cfg }
}

// ------------------------------------------------------------------ deciding

/** Record a decision about a deploy in the journey's log (a project without a journey yet keeps no log: skipped). */
async function record(ctx: Context, repo: string, d: { kind: string; ref: string; summary: string; detail: unknown }): Promise<void> {
  await writeJourney(ctx, repo, (db) => {
    const r = loadJourney(db)
    if (!r) return { result: null, changed: false }
    decide(db, { kind: d.kind, stage: r.journey.currentStage, ref: d.ref, by: label(ctx.principal), summary: d.summary, detail: d.detail })
    return { result: null }
  })
}

/** The person's name for the app and for GitHub: their name in the user pool, else their initials. */
async function nameOf(ctx: Context): Promise<string> {
  return (await publicName(ctx)).replace(/^a person on the project \((.*)\)$/, '$1')
}

/** Refuse unless this person may decide deploys on the project. */
function mustDecide(ctx: Context, f: DeployFacts): void {
  if (!f.cfg.enabled) throw new ActionError('Deploys are off for this project.')
  if (!mayDecide(ctx.principal, f.cfg.people)) throw new ActionError('Only trace\'s admins and the people named in the project\'s deploy setting (deploy.people) can decide deploys.')
}

/** Why `sha` may not be approved now, or null: the same rules as `approve` in src/harness/deploy.ts. */
export function approveRefusal(f: DeployFacts, sha: string): string | null {
  const req = openRequest(f.issues)
  if (!req) return 'Nothing is waiting to be deployed.'
  if (req.sha !== sha) return 'The request moved to a newer commit since you looked at it. Look again before deploying.'
  if (!f.buildPassed) return 'Its build has not passed, so it cannot be deployed.'
  if (f.newest && f.newest !== sha) return 'It is not the newest commit that passed its build. Look again: the request moves to the newest.'
  return null
}

/** Write the approval, record the decision, and start the deploy workflow with it. Answers the approval's name. */
async function startWith(ctx: Context, repo: string, branch: string, a: { sha: string; action: DeployApproval['action']; issue: number | null; kind: string; summary: string }): Promise<string> {
  const gh = await ctx.deps.github()
  if (typeof gh.dispatchWorkflowWith !== 'function') throw new ActionError('This installation cannot start a deploy from the app yet. An admin updates the installation.')
  const at = new Date()
  const byName = await nameOf(ctx)
  const name = await approvalStore(ctx).put({
    repo, sha: a.sha, action: a.action, by: label(ctx.principal), by_sub: ctx.principal.sub, by_name: byName,
    at: at.toISOString(), expires: new Date(at.getTime() + APPROVAL_TTL_MS).toISOString(), issue: a.issue,
  })
  await record(ctx, repo, { kind: a.kind, ref: a.sha, summary: a.summary, detail: { sha: a.sha, approval: name, issue: a.issue, by_name: byName } })
  try {
    await gh.dispatchWorkflowWith(repo, DEPLOY_WORKFLOW, branch, { approval: name, sha: a.sha })
  } catch (e) {
    throw new ActionError(`trace could not start the deploy workflow (${e instanceof Error ? e.message.slice(0, 200) : 'GitHub refused'}). Nothing was deployed; try again in a minute.`)
  } finally {
    ctx.deps.githubCache?.bust(repo)
  }
  return name
}

const Sha = z.string().regex(/^[0-9a-f]{40}$/, 'a full commit (40 hex characters)')

export const DEPLOY_ACTIONS = {
  'deploys.get': def('read', Repo, async ({ repo }, ctx) => {
    ctx.deps.githubBudget?.take(ctx.principal.sub)
    const { facts } = await deployFacts(ctx, repo)
    return deploysView(facts, mayDecide(ctx.principal, facts.cfg.people))
  }),

  'deploy.approve': def('write', Repo.extend({ sha: Sha }), async ({ repo, sha }, ctx) => {
    ctx.deps.githubBudget?.take(ctx.principal.sub)
    const { facts: f, branch } = await deployFacts(ctx, repo, { fresh: true })
    mustDecide(ctx, f)
    const why = approveRefusal(f, sha)
    if (why) throw new ActionError(why)
    const req = openRequest(f.issues)!
    const env = f.cfg.environment
    const approval = await startWith(ctx, repo, branch, {
      sha, action: 'deploy', issue: req.issue.number, kind: 'deploy.approved',
      summary: `${label(ctx.principal)} approved deploying ${sha.slice(0, 12)} to ${env}.`,
    })
    return { started: true as const, approval, next: `trace started the deploy of ${sha.slice(0, 7)} to ${env}. Its progress shows here.` }
  }),

  'deploy.skip': def('write', Repo.extend({ reason: z.string().trim().min(1).max(2000) }), async ({ repo, reason }, ctx) => {
    ctx.deps.githubBudget?.take(ctx.principal.sub)
    const gh = deploysApi(await ctx.deps.github())
    const { facts: f } = await deployFacts(ctx, repo, { fresh: true })
    mustDecide(ctx, f)
    const req = openRequest(f.issues)
    if (!req) throw new ActionError('Nothing is waiting to be deployed.')
    const p = `${repoPath(repo)}/issues/${req.issue.number}`
    // closed first, then the reason: a comment that cannot be posted must not leave it open after the person was told
    try {
      await gh.request('PATCH', p, { state: 'closed', state_reason: 'not_planned' })
    } finally {
      ctx.deps.githubCache?.bust(repo)
    }
    const byName = await nameOf(ctx)
    await gh.request('POST', `${p}/comments`, { body: `Skipped in trace by ${await publicName(ctx)}:\n\n${quote(reason)}` }).catch(() => undefined)
    await record(ctx, repo, {
      kind: 'deploy.skipped', ref: String(req.issue.number),
      summary: `${label(ctx.principal)} skipped deploying ${req.sha.slice(0, 12)} to ${f.cfg.environment}: ${reason.replace(/\s+/g, ' ').slice(0, 300)}`,
      detail: { sha: req.sha, issue: req.issue.number, by_name: byName },
    })
    return { skipped: true as const }
  }),

  'deploy.rollback': def('write', Repo.extend({ to: Sha }), async ({ repo, to }, ctx) => {
    ctx.deps.githubBudget?.take(ctx.principal.sub)
    const { facts: f, branch } = await deployFacts(ctx, repo, { fresh: true })
    mustDecide(ctx, f)
    const recent = recentResults(f.issues, f.decisions)
    const now = runningNow(recent)
    if (now?.sha === to) throw new ActionError(`${f.cfg.environment} already runs ${to.slice(0, 7)}.`)
    if (!recent.some((r) => r.sha === to && (r.result === 'deployed' || r.result === 'rolled_back'))) throw new ActionError(`${to.slice(0, 7)} has not run in ${f.cfg.environment} lately, so trace cannot roll back to it.`)
    if (inProgress(f.running, f.approvals, openRequest(f.issues), f.cfg.auto)) throw new ActionError('A deploy is running now. Wait for it to finish, then roll back if you still need to.')
    const rec = trusted(f.issues).find((i) => DEPLOYED_SHA.exec(i.body ?? '')?.[1] === to)
    const approval = await startWith(ctx, repo, branch, {
      sha: to, action: 'rollback', issue: rec?.number ?? null, kind: 'deploy.rollback',
      summary: `${label(ctx.principal)} asked to roll ${f.cfg.environment} back to ${to.slice(0, 12)}${now ? ` (it ran ${now.sha.slice(0, 12)})` : ''}.`,
    })
    return { started: true as const, approval }
  }),
}

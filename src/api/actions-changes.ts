/**
 * Changes: the pull requests trace's jobs opened, reviewed and accepted in the app (docs/guided-flow.md "API runtime
 * actions"). A job's work reaches the record only when its pull request is merged; people did that on GitHub, and the
 * app said "Waiting on GitHub". Now the app shows each one as a change, and accepting it merges it from here.
 *
 *   changes.list    read    { repo } → { repo, changes }: the open pull requests a trace job of this project opened
 *                           (the branch match of src/api/changes.ts), oldest first, each with its checks and verdict
 *                           (the status of the oldest MAX_STATUS only: each costs two GitHub calls)
 *   change.get      read    { repo, number } → ChangeDetail: what trace did, its files, checks, the requirements it
 *                           names, trace's recommendation, and whether this person may accept it now (and if not, why)
 *   change.check    read    { repo, number, id } → CheckDetail (src/api/changes.ts): one check of its head commit in full,
 *                           by the id checks_list gives (cr:<check run id>, job:<Actions job id>): its report, its
 *                           annotations and, for a GitHub Actions job, the end of its log (null when it cannot be read).
 *                           A check of another commit is refused. Its GitHub link only for admins
 *   change.diff     read    { repo, number, path } → one file's patch, and the refs to read it before and after (the
 *                           review page opens schematic and board files there, in the viewer)
 *   change.accept   write   { repo, number, head_sha, note? } → { merged, sha, stage, next, warning? }: `head_sha` is
 *                           the head commit the person looked at (change.get's head.sha); a change whose head has
 *                           moved since is refused, and GitHub merges only that commit. Reads the status again and
 *                           refuses unless it may be accepted now; merges it with the repository's allowed method
 *                           (squash first), takes the hold label off, and records change.accepted (a record that
 *                           cannot be written after the merge is a warning in the answer: the merge stands), with when it became
 *                           ready (ready_since); then the wait from ready to accepted (src/api/process-metrics.ts)
 *   change.rerun    write   { repo, number } → { checks, runs }: runs again the checks that did not run properly (GitHub
 *                           busy or down, the runner lost: change.get's infra_failed), by re-running the failed jobs of
 *                           their workflow runs on the change's head commit. Accepting tries the merge again for about
 *                           20 s while GitHub is still taking the checks in (mergeWhenReady)
 *                           Checks no runner picked up (change.get's stuck) are cancelled and run again instead
 *   changes.rerun_stuck write { repo } → { changes, cancelled, rerun, later, summary }: every open change's checks no
 *                           runner picked up (src/api/stuck-checks.ts, test-esp32 log #146), cancelled and run again
 *                           once an admin fixed the runner; trace also does it on its own every 30 minutes
 *   change.ask      write   { repo, number, note } → { job_id }: comments the note on it as a quote, starts a revision
 *                           job with the same specialist on the same branch (so the same pull request updates), and
 *                           records change.asked (and a rework, sent_back: src/api/process-metrics.ts)
 *   change.discard  write   { repo, number, reason } → { closed, jobs }: closes it, stops the jobs working on its
 *                           branch (queued or running: cancelled; paused: never resumed), then comments the reason
 *                           with what was stopped and trace's discard mark (a comment that fails leaves it closed),
 *                           records change.discarded with its branch, head, reason and the jobs. The comment retires
 *                           the branch: no job reopens it as a change (src/core/discarded.ts, test-esp32 log #75).
 *                           `jobs`: what happened to each job, in words, as the change's page says it (discarded)
 *
 * Access is checked first (perform), as for every action: read = assigned to the project; write = the Contributor
 * part (admins are contributors everywhere). A reviewer reads changes but cannot accept, ask or discard, and a
 * connected system only reads (src/api/service-policy.ts). A pull request that is not one of trace's (a person's own,
 * a fork's, one of another project: src/api/changes.ts traceJob) is answered "no such change": these actions never
 * act on a person's pull request.
 *
 * GitHub's allowance: every project shares one token, so the answers are kept a short while per head commit
 * (src/api/github-cache.ts), and each principal may make at most PER_MINUTE of these actions a minute. Accepting
 * reads the status fresh, never a kept copy.
 *
 * GitHub's review rule: trace never approves on GitHub (its account opened the pull request, and GitHub refuses an
 * approval from the author). The guided flow expects the repository to require passing checks only; trace records who
 * accepted in the decisions log. A repository that still requires a review makes accepting fail with plain words that
 * say so; an admin fixes the rule from the change's page (repo.rules.fix, src/api/actions-rules.ts).
 *
 * Who did it goes into the decisions log as their label (email), like every other decision. The comment on GitHub,
 * which anyone who can read the repository sees, names them by their name in the user pool, else "a person on the
 * project" and their initials: never their email. What a person wrote is posted as a quote, with comment markers
 * (`<!--`, `-->`, which trace's own workflows read as instructions) and @mentions neutralised: it is posted as trace's
 * account, so it must not be able to speak for trace or ping people in its name.
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { isAdmin, standing } from '../core/access.js'
import { readSettings, resolve } from '../core/config.js'
import { type JobRow, indexedHandle, isLive, loadJobs, putControl } from '../core/job-index.js'
import { discardComment } from '../core/discarded.js'
import { STAGE_NAMES, decide, loadJourney, mergeAgentFacts } from '../core/journey.js'
import { SPECIALIST_KINDS, SPECIALIST_WORDS } from '../agents/kinds.js'
import { fence } from '../agents/specialist.js'
import { Composer, NO_LAYERS } from '../prompts/resolve.js'
import { ActionError, type Context, PROJECT_DB_PATH, Repo, TaskBranch, agentFacts, def, label, tempDb, withJourneyDb, withRecordDb, writeJourney } from './action-kit.js'
import { AGENT_WORDS, jobIndex } from './actions-jobs.js'
import {
  CHECK_ANNOTATIONS, type CheckDetail, annotationLevel, checkLines, checkText, type ChangeDetail, type ChangeFacts, type DiscardView, type ChangeSummary, type StackLink, type TraceRule, stacksOf, acceptance, approvalsGiven, changeSummary, checkState, criteriaNamed, editAcceptance, editFacts, editOf,
  editRecommendation, editSummary, editVerdict, editsByBranch, fileKind, type InfraFailure, infraReason, jobRequest, jobsByBranch, readySince, recommendationOf, requirementsNamed, settleUnfinished, summaryBullets, traceChanges,
  jobWorking, traceJob, unfinishedWords, verdictOf, creditedAgent,
} from './changes.js'
import { type AppEdit, EDIT_WORDS, editStray } from '../core/app-edits.js'
import { editStore } from './edits.js'
import { applyEditsSoon } from './apply-edits.js'
import { resolveConflicts, resolveWords } from './conflicts.js'
import { GitHubError, checksOf, type GitHubApi, type MergeMethod, type PullDetail, type PullStatus, type PullSummary } from './github.js'
import { SETTINGS_TTL_MS, cached } from './github-cache.js'
import { recordRework, recordWait } from './process-metrics.js'
import { jobLogEnd, repoJob } from './actions-health.js'
import type { CheckRunDetail } from './github.js'
import { backToDefine, changedRequirements, pastDefine } from './pending-changes.js'
import { hasTable } from './record-read.js'
import { type RequirementEditsView, editsView, requirementAsked, requirementEdits, withRequirementEdits } from './requirement-edits.js'
import { type PendingAnswer, loadFollowups, pendingAnswers } from '../core/answer-followups.js'
import { type RecordChanges, betterTitle, changeContent, contentBullets, contentPhrase, plumbingTitle, recordChanges, recordRequirementIds } from '../core/change-contents.js'
import { type RestartResult, type StuckLook, restartStuck, stuckFor, stuckLook } from './stuck-checks.js'

/** At most this many open changes get their status read (two GitHub calls each) in one list or journey. */
export const MAX_STATUS = 5

/**
 * How long one change's status and checks are kept for its review page: short, because GitHub tells nothing when it
 * finishes working out whether a change can merge (after another change merged), so the page looks again soon and must
 * not be answered from a copy made before.
 */
export const DETAIL_STATUS_TTL_MS = 4_000

/**
 * The gate criteria a person has approved in this project (src/api/changes.ts approvalsGiven), with the agents' facts
 * merged in. A project without a journey, or a journey trace cannot read now: none (a change that waited on an
 * approval keeps waiting, the safe side).
 */
export async function projectApprovals(ctx: Context, repo: string): Promise<Set<string>> {
  return (await projectReview(ctx, repo, [])).given
}

/**
 * What the journey record says about the project's open changes, in one read: the approvals given (projectApprovals)
 * and, by branch, the answers trace has not applied yet (src/core/answer-followups.ts pendingAnswers, against `rows`,
 * the job index). A record trace cannot read now: no approvals and no answers (as before this was kept).
 */
export async function projectReview(ctx: Context, repo: string, rows: readonly JobRow[]): Promise<{ given: Set<string>; answers: Map<string, PendingAnswer[]> }> {
  try {
    const [{ r, followups }, facts] = await Promise.all([withJourneyDb(ctx, repo, (db) => ({ r: loadJourney(db), followups: loadFollowups(db) })), agentFacts(ctx, repo).catch(() => null)])
    const answers = pendingAnswers(followups, rows, Date.now() / 1000)
    if (!r) return { given: new Set(), answers }
    return { given: approvalsGiven(facts ? mergeAgentFacts(r, facts) : r), answers }
  } catch {
    return { given: new Set(), answers: new Map() }
  }
}

const Number_ = z.number().int().min(1).max(10_000_000)
const ChangeArgs = Repo.extend({ number: Number_ })
/** A full commit sha, as change.get gives head.sha. */
const Sha = z.string().regex(/^[0-9a-f]{40}$/, 'the head commit (40 hex characters) the change was looked at')
/** A path inside the repository, as GitHub lists it: no absolute paths and no climbing out. */
const RepoPath = z.string().min(1).max(500).refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'a path inside the repository')

/** The repository's GitHub calls the changes need, or a plain refusal when this installation's client has none. */
function changesApi(gh: GitHubApi): Required<Pick<GitHubApi, 'pullStatus' | 'pullDetail' | 'pullFiles' | 'pullCommits' | 'checkRuns' | 'mergeMethods' | 'mergePull' | 'comment' | 'closePull' | 'removeLabel'>> & GitHubApi {
  const need = ['pullStatus', 'pullDetail', 'pullFiles', 'pullCommits', 'checkRuns', 'mergeMethods', 'mergePull', 'comment', 'closePull', 'removeLabel'] as const
  if (need.some((k) => typeof gh[k] !== 'function')) throw new ActionError('This installation cannot review changes in the app yet: its update brings it.')
  return gh as ReturnType<typeof changesApi>
}

/** What a project's settings and GitHub say about telling trace's pull requests apart, and its hold label. */
export interface ProjectRule extends TraceRule { hold: string }

/**
 * The project's rule (src/api/changes.ts TraceRule) and hold label, kept SETTINGS_TTL_MS: its default branch (GitHub),
 * its own branch prefix and hold label (its settings on that branch; the defaults when they cannot be read), and the
 * login trace's agents act as (the runtime's, else the repository's TRACE_AGENT_LOGIN variable the installer sets; not
 * known: not checked). A default branch GitHub will not give is a failure: no change can be told apart without it.
 */
export async function projectRule(ctx: Context, repo: string): Promise<ProjectRule> {
  return cached(ctx.deps.githubCache, repo, 'rule', async () => {
    const gh = await ctx.deps.github()
    const { branch } = await gh.defaultBranch(repo)
    let prefix = 'claude/'
    let hold = 'no-automerge'
    try {
      const t = tempDb(ctx.deps.scratch, await gh.rawFile(repo, PROJECT_DB_PATH, branch))
      try {
        const cfg = resolve(readSettings(t.db)).config
        // an empty prefix means "the agents' default" to the agents (src/agents/worker/prompt.ts), so here too
        prefix = cfg.worker.own_branch_prefix || 'claude/'
        hold = cfg.labels.hold
      } finally {
        t.cleanup()
      }
    } catch {
      // the defaults: what a project without settings has
    }
    const agentLogin = ctx.deps.agentLogin || (await gh.repoVariable?.(repo, 'TRACE_AGENT_LOGIN').catch(() => null)) || null
    return { repo, defaultBranch: branch, prefix, agentLogin, hold }
  }, SETTINGS_TTL_MS)
}

/** The hold label (labels.hold, default no-automerge) from the project's settings; the default when they cannot be read. */
export async function holdLabel(ctx: Context, repo: string): Promise<string> {
  return (await projectRule(ctx, repo).catch(() => null))?.hold ?? 'no-automerge'
}

/** The project's job index rows (the branches trace's jobs worked on). */
export const jobRows = async (ctx: Context, repo: string): Promise<JobRow[]> => (await jobIndex(ctx, repo).read((db) => loadJobs(db))).result

/** The repository's open pull requests, kept a short while (src/api/github-cache.ts). */
export const openPulls = async (ctx: Context, repo: string): Promise<PullSummary[]> => {
  const gh = await ctx.deps.github()
  const open = await cached(ctx.deps.githubCache, repo, 'pulls', () => gh.openPulls(repo))
  // one merged or closed here a moment ago is not open, whatever GitHub's list says yet (src/api/github-cache.ts closed)
  const cache = ctx.deps.githubCache
  return cache ? open.filter((p) => !cache.isClosed(repo, p.number)) : open
}

/** One pull request's status, kept a short while per head commit (`sha`: the head the list gave; unknown, per number). */
const pullStatus = (ctx: Context, gh: GitHubApi, repo: string, number: number, sha?: string): Promise<PullStatus | null> =>
  (gh.pullStatus ? cached(ctx.deps.githubCache, repo, `status:${number}:${sha ?? ''}`, () => gh.pullStatus!(repo, number)) : Promise.resolve(null))

/** Count one GitHub-touching change action against this principal's budget (src/api/github-cache.ts). */
const spend = (ctx: Context): void => { ctx.deps.githubBudget?.take(ctx.principal.sub) }

/** Forget what is kept for the repository: after accepting, asking or discarding, its next look is fresh. */
const bust = (ctx: Context, repo: string): void => { ctx.deps.githubCache?.bust(repo) }

/** The project's recorded app edits (docs/stay-in-trace.md); none when the store cannot be read (nothing is lost:
 * an edit not listed is neither applied nor accepted). */
export const projectEdits = async (ctx: Context, repo: string): Promise<AppEdit[]> =>
  cached(ctx.deps.githubCache, repo, 'edits', () => editStore(ctx).list(repo)).catch(() => [])

/**
 * The open pull requests that are trace's changes, each with its job, oldest first; the open pull requests that are
 * people's app edits, each with its record; and the project's rule.
 */
export async function tracePulls(ctx: Context, repo: string): Promise<{ changes: { pull: PullSummary; job: JobRow }[]; edits: { pull: PullSummary; edit: AppEdit }[]; rule: ProjectRule; pulls: PullSummary[]; rows: JobRow[] }> {
  const [pulls, rows] = await Promise.all([openPulls(ctx, repo), jobRows(ctx, repo)])
  // no open pull request: nothing to tell apart, so the settings are not read for it
  if (!pulls.length) return { changes: [], edits: [], rule: { repo, defaultBranch: '', prefix: 'claude/', agentLogin: null, hold: 'no-automerge' }, pulls, rows }
  const [rule, recorded] = await Promise.all([projectRule(ctx, repo), projectEdits(ctx, repo)])
  const byBranch = editsByBranch(recorded)
  const edits = pulls.flatMap((pull) => { const edit = editOf(pull, byBranch, repo); return edit ? [{ pull, edit }] : [] })
  return { changes: traceChanges(pulls, rows, rule), edits, rule, pulls, rows }
}

/** Whether this person may change the project: an admin, or the Contributor part on it. */
async function writes(ctx: Context, repo: string): Promise<boolean> {
  return isAdmin(ctx.principal) || (await standing(ctx.principal, repo))?.part === 'contributor'
}

/**
 * The change `number`: with the job that made it (a specialist's change), or with the record of the person's app edit
 * it is; else "no such change" (a person's own pull request, a fork's, one another login opened, or an edit branch
 * someone pushed to: src/api/changes.ts traceJob and editOf).
 */
async function traceChange(ctx: Context, gh: ReturnType<typeof changesApi>, repo: string, number: number): Promise<{ pull: PullDetail; job: JobRow | null; edit: AppEdit | null; rule: ProjectRule; rows: JobRow[] }> {
  const [pull, rows, rule] = await Promise.all([gh.pullDetail(repo, number), jobRows(ctx, repo), projectRule(ctx, repo)])
  const job = pull ? traceJob({ head: pull.head.ref, headRepo: pull.head.repo, author: pull.author }, jobsByBranch(rows, rule), rule) : null
  // an edit is read from its store each time (never a kept copy): accepting decides on it
  const recorded = pull && !job ? await editStore(ctx).get(repo, pull.head.ref).catch(() => null) : null
  const edit = pull && recorded ? editOf({ head: pull.head.ref, headRepo: pull.head.repo, sha: pull.head.sha }, new Map([[recorded.branch, recorded]]), repo) : null
  if (!pull || (!job && !edit)) throw new ActionError(`${repo} has no change #${number} from trace.`)
  return { pull, job, edit, rule, rows }
}

const factsOf = (p: Pick<PullDetail, 'state' | 'draft' | 'mergeable'>, checks: PullStatus['checks'], denied = false): ChangeFacts => ({ state: p.state, draft: p.draft, mergeable: p.mergeable, checks, ...(denied ? { checks_denied: true } : {}) })

/**
 * The open changes, oldest first, each with the gate criteria its job named (where its step goes in the journey) and
 * the status of the oldest `max` (the rest have none: their verdict is "checking", and they are never called ready).
 */
/**
 * Whether a change of trace's carries no design content (changeContent), for the gates (pendingBlockers): looked at only
 * for a change that may be one (titled as a specialist's record or a merge, or the Documentation specialist's), from its files at
 * its head commit, kept as long as its list title (a head commit's files never change). Null: design, or not known.
 */
async function contentOf(ctx: Context, gh: GitHubApi, repo: string, pull: PullSummary, job: JobRow): Promise<'record' | 'docs' | null> {
  const docs = creditedAgent(job) === 'docs' || job.agent === 'docs'
  if (!gh.pullFiles || !pull.sha || !(docs || plumbingTitle(pull.title))) return null
  try {
    const files = await cached(ctx.deps.githubCache, repo, `content:${pull.number}:${pull.sha}`, () => gh.pullFiles!(repo, pull.number), LIST_TITLE_TTL_MS)
    const c = changeContent(files.map((f) => f.path))
    return c === 'design' ? null : c
  } catch {
    return null
  }
}

export async function openChanges(ctx: Context, repo: string, o: { max?: number } = {}): Promise<{ change: ChangeSummary; criteria: string[]; content?: 'record' | 'docs' | null }[]> {
  const gh = await ctx.deps.github()
  const { changes: mine, edits, rule, pulls, rows } = await tracePulls(ctx, repo)
  const stacks = stacksOf(pulls, repo, rule.defaultBranch)
  const max = o.max ?? MAX_STATUS
  const [status, editStatus, { given, answers }, look, contents] = await Promise.all([
    Promise.all(mine.map(({ pull }, i) => (i < max ? pullStatus(ctx, gh, repo, pull.number, pull.sha).catch(() => null) : Promise.resolve(null)))),
    Promise.all(edits.map(({ pull }, i) => (i < max ? pullStatus(ctx, gh, repo, pull.number, pull.sha).catch(() => null) : Promise.resolve(null)))),
    mine.length ? projectReview(ctx, repo, rows) : Promise.resolve({ given: new Set<string>(), answers: new Map<string, PendingAnswer[]>() }),
    // workflow runs no runner picks up (src/api/stuck-checks.ts): one look for the whole list, kept a minute
    mine.length ? stuckLook(ctx, repo).catch(() => null) : Promise.resolve(null),
    Promise.all(mine.map(({ pull, job }) => contentOf(ctx, gh, repo, pull, job))),
  ])
  // a change titled by a record or a merge commit is named by what it holds, as its review page names it (log #154)
  const titles = await Promise.all(mine.map(({ pull, job }) => listTitle(ctx, gh, repo, pull, job, rows, stacks.get(pull.number)?.stacked?.base ?? null)))
  const works = mine.map(({ pull, job }, i) => ({
    change: { ...changeSummary({ repo, pull, job, status: status[i] ?? null, hold: rule.hold, agentWords: AGENT_WORDS, given, stack: stacks.get(pull.number), answers: answers.get(pull.head), stuck: stuckFor(look, pull.sha) }), title: titles[i] ?? pull.title },
    criteria: criteriaNamed(jobRequest(job), job.title),
    ...(contents[i] ? { content: contents[i] } : {}),
  }))
  const own = edits.map(({ pull, edit }, i) => ({
    change: editSummary({ pull, edit, status: editStatus[i] ?? null, hold: rule.hold, viewerSub: ctx.principal.sub }),
    criteria: [] as string[],
  }))
  return [...works, ...own].sort((a, b) => a.change.opened_at.localeCompare(b.change.opened_at) || a.change.number - b.change.number)
}

/** The open changes as changes.list answers them. */
export const listChanges = async (ctx: Context, repo: string, o: { max?: number } = {}): Promise<ChangeSummary[]> => (await openChanges(ctx, repo, o)).map((x) => x.change)

/**
 * One change in full, for this person. `fresh`: its status and checks are read from GitHub now, never a kept copy
 * (accepting decides on them). Its files and commits are kept per head commit: they cannot change without a push.
 */
async function changeDetail(ctx: Context, repo: string, number: number, o: { fresh?: boolean } = {}): Promise<ChangeDetail> {
  const gh = changesApi(await ctx.deps.github())
  const found = await traceChange(ctx, gh, repo, number)
  if (found.edit) return editDetail(ctx, gh, repo, number, found.pull, found.edit, found.rule, o)
  const { pull, rule } = found
  const job = found.job as JobRow
  const sha = pull.head.sha
  const keep = o.fresh ? undefined : ctx.deps.githubCache
  // everything else is read in parallel; a part GitHub will not give (a token that cannot read checks) is left out
  const [read0, files, commits, runs, write, { given, answers }, discarded, look] = await Promise.all([
    cached(keep, repo, `status:${number}:${sha}`, () => gh.pullStatus(repo, number), DETAIL_STATUS_TTL_MS),
    cached(ctx.deps.githubCache, repo, `files:${number}:${sha}`, () => gh.pullFiles(repo, number)).catch(() => []),
    cached(ctx.deps.githubCache, repo, `commits:${number}:${sha}`, () => gh.pullCommits(repo, number)).catch(() => []),
    cached(keep, repo, `runs:${sha}`, () => gh.checkRuns(repo, sha, { jobs: true }), DETAIL_STATUS_TTL_MS).catch(() => null), writes(ctx, repo),
    projectReview(ctx, repo, found.rows),
    pull.state === 'closed' ? discardOf(ctx, repo, number) : Promise.resolve(null),
    pull.state === 'open' ? stuckLook(ctx, repo).catch(() => null) : Promise.resolve(null),
  ])
  // one count of its checks everywhere (test-esp32 #201): the checks listed on its page, each workflow read as its jobs,
  // are what the heading, the Overview's card (both from this answer) and the recommendation count, not GitHub's
  // status, which counts a workflow as one check
  const status = read0 && runs?.length ? { ...read0, checks: checksOf(runs) } : read0
  const hold = rule.hold
  // where it sits in a stack: its base read now (accepting decides on it), the changes above it from the kept list
  const stack = await stackFor(ctx, repo, pull, rule)
  const pending = answers.get(pull.head.ref)
  const stuck = pull.state === 'open' ? stuckFor(look, sha) : null
  const sum = changeSummary({ repo, pull: { ...pull, labels: pull.labels }, job, status, hold, agentWords: AGENT_WORDS, given, stack, answers: pending, stuck })
  const facts = factsOf(pull, status?.checks ?? null, status?.checks_denied ?? false)
  if (stack.stacked) facts.stacked = stack.stacked
  // its checks cannot start: no runner picks them up (test-esp32 log #146)
  if (stuck) facts.stuck = stuck
  // its job is still at it: not recommended, nor accepted, until it ends (log #68)
  if (jobWorking(job)) facts.working = true
  // an answer to its specialist's question not applied yet: never recommended for accepting (test-esp32 log #131)
  if (pending?.length) facts.answers = [...pending]
  const infra = await infraFailures(ctx, gh, repo, runs)
  if (infra) facts.infra = infra
  // the specialist's own word that it is not finished, from its title, summary or the description (src/api/changes.ts)
  const unfinished = unfinishedWords({ title: pull.title, summary: job.summary, body: pull.body, request: jobRequest(job) })
  if (unfinished) facts.unfinished = unfinished
  // it waited on a person's approval: once given, it is finished (src/api/changes.ts settleUnfinished)
  settleUnfinished(facts, { title: pull.title, summary: job.summary, body: pull.body }, given)
  const checksList = checkLines(runs)
  // checked against the project's own requirements: a resistor R3 is not a requirement (test-esp32 log #47, #105)
  const named = await projectRequirementIds(ctx, gh, repo, rule.defaultBranch, files.some((f) => f.path === PROJECT_DB_PATH) ? sha : null)
    .then((known) => requirementsNamed(known, pull.title, pull.body, ...commits))
    .catch((e: unknown) => {
      logLine(ctx, { warning: 'change.get: the project\'s requirements could not be read', repo, number, error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) })
      return { ids: [] as string[], unknown: [] as string[] }
    })
  const passed = checksList.filter((c) => c.state === 'passed').map((c) => c.name)
  // an accepted requirement its database edits: said before it is accepted (src/api/requirement-edits.ts)
  // and the intent statements and requirements it adds or changes, said in its summary (log #133)
  const read = pull.state === 'open' && files.some((f) => f.path === PROJECT_DB_PATH)
    ? await cached(keep, repo, `record-edits:${number}:${sha}`, () => recordEditsOf(ctx, gh, repo, pull, found.rows, stack.stacked?.base ?? null)).catch((e: unknown) => {
      logLine(ctx, { warning: 'change.get: the requirements it edits could not be read', repo, number, error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) })
      return null
    })
    : null
  const edits = read?.edits ?? null
  // the requirements its record adds or changes are ones it names too: 22 added were "none named" (log #27)
  const requirements = [...new Set([...named.ids, ...recordRequirementIds(read?.record ?? null)])]
  const content = { paths: files.map((f) => f.path), record: read?.record ?? null }
  return {
    ...sum,
    // named by the work in it, not by the record it started as or a merge commit; a record by what it holds (log
    // #144, #154, #14)
    title: betterTitle(sum.title, commits, { holds: contentPhrase(content), kind: job.agent }),
    verdict: verdictOf(facts),
    ...(facts.awaiting ? { awaiting: facts.awaiting } : {}),
    // what it holds first: its files, and what its record adds, table by table (log #144, #133, #59, #37); then what
    // every job on its branch reported (log #18)
    summary: [...contentBullets(content), ...summaryBullets({ jobSummary: job.summary, earlier: earlierSummaries(found.rows, job, pull.head.ref), body: pull.body, commits })].slice(0, 12),
    files: files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, kind: fileKind(f.path, f.patch) })),
    checks_list: checksList, requirements,
    ...(named.unknown.length ? { requirements_unknown: named.unknown } : {}),
    recommendation: withRequirementEdits(recommendationOf(facts, { passed, requirements, from: sum.from }), edits),
    ...(edits ? { requirement_edits: edits } : {}),
    ...acceptance(facts, write),
    base: pull.base, head: { ref: pull.head.ref, sha: pull.head.sha },
    ready_since: readySince(runs, pull.created_at),
    rule_blocks: ruleBlocks(facts), may_discard: write, may_ask: write,
    ...(infra ? { infra_failed: infra } : {}),
    ...(discarded ? { discarded } : {}),
  }
}

/** At most this many failed checks are looked into for a cause outside the work (each costs a GitHub read or two). */
export const INFRA_LOOKS = 4
/** How much of a failed job's log end is read for one (GitHub's error is the last thing a failed job prints). */
const INFRA_LOG_MAX = 16 * 1024

/**
 * The checks that failed, when every one failed for a reason outside the work (src/api/changes.ts infraReason), from
 * their annotations, else the end of their Actions job's log; null when none failed, or any failed on the work, or
 * could not be looked into. Completed checks do not change, so what is read is kept (the cache's default time).
 */
export async function infraFailures(ctx: Context, gh: GitHubApi, repo: string, runs: readonly CheckRunDetail[] | null): Promise<InfraFailure | null> {
  const failed = (runs ?? []).filter((c) => checkState(c) === 'failed')
  if (!failed.length || failed.length > INFRA_LOOKS || failed.some((c) => !c.id)) return null
  const whys = await Promise.all(failed.map((c) => failureText(ctx, gh, repo, c.id!, c.summary).then(infraReason, () => null)))
  if (whys.some((w) => !w)) return null
  return { checks: failed.map((c) => ({ id: c.id!, name: c.name })), why: whys[0]! }
}

async function failureText(ctx: Context, gh: GitHubApi, repo: string, id: string, summary: string | null): Promise<string> {
  const [kind, raw] = id.split(':') as ['cr' | 'job', string]
  const n = Number(raw)
  const said = [summary ?? '']
  if (kind === 'cr' && typeof gh.checkAnnotations === 'function') {
    const notes = await cached(ctx.deps.githubCache, repo, `annotations:${n}:completed`, () => gh.checkAnnotations!(repo, n, CHECK_ANNOTATIONS)).catch(() => [])
    said.push(...notes.map((a) => `${a.title ?? ''} ${a.message}`))
    if (infraReason(said.join('\n'))) return said.join('\n')
  }
  // an Actions job (a check run GitHub Actions made carries its job's id): the end of its log. Another app's check
  // run has no log there, and reads as nothing
  const log = await jobLogEnd(ctx, repo, n, 'completed', INFRA_LOG_MAX).catch(() => null)
  return [...said, log?.text ?? ''].join('\n')
}

/**
 * The summaries of the other jobs that worked on `branch` before `job` (oldest first): a change two jobs made is said
 * by both (test-esp32 log #18). A delegated worker's job is its specialist's, so it is left out.
 */
export function earlierSummaries(rows: readonly JobRow[], job: JobRow, branch: string): string[] {
  const at = (j: JobRow): number => j.endedAt ?? j.updatedAt
  return rows.filter((j) => j.branch === branch && j.id !== job.id && !j.parentJob && j.summary && at(j) <= at(job))
    .sort((a, b) => at(a) - at(b)).map((j) => j.summary as string)
}

/** How long a change's title in the list is kept: its head commit's contents never change. */
const LIST_TITLE_TTL_MS = 10 * 60_000

/**
 * A change's title for the list: its own, unless it says nothing of the work (a specialist's record or a merge
 * commit, log #154, #14); then as its review page names it (betterTitle), from its commits and, when they name no
 * work, from what its record holds. Read only for such a change, and kept by its head commit; its own title when
 * GitHub will not say.
 */
async function listTitle(ctx: Context, raw: GitHubApi, repo: string, pull: PullSummary, job: JobRow, rows: readonly JobRow[], base: string | null): Promise<string> {
  if (!plumbingTitle(pull.title) || !pull.sha || typeof raw.pullCommits !== 'function') return pull.title
  const gh = raw as GitHubApi & Required<Pick<GitHubApi, 'pullCommits'>>
  const sha = pull.sha
  return cached(ctx.deps.githubCache, repo, `list-title:${pull.number}:${sha}`, async () => {
    const commits = await cached(ctx.deps.githubCache, repo, `commits:${pull.number}:${sha}`, () => gh.pullCommits(repo, pull.number))
    const t = betterTitle(pull.title, commits, { kind: job.agent })
    if (!plumbingTitle(t)) return t
    const read = await cached(ctx.deps.githubCache, repo, `record-edits:${pull.number}:${sha}`, () => recordEditsOf(ctx, gh, repo, { head: { sha, ref: pull.head } }, rows, base)).catch(() => null)
    return betterTitle(pull.title, commits, { kind: job.agent, holds: contentPhrase({ paths: [], record: read?.record ?? null }) })
  }, LIST_TITLE_TTL_MS).catch(() => pull.title)
}

/**
 * What `pull`'s database edits. `edits`: the accepted requirements it changes, against the design as it stands (the
 * default branch's database, with people's decisions from the journey record), and what on its branch asked for that
 * (null when it edits none). `record`: the intent statements and requirements it adds or changes, against the change
 * it is stacked on when it is (its own review shows its own edits only), else the design. Null when it carries no
 * database.
 */
async function recordEditsOf(ctx: Context, gh: GitHubApi, repo: string, pull: { head: { sha: string; ref: string } }, jobs: readonly JobRow[], base: string | null): Promise<{ edits: RequirementEditsView | null; record: RecordChanges } | null> {
  const t = tempDb(ctx.deps.scratch, await gh.rawFile(repo, PROJECT_DB_PATH, pull.head.sha))
  // a stacked change is compared with the change it builds on; that copy unreadable, with the design
  const under = base ? tempDb(ctx.deps.scratch, await gh.rawFile(repo, PROJECT_DB_PATH, base).catch(() => null)) : null
  try {
    if (!existsSync(t.db)) return null
    const head = new DatabaseSync(t.db, { readOnly: true })
    const below = under && existsSync(under.db) ? new DatabaseSync(under.db, { readOnly: true }) : null
    try {
      return await withRecordDb(ctx, repo, (design) => {
        const record = recordChanges(below ?? design, head)
        const edits = requirementEdits(design, head)
        if (!edits.length) return { edits: null, record }
        const r = loadJourney(design)
        return { edits: editsView(edits, r ? pastDefine(r) : false, requirementAsked(jobs, [pull.head.ref, ...(base ? [base] : [])], r)), record }
      })
    } finally {
      head.close()
      below?.close()
    }
  } finally {
    t.cleanup()
    under?.cleanup()
  }
}

/** Every requirement id in a project database (struck ones too: a change may still name one), or none. */
export function requirementIdsIn(db: DatabaseSync): string[] {
  if (!hasTable(db, 'requirements')) return []
  return (db.prepare('SELECT id FROM requirements ORDER BY id').all() as { id: unknown }[]).map((r) => String(r.id))
}

/** The requirement ids in the database at `ref`: none when it has no database. */
async function requirementIdsAt(ctx: Context, gh: GitHubApi, repo: string, ref: string): Promise<string[]> {
  const t = tempDb(ctx.deps.scratch, await gh.rawFile(repo, PROJECT_DB_PATH, ref))
  try {
    if (!existsSync(t.db)) return []
    const db = new DatabaseSync(t.db, { readOnly: true })
    try { return requirementIdsIn(db) } finally { db.close() }
  } finally {
    t.cleanup()
  }
}

/**
 * The project's requirement ids a change may name: the design's (its default branch's database, kept
 * SETTINGS_TTL_MS), and, when the change carries its own database (`head`: its head commit), the ones it adds.
 */
export async function projectRequirementIds(ctx: Context, gh: GitHubApi, repo: string, defaultBranch: string, head: string | null): Promise<string[]> {
  const [design, theirs] = await Promise.all([
    cached(ctx.deps.githubCache, repo, 'requirement-ids', () => requirementIdsAt(ctx, gh, repo, defaultBranch), SETTINGS_TTL_MS),
    head ? cached(ctx.deps.githubCache, repo, `requirement-ids:${head}`, () => requirementIdsAt(ctx, gh, repo, head)) : Promise.resolve([] as string[]),
  ])
  return [...new Set([...design, ...theirs])]
}

/**
 * Change `pull`'s place in a stack (docs/stacked-changes.md): stacked when its base, as read now, is not the default
 * branch, on the open change whose branch that is; and the open changes built on it, from the kept list.
 */
async function stackFor(ctx: Context, repo: string, pull: Pick<PullDetail, 'number' | 'base'>, rule: ProjectRule): Promise<{ stacked?: { base: string; on: StackLink | null }; built_on_by: StackLink[] }> {
  const pulls = await openPulls(ctx, repo).catch(() => [] as PullSummary[])
  const built_on_by = stacksOf(pulls, repo, rule.defaultBranch).get(pull.number)?.built_on_by ?? []
  if (!rule.defaultBranch || pull.base.ref === rule.defaultBranch) return { built_on_by }
  const below = pulls.find((p) => p.head === pull.base.ref && p.headRepo?.toLowerCase() === repo.toLowerCase())
  return { stacked: { base: pull.base.ref, on: below ? { number: below.number, title: below.title } : null }, built_on_by }
}

/** How much of an Actions job's log end change.check answers. */
export const CHECK_LOG_MAX = 64 * 1024
/** A check's id as checks_list gives it. */
const CheckId = z.string().max(40).regex(/^(cr|job):[1-9]\d{0,18}$/, 'a check id from checks_list (cr:<id> or job:<id>)')

/**
 * One check of change `number`'s head commit in full (CheckDetail). The change must be one of trace's (traceChange),
 * and the check must have run on its head commit: a check of any other commit is refused. The log is the end of the
 * GitHub Actions job's log (a check run GitHub Actions made has its job's id), null when there is none or it cannot
 * be read; reading it never fails the answer.
 */
async function checkDetail(ctx: Context, repo: string, number: number, id: string): Promise<CheckDetail> {
  const gh = changesApi(await ctx.deps.github())
  const { pull } = await traceChange(ctx, gh, repo, number)
  const sha = pull.head.sha
  const [kind, raw] = id.split(':') as ['cr' | 'job', string]
  const n = Number(raw)
  const none = (): ActionError => new ActionError(`Change #${number} has no check ${id} on its latest commit.`)
  const admin = isAdmin(ctx.principal)
  const logOf = async (job: number, status: string): Promise<CheckDetail['log']> => {
    try { return await jobLogEnd(ctx, repo, job, status, CHECK_LOG_MAX) } catch { return null }
  }
  if (kind === 'cr') {
    if (typeof gh.checkRun !== 'function') throw new ActionError('This installation cannot open a check in the app yet: its update brings it.')
    const cr = await cached(ctx.deps.githubCache, repo, `check:${n}`, () => gh.checkRun!(repo, n), DETAIL_STATUS_TTL_MS)
    if (!cr || cr.head_sha !== sha) throw none()
    const [annotations, log] = await Promise.all([
      cr.annotations > 0 && typeof gh.checkAnnotations === 'function'
        ? cached(ctx.deps.githubCache, repo, `annotations:${n}:${cr.status}`, () => gh.checkAnnotations!(repo, n, CHECK_ANNOTATIONS), DETAIL_STATUS_TTL_MS).catch(() => [])
        : Promise.resolve([]),
      cr.app === 'github-actions' ? logOf(cr.id, cr.status) : Promise.resolve(null),
    ])
    return {
      id, name: cr.name, state: checkState(cr), summary: (cr.title || cr.summary || null)?.slice(0, 300) ?? null,
      text: checkText(cr.summary, cr.text), started_at: cr.started_at, completed_at: cr.completed_at,
      annotations: annotations.slice(0, CHECK_ANNOTATIONS).map((a) => ({ path: a.path, line: a.start_line, level: annotationLevel(a.level), title: a.title, message: a.message.slice(0, 4000) })),
      log, ...(admin && cr.url ? { url: cr.url } : {}),
    }
  }
  // a workflow run's job: one of this repository's runs, on this commit
  let job: Awaited<ReturnType<typeof repoJob>>
  try {
    job = await cached(ctx.deps.githubCache, repo, `job:${n}`, () => repoJob(ctx, repo, n), DETAIL_STATUS_TTL_MS)
  } catch (e) {
    if (e instanceof ActionError) throw none()
    throw e
  }
  if (job.head_sha !== sha) throw none()
  return {
    id, name: job.name, state: checkState({ status: job.status, conclusion: job.conclusion ?? null }), summary: null, text: null,
    started_at: job.started_at ?? null, completed_at: job.completed_at ?? null, annotations: [],
    log: await logOf(job.id, job.status), ...(admin && job.html_url ? { url: job.html_url } : {}),
  }
}

/** An edit whose pull request changes files the edit does not write is never accepted: a commit was slipped in. */
const strayAware = (a: { may_accept: boolean; blockers: string[] }, stray: readonly string[]): { may_accept: boolean; blockers: string[] } =>
  (stray.length ? { may_accept: false, blockers: [`It changes files this change does not write (${stray.slice(0, 3).join(', ')}${stray.length > 3 ? ', …' : ''}): someone pushed to its branch. Discard it and make the change again.`, ...a.blockers] } : a)

/**
 * Its checks are done and none failed, yet GitHub says its rules stop it: a required review trace cannot give (the
 * change page offers admins "Fix the rule and accept": repo.rules.fix).
 */
export const ruleBlocks = (f: ChangeFacts): boolean =>
  f.state === 'open' && !f.draft && f.mergeable === 'blocked' && f.checks !== null && f.checks.total > 0 && f.checks.failed === 0 && f.checks.running === 0

/** One app edit in full, for this person (docs/stay-in-trace.md "Where they show"). */
async function editDetail(ctx: Context, gh: ReturnType<typeof changesApi>, repo: string, number: number, pull: PullDetail, edit: AppEdit, rule: ProjectRule, o: { fresh?: boolean }): Promise<ChangeDetail> {
  const sha = pull.head.sha
  const keep = o.fresh ? undefined : ctx.deps.githubCache
  const [status, files, commits, runs] = await Promise.all([
    cached(keep, repo, `status:${number}:${sha}`, () => gh.pullStatus(repo, number), DETAIL_STATUS_TTL_MS),
    cached(ctx.deps.githubCache, repo, `files:${number}:${sha}`, () => gh.pullFiles(repo, number)).catch(() => null),
    cached(ctx.deps.githubCache, repo, `commits:${number}:${sha}`, () => gh.pullCommits(repo, number)).catch(() => []),
    cached(keep, repo, `runs:${sha}`, () => gh.checkRuns(repo, sha, { jobs: true }), DETAIL_STATUS_TTL_MS).catch(() => null),
  ])
  const sum = editSummary({ pull: { ...pull, labels: pull.labels }, edit, status, hold: rule.hold, viewerSub: ctx.principal.sub })
  const facts = factsOf(pull, status?.checks ?? null, status?.checks_denied ?? false)
  const infra = await infraFailures(ctx, gh, repo, runs)
  if (infra) facts.infra = infra
  const mine = edit.by_sub === ctx.principal.sub
  const admin = isAdmin(ctx.principal)
  const checksList = checkLines(runs)
  return {
    ...sum,
    verdict: editVerdict(facts, edit),
    summary: [`${edit.title}.`, `Made in trace by ${mine ? 'you' : edit.by_name} as ${EDIT_WORDS[edit.kind]}.`, ...commits.slice(0, 3).map((m) => m.split('\n')[0] ?? '').filter((m) => m && !m.startsWith(edit.title))],
    files: (files ?? []).map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, kind: fileKind(f.path, f.patch) })),
    checks_list: checksList, requirements: [],
    recommendation: editRecommendation(facts, edit, mine),
    ...strayAware(editAcceptance(facts, edit, { admin, mine }), files ? editStray(files, edit) : ['its files could not be read']),
    base: pull.base, head: { ref: pull.head.ref, sha: pull.head.sha },
    rule_blocks: ruleBlocks(editFacts(facts, edit.kind)), may_discard: mine || admin, may_ask: false,
    ready_since: readySince(runs, pull.created_at),
    ...(infra ? { infra_failed: infra } : {}),
  }
}

/** The merge method to use: the first of squash, merge, rebase the repository allows (squash when it says nothing). */
export function mergeMethod(allowed: readonly MergeMethod[]): MergeMethod {
  return (['squash', 'merge', 'rebase'] as const).find((m) => allowed.includes(m)) ?? 'squash'
}

/**
 * How long change.accept waits, between tries, for GitHub to finish working out a merge it refused for now. Right after
 * the last check passes GitHub says "blocked" for up to a minute while it takes the checks in; an Accept then did
 * nothing a person could see (test-esp32 run 2, #99). About 20 s in all, inside one request.
 */
export const MERGE_WAITS_MS = [3_000, 6_000, 10_000]

/**
 * The merge, tried again while GitHub refuses it for now (405 not about a review: its checks not yet taken in, the
 * base branch just moved). A refusal for a review, a head that moved (409) or anything else is thrown at once.
 */
export async function mergeWhenReady(ctx: Context, merge: () => Promise<{ sha: string }>): Promise<string> {
  const sleep = ctx.deps.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)))
  for (let i = 0; ; i++) {
    try {
      return (await merge()).sha
    } catch (e) {
      const notYet = e instanceof GitHubError && e.status === 405 && !/review/i.test(e.said ?? '')
      const wait = MERGE_WAITS_MS[i]
      if (!notYet || wait === undefined) throw e
      await sleep(wait)
    }
  }
}

/** GitHub's refusal of a merge, in plain words; a required review gets the words the guided flow promises. */
export function mergeRefusal(e: unknown): ActionError | null {
  if (!(e instanceof GitHubError)) return null
  const said = e.said ?? ''
  if (/review/i.test(said)) {
    return new ActionError('GitHub refused: this repository requires an approving review before a change goes in, and trace cannot approve its own. An admin can fix the rule from this change\'s page ("Fix the rule and accept"), and nothing else changes.')
  }
  if (e.status === 409) return new ActionError('The change moved on since you looked at it (trace pushed to it again). Look at it again, then accept.')
  if (e.status === 405) return new ActionError(`GitHub is not ready to merge it yet (it says: ${said || 'its rules do not allow it yet'}). trace tried for ${Math.round(MERGE_WAITS_MS.reduce((a, b) => a + b, 0) / 1000)} seconds; nothing changed. Accept it again in a minute.`)
  if (e.status === 403) return new ActionError('GitHub refused: trace\'s token may not merge in this repository. An admin can give the token write access to its contents and pull requests.')
  return null
}

/**
 * Text a person wrote, made safe to post as trace's account: comment markers (`<!--`, `-->`: trace's workflows read
 * markers in comments by its own account as instructions) become HTML entities, which GitHub shows as the same
 * characters, and every @ before a name gets a zero-width joiner after it, so it mentions nobody.
 */
export function neutralise(text: string): string {
  return text.replace(/<!--/g, '&lt;!--').replace(/--!?>/g, '--&gt;').replace(/@(?=[A-Za-z0-9_-])/g, '@\u200d')
}

/** A person's words as a Markdown quote, neutralised. */
export const quote = (text: string): string => neutralise(text).split(/\r?\n/).map((l) => `> ${l}`).join('\n')

/** Initials from a name or an email's local part: "Ada Lovelace" → "AL", "c.user@x" → "CU" (at most three). */
export function initials(s: string): string {
  const parts = (s.split('@')[0] ?? '').split(/[\s._+-]+/).filter(Boolean)
  return parts.slice(0, 3).map((x) => x.charAt(0).toUpperCase()).join('') || '?'
}

/**
 * Who did it, for a comment anyone who reads the repository sees: their name in the user pool, else "a person on the
 * project" and their initials. Never their email (the part before @ of an email is still an email).
 */
export async function publicName(ctx: Context): Promise<string> {
  const p = ctx.principal
  const u = await ctx.deps.cognito().getUser(p.sub).catch(() => null)
  const name = u?.name?.trim()
  if (name) return neutralise(name.replace(/\s+/g, ' ').slice(0, 80))
  return `a person on the project (${initials(p.email ?? p.sub)})`
}

/** The branch a job works on: its row's once it started, else the one its request names (a queued carry-on). */
function branchOf(r: JobRow): string | null {
  if (r.branch) return r.branch
  try {
    const b = (JSON.parse(r.payload ?? 'null') as { branch?: unknown } | null)?.branch
    return typeof b === 'string' ? b : null
  } catch {
    return null
  }
}

/**
 * Stop the jobs on a discarded change's branch (test-esp32 log #75: a Verification job pushed to it 15 minutes after
 * the discard): a queued or running one is cancelled through the worker, a paused one is marked never to be resumed
 * (as Cancel on a paused job does). A delegated worker goes with its specialist's job; a job trace lost contact with
 * has nothing to stop. What happened to each, in words for the change's page and its comment. A job that cannot be
 * stopped is said so: whatever it pushes, trace opens no change from the branch again (src/harness/prs.ts).
 */
async function stopBranchJobs(ctx: Context, repo: string, branch: string, by: string): Promise<string[]> {
  const at = Date.now() / 1000
  const rows = (await jobRows(ctx, repo).catch(() => [] as JobRow[]))
    .filter((r) => !r.parentJob && branchOf(r) === branch && (r.state === 'queued' || r.state === 'paused' || (r.state === 'running' && isLive(r, at))))
  if (!rows.length) return []
  const api = await ctx.deps.jobs()
  const words: string[] = []
  for (const r of rows) {
    const who = `The ${(SPECIALIST_WORDS as Readonly<Record<string, string>>)[r.agent ?? ''] ?? AGENT_WORDS[r.agent ?? ''] ?? 'trace'} job`
    if (r.state === 'paused') {
      const ok = await writeJourney(ctx, repo, (db) => { putControl(db, { job: r.id, by, at, discarded: true }); return { result: true } }).then(() => true, () => false)
      words.push(ok ? `${who} paused on it will not be resumed.` : `${who} paused on it could not be marked: do not resume it.`)
      continue
    }
    const what = r.state === 'queued' ? 'queued for it' : 'that was working on it'
    const res = api.cancel ? await api.cancel(indexedHandle(repo, r.session, r.id), `the change it works on was discarded by ${by}`).catch(() => null) : null
    words.push(res?.ok ? `${who} ${what} was stopped.` : `${who} ${what} could not be stopped; trace will not open this branch as a change again, whatever it pushes.`)
  }
  return words
}

/** A discarded change's discard, from the decisions log (change.discard records it); null when none is kept. */
async function discardOf(ctx: Context, repo: string, number: number): Promise<DiscardView | null> {
  const r = await withJourneyDb(ctx, repo, (db) => loadJourney(db)).catch(() => null)
  const d = r?.decisions.find((x) => x.kind === 'change.discarded' && x.ref === String(number))
  if (!d) return null
  const detail = (d.detail ?? {}) as { reason?: unknown; jobs?: unknown }
  return {
    by: d.by ?? 'a person', at: new Date(d.at * 1000).toISOString(),
    reason: typeof detail.reason === 'string' ? detail.reason : d.summary.replace(/^.*?discarded "[^"]*": /, ''),
    jobs: Array.isArray(detail.jobs) ? detail.jobs.filter((j): j is string => typeof j === 'string') : [],
  }
}

/** Record a decision about a change in the journey's log (a project without a journey yet keeps no log: skipped). */
async function record(ctx: Context, repo: string, d: { kind: string; ref: string; summary: string; detail: unknown }): Promise<void> {
  await writeJourney(ctx, repo, (db) => {
    const r = loadJourney(db)
    if (!r) return { result: null, changed: false }
    decide(db, { kind: d.kind, stage: r.journey.currentStage, ref: d.ref, by: label(ctx.principal), summary: d.summary, detail: d.detail })
    return { result: null }
  })
}

/**
 * The request a revision job gets: what the person asked (their note: the one part that is their request), and to
 * carry on on the same branch so the change updates. The change's title and what the job reported last time are not
 * the person's words (a title is whatever the branch's first commit said), so they come after it, fenced as data, not
 * instructions (the specialist's prompt quotes the whole request as the person's).
 */
export function revisionRequest(o: { number: number; title: string; branch: string; note: string; by: string; summary: string | null }): string {
  // the words are the prompt catalog's (src/prompts/catalog.ts specialist.job.revision), locked
  const p = new Composer(NO_LAYERS)
  return p.text('specialist.job.revision', {
    by: o.by, number: o.number, branch: o.branch, note: o.note, reported: o.summary ? ' and what you reported last time' : '',
    title: fence(p, 'change-title', o.title, 300),
    summary: o.summary ? p.text('specialist.job.revision.summary', { summary: fence(p, 'earlier-summary', o.summary, 4000) }) : '',
  })
}

/** A line for the runtime's log. */
export const logLine = (ctx: Context, l: Record<string, unknown>): void => {
  (ctx.deps.log ?? ((x) => { process.stdout.write(`${JSON.stringify(x)}\n`) }))({ at: new Date().toISOString(), ...l })
}

/**
 * Cancel and run again the stuck checks on the head commits `only` (null: every stuck run of the repository), from a
 * fresh look; GitHub's refusals in plain words. The kept answers are forgotten after, so the next look is fresh.
 */
export async function rerunStuck(ctx: Context, repo: string, only: ReadonlySet<string> | null, look?: StuckLook | null): Promise<RestartResult> {
  const gh = await ctx.deps.github()
  if (typeof gh.request !== 'function') throw new ActionError('This installation cannot run checks again from the app yet: its update brings it.')
  if (look === undefined) bust(ctx, repo)
  const seen = look === undefined ? await stuckLook(ctx, repo) : look
  if (!seen) throw new ActionError('trace could not list this repository\'s queued checks: its GitHub token needs "Actions: read".')
  try {
    return await restartStuck({ request: gh.request.bind(gh) }, repo, seen.runs, { only, sleep: ctx.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))) })
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 403 || e.status === 404)) throw new ActionError('GitHub refused: trace\'s token may not cancel or run checks again in this repository. An admin can give the token write access to Actions.')
    throw e
  } finally {
    bust(ctx, repo)
  }
}

/** What running the stuck checks again did, in plain words. */
export function restartWords(r: RestartResult): string {
  if (!r.rerun && !r.later && !r.cancelled) return 'Nothing was stuck any more: no check needed running again.'
  const again = r.rerun ? `${r.rerun === 1 ? '1 workflow runs' : `${r.rerun} workflows run`} again` : ''
  const later = r.later ? `${r.later === 1 ? '1 is' : `${r.later} are`} still stopping and ${r.later === 1 ? 'runs' : 'run'} again on trace's next look` : ''
  const lead = [again, later].filter(Boolean).join('; ') || `${r.cancelled === 1 ? '1 stuck workflow was' : `${r.cancelled} stuck workflows were`} cancelled`
  return `${lead[0]?.toUpperCase() ?? ''}${lead.slice(1)}. If the runner is still broken they wait again, and the change says why.`
}

export const CHANGE_ACTIONS = {
  'changes.list': def('read', Repo, async ({ repo }, ctx) => {
    spend(ctx)
    // the fallback for an installation whose hooks are not set up: apply people's edits that are ready (at most every
    // 30 s per repository; it never waits on it, src/api/apply-edits.ts)
    applyEditsSoon(ctx, repo)
    return { repo, changes: await listChanges(ctx, repo) }
  }),

  'change.get': def('read', ChangeArgs, async ({ repo, number }, ctx) => { spend(ctx); return changeDetail(ctx, repo, number) }),

  'change.check': def('read', ChangeArgs.extend({ id: CheckId }), async ({ repo, number, id }, ctx) => { spend(ctx); return checkDetail(ctx, repo, number, id) }),

  /**
   * Run again the checks that did not run properly (ChangeDetail.infra_failed: GitHub busy or down, the runner lost),
   * instead of re-running a workflow on GitHub by hand (test-esp32 run 2, #128). Each check's workflow run is read
   * first: it must be on the change's head commit (a re-run of a run on an older commit changes nothing here), and its
   * failed jobs are run again (one call per run). A check that failed on the work is never run again from here.
   */
  'change.rerun': def('write', ChangeArgs, async ({ repo, number }, ctx) => {
    spend(ctx)
    const d = await changeDetail(ctx, repo, number, { fresh: true })
    if (d.state !== 'open') throw new ActionError(d.state === 'merged' ? 'It is already accepted into the design.' : 'It was discarded.')
    const infra = d.infra_failed
    // checks no runner picked up: cancelled and run again (src/api/stuck-checks.ts restartStuck)
    if (!infra?.checks.length && d.stuck) {
      const r = await rerunStuck(ctx, repo, new Set([d.head.sha]))
      logLine(ctx, { event: 'change.rerun', repo, number, by: label(ctx.principal), stuck: r })
      return { checks: [] as string[], runs: r.rerun, ...r, summary: restartWords(r) }
    }
    if (!infra?.checks.length) throw new ActionError('None of its checks failed for a reason outside the work, so there is nothing to run again here.')
    const gh = await ctx.deps.github()
    if (typeof gh.request !== 'function') throw new ActionError('This installation cannot run checks again from the app yet: its update brings it.')
    const runs = new Set<string>()
    for (const c of infra.checks) {
      const job = await repoJob(ctx, repo, Number(c.id.split(':')[1]))
      if (job.head_sha !== d.head.sha) throw new ActionError(`The ${c.name} check ran on an older commit of this change. Look at it again.`)
      const run = /\/actions\/runs\/(\d+)$/.exec(job.run_url ?? '')?.[1]
      if (run) runs.add(run)
    }
    const [o, n] = repo.split('/')
    try {
      for (const run of runs) await gh.request('POST', `/repos/${encodeURIComponent(o ?? '')}/${encodeURIComponent(n ?? '')}/actions/runs/${run}/rerun-failed-jobs`)
    } catch (e) {
      if (e instanceof GitHubError && e.status === 403 && /already running|in progress/i.test(e.said ?? '')) throw new ActionError('It is already running again. Look again in a minute.')
      if (e instanceof GitHubError && (e.status === 403 || e.status === 404)) throw new ActionError('GitHub refused: trace\'s token may not run checks again in this repository. An admin can give the token write access to Actions.')
      throw e
    } finally {
      bust(ctx, repo)
    }
    logLine(ctx, { event: 'change.rerun', repo, number, by: label(ctx.principal), checks: infra.checks.map((c) => c.name), runs: [...runs] })
    return { checks: infra.checks.map((c) => c.name), runs: runs.size }
  }),

  /**
   * Run again every check of the project's open changes that no runner picked up (ChangeSummary.stuck; test-esp32 log
   * #146), once an admin has fixed the runner: the stuck queued runs are cancelled, which frees the concurrency group
   * they hold, and the newest of each workflow and branch runs again (src/api/stuck-checks.ts restartStuck).
   */
  'changes.rerun_stuck': def('write', Repo, async ({ repo }, ctx) => {
    spend(ctx)
    bust(ctx, repo)
    const open = await openChanges(ctx, repo)
    const heads = new Set(open.flatMap(({ change: c }) => (c.stuck ? [c.number] : [])))
    if (!heads.size) throw new ActionError('No change\'s checks are stuck waiting for a runner now, so there is nothing to run again.')
    const { changes } = await tracePulls(ctx, repo)
    const r = await rerunStuck(ctx, repo, new Set(changes.filter(({ pull }) => heads.has(pull.number)).map(({ pull }) => pull.sha).filter((x): x is string => !!x)))
    logLine(ctx, { event: 'changes.rerun_stuck', repo, by: label(ctx.principal), ...r })
    return { repo, changes: [...heads], ...r, summary: restartWords(r) }
  }),

  'change.diff': def('read', ChangeArgs.extend({ path: RepoPath }), async ({ repo, number, path }, ctx) => {
    spend(ctx)
    const gh = changesApi(await ctx.deps.github())
    const { pull } = await traceChange(ctx, gh, repo, number)
    const f = (await cached(ctx.deps.githubCache, repo, `files:${number}:${pull.head.sha}`, () => gh.pullFiles(repo, number))).find((x) => x.path === path)
    if (!f) throw new ActionError(`Change #${number} does not change ${path}.`)
    // before: the base commit (the file's old path when it was renamed); after: the head commit. A file added has no
    // before, one removed no after
    return {
      path, kind: fileKind(f.path, f.patch), patch: f.patch,
      before: f.status === 'added' ? null : { ref: pull.base.sha, ...(f.previous ? { path: f.previous } : {}) },
      after: f.status === 'removed' ? null : { ref: pull.head.sha },
      binary: f.patch === null && fileKind(f.path, null) !== 'text',
    }
  }),

  'change.accept': def('write', ChangeArgs.extend({ head_sha: Sha, note: z.string().trim().max(4000).optional() }), async ({ repo, number, head_sha: looked, note }, ctx) => {
    spend(ctx)
    // read it again now, from GitHub and not a kept copy: what the person looked at may have changed (a check failed,
    // trace pushed again). What they looked at is what they accept: a head that moved since is refused, and GitHub
    // merges only that commit (a push between this read and the merge makes GitHub refuse it: mergeRefusal's 409)
    const d = await changeDetail(ctx, repo, number, { fresh: true })
    if (d.head.sha !== looked) throw new ActionError('It changed since you looked at it. Look again before accepting.')
    if (!d.may_accept) throw new ActionError(`It cannot be accepted now. ${d.blockers.join(' ')}`)
    // an edit made in the app: an admin who did not make it accepts it (decision A); writes once it is merged
    if (d.kind !== 'work' && !isAdmin(ctx.principal)) throw new ActionError('Only an admin can accept a change someone made in the app.')
    const gh = changesApi(await ctx.deps.github())
    const allowed: readonly MergeMethod[] = await gh.mergeMethods(repo).catch(() => ['squash' as const])
    // changes stacked on it hold its commits: squashed or rebased, they would conflict with the design (docs/stacked-changes.md)
    const above = d.built_on_by ?? []
    if (above.length && !allowed.includes('merge')) {
      throw new ActionError(`${above.length === 1 ? 'A change builds' : `${above.length} changes build`} on this one, so it must go in with a merge commit, and this repository does not allow merge commits. An admin can allow them in the repository's settings, then accept it.`)
    }
    const method = above.length ? 'merge' as const : mergeMethod(allowed)
    let sha: string
    try {
      sha = await mergeWhenReady(ctx, () => gh.mergePull(repo, number, { method, sha: looked }))
      ctx.deps.githubCache?.closed(repo, number)
    } catch (e) {
      throw mergeRefusal(e) ?? e
    } finally {
      bust(ctx, repo)
    }
    // the hold label stopped the harness merging it on its own (src/harness/prs.ts automerge); it is merged now, and
    // a label left on a merged pull request only confuses the next reader. Its absence is fine
    if (d.held) await gh.removeLabel(repo, number, await holdLabel(ctx, repo)).catch(() => false)
    if (note) await gh.comment(repo, number, `Accepted by ${await publicName(ctx)}:\n\n${quote(note)}`).catch(() => undefined)
    const by = label(ctx.principal)
    // an edit's record is done once it is merged: it is never applied or listed again
    if (d.kind !== 'work') await editStore(ctx).remove(repo, d.head.ref).catch(() => undefined)
    // it is merged: whatever happens to the record now, the answer says so (a person told "it failed" would try again)
    let warning: string | undefined
    try {
      await record(ctx, repo, {
        kind: 'change.accepted', ref: String(number),
        summary: `${by} accepted "${d.title}" from ${d.from} into the design.${d.requirements.length ? ` It covers ${d.requirements.join(', ')}.` : ''}${note ? ` Note: ${note}` : ''}`,
        // ready_since: when it became ready for a person, for where the stage's time went (src/core/process-time.ts)
        detail: { number, sha, method, head: d.head.sha, checks: d.checks, requirements: d.requirements, ready_since: d.ready_since, kind: d.kind },
      })
    } catch (e) {
      logLine(ctx, { warning: 'change.accept: merged, but the decision was not recorded', repo, number, error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) })
      warning = 'It is merged, but trace could not write the decision to the log. Nothing else needs doing; an admin can find it in the runtime\'s log.'
    }
    // merged: the wait from ready to accepted (src/api/process-metrics.ts)
    recordWait(repo, 'change', d.ready_since, Date.now() / 1000)
    const stage = d.stage
    // a change that alters a requirement after the baseline takes the project back to Define, where the person agrees
    // it (docs/user-journey.md "Nothing goes to Fabricate while it is changing"). The merge stands either way; when the
    // record cannot be read now, journey.get and gate.sign find the change before any gate past Define is signed
    const back = await (async () => {
      const r = await withJourneyDb(ctx, repo, (db) => loadJourney(db))
      // the requirements its review page said it edits count too: the default branch read straight after the merge
      // can still be the copy from before it (test-esp32 log #112: Define reopened only at the next accept)
      if (!r) return null
      const ids = [...new Set([...await changedRequirements(ctx, repo, r).catch(() => [] as string[]), ...(d.requirement_edits?.ids ?? [])])]
      return backToDefine(ctx, repo, r, ids, by)
    })().catch(() => null)
    if (back) {
      return {
        merged: true as const, sha, stage: back.outcome.stage, back_to: back.outcome.stage, ...(back.outcome.revision ? { revision: back.outcome.revision } : {}),
        next: `Its work counts in the design now. Because ${back.reason}: ${back.words.charAt(0).toLowerCase()}${back.words.slice(1)}. Agree the change in Requirements review, then sign the requirements baseline and each gate after it again.`,
        ...(warning ? { warning } : {}),
      }
    }
    return {
      merged: true as const, sha, stage,
      next: d.kind !== 'work' ? 'It is applied.' : `Its work counts in the design now.${stage ? ` trace checks ${STAGE_NAMES[stage]}'s criteria again with it.` : ' trace checks the stage\'s criteria again with it.'}`,
      ...(warning ? { warning } : {}),
    }
  }),

  'change.ask': def('write', ChangeArgs.extend({ note: z.string().trim().min(1).max(4000) }), async ({ repo, number, note }, ctx) => {
    spend(ctx)
    const gh = changesApi(await ctx.deps.github())
    const found = await traceChange(ctx, gh, repo, number)
    const { pull } = found
    // an edit has no specialist to ask: the person who made it makes it again
    if (!found.job) throw new ActionError(`${found.edit ? `${found.edit.by_name} made this change in trace. Ask them to make it again, or discard it.` : `${repo} has no change #${number} from trace.`}`)
    const job = found.job
    if (pull.state !== 'open') throw new ActionError(pull.state === 'merged' ? 'It is already accepted into the design: ask for a new task instead.' : 'It was discarded: ask for a new task instead.')
    // the rule the task action holds a branch to: a revision job pushes to it, so never main or a person's branch
    if (!TaskBranch.safeParse(pull.head.ref).success) throw new ActionError(`${repo} has no change #${number} from trace.`)
    const by = label(ctx.principal)
    // the same specialist (a job routed or delegated to the generic worker carries on routed), on the same branch:
    // the job's runner checks out the remote branch when it exists (src/agents/runtime/job.ts checkoutBranch), so its
    // pushes update this pull request. The specialist it ran as (job.agent), not the one it is credited to
    // (creditedAgent, the person's pick): a re-routed job's revision goes where the router sent the work
    const agent = SPECIALIST_KINDS.find((k) => k === job.agent)
    const started = await (await ctx.deps.jobs()).startJob({
      kind: 'task', repository: repo, request: revisionRequest({ number, title: pull.title, branch: pull.head.ref, note, by, summary: job.summary }),
      requestedBy: by, requestedBySub: ctx.principal.sub, branch: pull.head.ref, ...(agent ? { agent } : {}),
    })
    if (!started.accepted) throw new ActionError(`trace could not start the revision: ${started.reason ?? 'it did not accept the job'}. Nothing was posted.`)
    bust(ctx, repo)
    await gh.comment(repo, number, `Asked for changes by ${await publicName(ctx)}:\n\n${quote(note)}\n\n${agent ? `The ${SPECIALIST_WORDS[agent]} specialist` : 'trace'} is revising it on this branch.`).catch(() => undefined)
    await record(ctx, repo, {
      kind: 'change.asked', ref: String(number),
      summary: `${by} asked for changes to "${pull.title}": ${note.replace(/\s+/g, ' ').slice(0, 300)}`,
      detail: { number, job_id: started.jobId, branch: pull.head.ref, agent: agent ?? null },
    })
    // sent back: the change is done again (src/api/process-metrics.ts)
    recordRework(repo, 'sent_back')
    return { job_id: started.jobId }
  }),

  /**
   * Bring a change in conflict up to date now (src/api/conflicts.ts), instead of waiting for trace to notice: an edit
   * made in trace is made again on the newest design; anything else goes to the worker, which merges the default branch
   * in, with the attempts it gave up on set aside. Anyone who may decide on the project's changes may ask.
   */
  'change.resolve': def('write', ChangeArgs, async ({ repo, number }, ctx) => {
    spend(ctx)
    const r = await resolveConflicts(ctx, repo, { only: [number], retry: true })
    const text = resolveWords(number, r)
    bust(ctx, repo)
    if (r.conflicts.length) {
      await record(ctx, repo, {
        kind: 'change.resolve', ref: String(number),
        summary: `${label(ctx.principal)} asked trace to bring change #${number} up to date with the newest design.`,
        detail: { number, remade: r.remade.includes(number), worker: r.worker.includes(number), started: r.started },
      }).catch(() => undefined)
    }
    return { text, remade: r.remade.includes(number), worker: r.worker.includes(number) && (r.started === 'yes' || r.started === 'without-retry'), conflict: r.conflicts.includes(number) }
  }),

  'change.discard': def('write', ChangeArgs.extend({ reason: z.string().trim().min(1).max(2000) }), async ({ repo, number, reason }, ctx) => {
    spend(ctx)
    const gh = changesApi(await ctx.deps.github())
    const { pull, edit } = await traceChange(ctx, gh, repo, number)
    if (pull.state !== 'open') throw new ActionError(pull.state === 'merged' ? 'It is already accepted into the design, so it cannot be discarded.' : 'It is discarded already.')
    // an edit made in the app: its author or an admin discards it
    if (edit && edit.by_sub !== ctx.principal.sub && !isAdmin(ctx.principal)) throw new ActionError(`${edit.by_name} made this change: they or an admin can discard it.`)
    const by = label(ctx.principal)
    // closed first, then the reason: a comment that cannot be posted must not leave it open after the person was told
    // it is discarded, nor post a reason on a change that stays open
    try {
      await gh.closePull(repo, number)
      ctx.deps.githubCache?.closed(repo, number)
    } finally {
      bust(ctx, repo)
    }
    // the jobs still at its branch would push to it again (log #75): stopped now, where trace can reach them
    const jobs = edit ? [] : await stopBranchJobs(ctx, repo, pull.head.ref, by)
    // the comment (with its mark) is what retires the branch for the harness and the jobs (src/core/discarded.ts)
    await gh.comment(repo, number, discardComment({ by: await publicName(ctx), quoted: quote(reason), stopped: jobs })).catch((e: unknown) => {
      logLine(ctx, { warning: 'change.discard: closed, but the reason was not posted', repo, number, error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) })
    })
    if (edit) await editStore(ctx).remove(repo, edit.branch).catch(() => undefined)
    await record(ctx, repo, {
      kind: 'change.discarded', ref: String(number),
      summary: `${by} discarded "${pull.title}": ${reason.replace(/\s+/g, ' ').slice(0, 300)}`, detail: { number, branch: pull.head.ref, head: pull.head.sha, reason, by, jobs },
    })
    return { closed: true as const, jobs }
  }),
}

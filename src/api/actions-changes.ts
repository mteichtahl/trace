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
 *   change.diff     read    { repo, number, path } → one file's patch, and the refs to read it before and after (the
 *                           review page opens schematic and board files there, in the viewer)
 *   change.accept   write   { repo, number, head_sha, note? } → { merged, sha, stage, next, warning? }: `head_sha` is
 *                           the head commit the person looked at (change.get's head.sha); a change whose head has
 *                           moved since is refused, and GitHub merges only that commit. Reads the status again and
 *                           refuses unless it may be accepted now; merges it with the repository's allowed method
 *                           (squash first), takes the hold label off, and records change.accepted (a record that
 *                           cannot be written after the merge is a warning in the answer: the merge stands)
 *   change.ask      write   { repo, number, note } → { job_id }: comments the note on it as a quote, starts a revision
 *                           job with the same specialist on the same branch (so the same pull request updates), and
 *                           records change.asked
 *   change.discard  write   { repo, number, reason } → { closed }: closes it, then comments the reason (a comment that
 *                           fails leaves it closed), records change.discarded
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
 * say so and how to change the rule.
 *
 * Who did it goes into the decisions log as their label (email), like every other decision. The comment on GitHub,
 * which anyone who can read the repository sees, names them by their name in the user pool, else "a person on the
 * project" and their initials: never their email. What a person wrote is posted as a quote, with comment markers
 * (`<!--`, `-->`, which trace's own workflows read as instructions) and @mentions neutralised: it is posted as trace's
 * account, so it must not be able to speak for trace or ping people in its name.
 */
import { z } from 'zod'
import { isAdmin, standing } from '../core/access.js'
import { readSettings, resolve } from '../core/config.js'
import { type JobRow, loadJobs } from '../core/job-index.js'
import { STAGE_NAMES, decide, loadJourney } from '../core/journey.js'
import { SPECIALIST_KINDS, SPECIALIST_WORDS } from '../agents/kinds.js'
import { fence } from '../agents/specialist.js'
import { Composer, NO_LAYERS } from '../prompts/resolve.js'
import { ActionError, type Context, PROJECT_DB_PATH, Repo, TaskBranch, def, label, tempDb, writeJourney } from './action-kit.js'
import { AGENT_WORDS, jobIndex } from './actions-jobs.js'
import {
  type ChangeDetail, type ChangeFacts, type ChangeSummary, type TraceRule, acceptance, changeSummary, checkState, criteriaNamed, fileKind, jobRequest, jobsByBranch,
  recommendationOf, requirementIds, summaryBullets, traceChanges, traceJob,
} from './changes.js'
import { GitHubError, type GitHubApi, type MergeMethod, type PullDetail, type PullStatus, type PullSummary } from './github.js'
import { SETTINGS_TTL_MS, cached } from './github-cache.js'

/** At most this many open changes get their status read (two GitHub calls each) in one list or journey. */
export const MAX_STATUS = 5

const Number_ = z.number().int().min(1).max(10_000_000)
const ChangeArgs = Repo.extend({ number: Number_ })
/** A full commit sha, as change.get gives head.sha. */
const Sha = z.string().regex(/^[0-9a-f]{40}$/, 'the head commit (40 hex characters) the change was looked at')
/** A path inside the repository, as GitHub lists it: no absolute paths and no climbing out. */
const RepoPath = z.string().min(1).max(500).refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'a path inside the repository')

/** The repository's GitHub calls the changes need, or a plain refusal when this installation's client has none. */
function changesApi(gh: GitHubApi): Required<Pick<GitHubApi, 'pullStatus' | 'pullDetail' | 'pullFiles' | 'pullCommits' | 'checkRuns' | 'mergeMethods' | 'mergePull' | 'comment' | 'closePull' | 'removeLabel'>> & GitHubApi {
  const need = ['pullStatus', 'pullDetail', 'pullFiles', 'pullCommits', 'checkRuns', 'mergeMethods', 'mergePull', 'comment', 'closePull', 'removeLabel'] as const
  if (need.some((k) => typeof gh[k] !== 'function')) throw new ActionError('This installation cannot review changes in the app. Use the "View on GitHub" link.')
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
  return cached(ctx.deps.githubCache, repo, 'pulls', () => gh.openPulls(repo))
}

/** One pull request's status, kept a short while per head commit (`sha`: the head the list gave; unknown, per number). */
const pullStatus = (ctx: Context, gh: GitHubApi, repo: string, number: number, sha?: string): Promise<PullStatus | null> =>
  (gh.pullStatus ? cached(ctx.deps.githubCache, repo, `status:${number}:${sha ?? ''}`, () => gh.pullStatus!(repo, number)) : Promise.resolve(null))

/** Count one GitHub-touching change action against this principal's budget (src/api/github-cache.ts). */
const spend = (ctx: Context): void => { ctx.deps.githubBudget?.take(ctx.principal.sub) }

/** Forget what is kept for the repository: after accepting, asking or discarding, its next look is fresh. */
const bust = (ctx: Context, repo: string): void => { ctx.deps.githubCache?.bust(repo) }

/** The open pull requests that are trace's changes, each with its job, oldest first, and the project's rule. */
export async function tracePulls(ctx: Context, repo: string): Promise<{ changes: { pull: PullSummary; job: JobRow }[]; rule: ProjectRule }> {
  const [pulls, rows] = await Promise.all([openPulls(ctx, repo), jobRows(ctx, repo)])
  // no open pull request: nothing to tell apart, so the settings are not read for it
  if (!pulls.length) return { changes: [], rule: { repo, defaultBranch: '', prefix: 'claude/', agentLogin: null, hold: 'no-automerge' } }
  const rule = await projectRule(ctx, repo)
  return { changes: traceChanges(pulls, rows, rule), rule }
}

/** Whether this person may change the project: an admin, or the Contributor part on it. */
async function writes(ctx: Context, repo: string): Promise<boolean> {
  return isAdmin(ctx.principal) || (await standing(ctx.principal, repo))?.part === 'contributor'
}

/** The change `number` with the job that made it, or "no such change" (a person's own pull request, a fork's, or one
 * another login opened, is not one: src/api/changes.ts traceJob). */
async function traceChange(ctx: Context, gh: ReturnType<typeof changesApi>, repo: string, number: number): Promise<{ pull: PullDetail; job: JobRow; rule: ProjectRule }> {
  const [pull, rows, rule] = await Promise.all([gh.pullDetail(repo, number), jobRows(ctx, repo), projectRule(ctx, repo)])
  const job = pull ? traceJob({ head: pull.head.ref, headRepo: pull.head.repo, author: pull.author }, jobsByBranch(rows, rule), rule) : null
  if (!pull || !job) throw new ActionError(`${repo} has no change #${number} from trace.`)
  return { pull, job, rule }
}

const factsOf = (p: Pick<PullDetail, 'state' | 'draft' | 'mergeable'>, checks: PullStatus['checks'], denied = false): ChangeFacts => ({ state: p.state, draft: p.draft, mergeable: p.mergeable, checks, ...(denied ? { checks_denied: true } : {}) })

/**
 * The open changes, oldest first, each with the gate criteria its job named (where its step goes in the journey) and
 * the status of the oldest `max` (the rest have none: their verdict is "checking", and they are never called ready).
 */
export async function openChanges(ctx: Context, repo: string, o: { max?: number } = {}): Promise<{ change: ChangeSummary; criteria: string[] }[]> {
  const gh = await ctx.deps.github()
  const { changes: mine, rule } = await tracePulls(ctx, repo)
  const max = o.max ?? MAX_STATUS
  const status = await Promise.all(mine.map(({ pull }, i) => (i < max ? pullStatus(ctx, gh, repo, pull.number, pull.sha).catch(() => null) : Promise.resolve(null))))
  return mine.map(({ pull, job }, i) => ({
    change: changeSummary({ repo, pull, job, status: status[i] ?? null, hold: rule.hold, agentWords: AGENT_WORDS }),
    criteria: criteriaNamed(jobRequest(job), job.title),
  }))
}

/** The open changes as changes.list answers them. */
export const listChanges = async (ctx: Context, repo: string, o: { max?: number } = {}): Promise<ChangeSummary[]> => (await openChanges(ctx, repo, o)).map((x) => x.change)

/**
 * One change in full, for this person. `fresh`: its status and checks are read from GitHub now, never a kept copy
 * (accepting decides on them). Its files and commits are kept per head commit: they cannot change without a push.
 */
async function changeDetail(ctx: Context, repo: string, number: number, o: { fresh?: boolean } = {}): Promise<ChangeDetail> {
  const gh = changesApi(await ctx.deps.github())
  const { pull, job, rule } = await traceChange(ctx, gh, repo, number)
  const sha = pull.head.sha
  const keep = o.fresh ? undefined : ctx.deps.githubCache
  // everything else is read in parallel; a part GitHub will not give (a token that cannot read checks) is left out
  const [status, files, commits, runs, write] = await Promise.all([
    cached(keep, repo, `status:${number}:${sha}`, () => gh.pullStatus(repo, number)),
    cached(ctx.deps.githubCache, repo, `files:${number}:${sha}`, () => gh.pullFiles(repo, number)).catch(() => []),
    cached(ctx.deps.githubCache, repo, `commits:${number}:${sha}`, () => gh.pullCommits(repo, number)).catch(() => []),
    cached(keep, repo, `runs:${sha}`, () => gh.checkRuns(repo, sha)).catch(() => null), writes(ctx, repo),
  ])
  const hold = rule.hold
  const sum = changeSummary({ repo, pull: { ...pull, labels: pull.labels }, job, status, hold, agentWords: AGENT_WORDS })
  const facts = factsOf(pull, status?.checks ?? null, status?.checks_denied ?? false)
  const checksList = (runs ?? []).map((c) => ({ name: c.name, state: checkState(c), summary: c.summary }))
  const requirements = requirementIds(pull.title, pull.body, ...commits)
  const passed = checksList.filter((c) => c.state === 'passed').map((c) => c.name)
  return {
    ...sum,
    summary: summaryBullets({ jobSummary: job.summary, body: pull.body, commits }),
    files: files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, kind: fileKind(f.path, f.patch) })),
    checks_list: checksList, requirements,
    recommendation: recommendationOf(facts, { passed, requirements }),
    ...acceptance(facts, write),
    base: pull.base, head: { ref: pull.head.ref, sha: pull.head.sha },
  }
}

/** The merge method to use: the first of squash, merge, rebase the repository allows (squash when it says nothing). */
export function mergeMethod(allowed: readonly MergeMethod[]): MergeMethod {
  return (['squash', 'merge', 'rebase'] as const).find((m) => allowed.includes(m)) ?? 'squash'
}

/** GitHub's refusal of a merge, in plain words; a required review gets the words the guided flow promises. */
export function mergeRefusal(e: unknown): ActionError | null {
  if (!(e instanceof GitHubError)) return null
  const said = e.said ?? ''
  if (/review/i.test(said)) {
    return new ActionError('GitHub refused: this repository requires an approving review before a pull request can merge, and trace cannot approve its own. trace\'s guided flow expects the repository\'s rules to require passing checks only: an admin of the repository can change the rule on GitHub (Settings, Branches or Rules, for the default branch), and then accept again.')
  }
  if (e.status === 409) return new ActionError('The change moved on since you looked at it (trace pushed to it again). Look at it again, then accept.')
  if (e.status === 405) return new ActionError(`GitHub would not merge it: ${said || 'its rules do not allow it yet'}. Look at it again in a minute.`)
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
const logLine = (ctx: Context, l: Record<string, unknown>): void => {
  (ctx.deps.log ?? ((x) => { process.stdout.write(`${JSON.stringify(x)}\n`) }))({ at: new Date().toISOString(), ...l })
}

export const CHANGE_ACTIONS = {
  'changes.list': def('read', Repo, async ({ repo }, ctx) => { spend(ctx); return { repo, changes: await listChanges(ctx, repo) } }),

  'change.get': def('read', ChangeArgs, async ({ repo, number }, ctx) => { spend(ctx); return changeDetail(ctx, repo, number) }),

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
    const gh = changesApi(await ctx.deps.github())
    const method = mergeMethod(await gh.mergeMethods(repo).catch(() => ['squash' as const]))
    let sha: string
    try {
      sha = (await gh.mergePull(repo, number, { method, sha: looked })).sha
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
    // it is merged: whatever happens to the record now, the answer says so (a person told "it failed" would try again)
    let warning: string | undefined
    try {
      await record(ctx, repo, {
        kind: 'change.accepted', ref: String(number),
        summary: `${by} accepted "${d.title}" from ${d.from} into the design.${d.requirements.length ? ` It covers ${d.requirements.join(', ')}.` : ''}${note ? ` Note: ${note}` : ''}`,
        detail: { number, sha, method, head: d.head.sha, checks: d.checks, requirements: d.requirements },
      })
    } catch (e) {
      logLine(ctx, { warning: 'change.accept: merged, but the decision was not recorded', repo, number, error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) })
      warning = 'It is merged, but trace could not write the decision to the log. Nothing else needs doing; an admin can find it in the runtime\'s log.'
    }
    const stage = d.stage
    return {
      merged: true as const, sha, stage,
      next: `Its work counts in the design now.${stage ? ` trace checks ${STAGE_NAMES[stage]}'s criteria again with it.` : ' trace checks the stage\'s criteria again with it.'}`,
      ...(warning ? { warning } : {}),
    }
  }),

  'change.ask': def('write', ChangeArgs.extend({ note: z.string().trim().min(1).max(4000) }), async ({ repo, number, note }, ctx) => {
    spend(ctx)
    const gh = changesApi(await ctx.deps.github())
    const { pull, job } = await traceChange(ctx, gh, repo, number)
    if (pull.state !== 'open') throw new ActionError(pull.state === 'merged' ? 'It is already accepted into the design: ask for a new task instead.' : 'It was discarded: ask for a new task instead.')
    // the rule the task action holds a branch to: a revision job pushes to it, so never main or a person's branch
    if (!TaskBranch.safeParse(pull.head.ref).success) throw new ActionError(`${repo} has no change #${number} from trace.`)
    const by = label(ctx.principal)
    // the same specialist (a job routed or delegated to the generic worker carries on routed), on the same branch:
    // the job's runner checks out the remote branch when it exists (src/agents/runtime/job.ts checkoutBranch), so its
    // pushes update this pull request
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
    return { job_id: started.jobId }
  }),

  'change.discard': def('write', ChangeArgs.extend({ reason: z.string().trim().min(1).max(2000) }), async ({ repo, number, reason }, ctx) => {
    spend(ctx)
    const gh = changesApi(await ctx.deps.github())
    const { pull } = await traceChange(ctx, gh, repo, number)
    if (pull.state !== 'open') throw new ActionError(pull.state === 'merged' ? 'It is already accepted into the design, so it cannot be discarded.' : 'It is discarded already.')
    const by = label(ctx.principal)
    // closed first, then the reason: a comment that cannot be posted must not leave it open after the person was told
    // it is discarded, nor post a reason on a change that stays open
    try {
      await gh.closePull(repo, number)
    } finally {
      bust(ctx, repo)
    }
    await gh.comment(repo, number, `Discarded by ${await publicName(ctx)}:\n\n${quote(reason)}`).catch((e: unknown) => {
      logLine(ctx, { warning: 'change.discard: closed, but the reason was not posted', repo, number, error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) })
    })
    await record(ctx, repo, {
      kind: 'change.discarded', ref: String(number),
      summary: `${by} discarded "${pull.title}": ${reason.replace(/\s+/g, ' ').slice(0, 300)}`, detail: { number, branch: pull.head.ref },
    })
    return { closed: true as const }
  }),
}

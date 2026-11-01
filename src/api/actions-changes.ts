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
 *   change.accept   write   { repo, number, note? } → { merged, sha, stage, next }: reads the status again and refuses
 *                           unless it may be accepted now; merges it with the repository's allowed method (squash
 *                           first), takes the hold label off, and records change.accepted
 *   change.ask      write   { repo, number, note } → { job_id }: comments "Asked by <name>: …" on it, starts a revision
 *                           job with the same specialist on the same branch (so the same pull request updates), and
 *                           records change.asked
 *   change.discard  write   { repo, number, reason } → { closed }: comments the reason, closes it, records
 *                           change.discarded
 *
 * Access is checked first (perform), as for every action: read = assigned to the project; write = the Contributor
 * part (admins are contributors everywhere). A reviewer reads changes but cannot accept, ask or discard, and a
 * connected system only reads (src/api/service-policy.ts). A pull request that is not one of trace's (a person's own,
 * or one of another project) is answered "no such change": these actions never act on a person's pull request.
 *
 * GitHub's review rule: trace never approves on GitHub (its account opened the pull request, and GitHub refuses an
 * approval from the author). The guided flow expects the repository to require passing checks only; trace records who
 * accepted in the decisions log. A repository that still requires a review makes accepting fail with plain words that
 * say so and how to change the rule.
 *
 * Who did it goes into the decisions log as their label (email), like every other decision; the comment on GitHub
 * names them the same way, because the people reading GitHub need to know who asked.
 */
import { z } from 'zod'
import { isAdmin, standing } from '../core/access.js'
import { readSettings, resolve } from '../core/config.js'
import { type JobRow, loadJobs } from '../core/job-index.js'
import { STAGE_NAMES, decide, loadJourney } from '../core/journey.js'
import { SPECIALIST_KINDS, SPECIALIST_WORDS } from '../agents/kinds.js'
import { ActionError, type Context, Repo, def, label, withProjectDb, writeJourney } from './action-kit.js'
import { AGENT_WORDS, jobIndex } from './actions-jobs.js'
import {
  type ChangeDetail, type ChangeFacts, type ChangeSummary, acceptance, changeSummary, checkState, criteriaNamed, fileKind, jobRequest, jobsByBranch,
  recommendationOf, requirementIds, summaryBullets, traceChanges,
} from './changes.js'
import { GitHubError, type GitHubApi, type MergeMethod, type PullDetail, type PullStatus } from './github.js'

/** At most this many open changes get their status read (two GitHub calls each) in one list or journey. */
export const MAX_STATUS = 5

const Number_ = z.number().int().min(1).max(10_000_000)
const ChangeArgs = Repo.extend({ number: Number_ })
/** A path inside the repository, as GitHub lists it: no absolute paths and no climbing out. */
const RepoPath = z.string().min(1).max(500).refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'a path inside the repository')

/** The repository's GitHub calls the changes need, or a plain refusal when this installation's client has none. */
function changesApi(gh: GitHubApi): Required<Pick<GitHubApi, 'pullStatus' | 'pullDetail' | 'pullFiles' | 'pullCommits' | 'checkRuns' | 'mergeMethods' | 'mergePull' | 'comment' | 'closePull' | 'removeLabel'>> & GitHubApi {
  const need = ['pullStatus', 'pullDetail', 'pullFiles', 'pullCommits', 'checkRuns', 'mergeMethods', 'mergePull', 'comment', 'closePull', 'removeLabel'] as const
  if (need.some((k) => typeof gh[k] !== 'function')) throw new ActionError('This installation cannot review changes in the app. Use the "View on GitHub" link.')
  return gh as ReturnType<typeof changesApi>
}

/** The hold label (labels.hold, default no-automerge) from the project's settings; the default when they cannot be read. */
export async function holdLabel(ctx: Context, repo: string): Promise<string> {
  try {
    return await withProjectDb(ctx, repo, (db) => resolve(readSettings(db)).config.labels.hold)
  } catch {
    return 'no-automerge'
  }
}

/** The project's job index rows (the branches trace's jobs worked on). */
export const jobRows = async (ctx: Context, repo: string): Promise<JobRow[]> => (await jobIndex(ctx, repo).read((db) => loadJobs(db))).result

/** Whether this person may change the project: an admin, or the Contributor part on it. */
async function writes(ctx: Context, repo: string): Promise<boolean> {
  return isAdmin(ctx.principal) || (await standing(ctx.principal, repo))?.part === 'contributor'
}

/** The change `number` with the job that made it, or "no such change" (a person's own pull request is not one). */
async function traceChange(ctx: Context, gh: ReturnType<typeof changesApi>, repo: string, number: number): Promise<{ pull: PullDetail; job: JobRow }> {
  const [pull, rows] = await Promise.all([gh.pullDetail(repo, number), jobRows(ctx, repo)])
  const job = pull ? jobsByBranch(rows).get(pull.head.ref) : undefined
  if (!pull || !job) throw new ActionError(`${repo} has no change #${number} from trace.`)
  return { pull, job }
}

const factsOf = (p: Pick<PullDetail, 'state' | 'draft' | 'mergeable'>, checks: PullStatus['checks']): ChangeFacts => ({ state: p.state, draft: p.draft, mergeable: p.mergeable, checks })

/**
 * The open changes, oldest first, each with the gate criteria its job named (where its step goes in the journey) and
 * the status of the oldest `max` (the rest have none: their verdict is "checking", and they are never called ready).
 */
export async function openChanges(ctx: Context, repo: string, o: { max?: number } = {}): Promise<{ change: ChangeSummary; criteria: string[] }[]> {
  const gh = await ctx.deps.github()
  const [pulls, rows, hold] = await Promise.all([gh.openPulls(repo), jobRows(ctx, repo), holdLabel(ctx, repo)])
  const mine = traceChanges(pulls, rows)
  const max = o.max ?? MAX_STATUS
  const status = await Promise.all(mine.map(({ pull }, i) => (i < max && gh.pullStatus ? gh.pullStatus(repo, pull.number).catch(() => null) : Promise.resolve(null))))
  return mine.map(({ pull, job }, i) => ({
    change: changeSummary({ repo, pull, job, status: status[i] ?? null, hold, agentWords: AGENT_WORDS }),
    criteria: criteriaNamed(jobRequest(job), job.title),
  }))
}

/** The open changes as changes.list answers them. */
export const listChanges = async (ctx: Context, repo: string, o: { max?: number } = {}): Promise<ChangeSummary[]> => (await openChanges(ctx, repo, o)).map((x) => x.change)

/** One change in full, for this person. */
async function changeDetail(ctx: Context, repo: string, number: number): Promise<ChangeDetail> {
  const gh = changesApi(await ctx.deps.github())
  const { pull, job } = await traceChange(ctx, gh, repo, number)
  // everything else is read in parallel; a part GitHub will not give (a token that cannot read checks) is left out
  const [status, files, commits, runs, hold, write] = await Promise.all([
    gh.pullStatus(repo, number), gh.pullFiles(repo, number).catch(() => []), gh.pullCommits(repo, number).catch(() => []),
    gh.checkRuns(repo, pull.head.sha).catch(() => null), holdLabel(ctx, repo), writes(ctx, repo),
  ])
  const sum = changeSummary({ repo, pull: { ...pull, labels: pull.labels }, job, status, hold, agentWords: AGENT_WORDS })
  const facts = factsOf(pull, status?.checks ?? null)
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
    base: pull.base, head: pull.head,
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

/** Record a decision about a change in the journey's log (a project without a journey yet keeps no log: skipped). */
async function record(ctx: Context, repo: string, d: { kind: string; ref: string; summary: string; detail: unknown }): Promise<void> {
  await writeJourney(ctx, repo, (db) => {
    const r = loadJourney(db)
    if (!r) return { result: null, changed: false }
    decide(db, { kind: d.kind, stage: r.journey.currentStage, ref: d.ref, by: label(ctx.principal), summary: d.summary, detail: d.detail })
    return { result: null }
  })
}

/** The request a revision job gets: what the person asked, and to carry on on the same branch so the change updates. */
export function revisionRequest(o: { number: number; title: string; branch: string; note: string; by: string; summary: string | null }): string {
  return [
    `${o.by} reviewed your change #${o.number} ("${o.title}") and asked for changes:`,
    o.note,
    `Carry the work on ${o.branch} on: read what is already on the branch${o.summary ? ' and what you reported last time' : ''}, change what they asked, check it as before, and push to the same branch so the same change updates. Do not open a new pull request.`,
    ...(o.summary ? ['', 'What you reported last time:', o.summary.slice(0, 4000)] : []),
    'If what they asked cannot be done as asked, say so with journey.ask, with what you found.',
  ].join('\n')
}

export const CHANGE_ACTIONS = {
  'changes.list': def('read', Repo, async ({ repo }, ctx) => ({ repo, changes: await listChanges(ctx, repo) })),

  'change.get': def('read', ChangeArgs, async ({ repo, number }, ctx) => changeDetail(ctx, repo, number)),

  'change.diff': def('read', ChangeArgs.extend({ path: RepoPath }), async ({ repo, number, path }, ctx) => {
    const gh = changesApi(await ctx.deps.github())
    const { pull } = await traceChange(ctx, gh, repo, number)
    const f = (await gh.pullFiles(repo, number)).find((x) => x.path === path)
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

  'change.accept': def('write', ChangeArgs.extend({ note: z.string().trim().max(4000).optional() }), async ({ repo, number, note }, ctx) => {
    // read it again now: what the person looked at may have changed (a check failed, trace pushed again)
    const d = await changeDetail(ctx, repo, number)
    if (!d.may_accept) throw new ActionError(`It cannot be accepted now. ${d.blockers.join(' ')}`)
    const gh = changesApi(await ctx.deps.github())
    const method = mergeMethod(await gh.mergeMethods(repo).catch(() => ['squash' as const]))
    let sha: string
    try {
      sha = (await gh.mergePull(repo, number, { method, sha: d.head.sha })).sha
    } catch (e) {
      throw mergeRefusal(e) ?? e
    }
    // the hold label stopped the harness merging it on its own (src/harness/prs.ts automerge); it is merged now, and
    // a label left on a merged pull request only confuses the next reader. Its absence is fine
    if (d.held) await gh.removeLabel(repo, number, await holdLabel(ctx, repo)).catch(() => false)
    if (note) await gh.comment(repo, number, `Accepted by ${label(ctx.principal)}: ${note}`).catch(() => undefined)
    const by = label(ctx.principal)
    await record(ctx, repo, {
      kind: 'change.accepted', ref: String(number),
      summary: `${by} accepted "${d.title}" from ${d.from} into the design.${d.requirements.length ? ` It covers ${d.requirements.join(', ')}.` : ''}${note ? ` Note: ${note}` : ''}`,
      detail: { number, sha, method, head: d.head.sha, checks: d.checks, requirements: d.requirements },
    })
    const stage = d.stage
    return {
      merged: true as const, sha, stage,
      next: `Its work counts in the design now.${stage ? ` trace checks ${STAGE_NAMES[stage]}'s criteria again with it.` : ' trace checks the stage\'s criteria again with it.'}`,
    }
  }),

  'change.ask': def('write', ChangeArgs.extend({ note: z.string().trim().min(1).max(4000) }), async ({ repo, number, note }, ctx) => {
    const gh = changesApi(await ctx.deps.github())
    const { pull, job } = await traceChange(ctx, gh, repo, number)
    if (pull.state !== 'open') throw new ActionError(pull.state === 'merged' ? 'It is already accepted into the design: ask for a new task instead.' : 'It was discarded: ask for a new task instead.')
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
    await gh.comment(repo, number, `Asked by ${by}: ${note}\n\n${agent ? `The ${SPECIALIST_WORDS[agent]} specialist` : 'trace'} is revising it on this branch.`).catch(() => undefined)
    await record(ctx, repo, {
      kind: 'change.asked', ref: String(number),
      summary: `${by} asked for changes to "${pull.title}": ${note.replace(/\s+/g, ' ').slice(0, 300)}`,
      detail: { number, job_id: started.jobId, branch: pull.head.ref, agent: agent ?? null },
    })
    return { job_id: started.jobId }
  }),

  'change.discard': def('write', ChangeArgs.extend({ reason: z.string().trim().min(1).max(2000) }), async ({ repo, number, reason }, ctx) => {
    const gh = changesApi(await ctx.deps.github())
    const { pull } = await traceChange(ctx, gh, repo, number)
    if (pull.state !== 'open') throw new ActionError(pull.state === 'merged' ? 'It is already accepted into the design, so it cannot be discarded.' : 'It is discarded already.')
    const by = label(ctx.principal)
    await gh.comment(repo, number, `Discarded by ${by}: ${reason}`)
    await gh.closePull(repo, number)
    await record(ctx, repo, {
      kind: 'change.discarded', ref: String(number),
      summary: `${by} discarded "${pull.title}": ${reason.replace(/\s+/g, ' ').slice(0, 300)}`, detail: { number, branch: pull.head.ref },
    })
    return { closed: true as const }
  }),
}

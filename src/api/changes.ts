/**
 * A change: a pull request a trace job opened (docs/guided-flow.md). A job's work reaches the project's record only
 * when its pull request is merged, so the app shows it as a change to review and accept, never as a pull request.
 *
 * This file holds the rules, as plain functions over what GitHub and the job index say (src/api/actions-changes.ts
 * fetches them; journey.get and the inbox use the same rules):
 *
 *   which pull requests are trace's   all of these (traceRule): its head branch lives in the project's repository
 *                                     itself, not a fork (a fork can name its branch anything, claude/task-x
 *                                     included); the branch starts with the project's own prefix
 *                                     (worker.own_branch_prefix, claude/ by default) and is not the default branch;
 *                                     a job of the project's index worked on that branch (the newest job on a branch
 *                                     names it: a resumed task works on its paused one's branch), and that job is a
 *                                     task or a hand-off, or a work item on a branch of trace's own (a ci-red work
 *                                     item that fixed a person's branch made no change of trace's); and, when the
 *                                     login trace's agents act as is known (TRACE_AGENT_LOGIN), the pull request was
 *                                     opened by that login. A branch name alone proves nothing: anyone who can push
 *                                     a branch can name it claude/…, and accepting merges it
 *   verdict                           one word for the list's pill: ready, checking, failing, conflict, blocked
 *   recommendation                    worked out from facts, never a model: every check passed and it can merge →
 *                                     accept; a check failing → ask, naming it; checks running → wait; a conflict →
 *                                     none, trace brings it up to date
 *   may_accept and blockers           this person, now: the Contributor part, open, checks neither failing nor
 *                                     running, no conflict; otherwise each reason in plain words
 *   requirements                      the requirement ids (R4, R7, and ranges such as R1-R10) the change names
 *   summary                           what trace did, as plain bullets: the job's result, else the pull request's
 *                                     first list, else its commit subjects
 *   ready_since                       when it became ready for a person (readySince): its head commit's checks all
 *                                     finished, the last of them; GitHub giving no finishing time (commit statuses,
 *                                     none at all), when the pull request was opened. Operations' wait on a change
 *                                     runs from it to the accept (src/api/process-metrics.ts)
 *
 * GitHub's mergeable_state is read as: clean or has_hooks (can merge), unstable (a check that is not required failed),
 * dirty (a conflict), behind (the repository wants it up to date first), blocked (its rules stop it: required checks
 * still running, or a required review), unknown (GitHub is still working it out), draft.
 */
import { SPECIALIST_KINDS } from '../agents/kinds.js'
import { type AppEdit, EDIT_WORDS, type EditKind } from '../core/app-edits.js'
import type { JobRow } from '../core/job-index.js'
import { indexedHandle } from '../core/job-index.js'
import { type JourneyRecord, LATER_STAGES, STAGE_IDS, type StageId, TEMPLATES, templateStages } from '../core/journey.js'
import type { CheckRunDetail, PullFile, PullStatus, PullSummary } from './github.js'

export type Verdict = 'ready' | 'checking' | 'failing' | 'conflict' | 'blocked' | 'unfinished' | 'applying'
/** 'work': a specialist's change (docs/guided-flow.md); otherwise an edit a person made in the app (docs/stay-in-trace.md) */
export type ChangeKind = 'work' | EditKind
export type Checks = NonNullable<PullStatus['checks']>
export type FileKind = 'schematic' | 'board' | 'parts' | 'text' | 'image' | 'binary'

export interface ChangeSummary {
  number: number; title: string; url: string; draft: boolean; held: boolean
  kind: ChangeKind
  /** an edit: who made it (their name, else their initials) */
  by_name?: string
  /** an edit: the viewer made it */
  mine?: boolean
  /** an edit: auto (trace applies it once its checks pass) or review (an admin who did not make it accepts it) */
  applies?: AppEdit['applies']
  /** "the Verification specialist", or "a trace job" */
  from: string
  job_id: string | null; stage: StageId | null; opened_at: string; updated_at: string
  state: 'open' | 'merged' | 'closed'
  /** GitHub's mergeable_state */
  mergeable: string
  checks: Checks | null
  /** GitHub refused every way of reading the checks (src/api/github.ts checkRuns) */
  checks_denied?: boolean
  verdict: Verdict
  /** the gate criteria it says it waits on a person's approval of (ChangeFacts.awaiting) */
  awaiting?: string[]
  /** a stacked change (docs/stacked-changes.md): the open change it builds on, which is accepted first */
  builds_on?: StackLink
  /** the open changes stacked on this one, which follow it into the design */
  built_on_by?: StackLink[]
}
/** One change of a stack, as another change names it. */
export interface StackLink { number: number; title: string }
/**
 * One check of a change's head commit. `id` opens it with change.check: `cr:<check run id>` for a check run,
 * `job:<Actions job id>` for a workflow run's job, null for a commit status (nothing more to open).
 */
export interface CheckLine { id: string | null; name: string; state: 'passed' | 'failed' | 'running' | 'skipped'; summary: string | null }
/** One check in full (change.check): its report, annotations and, for a GitHub Actions job, the end of its log. */
export interface CheckDetail {
  id: string; name: string; state: CheckLine['state']
  /** one line, as in checks_list */
  summary: string | null
  /** the check's own report: output.summary + output.text, markdown, at most CHECK_TEXT_MAX bytes */
  text: string | null
  started_at: string | null; completed_at: string | null
  /** at most CHECK_ANNOTATIONS */
  annotations: { path: string; line: number | null; level: 'failure' | 'warning' | 'notice'; title: string | null; message: string }[]
  /** the Actions job's log end (cleaned), when there is one */
  log: { text: string; truncated: boolean } | null
  /** admins only: the check on GitHub */
  url?: string
}
/** A check's report is cut to this many bytes (UTF-8). */
export const CHECK_TEXT_MAX = 60 * 1024
/** At most this many annotations of a check are answered. */
export const CHECK_ANNOTATIONS = 50

/** The checks list of a change: each check's id, name, state and one line. */
export const checkLines = (runs: readonly CheckRunDetail[] | null): CheckLine[] =>
  (runs ?? []).map((c) => ({ id: c.id ?? null, name: c.name, state: checkState(c), summary: c.summary }))

/** A check run's report as change.check answers it: its summary then its text, cut to `max` bytes; null when empty. */
export function checkText(summary: string | null | undefined, text: string | null | undefined, max = CHECK_TEXT_MAX): string | null {
  const all = [summary?.trim(), text?.trim()].filter((x): x is string => !!x).join('\n\n')
  if (!all) return null
  const b = Buffer.from(all, 'utf8')
  if (b.length <= max) return all
  // cut on a character boundary, with a mark that it was cut, within max
  const mark = '\n\n…'
  return b.subarray(0, max - Buffer.byteLength(mark)).toString('utf8').replace(/\uFFFD+$/, '') + mark
}

/** GitHub's annotation levels in the three words the sheet uses. */
export const annotationLevel = (l: string): CheckDetail['annotations'][number]['level'] => (l === 'failure' || l === 'warning' ? l : 'notice')
export interface Recommendation { verdict: 'accept' | 'ask' | 'wait' | 'none'; why: string }
export interface ChangeDetail extends ChangeSummary {
  summary: string[]
  files: { path: string; status: PullFile['status']; additions: number; deletions: number; kind: FileKind }[]
  checks_list: CheckLine[]
  requirements: string[]
  recommendation: Recommendation
  may_accept: boolean
  blockers: string[]
  base: { ref: string; sha: string }; head: { ref: string; sha: string }
  /** its checks are done, yet the repository's rules stop it: a required review trace cannot give (repo.rules.fix) */
  rule_blocks: boolean
  /** an edit: whether this person may discard it (its author, or an admin); a specialist's change: write access */
  may_discard: boolean
  /** a specialist's change: whether this person may ask for changes (never for an edit: there is no specialist) */
  may_ask: boolean
  /** when it became ready for a person (readySince), ISO */
  ready_since: string
}

/**
 * When a change became ready for a person: the last of its head commit's checks to finish, when every check finished
 * and GitHub says when; otherwise when the pull request was opened (all trace has). Pure.
 */
export function readySince(runs: readonly Pick<CheckRunDetail, 'status' | 'completed_at'>[] | null, openedAt: string): string {
  const done = (runs ?? []).map((r) => (r.status === 'completed' && r.completed_at ? Date.parse(r.completed_at) : NaN))
  if (!done.length || done.some((t) => !Number.isFinite(t))) return openedAt
  return new Date(Math.max(...done, Date.parse(openedAt) || 0)).toISOString()
}

/** The facts the verdict, recommendation and blockers are worked out from. */
export interface ChangeFacts {
  state: 'open' | 'merged' | 'closed'; draft: boolean; mergeable: string; checks: Checks | null
  /** GitHub refused every way of reading the checks (src/api/github.ts checkRuns): the token lacks Actions and Commit statuses */
  checks_denied?: boolean
  /** the specialist's own words saying the work is not finished ("incomplete export, not for approval"): unfinishedWords */
  unfinished?: string
  /**
   * The gate criteria the specialist said the change waits on a person's approval of ("do not merge before layout.renders
   * is approved"). With `unfinished`: still waiting on them. Without: they were approved since, which settled it.
   */
  awaiting?: string[]
  /**
   * It targets a branch other than the default branch (`base`): a stacked change, built on the open change `on` (null
   * when no open change has that branch). Accepting it would merge it into that branch, not into the design.
   */
  stacked?: { base: string; on: StackLink | null }
}

// a specialist that says its work is not ready for a person, in its title (each clause) or in its summary or the pull
// request's description (only the plainest phrases there: a word like "incomplete" in a description is often about
// something else, "fixes an incomplete netlist")
const UNFINISHED_STRONG = /\b(not (yet )?for (approval|review|merging)|do not merge|don'?t merge|not ready( (for|to) (review|merge|merging|approval))?|work in progress|wip)\b/i
const UNFINISHED_TITLE = /\b(incomplete|unfinished|not finished|partial (work|export|render|result)s?|placeholder)\b/i

/**
 * A pull request description without the request it quotes: trace's descriptions open with who asked and what
 * ("Requested by the trace verify specialist (job …), who asked:" then the request), up to the next heading. Those are
 * the instructions the job was given, so they never say whether its work is finished.
 */
export function withoutQuotedRequest(body: string | null | undefined): string {
  const lines = (body ?? '').split('\n')
  const out: string[] = []
  let quoting = false
  for (const line of lines) {
    if (quoting) {
      if (/^\s*#{1,6}\s/.test(line)) quoting = false
      else continue
    }
    if (/\basked:\s*$/i.test(line)) { quoting = true; continue }
    // a Markdown blockquote is someone else's words: a worker quotes the request it was given that way ("## The
    // request, quoted" then "> … Do not merge.")
    if (/^\s*>/.test(line)) continue
    out.push(line)
  }
  return out.join('\n')
}

/** Text as compared for quoting: lower case, single spaces, no closing punctuation. */
const plain = (x: string): string => x.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?;:,]+$/, '').trim()

/**
 * The specialist's own words saying its work is not finished, or null. From the title, the clauses that say so
 * ("incomplete export, not for approval"); else the first sentence of its summary or description that says so plainly.
 * A sentence that is also in the job's own `request` is the instruction it was given, not its verdict: a worker's report
 * and its pull request quote what the specialist asked ("… do not change any requirement's status, do not merge."),
 * and that once read as "not finished" on a change whose work was done (test-2, change 3).
 */
export function unfinishedWords(o: { title: string; summary?: string | null | undefined; body?: string | null | undefined; request?: string | null | undefined }): string | null {
  const title = o.title.replace(/^trace:\s*/i, '')
  const clauses = title.split(/\s*[,;:(){}\u2013\u2014]\s*|\s+-\s+/).map((x) => x.trim()).filter(Boolean)
  const said = clauses.filter((c) => UNFINISHED_STRONG.test(c) || UNFINISHED_TITLE.test(c))
  if (said.length) return said.join(', ').slice(0, 160)
  const asked = o.request ? plain(o.request) : ''
  for (const text of [o.summary, withoutQuotedRequest(o.body)]) {
    const hit = (text ?? '').split(/(?<=[.!?])\s+|\n+/).map((x) => x.replace(/^[-*#>\s]+/, '').trim()).find((x) => UNFINISHED_STRONG.test(x) && !(asked && asked.includes(plain(x))))
    if (hit) return hit.slice(0, 160)
  }
  return null
}

const WAITS_ON_APPROVAL = /\bapprov(e|ed|al|ing)\b/i

/**
 * The gate criteria an unfinished change says it waits on a person's approval of: those its unfinished words name, else
 * (words such as "do not merge before that approval" name none) those its title, summary or description name. None
 * when the words are not about an approval: "work in progress" waits on the specialist, not a person.
 */
export function awaitedApprovals(unfinished: string, o: { title: string; summary?: string | null | undefined; body?: string | null | undefined }): string[] {
  if (!WAITS_ON_APPROVAL.test(unfinished)) return []
  const own = criteriaNamed(unfinished)
  return own.length ? own : criteriaNamed(o.title, o.summary ?? '', o.body ?? '')
}

/**
 * The gate criteria a person has approved, as the journey says now (with the agents' facts merged in): met, waived by
 * an open waiver, or named by an agent's question a person answered with an option that approves ("Approve the renders
 * of run d09516a5"): the answer is the approval, before the specialist records the criterion as met.
 */
export function approvalsGiven(r: Pick<JourneyRecord, 'criteria' | 'waivers' | 'questions'>): Set<string> {
  const out = new Set<string>()
  for (const c of r.criteria) if (c.status === 'met') out.add(c.id)
  for (const w of r.waivers) if (w.targetKind === 'criterion' && w.closedAt === null) out.add(w.target)
  for (const q of r.questions) {
    if (q.answeredAt === null || !q.optionId) continue
    const picked = q.options.find((o) => o.id === q.optionId)
    if (picked && /^\s*approve\b/i.test(picked.label)) for (const id of criteriaNamed(q.text)) out.add(id)
  }
  return out
}

/**
 * Settle a change's unfinished words against the approvals given: when every criterion it waited on is approved, it is
 * no longer unfinished (its `awaiting` stays, so the recommendation can say what was waited on). Changes `facts` in place.
 */
export function settleUnfinished(facts: ChangeFacts, o: { title: string; summary?: string | null | undefined; body?: string | null | undefined }, given: ReadonlySet<string>): ChangeFacts {
  if (!facts.unfinished) return facts
  const awaiting = awaitedApprovals(facts.unfinished, o)
  if (!awaiting.length) return facts
  facts.awaiting = awaiting
  if (awaiting.every((id) => given.has(id))) delete facts.unfinished
  return facts
}

/** What a person is told when trace's GitHub token may not read checks: who can fix it, and how. */
export const CHECKS_DENIED = 'trace\'s GitHub token may not read this repository\'s checks, so trace cannot tell whether this work passed. An admin gives the token "Actions: read" and "Commit statuses: read" on this repository.'

// ------------------------------------------------------------------ which pull requests are trace's

/**
 * What tells trace's pull requests from everyone else's, for one project: the repository (owner/name), its default
 * branch, the prefix of trace's own branches, and the login trace's agents open pull requests as (null: not known, so
 * not checked).
 */
export interface TraceRule { repo: string; defaultBranch: string; prefix: string; agentLogin: string | null }

/** The job kinds whose branch can carry a change of trace's: a task (a hand-off is a task too) or a work item. */
const CHANGE_JOB_KINDS: ReadonlySet<string> = new Set(['task', 'work-item'])

/** Whether `branch` is one of trace's own: the prefix, something after it, and never the default branch. */
export const ownBranch = (branch: string, rule: Pick<TraceRule, 'defaultBranch' | 'prefix'>): boolean =>
  branch !== rule.defaultBranch && branch.startsWith(rule.prefix) && branch.length > rule.prefix.length

/**
 * Each branch's newest job (a resumed task works on its paused one's branch, and names it). With a rule, only trace's
 * own branches are indexed, only for jobs that make changes: the default branch never is (a work item on it is not a
 * change), nor a person's branch a ci-red or conflict work item worked on.
 */
export function jobsByBranch(jobs: readonly JobRow[], rule?: Pick<TraceRule, 'defaultBranch' | 'prefix'>): Map<string, JobRow> {
  const byBranch = new Map<string, JobRow>()
  for (const j of [...jobs].sort((a, b) => (a.endedAt ?? a.updatedAt) - (b.endedAt ?? b.updatedAt))) {
    if (!j.branch) continue
    if (rule && (!CHANGE_JOB_KINDS.has(j.kind) || !ownBranch(j.branch, rule))) continue
    // a delegated worker commits for its specialist: the change is the specialist's job's, never the worker's
    byBranch.set(j.branch, (j.parentJob ? jobs.find((x) => x.id === j.parentJob) : undefined) ?? j)
  }
  return byBranch
}

/** What the rule reads of a pull request: its head branch and where it lives, and who opened it. */
export interface PullFacts { head: string; headRepo?: string | null | undefined; author?: string | null | undefined }

/** The job that made `pull`, when it is one of trace's changes by every part of the rule; else null. */
export function traceJob(pull: PullFacts, byBranch: ReadonlyMap<string, JobRow>, rule: TraceRule): JobRow | null {
  // a fork's branch is not trace's whatever its name; an unknown head repository (a deleted fork) neither
  if (!pull.headRepo || pull.headRepo.toLowerCase() !== rule.repo.toLowerCase()) return null
  if (!ownBranch(pull.head, rule)) return null
  if (rule.agentLogin && (pull.author ?? '').toLowerCase() !== rule.agentLogin.toLowerCase()) return null
  return byBranch.get(pull.head) ?? null
}

/** The pull requests trace's jobs opened, each with its job, oldest first (by when it was opened, else its number). */
export function traceChanges<P extends Pick<PullSummary, 'number' | 'head' | 'headRepo' | 'author'> & { created_at?: string | undefined }>(pulls: readonly P[], jobs: readonly JobRow[], rule: TraceRule): { pull: P; job: JobRow }[] {
  const byBranch = jobsByBranch(jobs, rule)
  return pulls.flatMap((pull) => { const job = traceJob(pull, byBranch, rule); return job ? [{ pull, job }] : [] })
    .sort((a, b) => (a.pull.created_at ?? '').localeCompare(b.pull.created_at ?? '') || a.pull.number - b.pull.number)
}

// ------------------------------------------------------------------ which pull requests are a person's app edits

/**
 * The edit `pull` is, or null (docs/stay-in-trace.md "Which pull requests are edits"): its head branch lives in the
 * project's repository (not a fork), an edit is recorded for that branch, and its head commit is the recorded one.
 * Anyone who can push may push to a trace/… branch, and a pushed commit makes it no longer the edit trace made. The
 * branch prefix and the author are not checked: the commit is.
 */
export function editOf(pull: Pick<PullFacts, 'head' | 'headRepo'> & { sha?: string | undefined }, edits: ReadonlyMap<string, AppEdit>, repo: string): AppEdit | null {
  if (!pull.headRepo || pull.headRepo.toLowerCase() !== repo.toLowerCase()) return null
  const e = edits.get(pull.head)
  if (!e || !pull.sha || e.commit !== pull.sha) return null
  return e
}

/** Each recorded edit by its branch. */
export const editsByBranch = (edits: readonly AppEdit[]): Map<string, AppEdit> => new Map(edits.map((e) => [e.branch, e]))

/** Who made an edit, in the app's words: "a setting change by Alex L.", "a hand-in by you". */
export const editFrom = (e: Pick<AppEdit, 'kind' | 'by_name'>, mine: boolean): string => `${EDIT_WORDS[e.kind]} by ${mine ? 'you' : e.by_name}`

/**
 * Whether an edit may be applied with no checks at all: a repository joining trace (or its workflows refreshed) has no
 * build of trace's yet, and its content is trace's own scaffold, fixed by the recorded commit.
 */
export const mayApplyUnchecked = (kind: ChangeKind): boolean => kind === 'join' || kind === 'workflows'

/**
 * The facts of an edit, read as a change's: a join or workflows edit with no checks that GitHub says can merge counts as
 * checked (mayApplyUnchecked), so it is not held for checks that will never run.
 */
export function editFacts(f: ChangeFacts, kind: ChangeKind): ChangeFacts {
  if (!mayApplyUnchecked(kind) || f.state !== 'open') return f
  const none = f.checks === null || f.checks.total === 0
  if (!none || !CAN_MERGE.has(f.mergeable)) return f
  return { ...f, checks: { total: 1, passed: 1, failed: 0, running: 0, skipped: 0, failing: [] }, checks_denied: false }
}

/** An edit's verdict: an auto edit that is ready is "applying" (trace merges it); otherwise as any change. */
export function editVerdict(f: ChangeFacts, e: Pick<AppEdit, 'kind' | 'applies'>): Verdict {
  const v = verdictOf(editFacts(f, e.kind))
  return v === 'ready' && e.applies === 'auto' ? 'applying' : v
}

/** What trace recommends for an edit: an auto one needs nothing from anyone; a review one, as a change's. */
export function editRecommendation(f: ChangeFacts, e: Pick<AppEdit, 'kind' | 'applies' | 'by_name'>, mine: boolean): Recommendation {
  const g = editFacts(f, e.kind)
  const r = recommendationOf(g)
  if (e.applies === 'auto' && g.state === 'open') {
    if (r.verdict === 'accept') return { verdict: 'none', why: 'Its checks passed: trace applies it now.' }
    if (r.verdict === 'wait') return { verdict: 'wait', why: `${r.why} trace applies it once they pass, with nothing for anyone to do.` }
    if (r.verdict === 'ask') return { verdict: 'none', why: `${r.why.replace(/ Ask trace to fix (it|them) before accepting\.$/, '')} trace does not apply it while that is so: discard it, or make the change again.` }
    return r
  }
  if (r.verdict === 'accept') return { verdict: 'accept', why: `${r.why} ${mine ? 'You made it, so another admin accepts it.' : `${e.by_name} made it in trace; accepting applies it.`}` }
  if (r.verdict === 'ask') return { verdict: 'none', why: `${r.why.replace(/ Ask trace to fix (it|them) before accepting\.$/, '')} Ask ${mine ? 'trace' : e.by_name} to make it again, or discard it.` }
  return r
}

/**
 * Whether this person may accept an edit now, and if not why: only a review edit is ever accepted, by an admin who did
 * not make it (decision A); then the change's own rules (acceptance).
 */
export function editAcceptance(f: ChangeFacts, e: Pick<AppEdit, 'kind' | 'applies' | 'by_name'>, viewer: { admin: boolean; mine: boolean }): { may_accept: boolean; blockers: string[] } {
  const base = acceptance(editFacts(f, e.kind), true)
  const out = [...base.blockers]
  if (e.applies === 'auto') out.unshift('trace applies it once its checks pass: nobody needs to accept it.')
  else if (viewer.mine) out.unshift('You made this change: another admin accepts it.')
  else if (!viewer.admin) out.unshift('Only an admin can accept a change someone made in the app.')
  return { may_accept: out.length === 0, blockers: out }
}

/**
 * The specialist a change is credited to: the one its task was started with (the `agent` of its recorded request, what
 * the person confirmed), else the one its row names. The row's agent is where the job was routed (the index takes it
 * from the job's `routed` event), which the router may move from a person's pick (src/agents/router.ts misPicked), so
 * it is not who the task was asked of. A delegated worker's commits are its specialist's already (jobsByBranch).
 */
export function creditedAgent(job: Pick<JobRow, 'agent' | 'payload'> | null): string | null {
  if (!job) return null
  try {
    const a = job.payload ? (JSON.parse(job.payload) as { agent?: unknown }).agent : undefined
    if (typeof a === 'string' && (SPECIALIST_KINDS as readonly string[]).includes(a)) return a
  } catch { /* an unreadable request says nothing: the row's agent stands */ }
  return job.agent
}

/**
 * Who made it, in words: "the Verification specialist" (creditedAgent), else "a trace job". When the job ran as
 * another specialist (the router moved the pick), it says so rather than hide it: "the Verification specialist (routed
 * to the Implementation specialist)".
 */
export function fromWords(job: Pick<JobRow, 'agent' | 'payload'> | null, agentWords: Readonly<Record<string, string>>): string {
  const a = creditedAgent(job)
  if (!a || !(SPECIALIST_KINDS as readonly string[]).includes(a)) return 'a trace job'
  const ran = job?.agent
  const routed = ran && ran !== a && (SPECIALIST_KINDS as readonly string[]).includes(ran) ? ` (routed to the ${agentWords[ran] ?? ran} specialist)` : ''
  return `the ${agentWords[a] ?? a} specialist${routed}`
}

// ------------------------------------------------------------------ verdict, recommendation, may_accept

const CAN_MERGE = new Set(['clean', 'has_hooks'])

/** One word for the list's pill. */
export function verdictOf(f: ChangeFacts): Verdict {
  const v = verdictOfOwn(f)
  // a stacked change waits for the one it builds on: "ready" only once it targets the design (docs/stacked-changes.md)
  return v === 'ready' && f.stacked ? 'blocked' : v
}

function verdictOfOwn(f: ChangeFacts): Verdict {
  if (f.state !== 'open' || f.draft) return 'blocked'
  if (f.mergeable === 'dirty') return 'conflict'
  if ((f.checks?.failed ?? 0) > 0 || f.mergeable === 'unstable') return 'failing'
  // the specialist says it is not finished: that, not the checks, is what a person should hear first
  if (f.unfinished) return 'unfinished'
  if ((f.checks?.running ?? 0) > 0 || f.mergeable === 'unknown') return 'checking'
  if (f.mergeable === 'behind' || f.mergeable === 'blocked') return 'blocked'
  // never "ready" on checks trace could not read, or before any ran: accepting refuses both (acceptance). A token
  // that may not read checks will not fix itself by waiting: blocked, not checking
  if (f.checks === null && f.checks_denied) return 'blocked'
  if (f.checks === null || f.checks.total === 0) return 'checking'
  return 'ready'
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const list = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

/**
 * What trace recommends, and why, from the facts only. `passed`: the names of the checks that passed, when known (the
 * review page has them; a list only has counts). `requirements`: the ids the change names.
 */
export function recommendationOf(f: ChangeFacts, o: { passed?: readonly string[]; requirements?: readonly string[]; from?: string } = {}): Recommendation {
  if (f.state === 'merged') return { verdict: 'none', why: 'It is already accepted into the design.' }
  if (f.state === 'closed') return { verdict: 'none', why: 'It was discarded.' }
  if (f.draft) return { verdict: 'wait', why: 'It is a draft: trace has not finished it yet.' }
  // passing checks say the files are sound, not that the work is done: the specialist's own word comes first
  if (f.unfinished) {
    const who = o.from ? `${o.from[0]?.toUpperCase() ?? ''}${o.from.slice(1)}` : 'The specialist'
    // it waits on a person's approval, not on more work: say what to approve, not "ask for changes"
    if (f.awaiting?.length) return { verdict: 'wait', why: `${who} says this waits for ${list(f.awaiting)} to be approved: "${f.unfinished}". Once ${f.awaiting.length === 1 ? 'it is' : 'they are'} approved, trace looks at it again.` }
    return { verdict: 'ask', why: `${who} says this work is not finished: "${f.unfinished}". Ask for changes so it finishes before you accept it, or discard it.` }
  }
  if (f.mergeable === 'dirty') return { verdict: 'none', why: 'It conflicts with changes accepted since it was made. trace will bring it up to date.' }
  const failing = f.checks?.failing ?? []
  if ((f.checks?.failed ?? 0) > 0 || f.mergeable === 'unstable') {
    const named = failing.length ? `The ${list(failing.slice(0, 3))} ${failing.length === 1 ? 'check' : 'checks'} failed${failing.length > 3 ? `, with ${plural(failing.length - 3, 'more')}` : ''}` : 'A check failed'
    return { verdict: 'ask', why: `${named}. Ask trace to fix ${failing.length > 1 ? 'them' : 'it'} before accepting.` }
  }
  if ((f.checks?.running ?? 0) > 0) return { verdict: 'wait', why: `${plural(f.checks?.running ?? 0, 'check is', 'checks are')} still running. Wait for ${f.checks?.running === 1 ? 'it' : 'them'} to finish.` }
  if (f.mergeable === 'unknown') return { verdict: 'wait', why: 'GitHub is still working out whether it can be merged. Look again in a minute.' }
  if (f.mergeable === 'behind') return { verdict: 'none', why: 'It is behind changes accepted since it was made. trace will bring it up to date.' }
  // its checks are done, yet GitHub says the repository's rules stop it: almost always a required approving review,
  // which trace cannot give (GitHub refuses an approval from the account that opened it)
  if (f.mergeable === 'blocked') return { verdict: 'none', why: 'Its checks passed, but this repository asks for a review trace cannot give. An admin can fix the rule from this page, then accept it.' }
  if (f.checks === null) return f.checks_denied ? { verdict: 'none', why: CHECKS_DENIED } : { verdict: 'wait', why: 'trace could not read its checks. Look again in a minute.' }
  if (f.checks.total === 0) return { verdict: 'wait', why: 'No checks have run on it yet. Wait for them to run.' }
  if (f.stacked) return { verdict: 'wait', why: `${stackedWords(f.stacked)} Its checks passed: it follows that change into the design once it is accepted.` }
  const reqs = o.requirements?.length ? ` It covers ${list([...o.requirements].slice(0, 8))}${o.requirements.length > 8 ? ` and ${plural(o.requirements.length - 8, 'more requirement')}` : ''}.` : ''
  const total = f.checks.passed
  const checks = o.passed?.length ? `${total === 1 ? 'Its check' : `All ${total} checks`} passed (${list(o.passed.slice(0, 5))}${o.passed.length > 5 ? ' and others' : ''}), and it can be merged.`
    : `${total === 1 ? 'Its check' : `All ${total} checks`} passed, and it can be merged.`
  const waited = f.awaiting?.length ? ` It waited for ${list(f.awaiting)} to be approved, and ${f.awaiting.length === 1 ? 'it is' : 'they are'} now.` : ''
  return { verdict: 'accept', why: `${checks[0]?.toUpperCase() ?? ''}${checks.slice(1)}${waited}${reqs}` }
}

/**
 * Whether this person may accept it now, and if not, why (each reason in plain words). `write`: they have the
 * Contributor part on the project (or are an admin). GitHub's own rules (a required review) are not judged here:
 * accepting tries, and says so in plain words when GitHub refuses (src/api/actions-changes.ts). Checks trace could not
 * read, or none run at all, are refused too: "can be merged" from GitHub then says nothing about whether the work was
 * checked (a repository without a required check merges anything), and a person accepting would be trusting nothing.
 */
export function acceptance(f: ChangeFacts, write: boolean): { may_accept: boolean; blockers: string[] } {
  const out: string[] = []
  if (!write) out.push('Only a contributor on this project can accept a change.')
  if (f.state === 'merged') out.push('It is already accepted into the design.')
  else if (f.state === 'closed') out.push('It was discarded.')
  else {
    if (f.draft) out.push('It is a draft: trace has not finished it yet.')
    if (f.mergeable === 'dirty') out.push('It conflicts with changes accepted since it was made. trace will bring it up to date.')
    if (f.mergeable === 'behind') out.push('It is behind changes accepted since it was made. trace will bring it up to date.')
    const failing = f.checks?.failing ?? []
    if ((f.checks?.failed ?? 0) > 0) out.push(failing.length ? `The ${list(failing.slice(0, 3))} ${failing.length === 1 ? 'check' : 'checks'} failed.` : 'A check failed.')
    else if (f.mergeable === 'unstable') out.push('A check failed.')
    if ((f.checks?.running ?? 0) > 0) out.push(`${plural(f.checks?.running ?? 0, 'check is', 'checks are')} still running.`)
    else if (f.mergeable === 'unknown') out.push('GitHub is still working out whether it can be merged.')
    if (f.checks === null) out.push(f.checks_denied ? CHECKS_DENIED : 'trace could not read its checks.')
    else if (f.checks.total === 0) out.push('No checks have run on it yet.')
    // accepting would merge it into the change below, not into the design
    if (f.stacked) out.push(stackedWords(f.stacked))
  }
  return { may_accept: out.length === 0, blockers: out }
}

/** Why a stacked change waits, in plain words. */
export function stackedWords(s: NonNullable<ChangeFacts['stacked']>): string {
  return s.on
    ? `It builds on "${s.on.title}" (change ${s.on.number}), which is not accepted yet. Accept that one first.`
    : `It is built on ${s.base}, not on the design itself, so it cannot be accepted yet. If the change it builds on was just accepted, trace moves this one onto the design in a few minutes; if that change was discarded, discard this one too.`
}

/**
 * The stacks among a repository's open pull requests (docs/stacked-changes.md): for each pull request that targets
 * another open one's branch, the one it builds on, and for each, the ones built on it. Only pull requests whose head is
 * in the repository itself count, so a fork's branch never stands for a trace change.
 */
export function stacksOf(pulls: readonly Pick<PullSummary, 'number' | 'title' | 'head' | 'base' | 'headRepo'>[], repo: string, defaultBranch: string): Map<number, { stacked?: { base: string; on: StackLink | null }; built_on_by: StackLink[] }> {
  // a head repository GitHub no longer knows (null: a deleted fork) is not the repository's own
  const own = pulls.filter((p) => p.headRepo?.toLowerCase() === repo.toLowerCase())
  const byHead = new Map(own.map((p) => [p.head, p]))
  const out = new Map<number, { stacked?: { base: string; on: StackLink | null }; built_on_by: StackLink[] }>()
  const at = (n: number) => { let e = out.get(n); if (!e) { e = { built_on_by: [] }; out.set(n, e) } return e }
  for (const p of own) {
    if (!p.base || !defaultBranch || p.base === defaultBranch) continue
    const below = byHead.get(p.base)
    at(p.number).stacked = { base: p.base, on: below ? { number: below.number, title: below.title } : null }
    if (below) at(below.number).built_on_by.push({ number: p.number, title: p.title })
  }
  return out
}

/** A check run's state in the review page's four words. */
export function checkState(c: { status: string; conclusion: string | null }): CheckLine['state'] {
  if (c.status !== 'completed') return 'running'
  if (c.conclusion === 'success') return 'passed'
  if (c.conclusion === 'skipped' || c.conclusion === 'neutral') return 'skipped'
  return 'failed'
}

// ------------------------------------------------------------------ what it says

/**
 * The requirement ids a change names, in order: R4, R7, and ranges (R1-R10, R1–R3) spelled out when they are short
 * enough to be a range of requirements (at most 50). Case matters: "r4" is not an id.
 */
export function requirementIds(...texts: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (n: number): void => { const id = `R${n}`; if (!seen.has(id)) { seen.add(id); out.push(id) } }
  for (const t of texts) {
    for (const m of t.matchAll(/\bR(\d{1,4})(?:\s*(?:-|–|to)\s*R?(\d{1,4}))?\b/g)) {
      const a = Number(m[1])
      const b = m[2] === undefined ? a : Number(m[2])
      if (b > a && b - a <= 50) for (let n = a; n <= b; n++) add(n)
      else add(a)
    }
  }
  return out
}

/** Every criterion id any template has, for finding the ones a job's request names. */
const CRITERION_IDS: ReadonlySet<string> = new Set(TEMPLATES.flatMap((t) => templateStages(t, LATER_STAGES).flatMap((s) => s.gates.flatMap((g) => g.criteria.map((c) => c.id)))))

/** The gate criteria a job's words name ("record capture.erc with journey.check"): what its change would satisfy. */
export function criteriaNamed(...texts: readonly string[]): string[] {
  const out = new Set<string>()
  for (const t of texts) for (const m of t.matchAll(/\b[a-z]+(?:\.[a-z]+){1,2}\b/g)) if (CRITERION_IDS.has(m[0])) out.add(m[0])
  return [...out]
}

/** The stage a change belongs to: the stage of the first criterion its job names, else null. */
export function stageNamed(criteria: readonly string[]): StageId | null {
  const s = criteria[0]?.split('.')[0]
  return (STAGE_IDS as readonly string[]).includes(s ?? '') ? s as StageId : null
}

/** A job row's request (its recorded payload), or ''. */
export function jobRequest(job: Pick<JobRow, 'payload'> | null): string {
  if (!job?.payload) return ''
  try {
    const p = JSON.parse(job.payload) as { request?: unknown }
    return typeof p.request === 'string' ? p.request : ''
  } catch {
    return ''
  }
}

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/

/** The first list in a text (Markdown bullets or numbers), each item as one line. */
export function firstList(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => BULLET.test(l))
  if (start < 0) return []
  const out: string[] = []
  for (const l of lines.slice(start)) {
    const m = BULLET.exec(l)
    if (!m) break
    out.push(m[1] as string)
  }
  return out
}

/**
 * What trace did, as plain bullets (at most 12): the job's result summary (its list, else its lines), else the pull
 * request body's first list (trace's own pull requests list their commits: their short ids are dropped), else the
 * commit subjects.
 */
export function summaryBullets(o: { jobSummary: string | null; body: string; commits: readonly string[] }): string[] {
  const clean = (xs: readonly string[]): string[] => xs.map((x) => x.replace(/^[0-9a-f]{7,40}\s+/, '').replace(/<!--[\s\S]*?-->/g, '').trim()).filter(Boolean).slice(0, 12)
  const job = o.jobSummary?.trim() ?? ''
  if (job) {
    const l = firstList(job)
    return clean(l.length ? l : job.split(/\r?\n/).map((x) => x.replace(/^#+\s*/, '')).filter((x) => x.trim()))
  }
  const fromBody = clean(firstList(o.body))
  if (fromBody.length) return fromBody
  return clean(o.commits.map((m) => m.split('\n')[0] ?? ''))
}

/** What kind of file it is, for the review page's viewer: KiCad's schematic and board files open in the viewer. */
export function fileKind(path: string, patch: string | null): FileKind {
  const p = path.toLowerCase()
  const ext = p.slice(p.lastIndexOf('.') + 1)
  if (ext === 'kicad_sch') return 'schematic'
  if (ext === 'kicad_pcb') return 'board'
  if (ext === 'kicad_sym' || ext === 'kicad_mod' || /(^|\/)(bom|parts)[^/]*\.(csv|tsv|json|xlsx?)$/.test(p)) return 'parts'
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'image'
  if (patch !== null) return 'text'
  return ['md', 'txt', 'json', 'yaml', 'yml', 'toml', 'csv', 'ts', 'js', 'py', 'c', 'h', 'rs', 'v', 'sv', 'vhd', 'kicad_pro'].includes(ext) ? 'text' : 'binary'
}

// ------------------------------------------------------------------ the summary

/** One edit's summary from its pull request (with or without its status) and its record. */
export function editSummary(o: {
  pull: Pick<PullSummary, 'number' | 'title' | 'url' | 'draft' | 'labels' | 'updated_at'> & { created_at?: string | undefined }
  edit: AppEdit; status: Pick<PullStatus, 'state' | 'mergeable' | 'checks' | 'checks_denied' | 'draft' | 'updated_at'> | null
  hold: string; viewerSub: string
}): ChangeSummary {
  const s = o.status
  const facts: ChangeFacts = { state: s?.state ?? 'open', draft: s?.draft ?? o.pull.draft, mergeable: s?.mergeable ?? 'unknown', checks: s?.checks ?? null, ...(s?.checks_denied ? { checks_denied: true } : {}) }
  const mine = o.edit.by_sub === o.viewerSub
  return {
    number: o.pull.number, title: o.edit.title, url: o.pull.url, draft: facts.draft, held: o.pull.labels.includes(o.hold), kind: o.edit.kind,
    by_name: o.edit.by_name, mine, applies: o.edit.applies,
    from: editFrom(o.edit, mine), job_id: null, stage: null,
    opened_at: o.pull.created_at ?? o.edit.at, updated_at: s?.updated_at ?? o.pull.updated_at,
    state: facts.state, mergeable: facts.mergeable, checks: facts.checks, ...(facts.checks_denied ? { checks_denied: true } : {}),
    verdict: editVerdict(facts, o.edit),
  }
}

/** One change's summary from its pull request (with or without its status) and its job. */
export function changeSummary(o: {
  repo: string; pull: Pick<PullSummary, 'number' | 'title' | 'url' | 'draft' | 'labels' | 'updated_at'> & { created_at?: string | undefined }
  job: JobRow | null; status: Pick<PullStatus, 'state' | 'mergeable' | 'checks' | 'checks_denied' | 'draft' | 'updated_at'> | null
  hold: string; agentWords: Readonly<Record<string, string>>
  /** the gate criteria a person has approved (approvalsGiven): settles a change that waited on one */
  given?: ReadonlySet<string> | undefined
  /** where it sits in a stack (stacksOf) */
  stack?: { stacked?: { base: string; on: StackLink | null }; built_on_by: StackLink[] } | undefined
}): ChangeSummary {
  const s = o.status
  const facts: ChangeFacts = { state: s?.state ?? 'open', draft: s?.draft ?? o.pull.draft, mergeable: s?.mergeable ?? 'unknown', checks: s?.checks ?? null, ...(s?.checks_denied ? { checks_denied: true } : {}) }
  if (o.stack?.stacked) facts.stacked = o.stack.stacked
  const unfinished = unfinishedWords({ title: o.pull.title, summary: o.job?.summary, request: jobRequest(o.job) })
  if (unfinished) facts.unfinished = unfinished
  settleUnfinished(facts, { title: o.pull.title, summary: o.job?.summary }, o.given ?? new Set())
  const crit = criteriaNamed(jobRequest(o.job), o.job?.title ?? '')
  return {
    number: o.pull.number, title: o.pull.title, url: o.pull.url, draft: facts.draft, held: o.pull.labels.includes(o.hold), kind: 'work',
    from: fromWords(o.job, o.agentWords), job_id: o.job ? indexedHandle(o.repo, o.job.session, o.job.id) : null, stage: stageNamed(crit),
    opened_at: o.pull.created_at ?? o.pull.updated_at, updated_at: s?.updated_at ?? o.pull.updated_at,
    state: facts.state, mergeable: facts.mergeable, checks: facts.checks, ...(facts.checks_denied ? { checks_denied: true } : {}), verdict: verdictOf(facts),
    ...(facts.awaiting ? { awaiting: facts.awaiting } : {}),
    ...(o.stack?.stacked?.on ? { builds_on: o.stack.stacked.on } : {}),
    ...(o.stack?.built_on_by.length ? { built_on_by: o.stack.built_on_by } : {}),
  }
}

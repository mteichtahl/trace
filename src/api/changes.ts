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
import { plumbingTitle } from '../core/change-contents.js'
import { plainLine } from '../core/plain-words.js'
import type { JobRow } from '../core/job-index.js'
import { indexedHandle, isLive } from '../core/job-index.js'
import { type JourneyRecord, LATER_STAGES, STAGE_IDS, type StageId, TEMPLATES, templateStages } from '../core/journey.js'
import type { CheckRunDetail, PullFile, PullStatus, PullSummary } from './github.js'
import type { RequirementEditsView } from './requirement-edits.js'
import type { PendingAnswer } from '../core/answer-followups.js'
import { type StuckChecks, stuckWords } from './stuck-checks.js'

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
  /** the answers to its specialist's questions trace has not applied to it yet (ChangeFacts.answers) */
  answers?: PendingAnswer[]
  /** a stacked change (docs/stacked-changes.md): the open change it builds on, which is accepted first */
  builds_on?: StackLink
  /** the open changes stacked on this one, which follow it into the design */
  built_on_by?: StackLink[]
  /** the job behind it is still working (ChangeFacts.working): what is reviewed may still change */
  working?: boolean
  /** its checks cannot start: no runner picks them up (ChangeFacts.stuck, src/api/stuck-checks.ts) */
  stuck?: StuckChecks
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
  /** the agents' own reports, as they wrote them (agentReport), behind More; absent: none */
  report?: string
  files: { path: string; status: PullFile['status']; additions: number; deletions: number; kind: FileKind }[]
  checks_list: CheckLine[]
  /** the project's requirements it names (requirementsNamed) */
  requirements: string[]
  /** what it cites as a requirement that the project has none of ("R3"); absent: none */
  requirements_unknown?: string[]
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
  /** the accepted requirements its database edits, said before it is accepted (src/api/requirement-edits.ts) */
  requirement_edits?: RequirementEditsView
  /**
   * The hand-off its job answered (askedFor): the specialist that asked, and what it asked, so a person sees why a
   * specialist they did not start made it (test-esp32 #141, #234). Absent: a person or a stage started its job.
   */
  handoff?: AskedFor
  /**
   * Every check that failed, failed for a reason outside the work (GitHub busy or down, the runner lost: infraReason):
   * which ones, by checks_list id, and why in plain words. The page offers to run them again (change.rerun). Absent:
   * no check failed, or one failed on the work itself.
   */
  infra_failed?: InfraFailure
  /**
   * A discarded change: who discarded it, when, their reason and what happened to the jobs that were working on its
   * branch (stopped, or told apart: change.discard). Absent: not discarded, or discarded before this was kept.
   */
  discarded?: DiscardView
}

/** Who discarded a change, when, why, and the jobs on its branch it stopped (ChangeDetail.discarded). */
export interface DiscardView { by: string; at: string; reason: string; jobs: string[] }

/** Checks that failed for a reason outside the work (ChangeDetail.infra_failed). */
export interface InfraFailure { checks: { id: string; name: string }[]; why: string }

/**
 * Why a check's failure says nothing about the work, from its annotations or the end of its log: null when nothing
 * there names a cause outside it. Only what GitHub and its runners say in their own words counts, so a check that
 * failed on the design is never taken for one that did not run properly. In test-esp32 run 2 (#126, #128) both of
 * trace-prs's jobs died on "API rate limit exceeded for user ID …", and the page said to send a sound layout back.
 */
export function infraReason(text: string | null | undefined): string | null {
  const t = text ?? ''
  if (/API rate limit exceeded|secondary rate limit|abuse detection mechanism/i.test(t)) return 'GitHub was busy (it limited how many requests trace could make)'
  if (/runner has received a shutdown signal|lost communication with the server|hosted runner encountered an error|job was not acquired by Runner/i.test(t)) return 'the machine running it stopped partway'
  if (/(?:HttpError|RequestError)\b[^\n]{0,120}\b(?:Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|50[0234])\b|GitHub is (?:down|having|experiencing)|Unicorn!/i.test(t)) return 'GitHub had a problem'
  return null
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
  /**
   * The job behind it is still working (jobWorking): queued, or running and alive. It may push more commits, open
   * another change or take on more work, so nothing about it is settled yet (log #68, #77).
   */
  working?: boolean
  /**
   * The answers a person gave to its specialist's questions that no job has applied to it yet (src/core/answer-
   * followups.ts pendingAnswers): accepted now, the change would go in without them (test-esp32 log #131).
   */
  answers?: PendingAnswer[]
  /** every check that failed, failed for a reason outside the work (infraReason): it is run again, not sent back */
  infra?: InfraFailure
  /**
   * Its checks cannot start: its workflow runs have been queued for a long while and no runner picks them up
   * (src/api/stuck-checks.ts, test-esp32 log #146). Waiting fixes nothing: an admin fixes the runner, then they run again.
   */
  stuck?: StuckChecks
}

/**
 * Whether a change's job is still working on it: queued (to start, or to carry on after "ask for changes"), or running
 * with a recent heartbeat. A paused job (a person stopped it) or a lost one (its heartbeat stopped) is not.
 */
export const jobWorking = (job: Pick<JobRow, 'state' | 'beatAt' | 'startedAt' | 'updatedAt'> | null | undefined, at = Date.now() / 1000): boolean =>
  Boolean(job) && (job?.state === 'queued' || isLive(job as JobRow, at))

/** What a change whose job is still working says, wherever it is shown. */
export const STILL_WORKING = 'trace is still working on this change.'

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

/** Who asked for a change's work, and what, when a specialist asked another (a hand-off). */
export interface AskedFor { by: string; question: string; blocks?: string }

const HANDOFF_BRANCH = /(?:^|\/)handoff-(ho[0-9a-f]{14})$/
const ASKED_TITLE = /^Asked by (the .+? specialist): (.+)$/s

/** The hand-off a change's work answered, by its id: the job's, else its branch's ("claude/handoff-<id>"). */
export const handoffIdOf = (job: Pick<JobRow, 'handoff'> | null, branch: string): string | null => job?.handoff ?? HANDOFF_BRANCH.exec(branch)?.[1] ?? null

/**
 * The hand-off a change's work answered (src/core/handoffs.ts): its id from the job, else from the branch a hand-off's
 * job works on ("claude/handoff-<id>"); what was asked from the agents' facts when they were read, else from the job's
 * title ("Asked by the Implementation specialist: …", cut at 200 characters). Null: no hand-off made it. Pure.
 */
export function askedFor(o: {
  job: Pick<JobRow, 'handoff' | 'title'> | null; branch: string
  rows?: readonly Pick<JobRow, 'handoff' | 'title'>[]
  handoffs?: readonly { id: string; fromAgent: string; question: string; blocks?: string | null }[] | null
  agentWords: Readonly<Record<string, string>>
}): AskedFor | null {
  const id = handoffIdOf(o.job, o.branch)
  if (!id) return null
  const flat = (x: string): string => x.replace(/\s+/g, ' ').trim()
  const h = o.handoffs?.find((x) => x.id === id)
  if (h && flat(h.question)) {
    const blocks = flat(h.blocks ?? '')
    return { by: `the ${o.agentWords[h.fromAgent] ?? h.fromAgent} specialist`, question: flat(h.question), ...(blocks ? { blocks } : {}) }
  }
  const row = o.job?.handoff === id ? o.job : o.rows?.find((r) => r.handoff === id) ?? null
  const m = row ? ASKED_TITLE.exec(row.title) : null
  return m ? { by: m[1]!, question: flat(m[2]!) } : null
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
  // its job is still at it: checks that passed say nothing yet about what it will push next (log #68)
  if (f.working) return 'checking'
  if (f.mergeable === 'dirty') return 'conflict'
  // a check that did not run properly says nothing about the work: it waits to be run again, it is not failing
  if (infraOnly(f)) return 'blocked'
  if ((f.checks?.failed ?? 0) > 0 || f.mergeable === 'unstable') return 'failing'
  // checks no runner picks up: they are not running, and waiting will not finish them (test-esp32 log #146)
  if (f.stuck) return 'blocked'
  // the specialist says it is not finished, or an answer is still to be applied to it: that, not the checks, is what a
  // person should hear first
  if (f.unfinished || f.answers?.length) return 'unfinished'
  if ((f.checks?.running ?? 0) > 0 || f.mergeable === 'unknown') return 'checking'
  // "blocked" before any check reported is GitHub waiting for the required ones (a change just brought up to date):
  // checking, as below, not stopped by a rule (test-esp32 #76)
  if (f.mergeable === 'behind' || (f.mergeable === 'blocked' && (f.checks?.total ?? 0) > 0)) return 'blocked'
  // never "ready" on checks trace could not read, or before any ran: accepting refuses both (acceptance). A token
  // that may not read checks will not fix itself by waiting: blocked, not checking
  if (f.checks === null && f.checks_denied) return 'blocked'
  if (f.checks === null || f.checks.total === 0) return 'checking'
  return 'ready'
}

/** Whether every check that failed, failed for a reason outside the work (and at least one did). */
const infraOnly = (f: ChangeFacts): boolean => !!f.infra?.checks.length && (f.checks?.failed ?? 0) > 0

/** "the open-pr and automerge checks": which checks did not run properly. */
const infraNamed = (i: InfraFailure): string => `the ${list(i.checks.slice(0, 3).map((c) => c.name))} ${i.checks.length === 1 ? 'check' : 'checks'}${i.checks.length > 3 ? ` and ${i.checks.length - 3} more` : ''}`

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const list = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

/**
 * What trace recommends, and why, from the facts only. `passed`: the names of the checks that passed, when known (the
 * review page has them; a list only has counts). `requirements`: the ids the change names.
 */
export function recommendationOf(f: ChangeFacts, o: { passed?: readonly string[]; requirements?: readonly string[]; from?: string; at?: number } = {}): Recommendation {
  if (f.state === 'merged') return { verdict: 'none', why: 'It is already accepted into the design.' }
  if (f.state === 'closed') return { verdict: 'none', why: 'It was discarded.' }
  if (f.draft) return { verdict: 'wait', why: 'It is a draft: trace has not finished it yet.' }
  // never "accept" while its job runs: it may still push to it, and what is accepted would not be what was reviewed
  // the app heads the box with STILL_WORKING (web/src/lib/guided.ts recommendationWords): the reason does not repeat it
  if (f.working) return { verdict: 'wait', why: 'Its job has not finished, so what you see may still change. Wait for it to finish before you accept it.' }
  // an answer not applied yet: accepted now, the change goes in without it (test-esp32 log #131)
  if (f.answers?.length) return answersWait(f.answers)
  // passing checks say the files are sound, not that the work is done: the specialist's own word comes first
  if (f.unfinished) {
    const who = o.from ? `${o.from[0]?.toUpperCase() ?? ''}${o.from.slice(1)}` : 'The specialist'
    // it waits on a person's approval, not on more work: say what to approve, not "ask for changes"
    if (f.awaiting?.length) return { verdict: 'wait', why: `${who} says this waits for ${list(f.awaiting)} to be approved: "${f.unfinished}". Once ${f.awaiting.length === 1 ? 'it is' : 'they are'} approved, trace looks at it again.` }
    return { verdict: 'ask', why: `${who} says this work is not finished: "${f.unfinished}". Ask for changes so it finishes before you accept it, or discard it.` }
  }
  if (f.mergeable === 'dirty') return { verdict: 'none', why: 'It conflicts with changes accepted since it was made. trace will bring it up to date.' }
  const failing = f.checks?.failing ?? []
  // GitHub was busy, or the runner was lost: the check did not run properly, which says nothing about the work. Run it
  // again; never "ask for changes", which would send sound work back to the specialist (test-esp32 run 2, #128)
  if (infraOnly(f) && f.infra) {
    const named = infraNamed(f.infra)
    const why = `${f.infra.why[0]?.toUpperCase() ?? ''}${f.infra.why.slice(1)}`
    return { verdict: 'wait', why: `${why}, so ${named} did not run properly. That says nothing about the work. Run ${f.infra.checks.length === 1 ? 'it' : 'them'} again; trace recommends once ${f.infra.checks.length === 1 ? 'it has' : 'they have'} run.` }
  }
  if ((f.checks?.failed ?? 0) > 0 || f.mergeable === 'unstable') {
    const named = failing.length ? `The ${list(failing.slice(0, 3))} ${failing.length === 1 ? 'check' : 'checks'} failed${failing.length > 3 ? `, with ${plural(failing.length - 3, 'more')}` : ''}` : 'A check failed'
    return { verdict: 'ask', why: `${named}. Ask trace to fix ${failing.length > 1 ? 'them' : 'it'} before accepting.` }
  }
  // never "still running" over checks that cannot start: say why, and who fixes it (test-esp32 log #146)
  if (f.stuck) return { verdict: 'wait', why: stuckWords(f.stuck, o.at ?? Date.now() / 1000) }
  if ((f.checks?.running ?? 0) > 0) return { verdict: 'wait', why: `${plural(f.checks?.running ?? 0, 'check is', 'checks are')} still running. Wait for ${f.checks?.running === 1 ? 'it' : 'them'} to finish.` }
  if (f.mergeable === 'unknown') return { verdict: 'wait', why: 'GitHub is still working out whether it can be merged. Look again in a minute.' }
  if (f.mergeable === 'behind') return { verdict: 'none', why: 'It is behind changes accepted since it was made. trace will bring it up to date.' }
  // its checks are done, yet GitHub says the repository's rules stop it: almost always a required approving review,
  // which trace cannot give (GitHub refuses an approval from the account that opened it). A change just brought up to
  // date is "blocked" too, until its required checks report: none have run, so it is not that (test-esp32 #76: the
  // page said "Its checks passed, but …" beside "No checks have run on it yet")
  if (f.mergeable === 'blocked' && (f.checks?.total ?? 0) > 0) return { verdict: 'none', why: 'Its checks passed, but this repository asks for a review trace cannot give. An admin can fix the rule from this page, then accept it.' }
  if (f.checks === null) return f.checks_denied ? { verdict: 'none', why: CHECKS_DENIED } : { verdict: 'wait', why: 'trace could not read its checks. Look again in a minute.' }
  if (f.checks.total === 0) return { verdict: 'wait', why: 'No checks have run on it yet. Wait for them to run.' }
  if (f.stacked) return { verdict: 'wait', why: `${stackedWords(f.stacked)} Its checks passed: it follows that change into the design once it is accepted.` }
  const reqs = o.requirements?.length ? ` It covers ${list([...o.requirements].slice(0, 8))}${o.requirements.length > 8 ? ` and ${plural(o.requirements.length - 8, 'more requirement')}` : ''}.` : ''
  // the count is of what is named: GitHub's status counts its checks one way and the check list names them another
  // ("All 2 checks passed (check, tests pass and open-pr)", test-esp32 log #153), so the larger of the two is said,
  // and "and others" whenever fewer are named than counted
  const names = [...new Set(o.passed ?? [])]
  const total = Math.max(f.checks.passed, names.length)
  const checks = names.length ? `${total === 1 ? 'Its check' : `All ${total} checks`} passed (${list(names.slice(0, 5))}${names.length > 5 || names.length < total ? ' and others' : ''}), and it can be merged.`
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
    if (f.working) out.push(`${STILL_WORKING} Wait for its job to finish.`)
    if (f.mergeable === 'dirty') out.push('It conflicts with changes accepted since it was made. trace will bring it up to date.')
    if (f.mergeable === 'behind') out.push('It is behind changes accepted since it was made. trace will bring it up to date.')
    const failing = f.checks?.failing ?? []
    if (infraOnly(f) && f.infra) out.push(`${infraNamed(f.infra).replace(/^t/, 'T')} did not run properly: ${f.infra.why}. Run ${f.infra.checks.length === 1 ? 'it' : 'them'} again.`)
    else if ((f.checks?.failed ?? 0) > 0) out.push(failing.length ? `The ${list(failing.slice(0, 3))} ${failing.length === 1 ? 'check' : 'checks'} failed.` : 'A check failed.')
    else if (f.mergeable === 'unstable') out.push('A check failed.')
    // the reason only: the recommendation beside it says what an admin does
    if (f.stuck) out.push(`Its checks cannot start: ${f.stuck.why}.`)
    else if ((f.checks?.running ?? 0) > 0) out.push(`${plural(f.checks?.running ?? 0, 'check is', 'checks are')} still running.`)
    else if (f.mergeable === 'unknown') out.push('GitHub is still working out whether it can be merged.')
    if (f.checks === null) out.push(f.checks_denied ? CHECKS_DENIED : 'trace could not read its checks.')
    else if (f.checks.total === 0) out.push('No checks have run on it yet.')
    // accepting would merge it into the change below, not into the design
    if (f.stacked) out.push(stackedWords(f.stacked))
  }
  return { may_accept: out.length === 0, blockers: out }
}

/** "your answer to "…"" for one or more pending answers. */
const answersWords = (xs: readonly PendingAnswer[]): string =>
  `your ${xs.length === 1 ? 'answer' : 'answers'} to ${list(xs.slice(0, 3).map((a) => `"${a.text.replace(/\s+/g, ' ').trim().slice(0, 120)}"`))}${xs.length > 3 ? ` and ${plural(xs.length - 3, 'more question')}` : ''}`

/**
 * What trace recommends for a change with answers still to apply: wait while trace applies them; ask for changes
 * (with the answer) when it will not on its own (a person cancelled the job, or it gave up). Never accept.
 */
export function answersWait(xs: readonly PendingAnswer[]): Recommendation {
  const stopped = xs.filter((a) => a.stopped)
  if (stopped.length) {
    return { verdict: 'ask', why: `trace has not applied ${answersWords(stopped)} to it: ${stopped[0]?.stopped ?? 'its job stopped'}. Ask for changes with the answer before you accept it, or discard it.` }
  }
  return { verdict: 'wait', why: `Waiting for trace to apply ${answersWords(xs)} to it. Accepted now, it would go into the design without ${xs.length === 1 ? 'that answer' : 'those answers'}.` }
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

/** "REQ-009" and "REQ-9" are one requirement (as the review page matches them: change-requirements.tsx). */
const reqKey = (id: string): string => id.trim().toUpperCase().replace(/-0+(\d)/g, '-$1')
/** A reference designator's shape (R3, U12, C5): a part on the board unless the line says it is a requirement. */
const DESIGNATOR = /^[A-Z]{1,3}\d{1,4}$/
/** A line that says it names requirements: "Requirements it covers: …", "covers R3". */
const SAYS_REQUIREMENT = /\brequirements?\b|\bcover(?:s|ed|ing)?\b/i
/** A word that may be an id: letters first, then letters, digits and hyphens (REQ-9b1b96, R3, TST-009). */
const TOKEN = /(?<![\w-])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*(?![\w-])/g
/** A short range of designator-shaped ids, "R1-R7", "R1–R3", "R2 to R5", spelled out (at most 50). */
const RANGE = /(?<![\w-])([A-Z]{1,3})(\d{1,4})\s*(?:-|–|to)\s*(?:\1)?(\d{1,4})(?![\w-])/g
/** A local name the text gives a real id: "R3 (REQ-9b1b96)", "R3 = REQ-9b1b96", "R3: REQ-9b1b96", "R3 → REQ-9b1b96". */
const ALIAS = /(?<![\w-])([A-Z]{1,3}\d{1,4})\s*(?:[:=(]|->|→)\s*([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)/g

const spelled = (line: string): string => line.replace(RANGE, (all, p: string, a: string, b: string) => {
  const x = Number(a)
  const y = Number(b)
  return y > x && y - x <= 50 ? Array.from({ length: y - x + 1 }, (_, i) => `${p}${x + i}`).join(' ') : `${p}${a} ${p}${b}`
})

/**
 * The requirements a change names (its title, description and commit messages), against the project's own ids
 * (`known`: every requirement in its record). `ids`: the project's ids it names, in order, each as the project writes
 * it ("REQ-9" finds REQ-009; a local name the text gives one, "R3 (REQ-9b1b96)", finds it too). `unknown`: what it
 * cites as a requirement that the project has no such requirement for: only a word in the project's own id form
 * (REQ-abc123 when its ids are REQ-…; R9, on a line that says it names requirements, when they are R1, R2). Elsewhere a
 * designator-shaped word (R3, R1-R7) is a part on the board, even on a line that says it names requirements: in test-esp32 the schematic change's net table ("EN = … R3") read as "covers R3", a
 * layout's "R1/R2 sit beside the CC pins" as "covers R1, R2" (log #47, #105), and a layout change's fit findings
 * "Q1/R4/R5" as naming the requirements R4 and R5 (log #152), in a project whose requirements are REQ-xxxxxx. Case
 * matters for the designator shape: "r4" is not one.
 */
export function requirementsNamed(known: Iterable<string>, ...texts: readonly string[]): { ids: string[]; unknown: string[] } {
  const byKey = new Map<string, string>()
  for (const id of known) byKey.set(reqKey(id), id)
  // the project's id forms: "REQ-" for REQ-9b1b96, REQ-PWR-001
  const prefixes = new Set([...byKey.values()].map((id) => /^([A-Za-z]+-)/.exec(id)?.[1]?.toUpperCase()).filter((p): p is string => Boolean(p)))
  // and its designator-shaped ones: "R" for R1, R2
  const letters = new Set([...byKey.values()].filter((id) => DESIGNATOR.test(id)).map((id) => /^[A-Z]+/.exec(id)![0]))
  const lines = texts.flatMap((t) => t.split(/\r?\n/))
  const alias = new Map<string, string>()
  for (const l of lines) for (const m of l.matchAll(ALIAS)) { const id = byKey.get(reqKey(m[2]!)); if (id) alias.set(m[1]!, id) }
  const ids: string[] = []
  const unknown: string[] = []
  const push = (xs: string[], x: string): void => { if (!xs.includes(x)) xs.push(x) }
  for (const line of lines) {
    const says = SAYS_REQUIREMENT.test(line)
    for (const [tok] of spelled(line).matchAll(TOKEN)) {
      const named = alias.get(tok)
      if (named) { push(ids, named); continue }
      const id = byKey.get(reqKey(tok))
      // a project whose ids look like designators (R1): read as one only where the line says so
      if (id && (!DESIGNATOR.test(id) || (says && tok === id))) { push(ids, id); continue }
      if (id) continue
      // only an id in the project's own form: "R4" near the word "requirements" was still a resistor in a project
      // whose ids are REQ-… (log #152). A project that numbers its requirements R1, R2 has that form, where a line
      // says it names requirements
      const ours = [...prefixes].some((p) => tok.toUpperCase().startsWith(p) && /\d/.test(tok.slice(p.length)))
      if (ours || (says && DESIGNATOR.test(tok) && letters.has(/^[A-Z]+/.exec(tok)![0]))) push(unknown, tok)
    }
  }
  return { ids, unknown }
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
 * A job's report without the runtime's header: a specialist's job ends "docs: done in 41 turns: <its report>", and with
 * no report (one posted on its work item instead, or none written) it is only "docs: done in 41 turns", which says
 * nothing of the work (test-esp32 #73). Empty then, so the change is said from its pull request instead.
 */
export function reportOf(summary: string | null | undefined): string {
  return (summary ?? '').trim().replace(/^[\w-]+: done in \d+ turns?(?: \(escalated\))?(?::\s*|\s*$)/, '').trim()
}

/**
 * What trace did, as plain bullets (at most 12): the job's result summary (its list, else its lines; reportOf), else the
 * pull request body's first list (trace's own pull requests list their commits: their short ids are dropped), else the
 * commit subjects.
 */
export function summaryBullets(o: { jobSummary: string | null; body: string; commits: readonly string[]; earlier?: readonly (string | null)[] }): string[] {
  // a record's or a merge commit's subject says nothing of the work: never a bullet (test-esp32 log #59, #154)
  const clean = (xs: readonly string[]): string[] => [...new Set(xs.map((x) => x.replace(/^[0-9a-f]{7,40}\s+/, '').replace(/<!--[\s\S]*?-->/g, '').trim()).filter((x) => x && !plumbingTitle(x)))].slice(0, 12)
  // a report's line as a person reads it: the agent's internals left out, its report kept behind More (test-esp32 #24)
  const plain = (xs: readonly string[]): string[] => clean(xs).map(plainLine).filter((x): x is string => x !== null)
  // every job's on the branch, oldest first: a change two jobs made is not said by the second one's alone (log #18)
  const jobs = [...(o.earlier ?? []), o.jobSummary].map((s) => reportOf(s)).filter(Boolean)
  if (jobs.length) {
    const lines = jobs.map((job) => {
      const l = firstList(job)
      return plain(l.length ? l : job.split(/\r?\n/).map((x) => x.replace(/^#+\s*/, '')).filter((x) => x.trim()))
    })
    // several jobs' reports read as one would contradict each other ("Changes 2 requirements", then an earlier job's "I
    // did not touch any requirement's words", log #166): each is labelled with the job it is from
    const said = lines.filter((l) => l.length)
    if (said.length === 1) return said.flat().slice(0, 12)
    if (said.length > 1) return [...new Set(said.flatMap((l, i) => l.map((x) => `**${jobLabel(i, said.length)}:** ${x}`)))].slice(0, 12)
  }
  const fromBody = plain(firstList(o.body))
  if (fromBody.length) return fromBody
  return clean(o.commits.map((m) => m.split('\n')[0] ?? ''))
}

/**
 * The agents' own reports on a change, for More under "What trace did" (test-esp32 #24): each job's, oldest first,
 * without the runtime's header, labelled when there are several. Null: no job wrote one.
 */
export function agentReport(o: { jobSummary: string | null; earlier?: readonly (string | null)[] }): string | null {
  const jobs = [...(o.earlier ?? []), o.jobSummary].map((s) => reportOf(s)).filter(Boolean)
  if (!jobs.length) return null
  return jobs.length === 1 ? jobs[0]! : jobs.map((j, i) => `**${jobLabel(i, jobs.length)}**\n\n${j}`).join('\n\n')
}

/** Which of a change's jobs a report is from, oldest first: "Earlier job", "Latest job", or "Job 2 of 3". */
function jobLabel(i: number, n: number): string {
  if (i === n - 1) return 'Latest job'
  return n === 2 ? 'Earlier job' : `Job ${i + 1} of ${n}`
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
  /** now, in seconds (whether its job is still working) */
  at?: number | undefined
  /** the answers trace has not applied to its branch yet (pendingAnswers) */
  answers?: readonly PendingAnswer[] | undefined
  /** its checks cannot start (src/api/stuck-checks.ts stuckFor) */
  stuck?: StuckChecks | null | undefined
}): ChangeSummary {
  const s = o.status
  const facts: ChangeFacts = { state: s?.state ?? 'open', draft: s?.draft ?? o.pull.draft, mergeable: s?.mergeable ?? 'unknown', checks: s?.checks ?? null, ...(s?.checks_denied ? { checks_denied: true } : {}) }
  if (o.stack?.stacked) facts.stacked = o.stack.stacked
  if (o.stuck && facts.state === 'open') facts.stuck = o.stuck
  if (jobWorking(o.job, o.at)) facts.working = true
  if (o.answers?.length) facts.answers = [...o.answers]
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
    ...(facts.answers ? { answers: facts.answers } : {}),
    ...(o.stack?.stacked?.on ? { builds_on: o.stack.stacked.on } : {}),
    ...(o.stack?.built_on_by.length ? { built_on_by: o.stack.built_on_by } : {}),
    ...(facts.working ? { working: true } : {}),
    ...(facts.stuck ? { stuck: facts.stuck } : {}),
  }
}

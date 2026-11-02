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
 *
 * GitHub's mergeable_state is read as: clean or has_hooks (can merge), unstable (a check that is not required failed),
 * dirty (a conflict), behind (the repository wants it up to date first), blocked (its rules stop it: required checks
 * still running, or a required review), unknown (GitHub is still working it out), draft.
 */
import { SPECIALIST_KINDS } from '../agents/kinds.js'
import type { JobRow } from '../core/job-index.js'
import { indexedHandle } from '../core/job-index.js'
import { LATER_STAGES, STAGE_IDS, type StageId, TEMPLATES, templateStages } from '../core/journey.js'
import type { PullFile, PullStatus, PullSummary } from './github.js'

export type Verdict = 'ready' | 'checking' | 'failing' | 'conflict' | 'blocked'
export type Checks = NonNullable<PullStatus['checks']>
export type FileKind = 'schematic' | 'board' | 'parts' | 'text' | 'image' | 'binary'

export interface ChangeSummary {
  number: number; title: string; url: string; draft: boolean; held: boolean
  /** "the Verification specialist", or "a trace job" */
  from: string
  job_id: string | null; stage: StageId | null; opened_at: string; updated_at: string
  state: 'open' | 'merged' | 'closed'
  /** GitHub's mergeable_state */
  mergeable: string
  checks: Checks | null
  /** GitHub refused to list the checks: trace's token lacks "Checks: read" */
  checks_denied?: boolean
  verdict: Verdict
}
export interface CheckLine { name: string; state: 'passed' | 'failed' | 'running' | 'skipped'; summary: string | null }
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
}

/** The facts the verdict, recommendation and blockers are worked out from. */
export interface ChangeFacts {
  state: 'open' | 'merged' | 'closed'; draft: boolean; mergeable: string; checks: Checks | null
  /** GitHub refused to list the checks: trace's token lacks "Checks: read" (src/api/github.ts pullStatus) */
  checks_denied?: boolean
}

/** What a person is told when trace's GitHub token may not read checks: who can fix it, and how. */
export const CHECKS_DENIED = 'trace\'s GitHub token may not read checks, so trace cannot tell whether this work passed. An admin gives the token "Checks: Read-only" on GitHub (run the installer again to see every permission it needs).'

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
    byBranch.set(j.branch, j)
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

/** Who made it, in words: "the Verification specialist", else "a trace job". */
export function fromWords(job: Pick<JobRow, 'agent'> | null, agentWords: Readonly<Record<string, string>>): string {
  const a = job?.agent
  return a && (SPECIALIST_KINDS as readonly string[]).includes(a) ? `the ${agentWords[a] ?? a} specialist` : 'a trace job'
}

// ------------------------------------------------------------------ verdict, recommendation, may_accept

const CAN_MERGE = new Set(['clean', 'has_hooks'])

/** One word for the list's pill. */
export function verdictOf(f: ChangeFacts): Verdict {
  if (f.state !== 'open' || f.draft) return 'blocked'
  if (f.mergeable === 'dirty') return 'conflict'
  if ((f.checks?.failed ?? 0) > 0 || f.mergeable === 'unstable') return 'failing'
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
export function recommendationOf(f: ChangeFacts, o: { passed?: readonly string[]; requirements?: readonly string[] } = {}): Recommendation {
  if (f.state === 'merged') return { verdict: 'none', why: 'It is already accepted into the design.' }
  if (f.state === 'closed') return { verdict: 'none', why: 'It was discarded.' }
  if (f.draft) return { verdict: 'wait', why: 'It is a draft: trace has not finished it yet.' }
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
  if (f.mergeable === 'blocked') return { verdict: 'none', why: 'Its checks are done, but the repository\'s rules on GitHub stop it merging, usually because they require an approving review. trace\'s guided flow expects the rules to require passing checks only.' }
  if (f.checks === null) return f.checks_denied ? { verdict: 'none', why: CHECKS_DENIED } : { verdict: 'wait', why: 'trace could not read its checks. Look again in a minute.' }
  if (f.checks.total === 0) return { verdict: 'wait', why: 'No checks have run on it yet. Wait for them to run.' }
  const reqs = o.requirements?.length ? ` It covers ${list([...o.requirements].slice(0, 8))}${o.requirements.length > 8 ? ` and ${plural(o.requirements.length - 8, 'more requirement')}` : ''}.` : ''
  const total = f.checks.passed
  const checks = o.passed?.length ? `${total === 1 ? 'Its check' : `All ${total} checks`} passed (${list(o.passed.slice(0, 5))}${o.passed.length > 5 ? ' and others' : ''}), and it can be merged.`
    : `${total === 1 ? 'Its check' : `All ${total} checks`} passed, and it can be merged.`
  return { verdict: 'accept', why: `${checks[0]?.toUpperCase() ?? ''}${checks.slice(1)}${reqs}` }
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
  }
  return { may_accept: out.length === 0, blockers: out }
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

/** One change's summary from its pull request (with or without its status) and its job. */
export function changeSummary(o: {
  repo: string; pull: Pick<PullSummary, 'number' | 'title' | 'url' | 'draft' | 'labels' | 'updated_at'> & { created_at?: string | undefined }
  job: JobRow | null; status: Pick<PullStatus, 'state' | 'mergeable' | 'checks' | 'checks_denied' | 'draft' | 'updated_at'> | null
  hold: string; agentWords: Readonly<Record<string, string>>
}): ChangeSummary {
  const s = o.status
  const facts: ChangeFacts = { state: s?.state ?? 'open', draft: s?.draft ?? o.pull.draft, mergeable: s?.mergeable ?? 'unknown', checks: s?.checks ?? null, ...(s?.checks_denied ? { checks_denied: true } : {}) }
  const crit = criteriaNamed(jobRequest(o.job), o.job?.title ?? '')
  return {
    number: o.pull.number, title: o.pull.title, url: o.pull.url, draft: facts.draft, held: o.pull.labels.includes(o.hold),
    from: fromWords(o.job, o.agentWords), job_id: o.job ? indexedHandle(o.repo, o.job.session, o.job.id) : null, stage: stageNamed(crit),
    opened_at: o.pull.created_at ?? o.pull.updated_at, updated_at: s?.updated_at ?? o.pull.updated_at,
    state: facts.state, mergeable: facts.mergeable, checks: facts.checks, ...(facts.checks_denied ? { checks_denied: true } : {}), verdict: verdictOf(facts),
  }
}

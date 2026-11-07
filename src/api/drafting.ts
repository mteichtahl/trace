/**
 * The requirements drafted from the intent (docs/user-journey.md, Define): Intent builder's Submit starts the
 * Verification specialist on REQUIREMENTS_FROM_INTENT, and its requirements open Requirements review. Until they are in
 * the record, where that stands decides the project's next step (journey.get), and the Requirements page's empty state:
 *
 *   intent        the intent is not submitted yet: the next step is to write it in the Intent builder
 *   waiting       the intent is submitted and the drafting job is queued until the project's agent is set up (a
 *                 project created in the web app: src/api/agent-queue.ts); it starts by itself once the agent is there
 *   drafting      the drafting job is queued, running or paused (or was started a moment ago and is not listed yet)
 *   stopped       the intent is submitted, there are no requirements, and no drafting job is under way: it was lost,
 *                 failed or cancelled, or none was started. requirements.draft starts it again
 *   drafted       the job finished: its requirements wait in its change, for a person to accept
 *   done          the record has requirements: Requirements review is where they are decided
 *
 * Starting the job is draftRequirements, for Submit and for requirements.draft alike: the same request, the same agent,
 * through the jobs API every task goes through. Asked again, it is a new attempt in a session of its own
 * (src/api/workers.ts taskSession): the lost job's session may still be held by a runtime that stopped answering, or
 * one that lists the job as running, and asking there would start nothing.
 */
import type { DatabaseSync } from 'node:sqlite'
import { type JobRow, heardOf, indexedHandle, isLive } from '../core/job-index.js'
import { type JourneyRecord, type NextStep, type Viewer, decide } from '../core/journey.js'
import { jobRequest } from './changes.js'
import { type Context, label, withRecordDb } from './action-kit.js'
import { SETTINGS_TTL_MS, cached } from './github-cache.js'
import { requirementEvidence } from './record-read.js'
import { recordRework } from './process-metrics.js'
import { type QueueFile, queuedHandle, titleOf } from './agent-queue.js'

const NO_QUEUE: QueueFile = { queued: [], started: [] }

/** The job Intent builder's Submit starts: the candidate requirements, drafted from the intent as the people decided it. */
export const REQUIREMENTS_FROM_INTENT = [
  'The intent was submitted in the Intent builder. Draft the candidate requirements from it for Requirements review.',
  'Read the intent statements with the people\'s decisions (design.intent list): use the accepted ones as accepted and the edited ones in their edited words; leave rejected ones out.',
  'For each requirement: one testable acceptance criterion with a number and a unit, a kind, and its source (stated by a person, or inferred). Add them with verify.requirements and link each to the intent statements it comes from (design.intent link).',
  'Mark every number you chose yourself in the acceptance criterion itself, right after it: "(inferred: where it comes from)", e.g. "within 5 s (inferred: a typical NTP exchange)" or "in 10 of 10 attempts (inferred: a repeatable reset)". That holds for test conditions too (a resolution, a distance, a count of tries, a sampling time). A number a person gave in the intent is not marked. verify.requirements lists the numbers left unmarked (unmarked_numbers): mark each one and update the requirement.',
  'Keep the requirements already in the record that still match the intent, under their ids, rather than adding duplicates. Leave every requirement proposed: people accept or strike them in Requirements review.',
  'Do not change the design files.',
].join('\n')

/**
 * The request as earlier versions of trace sent it, so a drafting job started before it changed is still known as one
 * (draftingJobs).
 */
export const EARLIER_REQUESTS: readonly string[] = [
  REQUIREMENTS_FROM_INTENT.split('\n').filter((l) => !l.startsWith('Mark every number you chose yourself')).join('\n'),
]

/** How long after Submit (or a retry) a drafting job not yet in the job index is taken as starting, not as missing. */
export const STARTING_S = 120

/** The decision requirements.draft logs for each retry, with its attempt (detail.attempt) and when it was asked. */
export const DRAFT_AGAIN_KIND = 'requirements.draft'

export type DraftingState = 'intent' | 'waiting' | 'drafting' | 'stopped' | 'drafted' | 'done'
export interface Drafting {
  state: DraftingState
  /** the latest drafting job (the API's id), and how it ended: lost, failed, aborted; null when none was listed */
  job: { id: string; state: 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'aborted' | 'lost'; error: string | null } | null
  /**
   * the highest attempt recorded: in a drafting job's request (index rows) or a retry's decision (the record, which
   * keeps every one: the index keeps only its newest finished rows). The next one is `attempts + 1`
   */
  attempts: number
}

/** The jobs the index lists that draft the requirements from the intent, newest first. */
export function draftingJobs(rows: readonly JobRow[]): JobRow[] {
  // its title as the index gives it now (a headline), or as it gave it before (the request's first 200 characters)
  const requests = [REQUIREMENTS_FROM_INTENT, ...EARLIER_REQUESTS]
  const titles = [titleOf(REQUIREMENTS_FROM_INTENT), ...requests.map((r) => r.replace(/\s+/g, ' ').trim().slice(0, 200))]
  return rows.filter((j) => j.kind === 'task' && !j.parentJob && (requests.includes(jobRequest(j)) || (!j.payload && titles.includes(j.title))))
    .sort((a, b) => (b.queuedAt ?? b.startedAt ?? b.updatedAt) - (a.queuedAt ?? a.startedAt ?? a.updatedAt))
}

/** When the intent was last submitted in the Intent builder (seconds), or null. */
const submittedAt = (r: Pick<JourneyRecord, 'decisions'>): number | null =>
  r.decisions.find((d) => d.kind === 'skill.submitted' && d.ref === 'intent-builder')?.at ?? null

/** When drafting was last asked for: the intent's Submit or a retry, the later (seconds), or null. */
const askedAt = (r: Pick<JourneyRecord, 'decisions'>): number | null => {
  const sent = submittedAt(r)
  const again = r.decisions.find((d) => d.kind === DRAFT_AGAIN_KIND)?.at ?? null
  return sent === null ? null : Math.max(sent, again ?? sent)
}

/**
 * The highest attempt recorded: each retry's decision in the record (requirements.draft logs its attempt; the record
 * keeps every decision, where the job index keeps only its newest finished rows, so a count of rows could repeat an
 * attempt, and with it a session). Submit, or a drafting job listed, is attempt 1. 0 when there is neither.
 */
export function lastAttempt(r: Pick<JourneyRecord, 'decisions'>, rows: readonly JobRow[]): number {
  const fromRecord = r.decisions.filter((d) => d.kind === DRAFT_AGAIN_KIND).map((d) => {
    const a = (d.detail as { attempt?: unknown } | null)?.attempt
    return typeof a === 'number' && Number.isInteger(a) ? a : 0
  })
  const first = submittedAt(r) !== null || draftingJobs(rows).length > 0 ? 1 : 0
  return Math.max(first, ...fromRecord)
}

/**
 * Whether the requirements need counting to say where drafting stands (draftingNow): not before the intent is
 * submitted with no drafting job listed (that is 'intent' whatever the record holds), and not when the step it would
 * change is not a task or trace working (a question, a gate, a change to review keep theirs). Pure.
 */
export function needsCount(r: Pick<JourneyRecord, 'journey' | 'decisions'>, rows: readonly JobRow[], next?: Pick<NextStep, 'kind'>): boolean {
  if (r.journey.currentStage !== 'define') return false
  if (next && next.kind !== 'task' && next.kind !== 'working') return false
  return submittedAt(r) !== null || draftingJobs(rows).length > 0
}

/**
 * Where the drafting stands, from the record, the job index, how many requirements the record holds and the work
 * queued until the project's agent is set up (`queue`, src/api/agent-queue.ts). Pure.
 */
export function draftingOf(repo: string, r: Pick<JourneyRecord, 'decisions'>, rows: readonly JobRow[], requirements: number, at: number, queue: QueueFile = NO_QUEUE): Drafting {
  const jobs = draftingJobs(rows)
  const last = jobs[0]
  const job: Drafting['job'] = last ? { id: indexedHandle(repo, last.session, last.id), state: last.state === 'running' && !isLive(last, at) ? 'lost' : last.state, error: last.error } : null
  const base = { job, attempts: lastAttempt(r, rows) }
  if (requirements > 0) return { state: 'done', ...base }
  const asked = askedAt(r)
  if (asked === null) return { state: 'intent', ...base }
  // Submit while the project's agent was being set up: the drafting job waits for it, queued
  const title = titleOf(REQUIREMENTS_FROM_INTENT)
  const queued = queue.queued.find((q) => q.title === title)
  if (queued) return { state: 'waiting', ...base, job: { id: queuedHandle(repo, queued.id), state: 'queued', error: null } }
  // and once it started from the queue, the grace counts from then: it is not in the index straight away
  const fromQueue = Math.max(0, ...queue.started.filter((s) => s.title === title && s.job).map((s) => Date.parse(s.started_at) / 1000))
  const sent = Math.max(asked, fromQueue)
  if (job && (job.state === 'queued' || job.state === 'running' || job.state === 'paused')) return { state: 'drafting', ...base }
  // asked for (Submit, or a retry) after the last job listed, or none listed: just started, not in the index yet
  const lastAt = last ? last.queuedAt ?? last.startedAt ?? last.updatedAt : null
  if (at - sent < STARTING_S && (lastAt === null || lastAt < sent)) return { state: 'drafting', ...base, job: null }
  if (job?.state === 'succeeded') return { state: 'drafted', ...base }
  return { state: 'stopped', ...base }
}

/** Why the drafting stopped, in words, for the step and the page. */
export function stoppedWords(d: Drafting, rows: readonly JobRow[], at: number): string {
  const j = d.job
  if (!j) return 'trace has not started drafting the requirements from your intent.'
  if (j.state === 'lost') {
    const row = draftingJobs(rows)[0]
    const mins = row ? Math.round((at - heardOf(row).heardAt) / 60) : null
    return `The Verification specialist stopped answering while it drafted the requirements${mins !== null ? `: trace has not heard from it for ${mins} minutes` : ''}, so it is lost.`
  }
  if (j.state === 'failed') return `The Verification specialist could not draft the requirements${j.error ? `: ${j.error.replace(/\s+/g, ' ').slice(0, 200).replace(/\.$/, '')}` : ''}.`
  return 'Drafting the requirements was cancelled before it finished.'
}

/**
 * The next step while there are no requirements in Define (journey.get): write the intent first; then trace drafts
 * them (the drafting job, `job_id`); when that stopped, drafting them again. Only over a step that is a task or trace
 * working: a question, a failure, a change to review or the gate keep theirs. A project that started from an import has
 * its requirements from the import (Design import), so it is left alone.
 */
export function draftingStep(next: NextStep, r: Pick<JourneyRecord, 'journey'>, d: Drafting, viewer: Viewer, why: string): NextStep {
  if (r.journey.currentStage !== 'define' || r.journey.start !== 'idea' || (next.kind !== 'task' && next.kind !== 'working')) return next
  const mine = viewer.admin || viewer.part === 'contributor'
  const who = { belongs_to: mine ? 'you' as const : 'contributors' as const, yours: mine }
  switch (d.state) {
    case 'intent': return {
      kind: 'task', ...who, summary: 'Define: Write the product intent in the Intent builder.',
      why: 'trace drafts the requirements from the intent: until it is submitted there are no requirements to accept or strike.',
      recommendation: null, button: mine ? 'Open the Intent builder' : 'Read the stage', stage: 'define', ref: { kind: 'skill', id: 'intent-builder' }, step: null,
      after: 'Once you submit it, the Verification specialist drafts the requirements, and you accept or strike each in Requirements review.',
    }
    case 'waiting': return {
      kind: 'working', belongs_to: 'trace', yours: false, summary: 'Your intent is submitted. trace drafts the requirements from it once this project\'s agent is set up.',
      why: 'Drafting needs the project\'s own agent, which trace is still setting up. The drafting is queued and starts by itself; you need not submit again.',
      recommendation: null, button: 'Watch', stage: 'define', ref: null, step: null,
      after: 'When they are drafted, you accept or strike each in Requirements review.', ...(d.job ? { job_id: d.job.id } : {}),
    }
    case 'drafting': return {
      kind: 'working', belongs_to: 'trace', yours: false, summary: 'trace is drafting the requirements from your intent.',
      why: 'There is nothing to accept yet: the Verification specialist turns each intent line into a requirement with a measurable criterion.',
      recommendation: null, button: 'Watch', stage: 'define', ref: null, step: null,
      after: 'When they are drafted, you accept or strike each in Requirements review.', ...(d.job ? { job_id: d.job.id } : {}),
    }
    case 'stopped': return {
      kind: 'task', ...who, summary: `${why} Draft the requirements again to start it once more.`,
      why: 'Requirements review needs the requirements drafted from your intent, and nothing is drafting them now.',
      // someone who may not start it reads the stage: its gate's page, as "Read the stage" opens for a criterion
      recommendation: null, button: mine ? 'Draft the requirements again' : 'Read the stage', stage: 'define', ref: mine ? { kind: 'action', id: 'requirements.draft' } : { kind: 'gate', id: 'define' }, step: null,
      after: 'The Verification specialist starts again from your submitted intent; you need not write it again.',
    }
    default: return next
  }
}

/**
 * How many requirements the repository's record holds, kept per default-branch commit (ctx.deps.githubCache): one look
 * at the default branch (short-lived, as every changes look), and the database read only when that commit is new. The
 * person's decisions that strike one are the journey store's, so the count is made against the live record as
 * requirementEvidence makes it, and kept with the record's version too.
 */
async function requirementCount(ctx: Context, repo: string, r: JourneyRecord, version: number): Promise<number> {
  const gh = await ctx.deps.github()
  const { sha } = await cached(ctx.deps.githubCache, repo, 'default-branch', () => gh.defaultBranch(repo))
  return cached(ctx.deps.githubCache, repo, `requirements:${sha}:${version}`, () => withRecordDb(ctx, repo, (db) => requirementEvidence(db, r).length), SETTINGS_TTL_MS)
}

/**
 * Where the drafting stands for journey.get and requirements.draft: in Define only. Null elsewhere, when nothing it
 * says could change the step (needsCount: then the record is not read at all, and costs GitHub nothing), or when the
 * record's requirements cannot be read (nothing is said rather than a guess). Before the intent is submitted, with no
 * drafting job listed, it is 'intent' without a read. `why`: stoppedWords.
 */
export async function draftingNow(ctx: Context, repo: string, r: JourneyRecord, rows: readonly JobRow[], o: { at?: number; next?: Pick<NextStep, 'kind'>; version?: number; queue?: QueueFile } = {}): Promise<(Drafting & { why: string }) | null> {
  const at = o.at ?? Date.now() / 1000
  if (r.journey.currentStage !== 'define' || (o.next && o.next.kind !== 'task' && o.next.kind !== 'working')) return null
  if (!needsCount(r, rows, o.next)) return { ...draftingOf(repo, r, rows, 0, at, o.queue), why: '' }
  const n = await requirementCount(ctx, repo, r, o.version ?? 0).catch(() => null)
  if (n === null) return null
  const d = draftingOf(repo, r, rows, n, at, o.queue)
  return { ...d, why: d.state === 'stopped' ? stoppedWords(d, rows, at) : '' }
}

/**
 * Start the drafting job (Submit, and requirements.draft with the next attempt): the jobs API's answer. `attempt` names
 * its session only (src/api/workers.ts taskSession); the worker is sent the task as Submit sends it, and the attempt is
 * kept in the record by logRetry.
 */
export async function draftRequirements(ctx: Context, repo: string, attempt = 1): Promise<{ accepted: boolean; jobId: string; reason?: string | undefined; queued?: boolean | undefined }> {
  const r = await (await ctx.deps.jobs()).startJob({
    kind: 'task', repository: repo, request: REQUIREMENTS_FROM_INTENT, agent: 'verify', requestedBy: label(ctx.principal), requestedBySub: ctx.principal.sub,
    ...(attempt > 1 ? { attempt } : {}),
  })
  // a stopped drafting job started again is work done twice (src/api/process-metrics.ts)
  if (attempt > 1 && r.accepted) recordRework(repo, 'job_restarted')
  return r
}

/** Log a retry in the record (requirements.draft), with its attempt: the next look's grace and attempt count from it. */
export function logRetry(db: DatabaseSync, o: { attempt: number; by: string; jobId: string | null }): void {
  decide(db, {
    kind: DRAFT_AGAIN_KIND, stage: 'define', ref: o.jobId, by: o.by,
    summary: `${o.by} asked trace to draft the requirements again (attempt ${o.attempt}).`, detail: { attempt: o.attempt },
  })
}

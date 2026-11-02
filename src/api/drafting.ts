/**
 * The requirements drafted from the intent (docs/user-journey.md, Define): Intent builder's Submit starts the
 * Verification specialist on REQUIREMENTS_FROM_INTENT, and its requirements open Requirements review. Until they are in
 * the record, where that stands decides the project's next step (journey.get), and the Requirements page's empty state:
 *
 *   intent        the intent is not submitted yet: the next step is to write it in the Intent builder
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
import { type JobRow, heardOf, indexedHandle, isLive } from '../core/job-index.js'
import type { JourneyRecord, NextStep, Viewer } from '../core/journey.js'
import { jobRequest } from './changes.js'
import { type Context, label, withRecordDb } from './action-kit.js'
import { requirementEvidence } from './record-read.js'

/** The job Intent builder's Submit starts: the candidate requirements, drafted from the intent as the people decided it. */
export const REQUIREMENTS_FROM_INTENT = [
  'The intent was submitted in the Intent builder. Draft the candidate requirements from it for Requirements review.',
  'Read the intent statements with the people\'s decisions (design.intent list): use the accepted ones as accepted and the edited ones in their edited words; leave rejected ones out.',
  'For each requirement: one testable acceptance criterion with a number and a unit, a kind, and its source (stated by a person, or inferred). Add them with verify.requirements and link each to the intent statements it comes from (design.intent link).',
  'Keep the requirements already in the record that still match the intent, under their ids, rather than adding duplicates. Leave every requirement proposed: people accept or strike them in Requirements review.',
  'Do not change the design files.',
].join('\n')

/** How long after Submit a drafting job not yet in the job index is taken as starting, not as missing. */
export const STARTING_S = 120

export type DraftingState = 'intent' | 'drafting' | 'stopped' | 'drafted' | 'done'
export interface Drafting {
  state: DraftingState
  /** the latest drafting job (the API's id), and how it ended: lost, failed, aborted; null when none was listed */
  job: { id: string; state: 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'aborted' | 'lost'; error: string | null } | null
  /** how many drafting jobs the project's index lists: the next one is attempt `attempts + 1` */
  attempts: number
}

/** The jobs the index lists that draft the requirements from the intent, newest first. */
export function draftingJobs(rows: readonly JobRow[]): JobRow[] {
  const title = REQUIREMENTS_FROM_INTENT.replace(/\s+/g, ' ').trim().slice(0, 200)
  return rows.filter((j) => j.kind === 'task' && !j.parentJob && (jobRequest(j) === REQUIREMENTS_FROM_INTENT || (!j.payload && j.title === title)))
    .sort((a, b) => (b.queuedAt ?? b.startedAt ?? b.updatedAt) - (a.queuedAt ?? a.startedAt ?? a.updatedAt))
}

/** When the intent was last submitted in the Intent builder (seconds), or null. */
const submittedAt = (r: Pick<JourneyRecord, 'decisions'>): number | null =>
  r.decisions.find((d) => d.kind === 'skill.submitted' && d.ref === 'intent-builder')?.at ?? null

/** Where the drafting stands, from the record, the job index and how many requirements the record holds. Pure. */
export function draftingOf(repo: string, r: Pick<JourneyRecord, 'decisions'>, rows: readonly JobRow[], requirements: number, at: number): Drafting {
  const jobs = draftingJobs(rows)
  const last = jobs[0]
  const job: Drafting['job'] = last ? { id: indexedHandle(repo, last.session, last.id), state: last.state === 'running' && !isLive(last, at) ? 'lost' : last.state, error: last.error } : null
  const base = { job, attempts: jobs.length }
  if (requirements > 0) return { state: 'done', ...base }
  const sent = submittedAt(r)
  if (sent === null) return { state: 'intent', ...base }
  if (job && (job.state === 'queued' || job.state === 'running' || job.state === 'paused')) return { state: 'drafting', ...base }
  // asked for after the last job listed (or none listed): just started, not in the index yet
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
    case 'drafting': return {
      kind: 'working', belongs_to: 'trace', yours: false, summary: 'trace is drafting the requirements from your intent.',
      why: 'There is nothing to accept yet: the Verification specialist turns each intent line into a requirement with a measurable criterion.',
      recommendation: null, button: 'Watch', stage: 'define', ref: null, step: null,
      after: 'When they are drafted, you accept or strike each in Requirements review.', ...(d.job ? { job_id: d.job.id } : {}),
    }
    case 'stopped': return {
      kind: 'task', ...who, summary: `${why} Draft the requirements again to start it once more.`,
      why: 'Requirements review needs the requirements drafted from your intent, and nothing is drafting them now.',
      recommendation: null, button: mine ? 'Draft the requirements again' : 'Read the stage', stage: 'define', ref: { kind: 'action', id: 'requirements.draft' }, step: null,
      after: 'The Verification specialist starts again from your submitted intent; you need not write it again.',
    }
    default: return next
  }
}

/**
 * Where the drafting stands for journey.get and requirements.draft: in Define only (null elsewhere, or when the record's
 * requirements cannot be read: then nothing is said rather than a guess). `why`: stoppedWords.
 */
export async function draftingNow(ctx: Context, repo: string, r: JourneyRecord, rows: readonly JobRow[], at = Date.now() / 1000): Promise<(Drafting & { why: string }) | null> {
  if (r.journey.currentStage !== 'define') return null
  const n = await withRecordDb(ctx, repo, (db) => requirementEvidence(db, r).length).catch(() => null)
  if (n === null) return null
  const d = draftingOf(repo, r, rows, n, at)
  return { ...d, why: d.state === 'stopped' ? stoppedWords(d, rows, at) : '' }
}

/** Start the drafting job (Submit, and requirements.draft with the next attempt): the jobs API's answer. */
export async function draftRequirements(ctx: Context, repo: string, attempt = 1): Promise<{ accepted: boolean; jobId: string; reason?: string | undefined }> {
  return (await ctx.deps.jobs()).startJob({
    kind: 'task', repository: repo, request: REQUIREMENTS_FROM_INTENT, agent: 'verify', requestedBy: label(ctx.principal), requestedBySub: ctx.principal.sub,
    ...(attempt > 1 ? { attempt } : {}),
  })
}

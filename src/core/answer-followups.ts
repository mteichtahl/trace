/**
 * Answers trace still has to apply (test-esp32 log #131, #122). When a person answers an agent's question, the work it
 * blocks changes only once a job acts on the answer: the asking job itself when it is still queued, running or paused
 * (it reads the answer), else a carry-on task on the asking job's branch (src/api/actions-journey.ts carryOn). That job
 * lived only in its worker's queue: when it was lost, cancelled by its runtime shutting down, or never reached the
 * index, nothing remembered the answer, the queued item left the Overview without running, and the change it blocked
 * was still recommended for accepting without it.
 *
 * So each answer that a job must apply is recorded here, in the journey record (the API's, beside job_controls: the
 * agents never write it), until that job's work is in:
 *
 *   answer_followups   one row per answered question: the asking job and its branch and specialist, what the person
 *                      answered (and how long it lasts), the job expected to apply it (`job`: the asker, or the
 *                      carry-on started for it), how many carry-ons were started (`attempts`), and its state: pending,
 *                      applied, or stopped (a person cancelled its job, or trace gave up after MAX_ATTEMPTS)
 *
 * followupStatus reads a pending row against the project's job index (pure):
 *
 *   applied   its job succeeded, or any job on its branch that started after the answer did (a person's "Ask for
 *             changes" carrying the answer counts)
 *   waiting   its job is queued, running or paused, or another job on its branch started after the answer is
 *   restart   its job failed, was aborted by anything but a person, was lost (no heartbeat), was queued with no word for
 *             STALE_QUEUED_S (its runtime is gone: a queued job rewrites its row every few minutes), or never reached
 *             the index within MISSING_AFTER_S: a new carry-on is started on the same branch (journey.get)
 *   stopped   a person cancelled its job, or MAX_ATTEMPTS carry-ons did not apply it: nothing starts on its own, and
 *             the change still is not recommended for accepting
 *
 * A change on the branch of a follow-up that is not applied is never recommended for accepting
 * (src/api/changes.ts recommendationOf): it waits for trace to apply the answer.
 */
import type { DatabaseSync } from 'node:sqlite'
import { type JobRow, STALE_AFTER_S, isLive } from './job-index.js'

/** At most this many carry-ons are started for one answer before trace stops and says so. */
export const MAX_ATTEMPTS = 3
/** A queued job's row with no word for this long has no runtime left (it rewrites its row at least every 5 minutes). */
export const STALE_QUEUED_S = 60 * 60
/** A job that is not in the index this long after it was started never will be. */
export const MISSING_AFTER_S = 10 * 60

export const ANSWER_FOLLOWUPS_SQL = `CREATE TABLE IF NOT EXISTS answer_followups (
  question TEXT PRIMARY KEY, text TEXT NOT NULL, asked_job TEXT NOT NULL, branch TEXT NOT NULL, agent TEXT NOT NULL,
  answer TEXT NOT NULL, reason TEXT, lasts TEXT, by TEXT, by_sub TEXT,
  job TEXT, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', note TEXT,
  answered_at REAL NOT NULL, started_at REAL NOT NULL, updated_at REAL NOT NULL
)`

export type FollowupState = 'pending' | 'applied' | 'stopped'

/** One answer a job has to apply. */
export interface Followup {
  question: string; text: string
  /** the job that asked, its branch and its specialist */
  askedJob: string; branch: string; agent: string
  answer: string; reason: string | null; lasts: string | null
  /** who answered: their label, and their Cognito sub (the carry-on runs as their request) */
  by: string | null; bySub: string | null
  /** the worker job id expected to apply it (null: a start that was not accepted) */
  job: string | null
  attempts: number; state: FollowupState
  /** why it stopped, or was applied, in words */
  note: string | null
  answeredAt: number; startedAt: number; updatedAt: number
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

export function loadFollowups(db: DatabaseSync): Followup[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='answer_followups'").get()) return []
  return (db.prepare('SELECT * FROM answer_followups ORDER BY answered_at').all() as Record<string, unknown>[]).map((r) => ({
    question: String(r.question), text: String(r.text), askedJob: String(r.asked_job), branch: String(r.branch), agent: String(r.agent),
    answer: String(r.answer), reason: str(r.reason), lasts: str(r.lasts), by: str(r.by), bySub: str(r.by_sub),
    job: str(r.job), attempts: Number(r.attempts), state: (['applied', 'stopped'].includes(String(r.state)) ? String(r.state) : 'pending') as FollowupState,
    note: str(r.note), answeredAt: Number(r.answered_at), startedAt: Number(r.started_at), updatedAt: Number(r.updated_at),
  }))
}

/** Record (or record again, for an answer given again) an answer a job has to apply. */
export function putFollowup(db: DatabaseSync, f: Omit<Followup, 'state' | 'note' | 'updatedAt'> & { state?: FollowupState; note?: string | null }, at: number): void {
  db.exec(ANSWER_FOLLOWUPS_SQL)
  db.prepare(`INSERT OR REPLACE INTO answer_followups (question, text, asked_job, branch, agent, answer, reason, lasts, by, by_sub, job, attempts, state, note, answered_at, started_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    f.question, f.text.slice(0, 2000), f.askedJob, f.branch, f.agent, f.answer.slice(0, 4000), f.reason, f.lasts, f.by, f.bySub,
    f.job, f.attempts, f.state ?? 'pending', f.note ?? null, f.answeredAt, f.startedAt, at)
}

/** Change one follow-up's job, attempts, state or note. False when there is none for that question. */
export function updateFollowup(db: DatabaseSync, question: string, set: Partial<Pick<Followup, 'job' | 'attempts' | 'state' | 'note' | 'startedAt'>>, at: number): boolean {
  if (!loadFollowups(db).some((f) => f.question === question)) return false
  const cols: Record<string, string> = { job: 'job', attempts: 'attempts', state: 'state', note: 'note', startedAt: 'started_at' }
  const entries = Object.entries(set).filter(([, v]) => v !== undefined) as [string, string | number | null][]
  db.prepare(`UPDATE answer_followups SET ${[...entries.map(([k]) => `${cols[k]}=?`), 'updated_at=?'].join(', ')} WHERE question=?`).run(...entries.map(([, v]) => v), at, question)
  return true
}

export type FollowupStatus =
  | { state: 'applied'; job: string; why: string }
  | { state: 'waiting'; job: string | null; why: string }
  | { state: 'restart'; why: string }
  | { state: 'stopped'; why: string }

/** A job a person cancelled (job.control cancel: "cancelled by <who>…"), not one its runtime stopped. */
const cancelledByPerson = (j: Pick<JobRow, 'error'>): string | null => {
  const m = /^cancelled by (.+?)(?::|$)/.exec(j.error ?? '')
  return m ? (m[1] as string).trim() : null
}

/** Where a follow-up stands against the project's job index (see the top of this file). Pure. */
export function followupStatus(f: Followup, rows: readonly JobRow[], at: number): FollowupStatus {
  if (f.state === 'applied') return { state: 'applied', job: f.job ?? '', why: f.note ?? 'Applied.' }
  // work on the branch that started after the answer: a carry-on, or a person's own revision
  const after = rows.filter((r) => r.branch === f.branch && !r.parentJob && (r.queuedAt ?? r.startedAt ?? 0) >= f.answeredAt)
  const own = f.job ? rows.find((r) => r.id === f.job) : undefined
  const done = [own, ...after].find((r) => r?.state === 'succeeded')
  if (done) return { state: 'applied', job: done.id, why: `Applied by job ${done.id}.` }
  if (f.state === 'stopped') return { state: 'stopped', why: f.note ?? 'Stopped.' }
  const busy = (r: JobRow): boolean => r.state === 'paused' || isLive(r, at) || (r.state === 'queued' && at - r.updatedAt <= STALE_QUEUED_S)
  if (own && busy(own)) return { state: 'waiting', job: own.id, why: own.state === 'queued' ? `job ${own.id} is queued` : own.state === 'paused' ? `job ${own.id} is paused` : `job ${own.id} is working on it` }
  const other = after.find(busy)
  if (other) return { state: 'waiting', job: other.id, why: `job ${other.id} is working on its branch` }
  const person = own?.state === 'aborted' ? cancelledByPerson(own) : null
  if (person) return { state: 'stopped', why: `its job was cancelled by ${person}` }
  // missing from the index: a job just started may not be written yet
  if (!own && at - f.startedAt < MISSING_AFTER_S) return { state: 'waiting', job: f.job, why: f.job ? `job ${f.job} is starting` : 'its job is starting' }
  const why = !own ? (f.job ? `job ${f.job} never reached the project's job list` : 'no job could be started for it')
    : own.state === 'queued' ? `job ${own.id} was queued and its runtime stopped without a word`
      : own.state === 'running' ? `job ${own.id} was lost: no word from it for more than ${Math.round(STALE_AFTER_S / 60)} minutes`
        : `job ${own.id} ${own.state === 'failed' ? 'failed' : 'was stopped'}${own.error ? ` (${own.error.slice(0, 160)})` : ''}`
  if (f.attempts >= MAX_ATTEMPTS) return { state: 'stopped', why: `${why}, and trace gave up after ${MAX_ATTEMPTS} tries` }
  return { state: 'restart', why }
}

/** An answer a change still waits on, as the change's recommendation names it. */
export interface PendingAnswer {
  question: string; text: string
  /** set when trace will not apply it on its own: why */
  stopped?: string
}

/** The answers each branch still waits on (followupStatus not applied), by branch. Pure. */
export function pendingAnswers(followups: readonly Followup[], rows: readonly JobRow[], at: number): Map<string, PendingAnswer[]> {
  const out = new Map<string, PendingAnswer[]>()
  for (const f of followups) {
    const s = followupStatus(f, rows, at)
    if (s.state === 'applied') continue
    const list = out.get(f.branch) ?? []
    list.push({ question: f.question, text: f.text, ...(s.state === 'stopped' ? { stopped: s.why } : {}) })
    out.set(f.branch, list)
  }
  return out
}

/**
 * Answers trace still has to apply (test-esp32 log #131, #122). When a person answers an agent's question, the work it
 * blocks changes only once a job acts on the answer: the asking job itself when it is still queued, running or paused
 * (it reads the answer), else a carry-on task on the asking job's branch (src/api/actions-journey.ts carryOn), or, when
 * that branch holds another specialist's work, on a change of its own stacked on it (carryOnPlace). That job
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
 *                      applied, or stopped (a person cancelled its job, or trace gave up after MAX_ATTEMPTS).
 *                      `stack_on`: its carry-on opens a change of its own on top of that branch, which holds another
 *                      specialist's work (test-esp32 log #144); once its job's branch is known, that is its `branch`
 *
 * followupStatus reads a pending row against the project's job index (pure):
 *
 *   applied   its job succeeded, or any job on its branch that started after the answer did (a person's "Ask for
 *             changes" carrying the answer counts)
 *   waiting   its job is queued, running or paused, or another job on its branch started after the answer is
 *   restart   its job failed, was aborted by anything but a person, was lost (no heartbeat), was queued with no word for
 *             STALE_QUEUED_S (its runtime is gone: a queued job rewrites its row every few minutes), or never reached
 *             the index within MISSING_AFTER_S: a new carry-on is started on the same branch (journey.get), or, for
 *             one on a change of its own whose branch is not known yet, stacked on the same branch again
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
  answered_at REAL NOT NULL, started_at REAL NOT NULL, updated_at REAL NOT NULL, stack_on TEXT
)`

/** The table, with the columns added since it was first made (a journey record written before has none of them). */
function ensureTable(db: DatabaseSync): void {
  db.exec(ANSWER_FOLLOWUPS_SQL)
  const cols = new Set((db.prepare('PRAGMA table_info(answer_followups)').all() as { name: string }[]).map((c) => c.name))
  if (!cols.has('stack_on')) db.exec('ALTER TABLE answer_followups ADD COLUMN stack_on TEXT')
}

export type FollowupState = 'pending' | 'applied' | 'stopped'

/** One answer a job has to apply. */
export interface Followup {
  question: string; text: string
  /** the job that asked, its branch (where the answer's work goes) and its specialist */
  askedJob: string; branch: string; agent: string
  /**
   * Set: the answer's work goes on a change of its own, stacked on this branch (the asking job's, which holds another
   * specialist's work: carryOnPlace). Its carry-on's branch is not known until its job names it (landedOn).
   */
  stackOn: string | null
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
    stackOn: str(r.stack_on), job: str(r.job), attempts: Number(r.attempts), state: (['applied', 'stopped'].includes(String(r.state)) ? String(r.state) : 'pending') as FollowupState,
    note: str(r.note), answeredAt: Number(r.answered_at), startedAt: Number(r.started_at), updatedAt: Number(r.updated_at),
  }))
}

/** Record (or record again, for an answer given again) an answer a job has to apply. */
export function putFollowup(db: DatabaseSync, f: Omit<Followup, 'state' | 'note' | 'updatedAt' | 'stackOn'> & { state?: FollowupState; note?: string | null; stackOn?: string | null }, at: number): void {
  ensureTable(db)
  db.prepare(`INSERT OR REPLACE INTO answer_followups (question, text, asked_job, branch, agent, answer, reason, lasts, by, by_sub, job, attempts, state, note, answered_at, started_at, updated_at, stack_on)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    f.question, f.text.slice(0, 2000), f.askedJob, f.branch, f.agent, f.answer.slice(0, 4000), f.reason, f.lasts, f.by, f.bySub,
    f.job, f.attempts, f.state ?? 'pending', f.note ?? null, f.answeredAt, f.startedAt, at, f.stackOn ?? null)
}

/** Change one follow-up's job, attempts, state or note. False when there is none for that question. */
export function updateFollowup(db: DatabaseSync, question: string, set: Partial<Pick<Followup, 'job' | 'attempts' | 'state' | 'note' | 'startedAt' | 'branch' | 'stackOn'>>, at: number): boolean {
  if (!loadFollowups(db).some((f) => f.question === question)) return false
  ensureTable(db)
  const cols: Record<string, string> = { job: 'job', attempts: 'attempts', state: 'state', note: 'note', startedAt: 'started_at', branch: 'branch', stackOn: 'stack_on' }
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
  // (a carry-on on a change of its own has no branch until its job names it: work on the branch it stacks on is not it)
  const after = f.stackOn ? [] : rows.filter((r) => r.branch === f.branch && !r.parentJob && (r.queuedAt ?? r.startedAt ?? 0) >= f.answeredAt)
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

/**
 * The answers each branch still waits on (followupStatus not applied), by branch. Pure. A carry-on on a change of its
 * own holds up that change only, once its job names its branch: never the change it stacks on, which holds another
 * specialist's work the answer does not touch.
 */
export function pendingAnswers(followups: readonly Followup[], rows: readonly JobRow[], at: number): Map<string, PendingAnswer[]> {
  const out = new Map<string, PendingAnswer[]>()
  for (const f of followups) {
    const s = followupStatus(f, rows, at)
    if (s.state === 'applied') continue
    const branch = f.stackOn ? landedOn(f, rows) : f.branch
    if (!branch) continue
    const list = out.get(branch) ?? []
    list.push({ question: f.question, text: f.text, ...(s.state === 'stopped' ? { stopped: s.why } : {}) })
    out.set(branch, list)
  }
  return out
}

/** The branch a job works on: its own row's, else one its worker pushed to (a specialist's row may not carry it). */
export function jobBranch(rows: readonly JobRow[], id: string): string | null {
  const row = rows.find((r) => r.id === id)
  if (!row) return null
  return row.branch ?? rows.find((r) => r.parentJob === row.id && r.branch)?.branch ?? null
}

/** Where a carry-on on a change of its own landed: its job's branch, once the job names one (null until then). */
export function landedOn(f: Pick<Followup, 'job' | 'stackOn'>, rows: readonly JobRow[]): string | null {
  if (!f.job) return null
  const b = jobBranch(rows, f.job)
  return b && b !== f.stackOn ? b : null
}

/** Where the carry-on for an answered question works (carryOnPlace). */
export type CarryOnPlace =
  | { branch: string }
  /** a change of its own on top of `stackOn`, whose work is `owner`'s (a specialist kind) */
  | { stackOn: string; owner: string }

/**
 * Where the carry-on for a question asked by job `asked` on `branch` works (test-esp32 log #144). On that branch when
 * it is the asking specialist's own work: started by a job of that specialist (the asking job itself, an earlier job
 * of its, or a person's task given to it). When another specialist started it, and the asking job only ran there (sent
 * to check a hand-off's answer, on the hand-off's branch), the carry-on opens a change of its own, stacked on that
 * branch so it starts from what the asking job saw: its work is reviewed as its own change, under its own name, and
 * never lands in another specialist's change (a docs "record" change that came to carry a whole case design). A
 * branch no known job started is taken as the asker's, as before. Pure.
 */
export function carryOnPlace(rows: readonly JobRow[], asked: Pick<JobRow, 'id' | 'agent'>, branch: string): CarryOnPlace {
  const byId = new Map(rows.map((r) => [r.id, r]))
  // the jobs that worked on it, each as its top job (a worker's row stands for the specialist job that started it)
  const top = new Map<string, JobRow>()
  for (const r of rows) {
    if (r.branch !== branch) continue
    const t = (r.parentJob ? byId.get(r.parentJob) : undefined) ?? r
    top.set(t.id, t)
  }
  const when = (r: JobRow): number => r.queuedAt ?? r.startedAt ?? r.updatedAt
  const first = [...top.values()].sort((a, b) => when(a) - when(b))[0]
  if (!first || first.id === asked.id || !first.agent || first.agent === asked.agent) return { branch }
  return { stackOn: branch, owner: first.agent }
}

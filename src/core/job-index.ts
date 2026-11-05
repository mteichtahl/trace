/**
 * A project's job index: what its agents are doing, have queued, paused and recently finished, in one place the API
 * can read. Each task runs in its own AgentCore session (one microVM per project, agent and request:
 * src/api/workers.ts taskSession), so no single process knows a project's jobs; this index is where they meet.
 *
 *   where   projects/<slug>/journey-agent/jobs.db   one SQLite database per project in the central bucket, beside the
 *           agents' facts (what agents contribute), written with conditional puts exactly like the journey record
 *           (src/core/journey-store.ts BucketDb). Only the project's worker writes it (src/agents/runtime/job-index.ts,
 *           from its jobs' own events: started, routed, a log line, a wait, ended), and its role may write there only
 *           with a conditional put and never delete (src/infra/project.ts AgentFactsConditional, AgentFactsNoDelete);
 *           the API reads it with the facts' read grant, and the live-events Lambda reads this one object of a project.
 *           No new permission: both roles' policies are at the edge of their inline size, and this is what that
 *           folder is for
 *   tables  jobs     one row per job: kind, agent, the request in one line, who asked (their Cognito sub and email),
 *                    state (queued, running, paused, succeeded, failed, aborted), its current step (the latest line of
 *                    its log), when it was queued, started and ended, where it runs, its branch, and for a task the
 *                    request (payload) that resuming or starting it again needs; `beat_at` is the running job's
 *                    heartbeat (a microVM that dies writes nothing, so a running row whose beat is older than
 *                    STALE_AFTER_S is shown as lost and no longer holds the queue); `lost_at` is when the project's
                    worker declared it lost (markLost, LOST COUNTED ONCE below)
 *           batch    the graphics card and CPU jobs (AWS Batch) a job's tools have running, from the waits its tool
 *                    server reports (src/gpu/batch.ts trackEventWait, relayed to the runtime): id, pool, state
 *
 * What people decide about jobs is not here (an agent writes this index, and agents never decide for a person): it is
 * the journey record's `job_controls` table (projects/<slug>/journey/journey.db, written only by the API, after its
 * access check): a queued job held ("paused" before it starts), its place in the queue (Move up), a paused job
 * discarded, and a lost job dismissed (with the person's reason) or started again (by whom, and when: the new job's
 * row links back to it through resume_of). The worker reads those controls when it decides whether a queued job may
 * start (QUEUE RULE below).
 *
 * QUEUE RULE. A person's task waits while the project already has a job running for the same agent, or
 * worker.max_parallel jobs running in all: it is `queued` until it is first in its agent's queue, not held, and a
 * slot is free. The queue's order is each job's `order` control when a person moved it, else when it was queued.
 * Work items (the repository's workflows) are not queued here: the workflows already limit them (worker.max_parallel
 * claims), and a claim held while queued could expire and be dispatched twice. They count as running all the same.
 *
 * LOST COUNTED ONCE. A lost job ends without a word, so nothing records its end: Operations counted only the jobs
 * that finished (and showed "100 % succeeded" over lost ones). The project's worker, the one writer of this index,
 * declares them: every write it makes (and its heartbeat, BEAT_S) runs markLost inside the same conditional put, which
 * stamps `lost_at` on each running row past STALE_AFTER_S that is not one of its own live jobs and has none yet, and
 * returns those rows. Only the write that wins the put returns them (a lost race re-runs on the new index, where the
 * other writer's stamp is already there), so each lost job is counted once (trace.jobs outcome `lost`,
 * src/agents/runtime/job-index.ts), however many microVMs of the project write and however many API processes read.
 * The row keeps its state (`running`): the views show it lost from its heartbeat as before. A row that beats again
 * after it was declared lost (a partition, not a death) keeps its stamp: it is not counted lost a second time, and its
 * end is counted as well when it comes.
 *
 * Pure except for the store: the views (jobView), the order (queueOrder) and the estimate (typicalSeconds) are
 * functions of the rows, tested on their own.
 */
import type { DatabaseSync } from 'node:sqlite'
import { type Backend } from './central.js'
import { BucketDb, type JourneyStoreOptions } from './journey-store.js'
import { projectDataPrefix, projectHash, projectSlug } from './project.js'

/** Beside the agents' facts (src/core/agent-facts.ts AGENT_FACTS_FOLDER): what agents contribute. */
export const JOB_INDEX_FOLDER = 'journey-agent'
export const JOB_INDEX_DB = 'jobs.db'
/** A paused job's Claude transcript (src/agents/runtime/job-index.ts saveTranscript): the worker's only, never the API's. */
export const JOB_SESSIONS_FOLDER = 'job-sessions'

/** The object the worker writes for each change to a project's job index. */
export const jobIndexKey = (repository: string): string => `${projectDataPrefix(repository)}/${JOB_INDEX_FOLDER}/${JOB_INDEX_DB}`

/** How often a running job says it is still alive: a timer, because a microVM that dies sends no event. */
export const BEAT_S = 300
/** A running row whose heartbeat is older than this is lost (its microVM ended without a word). */
export const STALE_AFTER_S = 3 * BEAT_S
/** A running row whose heartbeat is older than this is overdue: a beat was missed, and trace has not heard from it. */
export const OVERDUE_AFTER_S = BEAT_S + 60
/** Finished rows kept (the estimates and Today read them). */
export const KEEP_FINISHED = 300

export const JOB_STATES = ['queued', 'running', 'paused', 'succeeded', 'failed', 'aborted'] as const
export type IndexState = (typeof JOB_STATES)[number]

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,            -- the worker's job id (job-…)
  handle TEXT,                    -- the API's id for it, <AgentCore session>.<job id>, when the API started it
  session TEXT,                   -- the AgentCore session it runs in
  kind TEXT NOT NULL,             -- task | work-item | sweep
  agent TEXT,                     -- verify, impl, …, worker (a delegated job), sweep
  title TEXT NOT NULL,            -- the request (or the item) in one line
  number INTEGER,                 -- the issue or pull request
  requested_by_sub TEXT,          -- the person's Cognito sub (a task), NULL for a workflow's work item
  requested_by TEXT,              -- their email, for reading
  state TEXT NOT NULL CHECK (state IN ('queued','running','paused','succeeded','failed','aborted')),
  step TEXT,                      -- the latest line of its log, in its own words
  queued_at REAL,
  started_at REAL,
  ended_at REAL,
  beat_at REAL,
  where_ TEXT,                    -- where it runs now, in words
  branch TEXT,
  parent_job TEXT,                -- a delegated worker's specialist job
  handoff TEXT,                   -- a hand-off job: the hand-off it answers (src/core/handoffs.ts)
  resume_of TEXT,                 -- the paused job this one carries on, or the lost one it starts again
  resumed_by TEXT,                -- the job that carried this paused one on, or started this lost one again
  summary TEXT,
  error TEXT,
  payload TEXT,                   -- a task's request (JSON, without its trace context): what Resume starts again
  claude_session TEXT,            -- its Agent SDK session id, when paused with its transcript kept
  paused_by TEXT,                 -- who paused it (their email), and when
  paused_at REAL,
  tail TEXT,                      -- its last log lines (JSON array), so a job that goes silent shows what it was doing
  vitals TEXT,                    -- its microVM at its last word: memory in use and in all, in MB (JSON)
  lost_at REAL,                   -- when the project's worker declared it lost (markLost): counted once
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, agent);
CREATE TABLE IF NOT EXISTS batch (
  id TEXT PRIMARY KEY,            -- trace's id of the remote job (the gpu.* tools' job id)
  job_id TEXT NOT NULL,
  pool TEXT NOT NULL,             -- gpu | cpu
  state TEXT,                     -- AWS Batch's word: SUBMITTED, RUNNABLE, STARTING, RUNNING, …
  submitted_at REAL NOT NULL,
  ended_at REAL
);
`

export const applyJobIndexSchema = (db: DatabaseSync): void => {
  db.exec(SCHEMA)
  // added with hand-offs: an index made before has no such column
  const cols = new Set((db.prepare("SELECT name FROM pragma_table_info('jobs')").all() as { name: string }[]).map((c) => c.name))
  if (!cols.has('handoff')) db.exec('ALTER TABLE jobs ADD COLUMN handoff TEXT')
  // added to explain lost jobs: an index made before has neither
  if (!cols.has('tail')) db.exec('ALTER TABLE jobs ADD COLUMN tail TEXT')
  if (!cols.has('vitals')) db.exec('ALTER TABLE jobs ADD COLUMN vitals TEXT')
  // added to count lost jobs once (LOST COUNTED ONCE)
  if (!cols.has('lost_at')) db.exec('ALTER TABLE jobs ADD COLUMN lost_at REAL')
}

/** One project's job index, in `store` (the central bucket at its `projects` prefix). */
export class JobIndexStore extends BucketDb {
  constructor(store: Backend, repo: string, o: Omit<JourneyStoreOptions, 'legacy'> = {}) {
    super(store, repo, { folder: JOB_INDEX_FOLDER, file: JOB_INDEX_DB, schema: applyJobIndexSchema }, o)
  }
}

// ------------------------------------------------------------------ rows

export interface JobRow {
  id: string; handle: string | null; session: string | null; kind: string; agent: string | null; title: string; number: number | null
  requestedBySub: string | null; requestedBy: string | null; state: IndexState; step: string | null
  queuedAt: number | null; startedAt: number | null; endedAt: number | null; beatAt: number | null; where: string | null
  branch: string | null; parentJob: string | null; handoff: string | null; resumeOf: string | null; resumedBy: string | null
  summary: string | null; error: string | null; payload: string | null; claudeSession: string | null
  pausedBy: string | null; pausedAt: number | null
  /** its last log lines (JSON array of strings) and its microVM's memory at its last word (JSON { usedMb, totalMb }) */
  tail: string | null; vitals: string | null
  /** when the project's worker declared it lost (markLost) */
  lostAt?: number | null
  updatedAt: number
}
export interface BatchRow { id: string; jobId: string; pool: 'gpu' | 'cpu'; state: string | null; submittedAt: number; endedAt: number | null }

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

export function loadJobs(db: DatabaseSync): JobRow[] {
  return (db.prepare('SELECT * FROM jobs ORDER BY COALESCE(started_at, queued_at, updated_at) DESC').all() as Record<string, unknown>[]).map((r) => endedByItsWord({
    id: String(r.id), handle: str(r.handle), session: str(r.session), kind: String(r.kind), agent: str(r.agent), title: String(r.title), number: num(r.number),
    requestedBySub: str(r.requested_by_sub), requestedBy: str(r.requested_by), state: String(r.state) as IndexState, step: str(r.step),
    queuedAt: num(r.queued_at), startedAt: num(r.started_at), endedAt: num(r.ended_at), beatAt: num(r.beat_at), where: str(r.where_),
    branch: str(r.branch), parentJob: str(r.parent_job), handoff: str(r.handoff), resumeOf: str(r.resume_of), resumedBy: str(r.resumed_by),
    summary: str(r.summary), error: str(r.error), payload: str(r.payload), claudeSession: str(r.claude_session),
    pausedBy: str(r.paused_by), pausedAt: num(r.paused_at), tail: str(r.tail), vitals: str(r.vitals), lostAt: num(r.lost_at), updatedAt: Number(r.updated_at),
  }))
}

// ------------------------------------------------------------------ a job's own word on its end

/**
 * A job's end as its own log says it: the line jobs.ts logs as the job ends, just before its 'ended' event
 * ("<time> succeeded: branch …, done in 8 turns"). No other log line starts with these words.
 */
const END_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (succeeded|failed|aborted|paused)(?:: ([\s\S]*))?$/

export type EndState = 'succeeded' | 'failed' | 'aborted' | 'paused'

/** The end a row's last log line reports, or null when its last line is not its end. Pure. */
export function endInTail(tail: string | null): { state: EndState; at: number; text: string | null } | null {
  let lines: unknown = []
  try { lines = tail ? JSON.parse(tail) : [] } catch { return null }
  if (!Array.isArray(lines)) return null
  const last: unknown = lines[lines.length - 1]
  const m = typeof last === 'string' ? END_LINE.exec(last) : null
  if (!m) return null
  const at = Date.parse(m[1] as string) / 1000
  return Number.isFinite(at) ? { state: m[2] as EndState, at, text: m[3]?.trim() || null } : null
}

/**
 * A running row whose own last log line is its end has ended, whatever its state column says. Its end's write can
 * miss the index while its last lines (written on their own) land: job-mw36djoh's docs worker logged "succeeded …
 * done in 8 turns" and its commits were on the change, yet its row stayed `running` and it was shown lost 15 minutes
 * later, so a person would have restarted finished work. Every reader (the views, the queue, the lost sweep) loads
 * rows through here, so none of them calls such a job lost; the worker also writes the end into the row
 * (recordTailEnds). Pure.
 */
export function endedByItsWord(j: JobRow): JobRow {
  if (j.state !== 'running') return j
  const end = endInTail(j.tail)
  if (!end) return j
  const ok = end.state === 'succeeded' || end.state === 'paused'
  return {
    ...j, state: end.state, endedAt: j.endedAt ?? end.at,
    summary: j.summary ?? (ok ? end.text : null), error: j.error ?? (ok ? null : end.text),
  }
}

/**
 * Write the end of every running row whose own last log line is its end (endedByItsWord) into the row, and return
 * them. Run it inside the index's conditional put, before markLost.
 */
export function recordTailEnds(db: DatabaseSync, at: number): Pick<JobRow, 'id' | 'state'>[] {
  const out: Pick<JobRow, 'id' | 'state'>[] = []
  for (const r of db.prepare("SELECT id, tail FROM jobs WHERE state='running'").all() as { id: string; tail: string | null }[]) {
    const end = endInTail(r.tail)
    if (!end) continue
    const ok = end.state === 'succeeded' || end.state === 'paused'
    const was = db.prepare('SELECT summary, error, ended_at FROM jobs WHERE id=?').get(r.id) as { summary: string | null; error: string | null; ended_at: number | null }
    putJob(db, r.id, {
      state: end.state, endedAt: was.ended_at ?? end.at,
      ...(ok && !was.summary && end.text ? { summary: end.text } : {}), ...(!ok && !was.error && end.text ? { error: end.text } : {}),
    }, at)
    out.push({ id: r.id, state: end.state })
  }
  return out
}

export function loadBatch(db: DatabaseSync): BatchRow[] {
  return (db.prepare('SELECT * FROM batch ORDER BY submitted_at').all() as Record<string, unknown>[]).map((r) => ({
    id: String(r.id), jobId: String(r.job_id), pool: r.pool === 'cpu' ? 'cpu' : 'gpu', state: str(r.state), submittedAt: Number(r.submitted_at), endedAt: num(r.ended_at),
  }))
}

const COLUMN: Record<keyof Omit<JobRow, 'id'>, string> = {
  handle: 'handle', session: 'session', kind: 'kind', agent: 'agent', title: 'title', number: 'number', requestedBySub: 'requested_by_sub', requestedBy: 'requested_by',
  state: 'state', step: 'step', queuedAt: 'queued_at', startedAt: 'started_at', endedAt: 'ended_at', beatAt: 'beat_at', where: 'where_', branch: 'branch',
  parentJob: 'parent_job', handoff: 'handoff', resumeOf: 'resume_of', resumedBy: 'resumed_by', summary: 'summary', error: 'error', payload: 'payload', claudeSession: 'claude_session',
  pausedBy: 'paused_by', pausedAt: 'paused_at', tail: 'tail', vitals: 'vitals', lostAt: 'lost_at', updatedAt: 'updated_at',
}

/** Insert or change one job's row (only the fields given), stamping updated_at. */
export function putJob(db: DatabaseSync, id: string, fields: Partial<Omit<JobRow, 'id' | 'updatedAt'>>, at: number): void {
  const set = { ...fields, updatedAt: at }
  const exists = Boolean(db.prepare('SELECT 1 FROM jobs WHERE id=?').get(id))
  const entries = Object.entries(set).filter(([, v]) => v !== undefined) as [keyof typeof COLUMN, string | number | null][]
  if (exists) {
    db.prepare(`UPDATE jobs SET ${entries.map(([k]) => `${COLUMN[k]}=?`).join(', ')} WHERE id=?`).run(...entries.map(([, v]) => v), id)
  } else {
    const cols = ['id', ...entries.map(([k]) => COLUMN[k])]
    if (!('kind' in set) || !('title' in set) || !('state' in set)) throw new Error(`job ${id}: a new row needs its kind, title and state`)
    db.prepare(`INSERT INTO jobs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(id, ...entries.map(([, v]) => v))
  }
}

export function putBatch(db: DatabaseSync, b: BatchRow): void {
  db.prepare('INSERT INTO batch (id, job_id, pool, state, submitted_at, ended_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, ended_at=excluded.ended_at')
    .run(b.id, b.jobId, b.pool, b.state, b.submittedAt, b.endedAt)
}

/** Keep the newest KEEP_FINISHED finished rows (and their Batch rows). */
export function pruneJobs(db: DatabaseSync): void {
  db.exec(`DELETE FROM jobs WHERE state IN ('succeeded','failed','aborted') AND id NOT IN (
    SELECT id FROM jobs WHERE state IN ('succeeded','failed','aborted') ORDER BY ended_at DESC LIMIT ${KEEP_FINISHED})`)
  db.exec('DELETE FROM batch WHERE job_id NOT IN (SELECT id FROM jobs)')
}

// ------------------------------------------------------------------ what people decided (the journey record's job_controls)

/** A person's control of one job, in the journey record (written by the API only). */
export interface JobControl {
  /** the worker's job id */
  job: string
  /** a queued job held: it does not start until resumed */
  held: boolean
  /** its place in the queue when a person moved it (smaller first); null: when it was queued */
  order: number | null
  /** a paused job a person discarded (Cancel on a paused job): it is not resumed */
  discarded: boolean
  /** a lost job a person dismissed (Dismiss on its "Ended without finishing" card): it leaves the overview */
  dismissed: boolean
  /** why it was dismissed, in the person's words; null when they gave none */
  reason: string | null
  /**
   * a lost job started again: who (a person, or trace on its own) and when. Written before the new job is asked for,
   * so two presses (or two looks) start it once; cleared again when the start is refused
   */
  restartedBy: string | null
  restartedAt: number | null
  by: string
  at: number
}

export const JOB_CONTROLS_SQL = `CREATE TABLE IF NOT EXISTS job_controls (
  job TEXT PRIMARY KEY, held INTEGER NOT NULL DEFAULT 0, ord REAL, discarded INTEGER NOT NULL DEFAULT 0, dismissed INTEGER NOT NULL DEFAULT 0,
  reason TEXT, restarted_by TEXT, restarted_at REAL, by TEXT NOT NULL, at REAL NOT NULL
)`

/** Make the table, and add the columns a record made before lost jobs could be dismissed or started again lacks. */
function controlsTable(db: DatabaseSync): void {
  db.exec(JOB_CONTROLS_SQL)
  const cols = new Set((db.prepare("SELECT name FROM pragma_table_info('job_controls')").all() as { name: string }[]).map((c) => c.name))
  if (!cols.has('dismissed')) db.exec('ALTER TABLE job_controls ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0')
  if (!cols.has('reason')) db.exec('ALTER TABLE job_controls ADD COLUMN reason TEXT')
  if (!cols.has('restarted_by')) db.exec('ALTER TABLE job_controls ADD COLUMN restarted_by TEXT')
  if (!cols.has('restarted_at')) db.exec('ALTER TABLE job_controls ADD COLUMN restarted_at REAL')
}

/** The controls in a journey record (none when the table was never made). */
export function loadControls(db: DatabaseSync): Map<string, JobControl> {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_controls'").get()) return new Map()
  return new Map((db.prepare('SELECT * FROM job_controls').all() as Record<string, unknown>[]).map((r) => [String(r.job), {
    job: String(r.job), held: Number(r.held) === 1, order: num(r.ord), discarded: Number(r.discarded) === 1,
    dismissed: Number(r.dismissed ?? 0) === 1, reason: str(r.reason), restartedBy: str(r.restarted_by), restartedAt: num(r.restarted_at),
    by: String(r.by), at: Number(r.at),
  }]))
}

export function putControl(db: DatabaseSync, c: Pick<JobControl, 'job' | 'by' | 'at'> & Partial<Omit<JobControl, 'job' | 'by' | 'at'>>): void {
  controlsTable(db)
  const was = loadControls(db).get(c.job)
  const pick = <K extends keyof JobControl>(k: K, none: JobControl[K]): JobControl[K] => (c[k] !== undefined ? c[k] as JobControl[K] : was?.[k] ?? none)
  db.prepare('INSERT OR REPLACE INTO job_controls (job, held, ord, discarded, dismissed, reason, restarted_by, restarted_at, by, at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    c.job, pick('held', false) ? 1 : 0, pick('order', null), pick('discarded', false) ? 1 : 0, pick('dismissed', false) ? 1 : 0,
    pick('reason', null), pick('restartedBy', null), pick('restartedAt', null), c.by, c.at)
}

/**
 * Declare the lost jobs (LOST COUNTED ONCE): stamp `lost_at` on every running row past STALE_AFTER_S that has none and
 * is not in `alive` (the writer's own running jobs, which it knows are alive whatever their row says), and return
 * them. Run it inside the index's conditional put. updated_at is left alone: the live events read it as "changed",
 * and nothing a person sees changed.
 */
export function markLost(db: DatabaseSync, at: number, alive: ReadonlySet<string> = new Set()): Pick<JobRow, 'id' | 'kind' | 'agent'>[] {
  const out: Pick<JobRow, 'id' | 'kind' | 'agent'>[] = []
  for (const j of loadJobs(db)) {
    if (j.state !== 'running' || j.lostAt != null || alive.has(j.id) || isLive(j, at)) continue
    db.prepare('UPDATE jobs SET lost_at=? WHERE id=? AND lost_at IS NULL').run(at, j.id)
    out.push({ id: j.id, kind: j.kind, agent: j.agent })
  }
  return out
}

// ------------------------------------------------------------------ the queue

/** A running row that still holds its slot: its heartbeat is recent (or it has none yet and started recently). */
export const isLive = (j: Pick<JobRow, 'state' | 'beatAt' | 'startedAt' | 'updatedAt'>, at: number): boolean =>
  j.state === 'running' && at < heardOf(j).lostAt

/** When trace last heard from a running row, when it is overdue (a beat missed) and when it is declared lost (s). */
export function heardOf(j: Pick<JobRow, 'beatAt' | 'startedAt' | 'updatedAt'>): { heardAt: number; overdueAt: number; lostAt: number } {
  const heardAt = j.beatAt ?? j.startedAt ?? j.updatedAt
  return { heardAt, overdueAt: heardAt + OVERDUE_AFTER_S, lostAt: heardAt + STALE_AFTER_S }
}

/** The queued jobs of one agent, first first: a person's order where they moved one, else when each was queued. */
export function queueOrder(jobs: readonly JobRow[], controls: ReadonlyMap<string, JobControl>, agent?: string | null): JobRow[] {
  const key = (j: JobRow): number => controls.get(j.id)?.order ?? j.queuedAt ?? j.updatedAt
  return jobs.filter((j) => j.state === 'queued' && (agent === undefined || j.agent === agent)).sort((a, b) => key(a) - key(b) || a.id.localeCompare(b.id))
}

/** Whether a queued job may start now (QUEUE RULE), and if not, why, in words. */
export function mayStart(id: string, jobs: readonly JobRow[], controls: ReadonlyMap<string, JobControl>, o: { maxParallel: number; at: number }): { ok: true } | { ok: false; why: string } {
  const me = jobs.find((j) => j.id === id)
  if (!me) return { ok: false, why: 'it is not in the index yet' }
  if (controls.get(id)?.held) return { ok: false, why: `held by ${controls.get(id)?.by ?? 'a person'}: it starts when someone resumes it` }
  // a delegated worker is part of its specialist's job; a sweep only starts others
  const counted = jobs.filter((j) => j.id !== id && isLive(j, o.at) && j.kind !== 'sweep' && !j.parentJob)
  const same = counted.find((j) => j.agent === me.agent)
  if (same) return { ok: false, why: `the ${me.agent ?? 'same'} agent is already working on this project ("${same.title.slice(0, 80)}")` }
  if (counted.length >= o.maxParallel) return { ok: false, why: `${counted.length} jobs are already running on this project (worker.max_parallel ${o.maxParallel})` }
  const ahead = queueOrder(jobs, controls, me.agent).filter((j) => !controls.get(j.id)?.held)
  if (ahead[0] && ahead[0].id !== id) return { ok: false, why: `"${ahead[0].title.slice(0, 80)}" is ahead of it in the queue` }
  return { ok: true }
}

/** The order key that puts `id` one place up its agent's queue (null: it is first already, or not queued). */
export function moveUpOrder(id: string, jobs: readonly JobRow[], controls: ReadonlyMap<string, JobControl>): number | null {
  const me = jobs.find((j) => j.id === id)
  if (!me || me.state !== 'queued') return null
  const q = queueOrder(jobs, controls, me.agent)
  const i = q.findIndex((j) => j.id === id)
  if (i <= 0) return null
  const key = (j: JobRow): number => controls.get(j.id)?.order ?? j.queuedAt ?? j.updatedAt
  const before = q[i - 1] as JobRow
  const twoBefore = q[i - 2]
  return twoBefore ? (key(twoBefore) + key(before)) / 2 : key(before) - 1
}

// ------------------------------------------------------------------ estimates

/** Fewer earlier runs of the same kind than this make no estimate: one quick job is not what such jobs usually take. */
export const ESTIMATE_MIN_RUNS = 3
/** How many of a job's request's first words name what kind of work it is. */
const KIND_WORDS = 3

/**
 * What kind of job a row is, for its estimate: its kind (task, work item), its agent, the specialist that delegated it
 * (a worker drawing a layout for the impl specialist is not a worker fixing a sentence for the docs one), and the
 * first words of its request ("lay out the", "draw the schematic"), a hand-off's after who asked. One estimate for all
 * of an agent's jobs said "usually 1.5 min" for a layout that took an hour (#121). Pure.
 */
export function jobKindOf(j: Pick<JobRow, 'kind' | 'agent' | 'title' | 'parentJob'>, agentOf: ReadonlyMap<string, string | null>): string {
  const parent = j.parentJob ? agentOf.get(j.parentJob) ?? '?' : ''
  const words = j.title.replace(/^Asked by the [^:]{1,60} specialist:\s*/, '').toLowerCase().match(/[a-z0-9]+/g)?.slice(0, KIND_WORDS).join(' ') ?? ''
  return [j.kind, j.agent ?? '', parent, words].join('|')
}

/**
 * The typical time (s) of this kind of job on the project (jobKindOf): the median of the last 20 of that kind that
 * succeeded, or null with fewer than ESTIMATE_MIN_RUNS of them. No estimate is better than a tiny one.
 */
export function typicalSeconds(jobs: readonly JobRow[], of: Pick<JobRow, 'kind' | 'agent' | 'title' | 'parentJob'>): number | null {
  const agentOf = new Map(jobs.map((j) => [j.id, j.agent]))
  const kind = jobKindOf(of, agentOf)
  const d = jobs.filter((j) => j.state === 'succeeded' && j.startedAt !== null && j.endedAt !== null && jobKindOf(j, agentOf) === kind)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 20).map((j) => (j.endedAt as number) - (j.startedAt as number)).sort((a, b) => a - b)
  if (d.length < ESTIMATE_MIN_RUNS) return null
  const mid = Math.floor(d.length / 2)
  return Math.round(d.length % 2 ? (d[mid] as number) : ((d[mid - 1] as number) + (d[mid] as number)) / 2)
}

// ------------------------------------------------------------------ the API's id for a job

/** The AgentCore session the API starts a task in: trace-api-<project hash>-<24 hex> (src/api/workers.ts taskSession). */
export const API_SESSION = /^trace-api-([0-9a-f]{8})-[0-9a-f]{24}$/

/**
 * The id the API gives a job of the index: `<session>.<job id>` when the API started it (its handle, src/api/workers.ts),
 * else `p<project hash>.<session>.<job id>` (a workflow's job: its session, when known, is where its worker is asked;
 * `p<hash>..<job id>` without one). Either way the project's hash is in it, so access is checked before anything.
 */
export function indexedHandle(repository: string, session: string | null, jobId: string): string {
  const hash = projectHash(projectSlug(repository))
  if (session && API_SESSION.exec(session)?.[1] === hash) return `${session}.${jobId}`
  return `p${hash}.${session && /^[A-Za-z0-9_-]{33,256}$/.test(session) ? session : ''}.${jobId}`
}

/** The jobs changed since `since` (seconds), for the live events: id (the API's), state. */
export function changedSince(db: DatabaseSync, repository: string, since: number): { jobId: string; state: IndexState }[] {
  return (db.prepare('SELECT id, session, state FROM jobs WHERE updated_at >= ? ORDER BY updated_at').all(since) as Record<string, unknown>[])
    .map((r) => ({ jobId: indexedHandle(repository, str(r.session), String(r.id)), state: String(r.state) as IndexState }))
}

/** How many log lines a job's row keeps, and how long each may be. */
export const TAIL_LINES = 12
const TAIL_CHARS = 300

/** A job's last log lines as its row keeps them. Pure. */
export function tailOf(log: readonly string[]): string {
  return JSON.stringify(log.slice(-TAIL_LINES).map((l) => (l.length > TAIL_CHARS ? `${l.slice(0, TAIL_CHARS - 1)}…` : l)))
}

/**
 * What a lost job's row says about its end, in words: its last lines and how full its microVM's memory was at its last
 * word (a microVM that runs out of memory ends without one). Empty when the row holds neither. Pure.
 */
export function lastWords(r: Pick<JobRow, 'tail' | 'vitals'>): string {
  let lines: string[] = []
  try { const t: unknown = r.tail ? JSON.parse(r.tail) : []; if (Array.isArray(t)) lines = t.filter((x): x is string => typeof x === 'string') } catch { /* an unreadable tail says nothing */ }
  let mem = ''
  try {
    const v = r.vitals ? JSON.parse(r.vitals) as { usedMb?: unknown; totalMb?: unknown } : null
    if (v && typeof v.usedMb === 'number' && typeof v.totalMb === 'number' && v.totalMb > 0) mem = `Its microVM had ${v.usedMb} of ${v.totalMb} MB of memory in use at its last word (${Math.round((v.usedMb / v.totalMb) * 100)} %).`
  } catch { /* nor unreadable vitals */ }
  const last = lines.slice(-3)
  return [last.length ? `Its last lines: ${last.map((l) => `"${l}"`).join(' · ')}.` : '', mem].filter(Boolean).join(' ')
}

/**
 * The worker's side of the project's job index (src/core/job-index.ts): it writes what its own jobs do, admits a
 * person's task when the project's queue lets it start, and keeps a paused job's transcript.
 *
 *   indexJobs(jobs, store)   listens to the jobs' events (started, state, routed, log, ended) and to the waits their
 *                            tools report (a graphics card or CPU job on AWS Batch: src/gpu/batch.ts), and writes each
 *                            change into the index with a conditional put. Started, state changes and endings are
 *                            written at once; a new log line (the job's current step) at most every STEP_EVERY_MS per
 *                            job, so a chatty job does not rewrite the index for every line. A running job's heartbeat
 *                            is written every BEAT_S seconds: a timer, because a microVM that dies sends no event, and
 *                            the heartbeat is how a lost job stops holding the queue
 *   queueAdmit(store, …)     createJobs' `admit`: the job's row is claimed as running or queued in one conditional
 *                            write (two jobs that start together cannot both take the last slot: one write wins, the
 *                            other is re-run on the new index). A queued job waits for the index or people's controls
 *                            (the journey record's job_controls: held, moved up) to change: on the project's events
 *                            topic (the bucket's "Object Created" of either object, src/infra/project.ts
 *                            JourneyEventsRule), the way journey.ask waits for an answer; without the topic, or when
 *                            subscribing fails, on a declared timer (30 s doubling to 5 minutes), saying when it looks
 *                            next. While queued it holds its microVM (AgentCore bills its memory, not CPU, while it
 *                            waits) and counts against the session's maximum lifetime (8 hours by default)
 *   transcripts              a paused job's Claude transcript (the Agent SDK's session file) is copied to
 *                            projects/<slug>/job-sessions/<job id>/<session id>.jsonl, which only the project's worker
 *                            reads; a resumed task restores it and continues the same conversation
 *
 * Nothing here fails a job: an index that cannot be written is logged once per job and the job carries on.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { freemem, homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import { type Backend } from '../../core/central.js'
import {
  BEAT_S, type BatchRow, type JobControl, JobIndexStore, JOB_SESSIONS_FOLDER, type JobRow, loadControls, loadJobs, mayStart, pruneJobs, putBatch, putJob, tailOf,
} from '../../core/job-index.js'
import { type BucketDb, JourneyStore } from '../../core/journey-store.js'
import { projectsBackend, projectsFromEnv } from '../../core/agent-facts.js'
import type { PausedWork } from './job.js'
import { projectSlug } from '../../core/project.js'
import { type WaitChange, waitWithTimer } from '../../core/wait.js'
import { type SnsApi, type SqsApi, openWaitQueue, staleAfterMs, waitQueueName } from '../../gpu/batch.js'
import type { Admit, JobEvent, Jobs } from './jobs.js'
import { type JobInfo, type JobPayload, isDelegated, isHandoff } from './schemas.js'
import { handoffTitle } from '../../core/handoffs.js'

export const STEP_EVERY_MS = 15_000
/** Where a queued job looks when no event reaches it (no events topic, or subscribing failed). */
export const QUEUE_CHECK = { intervalMs: 30_000, factor: 2, maxIntervalMs: 5 * 60_000 }
/** What the project's topic carries for a write of the index or of people's controls (S3 events through EventBridge). */
export const INDEX_WRITE_FILTER = { source: ['aws.s3'], 'detail-type': ['Object Created'] }

const iso = (s: string | undefined): number | null => (s ? Date.parse(s) / 1000 : null)
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The request in one line, for a person. */
export function titleOf(p: JobPayload): string {
  switch (p.kind) {
    case 'task': return isHandoff(p) ? handoffTitle(p.handoff.from, p.handoff.question) : p.request.replace(/\s+/g, ' ').trim().slice(0, 200)
    case 'work-item': return `${p.item.kind === 'agent-fix' ? 'Issue' : 'Pull request'} #${p.item.number}: ${p.item.title}`.slice(0, 200)
    case 'sweep': return `Looking for work on ${p.repositories.length === 1 ? p.repositories[0] : `${p.repositories.length} projects`}`
  }
}

/** A task's request as Resume needs it again (its trace context and any earlier resume left out). A hand-off job's is
 * not kept: it is never paused, so never resumed. */
export function resumablePayload(p: JobPayload): string | null {
  if (p.kind !== 'task' || isDelegated(p) || isHandoff(p)) return null
  const { trace: _t, resume: _r, ...rest } = p
  return JSON.stringify(rest)
}

/** The Batch job a wait is about, from its words (src/gpu/batch.ts: "the graphics card job <id>", "the remote CPU job <id>"). */
export function batchOfWait(what: string): { id: string; pool: 'gpu' | 'cpu' } | null {
  const m = /^the (graphics card|remote CPU) job (\S{1,80})$/.exec(what)
  return m ? { id: m[2] as string, pool: m[1] === 'graphics card' ? 'gpu' : 'cpu' } : null
}

/** The microVM's memory now, for a job's row: a microVM that runs out of it ends without a word. */
export const vitals = (): string => JSON.stringify({ usedMb: Math.round((totalmem() - freemem()) / 2 ** 20), totalMb: Math.round(totalmem() / 2 ** 20) })

/** Where it runs, in words. */
const WHERE = 'on the project\'s agent runtime'

export interface IndexOptions {
  now?: () => number
  log?: (line: string) => void
  /** run the heartbeat (default true); tests drive beat() themselves */
  heartbeat?: boolean
  /** a person's tasks wait in the project's queue (queueAdmit): their first row is `queued` */
  queued?: boolean
  /** at most one step write per job in this window (default STEP_EVERY_MS); tests shorten it */
  stepEveryMs?: number
}

export interface JobIndexWriter {
  /** write the pending changes now (tests; the writer flushes on its own) */
  flush(): Promise<void>
  /** write every running job's heartbeat now */
  beat(): Promise<void>
  stop(): void
}

/**
 * Keep the index current from the jobs' own events. `payloadOf` gives a job's payload (startJob's); the index takes
 * its title, requester and, for a task, the request a Resume starts again.
 */
export function indexJobs(jobs: Jobs, store: JobIndexStore, payloadOf: (jobId: string) => JobPayload | undefined, o: IndexOptions = {}): JobIndexWriter {
  const now = o.now ?? Date.now
  const log = o.log ?? ((l: string) => { process.stderr.write(`job index: ${l}\n`) })
  const pending = new Map<string, Partial<Omit<JobRow, 'id' | 'updatedAt'>>>()
  const batch = new Map<string, BatchRow>()
  const lastStep = new Map<string, number>()
  const failedOnce = new Set<string>()
  let writing: Promise<void> = Promise.resolve()
  let timer: NodeJS.Timeout | null = null

  const rowOf = (j: JobInfo): Partial<Omit<JobRow, 'id' | 'updatedAt'>> => {
    const p = payloadOf(j.id)
    return {
      kind: j.kind, agent: j.agent ?? null, title: p ? titleOf(p) : j.key, number: j.number ?? null,
      requestedBySub: p?.kind === 'task' ? p.requestedBySub ?? null : null, requestedBy: p?.kind === 'task' ? p.requestedBy : null,
      state: j.state, step: j.step ?? null, startedAt: iso(j.runningAt ?? j.startedAt), endedAt: iso(j.endedAt), where: WHERE,
      branch: j.branch ?? null, parentJob: j.parentJobId ?? null, handoff: j.handoffId ?? null, session: j.session ?? null, summary: j.summary?.slice(0, 8000) ?? null, error: j.error?.slice(0, 2000) ?? null,
      ...(p?.kind === 'task' && !isDelegated(p) ? { payload: resumablePayload(p), resumeOf: p.resume?.job ?? null } : {}),
      ...(j.pause ? { pausedBy: j.pause.by, pausedAt: iso(j.pause.at) } : {}),
    }
  }
  /** jobs whose first row is pending: written as is only when the queue has not already written theirs */
  const fresh = new Set<string>()
  /** changes to a job whose first row is not written yet, kept for it */
  const early = new Map<string, Partial<Omit<JobRow, 'id' | 'updatedAt'>>>()
  const flush = (): Promise<void> => {
    if (!pending.size && !batch.size) return writing
    const rows = new Map(pending)
    const bs = [...batch.values()]
    pending.clear()
    batch.clear()
    writing = writing.then(async () => {
      const at = now() / 1000
      try {
        await store.update((db) => {
          for (const [id, f0] of rows) {
            const exists = Boolean(db.prepare('SELECT 1 FROM jobs WHERE id=?').get(id))
            // a change that reached the index before the job's first row (a log line's step, its route: the job logs
            // "started" before its 'started' event) waits for that row instead of failing the whole write
            if (!exists && !('kind' in f0 && 'title' in f0 && 'state' in f0)) { early.set(id, { ...early.get(id), ...f0 }); continue }
            // the queue (queueAdmit) may have written this job's state first: a first row never overwrites it
            const f = fresh.has(id) && exists ? { ...f0, state: undefined } : f0
            // a resumed task marks the paused one it carries on
            if (f.resumeOf) putJob(db, f.resumeOf, { resumedBy: id }, at)
            putJob(db, id, f.beatAt === undefined && f.state === 'running' ? { ...f, beatAt: at } : f, at)
          }
          for (const b of bs) putBatch(db, b)
          pruneJobs(db)
          return { result: null }
        })
        for (const id of rows.keys()) fresh.delete(id)
      } catch (e) {
        for (const id of rows.keys()) {
          if (failedOnce.has(id)) continue
          failedOnce.add(id)
          log(`could not write ${id} into the project's job index (the job carries on; screens will not list it): ${errText(e)}`)
        }
      }
    })
    return writing
  }
  const soon = (): void => { void flush() }
  /** a job's step written later, at the end of its STEP_EVERY_MS window */
  const trailing = new Map<string, NodeJS.Timeout>()
  const writeStep = (id: string): void => {
    lastStep.set(id, now())
    const j = jobs.jobStatus(id)[0]
    if (j) merge(id, { step: j.step ?? null, branch: j.branch ?? null, tail: tailOf(j.log ?? []), vitals: vitals() })
    soon()
  }
  const merge = (id: string, f: Partial<Omit<JobRow, 'id' | 'updatedAt'>>): void => {
    // what waited for the job's first row goes under it (the row's own fields win)
    const before = early.get(id)
    if (before && 'kind' in f) early.delete(id)
    pending.set(id, { ...(before && 'kind' in f ? before : {}), ...pending.get(id), ...f })
  }

  const off = jobs.events.on((e: JobEvent) => {
    switch (e.type) {
      case 'started': {
        // a person's task is queued until the queue admits it (queueAdmit writes it running): before that it holds
        // no slot, while it clones and is routed
        const p = payloadOf(e.jobId)
        const waits = p !== undefined && p.kind === 'task' && !isDelegated(p) && o.queued === true
        fresh.add(e.jobId)
        merge(e.jobId, { ...rowOf(e.job), queuedAt: iso(e.job.startedAt), ...(waits ? { state: 'queued' as const, step: 'getting ready: its checkout and its agent' } : {}) })
        return soon()
      }
      case 'state': case 'ended':
        merge(e.jobId, rowOf(e.job))
        return soon()
      case 'routed':
        merge(e.jobId, { agent: e.route.kind })
        return soon()
      case 'log': {
        const t = now()
        const wait = (o.stepEveryMs ?? STEP_EVERY_MS) - (t - (lastStep.get(e.jobId) ?? 0))
        // a line inside the window is not dropped: the window's last line is written when it closes. Dropped, a burst
        // ("cloning", "routed", "running the verify specialist") left the queue's "starting" on screen until the next
        // heartbeat, minutes later, while the specialist worked
        if (wait > 0) {
          if (!trailing.has(e.jobId)) {
            const timer = setTimeout(() => { trailing.delete(e.jobId); writeStep(e.jobId) }, wait)
            timer.unref()
            trailing.set(e.jobId, timer)
          }
          return
        }
        return writeStep(e.jobId)
      }
      case 'wait': return onWait(e.change)
    }
  })
  function onWait(c: WaitChange): void {
    const b = batchOfWait(c.notice.what)
    const jobId = c.notice.jobId
    if (!b || !jobId) return
    batch.set(b.id, {
      id: b.id, jobId, pool: b.pool, state: c.notice.state ?? 'SUBMITTED', submittedAt: Date.parse(c.notice.startedAt) / 1000,
      endedAt: c.type === 'ended' ? now() / 1000 : null,
    })
    soon()
  }
  const beat = async (): Promise<void> => {
    const live = jobs.jobStatus().filter((j) => j.state === 'running')
    for (const j of live) merge(j.id, { beatAt: now() / 1000, step: j.step ?? null, tail: tailOf(j.log ?? []), vitals: vitals() })
    await flush()
  }
  if (o.heartbeat !== false) {
    timer = setInterval(() => { void beat() }, BEAT_S * 1000)
    timer.unref()
  }
  return {
    flush,
    beat,
    stop: () => { off(); if (timer) clearInterval(timer); for (const t of trailing.values()) clearTimeout(t); trailing.clear() },
  }
}

// ------------------------------------------------------------------ the queue

/** Something that says when the index or people's controls may have changed. */
export interface Changes {
  /** resolves true when told of a change, false after timeoutMs (or abort) */
  next(timeoutMs: number, signal: AbortSignal): Promise<boolean>
  close(): Promise<void>
  /** how it is told, for the log */
  how: string
}

export interface QueueOptions {
  store: JobIndexStore
  /** people's controls (held, moved up): the journey record (projects/<slug>/journey/journey.db, job_controls) */
  controls: BucketDb
  now?: () => number
  log?: (line: string) => void
  /** how a queued job is told of changes (default: the project's events topic, else a timer) */
  changes?: (jobId: string) => Promise<Changes>
}

/**
 * createJobs' `admit` for one project: claim the job's slot or queue it (one conditional write), then wait for a
 * change and try again, until it may start or it is aborted.
 */
export function queueAdmit(o: QueueOptions): Admit {
  const now = o.now ?? Date.now
  const log = o.log ?? ((l: string) => { process.stderr.write(`queue: ${l}\n`) })
  return async (job, a) => {
    let changes: Changes | null = null
    try {
      for (;;) {
        const controls = await readControls(o.controls).catch((e: unknown) => { log(`people's controls could not be read (${errText(e)}): none taken`); return new Map<string, JobControl>() })
        const at = now() / 1000
        const out = await o.store.update((db) => {
          // its own row as it stands, so the rule sees it (queued, by its agent, since it was accepted)
          const known = Boolean(db.prepare('SELECT 1 FROM jobs WHERE id=?').get(job.id))
          putJob(db, job.id, known ? { agent: a.agent, state: 'queued' } : { kind: job.kind, agent: a.agent, title: job.key, state: 'queued', queuedAt: iso(job.startedAt) }, at)
          const verdict = mayStart(job.id, loadJobs(db), controls, { maxParallel: a.maxParallel, at })
          if (verdict.ok) putJob(db, job.id, { state: 'running', startedAt: at, beatAt: at, step: 'starting' }, at)
          else putJob(db, job.id, { step: `queued: ${verdict.why}` }, at)
          return { result: verdict }
        })
        if (out.result.ok) return
        a.queued(out.result.why)
        changes ??= await (o.changes ?? eventsOrTimer(o.store.slug, log))(job.id)
        await changes.next(10 * 60_000, a.signal)
        if (a.signal.aborted) return
      }
    } finally {
      await changes?.close()
    }
  }
}

const readControls = async (s: BucketDb): Promise<Map<string, JobControl>> => (await s.read((db) => loadControls(db))).result

/**
 * The project's events topic (TRACE_BATCH_EVENTS_TOPIC) as a Changes, else a declared timer. The topic carries the
 * bucket's "Object Created" of the job index and of people's controls (and of the journey record, which is read as a
 * change too: a cheap extra look).
 */
export function eventsOrTimer(project: string, log: (l: string) => void, env: NodeJS.ProcessEnv = process.env, deps: { sqs?: SqsApi; sns?: SnsApi } = {}): (jobId: string) => Promise<Changes> {
  return async (jobId) => {
    const topic = env.TRACE_BATCH_EVENTS_TOPIC?.trim()
    const name = topic ? waitQueueName(topic, project, `queue-${jobId}`) : null
    let why = 'this project sends its worker no event when its job index changes (no events topic: an older or flat installation)'
    if (topic && name) {
      try {
        const q = await openWaitQueue({
          topic, queueName: name, sweepPrefix: name.slice(0, name.indexOf('-wait-') + '-wait-'.length), project: project.toLowerCase(),
          filterPolicy: INDEX_WRITE_FILTER, sqs: deps.sqs, sns: deps.sns, now: Date.now, staleMs: staleAfterMs(env), log,
        })
        log(`${jobId} is queued: told when the project's jobs or people's controls change, and looking every 5 minutes in case a message is lost`)
        return {
          how: 'events',
          async next(timeoutMs, signal) {
            const end = Date.now() + Math.min(timeoutMs, 5 * 60_000)
            while (!signal.aborted && Date.now() < end) {
              if ((await q.receive(Math.max(1, Math.min(20, Math.ceil((end - Date.now()) / 1000))))).length) return true
            }
            return false
          },
          close: () => q.close(),
        }
      } catch (e) {
        why = `subscribing to the project's events failed (${errText(e)})`
      }
    }
    return timerChanges(jobId, why, log)
  }
}

/** A timer as a Changes: the declared QUEUE_CHECK intervals, on the record of waits (so "next check in …" shows). */
export function timerChanges(jobId: string, why: string, log: (l: string) => void, o: { now?: () => number; sleep?: (ms: number, early: AbortSignal) => Promise<void> } = {}): Changes {
  let interval = QUEUE_CHECK.intervalMs
  log(`${jobId} is queued: looking again in ${Math.round(interval / 1000)} seconds, then less often while nothing changes (up to every ${QUEUE_CHECK.maxIntervalMs / 60_000} minutes), because ${why}`)
  return {
    how: 'timer',
    async next(_timeoutMs, signal) {
      await waitWithTimer({
        what: `its turn in the project's queue (${jobId})`, why, intervalMs: interval, signal,
        // one look per call: the caller re-reads the index itself
        check: async () => ({ done: true, value: true }),
        ...(o.now ? { now: o.now } : {}), ...(o.sleep ? { sleep: o.sleep } : {}),
        deadlineAt: (o.now ?? Date.now)() + interval + 1,
      })
      interval = Math.min(QUEUE_CHECK.maxIntervalMs, interval * QUEUE_CHECK.factor)
      return false
    },
    close: async () => undefined,
  }
}

// ------------------------------------------------------------------ a paused job's transcript

/** Claude Code's folder for one working directory's sessions: its path with every other character replaced by "-". */
export const sessionsDir = (cwd: string, home: string = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')): string =>
  join(home, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))

export const transcriptKey = (repository: string, jobId: string, sessionId: string): string =>
  `${projectSlug(repository)}/${JOB_SESSIONS_FOLDER}/${jobId}/${sessionId}.jsonl`

const SESSION_ID = /^[0-9a-f-]{8,64}$/

/** Find a session's transcript on this machine (the working directory's folder first, then every project folder). */
export function findTranscript(sessionId: string, cwd: string, home?: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null
  const own = join(sessionsDir(cwd, home), `${sessionId}.jsonl`)
  if (existsSync(own)) return own
  const root = join(home ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')), 'projects')
  if (!existsSync(root)) return null
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${sessionId}.jsonl`)
    if (existsSync(f)) return f
  }
  return null
}

/** Keep a paused job's transcript in the project's area (projects at the `projects` prefix). Null when there is none. */
export async function saveTranscript(projects: Backend, repository: string, jobId: string, sessionId: string, cwd: string, home?: string): Promise<string | null> {
  const f = findTranscript(sessionId, cwd, home)
  if (!f) return null
  const key = transcriptKey(repository, jobId, sessionId)
  await projects.put(key, new Uint8Array(readFileSync(f)), { contentType: 'application/x-ndjson' })
  return key
}

/** Put a kept transcript back where Claude Code looks for it (the new working directory's folder). False: none kept. */
export async function restoreTranscript(projects: Backend, repository: string, jobId: string, sessionId: string, cwd: string, home?: string): Promise<boolean> {
  if (!SESSION_ID.test(sessionId)) return false
  const got = await projects.get(transcriptKey(repository, jobId, sessionId))
  if (!got) return false
  const dir = sessionsDir(cwd, home)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sessionId}.jsonl`), got.body)
  return true
}

/** The paused job's row (for a resumed task): its branch, summary and kept session. */
export async function pausedRow(store: JobIndexStore, jobId: string): Promise<JobRow | null> {
  return (await store.read((db) => loadJobs(db).find((j) => j.id === jobId) ?? null)).result
}

/** Record a paused job's kept session (its Claude session id) in the index. */
export async function recordPausedSession(store: JobIndexStore, jobId: string, claudeSession: string, at: number): Promise<void> {
  await store.update((db) => { putJob(db, jobId, { claudeSession }, at); return { result: null } })
}

// ------------------------------------------------------------------ the worker's wiring

/**
 * The job index, queue and paused work of this worker's project, from its environment (TRACE_PROJECT and
 * TRACE_PROJECT_HOME, set on each project's worker runtime): null elsewhere (a laptop, tests, the flat layout's shared
 * runtime without a project), where nothing is indexed and nothing queues.
 */
export function workerIndex(env: NodeJS.ProcessEnv = process.env): { admit: Admit; paused: PausedWork; watch(jobs: Jobs): JobIndexWriter } | null {
  const where = projectsFromEnv(env)
  if (!where || !env.TRACE_PROJECT?.trim()) return null
  const projects = projectsBackend(where.projects)
  const store = new JobIndexStore(projects, where.repository)
  const journey = new JourneyStore(projects, where.repository)
  const log = (l: string): void => { process.stderr.write(`job index: ${l}
`) }
  const paused: PausedWork = {
    async save(jobId, session, cwd) {
      const key = await saveTranscript(projects, where.repository, jobId, session, cwd)
      if (!key) return false
      await recordPausedSession(store, jobId, session, Date.now() / 1000)
      return true
    },
    restore: (jobId, session, cwd) => restoreTranscript(projects, where.repository, jobId, session, cwd),
    async read(jobId) {
      const r = await pausedRow(store, jobId)
      return r ? { branch: r.branch, step: r.step, pausedBy: r.pausedBy, pausedAt: r.pausedAt === null ? null : new Date(r.pausedAt * 1000).toISOString(), session: r.claudeSession } : null
    },
  }
  return {
    admit: queueAdmit({ store, controls: journey, log }),
    paused,
    watch: (jobs) => indexJobs(jobs, store, (id) => jobs.payloadOf(id), { log, queued: true }),
  }
}

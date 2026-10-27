/**
 * The agent's jobs: started in the background, one at a time per item (dedupe by key), kept in a small in-memory log.
 * The runtime server (server.ts) and the API runtime (src/api, in-process) both start work through here:
 *
 *   startJob(payload)  → { accepted, jobId }      (accepted false, with the running job's id, for a duplicate)
 *   jobStatus(jobId?)  → one job, or every job this process knows
 *
 * Every change is an event (events: EventBus<JobEvent>), so nothing here is polled:
 *
 *   started   a job was accepted (its JobInfo)          log      one line into a job's log (the line, timestamped)
 *   routed    a specialist job was routed (its Route)   ended    a job ended (its final JobInfo: state, summary, error)
 *   state     it was queued, admitted (running), or a person asked it to pause (its JobInfo)
 *   wait      a wait opened, was checked or changed state, or ended (src/core/wait.ts): a job runs inside withJob, so
 *             its waits carry its id and count as its changes; a wait outside any job (a tool call) has jobId ''
 *
 * Each event bumps `version()`, a counter that only grows (per process, from 0), and carries it; a job's own last
 * change is `versionOf(jobId)`. On top of the events:
 *
 *   waitForEnd(jobId, { timeoutMs, signal })        → the finished JobInfo the moment the job ends; at once when it
 *                                                     already has; null for an unknown job, on timeout or abort
 *   waitForChange(afterVersion, { jobId?, ... })    → the version as soon as it passes afterVersion (for one job, or
 *                                                     any); at once when it already has; the version as it stands on
 *                                                     timeout or abort (a status answer that can hold: server.ts)
 *
 * QUEUE AND PAUSE. A runner may ask to be admitted (ctx.admit, once it knows its agent): the job is `queued` until the
 * `admit` option (src/agents/runtime/job-index.ts: the project's queue, src/core/job-index.ts) lets it start, then
 * `running` again. pause(jobId) asks a running task to stop at its next safe point (ctx.pauseSignal: the runner
 * stops Claude before its next tool call and keeps the work on its branch); a runner that stopped for it rejects with
 * JobPaused and the job ends `paused`. Its delegated worker is asked to pause with it. Without `admit` nothing queues.
 *
 * The runner that does the work is injected (createJobs), so tests drive the contract without git or a model.
 */
import { randomBytes } from 'node:crypto'
import { EventBus, type WaitChange, waitChanges, withJob } from '../../core/wait.js'
import { ATTR, annotate } from '../../core/telemetry.js'
import type { Route } from '../kinds.js'
import { type PromptRecord, promptAttrs } from '../../prompts/telemetry.js'
import { realRunner } from './job.js'
import { workerIndex } from './job-index.js'
import { observeJob } from './observe.js'
import { type Accepted, type JobInfo, type JobPayload, checkProject, isDelegated } from './schemas.js'

export { AcceptedSchema, InvocationSchema, SweepPayload, StatusPayload, TaskPayload, WorkItemPayload } from './schemas.js'
export type { Accepted, Invocation, JobInfo, JobPayload, JobState, SweepJob, TaskJob, WorkItemJob } from './schemas.js'

export interface JobContext {
  jobId: string
  signal: AbortSignal
  /** Aborted when a person asks this job to pause: stop at the next safe point, keep the work, reject with JobPaused. */
  pauseSignal?: AbortSignal
  /**
   * Wait for this job's turn in its project's queue (the `admit` option of createJobs), as `agent`: the job is queued
   * meanwhile. At once without a queue. Rejects when the job is aborted while it waits.
   */
  admit?(agent: string, o: { maxParallel: number }): Promise<void>
  /** Record the branch the job works on (status, the job index). */
  branch?(name: string): void
  /** One line into the job's log (kept in memory, also written to stdout). Never pass secrets. */
  log(line: string): void
  /** Start another job (a sweep starts one per item it claims; a specialist's delegation starts a worker job). */
  startJob(payload: JobPayload): Accepted
  /** Record how the job was routed: on the job (status) and on its span. */
  route?(r: Route): void
  /** Record which prompt versions the job's model calls were built from: on the job (status) and on its span. */
  prompts?(used: readonly PromptRecord[]): void
}

/** Does one job; resolves with a one-line summary, rejects with the reason it failed. */
export type JobRunner = (payload: JobPayload, ctx: JobContext) => Promise<string>

/** A runner that stopped at a safe point because a person paused it: the job ends `paused`, with this as its summary. */
export class JobPaused extends Error {
  override name = 'JobPaused'
}

/** The queue a job waits in (createJobs `admit`): resolves when it may start; `queued(why)` says why it waits. */
export type Admit = (job: JobInfo, o: { agent: string; maxParallel: number; signal: AbortSignal; queued: (why: string) => void }) => Promise<void>

/** One change to one job. `version` is the jobs' change counter after it (Jobs.version). */
export type JobEvent =
  | { type: 'started'; jobId: string; version: number; job: JobInfo }
  | { type: 'log'; jobId: string; version: number; line: string }
  | { type: 'routed'; jobId: string; version: number; route: Route }
  | { type: 'ended'; jobId: string; version: number; job: JobInfo }
  /** queued, admitted, or asked to pause */
  | { type: 'state'; jobId: string; version: number; job: JobInfo }
  /** a wait opened, checked or ended (src/core/wait.ts): in a job (its jobId), or outside any job (jobId '') */
  | { type: 'wait'; jobId: string; version: number; change: WaitChange }

export type JobEnded = Extract<JobEvent, { type: 'ended' }>

export interface WaitOptions { timeoutMs?: number; signal?: AbortSignal | undefined }

export interface Jobs {
  /** `session`: the AgentCore session it was invoked in (recorded on the job: the API's handle names it). */
  startJob(payload: JobPayload, session?: string): Accepted
  jobStatus(jobId?: string): JobInfo[]
  /** Every change to every job, as it happens. Listeners must not throw (a throw is swallowed) and must not block. */
  readonly events: EventBus<JobEvent>
  /** The change counter: bumped by every event, never goes down. */
  version(): number
  /** The version of one job's latest change (0 for a job never seen). */
  versionOf(jobId: string): number
  /** The job once it has ended (at once if it has); null for an unknown job, on timeout or on abort. */
  waitForEnd(jobId: string, o?: WaitOptions): Promise<JobInfo | null>
  /**
   * Resolves with the version as soon as it is above afterVersion (that job's own changes only, with jobId); at once if
   * it already is. On timeout or abort, with the version as it stands (≤ afterVersion for that scope: nothing changed).
   */
  waitForChange(afterVersion: number, o?: WaitOptions & { jobId?: string | undefined }): Promise<number>
  /** True while any job runs (GET /ping answers HealthyBusy). */
  busy(): boolean
  /**
   * Abort one running job (its AbortController: Claude is stopped, git commands are killed) and wait up to graceMs
   * for it to end. False when no such job is running. A specialist's delegated worker is aborted with it.
   */
  abort(jobId: string, reason: string, graceMs?: number): Promise<boolean>
  /**
   * Ask one running task to pause at its next safe point (and its delegated worker with it). False when no such job
   * is running, or it is not a person's task (a work item or a sweep cannot be paused: only cancelled).
   */
  pause(jobId: string, by: string): boolean
  /** Abort every running job and wait (up to graceMs) for them to finish. */
  shutdown(graceMs?: number): Promise<void>
  /** The payload a job was started with (while the job is known), for the job index's title and Resume. */
  payloadOf(jobId: string): JobPayload | undefined
  /** Stop listening to the process's wait changes (a registry that is thrown away, as in tests). */
  dispose(): void
}

const KEEP_FINISHED = 200
const LOG_LINES = 200

/** The agent a job starts as: the worker for a delegation, else the specialist named or routed so far. */
export function jobAgent(p: JobPayload): string {
  if (isDelegated(p)) return 'worker'
  if (p.kind === 'work-item') return p.item.route?.kind ?? 'specialist'
  if (p.kind === 'task') return p.agent ?? 'specialist'
  return 'sweep'
}

export function jobKey(p: JobPayload): string {
  switch (p.kind) {
    case 'work-item': return `${p.repository.toLowerCase()}#${p.item.number}`
    case 'task': return isDelegated(p)
      ? `${p.repository.toLowerCase()}:delegate:${p.delegation.parentJobId}`
      : `${p.repository.toLowerCase()}:task:${p.agent ?? 'auto'}:${p.branch ?? p.request}`
    case 'sweep': return `sweep:${[...p.repositories].map((r) => r.toLowerCase()).sort().join(',')}`
  }
}

/** Whether a job can be paused: a person's own task (not a delegated worker, not a work item or a sweep). */
export const pausable = (p: JobPayload): boolean => p.kind === 'task' && !isDelegated(p)

/**
 * `project`: the one project jobs may be for (TRACE_PROJECT); startJob throws WrongProject for any other. `admit`:
 * the project's queue (absent: nothing queues). `session`: the AgentCore session a payload was invoked in.
 */
export function createJobs(runner: JobRunner, opts: { echo?: (line: string) => void; now?: () => number; project?: string | undefined; admit?: Admit } = {}): Jobs {
  const echo = opts.echo ?? ((l: string) => { process.stdout.write(`${l}\n`) })
  const now = opts.now ?? Date.now
  const jobs = new Map<string, JobInfo>()
  const payloads = new Map<string, JobPayload>()
  type Live = { id: string; abort: AbortController; pause: AbortController; payload: JobPayload; done: Promise<void> }
  const running = new Map<string, Live>()
  const runningById = (id: string): Live | undefined => {
    for (const r of running.values()) if (r.id === id) return r
    return undefined
  }
  /** A specialist job's delegated worker jobs, while they run: aborted when the specialist is aborted or ends. */
  const children = new Map<string, Set<string>>()
  const abortOne = (id: string, why: string): Promise<void> | null => {
    const r = runningById(id)
    if (!r) return null
    if (!r.abort.signal.aborted) r.abort.abort(new Error(why))
    return r.done
  }

  const prune = (): void => {
    const finished = [...jobs.values()].filter((j) => j.state !== 'running' && j.state !== 'queued')
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) { jobs.delete(j.id); versions.delete(j.id); payloads.delete(j.id) }
  }

  const events = new EventBus<JobEvent>()
  let version = 0
  const versions = new Map<string, number>()
  type Unversioned = JobEvent extends infer E ? E extends JobEvent ? Omit<E, 'version'> : never : never
  const emit = (e: Unversioned): void => {
    version++
    versions.set(e.jobId, version)
    events.emit({ ...e, version } as JobEvent)
  }
  // every change to the record of open waits is a change here too, so a held status answer wakes on it
  const unwatch = waitChanges.on((change) => emit({ type: 'wait', jobId: change.notice.jobId ?? '', change }))
  const scopeVersion = (jobId: string | undefined): number => (jobId ? versions.get(jobId) ?? 0 : version)

  const self: Jobs = {
    startJob(payload, session?: string) {
      checkProject(payload, opts.project)
      const key = jobKey(payload)
      const live = running.get(key)
      if (live) return { accepted: false, jobId: live.id, reason: `already running (${key})` }
      const id = `job-${now().toString(36)}-${randomBytes(4).toString('hex')}`
      const info: JobInfo = {
        id, kind: payload.kind, key, state: 'running', startedAt: new Date(now()).toISOString(), log: [],
        ...('repository' in payload ? { repository: payload.repository } : {}),
        ...(payload.kind === 'work-item' ? { number: payload.item.number } : payload.kind === 'task' && !isDelegated(payload) && payload.issue ? { number: payload.issue } : {}),
        agent: jobAgent(payload),
        ...(isDelegated(payload) ? { parentJobId: payload.delegation.parentJobId } : {}),
        ...(session ? { session } : {}),
        ...(payload.kind === 'task' && payload.branch ? { branch: payload.branch } : {}),
      }
      jobs.set(id, info)
      payloads.set(id, payload)
      const abort = new AbortController()
      const pauseCtl = new AbortController()
      // a delegated worker belongs to its specialist's job: it never outlives it (aborted, failed or finished)
      const parentId = isDelegated(payload) ? payload.delegation.parentJobId : null
      const parent = parentId ? runningById(parentId) : undefined
      let unlink = (): void => undefined
      if (parentId && parent) {
        const kids = children.get(parentId) ?? new Set<string>()
        kids.add(id)
        children.set(parentId, kids)
        const onParentAbort = (): void => { if (!abort.signal.aborted) abort.abort(new Error(`cancelled: its specialist job ${parentId} was aborted`)) }
        if (parent.abort.signal.aborted) onParentAbort()
        else parent.abort.signal.addEventListener('abort', onParentAbort, { once: true })
        unlink = () => {
          parent.abort.signal.removeEventListener('abort', onParentAbort)
          children.get(parentId)?.delete(id)
          if (children.get(parentId)?.size === 0) children.delete(parentId)
        }
      }
      const log = (line: string): void => {
        const l = `${new Date(now()).toISOString()} ${line}`
        info.log.push(l)
        info.step = line.slice(0, 300)
        if (info.log.length > LOG_LINES) info.log.splice(0, info.log.length - LOG_LINES)
        echo(`[${id}] ${line}`)
        emit({ type: 'log', jobId: id, line: l })
      }
      log(`started ${key}`)
      emit({ type: 'started', jobId: id, job: info })
      const route = (r: Route): void => {
        info.route = r
        info.agent = r.kind
        log(`routed to ${r.kind} (${r.source}, confidence ${r.confidence.toFixed(2)}): ${r.reason}`)
        annotate({ [ATTR.agent]: r.kind, [ATTR.agentKind]: r.kind, [ATTR.routeReason]: r.reason, [ATTR.routeConfidence]: r.confidence, [ATTR.routeSource]: r.source })
        emit({ type: 'routed', jobId: id, route: r })
      }
      const prompts = (used: readonly PromptRecord[]): void => {
        info.prompts = [...(info.prompts ?? []), ...used]
        annotate(promptAttrs(info.prompts))
      }
      const branch = (b: string): void => { info.branch = b }
      const admit = async (agent: string, o: { maxParallel: number }): Promise<void> => {
        if (!opts.admit) return
        let waited = false
        await opts.admit(info, {
          agent, maxParallel: o.maxParallel, signal: abort.signal,
          queued: (why) => {
            if (info.state === 'queued' && info.step === why) return
            waited = true
            info.state = 'queued'
            log(`queued: ${why}`)
            emit({ type: 'state', jobId: id, job: info })
          },
        })
        if (abort.signal.aborted) throw abort.signal.reason instanceof Error ? abort.signal.reason : new Error(String(abort.signal.reason))
        if (waited) {
          info.state = 'running'
          info.runningAt = new Date(now()).toISOString()
          log('its turn in the queue: starting')
          emit({ type: 'state', jobId: id, job: info })
        }
      }
      const done = observeJob(payload, id, info.agent ?? 'specialist', () => info, async () => {
        try {
          info.summary = await withJob(id, () => runner(payload, {
            jobId: id, signal: abort.signal, pauseSignal: pauseCtl.signal, log, startJob: (p) => self.startJob(p, session), route, prompts, admit, branch,
          }))
          info.state = abort.signal.aborted ? 'aborted' : 'succeeded'
          if (abort.signal.aborted) info.error = abort.signal.reason instanceof Error ? abort.signal.reason.message : String(abort.signal.reason)
        } catch (e) {
          if (e instanceof JobPaused && !abort.signal.aborted) {
            info.state = 'paused'
            info.summary = e.message
          } else {
            info.state = abort.signal.aborted ? 'aborted' : 'failed'
            info.error = e instanceof Error ? e.message : String(e)
          }
        } finally {
          info.endedAt = new Date(now()).toISOString()
          log(`${info.state}${info.error ? `: ${info.error}` : info.summary ? `: ${info.summary}` : ''}`)
          unlink()
          // a specialist that ended (however) takes any worker it delegated to with it
          for (const kid of children.get(id) ?? []) void abortOne(kid, `cancelled: its specialist job ${id} ended (${info.state})`)
          children.delete(id)
          running.delete(key)
          prune()
          // last: a listener sees the job ended, not busy, and its worker children on their way out
          emit({ type: 'ended', jobId: id, job: info })
        }
      })
      running.set(key, { id, abort, pause: pauseCtl, payload, done })
      return { accepted: true, jobId: id }
    },
    jobStatus(jobId) {
      if (jobId) { const j = jobs.get(jobId); return j ? [j] : [] }
      return [...jobs.values()].reverse()
    },
    busy: () => running.size > 0,
    events,
    version: () => version,
    versionOf: (jobId) => versions.get(jobId) ?? 0,
    async waitForEnd(jobId, o = {}) {
      if (!jobs.has(jobId)) return null
      const ended = (e: JobEvent): e is JobEnded => e.type === 'ended' && e.jobId === jobId
      const e = await events.waitFor(ended, {
        ...o,
        // asked after listening starts: an end between the caller's look and the wait is not missed
        already: () => { const j = jobs.get(jobId); return j && j.state !== 'running' ? { type: 'ended', jobId, version: versions.get(jobId) ?? version, job: j } : null },
      })
      return e?.job ?? null
    },
    async waitForChange(afterVersion, o = {}) {
      const { jobId, ...w } = o
      const e = await events.waitFor((x) => !jobId || x.jobId === jobId, {
        ...w,
        already: () => { const v = scopeVersion(jobId); return v > afterVersion ? { type: 'log', jobId: jobId ?? '', version: v, line: '' } : null },
      })
      return e?.version ?? scopeVersion(jobId)
    },
    pause(jobId, by) {
      const r = runningById(jobId)
      const info = jobs.get(jobId)
      if (!r || !info || info.state !== 'running' || !pausable(r.payload) || r.abort.signal.aborted) return false
      if (!r.pause.signal.aborted) {
        info.pause = { by, at: new Date(now()).toISOString() }
        r.pause.abort(new Error(`paused by ${by}`))
        info.log.push(`${new Date(now()).toISOString()} pausing at the next safe point (asked by ${by})`)
        emit({ type: 'state', jobId, job: info })
        // its delegated worker stops at its own next safe point, so the specialist's call returns and it can stop too
        for (const kid of children.get(jobId) ?? []) runningById(kid)?.pause.abort(new Error(`its specialist job ${jobId} is pausing`))
      }
      return true
    },
    async abort(jobId, reason, graceMs = 30_000) {
      const done = abortOne(jobId, reason)
      if (!done) return false
      await Promise.race([done, new Promise((res) => setTimeout(res, graceMs).unref())])
      return true
    },
    payloadOf: (jobId) => payloads.get(jobId),
    dispose: () => { unwatch() },
    async shutdown(graceMs = 20_000) {
      const live = [...running.values()]
      for (const r of live) r.abort.abort(new Error('the runtime is shutting down'))
      await Promise.race([Promise.allSettled(live.map((r) => r.done)), new Promise((res) => setTimeout(res, graceMs).unref())])
    },
  }
  return self
}

// ------------------------------------------------------------------ the process's own jobs (the real runner)

let current: Jobs | null = null

/**
 * The jobs of this process, with the real runner (git, GitHub, Claude). Created on first use. On a project's worker
 * runtime (TRACE_PROJECT_HOME) its jobs are written into the project's job index, a person's task waits its turn in
 * the project's queue, and a paused job's transcript is kept (src/agents/runtime/job-index.ts).
 */
export function defaultJobs(): Jobs {
  if (current) return current
  const index = workerIndex()
  current = createJobs(realRunner(process.env, index?.paused), { project: process.env.TRACE_PROJECT || undefined, ...(index ? { admit: index.admit } : {}) })
  index?.watch(current)
  return current
}

/** For the API runtime (in-process): start a job with the real runner. Returns at once; the work runs in the background. */
export function startJob(payload: JobPayload): Accepted {
  return defaultJobs().startJob(payload)
}

/** One job (by id), or every job this process knows, newest first. */
export function jobStatus(jobId?: string): JobInfo[] {
  return defaultJobs().jobStatus(jobId)
}

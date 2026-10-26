/**
 * The agent's jobs: started in the background, one at a time per item (dedupe by key), kept in a small in-memory log.
 * The runtime server (server.ts) and the API runtime (src/api, in-process) both start work through here:
 *
 *   startJob(payload)  → { accepted, jobId }      (accepted false, with the running job's id, for a duplicate)
 *   jobStatus(jobId?)  → one job, or every job this process knows
 *
 * The runner that does the work is injected (createJobs), so tests drive the contract without git or a model.
 */
import { randomBytes } from 'node:crypto'
import { ATTR, annotate } from '../../core/telemetry.js'
import type { Route } from '../kinds.js'
import { realRunner } from './job.js'
import { observeJob } from './observe.js'
import { type Accepted, type JobInfo, type JobPayload, checkProject, isDelegated } from './schemas.js'

export { AcceptedSchema, InvocationSchema, SweepPayload, StatusPayload, TaskPayload, WorkItemPayload } from './schemas.js'
export type { Accepted, Invocation, JobInfo, JobPayload, JobState, SweepJob, TaskJob, WorkItemJob } from './schemas.js'

export interface JobContext {
  jobId: string
  signal: AbortSignal
  /** One line into the job's log (kept in memory, also written to stdout). Never pass secrets. */
  log(line: string): void
  /** Start another job (a sweep starts one per item it claims; a specialist's delegation starts a worker job). */
  startJob(payload: JobPayload): Accepted
  /** Record how the job was routed: on the job (status) and on its span. */
  route?(r: Route): void
}

/** Does one job; resolves with a one-line summary, rejects with the reason it failed. */
export type JobRunner = (payload: JobPayload, ctx: JobContext) => Promise<string>

export interface Jobs {
  startJob(payload: JobPayload): Accepted
  jobStatus(jobId?: string): JobInfo[]
  /** True while any job runs (GET /ping answers HealthyBusy). */
  busy(): boolean
  /**
   * Abort one running job (its AbortController: Claude is stopped, git commands are killed) and wait up to graceMs
   * for it to end. False when no such job is running. A specialist's delegated worker is aborted with it.
   */
  abort(jobId: string, reason: string, graceMs?: number): Promise<boolean>
  /** Abort every running job and wait (up to graceMs) for them to finish. */
  shutdown(graceMs?: number): Promise<void>
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

/** `project`: the one project jobs may be for (TRACE_PROJECT); startJob throws WrongProject for any other. */
export function createJobs(runner: JobRunner, opts: { echo?: (line: string) => void; now?: () => number; project?: string | undefined } = {}): Jobs {
  const echo = opts.echo ?? ((l: string) => { process.stdout.write(`${l}\n`) })
  const now = opts.now ?? Date.now
  const jobs = new Map<string, JobInfo>()
  const running = new Map<string, { id: string; abort: AbortController; done: Promise<void> }>()
  const runningById = (id: string): { id: string; abort: AbortController; done: Promise<void> } | undefined => {
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
    const finished = [...jobs.values()].filter((j) => j.state !== 'running')
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(j.id)
  }

  const self: Jobs = {
    startJob(payload) {
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
      }
      jobs.set(id, info)
      const abort = new AbortController()
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
        if (info.log.length > LOG_LINES) info.log.splice(0, info.log.length - LOG_LINES)
        echo(`[${id}] ${line}`)
      }
      log(`started ${key}`)
      const route = (r: Route): void => {
        info.route = r
        info.agent = r.kind
        log(`routed to ${r.kind} (${r.source}, confidence ${r.confidence.toFixed(2)}): ${r.reason}`)
        annotate({ [ATTR.agent]: r.kind, [ATTR.agentKind]: r.kind, [ATTR.routeReason]: r.reason, [ATTR.routeConfidence]: r.confidence, [ATTR.routeSource]: r.source })
      }
      const done = observeJob(payload, id, info.agent ?? 'specialist', () => info, async () => {
        try {
          info.summary = await runner(payload, { jobId: id, signal: abort.signal, log, startJob: (p) => self.startJob(p), route })
          info.state = abort.signal.aborted ? 'aborted' : 'succeeded'
          if (abort.signal.aborted) info.error = abort.signal.reason instanceof Error ? abort.signal.reason.message : String(abort.signal.reason)
        } catch (e) {
          info.state = abort.signal.aborted ? 'aborted' : 'failed'
          info.error = e instanceof Error ? e.message : String(e)
        } finally {
          info.endedAt = new Date(now()).toISOString()
          log(`${info.state}${info.error ? `: ${info.error}` : info.summary ? `: ${info.summary}` : ''}`)
          unlink()
          // a specialist that ended (however) takes any worker it delegated to with it
          for (const kid of children.get(id) ?? []) void abortOne(kid, `cancelled: its specialist job ${id} ended (${info.state})`)
          children.delete(id)
          running.delete(key)
          prune()
        }
      })
      running.set(key, { id, abort, done })
      return { accepted: true, jobId: id }
    },
    jobStatus(jobId) {
      if (jobId) { const j = jobs.get(jobId); return j ? [j] : [] }
      return [...jobs.values()].reverse()
    },
    busy: () => running.size > 0,
    async abort(jobId, reason, graceMs = 30_000) {
      const done = abortOne(jobId, reason)
      if (!done) return false
      await Promise.race([done, new Promise((res) => setTimeout(res, graceMs).unref())])
      return true
    },
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

/** The jobs of this process, with the real runner (git, GitHub, Claude). Created on first use. */
export function defaultJobs(): Jobs {
  current ??= createJobs(realRunner(), { project: process.env.TRACE_PROJECT || undefined })
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

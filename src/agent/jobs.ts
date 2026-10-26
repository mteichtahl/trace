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
import { ITEM_AGENT, realRunner } from './job.js'
import { observeJob } from './observe.js'
import type { Accepted, JobInfo, JobPayload } from './schemas.js'

export { AcceptedSchema, InvocationSchema, SweepPayload, StatusPayload, TaskPayload, WorkItemPayload } from './schemas.js'
export type { Accepted, Invocation, JobInfo, JobPayload, JobState, SweepJob, TaskJob, WorkItemJob } from './schemas.js'

export interface JobContext {
  jobId: string
  signal: AbortSignal
  /** One line into the job's log (kept in memory, also written to stdout). Never pass secrets. */
  log(line: string): void
  /** Start another job (a sweep starts one per item it claims). */
  startJob(payload: JobPayload): Accepted
}

/** Does one job; resolves with a one-line summary, rejects with the reason it failed. */
export type JobRunner = (payload: JobPayload, ctx: JobContext) => Promise<string>

export interface Jobs {
  startJob(payload: JobPayload): Accepted
  jobStatus(jobId?: string): JobInfo[]
  /** True while any job runs (GET /ping answers HealthyBusy). */
  busy(): boolean
  /** Abort every running job and wait (up to graceMs) for them to finish. */
  shutdown(graceMs?: number): Promise<void>
}

const KEEP_FINISHED = 200
const LOG_LINES = 200

export function jobKey(p: JobPayload): string {
  switch (p.kind) {
    case 'work-item': return `${p.repository.toLowerCase()}#${p.item.number}`
    case 'task': return `${p.repository.toLowerCase()}:${p.agent === 'render' ? 'render' : 'task'}:${p.branch ?? p.request}`
    case 'sweep': return `sweep:${[...p.repositories].map((r) => r.toLowerCase()).sort().join(',')}`
  }
}

export function createJobs(runner: JobRunner, opts: { echo?: (line: string) => void; now?: () => number } = {}): Jobs {
  const echo = opts.echo ?? ((l: string) => { process.stdout.write(`${l}\n`) })
  const now = opts.now ?? Date.now
  const jobs = new Map<string, JobInfo>()
  const running = new Map<string, { id: string; abort: AbortController; done: Promise<void> }>()

  const prune = (): void => {
    const finished = [...jobs.values()].filter((j) => j.state !== 'running')
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(j.id)
  }

  const self: Jobs = {
    startJob(payload) {
      const key = jobKey(payload)
      const live = running.get(key)
      if (live) return { accepted: false, jobId: live.id, reason: `already running (${key})` }
      const id = `job-${now().toString(36)}-${randomBytes(4).toString('hex')}`
      const info: JobInfo = {
        id, kind: payload.kind, key, state: 'running', startedAt: new Date(now()).toISOString(), log: [],
        ...('repository' in payload ? { repository: payload.repository } : {}),
        ...(payload.kind === 'work-item' ? { number: payload.item.number } : payload.kind === 'task' && payload.issue ? { number: payload.issue } : {}),
      }
      jobs.set(id, info)
      const abort = new AbortController()
      const log = (line: string): void => {
        const l = `${new Date(now()).toISOString()} ${line}`
        info.log.push(l)
        if (info.log.length > LOG_LINES) info.log.splice(0, info.log.length - LOG_LINES)
        echo(`[${id}] ${line}`)
      }
      log(`started ${key}`)
      const done = observeJob(payload, id, payload.kind === 'work-item' ? ITEM_AGENT[payload.item.kind] : payload.kind === 'task' ? payload.agent ?? 'worker' : 'worker', () => info, async () => {
        try {
          info.summary = await runner(payload, { jobId: id, signal: abort.signal, log, startJob: (p) => self.startJob(p) })
          info.state = abort.signal.aborted ? 'aborted' : 'succeeded'
        } catch (e) {
          info.state = abort.signal.aborted ? 'aborted' : 'failed'
          info.error = e instanceof Error ? e.message : String(e)
        } finally {
          info.endedAt = new Date(now()).toISOString()
          log(`${info.state}${info.error ? `: ${info.error}` : info.summary ? `: ${info.summary}` : ''}`)
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
  current ??= createJobs(realRunner())
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

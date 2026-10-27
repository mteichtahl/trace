/**
 * The wait relay, runtime side: the waits a job's tools open in its MCP server process, mirrored on this process's
 * record of open waits (src/core/wait.ts), so a status invocation for that job lists them and check-now reaches them.
 *
 * A job's tools (gpu.*, kb.sync, …) run in the `tracectl mcp` child its Claude session starts (job.ts runClaude), and
 * their waits land in that child's own record. So every job, specialist or worker, is registered here while it runs
 * (job.ts), which gives it a token; the child gets TRACE_WAITS_URL (this runtime, loopback) and TRACE_WAITS_TOKEN,
 * and its relay (src/core/wait-report.ts) talks to two loopback-only endpoints (server.ts):
 *
 *   POST /waits/report { token, change: { type: opened|updated|ended, notice } }  → { ok }
 *        the child reports each change to its record, in order. The wait is mirrored here (wait.ts mirrorWait) under
 *        the child's wait id (a fresh id only if that one is taken), attributed to the token's job (notice.jobId):
 *        it is in activeWaits(), and each change emits waitChanges, so a held status for that job wakes on it.
 *   POST /waits/wakes  { token, timeoutS }                                         → { waitIds }
 *        held (at most 240 s; released when the client goes) until checkNow() is called here on one of that job's
 *        mirrored timer waits; answers the child's ids, and the child calls its own checkNow on each.
 *
 * A wake asked for while no /waits/wakes is held is kept for the next one. When the job ends (unregister) its mirrors
 * end, whatever the child reported last, and a held /waits/wakes answers at once. Tokens are random, compared in
 * constant time, and live only while their job runs.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { type MirroredWait, type WaitNotice, activeWaits, mirrorWait } from '../../core/wait.js'

/** The longest one POST /waits/wakes is held (s): below undici's 300 s headers timeout, like /delegate/wait. */
export const MAX_WAKES_S = 240
/** The most waits one job's child may have mirrored at a time. */
const MAX_MIRRORS = 200

const Text = (max: number) => z.string().max(max)
const Iso = z.string().max(40)
export const RelayedNotice = z.object({
  id: z.string().min(1).max(64),
  what: Text(500),
  source: z.enum(['event', 'timer']),
  startedAt: Iso,
  jobId: z.string().max(64).nullable().optional(),
  state: Text(500).nullable(),
  lastCheckedAt: Iso.nullable(),
  nextCheckAt: Iso.nullable(),
  intervalMs: z.number().min(0).nullable(),
  checks: z.number().int().min(0),
  why: Text(1000).nullable(),
})
const Token = z.string().min(16).max(200)
export const WaitReportRequest = z.object({
  token: Token,
  change: z.object({ type: z.enum(['opened', 'updated', 'ended']), notice: RelayedNotice }),
}).strict()
export type WaitReportRequest = z.infer<typeof WaitReportRequest>
export const WaitWakesRequest = z.object({ token: Token, timeoutS: z.number().min(0).max(24 * 3600) }).strict()

export class RelayError extends Error {
  override name = 'RelayError'
  constructor(message: string, readonly status = 400) { super(message) }
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

interface Entry {
  jobId: string
  token: string
  /** by the child's wait id */
  mirrors: Map<string, MirroredWait>
  /** child wait ids woken while no /waits/wakes was held */
  pending: Set<string>
  waiters: Set<() => void>
}

export interface WaitRelay {
  /** Register a running job; returns its token (for its MCP server's TRACE_WAITS_TOKEN). */
  register(jobId: string): string
  /** The job ended: its token is dead, its mirrors end, a held wakes answers. */
  unregister(jobId: string): void
  /** One change the token's child reported. Throws RelayError (403) for a token no running job holds. */
  report(token: string, change: WaitReportRequest['change']): void
  /** The child ids woken by checkNow, as soon as there is one (at once if some are pending), or [] on timeout/abort. */
  wakes(token: string, o: { timeoutMs: number; signal?: AbortSignal | undefined }): Promise<string[]>
  /** The mirrored wait ids (this record's) of one job: tests and diagnostics. */
  mirroredOf(jobId: string): string[]
  /** How many /waits/wakes calls one job has held now: tests and diagnostics. */
  heldOf(jobId: string): number
}

export function createWaitRelay(): WaitRelay {
  const byJob = new Map<string, Entry>()
  const byToken = (token: string): Entry => {
    for (const e of byJob.values()) if (same(e.token, token)) return e
    throw new RelayError('not a running job: the wait relay is refused', 403)
  }
  const drop = (jobId: string): void => {
    const e = byJob.get(jobId)
    if (!e) return
    byJob.delete(jobId)
    for (const m of e.mirrors.values()) m.end()
    e.mirrors.clear()
    e.pending.clear()
    for (const w of [...e.waiters]) w()
  }
  const wake = (e: Entry, childId: string): void => {
    e.pending.add(childId)
    for (const w of [...e.waiters]) w()
  }
  return {
    register(jobId) {
      drop(jobId)
      const token = randomBytes(32).toString('hex')
      byJob.set(jobId, { jobId, token, mirrors: new Map(), pending: new Set(), waiters: new Set() })
      return token
    },
    unregister: drop,
    report(token, change) {
      const e = byToken(token)
      const childId = change.notice.id
      const m = e.mirrors.get(childId)
      if (change.type === 'ended') {
        if (m) { e.mirrors.delete(childId); e.pending.delete(childId); m.end() }
        return
      }
      if (m) { m.update(noticeOf(change.notice, m.id, e.jobId)); return }
      // opened (or an update whose opened was lost): mirror it under the child's id, unless that one is taken here
      if (e.mirrors.size >= MAX_MIRRORS) throw new RelayError(`more than ${MAX_MIRRORS} open waits reported for one job`, 429)
      const taken = activeWaits().some((w) => w.id === childId)
      const id = taken ? `wait-${randomBytes(5).toString('hex')}` : childId
      e.mirrors.set(childId, mirrorWait(noticeOf(change.notice, id, e.jobId), { onWake: () => wake(e, childId) }))
    },
    wakes(token, o) {
      const e = byToken(token)
      return new Promise((resolve) => {
        let timer: NodeJS.Timeout | undefined
        /** a caller that went away takes nothing: its wakes stay pending for the next call */
        const finish = (take: boolean): void => {
          e.waiters.delete(onWake)
          if (timer) clearTimeout(timer)
          o.signal?.removeEventListener('abort', onAbort)
          const ids = take ? [...e.pending] : []
          if (take) e.pending.clear()
          resolve(ids)
        }
        const onWake = (): void => finish(true)
        const onAbort = (): void => finish(false)
        if (o.signal?.aborted) return finish(false)
        if (e.pending.size || !byJob.has(e.jobId)) return finish(true)
        e.waiters.add(onWake)
        o.signal?.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => finish(true), Math.max(0, Math.min(o.timeoutMs, MAX_WAKES_S * 1000)))
      })
    },
    mirroredOf(jobId) { return [...(byJob.get(jobId)?.mirrors.values() ?? [])].map((m) => m.id) },
    heldOf(jobId) { return byJob.get(jobId)?.waiters.size ?? 0 },
  }
}

function noticeOf(n: z.infer<typeof RelayedNotice>, id: string, jobId: string): WaitNotice {
  return {
    id, jobId, what: n.what, source: n.source, startedAt: n.startedAt, state: n.state, lastCheckedAt: n.lastCheckedAt,
    nextCheckAt: n.nextCheckAt, intervalMs: n.intervalMs, checks: n.checks, why: n.why,
  }
}

let current: WaitRelay | null = null

/** This process's wait relay (shared by the runner and the server). */
export function defaultWaitRelay(): WaitRelay {
  current ??= createWaitRelay()
  return current
}

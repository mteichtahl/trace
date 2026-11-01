/**
 * Hand-offs between specialists, on the runtime that runs the asking job (src/core/handoffs.ts has the rules).
 *
 *   specialist job (job.ts)  registers here → a token, given to its Claude session's MCP server only
 *                            (TRACE_HANDOFF_URL, TRACE_HANDOFF_TOKEN), with agents.enabled and the limits
 *                            (TRACE_HANDOFF_ENABLED, TRACE_HANDOFF_LIMITS) from the default branch's settings. A job a
 *                            hand-off started is never registered: it gets no token, so journey.handoff is not
 *                            offered to it (depth 1; the guards refuse it too, from its row)
 *   journey.handoff          (src/tools/journey/tools.ts, in that MCP server) checks the request and the guards and
 *                            writes it to the agents' facts, then POST /handoff { token, id }
 *   this module              checks the token, reads the request back from the facts (never from the caller), checks
 *                            it is that job's own, still `requested` and not declined, and starts the receiving
 *                            specialist as a job on this same runtime (ctx.startJob, the way a sweep starts its items):
 *                            a task with `agent` and `handoff` (the recorded request, depth 1), which waits its turn in
 *                            the project's queue like a person's task, where people may hold, move up or cancel it.
 *                            The hand-off is marked `started` with that job's id; a job that could not start marks it
 *                            `failed`, with why
 *   the receiving job        runs the asked specialist with a header saying who asked for what (the prompt catalog's
 *                            specialist.job.handoff); it answers with journey.handoff_answer, which only that job may
 *                            do (TRACE_HANDOFF_ID and its job id). Before Claude starts, a person's decline (the journey
 *                            record) stops it; when it ends, an unanswered hand-off is closed as `failed` with how the
 *                            job ended (settle), so the asker never waits on a job that is gone
 *
 * Why the worker runtime starts it, not the API: the asking job is already on the project's own runtime, whose role
 * reaches the project's queue and facts; starting a job there needs no new permission and no caller outside the
 * container. The new job runs in its own checkout (its own branch), not the asker's. The endpoint answers loopback
 * callers only, and tokens are compared in constant time.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { AgentFactsStore, projectsBackend, projectsFromEnv } from '../../core/agent-facts.js'
import { type HandoffFact, HandoffError, type Limits, loadDeclines, loadHandoffs, markFailed, markStarted } from '../../core/handoffs.js'
import { JourneyStore } from '../../core/journey-store.js'
import { JobIndexStore, isLive, loadJobs } from '../../core/job-index.js'
import { SPECIALIST_KINDS, SPECIALIST_WORDS, type SpecialistKind } from '../kinds.js'
import { type Accepted, type HandoffTaskJob, type JobPayload } from './schemas.js'

export const HandoffStartRequest = z.object({ token: z.string().min(16).max(200), id: z.string().regex(/^ho[0-9a-f]{14}$/) }).strict()

/** The job that may raise hand-offs, as it registers. */
export interface AskingJob {
  jobId: string
  kind: SpecialistKind
  repository: string
  /** agents.enabled and the limits, from the default branch's settings */
  enabled: readonly SpecialistKind[]
  limits: Limits
}

/** What the receiving job's runner asks of the hand-off it answers. */
export interface HandoffRunner {
  /** a person's decline (the journey record), or null */
  declined(id: string): Promise<{ reason: string; by: string } | null>
  /** the job ended: close the hand-off as failed, with `why`, unless it was answered. True when it closed it. */
  settle(id: string, why: string): Promise<boolean>
  /**
   * The job answered its hand-off and ended: when the job that asked has ended too, start the asking specialist again
   * on `branch` (the answering job's, where the answer's work is), told the answer, so it checks it and carries on. A
   * job that asked and is still queued, running or paused reads the answer itself. The new job's id, or null.
   */
  carryOn(id: string, branch: string, startJob: (p: JobPayload) => Accepted): Promise<string | null>
}

export interface HandoffRuntime extends HandoffRunner {
  register(job: AskingJob): string
  unregister(jobId: string): void
  /**
   * Start the receiving job for one of the token's own hand-offs (`startJob` is given the asking job, so the new job
   * can run in its session). Throws HandoffStartError (with an HTTP status).
   */
  start(token: string, id: string, startJob: (p: JobPayload, asker: AskingJob) => Accepted): Promise<Accepted & { handoff: string }>
  /**
   * The receiving job is about to start its work (after its turn in the queue): its hand-off is marked started with its
   * id (if the runtime has not yet), or, when a person declined it meanwhile, closed and the reason returned.
   */
  begin(id: string, jobId: string): Promise<{ declined: { reason: string; by: string } | null }>
}

export class HandoffStartError extends Error {
  override name = 'HandoffStartError'
  constructor(message: string, readonly status = 400) { super(message) }
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The receiving job's payload, from the recorded request only. */
export function handoffPayload(h: HandoffFact, repository: string): HandoffTaskJob {
  return {
    kind: 'task', repository, agent: h.toKind,
    request: h.question,
    requestedBy: `the ${SPECIALIST_WORDS[h.fromAgent as SpecialistKind] ?? h.fromAgent} specialist (job ${h.fromJob})`.slice(0, 200),
    handoff: {
      id: h.id, from: h.fromAgent as SpecialistKind, fromJob: h.fromJob, question: h.question, blocks: h.blocks, evidence: h.evidence.map((e) => ({ kind: e.kind, ref: e.ref, ...(e.label ? { label: e.label } : {}) })),
      recommendation: h.recommendation, acceptance: h.acceptance, depth: 1,
    },
  }
}

export function createHandoffRuntime(o: { facts: AgentFactsStore; journey: Pick<JourneyStore, 'read'>; repository: string; jobs?: Pick<JobIndexStore, 'read'>; now?: () => number }): HandoffRuntime {
  const byJob = new Map<string, { job: AskingJob; token: string }>()
  const byToken = (token: string): AskingJob => {
    for (const e of byJob.values()) if (same(e.token, token)) return e.job
    throw new HandoffStartError('not a running specialist job: a hand-off is refused', 403)
  }
  const declines = async (): Promise<Map<string, { reason: string; by: string }>> =>
    new Map((await o.journey.read((db) => loadDeclines(db))).result.map((d) => [d.handoffId, { reason: d.reason, by: d.by }]))
  return {
    register(job) {
      const token = randomBytes(32).toString('hex')
      byJob.set(job.jobId, { job, token })
      return token
    },
    unregister(jobId) { byJob.delete(jobId) },
    async start(token, id, startJob) {
      const job = byToken(token)
      const h = (await o.facts.read((db) => loadHandoffs(db).find((x) => x.id === id) ?? null)).result
      if (!h || h.fromJob !== job.jobId) throw new HandoffStartError(`${id} is not a hand-off this job raised`, 404)
      if (h.state !== 'requested') return { accepted: false, jobId: h.jobId ?? '', reason: `it is ${h.state} already`, handoff: id }
      const d = (await declines()).get(id)
      if (d) return { accepted: false, jobId: '', reason: `declined by ${d.by}: ${d.reason}`, handoff: id }
      let r: Accepted
      try {
        r = startJob(handoffPayload(h, o.repository), job)
      } catch (e) {
        const why = `its job could not start (${e instanceof Error ? e.message : String(e)})`
        await o.facts.update((db) => ({ result: markFailed(db, id, why) }))
        throw new HandoffStartError(why, 500)
      }
      if (!r.accepted) {
        await o.facts.update((db) => ({ result: markFailed(db, id, `its job was not accepted (${r.reason ?? 'refused'})`) }))
        return { ...r, handoff: id }
      }
      await o.facts.update((db) => { markStarted(db, id, r.jobId); return { result: null } })
      return { ...r, handoff: id }
    },
    async declined(id) { return (await declines()).get(id) ?? null },
    async begin(id, jobId) {
      const d = (await declines()).get(id) ?? null
      await o.facts.update((db) => {
        if (d) markFailed(db, id, `declined by ${d.by}: ${d.reason}`)
        else markStarted(db, id, jobId)
        return { result: null }
      })
      return { declined: d }
    },
    async settle(id, why) {
      return (await o.facts.update((db) => { const n = markFailed(db, id, why); return { result: n, changed: n } })).result
    },
    async carryOn(id, branch, startJob) {
      const h = (await o.facts.read((db) => loadHandoffs(db).find((x) => x.id === id) ?? null)).result
      const kind = SPECIALIST_KINDS.find((k) => k === h?.fromAgent)
      if (!h || h.state !== 'answered' || !kind) return null
      const asker = o.jobs ? (await o.jobs.read((db) => loadJobs(db).find((j) => j.id === h.fromJob) ?? null)).result : null
      if (asker && (asker.state === 'queued' || asker.state === 'paused' || isLive(asker, (o.now ?? (() => Date.now() / 1000))()))) return null
      const r = startJob({ kind: 'task', repository: o.repository, agent: kind, branch, request: carryOnRequest(h, branch), requestedBy: `hand-off ${h.id}` })
      return r.accepted ? r.jobId : null
    },
  }
}

/**
 * What the asking specialist is told when its hand-off was answered after its job ended: carry on on the answering
 * job's branch, where the answer's work is, so its pull request carries both the answer and the asker's check of it.
 */
export function carryOnRequest(h: HandoffFact, branch: string): string {
  return [
    `Your hand-off ${h.id} to the ${SPECIALIST_WORDS[h.toKind]} specialist was answered after your job ended. You asked: ${h.question.slice(0, 1500)}`,
    `Its answer (read it in full with journey.status, handoff ${h.id}): ${(h.answer ?? '').slice(0, 3000)}`,
    `${h.acceptanceMet === false ? 'It says your acceptance is not all met. ' : ''}The answer's work is on ${branch}: you are on that branch. Check the answer against your acceptance with your own tools (re-run what it changed: your test items, checks or analyses), record what you find as before, and push to the same branch so its pull request carries the answer and your check of it.`,
    'Carry on with what the answer unblocked. If it does not hold, say so with the numbers: ask a person (journey.ask) rather than hand the same question back.',
  ].join('\n')
}

let current: HandoffRuntime | null | undefined

/**
 * This process's hand-offs: on a project's worker runtime (TRACE_PROJECT and the projects store in scope), else null:
 * a laptop or the flat layout's shared runtime raises none.
 */
export function defaultHandoffRuntime(env: NodeJS.ProcessEnv = process.env): HandoffRuntime | null {
  if (current !== undefined) return current
  const where = projectsFromEnv(env)
  if (!where || !env.TRACE_PROJECT?.trim()) { current = null; return null }
  const store = projectsBackend(where.projects)
  current = createHandoffRuntime({ facts: new AgentFactsStore(store, where.repository), journey: new JourneyStore(store, where.repository), jobs: new JobIndexStore(store, where.repository), repository: where.repository })
  return current
}

/** Why a receiving job ended without an answer, in words (the hand-off's `why`). */
export function endedWithout(state: 'succeeded' | 'failed' | 'aborted' | 'paused', detail: string): string {
  switch (state) {
    case 'succeeded': return `its job finished without answering it (its report: ${detail.slice(0, 300) || 'none'})`
    case 'failed': return `its job failed (${detail.slice(0, 300)})`
    case 'aborted': return `its job was cancelled (${detail.slice(0, 300)})`
    case 'paused': return 'its job stopped before answering'
  }
}

export { HandoffError }

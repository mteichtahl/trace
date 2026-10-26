/**
 * Delegation from a specialist to the retained worker, inside one runtime process.
 *
 *   specialist job (job.ts)  registers itself here → a token, given to its Claude session's MCP server only
 *                            (TRACE_DELEGATE_URL, TRACE_DELEGATE_TOKEN)
 *   agent.delegate (src/tools/agent/tools.ts, in that MCP server)
 *                            POST /delegate        { token, brief, acceptance, branch? } → { accepted, jobId }
 *                            POST /delegate/status { token, jobId }                      → the worker job's state
 *   this module              checks the token, starts a worker job (a delegated task: the worker's own prompt,
 *                            src/agents/worker/prompt.ts, with the brief and acceptance criteria as its request),
 *                            and answers status for that parent's own children only
 *
 * The worker runs in the specialist's checkout (the specialist is blocked in its tool call meanwhile), so the runs
 * the specialist recorded are in the tree the worker commits, and the specialist checks the worker's result there.
 *
 * Depth 1: only a registered specialist job holds a token; a delegated job is never registered, gets no token and is
 * not offered agent.delegate. One delegation at a time per specialist. The endpoints answer loopback callers only
 * (AgentCore forwards /invocations and /ping, nothing else), and tokens are compared in constant time.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { TraceConfig } from '../../core/config.js'
import { SPECIALISTS } from '../index.js'
import { type SpecialistKind, WORKER } from '../kinds.js'
import { type Accepted, BranchSchema, type DelegatedTaskJob, type JobInfo, type JobPayload } from './schemas.js'

/** What the worker inherits from the specialist job that delegates. */
export interface ParentJob {
  jobId: string
  kind: SpecialistKind
  repository: string
  /** The specialist's checkout: the worker works in it. */
  dir: string
  /** The specialist's settings (from the default branch): never re-read from a PR's tree. */
  cfg: TraceConfig
  /** The branch the specialist is on. */
  branch: string
  defaultBranch: string
  /** The memory session the worker continues. */
  session: string
}

export const DelegateRequest = z.object({
  token: z.string().min(16).max(200),
  brief: z.string().min(1).max(20_000),
  acceptance: z.array(z.string().min(1).max(1000)).min(1).max(20),
  branch: BranchSchema.optional(),
}).strict()
export type DelegateRequest = z.infer<typeof DelegateRequest>

export const DelegateStatusRequest = z.object({ token: z.string().min(16).max(200), jobId: z.string().min(1).max(64) }).strict()

export class DelegationError extends Error {
  override name = 'DelegationError'
  constructor(message: string, readonly status = 400) { super(message) }
}

/** The worker's request: the specialist's brief and acceptance criteria, as the task's request. */
export function delegatedRequest(kind: SpecialistKind, parentJobId: string, brief: string, acceptance: readonly string[]): string {
  return [
    `The ${SPECIALISTS[kind].title} specialist (job ${parentJobId}) delegated this to you. Its brief:`,
    '',
    brief.trim(),
    '',
    'ACCEPTANCE CRITERIA. The specialist checks each one with its own tools after you finish, in this same checkout:',
    ...acceptance.map((a, i) => `${i + 1}. ${a.trim()}`),
    '',
    'Meet every criterion. You work in the specialist\'s checkout: uncommitted files in it (such as .trace/project.db',
    'with its runs) are part of the work; commit them when the brief says so, and never discard them. End your session',
    'with one line per criterion saying how you met it, or why you could not.',
  ].join('\n')
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

interface Entry { parent: ParentJob; token: string; children: string[]; active: string | null }

export interface Delegations {
  /** Register a running specialist job; returns its token. */
  register(parent: ParentJob): string
  unregister(jobId: string): void
  /** The specialist job a delegated task belongs to (for the runner), or null once it ended. */
  parent(jobId: string): ParentJob | null
  /** Start a worker job for the token's specialist. */
  start(req: DelegateRequest, startJob: (p: JobPayload) => Accepted): Accepted
  /** One of the token's own children, or throws. */
  status(token: string, jobId: string, jobStatus: (id: string) => JobInfo[]): JobInfo
}

export function createDelegations(): Delegations {
  const byJob = new Map<string, Entry>()
  const byToken = (token: string): Entry => {
    for (const e of byJob.values()) if (same(e.token, token)) return e
    throw new DelegationError('not a running specialist job: delegation is refused', 403)
  }
  return {
    register(parent) {
      const token = randomBytes(32).toString('hex')
      byJob.set(parent.jobId, { parent, token, children: [], active: null })
      return token
    },
    unregister(jobId) { byJob.delete(jobId) },
    parent(jobId) { return byJob.get(jobId)?.parent ?? null },
    start(req, startJob) {
      const e = byToken(req.token)
      if (e.active) throw new DelegationError(`a delegation is still running for this specialist (${e.active})`, 409)
      const p = e.parent
      const payload: DelegatedTaskJob = {
        kind: 'task', agent: WORKER, repository: p.repository,
        request: delegatedRequest(p.kind, p.jobId, req.brief, req.acceptance),
        requestedBy: `the trace ${p.kind} specialist (job ${p.jobId})`,
        // never the default branch: a specialist on it (an issue) gets a branch of its own for the worker
        branch: req.branch ?? (p.branch === p.defaultBranch ? `${p.cfg.worker.own_branch_prefix || 'claude/'}${p.kind}-${p.jobId.replace(/^job-/, '')}` : p.branch),
        delegation: { parentJobId: p.jobId, specialist: p.kind, acceptance: [...req.acceptance], depth: 1 },
      }
      if (payload.branch === p.defaultBranch) throw new DelegationError(`the worker never works on the default branch (${p.defaultBranch}): give another branch`)
      const r = startJob(payload)
      if (r.accepted) { e.children.push(r.jobId); e.active = r.jobId }
      return r
    },
    status(token, jobId, jobStatus) {
      const e = byToken(token)
      if (!e.children.includes(jobId)) throw new DelegationError(`${jobId} is not a job this specialist delegated`, 404)
      const j = jobStatus(jobId)[0]
      if (!j) throw new DelegationError(`${jobId} is no longer known`, 404)
      if (j.state !== 'running' && e.active === jobId) e.active = null
      return j
    },
  }
}

let current: Delegations | null = null

/** This process's delegations (shared by the runner and the server). */
export function defaultDelegations(): Delegations {
  current ??= createDelegations()
  return current
}

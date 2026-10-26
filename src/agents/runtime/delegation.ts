/**
 * Delegation from a specialist to the retained worker, inside one runtime process.
 *
 *   specialist job (job.ts)  registers itself here → a token, given to its Claude session's MCP server only
 *                            (TRACE_DELEGATE_URL, TRACE_DELEGATE_TOKEN)
 *   agent.delegate (src/tools/agent/tools.ts, in that MCP server)
 *                            POST /delegate        { token, brief, acceptance, branch? } → { accepted, jobId }
 *                            POST /delegate/status { token, jobId }                      → the worker job's state
 *                            POST /delegate/cancel { token, jobId, reason? }             → stops it (the tool's timeout)
 *   this module              checks the token, starts a worker job (a delegated task: the worker's own prompt,
 *                            src/agents/worker/prompt.ts, with the brief and acceptance criteria as its request),
 *                            and answers status and cancel for that parent's own children only
 *
 * STUCK DELEGATIONS. A worker never outlives its specialist: jobs.ts aborts it (its AbortController) when the
 * specialist job is aborted or ends, and agent.delegate cancels it when its wait times out. Either way the delegation
 * is `cancelled`, and the specialist may delegate again (still one at a time), as it may after a failed one.
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
  /** The default branch's CLAUDE.md, for the worker's system prompt. */
  notes?: string | null
}

export const DelegateRequest = z.object({
  token: z.string().min(16).max(200),
  brief: z.string().min(1).max(15_000),
  acceptance: z.array(z.string().min(1).max(1000)).min(1).max(20),
  branch: BranchSchema.optional(),
}).strict()
export type DelegateRequest = z.infer<typeof DelegateRequest>

export const DelegateStatusRequest = z.object({ token: z.string().min(16).max(200), jobId: z.string().min(1).max(64) }).strict()
/** POST /delegate/cancel: stop the token's own worker job (agent.delegate's timeout). */
export const DelegateCancelRequest = DelegateStatusRequest.extend({ reason: z.string().min(1).max(500).optional() }).strict()

/**
 * Where a delegation stands. `cancelled`: its worker was aborted (the delegation timed out, or its specialist was
 * aborted or ended); the specialist may delegate again, still one at a time.
 */
export type DelegationState = 'running' | 'succeeded' | 'failed' | 'cancelled'
export const delegationStateOf = (j: Pick<JobInfo, 'state'>): DelegationState =>
  (j.state === 'aborted' ? 'cancelled' : j.state)

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

interface Entry { parent: ParentJob; token: string; children: Map<string, DelegationState>; active: string | null }

export interface Delegations {
  /** Register a running specialist job; returns its token. */
  register(parent: ParentJob): string
  unregister(jobId: string): void
  /** The specialist job a delegated task belongs to (for the runner), or null once it ended. */
  parent(jobId: string): ParentJob | null
  /**
   * Start a worker job for the token's specialist: one at a time. With `jobStatus`, the active one is looked up first,
   * so a delegation that failed or was cancelled no longer blocks the next.
   */
  start(req: DelegateRequest, startJob: (p: JobPayload) => Accepted, jobStatus?: (id: string) => JobInfo[]): Accepted
  /** One of the token's own children (and where its delegation stands), or throws. */
  status(token: string, jobId: string, jobStatus: (id: string) => JobInfo[]): JobInfo & { delegation: DelegationState }
  /** Abort one of the token's own running children (jobs.abort) and mark its delegation cancelled. */
  cancel(token: string, jobId: string, reason: string, abort: (id: string, reason: string) => Promise<boolean>, jobStatus: (id: string) => JobInfo[]): Promise<DelegationState>
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
      byJob.set(parent.jobId, { parent, token, children: new Map(), active: null })
      return token
    },
    unregister(jobId) { byJob.delete(jobId) },
    parent(jobId) { return byJob.get(jobId)?.parent ?? null },
    start(req, startJob, jobStatus) {
      const e = byToken(req.token)
      if (e.active && jobStatus) {
        // the last one ended (failed, cancelled, succeeded) or is no longer known: it no longer blocks
        const j = jobStatus(e.active)[0]
        if (!j || j.state !== 'running') settle(e, e.active, j ? delegationStateOf(j) : 'cancelled')
      }
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
      if (r.accepted) { e.children.set(r.jobId, 'running'); e.active = r.jobId }
      return r
    },
    status(token, jobId, jobStatus) {
      const e = byToken(token)
      const known = e.children.get(jobId)
      if (!known) throw new DelegationError(`${jobId} is not a job this specialist delegated`, 404)
      const j = jobStatus(jobId)[0]
      if (!j) throw new DelegationError(`${jobId} is no longer known`, 404)
      // a cancel already said so; otherwise the job's own state decides
      const state = known === 'cancelled' ? 'cancelled' : delegationStateOf(j)
      if (state !== 'running') settle(e, jobId, state)
      return { ...j, delegation: state }
    },
    async cancel(token, jobId, reason, abort, jobStatus) {
      const e = byToken(token)
      const known = e.children.get(jobId)
      if (!known) throw new DelegationError(`${jobId} is not a job this specialist delegated`, 404)
      if (known !== 'running') return known
      const j = jobStatus(jobId)[0]
      if (j && j.state !== 'running') { const s = delegationStateOf(j); settle(e, jobId, s); return s }
      await abort(jobId, `cancelled: ${reason}`)
      settle(e, jobId, 'cancelled')
      return 'cancelled'
    },
  }
}

function settle(e: Entry, jobId: string, state: DelegationState): void {
  if (state === 'running') return
  e.children.set(jobId, state)
  if (e.active === jobId) e.active = null
}

let current: Delegations | null = null

/** This process's delegations (shared by the runner and the server). */
export function defaultDelegations(): Delegations {
  current ??= createDelegations()
  return current
}

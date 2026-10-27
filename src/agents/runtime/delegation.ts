/**
 * Delegation from a specialist to the retained worker, inside one runtime process.
 *
 *   specialist job (job.ts)  registers itself here → a token, given to its Claude session's MCP server only
 *                            (TRACE_DELEGATE_URL, TRACE_DELEGATE_TOKEN)
 *   agent.delegate (src/tools/agent/tools.ts, in that MCP server)
 *                            POST /delegate        { token, brief, acceptance, branch? } → { accepted, jobId }
 *                            POST /delegate/wait   { token, jobId, timeoutS }            → the worker job's state the
 *                                                  moment it ends, or as it stands after timeoutS (at most 240 s)
 *                            POST /delegate/status { token, jobId }                      → the worker job's state now
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
import { type Composed, Composer, type Layers, NO_LAYERS } from '../../prompts/resolve.js'
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
  /** The prompt overrides the specialist runs with (the worker's prompt and the delegation's wording use them too). */
  prompts?: Layers | undefined
}

export const DelegateRequest = z.object({
  token: z.string().min(16).max(200),
  brief: z.string().min(1).max(15_000),
  acceptance: z.array(z.string().min(1).max(1000)).min(1).max(20),
  branch: BranchSchema.optional(),
}).strict()
export type DelegateRequest = z.infer<typeof DelegateRequest>

export const DelegateStatusRequest = z.object({ token: z.string().min(16).max(200), jobId: z.string().min(1).max(64) }).strict()
/**
 * The longest one POST /delegate/wait holds (s): below undici's 300 s headers timeout, which a fetch that waits for
 * an answer would otherwise hit. A longer timeoutS is held this long; the caller asks again.
 */
export const MAX_WAIT_S = 240
/** POST /delegate/wait: the token's own worker job, answered the moment it ends (or when timeoutS passes). */
export const DelegateWaitRequest = DelegateStatusRequest.extend({ timeoutS: z.number().min(0).max(24 * 3600) }).strict()
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

/** The worker's request: the specialist's brief and acceptance criteria (delegate.brief, delegate.request in the prompt catalog). */
export function composeDelegated(kind: SpecialistKind, parentJobId: string, brief: string, acceptance: readonly string[], layers: Layers = NO_LAYERS): Composed {
  return new Composer(layers)
    .add('delegate.brief', { specialist: SPECIALISTS[kind].title, parent_job: parentJobId })
    .add('delegate.request', { brief: brief.trim(), acceptance: acceptance.map((a, i) => `${i + 1}. ${a.trim()}`) })
    .done()
}

export function delegatedRequest(kind: SpecialistKind, parentJobId: string, brief: string, acceptance: readonly string[], layers: Layers = NO_LAYERS): string {
  return composeDelegated(kind, parentJobId, brief, acceptance, layers).text
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
  /** The specialist job holding this token (server.ts attributes a /delegate/wait's wait to it), or throws (403). */
  parentOfToken(token: string): ParentJob
  /**
   * Start a worker job for the token's specialist: one at a time. With `jobStatus`, the active one is looked up first,
   * so a delegation that failed or was cancelled no longer blocks the next.
   */
  start(req: DelegateRequest, startJob: (p: JobPayload) => Accepted, jobStatus?: (id: string) => JobInfo[]): Accepted
  /** One of the token's own children (and where its delegation stands), or throws. */
  status(token: string, jobId: string, jobStatus: (id: string) => JobInfo[]): JobInfo & { delegation: DelegationState }
  /**
   * The same as status, once the child has ended (waitForEnd: an event, not a timer) or timeoutMs passed or the signal
   * aborted (then as it stands, still running). The token is checked before anything waits.
   */
  wait(token: string, jobId: string, o: { timeoutMs: number; signal?: AbortSignal | undefined },
    jobs: { jobStatus: (id: string) => JobInfo[]; waitForEnd: (id: string, o: { timeoutMs?: number; signal?: AbortSignal | undefined }) => Promise<JobInfo | null> }): Promise<JobInfo & { delegation: DelegationState }>
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
    parentOfToken(token) { return byToken(token).parent },
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
        request: delegatedRequest(p.kind, p.jobId, req.brief, req.acceptance, p.prompts),
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
    async wait(token, jobId, o, jobs) {
      const now = this.status(token, jobId, jobs.jobStatus)
      if (now.delegation !== 'running') return now
      await jobs.waitForEnd(jobId, o)
      return this.status(token, jobId, jobs.jobStatus)
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

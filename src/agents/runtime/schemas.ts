/**
 * The contract of the trace agent on Bedrock AgentCore Runtime: what POST /invocations accepts and what it answers.
 * Shared by the runtime (src/agents/runtime/server.ts), the dispatcher (src/agents/runtime/dispatch.ts) and the API runtime (src/api),
 * which starts the same jobs in-process.
 */
import { z } from 'zod'
import type { PromptRecord } from '../../prompts/resolve.js'
import { WorkItemSchema } from '../../harness/worker.js'
import { type Route, SPECIALIST_KINDS, SpecialistKindSchema, WORKER } from '../kinds.js'

/** owner/repo, GitHub's own character set (no "..", no leading dash or dot). */
export const RepositorySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/, 'expected owner/repo')
  .refine((s) => !s.includes('..'), 'expected owner/repo')

/** A git branch name that is safe as one argv element: no leading dash, no "..", no spaces or control characters. */
export const BranchSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/, 'not a valid branch name')
  .refine((s) => !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock') && !s.includes('//'), 'not a valid branch name')

/**
 * The caller's trace context, in the payload as well as in InvokeAgentRuntime's traceparent/tracestate/baggage
 * headers: AgentCore's documentation does not say those headers reach the container, so the runtime continues from
 * the payload when the request carries no traceparent of the same trace (src/agents/runtime/observe.ts).
 */
export const TraceContextSchema = z.object({
  traceparent: z.string().regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/, 'a W3C traceparent'),
  tracestate: z.string().max(512).optional(),
  baggage: z.string().max(8192).optional(),
}).strict()
export type TraceContext = z.infer<typeof TraceContextSchema>

export const WorkItemPayload = z.object({
  kind: z.literal('work-item'),
  repository: RepositorySchema,
  item: WorkItemSchema,
  runUrl: z.string().url().optional(),
  trace: TraceContextSchema.optional(),
}).strict()

export const SweepPayload = z.object({
  kind: z.literal('sweep'),
  repositories: z.array(RepositorySchema).min(1).max(200),
  trace: TraceContextSchema.optional(),
}).strict()

/** The longest a status invocation is held (s), below undici's 300 s headers timeout. */
export const MAX_STATUS_WAIT_S = 240

/**
 * `afterVersion` with `waitS`: hold the answer until a job in scope (jobId's, or any) changes after that version (the
 * `version` an earlier answer gave), or waitS passes; then answer as usual. Without both, answered at once.
 */
export const StatusPayload = z.object({
  kind: z.literal('status'),
  jobId: z.string().max(64).optional(),
  afterVersion: z.number().int().min(0).optional(),
  waitS: z.number().min(0).max(MAX_STATUS_WAIT_S).optional(),
  trace: TraceContextSchema.optional(),
}).strict()

/** Wake one timer wait of this process (src/core/wait.ts checkNow) for a check now: what a person's "check now" does. */
export const CheckNowPayload = z.object({
  kind: z.literal('check-now'),
  waitId: z.string().min(1).max(64),
  trace: TraceContextSchema.optional(),
}).strict()

/**
 * Cancel one running job of this process (a person's Cancel, through the API's job.control): its AbortController stops
 * Claude and its git commands, its delegated worker goes with it, and the graphics card or CPU jobs its tools started
 * on AWS Batch are terminated when its tool server closes (src/gpu/inflight.ts). Answers once the job has ended, or
 * after a short grace.
 */
export const CancelPayload = z.object({
  kind: z.literal('cancel'),
  jobId: z.string().min(1).max(64),
  reason: z.string().min(1).max(300).default('cancelled by a person'),
  trace: TraceContextSchema.optional(),
}).strict()

/**
 * The agents a person's task can be given to: the specialists (src/agents). Leave `agent` out and the job is routed
 * (src/agents/router.ts). The generic worker is not among them: only a specialist starts it (agent.delegate).
 */
export const TASK_AGENTS = SPECIALIST_KINDS

/** A free-form request from an authorised person (the API runtime): done on a claude/task-<slug> branch, pushed, PR opened. */
export const TaskPayload = z.object({
  kind: z.literal('task'),
  repository: RepositorySchema,
  request: z.string().min(1).max(20_000),
  requestedBy: z.string().min(1).max(200),
  /** The person's Cognito sub (immutable): their person memory is keyed on it; requestedBy (an email) is for reading. */
  requestedBySub: z.string().min(1).max(200).optional(),
  branch: BranchSchema.optional(),
  /** An issue or PR to report back on, when the request came from one. */
  issue: z.number().int().positive().optional(),
  /** Which specialist does it; routed when absent. */
  agent: SpecialistKindSchema.optional(),
  trace: TraceContextSchema.optional(),
}).strict()

/** What a specialist's agent.delegate hands the worker, besides the brief (the task's request). */
export const DelegationSchema = z.object({
  /** The specialist's job: its checkout, settings and branch are the worker's (src/agents/runtime/delegation.ts). */
  parentJobId: z.string().min(1).max(64),
  specialist: SpecialistKindSchema,
  acceptance: z.array(z.string().min(1).max(1000)).min(1).max(20),
  /** Always 1: a delegated worker cannot delegate. */
  depth: z.literal(1),
}).strict()
export type Delegation = z.infer<typeof DelegationSchema>

/**
 * A worker job a specialist started (internal only: never accepted on /invocations or through the API). The request
 * is the specialist's brief with its acceptance criteria; it runs in the specialist's checkout.
 */
export const DelegatedTaskPayload = TaskPayload.omit({ agent: true, issue: true }).extend({
  agent: z.literal(WORKER),
  delegation: DelegationSchema,
}).strict()

/**
 * One tool call the API forwards to the project's worker runtime (src/agents/runtime/tool.ts): no model and no job,
 * the tool's answer in the response. The worker clones the project's default branch, refuses hardware tools and
 * paths outside the clone, and runs the tool through the registry. The API checked the person's access first.
 */
export const ToolPayload = z.object({
  kind: z.literal('tool'),
  repository: RepositorySchema,
  name: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'a tool name (area.tool)'),
  args: z.record(z.string(), z.unknown()).default({}),
  trace: TraceContextSchema.optional(),
}).strict()
export type ToolJob = z.infer<typeof ToolPayload>

export const InvocationSchema = z.discriminatedUnion('kind', [WorkItemPayload, SweepPayload, StatusPayload, CheckNowPayload, CancelPayload, TaskPayload, ToolPayload])
export type Invocation = z.infer<typeof InvocationSchema>
export type WorkItemJob = z.infer<typeof WorkItemPayload>
export type SweepJob = z.infer<typeof SweepPayload>
export type TaskJob = z.infer<typeof TaskPayload>
export type DelegatedTaskJob = z.infer<typeof DelegatedTaskPayload>
/** What can be started as a job (everything but status, check-now, cancel and tool); a delegated task only from inside the runtime. */
export type JobPayload = WorkItemJob | SweepJob | TaskJob | DelegatedTaskJob

export const AcceptedSchema = z.object({
  accepted: z.boolean(),
  jobId: z.string(),
  reason: z.string().optional(),
}).loose()
export type Accepted = z.infer<typeof AcceptedSchema>

export type JobState = 'running' | 'succeeded' | 'failed' | 'aborted'

export interface JobInfo {
  id: string
  kind: JobPayload['kind']
  key: string
  repository?: string
  number?: number
  state: JobState
  startedAt: string
  endedAt?: string
  summary?: string
  error?: string
  /** The agent that does it: a specialist kind, or worker for a delegated job. */
  agent?: string
  /** How a specialist job was routed (set once the runner has routed it). */
  route?: Route
  /** A delegated job: the specialist job that started it. */
  parentJobId?: string
  /** Which prompt versions its model calls were built from: id, layer, version and the template's sha (never the text). */
  prompts?: PromptRecord[]
  log: string[]
}

/** A delegated worker job (from agent.delegate). */
export const isDelegated = (p: JobPayload): p is DelegatedTaskJob => p.kind === 'task' && 'delegation' in p

// ------------------------------------------------------------------ single-project mode

/** An invocation or job for another project than the one this runtime serves (TRACE_PROJECT): answered 403. */
export class WrongProject extends Error {
  override name = 'WrongProject'
  readonly status = 403
}

/** The repositories an invocation is about (none for status, check-now and cancel). */
export function repositoriesOf(p: Invocation | JobPayload): string[] {
  switch (p.kind) {
    case 'work-item': case 'task': case 'tool': return [p.repository]
    case 'sweep': return [...p.repositories]
    case 'status': case 'check-now': case 'cancel': return []
  }
}

/**
 * Refuse anything for another project. `project` is TRACE_PROJECT (owner/repo): each project's worker runtime has
 * its own, and its role reaches only that project's resources, so this is the friendly answer to what IAM would
 * refuse anyway. Without a project (a local run, tests) everything is allowed.
 */
export function checkProject(p: Invocation | JobPayload, project: string | undefined): void {
  const mine = project?.trim().toLowerCase()
  if (!mine) return
  const other = repositoriesOf(p).filter((r) => r.toLowerCase() !== mine)
  if (other.length) throw new WrongProject(`this runtime serves ${mine} only, not ${other.join(', ')}`)
}

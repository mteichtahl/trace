/**
 * The contract of the trace agent on Bedrock AgentCore Runtime: what POST /invocations accepts and what it answers.
 * Shared by the runtime (src/agents/runtime/server.ts), the dispatcher (src/agents/runtime/dispatch.ts) and the API runtime (src/api),
 * which starts the same jobs in-process.
 */
import { z } from 'zod'
import { WorkItemSchema } from '../../harness/worker.js'

/** owner/repo, GitHub's own character set (no "..", no leading dash or dot). */
export const RepositorySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/, 'expected owner/repo')
  .refine((s) => !s.includes('..'), 'expected owner/repo')

/** A git branch name that is safe as one argv element: no leading dash, no "..", no spaces or control characters. */
export const BranchSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/, 'not a valid branch name')
  .refine((s) => !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock') && !s.includes('//'), 'not a valid branch name')

export const WorkItemPayload = z.object({
  kind: z.literal('work-item'),
  repository: RepositorySchema,
  item: WorkItemSchema,
  runUrl: z.string().url().optional(),
}).strict()

export const SweepPayload = z.object({
  kind: z.literal('sweep'),
  repositories: z.array(RepositorySchema).min(1).max(200),
}).strict()

export const StatusPayload = z.object({
  kind: z.literal('status'),
  jobId: z.string().max(64).optional(),
}).strict()

/** The agents a task can be given to: the worker (code changes), or the rendering agent (src/agents/render/prompt.ts). */
export const TASK_AGENTS = ['worker', 'render'] as const

/** A free-form request from an authorised person (the API runtime): done on a claude/task-<slug> branch, pushed, PR opened. */
export const TaskPayload = z.object({
  kind: z.literal('task'),
  repository: RepositorySchema,
  request: z.string().min(1).max(20_000),
  requestedBy: z.string().min(1).max(200),
  branch: BranchSchema.optional(),
  /** An issue or PR to report back on, when the request came from one. */
  issue: z.number().int().positive().optional(),
  /** Which agent does it (default worker). */
  agent: z.enum(TASK_AGENTS).optional(),
}).strict()

export const InvocationSchema = z.discriminatedUnion('kind', [WorkItemPayload, SweepPayload, StatusPayload, TaskPayload])
export type Invocation = z.infer<typeof InvocationSchema>
export type WorkItemJob = z.infer<typeof WorkItemPayload>
export type SweepJob = z.infer<typeof SweepPayload>
export type TaskJob = z.infer<typeof TaskPayload>
/** What can be started as a job (everything but status). */
export type JobPayload = WorkItemJob | SweepJob | TaskJob

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
  log: string[]
}

// ------------------------------------------------------------------ single-project mode

/** An invocation or job for another project than the one this runtime serves (TRACE_PROJECT): answered 403. */
export class WrongProject extends Error {
  override name = 'WrongProject'
  readonly status = 403
}

/** The repositories an invocation is about (none for status). */
export function repositoriesOf(p: Invocation): string[] {
  switch (p.kind) {
    case 'work-item': case 'task': return [p.repository]
    case 'sweep': return [...p.repositories]
    case 'status': return []
  }
}

/**
 * Refuse anything for another project. `project` is TRACE_PROJECT (owner/repo): each project's worker runtime has
 * its own, and its role reaches only that project's resources, so this is the friendly answer to what IAM would
 * refuse anyway. Without a project (a local run, tests) everything is allowed.
 */
export function checkProject(p: Invocation, project: string | undefined): void {
  const mine = project?.trim().toLowerCase()
  if (!mine) return
  const other = repositoriesOf(p).filter((r) => r.toLowerCase() !== mine)
  if (other.length) throw new WrongProject(`this runtime serves ${mine} only, not ${other.join(', ')}`)
}

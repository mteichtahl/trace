/**
 * The retained generic worker's prompts. The worker is started only by a specialist (agent.delegate,
 * src/agents/runtime/delegation.ts): its task prompt carries the specialist's brief and acceptance criteria as the
 * request, with the same rules and guardrails as ever. workItemPrompt (the harness's promptFor, re-worded for where
 * it runs) is what a specialist follows itself in GitHub Actions, where there is no runtime to delegate to.
 */
import { createHash } from 'node:crypto'
import type { TraceConfig } from '../../core/config.js'
import { type WorkItem, addValidate, promptFor } from '../../harness/worker.js'
import type { TaskJob } from '../runtime/schemas.js'
import { type Composed, Composer, type Layers, NO_LAYERS } from '../../prompts/resolve.js'

const WHERE = 'on Amazon Bedrock AgentCore Runtime'

/** What the worker's task prompt reads of a task: a person's, or a specialist's delegation (its brief as the request). */
export type TaskLike = Pick<TaskJob, 'repository' | 'request' | 'requestedBy'> & { issue?: number | undefined }

export function workItemPrompt(item: WorkItem, cfg: TraceConfig, repository: string, layers: Layers = NO_LAYERS): string {
  return promptFor(item, cfg, repository, undefined, { where: WHERE, prompts: layers })
}

/** claude/task-<words>-<hash6>: stable for one request, readable, and safe as a git ref. */
export function taskBranch(job: Pick<TaskJob, 'request' | 'branch'>, cfg: TraceConfig): string {
  if (job.branch) return job.branch
  const words = job.request.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  const hash = createHash('sha256').update(job.request).digest('hex').slice(0, 6)
  return `${cfg.worker.own_branch_prefix || 'claude/'}task-${words ? `${words}-` : ''}${hash}`
}

const quoted = (text: string): string => text.split('\n').map((l) => `> ${l}`).join('\n')

/** The worker's task prompt, from the prompt catalog (src/prompts/catalog.ts) with the job's overrides. */
export function composeTask(job: TaskLike, cfg: TraceConfig, branch: string, layers: Layers = NO_LAYERS): Composed {
  const p = new Composer(layers)
  const from = JSON.stringify(job.requestedBy)
  p.add('worker.role', { repository: job.repository, where: WHERE }).add('worker.data.task')
  p.add('worker.request', { from, request: quoted(job.request) })
  p.add('worker.tools').add('worker.knowledge')
  p.add('worker.task', { branch, default_branch: cfg.branch, requested_by: job.requestedBy })
  addValidate(p, cfg)
  const esc = cfg.worker.escalate_to
  if (job.issue) p.add('worker.report.issue', { issue: job.issue, mention: esc ? p.text('mention.starting', { escalate_to: esc }) : '' })
  else p.add('worker.report.none', { from })
  p.add('worker.guardrails')
  return p.done()
}

export function taskPrompt(job: TaskLike, cfg: TraceConfig, branch: string, layers: Layers = NO_LAYERS): string {
  return composeTask(job, cfg, branch, layers).text
}

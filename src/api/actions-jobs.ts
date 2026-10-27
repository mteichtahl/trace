/**
 * Controlling a running job: what the job system can genuinely do, and nothing it cannot.
 *
 *   job.control   write on its project   { id, op }: pause | resume | cancel | move_up → { ok, kept? } or
 *                                        { ok: false, reason } in plain words. Reviewers cannot (write is needed);
 *                                        another project's job, and one that does not exist, get "no access"
 *
 * What each op is today (src/agents/runtime/jobs.ts, server.ts, src/gpu/batch.ts):
 *
 *   cancel    yes   the job's AbortController on its worker (invocation kind `cancel`): Claude and its git commands
 *                   stop, its delegated worker goes with it, and the graphics card or CPU jobs its tools submitted to
 *                   AWS Batch are terminated when its tool server closes (src/gpu/inflight.ts). `kept`: what stays
 *   pause     no    a job is one Claude session in one microVM; nothing can hold it and carry on later
 *   resume    no    nothing is ever paused
 *   move_up   no    jobs start the moment they are asked for, one per item, so there is no queue of trace's own to
 *                   reorder; the AWS Batch queues order by submission and the stack gives them no scheduling policy
 *
 * The job's view (`job`, and every job view the API answers) carries `controls`: the ops the API can do for it now,
 * so the app shows only those (jobControls).
 */
import { z } from 'zod'
import { AccessDenied, isAdmin, require_ } from '../core/access.js'
import { type Context, type JobView, type JobsApi, NO_ACCESS, def } from './action-kit.js'

export const JOB_OPS = ['pause', 'resume', 'cancel', 'move_up'] as const
export type JobOp = (typeof JOB_OPS)[number]

/** Why an op cannot be done, in plain words (an op not here can be). */
export const CANNOT: Readonly<Partial<Record<JobOp, string>>> = {
  pause: 'A running job cannot be paused: it is one agent session that cannot be held and resumed later. Cancel it instead; commits it already pushed are kept.',
  resume: 'Nothing is paused: jobs cannot be paused.',
  move_up: 'Jobs are not queued: each starts as soon as it is asked for, so there is nothing to move up.',
}

/** The ops the API can do for a job as it is now (only a running job can be cancelled; none without a cancel). */
export function jobControls(j: Pick<JobView, 'state'>, jobs: Pick<JobsApi, 'cancel'>): JobOp[] {
  return j.state === 'running' && jobs.cancel ? ['cancel'] : []
}

/** A job view with its controls. */
export const withControls = <J extends JobView>(j: J, jobs: Pick<JobsApi, 'cancel'>): J & { controls: JobOp[] } => ({ ...j, controls: jobControls(j, jobs) })

/** need 'job' with write: the project from the job id, checked before its worker is asked anything. */
async function writeAccess(id: string, ctx: Context): Promise<JobsApi> {
  const jobs = await ctx.deps.jobs()
  const repo = jobs.repositoryOf(id)
  if (!repo) throw new AccessDenied(NO_ACCESS)
  if (!isAdmin(ctx.principal)) {
    // the same "no access" for a project they are not on; a reviewer on it is refused write
    await require_(ctx.principal, repo, 'read')
    await require_(ctx.principal, repo, 'write')
  }
  return jobs
}

export const JOB_ACTIONS = {
  'job.control': def('job', z.object({ id: z.string().min(1).max(200), op: z.enum(JOB_OPS), reason: z.string().trim().max(300).optional() }), async (a, ctx) => {
    const jobs = await writeAccess(a.id, ctx)
    const cannot = CANNOT[a.op]
    if (cannot) return { ok: false, op: a.op, reason: cannot }
    if (!jobs.cancel) return { ok: false, op: a.op, reason: 'This installation cannot cancel jobs from the app: the API has no worker runtime to ask.' }
    const by = ctx.principal.email ?? ctx.principal.sub
    const r = await jobs.cancel(a.id, `cancelled by ${by}${a.reason ? `: ${a.reason}` : ''}`)
    if (!r.ok) return { ok: false, op: a.op, state: r.state, reason: r.reason ?? 'The job is not running.' }
    return { ok: true, op: a.op, state: r.state, ...(r.kept ? { kept: r.kept } : {}) }
  }),
}

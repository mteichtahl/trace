/**
 * A project's jobs, and controlling them: what the job system can genuinely do, and nothing it cannot.
 *
 *   jobs.list     read                   { repo } → { repo, jobs, agents, batch, updatedAt }: the project's job index
 *                                        (src/core/job-index.ts, written by its worker as its jobs change): running,
 *                                        queued, paused and the last day's finished jobs, newest first, each with its
 *                                        controls; per agent its status (Working, Queued, Waiting on a person, Stuck,
 *                                        Idle), what it is doing now, its queue in order, and the last day's runs; the
 *                                        graphics card and CPU jobs (AWS Batch) its jobs have running. Reviewers see it
 *                                        all with no controls
 *   job.control   write on its project   { id, op, repo? }: pause | resume | cancel | move_up → { ok, kept? } or
 *                                        { ok: false, reason } in plain words. Reviewers cannot (write is needed);
 *                                        another project's job, and one that does not exist, get "no access"
 *
 * What each op does (src/agents/runtime/jobs.ts, job.ts, job-index.ts):
 *
 *   pause     running task   asks its worker (invocation kind `pause`): it stops before Claude's next tool call (the
 *                            step in progress finishes), commits and pushes its work on its branch, keeps its
 *                            transcript, and ends `paused`. Answered at once ("pausing"); its state follows as an event
 *             queued job     held in the queue (the journey record's job_controls): it does not start until resumed
 *   resume    paused job     a new task on the paused job's branch, carrying it on (`resume`): its conversation
 *                            continues when its transcript was kept, else it is told what was done
 *             held job       released: it starts at its turn
 *   cancel    running/queued the job's AbortController on its worker (invocation kind `cancel`): Claude and its git
 *                            commands stop, its delegated worker goes with it, and the graphics card or CPU jobs its
 *                            tools submitted are terminated when its tool server closes (src/gpu/inflight.ts)
 *             paused job     discarded: it is not resumed; its branch stays as it is
 *   move_up   queued job     one place up its agent's queue (job_controls.ord)
 *
 * A work item (a workflow's) can only be cancelled: the workflows claim it and would dispatch it again. A delegated
 * worker is controlled through its specialist's job. Every job view (here, `job`, journey.get's jobs) carries
 * `controls`: the ops this person can do for it now, so the app shows only those.
 *
 * People's controls are in the journey record, never in the index: the index is written by an agent's worker, and
 * agents never decide for a person. A queued job reads them when it looks again (on the project's events topic).
 */
import { z } from 'zod'
import { AccessDenied, isAdmin, require_, standing } from '../core/access.js'
import {
  type BatchRow, type JobControl, type JobRow, JobIndexStore, STALE_AFTER_S, indexedHandle, isLive, loadBatch, loadControls, loadJobs, moveUpOrder, putControl, queueOrder, typicalSeconds,
} from '../core/job-index.js'
import { type AgentFacts, loadJourney } from '../core/journey.js'
import { PROJECTS_PREFIX, projectSlug } from '../core/project.js'
import { TaskPayload } from '../agents/runtime/schemas.js'
import { type Context, type JobView, type JobsApi, NO_ACCESS, Repo, agentFacts, def, journeyStore, label, plainly, storeAt, withJourneyDb, writeJourney } from './action-kit.js'

export const JOB_OPS = ['pause', 'resume', 'cancel', 'move_up'] as const
export type JobOp = (typeof JOB_OPS)[number]

/** The agents, in words (src/agents/<kind>/index.ts titles, and the worker). */
export const AGENT_WORDS: Readonly<Record<string, string>> = {
  verify: 'Verification', impl: 'Implementation', ams: 'Analog and mixed-signal', emc: 'EMC', render: 'Rendering', thermal: 'Thermal', worker: 'Worker', sweep: 'trace',
}
export const AGENT_IDS = ['verify', 'impl', 'ams', 'emc', 'render', 'thermal', 'worker'] as const

/** How long finished jobs stay in the list (and count in an agent's day). */
const DAY_S = 86_400

export type ViewState = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'aborted' | 'lost'

/** One job as the app reads it. */
export interface IndexedJob extends JobView {
  id: string; workerJobId: string; kind: string; repository: string; agent: string | null; agentName: string | null; title: string; number: number | null
  startedBy: string | null; yours: boolean; state: ViewState; step: string | null; held: boolean
  queuedAt: string | null; startedAt: string | null; endedAt: string | null
  /** typical seconds for this kind of job by this agent on this project (median of its last 20 that succeeded) */
  typicalS: number | null
  where: string | null; branch: string | null
  /** queued: its place in its agent's queue (1 is next) and what it waits for */
  queue: { position: number; of: number; startsWhen: string } | null
  parentJob: string | null; resumeOf: string | null; resumedBy: string | null; summary: string | null; error: string | null
  pausedBy: string | null; pausedAt: string | null
  controls: JobOp[]
}

const iso = (t: number | null): string | null => (t === null ? null : new Date(t * 1000).toISOString())

/** Why a running job's state is not what its row says: its heartbeat stopped. */
const LOST = `trace lost contact with it: its runtime stopped without a word for more than ${Math.round(STALE_AFTER_S / 60)} minutes`

/**
 * The ops a person may do on a job as it is now. `write`: they may change the project (contributors, admins); `can`:
 * what this installation's API can reach (a worker to pause or cancel).
 */
export function controlsOf(j: Pick<JobRow, 'kind' | 'state' | 'parentJob' | 'resumedBy' | 'session'> & { held: boolean; discarded: boolean; lost: boolean; first: boolean },
  o: { write: boolean; pause: boolean; cancel: boolean }): JobOp[] {
  if (!o.write || j.parentJob || j.lost) return []
  const task = j.kind === 'task'
  const reach = j.session !== null
  switch (j.state) {
    case 'running': return [...(task && o.pause && reach ? ['pause' as const] : []), ...(o.cancel && reach ? ['cancel' as const] : [])]
    case 'queued': return [...(task ? [j.held ? 'resume' as const : 'pause' as const] : []), ...(!j.first ? ['move_up' as const] : []), ...(o.cancel && reach ? ['cancel' as const] : [])]
    case 'paused': return j.discarded || j.resumedBy ? [] : ['resume', 'cancel']
    default: return []
  }
}

/** The job index's rows as views, for this person. */
export function jobViews(repo: string, rows: readonly JobRow[], controls: ReadonlyMap<string, JobControl>, o: { at: number; sub: string; write: boolean; pause: boolean; cancel: boolean }): IndexedJob[] {
  const queues = new Map<string, JobRow[]>()
  const out: IndexedJob[] = []
  for (const j of rows) {
    const finished = j.state === 'succeeded' || j.state === 'failed' || j.state === 'aborted'
    if (finished && o.at - (j.endedAt ?? j.updatedAt) > DAY_S) continue
    const c = controls.get(j.id)
    const lost = j.state === 'running' && !isLive(j, o.at)
    const discarded = j.state === 'paused' && Boolean(c?.discarded)
    let queue: IndexedJob['queue'] = null
    let first = true
    if (j.state === 'queued') {
      const key = j.agent ?? ''
      const q = queues.get(key) ?? queueOrder(rows, controls, j.agent)
      queues.set(key, q)
      const position = q.findIndex((x) => x.id === j.id) + 1
      first = position <= 1
      const startsWhen = c?.held ? `held by ${c.by}: it starts when someone resumes it` : (j.step?.replace(/^queued: /, '') ?? 'starts when it is its turn')
      queue = { position, of: q.length, startsWhen }
    }
    const state: ViewState = lost ? 'lost' : discarded ? 'aborted' : j.state
    out.push({
      id: indexedHandle(repo, j.session, j.id), workerJobId: j.id, kind: j.kind, repository: repo, agent: j.agent, agentName: j.agent ? AGENT_WORDS[j.agent] ?? j.agent : null,
      title: j.title, number: j.number, startedBy: j.requestedBy, yours: j.requestedBySub !== null && j.requestedBySub === o.sub, state,
      step: lost ? LOST : discarded ? `discarded by ${c?.by ?? 'a person'}` : j.step, held: Boolean(c?.held),
      queuedAt: iso(j.queuedAt), startedAt: iso(j.state === 'queued' ? null : j.startedAt), endedAt: iso(j.endedAt),
      typicalS: typicalSeconds(rows, j.kind, j.agent), where: j.where, branch: j.branch, queue,
      parentJob: j.parentJob, resumeOf: j.resumeOf, resumedBy: j.resumedBy, summary: j.summary, error: lost ? LOST : j.error,
      pausedBy: j.pausedBy, pausedAt: iso(j.pausedAt),
      controls: controlsOf({ ...j, held: Boolean(c?.held), discarded, lost, first }, o),
    })
  }
  const rank: Record<ViewState, number> = { running: 0, paused: 1, queued: 2, lost: 3, failed: 4, aborted: 5, succeeded: 6 }
  return out.sort((a, b) => rank[a.state] - rank[b.state] || (a.state === 'queued' && b.state === 'queued' ? (a.queue?.position ?? 0) - (b.queue?.position ?? 0) : 0)
    || (b.startedAt ?? b.queuedAt ?? '').localeCompare(a.startedAt ?? a.queuedAt ?? ''))
}

export type AgentStatus = 'working' | 'queued' | 'waiting_person' | 'stuck' | 'idle'

export interface AgentView {
  id: string; name: string; status: AgentStatus
  /** in words: "Working on …", "Waiting on a person: …" */
  says: string
  now: string[]; queue: string[]
  /** the last day: jobs that ended, how many succeeded, their median time */
  today: { runs: number; succeeded: number; medianS: number | null }
}

/**
 * Each agent's status from the index and the journey's facts. Stuck beats waiting, which beats working: an agent
 * that cannot go on is what a person most needs to see. A question or stuck report counts for an agent when it came
 * from one of its jobs (by job id), or names it (its words) when it has no job.
 */
export function agentViews(jobs: readonly IndexedJob[], facts: AgentFacts, answered: ReadonlySet<string>, dismissed: ReadonlySet<string>, at: number): AgentView[] {
  const jobAgent = new Map(jobs.map((j) => [j.workerJobId, j.agent]))
  const of = (jobId: string | null, words: string): string | null => {
    const byJob = jobId ? jobAgent.get(jobId) : undefined
    if (byJob) return byJob
    return AGENT_IDS.find((a) => words.toLowerCase().includes((AGENT_WORDS[a] ?? a).toLowerCase())) ?? null
  }
  const asks = facts.questions.filter((q) => !answered.has(q.id)).map((q) => ({ agent: of(q.jobId, q.askedBy), text: q.text }))
  const stuck = facts.stuck.filter((s) => s.resolvedAt === null && !dismissed.has(s.id)).map((s) => ({ agent: of(s.jobId, s.agent), text: s.why }))
  return AGENT_IDS.map((id) => {
    const mine = jobs.filter((j) => j.agent === id)
    const now = mine.filter((j) => j.state === 'running')
    const queue = mine.filter((j) => j.state === 'queued').sort((a, b) => (a.queue?.position ?? 0) - (b.queue?.position ?? 0))
    const ended = mine.filter((j) => (j.state === 'succeeded' || j.state === 'failed') && j.endedAt && at - Date.parse(j.endedAt) / 1000 <= DAY_S)
    const times = ended.filter((j) => j.state === 'succeeded' && j.startedAt && j.endedAt).map((j) => (Date.parse(j.endedAt as string) - Date.parse(j.startedAt as string)) / 1000).sort((a, b) => a - b)
    const s = stuck.find((x) => x.agent === id)
    const q = asks.find((x) => x.agent === id)
    const name = AGENT_WORDS[id] ?? id
    const [status, says]: [AgentStatus, string] = s ? ['stuck', `Stuck: ${s.text}`]
      : q ? ['waiting_person', `Waiting on a person: ${q.text}`]
        : now.length ? ['working', `Working on ${now.map((j) => `"${j.title}"`).join(', ')}`]
          : queue.length ? ['queued', `${queue.length} queued; next: "${queue[0]?.title ?? ''}"`]
            : ['idle', 'Idle']
    return {
      id, name, status, says: says.slice(0, 300), now: now.map((j) => j.id), queue: queue.map((j) => j.id),
      today: { runs: ended.length, succeeded: ended.filter((j) => j.state === 'succeeded').length, medianS: times.length ? Math.round(times[Math.floor(times.length / 2)] as number) : null },
    }
  })
}

export const jobIndex = (ctx: Context, repo: string): JobIndexStore => new JobIndexStore(storeAt(ctx, PROJECTS_PREFIX), repo, { scratch: ctx.deps.scratch })

const readControls = async (ctx: Context, repo: string): Promise<Map<string, JobControl>> => withJourneyDb(ctx, repo, (db) => loadControls(db)).catch(() => new Map())

/** Whether this person may change the project (contributor or admin). */
async function writes(ctx: Context, repo: string): Promise<boolean> {
  if (isAdmin(ctx.principal)) return true
  return (await standing(ctx.principal, repo))?.part === 'contributor'
}

/** The project's jobs for this person (after their read check): what jobs.list and journey.get answer. */
export async function listJobs(ctx: Context, repo: string, o: { at?: number } = {}): Promise<{ jobs: IndexedJob[]; batch: (BatchRow & { submittedAt: number })[]; rows: JobRow[] }> {
  const at = o.at ?? Date.now() / 1000
  const [{ result }, controls, write, jobs] = await Promise.all([
    jobIndex(ctx, repo).read((db) => ({ rows: loadJobs(db), batch: loadBatch(db) })),
    readControls(ctx, repo),
    writes(ctx, repo),
    ctx.deps.jobs(),
  ])
  const views = jobViews(repo, result.rows, controls, { at, sub: ctx.principal.sub, write, pause: Boolean(jobs.pause), cancel: Boolean(jobs.cancel) })
  const live = new Set(views.filter((j) => j.state === 'running').map((j) => j.workerJobId))
  return { jobs: views, batch: result.batch.filter((b) => b.endedAt === null && live.has(b.jobId)), rows: result.rows }
}

/** need 'job' with write: the project from the job id, checked before its worker is asked anything. */
async function writeAccess(id: string, ctx: Context, repo?: string): Promise<{ jobs: JobsApi; repo: string }> {
  const jobs = await ctx.deps.jobs()
  const of = jobs.repositoryOf(id)
  if (!of || (repo && projectSlug(repo) !== projectSlug(of))) throw new AccessDenied(NO_ACCESS)
  if (!isAdmin(ctx.principal)) {
    // the same "no access" for a project they are not on; a reviewer on it is refused write
    await require_(ctx.principal, of, 'read')
    await require_(ctx.principal, of, 'write')
  }
  return { jobs, repo: of }
}

/** The ops the API can do for a job view that did not come from the index (`job`): cancel and pause while it runs. */
export function jobControls(j: Pick<JobView, 'state' | 'kind'>, jobs: Pick<JobsApi, 'cancel' | 'pause'>): JobOp[] {
  if (j.state !== 'running') return []
  return [...(j.kind === 'task' && jobs.pause ? ['pause' as const] : []), ...(jobs.cancel ? ['cancel' as const] : [])]
}

/** A job view with its controls. */
export const withControls = <J extends JobView>(j: J, jobs: Pick<JobsApi, 'cancel' | 'pause'>): J & { controls: JobOp[] } => ({ ...j, controls: jobControls(j, jobs) })

/** What Resume needs of a paused task's recorded request (the rest of it, its kind and project, is checked apart). */
const Resumable = TaskPayload.pick({ request: true, requestedBy: true, requestedBySub: true, agent: true, branch: true }).loose()

export const JOB_ACTIONS = {
  'jobs.list': def('read', Repo, async ({ repo }, ctx) => {
    const at = Date.now() / 1000
    const [{ jobs, batch }, facts, record] = await Promise.all([
      listJobs(ctx, repo, { at }),
      agentFacts(ctx, repo).catch((): AgentFacts => ({ questions: [], checks: [], stuck: [] })),
      withJourneyDb(ctx, repo, (db) => loadJourney(db)).catch(() => null),
    ])
    const answered = new Set((record?.questions ?? []).filter((q) => q.answeredAt !== null).map((q) => q.id))
    const dismissed = new Set((record?.dismissals ?? []).map((d) => d.stuckId))
    return {
      repo, jobs, agents: agentViews(jobs, facts, answered, dismissed, at),
      batch: batch.map((b) => ({ id: b.id, job: jobs.find((j) => j.workerJobId === b.jobId)?.id ?? null, pool: b.pool, state: b.state, submittedAt: iso(b.submittedAt) })),
      updatedAt: new Date(at * 1000).toISOString(),
    }
  }),

  'job.control': def('job', z.object({ id: z.string().min(1).max(400), op: z.enum(JOB_OPS), reason: z.string().trim().max(300).optional(), repo: z.string().max(140).optional() }), async (a, ctx) => {
    const { jobs, repo } = await writeAccess(a.id, ctx, a.repo)
    const by = label(ctx.principal)
    const at = Date.now() / 1000
    const { jobs: views, rows } = await listJobs(ctx, repo, { at })
    const view = views.find((j) => j.id === a.id || j.workerJobId === a.id.split('.').at(-1))
    const answer = (r: Record<string, unknown>) => ({ repo, op: a.op, ...r })
    // a job the index does not list (an older worker, or one that just started): cancel and pause by its handle only
    if (!view) {
      if (a.op === 'cancel' && jobs.cancel) {
        const r = await jobs.cancel(a.id, `cancelled by ${by}${a.reason ? `: ${a.reason}` : ''}`)
        return answer(r.ok ? { ok: true, state: r.state, ...(r.kept ? { kept: r.kept } : {}) } : { ok: false, state: r.state, reason: r.reason ?? 'The job is not running.' })
      }
      if (a.op === 'pause' && jobs.pause) {
        const r = await jobs.pause(a.id, by)
        return answer(r.ok ? { ok: true, state: r.state, pausing: true, ...(r.kept ? { kept: r.kept } : {}) } : { ok: false, state: r.state, reason: r.reason ?? 'The job is not running.' })
      }
      return answer({ ok: false, reason: 'trace does not list this job, so it can only be cancelled while it runs.' })
    }
    if (!view.controls.includes(a.op)) return answer({ ok: false, state: view.state, reason: cannot(a.op, view, jobs) })
    const control = (c: Partial<Pick<JobControl, 'held' | 'order' | 'discarded'>>) =>
      plainly(() => writeJourney(ctx, repo, (db) => { putControl(db, { job: view.workerJobId, by, at, ...c }); return { result: {} } }))

    switch (a.op) {
      case 'cancel': {
        if (view.state === 'paused') {
          await control({ discarded: true })
          return answer({ ok: true, state: 'aborted', kept: `Its work stays on ${view.branch ?? 'its branch'}; it will not be resumed.` })
        }
        const r = await (jobs.cancel as NonNullable<JobsApi['cancel']>)(view.id, `cancelled by ${by}${a.reason ? `: ${a.reason}` : ''}`)
        return answer(r.ok ? { ok: true, state: r.state, ...(r.kept ? { kept: r.kept } : {}) } : { ok: false, state: r.state, reason: r.reason ?? 'The job is not running.' })
      }
      case 'pause': {
        if (view.state === 'queued') {
          await control({ held: true })
          return answer({ ok: true, state: 'queued', held: true, kept: 'It stays in the queue, held: it does not start until someone resumes it.' })
        }
        const r = await (jobs.pause as NonNullable<JobsApi['pause']>)(view.id, by)
        return answer(r.ok ? { ok: true, state: r.state, pausing: true, ...(r.kept ? { kept: r.kept } : {}) } : { ok: false, state: r.state, reason: r.reason ?? 'The job is not running.' })
      }
      case 'resume': {
        if (view.state === 'queued') {
          await control({ held: false })
          return answer({ ok: true, state: 'queued', held: false, kept: 'Released: it starts at its turn.' })
        }
        // a paused job: a new task on its branch, carrying it on
        const row = rows.find((r) => r.id === view.workerJobId)
        const p = row?.payload ? Resumable.safeParse(JSON.parse(row.payload)) : null
        if (!row || !p?.success || !row.branch) return answer({ ok: false, state: view.state, reason: 'Its request or branch was not recorded, so it cannot be carried on. Start it again as a new task.' })
        const started = await jobs.startJob({
          kind: 'task', repository: repo, request: p.data.request, requestedBy: p.data.requestedBy,
          ...(p.data.requestedBySub ? { requestedBySub: p.data.requestedBySub } : {}), ...(p.data.agent ?? row.agent ? { agent: (p.data.agent ?? row.agent) as NonNullable<typeof p.data.agent> } : {}),
          branch: row.branch, resume: { job: row.id, by },
        })
        if (!started.accepted) return answer({ ok: false, state: view.state, reason: started.reason ?? 'It is already being carried on.', jobId: started.jobId })
        return answer({ ok: true, state: 'queued', jobId: started.jobId, kept: `It carries on from ${row.branch}${row.claudeSession ? ', with its conversation' : ''}.` })
      }
      case 'move_up': {
        const order = moveUpOrder(view.workerJobId, rows, await readControls(ctx, repo))
        if (order === null) return answer({ ok: false, state: view.state, reason: 'It is first in its queue already.' })
        await control({ order })
        return answer({ ok: true, state: 'queued', position: Math.max(1, (view.queue?.position ?? 2) - 1) })
      }
    }
  }),
}

/** Why an op cannot be done for this job now, in plain words. */
export function cannot(op: JobOp, j: Pick<IndexedJob, 'state' | 'kind' | 'parentJob' | 'resumedBy' | 'queue'>, jobs: Pick<JobsApi, 'cancel' | 'pause'>): string {
  if (j.parentJob) return 'A worker job belongs to the specialist that asked for it: pause or cancel that job instead.'
  if (j.state === 'lost') return 'trace lost contact with this job; there is nothing to control. Start it again if it is still needed.'
  switch (op) {
    case 'pause':
      if (j.kind !== 'task') return 'Only a person\'s task can be paused; a workflow\'s job can only be cancelled (the workflow would start it again).'
      if (!jobs.pause) return 'This installation cannot pause jobs from the app: the API has no worker runtime to ask.'
      return j.state === 'paused' ? 'It is paused already.' : `It has ${j.state === 'succeeded' ? 'finished' : j.state === 'failed' ? 'failed' : 'stopped'}: there is nothing to pause.`
    case 'resume': return j.resumedBy ? 'It was resumed already.' : 'Only a paused or held job can be resumed.'
    case 'move_up': return j.state !== 'queued' ? 'Only a queued job can be moved up.' : j.queue?.position === 1 ? 'It is first in its queue already.' : 'It cannot be moved.'
    case 'cancel': return !jobs.cancel ? 'This installation cannot cancel jobs from the app: the API has no worker runtime to ask.' : 'It is not running, queued or paused.'
  }
}

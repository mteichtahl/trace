/**
 * A project's jobs, and controlling them: what the job system can genuinely do, and nothing it cannot.
 *
 *   jobs.list     read                   { repo } → { repo, jobs, agents, handoffs, batch, updatedAt }: the project's job index
 *                                        (src/core/job-index.ts, written by its worker as its jobs change): running,
 *                                        queued, paused and the last day's finished jobs, newest first, each with its
 *                                        controls; per agent its status (Working, Queued, Waiting on a person, Stuck,
 *                                        Idle), what it is doing now, its queue in order, and the last day's runs; the
 *                                        graphics card and CPU jobs (AWS Batch) its jobs have running; the hand-offs
 *                                        between specialists (src/core/handoffs.ts: who asked whom, the request, its
 *                                        state, the answer). Reviewers see it all with no controls
 *   handoff.decline write on its project { repo, id, reason } → { declined }: a person declines a pending hand-off
 *                                        (requested, or its job queued) with a reason in one line. It is written in the
 *                                        journey record (people's), never the agents' facts; a queued receiving job is
 *                                        cancelled at once where the API can reach it, and otherwise does not run at its
 *                                        turn. The asking specialist reads the decline in journey.status and may ask a
 *                                        person instead. A running one is refused: cancel its job. Reviewers cannot
 *   job.control   write on its project   { id, op, reason?, repo? }: pause | resume | cancel | move_up | restart |
 *                                        dismiss → { ok, kept? } or { ok: false, reason } in plain words. Reviewers
 *                                        cannot (write is needed); another project's job, and one that does not exist,
 *                                        get "no access"
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
 *   restart   lost task      the same request on the same branch, as a new attempt (a session of its own): the new
 *                            task's row links back to the lost one (resume_of), and its prompt says what the lost one
 *                            left on the branch. Claimed in the journey record first (job_controls.restarted_by), so
 *                            two presses start it once; recorded in the decisions (job.restarted)
 *   dismiss   lost job       with an optional reason: it leaves the overview's "Ended without finishing" and the next
 *                            step; recorded in the decisions (job.dismissed). Nothing runs or stops
 *
 * STARTED AGAIN ONCE (test-esp32 log #45, #46): a lost task that left no change behind is started again by trace on
 * its own, once, on the next journey.get (restartLostJobs), with a note in the decisions. If that attempt is lost too,
 * a person decides: its card offers Start again and Dismiss, and the next step says it ended without finishing.
 *
 * A work item (a workflow's) can only be cancelled: the workflows claim it and would dispatch it again. A delegated
 * worker is controlled through its specialist's job. A hand-off job (one specialist asked another) is held, moved up and
 * cancelled like a person's task, but never paused: cancelled, its asker is told it was not answered. Every job view (here, `job`, journey.get's jobs) carries
 * `controls`: the ops this person can do for it now, so the app shows only those.
 *
 * People's controls are in the journey record, never in the index: the index is written by an agent's worker, and
 * agents never decide for a person. A queued job reads them when it looks again (on the project's events topic).
 */
import { z } from 'zod'
import { AccessDenied, isAdmin, require_, standing } from '../core/access.js'
import {
  type BatchRow, type JobControl, type JobRow, JobIndexStore, STALE_AFTER_S, heardOf, indexedHandle, isLive, lastWords, loadBatch, loadControls, loadJobs, moveUpOrder, putControl, queueOrder, typicalSeconds,
} from '../core/job-index.js'
import { type AgentFacts, type JourneyRecord, type NextStep, type StageView, type Viewer, decide, loadJourney } from '../core/journey.js'
import { type HandoffView, declineHandoff, handoffViews } from '../core/handoffs.js'
import { SPECIALIST_KINDS, SPECIALIST_WORDS } from '../agents/kinds.js'
import { PROJECTS_PREFIX, projectSlug } from '../core/project.js'
import { TaskPayload } from '../agents/runtime/schemas.js'
import { type Context, type JobView, type JobsApi, NO_ACCESS, Repo, agentFacts, def, hashOf, label, plainly, storeAt, withJourneyDb, writeJourney } from './action-kit.js'
import { assertNotHeld } from './held.js'
import { type QueueFile, WAITS_FOR_AGENT, queuedHandle, readQueue, startQueued } from './agent-queue.js'

export const JOB_OPS = ['pause', 'resume', 'cancel', 'move_up', 'restart', 'dismiss'] as const
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
  /** typical seconds for this kind of job on this project (core/job-index.ts typicalSeconds), null without enough history */
  typicalS: number | null
  where: string | null; branch: string | null
  /** queued: its place in its agent's queue (1 is next) and what it waits for */
  queue: { position: number; of: number; startsWhen: string } | null
  parentJob: string | null; resumeOf: string | null; resumedBy: string | null; summary: string | null; error: string | null
  pausedBy: string | null; pausedAt: string | null
  /**
   * running: when trace last heard from it (its heartbeat), when that is late (a beat missed: overdue) and when it is
   * declared lost if it stays silent. A screen that has not looked since tells a silent job from a running one by these
   */
  heard: { at: string; overdueAt: string; lostAt: string } | null
  /** a hand-off job: the hand-off it answers and who asked (its title says so too: "Asked by the … specialist: …") */
  handoff: { id: string; from: string | null; fromName: string | null } | null
  /**
   * lost: what a person (or trace) decided about it, once decided: dismissed (with their reason), or started again (the
   * new job's row links back to it). A settled lost job leaves the overview's "Ended without finishing" and the next step
   */
  settled: { how: 'dismissed' | 'restarted'; by: string; at: string; reason: string | null } | null
  controls: JobOp[]
}

const iso = (t: number | null): string | null => (t === null ? null : new Date(t * 1000).toISOString())

/** A hand-off job's hand-off, from its row: its id, and who asked (from its title, "Asked by the … specialist: …"). */
function handoffOf(j: Pick<JobRow, 'handoff' | 'title'>): IndexedJob['handoff'] {
  const from = SPECIALIST_KINDS.find((k) => j.title.startsWith(`Asked by the ${SPECIALIST_WORDS[k]} specialist:`)) ?? null
  return { id: j.handoff as string, from, fromName: from ? SPECIALIST_WORDS[from] : null }
}

/**
 * The project's hand-offs between specialists as people read them (src/core/handoffs.ts handoffViews): the agents'
 * facts, people's declines (the journey record) and each receiving job's state in the index, with the API's job ids.
 */
export function projectHandoffs(repo: string, facts: AgentFacts, record: Pick<JourneyRecord, 'declines'> | null, rows: readonly JobRow[]): HandoffView[] {
  const at = Date.now() / 1000
  const jobs = new Map(rows.map((r) => [r.id, { state: r.state === 'running' && !isLive(r, at) ? 'lost' : r.state, handle: indexedHandle(repo, r.session, r.id) }]))
  return handoffViews(facts.handoffs ?? [], record?.declines ?? [], jobs)
}

/** Why a running job's state is not what its row says: its heartbeat stopped. */
const LOST = `trace lost contact with it: its runtime stopped without a word for more than ${Math.round(STALE_AFTER_S / 60)} minutes`

/**
 * The ops a person may do on a job as it is now. `write`: they may change the project (contributors, admins); `can`:
 * what this installation's API can reach (a worker to pause or cancel).
 */
export function controlsOf(j: Pick<JobRow, 'kind' | 'state' | 'parentJob' | 'resumedBy' | 'session'> & Partial<Pick<JobRow, 'handoff' | 'payload'>> & { held: boolean; discarded: boolean; lost: boolean; first: boolean; settled?: boolean },
  o: { write: boolean; pause: boolean; cancel: boolean }): JobOp[] {
  if (!o.write) return []
  // a lost job: Start again (a person's task whose request was recorded) and Dismiss, until one of them is done
  if (j.lost) return j.settled ? [] : [...(restartable(j) ? ['restart' as const] : []), 'dismiss']
  if (j.parentJob) return []
  const task = j.kind === 'task'
  const reach = j.session !== null
  switch (j.state) {
    // a running hand-off job is cancelled, never paused: its asker is told at once (src/core/handoffs.ts)
    case 'running': return [...(task && !j.handoff && o.pause && reach ? ['pause' as const] : []), ...(o.cancel && reach ? ['cancel' as const] : [])]
    case 'queued': return [...(task ? [j.held ? 'resume' as const : 'pause' as const] : []), ...(!j.first ? ['move_up' as const] : []), ...(o.cancel && reach ? ['cancel' as const] : [])]
    case 'paused': return j.discarded || j.resumedBy ? [] : ['resume', 'cancel']
    default: return []
  }
}

/**
 * Whether a lost job can be started again as it was asked: a person's task (not a delegated worker, not a hand-off)
 * whose request the index recorded. A workflow's work item is dispatched again by its workflow instead.
 */
export const restartable = (j: Pick<JobRow, 'kind' | 'parentJob'> & Partial<Pick<JobRow, 'handoff' | 'payload'>>): boolean =>
  j.kind === 'task' && !j.parentJob && !j.handoff && Boolean(j.payload)

/** A claim to start a lost job again older than this, with no new job to show for it, failed without a word. */
const RESTART_CLAIM_S = 15 * 60

/** What was decided about a lost job: dismissed, or started again (claimed in the record, or its new job in the index). */
export function settledOf(j: Pick<JobRow, 'resumedBy'>, c: JobControl | undefined, at: number): IndexedJob['settled'] {
  if (c?.dismissed) return { how: 'dismissed', by: c.by, at: iso(c.at) as string, reason: c.reason }
  if (j.resumedBy) return { how: 'restarted', by: c?.restartedBy ?? 'trace', at: iso(c?.restartedAt ?? c?.at ?? at) as string, reason: null }
  if (c?.restartedBy && c.restartedAt !== null && at - c.restartedAt < RESTART_CLAIM_S) return { how: 'restarted', by: c.restartedBy, at: iso(c.restartedAt) as string, reason: null }
  return null
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
    const settled = lost ? settledOf(j, c, o.at) : null
    out.push({
      id: indexedHandle(repo, j.session, j.id), workerJobId: j.id, kind: j.kind, repository: repo, agent: j.agent, agentName: j.agent ? AGENT_WORDS[j.agent] ?? j.agent : null,
      title: j.title, number: j.number, startedBy: j.requestedBy, yours: j.requestedBySub !== null && j.requestedBySub === o.sub, state,
      step: lost ? [`${LOST}.`, lastWords(j)].filter(Boolean).join(' ') : discarded ? `discarded by ${c?.by ?? 'a person'}` : j.step, held: Boolean(c?.held),
      queuedAt: iso(j.queuedAt), startedAt: iso(j.state === 'queued' ? null : j.startedAt), endedAt: iso(j.endedAt),
      typicalS: typicalSeconds(rows, j), where: j.where, branch: j.branch, queue,
      parentJob: j.parentJob, resumeOf: j.resumeOf, resumedBy: j.resumedBy, summary: j.summary, error: lost ? [`${LOST}.`, lastWords(j)].filter(Boolean).join(' ') : j.error,
      pausedBy: j.pausedBy, pausedAt: iso(j.pausedAt),
      heard: state === 'running' ? (({ heardAt, overdueAt, lostAt }) => ({ at: iso(heardAt) as string, overdueAt: iso(overdueAt) as string, lostAt: iso(lostAt) as string }))(heardOf(j)) : null,
      handoff: j.handoff ? handoffOf(j) : null, settled,
      controls: controlsOf({ ...j, held: Boolean(c?.held), discarded, lost, first, settled: settled !== null }, o),
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
 * that cannot go on is what a person most needs to see. A stuck report a person answered or dismissed, or one the agent has since got past (a later job of
 * its that started after the report and succeeded) no longer counts. A question or stuck report counts for an agent when it came
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
  // a stuck report stands until it is resolved or dismissed, or until the same agent has since started a job that
  // succeeded: it got past it (agents rarely mark their own old reports resolved, and a fix elsewhere, a deploy or a
  // permission, never does), so the agent is not shown stuck on a problem its later work shows is gone
  const got = (agent: string | null, after: number): boolean => agent !== null && jobs.some((j) =>
    j.agent === agent && j.state === 'succeeded' && j.startedAt !== null && j.startedAt !== undefined && Date.parse(j.startedAt) / 1000 > after)
  // a person answering it (question.answer writes the answer under the stuck item's id) settles it too, as on Home
  const stuck = facts.stuck.filter((s) => s.resolvedAt === null && !dismissed.has(s.id) && !answered.has(s.id))
    .map((s) => ({ agent: of(s.jobId, s.agent), text: s.why, at: s.at }))
    .filter((s) => !got(s.agent, s.at))
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
export async function listJobs(ctx: Context, repo: string, o: { at?: number } = {}): Promise<{ jobs: IndexedJob[]; batch: (BatchRow & { submittedAt: number })[]; rows: JobRow[]; queue: QueueFile }> {
  const at = o.at ?? Date.now() / 1000
  const [{ result }, controls, write, jobs] = await Promise.all([
    jobIndex(ctx, repo).read((db) => ({ rows: loadJobs(db), batch: loadBatch(db) })),
    readControls(ctx, repo),
    writes(ctx, repo),
    ctx.deps.jobs(),
  ])
  // the work asked for while the project's agent was being set up (src/api/agent-queue.ts): started here once the agent
  // is there, so every look at the project's jobs (journey.get, jobs.list) starts it; until then listed as queued
  const queue = await agentQueueNow(ctx, repo, jobs)
  const views = jobViews(repo, result.rows, controls, { at, sub: ctx.principal.sub, write, pause: Boolean(jobs.pause), cancel: Boolean(jobs.cancel) })
  const live = new Set(views.filter((j) => j.state === 'running').map((j) => j.workerJobId))
  return { jobs: [...views, ...queuedJobViews(repo, queue, { at, sub: ctx.principal.sub, write })], batch: result.batch.filter((b) => b.endedAt === null && live.has(b.jobId)), rows: result.rows, queue }
}

/** A queued start claimed this long ago with no job recorded did not start. */
const STARTING_LOST_MS = 10 * 60 * 1000

/** The project's queued starts, after starting them when its agent is there; an unreadable queue is an empty one. */
async function agentQueueNow(ctx: Context, repo: string, jobs: JobsApi): Promise<QueueFile> {
  const store = storeAt(ctx, PROJECTS_PREFIX)
  try {
    if (!jobs.hasAgent || jobs.hasAgent(repo)) await startQueued(jobs, store, repo)
    return await readQueue(store, repo)
  } catch {
    return { queued: [], started: [] }
  }
}

/**
 * The queued starts as the app lists jobs: queued, waiting for the project's agent (cancel takes one out), and the
 * ones that could not start once it was there, as failed, for a day. Pure.
 */
export function queuedJobViews(repo: string, q: QueueFile, o: { at: number; sub: string; write: boolean }): IndexedJob[] {
  const base = (id: string, title: string, agent: string | null, by: string | null, bySub: string | null, queuedAt: string) => ({
    workerJobId: id, kind: 'task', repository: projectSlug(repo), agent, agentName: agent ? AGENT_WORDS[agent] ?? agent : null, title, number: null,
    startedBy: by, yours: bySub !== null && bySub === o.sub, held: false, queuedAt, typicalS: null, where: null, branch: null,
    parentJob: null, resumeOf: null, resumedBy: null, summary: null, pausedBy: null, pausedAt: null, heard: null, handoff: null, settled: null,
  })
  const waiting = q.queued.map((s, i): IndexedJob => ({
    ...base(s.id, s.title, s.payload.agent ?? null, s.payload.requestedBy, s.payload.requestedBySub ?? null, s.queued_at),
    id: queuedHandle(repo, s.id), state: 'queued', step: `queued: ${WAITS_FOR_AGENT}`, startedAt: null, endedAt: null, error: null,
    queue: { position: i + 1, of: q.queued.length, startsWhen: WAITS_FOR_AGENT }, waitsForAgent: true, controls: o.write ? ['cancel'] : [],
  }))
  // (one claimed and never answered for a while: its look stopped half way, so it did not start)
  const failed = q.started.filter((s) => s.job === null && (s.error || o.at * 1000 - Date.parse(s.started_at) > STARTING_LOST_MS) && o.at * 1000 - Date.parse(s.started_at) < DAY_S * 1000).map((s): IndexedJob => ({
    ...base(s.id, s.title, s.agent, null, null, s.queued_at),
    id: queuedHandle(repo, s.id), state: 'failed', step: null, startedAt: s.started_at, endedAt: s.started_at, queue: null, controls: [],
    error: `It waited for this project's agent, then could not start: ${s.error ?? 'trace stopped while starting it. Ask for it again'}.`.replace(/\.\.$/, '.'),
  }))
  return [...waiting, ...failed]
}

/**
 * The lost jobs that still need a person (the overview's "Ended without finishing" and the next step): lost in the last
 * day (as the app counts it: since trace last heard from it), not dismissed or started again, and not a specialist's
 * delegated worker or a sweep (its specialist's own job is the one to act on). Newest first.
 */
export function openLostJobs(jobs: readonly IndexedJob[], rows: readonly JobRow[], at: number): IndexedJob[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return jobs.filter((j) => {
    const row = byId.get(j.workerJobId)
    return j.state === 'lost' && !j.settled && !j.parentJob && j.kind !== 'sweep' && row !== undefined && at - heardOf(row).heardAt < DAY_S
  })
}

/** The attempt a job is: 1, plus one for each job before it that it starts again or carries on (resume_of). */
export function attemptOf(row: Pick<JobRow, 'id' | 'resumeOf'>, rows: readonly Pick<JobRow, 'id' | 'resumeOf'>[]): number {
  const seen = new Set([row.id])
  let n = 1
  for (let cur = row.resumeOf; cur && !seen.has(cur); cur = rows.find((r) => r.id === cur)?.resumeOf ?? null) {
    seen.add(cur)
    n++
  }
  return n
}

/**
 * Start a lost task again: its recorded request, for the same specialist, on the same branch, as a new attempt (a
 * session of its own: src/api/workers.ts taskSession), carrying `restart` so the new row links back to it and its prompt
 * says what the lost one left on the branch. Claimed in the journey record first, so two presses (or a press and trace's
 * own restart) start it once; a start that is refused takes the claim back, so the card offers Start again again.
 * `auto`: trace on its own (restartLostJobs), only for a first attempt it has never started again itself, and noted in
 * the decisions before it starts. A person's restart is noted once it has started.
 */
export async function restartLost(ctx: Context, repo: string, row: JobRow, rows: readonly JobRow[], o: { by: string; auto: boolean }):
  Promise<{ ok: true; jobId: string; kept: string } | { ok: false; reason: string }> {
  const p = row.payload ? Resumable.safeParse(JSON.parse(row.payload)) : null
  if (!restartable(row) || !p?.success) return { ok: false, reason: 'Its request was not recorded, so it cannot be started again as it was asked. Ask trace to do the work again with "Ask trace to fix something", or dismiss it.' }
  const agent = p.data.agent ?? SPECIALIST_KINDS.find((k) => k === row.agent)
  const branch = row.branch ?? p.data.branch ?? undefined
  const attempt = attemptOf(row, rows) + 1
  const at = Date.now() / 1000
  const where = branch ? ` on ${branch}` : ''
  const claim = await plainly(() => writeJourney(ctx, repo, (db) => {
    const settled = settledOf(row, loadControls(db).get(row.id), at)
    if (settled) return { result: { claimed: false, why: settled.how === 'dismissed' ? 'It was dismissed.' : 'It was started again already: follow the new job.' }, changed: false }
    const rec = loadJourney(db)
    // trace starts a lost job again on its own once: never a second time, nor after a person decided about it
    if (o.auto && rec?.decisions.some((d) => d.ref === row.id && d.kind.startsWith('job.'))) return { result: { claimed: false, why: 'trace started it again once already.' }, changed: false }
    putControl(db, { job: row.id, by: o.by, at, restartedBy: o.by, restartedAt: at })
    if (o.auto && rec) {
      decide(db, {
        kind: 'job.restarted', stage: rec.journey.currentStage, ref: row.id, by: 'trace', detail: { job: row.id, auto: true, attempt, branch: branch ?? null },
        summary: `trace started "${row.title}" again on its own${where}: it ended without finishing and left no change. If this attempt stops too, trace asks you.`,
      })
    }
    return { result: { claimed: true, why: '' } }
  }))
  if (!claim.claimed) return { ok: false, reason: claim.why }
  const jobs = await ctx.deps.jobs()
  const started = await jobs.startJob({
    kind: 'task', repository: repo, request: p.data.request, requestedBy: p.data.requestedBy, ...(p.data.requestedBySub ? { requestedBySub: p.data.requestedBySub } : {}),
    ...(agent ? { agent } : {}), ...(branch ? { branch } : {}), restart: { job: row.id, by: o.by }, attempt,
  }).catch((e: unknown) => ({ accepted: false, jobId: '', reason: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) }))
  await writeJourney(ctx, repo, (db) => {
    const rec = loadJourney(db)
    if (!started.accepted) {
      putControl(db, { job: row.id, by: o.by, at: Date.now() / 1000, restartedBy: null, restartedAt: null })
      if (o.auto && rec) decide(db, { kind: 'job.restart_failed', stage: rec.journey.currentStage, ref: row.id, by: 'trace', detail: { job: row.id, reason: started.reason ?? null }, summary: `trace could not start "${row.title}" again: ${started.reason ?? 'the job was not accepted'}. Start it again or dismiss it on the overview.` })
    } else if (!o.auto && rec) {
      decide(db, { kind: 'job.restarted', stage: rec.journey.currentStage, ref: row.id, by: o.by, detail: { job: row.id, auto: false, attempt, branch: branch ?? null, new_job: started.jobId }, summary: `${o.by} started "${row.title}" again${where}: it ended without finishing.` })
    }
    return { result: {} }
  }).catch(() => undefined)
  if (!started.accepted) return { ok: false, reason: `trace could not start it again: ${started.reason ?? 'the job was not accepted'}.` }
  return { ok: true, jobId: started.jobId, kept: `It starts again${where}, from what the lost attempt left there.` }
}

/**
 * The next step while a job ended without finishing (test-esp32 log #46): never "trace works on …" or a person's
 * "Continue" over work nothing is doing. It names the lost job (the newest, and how many more), and offers Start again
 * (its button calls job.control restart) or, for a job that cannot be started again from here, Dismiss. Only a step
 * that would have the person carry on, or say trace is working, gives way: a question, a gate, a change to review and a
 * failure stay first, and so does drafting the requirements again (its own action). `lost`: openLostJobs.
 */
export function lostJobStep(next: NextStep, lost: readonly Pick<IndexedJob, 'id' | 'title' | 'agentName' | 'kind' | 'parentJob' | 'handoff'>[], viewer: Pick<Viewer, 'admin' | 'part'>, canRestart: (id: string) => boolean): NextStep {
  // one that can be started again first: the button then does what the step says
  const j = lost.find((x) => canRestart(x.id)) ?? lost[0]
  if (!j || (next.kind !== 'task' && next.kind !== 'working') || next.ref?.kind === 'action') return next
  const mine = viewer.admin || viewer.part === 'contributor'
  const can = canRestart(j.id)
  const more = lost.length > 1 ? ` ${lost.length - 1} more ${lost.length === 2 ? 'job' : 'jobs'} ended the same way: see the overview.` : ''
  return {
    kind: 'task', belongs_to: mine ? 'you' : 'contributors', yours: mine,
    summary: `${j.agentName ? `The ${j.agentName} job` : 'A job'} "${j.title}" ended without finishing: trace lost contact with it, and nothing is doing its work now.${more}`,
    why: 'Until it is started again, nothing does its work, and the steps that wait on it wait too.',
    recommendation: can ? 'trace recommends starting it again: it carries on from what the lost attempt left on its branch.' : null,
    button: mine ? (can ? 'Start it again' : 'Dismiss it') : 'Read the stage',
    stage: next.stage, ref: mine ? { kind: 'action', id: can ? 'job.restart' : 'job.dismiss' } : next.ref, step: null,
    after: can
      ? 'Once it is started again, trace carries on with the work. If it is no longer needed, dismiss it on the overview instead.'
      : 'Once it is dismissed, the next step is what the stage needs next. To have the work done again, use "Ask trace to fix something".',
    job_id: j.id,
  }
}

/** The stage's steps while a lost job holds up the next step: trace's step `now` reads as stopped, not as being worked on. */
export function stoppedSteps<S extends Pick<StageView, 'steps'>>(stages: readonly S[]): S[] {
  return stages.map((s) => (s.steps.some((x) => x.state === 'now' && x.owner === 'trace')
    ? { ...s, steps: s.steps.map((x) => (x.state === 'now' && x.owner === 'trace' ? { ...x, stopped: true as const } : x)) }
    : s))
}

/**
 * Started again once, on its own (STARTED AGAIN ONCE above): each lost task that is a first attempt and left no change
 * behind (no open change made by it; `changeJobs`, the jobs the open changes came from, null when the changes could not
 * be listed: then nothing starts).
 * Nothing starts while the project is paused or retired. Answers the titles started again.
 */
export async function restartLostJobs(ctx: Context, repo: string, list: { jobs: readonly IndexedJob[]; rows: readonly JobRow[] }, changeJobs: ReadonlySet<string> | null, o: { held: boolean; at?: number }): Promise<string[]> {
  if (o.held || !changeJobs) return []
  const out: string[] = []
  for (const j of openLostJobs(list.jobs, list.rows, o.at ?? Date.now() / 1000)) {
    const row = list.rows.find((r) => r.id === j.workerJobId)
    if (!row || row.resumeOf || !restartable(row) || changeJobs.has(j.id)) continue
    const r = await restartLost(ctx, repo, row, list.rows, { by: 'trace', auto: true }).catch(() => null)
    if (r?.ok) out.push(row.title)
  }
  return out
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
    const [{ jobs, batch, rows }, facts, record] = await Promise.all([
      listJobs(ctx, repo, { at }),
      agentFacts(ctx, repo).catch((): AgentFacts => ({ questions: [], checks: [], stuck: [] })),
      withJourneyDb(ctx, repo, (db) => loadJourney(db)).catch(() => null),
    ])
    const answered = new Set((record?.questions ?? []).filter((q) => q.answeredAt !== null).map((q) => q.id))
    const dismissed = new Set((record?.dismissals ?? []).map((d) => d.stuckId))
    return {
      repo, jobs, agents: agentViews(jobs, facts, answered, dismissed, at),
      // the hand-offs between specialists: who asked whom, for what, where each stands and its answer
      handoffs: projectHandoffs(repo, facts, record, rows),
      batch: batch.map((b) => ({ id: b.id, job: jobs.find((j) => j.workerJobId === b.jobId)?.id ?? null, pool: b.pool, state: b.state, submittedAt: iso(b.submittedAt) })),
      updatedAt: new Date(at * 1000).toISOString(),
    }
  }),

  'handoff.decline': def('write', Repo.extend({ id: z.string().regex(/^ho[0-9a-f]{14}$/, 'a hand-off id'), reason: z.string().trim().min(3).max(300) }), async (a, ctx) => {
    const by = label(ctx.principal)
    const [facts, { rows }, jobs] = await Promise.all([agentFacts(ctx, a.repo), listJobs(ctx, a.repo), ctx.deps.jobs()])
    const h = (facts.handoffs ?? []).find((x) => x.id === a.id)
    const row = h?.jobId ? rows.find((r) => r.id === h.jobId) : undefined
    const jobState = row ? (row.state === 'running' && !isLive(row, Date.now() / 1000) ? 'lost' : row.state) : null
    const declined = await plainly(() => writeJourney(ctx, a.repo, (db) => ({ result: declineHandoff(db, h, { hash: hashOf(ctx.principal), label: by }, a.reason, { jobState }) })))
    // its queued job leaves the queue now where the API can reach it; otherwise it does not run at its turn (job.ts)
    let job: { cancelled: boolean; note: string } | null = null
    if (row && row.state === 'queued') {
      const handle = indexedHandle(a.repo, row.session, row.id)
      const r = jobs.cancel && row.session ? await jobs.cancel(handle, `hand-off declined by ${by}: ${declined.reason}`).catch(() => null) : null
      job = r?.ok ? { cancelled: true, note: 'Its queued job was cancelled.' } : { cancelled: false, note: 'Its queued job will not run: it stops at its turn.' }
    }
    const to = h ? `the ${SPECIALIST_WORDS[h.toKind]} specialist` : 'the specialist asked'
    return { repo: a.repo, declined, ...(job ? { job } : {}), summary: `Declined: ${to} will not answer it, and the asking specialist is told why.` }
  }),

  'job.control': def('job', z.object({ id: z.string().min(1).max(400), op: z.enum(JOB_OPS), reason: z.string().trim().max(300).optional(), repo: z.string().max(140).optional() }), async (a, ctx) => {
    const { jobs, repo } = await writeAccess(a.id, ctx, a.repo)
    // a paused or retired project: its work can be paused or cancelled, but nothing resumed or moved up
    if (a.op === 'resume' || a.op === 'move_up' || a.op === 'restart') await assertNotHeld(repo)
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
      case 'restart': {
        const row = rows.find((r) => r.id === view.workerJobId)
        if (!row) return answer({ ok: false, state: view.state, reason: 'It is no longer in the project\'s job list.' })
        const r = await restartLost(ctx, repo, row, rows, { by, auto: false })
        return answer(r.ok ? { ok: true, state: 'queued', jobId: r.jobId, kept: r.kept } : { ok: false, state: view.state, reason: r.reason })
      }
      case 'dismiss': {
        const why = a.reason?.replace(/\s+/g, ' ').trim() || null
        const done = await plainly(() => writeJourney(ctx, repo, (db) => {
          if (loadControls(db).get(view.workerJobId)?.dismissed) return { result: { already: true }, changed: false }
          putControl(db, { job: view.workerJobId, by, at, dismissed: true, reason: why })
          const rec = loadJourney(db)
          if (rec) {
            decide(db, {
              kind: 'job.dismissed', stage: rec.journey.currentStage, ref: view.workerJobId, by, detail: { job: view.workerJobId, reason: why },
              summary: `${by} dismissed "${view.title}", which ended without finishing${why ? `: ${why}` : '.'}`,
            })
          }
          return { result: { already: false } }
        }))
        return answer({ ok: true, state: 'lost', dismissed: true, kept: done.already ? 'It was dismissed already.' : 'Dismissed: it leaves the overview, and the decision is in the project\'s history.' })
      }
    }
  }),
}

/** Why an op cannot be done for this job now, in plain words. */
export function cannot(op: JobOp, j: Pick<IndexedJob, 'state' | 'kind' | 'parentJob' | 'resumedBy' | 'queue'> & Partial<Pick<IndexedJob, 'handoff' | 'settled'>>, jobs: Pick<JobsApi, 'cancel' | 'pause'>): string {
  if (j.parentJob) return 'A worker job belongs to the specialist that asked for it: pause or cancel that job instead.'
  if (op === 'pause' && j.handoff && j.state === 'running') return 'A job another specialist asked for is not paused: cancel it, and the asking specialist is told it was not answered.'
  if (j.state === 'lost') {
    if (j.settled) return j.settled.how === 'dismissed' ? 'It was dismissed already.' : 'It was started again already: follow the new job.'
    if (op === 'restart') return 'Only a person\'s task whose request trace recorded can be started again from here. Ask trace to do the work again with "Ask trace to fix something", or dismiss it.'
    return 'trace lost contact with this job: there is nothing to pause, resume or cancel. Start it again if it is still needed, or dismiss it.'
  }
  if (op === 'restart' || op === 'dismiss') return 'Only a job that ended without finishing can be started again or dismissed.'
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

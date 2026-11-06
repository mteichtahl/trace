/**
 * Spend by job (Cost and time, and the Overview's warning): what each job cost, in which stage, and which of it was
 * work done again. The cost ledger (src/core/cost.ts) has one row per agent run and per graphics card, CPU or tools
 * function job, but a person thinks in jobs ("the second architecture proposal", "the docs rewrite"), so the rows are
 * put together by the job that caused them, from the job index (src/core/job-index.ts):
 *
 *   an agent run        its job id is the specialist's job
 *   a Batch job         the job index's batch table names the job whose tools ran it; failing that, the one agent job
 *                       that was running then; failing that, it is spend no job claims ("not tied to a job")
 *   a delegated worker  counted in the specialist's job that started it
 *
 * Each job is put in the stage the project was in when it started: the journey's current stage at that time, from
 * journey_history (src/core/journey.ts), not the stages' spans, which overlap once a stage is reopened.
 *
 * Work done again, the spend a person can cut, is marked on the job that repeats it (run 2 of the test-esp32 project
 * spent most of its budget this way, and nothing showed it):
 *
 *   sent_back   a person asked for changes to its change (change.asked in the journey's decisions)
 *   redone      it worked on the branch an earlier job already worked on (a conflict fix, a docs refresh)
 *   duplicate   the same specialist was asked the same thing again, on a branch of its own
 *
 * A job that carries on a paused one is the same work continued, not a repeat. Pure but for stageTimeline.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { UsageKind, UsageRow } from './cost.js'
import type { BatchRow, JobRow } from './job-index.js'
import { STAGE_IDS, type StageId } from './journey-catalog.js'
import { shownJobTitle } from './plain-words.js'

export interface StageMark { at: number; stage: StageId }

const isStage = (s: unknown): s is StageId => typeof s === 'string' && (STAGE_IDS as readonly string[]).includes(s)

/**
 * When the project was in which stage: the journey's current stage and each change of it (journey_history), oldest
 * first. A record from before the history: its current stage, from the start.
 */
export function stageTimeline(db: DatabaseSync, current: StageId): StageMark[] {
  const has = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='journey_history'").get())
  const rows = has ? db.prepare("SELECT old, new, at FROM journey_history WHERE field = 'current_stage' ORDER BY at, rowid").all() as { old: unknown; new: unknown; at: number }[] : []
  const first = rows[0]
  const marks: StageMark[] = [{ at: Number.NEGATIVE_INFINITY, stage: first && isStage(first.old) ? first.old : current }]
  for (const r of rows) if (isStage(r.new)) marks.push({ at: Number(r.at), stage: r.new })
  return marks
}

/** The stage the project was in at `t`. */
export function stageAt(marks: readonly StageMark[], t: number): StageId | null {
  let s: StageId | null = null
  for (const m of marks) { if (m.at <= t) s = m.stage; else break }
  return s
}

export type RepeatKind = 'sent_back' | 'redone' | 'duplicate'
export type JobOutcome = 'finished' | 'failed' | 'cancelled' | 'lost' | 'running' | 'queued' | 'paused' | 'unknown'

export interface JobSpend {
  /** the job's id; null for the spend no job claims */
  id: string | null
  agent: string | null
  title: string
  stage: StageId | null
  outcome: JobOutcome
  started: number | null
  ended: number | null
  /** how long it ran, in seconds (to now while it runs) */
  seconds: number | null
  /** USD, estimated; cents */
  amount: number
  byKind: Record<UsageKind, number>
  /** delegated worker jobs counted in it */
  workers: number
  /** work done again, and the earlier job it repeats */
  repeat: { kind: RepeatKind; of: string | null } | null
}

export interface StageSpend {
  stage: StageId
  amount: number
  jobs: number
  /** of it, spent on work done again (sent back, redone, duplicated) */
  repeated: number
  /** of it, spent on jobs that failed, were cancelled or were lost */
  wasted: number
}

export interface SpendByJob {
  jobs: JobSpend[]
  stages: StageSpend[]
  total: number
  repeated: number
  wasted: number
}

const cents = (n: number): number => Math.round(n * 100) / 100
const zero = (): Record<UsageKind, number> => ({ agents: 0, gpu: 0, cpu: 0, tools: 0 })
/** A request in the form two asks for the same thing share. */
const sameAsk = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 160)

function outcomeOf(j: JobRow, now: number, staleAfter: number): JobOutcome {
  switch (j.state) {
    case 'succeeded': return 'finished'
    case 'failed': return 'failed'
    case 'aborted': return 'cancelled'
    case 'running': return j.lostAt || (j.beatAt !== null && now - j.beatAt > staleAfter) ? 'lost' : 'running'
    case 'queued': case 'paused': return j.state
    default: return 'unknown'
  }
}

/**
 * The ledger's rows by job, grouped by stage, with work done again marked. `sentBack`: the jobs a person's "ask for
 * changes" started (change.asked's job_id). `staleAfter`: a running job silent this long is lost (STALE_AFTER_S).
 */
export function spendByJob(o: {
  usage: readonly UsageRow[]; jobs: readonly JobRow[]; batch: readonly BatchRow[]; timeline: readonly StageMark[]
  sentBack?: ReadonlySet<string>; now: number; staleAfter: number
}): SpendByJob {
  const byId = new Map(o.jobs.map((j) => [j.id, j]))
  // a delegated worker is counted in the specialist's job that started it
  const owner = (id: string): string => { const j = byId.get(id); return j?.parentJob && byId.has(j.parentJob) ? j.parentJob : id }
  const batchOf = new Map(o.batch.map((b) => [b.id, b.jobId]))
  const agentJobs = o.jobs.filter((j) => j.startedAt !== null && j.agent !== 'worker' && !j.parentJob)
  /** the one specialist job running at `t`, or null when none or several were */
  const runningAt = (t: number): string | null => {
    const at = agentJobs.filter((j) => (j.startedAt as number) <= t && t <= (j.endedAt ?? j.beatAt ?? o.now) + 120)
    return at.length === 1 ? (at[0] as JobRow).id : null
  }
  const NONE = '\u0000none'
  const sums = new Map<string, { byKind: Record<UsageKind, number>; first: number; agent: string | null }>()
  const workers = new Map<string, Set<string>>()
  for (const u of o.usage) {
    if (u.amount === null) continue
    let id: string | null = null
    if (u.kind === 'agents') id = u.jobId
    else if (u.jobId && batchOf.has(u.jobId)) id = batchOf.get(u.jobId) ?? null
    else id = runningAt(u.at)
    const key = id ? owner(id) : NONE
    if (id && key !== id) { const w = workers.get(key) ?? new Set<string>(); w.add(id); workers.set(key, w) }
    const s = sums.get(key) ?? { byKind: zero(), first: u.at, agent: u.kind === 'agents' ? u.agent : null }
    s.byKind[u.kind] += u.amount
    s.first = Math.min(s.first, u.at)
    if (!s.agent && u.kind === 'agents') s.agent = u.agent
    sums.set(key, s)
  }

  // work done again: in the order the jobs started, each job against those before it
  const ordered = [...o.jobs].filter((j) => !j.parentJob || !byId.has(j.parentJob)).sort((a, b) => (a.startedAt ?? a.queuedAt ?? a.updatedAt) - (b.startedAt ?? b.queuedAt ?? b.updatedAt))
  const repeats = new Map<string, JobSpend['repeat']>()
  const branches = new Map<string, string>()
  const asks = new Map<string, string>()
  for (const j of ordered) {
    const earlierOnBranch = j.branch ? branches.get(j.branch) : undefined
    const ask = `${j.agent ?? ''}\u0000${sameAsk(j.title)}`
    const earlierAsk = asks.get(ask)
    if (o.sentBack?.has(j.id)) repeats.set(j.id, { kind: 'sent_back', of: earlierOnBranch ?? null })
    else if (j.resumeOf) { /* the same work, carried on */ }
    else if (earlierOnBranch) repeats.set(j.id, { kind: 'redone', of: earlierOnBranch })
    else if (earlierAsk && j.kind === 'task') repeats.set(j.id, { kind: 'duplicate', of: earlierAsk })
    if (j.branch && !branches.has(j.branch)) branches.set(j.branch, j.id)
    if (!asks.has(ask)) asks.set(ask, j.id)
  }

  const rows: JobSpend[] = []
  for (const [key, s] of sums) {
    const amount = cents(s.byKind.agents + s.byKind.gpu + s.byKind.cpu + s.byKind.tools)
    for (const k of Object.keys(s.byKind) as UsageKind[]) s.byKind[k] = cents(s.byKind[k])
    if (key === NONE) {
      rows.push({ id: null, agent: null, title: 'Not tied to a job', stage: null, outcome: 'unknown', started: null, ended: null, seconds: null, amount, byKind: s.byKind, workers: 0, repeat: null })
      continue
    }
    const j = byId.get(key)
    const started = j?.startedAt ?? null
    const ended = j?.endedAt ?? null
    const outcome = j ? outcomeOf(j, o.now, o.staleAfter) : 'unknown'
    rows.push({
      id: key, agent: j?.agent ?? s.agent, title: j ? shownJobTitle(j) : 'A job no longer in the job index',
      stage: stageAt(o.timeline, started ?? j?.queuedAt ?? s.first), outcome, started, ended,
      seconds: started === null ? null : Math.max(0, Math.round((ended ?? (outcome === 'running' ? o.now : j?.beatAt ?? o.now)) - started)),
      amount, byKind: s.byKind, workers: workers.get(key)?.size ?? 0, repeat: repeats.get(key) ?? null,
    })
  }
  // the rows not tied to a job have no start: put each in the stage of when it ran
  const none = rows.find((r) => r.id === null)
  const stageOfNone = new Map<StageId, number>()
  if (none) {
    for (const u of o.usage) {
      if (u.amount === null || u.kind === 'agents') continue
      const id = u.jobId && batchOf.has(u.jobId) ? batchOf.get(u.jobId) ?? null : runningAt(u.at)
      if (id) continue
      const st = stageAt(o.timeline, u.at)
      if (st) stageOfNone.set(st, (stageOfNone.get(st) ?? 0) + u.amount)
    }
  }
  rows.sort((a, b) => (a.started ?? Number.POSITIVE_INFINITY) - (b.started ?? Number.POSITIVE_INFINITY))

  const stages = new Map<StageId, StageSpend>()
  const add = (st: StageId, amount: number, r?: JobSpend): void => {
    const s = stages.get(st) ?? { stage: st, amount: 0, jobs: 0, repeated: 0, wasted: 0 }
    s.amount += amount
    if (r) {
      s.jobs++
      if (r.repeat) s.repeated += amount
      if (r.outcome === 'failed' || r.outcome === 'cancelled' || r.outcome === 'lost') s.wasted += amount
    }
    stages.set(st, s)
  }
  for (const r of rows) if (r.id !== null && r.stage) add(r.stage, r.amount, r)
  for (const [st, n] of stageOfNone) add(st, n)
  const stageRows = [...stages.values()].map((s) => ({ ...s, amount: cents(s.amount), repeated: cents(s.repeated), wasted: cents(s.wasted) }))
    .sort((a, b) => STAGE_IDS.indexOf(a.stage) - STAGE_IDS.indexOf(b.stage))
  return {
    jobs: rows,
    stages: stageRows,
    total: cents(rows.reduce((n, r) => n + r.amount, 0)),
    repeated: cents(rows.filter((r) => r.repeat).reduce((n, r) => n + r.amount, 0)),
    wasted: cents(rows.filter((r) => r.outcome === 'failed' || r.outcome === 'cancelled' || r.outcome === 'lost').reduce((n, r) => n + r.amount, 0)),
  }
}

export interface StageWarning {
  level: 'near' | 'over' | 'spent'
  stage: StageId
  /** the current stage's cloud spend */
  spent: number
  /** its share: what is left of the budget for cloud work at the stage's start, split across it and the stages after */
  share: number
  /** what the budget leaves for cloud work from the stage's start (budget less orders, committed, forecast and the
   * cloud spend of earlier stages); negative: over */
  left: number
  /** the stages the share is split across, this one included */
  stagesLeft: number
  /** the stage's biggest jobs, most first */
  top: JobSpend[]
}

/** Warn at this part of the stage's share, before it is passed. */
export const NEAR_SHARE = 0.75

/**
 * A warning before the current stage overruns: when its cloud spend passes NEAR_SHARE of its share of the budget (what
 * the budget has left for cloud work when it started, split evenly across it and the stages after), or the budget has
 * nothing left for cloud work. Null without a budget, or while the stage is within NEAR_SHARE of its share. cost.get
 * gives it the cloud-work allowance with nothing else against it (`other` 0): the build budget is the order's.
 */
export function stageWarning(o: {
  budget: number | null | undefined; other: number; cloud: number; stage: StageId; stagesLeft: number; spend: SpendByJob; top?: number
}): StageWarning | null {
  if (o.budget === null || o.budget === undefined || o.stagesLeft < 1) return null
  const spent = o.spend.stages.find((s) => s.stage === o.stage)?.amount ?? 0
  const left = cents(o.budget - o.other - (o.cloud - spent))
  const share = cents(Math.max(0, left) / o.stagesLeft)
  const level = left <= 0 || (spent > 0 && spent >= left) ? 'spent' as const : spent > share ? 'over' as const : spent >= share * NEAR_SHARE && spent > 0 ? 'near' as const : null
  if (!level) return null
  const top = o.spend.jobs.filter((j) => j.stage === o.stage && j.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, o.top ?? 3)
  return { level, stage: o.stage, spent, share, left, stagesLeft: o.stagesLeft, top }
}

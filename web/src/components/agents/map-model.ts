/**
 * The model behind the agents map (docs/agents-screen.md): what each agent's box says, which hand-offs join which boxes,
 * where each box sits, and each project's line in "Projects at a glance". Pure, so the screen and its tests read the
 * same rules.
 *
 * - An agent's box lists its work one line per project: the most pressing project first (the one its status comes
 *   from), then running, paused and queued work. On All projects the box summarises every project; filtered, only that
 *   project's line is left.
 * - Hand-offs are drawn as one arrow per pair of agents (asker → asked), counting every hand-off on it across the
 *   projects in view. Open ones always show; ended ones (answered, declined, failed) only for an hour after they ended.
 * - Boxes sit on a three-wide grid in a fixed order, so the picture holds still as work comes and goes.
 */
import type { AgentState, Handoff, InboxItem, RunSummary } from '@/lib/types'
import type { AgentWork, HandoffItem, ProjectWork, WorkItem } from './use-agents'

// ------------------------------------------------------------------ project colours

/** How many project colours the theme has (--project-1 … --project-6); more projects reuse them in turn. */
export const PROJECT_TONES = 6

/** A project's colour, by its place in the person's project list, so it is the same on every screen. */
export const projectTone = (index: number): string => `var(--project-${(((index % PROJECT_TONES) + PROJECT_TONES) % PROJECT_TONES) + 1})`

// ------------------------------------------------------------------ an agent's box

export type RowState = 'running' | 'paused' | 'queued' | 'waiting' | 'stuck'

/** One line of an agent's box: its work on one project. */
export interface AgentRow {
  repo: string
  project: string
  title: string
  state: RowState
  /** "3/5" (step 3 of 5), "Paused", "Next", "#2", or null when nothing is known */
  step: string | null
  /** 0..1, or null when the work's size is not known */
  progress: number | null
  /** other jobs of this agent on the same project (queued behind, or running alongside) */
  more: number
}

const RANK: Record<RowState, number> = { stuck: 0, waiting: 1, running: 2, paused: 3, queued: 4 }

const stepOf = (run: RunSummary): string | null => {
  if (run.state === 'paused') return 'Paused'
  if (run.state === 'queued') return run.position === 1 ? 'Next' : run.position ? `#${run.position}` : 'Queued'
  if (run.stepIndex && run.stepCount) return `${run.stepIndex}/${run.stepCount}`
  return null
}

const progressOf = (run: RunSummary): number | null => {
  if (run.state === 'queued') return null
  if (typeof run.progress === 'number') return Math.max(0, Math.min(1, run.progress))
  if (run.stepIndex && run.stepCount) return Math.max(0, Math.min(1, run.stepIndex / run.stepCount))
  return null
}

const stateOf = (run: RunSummary): RowState => (run.state === 'paused' ? 'paused' : run.state === 'queued' ? 'queued' : 'running')

/** A hand-off's job without its "Asked by the Thermal specialist: " lead: the map's arrow already says who asked. */
export const workTitle = (title: string): string => title.replace(/^Asked by the .+? specialist:\s*/i, '').trim() || title

/** A status line without its "Stuck: " or "Waiting on a person: " lead. */
export const saysText = (says: string): string => says.replace(/^(Stuck|Waiting on a person|Working|Queued|Idle):\s*/i, '').trim()

/** The lines of an agent's box: one per project it has work on, the most pressing first. Pure. */
export function rowsOf(w: AgentWork | undefined): AgentRow[] {
  if (!w) return []
  const byRepo = new Map<string, { first: WorkItem; count: number }>()
  for (const x of [...w.now, ...w.queue]) {
    const at = byRepo.get(x.repo)
    if (at) at.count++
    else byRepo.set(x.repo, { first: x, count: 1 })
  }
  const rows: AgentRow[] = [...byRepo.values()].map(({ first, count }) => ({
    repo: first.repo, project: first.project, title: workTitle(first.run.title), state: stateOf(first.run), step: stepOf(first.run), progress: progressOf(first.run), more: count - 1,
  }))
  // the project the agent's status comes from: its line says so, or gets one when the agent has no job there
  if ((w.status === 'stuck' || w.status === 'waiting_person') && w.project) {
    const pressing: RowState = w.status === 'stuck' ? 'stuck' : 'waiting'
    const row = rows.find((r) => r.project === w.project)
    if (row) {
      row.state = pressing
      row.title = saysText(w.says) || row.title
    } else {
      rows.push({ repo: w.repo ?? '', project: w.project, title: saysText(w.says) || (pressing === 'stuck' ? 'Stuck' : 'Waiting on a person'), state: pressing, step: null, progress: null, more: 0 })
    }
  }
  return rows.sort((a, b) => RANK[a.state] - RANK[b.state])
}

/** "Queue 2 · Today 8 of 9 passed": the box's last line. Pure. */
export function footerOf(w: AgentWork | undefined): string {
  const parts: string[] = []
  if (w && w.queue.length) parts.push(`Queue ${w.queue.length}`)
  const t = w?.today
  parts.push(!t || t.runs === 0 ? 'No runs today' : `Today ${t.succeeded} of ${t.runs} passed`)
  return parts.join(' · ')
}

// ------------------------------------------------------------------ hand-off arrows

export type LinkState = 'running' | 'waiting' | 'answered' | 'ended'

/** One arrow: every hand-off from one agent to another on the projects in view. */
export interface AgentLink {
  id: string
  from: string
  fromName: string
  to: string
  toName: string
  state: LinkState
  /** open ones first, then the newest */
  items: HandoffItem[]
}

/** How long an ended hand-off stays on the map. */
export const RECENT_MS = 60 * 60_000

export const isOpenHandoff = (h: Pick<Handoff, 'state'>): boolean => h.state === 'requested' || h.state === 'queued' || h.state === 'running'

const endedAt = (h: Handoff): string => h.answer?.at ?? h.declined?.at ?? h.createdAt

/** Whether a hand-off belongs on the map now: open, or ended within the last hour. Pure. */
export const onMap = (h: Handoff, now: number, recentMs = RECENT_MS): boolean =>
  isOpenHandoff(h) || now - Date.parse(endedAt(h)) <= recentMs

/** The hand-offs as one arrow per pair of agents, with how each reads (the liveliest of its hand-offs). Pure. */
export function linksOf(handoffs: readonly HandoffItem[], now: number, recentMs = RECENT_MS): AgentLink[] {
  const by = new Map<string, AgentLink>()
  for (const x of handoffs) {
    const h = x.handoff
    if (!h.from || !h.to || h.from === h.to || !onMap(h, now, recentMs)) continue
    const id = `${h.from}>${h.to}`
    const link = by.get(id) ?? { id, from: h.from, fromName: h.fromName, to: h.to, toName: h.toName, state: 'ended' as LinkState, items: [] }
    link.items.push(x)
    by.set(id, link)
  }
  const order: Record<LinkState, number> = { running: 0, waiting: 1, answered: 2, ended: 3 }
  for (const l of by.values()) {
    const states = l.items.map((x) => x.handoff.state)
    l.state = states.includes('running') ? 'running' : states.some((s) => s === 'requested' || s === 'queued') ? 'waiting' : states.includes('answered') ? 'answered' : 'ended'
    l.items.sort((a, b) => Number(isOpenHandoff(b.handoff)) - Number(isOpenHandoff(a.handoff)) || b.handoff.createdAt.localeCompare(a.handoff.createdAt))
  }
  return [...by.values()].sort((a, b) => order[a.state] - order[b.state] || b.items.length - a.items.length)
}

// ------------------------------------------------------------------ where each box sits

/** The agents' places on a three-wide grid: askers above or left of the ones they usually ask. */
const SLOTS: Record<string, [col: number, row: number]> = {
  verify: [0, 0], impl: [1, 0], worker: [2, 0],
  ams: [0, 1], emc: [1, 1],
  thermal: [0, 2], docs: [1, 2], render: [2, 2],
}
export const COLUMNS = 3

/** Each agent's cell; agents without a fixed place fill the free cells in reading order. Pure. */
export function layoutOf(ids: readonly string[]): Map<string, { col: number; row: number }> {
  const at = new Map<string, { col: number; row: number }>()
  const taken = new Set<string>()
  for (const id of ids) {
    const s = SLOTS[id]
    if (s) { at.set(id, { col: s[0], row: s[1] }); taken.add(`${s[0]},${s[1]}`) }
  }
  let cell = 0
  for (const id of ids) {
    if (at.has(id)) continue
    while (taken.has(`${cell % COLUMNS},${Math.floor(cell / COLUMNS)}`)) cell++
    const p = { col: cell % COLUMNS, row: Math.floor(cell / COLUMNS) }
    at.set(id, p)
    taken.add(`${p.col},${p.row}`)
  }
  return at
}

export type Side = 'left' | 'right' | 'top' | 'bottom'

/** Which sides an arrow leaves and enters by, from where the two cells sit. Pure. */
export function sidesFor(a: { col: number; row: number }, b: { col: number; row: number }): { from: Side; to: Side } {
  const dx = b.col - a.col
  const dy = b.row - a.row
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' }
  return dy >= 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' }
}

/** The agents an agent asked or was asked by, on the arrows drawn. Pure. */
export function linkedAgents(links: readonly Pick<AgentLink, 'id' | 'from' | 'to'>[], id: string): { nodes: Set<string>; links: Set<string> } {
  const nodes = new Set([id])
  const on = new Set<string>()
  for (const l of links) {
    if (l.from !== id && l.to !== id) continue
    nodes.add(l.from === id ? l.to : l.from)
    on.add(l.id)
  }
  return { nodes, links: on }
}

// ------------------------------------------------------------------ projects at a glance

export type AgentStatus = AgentState['status']

/** One project's line in "Projects at a glance". */
export interface ProjectGlance {
  repo: string
  project: string
  tone: string
  paused: boolean
  /** how many of its agents are in each state */
  counts: Record<AgentStatus, number>
  /** jobs running or paused, and queued */
  running: number
  queued: number
  /** hand-offs open, and ended in the last hour */
  open: number
  recent: number
  /** things on Next for this project (questions, gates, stuck reports, …) */
  needs: number
}

const ZERO = (): Record<AgentStatus, number> => ({ working: 0, waiting_person: 0, stuck: 0, queued: 0, idle: 0 })

/** Each project's summary, in the order of the person's projects. Pure. */
export function glanceOf(per: readonly ProjectWork[], inbox: readonly InboxItem[], now: number, tones: ReadonlyMap<string, string>): ProjectGlance[] {
  return per.map((p) => {
    const counts = ZERO()
    for (const a of p.agents) counts[a.status]++
    const open = p.handoffs.filter(isOpenHandoff).length
    return {
      repo: p.repo, project: p.project, tone: tones.get(p.repo) ?? projectTone(0), paused: p.paused, counts,
      running: p.jobs.filter((j) => j.state === 'running' || j.state === 'paused').length,
      queued: p.jobs.filter((j) => j.state === 'queued').length,
      open, recent: p.handoffs.filter((h) => !isOpenHandoff(h) && onMap(h, now)).length,
      needs: inbox.filter((i) => i.repo === p.repo).length,
    }
  })
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** "2 working · 1 waiting on you · 1 stuck" for a project's agents; "Nothing running" when all are idle. Pure. */
export function countsText(c: Record<AgentStatus, number>): string {
  const parts = [
    c.working && `${c.working} working`,
    c.waiting_person && `${c.waiting_person} waiting on a person`,
    c.stuck && `${c.stuck} stuck`,
    c.queued && `${c.queued} queued`,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Nothing running'
}

/** "3 hand-offs open · 1 answered in the last hour". Pure. */
export function handoffText(open: number, recent: number): string {
  const a = open ? `${plural(open, 'hand-off')} open` : 'No hand-offs open'
  return recent ? `${a} · ${recent} ended in the last hour` : a
}

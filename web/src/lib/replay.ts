/**
 * Replay (docs/ontology-plan.md P8.3): the project's record played back in the graph view. journey.replay
 * (src/api/actions-replay.ts) answers with the record's events oldest first, each naming the graph node it changes,
 * the status it gives it and the nodes it touches; these pure rules build the graph as it stands after any event, so
 * the player (components/graph/replay.tsx) only moves a playhead.
 */
import { type Graph, type GraphLink, type GraphNode, type LinkKind, type NodeKind, type NodeStatus, readGraph } from './graph'

export interface ReplayEvent {
  /** unique and stable: <source>:<key>:<what> */
  id: string
  /** seconds since 1970 */
  t: number
  at: string
  /** what happened, as <thing>.<verb>: stage.started, criterion.met, gate.signed … */
  kind: string
  /** the ontology class of the record it comes from */
  class: string
  /** the record, as the graph names it (urn:trace:…) */
  record: string
  /** where it is read from: <database>.<table> */
  source: string
  node: string | null
  status?: NodeStatus
  links?: string[]
  who: string | null
  stage: string | null
  caption: string
}

export interface ReplayChapter {
  stage: string
  name: string
  t: number
  at: string
}

export interface ReplayPage {
  repo: string
  events: ReplayEvent[]
  next: string | null
  total: number
  range: { from: string; to: string } | null
  chapters: ReplayChapter[]
  people: string[]
  nodes: Record<string, unknown>
}

/** The whole replay, every page read. */
export interface Replay {
  events: ReplayEvent[]
  chapters: ReplayChapter[]
  people: string[]
  nodes: Map<string, GraphNode>
}

/** Pages put together, each page's nodes read as the graph reads them. */
export function joinPages(pages: readonly ReplayPage[]): Replay {
  const events: ReplayEvent[] = []
  const nodes = new Map<string, GraphNode>()
  for (const p of pages) {
    events.push(...p.events)
    for (const n of readGraph({ nodes: Object.values(p.nodes) }).nodes) nodes.set(n.id, n)
  }
  return { events, chapters: pages[0]?.chapters ?? [], people: pages[0]?.people ?? [], nodes }
}

/** A node the replay names but the record does not have any more: named by its id. */
function stub(id: string): GraphNode | null {
  const at = id.indexOf(':')
  const prefix = at > 0 ? id.slice(0, at) : ''
  const kinds: Record<string, NodeKind> = { gate: 'gate', criterion: 'criterion', waiver: 'waiver', decision: 'decision', person: 'person', run: 'run', test: 'run', requirement: 'requirement', intent: 'intent', block: 'block', part: 'part', component: 'component', net: 'net', artifact: 'artifact', case: 'case' }
  const kind = kinds[prefix]
  return kind ? { id, kind, label: id.slice(at + 1) } : null
}

/** How two nodes an event joins are linked, in the graph's words. */
export function linkKind(from: GraphNode, to: GraphNode): LinkKind {
  if (to.kind === 'person' || from.kind === 'person') return 'decided_by'
  if (from.kind === 'waiver') return 'waives'
  if (from.kind === 'gate' && to.kind === 'criterion') return 'contains'
  if (from.kind === 'run') return to.kind === 'run' ? 'related' : 'proves'
  return 'related'
}

/** Which events count: all, or one person's or specialist's. */
export function shown(e: ReplayEvent, who: string | null): boolean {
  return !who || e.who === who
}

/**
 * The graph after the first `upTo` events (0: nothing yet): each node an event names, with the status the last event
 * about it gave it, and each link an event made. `who` keeps one person's or specialist's events.
 */
export function graphAt(r: Replay, upTo: number, who: string | null = null): Graph {
  const nodes = new Map<string, GraphNode>()
  const links = new Map<string, GraphLink>()
  const node = (id: string): GraphNode | null => {
    const had = nodes.get(id)
    if (had) return had
    const base = r.nodes.get(id) ?? stub(id)
    if (!base) return null
    // the record's status today is not the status then: a node starts with none, and events give it one
    const { status: _now, ...then } = base
    void _now
    nodes.set(id, then)
    return then
  }
  for (const e of r.events.slice(0, Math.max(0, upTo))) {
    if (!shown(e, who) || !e.node) continue
    const n = node(e.node)
    if (!n) continue
    if (e.status) nodes.set(n.id, { ...n, status: e.status })
    for (const l of e.links ?? []) {
      const m = node(l)
      if (!m || m.id === n.id) continue
      const kind = linkKind(nodes.get(n.id)!, m)
      const id = `${n.id}>${kind}>${m.id}`
      links.set(id, { id, source: n.id, target: m.id, kind })
    }
  }
  return { nodes: [...nodes.values()], links: [...links.values()] }
}

/** The chapter the playhead is in: the last stage started at or before the event it shows. */
export function chapterAt(r: Replay, index: number): ReplayChapter | null {
  const e = r.events[Math.min(index, r.events.length - 1)]
  if (!e) return null
  let found: ReplayChapter | null = null
  for (const c of r.chapters) if (c.t <= e.t) found = c
  return found
}

/** Where each chapter starts, as an event index (for the scrubber's marks and the stage chips). */
export function chapterIndex(r: Replay, c: ReplayChapter): number {
  const i = r.events.findIndex((e) => e.t >= c.t)
  return i < 0 ? r.events.length : i
}

/** The next event index to show when playing with a filter: skip the events the filter hides. */
export function step(r: Replay, from: number, who: string | null): number {
  let i = from + 1
  while (i < r.events.length && !shown(r.events[i - 1]!, who)) i++
  return Math.min(i, r.events.length)
}

/** The speeds the player offers, in events a second. */
export const SPEEDS = [0.5, 1, 2, 4, 8] as const

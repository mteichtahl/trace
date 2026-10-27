/**
 * The knowledge graph (docs/ui-design.md, "Graph view"): the shapes graph.neighbourhood answers with, and the pure
 * rules the view follows, kept apart from Cytoscape so they are tested on their own: filtering by kind, distance
 * from the focus (the Tab order), the shortest path between two items (in words), failing chains back to the intent,
 * and grouping beyond about 150 items into "+N more".
 *
 * The contract (docs/web-build.md) gives `{ nodes, links }` without fixing their fields; the shapes below are the
 * app's reading of them ("assumed"), and readGraph() accepts the obvious variants (source/target or from/to).
 */

export const NODE_KINDS = ['intent', 'requirement', 'block', 'part', 'datasheet', 'run', 'decision', 'memory', 'document', 'person'] as const
export type NodeKind = (typeof NODE_KINDS)[number]

export const LINK_KINDS = ['derived_from', 'serves', 'uses', 'proves', 'fails', 'cites', 'decided_in', 'waives', 'learned_from', 'related'] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export type NodeStatus = 'verified' | 'failing' | 'untested' | 'waived' | 'active' | 'inactive'

export interface GraphNode {
  id: string
  kind: NodeKind
  /** short label drawn on the node ("R-006", "SX1262") */
  label: string
  /** what it is in words ("Reaches a gateway 2 km away") */
  title?: string
  /** one-line summary for hovers and the side sheet */
  summary?: string
  status?: NodeStatus
  /** where Open goes, in the app */
  to?: string
  /** a few facts for the side sheet ("Run id": "run_8e14") */
  facts?: Record<string, string>
  /** the project it belongs to; absent for the shared library */
  repo?: string
}

export interface GraphLink {
  id: string
  source: string
  target: string
  kind: LinkKind
}

export interface Graph {
  nodes: GraphNode[]
  links: GraphLink[]
}

export const NODE_WORD: Record<NodeKind, { one: string; many: string }> = {
  intent: { one: 'Intent statement', many: 'intent statements' },
  requirement: { one: 'Requirement', many: 'requirements' },
  block: { one: 'Block', many: 'blocks' },
  part: { one: 'Part', many: 'parts' },
  datasheet: { one: 'Datasheet page', many: 'datasheet pages' },
  run: { one: 'Run or evidence', many: 'runs' },
  decision: { one: 'Decision or waiver', many: 'decisions' },
  memory: { one: 'Memory', many: 'memories' },
  document: { one: 'Document', many: 'documents' },
  person: { one: 'Person', many: 'people' },
}

export const LINK_WORD: Record<LinkKind, string> = {
  derived_from: 'derived from',
  serves: 'serves',
  uses: 'uses',
  proves: 'proves',
  fails: 'fails',
  cites: 'cites',
  decided_in: 'decided in',
  waives: 'waives',
  learned_from: 'learned from',
  related: 'related by meaning',
}

const isKind = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v)

/** Read graph.neighbourhood's answer; unknown kinds and links to missing nodes are dropped. */
export function readGraph(r: { nodes?: unknown[]; links?: unknown[] } | undefined): Graph {
  const nodes: GraphNode[] = []
  for (const x of r?.nodes ?? []) {
    if (!x || typeof x !== 'object') continue
    const n = x as Record<string, unknown>
    const kind = n.kind ?? n.type
    if (typeof n.id !== 'string' || !isKind(NODE_KINDS, kind)) continue
    nodes.push({
      id: n.id,
      kind,
      label: typeof n.label === 'string' ? n.label : n.id,
      ...(typeof n.title === 'string' ? { title: n.title } : {}),
      ...(typeof n.summary === 'string' ? { summary: n.summary } : {}),
      ...(typeof n.status === 'string' ? { status: n.status as NodeStatus } : {}),
      ...(typeof n.to === 'string' ? { to: n.to } : {}),
      ...(n.facts && typeof n.facts === 'object' ? { facts: n.facts as Record<string, string> } : {}),
      ...(typeof n.repo === 'string' ? { repo: n.repo } : {}),
    })
  }
  const ids = new Set(nodes.map((n) => n.id))
  const links: GraphLink[] = []
  for (const x of r?.links ?? []) {
    if (!x || typeof x !== 'object') continue
    const l = x as Record<string, unknown>
    const source = (l.source ?? l.from) as unknown
    const target = (l.target ?? l.to) as unknown
    const kind = l.kind ?? l.type
    if (typeof source !== 'string' || typeof target !== 'string' || !ids.has(source) || !ids.has(target) || !isKind(LINK_KINDS, kind)) continue
    links.push({ id: typeof l.id === 'string' ? l.id : `${source}>${kind}>${target}`, source, target, kind })
  }
  return { nodes, links }
}

/** Two graphs as one (Expand adds a node's own links), without duplicates. */
export function mergeGraphs(a: Graph, b: Graph): Graph {
  const nodes = new Map(a.nodes.map((n) => [n.id, n]))
  for (const n of b.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n)
  const links = new Map(a.links.map((l) => [l.id, l]))
  for (const l of b.links) if (!links.has(l.id)) links.set(l.id, l)
  return { nodes: [...nodes.values()], links: [...links.values()] }
}

export interface GraphFilter {
  nodeKinds: Set<NodeKind>
  linkKinds: Set<LinkKind>
  /** "Related by meaning" (dashed links) shown */
  meaning: boolean
  hidden: Set<string>
}

/** Only the kinds chosen; links need both ends shown; the focus always stays. */
export function filterGraph(g: Graph, f: GraphFilter, focus?: string): Graph {
  const nodes = g.nodes.filter((n) => n.id === focus || (f.nodeKinds.has(n.kind) && !f.hidden.has(n.id)))
  const ids = new Set(nodes.map((n) => n.id))
  const links = g.links.filter((l) => ids.has(l.source) && ids.has(l.target) && f.linkKinds.has(l.kind) && (f.meaning || l.kind !== 'related'))
  return { nodes, links }
}

function adjacency(g: Graph): Map<string, { to: string; link: GraphLink }[]> {
  const adj = new Map<string, { to: string; link: GraphLink }[]>(g.nodes.map((n) => [n.id, []]))
  for (const l of g.links) {
    adj.get(l.source)?.push({ to: l.target, link: l })
    adj.get(l.target)?.push({ to: l.source, link: l })
  }
  return adj
}

/** Links out from the focus to each node (breadth first, either direction). Unreachable nodes are left out. */
export function distances(g: Graph, focus: string): Map<string, number> {
  const adj = adjacency(g)
  const d = new Map<string, number>()
  if (!adj.has(focus)) return d
  d.set(focus, 0)
  const queue = [focus]
  while (queue.length) {
    const at = queue.shift()!
    for (const { to } of adj.get(at) ?? []) {
      if (d.has(to)) continue
      d.set(to, d.get(at)! + 1)
      queue.push(to)
    }
  }
  return d
}

/** The Tab order: by distance from the focus, then kind order, then label. */
export function tabOrder(g: Graph, focus: string): string[] {
  const d = distances(g, focus)
  const kindIndex = (k: NodeKind) => NODE_KINDS.indexOf(k)
  return [...g.nodes]
    .sort((a, b) => (d.get(a.id) ?? 99) - (d.get(b.id) ?? 99) || kindIndex(a.kind) - kindIndex(b.kind) || a.label.localeCompare(b.label))
    .map((n) => n.id)
}

export interface PathStep {
  node: GraphNode
  /** the link that leads to the next step */
  link?: GraphLink
}

/** The shortest path from `from` to `to` over recorded links (related-by-meaning only when nothing else joins them). */
export function shortestPath(g: Graph, from: string, to: string): PathStep[] | null {
  const run = (useMeaning: boolean): PathStep[] | null => {
    const gg = useMeaning ? g : { nodes: g.nodes, links: g.links.filter((l) => l.kind !== 'related') }
    const adj = adjacency(gg)
    if (!adj.has(from) || !adj.has(to)) return null
    const prev = new Map<string, { at: string; link: GraphLink } | null>([[from, null]])
    const queue = [from]
    while (queue.length) {
      const at = queue.shift()!
      if (at === to) break
      for (const e of adj.get(at) ?? []) {
        if (prev.has(e.to)) continue
        prev.set(e.to, { at, link: e.link })
        queue.push(e.to)
      }
    }
    if (!prev.has(to)) return null
    const byId = new Map(g.nodes.map((n) => [n.id, n]))
    const ids: { id: string; link?: GraphLink }[] = []
    let cur: string | undefined = to
    let via: GraphLink | undefined
    while (cur !== undefined) {
      ids.unshift({ id: cur, ...(via ? { link: via } : {}) })
      const p = prev.get(cur)
      via = p?.link
      cur = p?.at
    }
    return ids.map((x) => ({ node: byId.get(x.id)!, ...(x.link ? { link: x.link } : {}) }))
  }
  return run(false) ?? run(true)
}

/** "Bench range test → R-006 → Antenna block → u.FL connector" */
export const pathWords = (p: PathStep[]): string => p.map((s) => s.node.title ?? s.node.label).join(' → ')

/**
 * With "Show failing chains" on: every failing run, the requirement it fails, and everything that requirement is
 * derived from, back to the intent. Returns the node and link ids to colour red.
 */
export function failingChains(g: Graph): { nodes: Set<string>; links: Set<string> } {
  const nodes = new Set<string>()
  const links = new Set<string>()
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  // follow "derived from" upwards only: requirement → the requirement or intent line it comes from; an intent ends it
  const up = (id: string) => {
    if (byId.get(id)?.kind === 'intent') return
    for (const l of g.links) {
      if (l.kind !== 'derived_from' || l.source !== id || nodes.has(l.target)) continue
      const n = byId.get(l.target)
      if (n && (n.kind === 'intent' || n.kind === 'requirement')) {
        nodes.add(l.target)
        links.add(l.id)
        up(l.target)
      }
    }
  }
  for (const l of g.links) {
    if (l.kind !== 'fails') continue
    nodes.add(l.source)
    nodes.add(l.target)
    links.add(l.id)
    const req = byId.get(l.target)?.kind === 'requirement' ? l.target : l.source
    up(req)
  }
  for (const n of g.nodes) if (n.status === 'failing') nodes.add(n.id)
  return { nodes, links }
}

export interface GroupNode {
  id: string
  kind: NodeKind
  /** the ids gathered in the group */
  members: string[]
  /** "+12 more parts" */
  label: string
  /** the node they all hang from */
  parent: string
}

/**
 * Keep at most `max` items drawn: the farthest items of the most numerous kinds gather into groups ("+12 more
 * parts") hanging from the node most of them link to. The focus and anything on the selected path are never grouped.
 */
export function groupBeyond(g: Graph, focus: string, max = 150, keep: Set<string> = new Set()): { graph: Graph; groups: GroupNode[] } {
  if (g.nodes.length <= max) return { graph: g, groups: [] }
  const d = distances(g, focus)
  // take from the most numerous kinds first, their farthest items first, keeping a few of each kind drawn
  const room = max - NODE_KINDS.length
  let excess = g.nodes.length - room
  const shown = new Set(g.nodes.map((n) => n.id))
  const byKind = NODE_KINDS.map((k) => ({ k, ids: g.nodes.filter((n) => n.kind === k && n.id !== focus && !keep.has(n.id)).sort((a, b) => (d.get(b.id) ?? 99) - (d.get(a.id) ?? 99)).map((n) => n.id) }))
    .sort((a, b) => b.ids.length - a.ids.length)
  for (const { ids } of byKind) {
    if (excess <= 0) break
    const take = Math.min(excess, Math.max(0, ids.length - 3))
    ids.slice(0, take).forEach((id) => shown.delete(id))
    excess -= take
  }
  const rest = g.nodes.filter((n) => !shown.has(n.id))
  const groups: GroupNode[] = []
  for (const kind of NODE_KINDS) {
    const members = rest.filter((n) => n.kind === kind).map((n) => n.id)
    if (!members.length) continue
    // the shown node most of them link to (or the focus)
    const votes = new Map<string, number>()
    for (const l of g.links) {
      const m = members.includes(l.source) ? l.target : members.includes(l.target) ? l.source : null
      if (m && shown.has(m)) votes.set(m, (votes.get(m) ?? 0) + 1)
    }
    const parent = [...votes.entries()].sort((a, b) => b[1] - a[1] || (d.get(a[0]) ?? 99) - (d.get(b[0]) ?? 99))[0]?.[0] ?? focus
    groups.push({ id: `group:${kind}`, kind, members, parent, label: `+${members.length} more ${members.length === 1 ? NODE_WORD[kind].one.toLowerCase() : NODE_WORD[kind].many}` })
  }
  const nodes = g.nodes.filter((n) => shown.has(n.id))
  const links = g.links.filter((l) => shown.has(l.source) && shown.has(l.target))
  return { graph: { nodes, links }, groups }
}

/** The links of one node, grouped by their words ("proves", "learned from"), for the side sheet. */
export function linksOf(g: Graph, id: string): { word: string; items: { node: GraphNode; link: GraphLink }[] }[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const groups = new Map<string, { node: GraphNode; link: GraphLink }[]>()
  for (const l of g.links) {
    const other = l.source === id ? l.target : l.target === id ? l.source : null
    if (!other) continue
    const n = byId.get(other)
    if (!n) continue
    const word = LINK_WORD[l.kind]
    groups.set(word, [...(groups.get(word) ?? []), { node: n, link: l }])
  }
  return [...groups.entries()].map(([word, items]) => ({ word, items }))
}

/** One row per link, for the List switch (item, kind, link, linked to, status). */
export interface ListRow {
  id: string
  item: string
  kind: string
  link: string
  linkedTo: string
  status: string
  nodeId: string
  distance: number
}

export function listRows(g: Graph, focus: string): ListRow[] {
  const d = distances(g, focus)
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const name = (n: GraphNode) => (n.title ? `${n.label} · ${n.title}` : n.label)
  const rows: ListRow[] = []
  for (const l of g.links) {
    const a = byId.get(l.source)
    const b = byId.get(l.target)
    if (!a || !b) continue
    // write each row from the end nearer the focus outwards
    const [from, to] = (d.get(a.id) ?? 99) <= (d.get(b.id) ?? 99) ? [b, a] : [a, b]
    rows.push({ id: l.id, item: name(from), kind: NODE_WORD[from.kind].one, link: LINK_WORD[l.kind], linkedTo: name(to), status: statusWord(from.status), nodeId: from.id, distance: d.get(from.id) ?? 99 })
  }
  for (const n of g.nodes) {
    if (g.links.some((l) => l.source === n.id || l.target === n.id)) continue
    rows.push({ id: `solo:${n.id}`, item: name(n), kind: NODE_WORD[n.kind].one, link: '', linkedTo: '', status: statusWord(n.status), nodeId: n.id, distance: d.get(n.id) ?? 99 })
  }
  return rows.sort((x, y) => x.distance - y.distance)
}

export function statusWord(s: NodeStatus | undefined): string {
  switch (s) {
    case 'verified': return 'Verified'
    case 'failing': return 'Failing'
    case 'untested': return 'Untested'
    case 'waived': return 'Waived'
    case 'active': return 'Active'
    case 'inactive': return 'Switched off'
    default: return ''
  }
}

/**
 * graph.neighbourhood: what trace knows around one item, as nodes and links (docs/ui-design.md "Graph view").
 *
 * Built from ONE project's record after the read check, so it is filtered by access by construction: nothing of
 * another project is read, drawn, grouped or counted. From the project's database (default branch) and its journey record
 * (the journey store), like journey.get:
 *
 *   requirement   requirements                     test     test_items          run       runs (and test_results)
 *   gate          gates with their criteria        waiver   waivers             decision  decisions, answered questions
 *   person        who signed, answered, waived (their email as the record has it)
 *   memory        with `memory: true`, the project's long-term memories most like the focus, through the same memory
 *                 the agents recall from, and only the ones this person may see (never another person's preferences)
 *
 *   links   verifies (test → requirement), proves | fails (a result's run → each requirement of its test), ran (a
 *           result's run → its test), uses (a result's run → the tool runs it rests on), evidence (run → gate),
 *           waives (waiver → what it waives), decided in (decision → gate or question), signed | answered | waived
 *           (person → what they did), related (memory → the focus, by meaning: dashed)
 *
 * The focus is "<kind>:<id>" (requirement:REQ-001, run:4f2a…, gate:capture, person:<email>); depth 1 to 3 (2 by
 * default). At most 150 nodes are returned, nearest first; past that, the rest of each kind gather into one group node
 * ("+12 more runs") with their ids, linked to the focus.
 */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { ActionError, type Context, Repo, def, memoryInclude, projectMemory, withRecordDb } from './action-kit.js'

export const NODE_KINDS = ['requirement', 'test', 'run', 'gate', 'waiver', 'decision', 'person', 'memory', 'group'] as const
export type NodeKind = (typeof NODE_KINDS)[number]
export const LINK_KINDS = ['verifies', 'proves', 'fails', 'ran', 'uses', 'evidence', 'waives', 'decided in', 'signed', 'answered', 'waived', 'related', 'group'] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export interface GraphNode { id: string; kind: NodeKind; label: string; status: string | null; summary: string | null; members?: string[] | undefined; count?: number | undefined }
export interface GraphLink { source: string; target: string; kind: LinkKind; dashed?: boolean | undefined }

export const MAX_NODES = 150

const KIND_WORDS: Readonly<Record<NodeKind, string>> = {
  requirement: 'requirements', test: 'test items', run: 'runs', gate: 'gates', waiver: 'waivers', decision: 'decisions', person: 'people', memory: 'memories', group: 'groups',
}

const hasTable = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const list = (v: unknown): string[] => {
  if (typeof v !== 'string') return []
  try { const x: unknown = JSON.parse(v); return Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : [] } catch { return [] }
}
const evidenceRuns = (v: unknown): string[] => {
  if (typeof v !== 'string') return []
  try {
    const x: unknown = JSON.parse(v)
    return Array.isArray(x) ? x.flatMap((e) => (typeof e === 'object' && e !== null && (e as { kind?: unknown }).kind === 'run' && typeof (e as { ref?: unknown }).ref === 'string' ? [(e as { ref: string }).ref] : [])) : []
  } catch { return [] }
}
const short = (t: string, n = 80): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

/** The whole project graph from its database (bounded by what one project's record holds). */
export function projectGraph(db: DatabaseSync): { nodes: Map<string, GraphNode>; links: GraphLink[] } {
  const nodes = new Map<string, GraphNode>()
  const links: GraphLink[] = []
  const node = (n: GraphNode): void => { if (!nodes.has(n.id)) nodes.set(n.id, n) }
  const link = (source: string, target: string, kind: LinkKind): void => { links.push({ source, target, kind }) }
  const person = (who: string | null): string | null => {
    if (!who) return null
    const id = `person:${who}`
    node({ id, kind: 'person', label: who, status: null, summary: null })
    return id
  }
  const rows = (sql: string): Record<string, unknown>[] => db.prepare(sql).all() as Record<string, unknown>[]

  if (hasTable(db, 'requirements')) {
    for (const r of rows('SELECT id, text, kind, status FROM requirements')) {
      node({ id: `requirement:${String(r.id)}`, kind: 'requirement', label: String(r.id), status: s(r.status), summary: short(String(r.text), 200) })
    }
  }
  const testReqs = new Map<string, string[]>()
  if (hasTable(db, 'test_items')) {
    for (const t of rows('SELECT id, title, requirements, status FROM test_items')) {
      const id = `test:${String(t.id)}`
      node({ id, kind: 'test', label: String(t.id), status: s(t.status), summary: short(String(t.title), 200) })
      const reqs = list(t.requirements)
      testReqs.set(String(t.id), reqs)
      for (const req of reqs) link(id, `requirement:${req}`, 'verifies')
    }
  }
  const runs = new Map<string, Record<string, unknown>>()
  for (const r of rows('SELECT id, kind, subject, status, summary FROM runs ORDER BY started DESC LIMIT 2000')) runs.set(String(r.id), r)
  const runNode = (id: string): string => {
    const r = runs.get(id)
    node({ id: `run:${id}`, kind: 'run', label: r ? `${String(r.kind)}${r.subject ? ` · ${String(r.subject)}` : ''}` : id, status: r ? s(r.status) : null, summary: r ? s(r.summary) : null })
    return `run:${id}`
  }
  if (hasTable(db, 'test_results')) {
    for (const t of rows('SELECT run_id, test_id, status, evidence FROM test_results ORDER BY at DESC LIMIT 2000')) {
      const run = runNode(String(t.run_id))
      link(run, `test:${String(t.test_id)}`, 'ran')
      const verdict: LinkKind = t.status === 'pass' ? 'proves' : 'fails'
      if (t.status === 'pass' || t.status === 'fail') for (const req of testReqs.get(String(t.test_id)) ?? []) link(run, `requirement:${req}`, verdict)
      for (const e of list(t.evidence)) link(run, runNode(e), 'uses')
    }
  }
  if (hasTable(db, 'gates')) {
    for (const g of rows('SELECT id, name, stage FROM gates')) node({ id: `gate:${String(g.id)}`, kind: 'gate', label: `the ${String(g.name)} gate`, status: null, summary: null })
    for (const c of rows('SELECT id, gate, text, status, evidence FROM gate_criteria')) {
      for (const run of evidenceRuns(c.evidence)) link(runNode(run), `gate:${String(c.gate)}`, 'evidence')
    }
    for (const sig of rows('SELECT gate, by FROM gate_signatures WHERE superseded_at IS NULL')) {
      const g = `gate:${String(sig.gate)}`
      const n = nodes.get(g)
      if (n) n.status = 'signed'
      const p = person(s(sig.by))
      if (p) link(p, g, 'signed')
    }
    for (const w of rows('SELECT id, target_kind, target, gate, reason, severity, by, closed_at FROM waivers')) {
      const id = `waiver:${String(w.id)}`
      node({ id, kind: 'waiver', label: `waiver on ${String(w.target)}`, status: w.closed_at === null ? s(w.severity) : 'closed', summary: short(String(w.reason), 200) })
      const target = w.target_kind === 'criterion' ? `gate:${String(w.gate)}` : w.target_kind === 'requirement' ? `requirement:${String(w.target)}` : w.target_kind === 'test' ? `test:${String(w.target)}` : null
      if (target) link(id, target, 'waives')
      const p = person(s(w.by))
      if (p) link(p, id, 'waived')
    }
    for (const q of rows('SELECT id, text, answer, answered_by FROM questions WHERE answered_at IS NOT NULL')) {
      const id = `decision:q-${String(q.id)}`
      node({ id, kind: 'decision', label: short(String(q.answer ?? ''), 60), status: 'answered', summary: short(String(q.text), 200) })
      const p = person(s(q.answered_by))
      if (p) link(p, id, 'answered')
    }
    for (const d of rows("SELECT id, kind, ref, summary, by FROM decisions WHERE kind IN ('gate.signed', 'gate.returned', 'stage.reopened') ORDER BY at DESC LIMIT 500")) {
      const id = `decision:${String(d.id)}`
      node({ id, kind: 'decision', label: short(String(d.summary), 60), status: String(d.kind).split('.')[1] ?? null, summary: String(d.summary) })
      if (d.ref && nodes.has(`gate:${String(d.ref)}`)) link(id, `gate:${String(d.ref)}`, 'decided in')
    }
  }
  return { nodes, links: links.filter((l) => nodes.has(l.source) && nodes.has(l.target)) }
}

/** The neighbourhood of `focus` within `depth` links, nearest first, capped with groups. Pure. */
export function neighbourhood(g: { nodes: Map<string, GraphNode>; links: GraphLink[] }, focus: string, depth: number, o: { kinds?: readonly NodeKind[] | undefined; max?: number | undefined } = {}): { nodes: GraphNode[]; links: GraphLink[]; distance: Map<string, number> } {
  const max = o.max ?? MAX_NODES
  const adj = new Map<string, GraphLink[]>()
  for (const l of g.links) {
    if (!adj.has(l.source)) adj.set(l.source, [])
    if (!adj.has(l.target)) adj.set(l.target, [])
    adj.get(l.source)?.push(l)
    adj.get(l.target)?.push(l)
  }
  const distance = new Map<string, number>([[focus, 0]])
  const order = [focus]
  for (let i = 0; i < order.length; i++) {
    const at = order[i] as string
    const d = distance.get(at) ?? 0
    if (d >= depth) continue
    for (const l of adj.get(at) ?? []) {
      const other = l.source === at ? l.target : l.source
      if (distance.has(other)) continue
      const n = g.nodes.get(other)
      if (o.kinds && n && !o.kinds.includes(n.kind)) continue
      distance.set(other, d + 1)
      order.push(other)
    }
  }
  let kept = order
  const groups: GraphNode[] = []
  if (order.length > max) {
    const overflow = order.slice(max - Math.min(NODE_KINDS.length, 8))
    kept = order.slice(0, max - Math.min(NODE_KINDS.length, 8))
    const byKind = new Map<NodeKind, string[]>()
    for (const id of overflow) {
      const k = g.nodes.get(id)?.kind ?? 'group'
      byKind.set(k, [...(byKind.get(k) ?? []), id])
    }
    for (const [k, ids] of byKind) {
      groups.push({ id: `group:${k}`, kind: 'group', label: `+${ids.length} more ${KIND_WORDS[k]}`, status: null, summary: null, members: ids.slice(0, 500), count: ids.length })
    }
  }
  const keep = new Set(kept)
  const nodes = kept.map((id) => g.nodes.get(id)).filter((n): n is GraphNode => Boolean(n))
  const links = g.links.filter((l) => keep.has(l.source) && keep.has(l.target))
  for (const grp of groups) { nodes.push(grp); links.push({ source: focus, target: grp.id, kind: 'group', dashed: true }) }
  return { nodes, links, distance }
}

const Focus = z.string().min(3).max(400).regex(/^[a-z]+:.+$/, 'a focus such as requirement:REQ-001')

export const GRAPH_ACTIONS = {
  'graph.neighbourhood': def('read', Repo.extend({
    focus: Focus,
    depth: z.number().int().min(1).max(3).default(2),
    kinds: z.array(z.enum(NODE_KINDS)).optional(),
    memory: z.boolean().default(false),
    memory_top_k: z.number().int().min(1).max(20).default(6),
  }), async (a, ctx: Context) => {
    const g = await withRecordDb(ctx, a.repo, (db) => projectGraph(db))
    if (!g.nodes.has(a.focus)) throw new ActionError(`Nothing called ${a.focus} is in this project's record.`)
    if (a.memory && (!a.kinds || a.kinds.includes('memory'))) {
      const mem = projectMemory(ctx, a.repo)
      const focus = g.nodes.get(a.focus)
      if (mem && focus) {
        const records = await mem.longTerm.recallProject(a.repo, `${focus.label} ${focus.summary ?? ''}`.trim(), { agent: undefined, include: memoryInclude(ctx, a.repo), topK: a.memory_top_k })
        for (const r of records) {
          g.nodes.set(`memory:${r.id}`, { id: `memory:${r.id}`, kind: 'memory', label: short(r.text, 60), status: r.strategy, summary: short(r.text, 300) })
          g.links.push({ source: `memory:${r.id}`, target: a.focus, kind: 'related', dashed: true })
        }
      }
    }
    const n = neighbourhood(g, a.focus, a.depth, { kinds: a.kinds ? [...a.kinds, 'group'] : undefined })
    return {
      repo: a.repo, focus: a.focus, depth: a.depth,
      nodes: n.nodes.map((x) => ({ ...x, distance: n.distance.get(x.id) ?? 1 })),
      links: n.links,
      truncated: n.nodes.some((x) => x.kind === 'group'),
    }
  }),
}

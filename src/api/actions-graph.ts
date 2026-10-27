/**
 * graph.neighbourhood: what trace knows around one item, as nodes and links (docs/ui-design.md "Graph view"), in the
 * app's one vocabulary (web/src/lib/graph.ts NODE_KINDS and LINK_KINDS; test/api/graph-vocabulary.test.ts keeps the
 * two equal).
 *
 * Built from ONE project's record after the read check, so it is filtered by access by construction: nothing of
 * another project is read, drawn, grouped or counted. From the project's database (default branch) and its journey record
 * (the journey store), like journey.get:
 *
 *   requirement   requirements (status: its evidence, record-read.ts)
 *   run           runs, and test items ("Run or evidence": a planned test is evidence to come)
 *   decision      gates (their signature), waivers, the decisions log, answered questions ("Decision or waiver")
 *   person        who signed, answered, waived (their email as the record has it)
 *   memory        with `memory: true`, the project's long-term memories most like the focus, through the same memory
 *                 the agents recall from, and only the ones this person may see (never another person's preferences)
 *   intent        the intent statements (src/tools/design), rejected ones left out; status: verified when every
 *                 requirement derived from it is, failing when one fails, untested otherwise
 *   block         the blocks of the architecture drawn (the chosen option, else trace's recommendation)
 *   part          each block's parts by part number
 *   document      the schematic sheets that name the requirements they serve (design.sheets)
 *   (datasheet: the record keeps no link from a part to its datasheet page yet)
 *
 *   links   proves | fails      a test item, or a run of it, against each requirement it covers (by the result) and a
 *                               run against its test; a planned test `serves` its requirements
 *           uses                a result's run → the tool runs it rests on
 *           cites               a gate → the runs its criteria cite as evidence
 *           waives              a waiver → what it waives
 *           decided_in          a decision of the log → the gate it was made at
 *           decided_by          a gate, an answer or a waiver → the person who signed, gave or took it
 *           related             a memory → the focus, by meaning (dashed)
 *           derived_from        a requirement → the intent statement it came from
 *           serves              a block, or a sheet, → each requirement it serves; a sheet → its block
 *           uses                a block → its parts (and a result's run → the tool runs it rests on)
 *
 * The focus is "<kind>:<id>" as the nodes carry it (requirement:REQ-001, run:4f2a…, test:TST-1, gate:capture,
 * person:<email>, intent:INT-1a2b3c, block:mcu, part:<part number>, sheet:<file>), or a bare id (REQ-001) found among them; depth 1 to 3 (2 by default). At most 150 nodes are
 * returned, nearest first; past that, the rest of each kind gather into `groups` ({ id, kind, members, label, parent }:
 * "+12 more runs"), the shape the app's own grouping uses.
 */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { loadJourney } from '../core/journey.js'
import { ActionError, type Context, Repo, def, memoryInclude, projectMemory, withRecordDb } from './action-kit.js'
import { TOPIC_NAMES } from '../tools/design/db.js'
import { architectureView, intentView, linksView } from '../tools/design/record.js'
import { designOf, requirementEvidence } from './record-read.js'

/** The app's vocabulary (web/src/lib/graph.ts). */
export const NODE_KINDS = ['intent', 'requirement', 'block', 'part', 'datasheet', 'run', 'decision', 'memory', 'document', 'person'] as const
export type NodeKind = (typeof NODE_KINDS)[number]
export const LINK_KINDS = ['derived_from', 'serves', 'uses', 'proves', 'fails', 'cites', 'decided_in', 'decided_by', 'waives', 'learned_from', 'related'] as const
export type LinkKind = (typeof LINK_KINDS)[number]
export const NODE_STATUSES = ['verified', 'failing', 'untested', 'waived', 'active', 'inactive'] as const
export type NodeStatus = (typeof NODE_STATUSES)[number]

export interface GraphNode {
  id: string; kind: NodeKind; label: string; title?: string | undefined; summary?: string | undefined; status?: NodeStatus | undefined
  to?: string | undefined; facts?: Record<string, string> | undefined; repo?: string | undefined
}
export interface GraphLink { id: string; source: string; target: string; kind: LinkKind; dashed?: boolean | undefined }
export interface GraphGroup { id: string; kind: NodeKind; members: string[]; label: string; parent: string; count: number }

export const MAX_NODES = 150

const KIND_WORDS: Readonly<Record<NodeKind, string>> = {
  intent: 'intent statements', requirement: 'requirements', block: 'blocks', part: 'parts', datasheet: 'datasheet pages', run: 'runs',
  decision: 'decisions', memory: 'memories', document: 'documents', person: 'people',
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
/** A run's or test's status as the graph's: pass → verified, fail/error → failing, waived, else untested. */
const resultStatus = (v: unknown): NodeStatus => (v === 'pass' ? 'verified' : v === 'fail' || v === 'error' ? 'failing' : v === 'waived' ? 'waived' : 'untested')

/** The whole project graph from its database (bounded by what one project's record holds). `repo` gives addresses. */
export function projectGraph(db: DatabaseSync, repo?: string): { nodes: Map<string, GraphNode>; links: GraphLink[] } {
  const nodes = new Map<string, GraphNode>()
  const links: GraphLink[] = []
  const pid = repo ? repo.replace('/', '~') : null
  const at = (path: string): { to?: string; repo?: string } => (pid ? { to: `/p/${pid}${path}`, repo } : {})
  const node = (n: GraphNode): void => { if (!nodes.has(n.id)) nodes.set(n.id, n) }
  const link = (source: string, target: string, kind: LinkKind): void => { links.push({ id: `${source}>${kind}>${target}`, source, target, kind }) }
  const person = (who: string | null): string | null => {
    if (!who) return null
    const id = `person:${who}`
    node({ id, kind: 'person', label: who, title: who, ...(repo ? { repo } : {}) })
    return id
  }
  const rows = (sql: string): Record<string, unknown>[] => db.prepare(sql).all() as Record<string, unknown>[]
  const r = loadJourney(db)

  for (const q of requirementEvidence(db, r)) {
    node({ id: `requirement:${q.id}`, kind: 'requirement', label: q.id, title: short(q.text, 120), summary: q.why, status: q.evidence, facts: { Kind: q.kind, Status: q.status, ...(q.source ? { Source: q.source } : {}) }, ...at(`/requirements/${encodeURIComponent(q.id)}`) })
  }
  const testReqs = new Map<string, string[]>()
  if (hasTable(db, 'test_items')) {
    for (const t of rows('SELECT id, title, requirements, method, status FROM test_items')) {
      const id = `test:${String(t.id)}`
      const status = resultStatus(t.status)
      node({ id, kind: 'run', label: String(t.id), title: short(String(t.title), 120), summary: `Test item (${String(t.method)}), ${String(t.status)}.`, status, facts: { 'Test item': String(t.id), Method: String(t.method), Status: String(t.status) }, ...(repo ? { repo } : {}) })
      const reqs = list(t.requirements)
      testReqs.set(String(t.id), reqs)
      for (const req of reqs) link(id, `requirement:${req}`, status === 'verified' ? 'proves' : status === 'failing' ? 'fails' : 'serves')
    }
  }
  const runs = new Map<string, Record<string, unknown>>()
  for (const x of rows('SELECT id, kind, subject, status, summary FROM runs ORDER BY started DESC LIMIT 2000')) runs.set(String(x.id), x)
  const runNode = (id: string): string => {
    const x = runs.get(id)
    node({
      id: `run:${id}`, kind: 'run', label: x ? `${String(x.kind)}${x.subject ? ` · ${String(x.subject)}` : ''}` : id, title: x ? String(x.kind) : id,
      ...(x?.summary ? { summary: String(x.summary) } : {}), ...(x ? { status: resultStatus(x.status) } : {}), facts: { 'Run id': id, ...(x ? { Kind: String(x.kind) } : {}) }, ...at(`/runs/${encodeURIComponent(id)}`),
    })
    return `run:${id}`
  }
  if (hasTable(db, 'test_results')) {
    for (const t of rows('SELECT run_id, test_id, status, evidence FROM test_results ORDER BY at DESC LIMIT 2000')) {
      const run = runNode(String(t.run_id))
      const verdict: LinkKind | null = t.status === 'pass' ? 'proves' : t.status === 'fail' || t.status === 'error' ? 'fails' : null
      if (verdict) {
        link(run, `test:${String(t.test_id)}`, verdict)
        for (const req of testReqs.get(String(t.test_id)) ?? []) link(run, `requirement:${req}`, verdict)
      }
      for (const e of list(t.evidence)) link(run, runNode(e), 'uses')
    }
  }
  if (r) {
    const signed = new Map(r.signatures.filter((x) => x.supersededAt === null && x.revision === r.journey.revision).map((x) => [x.gate, x]))
    for (const g of r.gates) {
      const sig = signed.get(g.id)
      node({ id: `gate:${g.id}`, kind: 'decision', label: `the ${g.name} gate`, title: `The ${g.name} gate`, summary: sig ? `Signed by ${sig.by}.` : 'Not signed yet.', status: sig ? 'verified' : 'untested', facts: { Gate: g.id, Stage: g.stage }, ...at(`/gates/${encodeURIComponent(g.id)}`) })
      if (sig) { const p = person(sig.by); if (p) link(`gate:${g.id}`, p, 'decided_by') }
    }
    for (const c of r.criteria) for (const run of evidenceRuns(JSON.stringify(c.evidence))) link(`gate:${c.gate}`, runNode(run), 'cites')
    for (const w of r.waivers) {
      const id = `waiver:${w.id}`
      node({ id, kind: 'decision', label: `waiver on ${w.target}`, title: `Waiver on ${w.target}`, summary: short(w.reason, 200), status: w.closedAt === null ? 'waived' : 'inactive', facts: { Severity: w.severity, Scope: w.scope }, ...(repo ? { repo } : {}) })
      const target = w.targetKind === 'criterion' ? `gate:${w.gate ?? ''}` : w.targetKind === 'requirement' ? `requirement:${w.target}` : w.targetKind === 'test' ? `test:${w.target}` : null
      if (target) link(id, target, 'waives')
      const p = person(w.by)
      if (p) link(id, p, 'decided_by')
    }
    for (const q of r.questions.filter((x) => x.answeredAt !== null)) {
      const id = `decision:q-${q.id}`
      node({ id, kind: 'decision', label: short(q.answer ?? '', 60), title: short(q.text, 120), summary: `Answered: ${q.answer ?? ''}`, status: 'active', facts: { 'Asked by': q.askedBy }, ...(repo ? { repo } : {}) })
      const p = person(q.answeredBy)
      if (p) link(id, p, 'decided_by')
    }
    for (const d of r.decisions.filter((x) => ['gate.signed', 'gate.returned', 'stage.reopened'].includes(x.kind)).slice(0, 500)) {
      const id = `decision:${d.id}`
      node({ id, kind: 'decision', label: short(d.summary, 60), title: short(d.summary, 120), summary: d.summary, facts: { Kind: d.kind }, ...(repo ? { repo } : {}) })
      if (d.ref && nodes.has(`gate:${d.ref}`)) link(id, `gate:${d.ref}`, 'decided_in')
    }
  }
  // the design record: intent, the architecture drawn, its parts, and the sheets that name what they serve
  const design = designOf(db)
  const evidence = new Map([...nodes.values()].filter((x) => x.kind === 'requirement').map((x) => [x.id, x.status]))
  const derived = linksView(design.rows)
  for (const st of intentView(design.rows, design.decisions).filter((x) => x.state !== 'rejected' && x.kind !== 'question')) {
    const reqs = derived.filter((l) => l.intent === st.id).map((l) => evidence.get(`requirement:${l.requirement}`))
    const status: NodeStatus = reqs.includes('failing') ? 'failing' : reqs.length && reqs.every((x) => x === 'verified' || x === 'waived') ? 'verified' : 'untested'
    node({ id: `intent:${st.id}`, kind: 'intent', label: short(st.words, 60), title: short(st.words, 120), summary: `${TOPIC_NAMES[st.topic]} · ${st.state === 'accepted' || st.state === 'edited' ? 'accepted' : 'proposed'}${st.source ? ` · from ${st.source.kind === 'person' ? 'the person' : st.source.kind}` : ''}`, status, facts: { Topic: TOPIC_NAMES[st.topic], State: st.state }, ...at('/requirements') })
  }
  for (const l of derived) link(`requirement:${l.requirement}`, `intent:${l.intent}`, 'derived_from')
  const arch = architectureView(design.rows, design.decisions)
  const shown = arch.options.find((o) => o.id === arch.current)
  for (const b of shown?.blocks ?? []) {
    const id = `block:${b.id}`
    node({ id, kind: 'block', label: b.name, title: b.name, summary: `${b.role ?? 'A block'} in option ${shown?.id}${arch.chosen?.option === shown?.id ? ' (chosen)' : ' (proposed)'}.`, status: b.serves.length ? 'active' : 'inactive', facts: { Option: shown?.id ?? '', ...(b.parts.length ? { Parts: b.parts.map((p) => p.mpn).join(', ') } : {}) }, ...at('/design') })
    for (const r of b.serves) link(id, `requirement:${r}`, 'serves')
    for (const p of b.parts) {
      node({ id: `part:${p.mpn}`, kind: 'part', label: p.mpn, title: p.mpn, summary: p.role ?? (p.key ? 'A key part.' : 'A part.'), facts: { 'Part number': p.mpn, ...(p.key ? { Key: 'yes' } : {}) }, ...(repo ? { repo } : {}) })
      link(id, `part:${p.mpn}`, 'uses')
    }
  }
  for (const sh of design.rows.sheets) {
    const id = `sheet:${sh.sheet}`
    node({ id, kind: 'document', label: sh.sheet.split('/').pop() ?? sh.sheet, title: `Schematic sheet ${sh.sheet}`, summary: sh.requirements.length ? `Serves ${sh.requirements.join(', ')}.` : `Serves no requirement: ${sh.reason ?? ''}`, facts: { Sheet: sh.sheet, ...(sh.block ? { Block: sh.block } : {}) }, ...at('/design') })
    for (const r of sh.requirements) link(id, `requirement:${r}`, 'serves')
    if (sh.block && nodes.has(`block:${sh.block}`)) link(id, `block:${sh.block}`, 'serves')
  }
  const seen = new Set<string>()
  return { nodes, links: links.filter((l) => nodes.has(l.source) && nodes.has(l.target) && !seen.has(l.id) && Boolean(seen.add(l.id))) }
}

/** The neighbourhood of `focus` within `depth` links, nearest first, capped with groups. Pure. */
export function neighbourhood(g: { nodes: Map<string, GraphNode>; links: GraphLink[] }, focus: string, depth: number, o: { kinds?: readonly NodeKind[] | undefined; max?: number | undefined } = {}): { nodes: GraphNode[]; links: GraphLink[]; groups: GraphGroup[]; distance: Map<string, number> } {
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
  const groups: GraphGroup[] = []
  if (order.length > max) {
    kept = order.slice(0, max)
    const overflow = order.slice(max)
    const byKind = new Map<NodeKind, string[]>()
    for (const id of overflow) {
      const k = g.nodes.get(id)?.kind
      if (k) byKind.set(k, [...(byKind.get(k) ?? []), id])
    }
    const keepSet = new Set(kept)
    for (const [k, ids] of byKind) {
      // the drawn node most of them link to, else the focus
      const votes = new Map<string, number>()
      for (const l of g.links) {
        const other = ids.includes(l.source) ? l.target : ids.includes(l.target) ? l.source : null
        if (other && keepSet.has(other)) votes.set(other, (votes.get(other) ?? 0) + 1)
      }
      const parent = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? focus
      groups.push({ id: `group:${k}`, kind: k, members: ids.slice(0, 500), count: ids.length, parent, label: `+${ids.length} more ${KIND_WORDS[k]}` })
    }
  }
  const keep = new Set(kept)
  const nodes = kept.map((id) => g.nodes.get(id)).filter((n): n is GraphNode => Boolean(n))
  const links = g.links.filter((l) => keep.has(l.source) && keep.has(l.target))
  return { nodes, links, groups, distance }
}

/** The node a focus names: its id, or a bare id (REQ-001) matched to "<kind>:REQ-001", requirements first. */
export function resolveFocus(nodes: ReadonlyMap<string, GraphNode>, focus: string): string | null {
  if (nodes.has(focus)) return focus
  const hits = [...nodes.keys()].filter((id) => id.slice(id.indexOf(':') + 1) === focus)
  return hits.find((id) => id.startsWith('requirement:')) ?? hits[0] ?? null
}

const Focus = z.string().min(1).max(400)

export const GRAPH_ACTIONS = {
  'graph.neighbourhood': def('read', Repo.extend({
    focus: Focus,
    depth: z.number().int().min(1).max(3).default(2),
    kinds: z.array(z.enum(NODE_KINDS)).optional(),
    memory: z.boolean().default(false),
    memory_top_k: z.number().int().min(1).max(20).default(6),
  }), async (a, ctx: Context) => {
    const g = await withRecordDb(ctx, a.repo, (db) => projectGraph(db, a.repo))
    const focus = resolveFocus(g.nodes, a.focus)
    if (!focus) throw new ActionError(`Nothing called ${a.focus} is in this project's record.`)
    if (a.memory && (!a.kinds || a.kinds.includes('memory'))) {
      const mem = projectMemory(ctx, a.repo)
      const f = g.nodes.get(focus)
      if (mem && f) {
        const records = await mem.longTerm.recallProject(a.repo, `${f.title ?? f.label} ${f.summary ?? ''}`.trim(), { agent: undefined, include: memoryInclude(ctx, a.repo), topK: a.memory_top_k })
        for (const r of records) {
          g.nodes.set(`memory:${r.id}`, { id: `memory:${r.id}`, kind: 'memory', label: short(r.text, 60), title: short(r.text, 120), summary: short(r.text, 300), status: r.inactive ? 'inactive' : 'active', ...(r.strategy ? { facts: { Kind: r.strategy } } : {}), repo: a.repo })
          g.links.push({ id: `memory:${r.id}>related>${focus}`, source: `memory:${r.id}`, target: focus, kind: 'related', dashed: true })
        }
      }
    }
    const n = neighbourhood(g, focus, a.depth, { kinds: a.kinds })
    return {
      repo: a.repo, focus, depth: a.depth,
      nodes: n.nodes.map((x) => ({ ...x, distance: n.distance.get(x.id) ?? 1 })),
      links: n.links,
      groups: n.groups,
      truncated: n.groups.length > 0,
    }
  }),
}

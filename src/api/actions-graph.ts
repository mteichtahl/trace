/**
 * graph.neighbourhood: what trace knows around one item, as nodes and links (docs/ui-design.md "Graph view"), in the
 * app's one vocabulary (web/src/lib/graph.ts NODE_KINDS and LINK_KINDS; test/api/graph-vocabulary.test.ts keeps the
 * two equal).
 *
 * Built from ONE project's record after the read check, so it is filtered by access by construction: nothing of
 * another project is read, drawn, grouped or counted. From the project's database (default branch) and its journey record
 * (the journey store), like journey.get. The journey's kinds (gate, criterion, waiver, decision, and who signed, waived
 * or answered) are read through the ontology: the journey's graph, built by the mapping (src/ontology/journey-graph.ts),
 * not its tables (docs/ontology-plan.md P2.7):
 *
 *   requirement   requirements (status: its evidence, record-read.ts)
 *   run           runs, and test items ("Run or evidence": a planned test is evidence to come); stale (with why) when
 *                 what it was made from changed on the default branch since (src/ontology/lineage.ts)
 *   artifact      each run's outputs (artifact_hashes), stale with their run
 *   gate          gates (their signature); criterion: each gate's criteria (met, waived, failing when their shape
 *                 found something, untested); waiver: waivers; decision: the decisions log and answered questions
 *   person        who signed, answered, waived (their email as the record has it)
 *   memory        with `memory: true`, the project's long-term memories most like the focus, through the same memory
 *                 the agents recall from, and only the ones this person may see (never another person's preferences)
 *   intent        the intent statements (src/tools/design), rejected ones left out; status: verified when every
 *                 requirement derived from it is, failing when one fails, untested otherwise
 *   block         the blocks of the architecture drawn (the chosen option, else trace's recommendation)
 *   part          each block's parts by part number
 *   component     each placed part of the board (the first .kicad_pcb of the default branch); net: the nets on its pads
 *   case          the newest case build's case (src/ontology/mech.ts): verified when it fits, failing with its problems,
 *                 stale with its build; made by its run, and failing each placed part that clashes with it
 *   document      the schematic sheets that name the requirements they serve (design.sheets)
 *   (datasheet: the record keeps no link from a part to its datasheet page yet)
 *
 * The node kinds are the ontology's (trace:graphKind on each class, src/ontology/graph-kinds.gen.ts).
 *
 *   links   proves | fails      a test item, or a run of it, against each requirement it covers (by the result) and a
 *                               run against its test; a planned test `serves` its requirements
 *           uses                a result's run → the tool runs it rests on; a run → another run's output it read
 *           made                a run → its outputs
 *           contains            a gate → its criteria
 *           cites               a criterion → the runs it cites as evidence
 *           waives              a waiver → what it waives (a criterion, a requirement, a test)
 *           decided_in          a decision of the log → the gate it was made at
 *           decided_by          a gate, an answer or a waiver → the person who signed, gave or took it
 *           related             a memory → the focus, by meaning (dashed)
 *           derived_from        a requirement → the intent statement it came from
 *           serves              a block, or a sheet, → each requirement it serves; a sheet → its block
 *           connects            a placed part → the nets on its pads
 *
 * The focus is "<kind>:<id>" as the nodes carry it (requirement:REQ-001, run:4f2a…, test:TST-1, gate:capture,
 * criterion:capture.erc, artifact:<run>/<name>, component:U1, net:GND,
 * person:<email>, intent:INT-1a2b3c, block:mcu, part:<part number>, sheet:<file>), or a bare id (REQ-001) found among them; depth 1 to 3 (2 by default). At most 150 nodes are
 * returned, nearest first; past that, the rest of each kind gather into `groups` ({ id, kind, members, label, parent }:
 * "+12 more runs"), the shape the app's own grouping uses.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { journeyGraph } from '../ontology/journey-graph.js'
import { NODE_KINDS } from '../ontology/graph-kinds.gen.js'
import { type Board, loadBoard } from '../tools/kicad/pcb.js'
import { filesRead, staleRuns } from '../ontology/lineage.js'
import { artifactJson, latestCaseBuild } from '../ontology/mech.js'
import { ActionError, type Context, Repo, def, memoryInclude, projectMemory, withRecordDb } from './action-kit.js'
import { TOPIC_NAMES } from '../tools/design/db.js'
import { architectureView, intentView, linksView, ownSignatures } from '../tools/design/record.js'
import { designOf, requirementEvidence } from './record-read.js'

/** The app's vocabulary (web/src/lib/graph.ts): the node kinds are the ontology's (trace:graphKind, generated). */
export { NODE_KINDS } from '../ontology/graph-kinds.gen.js'
export type NodeKind = (typeof NODE_KINDS)[number]
/** contains: a gate → its criteria; made: a run → its outputs; connects: a component → the nets on its pads */
export const LINK_KINDS = ['derived_from', 'serves', 'uses', 'made', 'proves', 'fails', 'cites', 'contains', 'connects', 'decided_in', 'decided_by', 'waives', 'learned_from', 'related'] as const
export type LinkKind = (typeof LINK_KINDS)[number]
/** stale: made from something that changed since (lineage, src/ontology/lineage.ts) */
export const NODE_STATUSES = ['verified', 'failing', 'untested', 'waived', 'stale', 'active', 'inactive'] as const
export type NodeStatus = (typeof NODE_STATUSES)[number]

export interface GraphNode {
  id: string; kind: NodeKind; label: string; title?: string | undefined; summary?: string | undefined; status?: NodeStatus | undefined
  to?: string | undefined; facts?: Record<string, string> | undefined; repo?: string | undefined
}
export interface GraphLink { id: string; source: string; target: string; kind: LinkKind; dashed?: boolean | undefined }
export interface GraphGroup { id: string; kind: NodeKind; members: string[]; label: string; parent: string; count: number }

export const MAX_NODES = 150

const KIND_WORDS: Readonly<Record<NodeKind, string>> = {
  intent: 'intent statements', requirement: 'requirements', block: 'blocks', part: 'parts', datasheet: 'datasheet pages', component: 'components',
  net: 'nets', case: 'cases', run: 'runs', artifact: 'outputs', gate: 'gates', criterion: 'criteria', waiver: 'waivers', decision: 'decisions', memory: 'memories',
  document: 'documents', person: 'people',
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
export interface GraphExtras {
  /** why each run no longer stands (lineage against the default branch's files): drawn stale, with the reason */
  stale?: ReadonlyMap<string, string> | undefined
  /** the board read from its .kicad_pcb on the default branch: its components and nets */
  board?: { path: string; board: Board } | undefined
}

export function projectGraph(db: DatabaseSync, repo?: string, extras: GraphExtras = {}): { nodes: Map<string, GraphNode>; links: GraphLink[] } {
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
  // the journey as the ontology has it: read through the mapping (src/ontology/journey-graph.ts), not its tables
  const r = journeyGraph(db, { installation: process.env.TRACE_PREFIX ?? 'trace', project: repo ?? 'local/project' })

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
      ...(extras.stale?.has(id) ? { summary: `Out of date: ${extras.stale.get(id)}`, status: 'stale' as const } : { ...(x?.summary ? { summary: String(x.summary) } : {}), ...(x ? { status: resultStatus(x.status) } : {}) }),
      facts: { 'Run id': id, ...(x ? { Kind: String(x.kind) } : {}) }, ...at(`/runs/${encodeURIComponent(id)}`),
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
    const signed = new Map(r.signatures.filter((x) => x.supersededAt === null && x.revision === r.revision).map((x) => [x.gate, x]))
    for (const g of r.gates) {
      const sig = signed.get(g.id)
      node({ id: `gate:${g.id}`, kind: 'gate', label: `the ${g.name} gate`, title: `The ${g.name} gate`, summary: sig ? `Signed by ${sig.by}.` : 'Not signed yet.', status: sig ? 'verified' : 'untested', facts: { Gate: g.id, Stage: g.stage }, ...at(`/gates/${encodeURIComponent(g.id)}`) })
      if (sig) { const p = person(sig.by); if (p) link(`gate:${g.id}`, p, 'decided_by') }
    }
    // each criterion of a gate: met, waived, failing (its shape found something), or not yet; what it cites
    const waivedCriteria = new Set(r.waivers.filter((w) => w.closedAt === null && w.targetKind === 'criterion').map((w) => w.target))
    for (const c of r.criteria) {
      const id = `criterion:${c.id}`
      const found = c.evidence.filter((e) => e.kind === 'finding')
      const status: NodeStatus = c.status === 'met' ? 'verified' : waivedCriteria.has(c.id) ? 'waived' : found.length ? 'failing' : 'untested'
      node({
        id, kind: 'criterion', label: short(c.text, 60), title: c.text,
        summary: found.length ? `Still needed: ${found.map((e) => e.label ?? e.ref).slice(0, 3).join(' ')}` : c.status === 'met' ? `Met${c.checkedBy ? `, by ${c.checkedBy}` : ''}.` : 'Not met yet.',
        status, facts: { Criterion: c.id, 'Decided by': c.owner === 'trace' ? 'trace\'s check' : 'a person' }, ...at(`/gates/${encodeURIComponent(c.gate)}`),
      })
      link(`gate:${c.gate}`, id, 'contains')
      for (const run of evidenceRuns(JSON.stringify(c.evidence))) link(id, runNode(run), 'cites')
    }
    for (const w of r.waivers) {
      const id = `waiver:${w.id}`
      node({ id, kind: 'waiver', label: `waiver on ${w.target}`, title: `Waiver on ${w.target}`, summary: short(w.reason, 200), status: w.closedAt === null ? 'waived' : 'inactive', facts: { Severity: w.severity, Scope: w.scope }, ...(repo ? { repo } : {}) })
      const target = w.targetKind === 'criterion' ? `criterion:${w.target}` : w.targetKind === 'requirement' ? `requirement:${w.target}` : w.targetKind === 'test' ? `test:${w.target}` : null
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
  for (const st of intentView(design.rows, design.decisions, ownSignatures(r)).filter((x) => x.state !== 'rejected' && x.kind !== 'question')) {
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
  // each run's outputs, and the runs made from them (lineage: artifact_hashes, run_inputs)
  if (hasTable(db, 'artifact_hashes')) {
    for (const h of rows('SELECT a.run_id, a.name FROM artifact_hashes a JOIN (SELECT id FROM runs ORDER BY started DESC LIMIT 2000) r ON r.id = a.run_id')) {
      const run = String(h.run_id)
      const id = `artifact:${run}/${String(h.name)}`
      node({ id, kind: 'artifact', label: String(h.name), title: `${String(h.name)}, made by run ${run.slice(0, 8)}`, ...(extras.stale?.has(run) ? { status: 'stale' as const, summary: `Out of date: ${extras.stale.get(run)}` } : {}), facts: { Output: String(h.name), Run: run }, ...at(`/runs/${encodeURIComponent(run)}`) })
      link(runNode(run), id, 'made')
    }
  }
  if (hasTable(db, 'run_inputs')) {
    for (const i of rows("SELECT run_id, ref, name FROM run_inputs WHERE kind = 'artifact' LIMIT 5000")) {
      const src = `artifact:${String(i.ref)}/${String(i.name)}`
      if (nodes.has(src) && runs.has(String(i.run_id))) link(runNode(String(i.run_id)), src, 'uses')
    }
  }
  // the board: each placed part and the nets on its pads, as the board file on the default branch has them
  if (extras.board) {
    const b = extras.board.board
    const parts = new Set([...nodes.keys()].filter((k) => k.startsWith('part:')).map((k) => k.slice(5).toUpperCase()))
    for (const f of b.footprints) {
      if (!f.ref) continue
      const id = `component:${f.ref}`
      node({ id, kind: 'component', label: f.ref, title: `${f.ref}${f.value ? ` · ${f.value}` : ''}`, summary: `${f.footprint ?? 'A part'} on the ${f.side === 'bottom' ? 'bottom' : 'top'} of ${extras.board.path}.`, facts: { Reference: f.ref, ...(f.value ? { Value: f.value } : {}), ...(f.footprint ? { Footprint: f.footprint } : {}) }, ...at('/design') })
      if (f.value && parts.has(f.value.toUpperCase())) link(id, `part:${[...nodes.keys()].find((k) => k.toUpperCase() === `PART:${f.value!.toUpperCase()}`)!.slice(5)}`, 'uses')
      for (const net of new Set(f.pads.map((p) => p.net).filter((n): n is string => Boolean(n)))) {
        node({ id: `net:${net}`, kind: 'net', label: net, title: `The net ${net}`, facts: { Net: net }, ...at('/design') })
        link(id, `net:${net}`, 'connects')
      }
    }
  }
  // the case: the newest build's, made by its run; each part that clashes with it, or lacks room, is failed by it
  const cb = latestCaseBuild(db)
  if (cb) {
    const fit = (artifactJson(db, cb.run, 'fit.json') ?? {}) as { clashes?: { ref: string; case_part: string }[]; gaps?: { ref: string; ok: boolean }[]; summary?: string }
    const bad = [...new Set([...(fit.clashes ?? []).map((c) => c.ref), ...(fit.gaps ?? []).filter((g) => !g.ok).map((g) => g.ref)])].filter((r) => r !== 'board')
    const stale = extras.stale?.get(cb.run)
    node({
      id: 'case:enclosure', kind: 'case', label: 'Case', title: `The case, from build ${cb.run.slice(0, 8)}`,
      status: stale ? 'stale' : cb.status === 'pass' ? 'verified' : 'failing',
      summary: stale ? `Out of date: ${stale}` : fit.summary ?? (cb.status === 'pass' ? 'The board fits its case.' : 'The board does not fit its case.'),
      facts: { Build: cb.run, ...(bad.length ? { Problems: bad.join(', ') } : {}) }, ...at('/design'),
    })
    link(runNode(cb.run), 'case:enclosure', 'made')
    for (const ref of bad) link('case:enclosure', `component:${ref}`, 'fails')
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

/**
 * Why each of the project's newest runs no longer stands (src/ontology/lineage.ts), against the default branch's files.
 * A file that cannot be fetched leaves its runs as they are: never called changed. Bounded to the newest 300 runs.
 */
async function staleOf(ctx: Context, repo: string, branch: string, db: DatabaseSync): Promise<Map<string, string>> {
  if (!hasTable(db, 'run_inputs')) return new Map()
  const ids = (db.prepare('SELECT id FROM runs ORDER BY started DESC LIMIT 300').all() as { id: string }[]).map((r) => r.id)
  const gh = await ctx.deps.github()
  const files = new Map<string, Uint8Array | null>()
  const unreadable = new Set<string>()
  await Promise.all(filesRead(db, ids).map(async (p) => {
    try { files.set(p, await gh.rawFile(repo, p, branch)) } catch { unreadable.add(p) }
  }))
  const readable = ids.filter((id) => !filesRead(db, [id]).some((p) => unreadable.has(p)))
  return staleRuns(db, readable, files)
}

/** The project's board, read from the first .kicad_pcb of the default branch (none: no board yet, or not readable). */
async function boardOf(ctx: Context, repo: string, branch: string): Promise<GraphExtras['board']> {
  try {
    const gh = await ctx.deps.github()
    const path = (await gh.tree(repo, branch)).files.map((f) => f.path).filter((p) => p.endsWith('.kicad_pcb')).sort()[0]
    if (!path) return undefined
    const bytes = await gh.rawFile(repo, path, branch)
    if (!bytes) return undefined
    const dir = mkdtempSync(join(ctx.deps.scratch, 'board-'))
    try {
      const file = join(dir, basename(path))
      writeFileSync(file, bytes)
      return { path, board: loadBoard(file) }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    return undefined
  }
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
    const gh = await ctx.deps.github()
    const { branch } = await gh.defaultBranch(a.repo)
    const board = await boardOf(ctx, a.repo, branch)
    const g = await withRecordDb(ctx, a.repo, async (db) => projectGraph(db, a.repo, { stale: await staleOf(ctx, a.repo, branch, db), board }))
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

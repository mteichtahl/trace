/**
 * shape.check (docs/ontology.md "Gates as SHACL shapes"; plan P5.1, P5.3): a trace-owned criterion checked by its
 * SHACL shape over the project's graph, the way a person can read it, instead of by an agent's say-so.
 *
 *   1. the graph: the project's records as trace builds them (src/ontology/graph.ts): the journey record and the
 *      agents' facts from the central bucket when this runtime has the project in scope (as the journey tools do),
 *      else the journey tables in .trace/project.db; the run, design and verification records of .trace/project.db,
 *      with the newest case build and, from the working tree, whether it still stands (layout.fit)
 *   2. the shape: ontology/shapes/<criterion>.ttl, which names the criterion it backs (tsh:criterion)
 *   3. pySHACL through the Python bridge (python/tracebridge/shapes.py `shapes.check`)
 *   4. recorded as a run (kind shape.check), its findings an artifact; and, when the journey is in scope, written as
 *      the criterion's check (criterion_checks): met with the run as evidence when the graph conforms, not met with
 *      each finding as evidence otherwise (its ref the finding's id, findingId). A finding waived on its own (an open
 *      waiver of kind finding on that id) is listed as waived and no longer holds the criterion
 *
 * The shape decides; the agent does not. A criterion with no shape is refused, naming the ones that have one.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { Parser, type Store, Writer } from 'n3'
import { z } from 'zod'
import { bridge } from '../../core/bridge.js'
import { type AnyTool, ToolError, defineTool } from '../../core/registry.js'
import { Work, findRoot } from '../../core/store.js'
import { AgentFactError, addCriterionCheck } from '../../core/agent-facts.js'
import { type JourneyRecord, copyJourneyTables, loadJourney } from '../../core/journey.js'
import { buildGraph, type GraphSources } from '../../ontology/graph.js'
import { shapedCriteria } from '../../ontology/shapes.js'
import { ONTOLOGY_DIR } from '../../ontology/vocab.js'
import { recorded } from '../kicad/record.js'
import { journeyScope } from '../journey/tools.js'

type Scope = ReturnType<typeof journeyScope>


const Finding = z.object({ focus: z.string().nullable(), path: z.string().nullable(), value: z.string().nullable(), message: z.string(), severity: z.string(), shape: z.string().nullable() })
const Result = z.object({ conforms: z.boolean(), findings: z.array(Finding) })
export type ShapeFinding = z.infer<typeof Finding>

/** ontology/shapes: one file per criterion */
export const SHAPES_DIR = join(ONTOLOGY_DIR, 'shapes')

type Quads = ReturnType<Store['getQuads']>
type Files = (path: string) => Uint8Array | null
/** The quads of the records in some of the project's databases (records link across databases by name); with `files`,
 *  the repository's files as they are now, what freshness needs (whether the newest case build still stands). */
export const graphQuads = (src: GraphSources, o: { installation: string; project: string; files?: Files }): Quads => buildGraph(src, { ...o, derived: true }).store.getQuads(null, null, null, null)

/** The repository's files as they are in the working tree (null when gone or outside it). */
export function workingTree(root: string | null = findRoot()): Files | undefined {
  if (!root) return undefined
  return (p) => {
    const abs = join(root, p)
    return !p.startsWith('/') && !p.split('/').includes('..') && existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs) : null
  }
}

/** Quads as Turtle. */
export function turtle(quads: Quads): Promise<string> {
  const w = new Writer({ prefixes: { trace: 'https://trace-eda.com/ns/trace#' } })
  w.addQuads(quads)
  return new Promise((res, rej) => w.end((e, out) => (e ? rej(e) : res(out as string))))
}

/**
 * A finding's id, which a waiver of kind finding names to waive it on its own: the criterion and the record it is about
 * (`architect.mapped@urn:trace:…:requirement:REQ-1`). A finding about the project as a whole is about its journey.
 */
export const findingId = (criterion: string, f: { focus: string | null }): string => `${criterion}@${f.focus ?? 'project'}`.slice(0, 300)

/** Each finding with its id, and whether a waiver of that one finding (its id in `waived`) excuses it. */
export const withWaivers = (criterion: string, findings: readonly ShapeFinding[], waived: ReadonlySet<string>): (ShapeFinding & { id: string; waived: boolean })[] =>
  findings.map((f) => ({ ...f, id: findingId(criterion, f), waived: waived.has(findingId(criterion, f)) }))

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf'
const TARGET_CLASS = 'http://www.w3.org/ns/shacl#targetClass'
const TRACE = 'https://trace-eda.com/ns/trace#'
const OF_RUN = `${TRACE}ofRun`

/** What a shape checked: each kind of record it targets (the project itself left out) and how many the graph has. */
export interface ShapeScope {
  kind: string; words: string; count: number
  /** when the records come from several runs (a parts list line belongs to one parts check): how many runs, and how
   * many records each has when every run has the same number (null otherwise) */
  runs?: { count: number; each: number | null }
}

/** "KeyPart" → "key part" */
const classWords = (iri: string): string => iri.replace(TRACE, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
const plural = (n: number, w: string): string => `${n} ${n === 1 ? w : `${w}s`}`

/**
 * The records `criterion`'s shape was run over: for each class its node shapes target (sh:targetClass), the
 * instances in the graph, its subclasses' too. The project (trace:Journey) is always one and is left out. Evidence
 * that says only "every record keeps to its shape" reads the same over an empty record as over a full one (test-esp32
 * #44); with this it says "7 key parts", or that there was nothing to check.
 */
export function shapeScope(criterion: string, quads: Quads, shapes = readFileSync(join(SHAPES_DIR, `${criterion}.ttl`), 'utf8')): ShapeScope[] {
  const classes = [...new Set(new Parser().parse(shapes).filter((q) => q.predicate.value === TARGET_CLASS).map((q) => q.object.value))].filter((c) => c !== `${TRACE}Journey`)
  const sub = new Map<string, string[]>()
  const types = new Map<string, Set<string>>()
  const runOf = new Map<string, string>()
  for (const q of quads) {
    if (q.predicate.value === OF_RUN) runOf.set(q.subject.value, q.object.value)
    if (q.predicate.value === SUBCLASS) sub.set(q.object.value, [...(sub.get(q.object.value) ?? []), q.subject.value])
    else if (q.predicate.value === RDF_TYPE) { const s = types.get(q.object.value) ?? new Set<string>(); s.add(q.subject.value); types.set(q.object.value, s) }
  }
  return classes.map((c) => {
    const seen = new Set<string>()
    const nodes = new Set<string>()
    const walk = (k: string): void => { if (seen.has(k)) return; seen.add(k); for (const n of types.get(k) ?? []) nodes.add(n); for (const s of sub.get(k) ?? []) walk(s) }
    walk(c)
    const per = new Map<string, number>()
    for (const n of nodes) { const r = runOf.get(n); if (r) per.set(r, (per.get(r) ?? 0) + 1) }
    const sizes = new Set(per.values())
    return { kind: c.replace(TRACE, ''), words: classWords(c), count: nodes.size, ...(per.size > 1 ? { runs: { count: per.size, each: sizes.size === 1 ? [...sizes][0] as number : null } } : {}) }
  })
}

/** "7 key parts and 3 fit findings", or "the project" when the shape looks at the project only. */
export function scopeWords(scope: readonly ShapeScope[]): string {
  if (!scope.length) return 'the project'
  // a count over several runs says so: "90 parts list lines" over six parts checks of 15 lines read as a 90-line parts
  // list (test-esp32-run2 R59)
  const parts = scope.map((s) => `${plural(s.count, s.words)}${s.runs ? ` from ${s.runs.count} checks${s.runs.each !== null ? ` (${s.runs.each} each)` : ''}` : ''}`)
  return parts.length === 1 ? parts[0] as string : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) as string}`
}

/** True when the shape had records to look at: a shape over no key parts at all checked nothing. */
export const checkedSomething = (scope: readonly ShapeScope[]): boolean => !scope.length || scope.some((s) => s.count > 0)

/**
 * The run's summary, in words: what was checked and what came of it ("architect.stock: checked 7 key parts: every one
 * keeps to its shape"), saying so when there was nothing to check.
 */
export function shapeSummary(criterion: string, scope: readonly ShapeScope[], open: number, waived: number): string {
  const w = waived ? `, ${waived} waived` : ''
  if (open) return `${criterion}: checked ${scopeWords(scope)}: ${plural(open, 'finding')}${w}`
  if (!checkedSomething(scope)) return `${criterion}: nothing to check: the record has no ${scope.map((s) => `${s.words}s`).join(' or ')} yet, so nothing was shown to keep to its shape`
  return `${criterion}: checked ${scopeWords(scope)}: every one keeps to its shape${w}`
}

/** Run `criterion`'s shape over a graph given as Turtle. */
export async function runShape(criterion: string, data: string, call = (m: string, p: Record<string, unknown>) => bridge().call(m, p, Result)): Promise<z.infer<typeof Result>> {
  if (!shapedCriteria().includes(criterion)) throw new ToolError(`no shape backs ${criterion}; shapes back ${shapedCriteria().join(', ') || 'no criteria yet'}`)
  return call('shapes.check', { data, shapes: [readFileSync(join(SHAPES_DIR, `${criterion}.ttl`), 'utf8')] }) as Promise<z.infer<typeof Result>>
}

/**
 * The project's records as quads, read the way the app reads them (src/api/action-kit.ts withRecordDb): a copy of
 * .trace/project.db with the journey's tables replaced by the central store's when the project is in scope, and the
 * agents' facts beside it. The repository's file is never written.
 */
export async function projectGraph(scope: Scope | null, o: { installation: string; project: string; files?: Files }, path?: string): Promise<{ quads: Quads; rec: JourneyRecord | null }> {
  const dir = mkdtempSync(join(tmpdir(), 'trace-shape-'))
  try {
    const copy = join(dir, 'record.db')
    const work = new Work(path)
    try { work.db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`) } finally { work.close() }
    const db = new DatabaseSync(copy)
    try {
      const live = scope ? await scope.journey.bytes() : null
      if (live) {
        writeFileSync(join(dir, 'journey.db'), live)
        copyJourneyTables(db, join(dir, 'journey.db'))
      }
      const quads = graphQuads({ journey: db, project: db }, o)
      if (scope) quads.push(...(await scope.facts.read((f) => graphQuads({ facts: f }, o))).result)
      return { quads, rec: loadJourney(db) }
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const check = defineTool({
  name: 'shape.check',
  description: 'Check a gate criterion trace owns against its shape (a SHACL rule over the project\'s records: ontology/shapes/<criterion>.ttl), instead of judging it yourself. Builds the project\'s graph from the journey record, the agents\' facts and .trace/project.db, runs the shape, and records the result as the criterion\'s check: met with this run as evidence when every record keeps to it, not met with each finding (its message names the thing and what to do) otherwise. Recorded; returns run_id.',
  input: z.object({ criterion: z.string().regex(/^[a-z][a-z.]*\.[a-z]+$/).describe('the criterion id, such as architect.mapped') }),
  run: async (a) => {
    let scope: Scope | null = null
    try { scope = journeyScope() } catch { scope = null }
    const repo = scope?.repository ?? process.env.GITHUB_REPOSITORY ?? 'local/project'
    const { quads, rec } = await projectGraph(scope, { installation: process.env.TRACE_PREFIX ?? 'trace', project: repo, files: workingTree() })
    const data = await turtle(quads)
    // a finding a person waived on its own (a waiver of kind finding, open, on its id) no longer holds the criterion
    const waived = new Set((rec?.waivers ?? []).filter((w) => w.closedAt === null && w.targetKind === 'finding').map((w) => w.target))
    const out = await recorded('shape.check', a.criterion, a, async (run) => {
      const r = await runShape(a.criterion, data)
      const all = withWaivers(a.criterion, r.findings, waived)
      const open = all.filter((f) => !f.waived)
      run.measure('findings', open.length)
      run.measure('waived', all.length - open.length)
      run.artifact('findings.json', JSON.stringify(all, null, 1), 'application/json')
      const conforms = open.length === 0
      const w = all.length - open.length
      const scope = shapeScope(a.criterion, quads)
      for (const s of scope) run.measure(s.kind, s.count)
      return {
        status: conforms ? 'pass' as const : 'fail' as const,
        summary: shapeSummary(a.criterion, scope, open.length, w),
        result: { criterion: a.criterion, conforms, checked: scope, findings: open.slice(0, 50), omitted: Math.max(0, open.length - 50), waived: all.filter((f) => f.waived).map((f) => f.id) },
      }
    })
    if (!scope) return { ...out, recorded_check: false, next: `Not recorded as the criterion's check (no project in scope): journey.check ${a.criterion} ${out.conforms ? 'met' : 'not_met'} with evidence run ${out.run_id}.` }
    const s = scope
    const evidence = out.conforms
      ? [{ kind: 'run', ref: out.run_id, label: shapeSummary(a.criterion, out.checked, 0, out.waived.length) }]
      : [{ kind: 'run', ref: out.run_id, label: shapeSummary(a.criterion, out.checked, out.findings.length + out.omitted, out.waived.length) },
        ...out.findings.slice(0, 19).map((f) => ({ kind: 'finding', ref: f.id, label: f.message.slice(0, 300) }))]
    try {
      await s.facts.update((db) => ({ result: addCriterionCheck(db, s.asker, { criterion: a.criterion, status: out.conforms ? 'met' : 'not_met', evidence, note: out.conforms ? 'every record keeps to the shape' : `${out.findings.length} finding(s)` }, rec) }))
    } catch (e) {
      if (e instanceof AgentFactError) throw new ToolError(`shape.check: ran (run ${out.run_id}) but could not record the check: ${e.message}`)
      throw e
    }
    return { ...out, recorded_check: true, next: out.conforms ? 'Recorded as met.' : 'Recorded as not met: fix what each finding names, then run shape.check again.' }
  },
})

export const tools: AnyTool[] = [check] as unknown as AnyTool[]

/**
 * shape.check (docs/ontology.md "Gates as SHACL shapes"; plan P5.1, P5.3): a trace-owned criterion checked by its
 * SHACL shape over the project's graph, the way a person can read it, instead of by an agent's say-so.
 *
 *   1. the graph: the project's records as trace builds them (src/ontology/graph.ts): the journey record and the
 *      agents' facts from the central bucket when this runtime has the project in scope (as the journey tools do),
 *      else the journey tables in .trace/project.db; the run, design and verification records of .trace/project.db
 *   2. the shape: ontology/shapes/<criterion>.ttl, which names the criterion it backs (tsh:criterion)
 *   3. pySHACL through the Python bridge (python/tracebridge/shapes.py `shapes.check`)
 *   4. recorded as a run (kind shape.check), its findings an artifact; and, when the journey is in scope, written as
 *      the criterion's check (criterion_checks): met with the run as evidence when the graph conforms, not met with
 *      each finding as evidence otherwise
 *
 * The shape decides; the agent does not. A criterion with no shape is refused, naming the ones that have one.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { type Store, Writer } from 'n3'
import { z } from 'zod'
import { bridge } from '../../core/bridge.js'
import { type AnyTool, ToolError, defineTool } from '../../core/registry.js'
import { Work } from '../../core/store.js'
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
/** The quads of the records in some of the project's databases (records link across databases by name). */
export const graphQuads = (src: GraphSources, o: { installation: string; project: string }): Quads => buildGraph(src, { ...o, derived: true }).store.getQuads(null, null, null, null)

/** Quads as Turtle. */
export function turtle(quads: Quads): Promise<string> {
  const w = new Writer({ prefixes: { trace: 'https://trace-eda.com/ns/trace#' } })
  w.addQuads(quads)
  return new Promise((res, rej) => w.end((e, out) => (e ? rej(e) : res(out as string))))
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
export async function projectGraph(scope: Scope | null, o: { installation: string; project: string }, path?: string): Promise<{ quads: Quads; rec: JourneyRecord | null }> {
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
    const { quads, rec } = await projectGraph(scope, { installation: process.env.TRACE_PREFIX ?? 'trace', project: repo })
    const data = await turtle(quads)
    const out = await recorded('shape.check', a.criterion, a, async (run) => {
      const r = await runShape(a.criterion, data)
      run.measure('findings', r.findings.length)
      run.artifact('findings.json', JSON.stringify(r.findings, null, 1), 'application/json')
      return {
        status: r.conforms ? 'pass' as const : 'fail' as const,
        summary: r.conforms ? `${a.criterion}: every record keeps to its shape` : `${a.criterion}: ${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}`,
        result: { criterion: a.criterion, conforms: r.conforms, findings: r.findings.slice(0, 50), omitted: Math.max(0, r.findings.length - 50) },
      }
    })
    if (!scope) return { ...out, recorded_check: false, next: `Not recorded as the criterion's check (no project in scope): journey.check ${a.criterion} ${out.conforms ? 'met' : 'not_met'} with evidence run ${out.run_id}.` }
    const s = scope
    const evidence = out.conforms
      ? [{ kind: 'run', ref: out.run_id, label: `the ${a.criterion} shape over the project's records` }]
      : [{ kind: 'run', ref: out.run_id, label: `the ${a.criterion} shape: ${out.findings.length} finding(s)` },
        ...out.findings.slice(0, 19).map((f) => ({ kind: 'finding', ref: (f.focus ?? a.criterion).slice(-300), label: f.message.slice(0, 300) }))]
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

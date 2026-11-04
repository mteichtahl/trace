/**
 * The ontology to other systems (docs/ontology.md "Storage, runtime and access"; plan P6.1): four read actions, open to
 * connected systems with the read scope (src/api/service-policy.ts SERVICE_ACTIONS), so the MCP endpoint offers them as
 * trace_<action> with nothing more.
 *
 *   ontology.describe  signed in   the vocabulary: its version and JSON-LD context, every class and property with its
 *                                  plain-words label and comment, parents, domain and range, where a class is kept,
 *                                  and its Si2 alignments; with `term`, one term with the tables that store it
 *   record.get         read        one record of a project as JSON-LD: a node of the project's graph, named by its
 *                                  identifier (urn:trace:…) or by `<kind>:<key>` (requirement:REQ-001, run:4f2a…,
 *                                  criterion:capture.erc), its links as identifiers and its own parts embedded
 *   artifact.lineage   read        what a run was made from (files with their hashes, other runs' outputs) and what it
 *                                  made (each output's normalised hash), and the runs made from its outputs
 *   artifact.stale     read        whether the newest run of each tool and subject still stands against the default
 *                                  branch's files, with why (stale) or why it is kept (an upstream change that made
 *                                  the same output); `runs` narrows it to some runs
 *
 * Every read is one project's, after the read check: the project's database from its default branch with the
 * journey record and the agents' facts beside it, the way journey.get reads them. A file freshness needs that cannot
 * be fetched is never called changed: the run is reported unknown.
 */
import type { DatabaseSync } from 'node:sqlite'
import { Store } from 'n3'
import { z } from 'zod'
import { buildGraph, type GraphOptions, nodeIri } from '../ontology/graph.js'
import { contextUrl, ontologyVersion, recordJsonLd } from '../ontology/jsonld.js'
import { type Freshness, filesRead, freshness, latestFreshness } from '../ontology/lineage.js'
import { TABLES } from '../ontology/mapping.js'
import { readVocabulary, type Vocabulary } from '../ontology/vocab.js'
import { ActionError, type Context, Repo, agentFactsStore, def, withProjectDb, withRecordDb } from './action-kit.js'
import { jobIndex } from './actions-jobs.js'

let vocab: Vocabulary | null = null
const vocabulary = (): Vocabulary => (vocab ??= readVocabulary())

const installation = (): string => process.env.TRACE_PREFIX ?? 'trace'
const graphOptions = (repo: string): GraphOptions => ({ installation: installation(), project: repo })

/** The kinds a record can be named by (`<kind>:<key>`): every mapped table's, and the ones links name. */
export const RECORD_KINDS: readonly string[] = [...new Set(['project', 'template', 'revision', 'specialist', ...TABLES.map((t) => t.kind)])].sort()

/** One project's graph: its database (default branch) with the journey record, and the agents' facts and job index. */
export async function projectGraph(ctx: Context, repo: string): Promise<Store> {
  const o = graphOptions(repo)
  const store = new Store()
  const add = (s: Store): void => { store.addQuads(s.getQuads(null, null, null, null)) }
  add(await withRecordDb(ctx, repo, (db) => buildGraph({ journey: db, project: db }, o).store))
  add((await agentFactsStore(ctx, repo).read((db) => buildGraph({ facts: db }, o).store)).result)
  add((await jobIndex(ctx, repo).read((db) => buildGraph({ jobs: db }, o).store)).result)
  return store
}

/** A record's identifier from what a caller gave: an identifier as is, or `<kind>:<key>` of this project. */
export function recordId(repo: string, id: string): string {
  if (id.startsWith('urn:trace:')) return id
  const colon = id.indexOf(':')
  if (colon < 1) throw new ActionError(`Name a record by its identifier (urn:trace:…) or as <kind>:<key>, such as requirement:REQ-001. Kinds: ${RECORD_KINDS.join(', ')}.`)
  const kind = id.slice(0, colon)
  if (!RECORD_KINDS.includes(kind)) throw new ActionError(`There is no kind of record called ${kind}. Kinds: ${RECORD_KINDS.join(', ')}.`)
  return nodeIri(graphOptions(repo), kind, id.slice(colon + 1))
}

/** The vocabulary in brief, or one term with the tables that store it. */
export function describe(v: Vocabulary, term?: string) {
  const cls = [...v.classes.values()].map((c) => ({
    name: c.name, kind: 'class' as const, label: c.label, comment: c.comment, module: c.file, parents: c.parents,
    ...(c.altLabels.length ? { other_names: c.altLabels } : {}), ...(c.keptIn ? { kept_in: c.keptIn } : {}), ...(c.derived ? { derived: true } : {}),
  }))
  const props = [...v.properties.values()].filter((p) => p.kind !== 'annotation').map((p) => ({
    name: p.name, kind: p.kind, label: p.label, comment: p.comment, module: p.file, domain: p.domain, range: p.range, ...(p.derived ? { derived: true } : {}),
  }))
  const base = { namespace: 'https://trace-eda.com/ns/trace#', version: ontologyVersion(v), context: contextUrl(v), versions: v.versions }
  if (!term) {
    return {
      ...base, classes: cls.sort((a, b) => a.name.localeCompare(b.name)), properties: props.sort((a, b) => a.name.localeCompare(b.name)),
      alignments: v.alignments.map((a) => ({ term: a.term, relation: a.relation, si2: `eda:${a.si2}` })),
    }
  }
  const one = cls.find((c) => c.name === term) ?? props.find((p) => p.name === term)
  if (!one) throw new ActionError(`The ontology has no term called ${term}. ontology.describe without a term lists them all.`)
  const tables = one.kind === 'class'
    ? TABLES.filter((t) => t.class === term || Object.values(t.typeBy?.classes ?? {}).includes(term)).map((t) => `${t.db}.${t.table}`)
    : TABLES.filter((t) => Object.values(t.columns).some((r) => 'prop' in r && r.prop === term) || t.link?.[2] === term).map((t) => `${t.db}.${t.table}`)
  return {
    ...base, term: one, stored_in: tables,
    alignments: v.alignments.filter((a) => a.term === term).map((a) => ({ relation: a.relation, si2: `eda:${a.si2}` })),
    ...(one.kind === 'class' ? { subclasses: cls.filter((c) => c.parents.includes(term)).map((c) => c.name) } : {}),
  }
}

interface InputRow { kind: 'file' | 'artifact'; ref: string; name: string | null; sha256: string | null }
const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))

/** A run's lineage: what it was made from, what it made, and the runs made from what it made. */
export function lineageOf(db: DatabaseSync, run: string) {
  const r = db.prepare('SELECT id, kind, subject, status, started FROM runs WHERE id=?').get(run) as { id: string; kind: string; subject: string | null; status: string; started: number } | undefined
  if (!r) throw new ActionError(`There is no run ${run} in this project's record.`)
  const inputs = has(db, 'run_inputs') ? db.prepare('SELECT kind, ref, name, sha256 FROM run_inputs WHERE run_id=? ORDER BY ord').all(run) as unknown as InputRow[] : []
  const outputs = has(db, 'artifact_hashes') ? db.prepare('SELECT name, sha256 FROM artifact_hashes WHERE run_id=? ORDER BY name').all(run) as { name: string; sha256: string }[] : []
  const used = has(db, 'run_inputs')
    ? db.prepare(`SELECT i.run_id AS run, i.name AS name, r.kind AS kind, r.subject AS subject FROM run_inputs i JOIN runs r ON r.id = i.run_id
        WHERE i.kind = 'artifact' AND i.ref = ? ORDER BY r.started`).all(run) as { run: string; name: string | null; kind: string; subject: string | null }[]
    : []
  return {
    run: { id: r.id, kind: r.kind, subject: r.subject, status: r.status, started: new Date(r.started * 1000).toISOString() },
    made_from: inputs.map((i) => (i.kind === 'file'
      ? { file: i.ref, sha256: i.sha256 }
      : { run: i.ref, output: i.name, sha256: i.sha256 })),
    made: outputs,
    made_into: used.map((u) => ({ run: u.run, kind: u.kind, subject: u.subject, output: u.name })),
    ...(inputs.length ? {} : { note: 'trace recorded nothing this run was made from (it ran before lineage was kept, or reads nothing from the repository).' }),
  }
}

const iso = (f: Freshness) => ({ run: f.run, kind: f.kind, subject: f.subject, state: f.state, ...(f.reasons.length ? { why: f.reasons } : {}), ...(f.kept.length ? { kept: f.kept } : {}) })

export const ONTOLOGY_ACTIONS = {
  'ontology.describe': def('signed-in', z.object({ term: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(60).optional() }), async (a) =>
    describe(vocabulary(), a.term)),

  'record.get': def('read', Repo.extend({ id: z.string().trim().min(3).max(400) }), async (a, ctx) => {
    const id = recordId(a.repo, a.id)
    const store = await projectGraph(ctx, a.repo)
    const rec = recordJsonLd(store, id, vocabulary())
    if (!rec) throw new ActionError(`${a.repo} has no record ${a.id}.`)
    return { repo: a.repo, id, record: rec }
  }),

  'artifact.lineage': def('read', Repo.extend({ run: z.string().trim().min(4).max(80) }), async (a, ctx) =>
    withRecordDb(ctx, a.repo, (db) => ({ repo: a.repo, ...lineageOf(db, a.run) }))),

  'artifact.stale': def('read', Repo.extend({ runs: z.array(z.string().trim().min(4).max(80)).max(200).optional() }), async (a, ctx) => {
    const gh = await ctx.deps.github()
    const { branch } = await gh.defaultBranch(a.repo)
    return withProjectDb(ctx, a.repo, async (path) => {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        if (!has(db, 'runs')) return { repo: a.repo, branch, runs: [] }
        const ids = a.runs ?? latestFreshness(db, () => null).map((f) => f.run)
        // the files freshness reads, from the default branch; one that cannot be fetched leaves its runs unknown
        const files = new Map<string, Uint8Array | null>()
        const unreadable = new Set<string>()
        await Promise.all(filesRead(db, ids).map(async (p) => {
          try { files.set(p, await gh.rawFile(a.repo, p, branch)) } catch { unreadable.add(p) }
        }))
        const memo = new Map<string, Freshness>()
        const runs = ids.map((id) => {
          if (filesRead(db, [id]).some((p) => unreadable.has(p))) return { run: id, kind: null, subject: null, state: 'unknown' as const, why: ['a file it was made from could not be read from the default branch'] }
          return iso(freshness(db, id, (p) => files.get(p) ?? null, memo))
        })
        return { repo: a.repo, branch, runs, stale: runs.filter((r) => r.state === 'stale').length }
      } finally {
        db.close()
      }
    })
  }),
}

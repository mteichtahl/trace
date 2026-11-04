/**
 * A project's graph, in memory, from its databases through the mapping (docs/ontology.md "Querying": "The API builds a
 * project's graph from its databases through the mapping, in memory, and answers from it"). Nothing is stored: the
 * tables stay the record, and the graph is built when it is read.
 *
 *   buildGraph(sources, o)    an N3 store of every mapped row of the databases given (journey.db, facts.db, jobs.db)
 *   nodeIri(o, kind, id)      a record's identifier, urn:trace:<installation>:<project>:<kind>:<id>
 *   checkRecords(store, v)    what in the graph breaks the ontology: an undefined class or property, a literal where a
 *                             link belongs (or the reverse), a subject outside a property's domain, a link to the
 *                             wrong class, a literal of the wrong type. Empty: the records keep to the ontology
 *
 * Identifiers never hold a person's name or a part number (docs/ontology.md "Identifiers"): rows are named by their
 * table's own key, which for people's records is a random id.
 */
import type { DatabaseSync } from 'node:sqlite'
import { DataFactory, type NamedNode, type Quad_Object, Store } from 'n3'
import { type ColumnRule, type DbName, type FieldMap, type LiteralAs, type TableMap, TABLES, keyColumns } from './mapping.js'
import { NS, RDF, XSD, type Vocabulary, isA, local } from './vocab.js'
import type { Board } from '../tools/kicad/pcb.js'
import { addBoard } from './board.js'
import { addDerived } from './derived.js'
import { addCase } from './mech.js'

const { namedNode, literal, quad } = DataFactory

export interface GraphSources {
  journey?: DatabaseSync | null
  facts?: DatabaseSync | null
  jobs?: DatabaseSync | null
  /** the repository's .trace/project.db: the design record, the verification and run records, bench readings */
  project?: DatabaseSync | null
  /** the installation's parts database */
  central?: DatabaseSync | null
  /** the boards, read from their .kicad_pcb (src/tools/kicad/pcb.ts loadBoard), by their path in the repository */
  boards?: readonly { path: string; board: Board }[]
}
export interface GraphOptions {
  /** the installation's name (its prefix): identifiers are unique across installations */
  installation: string
  /** the project, owner/repo */
  project: string
  /** add the facts no column stores, worked out as the app reads them (src/ontology/derived.ts): for the shapes. Off
   *  by default, so the graph checked against the ontology (checkRecords) is what trace stores */
  derived?: boolean
  /** the repository's files as they are now (path → bytes, null when gone): with `derived`, whether the newest case
   *  build still stands is worked out from its lineage (src/ontology/mech.ts) */
  files?: (path: string) => Uint8Array | null
}

const enc = (s: string): string => encodeURIComponent(s)
export const nodeIri = (o: GraphOptions, kind: string, id: string): string => `urn:trace:${enc(o.installation)}:${enc(o.project)}:${kind}:${enc(id)}`
const T = (name: string): NamedNode => namedNode(`${NS}${name}`)
const TYPE = namedNode(`${RDF}type`)

const hasTable = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return undefined }
}

/** A column's value as a literal, or null when there is none. */
function asLiteral(v: unknown, as: LiteralAs = 'text'): Quad_Object | null {
  if (v === null || v === undefined || v === '') return null
  switch (as) {
    case 'time': {
      const n = Number(v)
      return Number.isFinite(n) ? literal(new Date(n * 1000).toISOString(), namedNode(`${XSD}dateTime`)) : null
    }
    case 'int': return Number.isFinite(Number(v)) ? literal(String(Math.trunc(Number(v))), namedNode(`${XSD}integer`)) : null
    case 'decimal': return Number.isFinite(Number(v)) ? literal(String(Number(v)), namedNode(`${XSD}decimal`)) : null
    case 'bool': return literal(v === true || v === 1 || v === '1' || v === 'true' ? 'true' : 'false', namedNode(`${XSD}boolean`))
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? literal(String(v), namedNode(`${XSD}date`)) : null
    case 'json': {
      const j = parseJson(v)
      return j === undefined ? literal(String(v), namedNode(`${RDF}JSON`)) : literal(JSON.stringify(j), namedNode(`${RDF}JSON`))
    }
    default: return literal(String(v))
  }
}

interface Ctx { o: GraphOptions; store: Store; typed: Set<string> }

function link(c: Ctx, kind: string, id: string, type?: string): NamedNode {
  const n = namedNode(nodeIri(c.o, kind, id))
  if (type && !c.typed.has(`${n.value} ${type}`)) {
    c.typed.add(`${n.value} ${type}`)
    c.store.addQuad(quad(n, TYPE, T(type)))
  }
  return n
}

/** Apply one column's (or one JSON field's) rule to its value, on node `s`. `row` is the whole row, for `pick`. */
function apply(c: Ctx, s: NamedNode, name: string, rule: ColumnRule, v: unknown, row: Record<string, unknown>, rules: Readonly<Record<string, ColumnRule>>): void {
  if ('ignore' in rule) return
  const p = T(rule.prop)
  if ('ref' in rule) {
    if (v === null || v === undefined || v === '') return
    const target = typeof rule.ref === 'function' ? rule.ref(String(v), row) : [rule.ref, String(v)] as const
    if (target) c.store.addQuad(quad(s, p, link(c, target[0], target[1], rule.type)))
    else if (rule.orLiteral) { const l = asLiteral(v); if (l) c.store.addQuad(quad(s, T(rule.orLiteral), l)) }
    return
  }
  if ('refList' in rule) {
    const list = parseJson(v)
    if (Array.isArray(list)) for (const id of list) if (id !== null && id !== undefined && id !== '') c.store.addQuad(quad(s, p, link(c, rule.refList, String(id), rule.type)))
    return
  }
  if ('textList' in rule) {
    const list = parseJson(v)
    if (Array.isArray(list)) for (const x of list) { const l = asLiteral(x); if (l) c.store.addQuad(quad(s, p, l)) }
    return
  }
  if ('objects' in rule) {
    const list = parseJson(v)
    if (!Array.isArray(list)) return
    list.forEach((item, n) => {
      if (!item || typeof item !== 'object') return
      const node = namedNode(`${s.value}/${rule.prop}/${n}`)
      object(c, node, rule.objects, item as Record<string, unknown>)
      c.store.addQuad(quad(s, p, node))
    })
    return
  }
  if ('pick' in rule) {
    if (v === null || v === undefined || v === '') return
    const from = rules[rule.pick.column]
    const list = parseJson(row[rule.pick.column])
    if (!from || !('objects' in from) || !Array.isArray(list)) return
    const n = list.findIndex((x) => x && typeof x === 'object' && String((x as Record<string, unknown>)[rule.pick.field]) === String(v))
    if (n >= 0) c.store.addQuad(quad(s, p, namedNode(`${s.value}/${from.prop}/${n}`)))
    return
  }
  const l = asLiteral(v, rule.as)
  if (l) c.store.addQuad(quad(s, p, l))
  void name
}

function object(c: Ctx, node: NamedNode, m: FieldMap, item: Record<string, unknown>): void {
  c.store.addQuad(quad(node, TYPE, T(m.class)))
  if (m.typeIf && (item[m.typeIf.field] === true || item[m.typeIf.field] === 1)) c.store.addQuad(quad(node, TYPE, T(m.typeIf.class)))
  for (const [f, rule] of Object.entries(m.fields)) apply(c, node, f, rule, item[f], item, m.fields)
}

function table(c: Ctx, db: DatabaseSync, t: TableMap): number {
  if (!hasTable(db, t.table)) return 0
  const rows = db.prepare(`SELECT * FROM ${t.table}`).all() as Record<string, unknown>[]
  const fixed = t.link ? link(c, t.link[0], t.link[1]) : null
  for (const row of rows) {
    const s = namedNode(nodeIri(c.o, t.kind, keyColumns(t).map((k) => String(row[k])).join('/')))
    c.store.addQuad(quad(s, TYPE, T(t.class)))
    const extra = t.typeBy ? t.typeBy.classes[String(row[t.typeBy.column])] : undefined
    if (extra) c.store.addQuad(quad(s, TYPE, T(extra)))
    for (const [col, rule] of Object.entries(t.columns)) apply(c, s, col, rule, row[col], row, t.columns)
    if (fixed && t.link) c.store.addQuad(quad(fixed, T(t.link[2]), s))
  }
  return rows.length
}

/** The project's graph from the databases given (any may be absent), with how many rows each table gave. */
export function buildGraph(src: GraphSources, o: GraphOptions): { store: Store; rows: Record<string, number> } {
  const c: Ctx = { o, store: new Store(), typed: new Set() }
  const rows: Record<string, number> = {}
  for (const t of TABLES) {
    const db = src[t.db as DbName]
    // the project database carries a copy of the journey's tables (a release's): the journey record is read for them
    if (db) rows[`${t.db}.${t.table}`] = table(c, db, t)
  }
  for (const b of src.boards ?? []) addBoard(c.store, o, b.path, b.board)
  // the newest case build, from the run record's artifacts (the mechanical module)
  if (src.project) addCase(c.store, o, src.project, o.files)
  // for the shapes, what no column stores, worked out as the app reads it: people's decisions are the journey's, or the
  // project database's copy of them (a release, the API's record copy)
  if (o.derived && src.project) addDerived(c.store, o, src.project, src.journey ?? src.project)
  // the journey belongs to its project
  if (src.journey && hasTable(src.journey, 'journey') && src.journey.prepare("SELECT 1 FROM journey WHERE id='current'").get()) {
    c.store.addQuad(quad(link(c, 'journey', 'current'), T('inProject'), link(c, 'project', o.project, 'Project')))
  }
  return { store: c.store, rows }
}

// ------------------------------------------------------------------ checking records against the ontology

export interface RecordProblem { subject: string; predicate: string | null; message: string }

const XSD_OF: Readonly<Record<string, string>> = { string: `${XSD}string`, dateTime: `${XSD}dateTime`, integer: `${XSD}integer`, decimal: `${XSD}decimal`, boolean: `${XSD}boolean`, date: `${XSD}date` }

/** Everything in `store` that breaks the ontology's classes, properties, domains and ranges (closed: nothing undefined). */
export function checkRecords(store: Store, v: Vocabulary): RecordProblem[] {
  const out: RecordProblem[] = []
  const types = new Map<string, string[]>()
  for (const q of store.getQuads(null, TYPE, null, null)) {
    const cls = local(q.object.value)
    if (!cls || !v.classes.has(cls)) { out.push({ subject: q.subject.value, predicate: null, message: `type ${q.object.value} is not a class of the ontology` }); continue }
    types.set(q.subject.value, [...(types.get(q.subject.value) ?? []), cls])
  }
  const fits = (node: string, cls: string): boolean | null => {
    const ts = types.get(node)
    return ts ? ts.some((t) => isA(v, t, cls)) : null
  }
  for (const q of store.getQuads(null, null, null, null)) {
    if (q.predicate.value === TYPE.value) continue
    const name = local(q.predicate.value)
    const p = name ? v.properties.get(name) : undefined
    if (!p || p.kind === 'annotation') { out.push({ subject: q.subject.value, predicate: q.predicate.value, message: 'not a property of the ontology' }); continue }
    if (p.derived) out.push({ subject: q.subject.value, predicate: name, message: 'is worked out when read and is never stored' })
    if (p.domain && v.classes.has(p.domain) && fits(q.subject.value, p.domain) === false) {
      out.push({ subject: q.subject.value, predicate: name, message: `its subject is a ${types.get(q.subject.value)?.join(', ')}, not a ${p.domain}` })
    }
    if (p.kind === 'object') {
      if (q.object.termType !== 'NamedNode') { out.push({ subject: q.subject.value, predicate: name, message: 'links to a node, not a value' }); continue }
      if (p.range && v.classes.has(p.range) && fits(q.object.value, p.range) === false) {
        out.push({ subject: q.subject.value, predicate: name, message: `links to a ${types.get(q.object.value)?.join(', ')}, not a ${p.range}` })
      }
    } else {
      if (q.object.termType !== 'Literal') { out.push({ subject: q.subject.value, predicate: name, message: 'holds a value, not a link' }); continue }
      const want = p.range ? (p.range.startsWith(XSD) ? p.range : p.range.startsWith(RDF) ? p.range : XSD_OF[p.range] ?? p.range) : null
      if (want && q.object.datatype.value !== want) out.push({ subject: q.subject.value, predicate: name, message: `is a ${q.object.datatype.value}, not a ${want}` })
    }
  }
  return out
}

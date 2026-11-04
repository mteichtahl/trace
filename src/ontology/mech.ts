/**
 * The case as the ontology reads it (ontology/trace-mech.ttl; plan P7.1): the newest case build of the run record
 * (the newest mech.build run that measured a fit), read when the graph is built, like the board (./board.ts). Nothing
 * of it is a table: the build's artifacts are the record.
 *
 *   result.json   the case's records as the engine wrote them (its `records`, which is mechanical/out/case.jsonld),
 *                 read as they are: every key is a term of the ontology (python/tracebridge/mech/records.py); each of
 *                 its process rules becomes a RuleResult named by the rule (case-rule:wall), like a fit problem
 *   fit.json      each problem the fit check found (a clash, a gap under its clearance, an opening not made that the
 *                 settings do not leave out) becomes a FitFinding, named by what it is about so a waiver of it outlasts
 *                 a rebuild
 *                 (case-finding:clash/U1/lid, case-finding:gap/board/edge, case-finding:opening/J1)
 *   case.json     the settings as the build used them: CaseSettings and a PartClearance per part given more room
 *   facts.json    each placed part's space (ComponentEnvelope) on the board the case was built for
 *
 * The engine's record ids are `<kind>:<key>` (case:base, joint:H1); in the graph each is
 * urn:trace:…:case-<kind>:<key> (the enclosure's own parts keep `case`), and `component:J1` is the board module's
 * own record of the part. With `freshness` (a reader of the repository's files as they are now), the fit check also
 * says whether the build still stands (isCurrentBuild, staleBecause: derived, for the shapes), by the build's lineage
 * (src/ontology/lineage.ts).
 */
import type { DatabaseSync } from 'node:sqlite'
import { DataFactory, type NamedNode, type Quad_Object, type Store } from 'n3'
import { unpackArtifact } from '../core/store.js'
import { freshness } from './lineage.js'
import { type GraphOptions, nodeIri } from './graph.js'
import { NS, RDF, XSD } from './vocab.js'

const { namedNode, literal, quad } = DataFactory
const T = (n: string): NamedNode => namedNode(`${NS}${n}`)
const TYPE = namedNode(`${RDF}type`)
const typed = (v: unknown, dt: string): Quad_Object => literal(String(v), namedNode(`${XSD}${dt}`))
const dec = (v: unknown): Quad_Object | null => (typeof v === 'number' && Number.isFinite(v) ? typed(Math.round(v * 1e4) / 1e4, 'decimal') : null)
const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))

/** The classes and properties of the engine's own records (python/tracebridge/mech/records.py), for the ontology's
 *  tests: test/ontology/mech.test.ts holds a real build's case.jsonld to these lists. */
export const ENGINE_CLASSES = ['Enclosure', 'EnclosurePart', 'Material', 'BoardOutline', 'Standoff', 'Fastener', 'MountingPoint', 'Opening', 'Joint', 'FitCheck'] as const
export const ENGINE_PROPERTIES = [
  'caseSource', 'hasPart', 'material', 'encloses', 'outerSize', 'name', 'process', 'service', 'path', 'sha256', 'thickness', 'unit',
  'partKind', 'boundingBox', 'wallThickness', 'hasStandoff', 'fastenerKind', 'size', 'length', 'pilotDiameter', 'reference',
  'positionX', 'positionY', 'diameter', 'fastener', 'atMountingPoint', 'forComponent', 'face', 'inPart', 'jointKind', 'joins',
  'usesFastener', 'clearance', 'status', 'enclosed', 'clashCount', 'clashes', 'gapViolations', 'boardSha256', 'fitOf',
] as const

/** The classes and properties this reader writes beyond the engine's own records, for the ontology's tests. */
export const MECH_CLASSES = ['FitFinding', 'RuleResult', 'CaseSettings', 'PartClearance', 'ComponentEnvelope', 'Material'] as const
export const MECH_PROPERTIES = [
  'madeByRun', 'outlineOf', 'findingOf', 'findingKind', 'reference', 'casePart', 'place', 'measured', 'required', 'volume', 'text',
  'ruleOf', 'ruleName', 'status', 'sourceAddress', 'settingsOf', 'caseSource', 'caseTemplate', 'material', 'name', 'process', 'service',
  'wallThickness', 'floorThickness', 'lidThickness', 'edgeClearance', 'clearanceAbove', 'clearanceBelow', 'caseQuantity',
  'hasPartClearance', 'clearance', 'reason', 'settingReasons', 'path', 'envelopeOf', 'boundingBox', 'height', 'side', 'heightSource',
  'isConnector', 'edgeSide', 'isCurrentBuild', 'staleBecause',
] as const

export interface CaseBuild { run: string; started: number; status: string }

/** The newest mech.build run that measured a fit (what mech.fit reads), or null. */
export function latestCaseBuild(db: DatabaseSync): CaseBuild | null {
  if (!has(db, 'runs') || !has(db, 'artifacts')) return null
  const rows = db.prepare("SELECT id, started, status FROM runs WHERE kind='mech.build' AND status IN ('pass','fail') ORDER BY started DESC, id DESC LIMIT 20").all() as { id: string; started: number; status: string }[]
  for (const r of rows) if (artifactJson(db, r.id, 'fit.json') !== null) return { run: r.id, started: r.started, status: r.status }
  return null
}

/** A build's JSON artifact, or null when it has none or it is not JSON. */
export function artifactJson(db: DatabaseSync, run: string, name: string): unknown {
  const row = db.prepare('SELECT mime, bytes FROM artifacts WHERE run_id=? AND name=?').get(run, name) as { mime: string | null; bytes: Uint8Array } | undefined
  if (!row) return null
  try { return JSON.parse(new TextDecoder().decode(unpackArtifact(row.mime, row.bytes).bytes)) } catch { return null }
}

/** An engine record id (`case:base`, `joint:H1`, `component:J1`) as its node in the project's graph. */
export function caseNode(o: GraphOptions, id: string): NamedNode {
  const at = id.indexOf(':')
  const kind = at < 0 ? 'case' : id.slice(0, at)
  const key = at < 0 ? id : id.slice(at + 1)
  return namedNode(nodeIri(o, kind === 'case' || kind === 'component' ? kind : `case-${kind}`, key))
}

/** The engine's keys whose range is JSON (a list kept as one value) and whose range is a whole number. */
export const JSON_KEYS: ReadonlySet<string> = new Set(['boundingBox', 'outerSize'])
export const INTEGER_KEYS: ReadonlySet<string> = new Set(['clashCount', 'gapViolations'])

type Rec = Record<string, unknown>
const isRec = (x: unknown): x is Rec => Boolean(x) && typeof x === 'object' && !Array.isArray(x)

/**
 * The engine's case records into `store`, each key read as the ontology's term: a link (`{"@id": …}`) for an object
 * property, a value typed by the term's range (JSON_KEYS kept whole, INTEGER_KEYS whole numbers, other numbers
 * decimals; test/ontology/mech.test.ts holds both lists to the ontology, which is not read here so the harness bundle
 * needs no files), and a key the ontology does not define left as it is, so the record check (checkRecords) reports
 * it. Returns the fit check's node.
 */
export function addCaseRecords(store: Store, o: GraphOptions, records: unknown): NamedNode | null {
  const graph = isRec(records) && Array.isArray(records['@graph']) ? records['@graph'] as unknown[] : []
  let fit: NamedNode | null = null
  const value = (key: string, x: unknown): Quad_Object | null => {
    if (isRec(x) && typeof x['@id'] === 'string') return caseNode(o, x['@id'])
    if (JSON_KEYS.has(key)) return literal(JSON.stringify(x), namedNode(`${RDF}JSON`))
    if (x === null || x === undefined) return null
    if (typeof x === 'boolean') return typed(x, 'boolean')
    if (typeof x === 'number') return INTEGER_KEYS.has(key) ? typed(Math.trunc(x), 'integer') : dec(x)
    return literal(String(x))
  }
  for (const n of graph) {
    if (!isRec(n) || typeof n['@id'] !== 'string') continue
    const s = caseNode(o, n['@id'])
    for (const t of [n['@type']].flat()) if (typeof t === 'string') store.addQuad(quad(s, TYPE, T(t)))
    if (n['@type'] === 'FitCheck') fit = s
    for (const [k, x] of Object.entries(n)) {
      if (k.startsWith('@')) continue
      const items = Array.isArray(x) && !JSON_KEYS.has(k) ? x : [x]
      for (const item of items) { const q = value(k, item); if (q) store.addQuad(quad(s, T(k), q)) }
    }
  }
  return fit
}

/** A fit problem's node: named by what it is about, so a waiver of it outlasts a rebuild. */
export const findingKey = (f: { kind: 'clash' | 'gap' | 'opening'; ref: string; at?: string | null }): string => [f.kind, f.ref, ...(f.at ? [f.at] : [])].join('/')

interface Fit {
  clashes?: { ref: string; case_part: string; volume_mm3: number }[]
  gaps?: { ref: string; where: string; measured_mm: number | null; required_mm: number; ok: boolean }[]
  openings?: { ref: string; side: string; made: boolean }[]
}
interface Rule { rule: string; ok: boolean | null; detail: string; measured: unknown; limit: unknown; source: string | null }

/** The newest case build of `project` (the run record) into `store`. Nothing when there is none. */
export function addCase(store: Store, o: GraphOptions, project: DatabaseSync, files?: (path: string) => Uint8Array | null): CaseBuild | null {
  const b = latestCaseBuild(project)
  if (!b) return null
  const id = (kind: string, key: string): NamedNode => namedNode(nodeIri(o, kind, key))
  const add = (s: NamedNode, p: string, x: Quad_Object | null): void => { if (x) store.addQuad(quad(s, T(p), x)) }
  const result = artifactJson(project, b.run, 'result.json') as { records?: unknown; rules?: Rule[] } | null
  const run = id('run', b.run)
  const fit = addCaseRecords(store, o, result?.records) ?? id('case-check', 'fit')
  store.addQuad(quad(fit, TYPE, T('FitCheck')))
  store.addQuad(quad(fit, T('madeByRun'), run))
  const enclosure = caseNode(o, 'case:enclosure')
  // the outline is of the board file the board module reads
  for (const q of store.getQuads(enclosure, T('encloses'), null, null)) {
    const path = store.getQuads(q.object, T('path'), null, null)[0]?.object.value
    if (path) store.addQuad(quad(q.object as NamedNode, T('outlineOf'), id('board-file', path)))
  }

  const f = (artifactJson(project, b.run, 'fit.json') ?? {}) as Fit
  const finding = (key: string, kind: string, ref: string, text: string): NamedNode => {
    const n = id('case-finding', key)
    store.addQuad(quad(n, TYPE, T('FitFinding')))
    add(n, 'findingOf', fit)
    add(n, 'findingKind', literal(kind))
    add(n, 'reference', literal(ref))
    add(n, 'text', literal(text))
    return n
  }
  for (const c of f.clashes ?? []) {
    const n = finding(findingKey({ kind: 'clash', ref: c.ref, at: c.case_part }), 'clash', c.ref, `${c.ref} clashes with the ${c.case_part} (${fmt(c.volume_mm3)} mm³)`)
    add(n, 'casePart', literal(c.case_part))
    add(n, 'volume', dec(c.volume_mm3))
  }
  for (const g of (f.gaps ?? []).filter((x) => !x.ok)) {
    const n = finding(findingKey({ kind: 'gap', ref: g.ref, at: g.where }), 'gap', g.ref,
      `${g.ref === 'board' ? 'The board' : g.ref} ${WHERE[g.where] ?? g.where}: ${g.measured_mm === null ? 'not measured' : `${fmt(g.measured_mm)} mm`}, needs ${fmt(g.required_mm)} mm`)
    add(n, 'place', literal(g.where))
    add(n, 'measured', dec(g.measured_mm))
    add(n, 'required', dec(g.required_mm))
  }
  // an opening a person chose to leave out (openings.skip in the settings) is their choice, not a problem
  const skipped = new Set((artifactJson(project, b.run, 'case.json') as CaseJson | null)?.openings?.skip ?? [])
  for (const x of (f.openings ?? []).filter((y) => !y.made && !skipped.has(y.ref))) {
    const n = finding(findingKey({ kind: 'opening', ref: x.ref }), 'opening', x.ref, `No opening is cut for ${x.ref} on the ${x.side} side`)
    add(n, 'place', literal(x.side))
  }

  for (const r of result?.rules ?? []) {
    const n = id('case-rule', r.rule)
    store.addQuad(quad(n, TYPE, T('RuleResult')))
    add(n, 'ruleOf', fit)
    add(n, 'ruleName', literal(r.rule))
    add(n, 'status', literal(r.ok === true ? 'pass' : r.ok === false ? 'fail' : 'not checked'))
    add(n, 'text', r.detail ? literal(r.detail) : null)
    add(n, 'measured', dec(r.measured))
    add(n, 'required', dec(r.limit))
    add(n, 'sourceAddress', r.source ? literal(r.source) : null)
  }

  const s = artifactJson(project, b.run, 'case.json') as CaseJson | null
  if (s) addSettings(store, o, s, enclosure)

  const facts = artifactJson(project, b.run, 'facts.json') as { parts?: FactPart[] } | null
  for (const p of facts?.parts ?? []) {
    const n = id('case-envelope', p.ref)
    store.addQuad(quad(n, TYPE, T('ComponentEnvelope')))
    add(n, 'envelopeOf', id('component', p.ref))
    add(n, 'boundingBox', literal(JSON.stringify([p.box.max_x - p.box.min_x, p.box.max_y - p.box.min_y, p.height_mm].map((x) => Math.round(x * 1e3) / 1e3)), namedNode(`${RDF}JSON`)))
    add(n, 'height', dec(p.height_mm))
    add(n, 'side', literal(p.side))
    add(n, 'heightSource', literal(p.height_source))
    add(n, 'isConnector', typed(p.connector, 'boolean'))
    add(n, 'edgeSide', p.edge ? literal(p.edge.side) : null)
  }

  // for the shapes: whether the build still stands, by its lineage against the files as they are now
  if (o.derived && files) {
    const fr = freshness(project, b.run, files)
    add(fit, 'isCurrentBuild', typed(fr.state === 'current', 'boolean'))
    if (fr.state !== 'current') add(fit, 'staleBecause', literal(fr.reasons[0] ?? 'trace cannot tell what the build was made from'))
  }
  return b
}

const WHERE: Readonly<Record<string, string>> = { edge: 'to the wall', above: 'to the lid', below: 'to the floor', around: 'in its opening' }
const fmt = (n: number): string => String(Math.round(n * 100) / 100)

interface FactPart { ref: string; side: string; box: { min_x: number; min_y: number; max_x: number; max_y: number }; height_mm: number; height_source: string; connector: boolean; edge: { side: string } | null }
interface CaseJson {
  template?: string; source?: string; quantity?: number
  process?: { service?: string; process?: string; material?: string }
  params?: { wall_mm?: number; floor_mm?: number; lid_mm?: number }
  clearance?: { edge_mm?: number; above_tallest_mm?: number; below_mm?: number; parts?: Record<string, { mm: number; reason: string }> }
  openings?: { skip?: string[] }
  reasons?: Record<string, string>
}

function addSettings(store: Store, o: GraphOptions, s: CaseJson, enclosure: NamedNode): void {
  const id = (kind: string, key: string): NamedNode => namedNode(nodeIri(o, kind, key))
  const add = (n: NamedNode, p: string, x: Quad_Object | null): void => { if (x) store.addQuad(quad(n, T(p), x)) }
  const n = id('case-settings', 'case')
  store.addQuad(quad(n, TYPE, T('CaseSettings')))
  add(n, 'settingsOf', enclosure)
  add(n, 'path', literal('mechanical/case.json'))
  add(n, 'caseTemplate', s.template ? literal(s.template) : null)
  add(n, 'caseSource', s.source ? literal(s.source) : null)
  if (s.process) {
    const m = id('case-material', 'settings')
    store.addQuad(quad(m, TYPE, T('Material')))
    add(m, 'name', s.process.material ? literal(s.process.material) : null)
    add(m, 'process', s.process.process ? literal(s.process.process) : null)
    add(m, 'service', s.process.service ? literal(s.process.service) : null)
    add(n, 'material', m)
  }
  add(n, 'wallThickness', dec(s.params?.wall_mm))
  add(n, 'floorThickness', dec(s.params?.floor_mm))
  add(n, 'lidThickness', dec(s.params?.lid_mm))
  add(n, 'edgeClearance', dec(s.clearance?.edge_mm))
  add(n, 'clearanceAbove', dec(s.clearance?.above_tallest_mm))
  add(n, 'clearanceBelow', dec(s.clearance?.below_mm))
  add(n, 'caseQuantity', typeof s.quantity === 'number' ? typed(Math.trunc(s.quantity), 'integer') : null)
  for (const [ref, c] of Object.entries(s.clearance?.parts ?? {})) {
    const p = id('case-clearance', ref)
    store.addQuad(quad(p, TYPE, T('PartClearance')))
    add(p, 'reference', literal(ref))
    add(p, 'clearance', dec(c.mm))
    add(p, 'reason', literal(c.reason))
    add(n, 'hasPartClearance', p)
  }
  if (s.reasons && Object.keys(s.reasons).length) add(n, 'settingReasons', literal(JSON.stringify(s.reasons), namedNode(`${RDF}JSON`)))
}

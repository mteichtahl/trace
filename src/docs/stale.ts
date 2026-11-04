/**
 * Which sections of the project's documents a change touched (docs/scribe.md "Surgical updates"): the files a change
 * made map to the kinds of record they hold (src/docs/catalog.ts SOURCE_KINDS), and every section written from one of
 * those kinds is to be written again. The project database is compared table by table between the two commits, so a
 * new requirement marks the requirement sections and not the thermal ones. No model is asked: the mapping is fixed,
 * so the same change always marks the same sections and a person can check why.
 *
 * Pure apart from reading the two databases it is given.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { DOC_KINDS, DOCS, type DocKind, type SourceKind } from './catalog.js'

/** The project database's tables and the records they hold. A table not named here marks nothing. */
export const TABLE_SOURCES: Readonly<Record<string, readonly SourceKind[]>> = {
  intent_statements: ['intent'], requirement_intent: ['intent', 'requirements'], requirements: ['requirements'],
  arch_options: ['architecture', 'decisions'], arch_criteria: ['architecture', 'decisions'], arch_scores: ['architecture', 'decisions'],
  arch_blocks: ['architecture'], arch_connections: ['architecture'],
  pin_plan: ['pin-plan'], sheet_requirements: ['schematic', 'requirements'], parts_list_lines: ['parts'],
  test_items: ['tests'], test_results: ['tests'], coverage_points: ['tests'], coverage_hits: ['tests'], bringup_readings: ['tests'],
  protocol_specs: ['protocol-specs'], thermal_budget: ['power'], thermal_envelope: ['thermal'],
}

/** Run kinds and the records their results are: a new run of one marks its sections. */
export const RUN_SOURCES: readonly (readonly [RegExp, readonly SourceKind[]])[] = [
  [/^thermal\.(check|junction|board|measure|pcb)$/, ['thermal']], [/^thermal\.budget$/, ['power']],
  [/^protocol\.(model|check|capture|diagram|compat|bus_analog)$/, ['protocol-runs']],
  [/^(sim|verify|ams|emc)\./, ['tests']], [/^(kicad\.(erc|drc)|layout\.)/, ['board']],
  [/^(render\.(board|showcase)|mech\.(build|fit))$/, ['board', 'enclosure']], [/^fab\./, ['fabrication']],
]

/** Repository paths and the records they hold. */
export const PATH_SOURCES: readonly (readonly [RegExp, readonly SourceKind[]])[] = [
  [/\.kicad_sch$/, ['schematic']], [/\.kicad_pcb$/, ['board', 'fabrication']], [/\.kicad_(pro|dru)$/, ['board']],
  [/^mechanical\//, ['enclosure']], [/^(firmware|src|include|lib)\/|\.(c|h|cpp|hpp|rs|ino)$/, ['firmware']],
  [/(^|\/)(intent|spec)\.md$/, ['intent', 'requirements']], [/^(fab|fabrication|release)\//, ['fabrication']],
]

/** The records a list of changed repository paths holds (the project database is compared separately). Pure. */
export function sourcesOfPaths(paths: readonly string[]): Set<SourceKind> {
  const out = new Set<SourceKind>()
  for (const p of paths) for (const [re, kinds] of PATH_SOURCES) if (re.test(p)) kinds.forEach((k) => out.add(k))
  return out
}

const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))

function tableHash(db: DatabaseSync | null, t: string): string {
  if (!db || !has(db, t)) return ''
  // each row hashed on its own and the hashes sorted, so a merge that only reorders rows changes nothing
  const rows = db.prepare(`SELECT * FROM "${t}"`).all().map((r) => createHash('sha256')
    .update(JSON.stringify(r, (_k, v: unknown) => (v instanceof Uint8Array ? createHash('sha256').update(v).digest('hex') : v))).digest('hex'))
  return createHash('sha256').update(rows.sort().join('\n')).digest('hex')
}

/** The records whose tables differ between the two databases (either may be absent: a new project). */
export function sourcesOfDatabases(before: DatabaseSync | null, after: DatabaseSync | null): Set<SourceKind> {
  const out = new Set<SourceKind>()
  for (const [t, kinds] of Object.entries(TABLE_SOURCES)) {
    if (tableHash(before, t) !== tableHash(after, t)) kinds.forEach((k) => out.add(k))
  }
  const runKinds = (db: DatabaseSync | null): Map<string, number> => {
    const m = new Map<string, number>()
    if (!db || !has(db, 'runs')) return m
    for (const r of db.prepare("SELECT kind, count(*) AS n FROM runs WHERE status IN ('pass','fail') GROUP BY kind").all() as { kind: string; n: number }[]) m.set(r.kind, r.n)
    return m
  }
  const a = runKinds(before)
  for (const [kind, n] of runKinds(after)) {
    if ((a.get(kind) ?? 0) === n) continue
    for (const [re, kinds] of RUN_SOURCES) if (re.test(kind)) kinds.forEach((k) => out.add(k))
  }
  return out
}

export interface StaleSection { id: string; title: string; because: SourceKind[] }

/** For each document, the sections written from any of `sources`, with the records that marked each. Pure. */
export function staleSections(sources: ReadonlySet<SourceKind>, kinds: readonly DocKind[] = DOC_KINDS): { kind: DocKind; sections: StaleSection[] }[] {
  return kinds.map((k) => ({
    kind: k,
    sections: DOCS[k].sections
      .map((s) => ({ id: s.id, title: s.title, because: s.sources.filter((x) => sources.has(x)) }))
      .filter((s) => s.because.length > 0),
  }))
}

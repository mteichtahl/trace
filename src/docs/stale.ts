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
import type { StageId } from '../core/journey-catalog.js'
import { DOC_KINDS, DOCS, docsFor, reached, type DocKind, type SourceKind } from './catalog.js'

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
  [/^protocol\.(model|check|capture|compat|bus_analog)$/, ['protocol-runs']],
  [/^(sim|verify|ams|emc)\./, ['tests']], [/^(kicad\.(erc|drc)|layout\.)/, ['board']],
  [/^mech\.(build|fit)$/, ['enclosure']], [/^fab\./, ['fabrication']],
]
// Not here, on purpose: the runs Scribe itself makes for the documents (docs.*, render.showcase, render.board,
// protocol.diagram). They are pictures of records, not records, so they never mark a section: otherwise Scribe's own
// change would start Scribe again.

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
  const a = latestOutcomes(before)
  for (const [key, outcome] of latestOutcomes(after)) {
    if (a.get(key) === outcome) continue
    const kind = key.slice(0, key.indexOf('\0'))
    for (const [re, kinds] of RUN_SOURCES) if (re.test(kind)) kinds.forEach((k) => out.add(k))
  }
  return out
}

/**
 * Each check's latest outcome, by its kind and what it checked: its status and summary, without the ids of runs and
 * rows the summary cites. What the documents report is the outcome, so a check run again with the same outcome marks
 * nothing: test-esp32 run 2 ran the same ERC ("0 errors, 0 warnings") in five jobs, the same case fit four times and the
 * verify plan twice, and each new run marked its sections, so every such change started the Documentation agent again
 * to write what was already written. A new check, or one whose outcome changed, marks them as before.
 */
function latestOutcomes(db: DatabaseSync | null): Map<string, string> {
  const m = new Map<string, string>()
  if (!db || !has(db, 'runs')) return m
  const rows = db.prepare("SELECT kind, subject, status, summary FROM runs WHERE status IN ('pass','fail') ORDER BY started, id").all() as { kind: string; subject: string | null; status: string; summary: string | null }[]
  for (const r of rows) m.set(`${r.kind}\0${r.subject ?? ''}`, `${r.status}\0${(r.summary ?? '').replace(CITED_ID, '#')}`)
  return m
}
/** A run's or a record row's id as summaries cite them (16 or 32 hex digits): new on every run, whatever it found. */
const CITED_ID = /\b(?:[0-9a-f]{32}|[0-9a-f]{16})\b/g

/**
 * The sections due by `stage` (of the documents it has) that a change to `sources` marks: what the Documentation agent
 * would write now. None means the change feeds only sections due at a later stage, which are written when that stage
 * opens (it compares with the commit the documents were last written at, so nothing is missed). Pure.
 */
export function dueSections(sources: ReadonlySet<SourceKind>, stage: StageId): { kind: DocKind; sections: StaleSection[] }[] {
  return docsFor(stage, true).map((d) => ({
    kind: d.kind,
    sections: d.sections.filter((s) => reached(stage, s.due))
      .map((s) => ({ id: s.id, title: s.title, because: s.sources.filter((x) => sources.has(x)) }))
      .filter((s) => s.because.length > 0),
  })).filter((d) => d.sections.length > 0)
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

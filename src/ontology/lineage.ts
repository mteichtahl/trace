/**
 * Lineage and freshness, worked out on read (docs/ontology.md "Input/output, versions and staleness"; plan P4.2): a
 * run is current when everything it was made from is still what it read, and stale otherwise, with the cause in plain
 * words. Nothing stores a freshness flag that could drift: trace computes it from the run record (run_inputs,
 * artifact_hashes in .trace/project.db) and the repository's files as they are now, like every other state it shows.
 *
 *   freshness(db, run, read)   one run: current, stale (with reasons) or unknown (no inputs recorded: a run from before
 *                              lineage). `read(path)` gives a repository file as it is now, or null when it is gone
 *   latestFreshness(db, read)  the newest run of each tool and subject, with its freshness
 *
 * The rule, for each input:
 *   a file              current while its normalised content has the hash the run recorded (src/core/normalise.ts)
 *   a view of a file    `<path>#<view>`: current while the part of the file the run depends on has the hash recorded
 *                       (inputHash; `case`: what a case build depends on of a board, src/tools/mech/case-facts.ts)
 *   another run's output current while that run is the newest of its tool and subject and is itself current; when
 *                       the tool ran again, current while the newer run made the same output (the same hash) and is
 *                       current. That is the content check: a schematic edit that leaves the netlist the same leaves
 *                       everything made from the netlist current, and `kept` says why
 */
import type { DatabaseSync } from 'node:sqlite'
import { normalisedHash } from '../core/normalise.js'
import { CASE_VIEW, caseViewHash } from '../tools/mech/case-facts.js'

export type FreshnessState = 'current' | 'stale' | 'unknown'
export interface Freshness {
  run: string
  kind: string
  subject: string | null
  state: FreshnessState
  /** why it is stale, in words: each input that changed */
  reasons: string[]
  /** why it is still current although something upstream changed */
  kept: string[]
}

interface RunRow { id: string; kind: string; subject: string | null; started: number }
interface InputRow { kind: 'file' | 'artifact'; ref: string; name: string | null; sha256: string | null }

const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
const runOf = (db: DatabaseSync, id: string): RunRow | undefined => db.prepare('SELECT id, kind, subject, started FROM runs WHERE id=?').get(id) as RunRow | undefined
const hashOf = (db: DatabaseSync, run: string, name: string): string | null => (db.prepare('SELECT sha256 FROM artifact_hashes WHERE run_id=? AND name=?').get(run, name) as { sha256: string } | undefined)?.sha256 ?? null

/** A file input's path and the view of it a run depends on (`hardware/x.kicad_pcb#case` → the board, `case`). */
export function splitRef(ref: string): { path: string; view: string | null } {
  const at = ref.lastIndexOf('#')
  // only a view trace knows: a file whose own name has a # in it is that file
  return at > 0 && VIEWS.has(ref.slice(at + 1)) ? { path: ref.slice(0, at), view: ref.slice(at + 1) } : { path: ref, view: null }
}
const VIEWS: ReadonlySet<string> = new Set([CASE_VIEW])

/** The hash a file input records: of the file's normalised content, or of the view of it named after `#`. */
export function inputHash(ref: string, bytes: Uint8Array): string {
  const { path, view } = splitRef(ref)
  if (view === CASE_VIEW) return caseViewHash(path, bytes)
  return normalisedHash(path, bytes)
}

const VIEW_WORDS: Readonly<Record<string, string>> = { [CASE_VIEW]: 'what the case depends on of' }
const inWords = (ref: string): string => {
  const { path, view } = splitRef(ref)
  return view ? `${VIEW_WORDS[view] ?? `the ${view} of`} ${path}` : path
}

/** The newest run of the same tool and subject that made output `name`. */
function newestMaker(db: DatabaseSync, r: RunRow, name: string): RunRow | undefined {
  return db.prepare(`SELECT r.id, r.kind, r.subject, r.started FROM runs r JOIN artifact_hashes h ON h.run_id = r.id AND h.name = ?
    WHERE r.kind = ? AND r.subject IS ? ORDER BY r.started DESC, r.id DESC LIMIT 1`).get(name, r.kind, r.subject) as RunRow | undefined
}

/** One run's freshness. `seen` guards a cycle (a run's inputs never name itself; a damaged record might). */
export function freshness(db: DatabaseSync, runId: string, read: (path: string) => Uint8Array | null, memo: Map<string, Freshness> = new Map(), seen: Set<string> = new Set()): Freshness {
  const hit = memo.get(runId)
  if (hit) return hit
  const r = runOf(db, runId)
  const out: Freshness = { run: runId, kind: r?.kind ?? 'unknown', subject: r?.subject ?? null, state: 'current', reasons: [], kept: [] }
  if (!r) return { ...out, state: 'unknown', reasons: [`there is no run ${runId}`] }
  const inputs = has(db, 'run_inputs') ? db.prepare('SELECT kind, ref, name, sha256 FROM run_inputs WHERE run_id=? ORDER BY ord').all(runId) as unknown as InputRow[] : []
  if (!inputs.length) {
    const f = { ...out, state: 'unknown' as const, reasons: ['trace recorded nothing this run was made from (it ran before lineage was kept)'] }
    memo.set(runId, f)
    return f
  }
  if (seen.has(runId)) return { ...out, state: 'unknown', reasons: ['its inputs lead back to itself'] }
  seen.add(runId)
  for (const i of inputs) {
    if (i.kind === 'file') {
      const now = read(splitRef(i.ref).path)
      if (now === null) { if (i.sha256 !== null) out.reasons.push(`${splitRef(i.ref).path} is gone`); continue }
      if (inputHash(i.ref, now) !== i.sha256) out.reasons.push(i.sha256 === null ? `${splitRef(i.ref).path} was added since` : `${inWords(i.ref)} changed since ${r.kind} ran`)
      continue
    }
    const maker = runOf(db, i.ref)
    const name = i.name ?? ''
    if (!maker) { out.reasons.push(`the run that made ${name} (${i.ref}) is no longer in the record`); continue }
    const newest = newestMaker(db, maker, name) ?? maker
    const f = freshness(db, newest.id, read, memo, seen)
    if (newest.id !== maker.id) {
      const h = hashOf(db, newest.id, name)
      if (h !== i.sha256) { out.reasons.push(`${maker.kind} made ${name} again (run ${newest.id.slice(0, 8)}) and it differs`); continue }
      const up = freshness(db, maker.id, read, memo, seen)
      out.kept.push(`${up.reasons[0] ?? `${maker.kind}'s inputs changed`}, but ${maker.kind} made the same ${name} again (run ${newest.id.slice(0, 8)})`)
    }
    if (f.state === 'stale') out.reasons.push(`${name} from ${maker.kind} is out of date: ${f.reasons[0] ?? 'its inputs changed'}`)
    out.kept.push(...f.kept)
  }
  seen.delete(runId)
  const done: Freshness = { ...out, state: out.reasons.length ? 'stale' : 'current', kept: [...new Set(out.kept)] }
  memo.set(runId, done)
  return done
}

/** The newest run of each tool and subject, each with its freshness, newest first. */
export function latestFreshness(db: DatabaseSync, read: (path: string) => Uint8Array | null): Freshness[] {
  const rows = db.prepare(`SELECT id FROM runs r WHERE started = (SELECT MAX(started) FROM runs x WHERE x.kind = r.kind AND x.subject IS r.subject)
    ORDER BY started DESC`).all() as { id: string }[]
  const memo = new Map<string, Freshness>()
  return rows.map((x) => freshness(db, x.id, read, memo))
}

/**
 * Every repository file freshness will read for `runs`: their file inputs, and those of the runs whose outputs they
 * were made from (and of the newest runs of those tools), so a caller that reads files over the network (the API,
 * from the default branch) can fetch them first and answer `read` from what it fetched.
 */
export function filesRead(db: DatabaseSync, runs: readonly string[]): string[] {
  if (!has(db, 'run_inputs')) return []
  const files = new Set<string>()
  const seen = new Set<string>()
  const todo = [...runs]
  while (todo.length) {
    const id = todo.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    for (const i of db.prepare('SELECT kind, ref, name FROM run_inputs WHERE run_id=?').all(id) as unknown as InputRow[]) {
      if (i.kind === 'file') { files.add(splitRef(i.ref).path); continue }
      todo.push(i.ref)
      const maker = runOf(db, i.ref)
      const newest = maker && i.name ? newestMaker(db, maker, i.name) : undefined
      if (newest) todo.push(newest.id)
    }
  }
  return [...files].sort()
}

/** Why each of `runs` no longer stands, by run (stale runs only), reading the files from `files` (null: gone). */
export function staleRuns(db: DatabaseSync, runs: readonly string[], files: ReadonlyMap<string, Uint8Array | null>): Map<string, string> {
  const memo = new Map<string, Freshness>()
  const out = new Map<string, string>()
  for (const id of runs) {
    const f = freshness(db, id, (p) => files.get(p) ?? null, memo)
    if (f.state === 'stale') out.set(id, f.reasons[0] ?? 'what it was made from changed')
  }
  return out
}

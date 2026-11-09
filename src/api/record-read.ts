/**
 * Reading what the record holds about the design, for the screens (requirements.trace, design.get, files.list,
 * skill.get): each requirement's evidence status, and the findings of the latest electrical and design rule checks.
 * Pure functions over an open record database (src/api/action-kit.ts withRecordDb: the repository's project database
 * with the live journey tables), so they are tested on their own.
 *
 * The design record (src/tools/design: intent, architecture, pin plan, sheet → requirements) is read here too, with
 * people's decisions over it: they are journey tables (design_decisions), so withRecordDb's copy already holds them
 * beside the agents' rows. A requirement a person struck in Requirements review is struck here, whatever the
 * repository's row says, and one they accepted is accepted.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { JourneyRecord } from '../core/journey.js'
import { artifactMime, unpackArtifact } from '../core/store.js'
import { type DesignDecision, loadDesignDecisions } from '../tools/design/decisions.js'
import { type DesignRows, readDesignRows } from '../tools/design/db.js'
import type { StockLine } from '../tools/design/key-parts.js'
import { parseNets, requirementDecisions, requirementsNow, withStated } from '../tools/design/record.js'
import type { Drawing } from '../tools/kicad/export.js'
import { type CheckReport, parseDrc, parseErc } from '../tools/kicad/checks.js'
import { type SetAside, type WaiverRef, requirementVerdict, setAsideWords } from '../tools/verify/verdict.js'

export const hasTable = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
const rows = (db: DatabaseSync, sql: string, ...args: (string | number)[]): Record<string, unknown>[] => db.prepare(sql).all(...args) as Record<string, unknown>[]
const list = (v: unknown): string[] => {
  if (typeof v !== 'string') return []
  try { const x: unknown = JSON.parse(v); return Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : [] } catch { return [] }
}
const jsonOf = (v: unknown): unknown => { if (typeof v !== 'string') return null; try { return JSON.parse(v) } catch { return null } }

// ------------------------------------------------------------------ requirements and their evidence

export type Evidence = 'verified' | 'failing' | 'untested' | 'waived'

export interface TraceRequirement {
  id: string; text: string; kind: string; acceptance: string | null; source: string | null; status: string
  /** how its criterion is checked, when the person gave it with an edit (Requirements review) */
  method?: string
  evidence: Evidence
  /** why, in words: "TST-001 failed on its last run", "waived: W-… (degraded)" */
  why: string
  tests: { id: string; title: string; method: string; status: string; last_run: string | null }[]
  waiver: string | null
  /** what was set aside on it (tests waived, a waiver on it) and in words, as the verification report says it */
  set_aside?: SetAside[]
  note?: string
}


/**
 * Every live requirement (not rejected or obsolete) with its evidence status, by the verification report's own rule
 * (src/tools/verify/verdict.ts, with the journey's waivers):
 *   waived     every one of its tests is set aside (waived), or an open waiver stands on it and it is not verified
 *   failing    a test of it failed or errored on its last run
 *   verified   it has tests, and every one not set aside passed; what was set aside is said (`note`: "TST-031 waived
 *              to Fabricate"), so a waiver on a verified requirement is never hidden
 *   untested   no test yet, or a test has not run (planned, blocked)
 */
/** The waivers a requirement's evidence reads: the journey record's, or the journey as the ontology has it. */
export type RequirementWaivers = { waivers: readonly { id: string; closedAt: number | null; targetKind: string; target: string; severity: string; reason: string; caughtWhere?: string | null }[] } | null

export function requirementEvidence(db: DatabaseSync, r: RequirementWaivers): TraceRequirement[] {
  if (!hasTable(db, 'requirements')) return []
  const tests = hasTable(db, 'test_items') ? rows(db, 'SELECT id, title, requirements, method, status, last_run FROM test_items ORDER BY id') : []
  const waivers: WaiverRef[] = (r?.waivers ?? []).map((w) => ({ id: w.id, targetKind: w.targetKind, target: w.target, caughtWhere: w.caughtWhere ?? null, closedAt: w.closedAt }))
  const byId = new Map((r?.waivers ?? []).map((w) => [w.id, w]))
  const all = rows(db, 'SELECT * FROM requirements ORDER BY id')
  const decided = requirementDecisions(loadDesignDecisions(db), requirementsNow(all))
  return all.flatMap((q) => {
    const d = decided.get(String(q.id))
    // a person's decision stands over the agents' row; without one, the row's own status
    if (d ? d.choice === 'struck' : q.status === 'rejected' || q.status === 'obsolete') return []
    // the person's own wording (an edit in Requirements review) is laid over the agents' row
    const e = d?.edited
    return [{ ...q, ...(e?.text ? { text: e.text } : {}), ...(e?.acceptance ? { acceptance: e.acceptance } : {}), ...(e?.kind ? { kind: e.kind } : {}), ...(e?.method ? { method: e.method } : {}), status: d?.choice === 'accepted' ? 'accepted' : q.status } as Record<string, unknown>]
  }).map((q) => {
    const id = String(q.id)
    const mine = tests.filter((t) => list(t.requirements).includes(id)).map((t) => ({
      id: String(t.id), title: String(t.title), method: String(t.method), status: String(t.status), last_run: t.last_run === null ? null : String(t.last_run),
    }))
    const v = requirementVerdict(id, mine, waivers)
    const w = v.waiver ? byId.get(v.waiver.id) : undefined
    const note = setAsideWords(v.set_aside)
    const failed = v.active.find((t) => t.status === 'fail' || t.status === 'error')
    let evidence: Evidence
    let why: string
    if (v.verdict === 'verified') { evidence = 'verified'; why = `${v.active.map((t) => t.id).join(', ')} passed${note ? `; ${note}` : ''}.` }
    else if (v.verdict === 'waived') { evidence = 'waived'; why = w ? `Waived (${w.severity}): ${w.reason}` : 'Every test of it is waived.' }
    else if (failed) { evidence = 'failing'; why = `${failed.id} ${failed.status === 'fail' ? 'failed' : 'errored'} on its last run.` }
    else { evidence = 'untested'; why = mine.length ? `${v.active.filter((t) => t.status !== 'pass').map((t) => t.id).join(', ')} not run yet.` : 'No test is planned for it yet.' }
    return {
      id, text: String(q.text), kind: String(q.kind), acceptance: q.acceptance === null ? null : String(q.acceptance), source: q.source === null ? null : String(q.source),
      status: String(q.status), ...(typeof q.method === 'string' ? { method: q.method } : {}), evidence, why, tests: mine, waiver: w?.id ?? null,
      ...(v.set_aside.length ? { set_aside: v.set_aside } : {}), ...(note ? { note } : {}),
    }
  })
}

// ------------------------------------------------------------------ check findings

export type FindingSeverity = 'blocks' | 'fix' | 'waived'

/** One finding of a rule check, where KiCad put it (millimetres on its sheet or board). */
export interface Finding {
  id: string
  severity: FindingSeverity
  text: string
  type: string
  /** ERC: the sheet path ('/', '/Power/'); DRC: violations | unconnected | parity */
  where: string
  ref: string | null
  x_mm: number | null
  y_mm: number | null
  run: string
  waiver: string | null
}

export interface CheckRun { id: string; kind: string; subject: string | null; status: string; summary: string | null; started: number; finished: number | null }

/** The newest run of `kind` (kicad.erc, kicad.drc, …), or null. */
export function latestRun(db: DatabaseSync, kind: string, subject?: string): CheckRun | null {
  const r = (subject
    ? db.prepare('SELECT id, kind, subject, status, summary, started, finished FROM runs WHERE kind=? AND subject=? ORDER BY started DESC LIMIT 1').get(kind, subject)
    : db.prepare('SELECT id, kind, subject, status, summary, started, finished FROM runs WHERE kind=? ORDER BY started DESC LIMIT 1').get(kind)) as Record<string, unknown> | undefined
  return r ? { id: String(r.id), kind: String(r.kind), subject: r.subject === null ? null : String(r.subject), status: String(r.status), summary: r.summary === null ? null : String(r.summary), started: Number(r.started), finished: r.finished === null ? null : Number(r.finished) } : null
}

/** A run's result (its JSON), or null. */
export function runResult(db: DatabaseSync, id: string): Record<string, unknown> | null {
  const r = db.prepare('SELECT result FROM runs WHERE id=?').get(id) as Record<string, unknown> | undefined
  const v = jsonOf(r?.result)
  return v && typeof v === 'object' ? v as Record<string, unknown> : null
}

/** A run artifact as text, or null. */
export function artifactText(db: DatabaseSync, run: string, name: string): string | null {
  const r = db.prepare('SELECT mime, bytes FROM artifacts WHERE run_id=? AND name=?').get(run, name) as Record<string, unknown> | undefined
  return r ? new TextDecoder().decode(unpackArtifact(r.mime === null ? null : String(r.mime), r.bytes as Uint8Array).bytes) : null
}

/** A finding's id: stable across runs while the same problem stays at the same place. */
const findingId = (check: 'erc' | 'drc', type: string, ref: string | null, x: number | null, y: number | null): string =>
  `${check}:${type}:${ref ?? (x !== null ? `${x},${y}` : 'board')}`

/**
 * The findings of the latest ERC (or DRC) run in the record, from its stored report: errors block, warnings are to
 * fix, KiCad's own exclusions and findings waived in the journey are waived. Null when no such run is recorded, or its
 * report cannot be read (`unreadable` says why).
 */
export function checkFindings(db: DatabaseSync, check: 'erc' | 'drc', r: JourneyRecord | null): { run: CheckRun; findings: Finding[]; report: Pick<CheckReport, 'errors' | 'warnings' | 'excluded'> } | { run: CheckRun | null; findings: null; unreadable: string } {
  const run = latestRun(db, `kicad.${check}`)
  if (!run) return { run: null, findings: null, unreadable: `No ${check === 'erc' ? 'electrical' : 'design'} rule check is recorded yet.` }
  const text = artifactText(db, run.id, `${check}-report.json`)
  if (!text) return { run, findings: null, unreadable: `The ${check.toUpperCase()} run ${run.id} kept no report.` }
  let rep: CheckReport
  try {
    rep = check === 'erc' ? parseErc(text) : parseDrc(text)
  } catch (e) {
    return { run, findings: null, unreadable: `The ${check.toUpperCase()} report of run ${run.id} could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }
  const waivers = new Map((r?.waivers ?? []).filter((w) => w.closedAt === null && w.targetKind === 'finding').map((w) => [w.target, w.id]))
  const seen = new Set<string>()
  const findings: Finding[] = []
  for (const v of rep.violations) {
    const item = v.items.find((i) => i.pos) ?? v.items[0]
    const ref = v.items.map((i) => i.ref).find((x): x is string => Boolean(x)) ?? null
    const x = item?.pos?.x_mm ?? null
    const y = item?.pos?.y_mm ?? null
    let id = findingId(check, v.type, ref, x, y)
    for (let n = 2; seen.has(id); n++) id = `${findingId(check, v.type, ref, x, y)}#${n}`
    seen.add(id)
    const waiver = waivers.get(id) ?? null
    findings.push({
      id, severity: v.severity === 'exclusion' || waiver ? 'waived' : v.severity === 'error' ? 'blocks' : 'fix',
      text: v.description || v.type, type: v.type, where: v.where, ref, x_mm: x, y_mm: y, run: run.id, waiver,
    })
  }
  return { run, findings, report: { errors: rep.errors, warnings: rep.warnings, excluded: rep.excluded } }
}

/**
 * Which schematic file an ERC sheet path belongs to: '/' is the root sheet (the file named like the project, else
 * the first); '/Power/' the file whose name is Power (case and separators ignored), else the root.
 */
export function sheetFileOf(where: string, files: readonly string[]): string | null {
  if (!files.length) return null
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const base = (p: string): string => norm((p.split('/').pop() ?? p).replace(/\.kicad_sch$/i, ''))
  const last = where.split('/').filter(Boolean).pop()
  if (last) {
    const hit = files.find((f) => base(f) === norm(last))
    if (hit) return hit
  }
  const dirs = new Map(files.map((f) => [f, f.split('/').slice(0, -1).join('/')]))
  const root = files.find((f) => { const d = (dirs.get(f) ?? '').split('/').pop() ?? ''; return base(f) === norm(d) }) ?? [...files].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0]
  return root ?? null
}

/** Images runs made (SVG or PNG artifacts), newest first, as evidence paths files.url opens: runs/<id>/<name>. */
export function runImages(db: DatabaseSync, kinds: readonly string[]): { path: string; run: string; kind: string; name: string; mime: string }[] {
  if (!kinds.length) return []
  // a stored picture's type carries where it is kept ("image/png; trace-stored=<sha>:<bytes>"): an exact 'image/png'
  // missed every render kept in the store, and the release review's board read "no drawing of it is recorded yet"
  // over three renders (test-esp32-run3 S21)
  const q = `SELECT a.run_id, a.name, a.mime, r.kind FROM artifacts a JOIN runs r ON r.id = a.run_id WHERE r.kind IN (${kinds.map(() => '?').join(',')}) AND (a.mime LIKE 'image/svg%' OR a.mime = 'image/png' OR a.mime LIKE 'image/png;%') ORDER BY r.started DESC, a.name LIMIT 200`
  return rows(db, q, ...kinds).map((x) => ({ path: `runs/${String(x.run_id)}/${String(x.name)}`, run: String(x.run_id), kind: String(x.kind), name: String(x.name), mime: artifactMime(String(x.mime)) ?? '' }))
}

/** The struck requirements (the repository's rejected or obsolete rows, and those a person struck), each with the
 * reason a person gave when they struck it (null: struck without one, by an agent or before reasons were kept). */
export function struckRequirements(db: DatabaseSync): { id: string; reason: string | null; by: string | null }[] {
  if (!hasTable(db, 'requirements')) return []
  const all = rows(db, 'SELECT * FROM requirements ORDER BY id')
  const decided = requirementDecisions(loadDesignDecisions(db), requirementsNow(all))
  return all.flatMap((q) => {
    const d = decided.get(String(q.id))
    const struck = d ? d.choice === 'struck' : q.status === 'rejected' || q.status === 'obsolete'
    return struck ? [{ id: String(q.id), reason: d?.choice === 'struck' ? d.reason : null, by: d?.by ?? null }] : []
  })
}

// ------------------------------------------------------------------ the design record

/** The agents' design rows (with the intent statements people stated themselves) and people's decisions about them. */
export function designOf(db: DatabaseSync): { rows: DesignRows; decisions: DesignDecision[] } {
  const decisions = loadDesignDecisions(db)
  return { rows: withStated(readDesignRows(db), decisions), decisions }
}

/** The newest schematic netlist in the record (kicad.netlist's or design.pins_check's nets.tsv), with its run. */
export function latestNetlist(db: DatabaseSync): { run: CheckRun; nets: Map<string, string[]> } | null {
  const r = db.prepare("SELECT a.run_id FROM artifacts a JOIN runs r ON r.id = a.run_id WHERE a.name = 'nets.tsv' AND r.kind IN ('kicad.netlist', 'design.pins_check') ORDER BY r.started DESC LIMIT 1").get() as { run_id?: string } | undefined
  if (!r?.run_id) return null
  const run = db.prepare('SELECT id, kind, subject, status, summary, started, finished FROM runs WHERE id=?').get(r.run_id) as Record<string, unknown>
  const text = artifactText(db, r.run_id, 'nets.tsv') ?? ''
  return {
    run: { id: String(run.id), kind: String(run.kind), subject: run.subject === null ? null : String(run.subject), status: String(run.status), summary: run.summary === null ? null : String(run.summary), started: Number(run.started), finished: run.finished === null ? null : Number(run.finished) },
    nets: parseNets(text),
  }
}

/**
 * The newest drawing of each thing kicad.export draws (the board, its render, each schematic sheet), across every
 * export that kept any (drawings.json), as artifact paths for files.url; the run is the newest of them. An export of
 * the sheets alone no longer hides the board an earlier export drew (the Release review's Fabrication step showed "No
 * board yet" over a signed layout).
 */
export function latestDrawings(db: DatabaseSync): { run: CheckRun; drawings: (Drawing & { path: string })[] } | null {
  const runs = db.prepare("SELECT a.run_id FROM artifacts a JOIN runs r ON r.id = a.run_id WHERE a.name = 'drawings.json' AND r.kind = 'kicad.export' ORDER BY r.started DESC LIMIT 20").all() as { run_id?: string }[]
  const newest = runs[0]?.run_id ? latestRunById(db, runs[0].run_id) : null
  if (!newest) return null
  const drawings: (Drawing & { path: string })[] = []
  const seen = new Set<string>()
  for (const { run_id: id } of runs) {
    if (!id) continue
    const v = jsonOf(artifactText(db, id, 'drawings.json')) as { drawings?: Drawing[] } | null
    for (const d of Array.isArray(v?.drawings) ? v.drawings : []) {
      if (typeof d.artifact !== 'string') continue
      const key = d.kind === 'sheet' ? `sheet:${d.file ?? d.artifact}:${d.sheet ?? ''}` : d.kind
      if (seen.has(key)) continue
      seen.add(key)
      drawings.push({ ...d, path: `runs/${id}/${d.artifact}` })
    }
  }
  return { run: newest, drawings }
}

function latestRunById(db: DatabaseSync, id: string): CheckRun | null {
  const r = db.prepare('SELECT id, kind, subject, status, summary, started, finished FROM runs WHERE id=?').get(id) as Record<string, unknown> | undefined
  return r ? { id: String(r.id), kind: String(r.kind), subject: r.subject === null ? null : String(r.subject), status: String(r.status), summary: r.summary === null ? null : String(r.summary), started: Number(r.started), finished: r.finished === null ? null : Number(r.finished) } : null
}

/** Where a finding in millimetres sits on a drawing of known size, as fractions (0..1); null when it cannot be placed. */
export function placeOn(f: { x_mm: number | null; y_mm: number | null }, d: { width_mm?: number | undefined; height_mm?: number | undefined; origin_mm?: { x_mm: number; y_mm: number } | undefined } | null | undefined): { x: number; y: number } | null {
  if (!d?.width_mm || !d.height_mm || f.x_mm === null || f.y_mm === null) return null
  const x = (f.x_mm - (d.origin_mm?.x_mm ?? 0)) / d.width_mm
  const y = (f.y_mm - (d.origin_mm?.y_mm ?? 0)) / d.height_mm
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 } : null
}

/**
 * Every line of every parts check that did not error (parts.bom_check's parts_list_lines), with its run's start and the
 * boards it was checked for: the key parts' stock and price (src/tools/design/key-parts.ts). Empty when none is.
 */
export function stockLines(db: DatabaseSync): StockLine[] {
  if (!hasTable(db, 'parts_list_lines') || !hasTable(db, 'runs')) return []
  const rows = db.prepare(`SELECT l.*, r.started AS started,
      (SELECT m.value FROM measurements m WHERE m.run_id = l.run_id AND m.name = 'boards') AS boards
    FROM parts_list_lines l JOIN runs r ON r.id = l.run_id
    WHERE r.kind = 'parts.bom_check' AND r.status != 'error'`).all() as Record<string, unknown>[]
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
  const txt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
  return rows.map((r) => {
    let flags: string[] = []
    try { const f: unknown = JSON.parse(String(r.flags ?? '[]')); if (Array.isArray(f)) flags = f.filter((x): x is string => typeof x === 'string') } catch { /* unreadable flags: none */ }
    return {
      run: String(r.run_id), started: Number(r.started), boards: num(r.boards), mpn: txt(r.mpn), part_key: txt(r.part_key), order_code: txt(r.order_code),
      need: Number(r.need), status: String(r.status), flags, stock: num(r.stock), unit_price: num(r.unit_price), currency: txt(r.currency), note: txt(r.note),
    }
  })
}

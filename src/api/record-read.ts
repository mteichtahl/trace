/**
 * Reading what the record holds about the design, for the screens (requirements.trace, design.get, files.list,
 * skill.get): each requirement's evidence status, and the findings of the latest electrical and design rule checks.
 * Pure functions over an open record database (src/api/action-kit.ts withRecordDb: the repository's project database
 * with the live journey tables), so they are tested on their own.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { JourneyRecord } from '../core/journey.js'
import { type CheckReport, parseDrc, parseErc } from '../tools/kicad/checks.js'

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
  evidence: Evidence
  /** why, in words: "TST-001 failed on its last run", "waived: W-… (degraded)" */
  why: string
  tests: { id: string; title: string; method: string; status: string; last_run: string | null }[]
  waiver: string | null
}

/**
 * Every live requirement (not rejected or obsolete) with its evidence status:
 *   waived     an open waiver on the requirement in the journey, or every one of its tests is waived
 *   failing    a test of it failed or errored on its last run
 *   verified   it has tests, and every one not waived passed
 *   untested   no test yet, or a test has not run (planned, blocked)
 */
export function requirementEvidence(db: DatabaseSync, r: JourneyRecord | null): TraceRequirement[] {
  if (!hasTable(db, 'requirements')) return []
  const tests = hasTable(db, 'test_items') ? rows(db, 'SELECT id, title, requirements, method, status, last_run FROM test_items ORDER BY id') : []
  const waived = new Map((r?.waivers ?? []).filter((w) => w.closedAt === null && w.targetKind === 'requirement').map((w) => [w.target, w]))
  return rows(db, "SELECT id, text, kind, acceptance, source, status FROM requirements WHERE status NOT IN ('rejected', 'obsolete') ORDER BY id").map((q) => {
    const id = String(q.id)
    const mine = tests.filter((t) => list(t.requirements).includes(id)).map((t) => ({
      id: String(t.id), title: String(t.title), method: String(t.method), status: String(t.status), last_run: t.last_run === null ? null : String(t.last_run),
    }))
    const w = waived.get(id)
    const active = mine.filter((t) => t.status !== 'waived')
    const failed = active.find((t) => t.status === 'fail' || t.status === 'error')
    let evidence: Evidence
    let why: string
    if (w) { evidence = 'waived'; why = `Waived (${w.severity}): ${w.reason}` }
    else if (mine.length && !active.length) { evidence = 'waived'; why = 'Every test of it is waived.' }
    else if (failed) { evidence = 'failing'; why = `${failed.id} ${failed.status === 'fail' ? 'failed' : 'errored'} on its last run.` }
    else if (active.length && active.every((t) => t.status === 'pass')) { evidence = 'verified'; why = `${active.map((t) => t.id).join(', ')} passed.` }
    else { evidence = 'untested'; why = mine.length ? `${active.filter((t) => t.status !== 'pass').map((t) => t.id).join(', ')} not run yet.` : 'No test is planned for it yet.' }
    return {
      id, text: String(q.text), kind: String(q.kind), acceptance: q.acceptance === null ? null : String(q.acceptance), source: q.source === null ? null : String(q.source),
      status: String(q.status), evidence, why, tests: mine, waiver: w?.id ?? null,
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

function artifactText(db: DatabaseSync, run: string, name: string): string | null {
  const r = db.prepare('SELECT bytes FROM artifacts WHERE run_id=? AND name=?').get(run, name) as Record<string, unknown> | undefined
  return r ? new TextDecoder().decode(r.bytes as Uint8Array) : null
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
  const q = `SELECT a.run_id, a.name, a.mime, r.kind FROM artifacts a JOIN runs r ON r.id = a.run_id WHERE r.kind IN (${kinds.map(() => '?').join(',')}) AND (a.mime LIKE 'image/svg%' OR a.mime = 'image/png') ORDER BY r.started DESC, a.name LIMIT 200`
  return rows(db, q, ...kinds).map((x) => ({ path: `runs/${String(x.run_id)}/${String(x.name)}`, run: String(x.run_id), kind: String(x.kind), name: String(x.name), mime: String(x.mime) }))
}

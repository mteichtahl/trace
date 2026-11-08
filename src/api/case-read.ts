/**
 * The case as the Design tab's Case view draws it (plan P7.7; design.get `case`): the newest case build, each problem
 * it found outlined by its part on the board, the process's failing rules, and, when what the build was made from
 * changed on the default branch since, why, in plain words (src/tools/mech/stale.ts, as mech.fit and the Case design
 * skill say it).
 *
 *   caseStaleness(ctx, repo, inputs)  why the newest build no longer stands for the default branch; [] when it does,
 *                                     null when the files cannot be read (not compared)
 *   caseView(db, rec, o)              the build and its problems: each named as the layout.fit shape names it, so a
 *                                     waiver of one problem in the journey shows it waived here
 */
import type { DatabaseSync } from 'node:sqlite'
import type { JourneyRecord } from '../core/journey.js'
import { nodeIri } from '../ontology/graph.js'
import { artifactJson, findingKey, latestCaseBuild } from '../ontology/mech.js'
import { CAPABILITIES, capabilitiesStamp } from '../tools/mech/capabilities.js'
import { type BuildInputs, filesNow, staleReasons } from '../tools/mech/stale.js'
import type { Context } from './action-kit.js'

/** Why the newest case build no longer stands for the default branch; null when the files cannot be read. */
export async function caseStaleness(ctx: Context, repo: string, was: unknown): Promise<string[] | null> {
  if (!was || typeof was !== 'object') return ['the build recorded no inputs']
  try {
    const gh = await ctx.deps.github()
    const { branch } = await gh.defaultBranch(repo)
    const now = await filesNow(was as Partial<BuildInputs>, (p) => gh.rawFile(repo, p, branch), { checked: CAPABILITIES.checked, sha256: capabilitiesStamp() })
    return staleReasons(was as Partial<BuildInputs>, now)
  } catch {
    return null
  }
}

interface Fit {
  status?: string; summary?: string
  clashes?: { ref: string; case_part: string; volume_mm3: number }[]
  gaps?: { ref: string; where: string; measured_mm: number | null; required_mm: number; ok: boolean }[]
  openings?: { ref: string; side: string; made: boolean }[]
}
interface Part { ref: string; x: number; y: number }
interface Rule { rule: string; ok: boolean | null; detail: string }

const WHERE: Readonly<Record<string, string>> = { edge: 'to the wall', above: 'to the lid', below: 'to the floor', around: 'in its opening' }
const fmt = (n: number): string => String(Math.round(n * 100) / 100)

export interface CaseFinding {
  /** the finding's id, as a waiver of kind finding names it: layout.fit@<the problem's record> */
  id: string
  severity: 'blocks' | 'waived'
  kind: 'clash' | 'gap' | 'opening' | 'rule'
  text: string
  where?: string
  x_mm?: number
  y_mm?: number
  source: { kind: 'run'; id: string; label: string }
}

export interface CaseView {
  run: string
  at: string
  status: 'pass' | 'fail'
  summary: string
  board: string | null
  process: string | null
  size: string | null
  findings: CaseFinding[]
  /** why the build no longer stands, in plain words; null: trace could not compare it with the default branch */
  stale?: string[] | null
  /** what the build was made from, for caseStaleness */
  inputs: unknown
}

/** The newest case build and its problems, or null when the project has none. */
export function caseView(db: DatabaseSync, rec: JourneyRecord | null, o: { installation: string; project: string }): CaseView | null {
  const b = latestCaseBuild(db)
  if (!b) return null
  const row = db.prepare('SELECT result FROM runs WHERE id=?').get(b.run) as { result: string | null } | undefined
  let result: Record<string, unknown> = {}
  try { result = JSON.parse(row?.result ?? '{}') as Record<string, unknown> } catch { /* an unreadable result: the artifacts still say what was built */ }
  const fit = (artifactJson(db, b.run, 'fit.json') ?? {}) as Fit
  const facts = (artifactJson(db, b.run, 'facts.json') ?? {}) as { board?: string; parts?: Part[] }
  const settings = artifactJson(db, b.run, 'case.json') as { openings?: { skip?: string[] } } | null
  const engine = (artifactJson(db, b.run, 'result.json') ?? {}) as { rules?: Rule[]; case?: { bbox_mm?: number[] } }
  const waived = new Set((rec?.waivers ?? []).filter((w) => w.closedAt === null && w.targetKind === 'finding').map((w) => w.target))
  const at = new Map((facts.parts ?? []).map((p) => [p.ref, p]))
  const source = { kind: 'run' as const, id: b.run, label: `case build ${b.run.slice(0, 8)}` }
  const finding = (kind: CaseFinding['kind'], key: string, ref: string | null, text: string): CaseFinding => {
    const id = `layout.fit@${nodeIri(o, kind === 'rule' ? 'case-rule' : 'case-finding', key)}`
    const p = ref ? at.get(ref) : undefined
    return { id, severity: waived.has(id) ? 'waived' : 'blocks', kind, text, ...(ref ? { where: ref } : {}), ...(p ? { x_mm: p.x, y_mm: p.y } : {}), source }
  }
  const skipped = new Set(settings?.openings?.skip ?? [])
  const findings: CaseFinding[] = [
    ...(fit.clashes ?? []).map((c) => finding('clash', findingKey({ kind: 'clash', ref: c.ref, at: c.case_part }), c.ref === 'board' ? null : c.ref, `${c.ref === 'board' ? 'The board' : c.ref} clashes with the ${c.case_part} (${fmt(c.volume_mm3)} mm³)`)),
    ...(fit.gaps ?? []).filter((g) => !g.ok).map((g) => finding('gap', findingKey({ kind: 'gap', ref: g.ref, at: g.where }), g.ref === 'board' ? null : g.ref,
      `${g.ref === 'board' ? 'The board' : g.ref} ${WHERE[g.where] ?? g.where}: ${g.measured_mm === null ? 'not measured' : `${fmt(g.measured_mm)} mm`}, needs ${fmt(g.required_mm)} mm`)),
    ...(fit.openings ?? []).filter((x) => !x.made && !skipped.has(x.ref)).map((x) => finding('opening', findingKey({ kind: 'opening', ref: x.ref }), x.ref, `No opening is cut for ${x.ref} on the ${x.side} side`)),
    ...(engine.rules ?? []).filter((r) => r.ok === false).map((r) => finding('rule', r.rule, null, `Outside the process's rules: ${r.detail || r.rule}`)),
  ]
  const p = result.process as { service?: string; process?: string; material?: string } | undefined
  const box = engine.case?.bbox_mm
  return {
    run: b.run, at: new Date(b.started * 1000).toISOString(), status: b.status === 'pass' ? 'pass' : 'fail',
    summary: typeof result.fit_summary === 'string' ? result.fit_summary : fit.summary ?? '',
    board: facts.board ?? null,
    process: p ? `${p.process ?? '?'} ${p.material ?? '?'} at ${p.service ?? '?'}` : null,
    size: Array.isArray(box) && box.length === 3 ? `${box.map(fmt).join(' × ')} mm` : null,
    findings, inputs: result.inputs ?? null,
  }
}

/** A finding's record without the installation and project that name it: ":case-finding:gap%3AC6%3Aabove". */
const recordTail = (id: string): string => { const i = id.search(/:case-(?:finding|rule):/); return i < 0 ? id : id.slice(i) }

/** A problem's key as the build and case.json's `waived` name it: "gap/C6/above", or a rule's name. */
export const caseProblemKey = (id: string): string => decodeURIComponent(recordTail(id).replace(/^:case-(?:finding|rule):/, ''))

/**
 * The newest build's problems that are not waived, for `tracectl check` (test-esp32-run2 R54: a pull request's
 * required check failed on a C6 gap a person had been asked to waive, so the change could not pass while the waiver
 * was the agreed answer). Waived is an open journey waiver on the problem, matched by its record (the check names the
 * project by its repository, the app by its installation), or the problem's key listed in case.json's `waived`
 * (`listed`): in CI the check cannot read the journey, which lives in the installation's store. The layout gate
 * counts only the journey's waivers. null when the project has no case build.
 */
export function unwaivedCaseFindings(db: DatabaseSync, rec: JourneyRecord | null, listed: Iterable<string> = []): { all: number; open: CaseFinding[] } | null {
  const v = caseView(db, null, { installation: 'check', project: 'check' })
  if (!v) return null
  const waived = new Set((rec?.waivers ?? []).filter((w) => w.closedAt === null && w.targetKind === 'finding' && w.target.startsWith('layout.fit@')).map((w) => caseProblemKey(w.target)))
  for (const k of listed) waived.add(k)
  return { all: v.findings.length, open: v.findings.filter((f) => !waived.has(caseProblemKey(f.id))) }
}

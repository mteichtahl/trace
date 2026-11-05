/**
 * Whether the evidence trace's criteria are met on stands in the accepted design: the default branch's record
 * (docs/ontology-plan.md P4.3). journey.get shows a criterion that fails any of these as not met, with why, and
 * journey.sign will not count it (src/core/journey.ts withStaleEvidence).
 *
 *   out of date     the lineage of each run cited (src/ontology/lineage.ts) against the default branch's files now
 *   not accepted    a run cited is not in the default branch's record: an agent checked the criterion on its branch,
 *                   and the change holding that run is not accepted (test-esp32 #43, #57). It counts once accepted
 *   rule checks     the electrical and design rule checks (capture.erc, layout.drc) read again from the newest report
 *                   in the accepted record: every finding the report classes as to fix or waive counts, warnings as
 *                   well as errors (#51), and the evidence names the run and its counts, whatever the agent wrote
 *
 *   evidenceStaleness(ctx, repo, r)   all of it (AcceptedRecord), or undefined when nothing can be told: no run is
 *                                     cited and no rule check applies, or the record cannot be read. Never a guess:
 *                                     a file that cannot be fetched is not "changed"
 */
import type { DatabaseSync } from 'node:sqlite'
import type { AcceptedRecord, Evidence, JourneyRecord } from '../core/journey.js'
import { filesRead, staleRuns } from '../ontology/lineage.js'
import { type Context, openProjectDb, withProjectDb } from './action-kit.js'
import { checkFindings } from './record-read.js'

/** The runs cited as evidence by the met criteria trace owns. */
export const evidenceRuns = (r: JourneyRecord): string[] =>
  [...new Set(r.criteria.filter((c) => c.owner === 'trace' && c.status === 'met').flatMap((c) => c.evidence.filter((e) => e.kind === 'run').map((e) => e.ref)))]

/** The criteria a rule check's report backs: "clean, or each finding is waived". */
export const RULE_CHECKS: Readonly<Record<string, 'erc' | 'drc'>> = { 'capture.erc': 'erc', 'layout.drc': 'drc' }
const CHECK_WORDS = { erc: 'electrical rule check', drc: 'design rule check' } as const
/** The open findings listed with a criterion at most (its run lists them all). */
export const FINDINGS_LISTED = 50

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const cap = (s: string): string => `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`

/** The runs of `ids` the record holds. */
function runsIn(db: DatabaseSync, ids: readonly string[]): Set<string> {
  const has = db.prepare('SELECT 1 FROM runs WHERE id=?')
  return new Set(ids.filter((id) => has.get(id)))
}

/**
 * A rule check read again from the record (`db`, the default branch's): the newest run's report, its errors and
 * warnings both; each finding not waived (by KiCad's own exclusion, or a waiver of that one finding) is open. Null
 * when the run's report cannot be read: that is no reason to doubt the criterion, so it is left as it is.
 */
export function ruleCheck(db: DatabaseSync, check: 'erc' | 'drc', r: JourneyRecord | null): { why: string | null; evidence: Evidence[]; findings: Evidence[] } | null {
  const words = CHECK_WORDS[check]
  const f = checkFindings(db, check, r)
  if (!f.findings) return f.run ? null : { why: `No ${words} is in the accepted design yet: run it, and accept the change that holds it.`, evidence: [], findings: [] }
  const open = f.findings.filter((x) => x.severity !== 'waived')
  const waived = f.findings.length - open.length
  const types = new Map<string, number>()
  for (const x of open) types.set(x.type, (types.get(x.type) ?? 0) + 1)
  const byType = [...types].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t, n]) => `${n} ${t}`).join(', ')
  const run = f.run.id.slice(0, 8)
  const label = `${cap(words)}, run ${run}: ${plural(f.report.errors, 'error')}, ${plural(f.report.warnings, 'warning')}, ${f.report.excluded} excluded in KiCad; ${open.length} to fix or waive${open.length ? ` (${byType})` : ''}, ${waived} waived`
  const evidence: Evidence[] = [{ kind: 'run', ref: f.run.id, label: label.slice(0, 300) }]
  if (!open.length) return { why: null, evidence, findings: [] }
  const errors = open.filter((x) => x.severity === 'blocks').length
  const warnings = open.length - errors
  return {
    why: `The ${words} (run ${run}) has ${plural(open.length, 'finding')} to fix or waive (${byType}): ${plural(errors, 'error')} and ${plural(warnings, 'warning')}, and warnings count too. Fix them and run it again, or waive each one.`,
    evidence,
    findings: open.slice(0, FINDINGS_LISTED).map((x) => ({ kind: 'finding', ref: x.id, label: `${x.text}${x.ref && !x.text.includes(x.ref) ? ` (${x.ref})` : ''}`.slice(0, 300) })),
  }
}

/** The files `acceptedRecord` reads for `r`: those the cited runs the record holds were made from. */
export function filesFor(db: DatabaseSync, r: JourneyRecord): string[] {
  const runs = evidenceRuns(r)
  const held = runsIn(db, runs)
  return filesRead(db, runs.filter((id) => held.has(id)))
}

/**
 * What the accepted record says of `r`'s criteria (`db`: the default branch's record; `files`: its files, for the
 * lineage of the runs it holds). No network, so the rule is tested on its own.
 */
export function acceptedRecord(db: DatabaseSync, r: JourneyRecord, files: ReadonlyMap<string, Uint8Array | null>): AcceptedRecord {
  const runs = evidenceRuns(r)
  const held = runsIn(db, runs)
  const stale = staleRuns(db, runs.filter((id) => held.has(id)), files)
  const criteria = new Map<string, { why: string | null; evidence: Evidence[]; findings: Evidence[] }>()
  for (const c of r.criteria) {
    const check = RULE_CHECKS[c.id]
    // a met one only: one not met already says so, and its run lists the findings
    if (!check || c.owner !== 'trace' || c.status !== 'met') continue
    const again = ruleCheck(db, check, r)
    if (again) criteria.set(c.id, again)
  }
  return { staleRun: (id) => stale.get(id) ?? null, unaccepted: (id) => !held.has(id), criteria }
}

export async function evidenceStaleness(ctx: Context, repo: string, r: JourneyRecord | null): Promise<AcceptedRecord | undefined> {
  if (!r) return undefined
  // the record is read only when it could take a met criterion back (GitHub's allowance: journey.get is looked at often)
  if (!evidenceRuns(r).length && !r.criteria.some((c) => c.owner === 'trace' && c.status === 'met' && RULE_CHECKS[c.id])) return undefined
  try {
    const gh = await ctx.deps.github()
    const { branch } = await gh.defaultBranch(repo)
    // one read of the run record (the default branch's), and each file it names from the same branch
    return await withProjectDb(ctx, repo, async (path) => {
      const db = openProjectDb(path)
      try {
        const paths = filesFor(db, r)
        const files = new Map(await Promise.all(paths.map(async (p) => [p, await gh.rawFile(repo, p, branch)] as const)))
        return acceptedRecord(db, r, files)
      } finally {
        db.close()
      }
    })
  } catch {
    return undefined
  }
}

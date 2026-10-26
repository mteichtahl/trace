/**
 * Coverage of requirements by tests, and of the design by simulation, from the verification record.
 *
 * A requirement's verdict comes from the test items linked to it (their status, set by verify.run) and the coverage
 * points tied to it:
 *   verified       at least one test, every test not waived passed, every coverage point met its goal
 *   coverage_gap   every test passed, but a coverage point is below its goal
 *   failing        a test failed or errored
 *   partial        some tests passed, others are planned or blocked
 *   untested       tests exist but none has run (or all are blocked)
 *   no_test        no test item links to it
 *   waived         every test linked to it is waived
 * Rejected and obsolete requirements are counted, not listed.
 *
 * The evidence is each test item's latest result: its run ids. Functional coverage is the sum of the hits those
 * runs recorded (coverage_hits), matched to coverage points by name or /regex/. Line, toggle and branch coverage are
 * the evidence runs' coverage.dat artifacts (verify.verilator) merged point by point.
 */
import { Work } from '../../core/store.js'
import { matcher, type CoveragePoint, type Requirement, type TestItem, type VerifyDb } from './db.js'
import { mergeCoverage, parseCoverageDat, summarizeCoverage, type CovPoint } from './parse.js'

export type Verdict = 'verified' | 'coverage_gap' | 'failing' | 'partial' | 'untested' | 'no_test' | 'waived'

export interface PointState extends Pick<CoveragePoint, 'id' | 'kind' | 'match' | 'goal' | 'requirements'> {
  hits: number
  met: boolean
  matched: string[]
}

export interface ReqRow {
  id: string
  kind: Requirement['kind']
  text: string
  acceptance: string | null
  status: Requirement['status']
  verdict: Verdict
  tests: { id: string; method: TestItem['method']; status: TestItem['status']; last_run: string | null }[]
  points: { id: string; hits: number; goal: number; met: boolean }[]
}

export interface Matrix {
  summary: Record<Verdict, number> & { requirements: number; set_aside: number; tests: number; tests_by_status: Record<string, number> }
  requirements: ReqRow[]
  orphan_tests: string[]
  points: PointState[]
  unplanned_hits: { name: string; kind: string; hits: number }[]
  evidence_runs: string[]
  code: ReturnType<typeof summarizeCoverage> | null
  code_runs: string[]
}

export function evidenceRuns(v: VerifyDb, tests: readonly TestItem[]): string[] {
  const out = new Set<string>()
  for (const t of tests) for (const r of v.latestResult(t.id)?.evidence ?? []) out.add(r)
  return [...out]
}

/** Merged coverage.dat of the given runs (those that have one). */
export function codeCoverage(runIds: readonly string[]): { points: CovPoint[]; runs: string[] } {
  const w = new Work()
  try {
    const sets: CovPoint[][] = []
    const used: string[] = []
    for (const id of runIds) {
      const b = w.getArtifact(id, 'coverage.dat')
      if (!b) continue
      sets.push(parseCoverageDat(new TextDecoder().decode(b)).filter((p) => p.kind !== 'user'))
      used.push(id)
    }
    return { points: mergeCoverage(sets), runs: used }
  } finally {
    w.close()
  }
}

export function buildMatrix(v: VerifyDb, opts: { runs?: string[] | undefined; code?: boolean; exclude?: string | undefined; uncoveredLimit?: number } = {}): Matrix {
  const reqs = v.requirements()
  const live = reqs.filter((r) => r.status !== 'rejected' && r.status !== 'obsolete')
  const tests = v.tests()
  const evidence = opts.runs ?? evidenceRuns(v, tests)
  const hits = v.hits(evidence)
  const pts = v.points()
  const used = new Set<string>()
  const points: PointState[] = pts.map((p) => {
    const m = matcher(p.match)
    const mine = hits.filter((h) => h.kind === p.kind && m(h.name))
    for (const h of mine) used.add(`${h.kind}|${h.name}`)
    const total = mine.reduce((s, h) => s + h.hits, 0)
    return { id: p.id, kind: p.kind, match: p.match, goal: p.goal, requirements: p.requirements, hits: total, met: total >= p.goal, matched: [...new Set(mine.map((h) => h.name))].slice(0, 20) }
  })
  const unplanned = new Map<string, { name: string; kind: string; hits: number }>()
  for (const h of hits) {
    const k = `${h.kind}|${h.name}`
    if (used.has(k)) continue
    const e = unplanned.get(k) ?? unplanned.set(k, { name: h.name, kind: h.kind, hits: 0 }).get(k) as { name: string; kind: string; hits: number }
    e.hits += h.hits
  }
  const rows: ReqRow[] = live.map((r) => {
    const ts = tests.filter((t) => t.requirements.includes(r.id))
    const ps = points.filter((p) => p.requirements.includes(r.id))
    const active = ts.filter((t) => t.status !== 'waived')
    let verdict: Verdict
    if (!ts.length) verdict = 'no_test'
    else if (!active.length) verdict = 'waived'
    else if (active.some((t) => t.status === 'fail' || t.status === 'error')) verdict = 'failing'
    else if (active.every((t) => t.status === 'pass')) verdict = ps.every((p) => p.met) ? 'verified' : 'coverage_gap'
    else if (active.some((t) => t.status === 'pass')) verdict = 'partial'
    else verdict = 'untested'
    return {
      id: r.id, kind: r.kind, text: r.text, acceptance: r.acceptance, status: r.status, verdict,
      tests: ts.map((t) => ({ id: t.id, method: t.method, status: t.status, last_run: t.last_run })),
      points: ps.map((p) => ({ id: p.id, hits: p.hits, goal: p.goal, met: p.met })),
    }
  })
  const verdicts: Verdict[] = ['verified', 'coverage_gap', 'failing', 'partial', 'untested', 'no_test', 'waived']
  const byStatus: Record<string, number> = {}
  for (const t of tests) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
  const reqIds = new Set(live.map((r) => r.id))
  let code: Matrix['code'] = null
  let codeRuns: string[] = []
  if (opts.code !== false) {
    const cc = codeCoverage(evidence)
    codeRuns = cc.runs
    if (cc.points.length) {
      const s = summarizeCoverage(cc.points, opts.exclude ? { exclude: new RegExp(opts.exclude) } : {})
      code = { ...s, uncovered: s.uncovered.slice(0, opts.uncoveredLimit ?? 50) }
    }
  }
  return {
    summary: {
      requirements: live.length, set_aside: reqs.length - live.length, tests: tests.length, tests_by_status: byStatus,
      ...Object.fromEntries(verdicts.map((x) => [x, rows.filter((r) => r.verdict === x).length])) as Record<Verdict, number>,
    },
    requirements: rows,
    orphan_tests: tests.filter((t) => !t.requirements.some((r) => reqIds.has(r))).map((t) => t.id),
    points,
    unplanned_hits: [...unplanned.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100),
    evidence_runs: evidence,
    code,
    code_runs: codeRuns,
  }
}

const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The verification status as Markdown: summary, requirements with verdicts, tests, coverage, open items. */
export function reportMarkdown(m: Matrix, tests: readonly TestItem[], meta: { title: string; generated: string; git?: string | null }): string {
  const s = m.summary
  const out: string[] = [
    `# ${meta.title}`, '',
    `Generated ${meta.generated}${meta.git ? ` at ${meta.git}` : ''} from the project database (verify.report).`, '',
    '## Summary', '',
    `- Requirements: ${s.requirements} (${s.set_aside} rejected or obsolete not counted)`,
    `- Verified ${s.verified}, failing ${s.failing}, coverage gap ${s.coverage_gap}, partial ${s.partial}, untested ${s.untested}, no test ${s.no_test}, waived ${s.waived}`,
    `- Test items: ${s.tests} (${Object.entries(s.tests_by_status).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`,
  ]
  if (m.code) out.push(`- Code coverage (${m.code_runs.length} run${m.code_runs.length === 1 ? '' : 's'} merged): ${m.code.by_kind.map((k) => `${k.kind} ${k.covered}/${k.total} (${k.percent ?? '—'} %)`).join(', ')}`)
  if (m.points.length) out.push(`- Coverage points: ${m.points.filter((p) => p.met).length} of ${m.points.length} met`)
  out.push('', '## Requirements', '', '| Requirement | Kind | Verdict | Tests | Coverage | Text |', '|---|---|---|---|---|---|')
  for (const r of m.requirements) {
    out.push(`| ${r.id} | ${r.kind} | ${r.verdict} | ${r.tests.map((t) => `${t.id} ${t.status}`).join(', ') || '—'} | ${r.points.map((p) => `${p.id} ${p.hits}/${p.goal}`).join(', ') || '—'} | ${esc(clip(r.text, 140))} |`)
  }
  out.push('', '## Tests', '', '| Test | Method | Status | Requirements | Last run | How |', '|---|---|---|---|---|---|')
  for (const t of tests) {
    const how = t.tool ? `${t.tool}` : t.command ? `\`${clip(t.command.join(' '), 60)}\`` : 'inspection'
    out.push(`| ${t.id} | ${t.method} | ${t.status} | ${t.requirements.join(', ')} | ${t.last_run ?? '—'} | ${esc(how)} |`)
  }
  if (m.points.length) {
    out.push('', '## Coverage points', '', '| Point | Kind | Match | Hits | Goal | Met |', '|---|---|---|---|---|---|')
    for (const p of m.points) out.push(`| ${p.id} | ${p.kind} | \`${esc(p.match)}\` | ${p.hits} | ${p.goal} | ${p.met ? 'yes' : 'no'} |`)
  }
  if (m.code) {
    out.push('', '## Code coverage by file', '', '| File | ' + ['line', 'toggle', 'branch'].join(' | ') + ' |', '|---|---|---|---|')
    for (const f of m.code.by_file) {
      const cell = (k: string): string => {
        const e = f.by_kind.find((x) => x.kind === k)
        return e ? `${e.covered}/${e.total} (${e.percent ?? '—'} %)` : '—'
      }
      out.push(`| ${f.file.split('/').pop()} | ${cell('line')} | ${cell('toggle')} | ${cell('branch')} |`)
    }
  }
  const open = m.requirements.filter((r) => r.verdict !== 'verified' && r.verdict !== 'waived')
  out.push('', '## Open items', '')
  if (!open.length && !m.orphan_tests.length) out.push('None.')
  for (const r of open) out.push(`- ${r.id} (${r.verdict}): ${esc(clip(r.text, 160))}`)
  if (m.orphan_tests.length) out.push(`- Tests linked to no live requirement: ${m.orphan_tests.join(', ')}`)
  out.push('')
  return out.join('\n')
}

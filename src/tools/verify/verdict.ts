/**
 * One requirement's verdict from its tests, the one rule shared by the verification report (matrix.ts: verify.coverage
 * and verify.report) and the record's trace (src/api/record-read.ts requirementEvidence, requirements.trace), so a
 * screen never says "Verified" where the other says "Waived" (test-esp32 log #209). Pure.
 *
 * A test is set aside when its status is waived, or a person's open waiver names it (the journey's waivers, target
 * kind test). The verdict reads the tests not set aside:
 *   verified       at least one, every one passed, every coverage point met its goal
 *   coverage_gap   every one passed, but a coverage point is below its goal
 *   failing        one failed or errored
 *   partial        some passed, others are planned or blocked
 *   untested       none has run (or all are blocked)
 *   no_test        no test item links to it
 *   waived         every test linked to it is set aside
 * An open waiver on the requirement itself makes any verdict but verified waived. A verified requirement keeps its
 * verdict, and what was set aside is said beside it (`set_aside`, `setAsideWords`): "Verified · TST-031 waived to
 * Fabricate", never a bare "Verified" that hides the waiver.
 */

export type Verdict = 'verified' | 'coverage_gap' | 'failing' | 'partial' | 'untested' | 'no_test' | 'waived'

/** A waiver as the verdict reads it (the journey's WaiverRow has these fields). */
export interface WaiverRef { id: string; targetKind: string; target: string; caughtWhere: string | null; closedAt: number | null }

/** One thing set aside on a verified requirement: a test (and the waiver that set it aside), or the requirement's own waiver. */
export interface SetAside { test: string | null; waiver: string | null; to: string | null }

export interface RequirementVerdict<T> {
  verdict: Verdict
  /** the tests the verdict reads (not set aside) */
  active: T[]
  /** what was set aside; said beside the verdict when it is verified */
  set_aside: SetAside[]
  /** the open waiver on the requirement itself */
  waiver: WaiverRef | null
}

export function requirementVerdict<T extends { id: string; status: string }>(
  id: string, tests: readonly T[], waivers: readonly WaiverRef[] = [], points: readonly { met: boolean }[] = [],
): RequirementVerdict<T> {
  const open = waivers.filter((w) => w.closedAt === null)
  const own = open.find((w) => w.targetKind === 'requirement' && w.target === id) ?? null
  const onTest = (t: T): WaiverRef | undefined => open.find((w) => w.targetKind === 'test' && w.target === t.id)
  const aside = tests.filter((t) => t.status === 'waived' || onTest(t))
  const active = tests.filter((t) => !aside.includes(t))
  let verdict: Verdict
  if (!tests.length) verdict = 'no_test'
  else if (!active.length) verdict = 'waived'
  else if (active.some((t) => t.status === 'fail' || t.status === 'error')) verdict = 'failing'
  else if (active.every((t) => t.status === 'pass')) verdict = points.every((p) => p.met) ? 'verified' : 'coverage_gap'
  else if (active.some((t) => t.status === 'pass')) verdict = 'partial'
  else verdict = 'untested'
  if (own && verdict !== 'verified') verdict = 'waived'
  const setAside: SetAside[] = aside.map((t) => { const w = onTest(t) ?? own; return { test: t.id, waiver: w?.id ?? null, to: w?.caughtWhere ?? null } })
  if (own && !aside.some((t) => !onTest(t))) setAside.push({ test: null, waiver: own.id, to: own.caughtWhere })
  return { verdict, active, set_aside: setAside, waiver: own }
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
/** "to Fabricate" for a stage or a short place; "(checked instead: …)" for longer words. */
const where = (to: string | null): string => {
  if (!to?.trim()) return ''
  const t = to.trim()
  return t.split(/\s+/).length <= 3 ? ` to ${clip(t, 40)}` : ` (checked instead: ${clip(t, 60)})`
}

/** What was set aside, in a few words ("TST-031 waived to Fabricate", "waiver W-1 recorded"); null when nothing was. */
export function setAsideWords(list: readonly SetAside[]): string | null {
  if (!list.length) return null
  const byTo = new Map<string, string[]>()
  const own: SetAside[] = []
  for (const s of list) {
    if (s.test === null) { own.push(s); continue }
    const k = s.to?.trim() ?? ''
    byTo.set(k, [...(byTo.get(k) ?? []), s.test])
  }
  const parts = [...byTo].map(([to, ids]) => `${ids.join(', ')} waived${where(to || null)}`)
  for (const s of own) parts.push(s.to?.trim() ? `waived${where(s.to)}` : `waiver ${s.waiver ?? ''} recorded`.replace('  ', ' '))
  return parts.join('; ')
}

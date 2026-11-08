/**
 * The Release review's steps, from the record (docs/user-journey.md, "Release review"): what each of its five areas
 * shows and what its Decide step offers. trace reads the release report in a fixed order, so each step has its own
 * content: the EMC prechecks and estimates with the waivers on them, the parts list's cost, stock, sellers and
 * lifecycle, the DRC result and what the fab places, and what changed since the last revision. Where the record holds
 * nothing for a step, the step says so plainly. Pure: the record is read in actions-skills.ts.
 *
 * The person acknowledges each area on its own step (the draft's `acknowledged`, step ids), which is what "each of the
 * five areas acknowledged" checks, and each single-source or not-active part (the draft's `parts_ack`, line keys).
 */
import type { CriterionRow, DecisionRow, JourneyRecord, WaiverRow } from '../core/journey.js'
import { reviewWaitsOn } from '../core/journey.js'
import { STAGE_NAMES, type StageId } from '../core/journey-catalog.js'

/** The five areas a person acknowledges in turn, as step ids. */
export const AREAS = ['coverage', 'emc', 'bom', 'fab', 'changes'] as const
export const AREA_TITLES: Record<(typeof AREAS)[number], string> = { coverage: 'Coverage', emc: 'EMC and signal integrity', bom: 'Parts list', fab: 'Fabrication', changes: 'Changes since the last revision' }

/** What the record holds for the steps, read in actions-skills.ts. Absent pieces were not in the record. */
export interface ReleaseRecord {
  /** the newest emc.precheck run with its findings (findings.json) */
  precheck: { id: string; status: string; summary: string | null; started: number; findings: unknown[] | null } | null
  /** the newest run of each estimate kind (emc.run, emc.si) */
  estimates: { id: string; kind: string; status: string; summary: string | null; started: number }[]
  /** the newest parts.bom_check run and its result */
  parts: { id: string; status: string; summary: string | null; started: number; result: Record<string, unknown> | null } | null
  /** the newest DRC run (its findings are in the check input) */
  drcRun: { id: string; started: number } | null
}

export interface EmcFindingView { severity: 'error' | 'warn' | 'info'; rule: string; text: string; where: string | null }
export interface PartLineView {
  key: string; line: number; mpn: string | null; refs: string | null; status: string; stock: number | null; need: number
  unit_price: number | null; sellers: string[] | null; lifecycle: string | null
  /** one seller has it in stock (null: not known, the line has no sellers or only one provider answered) */
  single: boolean | null
  /** its lifecycle is not active (null: not known) */
  inactive: boolean | null
}

export interface ReleaseView {
  emc: {
    precheck: { run: string; at: string; status: string; summary: string | null; counts: { error: number; warn: number; info: number }; findings: EmcFindingView[]; more: number } | null
    estimates: { run: string; kind: string; status: string; summary: string | null; at: string }[]
    criterion: { id: string; text: string; status: 'met' | 'not_met' | 'waived' } | null
    waivers: { id: string; target: string; reason: string; risk: string; severity: string; by: string }[]
  }
  parts: {
    run: string; at: string; status: string; summary: string | null
    boards: number | null; build_quantity: number | null; currency: string | null; total: number | null
    per_board: number | null; for_build: number | null
    line_count: number; counts: Record<string, number>; blocking: number
    lines: PartLineView[]
    /** the lines to acknowledge: single-source or not active */
    flagged: string[]
    /** lines whose sellers and lifecycle the parts check does not have */
    unknown: number
  } | null
  fab: {
    drc: { run: string | null; at: string | null; errors: number; findings: number; waived: number } | null
    board: { size: string | null; layers: string[] | null } | null
    hand_placed: string[] | null
  }
  changes: {
    revision: string; previous: string | null
    started: { summary: string; by: string | null; at: string } | null
    items: { kind: string; summary: string; by: string | null; at: string }[]
  }
}

const iso = (t: number): string => new Date(t * 1000).toISOString()
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strs = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null)
const EOL = /obsolete|end of life|eol|discontinued|last time buy|nrnd|not recommended/i

/** A part's lifecycle, as not active (true), active (false) or not known (null). */
export function inactiveLifecycle(lifecycle: string | null): boolean | null {
  if (!lifecycle?.trim()) return null
  return EOL.test(lifecycle) || !/active|production|new product/i.test(lifecycle)
}

/** One line of the parts check as the step shows it. */
export function partLine(l: Record<string, unknown>): PartLineView {
  const sellers = strs(l.sources)
  const asked = strs(l.asked) ?? []
  const lifecycle = typeof l.lifecycle === 'string' ? l.lifecycle : null
  const offer = l.offer && typeof l.offer === 'object' ? l.offer as Record<string, unknown> : null
  const mpn = typeof l.mpn === 'string' ? l.mpn : null
  const line = num(l.line) ?? 0
  return {
    key: mpn ?? `line-${line}`, line, mpn, refs: typeof l.refs === 'string' ? l.refs : null, status: String(l.status ?? ''), stock: num(offer?.stock),
    need: num(l.need) ?? 0, unit_price: num(l.unit_price), sellers, lifecycle,
    // one seller is single-source only where more than one provider was asked: one alone cannot tell
    single: sellers && asked.length > 1 ? sellers.length <= 1 : null,
    inactive: inactiveLifecycle(lifecycle),
  }
}

/** The steps' content from the record. */
export function releaseView(r: JourneyRecord | null, rec: ReleaseRecord | null, o: { drc: { findings: { severity: string }[]; errors: number } | null; board: Record<string, unknown> | null; handPlaced: string[] | null }): ReleaseView {
  // EMC: the precheck's errors and warnings first, then the estimates, the criterion and the waivers on it
  const pre = rec?.precheck ?? null
  const all = (pre?.findings ?? []).filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
  const counts = { error: 0, warn: 0, info: 0 }
  for (const f of all) if (f.severity === 'error' || f.severity === 'warn' || f.severity === 'info') counts[f.severity]++
  const rank = { error: 0, warn: 1, info: 2 } as const
  const shown = all.filter((f) => f.severity === 'error' || f.severity === 'warn').sort((a, b) => rank[a.severity as 'error'] - rank[b.severity as 'error']).slice(0, 12)
  const emcCriteria = (r?.criteria ?? []).filter((c) => /(^|\.)emc$/.test(c.id))
  const crit: CriterionRow | undefined = emcCriteria.find((c) => c.gate === 'signoff') ?? emcCriteria[0]
  const open = (r?.waivers ?? []).filter((w) => w.closedAt === null)
  const emcWaivers = open.filter((w) => emcCriteria.some((c) => c.id === w.target) || /emc/i.test(w.target))
  const waiverOf = (w: WaiverRow) => ({ id: w.id, target: w.target, reason: w.reason, risk: w.risk, severity: w.severity, by: w.by })

  // Parts list: cost per board and for the build quantity, stock, sellers and lifecycle
  const res = rec?.parts?.result ?? null
  const boards = num(res?.boards)
  const total = num(res?.total)
  const quantity = r?.journey.build.quantity ?? null
  const perBoard = total !== null && boards ? Math.round((total / boards) * 100) / 100 : null
  const lines = (Array.isArray(res?.lines) ? res.lines as unknown[] : []).filter((l): l is Record<string, unknown> => !!l && typeof l === 'object').map(partLine)
  const fitted = lines.filter((l) => l.need > 0)
  const countsOf = res?.counts && typeof res.counts === 'object' ? Object.fromEntries(Object.entries(res.counts as Record<string, unknown>).map(([k, v]) => [k, num(v) ?? 0])) : {}

  // Fabrication: the DRC result, the board's size and layers, what the fab does not place
  const drc = o.drc ? { run: rec?.drcRun?.id ?? null, at: rec?.drcRun ? iso(rec.drcRun.started) : null, errors: o.drc.errors, findings: o.drc.findings.length, waived: o.drc.findings.filter((f) => f.severity === 'waived').length } : null
  const outline = o.board?.outline as { width_mm?: number; height_mm?: number } | null | undefined

  // Changes: what started this revision and what was changed in it; the first revision has nothing to compare
  const revision = r?.journey.revision ?? 'A'
  const started = [...(r?.decisions ?? [])].filter((d) => d.kind === 'revision.started' && d.ref === revision).sort((a, b) => b.at - a.at)[0]
  const previous = started && started.detail && typeof started.detail === 'object' && typeof (started.detail as { from?: unknown }).from === 'string' ? (started.detail as { from: string }).from : null
  const CHANGE = /^(design\.|change\.(accepted|applied)$|stage\.reopened$|gate\.returned$|waiver\.added$)/
  const items = started ? (r?.decisions ?? []).filter((d: DecisionRow) => d.at >= started.at && d.id !== started.id && CHANGE.test(d.kind)).sort((a, b) => a.at - b.at).slice(-30) : []

  return {
    emc: {
      precheck: pre ? {
        run: pre.id, at: iso(pre.started), status: pre.status, summary: pre.summary, counts,
        findings: shown.map((f) => ({ severity: f.severity as 'error', rule: String(f.rule ?? ''), text: String(f.message ?? ''), where: typeof f.net === 'string' ? f.net : typeof f.layer === 'string' ? f.layer : null })),
        more: counts.error + counts.warn - shown.length,
      } : null,
      estimates: (rec?.estimates ?? []).map((e) => ({ run: e.id, kind: e.kind, status: e.status, summary: e.summary, at: iso(e.started) })),
      criterion: crit ? { id: crit.id, text: crit.text, status: crit.status === 'met' ? 'met' : open.some((w) => w.targetKind === 'criterion' && w.target === crit.id) ? 'waived' : 'not_met' } : null,
      waivers: emcWaivers.map(waiverOf),
    },
    parts: rec?.parts ? {
      run: rec.parts.id, at: iso(rec.parts.started), status: rec.parts.status, summary: rec.parts.summary,
      boards, build_quantity: quantity, currency: typeof res?.currency === 'string' ? res.currency : null, total, per_board: perBoard,
      // at the build quantity: the check's own total when it was made for it, else per board times the quantity
      for_build: boards !== null && quantity !== null && boards === quantity ? total : perBoard !== null && quantity !== null ? Math.round(perBoard * quantity * 100) / 100 : null,
      line_count: num(res?.line_count) ?? lines.length, counts: countsOf, blocking: num(res?.blocking) ?? 0,
      lines, flagged: fitted.filter((l) => l.single === true || l.inactive === true).map((l) => l.key),
      unknown: fitted.filter((l) => l.single === null && l.inactive === null).length,
    } : null,
    fab: {
      drc,
      // the copper layers only: kicad.board lists every layer (silk, mask, paste, …), and the review read "20 layers" for a
      // 2-layer board (test-esp32-run2 R61)
      board: o.board ? { size: outline?.width_mm ? `${outline.width_mm} × ${outline.height_mm} mm` : null, layers: copperLayers(o.board) } : null,
      hand_placed: o.handPlaced,
    },
    changes: {
      revision, previous,
      started: started ? { summary: started.summary, by: started.by, at: iso(started.at) } : null,
      items: items.map((d) => ({ kind: d.kind, summary: d.summary, by: d.by, at: iso(d.at) })),
    },
  }
}

/** The steps the draft acknowledges (its `acknowledged`), of the five areas. */
export const acknowledged = (draft: Record<string, unknown> | null): string[] => (Array.isArray(draft?.acknowledged) ? (draft.acknowledged as unknown[]).filter((x): x is string => typeof x === 'string' && (AREAS as readonly string[]).includes(x)) : [])

/** The Decide step's choice in the draft: release, or return to a stage, with the person's note. */
export function decisionOf(draft: Record<string, unknown> | null): { choice: 'release' } | { choice: 'return'; stage: StageId } | null {
  const c = draft?.choice as { option?: unknown } | undefined
  if (c?.option === 'release') return { choice: 'release' }
  const m = typeof c?.option === 'string' ? /^return:([a-z]+)$/.exec(c.option) : null
  return m && m[1]! in STAGE_NAMES ? { choice: 'return', stage: m[1] as StageId } : null
}
export const noteOf = (draft: Record<string, unknown> | null): string => (typeof draft?.note === 'string' ? draft.note.trim() : '')

/**
 * The Decide step's options and trace's recommendation: release when nothing stands in its way, else return to the
 * stage the concern belongs to, with the reasons. The stages offered are this project's, up to the current one.
 */
export function releaseRecommendation(r: JourneyRecord | null, v: ReleaseView, requirements: readonly { id: string; evidence: string }[]): { question: string; recommended: string; options: { id: string; label: string; detail?: string }[]; why: string } | null {
  if (!r) return null
  const cur = r.stages.find((s) => s.id === r.journey.currentStage)
  const stages = r.stages.filter((s) => cur && s.ord <= cur.ord).sort((a, b) => b.ord - a.ord)
  const concerns: { text: string; stage: StageId }[] = []
  // untested under the coverage criterion's waiver is not a concern; failing always is (test-esp32-run2 R59: trace
  // recommended that waiver, then recommended returning to Sign-off because of what it covers)
  const covered = r.waivers.some((w) => w.closedAt === null && w.targetKind === 'criterion' && w.target === 'signoff.coverage')
  const failing = requirements.filter((q) => q.evidence === 'failing')
  const untested = covered ? [] : requirements.filter((q) => q.evidence === 'untested')
  if (failing.length) concerns.push({ text: `${failing.length} requirement${failing.length === 1 ? ' is' : 's are'} failing`, stage: r.journey.currentStage })
  if (untested.length) concerns.push({ text: `${untested.length} requirement${untested.length === 1 ? ' is' : 's are'} untested`, stage: r.journey.currentStage })
  // an emission estimate over the limit is said, even with the precheck criterion met, unless that criterion is
  // waived for it (R60)
  const emcWaived = r.waivers.some((w) => w.closedAt === null && w.targetKind === 'criterion' && w.target === 'signoff.emc')
  const over = emcWaived ? [] : v.emc.estimates.filter((e) => e.status === 'fail')
  if (over.length) concerns.push({ text: `${over.length} emission estimate${over.length === 1 ? ' is' : 's are'} over the limit`, stage: r.journey.currentStage })
  for (const c of reviewWaitsOn(r, 'signoff.report')) concerns.push({ text: `${c.text.replace(/\.$/, '').toLowerCase()} is not met yet`, stage: r.journey.currentStage })
  if (v.fab.drc && v.fab.drc.errors > 0) concerns.push({ text: `DRC has ${v.fab.drc.errors} error${v.fab.drc.errors === 1 ? '' : 's'}`, stage: stages.some((s) => s.id === 'layout') ? 'layout' : r.journey.currentStage })
  if (v.parts && v.parts.blocking > 0) concerns.push({ text: `${v.parts.blocking} parts list line${v.parts.blocking === 1 ? ' is' : 's are'} out, short or not found`, stage: r.journey.currentStage })
  const back = concerns.find((c) => c.stage !== r.journey.currentStage)?.stage ?? concerns[0]?.stage
  const recommended = back ? `return:${back}` : 'release'
  return {
    question: 'Release, or return to the stage the concern belongs to?',
    recommended,
    options: [
      { id: 'release', label: 'Release', detail: 'Approve the release report; the release gate is signed next.' },
      ...stages.map((s) => ({ id: `return:${s.id}`, label: `Return to ${STAGE_NAMES[s.id]}`, detail: s.id === r.journey.currentStage ? 'Keep the stage open, with what has to change.' : `Reopen ${STAGE_NAMES[s.id]}; the gates from there are signed again.` })),
    ],
    why: concerns.length ? `${concerns.map((c) => c.text).join('; ').replace(/^./, (x) => x.toUpperCase())}.` : 'Every requirement is verified or waived, and nothing in the report stands in the way.',
  }
}

/** A board check's copper layers by name ("F.Cu", "In1.Cu", "B.Cu"), from its layer list, else its count; null when neither. */
export function copperLayers(board: Record<string, unknown>): string[] | null {
  const named = Array.isArray(board.layers) ? board.layers.filter((l): l is string => typeof l === 'string' && /\.Cu$/.test(l)) : []
  if (named.length) return named
  const n = typeof board.copper_layers === 'number' ? board.copper_layers : null
  return n ? Array.from({ length: n }, (_, i) => (i === 0 ? 'F.Cu' : i === n - 1 ? 'B.Cu' : `In${i}.Cu`)) : null
}

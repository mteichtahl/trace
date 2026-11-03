/**
 * Where a project's time went: how long each stage took, and how much of it trace was waiting on a person
 * (Operations' Process tab, "Where the time went, by stage"; the wait metrics, src/api/process-metrics.ts). Pure, over
 * the journey record (src/core/journey.ts) with the agents' facts merged in.
 *
 *   gateReadyAt   when a gate became ready to sign, as of `at`: the latest of its criteria's checks and its waivers
 *                 taken at or before `at`, and never before its stage started. A criterion checked again after a
 *                 signature (real records have them: a check re-run after Sign-off) is not "ready" for that
 *                 signature, so only what happened up to it counts, and a wait is never negative
 *   personWaits   the spans in which trace waited on a person, each in its stage:
 *                   question   asked → answered (or dismissed, or `at` while open); only those that block something or a stuck
 *                              agent (what the inbox lists): a question that blocks nothing waits on no one
 *                   gate       ready → signed, for every signature; a gate ready now and unsigned: ready → `at`
 *                   change     ready → accepted, for each change.accepted decision that recorded when it became
 *                              ready (detail.ready_since, src/api/actions-changes.ts change.accept); older decisions
 *                              have none and count no wait
 *   stageTimes    each started stage: its length (started → finished, or `at` while it runs) and the part of it
 *                 spent waiting on a person (the union of its waits, clipped to the stage, so two things waiting at
 *                 once count once). "trace working" is the rest: the stage's time when no person was waited on
 *
 * Times are seconds since the epoch, as the record keeps them.
 */
import { type JourneyRecord, STAGE_NAMES, type StageId } from './journey.js'

export interface Span { from: number; to: number }
export interface PersonWait extends Span { kind: 'question' | 'gate' | 'change'; stage: StageId | null; ref: string }
export interface StageTime { id: StageId; name: string; started: number; finished: number | null; seconds: number; waiting: number }

/** When gate `gate` became ready to sign, as of `at` (seconds); null for no such gate. */
export function gateReadyAt(r: JourneyRecord, gate: string, at: number): number | null {
  const g = r.gates.find((x) => x.id === gate)
  if (!g) return null
  const criteria = r.criteria.filter((c) => c.gate === gate)
  const ids = new Set(criteria.map((c) => c.id))
  const times = [
    ...criteria.map((c) => c.checkedAt).filter((t): t is number => t !== null && t <= at),
    ...r.waivers.filter((w) => w.targetKind === 'criterion' && ids.has(w.target) && w.at <= at).map((w) => w.at),
  ]
  const started = r.stages.find((s) => s.id === g.stage)?.started ?? null
  const last = times.length ? Math.max(...times) : null
  const t = last === null ? started : started === null ? last : Math.max(last, started)
  return t === null ? null : Math.min(t, at)
}

/** Whether a gate can be signed now on its criteria: each met, or waived with an open waiver. */
function gateMet(r: JourneyRecord, gate: string): boolean {
  const criteria = r.criteria.filter((c) => c.gate === gate)
  return criteria.length > 0 && criteria.every((c) => c.status === 'met' || r.waivers.some((w) => w.targetKind === 'criterion' && w.target === c.id && w.closedAt === null))
}

const ReadySince = (d: unknown): number | null => {
  const v = (d as { ready_since?: unknown } | null)?.ready_since
  const t = typeof v === 'string' ? Date.parse(v) / 1000 : typeof v === 'number' ? v : NaN
  return Number.isFinite(t) ? t : null
}

/** The spans in which trace waited on a person (see the module comment). */
export function personWaits(r: JourneyRecord, at: number): PersonWait[] {
  const out: PersonWait[] = []
  // a stuck report a person dismissed waited until the dismissal
  const dismissed = new Map((r.dismissals ?? []).map((d) => [d.stuckId, d.at]))
  for (const q of r.questions) {
    if (q.kind === 'question' && !q.blocks?.trim()) continue
    const to = q.answeredAt ?? dismissed.get(q.id) ?? at
    if (to > q.askedAt) out.push({ kind: 'question', stage: q.stage, ref: q.id, from: q.askedAt, to })
  }
  for (const g of r.gates) {
    const signed = r.signatures.filter((s) => s.gate === g.id)
    for (const s of signed) {
      const from = gateReadyAt(r, g.id, s.at)
      if (from !== null && s.at > from) out.push({ kind: 'gate', stage: g.stage, ref: g.id, from, to: s.at })
    }
    const live = signed.some((s) => s.supersededAt === null && s.revision === r.journey.revision)
    if (!live && g.stage === r.journey.currentStage && gateMet(r, g.id)) {
      const from = gateReadyAt(r, g.id, at)
      if (from !== null && at > from) out.push({ kind: 'gate', stage: g.stage, ref: g.id, from, to: at })
    }
  }
  for (const d of r.decisions) {
    if (d.kind !== 'change.accepted') continue
    const from = ReadySince(d.detail)
    if (from !== null && d.at > from) out.push({ kind: 'change', stage: (d.stage as StageId | null) ?? null, ref: d.ref ?? d.id, from, to: d.at })
  }
  return out
}

/** The length of the union of spans, each clipped to [lo, hi]. */
export function unionSeconds(spans: readonly Span[], lo: number, hi: number): number {
  const clipped = spans.map((s) => ({ from: Math.max(s.from, lo), to: Math.min(s.to, hi) })).filter((s) => s.to > s.from).sort((a, b) => a.from - b.from)
  let total = 0
  let end = -Infinity
  for (const s of clipped) {
    if (s.from >= end) { total += s.to - s.from; end = s.to } else if (s.to > end) { total += s.to - end; end = s.to }
  }
  return total
}

/** Each started stage of the record, in order: its length and the part spent waiting on a person. */
export function stageTimes(r: JourneyRecord, at: number): StageTime[] {
  const waits = personWaits(r, at)
  return [...r.stages].sort((a, b) => a.ord - b.ord).filter((s) => s.started !== null).map((s) => {
    const started = s.started as number
    const end = Math.max(started, s.finished ?? at)
    const mine = waits.filter((w) => (w.stage ?? r.journey.currentStage) === s.id)
    return { id: s.id, name: STAGE_NAMES[s.id], started, finished: s.finished, seconds: end - started, waiting: unionSeconds(mine, started, end) }
  })
}

/** What a question blocks, compared loosely: case, spaces and the end's full stop do not matter. */
const blocksKey = (b: string | null | undefined): string => (b ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim()
const CRITERION = /\b[a-z]+(?:\.[a-z]+){1,2}\b/g

/**
 * Whether a question about to be asked asks again what a person already answered (a rework, asked_again): it blocks
 * the same thing as an answered question of the record (the same words, loosely), or names the same gate criterion
 * (layout.renders) in what it blocks. A question that blocks nothing is never counted: there is nothing to compare.
 * Kept simple on purpose: it never reads the question's text, which may rightly ask something new about the same work.
 */
export function asksAgain(r: Pick<JourneyRecord, 'questions' | 'criteria'> | null, blocks: string | null | undefined): boolean {
  const key = blocksKey(blocks)
  if (!r || !key) return false
  const ids = new Set(r.criteria.map((c) => c.id))
  const named = (b: string | null | undefined): string[] => [...(b ?? '').matchAll(CRITERION)].map((m) => m[0]).filter((x) => ids.has(x))
  const mine = new Set(named(blocks))
  return r.questions.some((q) => q.answeredAt !== null && (blocksKey(q.blocks) === key || named(q.blocks).some((x) => mine.has(x))))
}

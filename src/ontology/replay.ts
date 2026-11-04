/**
 * Replay (docs/ontology-plan.md phase 8): a project's record played back in time order, and the record as it stood at
 * any moment.
 *
 *   journeyEvents(src, o)       every event the record holds, oldest first (P8.1): the journey's start, each stage
 *                               started, finished, reopened or cleared (stage_history), each criterion met or not
 *                               (criterion_history, and the agents' criterion checks), each signature and its
 *                               supersession, each gate returned, each waiver taken, acknowledged and closed, each
 *                               question asked and answered (people's and agents'), each design decision, the
 *                               decisions log's other entries (changes accepted, deploys, orders, and the rest), each
 *                               hand-off, job, run and the commit it built, each order placed, shipped and delivered,
 *                               each board received and checked, each bring-up reading and test result. Each is typed
 *                               by the ontology (the class its row maps to), names its record
 *                               (urn:trace:…), the graph view's node it changes (and the status it gives it), who did
 *                               it, the stage it happened in, and a caption in plain words
 *   recordAsOf(db, facts, t)    the journey record as it stood at `t` (P8.2), merged with the agents' facts as they
 *                               stood then: only rows that existed by `t`; each criterion's status and evidence from
 *                               its history; signatures not yet superseded; waivers not yet closed; questions not yet
 *                               answered; the stages' starts, finishes and reopenings from their history
 *   criteriaAsOf(r, gate)       a gate's criteria as a signature records them: met, waived (an open waiver on it) or
 *                               not met
 *
 * Nothing here writes. Times are seconds since 1970, as the record keeps them.
 */
import type { DatabaseSync } from 'node:sqlite'
import { loadChecks } from '../core/agent-facts.js'
import { STAGE_NAMES, type StageId } from '../core/journey-catalog.js'
import { type AgentFacts, type JourneyRecord, loadJourney, mergeAgentFacts } from '../core/journey.js'
import { type GraphOptions, nodeIri } from './graph.js'
import { TABLES } from './mapping.js'

/** The graph view's statuses an event can give a node (web/src/lib/graph.ts NodeStatus). */
export type ReplayStatus = 'verified' | 'failing' | 'untested' | 'waived' | 'active' | 'inactive'

export interface JourneyEvent {
  /** unique and stable: <source>:<key>:<what> */
  id: string
  /** seconds since 1970 */
  t: number
  at: string
  /** what happened, as <thing>.<verb>: stage.started, criterion.met, gate.signed, waiver.taken, run.passed … */
  kind: string
  /** the ontology class of the record it comes from (the mapped table's class) */
  class: string
  /** the record, as the graph names it (urn:trace:…) */
  record: string
  /** where it is read from: <database>.<table> */
  source: string
  /** the graph view's node it is about (graph.neighbourhood's ids: gate:define, criterion:define.accepted, run:…) */
  node: string | null
  /** what it makes that node: the graph view's status from now on */
  status?: ReplayStatus
  /** other graph nodes it touches (who decided, what a waiver waives) */
  links?: string[]
  who: string | null
  stage: StageId | null
  caption: string
}

export interface ReplaySources {
  /** the journey record with its history tables (journey.db, or the project database's copy) */
  journey?: DatabaseSync | null
  facts?: DatabaseSync | null
  jobs?: DatabaseSync | null
  project?: DatabaseSync | null
}

const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
const rows = (db: DatabaseSync, sql: string): Record<string, unknown>[] => db.prepare(sql).all() as Record<string, unknown>[]
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const short = (s: string, n = 90): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const json = <T>(v: unknown, d: T): T => { try { return typeof v === 'string' ? JSON.parse(v) as T : d } catch { return d } }
const CLASS: ReadonlyMap<string, { class: string; kind: string }> = new Map(TABLES.map((t) => [`${t.db}.${t.table}`, { class: t.class, kind: t.kind }]))

/** The decisions log's kinds another event already tells (from its own table, with more): left out of the stream. */
const TOLD = new Set(['gate.signed', 'gate.returned', 'waiver.taken', 'waiver.closed', 'waiver.acknowledged', 'question.answered', 'stage.reopened', 'criterion.met', 'criterion.not_met', 'criterion.confirmed'])

/** Every event of the record, oldest first. */
export function journeyEvents(src: ReplaySources, o: GraphOptions): JourneyEvent[] {
  const out: JourneyEvent[] = []
  const j = src.journey ?? null
  const r = j ? loadJourney(j) : null
  const stageOf = new Map<string, StageId>((r?.gates ?? []).map((g) => [g.id, g.stage]))
  const gateName = new Map((r?.gates ?? []).map((g) => [g.id, g.name]))
  const critOf = new Map((r?.criteria ?? []).map((c) => [c.id, c]))
  // the stage a moment falls in: the last stage started by then (the record's own start times)
  const starts: { t: number; stage: StageId }[] = []
  const add = (source: string, key: string, what: string, e: Omit<JourneyEvent, 'id' | 'at' | 'class' | 'record' | 'source' | 'stage'> & { stage?: StageId | null }): void => {
    if (!Number.isFinite(e.t)) return
    const m = CLASS.get(source)
    out.push({
      id: `${source}:${key}:${what}`, at: new Date(e.t * 1000).toISOString(), class: m?.class ?? 'Event',
      record: nodeIri(o, m?.kind ?? source, key), source, ...e, stage: e.stage ?? null,
    })
  }
  const person = (who: string | null): string[] => (who ? [`person:${who}`] : [])

  if (j && r) {
    add('journey.journey', 'current', 'started', { t: r.journey.created, kind: 'journey.started', node: null, who: r.journey.by, caption: `The journey started${r.journey.name ? `: ${r.journey.name}` : ''}`, stage: 'define' })
    if (has(j, 'stage_history')) {
      for (const s of rows(j, 'SELECT * FROM stage_history ORDER BY at')) {
        const stage = String(s.stage) as StageId
        const ev = String(s.event)
        if (ev === 'started') starts.push({ t: Number(s.at), stage })
        const words: Record<string, string> = { started: 'started', finished: 'finished', reopened: 'was reopened', unfinished: 'is open again', cleared: 'was cleared for a new revision' }
        add('journey.stage_history', String(s.id), ev, { t: Number(s.at), kind: `stage.${ev}`, node: null, who: str(s.by), stage, caption: `${STAGE_NAMES[stage] ?? stage} ${words[ev] ?? ev}${s.reason ? `: ${short(String(s.reason))}` : ''}` })
      }
    }
    if (has(j, 'criterion_history')) {
      for (const c of rows(j, 'SELECT * FROM criterion_history ORDER BY at')) {
        const met = c.status === 'met'
        const text = critOf.get(String(c.criterion))?.text ?? String(c.criterion)
        const who = str(c.by)
        add('journey.criterion_history', String(c.id), String(c.status), {
          t: Number(c.at), kind: met ? 'criterion.met' : c.status === 'waived' ? 'criterion.waived' : 'criterion.not_met', node: `criterion:${c.criterion}`,
          status: met ? 'verified' : c.status === 'waived' ? 'waived' : 'untested', links: person(who && who !== 'trace' ? who : null), who,
          stage: stageOf.get(String(c.gate)) ?? null,
          caption: `${who === 'trace' || c.source === 'checker' ? 'trace' : who ?? 'Someone'} marked “${short(text, 70)}” ${met ? 'met' : c.status === 'waived' ? 'waived' : 'not met'}`,
        })
      }
    }
    for (const s of r.signatures) {
      const name = gateName.get(s.gate) ?? s.gate
      add('journey.gate_signatures', s.id, 'signed', { t: s.at, kind: 'gate.signed', node: `gate:${s.gate}`, status: 'verified', links: person(s.by), who: s.by, stage: stageOf.get(s.gate) ?? null, caption: `${s.by} signed the ${name} gate` })
      if (s.supersededAt !== null) add('journey.gate_signatures', s.id, 'superseded', { t: s.supersededAt, kind: 'gate.unsigned', node: `gate:${s.gate}`, status: 'untested', who: null, stage: stageOf.get(s.gate) ?? null, caption: `The ${name} gate's signature no longer stands (its stage was reopened)` })
    }
    for (const g of r.gates) {
      if (g.returnedAt !== null) add('journey.gates', g.id, 'returned', { t: g.returnedAt, kind: 'gate.returned', node: `gate:${g.id}`, status: 'failing', links: person(g.returnedBy), who: g.returnedBy, stage: g.stage, caption: `${g.returnedBy ?? 'Someone'} returned the ${g.name} gate${g.returnReason ? `: ${short(g.returnReason)}` : ''}` })
    }
    for (const w of r.waivers) {
      const target = w.targetKind === 'criterion' ? `criterion:${w.target}` : w.targetKind === 'requirement' ? `requirement:${w.target}` : w.targetKind === 'test' ? `test:${w.target}` : null
      add('journey.waivers', w.id, 'taken', { t: w.at, kind: 'waiver.taken', node: `waiver:${w.id}`, status: 'waived', links: [...(target ? [target] : []), ...person(w.by)], who: w.by, stage: w.stage, caption: `${w.by} waived ${w.targetKind === 'criterion' ? `“${short(critOf.get(w.target)?.text ?? w.target, 60)}”` : w.target} (${w.severity}): ${short(w.reason, 70)}` })
      if (w.acknowledgedAt !== null) add('journey.waivers', w.id, 'acknowledged', { t: w.acknowledgedAt, kind: 'waiver.acknowledged', node: `waiver:${w.id}`, links: person(w.acknowledgedBy), who: w.acknowledgedBy, stage: w.stage, caption: `${w.acknowledgedBy ?? 'Someone'} acknowledged the waiver on ${w.target}` })
      if (w.closedAt !== null) add('journey.waivers', w.id, 'closed', { t: w.closedAt, kind: 'waiver.closed', node: `waiver:${w.id}`, status: 'inactive', who: null, stage: w.stage, caption: `The waiver on ${w.target} was closed` })
    }
    for (const q of r.questions) {
      add('journey.questions', q.id, 'asked', { t: q.askedAt, kind: q.kind === 'stuck' ? 'agent.stuck' : 'question.asked', node: null, who: q.askedBy, stage: q.stage, caption: `${q.askedBy} asked: ${short(q.text)}` })
      if (q.answeredAt !== null) add('journey.questions', q.id, 'answered', { t: q.answeredAt, kind: 'question.answered', node: `decision:q-${q.id}`, status: 'active', links: person(q.answeredBy), who: q.answeredBy, stage: q.stage, caption: `${q.answeredBy ?? 'Someone'} answered “${short(q.text, 50)}”: ${short(q.answer ?? '', 60)}` })
    }
    for (const d of r.decisions) {
      if (TOLD.has(d.kind)) continue
      add('journey.decisions', d.id, 'recorded', { t: d.at, kind: d.kind, node: null, who: d.by, stage: (d.stage as StageId | null) ?? null, caption: short(d.summary, 140) })
    }
    if (has(j, 'design_decisions')) {
      for (const d of rows(j, 'SELECT * FROM design_decisions ORDER BY at')) {
        const kind = String(d.kind)
        const target = String(d.target)
        const node = kind === 'requirement' ? `requirement:${target}` : kind === 'intent' ? `intent:${target}` : null
        add('journey.design_decisions', String(d.id), 'decided', { t: Number(d.at), kind: `design.${kind}`, node, links: person(str(d.by)), who: str(d.by), caption: `${str(d.by) ?? 'Someone'} ${String(d.choice)} ${kind === 'architecture.choice' ? 'an architecture' : `${kind.replace(/\./g, ' ')} ${target}`}` })
      }
    }
    for (const o2 of has(j, 'orders') ? rows(j, 'SELECT * FROM orders') : []) {
      const label = `the ${String(o2.fab)} order${o2.number ? ` ${String(o2.number)}` : ''}`
      for (const [col, verb] of [['placed_at', 'placed'], ['shipped_at', 'shipped'], ['delivered_at', 'delivered']] as const) {
        const t = num(o2[col])
        if (t !== null) add('journey.orders', String(o2.id), verb, { t, kind: `order.${verb}`, node: null, who: verb === 'placed' ? str(o2.placed_by) : null, caption: `${verb === 'placed' ? `${str(o2.placed_by) ?? 'Someone'} placed ${label}` : `${label[0]!.toUpperCase()}${label.slice(1)} ${verb}`}` })
      }
    }
    for (const b of has(j, 'boards') ? rows(j, 'SELECT * FROM boards') : []) {
      const t = num(b.received_at)
      if (t !== null) add('journey.boards', String(b.serial), 'received', { t, kind: 'board.received', node: null, who: str(b.by), caption: `Board ${String(b.serial)} received` })
    }
    for (const c of has(j, 'board_checks') ? rows(j, 'SELECT * FROM board_checks') : []) {
      add('journey.board_checks', String(c.id), 'checked', { t: Number(c.at), kind: 'board.checked', node: null, who: str(c.by), caption: `Board ${String(c.serial)}: ${String(c.kind)} check ${String(c.result)}` })
    }
  }

  if (src.facts) {
    const f = src.facts
    for (const c of has(f, 'criterion_checks') ? loadChecks(f) : []) {
      const crit = critOf.get(c.criterion)
      add('facts.criterion_checks', c.id, c.status, {
        t: c.checkedAt, kind: c.status === 'met' ? 'criterion.checked_met' : 'criterion.checked_not_met', node: `criterion:${c.criterion}`, status: c.status === 'met' ? 'verified' : 'untested',
        who: c.by, stage: crit ? stageOf.get(crit.gate) ?? null : null,
        caption: `${c.by} checked “${short(crit?.text ?? c.criterion, 70)}”: ${c.status === 'met' ? 'met' : 'not met'}`,
      })
    }
    for (const q of has(f, 'agent_questions') ? rows(f, 'SELECT * FROM agent_questions') : []) {
      add('facts.agent_questions', String(q.id), 'asked', { t: Number(q.asked_at), kind: 'question.asked', node: null, who: String(q.asked_by), stage: str(q.stage) as StageId | null, caption: `${String(q.asked_by)} asked: ${short(String(q.text))}` })
    }
    for (const s of has(f, 'stuck') ? rows(f, 'SELECT * FROM stuck') : []) {
      add('facts.stuck', String(s.id), 'stuck', { t: Number(s.at), kind: 'agent.stuck', node: null, who: String(s.agent_label), stage: str(s.stage) as StageId | null, caption: `${String(s.agent_label)} is stuck: ${short(String(s.why))}` })
    }
    for (const h of has(f, 'handoffs') ? rows(f, 'SELECT * FROM handoffs') : []) {
      add('facts.handoffs', String(h.id), 'asked', { t: Number(h.created_at), kind: 'handoff.asked', node: null, who: String(h.from_label), caption: `${String(h.from_label)} handed a question to the ${String(h.to_kind)} specialist: ${short(String(h.question))}` })
      const t = num(h.answered_at) ?? num(h.ended_at)
      if (t !== null) add('facts.handoffs', String(h.id), 'ended', { t, kind: `handoff.${String(h.state)}`, node: null, who: null, caption: `The hand-off to the ${String(h.to_kind)} specialist ${String(h.state)}` })
    }
  }

  if (src.jobs && has(src.jobs, 'jobs')) {
    for (const x of rows(src.jobs, 'SELECT * FROM jobs')) {
      const t0 = num(x.started_at) ?? num(x.queued_at)
      const who = str(x.requested_by)
      const what = short(String(x.title), 70)
      if (t0 !== null) add('jobs.jobs', String(x.id), 'started', { t: t0, kind: 'job.started', node: null, who, caption: `${who ? `${who} started` : 'trace started'} a ${String(x.agent ?? x.kind)} job: ${what}` })
      const t1 = num(x.ended_at)
      if (t1 !== null) add('jobs.jobs', String(x.id), 'ended', { t: t1, kind: `job.${String(x.state)}`, node: null, who: null, caption: `The ${String(x.agent ?? x.kind)} job ${String(x.state)}: ${what}` })
    }
  }

  if (src.project) {
    const p = src.project
    const seen = new Set<string>()
    for (const x of has(p, 'runs') ? rows(p, 'SELECT id, kind, subject, started, finished, status, summary, git_sha, agent FROM runs ORDER BY started') : []) {
      const sha = str(x.git_sha)
      if (sha && !seen.has(sha)) {
        seen.add(sha)
        add('project.runs', String(x.id), 'commit', { t: Number(x.started), kind: 'commit.built', node: null, who: null, caption: `trace first ran on commit ${sha.slice(0, 7)}` })
      }
      const t = num(x.finished)
      if (t === null) continue
      const ok = x.status === 'pass'
      add('project.runs', String(x.id), String(x.status), {
        t, kind: `run.${String(x.status)}`, node: `run:${x.id}`, status: ok ? 'verified' : x.status === 'fail' || x.status === 'error' ? 'failing' : 'untested', who: str(x.agent),
        caption: `${String(x.kind)}${x.subject ? ` on ${String(x.subject)}` : ''}: ${short(String(x.summary ?? x.status), 80)}`,
      })
    }
    for (const q of has(p, 'requirements') ? rows(p, 'SELECT id, text, created, by FROM requirements') : []) {
      const t = num(q.created)
      if (t !== null) add('project.requirements', String(q.id), 'recorded', { t, kind: 'requirement.recorded', node: `requirement:${q.id}`, status: 'untested', who: str(q.by), caption: `${String(q.id)} recorded: ${short(String(q.text), 80)}` })
    }
    for (const x of has(p, 'test_results') ? rows(p, 'SELECT * FROM test_results') : []) {
      const t = num(x.at)
      if (t !== null) add('project.test_results', String(x.run_id), 'result', { t, kind: `test.${String(x.status)}`, node: `test:${x.test_id}`, status: x.status === 'pass' ? 'verified' : x.status === 'fail' || x.status === 'error' ? 'failing' : x.status === 'waived' ? 'waived' : 'untested', links: [`run:${x.run_id}`], who: null, caption: `Test ${String(x.test_id)}: ${String(x.status)}` })
    }
    for (const x of has(p, 'bringup_readings') ? rows(p, 'SELECT * FROM bringup_readings') : []) {
      add('project.bringup_readings', String(x.id), 'reading', { t: Number(x.at), kind: 'bench.reading', node: null, who: str(x.by), caption: `Board ${String(x.board)}: ${String(x.quantity)} ${String(x.value)} ${String(x.unit ?? '')}${x.pass === 0 ? ' (out of limits)' : ''}` })
    }
  }

  // each event's stage, where its record does not say: the stage started last before it
  starts.sort((a, b) => a.t - b.t)
  for (const e of out) {
    if (e.stage) continue
    let s: StageId | null = null
    for (const x of starts) { if (x.t <= e.t) s = x.stage; else break }
    e.stage = s
  }
  return out.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id))
}

// ------------------------------------------------------------------ the record as it stood

/** The journey record as it stood at `t` (seconds), merged with the agents' facts as they stood then. */
export function recordAsOf(db: DatabaseSync, facts: DatabaseSync | null, t: number): JourneyRecord | null {
  const now = loadJourney(db)
  if (!now) return null
  const by = (x: number | null): boolean => x !== null && x <= t
  const keep = <T>(x: T | null | undefined, when: number | null): T | null => (by(when) ? (x ?? null) : null)

  // each criterion: its last change by `t` (criterion_history); none yet, not met
  const hist = has(db, 'criterion_history')
    ? rows(db, 'SELECT criterion, status, evidence, by, at FROM criterion_history ORDER BY at, rowid') : []
  const last = new Map<string, Record<string, unknown>>()
  for (const h of hist) if (Number(h.at) <= t) last.set(String(h.criterion), h)
  const criteria = now.criteria.map((c) => {
    const h = last.get(c.id)
    if (!h) return { ...c, status: 'not_met' as const, evidence: [], checkedAt: null, checkedBy: null }
    return { ...c, status: h.status === 'met' ? 'met' as const : 'not_met' as const, evidence: json(h.evidence, []), checkedAt: Number(h.at), checkedBy: str(h.by) }
  })

  // each stage: its starts, finishes and reopenings by `t` (stage_history)
  const sh = has(db, 'stage_history') ? rows(db, 'SELECT stage, event, reason, by, at FROM stage_history ORDER BY at, rowid') : []
  const stages = now.stages.map((s) => {
    let started: number | null = null
    let finished: number | null = null
    let reopenedAt: number | null = null
    let reopenedReason: string | null = null
    let reopenedBy: string | null = null
    for (const h of sh) {
      if (h.stage !== s.id || Number(h.at) > t) continue
      const at = Number(h.at)
      if (h.event === 'started') started = at
      else if (h.event === 'finished') finished = at
      else if (h.event === 'unfinished') finished = null
      else if (h.event === 'cleared') { started = null; finished = null }
      else if (h.event === 'reopened') { reopenedAt = at; reopenedReason = str(h.reason); reopenedBy = str(h.by) }
    }
    // a record from before the history was kept: its own times, when they are by `t`
    if (!sh.some((h) => h.stage === s.id)) return { ...s, started: keep(s.started, s.started), finished: keep(s.finished, s.finished), reopenedAt: keep(s.reopenedAt, s.reopenedAt) }
    return { ...s, started, finished, reopenedAt, reopenedReason, reopenedBy }
  })

  // the journey's current stage and revision as they were (journey_history), else as they are
  const jh = has(db, 'journey_history') ? rows(db, 'SELECT field, old, new, at FROM journey_history ORDER BY at, rowid') : []
  const field = (name: string, nowValue: string): string => {
    const changes = jh.filter((h) => h.field === name)
    const after = changes.find((h) => Number(h.at) > t)
    return after ? String(after.old) : nowValue
  }
  const journey = { ...now.journey, currentStage: field('current_stage', now.journey.currentStage) as StageId, revision: field('revision', now.journey.revision) }

  const r: JourneyRecord = {
    ...now, journey, stages, criteria,
    gates: now.gates.map((g) => (by(g.returnedAt) ? g : { ...g, returnedAt: null, returnedBy: null, returnReason: null })),
    opens: now.opens.filter((x) => x.at <= t),
    signatures: now.signatures.filter((s) => s.at <= t).map((s) => ({ ...s, supersededAt: keep(s.supersededAt, s.supersededAt) })),
    questions: now.questions.filter((q) => q.askedAt <= t).map((q) => (by(q.answeredAt) ? q : { ...q, answer: null, optionId: null, answerReason: null, answeredBy: null, answeredByHash: null, answeredAt: null })),
    waivers: now.waivers.filter((w) => w.at <= t).map((w) => ({ ...w, acknowledgedAt: keep(w.acknowledgedAt, w.acknowledgedAt), acknowledgedBy: keep(w.acknowledgedBy, w.acknowledgedAt), closedAt: keep(w.closedAt, w.closedAt) })),
    decisions: now.decisions.filter((d) => d.at <= t),
    dismissals: (now.dismissals ?? []).filter((d) => d.at <= t),
    declines: (now.declines ?? []).filter((d) => d.at <= t),
  }
  if (!facts) return r
  // the agents' facts as they stood: questions asked by `t`, each criterion's newest check by `t`
  const checks = has(facts, 'criterion_checks') ? loadChecks(facts).filter((c) => c.checkedAt <= t) : []
  const newest = new Map(checks.map((c) => [c.criterion, c]))
  const f: AgentFacts = {
    questions: has(facts, 'agent_questions') ? rows(facts, 'SELECT * FROM agent_questions ORDER BY asked_at').filter((q) => Number(q.asked_at) <= t).map((q) => ({
      id: String(q.id), askedBy: String(q.asked_by), askedOfSub: str(q.asked_of_sub), askedPart: q.asked_part === 'admins' ? 'admins' as const : 'contributors' as const,
      stage: str(q.stage) as StageId | null, text: String(q.text), blocks: str(q.blocks), options: json(q.options, []), sources: json(q.sources, []), jobId: str(q.job_id), askedAt: Number(q.asked_at),
    })) : [],
    checks: [...newest.values()],
    stuck: has(facts, 'stuck') ? rows(facts, 'SELECT * FROM stuck ORDER BY at').filter((s) => Number(s.at) <= t).map((s) => ({
      id: String(s.id), jobId: str(s.job_id), agent: String(s.agent_label), why: String(s.why), recommendation: String(s.recommendation), options: json(s.options, []),
      sources: json(s.sources, []), stage: str(s.stage) as StageId | null, at: Number(s.at), resolvedAt: num(s.resolved_at) !== null && Number(s.resolved_at) <= t ? Number(s.resolved_at) : null,
    })) : [],
  } as AgentFacts
  return mergeAgentFacts(r, f)
}

/** A gate's criteria as a signature records them: met, waived (an open waiver on it), or not met. */
export function criteriaAsOf(r: JourneyRecord, gate: string): { id: string; status: 'met' | 'waived' | 'not_met' }[] {
  const waived = new Set(r.waivers.filter((w) => w.closedAt === null && w.targetKind === 'criterion').map((w) => w.target))
  return r.criteria.filter((c) => c.gate === gate).map((c) => ({ id: c.id, status: c.status === 'met' ? 'met' : waived.has(c.id) ? 'waived' : 'not_met' }))
}

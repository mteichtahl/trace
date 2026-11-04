/**
 * The graph as it stood at a moment (docs/ontology-plan.md P8.2; buildGraph's `asOf`): each mapped table's rows as
 * they were then, worked out from the record itself, so the replay's graph at any moment is the record's own.
 *
 *   a row that did not exist yet       left out: its table's own creation time (CREATED: created, at, asked_at, …);
 *                                      a run's measurements, outputs and inputs come into being with the run
 *   a time after the moment            left out, with what goes with it (LATER: an answer with its answered_at, a
 *                                      signature's superseded_at, a waiver's closed_at, a run's end with its status)
 *   a criterion's status               from its history (criterion_history): its last change by then, else not met
 *   the journey's stage and revision   from its history (journey_history)
 *
 * A row a table keeps no creation time for, only `updated` (the architecture's rows, the pin plan, settings), counts
 * from its last update: a row changed after the moment is left out, though it existed in an earlier form. The design
 * record's own history is its decisions (design_decisions), which are kept by time.
 */
import type { DatabaseSync } from 'node:sqlite'

type Row = Record<string, unknown>
const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** When each table's row came into being: a column, or 'journey' (made with the journey), or 'run' (made with its run). */
export const CREATED: Readonly<Record<string, string>> = {
  journey: 'created', journey_template: 'at', stages: 'journey', gates: 'journey', gate_criteria: 'journey', criterion_opens: 'at',
  gate_signatures: 'at', questions: 'asked_at', waivers: 'at', decisions: 'at', orders: 'placed_at', order_tracking: 'at', boards: 'created',
  board_checks: 'at', stuck_dismissals: 'at', handoff_declines: 'at', design_decisions: 'at', job_controls: 'at', criterion_history: 'at',
  stage_history: 'at', journey_history: 'at', agent_questions: 'asked_at', criterion_checks: 'checked_at', stuck: 'at', handoffs: 'created_at',
  jobs: 'queued_at', settings: 'updated', runs: 'started', measurements: 'run', artifacts: 'run', artifact_hashes: 'run', run_inputs: 'run',
  coverage_hits: 'run', parts_list_lines: 'run', test_results: 'at', intent_statements: 'created', requirement_intent: 'updated',
  arch_options: 'created', arch_criteria: 'updated', arch_scores: 'updated', arch_blocks: 'updated', arch_connections: 'updated',
  pin_plan: 'updated', sheet_requirements: 'updated', requirements: 'created', test_items: 'created', coverage_points: 'created',
  bringup_readings: 'at', parts: 'updated', part_offers: 'fetched_at',
}

/** Times that may come after the moment, each with the columns that go with it. */
export const LATER: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  gate_signatures: { superseded_at: [] },
  questions: { answered_at: ['answer', 'option_id', 'answer_reason', 'answered_by', 'answered_by_hash'] },
  waivers: { acknowledged_at: ['acknowledged_by'], closed_at: [] },
  gates: { returned_at: ['returned_by', 'return_reason'] },
  stages: { started: [], finished: [], reopened_at: ['reopened_reason', 'reopened_by'] },
  orders: { shipped_at: [], delivered_at: [] },
  boards: { received_at: [] },
  stuck: { resolved_at: ['resolution'] },
  handoffs: { started_at: ['job_id'], answered_at: ['answer', 'answer_evidence', 'confidence', 'acceptance_met'], ended_at: ['why'] },
  jobs: { started_at: [], ended_at: ['summary', 'error'], paused_at: ['paused_by'], lost_at: [] },
  runs: { finished: ['summary', 'result'] },
  design_decisions: { superseded_at: [] },
}

/** `rows` of `table` as they stood at `t`. */
export function rowsAsOf(db: DatabaseSync, table: string, rows: readonly Row[], t: number): Row[] {
  const created = CREATED[table]
  let when: (r: Row) => number | null = () => null
  if (created === 'journey') {
    const j = has(db, 'journey') ? db.prepare("SELECT created FROM journey WHERE id='current'").get() as { created?: unknown } | undefined : undefined
    const start = n(j?.created)
    when = () => start
  } else if (created === 'run') {
    const started = new Map(has(db, 'runs') ? (db.prepare('SELECT id, started FROM runs').all() as Row[]).map((r) => [String(r.id), n(r.started)]) : [])
    when = (r) => started.get(String(r.run_id)) ?? null
  } else if (created) {
    when = (r) => n(r[created]) ?? n(r.updated) ?? n(r.at)
  }
  const later = LATER[table] ?? {}
  const out: Row[] = []
  for (const r of rows) {
    const w = when(r)
    if (created && w !== null && w > t) continue
    const x: Row = { ...r }
    for (const [col, goes] of Object.entries(later)) {
      const v = n(x[col])
      if (v !== null && v > t) { x[col] = null; for (const g of goes) x[g] = null }
    }
    if (table === 'runs' && x.finished === null && r.finished !== null) x.status = 'running'
    if (table === 'jobs' && n(r.ended_at) !== null && x.ended_at === null) x.state = x.started_at === null ? 'queued' : 'running'
    out.push(x)
  }
  if (table === 'gate_criteria') return criteriaAsOf(db, out, t)
  if (table === 'journey') return journeyAsOf(db, out, t)
  return out
}

/** Each criterion's status, evidence and who checked it, from its last change by `t` (none: not met). */
function criteriaAsOf(db: DatabaseSync, rows: Row[], t: number): Row[] {
  const last = new Map<string, Row>()
  if (has(db, 'criterion_history')) {
    for (const h of db.prepare('SELECT criterion, status, evidence, by, at FROM criterion_history WHERE at <= ? ORDER BY at, rowid').all(t) as Row[]) last.set(String(h.criterion), h)
  }
  return rows.map((r) => {
    const h = last.get(String(r.id))
    return h
      ? { ...r, status: h.status === 'met' ? 'met' : 'not_met', evidence: h.evidence, checked_at: h.at, checked_by: h.by }
      : { ...r, status: 'not_met', evidence: '[]', checked_at: null, checked_by: null }
  })
}

/** The journey's fields as they were: a field changed after `t` takes the value it had before the change. */
function journeyAsOf(db: DatabaseSync, rows: Row[], t: number): Row[] {
  if (!has(db, 'journey_history')) return rows
  const changes = db.prepare('SELECT field, old FROM journey_history WHERE at > ? ORDER BY at, rowid').all(t) as Row[]
  const first = new Map<string, unknown>()
  for (const c of changes) if (!first.has(String(c.field))) first.set(String(c.field), c.old)
  return rows.map((r) => {
    const x = { ...r }
    for (const [f, old] of first) if (f in x) x[f] = old
    return x
  })
}

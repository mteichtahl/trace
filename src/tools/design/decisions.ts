/**
 * People's decisions about the design record (the journey record's design_decisions table, src/core/journey.ts):
 * written only by the API for the person who decides (src/api/actions-design.ts and skill.submit), never by an agent,
 * because the journey record is people's (agents may read it, not write it). Read beside the agents' proposals
 * (src/tools/design/db.ts) by src/tools/design/record.ts.
 *
 *   intent                accepted (as worded: the words seen are kept, so a later change by an agent reopens it),
 *                         edited (the person's own words replace the agent's), or rejected
 *   intent.uncovered      left out: no requirement will cover this statement, with the reason
 *   requirement           accepted, or struck with the reason (Requirements review keeps the reason with it)
 *   architecture.criteria fixed: the criteria and their weights, before any score is read
 *   architecture.choice   chosen: the option, the person's reason, the criteria that decided it, their scores
 *   pins.agreed           agreed: the pin plan of one part, as it stood (its fingerprint), against the schematic
 *
 * A new decision on the same target supersedes the one before (kept, with superseded_at), so the log shows how it was
 * reached and the newest stands.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const DECISION_KINDS = ['intent', 'intent.uncovered', 'requirement', 'architecture.criteria', 'architecture.choice', 'pins.agreed'] as const
export type DecisionKind = (typeof DECISION_KINDS)[number]

export interface DesignDecision {
  id: string; kind: DecisionKind; target: string; choice: string; detail: Record<string, unknown>
  by: string; byHash: string; at: number; supersededAt: number | null
}

export class DesignDecisionError extends Error {
  override name = 'DesignDecisionError'
}

const hasTable = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))

/** Every decision, oldest first (superseded ones included). A database without the table has none. */
export function loadDesignDecisions(db: DatabaseSync): DesignDecision[] {
  if (!hasTable(db, 'design_decisions')) return []
  return (db.prepare('SELECT * FROM design_decisions ORDER BY at, rowid').all() as Record<string, unknown>[]).map((r) => {
    let detail: Record<string, unknown> = {}
    try { const v: unknown = JSON.parse(String(r.detail ?? '{}')); if (v && typeof v === 'object') detail = v as Record<string, unknown> } catch { /* unreadable detail: none */ }
    return {
      id: String(r.id), kind: String(r.kind) as DecisionKind, target: String(r.target), choice: String(r.choice), detail,
      by: String(r.by), byHash: String(r.by_hash), at: Number(r.at), supersededAt: r.superseded_at === null || r.superseded_at === undefined ? null : Number(r.superseded_at),
    }
  })
}

/** The decision standing on each target of a kind (the newest not superseded). */
export function standing(all: readonly DesignDecision[], kind: DecisionKind): Map<string, DesignDecision> {
  const m = new Map<string, DesignDecision>()
  for (const d of all) if (d.kind === kind && d.supersededAt === null) m.set(d.target, d)
  return m
}

/** Record a decision (superseding the one standing on its target). Returns it. */
export function recordDesignDecision(db: DatabaseSync, d: { kind: DecisionKind; target: string; choice: string; detail?: Record<string, unknown> | undefined }, by: { label: string; hash: string }): DesignDecision {
  const t = Date.now() / 1000
  const id = randomUUID().replaceAll('-', '').slice(0, 16)
  db.prepare('UPDATE design_decisions SET superseded_at=?, updated=? WHERE kind=? AND target=? AND superseded_at IS NULL').run(t, t, d.kind, d.target)
  db.prepare('INSERT INTO design_decisions (id, kind, target, choice, detail, by, by_hash, at, superseded_at, updated) VALUES (?,?,?,?,?,?,?,?,NULL,?)')
    .run(id, d.kind, d.target, d.choice, JSON.stringify(d.detail ?? {}), by.label, by.hash, t, t)
  return { id, kind: d.kind, target: d.target, choice: d.choice, detail: d.detail ?? {}, by: by.label, byHash: by.hash, at: t, supersededAt: null }
}

/** A short fingerprint of what was agreed (the pin plan of a part, as rows), so a later change is seen. */
export function fingerprint(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)
}

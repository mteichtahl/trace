/**
 * Shapes for Operations, Admin and Preferences (screens built from docs/ui-design.md "Operations", "Admin", "Agent
 * instructions and system prompts" and "Preferences"). They mirror what the API runtime answers today:
 * src/api/actions.ts (integrations.*, prompts.*, users.*), src/prompts/views.ts (the prompt views) and the web
 * backend's /api/ops and /api/auth/passkeys. Fields the API does not give yet are optional and marked "assumed".
 */
import type { Part, PersonClass } from './types'

// ------------------------------------------------------------------ /api/ops

export type OpsLevel = 'ok' | 'warn' | 'alarm'

export interface OpsTile {
  id: string
  label: string
  value: number | null
  unit: string
  /** e.g. { successRate: 0.96 } for runs */
  detail?: Record<string, unknown> | null
  spark: number[]
  status: OpsLevel
  /** assumed: change against the previous period, in words ("+18 vs previous 24 h") */
  change?: { value: number; text: string } | null
  /** assumed: the tile's second line ("oldest 4 min", "on track for US$560") */
  note?: string
}

export interface OpsAlarm {
  name: string
  state: 'ALARM' | 'INSUFFICIENT_DATA' | 'OK' | string
  /** the alarm's description or its state reason */
  reason: string
  since: string | null
  metric: string | null
  threshold: number | null
  repo?: string
  /** assumed: a plain summary and what to do */
  summary?: string
  todo?: string
}

export interface OpsSeries {
  label: string
  repo?: string
  /** a colour that means something (passed green, failed red): the Process tab's charts; others take the palette */
  color?: string
  /** [epoch ms, value] */
  points: [number, number][]
}

export interface OpsWidget {
  id: string
  title: string
  /** line | bar | area | value | pie | gauge */
  kind: string
  unit: string | null
  series: OpsSeries[]
  /** assumed: admins with console access get links */
  links?: { cloudwatch?: string; logs?: string; traces?: string }
}

export interface OpsSection {
  id: string
  title: string
  widgets: OpsWidget[]
}

export interface OpsAnswer {
  status: { level: OpsLevel; text: string }
  tiles: OpsTile[]
  alarms: OpsAlarm[]
  sections: OpsSection[]
  /** the Process tab (src/web/ops.ts processView); absent from an older API */
  process?: OpsProcess
  /** admins: what CloudWatch said it left out (a limit reached, a query refused), so an empty chart says why */
  notes?: string[]
  updatedAt: string
  nextAt: string
}

export type OpsWaitKind = 'question' | 'change' | 'gate'
export type OpsReworkCause = 'job_restarted' | 'conflict_resolved' | 'sent_back' | 'asked_again'
type OpsTally = { passed: number; failed: number }

/** How the people and trace work together over the range (src/web/ops.ts ProcessView). Seconds; [epoch ms, …] points. */
export interface OpsProcess {
  builds: (OpsTally & { points: [number, number, number][]; own: OpsTally; projects: OpsTally }) | null
  jobs: { done: number; failed: number; lost: number; cancelled: number; points: [number, number, number, number, number][] } | null
  waits: { kind: OpsWaitKind; count: number; median: number | null; slowest: number | null }[]
  wait: { count: number; median: number | null; slowest: number | null; spark: number[] } | null
  rework: { cause: OpsReworkCause; count: number }[]
  working: { share: number | null; jobSeconds: number; waitSeconds: number; spark: number[] } | null
  runTime: { median: number | null; count: number } | null
}

/** journey.time: where one project's time went, each started stage's length and its wait on people (seconds). */
export interface JourneyTime {
  repo: string
  started: boolean
  project: string | null
  at?: string
  stages: { id: string; name: string; started: number; finished: number | null; seconds: number; waiting: number }[]
}

// ------------------------------------------------------------------ users

export interface UserRow {
  email: string
  sub: string
  status: string
  enabled: boolean
  class: PersonClass | null
  projects: string[]
  /** each project with the person's part there (users.list since per-project parts) */
  parts?: { repo: string; part: Part }[]
  /** assumed: not in users.list yet (the access store keeps last_seen) */
  lastSeen?: string | null
  name?: string
}

// ------------------------------------------------------------------ integrations (src/core/integrations.ts)

export type IntegrationName = 'nexar' | 'mouser' | 'digikey'

export interface IntegrationStatus {
  name: IntegrationName
  title: string
  configured: boolean
  changed: string | null
  keys: readonly string[]
  enables: string
  url: string
  /** assumed: the API never reads a key back; when it can show the last four characters it will put them here */
  last4?: string
}

// ------------------------------------------------------------------ prompts (src/prompts/views.ts)

export type PromptLayer = 'default' | 'installation' | 'project'
export type PromptComposed = 'specialist' | 'worker.task' | 'worker.item' | 'delegate' | 'actions.check' | 'router' | 'memory' | 'system' | 'render' | 'cloudworker'

export interface PromptRow {
  id: string
  mode: 'editable' | 'locked'
  prompt: PromptComposed
  description: string
  layer: PromptLayer
  version: number | null
}

export interface PromptProblem {
  id: string
  layer: Exclude<PromptLayer, 'default'>
  version: number
  reason: string
}

export interface PromptList {
  repo?: string
  prompts: PromptRow[]
  problems: PromptProblem[]
  unavailable?: { layer: Exclude<PromptLayer, 'default'>; reason: string }[]
}

export interface PromptOverride {
  text: string | null
  version: number
  updated: string
  by: string | null
}

export interface PromptView {
  repo?: string
  id: string
  mode: 'editable' | 'locked'
  prompt: PromptComposed
  description: string
  vars: Record<string, { type: 'text' | 'number' | 'list'; description: string }>
  default: string
  installation: PromptOverride | null
  project: PromptOverride | null
  effective: { layer: PromptLayer; version: number | null; sha: string; text: string; skipped?: { layer: string; version: number; reason: string }[] }
  followed_by_locked: string[]
  composed: string
}

export interface PromptPreview {
  repo: string
  prompt: PromptComposed
  kind?: string
  text: string
  /** the prompt with each part preceded by its marker: [locked id · layer vN · sha] */
  marked: string
  parts: { id: string; layer: PromptLayer; version: number | null; sha: string; locked: boolean }[]
  unavailable?: { layer: string; reason: string }[]
}

export type PreviewJob =
  | { kind: 'task'; request: string; requestedBy?: string; issue?: number }
  | { kind: 'work-item'; item: { kind: 'ci-red' | 'conflict' | 'agent-fix'; number: number; sha: string; ref: string; own: boolean; title: string } }

export interface PromptWriteResult {
  scope: 'installation' | 'project'
  id: string
  version: number
  uid: string
  action: 'set' | 'reset' | 'revert'
  repo?: string
  branch?: string
  commit?: string
  note?: string
}

export interface PromptHistoryEntry {
  uid: string
  id: string
  version: number
  action: 'set' | 'reset' | 'revert'
  text: string | null
  /** a person's 16-character hash (through the API) or a login (CLI) */
  by: string | null
  at: string
  reason: string | null
}

// ------------------------------------------------------------------ /api/auth/passkeys

export interface Passkey {
  id: string
  name: string | null
  relyingParty?: string | null
  attachment?: string | null
  createdAt: string | null
}

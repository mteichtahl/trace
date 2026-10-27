/**
 * What the agents contribute to a project's journey, kept beside the journey record and never in it: the record is
 * people's (signatures, waivers, answers) and agents may not write it (src/infra/project.ts PeopleRecordsReadOnly).
 *
 *   where   projects/<slug>/journey-agent/facts.db   (one SQLite database per project in the central bucket, written
 *           with conditional puts exactly like the journey store: src/core/journey-store.ts BucketDb). The worker and
 *           the repository's workflows write it; the API reads it
 *   tables  agent_questions   a question an agent asks a person (by Cognito sub when it knows one), or the project's
 *                             contributors or admins: what it blocks, its options with exactly one recommended, each
 *                             with its reason, and the sources the agent read. Append only
 *           criterion_checks  an agent's check of a criterion trace owns: met or not met, with its evidence (a run
 *                             id, an artifact, a file), when, by which agent, in which job, on which revision. Append
 *                             only: the newest check of a criterion supersedes the ones before it
 *           stuck             an agent that cannot go on: its job, why, what it recommends, its options. Appended;
 *                             `resolved_at` is set when the agent moves on
 *
 * The API merges these facts into every view of the journey (src/core/journey.ts mergeAgentFacts): an agent's question
 * is a question on Home and in the inbox, an agent's check sets a trace-owned criterion's status (so a gate can be
 * ready), a stuck agent is a 'stuck' item. A person answers an agent's question with question.answer, which writes the
 * answer into the journey record under the agent's question id; the agent reads it there (journey.ask's wait).
 *
 * Every rule an agent's fact must meet is checked here, before it is written: a decision comes with a recommendation
 * (exactly one option recommended, a reason for every option), a check names a criterion trace owns (a person-owned
 * criterion is refused: only people's acts meet it) and a met check carries its evidence.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { type Backend, backendFor } from './central.js'
import {
  type AgentFacts, type AgentQuestion, type AskedPart, type CriterionCheck, type Evidence, EvidenceSchema, type JourneyRecord, type OptionRow, STAGE_IDS,
  type StageId, type StuckFact,
} from './journey.js'
import { BucketDb, type JourneyStoreOptions } from './journey-store.js'
import { PROJECTS_PREFIX, projectSlug } from './project.js'
import { transaction } from './store.js'

export const AGENT_FACTS_FOLDER = 'journey-agent'
export const AGENT_FACTS_DB = 'facts.db'

export class AgentFactError extends Error {
  override name = 'AgentFactError'
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_questions (
  id TEXT PRIMARY KEY,
  asked_by TEXT NOT NULL,         -- the agent, in words ("the Verification specialist")
  agent TEXT NOT NULL,            -- its kind (verify, impl, …, worker)
  asked_of_sub TEXT,              -- a person's Cognito sub, or NULL: asked_part
  asked_part TEXT NOT NULL CHECK (asked_part IN ('contributors', 'admins')),
  stage TEXT,
  text TEXT NOT NULL,
  blocks TEXT,                    -- what it blocks, in words (empty: it blocks nothing)
  options TEXT NOT NULL,          -- JSON list, recommended first: [{ id, label, recommended, why, gives_up? }]
  sources TEXT NOT NULL,          -- JSON list: [{ kind, ref, label }]
  job_id TEXT,
  asked_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS criterion_checks (
  id TEXT PRIMARY KEY,
  criterion TEXT NOT NULL,        -- capture.erc, …
  status TEXT NOT NULL CHECK (status IN ('met', 'not_met')),
  evidence TEXT NOT NULL,         -- JSON list: [{ kind: run | artifact | file | record | report, ref, label }]
  note TEXT,
  checked_at REAL NOT NULL,
  by TEXT NOT NULL,               -- the agent's kind
  job_id TEXT,
  revision TEXT                   -- the journey's revision when it was checked
);
CREATE INDEX IF NOT EXISTS criterion_checks_at ON criterion_checks(criterion, checked_at);
CREATE TABLE IF NOT EXISTS stuck (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  agent TEXT NOT NULL,            -- its kind
  agent_label TEXT NOT NULL,      -- in words
  why TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  options TEXT NOT NULL,          -- JSON list, as agent_questions.options (may be empty)
  sources TEXT NOT NULL,
  stage TEXT,
  at REAL NOT NULL,
  resolved_at REAL, resolution TEXT
);`

export const applyAgentFactsSchema = (db: DatabaseSync): void => { db.exec(SCHEMA) }

/** One project's agent facts, in `store` (the central bucket at its `projects` prefix). */
export class AgentFactsStore extends BucketDb {
  constructor(store: Backend, repo: string, o: Omit<JourneyStoreOptions, 'legacy'> = {}) {
    super(store, repo, { folder: AGENT_FACTS_FOLDER, file: AGENT_FACTS_DB, schema: applyAgentFactsSchema }, o)
  }
}

// ------------------------------------------------------------------ reading

const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback
  try { return JSON.parse(v) as T } catch { return fallback }
}
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const rows = (db: DatabaseSync, sql: string, ...args: (string | number)[]): Record<string, unknown>[] => db.prepare(sql).all(...args) as Record<string, unknown>[]

/** Every check, oldest first (`newest`: only the newest of each criterion). */
export function loadChecks(db: DatabaseSync, o: { newest?: boolean } = {}): CriterionCheck[] {
  const all = rows(db, 'SELECT * FROM criterion_checks ORDER BY checked_at, rowid').map((r) => ({
    id: String(r.id), criterion: String(r.criterion), status: r.status === 'met' ? 'met' as const : 'not_met' as const, evidence: json<Evidence[]>(r.evidence, []),
    checkedAt: Number(r.checked_at), by: String(r.by), jobId: str(r.job_id), revision: str(r.revision),
  }))
  if (!o.newest) return all
  const last = new Map<string, CriterionCheck>()
  for (const c of all) last.set(c.criterion, c)
  return [...last.values()]
}

/** The agents' facts of one project, as the journey's views take them (the newest check per criterion). */
export function loadAgentFacts(db: DatabaseSync): AgentFacts {
  return {
    questions: rows(db, 'SELECT * FROM agent_questions ORDER BY asked_at, rowid').map((r): AgentQuestion => ({
      id: String(r.id), askedBy: String(r.asked_by), askedOfSub: str(r.asked_of_sub), askedPart: r.asked_part === 'admins' ? 'admins' : 'contributors',
      stage: str(r.stage) as StageId | null, text: String(r.text), blocks: str(r.blocks), options: json<OptionRow[]>(r.options, []), sources: json<Evidence[]>(r.sources, []),
      jobId: str(r.job_id), askedAt: Number(r.asked_at),
    })),
    checks: loadChecks(db, { newest: true }),
    stuck: rows(db, 'SELECT * FROM stuck ORDER BY at, rowid').map((r): StuckFact => ({
      id: String(r.id), jobId: str(r.job_id), agent: String(r.agent_label), why: String(r.why), recommendation: String(r.recommendation),
      options: json<OptionRow[]>(r.options, []), sources: json<Evidence[]>(r.sources, []), stage: str(r.stage) as StageId | null, at: Number(r.at),
      resolvedAt: r.resolved_at === null || r.resolved_at === undefined ? null : Number(r.resolved_at),
    })),
  }
}

// ------------------------------------------------------------------ the rules, and writing

const now = (): number => Date.now() / 1000
const newId = (prefix: string): string => `${prefix}${randomUUID().replaceAll('-', '').slice(0, 14)}`

/** An option an agent offers: its reason is required (every decision comes with a recommendation and its reasons). */
export const AgentOptionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/i, 'a short id: letters, digits, - or _').describe('a short id: a, b, 4v2, keep'),
  label: z.string().trim().min(1).max(300).describe('the option in a few words, with a number and unit for a quantity'),
  recommended: z.boolean().default(false).describe('true for exactly one option: the one you recommend'),
  why: z.string().trim().min(3, 'say why, for every option').max(2000).describe('why: for the recommended one, why you recommend it; for the others, when it would be right'),
  gives_up: z.string().trim().max(1000).optional().describe('what choosing it gives up'),
})
export type AgentOption = z.input<typeof AgentOptionSchema>

/** Each option valid, exactly one recommended, ids unique; the recommended one first. Throws AgentFactError otherwise. */
export function checkOptions(given: readonly AgentOption[], o: { min: number }): OptionRow[] {
  const options = given.map((x) => {
    const p = AgentOptionSchema.safeParse(x)
    if (!p.success) throw new AgentFactError(`Option ${JSON.stringify(x.id ?? '')}: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    return p.data
  })
  if (options.length < o.min) throw new AgentFactError(o.min === 2 ? 'Offer at least two options: a decision is a choice between them.' : `Offer at least ${o.min} option.`)
  const rec = options.filter((x) => x.recommended)
  if (options.length && rec.length !== 1) throw new AgentFactError(`Recommend exactly one option (${rec.length} are recommended): every decision comes with trace's recommendation.`)
  const ids = new Set(options.map((x) => x.id))
  if (ids.size !== options.length) throw new AgentFactError('Each option needs its own id.')
  return [...options].sort((a, b) => Number(b.recommended) - Number(a.recommended)).map((x) => ({ id: x.id, label: x.label, recommended: x.recommended, why: x.why, ...(x.gives_up ? { gives_up: x.gives_up } : {}) }))
}

export interface Asker { agent: string; label: string; jobId: string | null }

export interface QuestionInput {
  text: string; blocks?: string | null | undefined; options: readonly AgentOption[]; sources?: readonly Evidence[] | undefined
  askedOfSub?: string | null | undefined; askedPart?: AskedPart | undefined; stage?: StageId | null | undefined
}

/** Record an agent's question (the record's current stage when none is given); returns its id. */
export function addAgentQuestion(db: DatabaseSync, by: Asker, q: QuestionInput, record: JourneyRecord | null): string {
  if (!record) throw new AgentFactError('This project has no journey yet: there is nowhere for a person to answer. Escalate in your report instead.')
  const options = checkOptions(q.options, { min: 2 })
  const text = q.text.trim()
  if (text.length < 10) throw new AgentFactError('Ask the question in a full sentence.')
  const id = newId('aq')
  db.prepare(`INSERT INTO agent_questions (id, asked_by, agent, asked_of_sub, asked_part, stage, text, blocks, options, sources, job_id, asked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, by.label, by.agent, q.askedOfSub ?? null, q.askedOfSub ? 'contributors' : q.askedPart ?? 'contributors', q.stage ?? record.journey.currentStage, text,
      q.blocks?.trim() || null, JSON.stringify(options), JSON.stringify((q.sources ?? []).map((s) => EvidenceSchema.parse(s))), by.jobId, now())
  return id
}

/** Record an agent's check of a criterion trace owns; refuses a person-owned or unknown criterion, and a met one without evidence. */
export function addCriterionCheck(db: DatabaseSync, by: Asker, c: { criterion: string; status: 'met' | 'not_met'; evidence: readonly Evidence[]; note?: string | undefined }, record: JourneyRecord | null): CriterionCheck {
  if (!record) throw new AgentFactError('This project has no journey yet, so it has no criteria to check.')
  const def = record.criteria.find((x) => x.id === c.criterion)
  if (!def) throw new AgentFactError(`There is no criterion called ${c.criterion} in this project (journey.status lists them).`)
  if (def.owner !== 'trace') throw new AgentFactError(`${c.criterion} is a person's to meet (${def.text}) — only their own act meets it. Ask them (journey.ask) if it blocks you.`)
  if (c.status === 'met' && !c.evidence.length) throw new AgentFactError('A met criterion needs its evidence: the run id, artifact or file that shows it.')
  const id = newId('cc')
  const t = now()
  db.prepare('INSERT INTO criterion_checks (id, criterion, status, evidence, note, checked_at, by, job_id, revision) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, c.criterion, c.status, JSON.stringify(c.evidence.map((e) => EvidenceSchema.parse(e))), c.note?.trim() || null, t, by.agent, by.jobId, record.journey.revision)
  return { id, criterion: c.criterion, status: c.status, evidence: [...c.evidence], checkedAt: t, by: by.agent, jobId: by.jobId, revision: record.journey.revision }
}

/** Record that an agent is stuck (options optional, but with one recommended when given); returns its id. */
export function addStuck(db: DatabaseSync, by: Asker, s: { why: string; recommendation: string; options?: readonly AgentOption[] | undefined; sources?: readonly Evidence[] | undefined }, record: JourneyRecord | null): string {
  const why = s.why.trim()
  const recommendation = s.recommendation.trim()
  if (why.length < 10) throw new AgentFactError('Say why you are stuck, in a full sentence.')
  if (recommendation.length < 5) throw new AgentFactError('Say what you recommend: every decision comes with trace\'s recommendation.')
  const options = checkOptions(s.options ?? [], { min: 0 })
  const id = newId('st')
  transaction(db, () => {
    // one open stuck per job: a newer one replaces it
    if (by.jobId) db.prepare("UPDATE stuck SET resolved_at=?, resolution='superseded' WHERE job_id=? AND resolved_at IS NULL").run(now(), by.jobId)
    db.prepare('INSERT INTO stuck (id, job_id, agent, agent_label, why, recommendation, options, sources, stage, at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, by.jobId, by.agent, by.label, why, recommendation, JSON.stringify(options), JSON.stringify((s.sources ?? []).map((e) => EvidenceSchema.parse(e))), record?.journey.currentStage ?? null, now())
  })
  return id
}

/** The agent moved on: its open stuck facts (of this job, or the one named) are resolved. Returns how many. */
export function resolveStuck(db: DatabaseSync, o: { id?: string | undefined; jobId?: string | null | undefined; resolution: string }): number {
  if (o.id) return Number(db.prepare('UPDATE stuck SET resolved_at=?, resolution=? WHERE id=? AND resolved_at IS NULL').run(now(), o.resolution, o.id).changes)
  if (o.jobId) return Number(db.prepare('UPDATE stuck SET resolved_at=?, resolution=? WHERE job_id=? AND resolved_at IS NULL').run(now(), o.resolution, o.jobId).changes)
  return 0
}

export const STAGE_ID = z.enum(STAGE_IDS)

// ------------------------------------------------------------------ where it is, from a session's environment

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/

/**
 * The central bucket at its `projects` prefix, and the project, for an agent's session: TRACE_PROJECT_HOME
 * (s3://<bucket>/projects/<slug>, the worker runtime's), else TRACE_HOME's sibling `projects` (s3://b/central →
 * s3://b/projects; a local TRACE_HOME → <TRACE_HOME>/projects). The project is TRACE_PROJECT, TRACE_MEMORY_REPOSITORY
 * or GITHUB_REPOSITORY. Null when either is unknown.
 */
export function projectsFromEnv(env: Record<string, string | undefined> = process.env): { projects: string; repository: string } | null {
  const repository = [env.TRACE_PROJECT, env.TRACE_MEMORY_REPOSITORY, env.GITHUB_REPOSITORY].map((r) => r?.trim()).find((r): r is string => Boolean(r && REPOSITORY.test(r)))
  if (!repository) return null
  const slug = projectSlug(repository)
  const home = env.TRACE_PROJECT_HOME?.trim().replace(/\/+$/, '')
  if (home) {
    // its own project's prefix only: a home for another project is not used
    if (!home.toLowerCase().endsWith(`/${slug}`)) return null
    return { projects: home.slice(0, -(slug.length + 1)), repository }
  }
  const central = env.TRACE_HOME?.trim().replace(/\/+$/, '')
  if (!central) return null
  const s3 = /^s3:\/\/([^/]+)(\/.*)?$/.exec(central)
  if (s3) {
    const parts = (s3[2] ?? '').split('/').filter(Boolean)
    parts.pop()
    return { projects: `s3://${s3[1]}/${[...parts, PROJECTS_PREFIX].join('/')}`, repository }
  }
  return { projects: `${central.replace(/^file:\/\//, '')}/${PROJECTS_PREFIX}`, repository }
}

/** The backend at a `projects` location (s3://…, file://… or a directory). */
export const projectsBackend = (location: string): Backend => backendFor(location)

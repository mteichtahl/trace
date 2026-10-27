/**
 * The journey tools (MCP: journey_status, journey_ask, journey_check, journey_stuck): what an agent contributes to its
 * project's journey, kept in the agents' own facts (src/core/agent-facts.ts, projects/<slug>/journey-agent/facts.db),
 * never in the journey record, which is people's: an agent can never sign, waive or answer for a person.
 *
 *   journey.status  the journey as it stands, with every agent's facts merged in: the current stage, the next step,
 *                   the gates of the stage with each criterion (who owns it, its status and evidence), the open
 *                   questions with their answers, the agents that are stuck
 *   journey.ask     ask a person (by Cognito sub) or the project's contributors or admins: what it blocks, the options
 *                   with exactly one recommended and a reason for each, the sources read. Answers the question id; with
 *                   wait_minutes it waits for the answer (read from the journey record), checking on a timer it
 *                   declares (a person's answer sends the worker no event), and says when it will look next
 *   journey.check   record a criterion trace owns as met or not met, with its evidence (a run id, an artifact, a file);
 *                   a person-owned criterion is refused. The newest check of a criterion supersedes the ones before
 *   journey.stuck   say the agent cannot go on: why, what it recommends, its options; or (resolved) that it moved on
 *
 * Where: the central bucket's `projects` prefix and the project, from the session's environment (TRACE_PROJECT_HOME
 * on the worker runtime, else TRACE_HOME; TRACE_PROJECT, TRACE_MEMORY_REPOSITORY or GITHUB_REPOSITORY). Who: the
 * agent (TRACE_AGENT, TRACE_AGENT_LABEL) and its job (TRACE_JOB_ID, else GITHUB_RUN_ID), which the job runner sets.
 * There is no argument that names a project or an agent. These tools are never offered through the API's `tool`
 * action (src/agents/runtime/tool.ts API_HIDDEN_TOOLS): people answer with question.answer and the other journey actions.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import {
  AgentFactError, AgentFactsStore, AgentOptionSchema, type Asker, addAgentQuestion, addCriterionCheck, addStuck, loadAgentFacts, projectsBackend,
  projectsFromEnv, resolveStuck,
} from '../../core/agent-facts.js'
import { type AgentFacts, EvidenceSchema, type JourneyRecord, JourneyError, journeyView, loadJourney, mergeAgentFacts } from '../../core/journey.js'
import { JourneyStore, JourneyStoreError } from '../../core/journey-store.js'
import { ToolError, defineTool } from '../../core/registry.js'
import { Work, findRoot, projectPath } from '../../core/store.js'
import { type WaitOutcome, waitWithTimer } from '../../core/wait.js'

const configured = (): boolean => projectsFromEnv() !== null

interface Scope { journey: JourneyStore; facts: AgentFactsStore; asker: Asker; repository: string }

/** The project, its stores and the agent, from the environment. */
export function journeyScope(env: Record<string, string | undefined> = process.env): Scope {
  const where = projectsFromEnv(env)
  if (!where) throw new ToolError('journey: no project in scope (TRACE_PROJECT_HOME or TRACE_HOME, and TRACE_PROJECT or GITHUB_REPOSITORY, are needed)')
  const store = projectsBackend(where.projects)
  const agent = (env.TRACE_AGENT || env.TRACE_MEMORY_AGENT || (env.GITHUB_ACTIONS === 'true' ? 'worker' : 'local')).trim().toLowerCase()
  const label = env.TRACE_AGENT_LABEL?.trim() || `the ${agent} agent`
  const jobId = env.TRACE_JOB_ID?.trim() || (env.GITHUB_RUN_ID ? `gh-${env.GITHUB_RUN_ID.trim()}` : null)
  return { journey: new JourneyStore(store, where.repository), facts: new AgentFactsStore(store, where.repository), asker: { agent, label, jobId }, repository: where.repository }
}

/** A refusal of the facts' own rules (or the stores'), as the agent's error. */
async function plainly<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof AgentFactError || e instanceof JourneyError || e instanceof JourneyStoreError) throw new ToolError(`journey: ${e.message}`)
    throw e
  }
}

const record = async (s: Scope): Promise<JourneyRecord | null> => (await s.journey.read((db) => loadJourney(db))).result
const facts = async (s: Scope): Promise<AgentFacts> => (await s.facts.read((db) => loadAgentFacts(db))).result

// ------------------------------------------------------------------ evidence an agent cites

const Evidence = EvidenceSchema.extend({
  kind: z.enum(['run', 'artifact', 'file', 'record', 'report', 'datasheet', 'kb']).describe('run (a run_id), artifact (run_id/name), file (a path in the repository), record, report, datasheet (part, sha256, page), kb (a knowledge-base path)'),
}).describe('{ kind, ref, label? }')

/** Runs and files are checked against the checkout: a run id that is not in its record, or a file that is not there, is refused. */
function checkEvidence(evidence: readonly z.output<typeof Evidence>[]): void {
  const root = findRoot()
  const db = projectPath()
  const runs = existsSync(db) ? new Work(db) : null
  try {
    for (const e of evidence) {
      if ((e.kind === 'run' || e.kind === 'artifact') && runs) {
        const [id = '', name] = e.kind === 'artifact' ? e.ref.split('/', 2) : [e.ref]
        const rec = runs.run(id)
        if (!rec) throw new ToolError(`journey: no run ${JSON.stringify(id)} in this checkout's record (trace.runs lists them)`)
        if (name && !rec.artifacts.some((a) => a.name === name)) throw new ToolError(`journey: run ${id} has no artifact ${JSON.stringify(name)}`)
      }
      if (e.kind === 'file' && root) {
        const full = resolve(root, e.ref)
        const rel = relative(root, full)
        if (isAbsolute(e.ref) || rel.startsWith('..')) throw new ToolError(`journey: ${e.ref}: a file is named by its path in the repository`)
        if (!existsSync(join(root, rel))) throw new ToolError(`journey: there is no file ${e.ref} in the checkout`)
      }
    }
  } finally {
    runs?.db.close()
  }
}

// ------------------------------------------------------------------ journey.status

export const status = defineTool({
  name: 'journey.status',
  description: 'The project\'s journey as it stands, with every agent\'s questions, checks and stuck notes merged in: the current stage, the one next step, the gates of the stage with each criterion (owner person or trace, status, evidence), open and answered questions, and agents that are stuck. Read this before journey.check or journey.ask.',
  input: z.object({
    question: z.string().min(1).max(40).optional().describe('only this question (its id from journey.ask), with its answer'),
  }),
  available: configured,
  run: async (a) => plainly(async () => {
    const s = journeyScope()
    const [r, f] = await Promise.all([record(s), facts(s)])
    if (!r) return { repository: s.repository, started: false, summary: 'This project has not started its journey yet: there are no gates or criteria to work towards.' }
    const merged = mergeAgentFacts(r, f)
    if (a.question) {
      const q = merged.questions.find((x) => x.id === a.question)
      if (!q) throw new ToolError(`journey: no question ${a.question} in this project`)
      return { question: answerOf(q) }
    }
    const v = journeyView(r, { hash: '', label: s.asker.label, admin: false, part: null }, undefined, f)
    const stage = v.current_stage
    return {
      repository: s.repository, started: true, template: v.template, revision: v.revision, stage,
      next: { kind: v.next.kind, belongs_to: v.next.belongs_to, summary: v.next.summary },
      gates: v.gates.filter((g) => g.stage === stage).map((g) => ({
        id: g.id, title: g.title, state: g.state, met: g.met, total: g.total,
        criteria: g.criteria.map((c) => ({ id: c.id, owner: c.owner, status: c.status, text: c.text, evidence: c.evidence, checked_at: c.checked_at })),
      })),
      questions: merged.questions.filter((q) => q.answeredAt === null || q.askedAt > Date.now() / 1000 - 7 * 86400).map(answerOf),
      later_stages: v.stages.filter((x) => x.state === 'queued').map((x) => x.id),
    }
  }),
})

interface Answer { answer: string | null; option: string | null; reason: string | null; by: string | null; at: string }
const answerOf = (q: JourneyRecord['questions'][number]): { id: string; kind: string; asked_by: string; text: string; blocks: string | null; job_id: string | null; asked_at: string; answered: Answer | null } => ({
  id: q.id, kind: q.kind, asked_by: q.askedBy, text: q.text, blocks: q.blocks, job_id: q.jobId, asked_at: new Date(q.askedAt * 1000).toISOString(),
  answered: q.answeredAt !== null ? { answer: q.answer, option: q.optionId, reason: q.answerReason, by: q.answeredBy, at: new Date(q.answeredAt * 1000).toISOString() } : null,
})

// ------------------------------------------------------------------ journey.ask

/** How a waiting journey.ask checks the journey record: a person's answer sends the worker no event. */
export const ASK_CHECK = { intervalMs: 30_000, factor: 2, maxIntervalMs: 5 * 60_000 }

export const ask = defineTool({
  name: 'journey.ask',
  description: 'Ask a person on the project a question you cannot answer from the record, the knowledge base or the datasheets, so it reaches them on Home, in the inbox and in chat (not only in an issue). Name what it blocks; offer 2 to 6 options with exactly one recommended and a reason for every option; cite what you already read. Ask one person by their Cognito sub when you know it, else the contributors (default) or the admins. Returns the question id; with wait_minutes, waits for the answer and returns it (or when trace will look next).',
  input: z.object({
    text: z.string().min(10).max(2000).describe('the question, in one or two plain sentences'),
    blocks: z.string().max(500).optional().describe('what it blocks, in words ("sizing the regulator"); leave out when it blocks nothing'),
    options: z.array(AgentOptionSchema).min(2).max(6).describe('the choices, exactly one with recommended: true; each with why'),
    sources: z.array(Evidence).max(20).default([]).describe('what you already read: runs, files, datasheets, knowledge-base passages'),
    ask: z.enum(['contributors', 'admins']).default('contributors').describe('who answers when no one is named: the contributors (admins too), or the admins (spend, sign-off calls)'),
    sub: z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'a Cognito sub').optional().describe('one person\'s Cognito sub, when you know who must answer'),
    wait_minutes: z.number().min(0).max(240).default(0).describe('wait this long for the answer (0: return at once with the question id)'),
  }),
  available: configured,
  run: async (a) => plainly(async () => {
    const s = journeyScope()
    checkEvidence(a.sources)
    const r = await record(s)
    const { result: id } = await s.facts.update((db) => ({
      result: addAgentQuestion(db, s.asker, { text: a.text, blocks: a.blocks, options: a.options, sources: a.sources, askedOfSub: a.sub ?? null, askedPart: a.ask }, r),
    }))
    const asked = { question_id: id, for: a.sub ? 'one person' : `the ${a.ask}` }
    if (!a.wait_minutes) return { ...asked, answered: null, next: `Asked. Read the answer later with journey.status { question: "${id}" }, or ask again with wait_minutes.` }
    const out = await waitForAnswer(s, id, a.wait_minutes * 60_000)
    return { ...asked, ...out }
  }),
})

/** Wait for a person's answer to question `id`, reading the journey record on the declared timer. */
export async function waitForAnswer(s: Pick<Scope, 'journey'>, id: string, ms: number, o: { sleep?: (ms: number, early: AbortSignal) => Promise<void>; now?: () => number } = {}): Promise<{ answered: Answer | null; next: string; next_check_at?: string | null }> {
  let lastNext: string | null = null
  const outcome: WaitOutcome<Answer> = await waitWithTimer<Answer>({
    what: `a person's answer to question ${id}`,
    why: 'a person answers in the web app, which sends the worker no event; trace reads the journey record instead',
    intervalMs: ASK_CHECK.intervalMs, factor: ASK_CHECK.factor, maxIntervalMs: ASK_CHECK.maxIntervalMs,
    deadlineAt: (o.now ?? Date.now)() + ms,
    ...(o.sleep ? { sleep: o.sleep } : {}), ...(o.now ? { now: o.now } : {}),
    report: (n) => { lastNext = n.nextCheckAt },
    check: async () => {
      const q = (await s.journey.read((db) => loadJourney(db)?.questions.find((x) => x.id === id) ?? null)).result
      const answered = q ? answerOf(q).answered : null
      if (answered) return { done: true, value: answered, state: 'answered' }
      return { done: false, state: 'not answered yet' }
    },
  })
  if (outcome.done) return { answered: outcome.value, next: 'Answered: carry on with it, and cite the question id where you act on it.' }
  const after = new Date((o.now ?? Date.now)() + ASK_CHECK.maxIntervalMs).toISOString()
  return {
    answered: null, next_check_at: lastNext ?? after,
    next: `Not answered within ${Math.round(ms / 60_000)} minutes. Carry on with what it does not block, read it later with journey.status { question: "${id}" }, or end your report with what waits on it. Never take the recommended option as the answer.`,
  }
}

// ------------------------------------------------------------------ journey.check

export const check = defineTool({
  name: 'journey.check',
  description: 'Record a gate criterion that trace owns as met or not met, with the evidence that shows it (a run id from this job, an artifact, a file). Only criteria with owner "trace" (journey.status lists them); a person\'s criteria are met only by their own acts. Check again whenever the evidence changes: the newest check of a criterion stands.',
  input: z.object({
    criterion: z.string().regex(/^[a-z][a-z.]*\.[a-z]+$/, 'a criterion id such as capture.erc').describe('the criterion id, e.g. capture.erc'),
    status: z.enum(['met', 'not_met']),
    evidence: z.array(Evidence).max(20).default([]).describe('what shows it: at least one run, artifact or file for met'),
    note: z.string().max(1000).optional().describe('one line on what was measured, with the number and unit'),
  }),
  available: configured,
  run: async (a) => plainly(async () => {
    const s = journeyScope()
    checkEvidence(a.evidence)
    const r = await record(s)
    const { result } = await s.facts.update((db) => ({ result: addCriterionCheck(db, s.asker, { criterion: a.criterion, status: a.status, evidence: a.evidence, note: a.note }, r) }))
    // what the gate looks like with it
    const f = await facts(s)
    const gate = r ? journeyView(r, { hash: '', label: s.asker.label, admin: false, part: null }, undefined, f).gates.find((g) => g.criteria.some((c) => c.id === a.criterion)) : undefined
    return {
      check_id: result.id, criterion: a.criterion, status: a.status,
      ...(gate ? { gate: { id: gate.id, state: gate.state, met: gate.met, total: gate.total } } : {}),
      next: gate?.state === 'ready' ? 'Every criterion of the gate is met or waived: an admin is told it is ready to sign.' : 'Recorded.',
    }
  }),
})

// ------------------------------------------------------------------ journey.stuck

export const stuck = defineTool({
  name: 'journey.stuck',
  description: 'Say you cannot go on, so the contributors see it at once (Home, inbox): why, what you recommend, and the options when there is a choice (exactly one recommended, a reason each). Use it with the ESCALATE line of your report, not instead of it. resolved: true says you moved on.',
  input: z.object({
    why: z.string().max(2000).optional().describe('why you are stuck, with the evidence (run ids, files)'),
    recommendation: z.string().max(1000).optional().describe('what you recommend a person does'),
    options: z.array(AgentOptionSchema).max(6).default([]).describe('the choices, exactly one recommended, when there is a choice'),
    sources: z.array(Evidence).max(20).default([]),
    resolved: z.boolean().default(false).describe('true: this job is no longer stuck'),
  }),
  available: configured,
  run: async (a) => plainly(async () => {
    const s = journeyScope()
    if (a.resolved) {
      const { result: n } = await s.facts.update((db) => { const n = resolveStuck(db, { jobId: s.asker.jobId, resolution: 'the agent moved on' }); return { result: n, changed: n > 0 } })
      return { resolved: n, next: n ? 'Marked as moving again.' : 'Nothing of this job was stuck.' }
    }
    if (!a.why || !a.recommendation) throw new ToolError('journey.stuck: give why and recommendation (or resolved: true)')
    checkEvidence(a.sources)
    const r = await record(s)
    const { result: id } = await s.facts.update((db) => ({ result: addStuck(db, s.asker, { why: a.why!, recommendation: a.recommendation!, options: a.options, sources: a.sources }, r) }))
    return { stuck_id: id, next: 'The contributors see it now. Finish with your report (ESCALATE: …); a person\'s answer reaches the next job.' }
  }),
})

export const tools = [status, ask, check, stuck]

/**
 * The journey tools (MCP: journey_status, journey_ask, journey_check, journey_stuck): what an agent contributes to its
 * project's journey, kept in the agents' own facts (src/core/agent-facts.ts, projects/<slug>/journey-agent/facts.db),
 * never in the journey record, which is people's: an agent can never sign, waive or answer for a person.
 *
 *   journey.status  the journey as it stands, with every agent's facts merged in: the current stage, the next step,
 *                   the gates of the stage with each criterion (who owns it, its status and evidence), the open
 *                   questions with their answers, the agents that are stuck, and the stuck reports a person dismissed
 *                   (stuck.dismiss) with the reason, so the agent knows to stop waiting on them and why
 *   journey.ask     ask a person (by Cognito sub) or the project's contributors or admins: what it blocks, the options
 *                   with exactly one recommended and a reason for each, the sources read. Answers the question id; with
 *                   wait_minutes it waits for the answer (read from the journey record). On events where the project
 *                   has its events topic (TRACE_BATCH_EVENTS_TOPIC, nested layout): a person's answer is a write of
 *                   projects/<slug>/journey/journey.db, whose S3 "Object Created" event an EventBridge rule sends to
 *                   that topic (src/infra/project.ts JourneyEventsRule); a short-lived queue of this wait's own
 *                   (src/gpu/batch.ts openWaitQueue) receives it, and the record is read once per write. In case a
 *                   message is lost it also reads the record 30 s and 90 s after subscribing, then every 5 minutes.
 *                   Without the topic, or when subscribing fails, it reads the record on a timer (30 s, doubling to
 *                   5 minutes). Either way it says when it will look next
 *   journey.check   record a criterion trace owns as met or not met, with its evidence (a run id, an artifact, a file);
 *                   a person-owned criterion is refused. The newest check of a criterion supersedes the ones before
 *   journey.stuck   say the agent cannot go on: why, what it recommends, its options; or (resolved) that it moved on
 *   journey.handoff a specialist asks another for something in that one's area, as a recorded request
 *                   (src/core/handoffs.ts: the quality bar and the guards are checked before anything is written): the
 *                   request goes into the agents' facts, then this runtime starts the asked specialist as a queued job
 *                   of the project (POST /handoff on loopback with the job's token: src/agents/runtime/handoff.ts). It
 *                   does not wait by default (the answer is recorded for the asker's next job: journey.status lists the
 *                   hand-offs it raised); with wait_minutes it waits as journey.ask does: on the project's events (the
 *                   same rule sends the topic the writes of the agents' facts, where the answer is written, and of the
 *                   journey record, where a decline is), reading once per write, or on its declared timer.
 *                   The asker's queue slot is never held beyond wait_minutes: the receiving job has a slot of its own
 *   journey.handoff_answer  the job a hand-off started answers it, once: only that job (TRACE_HANDOFF_ID and its job
 *                   id) may. Or says it cannot be answered, and why
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
import { randomBytes } from 'node:crypto'
import { type WaitOutcome, trackEventWait, waitWithTimer } from '../../core/wait.js'
import { type SnsApi, type SqsApi, SAFETY_CHECK_MS, WARMUP_CHECKS_MS, openWaitQueue, staleAfterMs, waitQueueName } from '../../gpu/batch.js'
import { SPECIALIST_KINDS, SPECIALIST_WORDS, type SpecialistKind } from '../../agents/kinds.js'
import {
  DEFAULT_LIMITS, type HandoffAsker, HandoffError, type HandoffView, type Limits, addHandoff, answerHandoff, checkRequest, handoffViews, loadDeclines, loadHandoffs,
  markFailed, nextFor,
} from '../../core/handoffs.js'
import { JobIndexStore, indexedHandle, loadJobs } from '../../core/job-index.js'

const configured = (): boolean => projectsFromEnv() !== null

interface Scope { journey: JourneyStore; facts: AgentFactsStore; jobs: JobIndexStore; asker: Asker; repository: string }

/** The project, its stores and the agent, from the environment. */
export function journeyScope(env: Record<string, string | undefined> = process.env): Scope {
  const where = projectsFromEnv(env)
  if (!where) throw new ToolError('journey: no project in scope (TRACE_PROJECT_HOME or TRACE_HOME, and TRACE_PROJECT or GITHUB_REPOSITORY, are needed)')
  const store = projectsBackend(where.projects)
  const agent = (env.TRACE_AGENT || env.TRACE_MEMORY_AGENT || (env.GITHUB_ACTIONS === 'true' ? 'worker' : 'local')).trim().toLowerCase()
  const label = env.TRACE_AGENT_LABEL?.trim() || `the ${agent} agent`
  const jobId = env.TRACE_JOB_ID?.trim() || (env.GITHUB_RUN_ID ? `gh-${env.GITHUB_RUN_ID.trim()}` : null)
  return {
    journey: new JourneyStore(store, where.repository), facts: new AgentFactsStore(store, where.repository), jobs: new JobIndexStore(store, where.repository),
    asker: { agent, label, jobId }, repository: where.repository,
  }
}

/** A refusal of the facts' own rules (or the stores'), as the agent's error. */
async function plainly<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof AgentFactError || e instanceof JourneyError || e instanceof JourneyStoreError || e instanceof HandoffError) throw new ToolError(`journey: ${e.message}`)
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
    handoff: z.string().regex(/^ho[0-9a-f]{14}$/, 'a hand-off id').optional().describe('only this hand-off (its id from journey.handoff), with its answer'),
  }),
  available: configured,
  run: async (a) => plainly(async () => {
    const s = journeyScope()
    if (a.handoff) {
      const v = (await handoffsNow(s)).find((x) => x.id === a.handoff)
      if (!v) throw new ToolError(`journey: no hand-off ${a.handoff} in this project`)
      return { handoff: forAsker(v) }
    }
    const [r, f, hs] = await Promise.all([record(s), facts(s), handoffsNow(s)])
    // the hand-offs this specialist raised (in any job: the answer reaches its next one), open or from the last week,
    // and the one this job answers
    const week = Date.now() / 1000 - 7 * 86400
    const answering = answeringHandoff()
    const handoffs = {
      raised: hs.filter((v) => v.from === s.asker.agent && (!ENDED.has(v.state) || Date.parse(v.created_at) / 1000 > week)).map(forAsker),
      ...(answering ? { answering: hs.filter((v) => v.id === answering).map((v) => ({ id: v.id, from: v.from, from_name: v.from_name, question: v.question, acceptance: v.acceptance, state: v.state })) } : {}),
    }
    if (!r) return { repository: s.repository, started: false, summary: 'This project has not started its journey yet: there are no gates or criteria to work towards.', handoffs }
    const merged = mergeAgentFacts(r, f)
    if (a.question) {
      const q = merged.questions.find((x) => x.id === a.question)
      if (!q) throw new ToolError(`journey: no question ${a.question} in this project`)
      return { question: answerOf(q, r) }
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
      questions: merged.questions.filter((q) => q.kind === 'question' && (q.answeredAt === null || q.askedAt > Date.now() / 1000 - 7 * 86400)).map((q) => answerOf(q, r)),
      stuck: merged.questions.filter((q) => q.kind === 'stuck' && (q.answeredAt === null || q.askedAt > Date.now() / 1000 - 7 * 86400)).map((q) => answerOf(q, r)),
      later_stages: v.stages.filter((x) => x.state === 'queued').map((x) => x.id),
      handoffs,
    }
  }),
})

interface Answer { answer: string | null; option: string | null; reason: string | null; by: string | null; at: string }
interface Dismissed { reason: string; by: string; at: string }
const answerOf = (q: JourneyRecord['questions'][number], r?: JourneyRecord): { id: string; kind: string; asked_by: string; text: string; blocks: string | null; job_id: string | null; asked_at: string; answered: Answer | null; dismissed?: Dismissed } => {
  const d = q.kind === 'stuck' ? r?.dismissals?.find((x) => x.stuckId === q.id) : undefined
  return {
    id: q.id, kind: q.kind, asked_by: q.askedBy, text: q.text, blocks: q.blocks, job_id: q.jobId, asked_at: new Date(q.askedAt * 1000).toISOString(),
    answered: q.answeredAt !== null ? { answer: q.answer, option: q.optionId, reason: q.answerReason, by: q.answeredBy, at: new Date(q.answeredAt * 1000).toISOString() } : null,
    // a person dismissed this stuck report: the agent stops waiting on it and acts on the reason
    ...(d ? { dismissed: { reason: d.reason, by: d.by, at: new Date(d.at * 1000).toISOString() } } : {}),
  }
}

// ------------------------------------------------------------------ journey.ask

/** How a waiting journey.ask checks the journey record where no event reaches it (no events topic, or subscribing failed). */
export const ASK_CHECK = { intervalMs: 30_000, factor: 2, maxIntervalMs: 5 * 60_000 }
/** What a journey-record write looks like on the project's topic (an S3 event through EventBridge, delivered raw). */
export const JOURNEY_WRITE_FILTER = { source: ['aws.s3'], 'detail-type': ['Object Created'] }

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
    const out = await waitForAnswer(s, id, a.wait_minutes * 60_000, { events: eventsOf(process.env, s.repository) })
    return { ...asked, ...out }
  }),
})

/** Where a person's answer arrives as an event: the project's own topic and the wait queue's name (null: none here). */
export interface AnswerEvents { topic: string; queueName: string; project: string; sqs?: SqsApi | undefined; sns?: SnsApi | undefined; staleMs?: number | undefined }

/** The events of this project, from the worker's environment: null without TRACE_BATCH_EVENTS_TOPIC (a flat layout,
 * an older stack, a laptop) or when the topic is not this project's. */
export function eventsOf(env: Record<string, string | undefined>, repository: string): AnswerEvents | null {
  const topic = env.TRACE_BATCH_EVENTS_TOPIC?.trim()
  if (!topic) return null
  // a queue of this wait's own: two waits on one question (two jobs) never share one
  const queueName = waitQueueName(topic, repository, `ask-${randomBytes(4).toString('hex')}`)
  return queueName ? { topic, queueName, project: repository.toLowerCase(), staleMs: staleAfterMs(env as NodeJS.ProcessEnv) } : null
}

interface WaitOptions {
  sleep?: (ms: number, early: AbortSignal) => Promise<void>
  now?: () => number
  /** wait on the project's events (null or absent: on the timer) */
  events?: AnswerEvents | null | undefined
  log?: (line: string) => void
}

type AnswerWait = { answered: Answer | null; next: string; next_check_at?: string | null; waited_on?: 'events' | 'timer'; why_timer?: string }

const readAnswer = async (s: Pick<Scope, 'journey'>, id: string): Promise<Answer | null> => {
  const q = (await s.journey.read((db) => loadJourney(db)?.questions.find((x) => x.id === id) ?? null)).result
  return q ? answerOf(q).answered : null
}

const notAnswered = (id: string, ms: number): string =>
  `Not answered within ${Math.round(ms / 60_000)} minutes. Carry on with what it does not block, read it later with journey.status { question: "${id}" }, or end your report with what waits on it. Never take the recommended option as the answer.`

/** What one wait is for: what it waits on (in words), how to read it, and what to say when it comes or does not. */
interface Watch<T> {
  what: string
  read: () => Promise<T | null>
  /** said when it came */
  came: string
  /** said when the wait is over without it */
  missed: (ms: number) => string
}

type Waited<T> = { value: T | null; next: string; next_check_at?: string | null; waited_on?: 'events' | 'timer'; why_timer?: string }

/** Wait for a person's answer to question `id`: on the project's events where it has them, else on the declared timer. */
export async function waitForAnswer(s: Pick<Scope, 'journey'>, id: string, ms: number, o: WaitOptions = {}): Promise<AnswerWait> {
  const { value, ...rest } = await waitFor<Answer>({
    what: `a person's answer to question ${id}`, read: () => readAnswer(s, id),
    came: 'Answered: carry on with it, and cite the question id where you act on it.', missed: (m) => notAnswered(id, m),
  }, ms, { ...o, log: o.log ?? ((line: string) => { process.stderr.write(`journey.ask: ${line}\n`) }) })
  return { answered: value, ...rest }
}

/** Wait for `w` on the project's events where it has them (a write of its journey record, job index or facts), else on the declared timer. */
async function waitFor<T>(w: Watch<T>, ms: number, o: WaitOptions): Promise<Waited<T>> {
  const now = o.now ?? Date.now
  const log = o.log ?? ((line: string) => { process.stderr.write(`journey: ${line}\n`) })
  const deadline = now() + ms
  let why = 'this project sends the worker no event when its journey record changes (no events topic: an older or flat installation)'
  if (o.events) {
    const out = await waitOnEvents(w, ms, o.events, { now, log })
    if (!('why' in out)) return out
    why = out.why
    log(`waiting on a timer: ${why}`)
  }
  // the timer carries on for what is left of the wait
  return { ...(await waitOnTimer(w, Math.max(0, deadline - now()), why, o)), waited_on: 'timer', why_timer: why }
}

/** The event wait: told of every write of the project's records, read once per write, with a few safety reads. */
async function waitOnEvents<T>(w: Watch<T>, ms: number, e: AnswerEvents, c: { now: () => number; log: (line: string) => void }): Promise<Waited<T> | { why: string }> {
  const { now, log } = c
  const deadline = now() + ms
  let queue: Awaited<ReturnType<typeof openWaitQueue>>
  try {
    queue = await openWaitQueue({
      topic: e.topic, queueName: e.queueName, sweepPrefix: e.queueName.slice(0, e.queueName.indexOf('-wait-') + '-wait-'.length), project: e.project,
      filterPolicy: JOURNEY_WRITE_FILTER, sqs: e.sqs, sns: e.sns, now, staleMs: e.staleMs ?? staleAfterMs({}), log,
    })
  } catch (err) {
    return { why: `setting up its event subscription failed (${err instanceof Error ? err.message : String(err)})` }
  }
  const wait = trackEventWait({ what: w.what, state: 'not answered yet', now })
  try {
    // the one read that closes the gap before the subscription existed
    let got = await w.read()
    if (got !== null) return { value: got, next: w.came, waited_on: 'events' }
    const subscribedAt = now()
    const warmups = WARMUP_CHECKS_MS.map((x) => subscribedAt + x)
    let nextSafety = warmups.shift() ?? subscribedAt + SAFETY_CHECK_MS
    log(`waiting for ${w.what}: told when the journey record changes; in case a message is lost, also reading it ${WARMUP_CHECKS_MS.map((x) => `${x / 1000} seconds`).join(' and ')} after subscribing, then every ${Math.round(SAFETY_CHECK_MS / 60_000)} minutes (next at ${new Date(nextSafety).toISOString()})`)
    for (;;) {
      const t = now()
      if (t >= deadline) {
        got = await w.read()
        if (got !== null) return { value: got, next: w.came, waited_on: 'events' }
        return { value: null, next_check_at: null, waited_on: 'events', next: `${w.missed(ms)} (trace was waiting on the project's change events; no further check is planned.)` }
      }
      let look = t >= nextSafety
      if (!look) {
        const waitS = Math.max(1, Math.min(20, Math.ceil((Math.min(nextSafety, deadline) - t) / 1000)))
        try {
          look = (await queue.receive(waitS)).length > 0
        } catch (err) {
          return { why: `receiving its events failed (${err instanceof Error ? err.message : String(err)})` }
        }
      } else {
        nextSafety = warmups.shift() ?? now() + SAFETY_CHECK_MS
      }
      if (!look) continue
      got = await w.read()
      if (got !== null) {
        wait.update('answered')
        return { value: got, next: w.came, waited_on: 'events' }
      }
    }
  } finally {
    wait.end()
    await queue.close()
  }
}

/** The timer wait: read on the declared timer (ASK_CHECK), saying why there is no event. */
async function waitOnTimer<T>(w: Watch<T>, ms: number, why: string, o: WaitOptions): Promise<Waited<T>> {
  let lastNext: string | null = null
  const outcome: WaitOutcome<T> = await waitWithTimer<T>({
    what: w.what,
    why,
    intervalMs: ASK_CHECK.intervalMs, factor: ASK_CHECK.factor, maxIntervalMs: ASK_CHECK.maxIntervalMs,
    deadlineAt: (o.now ?? Date.now)() + ms,
    ...(o.sleep ? { sleep: o.sleep } : {}), ...(o.now ? { now: o.now } : {}),
    report: (n) => { lastNext = n.nextCheckAt },
    check: async () => {
      const got = await w.read()
      if (got !== null) return { done: true, value: got, state: 'answered' }
      return { done: false, state: 'not answered yet' }
    },
  })
  if (outcome.done) return { value: outcome.value, next: w.came }
  const after = new Date((o.now ?? Date.now)() + ASK_CHECK.maxIntervalMs).toISOString()
  return { value: null, next_check_at: lastNext ?? after, next: w.missed(ms) }
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

// ------------------------------------------------------------------ hand-offs between specialists (src/core/handoffs.ts)

/** Where a specialist's hand-off is started: this runtime (loopback) and its job's token. Null: not offered. */
export interface HandoffEnv { url: string; token: string; enabled: SpecialistKind[]; limits: Limits }

export function handoffEnv(env: Record<string, string | undefined> = process.env): HandoffEnv | null {
  const url = env.TRACE_HANDOFF_URL?.trim()
  const token = env.TRACE_HANDOFF_TOKEN?.trim()
  if (!url || !token) return null
  const enabled = (env.TRACE_HANDOFF_ENABLED ?? '').split(',').map((x) => x.trim()).filter((x): x is SpecialistKind => (SPECIALIST_KINDS as readonly string[]).includes(x))
  const [job, project] = (env.TRACE_HANDOFF_LIMITS ?? '').split(',').map((x) => Number(x))
  const limits: Limits = { perJob: Number.isInteger(job) ? job as number : DEFAULT_LIMITS.perJob, perProject: Number.isInteger(project) ? project as number : DEFAULT_LIMITS.perProject }
  return { url: url.replace(/\/+$/, ''), token, enabled: enabled.length ? enabled : [...SPECIALIST_KINDS], limits }
}

/** The environment the runner gives an asking specialist's MCP server (handoffEnv reads it back). */
export function handoffAskEnv(o: { url: string; token: string; enabled: readonly string[]; limits: Limits }): Record<string, string> {
  return { TRACE_HANDOFF_URL: o.url, TRACE_HANDOFF_TOKEN: o.token, TRACE_HANDOFF_ENABLED: o.enabled.join(','), TRACE_HANDOFF_LIMITS: `${o.limits.perJob},${o.limits.perProject}` }
}

/** The hand-off this job answers (TRACE_HANDOFF_ID, which the runner sets for a job a hand-off started), or null. */
export const answeringHandoff = (env: Record<string, string | undefined> = process.env): string | null => env.TRACE_HANDOFF_ID?.trim() || null

const Started = z.object({ accepted: z.boolean(), jobId: z.string(), reason: z.string().optional() }).loose()
const ErrorBody = z.object({ error: z.string() }).loose()

/** Ask this runtime to start the receiving job (src/agents/runtime/handoff.ts). */
async function startReceiver(e: HandoffEnv, id: string): Promise<z.infer<typeof Started>> {
  let r: Response
  try {
    r = await fetch(`${e.url}/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: e.token, id }) })
  } catch (err) {
    throw new ToolError(`journey.handoff: the runtime could not be reached (${err instanceof Error ? err.message : String(err)})`)
  }
  const body: unknown = await r.json().catch(() => ({}))
  if (!r.ok) throw new ToolError(`journey.handoff: ${ErrorBody.safeParse(body).data?.error ?? `the runtime answered ${r.status}`}`)
  return Started.parse(body)
}

/** The project's hand-offs as views, with people's declines and the job index's states (an index that cannot be read: none). */
async function handoffsNow(s: Scope): Promise<HandoffView[]> {
  const [f, d, jobs] = await Promise.all([
    s.facts.read((db) => loadHandoffs(db)).then((x) => x.result),
    s.journey.read((db) => loadDeclines(db)).then((x) => x.result),
    s.jobs.read((db) => loadJobs(db)).then((x) => x.result).catch(() => []),
  ])
  return handoffViews(f, d, new Map(jobs.map((j) => [j.id, { state: j.state, handle: indexedHandle(s.repository, j.session, j.id) }])))
}

const ENDED: ReadonlySet<string> = new Set(['answered', 'unanswered', 'declined', 'failed'])

/** A hand-off as its asker reads it: the request in short, where it stands, the answer, and what to do. */
const forAsker = (v: HandoffView): Record<string, unknown> => ({
  id: v.id, to: v.to, to_name: v.to_name, question: v.question, state: v.state, says: v.says, asked_at: v.created_at,
  job_id: v.job?.id ?? null, answer: v.answer, declined: v.declined, why: v.why, next: nextFor(v),
})

export const handoff = defineTool({
  name: 'journey.handoff',
  description: 'Ask another specialist for something in its area that blocks or materially changes your work, as a recorded request: it runs as a queued job of the project, answers with its evidence, and the answer is recorded for you (journey.status lists it). Give the question in plain words, the evidence (run ids, files, datasheet pages), what it blocks, your recommended answer if you have one, and acceptance (what a good answer contains). A vague request is refused with what is missing. By default you do not wait; wait_minutes waits for the answer. Not for what you can do yourself, nor for a decision only a person can make (journey.ask).',
  input: z.object({
    to: z.enum(SPECIALIST_KINDS).describe('the specialist asked: verify, impl, ams, emc, render or thermal (never yourself)'),
    question: z.string().max(4000).describe('the question or task, in plain words, naming the part, net, block or figure it is about'),
    evidence: z.array(Evidence).max(20).default([]).describe('what to start from: run ids, files, artifacts, datasheet pages (part, sha256, page)'),
    blocks: z.string().max(1000).default('').describe('what it blocks in your work, in words'),
    recommendation: z.string().max(2000).optional().describe('the answer you would give, if you have one, for them to confirm or correct'),
    acceptance: z.array(z.string().max(1000)).max(10).default([]).describe('what a good answer contains, one item each (the figure, its unit, the run that shows it)'),
    wait_minutes: z.number().min(0).max(120).default(0).describe('wait this long for the answer (0, the default: record it and carry on; the answer reaches your next job)'),
  }),
  available: () => configured() && handoffEnv() !== null,
  run: async (a) => plainly(async () => {
    const s = journeyScope()
    const e = handoffEnv()
    if (!e) throw new ToolError('journey.handoff is offered to specialists on the trace runtime only')
    if (!s.asker.jobId) throw new ToolError('journey.handoff: a hand-off is raised from a job')
    const request = { to: a.to, question: a.question, evidence: a.evidence, blocks: a.blocks, recommendation: a.recommendation, acceptance: a.acceptance }
    // the quality bar first (nothing read or written for a vague request), then the evidence against the checkout
    checkRequest(request)
    checkEvidence(a.evidence)
    const declined = new Set((await s.journey.read((db) => loadDeclines(db))).result.map((d) => d.handoffId))
    const handoffOf = answeringHandoff()
    const asker: HandoffAsker = { agent: s.asker.agent, label: s.asker.label, jobId: s.asker.jobId, handoff: handoffOf ? { id: handoffOf, from: '' } : null }
    const { result: h } = await s.facts.update((db) => ({ result: addHandoff(db, asker, request, { enabled: e.enabled, limits: e.limits, declined }) }))
    let started: z.infer<typeof Started>
    try {
      started = await startReceiver(e, h.id)
    } catch (err) {
      // the runtime marks one it could not start; one it never heard of is closed here, so nobody waits on it
      await s.facts.update((db) => { const n = markFailed(db, h.id, `its job could not be started (${err instanceof Error ? err.message : String(err)})`); return { result: n, changed: n } })
      throw err
    }
    const base = { handoff_id: h.id, to: h.toKind, to_name: SPECIALIST_WORDS[h.toKind], job_id: started.accepted ? started.jobId : null }
    if (!started.accepted) {
      return { ...base, state: 'failed', next: `Its job was not started (${started.reason ?? 'refused'}). Do not ask again: ask a person with journey.ask if it still blocks you.` }
    }
    if (!a.wait_minutes) {
      return { ...base, state: 'queued', answer: null, next: `Recorded and queued for the ${SPECIALIST_WORDS[h.toKind]} specialist. Carry on with what it does not block; its answer is recorded for your next job (journey.status), or read it with journey.status { handoff: "${h.id}" }.` }
    }
    const out = await waitForHandoff(s, h.id, a.wait_minutes * 60_000, { events: eventsOf(process.env, s.repository) })
    return { ...base, ...out }
  }),
})

/** Wait for hand-off `id` to end (answered, unanswered, declined or failed), on the project's events where it has them. */
export async function waitForHandoff(s: Scope, id: string, ms: number, o: WaitOptions = {}): Promise<Record<string, unknown>> {
  const { value, next, ...rest } = await waitFor<HandoffView>({
    what: `the answer to hand-off ${id}`,
    read: async () => (await handoffsNow(s)).find((v) => v.id === id && ENDED.has(v.state)) ?? null,
    came: '', missed: (m) => `Not answered within ${Math.round(m / 60_000)} minutes. Carry on with what it does not block; the answer is recorded for your next job (journey.status { handoff: "${id}" }). Never take your own recommendation as its answer.`,
  }, ms, { ...o, log: o.log ?? ((line: string) => { process.stderr.write(`journey.handoff: ${line}\n`) }) })
  if (value) return { ...forAsker(value), ...rest }
  const now = (await handoffsNow(s)).find((v) => v.id === id)
  return { state: now?.state ?? 'queued', answer: null, next, ...rest }
}

export const handoffAnswer = defineTool({
  name: 'journey.handoff_answer',
  description: 'Answer the hand-off this job was started for, once: the answer in plain words with numbers and units, its evidence (run ids of this job, files, datasheet pages), your confidence (0 to 1), and whether every acceptance item is met (and which is not). If you cannot answer it, answered: false with why and what would be needed. Only the job started for the hand-off may answer it.',
  input: z.object({
    handoff: z.string().regex(/^ho[0-9a-f]{14}$/, 'a hand-off id').describe('the hand-off id, from THE JOB'),
    answered: z.boolean().default(true).describe('false: you cannot answer it (say why in answer)'),
    answer: z.string().max(8000).describe('the answer, or why it cannot be answered and what would be needed'),
    evidence: z.array(Evidence).max(20).default([]).describe('what the answer rests on: run ids, files, datasheet pages'),
    confidence: z.number().min(0).max(1).optional().describe('0 to 1'),
    acceptance_met: z.boolean().optional().describe('true when every acceptance item of the request is met'),
    unmet: z.string().max(2000).optional().describe('which acceptance item is not met, and why'),
  }),
  available: () => configured() && answeringHandoff() !== null,
  run: async (a) => plainly(async () => {
    const s = journeyScope()
    const mine = answeringHandoff()
    if (!mine || mine !== a.handoff) throw new ToolError(`journey.handoff_answer: this job answers ${mine ? `hand-off ${mine}` : 'no hand-off'}, not ${a.handoff}`)
    checkEvidence(a.evidence)
    const { result: h } = await s.facts.update((db) => ({
      result: answerHandoff(db, a.handoff, s.asker.jobId, { answered: a.answered, text: a.answer, evidence: a.evidence, confidence: a.confidence, acceptanceMet: a.acceptance_met, unmet: a.unmet }),
    }))
    return {
      handoff_id: h.id, state: h.state,
      next: h.state === 'answered'
        ? `Recorded: the ${h.fromLabel} reads it. Finish your report; do not do its work.`
        : `Recorded as not answerable: the ${h.fromLabel} is told why and may ask a person. Finish your report.`,
    }
  }),
})

export const tools = [status, ask, check, stuck, handoff, handoffAnswer]

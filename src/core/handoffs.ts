/**
 * Recorded hand-offs between specialists: one specialist asks another for something in that one's area, in writing,
 * and the answer is written down too. Nothing is a direct call between agents: the request is a row of the agents'
 * facts (projects/<slug>/journey-agent/facts.db, table `handoffs`, src/core/agent-facts.ts), the receiving specialist
 * runs as an ordinary queued job of the project (src/agents/runtime/handoff.ts starts it), and its answer is a row too.
 * People see every hand-off and may decline a pending one (handoff.decline, in the journey record: they never write the
 * agents' facts).
 *
 *   request   asked with journey.handoff (src/tools/journey/tools.ts) by a specialist in a job: the specialist asked
 *             (an enabled one, never itself), the question in plain words, the evidence (runs, files, artifacts,
 *             datasheet pages), what it blocks, the asker's recommended answer when it has one, and acceptance (what a
 *             good answer contains). checkRequest refuses a vague one with everything that is missing, before anything
 *             is written
 *   guards    checkGuards, on the same write as the row, so two hand-offs raised together cannot both take the last
 *             place: depth 1 (a job started by a hand-off raises none, so A→B→A cannot happen), never to the asking
 *             specialist itself, at most agents.handoff_max_per_job open hand-offs per asking job and
 *             agents.handoff_max_per_project per project, and never the same question again to a specialist that
 *             declined, failed or could not answer it (the asker asks a person instead: journey.ask)
 *   answer    journey.handoff_answer, by the job started for that hand-off only (answerHandoff checks the job id): the
 *             answer, its evidence, a confidence, whether the acceptance is met (and what is not); or that it cannot be
 *             answered, and why
 *   states    stored: requested (written, its job not started yet), started (its job is queued or running), answered,
 *             unanswered (the receiver said why it cannot answer), failed (its job could not start, or ended without
 *             an answer). People and agents read a view state (handoffViews): requested, queued, running, answered,
 *             unanswered, declined (a person declined it), failed
 *
 * Pure except for the SQLite handle: the rules and views are tested on their own.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { SPECIALIST_KINDS, SPECIALIST_WORDS, type SpecialistKind } from '../agents/kinds.js'
import { type Evidence, EvidenceSchema, VAGUE, decide } from './journey.js'
import { transaction } from './store.js'

export class HandoffError extends Error {
  override name = 'HandoffError'
}

export const HANDOFF_STATES = ['requested', 'started', 'answered', 'unanswered', 'failed'] as const
export type HandoffState = (typeof HANDOFF_STATES)[number]
export const HANDOFF_VIEW_STATES = ['requested', 'queued', 'running', 'answered', 'unanswered', 'declined', 'failed'] as const
export type HandoffViewState = (typeof HANDOFF_VIEW_STATES)[number]

/** A job started by a hand-off is at depth 1; it may raise none (guard 1). */
export const HANDOFF_DEPTH = 1

/** A hand-off as the agents' facts keep it. */
export interface HandoffFact {
  id: string; fromAgent: string; fromLabel: string; fromJob: string; toKind: SpecialistKind
  question: string; evidence: Evidence[]; blocks: string; recommendation: string | null; acceptance: string[]
  depth: number; state: HandoffState; createdAt: number
  jobId: string | null; startedAt: number | null
  answer: string | null; answerEvidence: Evidence[]; confidence: number | null; acceptanceMet: boolean | null; answeredAt: number | null
  why: string | null; endedAt: number | null
}

/** A person's decline of a pending hand-off (the journey record's handoff_declines). */
export interface HandoffDecline { handoffId: string; reason: string; by: string; byHash: string; at: number }

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback
  try { return JSON.parse(v) as T } catch { return fallback }
}
const now = (): number => Date.now() / 1000
const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))

/** Every hand-off of a project, oldest first (none in a facts database made before they existed). */
export function loadHandoffs(db: DatabaseSync): HandoffFact[] {
  if (!has(db, 'handoffs')) return []
  return (db.prepare('SELECT * FROM handoffs ORDER BY created_at, rowid').all() as Record<string, unknown>[]).map((r) => ({
    id: String(r.id), fromAgent: String(r.from_agent), fromLabel: String(r.from_label), fromJob: String(r.from_job), toKind: String(r.to_kind) as SpecialistKind,
    question: String(r.question), evidence: json<Evidence[]>(r.evidence, []), blocks: String(r.blocks), recommendation: str(r.recommendation), acceptance: json<string[]>(r.acceptance, []),
    depth: Number(r.depth), state: (HANDOFF_STATES as readonly string[]).includes(String(r.state)) ? String(r.state) as HandoffState : 'failed', createdAt: Number(r.created_at),
    jobId: str(r.job_id), startedAt: num(r.started_at),
    answer: str(r.answer), answerEvidence: json<Evidence[]>(r.answer_evidence, []), confidence: num(r.confidence),
    acceptanceMet: r.acceptance_met === null || r.acceptance_met === undefined ? null : Number(r.acceptance_met) === 1, answeredAt: num(r.answered_at),
    why: str(r.why), endedAt: num(r.ended_at),
  }))
}

/** The declines in a journey record (none when the table was never made). */
export function loadDeclines(db: DatabaseSync): HandoffDecline[] {
  if (!has(db, 'handoff_declines')) return []
  return (db.prepare('SELECT * FROM handoff_declines ORDER BY at').all() as Record<string, unknown>[]).map((r) => ({
    handoffId: String(r.handoff_id), reason: String(r.reason), by: String(r.by), byHash: String(r.by_hash), at: Number(r.at),
  }))
}

// ------------------------------------------------------------------ guard 2: the quality bar

/** A request as the asking specialist gives it (the tool's input; every field checked here, not by its schema). */
export interface HandoffRequest {
  to: string
  question?: string | undefined
  evidence?: readonly Evidence[] | undefined
  blocks?: string | undefined
  recommendation?: string | undefined
  acceptance?: readonly string[] | undefined
}

export const QUESTION_MIN = 20
export const BLOCKS_MIN = 10
export const ACCEPTANCE_MIN = 10
const words = (s: string): number => s.split(/\s+/).filter(Boolean).length

/**
 * The quality bar (guard 2): what is missing or too vague, in words, one line each. Empty: the request may be sent.
 * A good request can be acted on by a specialist that knows nothing of the asker's job.
 */
export function requestProblems(r: HandoffRequest): string[] {
  const out: string[] = []
  const q = (r.question ?? '').trim()
  if (q.length < QUESTION_MIN || words(q) < 4 || VAGUE.test(q)) out.push(`the question or task, in plain words (a full sentence of at least ${QUESTION_MIN} characters that names the part, net, block or figure it is about)`)
  if (!(r.evidence ?? []).length) out.push('the evidence: at least one run id, file, artifact or datasheet page (part, sha256, page) the other specialist should start from')
  const b = (r.blocks ?? '').trim()
  if (b.length < BLOCKS_MIN || VAGUE.test(b)) out.push('what it blocks, in words ("sizing the LDO\'s output capacitor"): why you cannot finish without it')
  const acc = (r.acceptance ?? []).map((a) => a.trim())
  if (!acc.length) out.push('acceptance: what a good answer contains (e.g. "the phase margin at 10 mA and 500 mA, with the run id"), one item each')
  else if (acc.some((a) => a.length < ACCEPTANCE_MIN || VAGUE.test(a))) out.push(`acceptance: each item a concrete thing the answer must contain, at least ${ACCEPTANCE_MIN} characters`)
  const rec = r.recommendation?.trim()
  if (rec !== undefined && rec !== '' && (rec.length < 5 || VAGUE.test(rec))) out.push('your recommended answer, if you give one, in words (or leave it out)')
  return out
}

/** Refuse a request below the bar, with everything that is missing (HandoffError). */
export function checkRequest(r: HandoffRequest): void {
  const p = requestProblems(r)
  if (p.length) throw new HandoffError(`This hand-off is not specific enough to send. Add:\n${p.map((x) => `- ${x}`).join('\n')}\nNothing was recorded.`)
}

// ------------------------------------------------------------------ guard 1: depth, loops and limits

export interface Limits { perJob: number; perProject: number }
/** The defaults of agents.handoff_max_per_job and agents.handoff_max_per_project (src/core/config.ts). */
export const DEFAULT_LIMITS: Limits = { perJob: 3, perProject: 10 }

/** Who asks: the specialist and its job; `handoff`: the hand-off that started this job, when one did. */
export interface HandoffAsker { agent: string; label: string; jobId: string; handoff?: { id: string; from: string } | null | undefined }

const isOpen = (h: HandoffFact, declined: ReadonlySet<string>): boolean => (h.state === 'requested' || h.state === 'started') && !declined.has(h.id)
const same = (a: string, b: string): boolean => a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ')

/**
 * Guard 1: whether this asker may raise a hand-off to `to` now. Throws HandoffError with what to do instead. `enabled`:
 * agents.enabled; `declined`: the ids people declined (the journey record).
 */
export function checkGuards(db: DatabaseSync, asker: HandoffAsker, to: string, question: string, o: { enabled: readonly string[]; limits: Limits; declined: ReadonlySet<string> }): SpecialistKind {
  const kind = SPECIALIST_KINDS.find((k) => k === to)
  if (!kind) throw new HandoffError(`${JSON.stringify(to)} is not a specialist: ask one of ${SPECIALIST_KINDS.join(', ')}.`)
  if (!SPECIALIST_KINDS.some((k) => k === asker.agent)) throw new HandoffError('Only a specialist raises a hand-off. The worker reports to the specialist that delegated to it.')
  if (kind === asker.agent) throw new HandoffError('You cannot hand off to yourself: this is your own area. Do it, or ask a person (journey.ask).')
  if (!o.enabled.includes(kind)) throw new HandoffError(`The ${SPECIALIST_WORDS[kind]} specialist is not enabled on this project (agents.enabled). Ask a person instead (journey.ask).`)
  if (o.limits.perJob <= 0 || o.limits.perProject <= 0) throw new HandoffError('Hand-offs between specialists are turned off on this project (agents.handoff_max_per_job or agents.handoff_max_per_project is 0). Ask a person instead (journey.ask).')
  const all = loadHandoffs(db)
  // depth 1: the job a hand-off started raises none, whatever its environment says (its row names it)
  const startedBy = asker.handoff ?? (() => { const h = all.find((x) => x.jobId === asker.jobId); return h ? { id: h.id, from: h.fromAgent } : null })()
  if (startedBy) {
    if (startedBy.from === kind) throw new HandoffError(`The ${SPECIALIST_WORDS[kind]} specialist asked you this (hand-off ${startedBy.id}): you cannot hand it back. Answer it with journey.handoff_answer, or say why you cannot.`)
    throw new HandoffError(`This job was started by a hand-off (${startedBy.id}), and a hand-off job raises none. Answer it with journey.handoff_answer; say in the answer what the ${SPECIALIST_WORDS[kind]} specialist would need to look at.`)
  }
  const again = all.find((h) => h.toKind === kind && same(h.question, question) && (h.state === 'failed' || h.state === 'unanswered' || o.declined.has(h.id)))
  if (again) throw new HandoffError(`You asked the ${SPECIALIST_WORDS[kind]} specialist this before (${again.id}) and it was ${o.declined.has(again.id) ? 'declined by a person' : again.state === 'failed' ? 'not answered: its job failed' : 'not answerable'}. Do not ask again: ask a person with journey.ask.`)
  const open = all.filter((h) => isOpen(h, o.declined))
  const mine = open.filter((h) => h.fromJob === asker.jobId)
  if (mine.length >= o.limits.perJob) throw new HandoffError(`This job already has ${mine.length} open hand-offs (agents.handoff_max_per_job ${o.limits.perJob}): wait for one (journey.status), or finish and report what waits on them.`)
  if (open.length >= o.limits.perProject) throw new HandoffError(`The project already has ${open.length} open hand-offs (agents.handoff_max_per_project ${o.limits.perProject}): finish with what you have and report what waits, or ask a person (journey.ask).`)
  return kind
}

// ------------------------------------------------------------------ writing (the agents' facts)

const newId = (): string => `ho${randomUUID().replaceAll('-', '').slice(0, 14)}`

/** Record a hand-off (both guards first); returns it, state requested. */
export function addHandoff(db: DatabaseSync, asker: HandoffAsker, r: HandoffRequest, o: { enabled: readonly string[]; limits: Limits; declined: ReadonlySet<string> }): HandoffFact {
  checkRequest(r)
  const question = (r.question ?? '').trim()
  const kind = checkGuards(db, asker, r.to, question, o)
  const evidence = (r.evidence ?? []).map((e) => EvidenceSchema.parse(e))
  const acceptance = (r.acceptance ?? []).map((a) => a.trim())
  const rec = r.recommendation?.trim() || null
  const id = newId()
  const t = now()
  db.prepare(`INSERT INTO handoffs (id, from_agent, from_label, from_job, to_kind, question, evidence, blocks, recommendation, acceptance, depth, state, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, asker.agent, asker.label, asker.jobId, kind, question, JSON.stringify(evidence), (r.blocks ?? '').trim(), rec, JSON.stringify(acceptance), HANDOFF_DEPTH, 'requested', t)
  const h = loadHandoffs(db).find((x) => x.id === id)
  if (!h) throw new HandoffError('the hand-off was not recorded')
  return h
}

/** Its receiving job was accepted: started, with that job's id. */
export function markStarted(db: DatabaseSync, id: string, jobId: string): void {
  db.prepare("UPDATE handoffs SET state='started', job_id=?, started_at=? WHERE id=? AND state='requested'").run(jobId, now(), id)
}

/** It will not be answered: its job could not start, or ended without an answer. Changes nothing once answered. */
export function markFailed(db: DatabaseSync, id: string, why: string): boolean {
  return Number(db.prepare("UPDATE handoffs SET state='failed', why=?, ended_at=? WHERE id=? AND state IN ('requested','started')").run(why.slice(0, 1000), now(), id).changes) > 0
}

/** The receiving job's answer (journey.handoff_answer), or that it cannot answer and why. */
export interface HandoffAnswer {
  answered: boolean
  /** the answer, or why it cannot be answered */
  text: string
  evidence: readonly Evidence[]
  confidence?: number | undefined
  acceptanceMet?: boolean | undefined
  /** acceptance not met: what is missing, and why */
  unmet?: string | undefined
}

export const ANSWER_MIN = 20

/** What an answer lacks, in words; empty: it may be recorded. */
export function answerProblems(a: HandoffAnswer): string[] {
  const out: string[] = []
  const text = a.text.trim()
  if (!a.answered) {
    if (text.length < 10 || VAGUE.test(text)) out.push('why it cannot be answered, in a full sentence (what is missing, and who or what could supply it)')
    return out
  }
  if (text.length < ANSWER_MIN || VAGUE.test(text)) out.push(`the answer in plain words, at least ${ANSWER_MIN} characters, with its numbers and units`)
  if (!a.evidence.length) out.push('the evidence: the run ids, files or datasheet pages the answer rests on')
  if (a.confidence === undefined || !(a.confidence >= 0 && a.confidence <= 1)) out.push('your confidence, 0 to 1')
  if (a.acceptanceMet === undefined) out.push('whether the acceptance is met (acceptance_met)')
  if (a.acceptanceMet === false && (a.unmet ?? '').trim().length < 10) out.push('which acceptance item is not met, and why (unmet)')
  return out
}

/**
 * Record the answer. Only the job started for this hand-off may answer it (its id, from the runtime's environment), and
 * only once. Throws HandoffError otherwise.
 */
export function answerHandoff(db: DatabaseSync, id: string, jobId: string | null, a: HandoffAnswer): HandoffFact {
  const h = loadHandoffs(db).find((x) => x.id === id)
  if (!h) throw new HandoffError(`There is no hand-off ${id} in this project.`)
  if (!jobId || h.jobId !== jobId) throw new HandoffError(`Only the job started for hand-off ${id} may answer it${h.jobId ? ` (job ${h.jobId})` : ''}.`)
  if (h.state === 'answered' || h.state === 'unanswered') throw new HandoffError(`Hand-off ${id} is already answered.`)
  if (h.state === 'failed') throw new HandoffError(`Hand-off ${id} was closed as not answered: ${h.why ?? 'its job ended'}.`)
  const p = answerProblems(a)
  if (p.length) throw new HandoffError(`The answer is not complete. Add:\n${p.map((x) => `- ${x}`).join('\n')}`)
  const unmet = a.acceptanceMet === false ? (a.unmet ?? '').trim() : null
  db.prepare(`UPDATE handoffs SET state=?, answer=?, answer_evidence=?, confidence=?, acceptance_met=?, why=?, answered_at=?, ended_at=? WHERE id=?`).run(
    a.answered ? 'answered' : 'unanswered', a.text.trim(), JSON.stringify(a.evidence.map((e) => EvidenceSchema.parse(e))),
    a.answered ? a.confidence ?? null : null, a.answered ? (a.acceptanceMet ? 1 : 0) : null, unmet, now(), now(), id)
  return loadHandoffs(db).find((x) => x.id === id) as HandoffFact
}

// ------------------------------------------------------------------ a person declines (the journey record)

export interface Decliner { hash: string; label: string }

/**
 * A person declines a pending hand-off, with a reason in one line: written in the journey record (people's, never the
 * agents' facts), logged in its decisions. Pending: requested, or its job queued (`jobState`, from the job index). A
 * running one is refused: cancel its job instead.
 */
export function declineHandoff(db: DatabaseSync, h: HandoffFact | undefined, by: Decliner, reason: string, o: { jobState: string | null }): { id: string; reason: string; by: string; at: string } {
  if (!h) throw new HandoffError('There is no such hand-off in this project.')
  if (loadDeclines(db).some((d) => d.handoffId === h.id)) throw new HandoffError('This hand-off is already declined.')
  if (h.state === 'answered' || h.state === 'unanswered') throw new HandoffError('This hand-off is already answered: there is nothing to decline.')
  if (h.state === 'failed') throw new HandoffError('This hand-off has already ended without an answer.')
  if (o.jobState === 'running') throw new HandoffError('Its job is already running: cancel that job instead (Cancel on its line), and the asker is told.')
  const why = reason.trim()
  if (why.length < 3 || VAGUE.test(why)) throw new HandoffError('Say in a line why it is declined, so the asking specialist knows what to do instead.')
  if (/[\r\n]/.test(why)) throw new HandoffError('Keep the reason to one line.')
  const t = now()
  transaction(db, () => {
    db.prepare('INSERT INTO handoff_declines (handoff_id, reason, by, by_hash, at) VALUES (?,?,?,?,?)').run(h.id, why, by.label, by.hash, t)
    decide(db, {
      kind: 'handoff.declined', stage: null, ref: h.id, by: by.label,
      summary: `The ${SPECIALIST_WORDS[h.toKind]} specialist will not answer ${fromWords(h)}'s hand-off: ${h.question.slice(0, 200)} Declined: ${why}`,
    })
  })
  return { id: h.id, reason: why, by: by.label, at: new Date(t * 1000).toISOString() }
}

// ------------------------------------------------------------------ views

const fromWords = (h: Pick<HandoffFact, 'fromAgent' | 'fromLabel'>): string => {
  const k = SPECIALIST_KINDS.find((x) => x === h.fromAgent)
  return k ? `the ${SPECIALIST_WORDS[k]} specialist` : h.fromLabel
}

/** A hand-off job's title, for the job index and every list of jobs: "Asked by the Thermal specialist: …". */
export function handoffTitle(from: string, question: string): string {
  const k = SPECIALIST_KINDS.find((x) => x === from)
  return `Asked by the ${k ? SPECIALIST_WORDS[k] : from} specialist: ${question.replace(/\s+/g, ' ').trim()}`.slice(0, 200)
}

/** What a job index row is, as far as a hand-off needs: its state, and the API's id for it. */
export interface HandoffJob { state: string; handle: string }

export interface HandoffView {
  id: string
  from: string; from_name: string; from_job: string; from_job_handle: string | null
  to: SpecialistKind; to_name: string
  question: string; blocks: string; evidence: Evidence[]; recommendation: string | null; acceptance: string[]
  /** one line: "Thermal → Analog and mixed-signal: …" */
  summary: string
  state: HandoffViewState
  /** in words: what happens next, or why it ended */
  says: string
  created_at: string
  job: { id: string; handle: string | null } | null
  answer: { answered: boolean; text: string; summary: string; evidence: Evidence[]; confidence: number | null; acceptance_met: boolean | null; unmet: string | null; at: string } | null
  declined: { reason: string; by: string; at: string } | null
  why: string | null
}

const iso = (t: number | null): string | null => (t === null ? null : new Date(t * 1000).toISOString())
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** One hand-off's view state: its own state, a person's decline, and its job's state in the index. */
export function viewState(h: HandoffFact, declined: boolean, job: HandoffJob | undefined): HandoffViewState {
  if (h.state === 'answered' || h.state === 'unanswered') return h.state
  // a declined one's job, cancelled or not run, then ends as failed: the decline is what people and the asker read
  if (declined) return 'declined'
  if (h.state === 'failed') return 'failed'
  if (h.state === 'requested') return 'requested'
  if (!job) return 'queued'
  if (job.state === 'queued') return 'queued'
  if (job.state === 'running') return 'running'
  // its job ended (or was lost, or paused) without answering: the runtime closes it as failed; until then, say so
  return 'failed'
}

const SAYS: Record<HandoffViewState, (h: HandoffFact, d: HandoffDecline | undefined) => string> = {
  requested: () => 'Recorded; its job is being started.',
  queued: (h) => `Queued for the ${SPECIALIST_WORDS[h.toKind]} specialist: it starts at its turn in the project's queue.`,
  running: (h) => `The ${SPECIALIST_WORDS[h.toKind]} specialist is working on it.`,
  answered: (h) => `Answered${h.acceptanceMet === false ? ', but not everything asked for is met' : ''}.`,
  unanswered: (h) => `The ${SPECIALIST_WORDS[h.toKind]} specialist could not answer it: ${cut(h.answer ?? '', 200)}`,
  declined: (_h, d) => `Declined by ${d?.by ?? 'a person'}: ${d?.reason ?? ''}`,
  failed: (h) => `Not answered: ${h.why ?? 'its job ended without an answer'}.`,
}

/**
 * Every hand-off of a project, newest first, as people and agents read it: from whom to whom, the request, the state
 * (with a person's decline and the receiving job's state), and the answer. `jobs`: the job index by worker job id.
 */
export function handoffViews(facts: readonly HandoffFact[], declines: readonly HandoffDecline[], jobs: ReadonlyMap<string, HandoffJob>): HandoffView[] {
  const byId = new Map(declines.map((d) => [d.handoffId, d]))
  return [...facts].reverse().map((h): HandoffView => {
    const d = byId.get(h.id)
    const job = h.jobId ? jobs.get(h.jobId) : undefined
    const state = viewState(h, Boolean(d), job)
    const fromKind = SPECIALIST_KINDS.find((k) => k === h.fromAgent)
    const fromName = fromKind ? SPECIALIST_WORDS[fromKind] : h.fromLabel
    return {
      id: h.id, from: h.fromAgent, from_name: fromName, from_job: h.fromJob, from_job_handle: jobs.get(h.fromJob)?.handle ?? null,
      to: h.toKind, to_name: SPECIALIST_WORDS[h.toKind],
      question: h.question, blocks: h.blocks, evidence: h.evidence, recommendation: h.recommendation, acceptance: h.acceptance,
      summary: `${fromName} → ${SPECIALIST_WORDS[h.toKind]}: ${cut(h.question.replace(/\s+/g, ' '), 160)}`,
      state, says: SAYS[state](h, d), created_at: iso(h.createdAt) as string,
      job: h.jobId ? { id: h.jobId, handle: job?.handle ?? null } : null,
      answer: h.answer !== null && h.answeredAt !== null ? {
        answered: h.state === 'answered', text: h.answer, summary: cut(h.answer.replace(/\s+/g, ' '), 200), evidence: h.answerEvidence,
        confidence: h.confidence, acceptance_met: h.acceptanceMet, unmet: h.state === 'answered' ? h.why : null, at: iso(h.answeredAt) as string,
      } : null,
      declined: d ? { reason: d.reason, by: d.by, at: iso(d.at) as string } : null,
      why: state === 'failed' ? h.why ?? 'its job ended without an answer' : null,
    }
  })
}

/** What the asking agent should do about one of its hand-offs, in words (journey.status). */
export function nextFor(v: Pick<HandoffView, 'state' | 'id' | 'to_name'>): string {
  switch (v.state) {
    case 'answered': return 'Use the answer, cite the hand-off id where you act on it, and check it against your acceptance.'
    case 'requested': case 'queued': case 'running': return `Not answered yet: carry on with what it does not block, and read it again later with journey.status { handoff: "${v.id}" }.`
    case 'declined': case 'failed': case 'unanswered':
      return `The ${v.to_name} specialist will not answer this. Do not hand it off again: if it still blocks you, ask a person with journey.ask (cite ${v.id}), or end your report with what waits on it.`
  }
}

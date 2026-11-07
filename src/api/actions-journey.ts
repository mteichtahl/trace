/**
 * The journey through the API: where a project is, its one next step, and the acts that move it (src/core/journey.ts
 * holds the record and every rule; this file checks access, reads and writes the record through GitHub, and words
 * the answers for the person asking).
 *
 *   journey.get             read     the journey for this person: template, revision, stages (state, criteria
 *                                    met/total, reopened), gates (state, criteria, evidence, waivers, signature, what
 *                                    still stops this person signing), the next step, questions, waivers, decisions,
 *                                    the project's jobs and the hand-offs between its specialists (jobs.list's,
 *                                    src/api/actions-jobs.ts). Each stage has its guide and its steps; the open
 *                                    changes trace made are steps too, and a ready one is the next step to review
 *                                    (src/api/actions-changes.ts; left out, with changes_unavailable, when GitHub
 *                                    cannot be reached).
 *                                    A project with no journey yet: { started: false } and what starts one
 *                                    In Define before the requirements exist, the next step and `drafting` say where
 *                                    their drafting stands (src/api/drafting.ts): write the intent, trace drafting
 *                                    them, or drafting them again when the job stopped
 *   requirements.draft      write    start the drafting job again (lost, failed, cancelled or never started), the same
 *                                    request and agent as Intent builder's Submit, as a new attempt
 *   journey.start_work      write    start trace's work on its criterion that nothing works on (src/api/owned-work.ts):
 *                                    the next step's Start it, once trace's own start of it ended without meeting it
 *                                    or was refused. journey.get starts it on its own the first time
 *   journey.criterion.open  read     record that this person opened a criterion's (or a waiver's) evidence: the Sign
 *                                    button needs every one opened by the signer. Reviewers may open evidence too
 *   gate.sign               admin    sign a gate: every criterion met or waived, every piece of evidence and every
 *                                    waiver of the stage opened by the signer, every waiver acknowledged (this call
 *                                    acknowledges the ones named). Otherwise refused with what is missing
 *   gate.return             write    return a gate with what has to change; optionally reopen the earlier stage the
 *                                    problem belongs to
 *   question.answer         write    answer an agent's question: an option (the recommended one, or another with a
 *                                    reason) or an answer in words
 *   waiver.add              write    take a waiver: reason, risk, severity, where it is caught instead, scope;
 *                                    `replaces` takes an earlier one again, withdrawing it (as waiver.withdraw)
 *   waiver.withdraw         write    withdraw a waiver in force with a reason, kept in the decisions log: its author
 *                                    or an admin, and not while a signed gate stands on it (reopen that stage first).
 *                                    What it waived counts again (test-esp32 #149)
 *   stuck.dismiss           write    dismiss a stuck agent's report with a reason in one line: it leaves Home and the
 *                                    inbox, and the agent reads the dismissal and its reason (journey.status)
 *   journey.time            read     where the project's time went (Operations' Process tab): each started stage's
 *                                    length and the part of it spent waiting on a person (src/core/process-time.ts)
 *   inbox                   signed in  the four kinds that earn a notification (a gate ready, a question blocking
 *                                    work, money about to be spent, an agent stuck) across the person's projects,
 *                                    most blocking and oldest first. Each project's database is read once, in
 *                                    parallel with a small limit; a project whose record cannot be read is listed
 *                                    under `unavailable` rather than failing the whole inbox
 *
 *   journey.snapshot        admin    copy the record into the repository's .trace/project.db (its journey tables) on a
 *                                    new branch trace/release-<revision>-<time>, recorded as an app edit (kind release:
 *                                    its pull request opens at once and trace applies it; `change`), and log the
 *                                    commit in the decisions. Signing the gate that cuts a
 *                                    release (the release approval gate; Prove's in the Firmware template) takes it
 *                                    on its own: a failed copy is reported with the signature and never undoes it.
 *                                    Either way the revision's renders (renders: false skips them) and its documents'
 *                                    release copies (documents: false; docs/scribe.md "Publishing") are started
 *
 * The record lives in the central bucket (src/core/journey-store.ts): every write is a conditional put of the
 * project's journey database, re-run on a lost race, and answers the record's `version`. The agents' facts
 * (src/core/agent-facts.ts: their questions, checks of the criteria trace owns, stuck notes) are read beside it and
 * merged into journey.get, gate.sign, waiver.add and the inbox; question.answer answers an agent's question in the
 * record under its id. The API never writes the agents' facts, and an agent's fact never meets a person's criterion.
 * Who did it is recorded as their email for the record people read, and as the 16-character hash of their Cognito sub
 * where the record only matches them (opened evidence, questions asked of them), never as anything else. Records made
 * before identity was keyed on the sub carry the email's hash: both are accepted when reading (hashesOf).
 *
 * The waits on people are recorded here once each act is saved (src/api/process-metrics.ts): an answer (asked →
 * answered) and a signature (the gate ready → signed).
 */
import { z } from 'zod'
import { AccessDenied, type Principal, classOf, isAdmin, projectsFor, standing } from '../core/access.js'
import {
  type AgentFacts, type CriterionRow, carryStage, designWorkLeft, INBOX_KINDS, type InboxItem, type NextStep, type StageId, decide, type JourneyRecord, type Viewer, SEVERITIES, STAGE_IDS, WAIVER_TARGETS, answerQuestion, addWaiver, withdrawWaiver, inboxItems,
  confirmCriterion, dismissStuck, guardsFabricate, isViewer, journeyView, loadJourney, markOutOfDate, mergeAgentFacts, nextStep, openedBy, type PendingChanges, recordOpen, returnGate, signGate, sortInbox, withAsks, withChanges, withPending, withStaleEvidence, staleCriteria,
} from '../core/journey.js'
import { gateReadyAt, stageTimes } from '../core/process-time.js'
import { recordAnswered, recordWait } from './process-metrics.js'
import { logLine, openChanges, openPulls, projectEdits, projectRule, rerunStuck } from './actions-changes.js'
import { editorName, recordEdit } from './edits.js'
import { RULES_PATH, proposeRule } from './rule-answers.js'
import { recommendationOf } from './changes.js'
import { REQUIREMENT_CHANGE_SAID } from './requirement-edits.js'
import { AGENT_WORDS, jobIndex, listJobs, lostJobStep, openLostJobs, projectHandoffs, restartLostJobs, restartable, stoppedSteps } from './actions-jobs.js'
import { editReviewItems, reviewItems } from './inbox-review.js'
import { loadJobs } from '../core/job-index.js'
import { evidenceStaleness } from './evidence-freshness.js'
import { STAGE_NAMES } from '../core/journey-catalog.js'
import { docsFor } from '../docs/catalog.js'
import { docsAfterDesign, docsReleaseRequest, docsRequest, recordNow, startScribe, startStageScribe } from './docs-follow.js'
import { ActionError, type Context, NO_ACCESS, Repo, agentFacts, def, hashOf, hashesOf, journeyStore, label, plainly, snapshotJourney, withJourneyDb, withRecordDb, writeJourney } from './action-kit.js'
import { requirementEvidence } from './record-read.js'
import { backToDefine, changedRequirements, pendingOf } from './pending-changes.js'
import { dueRetry, stuckFor, stuckLook } from './stuck-checks.js'
import { runningOn, waitsOn, waitsOnSteps, workingNow } from './waits-on.js'
import { OWNED_REFUSED, OWNED_STARTED, type OwnedDue, ownedDue, ownedStep, reviewWaits, stageSince } from './owned-work.js'
import { SPECIALIST_KINDS, SPECIALIST_WORDS } from '../agents/kinds.js'
import { isLive } from '../core/job-index.js'
import { draftRequirements, draftingNow, draftingStep, logRetry } from './drafting.js'
import type { JobRow } from '../core/job-index.js'
import { type Followup, carryOnPlace, followupStatus, landedOn, loadFollowups, putFollowup, updateFollowup } from '../core/answer-followups.js'
import { assertNotHeld } from './held.js'
import { type ReopenedWork, finishRequest, keptOf, readTrace, reopenHeadline, reopenedWork, resignBasis, resignPlan, scopedRequest } from './reopen-scope.js'

const Id = z.string().min(1).max(80)

/** Who is looking, for the journey's computations. */
export async function viewerOf(p: Principal, repo: string): Promise<Viewer> {
  const s = await standing(p, repo)
  return { hash: hashOf(p), also: hashesOf(p), label: label(p), admin: isAdmin(p), part: s?.part ?? null, sub: p.sub }
}

const NOT_STARTED = {
  started: false,
  summary: 'This project has not started its journey yet.',
  next: 'An admin starts it by choosing a template: Board, FPGA, Firmware or Mixed.',
}

/** An IANA time zone from the signer's browser, for the day a revision was cut; anything else is dropped. */
const TimeZone = z.string().trim().max(64).regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/).optional().catch(undefined)

const signer = (ctx: Context): { hash: string; label: string; also: string[] } => ({ hash: hashOf(ctx.principal), also: hashesOf(ctx.principal), label: label(ctx.principal) })

/** Run a journey write, turning a refusal of the record's own into the person's error. */
const journeyWrite = <T>(ctx: Context, repo: string, fn: Parameters<typeof writeJourney<T>>[2]) => plainly(() => writeJourney<T>(ctx, repo, fn))

/**
 * Copy the record into the repository, record it as an app edit (docs/stay-in-trace.md: its pull request opens at once
 * and trace applies it; `change` is its number), and log the commit in the decisions.
 */
async function snapshot(ctx: Context, repo: string, why: string): Promise<{ branch: string; commit: string; revision: string; version: number; change: number | null }> {
  const { base, ...s } = await plainly(() => snapshotJourney(ctx, repo, why))
  const edit = await recordEdit(ctx, { repo, branch: s.branch, base, commit: s.commit, kind: 'release', title: `The record of revision ${s.revision}`, redo: { op: 'release', why } })
  const logged = await writeJourney(ctx, repo, (db) => {
    decide(db, {
      kind: 'journey.snapshot', stage: null, ref: s.commit, by: label(ctx.principal),
      summary: `The record of revision ${s.revision} was copied into the repository (commit ${s.commit.slice(0, 7)} on ${s.branch}).`, detail: { branch: s.branch, commit: s.commit, revision: s.revision, why },
    })
    return { result: {} }
  })
  return { ...s, version: logged.version, change: edit.number }
}

/** At most this many projects' databases are read at once for the inbox. */
/** The open pull requests the project's jobs opened (inbox-review.ts), from GitHub and the project's job index. */
async function openReviews(ctx: Context, repo: string, project: string, stage: StageId): Promise<InboxItem[]> {
  // the open pull requests and the rule through the changes' short-lived cache (src/api/github-cache.ts): the inbox
  // asks for every project at once, often
  const [pulls, jobs] = await Promise.all([openPulls(ctx, repo), jobIndex(ctx, repo).read((db) => loadJobs(db)).then((x) => x.result)])
  // no open pull request: nothing to tell apart, and the project's settings are not read for it
  if (!pulls.length) return []
  // checks no runner picks up: one look per project, kept a minute (src/api/stuck-checks.ts)
  const [rule, edits, look] = await Promise.all([projectRule(ctx, repo), projectEdits(ctx, repo), stuckLook(ctx, repo).catch(() => null)])
  return [
    ...reviewItems({ repo, project, stage, pulls, jobs, rule, agentWords: AGENT_WORDS, stuck: (sha) => stuckFor(look, sha) }),
    ...editReviewItems({ repo, project, stage, pulls, edits, viewer: { admin: isAdmin(ctx.principal), sub: ctx.principal.sub } }),
  ]
}

const INBOX_PARALLEL = 4

async function mapLimit<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i] as T)
    }
  }))
  return out
}

/** What a person said their answer lasts as (Question answer's last step): a one-off, a rule, or a requirement change. */
export type Lasts = 'once' | 'rule' | 'requirement'

/** The request of the task that carries an ended job on once its question is answered. */
export function answeredRequest(a: {
  id: string; text: string; jobId: string; branch: string; answer: string; reason: string | null; by: string | null; lasts?: Lasts | undefined; again?: string | undefined
  /** the asking job's branch holds another specialist's work: this job works on a change of its own on top of it (carryOnPlace) */
  stacked?: { owner: string | null } | undefined
}): string {
  const owner = a.stacked?.owner ? `the ${SPECIALIST_WORDS[a.stacked.owner as keyof typeof SPECIALIST_WORDS] ?? a.stacked.owner} specialist's work` : 'another specialist\'s work'
  return [
    `Your question ${a.id} (asked in job ${a.jobId}) is answered. You asked: ${a.text}`,
    `${a.by ?? 'A person'} answered: ${a.answer}${a.reason ? ` (because ${a.reason})` : ''}.`,
    // started again by trace (keepAnswers): an earlier job for this answer stopped before it was applied
    ...(a.again ? [`An earlier job started to apply this answer stopped before it did (${a.again}). The branch may hold part of that work: read it first.`] : []),
    // the asking job only ran on another specialist's branch (log #144): its work is a change of its own, never theirs
    ...(a.stacked
      ? [`Your job ran on ${a.branch}, which holds ${owner}, so this work is a change of its own: you are on a new branch that starts from ${a.branch}. Change what the answer changes, check it as before, commit with subjects that say what the work is, and push this branch: it opens as its own change, stacked on that one. Never push to ${a.branch}.`]
      : [`Carry the work on ${a.branch} on with that answer: read what is already on the branch, change what the answer changes, check it as before, and push to the same branch so its pull request updates.`]),
    ...(a.lasts === 'requirement' ? [`${REQUIREMENT_CHANGE_SAID} Have the change proposed for a person to accept in Requirements review: the requirement, its new wording and measurable criterion, and why (the Verification specialist owns the requirements: journey.handoff to it unless you are it, then verify.requirements, left proposed). Until it is accepted, treat the requirement as it stands, and say in your report that the change waits on review.`] : []),
    // the rule itself goes into .trace/rules.md through trace's own change (src/api/rule-answers.ts, log #109)
    ...(a.lasts === 'rule' ? [`They made this a rule for the project: apply it in this job, and remember it (memory.remember) so later jobs apply it without asking again. trace adds it to the project's rules (${RULES_PATH}) through a change of its own, and every agent reads it from the default branch once that is accepted: do not edit ${RULES_PATH} yourself.`] : []),
    // a rule or a one-off is not a requirement change: an edit of an accepted requirement reopens Define and every
    // gate after it (test-esp32 log #112), and the change's review page recommends sending it back
    ...(a.lasts === 'rule' || a.lasts === 'once' ? [`They did not say it changes a requirement: leave every requirement's words, acceptance criterion and status as they are (no verify.requirements edit). If the answer cannot be carried out without changing one, ask (journey.ask) instead.`] : []),
    'Do not redo what the answer does not touch. If the answer cannot be done as given, ask again (journey.ask) with what you found.',
  ].join('\n')
}

/**
 * An answer made a rule for the project, added to .trace/rules.md through a change of trace's own
 * (src/api/rule-answers.ts). Never fails the answer: it stands whatever happens here, and Settings offers to add a rule
 * that is not in the rules yet.
 */
export async function ruleFromAnswer(ctx: Context, repo: string, question: string): Promise<{ rule?: { state: string; change: number | null; branch?: string; words: string }; rule_error?: string; started?: string[] }> {
  try {
    const r = await proposeRule(ctx, repo, question, await editorName(ctx))
    return { rule: { state: r.state, change: r.change, ...(r.branch ? { branch: r.branch } : {}), words: r.words }, started: [r.words] }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return { rule_error: why, started: [`The rule could not be added to the project's rules yet (${why.replace(/\.$/, '')}). Add it from Settings, under Project rules.`] }
  }
}

/** What an agent asked, by the id it is answered under: its question, or its stuck report, which is answered as a
 * question too (mergeAgentFacts), the job that asked being the one it blocks. Looking only among questions left every
 * answered stuck report (testyyyu's Rendering escalations) unacted on: no job started, yet "the agent carries on". */
export function askedBy(facts: AgentFacts | null | undefined, id: string): { id: string; text: string; jobId: string | null } | undefined {
  const q = facts?.questions.find((x) => x.id === id)
  if (q) return { id: q.id, text: q.text, jobId: q.jobId }
  const s = facts?.stuck.find((x) => x.id === id)
  return s ? { id: s.id, text: s.why, jobId: s.jobId } : undefined
}

/** The worker's job id in a job id the API hands out (`<session>.<job id>`, src/api/workers.ts), or the id itself. */
const workerJobId = (id: string): string => id.split('.').at(-1) ?? id

/**
 * Keep the answer a job has to apply (src/core/answer-followups.ts), so it is never dropped with that job: journey.get
 * starts it again (keepAnswers) until it is applied. Never fails the answer: it stands whatever happens here.
 */
async function keepFollowup(ctx: Context, repo: string, f: Omit<Followup, 'state' | 'note' | 'updatedAt'>): Promise<void> {
  await writeJourney(ctx, repo, (db) => { putFollowup(db, f, Date.now() / 1000); return { result: {} } }).catch(() => undefined)
}

/** An answer that recorded waivers (an option that waives) says so, as the Waiver skill would: " 3 waivers are recorded in your name." */
export const waivedWords = (q: { waivers?: string[] | undefined }): string =>
  q.waivers?.length ? ` ${q.waivers.length === 1 ? 'A waiver is' : `${q.waivers.length} waivers are`} recorded in your name.` : ''

/**
 * After an answer: when the job that asked has ended, a task for the same specialist on that job's branch, told the
 * answer; when that branch holds another specialist's work (the asking job only ran there: carryOnPlace), a task on a
 * change of its own stacked on it, so the answer's work is reviewed under its own name and never lands in their change
 * (test-esp32 log #144). A job still queued, running or paused reads the answer itself (journey.status, or on Resume): nothing starts.
 * Either way the answer is kept as a follow-up (src/core/answer-followups.ts) until a job on that branch applies it: a
 * carry-on that is lost, stopped with its runtime or never reaches the queue is started again (keepAnswers), and the
 * change on that branch is not recommended for accepting meanwhile (test-esp32 log #131).
 */
export async function carryOn(ctx: Context, repo: string, asked: { id: string; text: string; jobId: string | null }, q: { answered: { answer: string; reason: string | null; by: string | null } | null }, lasts?: Lasts): Promise<{ jobId?: string; started?: string[]; jobError?: string; summary?: string }> {
  if (!asked.jobId || !q.answered) return {}
  const { rows } = await listJobs(ctx, repo)
  const row = rows.find((r) => r.id === asked.jobId)
  const at = Date.now() / 1000
  const agent = row ? SPECIALIST_KINDS.find((k) => k === row.agent) : undefined
  // the specialist's own row may not carry the branch its worker pushed to
  const branch = row ? row.branch ?? rows.find((r) => r.parentJob === row.id && r.branch)?.branch ?? null : null
  const answered = q.answered
  // the asking job may only have run on another specialist's branch (a hand-off's, to check its answer): then the
  // answer's work is a change of its own, stacked on it, never more commits in that change (test-esp32 log #144)
  const place = row && branch && row.state !== 'queued' && row.state !== 'paused' && !isLive(row, at) ? carryOnPlace(rows, row, branch) : null
  const stacked = place && 'stackOn' in place ? place : null
  const keep = (job: string | null, attempts: number): Promise<void> => (agent && branch ? keepFollowup(ctx, repo, {
    question: asked.id, text: asked.text, askedJob: asked.jobId as string, branch, agent, answer: answered.answer, reason: answered.reason, lasts: lasts ?? null,
    by: answered.by, bySub: ctx.principal.sub, job, attempts, answeredAt: at, startedAt: at, stackOn: stacked?.stackOn ?? null,
  }) : Promise.resolve())
  // the job still runs, waits or is paused: it reads the answer itself (and is kept as the job that applies it)
  if (row && (row.state === 'queued' || row.state === 'paused' || isLive(row, at))) { await keep(row.id, 0); return {} }
  // never say the agent carries on when nothing will: the answer waits for whichever job asks next
  if (!row || !agent || !branch) return { summary: `Answered. The job that asked (${asked.jobId}) has ended and could not be started again${!row ? ' (it is not in the project\'s job list)' : !agent ? ` (${row.agent ?? 'no'} agent is not a specialist)` : ' (it has no branch)'}: the answer is kept for its next job.` }
  const request = answeredRequest({ id: asked.id, text: asked.text, jobId: row.id, branch, answer: answered.answer, reason: answered.reason, by: answered.by, lasts, ...(stacked ? { stacked: { owner: stacked.owner } } : {}) })
  const r = await (await ctx.deps.jobs()).startJob({ kind: 'task', repository: repo, request, agent, ...(stacked ? { stackOn: branch } : { branch }), requestedBy: label(ctx.principal), requestedBySub: ctx.principal.sub })
  // a start that was not accepted is kept too, with no job: trace starts it again (keepAnswers)
  await keep(r.accepted ? workerJobId(r.jobId) : null, 1)
  const who = `the ${SPECIALIST_WORDS[agent]} specialist`
  const where = stacked ? `a change of its own, on top of ${branch}` : branch
  return r.accepted
    ? { jobId: r.jobId, started: [`The ${SPECIALIST_WORDS[agent]} specialist carries on with your answer on ${where}.`], summary: `Answered. The ${SPECIALIST_WORDS[agent]} specialist carries on with it on ${where}.` }
    : { jobError: r.reason ?? 'trace did not accept the job.', summary: `Answered, but ${who} could not be started yet: ${r.reason ?? 'trace did not accept the job'}. trace tries again, and the change is not recommended for accepting until the answer is in it.` }
}

/**
 * Bring the answers trace still has to apply in line with the job index (src/core/answer-followups.ts followupStatus),
 * on each journey.get: one applied, or one trace will no longer start on its own, is written as such; one whose job was
 * lost, stopped with its runtime, or never reached the queue gets a new carry-on on the same branch, as a new attempt
 * (a new session: src/api/workers.ts taskSession), so a queued answer is never dropped (test-esp32 log #131). Each
 * restart is claimed in the record first (its attempts), so two looks at once start it once. Nothing starts while the
 * project is paused or retired. Answers the follow-ups started again, in words.
 */
export async function keepAnswers(ctx: Context, repo: string, followups: readonly Followup[], rows: readonly JobRow[], at = Date.now() / 1000): Promise<string[]> {
  // a carry-on on a change of its own whose job has named its branch: from now on that branch is where the answer goes
  // (a restart carries on there, with the work already on it)
  const landed = new Map(followups.filter((f) => f.state === 'pending' && f.stackOn).map((f) => [f.question, landedOn(f, rows)] as const).filter((x): x is [string, string] => x[1] !== null))
  if (landed.size) {
    await writeJourney(ctx, repo, (db) => {
      for (const [question, branch] of landed) updateFollowup(db, question, { branch, stackOn: null }, at)
      return { result: {} }
    }).catch(() => undefined)
  }
  const open = followups.filter((f) => f.state === 'pending').map((f) => (landed.has(f.question) ? { ...f, branch: landed.get(f.question) as string, stackOn: null } : f))
    .map((f) => ({ f, s: followupStatus(f, rows, at) }))
  const settle = open.filter(({ s }) => s.state === 'applied' || s.state === 'stopped')
  if (settle.length) {
    await writeJourney(ctx, repo, (db) => {
      for (const { f, s } of settle) updateFollowup(db, f.question, { state: s.state === 'applied' ? 'applied' : 'stopped', note: s.why }, at)
      return { result: {} }
    }).catch(() => undefined)
  }
  const restart = open.filter(({ s }) => s.state === 'restart')
  if (!restart.length) return []
  try { await assertNotHeld(repo) } catch { return [] }
  const out: string[] = []
  for (const { f, s } of restart) {
    const agent = SPECIALIST_KINDS.find((k) => k === f.agent)
    if (!agent || s.state !== 'restart') continue
    // claimed: only the look that moves its attempts on starts it
    const claimed = await writeJourney(ctx, repo, (db) => {
      const now = loadFollowups(db).find((x) => x.question === f.question)
      if (!now || now.state !== 'pending' || now.attempts !== f.attempts || now.job !== f.job) return { result: { ok: false }, changed: false }
      updateFollowup(db, f.question, { attempts: f.attempts + 1, job: null, startedAt: at, note: s.why }, at)
      return { result: { ok: true } }
    }).catch(() => ({ ok: false }))
    if (!claimed.ok) continue
    // still no branch of its own: stacked on the same branch again
    const place = f.stackOn ? carryOnPlace(rows, { id: f.askedJob, agent: f.agent }, f.stackOn) : null
    const request = answeredRequest({
      id: f.question, text: f.text, jobId: f.askedJob, branch: f.branch, answer: f.answer, reason: f.reason, by: f.by, lasts: (['once', 'rule', 'requirement'] as const).find((x) => x === f.lasts), again: s.why,
      ...(f.stackOn ? { stacked: { owner: place && 'owner' in place ? place.owner : null } } : {}),
    })
    const r = await (await ctx.deps.jobs()).startJob({
      kind: 'task', repository: repo, request, agent, ...(f.stackOn ? { stackOn: f.stackOn } : { branch: f.branch }), requestedBy: f.by ?? label(ctx.principal), ...(f.bySub ? { requestedBySub: f.bySub } : {}), attempt: f.attempts + 1,
    }).catch((e: unknown) => ({ accepted: false, jobId: '', reason: e instanceof Error ? e.message : String(e) }))
    if (r.accepted) {
      await writeJourney(ctx, repo, (db) => { updateFollowup(db, f.question, { job: workerJobId(r.jobId) }, Date.now() / 1000); return { result: {} } }).catch(() => undefined)
      out.push(`trace started the ${SPECIALIST_WORDS[agent]} specialist again to apply the answer to "${f.text.slice(0, 120)}" on ${f.stackOn ? `a change of its own, on top of ${f.stackOn}` : f.branch}: ${s.why}.`)
    }
  }
  return out
}

/** The day a revision was cut, YYYY-MM-DD, in the signer's time zone (an IANA name from their browser), else UTC. */
export function cutDay(at: Date, timeZone?: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  } catch {
    return at.toISOString().slice(0, 10)
  }
}

/**
 * What the rendering agent is asked when a revision is cut (docs/revision-renders.md): the revision's photorealistic
 * renders, named by the revision and the day it was cut.
 */
export function rendersRequest(revision: string, day: string): string {
  return [
    `Revision ${revision} was cut on ${day}: make its renders.`,
    `Call render_showcase with revision=${revision} and date=${day}, at release quality, for every shot it offers: the board, the board from above and below, and, when the case is built, the closed case, the board in the case and the exploded view, and the turntable video. The pictures are named <project>_rev-${revision}_${day}_<shot>.png and the turntable <project>_rev-${revision}_${day}_turntable.mp4.`,
    'Try one shot at quality=draft first, look at it, then make the full set in one call. Look at every picture before reporting it: framed, lit, the right way up, the board sitting in its case.',
    'Deliver the run the way your instructions say, naming the revision in the pull request\'s title.',
  ].join('\n')
}

/**
 * Start the rendering agent on a revision that was just cut. A revision stands whatever happens here: a job that
 * cannot start is said, and an admin can ask for the renders in chat.
 */
async function startRenders(ctx: Context, repo: string, revision: string, timeZone?: string | null): Promise<{ jobId?: string; started?: string; jobError?: string }> {
  const day = cutDay(new Date(), timeZone)
  try {
    const r = await (await ctx.deps.jobs()).startJob({ kind: 'task', repository: repo, request: rendersRequest(revision, day), agent: 'render', requestedBy: label(ctx.principal), requestedBySub: ctx.principal.sub })
    return r.accepted
      ? { ...(r.jobId ? { jobId: r.jobId } : {}), started: `The Rendering agent makes revision ${revision}'s renders (${day}).` }
      : { jobError: r.reason ?? 'trace did not accept the job.' }
  } catch (e) {
    return { jobError: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Start Scribe on a revision that was just cut: its documents brought up to date and printed as its release copies
 * (docs/scribe.md "Publishing"). Queued behind a Scribe job already working, since only this one prints them. `stage`:
 * the stage the signature opened, else Scribe reads it.
 */
async function startReleaseDocs(ctx: Context, repo: string, revision: string, timeZone: string | null | undefined, stage: StageId | null | undefined): Promise<{ jobId?: string; started?: string; jobError?: string }> {
  const day = cutDay(new Date(), timeZone)
  const r = await startScribe(ctx, repo, docsReleaseRequest(revision, day, { stage: stage ?? null }), { queue: true })
  return r.started
    ? { ...(r.jobId ? { jobId: r.jobId } : {}), started: `The Documentation agent prints revision ${revision}'s documents.` }
    : { jobError: r.jobError ?? r.skipped ?? 'trace did not accept the job.' }
}

/**
 * The work a stage starts when the gate before it is signed: the specialist and what it is asked. Architect: the
 * options a person then chooses between in Architecture choice (docs/user-journey.md, 2. Architect). A criterion of
 * trace's still not met once that work ended, with nothing else working on it, is started on its own (startOwnedWork,
 * src/api/owned-work.ts): by this entry's specialist, or by trace's router for a stage with no entry here.
 */
export const STAGE_WORK: Partial<Record<StageId, { agent: (typeof SPECIALIST_KINDS)[number]; request: string; started: string }>> = {
  architect: {
    agent: 'impl',
    started: 'The Implementation agent proposes the architecture options for Architecture choice.',
    request: [
      'The requirements baseline gate was signed: the project is in Architect. Propose the architecture for Architecture choice.',
      'Read the accepted requirements (verify.requirements list) and the intent (design.intent list).',
      'Propose two or three options with design.architecture: each a block diagram (blocks, the connections between them, the key parts of each block with MPN), the requirements each block serves so every requirement maps to a block, and why. Recommend one.',
      'Size the key circuits with the calc tools, pick candidate parts with parts.search and parts.lookup, pull their datasheets, and check stock and lifecycle for the build quantity: in stock at JLCPCB/LCSC first, then elsewhere, and only then out of stock with the reason written on the part.',
      'Propose the criteria to compare the options on (with weights) and score each option on each with a reason. Check the key parts with parts.bom_check at the build quantity, then shape.check architect.stock records the stock criterion.',
      'Do not choose: a person chooses in Architecture choice. Do not draw the schematic yet.',
    ].join('\n'),
  },
  capture: {
    agent: 'impl',
    started: 'The Implementation agent draws the schematic for the chosen architecture and runs the schematic review checks.',
    request: [
      'The architecture review gate was signed: the project is in Capture. Draw the schematic for the chosen architecture.',
      'Read the chosen option (design.architecture list) and the accepted requirements (verify.requirements list). Draw it in KiCad: a root sheet and one sheet per block, every part with its MPN, Manufacturer and LCSC fields and a footprint, and on each sheet a note naming the requirements it serves (design.sheets). Schematic only: no .kicad_pcb, that is Layout\'s.',
      'Check it with your own tools: kicad.erc clean (or each finding explained), kicad.netlist against the connections the architecture names, kicad.bom for every part\'s fields. Record capture.erc with journey.check.',
      'Stock: parts.bom_check on the parts list for the build quantity, then shape.check capture.stock records the criterion. A part out of stock gets an in-stock alternative proposed, or the reason written on it.',
      'Datasheets: pull each active part\'s datasheet and compare its limits (voltages, currents, power, temperature) with the operating point; record capture.datasheets with journey.check, citing each part\'s datasheet as evidence of kind datasheet (the part, the page and the result), each conflict named with the page it comes from.',
      'Pin plan: propose it with design.pins (connectors and every programmable part\'s pins, each with its net and function) for a person to agree in Pin plan. Do not agree it yourself.',
      'A part that breaks a requirement, or a choice the architecture did not make, is a question for a person (journey.ask): ask it, do not pick for them.',
    ].join('\n'),
  },
  prove: {
    agent: 'verify',
    started: 'The Verification agent plans a test for every requirement it can check before layout, and runs them.',
    request: [
      'The schematic review gate was signed: the project is in Prove. Prove the schematic against the accepted requirements before layout.',
      'Read the accepted requirements with their acceptance criteria (verify.requirements list) and the schematic.',
      'Plan a test item for every requirement that can be checked before layout (verify.plan): SPICE (sim.kicad_spice or sim.spice, with sim.sweep or sim.montecarlo for corners and tolerances) for the analog behaviour, inspection of the schematic for parts and fields, the rest with the method that fits. A requirement that can only be checked on the board or the bench gets its item planned for later, with that method, not run now.',
      'Run them (verify.run) at the corners each acceptance names, and record coverage (verify.coverage). Record prove.verified and prove.failing with journey.check, each with the runs as evidence.',
      'A test that fails is not yours to fix by changing the requirement: report it with the numbers, and hand the circuit change to the Implementation specialist (journey.handoff), or ask a person (journey.ask) when the requirement itself may be wrong. Do not waive anything yourself.',
      'Finish with verify.report: what is verified, what is planned for later and why, and anything failing.',
    ].join('\n'),
  },
  layout: {
    agent: 'impl',
    started: 'The Implementation agent lays out the board and runs the layout review checks.',
    request: [
      'The design proven gate was signed: the project is in Layout. Lay out the board for the proven schematic.',
      'Read the accepted requirements (verify.requirements list) for the outline, layers and anything that constrains placement, and the schematic.',
      'Create the board from the schematic, draw the outline the requirements allow, place the parts (pcb.floorplan, pcb.placement_check), and route every connection (pcb.autoroute, finishing by hand where it fails). Size power traces with calc.trace_width.',
      'Check it: kicad.drc clean (or each finding explained), every connection routed, matched lengths where the design names any (pcb.length_match, kicad.net_length). Record layout.routed, layout.drc and layout.lengths with journey.check, and layout.pins if the pin plan applies.',
      'Render the board (render.board) so a person can approve the renders. Do not approve them yourself: ask with journey.ask, naming layout.renders, the render run as a source, and a recommended option labelled "Approve the renders". The person\'s answer meets the criterion.',
      'A change the layout forces on the schematic or a requirement is a question for a person (journey.ask), not yours to make.',
      'Leave the case: trace starts it for the board once this layout is accepted.',
    ].join('\n'),
  },
  signoff: {
    agent: 'verify',
    started: 'The Verification agent closes coverage and writes the release report for Sign-off.',
    request: [
      'The layout review gate was signed: the project is in Sign-off. Prepare the release report.',
      'Run what the layout made possible (the items planned for after layout), then close coverage (verify.coverage): every requirement verified or waived, the gaps named. Record signoff.coverage with journey.check.',
      'Hand the parts list check (cost and stock at the build quantity, then shape.check signoff.bom) to the Implementation specialist, and the interference prechecks (then signoff.emc) to the EMC specialist, each with journey.handoff. verify.report reads their runs from the record, so wait for their answers first.',
      'When the build plan includes panel and mounting hardware, the parts list hand-off also asks for the hardware list (the parts list tool with hardware: true). Put it in the report as its own list (case parts, screws, panel parts), never added to the parts list or its cost check.',
      'Write the release report with verify.report: it holds coverage, interference estimates, the parts list with its cost and stock, and every open waiver, for a person to review. Release review approves the report it records. Do not sign or waive anything yourself.',
    ].join('\n'),
  },
  // the order sheet a person checks waits for the package and today's stock (test-esp32 #220): started here, not
  // only once a person asks
  fabricate: {
    agent: 'impl',
    started: 'The Implementation agent builds the release package and checks stock and prices again today.',
    request: [
      'The release approval gate was signed: the project is in Fabricate. Prepare the order for JLCPCB.',
      'Build the release package with kicad.fab (house jlcpcb, zipped) from the released board on the default branch, into hardware/<board>/release/rev<revision>/: Gerbers and drill, the parts list and the placement file in JLCPCB\'s columns. Fix nothing in the design here: a problem the package shows is a question for a person (journey.ask). Read the board with kicad.board, so its layers, size, thickness and copper are in the record for the order options. Record fabricate.order.package with journey.check, citing the kicad.fab run.',
      'Check stock and prices again today: parts.bom_check on the package\'s parts list at the build quantity, fresh, then shape.check fabricate.order.stock records the criterion. A line now short or out of stock is a question for a person (journey.ask), with an in-stock alternative where there is one.',
      'Do not order, pay or sign anything: a person checks the order sheet in Order submit and signs the order gate.',
    ].join('\n'),
  },
}

/**
 * Design work a stage starts part way through, once the work it builds on is accepted: the criterion it meets, the
 * criteria it waits for (met or waived), and the specialist and what it is asked. Layout's case is built for the
 * accepted board, so it starts when the layout lands, not after the documents (test-esp32 #132: the fit criterion
 * waited behind a docs change, though the documents are written from the case, not the other way round).
 */
export const FOLLOW_ON: Readonly<Record<string, { after: readonly string[]; agent: (typeof SPECIALIST_KINDS)[number]; request: string; started: string }>> = {
  'layout.fit': {
    after: ['layout.routed', 'layout.drc'],
    agent: 'impl',
    started: 'The Implementation agent designs the case for the accepted board and checks that the board fits it.',
    request: [
      'The board layout is accepted: the project is in Layout. Design its enclosure and check that the board fits it.',
      'Read the accepted requirements (verify.requirements list) for the size, mounting, openings and environment the case must meet, and the board as it now is on the default branch.',
      'With no mechanical/case.json yet: mech_board first (a part at the 5 mm default height needs its Height from its datasheet or a person), then mech_options with ask: true, and mech_init with the design the answer names. With a case already there, mech_fit says whether its last build is stale.',
      'mech_build, then read every clash and gap by part and fix it (mech_settings with its reason, or an edit to mechanical/case.py), rebuilding after each change. After each build, shape_check layout.fit records the criterion; never journey_check it.',
      'The fit check models the board\'s own parts only. A requirement that puts more in the case (a window for a display, a module on a header, a battery) keeps layout.fit unmet, naming it: build the case to hold it (the part\'s size from its datasheet; the window or mount in mechanical/case.py), then ask the person to check it and waive that one finding. Never report the fit met for the bare board alone.',
      'A change the case forces on the board or a requirement is a question for a person (journey.ask), not yours to make.',
    ].join('\n'),
  },
}

/** The FOLLOW_ON work the record is ready for: its criterion unmet in the current stage, what it waits for landed. Pure. */
export function followOnDue(r: JourneyRecord): string[] {
  const met = (id: string): boolean => {
    const c = r.criteria.find((x) => x.id === id)
    return !c || c.status === 'met' || r.waivers.some((w) => w.targetKind === 'criterion' && w.target === id && w.closedAt === null)
  }
  const stage = r.stages.find((s) => s.id === r.journey.currentStage)
  return Object.entries(FOLLOW_ON).filter(([id, f]) => {
    const c = r.criteria.find((x) => x.id === id)
    if (!c || !stage || !r.gates.some((g) => g.id === c.gate && g.stage === stage.id) || met(id) || !f.after.every(met)) return false
    // once a stage opening (or reopening): a decision says it was started since
    const since = Math.max(stage.started ?? 0, stage.reopenedAt ?? 0)
    return !r.decisions.some((d) => d.kind === 'work.started' && d.ref === id && d.at >= since)
  }).map(([id]) => id)
}

/**
 * Start the FOLLOW_ON work the stage is ready for (a push to the default branch, hook.docs: the accept that landed what
 * it waits for). Skipped while its specialist has a job queued or running on the project, which may be doing it; the
 * next push tries again. Each start is logged, so it starts once a stage.
 */
export async function startFollowOn(ctx: Context, repo: string, r: JourneyRecord): Promise<{ started: string[]; jobs: string[]; errors: string[] }> {
  const out = { started: [] as string[], jobs: [] as string[], errors: [] as string[] }
  const due = followOnDue(r)
  if (!due.length) return out
  const jobs = await ctx.deps.jobs()
  const busy = await jobs.jobStatus()
  for (const id of due) {
    const f = FOLLOW_ON[id]!
    if (busy.some((j) => j.repository === repo && j.agent === f.agent && (j.state === 'queued' || j.state === 'running'))) continue
    try {
      const s = await jobs.startJob({ kind: 'task', repository: repo, request: f.request, agent: f.agent, requestedBy: 'trace', requestedBySub: ctx.principal.sub })
      if (!s.accepted) { out.errors.push(s.reason ?? 'trace did not accept the job.'); continue }
      await writeJourney(ctx, repo, (db) => {
        decide(db, { kind: 'work.started', stage: r.journey.currentStage, ref: id, by: 'trace', summary: f.started, detail: { job: s.jobId, agent: f.agent } })
        return { result: null }
      })
      out.started.push(f.started)
      if (s.jobId) out.jobs.push(s.jobId)
    } catch (e) { out.errors.push(e instanceof Error ? e.message : String(e)) }
  }
  return out
}

/**
 * What starting trace's criterion `id` asks, and of whom (test-esp32 log #161): the documents' criterion is Scribe's;
 * a FOLLOW_ON criterion its own specialist's, as asked; any other the stage's specialist (STAGE_WORK), told to finish
 * that criterion only, with the stage's request for what the stage is about. A stage with no STAGE_WORK leaves the
 * agent to trace's router. Pure.
 */
export function ownedWork(stage: StageId, id: string, text: string): { agent?: (typeof SPECIALIST_KINDS)[number]; request: string; started: string; scribe?: true } {
  const name = STAGE_NAMES[stage]
  const what = text.replace(/\.$/, '')
  if (id.endsWith('.docs')) return { scribe: true, request: docsRequest(`${name}'s documents criterion is not met, and nothing was working on it.`, { stage, also: ['journey'] }), started: 'The Documentation agent brings the project\'s documents up to date.' }
  const follow = FOLLOW_ON[id]
  if (follow) return { agent: follow.agent, request: follow.request, started: follow.started }
  const work = STAGE_WORK[stage]
  const request = [
    `The project is in ${name}. Its criterion "${what}" (${id}) is not met, and no job is working on it: the stage's earlier work ended without meeting it.`,
    'Read the gate with journey_status and what the record holds for that criterion. Work already on the default branch stands: do not redo it. Do what is left for this criterion only, and record it with its check (journey.check, or shape.check for a criterion checked by shape).',
    'If a person must decide something first, ask with journey.ask. If it cannot be met, say why in your result, naming what would meet it.',
    ...(work ? ['', 'What the stage asks, for context:', work.request] : []),
  ].join('\n')
  const who = work ? `The ${SPECIALIST_WORDS[work.agent]} agent` : 'trace'
  return { ...(work ? { agent: work.agent } : {}), request, started: `${who} works on "${what}".` }
}

/**
 * Start trace's work on its criterion `id` (ownedWork), as trace (`auto`: journey.get, once a stage opening, refused
 * when a start for it is in the record since: two looks at once start one job) or as a person (journey.start_work).
 * The start is logged before the job is asked for, so a look while it starts reads "starting"; a refused start is
 * logged too, with its reason, so the next step says why. Answers what started, or why not.
 */
export async function startOwnedWork(ctx: Context, repo: string, r: Pick<JourneyRecord, 'journey'>, id: string, text: string, o: { auto: boolean }): Promise<{ started?: string; jobId?: string; jobError?: string; skipped?: true }> {
  const stage = r.journey.currentStage
  const work = ownedWork(stage, id, text)
  const what = text.replace(/\.$/, '')
  const by = o.auto ? 'trace' : label(ctx.principal)
  const claimed = await writeJourney(ctx, repo, (db) => {
    const now = loadJourney(db)
    const since = now ? stageSince(now) : 0
    if (o.auto && now?.decisions.some((d) => (d.kind === OWNED_STARTED || d.kind === OWNED_REFUSED) && d.ref === id && d.at >= since)) return { result: { ok: false }, changed: false }
    decide(db, {
      kind: OWNED_STARTED, stage, ref: id, by,
      summary: o.auto ? `Nothing was working on "${what}", so trace started its work. ${work.started}` : `${by} started trace's work on "${what}". ${work.started}`,
      detail: { auto: o.auto, ...(work.agent ? { agent: work.agent } : {}) },
    })
    return { result: { ok: true } }
  })
  if (!claimed.ok) return { skipped: true }
  let out: { started?: string; jobId?: string; jobError?: string }
  try {
    if (work.scribe) {
      const d = await startScribe(ctx, repo, work.request)
      out = d.started ? { started: d.started, ...(d.jobId ? { jobId: d.jobId } : {}) } : { jobError: d.jobError ?? d.skipped ?? 'trace did not accept the job.' }
    } else {
      const s = await (await ctx.deps.jobs()).startJob({ kind: 'task', repository: repo, request: work.request, ...(work.agent ? { agent: work.agent } : {}), requestedBy: by, requestedBySub: ctx.principal.sub })
      out = s.accepted ? { started: work.started, jobId: s.jobId } : { jobError: s.reason ?? 'trace did not accept the job.' }
    }
  } catch (e) { out = { jobError: e instanceof Error ? e.message : String(e) } }
  if (out.jobError) {
    const reason = out.jobError.replace(/\s+/g, ' ').slice(0, 300).replace(/\.$/, '')
    await writeJourney(ctx, repo, (db) => {
      decide(db, { kind: OWNED_REFUSED, stage, ref: id, by: 'trace', summary: `trace could not start its work on "${what}": ${reason}.`, detail: { reason } })
      return { result: {} }
    }).catch(() => undefined)
  }
  return out
}

/** journey.get's step for trace's criterion with nothing working on it (ownedDue): its work started now when due. */
async function ownedNow(ctx: Context, repo: string, r: JourneyRecord, next: NextStep, due: OwnedDue, viewer: Viewer): Promise<{ step: NextStep; stopped: boolean; started?: string }> {
  if (due.state !== 'start') return ownedStep(next, due, viewer)
  const s = await startOwnedWork(ctx, repo, r, due.criterion, due.text, { auto: true })
    .catch((e: unknown): Awaited<ReturnType<typeof startOwnedWork>> => ({ jobError: e instanceof Error ? e.message : String(e) }))
  if (s.skipped) return ownedStep(next, { ...due, state: 'starting' }, viewer)
  if (s.jobError || !s.started) return ownedStep(next, { ...due, state: 'stopped', why: `trace could not start its work: ${(s.jobError ?? 'it did not accept the job').replace(/\.$/, '')}.` }, viewer)
  return { ...ownedStep(next, { ...due, state: 'starting' }, viewer, { words: s.started, job: s.jobId ?? null }), started: s.started }
}

/**
 * A gate is not the next step while a requirement an agent changed after the requirements baseline is still
 * unaccepted: the gates check the design against the accepted requirements, so the change is the person's to decide
 * first, in Requirements review. Only after the baseline (before it, Requirements review itself is how the
 * requirements are first agreed), and only when the step would be the person signing a gate.
 */
export function changedStep(next: NextStep, stage: string, open: readonly string[]): NextStep {
  if (next.kind !== 'gate' || !next.yours || stage === 'define' || !open.length) return next
  const one = open.length === 1
  const ids = one ? open[0] : `${open.slice(0, -1).join(', ')} and ${open.at(-1)}`
  return {
    kind: 'task', belongs_to: 'you', yours: true,
    summary: `${ids} ${one ? 'was' : 'were'} changed after the requirements baseline and ${one ? 'is' : 'are'} not accepted yet: accept, edit or strike ${one ? 'it' : 'them'} in Requirements review. ${next.summary.replace(/ trace recommends signing\.$/, '')}`,
    why: 'The gates check the design against the accepted requirements, so a changed requirement is agreed before the next gate is signed.',
    recommendation: null, button: 'Open Requirements review', stage: next.stage, ref: { kind: 'skill', id: 'requirements-review' }, step: null, after: 'Once the changed requirements are agreed, the gate is yours to sign.',
  }
}

/** changedStep with the record read: only when it could change the step; a record that cannot be read leaves it. */
async function changedFirst(ctx: Context, repo: string, r: JourneyRecord, next: NextStep): Promise<NextStep> {
  if (next.kind !== 'gate' || !next.yours || r.journey.currentStage === 'define') return next
  const open = await withRecordDb(ctx, repo, (db) => requirementEvidence(db, r).filter((q) => q.status === 'proposed').map((q) => q.id)).catch(() => [] as string[])
  return changedStep(next, r.journey.currentStage, open)
}

/**
 * What a stage kept after a change of requirements still asks of its agent, or undefined when nothing: its criteria
 * trace owns are met again on the evidence it kept, read as journey.get reads them (the agents' facts in, evidence gone
 * out of date not counting). A stage that was in progress when the change came, or whose evidence went out of date,
 * finishes only what is left (finishRequest); a person's criterion left is the person's. Unreadable: the request whole.
 */
async function leftToDo(ctx: Context, repo: string, request: string, w: ReopenedWork): Promise<string | undefined> {
  try {
    const rec = await recordNow(ctx, repo)
    if (!rec) return request
    const stale = await evidenceStaleness(ctx, repo, rec)
    const left = designWorkLeft(stale ? withStaleEvidence(rec, stale) : rec).filter((c) => c.owner === 'trace')
    return left.length ? finishRequest(request, w.scope, left) : undefined
  } catch {
    return request
  }
}

/** The stage's design work left before a person's act (docsAfterDesign compares after it); null when unreadable. */
export const designBefore = (ctx: Context, repo: string): Promise<CriterionRow[] | null> =>
  recordNow(ctx, repo).then((r) => (r ? designWorkLeft(r) : null), () => null)

export const JOURNEY_ACTIONS = {
  'journey.get': def('read', Repo, async ({ repo }, ctx) => {
    const viewer = await viewerOf(ctx.principal, repo)
    // the project's jobs (src/api/actions-jobs.ts listJobs: its job index); an index that cannot be read leaves the
    // journey as it is and says so in jobs_unavailable
    const [{ result: { record: r0, followups }, version: v0 }, facts, jobs] = await Promise.all([journeyStore(ctx, repo).read((db) => ({ record: loadJourney(db), followups: loadFollowups(db) })), agentFacts(ctx, repo),
      listJobs(ctx, repo).then((x) => ({ jobs: x.jobs, rows: x.rows, queue: x.queue, error: null }), (e: unknown) => ({ jobs: [], rows: [], queue: undefined, error: e instanceof Error ? e.message : String(e) }))])
    // a requirement changed after the baseline takes the project back to Define before a gate past it can be signed
    // (returnForChange). The record is read only when a gate is the next step, as changedFirst did
    let r = r0
    let version = v0
    if (r0 && nextStep(r0, viewer).kind === 'gate') {
      const back = await backToDefine(ctx, repo, r0, await changedRequirements(ctx, repo, r0).catch(() => [] as string[]), 'trace').catch(() => null)
      if (back) { r = back.record; version = back.version }
    }
    // the answers trace still has to apply: one whose job was lost or stopped is started again, never dropped
    const kept = followups.length && !jobs.error ? await keepAnswers(ctx, repo, followups, jobs.rows).catch(() => [] as string[]) : []
    // the hand-offs between specialists (jobs.list's): who asked whom, for what, and the answer
    const handoffs = projectHandoffs(repo, facts, r, jobs.rows)
    if (!r) return { repo, ...NOT_STARTED, jobs: jobs.jobs, handoffs }
    // whether the project has agent memory here (the Memory tab): its memory is set up, not that a session has happened
    const hasMemory = Boolean(ctx.deps.memory?.()?.forProject(repo))
    // after a change of requirements: the gates to sign again, and whether each one's evidence stands, so re-signing
    // is seen to be quick (src/api/reopen-scope.ts). The design record is read only while there is such a list
    const rec = r
    const resign = resignBasis(rec) ? await withRecordDb(ctx, repo, (db) => resignPlan(rec, (ids, at) => readTrace(db, ids, at))).catch(() => null) : null
    // the open changes trace made, as steps and (when one is ready) the next step (docs/guided-flow.md). GitHub is
    // asked for the open pull requests and the status of the oldest MAX_STATUS only, through the same short-lived
    // cache as changes.list (src/api/github-cache.ts), so a journey and a list together cost one look; when it cannot be reached the
    // journey is answered without them, and says so in changes_unavailable, rather than guessing
    const open = await openChanges(ctx, repo).then((x) => ({ list: x, error: null }), (e: unknown) => ({ list: [], error: e instanceof Error ? e.message : String(e) }))
    // evidence that has gone out of date since it was checked: the criterion reads as not met until checked again
    const merged = facts ? mergeAgentFacts(r, facts) : r
    const staleRun = await evidenceStaleness(ctx, repo, merged)
    const seen = staleRun ? withStaleEvidence(merged, staleRun) : null
    const changed = withChanges(r, seen ? journeyView(seen, viewer) : journeyView(r, viewer, undefined, facts), viewer, open.list.map(({ change: c, criteria }) => ({
      number: c.number, title: c.title, from: c.from, criteria, ready: c.verdict === 'ready',
      recommendation: c.verdict === 'ready' ? `trace recommends accepting it. ${recommendationOf(c).why}` : null,
    })), { workingOn: jobs.error ? undefined : (id) => runningOn(jobs.rows, id) }) // "Meanwhile, trace goes on with" only over a job running on it (#204)
    // a stage is reviewed and signed only once its work is settled: its gate is locked while a change of it (or an
    // earlier stage) is open or an agent is still working, and the gates into Fabricate while anything is changing
    // a question waiting on a change that is no longer open is out of date (test-esp32 #108); only when the open
    // changes are known, never guessed
    const marked = open.error ? changed : markOutOfDate(changed, merged, open.list.map((x) => x.change.number))
    const view = withPending(r, marked, viewer, pendingOf(open.list, open.error ?? (jobs.error ? `the jobs could not be listed: ${jobs.error}` : null), [], jobs.rows))
    // Define before its requirements exist: the intent first, then trace drafting them, or drafting them again when the
    // job stopped (src/api/drafting.ts); never "accept every requirement" over none. The record is read only when that
    // could change the step, and its count is kept per default-branch commit and record version
    const drafting = jobs.error ? null : await draftingNow(ctx, repo, r, jobs.rows, { next: view.next, version, ...(jobs.queue ? { queue: jobs.queue } : {}) })
    const drafted = drafting ? draftingStep(view.next, r, drafting, viewer, drafting.why) : view.next
    // a job that ended without finishing (test-esp32 log #45, #46): one that left no change is started again once on
    // its own; otherwise the next step says it stopped and offers Start again, never "trace works on …" over it. The
    // drafting job has its own step (Draft the requirements again)
    const at = Date.now() / 1000
    const held = await assertNotHeld(repo).then(() => false, () => true)
    const restarted = jobs.error ? [] : await restartLostJobs(ctx, repo, jobs, open.error ? null : new Set(open.list.map((c) => c.change.job_id).filter((x): x is string => x !== null)),
      { held, at }).catch(() => [] as string[])
    const lost = jobs.error ? [] : openLostJobs(jobs.jobs, jobs.rows, at).filter((j) => !restarted.includes(j.title) && j.id !== drafting?.job?.id)
    const lostNext = lostJobStep(drafted, lost, viewer, (id) => { const row = jobs.rows.find((x) => x.id === lost.find((j) => j.id === id)?.workerJobId); return Boolean(row && restartable(row)) })
    // checks no runner picks up (test-esp32 log #146): trace cancels and runs them again on its own now and then, which
    // is also how it notices the runner was fixed (src/api/stuck-checks.ts)
    const look = open.error || held ? null : await stuckLook(ctx, repo, at).catch(() => null)
    if (dueRetry(repo, look, at)) {
      await rerunStuck(ctx, repo, null, look).then(
        (r) => logLine(ctx, { event: 'checks.retried', repo, by: 'trace', ...r }),
        (e: unknown) => logLine(ctx, { warning: 'journey.get: the stuck checks could not be run again', repo, error: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) }),
      )
    }
    // a person's review while trace's work for it is still under way: trace is working, not "your move" (#33, #92)
    const reviewing = jobs.error ? lostNext : reviewWaits(lostNext, r, { gates: view.gates, rows: jobs.rows, repo, at, words: STAGE_WORK[r.journey.currentStage]?.started })
    // who the step waits on when it would say trace is working and nothing of trace's is (test-esp32 log #146, #147)
    const working = jobs.error ? 1 : workingNow(jobs.rows, at)
    const waits = waitsOn(reviewing, { changes: open.list.map((x) => x.change), working, gates: view.gates, viewer, at })
    // trace's criterion with nothing at all working on it (#161): trace starts its work once, on its own; after that,
    // or when it cannot, the step says so with Start it (journey.start_work), never "trace is working" over nothing
    const due = waits.step !== reviewing || held || open.error ? null
      : ownedDue(waits.step, r, { gates: view.gates, rows: jobs.rows, working, queued: jobs.queue?.queued.length ?? 0, changes: open.list.length, at })
    const owned = due ? await ownedNow(ctx, repo, r, waits.step, due, viewer) : null
    const next = owned?.step ?? waits.step
    const stages = waitsOnSteps(owned?.stopped || (lostNext !== drafted && lostNext.job_id) ? stoppedSteps(view.stages) : view.stages, waits.owner)
    return {
      repo, started: true, you: { admin: viewer.admin, part: viewer.part }, has_memory: hasMemory, ...view, stages, next: await changedFirst(ctx, repo, r, next),
      ...(restarted.length ? { jobs_restarted: restarted } : {}),
      ...(owned?.started ? { work_started: [owned.started] } : {}),
      ...(drafting ? { drafting: { state: drafting.state, job: drafting.job, why: drafting.why || null } } : {}),
      jobs: jobs.jobs, handoffs, ...(jobs.error ? { jobs_unavailable: jobs.error.slice(0, 200) } : {}), ...(kept.length ? { answers_restarted: kept } : {}),
      ...(seen && staleCriteria(seen).length ? { stale_evidence: staleCriteria(seen) } : {}),
      ...(resign ? { resign } : {}),
      ...(open.error ? { changes_unavailable: open.error.slice(0, 200) } : {}),
    }
  }),

  // trace's criterion of the current stage with nothing working on it (src/api/owned-work.ts, test-esp32 log #161): the
  // next step's Start it. The criterion named, or the first of trace's the stage has not met (as the next step picks
  // it). Refused, in words, while a job of trace's is working on the project, or the project is paused or retired
  'journey.start_work': def('write', Repo.extend({ criterion: Id.optional() }), async (a, ctx) => {
    await assertNotHeld(a.repo).catch((e: unknown) => { throw new ActionError(e instanceof Error ? e.message : String(e)) })
    const [rec, list] = await Promise.all([recordNow(ctx, a.repo), listJobs(ctx, a.repo)])
    if (!rec) throw new ActionError('This project has not started its journey yet.')
    const busy = workingNow(list.rows) + list.queue.queued.length
    if (busy) throw new ActionError(`trace is working on this project already (${busy === 1 ? '1 job' : `${busy} jobs`} queued or running): see what it is doing on the Overview.`)
    const stale = await evidenceStaleness(ctx, a.repo, rec).catch(() => undefined)
    const seen = stale ? withStaleEvidence(rec, stale) : rec
    const left = designWorkLeft(seen).filter((c) => c.owner === 'trace')
    const docs = seen.criteria.filter((c) => c.id.endsWith('.docs') && c.status !== 'met' && seen.gates.some((g) => g.id === c.gate && g.stage === seen.journey.currentStage)
      && !seen.waivers.some((w) => w.targetKind === 'criterion' && w.target === c.id && w.closedAt === null))
    const c = a.criterion ? [...left, ...docs].find((x) => x.id === a.criterion) : (left[0] ?? docs[0])
    if (!c) throw new ActionError(a.criterion ? `${a.criterion} is not a criterion of trace's that ${STAGE_NAMES[seen.journey.currentStage]} still needs.` : `Every criterion of trace's in ${STAGE_NAMES[seen.journey.currentStage]} is met or waived: there is nothing to start.`)
    const s = await startOwnedWork(ctx, a.repo, seen, c.id, c.text, { auto: false })
    if (!s.started) throw new ActionError(`trace could not start its work on "${c.text.replace(/\.$/, '')}": ${(s.jobError ?? 'it did not accept the job').replace(/\.$/, '')}.`)
    return { repo: a.repo, criterion: c.id, jobId: s.jobId ?? null, started: [s.started] }
  }),

  // the drafting job stopped (lost, failed, cancelled, or never started) with the intent submitted and no requirements:
  // start it again, as Submit did (src/api/drafting.ts), as a new attempt. Refused, in words, while it is not stopped
  'requirements.draft': def('write', Repo, async ({ repo }, ctx) => {
    const [{ result: r, version }, list] = await Promise.all([journeyStore(ctx, repo).read((db) => loadJourney(db)), listJobs(ctx, repo)])
    if (!r) throw new ActionError('This project has not started its journey yet.')
    const d = await draftingNow(ctx, repo, r, list.rows, { version, queue: list.queue })
    if (!d) throw new ActionError(r.journey.currentStage === 'define' ? 'trace could not read the requirements just now, so it does not start drafting them again. Try again in a minute.' : 'The requirements are drafted already: the project is past Define.')
    if (d.state !== 'stopped') {
      throw new ActionError({
        intent: 'Write and submit the intent in the Intent builder first: trace drafts the requirements from it.',
        waiting: 'trace drafts the requirements once this project\'s agent is set up: the drafting is queued already.',
        drafting: 'trace is drafting the requirements already.',
        drafted: 'The requirements are drafted: they wait in a change from the Verification specialist. Accept it to bring them into Requirements review.',
        done: 'The requirements are in the record: decide them in Requirements review.',
        stopped: '',
      }[d.state])
    }
    // the highest attempt recorded, plus one: a new session (src/api/workers.ts taskSession)
    const attempt = d.attempts + 1
    const s = await draftRequirements(ctx, repo, attempt)
    if (!s.accepted) throw new ActionError(`trace could not start drafting the requirements: ${s.reason ?? 'it did not accept the job'}.`)
    // logged with its time and attempt: until the new job is in the index, the next look reads "drafting" (the grace
    // counts from this retry, not from Submit) and a second press is refused rather than started in the same session
    const logged = await writeJourney(ctx, repo, (db) => { logRetry(db, { attempt, by: label(ctx.principal), jobId: s.jobId }); return { result: {} } })
    return { repo, jobId: s.jobId, attempt, version: logged.version, started: ['The Verification agent drafts the candidate requirements again, from your submitted intent.'] }
  }),

  'journey.criterion.open': def('read', Repo.extend({ criterion: Id.optional(), waiver: Id.optional() }).refine((a) => Boolean(a.criterion) !== Boolean(a.waiver), 'name a criterion or a waiver'), async (a, ctx) => {
    const who = hashOf(ctx.principal)
    const viewer = { hash: who, also: hashesOf(ctx.principal) }
    const item = a.criterion ? { criterion: a.criterion } : { waiver: a.waiver as string }
    // the agents' checks move a criterion's checkedAt, and an open from before it does not count (openedBy): read them
    // to tell whether this person's open still counts. Unreadable, the open is written anyway
    const facts = await agentFacts(ctx, a.repo).catch(() => null)
    return journeyWrite(ctx, a.repo, (db) => {
      const before = loadJourney(db)
      const key = a.criterion ?? `waiver:${a.waiver}`
      // opening it again while the earlier open still counts changes nothing: no write. An earlier open that no longer
      // counts (from before the gate was last signed or returned, or before the criterion was checked again) is no
      // reason to skip it: that skipped the write and answered the old version, and the gate stayed at "opened 0 of 3"
      // however often the person opened the evidence (test-esp32-e2e, the Architect gate after #320)
      const counted = before ? openedBy(facts ? mergeAgentFacts(before, facts) : before, viewer).has(key) : false
      const kept = counted ? before?.opens.find((o) => o.item === key && isViewer(viewer, o.who)) : undefined
      if (kept) return { result: { repo: a.repo, opened: key, at: new Date(kept.at * 1000).toISOString() }, changed: false }
      const opened = recordOpen(db, item, who)
      return { result: { repo: a.repo, opened: opened.item, at: opened.at } }
    })
  }),

  'gate.sign': def('admin', Repo.extend({ gate: Id, acknowledge: z.array(Id).max(100).default([]), notes: z.string().trim().max(4000).optional(), time_zone: TimeZone }), async (a, ctx) => {
    // the agents' checks of the criteria trace owns count towards the gate; the signing rules are the record's own
    const facts = await agentFacts(ctx, a.repo)
    const now0 = (await journeyStore(ctx, a.repo).read((db) => loadJourney(db))).result
    // a requirement changed after the baseline: no gate past Define is signed over it. The project goes back to
    // Define (returnForChange) and the signature is refused, saying why. A record that cannot be read does not stop
    // a gate, except the ones into Fabricate (below)
    let changedReqs: string[] | null = null
    if (now0) {
      changedReqs = await changedRequirements(ctx, a.repo, now0).catch(() => null)
      const back = await backToDefine(ctx, a.repo, now0, changedReqs ?? [], label(ctx.principal))
      if (back) throw new ActionError(`The gate was not signed: ${back.reason}. ${back.words}: agree the change in Requirements review and sign the requirements baseline again; every gate after it is signed again.`)
    }
    // a stage is signed only once its work is settled: every gate asks GitHub for the open changes and the job index
    // for the agents still working, now, and stays locked when either cannot answer (pendingBlockers). The changed
    // requirements count at the gates into Fabricate
    let pending: PendingChanges | null = null
    if (now0) {
      const [open, jobs] = await Promise.all([
        openChanges(ctx, a.repo).then((x) => ({ list: x, error: null }), (e: unknown) => ({ list: [], error: e instanceof Error ? e.message : String(e) })),
        listJobs(ctx, a.repo).then((x) => ({ rows: x.rows, error: null }), (e: unknown) => ({ rows: [], error: e instanceof Error ? e.message : String(e) })),
      ])
      const fab = guardsFabricate(now0, a.gate)
      const why = open.error ?? (jobs.error ? `the jobs could not be listed: ${jobs.error}` : null) ?? (fab && changedReqs === null ? 'the requirements could not be read' : null)
      // a job waiting on an open question says so in the refusal, as on the gate page (#197)
      const viewer = await viewerOf(ctx.principal, a.repo)
      pending = withAsks(pendingOf(open.list, why, fab ? (changedReqs ?? []) : [], jobs.rows), journeyView(now0, viewer, undefined, facts).questions)
    }
    // a criterion met on evidence that is now out of date does not count until it is checked again
    const staleRun = now0 ? await evidenceStaleness(ctx, a.repo, facts ? mergeAgentFacts(now0, facts) : now0) : undefined
    // the stage this signature opens again after a change of requirements, and what the change reaches in it: a stage
    // it does not reach keeps its evidence and starts no agent (src/api/reopen-scope.ts; test-esp32 #71, #114, #116)
    const again: ReopenedWork | null = now0 ? await reopenedWork(ctx, a.repo, now0, a.gate).catch(() => null) : null
    const { ready_at: readyAt, signed_at: signedAt, ...signed } = await journeyWrite(ctx, a.repo, (db) => {
      // when the gate became ready, from the record as it stood before the signature (its criteria and waivers)
      const before = loadJourney(db)
      const at = Date.now() / 1000
      const ready = before ? gateReadyAt(facts ? mergeAgentFacts(before, facts) : before, a.gate, at) : null
      const r = signGate(db, a.gate, signer(ctx), { acknowledged: a.acknowledge, notes: a.notes ?? null, facts, pending, staleRun })
      if (again && r.advanced_to === again.stage) {
        const name = STAGE_NAMES[again.stage]
        if (again.scope.kept) {
          carryStage(db, again.stage, keptOf(again.reopens), again.reopens.map((x) => x.at), {
            by: 'trace', summary: `${name} keeps its work after the change of requirements: ${again.scope.why} Its gate is signed again on the same evidence.`, detail: { requirements: again.ids },
          })
        } else {
          decide(db, { kind: 'stage.rework', stage: again.stage, ref: again.stage, by: 'trace', summary: `${name} redoes only what the change of requirements reaches: ${again.scope.why}.`, detail: { requirements: again.ids, reach: again.scope.reach } })
        }
      }
      return { result: { repo: a.repo, ...r, ready_at: ready, signed_at: at } }
    })
    // saved: the wait from ready to signed (src/api/process-metrics.ts)
    recordWait(a.repo, 'gate', readyAt, signedAt)
    const reopened = again && signed.advanced_to === again.stage ? again : null
    // the stage the signature opened starts its agents' work (docs/user-journey.md, each stage's "trace:"); the
    // signature stands even when the job cannot start. Opened again after a change of requirements, it is asked to
    // redo only what the change reaches; a stage the change does not reach starts nothing unless it has work left
    const work = signed.advanced_to ? STAGE_WORK[signed.advanced_to] : undefined
    let request = work?.request
    if (work && reopened) request = reopened.scope.kept ? await leftToDo(ctx, a.repo, work.request, reopened) : scopedRequest(work.request, reopened.scope, reopened.ids, reopened.trace)
    let kickoff: { jobId?: string; started?: string[]; jobError?: string } = {}
    if (work && request) {
      try {
        // named by what it does (its request leads with why the stage is open again: test-esp32 #196)
        const headline = reopened ? reopenHeadline(reopened.stage, reopened.scope.kept) : undefined
        const r = await (await ctx.deps.jobs()).startJob({ kind: 'task', repository: a.repo, request, ...(headline ? { headline } : {}), agent: work.agent, requestedBy: label(ctx.principal), requestedBySub: ctx.principal.sub })
        kickoff = r.accepted ? { jobId: r.jobId, started: [work.started] } : { jobError: r.reason ?? 'trace did not accept the job.' }
      } catch (e) { kickoff = { jobError: e instanceof Error ? e.message : String(e) } }
    }
    // what the person is told: what the stage kept, or what it redoes
    const told = reopened ? {
      stage: reopened.stage, kept: reopened.scope.kept, why: reopened.scope.why, requirements: reopened.ids,
      words: reopened.scope.kept
        ? `${reopened.scope.why}${request ? ' trace finishes what was still to do.' : ' Sign its gate again; nothing is redone.'}`
        : `Only what the change reaches is redone: ${reopened.scope.why}.`,
    } : null
    if (told) signed.summary = `${signed.summary} ${told.words}`
    // the stage that opened may need new documents or sections, but they are written from its design: while it has
    // design work to do (nearly always, on opening) Scribe waits for it, and the push or the person's act that lands
    // the last of it starts Scribe (docs-follow.ts docsAfterDesign). A stage with no design work of its own starts it
    // now; a stage that needs no documents starts nothing, and the signature stands whatever happens here
    // (a signature that cuts a release asks for the release copies instead, below: one Scribe job does both)
    // A stage kept after a change of requirements has its documents already: they are written from its design, which
    // the change did not reach (test-esp32 #114, #116: a docs change each re-sign, locking the gate). The stage whose
    // work is redone writes them when its work lands, and the nightly check catches anything else
    const stageDocs = async (): Promise<void> => {
      if (!signed.advanced_to || !docsFor(signed.advanced_to, true).length || reopened?.scope.kept) return
      const d = await startStageScribe(ctx, a.repo, `The ${a.gate} gate was signed and ${STAGE_NAMES[signed.advanced_to]} opened.`, { also: ['journey'] })
      if (d.started) kickoff = { ...kickoff, started: [...(kickoff.started ?? []), d.started] }
    }
    const reopen = told ? { reopen: told } : {}
    if (!signed.released) {
      await stageDocs()
      return { ...signed, ...kickoff, ...reopen, snapshot: null }
    }
    // the signature cut a release: the record goes into the repository with it
    try {
      const s = await snapshot(ctx, a.repo, `${a.gate} signed`)
      // the revision's renders, made by the rendering agent from what was released (docs/revision-renders.md)
      const renders = await startRenders(ctx, a.repo, s.revision, a.time_zone)
      // and its documents, brought up to date and printed as its release copies (docs/scribe.md "Publishing")
      const documents = await startReleaseDocs(ctx, a.repo, s.revision, a.time_zone, signed.advanced_to)
      const said = renders.started ? ` ${renders.started}` : ` Its renders could not be started: ${renders.jobError ?? 'trace did not accept the job'}.`
      const docSaid = documents.started ? ` ${documents.started}` : ` Its documents could not be printed: ${documents.jobError ?? 'trace did not accept the job'}.`
      return {
        ...signed, ...kickoff, version: s.version, snapshot: { branch: s.branch, commit: s.commit, change: s.change }, renders, documents,
        started: [...(kickoff.started ?? []), ...(renders.started ? [renders.started] : []), ...(documents.started ? [documents.started] : [])],
        summary: `${signed.summary} The record was copied into the repository.${said}${docSaid}`,
      }
    } catch (e) {
      await stageDocs()
      return { ...signed, ...kickoff, snapshot: { error: `The gate is signed, but the record could not be copied into the repository: ${e instanceof Error ? e.message : String(e)}. An admin can copy it with journey.snapshot.` } }
    }
  }),

  'journey.snapshot': def('admin', Repo.extend({ reason: z.string().trim().max(300).default('copied by an admin'), renders: z.boolean().default(true), documents: z.boolean().default(true), time_zone: TimeZone }), async (a, ctx) => {
    const s = await snapshot(ctx, a.repo, a.reason)
    // a revision copied by hand gets its renders too, unless the admin says not to
    // and its documents' release copies, unless the admin says not to
    return {
      repo: a.repo, ...s, ...(a.renders ? { renders: await startRenders(ctx, a.repo, s.revision, a.time_zone) } : {}),
      ...(a.documents ? { documents: await startReleaseDocs(ctx, a.repo, s.revision, a.time_zone, null) } : {}),
    }
  }),

  'gate.return': def('write', Repo.extend({ gate: Id, reason: z.string().trim().min(1).max(4000), reopen: z.enum(STAGE_IDS).optional() }), async (a, ctx) =>
    journeyWrite(ctx, a.repo, (db) => {
      const r = returnGate(db, a.gate, signer(ctx), { reason: a.reason, reopen: a.reopen })
      return { result: { repo: a.repo, ...r, summary: r.reopened ? `Returned. ${r.reopened} is reopened.` : 'Returned with what has to change.' } }
    })),

  // a criterion an admin added to the template, which a person signs off by saying what they checked (no skill meets it)
  'criterion.confirm': def('write', Repo.extend({ criterion: Id, met: z.boolean().default(true), note: z.string().trim().max(300).default('') }), async (a, ctx) => {
    const before = await designBefore(ctx, a.repo)
    const out = await journeyWrite(ctx, a.repo, (db) => {
      confirmCriterion(db, a.criterion, { met: a.met, note: a.note }, signer(ctx))
      return { result: { repo: a.repo, criterion: a.criterion, met: a.met, summary: a.met ? 'Signed off.' : 'Taken back: it is not met.' } }
    })
    // the last of the stage's design work signed off: its documents are written now
    const docs = await docsAfterDesign(ctx, a.repo, before).catch(() => ({ started: undefined }))
    return docs.started ? { ...out, started: [docs.started] } : out
  }),

  'question.answer': def('write', Repo.extend({
    question: Id, option: Id.optional(), answer: z.string().trim().max(4000).optional(), reason: z.string().trim().max(2000).optional(),
    // what the person said the answer lasts as (Question answer's last step): it reaches the specialist carried on
    lasts: z.enum(['once', 'rule', 'requirement']).optional(),
  }), async (a, ctx) => {
    // an agent's question lives in its facts; the answer is written here, in the record, under the same id
    const facts = await agentFacts(ctx, a.repo)
    const before = await designBefore(ctx, a.repo)
    const answered = await journeyWrite(ctx, a.repo, (db) => {
      const q = answerQuestion(db, a.question, signer(ctx), { option: a.option, answer: a.answer, reason: a.reason, lasts: a.lasts }, { facts })
      return { result: { repo: a.repo, question: q, summary: `Answered.${waivedWords(q)} The agent carries on.` } }
    })
    // saved: the wait from asked to answered (src/api/process-metrics.ts)
    recordAnswered(a.repo, answered.question)
    // an agent that asked and then ended (its question left in its report) reads the answer only in a next job: start
    // that job, on the asking job's branch, so the answer is acted on now; the answer stands whatever happens here
    // an answer that approves the last of the stage's design work (the board renders): its documents are written now
    const docs = await docsAfterDesign(ctx, a.repo, before).catch(() => ({ started: undefined }))
    // an answer made a rule for the project goes into .trace/rules.md, where every agent reads its rules (log #109)
    const rule = a.lasts === 'rule' ? await ruleFromAnswer(ctx, a.repo, a.question) : {}
    const ruled = { ...(rule.rule ? { rule: rule.rule } : {}), ...(rule.rule_error ? { rule_error: rule.rule_error } : {}) }
    const asked = askedBy(facts, a.question)
    if (!asked?.jobId) {
      const started = [...(docs.started ? [docs.started] : []), ...(rule.started ?? [])]
      return { ...answered, ...ruled, ...(started.length ? { started } : {}) }
    }
    const carried: { started?: string[]; jobError?: string } = await carryOn(ctx, a.repo, asked, answered.question, a.lasts).catch((e: unknown) => ({ jobError: e instanceof Error ? e.message : String(e) }))
    const started = [...(carried.started ?? []), ...(docs.started ? [docs.started] : []), ...(rule.started ?? [])]
    const said = (carried as { summary?: string }).summary
    return { ...answered, ...carried, ...ruled, ...(said ? { summary: said.replace(/^Answered\./, `Answered.${waivedWords(answered.question)}`) } : {}), ...(started.length ? { started } : {}) }
  }),

  'stuck.dismiss': def('write', Repo.extend({ job: Id, reason: z.string().trim().min(3).max(300) }), async (a, ctx) => {
    // `job`: the stuck agent's job id, or the stuck item's own id (its question id in the views, which the app has)
    const facts = await agentFacts(ctx, a.repo)
    return journeyWrite(ctx, a.repo, (db) => {
      const d = dismissStuck(db, a.job, signer(ctx), a.reason, { facts })
      return { result: { repo: a.repo, dismissed: d, summary: 'Dismissed. The agent is told why.' } }
    })
  }),

  'waiver.add': def('write', Repo.extend({
    target: z.object({ kind: z.enum(WAIVER_TARGETS), id: Id }),
    reason: z.string().trim().min(1).max(2000),
    risk: z.string().trim().min(1).max(2000),
    severity: z.enum(SEVERITIES),
    caught_where: z.string().trim().max(300).nullable(),
    scope: z.string().trim().min(1).max(300).default('this revision only'),
    // the waiver this one takes again: it is withdrawn as this one is recorded
    replaces: Id.optional(),
  }), async (a, ctx) => {
    const facts = await agentFacts(ctx, a.repo)
    const before = a.target.kind === 'criterion' ? await designBefore(ctx, a.repo) : null
    const out = await journeyWrite(ctx, a.repo, (db) => {
      const w = addWaiver(db, { target: a.target, reason: a.reason, risk: a.risk, severity: a.severity, caught_where: a.caught_where, scope: a.scope }, { ...signer(ctx), admin: isAdmin(ctx.principal) }, { facts, replaces: a.replaces })
      return { result: { repo: a.repo, waiver: w, ...(a.replaces ? { replaced: a.replaces } : {}) } }
    })
    // a criterion waived may be the last of the stage's design work: its documents are written now
    const docs = await docsAfterDesign(ctx, a.repo, before).catch(() => ({ started: undefined }))
    return docs.started ? { ...out, started: [docs.started] } : out
  }),

  'waiver.withdraw': def('write', Repo.extend({ waiver: Id, reason: z.string().trim().min(1).max(2000) }), async (a, ctx) => {
    const facts = await agentFacts(ctx, a.repo)
    return journeyWrite(ctx, a.repo, (db) => {
      const w = withdrawWaiver(db, a.waiver, { ...signer(ctx), admin: isAdmin(ctx.principal) }, a.reason, { facts })
      return { result: { repo: a.repo, waiver: w, summary: `Withdrawn. ${w.target.kind === 'criterion' ? 'The criterion counts again: it is not met until it is met or waived again.' : `The ${w.target.kind} counts again.`}` } }
    })
  }),

  'journey.time': def('read', Repo, async ({ repo }, ctx) => {
    const [r, facts] = await Promise.all([withJourneyDb(ctx, repo, (db) => loadJourney(db)), agentFacts(ctx, repo).catch(() => null)])
    if (!r) return { repo, started: false, project: null, stages: [] }
    const at = Date.now() / 1000
    return { repo, started: true, project: r.journey.name ?? repo, at: new Date(at * 1000).toISOString(), stages: stageTimes(facts ? mergeAgentFacts(r, facts) : r, at) }
  }),

  inbox: def('signed-in', z.object({ kinds: z.array(z.enum(INBOX_KINDS)).optional(), limit: z.number().int().min(1).max(200).default(50) }), async (a, ctx) => {
    if (classOf(ctx.principal) === null) throw new AccessDenied(NO_ACCESS)
    const all = await projectsFor(ctx.principal)
    // a paused project asks nothing of anyone until it is resumed: it is listed apart, not as things to do
    const paused = all.flatMap((p) => (p.paused ? [{ repo: p.repo, by: p.paused.by, at: p.paused.at }] : []))
    const projects = all.filter((p) => !p.paused)
    const unavailable: { repo: string; reason: string }[] = []
    const per = await mapLimit(projects, INBOX_PARALLEL, async (p): Promise<InboxItem[]> => {
      try {
        const r: JourneyRecord | null = await withJourneyDb(ctx, p.repo, (db) => loadJourney(db))
        if (!r) return []
        const facts = await agentFacts(ctx, p.repo)
        const items = inboxItems(p.repo, r, { hash: hashOf(ctx.principal), also: hashesOf(ctx.principal), label: label(ctx.principal), admin: isAdmin(ctx.principal), part: p.part, sub: ctx.principal.sub }, undefined, facts)
        // the open pull requests trace's jobs opened, for those who can merge them (admins and contributors)
        const wantReview = (!a.kinds || a.kinds.includes('review')) && (isAdmin(ctx.principal) || p.part === 'contributor')
        if (wantReview) items.push(...await openReviews(ctx, p.repo, r.journey.name ?? p.repo, r.journey.currentStage).catch((e: unknown) => {
          unavailable.push({ repo: p.repo, reason: `its pull requests: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}` })
          return []
        }))
        return items
      } catch (e) {
        unavailable.push({ repo: p.repo, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) })
        return []
      }
    })
    const items = sortInbox(per.flat().filter((i) => !a.kinds || a.kinds.includes(i.kind))).slice(0, a.limit)
    const n = items.length
    return {
      summary: n ? `${n} ${n === 1 ? 'thing needs' : 'things need'} you.` : 'Nothing needs you. trace will tell you when something does.',
      items, unavailable, paused,
    }
  }),
}

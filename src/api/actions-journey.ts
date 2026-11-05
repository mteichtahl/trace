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
 *   journey.criterion.open  read     record that this person opened a criterion's (or a waiver's) evidence: the Sign
 *                                    button needs every one opened by the signer. Reviewers may open evidence too
 *   gate.sign               admin    sign a gate: every criterion met or waived, every piece of evidence and every
 *                                    waiver of the stage opened by the signer, every waiver acknowledged (this call
 *                                    acknowledges the ones named). Otherwise refused with what is missing
 *   gate.return             write    return a gate with what has to change; optionally reopen the earlier stage the
 *                                    problem belongs to
 *   question.answer         write    answer an agent's question: an option (the recommended one, or another with a
 *                                    reason) or an answer in words
 *   waiver.add              write    take a waiver: reason, risk, severity, where it is caught instead, scope
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
  type AgentFacts, INBOX_KINDS, type InboxItem, type NextStep, type StageId, decide, type JourneyRecord, type Viewer, SEVERITIES, STAGE_IDS, WAIVER_TARGETS, answerQuestion, addWaiver, inboxItems,
  confirmCriterion, dismissStuck, guardsFabricate, journeyView, loadJourney, mergeAgentFacts, nextStep, type PendingChanges, recordOpen, returnGate, signGate, sortInbox, withChanges, withPending, withStaleEvidence, staleCriteria,
} from '../core/journey.js'
import { gateReadyAt, stageTimes } from '../core/process-time.js'
import { recordAnswered, recordWait } from './process-metrics.js'
import { openChanges, openPulls, projectEdits, projectRule } from './actions-changes.js'
import { recordEdit } from './edits.js'
import { recommendationOf } from './changes.js'
import { AGENT_WORDS, jobIndex, listJobs, projectHandoffs } from './actions-jobs.js'
import { editReviewItems, reviewItems } from './inbox-review.js'
import { loadJobs } from '../core/job-index.js'
import { evidenceStaleness } from './evidence-freshness.js'
import { STAGE_NAMES } from '../core/journey-catalog.js'
import { docsFor } from '../docs/catalog.js'
import { docsReleaseRequest, docsRequest, startScribe } from './docs-follow.js'
import { ActionError, type Context, NO_ACCESS, Repo, agentFacts, def, hashOf, hashesOf, journeyStore, label, plainly, snapshotJourney, withJourneyDb, withRecordDb, writeJourney } from './action-kit.js'
import { requirementEvidence } from './record-read.js'
import { backToDefine, changedRequirements, pendingOf } from './pending-changes.js'
import { SPECIALIST_KINDS, SPECIALIST_WORDS } from '../agents/kinds.js'
import { isLive } from '../core/job-index.js'
import { draftRequirements, draftingNow, draftingStep, logRetry } from './drafting.js'

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
  const [rule, edits] = await Promise.all([projectRule(ctx, repo), projectEdits(ctx, repo)])
  return [
    ...reviewItems({ repo, project, stage, pulls, jobs, rule, agentWords: AGENT_WORDS }),
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
export function answeredRequest(a: { id: string; text: string; jobId: string; branch: string; answer: string; reason: string | null; by: string | null; lasts?: Lasts | undefined }): string {
  return [
    `Your question ${a.id} (asked in job ${a.jobId}) is answered. You asked: ${a.text}`,
    `${a.by ?? 'A person'} answered: ${a.answer}${a.reason ? ` (because ${a.reason})` : ''}.`,
    `Carry the work on ${a.branch} on with that answer: read what is already on the branch, change what the answer changes, check it as before, and push to the same branch so its pull request updates.`,
    ...(a.lasts === 'requirement' ? ['They said this answer changes a requirement. Have the change proposed for a person to accept in Requirements review: the requirement, its new wording and measurable criterion, and why (the Verification specialist owns the requirements: journey.handoff to it unless you are it, then verify.requirements, left proposed). Until it is accepted, treat the requirement as it stands, and say in your report that the change waits on review.'] : []),
    ...(a.lasts === 'rule' ? ['They made this a rule for the project: remember it (memory.remember) so later jobs apply it without asking again.'] : []),
    'Do not redo what the answer does not touch. If the answer cannot be done as given, ask again (journey.ask) with what you found.',
  ].join('\n')
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

/**
 * After an answer: when the job that asked has ended, a task for the same specialist on that job's branch, told the
 * answer. A job still queued, running or paused reads the answer itself (journey.status, or on Resume): nothing starts.
 */
export async function carryOn(ctx: Context, repo: string, asked: { id: string; text: string; jobId: string | null }, q: { answered: { answer: string; reason: string | null; by: string | null } | null }, lasts?: Lasts): Promise<{ jobId?: string; started?: string[]; jobError?: string; summary?: string }> {
  if (!asked.jobId || !q.answered) return {}
  const { rows } = await listJobs(ctx, repo)
  const row = rows.find((r) => r.id === asked.jobId)
  // the job still runs, waits or is paused: it reads the answer itself
  if (row && (row.state === 'queued' || row.state === 'paused' || isLive(row, Date.now() / 1000))) return {}
  const agent = row ? SPECIALIST_KINDS.find((k) => k === row.agent) : undefined
  // the specialist's own row may not carry the branch its worker pushed to
  const branch = row ? row.branch ?? rows.find((r) => r.parentJob === row.id && r.branch)?.branch ?? null : null
  // never say the agent carries on when nothing will: the answer waits for whichever job asks next
  if (!row || !agent || !branch) return { summary: `Answered. The job that asked (${asked.jobId}) has ended and could not be started again${!row ? ' (it is not in the project\'s job list)' : !agent ? ` (${row.agent ?? 'no'} agent is not a specialist)` : ' (it has no branch)'}: the answer is kept for its next job.` }
  const request = answeredRequest({ id: asked.id, text: asked.text, jobId: row.id, branch, answer: q.answered.answer, reason: q.answered.reason, by: q.answered.by, lasts })
  const r = await (await ctx.deps.jobs()).startJob({ kind: 'task', repository: repo, request, agent, branch, requestedBy: label(ctx.principal), requestedBySub: ctx.principal.sub })
  const who = `the ${SPECIALIST_WORDS[agent]} specialist`
  return r.accepted
    ? { jobId: r.jobId, started: [`The ${SPECIALIST_WORDS[agent]} specialist carries on with your answer on ${branch}.`], summary: `Answered. The ${SPECIALIST_WORDS[agent]} specialist carries on with it on ${branch}.` }
    : { jobError: r.reason ?? 'trace did not accept the job.', summary: `Answered, but ${who} could not be started again: ${r.reason ?? 'trace did not accept the job'}. The answer is kept for its next job.` }
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
 * options a person then chooses between in Architecture choice (docs/user-journey.md, 2. Architect). A stage with
 * trace-owned criteria and no entry here starts nothing, and waits with the next step saying trace is working.
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
      'Datasheets: pull each active part\'s datasheet and compare its limits (voltages, currents, power, temperature) with the operating point; record capture.datasheets with journey.check, each conflict named with the page it comes from.',
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
    ].join('\n'),
  },
  signoff: {
    agent: 'verify',
    started: 'The Verification agent closes coverage and writes the release report for Sign-off.',
    request: [
      'The layout review gate was signed: the project is in Sign-off. Prepare the release report.',
      'Run what the layout made possible (the items planned for after layout), then close coverage (verify.coverage): every requirement verified or waived, the gaps named. Record signoff.coverage with journey.check.',
      'Hand the parts list check (cost and stock at the build quantity, then shape.check signoff.bom) to the Implementation specialist, and the interference prechecks (then signoff.emc) to the EMC specialist, each with journey.handoff, and put their answers in the report.',
      'Write the release report with verify.report: coverage, interference estimates, the parts list and its cost, and every open waiver, for a person to review. Do not sign or waive anything yourself.',
    ].join('\n'),
  },
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

export const JOURNEY_ACTIONS = {
  'journey.get': def('read', Repo, async ({ repo }, ctx) => {
    const viewer = await viewerOf(ctx.principal, repo)
    // the project's jobs (src/api/actions-jobs.ts listJobs: its job index); an index that cannot be read leaves the
    // journey as it is and says so in jobs_unavailable
    const [{ result: r0, version: v0 }, facts, jobs] = await Promise.all([journeyStore(ctx, repo).read((db) => loadJourney(db)), agentFacts(ctx, repo),
      listJobs(ctx, repo).then((x) => ({ jobs: x.jobs, rows: x.rows, error: null }), (e: unknown) => ({ jobs: [], rows: [], error: e instanceof Error ? e.message : String(e) }))])
    // a requirement changed after the baseline takes the project back to Define before a gate past it can be signed
    // (returnForChange). The record is read only when a gate is the next step, as changedFirst did
    let r = r0
    let version = v0
    if (r0 && nextStep(r0, viewer).kind === 'gate') {
      const back = await backToDefine(ctx, repo, r0, await changedRequirements(ctx, repo, r0).catch(() => [] as string[]), 'trace').catch(() => null)
      if (back) { r = back.record; version = back.version }
    }
    // the hand-offs between specialists (jobs.list's): who asked whom, for what, and the answer
    const handoffs = projectHandoffs(repo, facts, r, jobs.rows)
    if (!r) return { repo, ...NOT_STARTED, jobs: jobs.jobs, handoffs }
    // whether the project has agent memory here (the Memory tab): its memory is set up, not that a session has happened
    const hasMemory = Boolean(ctx.deps.memory?.()?.forProject(repo))
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
    })))
    // a stage is reviewed and signed only once its work is settled: its gate is locked while a change of it (or an
    // earlier stage) is open or an agent is still working, and the gates into Fabricate while anything is changing
    const view = withPending(r, changed, viewer, pendingOf(open.list, open.error ?? (jobs.error ? `the jobs could not be listed: ${jobs.error}` : null), [], jobs.rows))
    // Define before its requirements exist: the intent first, then trace drafting them, or drafting them again when the
    // job stopped (src/api/drafting.ts); never "accept every requirement" over none. The record is read only when that
    // could change the step, and its count is kept per default-branch commit and record version
    const drafting = jobs.error ? null : await draftingNow(ctx, repo, r, jobs.rows, { next: view.next, version })
    const next = drafting ? draftingStep(view.next, r, drafting, viewer, drafting.why) : view.next
    return {
      repo, started: true, you: { admin: viewer.admin, part: viewer.part }, has_memory: hasMemory, ...view, next: await changedFirst(ctx, repo, r, next),
      ...(drafting ? { drafting: { state: drafting.state, job: drafting.job, why: drafting.why || null } } : {}),
      jobs: jobs.jobs, handoffs, ...(jobs.error ? { jobs_unavailable: jobs.error.slice(0, 200) } : {}),
      ...(seen && staleCriteria(seen).length ? { stale_evidence: staleCriteria(seen) } : {}),
      ...(open.error ? { changes_unavailable: open.error.slice(0, 200) } : {}),
    }
  }),

  // the drafting job stopped (lost, failed, cancelled, or never started) with the intent submitted and no requirements:
  // start it again, as Submit did (src/api/drafting.ts), as a new attempt. Refused, in words, while it is not stopped
  'requirements.draft': def('write', Repo, async ({ repo }, ctx) => {
    const [{ result: r, version }, list] = await Promise.all([journeyStore(ctx, repo).read((db) => loadJourney(db)), listJobs(ctx, repo)])
    if (!r) throw new ActionError('This project has not started its journey yet.')
    const d = await draftingNow(ctx, repo, r, list.rows, { version })
    if (!d) throw new ActionError(r.journey.currentStage === 'define' ? 'trace could not read the requirements just now, so it does not start drafting them again. Try again in a minute.' : 'The requirements are drafted already: the project is past Define.')
    if (d.state !== 'stopped') {
      throw new ActionError({
        intent: 'Write and submit the intent in the Intent builder first: trace drafts the requirements from it.',
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
    const item = a.criterion ? { criterion: a.criterion } : { waiver: a.waiver as string }
    return journeyWrite(ctx, a.repo, (db) => {
      const before = loadJourney(db)
      const key = a.criterion ?? `waiver:${a.waiver}`
      const seen = before?.opens.some((o) => o.item === key && o.who === who) ?? false
      const opened = recordOpen(db, item, who)
      // opening it again changes nothing worth a commit
      return { result: { repo: a.repo, opened: opened.item, at: opened.at }, changed: !seen }
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
      pending = pendingOf(open.list, why, fab ? (changedReqs ?? []) : [], jobs.rows)
    }
    // a criterion met on evidence that is now out of date does not count until it is checked again
    const staleRun = now0 ? await evidenceStaleness(ctx, a.repo, facts ? mergeAgentFacts(now0, facts) : now0) : undefined
    const { ready_at: readyAt, signed_at: signedAt, ...signed } = await journeyWrite(ctx, a.repo, (db) => {
      // when the gate became ready, from the record as it stood before the signature (its criteria and waivers)
      const before = loadJourney(db)
      const at = Date.now() / 1000
      const ready = before ? gateReadyAt(facts ? mergeAgentFacts(before, facts) : before, a.gate, at) : null
      const r = signGate(db, a.gate, signer(ctx), { acknowledged: a.acknowledge, notes: a.notes ?? null, facts, pending, staleRun })
      return { result: { repo: a.repo, ...r, ready_at: ready, signed_at: at } }
    })
    // saved: the wait from ready to signed (src/api/process-metrics.ts)
    recordWait(a.repo, 'gate', readyAt, signedAt)
    // the stage the signature opened starts its agents' work (docs/user-journey.md, each stage's "trace:"); the
    // signature stands even when the job cannot start
    const work = signed.advanced_to ? STAGE_WORK[signed.advanced_to] : undefined
    let kickoff: { jobId?: string; started?: string[]; jobError?: string } = {}
    if (work) {
      try {
        const r = await (await ctx.deps.jobs()).startJob({ kind: 'task', repository: a.repo, request: work.request, agent: work.agent, requestedBy: label(ctx.principal), requestedBySub: ctx.principal.sub })
        kickoff = r.accepted ? { jobId: r.jobId, started: [work.started] } : { jobError: r.reason ?? 'trace did not accept the job.' }
      } catch (e) { kickoff = { jobError: e instanceof Error ? e.message : String(e) } }
    }
    // the stage that opened may need new documents or sections: Scribe brings them up to date (docs/scribe.md); a
    // stage that needs none starts nothing, and the signature stands whatever happens here
    // (a signature that cuts a release asks for the release copies instead, below: one Scribe job does both)
    const stageDocs = async (): Promise<void> => {
      if (!signed.advanced_to || !docsFor(signed.advanced_to, true).length) return
      const d = await startScribe(ctx, a.repo, docsRequest(`The ${a.gate} gate was signed and ${STAGE_NAMES[signed.advanced_to]} opened.`, { stage: signed.advanced_to, also: ['journey'] }))
      if (d.started) kickoff = { ...kickoff, started: [...(kickoff.started ?? []), d.started] }
    }
    if (!signed.released) {
      await stageDocs()
      return { ...signed, ...kickoff, snapshot: null }
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
  'criterion.confirm': def('write', Repo.extend({ criterion: Id, met: z.boolean().default(true), note: z.string().trim().max(300).default('') }), async (a, ctx) =>
    journeyWrite(ctx, a.repo, (db) => {
      confirmCriterion(db, a.criterion, { met: a.met, note: a.note }, signer(ctx))
      return { result: { repo: a.repo, criterion: a.criterion, met: a.met, summary: a.met ? 'Signed off.' : 'Taken back: it is not met.' } }
    })),

  'question.answer': def('write', Repo.extend({
    question: Id, option: Id.optional(), answer: z.string().trim().max(4000).optional(), reason: z.string().trim().max(2000).optional(),
    // what the person said the answer lasts as (Question answer's last step): it reaches the specialist carried on
    lasts: z.enum(['once', 'rule', 'requirement']).optional(),
  }), async (a, ctx) => {
    // an agent's question lives in its facts; the answer is written here, in the record, under the same id
    const facts = await agentFacts(ctx, a.repo)
    const answered = await journeyWrite(ctx, a.repo, (db) => {
      const q = answerQuestion(db, a.question, signer(ctx), { option: a.option, answer: a.answer, reason: a.reason }, { facts })
      return { result: { repo: a.repo, question: q, summary: 'Answered. The agent carries on.' } }
    })
    // saved: the wait from asked to answered (src/api/process-metrics.ts)
    recordAnswered(a.repo, answered.question)
    // an agent that asked and then ended (its question left in its report) reads the answer only in a next job: start
    // that job, on the asking job's branch, so the answer is acted on now; the answer stands whatever happens here
    const asked = askedBy(facts, a.question)
    if (!asked?.jobId) return answered
    const carried = await carryOn(ctx, a.repo, asked, answered.question, a.lasts).catch((e: unknown) => ({ jobError: e instanceof Error ? e.message : String(e) }))
    return { ...answered, ...carried }
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
  }), async (a, ctx) => {
    const facts = await agentFacts(ctx, a.repo)
    return journeyWrite(ctx, a.repo, (db) => {
      const w = addWaiver(db, { target: a.target, reason: a.reason, risk: a.risk, severity: a.severity, caught_where: a.caught_where, scope: a.scope }, signer(ctx), { facts })
      return { result: { repo: a.repo, waiver: w } }
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

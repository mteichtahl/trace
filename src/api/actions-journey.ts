/**
 * The journey through the API: where a project is, its one next step, and the acts that move it (src/core/journey.ts
 * holds the record and every rule; this file checks access, reads and writes the record through GitHub, and words
 * the answers for the person asking).
 *
 *   journey.get             read     the journey for this person: template, revision, stages (state, criteria
 *                                    met/total, reopened), gates (state, criteria, evidence, waivers, signature, what
 *                                    still stops this person signing), the next step, questions, waivers, decisions,
 *                                    the project's jobs and the hand-offs between its specialists (jobs.list's,
 *                                    src/api/actions-jobs.ts).
 *                                    A project with no journey yet: { started: false } and what starts one
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
 *   inbox                   signed in  the four kinds that earn a notification (a gate ready, a question blocking
 *                                    work, money about to be spent, an agent stuck) across the person's projects,
 *                                    most blocking and oldest first. Each project's database is read once, in
 *                                    parallel with a small limit; a project whose record cannot be read is listed
 *                                    under `unavailable` rather than failing the whole inbox
 *
 *   journey.snapshot        admin    copy the record into the repository's .trace/project.db (its journey tables) on a
 *                                    new branch trace/release-<revision>-<time>, held for a person like every change
 *                                    to .trace/**, and log the commit in the decisions. Signing the gate that cuts a
 *                                    release (the release approval gate; Prove's in the Firmware template) takes it
 *                                    on its own: a failed copy is reported with the signature and never undoes it
 *
 * The record lives in the central bucket (src/core/journey-store.ts): every write is a conditional put of the
 * project's journey database, re-run on a lost race, and answers the record's `version`. The agents' facts
 * (src/core/agent-facts.ts: their questions, checks of the criteria trace owns, stuck notes) are read beside it and
 * merged into journey.get, gate.sign, waiver.add and the inbox; question.answer answers an agent's question in the
 * record under its id. The API never writes the agents' facts, and an agent's fact never meets a person's criterion.
 * Who did it is recorded as their email for the record people read, and as the 16-character hash of their Cognito sub
 * where the record only matches them (opened evidence, questions asked of them), never as anything else. Records made
 * before identity was keyed on the sub carry the email's hash: both are accepted when reading (hashesOf).
 */
import { z } from 'zod'
import { AccessDenied, type Principal, classOf, isAdmin, projectsFor, standing } from '../core/access.js'
import {
  INBOX_KINDS, type InboxItem, type NextStep, type StageId, decide, type JourneyRecord, type Viewer, SEVERITIES, STAGE_IDS, WAIVER_TARGETS, answerQuestion, addWaiver, inboxItems,
  dismissStuck, journeyView, loadJourney, recordOpen, returnGate, signGate, sortInbox,
} from '../core/journey.js'
import { AGENT_WORDS, jobIndex, listJobs, projectHandoffs } from './actions-jobs.js'
import { reviewItems } from './inbox-review.js'
import { loadJobs } from '../core/job-index.js'
import { type Context, NO_ACCESS, Repo, agentFacts, def, hashOf, hashesOf, label, plainly, snapshotJourney, withJourneyDb, withRecordDb, writeJourney } from './action-kit.js'
import { requirementEvidence } from './record-read.js'
import { SPECIALIST_KINDS, SPECIALIST_WORDS } from '../agents/kinds.js'
import { isLive } from '../core/job-index.js'

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

const signer = (ctx: Context): { hash: string; label: string; also: string[] } => ({ hash: hashOf(ctx.principal), also: hashesOf(ctx.principal), label: label(ctx.principal) })

/** Run a journey write, turning a refusal of the record's own into the person's error. */
const journeyWrite = <T>(ctx: Context, repo: string, fn: Parameters<typeof writeJourney<T>>[2]) => plainly(() => writeJourney<T>(ctx, repo, fn))

/** Copy the record into the repository and log the commit in the decisions. */
async function snapshot(ctx: Context, repo: string, why: string): Promise<{ branch: string; commit: string; revision: string; version: number }> {
  const s = await plainly(() => snapshotJourney(ctx, repo, why))
  const logged = await writeJourney(ctx, repo, (db) => {
    decide(db, {
      kind: 'journey.snapshot', stage: null, ref: s.commit, by: label(ctx.principal),
      summary: `The record of revision ${s.revision} was copied into the repository (commit ${s.commit.slice(0, 7)} on ${s.branch}).`, detail: { branch: s.branch, commit: s.commit, revision: s.revision, why },
    })
    return { result: {} }
  })
  return { ...s, version: logged.version }
}

/** At most this many projects' databases are read at once for the inbox. */
/** The open pull requests the project's jobs opened (inbox-review.ts), from GitHub and the project's job index. */
async function openReviews(ctx: Context, repo: string, project: string, stage: StageId): Promise<InboxItem[]> {
  const [pulls, jobs] = await Promise.all([(await ctx.deps.github()).openPulls(repo), jobIndex(ctx, repo).read((db) => loadJobs(db)).then((x) => x.result)])
  return reviewItems({ repo, project, stage, pulls, jobs, agentWords: AGENT_WORDS })
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

/**
 * After an answer: when the job that asked has ended, a task for the same specialist on that job's branch, told the
 * answer. A job still queued, running or paused reads the answer itself (journey.status, or on Resume): nothing starts.
 */
export async function carryOn(ctx: Context, repo: string, asked: { id: string; text: string; jobId: string | null }, q: { answered: { answer: string; reason: string | null; by: string | null } | null }, lasts?: Lasts): Promise<{ jobId?: string; started?: string[]; jobError?: string; summary?: string }> {
  if (!asked.jobId || !q.answered) return {}
  const { rows } = await listJobs(ctx, repo)
  const row = rows.find((r) => r.id === asked.jobId)
  if (!row || row.state === 'queued' || row.state === 'paused' || isLive(row, Date.now() / 1000)) return {}
  const agent = SPECIALIST_KINDS.find((k) => k === row.agent)
  // the specialist's own row may not carry the branch its worker pushed to
  const branch = row.branch ?? rows.find((r) => r.parentJob === row.id && r.branch)?.branch ?? null
  if (!agent || !branch) return {}
  const request = answeredRequest({ id: asked.id, text: asked.text, jobId: row.id, branch, answer: q.answered.answer, reason: q.answered.reason, by: q.answered.by, lasts })
  const r = await (await ctx.deps.jobs()).startJob({ kind: 'task', repository: repo, request, agent, branch, requestedBy: label(ctx.principal), requestedBySub: ctx.principal.sub })
  const who = `the ${SPECIALIST_WORDS[agent]} specialist`
  return r.accepted
    ? { jobId: r.jobId, started: [`The ${SPECIALIST_WORDS[agent]} specialist carries on with your answer on ${branch}.`], summary: `Answered. The ${SPECIALIST_WORDS[agent]} specialist carries on with it on ${branch}.` }
    : { jobError: r.reason ?? 'trace did not accept the job.', summary: `Answered, but ${who} could not be started again: ${r.reason ?? 'trace did not accept the job'}. The answer is kept for its next job.` }
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
      'Propose the criteria to compare the options on (with weights) and score each option on each with a reason. Record what you checked as the stock check where journey.check allows.',
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
      'Stock: parts.bom_check for the build quantity; record capture.stock with journey.check. A part out of stock gets an in-stock alternative proposed, or the reason written on it.',
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
      'Render the board (render.board) so a person can approve the renders. Do not approve them yourself.',
      'A change the layout forces on the schematic or a requirement is a question for a person (journey.ask), not yours to make.',
    ].join('\n'),
  },
  signoff: {
    agent: 'verify',
    started: 'The Verification agent closes coverage and writes the release report for Sign-off.',
    request: [
      'The layout review gate was signed: the project is in Sign-off. Prepare the release report.',
      'Run what the layout made possible (the items planned for after layout), then close coverage (verify.coverage): every requirement verified or waived, the gaps named. Record signoff.coverage with journey.check.',
      'Hand the parts list check (cost and stock at the build quantity, then signoff.bom) to the Implementation specialist, and the interference prechecks (then signoff.emc) to the EMC specialist, each with journey.handoff, and put their answers in the report.',
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
    recommendation: null, button: 'Open Requirements review', stage: next.stage, ref: { kind: 'skill', id: 'requirements-review' },
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
    const [r, facts, jobs] = await Promise.all([withJourneyDb(ctx, repo, (db) => loadJourney(db)), agentFacts(ctx, repo),
      listJobs(ctx, repo).then((x) => ({ jobs: x.jobs, rows: x.rows, error: null }), (e: unknown) => ({ jobs: [], rows: [], error: e instanceof Error ? e.message : String(e) }))])
    // the hand-offs between specialists (jobs.list's): who asked whom, for what, and the answer
    const handoffs = projectHandoffs(repo, facts, r, jobs.rows)
    if (!r) return { repo, ...NOT_STARTED, jobs: jobs.jobs, handoffs }
    // whether the project has agent memory here (the Memory tab): its memory is set up, not that a session has happened
    const hasMemory = Boolean(ctx.deps.memory?.()?.forProject(repo))
    const view = journeyView(r, viewer, undefined, facts)
    return {
      repo, started: true, you: { admin: viewer.admin, part: viewer.part }, has_memory: hasMemory, ...view, next: await changedFirst(ctx, repo, r, view.next),
      jobs: jobs.jobs, handoffs, ...(jobs.error ? { jobs_unavailable: jobs.error.slice(0, 200) } : {}),
    }
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

  'gate.sign': def('admin', Repo.extend({ gate: Id, acknowledge: z.array(Id).max(100).default([]), notes: z.string().trim().max(4000).optional() }), async (a, ctx) => {
    // the agents' checks of the criteria trace owns count towards the gate; the signing rules are the record's own
    const facts = await agentFacts(ctx, a.repo)
    const signed = await journeyWrite(ctx, a.repo, (db) => {
      const r = signGate(db, a.gate, signer(ctx), { acknowledged: a.acknowledge, notes: a.notes ?? null, facts })
      return { result: { repo: a.repo, ...r } }
    })
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
    if (!signed.released) return { ...signed, ...kickoff, snapshot: null }
    // the signature cut a release: the record goes into the repository with it
    try {
      const s = await snapshot(ctx, a.repo, `${a.gate} signed`)
      return { ...signed, ...kickoff, version: s.version, snapshot: { branch: s.branch, commit: s.commit }, summary: `${signed.summary} The record was copied into the repository.` }
    } catch (e) {
      return { ...signed, ...kickoff, snapshot: { error: `The gate is signed, but the record could not be copied into the repository: ${e instanceof Error ? e.message : String(e)}. An admin can copy it with journey.snapshot.` } }
    }
  }),

  'journey.snapshot': def('admin', Repo.extend({ reason: z.string().trim().max(300).default('copied by an admin') }), async (a, ctx) =>
    ({ repo: a.repo, ...(await snapshot(ctx, a.repo, a.reason)) })),

  'gate.return': def('write', Repo.extend({ gate: Id, reason: z.string().trim().min(1).max(4000), reopen: z.enum(STAGE_IDS).optional() }), async (a, ctx) =>
    journeyWrite(ctx, a.repo, (db) => {
      const r = returnGate(db, a.gate, signer(ctx), { reason: a.reason, reopen: a.reopen })
      return { result: { repo: a.repo, ...r, summary: r.reopened ? `Returned. ${r.reopened} is reopened.` : 'Returned with what has to change.' } }
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
    // an agent that asked and then ended (its question left in its report) reads the answer only in a next job: start
    // that job, on the asking job's branch, so the answer is acted on now; the answer stands whatever happens here
    const asked = facts.questions.find((q) => q.id === a.question)
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

  inbox: def('signed-in', z.object({ kinds: z.array(z.enum(INBOX_KINDS)).optional(), limit: z.number().int().min(1).max(200).default(50) }), async (a, ctx) => {
    if (classOf(ctx.principal) === null) throw new AccessDenied(NO_ACCESS)
    const projects = await projectsFor(ctx.principal)
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
      items, unavailable,
    }
  }),
}

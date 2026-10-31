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
  INBOX_KINDS, type InboxItem, type StageId, decide, type JourneyRecord, type Viewer, SEVERITIES, STAGE_IDS, WAIVER_TARGETS, answerQuestion, addWaiver, inboxItems,
  dismissStuck, journeyView, loadJourney, recordOpen, returnGate, signGate, sortInbox,
} from '../core/journey.js'
import { AGENT_WORDS, jobIndex, listJobs, projectHandoffs } from './actions-jobs.js'
import { reviewItems } from './inbox-review.js'
import { loadJobs } from '../core/job-index.js'
import { type Context, NO_ACCESS, Repo, agentFacts, def, hashOf, hashesOf, label, plainly, snapshotJourney, withJourneyDb, writeJourney } from './action-kit.js'

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
    return {
      repo, started: true, you: { admin: viewer.admin, part: viewer.part }, has_memory: hasMemory, ...journeyView(r, viewer, undefined, facts),
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
    if (!signed.released) return { ...signed, snapshot: null }
    // the signature cut a release: the record goes into the repository with it
    try {
      const s = await snapshot(ctx, a.repo, `${a.gate} signed`)
      return { ...signed, version: s.version, snapshot: { branch: s.branch, commit: s.commit }, summary: `${signed.summary} The record was copied into the repository.` }
    } catch (e) {
      return { ...signed, snapshot: { error: `The gate is signed, but the record could not be copied into the repository: ${e instanceof Error ? e.message : String(e)}. An admin can copy it with journey.snapshot.` } }
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
  }), async (a, ctx) => {
    // an agent's question lives in its facts; the answer is written here, in the record, under the same id
    const facts = await agentFacts(ctx, a.repo)
    return journeyWrite(ctx, a.repo, (db) => {
      const q = answerQuestion(db, a.question, signer(ctx), { option: a.option, answer: a.answer, reason: a.reason }, { facts })
      return { result: { repo: a.repo, question: q, summary: 'Answered. The agent carries on.' } }
    })
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

/**
 * The journey through the API: where a project is, its one next step, and the acts that move it (src/core/journey.ts
 * holds the record and every rule; this file checks access, reads and writes the record through GitHub, and words
 * the answers for the person asking).
 *
 *   journey.get             read     the journey for this person: template, revision, stages (state, criteria
 *                                    met/total, reopened), gates (state, criteria, evidence, waivers, signature, what
 *                                    still stops this person signing), the next step, questions, waivers, decisions.
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
 *   inbox                   signed in  the four kinds that earn a notification (a gate ready, a question blocking
 *                                    work, money about to be spent, an agent stuck) across the person's projects,
 *                                    most blocking and oldest first. Each project's database is read once, in
 *                                    parallel with a small limit; a project whose record cannot be read is listed
 *                                    under `unavailable` rather than failing the whole inbox
 *
 * Every write is a commit on the project's journey branch naming the person (src/api/action-kit.ts writeJourney).
 * Who did it is recorded as their email for the record people read, and as their 16-character hash where the record
 * only matches them (opened evidence), never as anything else.
 */
import { z } from 'zod'
import { AccessDenied, type Principal, classOf, isAdmin, projectsFor, standing } from '../core/access.js'
import {
  INBOX_KINDS, type InboxItem, type JourneyRecord, type Viewer, SEVERITIES, STAGE_IDS, WAIVER_TARGETS, answerQuestion, addWaiver, inboxItems,
  journeyView, loadJourney, recordOpen, returnGate, signGate, sortInbox,
} from '../core/journey.js'
import { type Context, NO_ACCESS, Repo, def, hashOf, label, plainly, withJourneyDb, writeJourney } from './action-kit.js'

const Id = z.string().min(1).max(80)

/** Who is looking, for the journey's computations. */
export async function viewerOf(p: Principal, repo: string): Promise<Viewer> {
  const s = await standing(p, repo)
  return { hash: hashOf(p), label: label(p), admin: isAdmin(p), part: s?.part ?? null }
}

const NOT_STARTED = {
  started: false,
  summary: 'This project has not started its journey yet.',
  next: 'An admin starts it by choosing a template: Board, FPGA, Firmware or Mixed.',
}

const signer = (ctx: Context): { hash: string; label: string } => ({ hash: hashOf(ctx.principal), label: label(ctx.principal) })

/** Run a journey write, turning a refusal of the record's own into the person's error. */
const journeyWrite = <T>(ctx: Context, repo: string, message: string, fn: Parameters<typeof writeJourney<T>>[3]) => plainly(() => writeJourney<T>(ctx, repo, message, fn))

/** At most this many projects' databases are read at once for the inbox. */
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
    const r = await withJourneyDb(ctx, repo, (db) => loadJourney(db))
    if (!r) return { repo, ...NOT_STARTED }
    return { repo, started: true, you: { admin: viewer.admin, part: viewer.part }, ...journeyView(r, viewer) }
  }),

  'journey.criterion.open': def('read', Repo.extend({ criterion: Id.optional(), waiver: Id.optional() }).refine((a) => Boolean(a.criterion) !== Boolean(a.waiver), 'name a criterion or a waiver'), async (a, ctx) => {
    const who = hashOf(ctx.principal)
    const item = a.criterion ? { criterion: a.criterion } : { waiver: a.waiver as string }
    return journeyWrite(ctx, a.repo, `journey: evidence opened (${a.criterion ?? `waiver ${a.waiver}`})`, (db) => {
      const before = loadJourney(db)
      const key = a.criterion ?? `waiver:${a.waiver}`
      const seen = before?.opens.some((o) => o.item === key && o.who === who) ?? false
      const opened = recordOpen(db, item, who)
      // opening it again changes nothing worth a commit
      return { result: { repo: a.repo, opened: opened.item, at: opened.at }, changed: !seen }
    })
  }),

  'gate.sign': def('admin', Repo.extend({ gate: Id, acknowledge: z.array(Id).max(100).default([]), notes: z.string().trim().max(4000).optional() }), async (a, ctx) =>
    journeyWrite(ctx, a.repo, `journey: gate ${a.gate} signed`, (db) => {
      const r = signGate(db, a.gate, signer(ctx), { acknowledged: a.acknowledge, notes: a.notes ?? null })
      return { result: { repo: a.repo, ...r } }
    })),

  'gate.return': def('write', Repo.extend({ gate: Id, reason: z.string().trim().min(1).max(4000), reopen: z.enum(STAGE_IDS).optional() }), async (a, ctx) =>
    journeyWrite(ctx, a.repo, `journey: gate ${a.gate} returned`, (db) => {
      const r = returnGate(db, a.gate, signer(ctx), { reason: a.reason, reopen: a.reopen })
      return { result: { repo: a.repo, ...r, summary: r.reopened ? `Returned. ${r.reopened} is reopened.` : 'Returned with what has to change.' } }
    })),

  'question.answer': def('write', Repo.extend({
    question: Id, option: Id.optional(), answer: z.string().trim().max(4000).optional(), reason: z.string().trim().max(2000).optional(),
  }), async (a, ctx) =>
    journeyWrite(ctx, a.repo, `journey: question ${a.question} answered`, (db) => {
      const q = answerQuestion(db, a.question, signer(ctx), { option: a.option, answer: a.answer, reason: a.reason })
      return { result: { repo: a.repo, question: q, summary: 'Answered. The agent carries on.' } }
    })),

  'waiver.add': def('write', Repo.extend({
    target: z.object({ kind: z.enum(WAIVER_TARGETS), id: Id }),
    reason: z.string().trim().min(1).max(2000),
    risk: z.string().trim().min(1).max(2000),
    severity: z.enum(SEVERITIES),
    caught_where: z.string().trim().max(300).nullable(),
    scope: z.string().trim().min(1).max(300).default('this revision only'),
  }), async (a, ctx) =>
    journeyWrite(ctx, a.repo, `journey: waiver on ${a.target.kind} ${a.target.id}`, (db) => {
      const w = addWaiver(db, { target: a.target, reason: a.reason, risk: a.risk, severity: a.severity, caught_where: a.caught_where, scope: a.scope }, signer(ctx))
      return { result: { repo: a.repo, waiver: w } }
    })),

  inbox: def('signed-in', z.object({ kinds: z.array(z.enum(INBOX_KINDS)).optional(), limit: z.number().int().min(1).max(200).default(50) }), async (a, ctx) => {
    if (classOf(ctx.principal) === null) throw new AccessDenied(NO_ACCESS)
    const projects = await projectsFor(ctx.principal)
    const unavailable: { repo: string; reason: string }[] = []
    const per = await mapLimit(projects, INBOX_PARALLEL, async (p): Promise<InboxItem[]> => {
      try {
        const r: JourneyRecord | null = await withJourneyDb(ctx, p.repo, (db) => loadJourney(db))
        if (!r) return []
        return inboxItems(p.repo, r, { hash: hashOf(ctx.principal), label: label(ctx.principal), admin: isAdmin(ctx.principal), part: p.part })
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

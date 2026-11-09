/**
 * A change that edits an accepted requirement, said before it is accepted (test-esp32 log #112, #62).
 *
 * A specialist's change carries the project database (.trace/project.db), and with it the requirements table. When its
 * copy of a requirement a person accepted differs from the design's (other words, another acceptance criterion, struck
 * or gone), accepting the change undoes that person's decision: the requirement is theirs to agree again, and past
 * Define the project goes back to Define and every gate after it is signed again (src/api/pending-changes.ts
 * backToDefine). In the test run that happened silently: the Verification specialist's change, described as "only
 * the note string changed", also rewrote REQ-367d71's acceptance criterion, its review page said nothing, and Define
 * reopened only after the next change was accepted.
 *
 *   requirementEdits    the accepted requirements a change's database edits, comparing its copy (the head commit's)
 *                       with the design's (the default branch's, with people's decisions from the journey record).
 *                       A change GitHub can merge without a conflict brings its database in whole, so its copy is
 *                       what the design will hold; an older copy that would put back an earlier wording counts too
 *   requirementAsked    whether anything asked for a requirement change on the change's branch: an answer whose
 *                       person said "It changes a requirement" (the carry-on request says so, and the answer's
 *                       decision records it), or a Change request about a requirement. "Just this once" and "A rule
 *                       for the project" never ask for one
 *   editsView           the words the review page shows, and the plain headline the recommendation leads with
 *   withRequirementEdits  trace's recommendation with them: an edit nothing asked for, that would reopen Define, is
 *                       "Ask for changes"; one that was asked for is still said first, so accepting is a choice made
 *                       knowing what it costs
 *
 * Requirements a person has not accepted yet are left out: changing a proposal costs nothing.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { JobRow } from '../core/job-index.js'
import type { JourneyRecord } from '../core/journey.js'
import { loadDesignDecisions } from '../tools/design/decisions.js'
import { requirementDecisions, requirementsNow } from '../tools/design/record.js'
import type { Recommendation } from './changes.js'
import { jobRequest } from './changes.js'
import { hasTable } from './record-read.js'

/** The words the carry-on request gives when the person said their answer changes a requirement (actions-journey.ts). */
export const REQUIREMENT_CHANGE_SAID = 'They said this answer changes a requirement.'
/** A Change request about a requirement starts its job with these words (actions-skills.ts skill.submit). */
const CHANGE_REQUEST = /^Change request \(requirement\):/m

interface Row { text: string; acceptance: string | null; status: string }
export type EditedPart = 'words' | 'acceptance' | 'struck' | 'removed'
export interface RequirementEdit { id: string; parts: EditedPart[]; before: Row; after: Row | null }

const readRows = (db: DatabaseSync): Map<string, Row & { updated: number | null }> => {
  if (!hasTable(db, 'requirements')) return new Map()
  const all = db.prepare('SELECT * FROM requirements ORDER BY id').all() as Record<string, unknown>[]
  return new Map(all.map((q) => [String(q.id), {
    text: String(q.text), acceptance: q.acceptance === null || q.acceptance === undefined ? null : String(q.acceptance), status: String(q.status),
    updated: typeof q.updated === 'number' ? q.updated : null,
  }]))
}

const GONE = new Set(['rejected', 'obsolete'])

/**
 * The accepted requirements the change's database (`head`) edits, against the design's (`design`: the default
 * branch's database with the journey tables, as withRecordDb gives it). Accepted: a person's standing decision accepts
 * it, or its row says accepted.
 */
export function requirementEdits(design: DatabaseSync, head: DatabaseSync): RequirementEdit[] {
  const ours = readRows(design)
  if (!ours.size) return []
  const all = [...ours.entries()].map(([id, r]) => ({ id, ...r }))
  const decided = requirementDecisions(loadDesignDecisions(design), requirementsNow(all))
  const theirs = readRows(head)
  const out: RequirementEdit[] = []
  for (const [id, m] of ours) {
    const d = decided.get(id)
    if (!(d ? d.choice === 'accepted' : m.status === 'accepted')) continue
    const h = theirs.get(id)
    const before = { text: m.text, acceptance: m.acceptance, status: m.status }
    if (!h) { if (theirs.size) out.push({ id, parts: ['removed'], before, after: null }); continue }
    const parts: EditedPart[] = []
    if (h.text !== m.text) parts.push('words')
    if (h.acceptance !== m.acceptance) parts.push('acceptance')
    if (GONE.has(h.status) && !GONE.has(m.status)) parts.push('struck')
    if (parts.length) out.push({ id, parts, before, after: { text: h.text, acceptance: h.acceptance, status: h.status } })
  }
  return out
}

/**
 * What asked for a requirement change on this change's branch, in words, or null when nothing did. `branches`: the
 * change's branch, and the one it builds on when stacked. The jobs that worked there count, with the jobs that started
 * them (a hand-off's worker, a revision): their requests, and the answers given to their questions.
 */
export function requirementAsked(jobs: readonly JobRow[], branches: readonly string[], r: Pick<JourneyRecord, 'questions' | 'decisions'> | null): string | null {
  const byId = new Map(jobs.map((j) => [j.id, j]))
  const mine = new Set<string>()
  for (const j of jobs.filter((x) => x.branch !== null && branches.includes(x.branch))) {
    // up the chain of jobs that started it: a hand-off or a revision carries on someone else's request
    for (let x: JobRow | undefined = j, n = 0; x && !mine.has(x.id) && n < 8; x = x.parentJob ? byId.get(x.parentJob) : undefined, n++) mine.add(x.id)
  }
  for (const id of mine) {
    const req = jobRequest(byId.get(id) ?? null)
    if (req.includes(REQUIREMENT_CHANGE_SAID)) return 'The person who answered its question said the answer changes a requirement.'
    if (CHANGE_REQUEST.test(req)) return 'It comes from a change request about a requirement.'
  }
  // an answer read by the job itself (it was still running) never went into a request: its decision records it
  for (const d of r?.decisions ?? []) {
    if (d.kind !== 'question.answered' || (d.detail as { lasts?: unknown } | null)?.lasts !== 'requirement') continue
    const q = r?.questions.find((x) => x.id === d.ref)
    if (q?.jobId && mine.has(q.jobId)) return `The answer to question ${q.id} said it changes a requirement.`
  }
  return null
}

/** What the review page shows of a change's requirement edits (ChangeDetail.requirement_edits). */
export interface RequirementEditsView {
  ids: string[]
  /** accepting it takes the project back to Define (it is past Define) */
  reopens: boolean
  /** what asked for it, in words; null: nothing did */
  asked: string | null
  /** the headline, said on the page and first in the recommendation */
  says: string
  /** one line per requirement: what it changes */
  edits: { id: string; what: string }[]
}

const list = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)
const quoted = (s: string | null): string => (s === null || s === '' ? 'none' : `"${s.length > 160 ? `${s.slice(0, 157)}…` : s}"`)

/**
 * Before and after, quoted: in full when short, or else around where they differ, so a long criterion whose change
 * comes late does not read "from X … to X …" with the change cut off both times (test-esp32-run3 S11).
 */
export function quotedChange(before: string | null, after: string | null): [string, string] {
  if (before === null || after === null || (before.length <= 160 && after.length <= 160)) return [quoted(before), quoted(after)]
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  // start a few words before the first difference, at a word boundary
  let from = Math.max(0, start - 40)
  if (from > 0) from = before.lastIndexOf(' ', from) + 1
  const cut = (s: string): string => {
    const stop = s.length - end
    const piece = s.slice(from, Math.min(s.length, Math.max(stop, from) + 20))
    const short = piece.length > 200 ? `${piece.slice(0, 197)}…` : piece
    return `"${from > 0 ? '…' : ''}${short}${from + piece.length < s.length && piece.length <= 200 ? '…' : ''}"`
  }
  return [cut(before), cut(after)]
}

/** One requirement's edit in words. */
export function editWords(e: RequirementEdit): string {
  if (e.parts.includes('removed')) return `${e.id} is removed from the record.`
  const out: string[] = []
  if (e.parts.includes('struck')) out.push(`it is marked ${e.after?.status ?? 'struck'}`)
  if (e.parts.includes('acceptance')) { const [b, a] = quotedChange(e.before.acceptance, e.after?.acceptance ?? null); out.push(`its acceptance criterion changes from ${b} to ${a}`) }
  if (e.parts.includes('words')) { const [b, a] = quotedChange(e.before.text, e.after?.text ?? null); out.push(`its words change from ${b} to ${a}`) }
  return `${e.id}: ${out.join('; ')}.`
}

/** The view of `edits`, or null when there are none. `reopens`: the project is past Define. */
export function editsView(edits: readonly RequirementEdit[], reopens: boolean, asked: string | null): RequirementEditsView | null {
  if (!edits.length) return null
  const ids = edits.map((e) => e.id)
  const one = ids.length === 1
  const says = reopens
    ? `Changes ${one ? 'a requirement' : 'requirements'} (${list(ids)}): accepting it reopens Define and every gate after it.`
    : `Changes ${one ? 'an accepted requirement' : 'accepted requirements'} (${list(ids)}): accepting it sends ${one ? 'it' : 'them'} back to Requirements review to be agreed again.`
  return { ids, reopens, asked, says, edits: edits.map((e) => ({ id: e.id, what: editWords(e) })) }
}

/**
 * trace's recommendation with the change's requirement edits said first. An edit nothing asked for that would reopen
 * Define turns "accept" into "ask": the specialist should leave the requirement as agreed, and a person who wants the
 * new wording can still accept it. Otherwise the recommendation stands, with the cost said before its reason.
 */
export function withRequirementEdits(rec: Recommendation, v: RequirementEditsView | null): Recommendation {
  if (!v) return rec
  if (!v.asked && v.reopens && (rec.verdict === 'accept' || rec.verdict === 'wait')) {
    return {
      verdict: 'ask',
      why: `${v.says} Nothing asked for that: no answer said it changes a requirement, and no change request did. Ask for changes so it leaves ${v.ids.length === 1 ? 'the requirement' : 'the requirements'} as agreed. If the new wording is right, you can still accept it, then agree it in Requirements review and sign the gates again.`,
    }
  }
  return { verdict: rec.verdict, why: `${v.says}${v.asked ? ` ${v.asked}` : ''} ${rec.why}` }
}

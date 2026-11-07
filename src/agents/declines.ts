/**
 * A specialist that declines a job as another specialist's work (test log R26): it changed nothing and named who the
 * work belongs to. The job must not read as a plain success, and the person is offered to send it on.
 *
 *   NOT MINE   the specialist's final report begins "NOT MINE: <kind>: <why>" (specialist.escalate in the prompt
 *              catalog asks for it); before that line existed, or when a project's prompt drops it, the report's own
 *              words: it says the work belongs to (or should go to) the <title> specialist and that it changed nothing
 *   no change  the runner (src/agents/runtime/job.ts) counts it a decline only when the job left nothing: no commit on
 *              its branch and no record kept. A job that did some of the work and named another specialist for the
 *              rest is a success that says so, as before
 *   summary    the job's summary is then "<kind>: declined, for <kind>: <the report>" (declinedSummary). The API reads it
 *              back (declinedOf) for the job view's `declined` and its Send it to <specialist> control
 *
 * Pure: the runtime, the API and the tests share it.
 */
import { SPECIALIST_KINDS, SPECIALIST_WORDS, type SpecialistKind } from './kinds.js'

export interface Decline { to: SpecialistKind; why: string }

const isKind = (k: string): k is SpecialistKind => (SPECIALIST_KINDS as readonly string[]).includes(k)
const byWords = (w: string): SpecialistKind | null => SPECIALIST_KINDS.find((k) => SPECIALIST_WORDS[k].toLowerCase() === w.toLowerCase()) ?? null

const NOT_MINE = /^\s*NOT MINE:\s*([a-z]+)\b\s*[:,.;\-–—]?\s*(.*)$/i
const TITLES = SPECIALIST_KINDS.map((k) => SPECIALIST_WORDS[k]).join('|')
const BELONGS = new RegExp(String.raw`\b(?:belongs? to|should go to|goes to|is (?:a job|work) for|is the work of|is for)\s+the\s+(${TITLES})\s+specialist\b`, 'i')
const NOTHING_CHANGED = /\b(?:did(?: not|n['’]?t)|have(?: not|n['’]?t)|has(?: not|n['’]?t)|made no|no) (?:change|changes|changed|edit|edits|edited)\b|\bnothing (?:was |is )?(?:changed|edited|committed)\b|\bleft (?:it|everything) (?:as it was|unchanged)\b/i

/** The first sentence or two of a report, as the why. */
const firstWords = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 300)

/**
 * The specialist a report declines the job for, or null: its NOT MINE line, else its own words (who the work belongs
 * to, and that it changed nothing). Never its own kind.
 */
export function declineIn(report: string, own: SpecialistKind): Decline | null {
  const first = report.split('\n').find((l) => l.trim()) ?? ''
  const m = NOT_MINE.exec(first)
  if (m) {
    const k = (m[1] ?? '').toLowerCase()
    const to = isKind(k) ? k : byWords(k)
    if (to && to !== own) return { to, why: firstWords(m[2] || report.slice(first.length)) }
  }
  const b = BELONGS.exec(report)
  const to = b ? byWords(b[1] ?? '') : null
  if (to && to !== own && NOTHING_CHANGED.test(report)) return { to, why: firstWords(report) }
  return null
}

/** A declined job's summary: the decline first, so it reads as one before the report. */
export const declinedSummary = (own: SpecialistKind, d: Decline, report: string, max = 2000): string =>
  `${own}: declined, for ${d.to}: ${report.replace(/^\s*NOT MINE:[^\n]*\n?/i, '').trim().slice(0, max) || d.why}`

const SUMMARY = /^([a-z]+): declined, for ([a-z]+): ([\s\S]*)$/

/** A declined job's decline, read back from its summary; null for any other summary. */
export function declinedOf(summary: string | null | undefined): (Decline & { from: SpecialistKind }) | null {
  const m = summary ? SUMMARY.exec(summary) : null
  if (!m) return null
  const from = m[1] ?? ''
  const to = m[2] ?? ''
  if (!isKind(from) || !isKind(to) || from === to) return null
  return { from, to, why: firstWords(m[3] ?? '') }
}

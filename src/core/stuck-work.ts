/**
 * Work trace gave up on, as a "Needs you" item (docs/stay-in-trace.md, 3. "Stuck work"). The worker (src/harness/
 * worker.ts pick) hands a red pull request, a conflict or an agent-fix request to worker.escalate_to once it has had
 * worker.max_attempts attempts on the same head; that mention is on GitHub, where most people never look. So the pick
 * also records a stuck note in the agents' facts (src/core/agent-facts.ts, the `stuck` table a specialist writes with
 * journey.stuck), and the API shows it as every stuck note is shown: an inbox item of kind `stuck` and an agent marked
 * Stuck, with what was tried and trace's recommendation.
 *
 * Why the pick writes it, not the API: the pick is the one place that knows an item reached max attempts (it counts
 * the attempt markers on GitHub as it claims), and it runs where the agents' facts can be written: on AgentCore (the
 * sweep, with the worker runtime's role and TRACE_PROJECT_HOME) and in GitHub Actions on the default branch (with the
 * repository's own OIDC role, TRACE_AWS_ROLE, which may write projects/<slug>/journey-agent/* with a conditional put
 * only: src/infra/project.ts AgentFactsConditional). Deriving it in the API instead would cost GitHub calls on every
 * inbox look, for every project, and the API never writes the agents' facts. Where neither is set up, nothing is
 * recorded and the GitHub mention stays the only word.
 *
 * Identity: a note is keyed by its item and head (`sourceKey`: ci-red#12@<sha>, agent-fix#7@issue), carried as its
 * one source (kind STUCK_SOURCE). One open note per key: the pick adds a note for an item at max attempts that has
 * none open (so one escalated before this existed, or while the facts could not be written, gets one on a later
 * pick), and resolves the open notes whose item is no longer stuck (a new push, the label taken off, the request
 * closed). A note a person dismissed stays open in the facts (a dismissal is the journey record's), so it is never
 * added again for the same head.
 *
 * Pure except for the database functions, which take the facts database as given (the caller's store update).
 */
import type { DatabaseSync } from 'node:sqlite'
import { addStuck, loadAgentFacts, resolveStuck } from './agent-facts.js'

/** The source kind a stuck work item's note carries its key as. */
export const STUCK_SOURCE = 'work-item'
/** Who the note is from: the worker, in words (it reads as "the trace worker is stuck: …"). */
export const STUCK_BY = { agent: 'worker', label: 'the trace worker', jobId: null } as const

export type StuckKind = 'ci-red' | 'conflict' | 'agent-fix'

/** One item the pick found at max attempts. */
export interface StuckItem {
  kind: StuckKind; number: number; sha: string; title: string
  /** worker.max_attempts */
  attempts: number
  /** the newest report an attempt left on the item (its own words, quoted), or null */
  lastReport: string | null
}

/** The note's key: the item and its head (`issue` for a request). */
export const sourceKey = (i: Pick<StuckItem, 'kind' | 'number' | 'sha'>): string => `${i.kind}#${i.number}@${i.sha === 'issue' ? 'issue' : i.sha.slice(0, 12)}`

/** The item a key names, or null when it is not one. */
export function parseKey(key: string): { kind: StuckKind; number: number; sha: string } | null {
  const m = /^(ci-red|conflict|agent-fix)#(\d+)@([0-9a-f]{1,40}|issue)$/.exec(key)
  return m ? { kind: m[1] as StuckKind, number: Number(m[2]), sha: m[3] as string } : null
}

const WHAT: Record<StuckKind, (n: number) => string> = {
  'ci-red': (n) => `fix the failing build on change #${n}`,
  conflict: (n) => `bring change #${n} up to date with the design`,
  'agent-fix': (n) => `do request #${n}`,
}

const RECOMMEND: Record<StuckKind, string> = {
  'ci-red': 'Read the failing step on the project overview, then tell trace what to change with "Ask trace to fix something", or discard the change if it is no longer wanted. A new commit on it puts it back in trace\'s queue.',
  conflict: 'Ask trace to redo the change on the current design with "Ask trace to fix something", or discard it if it is no longer wanted. A new commit on it puts it back in trace\'s queue.',
  'agent-fix': 'Say more about what is wanted with "Ask trace to fix something", or close the request if it is no longer needed.',
}

/** The last report's words in one paragraph: its quoted lines (an attempt's report quotes the agent), at most 400 characters. */
export function reportWords(body: string): string | null {
  const quoted = body.split(/\r?\n/).filter((l) => l.startsWith('> ')).map((l) => l.slice(2).trim()).filter(Boolean)
  const text = (quoted.length ? quoted : []).join(' ').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > 400 ? `${text.slice(0, 399)}…` : text
}

/** What the note says: why (what was tried, and its last report) and what trace recommends. */
export function stuckNote(i: StuckItem): { why: string; recommendation: string; key: string; label: string } {
  const title = i.title.replace(/\s+/g, ' ').trim().slice(0, 160)
  const tried = `trace tried ${i.attempts} times to ${WHAT[i.kind](i.number)}${title ? ` ("${title}")` : ''} and could not, so it stopped trying.`
  const last = i.lastReport ? ` Its last attempt reported: ${i.lastReport}` : ''
  return { why: `${tried}${last}`, recommendation: RECOMMEND[i.kind], key: sourceKey(i), label: `${i.kind === 'agent-fix' ? 'Request' : 'Change'} #${i.number}` }
}

/** The open (unresolved) stuck notes of work items, by key, with their ids. */
export function openStuckWork(db: DatabaseSync): Map<string, string> {
  const out = new Map<string, string>()
  for (const s of loadAgentFacts(db).stuck) {
    if (s.resolvedAt !== null) continue
    const k = s.sources.find((x) => x.kind === STUCK_SOURCE)?.ref
    if (k && parseKey(k)) out.set(k, s.id)
  }
  return out
}

/**
 * Bring the facts in line with what the pick found: a note for each stuck item without an open one; the open notes
 * whose item is not stuck now, resolved. A note whose item the pick did not see (closed, merged, label taken off) is
 * resolved too (an item at max attempts is never claimed again, so it is seen as stuck on every pick until it moves).
 * `keep`: the keys of items the pick could not judge this time (held by a claim younger than worker.claim_hours,
 * such as the last attempt still running): their notes stand. Returns what changed.
 */
export function syncStuckWork(db: DatabaseSync, stuck: readonly StuckItem[], keep: readonly string[] = []): { added: string[]; resolved: string[] } {
  const open = openStuckWork(db)
  const now = new Set([...stuck.map(sourceKey), ...keep])
  const added: string[] = []
  const resolved: string[] = []
  for (const i of stuck) {
    const n = stuckNote(i)
    if (open.has(n.key)) continue
    addStuck(db, STUCK_BY, { why: n.why, recommendation: n.recommendation, sources: [{ kind: STUCK_SOURCE, ref: n.key, label: n.label }] }, null)
    added.push(n.key)
  }
  for (const [key, id] of open) {
    if (now.has(key)) continue
    resolveStuck(db, { id, resolution: 'the item is no longer stuck: it was pushed to again, fixed or closed' })
    resolved.push(key)
  }
  return { added, resolved }
}

/** The numbers of the agent-fix requests with an open stuck note (health.get's asks). */
export function stuckRequests(db: DatabaseSync): Set<number> {
  const out = new Set<number>()
  for (const k of openStuckWork(db).keys()) {
    const p = parseKey(k)
    if (p?.kind === 'agent-fix') out.add(p.number)
  }
  return out
}

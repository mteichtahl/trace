/**
 * What a piece of agent work delivers, read from its words, so trace can tell when new work would do again what open
 * work already does (log #93: a second architecture proposal handed off while the first waited for review; #110: two
 * documentation changes open at once on the same document).
 *
 *   deliverablesOf   the deliverables a request, title or summary names: the architecture proposal, the pin plan, the
 *                    sheet plan, and each design document (by its file, its title or its short name). Only what one
 *                    piece of work owns as a whole: two jobs that name it would write the same record or file, and
 *                    accepting both would mix them (the architecture rows of two proposals, two edits of one document)
 *   coveringWork     among a project's work (its jobs, and the open change each job made), the first of the asked
 *                    specialist's that is still working or waits for review and names a deliverable the new request
 *                    names too; null when nothing covers it
 *
 * Deliberately narrow: words such as "the schematic" or "the board" name what nearly every job touches, and a refusal
 * on them would stop unrelated work. Pure.
 */
import { DOC_KINDS, DOCS } from '../docs/catalog.js'
import { type JobRow, isLive } from './job-index.js'

export interface Deliverable {
  /** stable key: architecture, pins, sheets, doc:<kind> */
  key: string
  /** in words: "the architecture proposal" */
  words: string
}

interface Rule { key: string; words: string; test: (t: string) => boolean }

const RULES: readonly Rule[] = [
  {
    key: 'architecture', words: 'the architecture proposal',
    // "propose the architecture", "architecture options A/B/C", "compare architectures", design.architecture, arch_options
    test: (t) => /\bdesign\.architecture\b|\barch_options\b/.test(t)
      || (/\barchitectures?\b/i.test(t) && /\b(propos\w*|options?|compar\w*|trade-?offs?|scor\w*|candidates?|alternatives?|record)\b/i.test(t)),
  },
  { key: 'pins', words: 'the pin plan', test: (t) => /\bdesign\.pins\b|\bpin (plan|map|assignments?|budget)\b/i.test(t) },
  { key: 'sheets', words: 'the sheet plan', test: (t) => /\bdesign\.sheets\b|\bsheet plan\b/i.test(t) },
  ...DOC_KINDS.map((k): Rule => {
    const d = DOCS[k]
    const file = d.file.split('/').at(-1)?.replace(/\.md$/, '') ?? k
    const title = d.title.toLowerCase().replace(/\s+/g, '[\\s-]+')
    const short = k === 'hld' || k === 'lld' ? `|\\b${k.toUpperCase()}\\b` : ''
    const re = new RegExp(`\\b(${file.replace(/-/g, '[\\s-]+')}|${title})(\\.md)?\\b${short}`, 'i')
    return { key: `doc:${k}`, words: `the ${d.title.toLowerCase()}`, test: (t) => re.test(t) }
  }),
]

/** The deliverables `texts` name, each once, in the order of RULES. */
export function deliverablesOf(...texts: readonly (string | null | undefined)[]): Deliverable[] {
  const t = texts.filter(Boolean).join('\n')
  if (!t.trim()) return []
  return RULES.filter((r) => r.test(t)).map(({ key, words }) => ({ key, words }))
}

/** One piece of a project's work as coveringWork reads it: a job, and the open change it made when it has one. */
export interface Work {
  job: Pick<JobRow, 'id' | 'agent' | 'kind' | 'state' | 'title' | 'summary' | 'payload' | 'branch' | 'parentJob' | 'beatAt' | 'startedAt' | 'updatedAt'>
  /** the open change on the job's branch (its pull request), when there is one */
  change?: { number: number; title: string } | null
}

export interface Covering {
  /** the job, the worker's id */
  job: string
  /** its open change, when the work waits for review */
  change: { number: number; title: string } | null
  /** still working (queued, running or paused) or waiting for review */
  state: 'working' | 'review'
  /** what both name */
  deliverables: Deliverable[]
  /** the job's or change's title, for the words */
  title: string
}

/** The request a job row recorded (its payload's `request`), or ''. */
const requestOf = (payload: string | null): string => {
  if (!payload) return ''
  try {
    const p = JSON.parse(payload) as { request?: unknown; agent?: unknown }
    return typeof p.request === 'string' ? p.request : ''
  } catch { return '' }
}

/** The specialist a job is for: the one its request was asked of, else the one it ran as. */
const agentOf = (job: Work['job']): string | null => {
  try {
    const a = job.payload ? (JSON.parse(job.payload) as { agent?: unknown }).agent : undefined
    if (typeof a === 'string') return a
  } catch { /* the row's agent stands */ }
  return job.agent
}

/**
 * The work of specialist `kind` that already covers `request`: a job of it still working (queued, paused, or running
 * and alive), or one whose change is open and waits for review, that names a deliverable `request` names too. `except`:
 * the asking job's own id. Newest first among equals is the caller's order; the first match is returned.
 */
export function coveringWork(request: string, kind: string, work: readonly Work[], o: { at: number; except?: string | null | undefined }): Covering | null {
  const asked = deliverablesOf(request)
  if (!asked.length) return null
  for (const w of work) {
    const j = w.job
    if (j.id === o.except || j.parentJob || j.kind === 'sweep' || agentOf(j) !== kind) continue
    const working = j.state === 'queued' || j.state === 'paused' || isLive(j as JobRow, o.at)
    const review = !working && Boolean(w.change)
    if (!working && !review) continue
    const theirs = new Set(deliverablesOf(j.title, requestOf(j.payload), j.summary, w.change?.title).map((d) => d.key))
    const both = asked.filter((d) => theirs.has(d.key))
    if (both.length) return { job: j.id, change: w.change ?? null, state: working ? 'working' : 'review', deliverables: both, title: w.change?.title ?? j.title }
  }
  return null
}

const list = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)

/** What the asker is told when its request is already covered, in words: what covers it, and what to do instead. */
export function coveredWords(c: Covering, who: string): string {
  const what = list(c.deliverables.map((d) => d.words))
  const where = c.change
    ? `change #${c.change.number} ("${c.change.title.slice(0, 120)}"), which waits for a person's review`
    : `job ${c.job} ("${c.title.slice(0, 120)}"), which is still working`
  return `${who} is already doing ${what}: ${where}. A second one would clash with it, and accepting both would mix them. Build on that work instead: read it (its change, or journey.status), carry on with what it does not block, and say in your report what waits on it.`
}

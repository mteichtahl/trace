/**
 * Jobs named in an agent's own words, and those words without trace's internal job ids (test-esp32-run2 log R18).
 *
 * An agent that is stuck or asks a question often names the job it waits on by its id: a job index id
 * (`job-mw6tp02o-ebfc934b`), a queued start's handle (`queued~owner~repo~473ee5ad94f6`) or that handle's last part
 * (`job 473ee5ad94f6`). None of them means anything to a person. The views (mergeAgentFacts) put the job's title in
 * their place when it is known, and plain words when it is not. The ids also say what a stuck note waits on: when
 * every job it names has ended and left no open change, what it waited on has landed (src/core/journey.ts
 * mergeAgentFacts retires the note).
 *
 * Pure.
 */

/** What the views know of the project's jobs, by any id an agent may name one by. */
export interface JobLook {
  /** the job's title, or null when it is not known */
  title(ref: string): string | null
  /** true: the job ended and left no open change (what waited on it can go on); false: not yet; null: not known */
  landed(ref: string): boolean | null
}

// a job index id, a queued start's handle, or (after the word "job") a queued start's own id
const ID = String.raw`(?:queued~[A-Za-z0-9-]+~[A-Za-z0-9._-]+~[0-9a-f]{12}|job-[a-z0-9]{4,}-[0-9a-f]{6,}|trace-api-[A-Za-z0-9.-]+)`
const NAMED = new RegExp(String.raw`\b(?:the\s+)?(?:(?:earlier|previous|other|first)\s+)?job\s+(${ID}|[0-9a-f]{12})\b`, 'gi')
const BARE = new RegExp(String.raw`\b${ID}\b`, 'g')

/** The job ids a text names, in order, each once. */
export function jobRefs(text: string | null | undefined): string[] {
  if (!text) return []
  const out = [...text.matchAll(NAMED)].map((m) => m[1] as string)
  for (const m of text.matchAll(BARE)) out.push(m[0])
  return [...new Set(out.map((x) => x.toLowerCase()))]
}

/** A queued handle's own id (its last part), or the ref as it is. */
export const refKey = (ref: string): string => {
  const m = /^queued~[^~]+~[^~]+~([0-9a-f]{12})$/i.exec(ref)
  return (m?.[1] ?? ref).toLowerCase()
}

/** The text with each job id it names replaced by the job's title in quotes, or by "another job". */
export function plainJobRefs(text: string, look?: Pick<JobLook, 'title'> | null): string {
  const words = (ref: string, the: boolean): string => {
    const t = look?.title(ref)?.replace(/\s+/g, ' ').trim()
    if (t) return `${the ? 'the job ' : ''}"${t.length > 80 ? `${t.slice(0, 79)}…` : t}"`
    return the ? 'another job' : 'another job'
  }
  return text.replace(NAMED, (_m, ref: string) => words(ref, true)).replace(BARE, (ref) => words(ref, false))
}

/** The same for text that may be null. */
export const plainJobRefsOf = (text: string | null, look?: Pick<JobLook, 'title'> | null): string | null => (text === null ? null : plainJobRefs(text, look))

/**
 * An agent's words as a person reads them on a card: a stuck report or a job's request comes from the agent, and the
 * agent writes for itself (test-esp32 log #35: run ids, a stack frame, tool names and "job-mw2lhy11-952f6819" on the
 * question a person had to answer; #25: the drafting job's prompt, cut off mid-word, on the "trace is doing" card).
 * The card shows the plain summary; the agent's own words stay behind "Show detail" (or Watch, for a job), never
 * thrown away.
 *
 * The summary is made, not written: the sentences that name none of the agent's internals (an id, a stack frame, a
 * tool, a file and line), up to a length, cut at a sentence or a word, never in the middle of one. When every sentence
 * names one, the first is kept with its internals taken out. Pure.
 */

/** A line of a stack trace ("at TCP.<anonymous> (node:net:347:12)", "at Object.run (/app/x.js:10:5)"). */
const FRAME = /^\s*at\s+\S.*(?:\(\S+:\d+(?::\d+)?\)|\S+:\d+:\d+)\s*$/
/** The agent's internals a person cannot act on. */
const INTERNAL: readonly RegExp[] = [
  /\bjob-[a-z0-9]+-[0-9a-f]{6,}\b/i, // a job's handle
  /\b(?:aq|st|cc)[0-9a-f]{14}\b/, // an agent fact's id
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // a uuid (a run, a session)
  /\brun\s+[0-9a-z-]*\d[0-9a-z-]{5,}\b/i, // "run 3f2a9c1d"
  /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/, // a tool's or a field's name (docs_publish, changed_since)
  /\b[a-z][a-z0-9]*\.[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*\s*(?:\(|\{|list\b)/, // a tool called by name (journey.ask {…}, design.intent list)
  /`[^`]+`/, // code
  /\b\S+\.(?:[cm]?js|ts|py|rs|json):\d+/, // a file and line
  /\b(?:stack|traceback|errno|exit code|stderr|ENOENT|ECONN\w+)\b/i,
  /\b[a-z]{3,}\.[a-z][a-z_]{2,}\b/, // a criterion's or a tool's id (architect.stock, render.board)
  /\bsha256\b|\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/i, // a hash or a run's id (52b9eb5d36ae4a0d)
]

const internal = (s: string): boolean => INTERNAL.some((re) => re.test(s))

/**
 * A sentence with its asides that cite the agent's internals taken out (test-esp32 #170: "No configured supplier lists
 * a 0.96 in SSD1306 module (parts_search on LCSC: …; bom_check d908…: not found)." is plain without its brackets).
 * Brackets that name nothing internal ("(GND first)") stay.
 */
function withoutInternalAsides(s: string): string {
  return s.replace(/\s*\([^()]*\)/g, (aside) => (internal(aside) ? '' : aside)).replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim()
}

/** A sentence that adds to the point rather than making it ("Also: …", "Note: …"): it never leads a summary (#170). */
const ASIDE = /^(?:also|note|besides|separately|in addition|additionally|p\.?s\.?)\b[:,]?/i

/** The words with an agent's internals taken out ("(job-…)", backticks, a file and line), spaces tidied. */
function stripped(s: string): string {
  return s
    .replace(/\(\s*(?:job-[a-z0-9-]+|run [^)]+|[a-z0-9_.-]+:\d+(?::\d+)?)\s*\)/gi, '')
    .replace(/\bjob-[a-z0-9]+-[0-9a-f]{6,}\b/gi, 'a job')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Cut `s` at a word, under `max` characters, with an ellipsis when anything was cut. */
function atWord(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.(-]+$/, '')}…`
}

/** The sentences of a text (a stack trace's lines and code blocks left out). */
function sentences(text: string): string[] {
  // a line that ends in a colon ends its sentence too (what followed it, a trace or a listing, is left out)
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, ' ').split('\n').filter((l) => !FRAME.test(l)).map((l) => l.replace(/:\s*$/, '.')).join(' ').replace(/\s+/g, ' ').trim()
  // a sentence ends at . ! or ? and a space (an agent starts the next with a tool's name as often as with a capital),
  // but not after an abbreviation ("e.g. the"); "3.3 V" has no space after its point
  const out: string[] = []
  for (const piece of prose.split(/(?<=[.!?])\s+/)) {
    const last = out.at(-1)
    if (last !== undefined && ABBREVIATION.test(last)) out[out.length - 1] = `${last} ${piece}`
    else out.push(piece)
  }
  return out.map((x) => x.trim()).filter(Boolean)
}
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|approx|incl|no|fig|p|pp|cf)\.$/i

/**
 * A plain summary of an agent's words, at most `max` characters (default 160): the plain sentences, in order, while
 * they fit; else the first sentence with its internals taken out. `same`: whether it is the text itself (nothing to
 * show behind "Show detail").
 */
export function plainSummary(text: string, o: { max?: number } = {}): { summary: string; same: boolean } {
  const max = o.max ?? 160
  const all = sentences(text)
  const whole = text.replace(/\s+/g, ' ').trim()
  const plain = all.map(withoutInternalAsides).filter((s) => s && !internal(s))
  // the point leads: an aside is kept only after a sentence that is not one
  while (plain.length > 1 && ASIDE.test(plain[0]!) && plain.some((s) => !ASIDE.test(s))) plain.push(plain.shift()!)
  let out = ''
  for (const s of plain) {
    const next = out ? `${out} ${s}` : s
    if (next.length > max) break
    out = next
  }
  if (!out) out = atWord(stripped(plain[0] ?? (all[0] === undefined ? whole : withoutInternalAsides(all[0]))), max)
  return { summary: out, same: out === whole }
}

/**
 * A job's request as its card's one line: its first plain sentence, cut at a word (test-esp32 #25: the title was the
 * prompt's first 200 characters, ending "use the a"). The request itself stays where Watch shows it.
 */
export function plainTitle(request: string, max = 100): string {
  const first = sentences(request).find((s) => !internal(s)) ?? sentences(request)[0] ?? request
  return atWord(stripped(first), max).replace(/\.$/, '')
}

/**
 * A job's title, the one place it is made (test-esp32 #25, #164, #189, #196: a start path that gave no title showed its
 * prompt cut mid-word, "… only par"): the headline it was started with ("Sign-off: redo what the requirement change
 * reaches"), else its request's first plain sentence (plainTitle). Never the raw prompt. Pure.
 */
export function jobHeadline(p: { request: string; headline?: string | null | undefined }): string {
  const given = p.headline?.replace(/\s+/g, ' ').trim()
  return given ? atWord(given, 100) : plainTitle(p.request)
}

/**
 * The title a job row is shown with, for rows written before titles were headlines: the headline in its payload, else
 * its title made plain the same way (a title that was the prompt's first 200 characters loses its cut word). Pure.
 */
export function shownJobTitle(j: { title: string; payload?: string | null | undefined }): string {
  if (j.payload) {
    try {
      const p = JSON.parse(j.payload) as { headline?: unknown }
      if (typeof p.headline === 'string' && p.headline.trim()) return jobHeadline({ request: '', headline: p.headline })
    } catch { /* not JSON: its title */ }
  }
  return plainTitle(j.title) || j.title
}

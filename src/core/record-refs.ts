/**
 * The record's ids in an agent's words, said as people say them (test-esp32-run2 log R29, R30, R31).
 *
 * Agents cite what they read by its id: a run ("Parts check 84ac569329e8472d: all 12 lines in stock", "(84ac569329e8472d:
 * USD 60.54-89.77 …)"), a person's answer ("which excludes shipping (answer aq472364d7dd6243)") and a gate criterion
 * ("so architect.stock is not met", "It blocks the architect.stock criterion"). None of them means anything to a
 * person. Where such words are shown, a run reads as what it is ("the parts check"), an answer as "your answer" (or
 * "the answer"), and a criterion as its own words. The job ids are src/core/job-refs.ts's.
 *
 * Pure (runKindsOf reads an open database).
 */
import type { DatabaseSync } from 'node:sqlite'

/** What a run of each tool is, in words; others are said from the tool's name ("kicad.board" → "board run"). */
const RUN_WORDS: Readonly<Record<string, string>> = {
  'parts.bom_check': 'parts check', 'parts.search': 'parts search', 'parts.lookup': 'part lookup',
  'kicad.erc': 'electrical rule check', 'kicad.drc': 'design rule check', 'kicad.netlist': 'netlist', 'kicad.bom': 'parts list',
  'mech.fit': 'case fit check', 'mech.build': 'case build', 'verify.report': 'verification report', 'shape.check': 'check',
  'sim.spice': 'simulation', 'sim.sweep': 'simulation sweep', 'design.pins': 'pin plan check',
}

/** A run of `kind`, in words: "parts check", "LDO thermal calculation", "board run". */
export function runWords(kind: string): string {
  if (RUN_WORDS[kind]) return RUN_WORDS[kind]!
  const [family, name = ''] = kind.split('.')
  const words = name.replace(/_/g, ' ')
  return family === 'calc' ? `${words} calculation` : `${words || family} run`
}

/** Every run in the record database, by id, as its words (empty when it has no runs table). */
export function runKindsOf(db: DatabaseSync): Map<string, string> {
  try {
    return new Map((db.prepare('SELECT id, kind FROM runs').all() as { id: string; kind: string }[]).map((r) => [String(r.id).toLowerCase(), runWords(String(r.kind))]))
  } catch {
    return new Map()
  }
}

/** What the words are said with: a run's words by its id, and whose an answer is ('you' or null). */
export interface RecordLook {
  run?: ((id: string) => string | null | undefined) | undefined
  answer?: ((id: string) => 'you' | null | undefined) | undefined
}

const RUN_ID = /(\b(?:the\s+)?(?:run\s+))?`?\b([0-9a-f]{16})\b`?/gi
const ANSWER_ID = /\b(?:(?:the|your|their|his|her)\s+)?(answers?\s+)?`?\b(aq[0-9a-f]{14})\b`?/gi
// a tool's own name before the id ("bom_check 84ac…", "parts.bom_check run 84ac…"): the app links those (cited.tsx)
const TOOL_BEFORE = /\b[a-z][a-z0-9]*[._][a-z0-9_]+\s+(?:run\s+)?$/
// where a sentence starts: the words then start with a capital
const STARTS = /(?:^|[.!?]\s+|\n\s*)$/

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * The text with the run and answer ids it names said in words: a run already named before its id ("Parts check
 * 84ac…") loses the id, another reads "the parts check"; an answer reads "your answer" when it is the viewer's, else
 * "the answer". A run id the record does not know is left as it is: it may be something else. Pure.
 */
export function plainRecordRefs(text: string, look: RecordLook = {}): string {
  if (!text) return text
  let out = text.replace(RUN_ID, (whole, run: string | undefined, id: string, at: number, all: string) => {
    const words = look.run?.(id.toLowerCase())
    if (!words) return whole
    const before = all.slice(0, at)
    if (!run && TOOL_BEFORE.test(before)) return whole
    // "Parts check 84ac…": already said; the id goes, with the space before it
    if (!run && new RegExp(`\\b${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i').test(before)) return ''
    const said = `the ${words}`
    return STARTS.test(before) ? cap(said) : said
  })
  // the space left where an id went ("Parts check : all")
  out = out.replace(/ +([:;,)])/g, '$1').replace(/(\S) {2,}/g, '$1 ')
  return out.replace(ANSWER_ID, (_whole, _ans: string | undefined, id: string, at: number, all: string) => {
    const said = look.answer?.(id.toLowerCase()) === 'you' ? 'your answer' : 'the answer'
    return STARTS.test(all.slice(0, at)) ? cap(said) : said
  })
}

/** The same for text that may be null. */
export const plainRecordRefsOf = (text: string | null, look: RecordLook = {}): string | null => (text === null ? null : plainRecordRefs(text, look))

/**
 * The text with each gate criterion id it names (the project's own: `criteria`) said in that criterion's words, in
 * quotes: "so architect.stock is not met" → 'so "every key part is in stock …" is not met', "the architect.stock
 * criterion" → 'the criterion "every key part …"'. A word that only looks like an id is left as it is. Pure.
 */
export function plainCriterionRefs(text: string, criteria: readonly { id: string; text: string }[]): string {
  if (!text || !criteria.length) return text
  const byId = new Map(criteria.map((c) => [c.id.toLowerCase(), c.text]))
  const quoted = (id: string): string | null => {
    const t = byId.get(id.toLowerCase())?.trim().replace(/\.$/, '')
    if (!t) return null
    // "Every key part …" reads "every key part …" inside a sentence; "JLCPCB …" stays as it is
    return `"${/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t}"`
  }
  return text
    .replace(/\b(the\s+)?([a-z]+(?:\.[a-z]+){1,2})\s+criterion\b/gi, (whole, the: string | undefined, id: string) => {
      const q = quoted(id)
      return q ? `${the ? (the.startsWith('T') ? 'The ' : 'the ') : ''}criterion ${q}` : whole
    })
    .replace(/(?<![\w.])([a-z]+(?:\.[a-z]+){1,2})(?![\w])/gi, (whole, id: string) => quoted(id) ?? whole)
}

/** The same for text that may be null. */
export const plainCriterionRefsOf = (text: string | null, criteria: readonly { id: string; text: string }[]): string | null =>
  (text === null ? null : plainCriterionRefs(text, criteria))

/** An architecture as the views show it, with what an agent wrote in it said in words (plainRecordRefs). Pure. */
export function plainArchitecture<A extends {
  options: readonly { summary: string; why: string | null; gives_up: string | null; risks: readonly string[] }[]
  scores: readonly { reason: string }[]
  criteria: readonly { description: string | null }[]
}>(a: A, look: RecordLook): A {
  const w = (t: string): string => plainRecordRefs(t, look)
  const wn = (t: string | null): string | null => plainRecordRefsOf(t, look)
  return {
    ...a,
    options: a.options.map((o) => ({ ...o, summary: w(o.summary), why: wn(o.why), gives_up: wn(o.gives_up), risks: o.risks.map(w) })),
    scores: a.scores.map((s) => ({ ...s, reason: w(s.reason) })),
    criteria: a.criteria.map((c) => ({ ...c, description: wn(c.description) })),
  }
}

/** Whose each answer is, from the journey's questions: 'you' for one the viewer gave. */
export const answerLook = (questions: readonly { id: string; answeredAt: number | null; answeredByHash: string | null }[], viewerHash: string | null | undefined) =>
  (id: string): 'you' | null => {
    const q = questions.find((x) => x.id.toLowerCase() === id)
    return q && q.answeredAt !== null && viewerHash && q.answeredByHash === viewerHash ? 'you' : null
  }

/** What a finding of each kind is, in words; others are said from the kind ("no_net" → "no net"). */
const FINDING_WORDS: Readonly<Record<string, string>> = {
  mate_order: 'connector pin order', mate_unknown: 'unknown connector pin order', strap_pull: 'strapping pin pull',
}
const RUN_KINDS = Object.keys(RUN_WORDS).map((k) => k.replace(/\./g, '\\.')).join('|')
// "the design.pins mate_order finding", "design.pins check: mate_order on J2"
const FINDING = new RegExp(String.raw`\b(the\s+)?(${RUN_KINDS})(\s+check)?(:)?\s+([a-z]+(?:_[a-z]+)+)\b`, 'gi')
// a datasheet's short hash (a sha256's first 8 characters), with a digit so a word is never taken for one
const HASH = String.raw`(?:sha256\s+)?\b(?=[0-9a-f]*[0-9])[0-9a-f]{8}\b`
const PAGE = String.raw`,?\s*p(?:age|\.)?\s?(\d+)\b`

/**
 * The text with the datasheets and findings it names by code said in words (test-esp32-run2 R39: a question quoted
 * "(ea9a571f p2)", "waive the mismatch with ea9a571f" and "the design.pins mate_order finding on J2"): a datasheet's
 * short hash reads "the datasheet" (with its page), a finding "the pin plan check's connector pin order finding". A
 * hash is only taken for a datasheet where the words say so (a page, "datasheet", "with"): another may be something
 * else. Pure.
 */
export function plainCodeRefs(text: string): string {
  if (!text) return text
  return text
    .replace(FINDING, (_w, the: string | undefined, kind: string, _check: string | undefined, colon: string | undefined, finding: string) => {
      const run = runWords(kind.toLowerCase())
      const f = FINDING_WORDS[finding.toLowerCase()] ?? finding.toLowerCase().replace(/_/g, ' ')
      return colon ? `${the ? (the.startsWith('T') ? 'The ' : 'the ') : ''}${run}: ${f}` : `${the ? (the.startsWith('T') ? 'The ' : 'the ') : ''}${run}'s ${f}`
    })
    // "the library datasheet (ea9a571f p2)": the datasheet is said, its page is what is left
    .replace(new RegExp(String.raw`(datasheet\s*)\(\s*${HASH}${PAGE}\s*\)`, 'gi'), (_w, d: string, page: string) => `${d}(page ${page})`)
    .replace(new RegExp(String.raw`(\b(?:the\s+)?datasheet\s+)?${HASH}${PAGE}`, 'gi'), (_w, _d, page: string, at: number, all: string) =>
      `${STARTS.test(all.slice(0, at)) ? 'The' : 'the'} datasheet, page ${page}`)
    .replace(new RegExp(String.raw`\b(?:the\s+)?datasheet\s+${HASH}`, 'gi'), (_w, at: number, all: string) => `${STARTS.test(all.slice(0, at)) ? 'The' : 'the'} datasheet`)
    .replace(new RegExp(String.raw`\b(with|against|per|from)\s+${HASH}`, 'gi'), (_w, prep: string) => `${prep} the datasheet`)
}

/**
 * A question's words as people read them: its gate criteria (plainCriterionRefs), answers (plainRecordRefs: "the
 * answer", "your answer" with `look`), datasheets and findings (plainCodeRefs) said in words. Pure.
 */
export function plainQuestionText(text: string, criteria: readonly { id: string; text: string }[], look: RecordLook = {}): string {
  return plainCriterionRefs(plainCodeRefs(plainRecordRefs(text, look)), criteria)
}

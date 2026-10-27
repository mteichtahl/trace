/**
 * A project's custom vocabulary for dictation (Amazon Transcribe streaming), from its design: the reference
 * designators, part numbers, net names and requirement ids people say when they talk about the board. Pure: what is
 * read from the checkout and what is sent to AWS are tools.ts's.
 *
 * Transcribe's table format (custom-vocabulary-create-table), which every row here keeps:
 *
 *   columns   Phrase, SoundsLike, IPA, DisplayAs, tab-separated, with a header row. SoundsLike and IPA are no longer
 *             supported by Transcribe (ignored, to be removed) and are left empty: the spoken form is the Phrase, and
 *             what is written is DisplayAs
 *   Phrase    letters, hyphens between words, periods only after single letters of an acronym ("C.L.I."); no digits
 *             (spelled out: "V.X.-zero-two-Q." for VX02Q), no spaces; may not start with . ' or -, may not end with '
 *             or -, never two of - . ' in a row; at most 256 characters
 *   DisplayAs anything printable but a tab or a line break (digits and symbols are fine): the design's own spelling
 *   size      at most 50 KB per vocabulary: rows are kept in order of use (designators, part numbers, nets,
 *             requirement ids) and the rest are counted as left out
 *
 * Spoken forms. A name is split into runs of letters and digits; other characters (_ - / . space) separate words, and
 * + is said "plus". A run of letters is spelled as an acronym ("S.T.M.") unless it reads as a word (four letters or
 * more with a vowel, or a capitalised word such as "Buck"), when the word and the spelled form are both given. Digits
 * are said one by one ("R.-one-four"); a reference designator's number is also said as a number ("R.-fourteen"), as
 * people say both. Number words are English, so only English languages get a vocabulary (ENGLISH below).
 */
import { createHash } from 'node:crypto'
import { VOICE_LANGUAGES } from '../../core/config.js'

/** The languages whose number words these spoken forms use (Transcribe streaming's English variants). */
export const ENGLISH = VOICE_LANGUAGES
export type EnglishLanguage = (typeof ENGLISH)[number]
export const isEnglish = (l: string): l is EnglishLanguage => (ENGLISH as readonly string[]).includes(l)

export const MAX_PHRASE = 256
export const MAX_TABLE_BYTES = 50 * 1024
export const HEADER = 'Phrase\tSoundsLike\tIPA\tDisplayAs'

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** 0–999 as words joined by hyphens ("one-hundred-twenty-three"), or null above. */
export function numberWords(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 999) return null
  if (n < 10) return DIGITS[n] as string
  if (n < 20) return TEENS[n - 10] as string
  if (n < 100) return [TENS[Math.floor(n / 10)] as string, ...(n % 10 ? [DIGITS[n % 10] as string] : [])].join('-')
  const rest = n % 100
  return [DIGITS[Math.floor(n / 100)] as string, 'hundred', ...(rest ? [numberWords(rest) as string] : [])].join('-')
}

const spellDigits = (d: string): string[] => [...d].map((c) => DIGITS[Number(c)] as string)
const spellLetters = (l: string): string => [...l.toUpperCase()].map((c) => `${c}.`).join('')
/** Reads as a word rather than letters: four or more with a vowel, or a capitalised word ("Buck", "Sensor"). */
const wordLike = (l: string): boolean => (l.length >= 4 && /[AEIOUYaeiouy]/.test(l)) || /^[A-Z][a-z]{2,}$/.test(l)

type Token = { kind: 'letters' | 'digits' | 'plus'; text: string }

function tokens(name: string): Token[] {
  const out: Token[] = []
  for (const m of name.matchAll(/[A-Za-z]+|\d+|\+/g)) out.push({ kind: m[0] === '+' ? 'plus' : /\d/.test(m[0]) ? 'digits' : 'letters', text: m[0] })
  return out
}

/** Every way of saying one token: digits one by one (and, when asked, as a number), letters spelled (and as a word). */
function forms(t: Token, number: boolean): string[] {
  if (t.kind === 'plus') return ['plus']
  if (t.kind === 'digits') {
    const one = spellDigits(t.text).join('-')
    const n = number && !(t.text.length > 1 && t.text.startsWith('0')) ? numberWords(Number(t.text)) : null
    return n && n !== one ? [one, n] : [one]
  }
  const spelled = spellLetters(t.text)
  return wordLike(t.text) ? [t.text, spelled] : [spelled]
}

/** Whether a Phrase keeps Transcribe's rules (see the file's comment). */
export function validPhrase(p: string): boolean {
  if (!p || p.length > MAX_PHRASE) return false
  if (!/^[A-Za-z.'-]+$/.test(p)) return false
  if (/^[.'-]/.test(p) || /['-]$/.test(p)) return false
  if (/--|\.\.|''/.test(p)) return false
  // periods only after single letters: every word with a period is a run of "X." pairs
  for (const w of p.split('-')) if (w.includes('.') && !/^([A-Za-z]\.)+$/.test(w)) return false
  return true
}

/** The spoken forms of one name, at most `max` of them (the first is the plainest). */
export function spokenForms(name: string, o: { number?: boolean; max?: number } = {}): string[] {
  const ts = tokens(name)
  if (!ts.length || ts.length > 24) return []
  let all: string[] = ['']
  for (const t of ts) {
    const next: string[] = []
    for (const prefix of all) for (const f of forms(t, o.number ?? false)) next.push(prefix ? `${prefix}-${f}` : f)
    all = next.slice(0, 16)
  }
  return [...new Set(all)].filter(validPhrase).slice(0, o.max ?? 3)
}

/** What a design gives the vocabulary, in the order rows are kept. */
export interface DesignTerms {
  /** reference designators: R14, U4, J1 */
  refs: readonly string[]
  /** manufacturer part numbers (and values that read as one): STM32F405RGT6, LM358 */
  parts: readonly string[]
  /** net names: labels and power nets (VCC_3V3, SDA) */
  nets: readonly string[]
  /** requirement ids: REQ-LAY-001 */
  requirements: readonly string[]
}

export interface Row { phrase: string; display: string }
export interface Table { text: string; rows: number; omitted: number; sha256: string; terms: number }

/** A DisplayAs: the design's own spelling, tabs and line breaks removed. */
const display = (s: string): string => s.replace(/[\t\r\n]+/g, ' ').trim().slice(0, MAX_PHRASE)

/** A name worth saying: not empty, no bus or hierarchy syntax left, not too long. */
const sayable = (s: string): boolean => s.length > 0 && s.length <= 64 && !/[[\]{}<>]/.test(s)

/** The rows for a design: each term's spoken forms, the design's spelling shown, duplicates dropped. */
export function rowsOf(d: DesignTerms): Row[] {
  const out: Row[] = []
  const seen = new Set<string>()
  const add = (names: readonly string[], number: boolean): void => {
    for (const raw of names) {
      const name = display((raw.split('/').filter(Boolean).pop() ?? raw))
      if (!sayable(name)) continue
      for (const phrase of spokenForms(name, { number })) {
        const key = `${phrase}\u0000${name}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ phrase, display: name })
      }
    }
  }
  add(d.refs, true)
  add(d.parts, false)
  add(d.nets, false)
  add(d.requirements, false)
  return out
}

/** The vocabulary table file: header and rows, within MAX_TABLE_BYTES; its sha256 says whether it changed. */
export function vocabularyTable(d: DesignTerms, maxBytes = MAX_TABLE_BYTES): Table {
  const rows = rowsOf(d)
  const lines = [HEADER]
  let bytes = Buffer.byteLength(HEADER) + 1
  let kept = 0
  for (const r of rows) {
    const line = `${r.phrase}\t\t\t${r.display}`
    const n = Buffer.byteLength(line) + 1
    if (bytes + n > maxBytes) break
    lines.push(line)
    bytes += n
    kept++
  }
  const text = `${lines.join('\n')}\n`
  const terms = new Set([...d.refs, ...d.parts, ...d.nets, ...d.requirements]).size
  return { text, rows: kept, omitted: rows.length - kept, sha256: createHash('sha256').update(text).digest('hex'), terms }
}

/**
 * The vocabulary's name for a project and language: `<prefix>-<project hash>-<language>` (Transcribe allows
 * [0-9a-zA-Z._-], at most 200). The roles' IAM is written for exactly this shape (src/infra/project.ts).
 */
export const vocabularyName = (base: string, language: string): string => `${base}-${language}`

/**
 * Candidate requirements from a specification's text, found by rules (no model): the agent reads the candidates and
 * confirms, edits or drops each one before it becomes a requirement.
 *
 * A candidate is
 *   - a sentence with a requirement verb: shall, must, is required to, has to, needs to, should, will (weaker: the
 *     score says so), including the negative forms; or
 *   - a specification-table line: a parameter name followed by numbers with a unit, or min/typ/max columns
 *     ("Supply voltage  VDD  2.7  3.3  3.6  V").
 *
 * Each gets a kind by keywords and units (emc before timing before electrical; functional otherwise), the numeric
 * limits found in it (≤ 5 mA, 2.7 to 3.6 V, ±2 %, at least 10 MHz, min/typ/max), an acceptance criterion written from
 * those limits (or "<the statement> is demonstrated" when it has none), the page, and a score in [0, 1] with the
 * reasons, so weak matches can be told from strong ones. Repeated statements (same text after normalising spaces and
 * case) are reported once.
 */
import type { Requirement } from './db.js'

export interface Limit {
  op: '<=' | '>=' | '<' | '>' | '=' | 'range' | 'tol'
  value?: number
  low?: number
  high?: number
  unit: string
  text: string
}

export interface Candidate {
  text: string
  kind: Requirement['kind']
  acceptance: string
  limits: Limit[]
  page: number | null
  score: number
  reasons: string[]
}

const STRONG = /\b(shall|must|is required to|are required to|has to|have to|needs to|need to|is to be|are to be)\b/i
const WEAK = /\b(should|will|is expected to|are expected to|recommended)\b/i
const NEGATIVE = /\b(shall not|must not|should not|will not|may not)\b/i

const EMC = /\b(EMC|EMI|ESD|EFT|surge|immunity|radiated|conducted emissions?|emissions?|CISPR|EN ?55\d{3}|EN ?61000|IEC ?61000|FCC part 15|ISO ?7637|ISO ?11452|burst|susceptibility|contact discharge|air discharge)\b/i
const TIMING = /\b(latency|delay|setup time|hold time|clock|frequency|period|jitter|skew|rise time|fall time|propagation|cycles?|baud|sample rate|sampling rate|throughput|timeout|within \d|response time|deadline|refresh)\b|\b\d+(\.\d+)?\s?(ps|ns|µs|us|ms|MHz|kHz|GHz|Hz|s)\b/i
const ELECTRICAL = /\b(voltage|current|power|supply|impedance|resistance|capacitance|inductance|ripple|noise|leakage|dissipation|isolation|threshold|drive strength|load|ohms?)\b|\b\d+(\.\d+)?\s?(V|mV|µV|uV|kV|A|mA|µA|uA|nA|W|mW|µW|Ω|ohm|kΩ|MΩ|dB|dBm|F|µF|uF|nF|pF|H|µH|uH|nH|°C)\b/i

// a number with an SI-prefixed unit (or %), e.g. 3.3 V, 100 mA, 48 MHz, 1.5 kΩ, 25 °C, ±2 %
const UNIT = String.raw`(?:%|°C|°F|dBm|dBc|dBµV|dBuV|dB|ppm|V\/µs|V\/us|[pnuµmkMG]?(?:V|A|W|Ω|ohm|Hz|F|H|s|bps|B|b)|LSB|cycles?|bits?|samples?)`
const NUM = String.raw`[-+]?\d+(?:[.,]\d+)?(?:[eE][-+]?\d+)?`

const reNum = (s: string): number => Number(s.replace(',', '.'))

/** Numeric limits in one statement. */
export function limitsOf(text: string): Limit[] {
  const out: Limit[] = []
  const seen = new Set<string>()
  const spans: [number, number][] = []
  // a span of text already read as one limit is not read again by a later, looser pattern ("not exceed 5 mA" is <=,
  // not also the >= of "exceed")
  const add = (l: Limit, at = -1, len = 0): void => {
    if (at >= 0 && spans.some(([a, b]) => at < b && at + len > a)) return
    const k = `${l.op}|${l.value ?? ''}|${l.low ?? ''}|${l.high ?? ''}|${l.unit}`
    if (!seen.has(k)) {
      seen.add(k)
      out.push(l)
      if (at >= 0) spans.push([at, at + len])
    }
  }
  const t = text.replace(/−/g, '-')
  // ranges: 2.7 V to 3.6 V, 2.7 to 3.6 V, 2.7–3.6 V, between 2.7 and 3.6 V
  for (const m of t.matchAll(new RegExp(String.raw`(?:between\s+)?(${NUM})\s*(${UNIT})?\s*(?:to|-|–|—|\.\.|and)\s*(${NUM})\s*(${UNIT})(?![\w/])`, 'g'))) {
    const u = (m[4] ?? m[2]) as string
    if (m[2] && m[4] && m[2] !== m[4]) continue
    add({ op: 'range', low: reNum(m[1] as string), high: reNum(m[3] as string), unit: u, text: m[0].trim() }, m.index, m[0].length)
  }
  // tolerances: ±2 %, +/- 50 ppm
  for (const m of t.matchAll(new RegExp(String.raw`(?:±|\+\/-|\+-)\s*(${NUM})\s*(${UNIT})(?![\w/])`, 'g'))) {
    add({ op: 'tol', value: reNum(m[1] as string), unit: m[2] as string, text: m[0].trim() }, m.index, m[0].length)
  }
  // comparisons: ≤ 5 mA, less than 10 ns, at least 10 MHz, no more than 1 %, maximum of 3 W, exceeds 2 kV
  const cmp: [RegExp, Limit['op']][] = [
    [/(?:≤|<=|=<|not (?:to )?exceed|no (?:more|greater|higher) than|at most|maximum(?: of)?|max(?:imum)?\.?|up to|less than or equal to|within)\s*/i, '<='],
    [/(?:≥|>=|=>|at least|no (?:less|fewer|lower) than|minimum(?: of)?|min(?:imum)?\.?|greater than or equal to|exceeds?|or more)\s*/i, '>='],
    [/(?:<|less than|below|under|lower than|faster than)\s*/i, '<'],
    [/(?:>|greater than|above|over|higher than|more than)\s*/i, '>'],
  ]
  for (const [re, op] of cmp) {
    const full = new RegExp(String.raw`${re.source}(${NUM})\s*(${UNIT})(?![\w/])`, 'gi')
    for (const m of t.matchAll(full)) {
      const v = reNum(m[1] as string)
      // "10 MHz or more" form is caught by the >= pattern only when the words come first; fine for a candidate list
      add({ op, value: v, unit: m[2] as string, text: m[0].trim() }, m.index, m[0].length)
    }
  }
  // "of 100 mA" / "is 3.3 V" / "= 3.3 V" when nothing else was found
  if (!out.length) {
    for (const m of t.matchAll(new RegExp(String.raw`(?:=|\bis\b|\bof\b|\bat\b|:)\s*(${NUM})\s*(${UNIT})(?![\w/])`, 'gi'))) {
      add({ op: '=', value: reNum(m[1] as string), unit: m[2] as string, text: m[0].trim() })
    }
  }
  return out
}

/** A min/typ/max table row: "<name> [symbol] <min> <typ> <max> <unit>" with one to three numbers before the unit. */
export function tableRow(line: string): { name: string; min?: number; typ?: number; max?: number; unit: string } | null {
  const m = new RegExp(String.raw`^\s*([A-Za-z][A-Za-z0-9 ,()/'+-]{2,60}?)\s{2,}(?:([A-Za-z][\w()/,]{0,15})\s+)?((?:(?:${NUM}|[-–—])\s+){1,3})(${UNIT})\s*(?:\s{2,}.*)?$`).exec(line)
  if (!m) return null
  const nums = (m[3] as string).trim().split(/\s+/)
  const vals = nums.map((n) => (/^[-–—]$/.test(n) ? undefined : reNum(n)))
  if (vals.every((v) => v === undefined)) return null
  const name = (m[1] as string).trim()
  const unit = m[4] as string
  if (vals.length === 3) return { name, unit, ...(vals[0] !== undefined ? { min: vals[0] } : {}), ...(vals[1] !== undefined ? { typ: vals[1] } : {}), ...(vals[2] !== undefined ? { max: vals[2] } : {}) }
  if (vals.length === 2) return { name, unit, ...(vals[0] !== undefined ? { min: vals[0] } : {}), ...(vals[1] !== undefined ? { max: vals[1] } : {}) }
  return { name, unit, ...(vals[0] !== undefined ? { typ: vals[0] } : {}) }
}

export function classify(text: string): Requirement['kind'] {
  if (EMC.test(text)) return 'emc'
  if (TIMING.test(text)) return 'timing'
  if (ELECTRICAL.test(text)) return 'electrical'
  return 'functional'
}

const fmt = (n: number): string => String(Math.round(n * 1e9) / 1e9)

export function acceptanceFor(text: string, limits: readonly Limit[], negative: boolean): string {
  if (!limits.length) return `${negative ? 'Demonstrate that it does not happen: ' : 'Demonstrated: '}${text.replace(/\s+/g, ' ').trim()}`
  return limits.map((l) => {
    if (l.op === 'range') return `measured value within ${fmt(l.low as number)} to ${fmt(l.high as number)} ${l.unit}`
    if (l.op === 'tol') return `deviation within ±${fmt(l.value as number)} ${l.unit}`
    const op = negative ? ({ '<=': '>', '>=': '<', '<': '>=', '>': '<=', '=': '!=' } as const)[l.op as '<=' | '>=' | '<' | '>' | '='] : l.op
    return `measured value ${op} ${fmt(l.value as number)} ${l.unit}`
  }).join('; ')
}

/** Split page text into statements: sentences, with table-like lines kept whole. */
export function statements(page: string): { text: string; table: boolean }[] {
  const out: { text: string; table: boolean }[] = []
  let para: string[] = []
  const flush = (): void => {
    if (!para.length) return
    const text = para.join(' ').replace(/\s+/g, ' ').trim()
    para = []
    // sentence split: a full stop, ! or ? followed by a space and a capital or digit; numbers like 3.3 are kept
    for (const sen of text.split(/(?<=[.!?;])\s+(?=[A-Z0-9(•\-–])/)) {
      const t = sen.replace(/^[•\-–*\d.)\s]+(?=[A-Za-z])/, '').trim()
      if (t.length >= 8) out.push({ text: t, table: false })
    }
  }
  for (const raw of page.split('\n')) {
    const line = raw.replace(/\t/g, '  ').trimEnd()
    if (!line.trim()) {
      flush()
      continue
    }
    if (tableRow(line)) {
      flush()
      out.push({ text: line.trim().replace(/\s{2,}/g, '  '), table: true })
      continue
    }
    // a bullet or numbered item starts a new statement
    if (/^\s*([•\-–*]|\d+(\.\d+)*[.)]|\([a-z0-9]+\))\s+/.test(line)) flush()
    para.push(line.trim())
  }
  flush()
  return out
}

/** Candidates from the text of each page (pages[0] is page 1; give one entry for text without pages). */
export function extractCandidates(pages: readonly string[], opts: { minScore?: number; pageNumbers?: boolean } = {}): Candidate[] {
  const minScore = opts.minScore ?? 0.3
  const out: Candidate[] = []
  const seen = new Set<string>()
  pages.forEach((page, i) => {
    for (const st of statements(page)) {
      const reasons: string[] = []
      let score = 0
      const strong = STRONG.exec(st.text)
      const weak = WEAK.exec(st.text)
      const neg = NEGATIVE.test(st.text)
      let limits: Limit[] = []
      if (st.table) {
        const row = tableRow(st.text)
        if (!row) continue
        limits = []
        if (row.min !== undefined && row.max !== undefined) limits.push({ op: 'range', low: row.min, high: row.max, unit: row.unit, text: st.text })
        else if (row.min !== undefined) limits.push({ op: '>=', value: row.min, unit: row.unit, text: st.text })
        else if (row.max !== undefined) limits.push({ op: '<=', value: row.max, unit: row.unit, text: st.text })
        else if (row.typ !== undefined) limits.push({ op: '=', value: row.typ, unit: row.unit, text: st.text })
        score = row.min !== undefined || row.max !== undefined ? 0.6 : 0.35
        reasons.push(row.min !== undefined || row.max !== undefined ? 'specification row with limits' : 'specification row (typical value only)')
      } else {
        if (strong) {
          score += 0.6
          reasons.push(`requirement verb "${strong[1]?.toLowerCase()}"`)
        } else if (weak) {
          score += 0.3
          reasons.push(`weak verb "${weak[1]?.toLowerCase()}"`)
        }
        if (score === 0) continue
        limits = limitsOf(st.text)
        if (limits.length) {
          score += 0.3
          reasons.push(`${limits.length} numeric limit${limits.length > 1 ? 's' : ''}`)
        }
        if (st.text.length > 400) {
          score -= 0.2
          reasons.push('long statement: may hold several requirements')
        }
      }
      score = Math.max(0, Math.min(1, Math.round(score * 100) / 100))
      if (score < minScore) continue
      const key = st.text.toLowerCase().replace(/\s+/g, ' ')
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        text: st.text, kind: classify(st.text), acceptance: acceptanceFor(st.text, limits, neg), limits,
        page: opts.pageNumbers === false ? null : i + 1, score, reasons,
      })
    }
  })
  return out
}

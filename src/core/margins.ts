/**
 * How close a recommendation comes to a hard limit, read from its own words. A specialist that recommends something
 * which only just fits ("totals 19.97 mm against the 20 mm height limit", test-esp32 log #139, where the sum also left
 * out the module's own board) must say so: under 5 % of the limit, or under 1 mm for a length, is too close to
 * recommend without naming the margin. The check is deliberately simple: a quantity set against a limit in the same
 * unit, in one phrase. Pure.
 */

export interface TightMargin { value: number; limit: number; unit: string }

/** Under this much room a quantity is too close to its limit: 5 % of the limit for anything, 1 mm for a length. */
export function tooClose(m: TightMargin): boolean {
  const gap = m.limit - m.value
  return gap >= 0 && (gap < m.limit * 0.05 || (m.unit === 'mm' && gap < 1))
}

const UNIT = String.raw`(mm|cm|mA|A|V|mW|W|°C|g)`
const NUM = String.raw`(\d+(?:\.\d+)?)`
// "<value> <unit> … against | under | within | below | inside | vs | of | ≤ [the|a|an] [up to three words] <limit> <unit>
// [up to two words]": the words around the second figure must call it a limit, so "move J2 5.5 mm west, ≤ 5.5 mm
// socket" is not read as a sum against a limit
const AGAINST = new RegExp(
  String.raw`${NUM}\s*${UNIT}(?![a-z])[^.;\d]{0,40}?(?:\b(?:against|under|within|below|inside|versus|vs\.?|of)\b|<=|≤|<)\s*((?:[a-z-]+\s+){0,4}?)${NUM}\s*${UNIT}(?![a-z])((?:\s+[a-z-]+){0,2})`,
  'gi',
)
const LIMIT = /\b(?:limit|maximum|max|budget|ceiling|rating|allowed|allowance)\b/i

/** The quantities a text sets against a limit with less room than `tooClose` allows. Same unit only. */
export function tightMargins(text: string): TightMargin[] {
  const out: TightMargin[] = []
  for (const m of text.matchAll(AGAINST)) {
    const t = { value: Number(m[1]), unit: m[2]!, limit: Number(m[4]) }
    if (m[5] === t.unit && LIMIT.test(`${m[3]} ${m[6]}`) && t.limit > 0 && tooClose(t)) out.push(t)
  }
  return out
}

/** The room left, in words ("0.03 mm"). */
export const marginWords = (t: TightMargin): string => `${Number((t.limit - t.value).toFixed(3))} ${t.unit}`

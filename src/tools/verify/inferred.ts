/**
 * Numbers trace adds to a requirement that no person gave (test-esp32 #88): in run 1 the drafted acceptance criteria
 * said "(inferred)" beside them; in run 2 "10 of 10 attempts", "1 ms resolution", "5 m line of sight" and "within 5 s"
 * read like the person's own, and a reviewer could not tell the two apart. Every number in an acceptance criterion
 * that is not in the intent is marked in the criterion itself, "(inferred: where it comes from)". verify.requirements
 * lists the ones left unmarked when it adds or updates a requirement, so the drafter marks them. Pure.
 */

/**
 * A quantity: a number and its unit ("1 ms", "4.75 V", "70 %", "12 Mbit/s"), or a count of tries ("10 of 10"). A bare
 * number (a pin, a status code, a count of boards) is left alone: whether a person gave it cannot be told from the
 * number alone.
 */
const QUANTITY = /(?<![\w.])(\d+(?:\.\d+)?)\s*(?:(of\s+\d+)\b|(%|(?:[pnuµmkMG]?(?:s|m|V|A|W|Hz|F|Ohm|ohm|Ω|B|bit\/s|dB|dBm))|min|h|degC|°C|baud|USD)(?![A-Za-z\d]))/g

/** A quantity's words compared: "5 s" and "5.0 s" are the same, "µs" and "us" too. */
const key = (n: string, unit: string): string => `${Number(n)} ${unit.replace(/µ/g, 'u').replace(/\s+/g, ' ').replace(/^°C$/, 'degC').replace(/^(k?)ohm$/, '$1Ohm')}`

/** The numbers of a range or a size that end at a quantity ("0 to 40 degC", "50 x 35 mm"): they share its unit. */
const LEADING = /((?:\d+(?:\.\d+)?\s*(?:to|x|-|–)\s*)+)$/

/** The quantities in a text, compared by key; the numbers of a range or a size each with its unit. */
function quantities(text: string): { key: string; said: string; at: number }[] {
  return [...text.matchAll(QUANTITY)].flatMap((m) => {
    const at = m.index ?? 0
    const unit = m[3]
    const one = { key: key(m[1] as string, (m[2] ?? unit) as string), said: m[0].trim(), at }
    const lead = unit ? LEADING.exec(text.slice(0, at)) : null
    if (!lead || !unit) return [one]
    const from = at - (lead[1] as string).length
    return [...[...(lead[1] as string).matchAll(/\d+(?:\.\d+)?/g)].map((n) => ({ key: key(n[0], unit), said: `${n[0]} ${unit}`, at: from + (n.index ?? 0) })), one]
  })
}

/**
 * Whether the number at `at` is marked: "(inferred …)" follows it before the clause ends, or it sits inside the
 * brackets of one ("(inferred: 10 of 10, typical bring-up)").
 */
function marked(text: string, at: number): boolean {
  const open = text.lastIndexOf('(', at)
  if (open >= 0 && text.indexOf(')', open) >= at && /^\(\s*(?:inferred|assumed)\b/i.test(text.slice(open))) return true
  const rest = text.slice(at)
  const clause = rest.split(/;|\.\s|\.$/)[0] ?? rest
  return /\(\s*(?:inferred|assumed)\b/i.test(clause)
}

/**
 * The quantities in an acceptance criterion that are neither in the intent nor marked inferred, as written ("10 of
 * 10", "1 ms"), in order. `intent`: the intent statements' words.
 */
export function unmarkedNumbers(acceptance: string, intent: readonly string[]): string[] {
  const given = new Set(quantities(intent.join('\n')).map((q) => q.key))
  const out: string[] = []
  for (const q of quantities(acceptance)) {
    if (given.has(q.key) || marked(acceptance, q.at) || out.includes(q.said)) continue
    out.push(q.said)
  }
  return out
}

/** What verify.requirements says of the requirements it wrote with numbers left unmarked, or null when none. */
export function unmarkedNote(reqs: readonly { id: string; acceptance?: string | null | undefined }[], intent: readonly string[]): { requirements: { id: string; numbers: string[] }[]; note: string } | null {
  if (!intent.length) return null
  const found = reqs.map((r) => ({ id: r.id, numbers: r.acceptance ? unmarkedNumbers(r.acceptance, intent) : [] })).filter((r) => r.numbers.length)
  if (!found.length) return null
  return {
    requirements: found,
    note: 'These numbers are not in the intent statements and are not marked. Mark each one you chose in the acceptance criterion itself, "(inferred: where it comes from)", e.g. "within 5 s (inferred: a typical NTP exchange)", and update the requirement; a person reviewing it must tell your numbers from theirs.',
  }
}

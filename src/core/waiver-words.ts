/**
 * What a waiver is on, in plain words, and which gate criterion it belongs to. A waiver names its target by kind and
 * id, and a finding's id is built for matching, not reading: a shape's finding is `<criterion>@<the record it is
 * about>` (src/tools/shape/tools.ts findingId, the record an escaped urn), a rule check's is `<erc|drc>:<type>:<where>`
 * (src/api/record-read.ts). People read "the finding of “The board fits its enclosure” on requirement REQ-8fc402",
 * not "finding layout.fit@urn:trace:trace:mteichtahl%2Ftest-esp32-e2e:requirement:REQ-8fc402" (test-esp32 #155).
 */

/** The criteria a rule check's findings belong to (src/api/evidence-freshness.ts RULE_CHECKS). */
const RULE_CRITERIA = { erc: 'capture.erc', drc: 'layout.drc' } as const
const RULE_WORDS = { erc: 'electrical rule check', drc: 'design rule check' } as const

/** The criterion a waiver on `target` counts for, or null: a requirement's or a test's waiver is the stage's only. */
export function waiverCriterion(target: { kind: string; id: string }): string | null {
  if (target.kind === 'criterion') return target.id
  if (target.kind !== 'finding') return null
  const shape = /^([a-z][a-z.]*\.[a-z]+)@/.exec(target.id)
  if (shape) return shape[1] as string
  const rule = /^(erc|drc):/.exec(target.id)
  if (rule) return RULE_CRITERIA[rule[1] as 'erc' | 'drc']
  // a module's pins against its connector (src/tools/design/record.ts mateCheck): capture.datasheets is not met over
  // one (src/tools/journey/tools.ts mateConflicts), so its waiver counts there (test-esp32-run2 R42: the waiver was
  // taken and the agent still could not cite the pin plan check it waives)
  return /^mate:/.test(target.id) ? MATE_CRITERION : null
}
const MATE_CRITERION = 'capture.datasheets'

const unescape = (s: string): string => { try { return decodeURIComponent(s) } catch { return s } }

/** A record's urn (`urn:trace:<installation>:<project>:<kind>:<id>`) as "requirement REQ-1"; anything else as given. */
function recordWords(focus: string): string {
  const v = unescape(focus)
  if (v === 'project') return 'the project'
  const m = /^urn:trace:.*:([a-z_-]+):([^:]+)$/.exec(v)
  if (!m) return v
  const kind = (m[1] as string).replace(/[-_]/g, ' ')
  return kind === 'journey' ? 'the project' : `${kind} ${m[2] as string}`
}

const quoted = (text: string): string => `“${text.trim().replace(/\.$/, '')}”`

/**
 * What a waiver on `target` is on, in words: "the criterion “Every connection is routed”", "the finding of “The board
 * fits its enclosure” on requirement REQ-8fc402", "the design rule check's lib footprint mismatch finding on J1".
 * `criterionText` gives a criterion's words (its id when unknown).
 */
export function waiverTargetWords(target: { kind: string; id: string }, criterionText: (id: string) => string | undefined): string {
  const text = (id: string): string => { const t = criterionText(id); return t ? quoted(t) : id }
  if (target.kind === 'criterion') return `the criterion ${text(target.id)}`
  if (target.kind === 'finding') {
    const shape = /^([a-z][a-z.]*\.[a-z]+)@(.*)$/.exec(target.id)
    if (shape) return `the finding of ${text(shape[1] as string)} on ${recordWords(shape[2] as string)}`
    const rule = /^(erc|drc):([^:]+):(.*)$/.exec(target.id)
    if (rule) {
      const where = rule[3] as string
      const at = where === 'board' ? '' : /^-?[\d.]+,-?[\d.]+(#\d+)?$/.test(where) ? ` at ${where.replace(/#\d+$/, '')} mm` : ` on ${where.replace(/#\d+$/, '')}`
      return `the ${RULE_WORDS[rule[1] as 'erc' | 'drc']}'s ${(rule[2] as string).replace(/_/g, ' ')} finding${at}`
    }
    // "mate:J2:SSD1306-0.96-128x64-I2C-4pin:order": the connector, the module, and what differs
    const mate = /^mate:([^:]+):(.+):(order|unknown)$/.exec(target.id)
    if (mate) return `the pin plan check's ${mate[3] === 'order' ? 'pin order' : 'unknown pin order'} finding on ${mate[1] as string} (the ${mate[2] as string} module)`
    return `the finding ${unescape(target.id)}`
  }
  return `${target.kind.replace(/_/g, ' ')} ${target.id}`
}

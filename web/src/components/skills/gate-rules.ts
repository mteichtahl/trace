/**
 * The gate's hard rule (docs/ui-design.md, "Gates and signing"): Sign stays disabled while the stage has work pending,
 * and until every criterion is met or
 * waived, every piece of evidence has been opened and every waiver acknowledged, and only an admin signs. Pure, so the
 * screen and its tests share it.
 */
import type { Criterion, Gate, Waiver } from '@/lib/types'

/**
 * The criterion a waiver counts for: the one it names, or the one its finding is of (a shape's finding
 * `layout.fit@…`, a rule check's `drc:…` or `erc:…`); null for a requirement's or a test's waiver, the stage's only.
 * journey.get says (`criterion`); this reads it from the target when it does not.
 */
export function waiverCriterion(w: Pick<Waiver, 'criterion' | 'target'>): string | null {
  if (w.criterion !== undefined) return w.criterion
  const t = w.target
  if (!t) return null
  if (t.kind === 'criterion') return t.id
  if (t.kind !== 'finding') return null
  const shape = /^([a-z][a-z.]*\.[a-z]+)@/.exec(t.id)
  if (shape) return shape[1]!
  return t.id.startsWith('erc:') ? 'capture.erc' : t.id.startsWith('drc:') ? 'layout.drc' : null
}

/** The waivers in force on criterion `id` alone, not the stage's others (test-esp32 #156). */
export const criterionWaivers = (gate: Pick<Gate, 'waivers'>, id: string): Waiver[] => gate.waivers.filter((w) => !w.closed && waiverCriterion(w) === id)

/** A criterion's status in words: "Met (2 waived)" counts its own waivers only. */
export function criterionStatusLabel(c: Pick<Criterion, 'id' | 'status'>, gate: Pick<Gate, 'waivers'>): string {
  if (c.status === 'waived') return 'Met (waived)'
  if (c.status !== 'met') return 'Not met'
  const n = criterionWaivers(gate, c.id).length
  return n ? `Met (${n} waived)` : 'Met'
}

export interface SignState {
  /** criterion ids whose evidence this person opened (from the record, plus this session) */
  opened: Set<string>
  /** waiver ids ticked this session ("I've read this waiver"): each tick records an open */
  acknowledged: Set<string>
  admin: boolean
  online: boolean
}

export interface Blocker {
  id: 'pending' | 'none' | 'met' | 'opened' | 'acknowledged' | 'admin' | 'online'
  /** what is still missing, in words for the tooltip */
  text: string
  /** the rows it concerns */
  items: string[]
}

export const isOpened = (c: Criterion, s: Pick<SignState, 'opened'>): boolean => !!c.opened || s.opened.has(c.id)

/**
 * Whether this person has read a waiver for the signing at hand: opened by the record's rule (journey.get
 * `opened_by_you`), or ticked this session. An acknowledgement from an earlier signing of a reopened stage does not
 * count: the record asks for the waiver to be opened again, and the box showed it ticked and locked, so the open was
 * never sent and the gate could not be signed (test-esp32-e2e, the Layout gate after the budget change).
 */
export const isWaiverRead = (w: Pick<Waiver, 'id' | 'opened'>, s: { acknowledged: ReadonlySet<string> }): boolean => !!w.opened || s.acknowledged.has(w.id)

/** What still stands between this person and Sign; empty means Sign is enabled. */
export function signBlockers(gate: Pick<Gate, 'criteria' | 'waivers'> & { pending?: string[] }, s: SignState): Blocker[] {
  const out: Blocker[] = []
  // the stage still has work pending (open changes, jobs still working): nothing is reviewed or signed over it
  if (gate.pending?.length) out.push({ id: 'pending', text: gate.pending[0] as string, items: [] })
  // no criteria reported yet is not "nothing to check": a gate is hard, so it cannot be signed blind
  if (!gate.criteria.length) out.push({ id: 'none', text: "The checker has not reported this gate's criteria yet", items: [] })
  // anything not met or waived (including one still being checked) holds the gate
  const notMet = gate.criteria.filter((c) => c.status !== 'met' && c.status !== 'waived')
  if (notMet.length) out.push({ id: 'met', text: `${notMet.length} ${notMet.length > 1 ? 'criteria' : 'criterion'} not met`, items: notMet.map((c) => c.id) })
  const unopened = gate.criteria.filter((c) => !isOpened(c, s))
  if (unopened.length) out.push({ id: 'opened', text: `Open the evidence for ${unopened.length} more criteri${unopened.length > 1 ? 'a' : 'on'}`, items: unopened.map((c) => c.id) })
  const unack = gate.waivers.filter((w) => !isWaiverRead(w, s))
  if (unack.length) out.push({ id: 'acknowledged', text: `Acknowledge ${unack.length} waiver${unack.length > 1 ? 's' : ''}`, items: unack.map((w) => w.id) })
  if (!s.admin) out.push({ id: 'admin', text: 'Only an admin can sign', items: [] })
  if (!s.online) out.push({ id: 'online', text: 'Signing needs the connection; it is refused offline', items: [] })
  return out
}

/**
 * The release and order gates commit money: signing asks for the passkey or second factor again. The journey's ids
 * (src/core/journey.ts): signoff (release approval) and fabricate.order (order approval).
 */
export const MONEY_GATES = ['signoff', 'fabricate.order'] as const
export const needsReauth = (gateId: string): boolean => (MONEY_GATES as readonly string[]).includes(gateId) || gateId === 'release' || gateId === 'order'

/** A return must say what has to change. */
export const returnReasonOk = (reason: string): boolean => reason.trim().length >= 10

/** "the schematic gate" → "Sign the schematic gate" */
export const signLabel = (gateName: string): string => `Sign ${gateName.startsWith('the ') ? gateName : `the ${gateName}`}`

/** Why Sign is locked, in one sentence for a phone (where there is no tooltip): the open criteria by name. */
export function lockedLine(gate: Pick<Gate, 'criteria' | 'waivers'>, blockers: Blocker[]): string {
  const b = blockers[0]
  if (!b) return ''
  if (b.id === 'met') {
    const open = gate.criteria.filter((c) => b.items.includes(c.id)).map((c) => c.text)
    const named = open.length <= 2 ? `: ${open.join('; ')}` : ''
    return `You can sign once ${open.length === 1 ? 'the open check is' : `the ${open.length} open checks are`} met${named}.`
  }
  if (b.id === 'none') return `${b.text}. You can sign once it has, and every check is met.`
  return `${b.text} to sign.`
}

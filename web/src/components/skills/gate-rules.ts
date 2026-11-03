/**
 * The gate's hard rule (docs/ui-design.md, "Gates and signing"): Sign stays disabled until every criterion is met or
 * waived, every piece of evidence has been opened and every waiver acknowledged, and only an admin signs. Pure, so the
 * screen and its tests share it.
 */
import type { Criterion, Gate } from '@/lib/types'

export interface SignState {
  /** criterion ids whose evidence this person opened (from the record, plus this session) */
  opened: Set<string>
  /** waiver ids acknowledged */
  acknowledged: Set<string>
  admin: boolean
  online: boolean
}

export interface Blocker {
  id: 'none' | 'met' | 'opened' | 'acknowledged' | 'admin' | 'online'
  /** what is still missing, in words for the tooltip */
  text: string
  /** the rows it concerns */
  items: string[]
}

export const isOpened = (c: Criterion, s: Pick<SignState, 'opened'>): boolean => !!c.opened || s.opened.has(c.id)

/** What still stands between this person and Sign; empty means Sign is enabled. */
export function signBlockers(gate: Pick<Gate, 'criteria' | 'waivers'>, s: SignState): Blocker[] {
  const out: Blocker[] = []
  // no criteria reported yet is not "nothing to check": a gate is hard, so it cannot be signed blind
  if (!gate.criteria.length) out.push({ id: 'none', text: "The checker has not reported this gate's criteria yet", items: [] })
  // anything not met or waived (including one still being checked) holds the gate
  const notMet = gate.criteria.filter((c) => c.status !== 'met' && c.status !== 'waived')
  if (notMet.length) out.push({ id: 'met', text: `${notMet.length} ${notMet.length > 1 ? 'criteria' : 'criterion'} not met`, items: notMet.map((c) => c.id) })
  const unopened = gate.criteria.filter((c) => !isOpened(c, s))
  if (unopened.length) out.push({ id: 'opened', text: `Open the evidence for ${unopened.length} more criteri${unopened.length > 1 ? 'a' : 'on'}`, items: unopened.map((c) => c.id) })
  const unack = gate.waivers.filter((w) => !w.acknowledged && !s.acknowledged.has(w.id))
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

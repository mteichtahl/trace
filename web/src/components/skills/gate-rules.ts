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
  id: 'met' | 'opened' | 'acknowledged' | 'admin' | 'online'
  /** what is still missing, in words for the tooltip */
  text: string
  /** the rows it concerns */
  items: string[]
}

export const isOpened = (c: Criterion, s: Pick<SignState, 'opened'>): boolean => !!c.opened || s.opened.has(c.id)

/** What still stands between this person and Sign; empty means Sign is enabled. */
export function signBlockers(gate: Pick<Gate, 'criteria' | 'waivers'>, s: SignState): Blocker[] {
  const out: Blocker[] = []
  const notMet = gate.criteria.filter((c) => c.status === 'not_met')
  if (notMet.length) out.push({ id: 'met', text: `${notMet.length} criterion${notMet.length > 1 ? 'a' : ''} not met`, items: notMet.map((c) => c.id) })
  const unopened = gate.criteria.filter((c) => !isOpened(c, s))
  if (unopened.length) out.push({ id: 'opened', text: `Open the evidence for ${unopened.length} more criteri${unopened.length > 1 ? 'a' : 'on'}`, items: unopened.map((c) => c.id) })
  const unack = gate.waivers.filter((w) => !w.acknowledged && !s.acknowledged.has(w.id))
  if (unack.length) out.push({ id: 'acknowledged', text: `Acknowledge ${unack.length} waiver${unack.length > 1 ? 's' : ''}`, items: unack.map((w) => w.id) })
  if (!s.admin) out.push({ id: 'admin', text: 'Only an admin can sign', items: [] })
  if (!s.online) out.push({ id: 'online', text: 'Signing needs the connection; it is refused offline', items: [] })
  return out
}

/** The release and order gates commit money: signing asks for the passkey or second factor again. */
export const needsReauth = (gateId: string): boolean => gateId === 'release' || gateId === 'order'

/** A return must say what has to change. */
export const returnReasonOk = (reason: string): boolean => reason.trim().length >= 10

/** "the schematic gate" → "Sign the schematic gate" */
export const signLabel = (gateName: string): string => `Sign ${gateName.startsWith('the ') ? gateName : `the ${gateName}`}`

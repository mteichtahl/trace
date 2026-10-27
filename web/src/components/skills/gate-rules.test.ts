import { describe, expect, it } from 'vitest'
import type { Gate } from '@/lib/types'
import { needsReauth, returnReasonOk, signBlockers, signLabel } from './gate-rules'

const gate: Pick<Gate, 'criteria' | 'waivers'> = {
  criteria: [
    { id: 'c1', text: 'ERC clean', status: 'met', opened: true },
    { id: 'c2', text: 'Stock', status: 'waived' },
    { id: 'c3', text: 'Pin plan', status: 'met' },
  ],
  waivers: [{ id: 'W-3', title: 'VBAT', reason: 'r', risk: 'degraded', caught: 'bench' }],
}
const base = { opened: new Set<string>(), acknowledged: new Set<string>(), admin: true, online: true }

describe('Sign the gate', () => {
  it('stays disabled until every piece of evidence is opened and every waiver acknowledged', () => {
    expect(signBlockers(gate, base).map((b) => b.id)).toEqual(['opened', 'acknowledged'])
    expect(signBlockers(gate, base)[0]!.text).toBe('Open the evidence for 2 more criteria')
    expect(signBlockers(gate, { ...base, opened: new Set(['c2', 'c3']) }).map((b) => b.id)).toEqual(['acknowledged'])
    expect(signBlockers(gate, { ...base, opened: new Set(['c2', 'c3']), acknowledged: new Set(['W-3']) })).toEqual([])
  })
  it('refuses a criterion that is not met, even with its evidence opened', () => {
    const g = { ...gate, criteria: [...gate.criteria, { id: 'c4', text: 'x', status: 'not_met' as const, opened: true }] }
    expect(signBlockers(g, { ...base, opened: new Set(['c2', 'c3']), acknowledged: new Set(['W-3']) }).map((b) => b.id)).toEqual(['met'])
  })
  it('only an admin signs, and never offline', () => {
    const ready = { ...base, opened: new Set(['c2', 'c3']), acknowledged: new Set(['W-3']) }
    expect(signBlockers(gate, { ...ready, admin: false }).map((b) => b.id)).toEqual(['admin'])
    expect(signBlockers(gate, { ...ready, online: false }).map((b) => b.id)).toEqual(['online'])
  })
  it('asks for the passkey again only at the gates that commit money', () => {
    expect(needsReauth('release')).toBe(true)
    expect(needsReauth('order')).toBe(true)
    expect(needsReauth('schematic')).toBe(false)
  })
  it('a return must say what has to change', () => {
    expect(returnReasonOk('no')).toBe(false)
    expect(returnReasonOk('C2 must be rated for 10 V')).toBe(true)
  })
  it('names the act', () => expect(signLabel('the schematic gate')).toBe('Sign the schematic gate'))
})

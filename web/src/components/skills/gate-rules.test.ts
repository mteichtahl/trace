import { describe, expect, it } from 'vitest'
import type { Gate } from '@/lib/types'
import { ApiError } from '@/lib/api'
import { lockedLine, needsReauth, returnReasonOk, signBlockers, signLabel, signRefusal } from './gate-rules'

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
  it('cannot be signed blind: no criteria reported yet keeps Sign locked, and says so', () => {
    const empty = { criteria: [], waivers: [] }
    const b = signBlockers(empty, base)
    expect(b.map((x) => x.id)).toEqual(['none'])
    expect(lockedLine(empty, b)).toMatch(/has not reported/)
  })
  it('names the open checks on a phone, where there is no tooltip', () => {
    const g = { criteria: [...gate.criteria, { id: 'c4', text: 'Power budget within 2 W', status: 'not_met' as const, opened: true }], waivers: [] }
    expect(lockedLine(g, signBlockers(g, base))).toBe('You can sign once the open check is met: Power budget within 2 W.')
  })

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
    expect(needsReauth('signoff')).toBe(true)
    expect(needsReauth('fabricate.order')).toBe(true)
    expect(needsReauth('schematic')).toBe(false)
  })
  it('a return must say what has to change', () => {
    expect(returnReasonOk('no')).toBe(false)
    expect(returnReasonOk('C2 must be rated for 10 V')).toBe(true)
  })
  it('names the act', () => expect(signLabel('the schematic gate')).toBe('Sign the schematic gate'))

  it('holds Sign while the stage has work pending, whatever else is done', () => {
    const g = { criteria: [], waivers: [], pending: ['Accept or discard 1 open change first ("Swap the regulator")'] }
    expect(signBlockers(g, { ...base, admin: true }).map((b) => b.id)[0]).toBe('pending')
    expect(signBlockers({ ...g, pending: [] }, base).map((b) => b.id)).not.toContain('pending')
  })
})

describe('signRefusal (test-esp32 #179)', () => {
  it('is the record\'s reason in words, without its own lead', () => {
    expect(signRefusal(new ApiError('The gate cannot be signed yet. Open the evidence for 2 more criteria.', 200))).toBe('Open the evidence for 2 more criteria.')
    expect(signRefusal(new ApiError('The gate was not signed: requirement REQ-3 changed after the baseline. Agree it.', 200))).toBe('Requirement REQ-3 changed after the baseline. Agree it.')
  })
  it('is null for a failure that is not a refusal: it stays technical detail', () => {
    expect(signRefusal(new ApiError('Internal Server Error', 500))).toBeNull()
    expect(signRefusal(new TypeError('Failed to fetch'))).toBeNull()
  })
})

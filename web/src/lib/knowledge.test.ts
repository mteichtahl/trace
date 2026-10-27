import { describe, expect, it } from 'vitest'
import { argsFromForm, canTry, familyOf, groupTools, schemaFields } from './tools-catalogue'
import { agentName, byDay, expiresInDays, markPieces, maySwitch, priceAt, queryTerms, rankResults, readMemory } from './knowledge'
import { canSwitchOff } from '@/components/memory/switch'
import { memoryRows } from '@/routes/_app/p/$id/memory/index'

describe('knowledge rules', () => {
  it('cuts results at the relevance threshold; weaker ones wait', () => {
    const r = rankResults([{ score: 0.2 }, { score: 0.9 }, { score: null }, { score: 0.5 }])
    expect(r.strong.map((x) => x.score)).toEqual([0.9, 0.5, null])
    expect(r.weak.map((x) => x.score)).toEqual([0.2])
  })

  it('marks the query words in a passage', () => {
    const terms = queryTerms('LDO output capacitor stability')
    expect(terms).toContain('capacitor')
    const marked = markPieces('requires an output capacitor of at least 2.2 µF', terms).filter((p) => p.mark).map((p) => p.text)
    expect(marked).toEqual(['output', 'capacitor'])
  })

  it('reads a memory record as the API gives it, switched off with its reason', () => {
    const m = readMemory({ id: 'r1', strategy: 'facts', actor: 'ams', text: 'x', created_at: '2026-10-01T00:00:00Z', active: false, inactive: { reason: 'old', by_you: true, at: '2026-10-02T00:00:00Z' } }, 'o/r')!
    expect(m).toMatchObject({ kind: 'facts', active: false, inactive: { reason: 'old', byYou: true } })
    expect(agentName(m.actor)).toBe('Analog and mixed-signal')
  })

  it('lets contributors, admins and owners of a preference switch; reviewers cannot', () => {
    expect(maySwitch({ actor: 'ams' }, { admin: false, part: 'reviewer' })).toBe(false)
    expect(maySwitch({ actor: 'ams' }, { admin: false, part: 'contributor' })).toBe(true)
    expect(maySwitch({ actor: 'person/abc' }, { admin: false, part: 'reviewer' })).toBe(true)
    expect(maySwitch({ actor: 'ams' }, { admin: true })).toBe(true)
  })

  it('needs a reason before switching off', () => {
    expect(canSwitchOff('')).toBe(false)
    expect(canSwitchOff('  ')).toBe(false)
    expect(canSwitchOff('superseded by the new regulator')).toBe(true)
  })

  it('shows Active by default and switched-off memories only when asked', () => {
    const recs = [readMemory({ id: 'a', text: 'on', active: true }, 'o/r')!, readMemory({ id: 'b', text: 'off', active: false, inactive: { reason: 'x' } }, 'o/r')!]
    expect(memoryRows(recs, { includeOff: false, ranked: false }).map((r) => r.id)).toEqual(['a'])
    expect(memoryRows(recs, { includeOff: true, ranked: false })).toHaveLength(2)
  })

  it('groups sessions by day and counts days to expiry', () => {
    const now = new Date('2026-10-27T12:00:00').getTime()
    const g = byDay([{ at: '2026-10-27T09:00:00' }, { at: '2026-10-26T09:00:00' }, { at: '2026-10-27T11:00:00' }], (x) => x.at, now)
    expect(g.map((x) => [x.label, x.items.length])).toEqual([['Today', 2], ['Yesterday', 1]])
    expect(expiresInDays('2026-10-27T11:00:00', 30, now)).toBe(30)
    expect(expiresInDays('2026-09-01T00:00:00', 30, now)).toBe(0)
  })

  it('prices a part at the build quantity', () => {
    expect(priceAt([{ qty: 1, price: 0.21 }, { qty: 10, price: 0.17 }, { qty: 100, price: 0.12 }], 25)).toBe(0.17)
  })
})

describe('tools catalogue', () => {
  it('groups tools by family in the design order', () => {
    expect(familyOf('parts.bom_check').label).toBe('Datasheets and parts')
    expect(groupTools([{ name: 'pcb.autoroute' }, { name: 'kicad.erc' }, { name: 'zzz.x' }]).map((g) => g.family.id)).toEqual(['kicad', 'layout', 'other'])
  })

  it('offers Try it for read-only tools, never to reviewers', () => {
    expect(canTry({ needs: 'read' }, { reviewer: false })).toBe(true)
    expect(canTry({ needs: 'write' }, { reviewer: false })).toBe(false)
    expect(canTry({ needs: 'read' }, { reviewer: true })).toBe(false)
  })

  it('builds a form from a JSON schema and checks the values', () => {
    const f = schemaFields({ type: 'object', properties: { q: { type: 'string' }, n: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, s: { type: 'string', enum: ['A', 'B'] }, on: { type: 'boolean' }, rows: { type: 'array', items: { type: 'object' } } }, required: ['q', 'n'] })
    expect(f.map((x) => [x.name, x.type, x.required])).toEqual([['q', 'string', true], ['n', 'integer', false], ['s', 'enum', false], ['on', 'boolean', false], ['rows', 'json', false]])
    expect(argsFromForm(f, { q: '', n: '0' }).errors).toEqual({ q: 'Needed', n: 'At least 1' })
    expect(argsFromForm(f, { q: 'ldo', n: '5', on: true, rows: '[1]' }).args).toEqual({ q: 'ldo', n: 5, on: true, rows: [1] })
  })
})

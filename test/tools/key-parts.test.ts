/**
 * Architecture choice's key parts (src/tools/design/key-parts.ts) and the reason asked for an option another one
 * outscores (record.ts outscoredBy): test-esp32 #38 and #96.
 */
import { describe, expect, it } from 'vitest'
import type { WaiverRow } from '../../src/core/journey.js'
import { nodeIri } from '../../src/ontology/graph.js'
import { findingId } from '../../src/tools/shape/tools.js'
import { type StockLine, keyPartsView } from '../../src/tools/design/key-parts.js'
import { type OptionView, outscoredBy, outscoredWords } from '../../src/tools/design/record.js'

const option = (id: string, blocks: OptionView['blocks']): OptionView => ({ id, name: id, summary: '', recommended: false, why: null, gives_up: null, risks: [], total: 0, blocks, connections: [] })
const block = (id: string, parts: OptionView['blocks'][number]['parts']): OptionView['blocks'][number] => ({ id, name: id.toUpperCase(), role: null, parts, serves: [], x: 0, y: 0 })
const line = (mpn: string, started: number, x: Partial<StockLine> = {}): StockLine => ({
  run: `run-${started}`, started, boards: 10, mpn, part_key: null, order_code: null, need: 10, status: 'ok', flags: [], stock: 500, unit_price: 0.5, currency: 'USD', note: null, ...x,
})
const waiver = (targetKind: WaiverRow['targetKind'], target: string, reason: string, closedAt: number | null = null): WaiverRow => ({
  id: `w-${target}`, stage: 'architect', gate: 'architect', targetKind, target, reason, risk: 'r', severity: 'degraded', caughtWhere: null, scope: 'this revision', by: 'Priya', at: 1, acknowledgedBy: null, acknowledgedAt: null, closedAt,
})

describe('keyPartsView', () => {
  const o = option('B', [
    block('pwr', [{ mpn: 'TLV75533PDBVR', key: true }, { mpn: 'C1-100nF' }]),
    block('mcu', [{ mpn: 'GRM155', role: 'decoupling' }, { mpn: 'STM32WLE5JCI6', key: true, role: 'microcontroller' }]),
    block('oled', [{ mpn: 'SSD1306-MODULE', key: true, off_board: true }]),
  ])

  it('lists each key part with the newest check of it: code, stock, need and price; a short part is a problem', () => {
    const v = keyPartsView(o, [
      line('TLV75533PDBVR', 1, { stock: 2, status: 'short' }), line('TLV75533PDBVR', 5, { order_code: 'C2848334', stock: 48210, unit_price: 0.118 }),
      line('STM32WLE5JCI6', 5, { order_code: 'C2652063', status: 'short', stock: 6 }),
    ], 10, [])
    expect(v.option).toBe('B')
    expect(v.parts.map((p) => [p.block, p.mpn, p.standing])).toEqual([['pwr', 'TLV75533PDBVR', 'ok'], ['mcu', 'STM32WLE5JCI6', 'problem'], ['oled', 'SSD1306-MODULE', 'unchecked']])
    expect(v.parts[0]?.check).toMatchObject({ order_code: 'C2848334', stock: 48210, unit_price: 0.118, currency: 'USD', need: 10, boards: 10 })
    expect(v.parts[1]).toMatchObject({ role: 'microcontroller', why: 'Short: 10 needed, 6 in stock.', exception: null })
    expect(v.parts[2]).toMatchObject({ off_board: true, check: null, why: expect.stringMatching(/Not checked for stock yet/) })
  })

  it('a check for fewer boards than the build is not enough', () => {
    const v = keyPartsView(o, [line('TLV75533PDBVR', 5, { boards: 1 })], 10, [])
    expect(v.parts[0]).toMatchObject({ standing: 'problem', why: 'Checked for 1 boards, fewer than the 10 the project builds: check it again.' })
  })

  it('a part\'s exception is the open waiver of its own stock finding (as shape.check names it), or of the criterion', () => {
    const o2 = { installation: 'trace', project: 'acme/design' }
    // the shape's focus is the block's second part: STM32WLE5JCI6 at index 1 of block mcu
    const own = findingId('architect.stock', { focus: `${nodeIri(o2, 'block', 'B/mcu')}/usesPart/1` })
    const lines = [line('STM32WLE5JCI6', 5, { status: 'out', stock: 0 }), line('SSD1306-MODULE', 5, { status: 'not-found', stock: null })]
    let v = keyPartsView(o, lines, 10, [waiver('finding', own, 'Four from last build\'s spares.')])
    expect(v.parts[1]?.exception).toEqual({ reason: 'Four from last build\'s spares.', by: 'Priya', scope: 'part' })
    expect(v.parts[2]?.exception).toBeNull()
    // a closed waiver is no exception; one of the whole criterion excepts every part that does not stand
    v = keyPartsView(o, [...lines, line('TLV75533PDBVR', 5)], 10, [waiver('finding', own, 'old', 9), waiver('criterion', 'architect.stock', 'Ordered from the distributor directly.')])
    expect(v.parts.map((p) => p.exception?.scope ?? null)).toEqual([null, 'criterion', 'criterion'])
  })
})

describe('outscoredBy', () => {
  const a = {
    options: [option('A', []), option('B', []), option('C', [])],
    criteria: [{ id: 'cost', name: 'Cost', weight: 2, description: null }, { id: 'risk', name: 'Risk', weight: 1.5, description: null }],
    scores: [
      { option: 'A', criterion: 'cost', score: 4, reason: '', by: 'trace' as const }, { option: 'A', criterion: 'risk', score: 4, reason: '', by: 'trace' as const },
      { option: 'C', criterion: 'cost', score: 5, reason: '', by: 'trace' as const }, { option: 'C', criterion: 'risk', score: 3, reason: '', by: 'trace' as const },
    ],
  }
  it('names the top option scoring higher, with both totals; none for the top score or an unscored record', () => {
    const h = outscoredBy(a, 'A')
    expect(h && [h.option.id, h.total, h.mine]).toEqual(['C', 14.5, 14])
    expect(h && outscoredWords(h)).toBe('Option C scores higher (14.5 against 14)')
    expect(outscoredBy(a, 'C')).toBeNull()
    expect(outscoredBy(a, 'B')?.option.id).toBe('C')
    expect(outscoredBy({ ...a, criteria: [] }, 'A')).toBeNull()
  })
  it('the person\'s own scores count', () => {
    expect(outscoredBy(a, 'A', [{ option: 'A', criterion: 'risk', score: 5 }])).toBeNull()
  })
})

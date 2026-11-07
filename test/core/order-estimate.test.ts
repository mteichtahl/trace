import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { costLimitOf, orderEstimate, orderEstimateFrom } from '../../src/core/order-estimate.js'

const parts = (o: Partial<Parameters<typeof orderEstimate>[0]['parts']> = {}) => ({
  run: 'p1', at: 1_793_850_000, boards: 10, total: 47.12, currency: 'USD',
  lines: Array.from({ length: 14 }, (_, i) => ({ lcsc: `C${i}`, perBoard: i < 7 ? 2 : 1, extended: i < 5 })),
  ...o,
})

describe('cost limits from the requirements', () => {
  it('reads a total and a per-board limit', () => {
    expect(costLimitOf({ id: 'REQ-4ce9e8', text: 'The whole project shall cost at most 100 USD.', tags: ['cost'] })).toMatchObject({ kind: 'total', amount: 100, currency: 'USD' })
    expect(costLimitOf({ id: 'REQ-f3f79d', text: 'Each board shall cost at most 8 USD.' })).toMatchObject({ kind: 'per_board', amount: 8 })
    expect(costLimitOf({ id: 'REQ-x', text: 'A unit cost under US$12.50.' })).toMatchObject({ kind: 'per_board', amount: 12.5 })
    expect(costLimitOf({ id: 'REQ-y', text: 'The board shall be 50 x 35 mm.' })).toBeNull()
  })
})

describe('the order estimate', () => {
  // test-esp32 run 2 (#162): US$100 and US$8 a board, with an MJF case of 21.9 cm3. The first estimate came at
  // Sign-off; made from Architect's parts check it says over then
  it('is over a US$100 total and at risk on a tight per-board limit with test-esp32\'s parts, board and case', () => {
    const e = orderEstimate({
      quantity: 10, parts: parts(),
      board: { run: 'b1', widthMm: 50, heightMm: 35, layers: 2 },
      case: { run: 'm1', volumeMm3: 21_875, process: 'MJF' },
      limits: [
        { requirement: 'REQ-4ce9e8', kind: 'total', amount: 100, currency: 'USD', source: '' },
        { requirement: 'REQ-f3f79d', kind: 'per_board', amount: 7.5, currency: 'USD', source: '' },
      ],
    })
    expect(e.low).toBeGreaterThan(100)
    // about US$7.4 to 7.9 a board: a US$7.50 limit is at risk, neither under nor over
    expect(e.perBoard.low).toBeGreaterThan(7)
    expect(e.perBoard.low).toBeLessThan(7.5)
    expect(e.perBoard.high).toBeGreaterThan(7.5)
    expect(e.limits.find((l) => l.requirement === 'REQ-4ce9e8')?.verdict).toBe('over')
    expect(e.limits.find((l) => l.requirement === 'REQ-f3f79d')?.verdict).toBe('at_risk')
    expect(e.verdict).toBe('over')
    expect(e.text).toMatch(/not a quote/)
    // five extended parts at US$3 each, setup and stencil
    expect(e.lines.find((l) => l.key === 'assembly')!.low).toBeGreaterThanOrEqual(5 * 3 + 9.5)
  })

  it('says what it leaves out, and counts lines not known as basic or extended both ways', () => {
    const e = orderEstimate({ quantity: 10, parts: parts({ lines: [{ lcsc: 'C1', perBoard: 1, extended: null }] }), board: null, case: null, limits: [] })
    const a = e.lines.find((l) => l.key === 'assembly')!
    expect(a.high - a.low).toBeGreaterThanOrEqual(3)
    expect(e.notIn.join(' ')).toMatch(/No case yet/)
    expect(e.lines.find((l) => l.key === 'boards')!.what).toMatch(/no board yet/)
    expect(e.verdict).toBeNull()
  })

  it('scales a check made for another quantity', () => {
    const e = orderEstimate({ quantity: 20, parts: parts({ boards: 10, total: 40 }), board: null, case: null, limits: [] })
    expect(e.lines[0]).toMatchObject({ low: 80 })
    expect(e.lines[0]!.source).toMatch(/scaled to 20/)
  })
})

describe('from the record', () => {
  it('reads the newest parts check, board, case and the cost requirements', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE runs (id TEXT, kind TEXT, status TEXT, started REAL, result TEXT);
      CREATE TABLE parts_list_lines (run_id TEXT, line INTEGER, order_code TEXT, per_board REAL, flags TEXT, line_total REAL);
      CREATE TABLE requirements (id TEXT, text TEXT, tags TEXT, status TEXT);
      CREATE TABLE journey (id TEXT, build TEXT);`)
    db.prepare('INSERT INTO runs VALUES (?,?,?,?,?)').run('p1', 'parts.bom_check', 'pass', 1, JSON.stringify({ boards: 10, total: 47, currency: 'USD' }))
    db.prepare('INSERT INTO runs VALUES (?,?,?,?,?)').run('b1', 'kicad.board', 'pass', 2, JSON.stringify({ outline: { width_mm: 50, height_mm: 35 }, copper_layers: 2 }))
    db.prepare('INSERT INTO runs VALUES (?,?,?,?,?)').run('m1', 'mech.build', 'pass', 3, JSON.stringify({ process: { process: 'MJF' }, case: { parts: [{ name: 'base', volume_mm3: 7300 }, { name: 'lid', volume_mm3: 14600 }, { name: 'oled-module', volume_mm3: 2900 }] } }))
    db.prepare('INSERT INTO parts_list_lines VALUES (?,?,?,?,?,?)').run('p1', 1, 'C1', 1, JSON.stringify(['jlc-extended']), 47)
    db.prepare('INSERT INTO requirements VALUES (?,?,?,?)').run('REQ-1', 'The whole project shall cost at most 100 USD.', '["cost"]', 'accepted')
    db.prepare('INSERT INTO requirements VALUES (?,?,?,?)').run('REQ-2', 'Each board shall cost at most 99 USD.', '["cost"]', 'rejected')
    db.prepare('INSERT INTO journey VALUES (?,?)').run('current', JSON.stringify({ quantity: 10, unit_cost: 9, budget: 275 }))
    const e = orderEstimateFrom(db)!
    expect(e.partsRun).toBe('p1')
    // the OLED is modelled to check the fit, not printed
    expect(e.lines.find((l) => l.key === 'case')!.what).toMatch(/21\.9 cm3 each, MJF/)
    expect(e.lines.find((l) => l.key === 'assembly')!.what).toMatch(/1 extended part,/)
    // REQ-1 is the total; the rejected REQ-2 is not, so the build plan's target stands for the per-board limit
    expect(e.limits.map((l) => [l.requirement, l.kind, l.amount])).toEqual([['REQ-1', 'total', 100], [null, 'per_board', 9]])
  })

  it('is null without a parts check', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE runs (id TEXT, kind TEXT, status TEXT, started REAL, result TEXT)')
    expect(orderEstimateFrom(db)).toBeNull()
  })
})

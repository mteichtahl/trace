/**
 * The order being prepared on the Build page (src/api/actions-build.ts orderSheet) and the board options kicad.fab
 * records for it (src/tools/kicad/order-options.ts): test-esp32 run 2, #217 and #226. The sheet says "ready to place"
 * only when the package is built at Fabricate and every line is in stock at a check made today; its options, parts and
 * picture come from the record; its cost is the target, said as such, until a quote is recorded.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { orderSheet } from '../../src/api/actions-build.js'
import { Work } from '../../src/core/store.js'
import { boardOrderOptions, orderOptionsOf } from '../../src/tools/kicad/order-options.js'
import { parseBoard } from '../../src/tools/kicad/pcb.js'
import { DEMO_PCB } from '../tools/kicad/helpers.js'

const NOW = 1_793_970_000
const FAB_STARTED = NOW - 3 * 3600
const at = { quantity: 10, unitCost: 9, currency: 'USD', revision: 'A', fabricateStarted: FAB_STARTED, now: NOW }

function record(): Work {
  const dir = mkdtempSync(join(tmpdir(), 'trace-order-sheet-'))
  mkdirSync(join(dir, '.git'))
  return new Work(join(dir, 'project.db'))
}
const when = (w: Work, id: string, t: number): void => { w.db.prepare('UPDATE runs SET started=? WHERE id=?').run(t, id) }

const OPTIONS = [
  { group: 'pcb', option: 'Layers', value: '2', source: 'the board file', decided: true },
  { group: 'pcb', option: 'Solder mask colour', value: 'Green', source: 'JLCPCB\'s default: not decided in the record', decided: false },
  { group: 'pcba', option: 'Assembly side', value: 'Top side (21 placed parts)', source: 'the placements', decided: true },
]

function fab(w: Work, t: number, o: { options?: boolean; status?: 'pass' | 'fail' } = {}): string {
  const id = w.start('kicad.fab', { subject: 'hardware/desk-gadget' })
  w.finish(id, o.status ?? 'pass', '19 fab files', { files: [{ path: 'desk-gadget-gerbers.zip', bytes: 1 }, { path: 'desk-gadget-jlc-bom.csv', bytes: 1 }], ...(o.options === false ? {} : { order_options: OPTIONS }) })
  when(w, id, t)
  return id
}

function partsCheck(w: Work, t: number, boards: number, lines: { refs: string; code: string; stock: number; need: number; price: number; status?: string }[]): string {
  const id = w.start('parts.bom_check', { subject: 'hardware/desk-gadget' })
  w.measure(id, 'boards', boards)
  const add = w.db.prepare('INSERT INTO parts_list_lines (run_id, line, mpn, part_key, order_code, refs, per_board, need, status, flags, stock, unit_price, line_total, currency, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  lines.forEach((l, i) => add.run(id, i + 1, `MPN-${l.code}`, `MPN-${l.code}`, l.code, l.refs, l.need / boards, l.need, l.status ?? 'ok', '[]', l.stock, l.price, l.price * l.need, 'USD', ''))
  w.finish(id, 'pass', `${lines.length} lines`, { boards })
  when(w, id, t)
  return id
}

function renders(w: Work, t: number): string {
  const id = w.start('render.showcase', { subject: 'hardware/desk-gadget.kicad_pcb' })
  const shots = { 'g_rev-A_2026-11-06_exploded.png': 'exploded', 'g_rev-A_2026-11-06_board-top.png': 'board-top' }
  for (const name of Object.keys(shots)) w.artifact(id, name, new Uint8Array([137, 80, 78, 71]), 'image/png')
  w.finish(id, 'pass', 'rendered', { revision: 'A', date: '2026-11-06', palette: { source: 'neutral', base: '#1d3557', accent: '#e63946', neutral: '#a8b0ba', background: ['#4075bf', '#14253d'] }, shots })
  when(w, id, t)
  return id
}

describe('the order being prepared (#217, #226)', () => {
  it('is not ready to place with no package and no parts check, and says what is missing; never "all 0 lines in stock"', () => {
    const w = record()
    const s = orderSheet(w.db, at)
    expect(s.ready).toBe(false)
    expect(s.missing).toEqual([
      'The release package is not built yet: kicad.fab builds the Gerbers, BOM and placement file.',
      'There is no parts check yet: parts.bom_check checks stock and price at 10 boards.',
    ])
    expect(s).toMatchObject({ files: [], options: [], parts: [], render: null, basis: 'target', target: 90 })
    expect(s.checkedAt).toBeUndefined()
  })

  it('reads the package\'s options, today\'s parts check against sign-off\'s prices, and the accepted renders: ready to place', () => {
    const w = record()
    partsCheck(w, FAB_STARTED - 86400, 10, [{ refs: 'U1', code: 'C701341', stock: 50_000, need: 10, price: 3.2 }, { refs: 'C1 C2', code: 'C15850', stock: 1e6, need: 20, price: 0.03 }])
    // a check at another quantity does not count
    partsCheck(w, NOW - 600, 5, [{ refs: 'U1', code: 'C701341', stock: 50_000, need: 5, price: 3.3 }])
    const today = partsCheck(w, NOW - 1200, 10, [{ refs: 'U1', code: 'C701341', stock: 58_366, need: 10, price: 3.28 }, { refs: 'C1 C2', code: 'C15850', stock: 14_146_231, need: 20, price: 0.03 }])
    const f = fab(w, FAB_STARTED + 600)
    const r = renders(w, FAB_STARTED + 300)
    const s = orderSheet(w.db, at)
    expect(s.missing).toEqual([])
    expect(s.ready).toBe(true)
    expect(s.files).toEqual(['desk-gadget-gerbers.zip', 'desk-gadget-jlc-bom.csv'])
    // the quantities are the build plan's, placed after each group's options
    expect(s.options.map((o) => [o.option, o.value, o.decided])).toEqual([
      ['Layers', '2', true], ['Solder mask colour', 'Green', false], ['PCB quantity', '10', true], ['Assembly side', 'Top side (21 placed parts)', true], ['Assembly quantity', '10', true],
    ])
    expect(s.parts).toEqual([
      { ref: 'U1', name: 'MPN-C701341', lcsc: 'C701341', stock: 58_366, need: 10, status: 'ok', then: 3.2, now: 3.28 },
      { ref: 'C1 C2', name: 'MPN-C15850', lcsc: 'C15850', stock: 14_146_231, need: 20, status: 'ok', then: 0.03, now: 0.03 },
    ])
    expect(s).toMatchObject({ checkRun: today, partsTotal: 33.4, render: { run: r, name: 'g_rev-A_2026-11-06_board-top.png', label: 'Top', revision: 'A' } })
    expect(f).toBeTruthy()
  })

  it('is not ready with a package from before Fabricate, a failed one, or one without options; a stale or short check says so', () => {
    const w = record()
    fab(w, FAB_STARTED - 600)
    partsCheck(w, NOW - 2 * 86400, 10, [{ refs: 'U1', code: 'C1', stock: 5, need: 10, price: 1 }, { refs: 'U2', code: 'C2', stock: 0, need: 10, price: 1, status: 'out' }])
    let s = orderSheet(w.db, at)
    expect(s.ready).toBe(false)
    expect(s.files).toEqual([])
    expect(s.options).toEqual([])
    expect(s.missing[0]).toMatch(/was built before Fabricate began/)
    expect(s.missing.slice(1)).toEqual([
      '2 of 2 lines are short or not found at 10 boards: U1, U2.',
      `The parts were last checked on ${new Date((NOW - 2 * 86400) * 1000).toISOString().slice(0, 10)}: stock and prices are checked again on the day of the order.`,
    ])
    const old = fab(w, FAB_STARTED + 60, { options: false })
    s = orderSheet(w.db, at)
    expect(s.options).toEqual([])
    expect(s.optionsNote).toBe(`The release package run ${old} recorded no board options (it was made before kicad.fab recorded them): build the package again to have them here.`)
    fab(w, FAB_STARTED + 120, { status: 'fail' })
    expect(orderSheet(w.db, at).missing[0]).toMatch(/did not pass/)
  })
})

describe('the board options kicad.fab records', () => {
  it('reads layers, size, thickness, copper, the smallest track and hole from the board, and marks JLCPCB\'s defaults', () => {
    const b = parseBoard(DEMO_PCB)
    const o = boardOrderOptions(b, [{ ref: 'U1', value: 'x', package: 'p', x_mm: 0, y_mm: 0, rotation_deg: 0, side: 'top' }, { ref: 'R1', value: 'x', package: 'p', x_mm: 0, y_mm: 0, rotation_deg: 0, side: 'top' }], { lines: 2, parts: 2 })
    const by = Object.fromEntries(o.map((x) => [x.option, x]))
    expect(by.Layers).toMatchObject({ group: 'pcb', value: String(b.layers.length), decided: true })
    expect(by.Dimensions?.value).toBe('50 x 30 mm')
    expect(by['PCB thickness']).toMatchObject({ value: '1.6 mm', decided: true })
    for (const k of ['Base material', 'Solder mask colour', 'Silkscreen colour', 'Surface finish']) expect(by[k]?.decided).toBe(false)
    expect(by['Assembly side']).toMatchObject({ group: 'pcba', value: 'Top side (2 placed parts)' })
    expect(by.BOM?.value).toBe('2 lines, 2 parts')
    // as the run's result stores them, read back by the order sheet
    expect(orderOptionsOf({ order_options: JSON.parse(JSON.stringify(o)) })).toEqual(o)
    expect(orderOptionsOf({})).toBeNull()
  })
})

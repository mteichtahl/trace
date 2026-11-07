/**
 * JLCPCB quotes (src/core/quotes.ts): kept in the journey record as the person read them off JLCPCB, every one kept,
 * each with what changed from the one before and why; an agent records one only from a person's words.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { applyAgentFactsSchema } from '../../src/core/agent-facts.js'
import { loadJourney, recordOrder, startJourney } from '../../src/core/journey.js'
import {
  type QuoteDefaults, type QuoteRow, allQuotes, confirmAgentQuote, correctQuote, latestQuote, linkOrderQuote, loadAgentQuotes, loadQuotes, quoteChanges, quoteDefaults,
  quoteViews, recordAgentQuote, recordQuote, withdrawQuote,
} from '../../src/core/quotes.js'
import { open, openProject } from '../../src/core/store.js'

const dir = mkdtempSync(join(tmpdir(), 'trace-quotes-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const by = { hash: 'h', label: 'ann@example.com' }

const D: QuoteDefaults = { revision: 'A', fab: 'JLCPCB', currency: 'USD', quantity: 10, options: [{ option: 'Layers', value: '2' }, { option: 'Surface finish', value: 'HASL' }], optionsFrom: 'fab-1', partsRun: 'bom-1', partsTotal: 40 }
const row = (o: Partial<QuoteRow>): QuoteRow => ({
  id: 'q', revision: 'A', fab: 'JLCPCB', on: '2026-11-01', total: 100, currency: 'USD', quantity: 10, lines: [], options: D.options, optionsFrom: 'fab-1',
  partsRun: 'bom-1', partsTotal: 40, link: null, why: null, orderId: null, by: 'ann', at: 1, source: 'person', said: null, ...o,
})

function project() {
  const p = mkdtempSync(join(dir, 'p-'))
  mkdirSync(join(p, '.git'))
  const db = openProject(p)
  startJourney(db, { template: 'board', by: 'seed', name: 'Q', build: { quantity: 10, unit_cost: 9, currency: 'USD' } })
  return db
}

describe('recording a quote', () => {
  it('keeps every quote with its options, parts check and why, logged in the decisions; the order placed against it is linked', () => {
    const db = project()
    const t = Date.now() / 1000
    db.prepare('INSERT INTO runs (id, kind, subject, started, status, summary, result) VALUES (?,?,?,?,?,?,?)').run('fab-1', 'kicad.fab', 'hw', t - 20, 'pass', 'fab', JSON.stringify({ order_options: [{ group: 'pcb', option: 'Layers', value: '2' }, { group: 'pcb', option: 'Surface finish', value: 'HASL', decided: false }] }))
    db.prepare('INSERT INTO runs (id, kind, subject, started, status, summary, result) VALUES (?,?,?,?,?,?,?)').run('bom-1', 'parts.bom_check', 'rows', t - 10, 'pass', 'bom', '{}')
    db.prepare("INSERT INTO parts_list_lines (run_id, line, refs, per_board, need, status, flags, unit_price, line_total) VALUES ('bom-1', 1, 'U1', 1, 10, 'ok', '[]', 3.38, 33.8), ('bom-1', 2, 'C1', 1, 10, 'ok', '[]', 0.1, 1)").run()
    const d = quoteDefaults(db)!
    expect(d).toMatchObject({ revision: 'A', currency: 'USD', quantity: 10, optionsFrom: 'fab-1', partsRun: 'bom-1', partsTotal: 34.8, options: [{ option: 'Layers', value: '2' }, { option: 'Surface finish', value: 'HASL' }] })

    const a = recordQuote(db, { on: '2026-11-01', total: 120, lines: [{ kind: 'pcb', amount: 20 }, { kind: 'components', amount: 60 }, { kind: 'shipping', amount: 40 }], link: 'Q-123', why: 'First quote.' }, d, by)
    expect(a).toMatchObject({ total: 120, currency: 'USD', quantity: 10, optionsFrom: 'fab-1', partsRun: 'bom-1', link: 'Q-123', why: 'First quote.', by: 'ann@example.com', source: 'person' })
    const b = recordQuote(db, { on: '2026-11-03', total: 110.5, why: 'Cheaper shipping.' }, d, by)
    expect(loadQuotes(db).map((q) => q.id)).toEqual([a.id, b.id])
    const log = loadJourney(db)!.decisions.filter((x) => x.kind === 'quote.recorded')
    expect(log.map((x) => x.summary).reverse()).toEqual([
      'JLCPCB quote recorded: US$120.00 for 10 boards of A, quoted 2026-11-01.',
      'JLCPCB quote recorded: US$110.50 for 10 boards of A, quoted 2026-11-03 (−US$9.50 on the quote before).',
    ])

    // the order goes to the newest quote of its revision with no order yet, and says what was paid against it
    const { order } = recordOrder(db, { number: 'Y1-0001', paid: 113, ship_date: null }, by)
    expect(linkOrderQuote(db, order)?.id).toBe(b.id)
    const v = quoteViews(loadQuotes(db), [order])
    expect(v[0]).toMatchObject({ id: b.id, order: { number: 'Y1-0001', paid: 113, difference: 2.5 }, change: { amount: -9.5, pct: -7.9 } })
    expect(v[1]).toMatchObject({ id: a.id, order: null, change: null })
    expect(() => linkOrderQuote(db, { id: 'other', revision: 'A' }, b.id)).toThrow(/already linked/)
    db.close()
  })

  it('refuses a quote it cannot stand behind', () => {
    const db = project()
    expect(() => recordQuote(db, { total: 50, on: '2999-01-01' }, D, by)).toThrow(/in the future/)
    expect(() => recordQuote(db, { total: 50, lines: [{ kind: 'pcb', amount: 30 }, { kind: 'shipping', amount: 30 }] }, D, by)).toThrow(/add up to US\$60.00, more than the total US\$50.00/)
    expect(() => recordQuote(db, { total: 50, lines: [{ kind: 'pcb', amount: 10 }, { kind: 'pcb', amount: 10 }] }, D, by)).toThrow(/PCB is given twice/)
    expect(() => recordQuote(db, { total: 50, lines: [{ kind: 'shipping', amount: -5 }] }, D, by)).toThrow(/discount goes in Other/)
    // the person's own options replace the release package's, and say so (no run)
    const q = recordQuote(db, { total: 50, currency: 'EUR', quantity: 5, options: [{ option: 'Layers', value: '4' }], lines: [{ kind: 'other', amount: -3 }] }, D, by)
    expect(q).toMatchObject({ currency: 'EUR', quantity: 5, options: [{ option: 'Layers', value: '4' }], optionsFrom: null })
    db.close()
  })

  it('a quote with no options given keeps the options of the quote before it on the same revision', () => {
    // the release package is frozen for a revision, so a choice the person made on an earlier quote still stands:
    // defaulting to the package's every time read as "Options changed" back to the package's values
    const db = project()
    const enig = [{ option: 'Layers', value: '2' }, { option: 'Surface finish', value: 'ENIG' }]
    const a = recordQuote(db, { on: '2026-11-01', total: 120, options: enig }, D, by)
    const b = recordQuote(db, { on: '2026-11-02', total: 118 }, D, by)
    expect(b).toMatchObject({ options: enig, optionsFrom: null })
    expect(quoteChanges(a, b).reasons.join(' ')).not.toMatch(/Options/)
    // another revision starts from its own release package
    const c = recordQuote(db, { on: '2026-11-03', total: 90 }, { ...D, revision: 'B' }, by)
    expect(c).toMatchObject({ options: D.options, optionsFrom: 'fab-1' })
    db.close()
  })

  it('an agent records a quote only from the person\'s words, which are kept with it', () => {
    const db = open(join(dir, 'facts.db'))
    applyAgentFactsSchema(db)
    const agent = { agent: 'worker', label: 'the worker agent', jobId: 'j1' }
    expect(() => recordAgentQuote(db, { total: 182.4, said: 'JLCPCB wants about two hundred' }, D, agent)).toThrow(/not in the person's words/)
    expect(() => recordAgentQuote(db, { total: 182.4, said: 'ok' }, D, agent)).toThrow(/person's words/)
    const q = recordAgentQuote(db, { total: 1182.4, said: 'The JLCPCB cart says US$1,182.40 with DHL.' }, D, agent)
    expect(q).toMatchObject({ source: 'agent', said: 'The JLCPCB cart says US$1,182.40 with DHL.', by: 'the worker agent', total: 1182.4 })
    expect(loadAgentQuotes(db)).toHaveLength(1)
    expect(quoteViews(loadAgentQuotes(db), [])[0]?.said).toBe('The JLCPCB cart says US$1,182.40 with DHL.')
    db.close()
  })
})

describe('what changed between two quotes', () => {
  it('says the quantity, options, revision, parts prices and each breakdown line that moved', () => {
    const prev = row({ lines: [{ kind: 'components', amount: 50 }, { kind: 'shipping', amount: 25 }, { kind: 'pcb', amount: 25 }] })
    const cur = row({
      total: 98.2, quantity: 20, revision: 'B', partsRun: 'bom-2', partsTotal: 43.2,
      options: [{ option: 'Layers', value: '2' }, { option: 'Surface finish', value: 'ENIG' }, { option: 'Stencil', value: 'Yes' }],
      lines: [{ kind: 'components', amount: 53.2 }, { kind: 'shipping', amount: 20 }, { kind: 'pcb', amount: 25 }],
    })
    expect(quoteChanges(prev, cur)).toEqual({
      amount: -1.8, pct: -1.8,
      reasons: [
        'Revision A to B.',
        'Quantity 10 to 20 boards.',
        'Options changed: Surface finish HASL to ENIG; Stencil Yes added.',
        'Parts re-checked (bom-2): +US$3.20 at the checked prices.',
        'Components +US$3.20, Shipping −US$5.00.',
      ],
    })
  })

  it('says nothing it cannot tell, and does not work out a change across currencies', () => {
    expect(quoteChanges(row({}), row({ total: 104 }))).toEqual({ amount: 4, pct: 4, reasons: [] })
    expect(quoteChanges(row({ lines: [{ kind: 'pcb', amount: 10 }] }), row({ lines: [{ kind: 'pcb', amount: 10 }, { kind: 'stencil', amount: 7 }] })).reasons).toEqual(['Stencil +US$7.00 (new).'])
    expect(quoteChanges(row({}), row({ currency: 'EUR', total: 90 }))).toEqual({ amount: null, pct: null, reasons: ['In EUR, not USD: the change is not worked out across currencies.'] })
  })
})

describe('correcting, withdrawing and confirming a quote (#241)', () => {
  it('a correction takes the old quote\'s place, keeps the old values to see, and moves its order', () => {
    const db = project()
    const a = recordQuote(db, { on: '2026-11-01', total: 120, why: 'First quote.' }, D, by)
    const b = recordQuote(db, { on: '2026-11-03', total: 1105, why: 'Cheaper shipping.' }, D, by)
    const { order } = recordOrder(db, { number: 'Y1-0001', paid: 113, ship_date: null }, by)
    linkOrderQuote(db, order)
    // a typo: 1105 for 110.50; what is not given stays the old quote's (date, why, options)
    const c = correctQuote(db, b.id, { total: 110.5, reason: 'Typed 1105 for 110.50.' }, [], by)
    expect(c).toMatchObject({ on: '2026-11-03', total: 110.5, why: 'Cheaper shipping.', options: D.options, orderId: order.id, corrects: { id: b.id, reason: 'Typed 1105 for 110.50.' } })
    const qs = loadQuotes(db)
    expect(qs.find((q) => q.id === b.id)).toMatchObject({ total: 1105, correctedBy: c.id, orderId: null })
    expect(latestQuote(qs, 'A')?.id).toBe(c.id)
    const v = quoteViews(qs, [order])
    expect(v.map((q) => q.id)).toEqual([c.id, b.id, a.id])
    // the change is from the quote that counts before it, and the corrected one has none
    expect(v[0]).toMatchObject({ change: { amount: -9.5 }, corrects: { id: b.id, on: '2026-11-03', total: 1105 }, order: { number: 'Y1-0001', difference: 2.5 } })
    expect(v[1]).toMatchObject({ correctedBy: c.id, change: null, order: null })
    expect(loadJourney(db)!.decisions.find((d) => d.kind === 'quote.corrected')?.summary).toBe('JLCPCB quote of 2026-11-03 corrected: US$1105.00 to US$110.50 (Typed 1105 for 110.50.).')
    expect(() => correctQuote(db, b.id, { total: 99 }, [], by)).toThrow(/already corrected/)
    expect(() => correctQuote(db, c.id, { total: 110.5 }, [], by)).toThrow(/Nothing changed/)
    // the options can be corrected too
    const d = correctQuote(db, c.id, { total: 110.5, options: [{ option: 'Layers', value: '4' }] }, [], by)
    expect(d).toMatchObject({ options: [{ option: 'Layers', value: '4' }], optionsFrom: null })
    db.close()
  })

  it('a withdrawn quote is kept with its reason, out of the totals; one an order was placed against is corrected instead', () => {
    const db = project()
    const a = recordQuote(db, { on: '2026-11-01', total: 120 }, D, by)
    const b = recordQuote(db, { on: '2026-11-02', total: 999, why: 'oops' }, D, by)
    expect(() => withdrawQuote(db, b.id, ' ', [], by)).toThrow(/Say why/)
    const w = withdrawQuote(db, b.id, 'Entered for the wrong project.', [], by)
    expect(w.withdrawn).toMatchObject({ reason: 'Entered for the wrong project.', by: 'ann@example.com' })
    const qs = loadQuotes(db)
    expect(latestQuote(qs, 'A')?.id).toBe(a.id)
    const v = quoteViews(qs, [])
    expect(v[0]).toMatchObject({ id: b.id, total: 999, withdrawn: { reason: 'Entered for the wrong project.' }, change: null })
    // the next quote is compared with the one that counts, and its options carry from it
    const c = recordQuote(db, { on: '2026-11-03', total: 118 }, D, by)
    expect(quoteViews(loadQuotes(db), [])[0]).toMatchObject({ id: c.id, change: { amount: -2 } })
    expect(loadJourney(db)!.decisions.find((d) => d.kind === 'quote.recorded' && d.ref === c.id)?.summary).toMatch(/−US\$2\.00 on the quote before/)
    // an order goes to the newest that counts
    const { order } = recordOrder(db, { number: 'Y1-0002', paid: 118, ship_date: null }, by)
    expect(linkOrderQuote(db, order)?.id).toBe(c.id)
    expect(() => linkOrderQuote(db, { id: 'o2', revision: 'A' }, b.id)).toThrow(/withdrawn/)
    expect(() => withdrawQuote(db, c.id, 'Not a mistake', [], by)).toThrow(/correct it instead/)
    db.close()
  })

  it('an agent\'s quote confirmed by the person is in the journey record once, and an order links to it', () => {
    const fdb = open(join(dir, 'facts-confirm.db'))
    applyAgentFactsSchema(fdb)
    const ag = recordAgentQuote(fdb, { on: '2026-11-04', total: 182.4, said: 'The JLCPCB cart says US$182.40 with DHL.' }, D, { agent: 'worker', label: 'the worker agent', jobId: 'j1' })
    const aq = loadAgentQuotes(fdb)
    fdb.close()
    const db = project()
    // before: an order cannot be linked to it
    expect(() => linkOrderQuote(db, { id: 'o', revision: 'A' }, ag.id)).toThrow(/confirmed first/)
    const c = confirmAgentQuote(db, ag.id, aq, by)
    expect(c).toMatchObject({ total: 182.4, by: 'the worker agent', source: 'person', confirms: { id: ag.id, said: 'The JLCPCB cart says US$182.40 with DHL.', by: 'ann@example.com' } })
    expect(confirmAgentQuote(db, ag.id, aq, by).id).toBe(c.id)
    const all = allQuotes(loadQuotes(db), aq)
    expect(all.map((q) => q.id)).toEqual([c.id])
    expect(quoteViews(all, [])[0]).toMatchObject({ confirmedBy: 'ann@example.com', said: 'The JLCPCB cart says US$182.40 with DHL.' })
    expect(quoteViews(aq, [])[0]).toMatchObject({ agent: true })
    const { order } = recordOrder(db, { number: 'Y1-0003', paid: 182.4, ship_date: null }, by)
    expect(linkOrderQuote(db, order, ag.id)?.id).toBe(c.id)
    expect(loadJourney(db)!.decisions.some((d) => d.kind === 'quote.confirmed')).toBe(true)
    db.close()
  })

  it('withdrawing an agent\'s quote confirms it first, so it is kept with the reason', () => {
    const fdb = open(join(dir, 'facts-withdraw.db'))
    applyAgentFactsSchema(fdb)
    const ag = recordAgentQuote(fdb, { on: '2026-11-04', total: 82.4, said: 'JLCPCB says 82.40 for five.' }, D, { agent: 'worker', label: 'the worker agent', jobId: 'j1' })
    const aq = loadAgentQuotes(fdb)
    fdb.close()
    const db = project()
    const w = withdrawQuote(db, ag.id, 'That was the other board.', aq, by)
    expect(w).toMatchObject({ confirms: { id: ag.id }, withdrawn: { reason: 'That was the other board.' } })
    const all = allQuotes(loadQuotes(db), aq)
    expect(all).toHaveLength(1)
    expect(latestQuote(all, 'A')).toBeNull()
    db.close()
  })
})

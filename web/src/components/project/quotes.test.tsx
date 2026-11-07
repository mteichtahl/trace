/**
 * JLCPCB cost over time (quotes.tsx): every quote, newest first, with its change from the one before and why; the order
 * placed against it with what was paid against the quote; the chart with the estimate as a band; the record-quote form.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuoteView } from '@/lib/types-s1'
import { QuoteHistory, changeWords, quoteArgs } from './quotes'

vi.mock('@/lib/queries', () => ({ useCall: (action: string) => ({ isPending: false, mutate: (args: unknown) => calls.push([action, args]) }) }))
const calls: [string, unknown][] = []

const wrap = (n: ReactNode) => <QueryClientProvider client={new QueryClient()}>{n}</QueryClientProvider>
const D = { quantity: 10, currency: 'USD', release: 'Rev A', options: [{ option: 'Layers', value: '2' }, { option: 'Surface finish', value: 'HASL' }] }
const q = (o: Partial<QuoteView>): QuoteView => ({
  id: 'q', on: '2026-11-01', at: '2026-11-01T10:00:00Z', total: 158.62, currency: 'USD', quantity: 10, revision: 'A', fab: 'JLCPCB', lines: [], options: [], optionsFrom: 'fab-1',
  partsRun: 'bom-1', link: null, why: null, by: 'Marc', change: null, order: null, ...o,
})
const THREE = [
  q({ id: 'q3', on: '2026-11-06', total: 161.3, why: 'Swapped U3 for a basic part.', link: 'https://cart.jlcpcb.com/quote/Q1', change: { amount: -3.6, pct: -2.2, reasons: ['Extended-part fees −US$3.00, Tax and duty −US$0.60.'] }, order: { id: 'o1', number: 'Y12-0042', paid: 164.5, difference: 3.2 } }),
  q({ id: 'q2', on: '2026-11-03', total: 164.9, why: 'ENIG for the radio module.', change: { amount: 6.28, pct: 4, reasons: ['Options changed: Surface finish HASL to ENIG.', 'PCB +US$7.80, Shipping −US$5.00.'] }, lines: [{ kind: 'pcb', amount: 26.2, label: 'PCB' }, { kind: 'shipping', amount: 21.4, label: 'Shipping' }] }),
  q({ id: 'q1', by: 'the worker agent', said: 'JLCPCB says US$158.62 for ten.' }),
]

describe('JLCPCB cost over time', () => {
  it('with no quote says how to get one, and offers to record it', () => {
    render(wrap(<QuoteHistory repo="a/b" quotes={[]} defaults={D} />))
    expect(screen.getByText(/No quote yet\. Upload the package on JLCPCB/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Record a quote/ }))
    const form = screen.getByRole('form', { name: 'Record a JLCPCB quote' })
    expect(form).toHaveTextContent('It is for Rev A with 2 options from the release package.')
    expect(within(form).getByRole('button', { name: 'Record quote' })).toBeDisabled()
  })

  it('lists every quote newest first, with its change, why, what trace saw change, and the order against it', () => {
    render(wrap(<QuoteHistory repo="a/b" quotes={THREE} defaults={D} estimate={{ low: 96.4, high: 171, currency: 'USD', at: '2026-11-06T00:00:00Z', partsRun: 'p', notIn: [] }} />))
    const items = within(screen.getByRole('list', { name: 'Quotes, newest first' })).getAllByRole('listitem').filter((li) => li.parentElement?.getAttribute('aria-label') === 'Quotes, newest first')
    expect(items.map((li) => li.textContent?.match(/US\$\d+\.\d\d/)?.[0])).toEqual(['US$161.30', 'US$164.90', 'US$158.62'])
    expect(items[0]).toHaveTextContent('−US$3.60 (−2.2%) on the quote before')
    expect(items[0]).toHaveTextContent('WhySwapped U3 for a basic part.')
    expect(items[0]).toHaveTextContent('What changedExtended-part fees −US$3.00, Tax and duty −US$0.60.')
    expect(items[0]).toHaveTextContent('Order Y12-0042 was placed against it: US$164.50 paid, +US$3.20 on the quote.')
    expect(within(items[0]!).getByRole('link', { name: /On JLCPCB/ })).toHaveAttribute('href', 'https://cart.jlcpcb.com/quote/Q1')
    expect(items[1]).toHaveTextContent('+US$6.28 (+4%) on the quote before')
    expect(items[1]).toHaveTextContent('Options changed: Surface finish HASL to ENIG.')
    expect(items[1]).toHaveTextContent('PCB US$26.20 · Shipping US$21.40')
    expect(items[2]).toHaveTextContent('Recorded by the worker agent from your words: “JLCPCB says US$158.62 for ten.”')
    expect(items[2]).not.toHaveTextContent('on the quote before')
    // the chart: totals oldest first, the estimate as a band
    expect(screen.getByRole('img', { name: /JLCPCB total per quote: 2026-11-01 US\$158.62, 2026-11-03 US\$164.90, 2026-11-06 US\$161.30; the estimate US\$96.40 to US\$171/ })).toBeInTheDocument()
  })
})

describe('recording a quote', () => {
  const base = { on: '2026-11-06', total: '182.40', currency: 'usd', quantity: '10', lines: {}, link: '', why: '' }
  it('sends the amounts as numbers and leaves blank lines out', () => {
    expect(quoteArgs({ ...base, lines: { pcb: '24', shipping: ' ', other: '-2.5' }, link: ' Q-1 ', why: 'Cheaper DHL.' })).toEqual({
      args: { on: '2026-11-06', total: 182.4, currency: 'USD', quantity: 10, lines: [{ kind: 'pcb', amount: 24 }, { kind: 'other', amount: -2.5 }], link: 'Q-1', why: 'Cheaper DHL.' },
    })
  })
  it('says what is wrong instead of sending it', () => {
    expect(quoteArgs({ ...base, total: '' })).toEqual({ problem: 'Give the total JLCPCB shows.' })
    expect(quoteArgs({ ...base, quantity: '0' })).toEqual({ problem: 'Give how many boards it is for.' })
    expect(quoteArgs({ ...base, lines: { components: 'lots' } })).toEqual({ problem: 'Components is not an amount.' })
    expect(quoteArgs({ ...base, lines: { pcb: '100', components: '100' } })).toEqual({ problem: 'The lines add up to 200.00, more than the total.' })
  })
  it('words a change from the quote before', () => {
    expect(changeWords({ currency: 'USD', change: null })).toBeNull()
    expect(changeWords({ currency: 'USD', change: { amount: null, pct: null, reasons: [] } })).toBeNull()
    expect(changeWords({ currency: 'USD', change: { amount: 0, pct: 0, reasons: [] } })).toBe('no change')
    expect(changeWords({ currency: 'EUR', change: { amount: -5, pct: -3.1, reasons: [] } })).toBe('−EUR 5.00 (−3.1%)')
  })
})

describe('correcting, withdrawing and confirming (#241)', () => {
  beforeEach(() => { calls.length = 0 })
  const items = () => within(screen.getByRole('list', { name: 'Quotes, newest first' })).getAllByRole('listitem').filter((li) => li.parentElement?.getAttribute('aria-label') === 'Quotes, newest first')
  const HISTORY = [
    q({ id: 'q5', on: '2026-11-07', total: 159.8, by: 'the worker agent', said: 'JLCPCB says US$159.80.', agent: true }),
    q({ id: 'q4', on: '2026-11-03', total: 110.5, corrects: { id: 'q3', on: '2026-11-03', total: 1105, reason: 'Typed 1105 for 110.50.', by: 'Marc' }, options: [{ option: 'Layers', value: '4' }], optionsFrom: null }),
    q({ id: 'q3', on: '2026-11-03', total: 1105, correctedBy: 'q4' }),
    q({ id: 'q2', on: '2026-11-02', total: 999, withdrawn: { reason: 'Entered for the other board', by: 'Marc', at: '2026-11-02T10:00:00Z' } }),
    q({ id: 'q1', total: 120 }),
  ]

  it('keeps corrected and withdrawn quotes to see, out of the count and the chart', () => {
    render(wrap(<QuoteHistory repo="a/b" quotes={HISTORY} defaults={D} />))
    const [agent, fixed, wrong, withdrawn] = items()
    expect(withdrawn).toHaveTextContent('Withdrawn by Marc: Entered for the other board. Kept to see, out of the totals.')
    expect(wrong).toHaveTextContent('Corrected')
    expect(fixed).toHaveTextContent('Corrects the entry of US$1,105.00 for 2026-11-03: Typed 1105 for 110.50 (Marc).')
    expect(agent).toHaveTextContent('Confirm it to keep it in the project\'s record, so the order can be linked to it.')
    // the corrected and withdrawn ones have no actions
    expect(within(wrong!).queryByRole('button')).toBeNull()
    expect(within(withdrawn!).queryByRole('button')).toBeNull()
    expect(screen.getByRole('img', { name: /JLCPCB total per quote: 2026-11-01 US\$120.00, 2026-11-03 US\$110.50, 2026-11-07 US\$159.80$/ })).toBeInTheDocument()
    fireEvent.click(within(agent!).getByRole('button', { name: 'Confirm' }))
    expect(calls).toEqual([['quote.confirm', { repo: 'a/b', quote: 'q5' }]])
  })

  it('withdraws with a reason', () => {
    render(wrap(<QuoteHistory repo="a/b" quotes={HISTORY} defaults={D} />))
    fireEvent.click(within(items()[4]!).getByRole('button', { name: 'Withdraw' }))
    const form = screen.getByRole('form', { name: 'Withdraw the quote of 2026-11-01' })
    expect(within(form).getByRole('button', { name: 'Withdraw quote' })).toBeDisabled()
    fireEvent.change(within(form).getByLabelText('Why is it withdrawn?'), { target: { value: 'A test entry' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Withdraw quote' }))
    expect(calls).toEqual([['quote.withdraw', { repo: 'a/b', quote: 'q1', reason: 'A test entry' }]])
  })

  it('corrects a quote from the form prefilled with it, options and all', () => {
    render(wrap(<QuoteHistory repo="a/b" quotes={HISTORY} defaults={D} />))
    fireEvent.click(within(items()[1]!).getByRole('button', { name: 'Correct' }))
    const form = screen.getByRole('form', { name: 'Correct a JLCPCB quote' })
    expect(form).toHaveTextContent('Correct the quote of 2026-11-03')
    expect(within(form).getByLabelText('Total')).toHaveValue('110.50')
    fireEvent.click(within(form).getByRole('button', { name: 'Change the options (1, from the quote as entered)' }))
    fireEvent.change(within(form).getByLabelText('Value of Layers'), { target: { value: '6' } })
    fireEvent.change(within(form).getByLabelText('What was wrong (optional)'), { target: { value: 'Six layers, not four.' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save the correction' }))
    expect(calls).toEqual([['quote.correct', { repo: 'a/b', quote: 'q4', on: '2026-11-03', total: 110.5, currency: 'USD', quantity: 10, options: [{ option: 'Layers', value: '6' }], reason: 'Six layers, not four.' }]])
  })

  it('a new quote\'s options start from the quote before, and are sent only when changed', () => {
    render(wrap(<QuoteHistory repo="a/b" quotes={HISTORY.slice(1)} defaults={D} />))
    fireEvent.click(screen.getByRole('button', { name: /Record a quote/ }))
    const form = screen.getByRole('form', { name: 'Record a JLCPCB quote' })
    expect(form).toHaveTextContent('It is for Rev A with 1 option from the quote before.')
    fireEvent.change(within(form).getByLabelText('Total'), { target: { value: '112' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Record quote' }))
    expect((calls[0]![1] as { options?: unknown }).options).toBeUndefined()
    fireEvent.click(within(form).getByRole('button', { name: /Change the options/ }))
    fireEvent.click(within(form).getByRole('button', { name: 'Add an option' }))
    fireEvent.change(within(form).getByLabelText('Option 2'), { target: { value: 'Surface finish' } })
    fireEvent.change(within(form).getByLabelText('Value of Surface finish'), { target: { value: 'ENIG' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Record quote' }))
    expect((calls[1]![1] as { options?: unknown }).options).toEqual([{ option: 'Layers', value: '4' }, { option: 'Surface finish', value: 'ENIG' }])
  })

  it('says what is wrong with the options', () => {
    const base = { on: '2026-11-06', total: '182.40', currency: 'usd', quantity: '10', lines: {}, link: '', why: '' }
    expect(quoteArgs({ ...base, options: [{ option: 'Layers', value: '' }] })).toEqual({ problem: 'Give a value for Layers.' })
    expect(quoteArgs({ ...base, options: [{ option: 'Layers', value: '2' }, { option: 'layers', value: '4' }] })).toEqual({ problem: 'layers is given twice.' })
    expect(quoteArgs({ ...base, options: [{ option: '', value: '' }] })).toMatchObject({ args: { options: [] } })
  })
})

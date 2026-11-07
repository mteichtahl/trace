/**
 * JLCPCB cost over time (quotes.tsx): every quote, newest first, with its change from the one before and why; the order
 * placed against it with what was paid against the quote; the chart with the estimate as a band; the record-quote form.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import type { QuoteView } from '@/lib/types-s1'
import { QuoteHistory, changeWords, quoteArgs } from './quotes'

const wrap = (n: ReactNode) => <QueryClientProvider client={new QueryClient()}>{n}</QueryClientProvider>
const D = { quantity: 10, currency: 'USD', release: 'Rev A', options: 12 }
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
    expect(form).toHaveTextContent("It is for Rev A with the release package's 12 options.")
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

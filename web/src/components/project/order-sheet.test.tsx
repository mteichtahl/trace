/**
 * The order sheet's words and the build budget at Fabricate (test-esp32 run 2, #217, #226, #218): "ready to place" only
 * when build.get says so, the cost the target said as such until a quote, no "All 0 lines are in stock", and nothing
 * committed before an order is placed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Budgets } from './budgets'
import { gateSpendLine } from './gate-spend'
import { againstBudget, lineChange, orderAmount, orderHeadline, priceChangeLine, unitPrice } from './order-sheet'

vi.mock('@tanstack/react-router', async (orig) => ({ ...(await orig<object>()), Link: ({ children }: { children: ReactNode }) => children }))

const wrap = (n: ReactNode) => <QueryClientProvider client={new QueryClient()}>{n}</QueryClientProvider>

describe('the order being prepared', () => {
  it('is not "ready to place" until build.get says so, and its cost is the target, not a quote', () => {
    const prepared = { state: 'ready' as const, boards: 10, total: 90, currency: 'USD', basis: 'target' as const, target: 90 }
    expect(orderHeadline({ ...prepared, ready: false })).toEqual({ title: 'The order for 10 boards is not ready to place yet.', cost: 'No quote yet: the build plan\'s target is US$90, not a price.' })
    // no word from build.get is not a yes
    expect(orderHeadline(prepared).title).toBe('The order for 10 boards is not ready to place yet.')
    expect(orderHeadline({ ...prepared, ready: true }).title).toBe('The order for 10 boards is ready to place on JLCPCB.')
    expect(orderHeadline({ ...prepared, target: null }).cost).toBe('No quote yet, and no target unit cost in the build plan.')
    expect(orderHeadline({ ...prepared, basis: 'quote', total: 184, ready: true }).cost).toBe('JLCPCB quoted US$184.00.')
    // the Orders list: "10 boards of A · US$90 · Ready to place" was the target shown as the order's cost
    expect(orderAmount(prepared)).toBe('target US$90, no quote yet')
    expect(orderAmount({ ...prepared, target: null })).toBe('no quote yet')
    expect(orderAmount({ ...prepared, state: 'placed', total: 131.4 })).toBe('US$131')
  })

  // #227: no quote is ever recorded yet, so the sheet could only show the target; it shows the order estimate the
  // gates show, said as not a quote, and holds that against the budget
  it('with an order estimate, says it before the target and holds its high end against the budget', () => {
    const prepared = { state: 'ready' as const, boards: 10, total: 90, currency: 'USD', basis: 'target' as const, target: 90, cost: [] }
    const estimate = { low: 141, high: 244, currency: 'USD', at: '2026-11-06T10:00:00.000Z', partsRun: 'p1', notIn: [] }
    expect(orderHeadline({ ...prepared, estimate }).cost).toBe('No quote yet: the order estimate is US$141 to US$244, from the parts check and the fab\'s published prices, not a quote.')
    expect(orderAmount({ ...prepared, estimate })).toBe('estimate US$141 to US$244, no quote yet')
    expect(againstBudget({ ...prepared, estimate })).toEqual({ amount: 244, what: 'the estimate\'s high end' })
    expect(againstBudget(prepared)).toEqual({ amount: 90, what: 'the target' })
    // the quote's total, never the target and parts lines beside it added up
    expect(againstBudget({ ...prepared, basis: 'quote', total: 182.4, estimate, cost: [{ label: 'Target', amount: 90 }, { label: 'Parts', amount: 50 }] })).toEqual({ amount: 182.4, what: 'the quote' })
  })
})

describe('with a JLCPCB quote', () => {
  it('makes the newest quote the headline cost, keeps the estimate to compare, and shows what was paid against it', () => {
    const estimate = { low: 141, high: 244, currency: 'USD', at: '2026-11-06T10:00:00.000Z', partsRun: 'p1', notIn: [] }
    const prepared = { state: 'ready' as const, boards: 10, total: 182.4, currency: 'USD', basis: 'quote' as const, target: 90, ready: true, estimate, quote: { id: 'q1', on: '2026-11-05', total: 182.4, currency: 'USD', quantity: 10 } }
    expect(orderHeadline(prepared).cost).toBe('JLCPCB quoted US$182.40 on 2026-11-05. The estimate was US$141 to US$244.')
    expect(orderHeadline({ ...prepared, quote: { ...prepared.quote, quantity: 20 } }).cost).toBe('JLCPCB quoted US$182.40 on 2026-11-05 for 20 boards. The estimate was US$141 to US$244.')
    expect(orderAmount(prepared)).toBe('quoted US$182.40')
    expect(orderAmount({ ...prepared, state: 'placed', total: 185.6, quote: { ...prepared.quote, difference: 3.2 } })).toBe('US$185.60 paid, quoted US$182.40 (+US$3.20)')
  })

  it('the Cost page says the forecast is the quote, not the estimate', () => {
    expect(gateSpendLine({ money: true, currency: 'USD', spent: { cloud: 0, orders: 0 }, committed: 0, forecast: 182.4, forecastBasis: { kind: 'quote', total: 182.4, on: '2026-11-05', id: 'q1' }, budget: 275, quantity: 10, unit_cost: 9, stages: [], lines: [] } as never))
      .toMatch(/forecast for the order: the JLCPCB quote of 2026-11-05, the newest recorded \(not the estimate\)/)
  })
})

describe('the build budget at Fabricate (#218)', () => {
  it('counts the order being prepared as a forecast from the target, and nothing as committed', () => {
    // cost.get at Fabricate with no order placed: forecast 90, committed 0
    const c = { money: true, currency: 'USD', spent: { cloud: 12, orders: 0 }, committed: 0, forecast: 90, budget: 275, quantity: 10, unit_cost: 9, stages: [], lines: [] }
    render(wrap(<Budgets cost={c} id="x" />))
    const build = screen.getByRole('region', { name: 'Build budget' })
    expect(build).toHaveTextContent('CommittedOrders placed, not paid yetUS$0')
    expect(build).toHaveTextContent('Forecast for the order10 boards at US$9 each, the build plan\'s target unit costUS$90')
    expect(build).not.toHaveTextContent('ready to place')
    expect(gateSpendLine(c)).toMatch(/US\$185 left\. After US\$90 forecast for the order: 10 boards at US\$9 each, the build plan's target unit cost\./)
  })
})

describe('price changes since sign-off (#229)', () => {
  // round 6: "2 prices went up since sign-off, adding US$0.00 for 10 boards", and "+US$0.00" on both lines, while C1/C2 went down
  const parts = [
    { then: 0.0037, now: 0.0038 },
    { then: 0.0012, now: 0.0013 },
    { then: 0.04, now: 0.03, need: 20 },
  ]
  it('counts the drops too, and says the net change', () => {
    expect(priceChangeLine(parts, 10, 'USD')).toBe('2 prices went up and 1 went down since sign-off: −US$0.20 net for 10 boards.')
    expect(priceChangeLine([{ then: 1, now: 1 }], 10, 'USD')).toBe('No price changed since sign-off.')
    expect(priceChangeLine([{ then: 0.5, now: 0.54 }], 10, 'USD')).toBe('1 price went up since sign-off: +US$0.40 for 10 boards.')
  })
  it('never says US$0.00 for a change of a fraction of a cent', () => {
    expect(priceChangeLine(parts.slice(0, 2), 10, 'USD')).toBe('2 prices went up since sign-off: less than a cent for 10 boards.')
    expect(lineChange(parts[0]!, 10, 'USD')).toBe('up under a cent')
    expect(lineChange(parts[2]!, 10, 'USD')).toBe('−US$0.20')
    expect(lineChange({ then: 1, now: 1 }, 10, 'USD')).toBeNull()
    // the two columns show the change too
    expect(unitPrice(0.0037, 'USD')).toBe('US$0.0037')
    expect(unitPrice(0.00202, 'USD')).toBe('US$0.00202')
    expect(unitPrice(0.002, 'USD')).toBe('US$0.002')
    expect(unitPrice(0.21, 'USD')).toBe('US$0.21')
  })
})

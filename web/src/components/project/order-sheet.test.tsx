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
import { againstBudget, orderAmount, orderHeadline } from './order-sheet'

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
    expect(orderHeadline({ ...prepared, basis: 'quote', total: 184, ready: true }).cost).toBe('Expected cost about US$184, from the quote.')
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
    expect(againstBudget({ ...prepared, basis: 'quote', estimate, cost: [{ label: 'Boards', amount: 100 }, { label: 'Parts', amount: 50 }] })).toEqual({ amount: 150, what: 'the quote' })
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
    expect(gateSpendLine(c)).toMatch(/US\$185 left after US\$90 forecast for the order \(10 boards at US\$9 each, the build plan's target unit cost\)/)
  })
})

/**
 * The order estimate on the gate's cost line and in the Build budget (test-esp32 run 2, #162): seen as soon as there is
 * a parts check, with each cost requirement's verdict, not first at Sign-off.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { CostView, OrderEstimateView } from '@/lib/types-s1'
import { Budgets } from './budgets'
import { estimateLine, gateSpendLine } from './gate-spend'

vi.mock('@tanstack/react-router', async (orig) => ({ ...(await orig<object>()), Link: ({ children }: { children: ReactNode }) => children }))

const wrap = (n: ReactNode) => <QueryClientProvider client={new QueryClient()}>{n}</QueryClientProvider>

const ESTIMATE: OrderEstimateView = {
  currency: 'USD', quantity: 10, low: 141, high: 244, perBoard: { low: 7.69, high: 8.34 }, at: '2026-11-03T10:00:00.000Z', partsRun: 'p1', verdict: 'over',
  lines: [], notIn: ['No case yet: a case is added once one is built (mech.build gives its volume).'],
  limits: [
    { requirement: 'REQ-4ce9e8', kind: 'total', amount: 100, currency: 'USD', verdict: 'over', text: '' },
    { requirement: 'REQ-f3f79d', kind: 'per_board', amount: 8, currency: 'USD', verdict: 'at_risk', text: '' },
  ],
  text: '',
}

describe('the order estimate against the cost requirements (#162)', () => {
  it('says each requirement over or at risk, and that it is not a quote', () => {
    const line = estimateLine(ESTIMATE)
    expect(line).toMatch(/^Order estimate US\$141 to US\$244 for 10 boards, US\$7.69 to US\$8.34 per board \(parts check of 2026-11-03;/)
    expect(line).toMatch(/not a quote/)
    expect(line).toMatch(/over REQ-4ce9e8 \(US\$100\) by US\$41 to US\$144/)
    expect(line).toMatch(/at risk against REQ-f3f79d \(US\$8\): up to US\$0.34 over/)
    expect(line).toMatch(/Change the budget, the parts, the case or the quantity now/)
    expect(estimateLine({ ...ESTIMATE, verdict: 'under', limits: [{ ...ESTIMATE.limits[0]!, amount: 275, verdict: 'under' }] })).toMatch(/under REQ-4ce9e8 \(US\$275\)\.$/)
  })

  it('is on the gate line and in the Build budget once there is a parts check', () => {
    const c: CostView = { money: true, currency: 'USD', spent: { cloud: 12, orders: 0 }, committed: 0, forecast: 80, budget: 100, quantity: 10, unit_cost: 8, stages: [], lines: [], orderEstimate: ESTIMATE }
    expect(gateSpendLine(c)).toMatch(/Order estimate US\$141 to US\$244/)
    expect(gateSpendLine({ ...c, orderEstimate: undefined })).not.toMatch(/Order estimate/)
    render(wrap(<Budgets cost={c} id="x" />))
    const est = screen.getByLabelText('Order estimate')
    expect(est).toHaveTextContent('Over a cost requirement')
    expect(est).toHaveTextContent('The order, 10 boardsBoards, assembly, parts, case and shippingUS$141 to US$244')
    expect(est).toHaveTextContent('No case yet')
  })
})

describe('the order forecast (#178)', () => {
  it('is the newest order estimate when there is one, and says so', () => {
    const c: CostView = {
      money: true, currency: 'USD', spent: { cloud: 12, orders: 0 }, committed: 0, forecast: 244, budget: 275, quantity: 10, unit_cost: 9, stages: [], lines: [],
      forecastBasis: { kind: 'estimate', low: 141, high: 244, at: '2026-11-06T10:00:00.000Z', partsRun: 'p1' },
    }
    const line = gateSpendLine(c)
    expect(line).toMatch(/US\$31 left after US\$244 forecast for the order \(the high end of the order estimate of 2026-11-06, US\$141 to US\$244, from its parts check and the fab's published prices\)/)
    expect(line).not.toMatch(/the build plan's target/)
    // without an estimate: the target, as before
    expect(gateSpendLine({ ...c, forecast: 90, forecastBasis: { kind: 'target' } })).toMatch(/US\$90 forecast for the order \(10 boards at US\$9 each, the build plan's target unit cost\)/)
  })
})

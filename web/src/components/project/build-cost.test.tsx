/**
 * The build and cost pieces of the app against what the API really answers (lib/api-answers.json: build.get, cost.get,
 * usage.month from test/api/web-answers.test.ts) and the mocks: the order's Wait line and shipping form, the boards,
 * the readings against their limits, the cloud breakdown with when Cost Explorer reads next, the gate's cost line and
 * the Operations cost tile.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import answers from '@/lib/api-answers.json'
import type { BuildView, CostView, UsageMonth } from '@/lib/types-s1'
import { costTile } from '@/components/ops/ops-model'
import { checkId } from '@/components/skills/inspection-panel'
import { handle } from '@/mock/handlers'
import { BenchReadings, BoardList, PlacedOrders, limitText } from './build-record'
import { CloudBreakdown, explorerLine, pricesLine } from './cloud-cost'
import { ago } from '@/lib/format'
import { gateSpendLine } from './gate-spend'

const wrap = (n: ReactNode) => <QueryClientProvider client={new QueryClient()}>{n}</QueryClientProvider>
const real = <T,>(a: 'build.get' | 'cost.get' | 'usage.month'): T => (answers as unknown as Record<string, { result: T }>)[a]!.result

describe('the API\'s build and cost answers, as the app reads them', () => {
  it('build.get: a shipped order with its DHL number and an honest Wait line; a board with its checks', () => {
    const b = real<BuildView>('build.get')
    const o = b.orders[0]!
    expect(o).toMatchObject({ state: 'shipped', number: 'Y12-0001', tracking: { carrier: 'dhl', number: '1234567890', checkable: false } })
    expect(o.wait?.text).toMatch(/once an admin adds the DHL key/)
    expect(b.boards[0]).toMatchObject({ serial: 'SN-001', state: 'received', photos: ['runs/abc/top.jpg'] })
    render(wrap(<PlacedOrders repo="acme/answers" orders={b.orders} />))
    expect(screen.getByText('Order Y12-0001')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark delivered' })).toBeInTheDocument()
    // trace cannot check it yet (no key), so there is no Check now
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull()
  })

  it('cost.get: the estimate by kind, nothing billed yet, and where the prices come from', () => {
    const c = real<CostView>('cost.get')
    expect(c.spent.detail?.estimated).toEqual({ agents: 0, gpu: 0, cpu: 0, total: 0 })
    render(<CloudBreakdown detail={c.spent.detail!} currency={c.currency} explorer={c.explorer} prices={c.prices} />)
    expect(screen.getByText('Cloud use, estimated')).toBeInTheDocument()
    expect(screen.getByText('Nothing billed with this project\'s tag yet.')).toBeInTheDocument()
    // no price list fetched yet in the API's test installation: the built-in table, old, and when it will be fetched
    expect(screen.getByText(/built-in price table of 2025-11-24 .*the AWS price list has not been fetched yet/)).toBeInTheDocument()
    expect(pricesLine(c.prices)).toEqual({ status: 'warning', label: 'Built-in prices' })
    expect(screen.getByText('Built-in prices')).toBeInTheDocument()
    expect(explorerLine(c.explorer)).toMatchObject({ status: 'waiting', label: 'Not read yet' })
    expect(gateSpendLine(c)).toBe('Spent so far US$40, US$40 on orders.')
  })

  it('usage.month: each project with its estimate, the actual (none yet) and orders', () => {
    const m = real<UsageMonth>('usage.month')
    expect(m.projects).toEqual([expect.objectContaining({ repo: 'acme/answers', actual: null, orders: 40 })])
    expect(costTile({ estimated: m.totals.estimated, actual: m.totals.actual, currency: m.currency, projects: m.projects.length })).toMatchObject({ id: 'cost', label: 'Cloud spend this month', sub: 'Estimate across 1 project · not billed by AWS yet' })
  })
})

describe('the prices\' badge', () => {
  const base = { asOf: '2026-10-27', stale: false, sources: [], text: '' }
  it('says the AWS price list and when, a failed fetch, the built-in table, and reads answers of before the price list', () => {
    const now = Date.parse('2026-10-27T12:00:00Z')
    expect(pricesLine({ ...base, source: 'price-list', status: 'met', fetchedAt: '2026-10-27T06:20:00Z', failed: null }, now)).toEqual({ status: 'met', label: `AWS price list, fetched ${ago('2026-10-27T06:20:00Z', now)}` })
    expect(pricesLine({ ...base, source: 'price-list', status: 'warning', failed: { at: '2026-10-27T06:20:00Z', error: 'denied' } }, now)).toEqual({ status: 'warning', label: 'Price list fetch failed' })
    expect(pricesLine({ ...base, source: 'built-in', status: 'warning', failed: { at: null, error: 'x' } }, now)).toEqual({ status: 'warning', label: 'Built-in prices: fetch failed' })
    expect(pricesLine({ ...base, stale: true }, now)).toEqual({ status: 'warning', label: 'Price table more than six months old' })
    expect(pricesLine({ ...base }, now)).toEqual({ status: 'met', label: 'Price table of 2026-10-27' })
  })
})

describe('the mocks', () => {
  it('the panel controller at bring-up: a followed DHL parcel, two boards, readings in limits', async () => {
    const r = await handle('/api/call', { method: 'POST', body: JSON.stringify({ action: 'build.get', repo: 'acme/panel-controller' }) })
    const b = (await r.json()).result as BuildView
    expect(b.orders[0]?.wait).toMatchObject({ source: 'timer', checkable: true })
    render(wrap(<><PlacedOrders repo="acme/panel-controller" orders={b.orders} /><BoardList boards={b.boards} /><BenchReadings bench={b.bench!} /></>))
    expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument()
    expect(screen.getByText('Failed inspection')).toBeInTheDocument()
    expect(screen.getByText('u3-rotation at U3')).toBeInTheDocument()
    expect(screen.getByText('3V3 rail at TP4')).toBeInTheDocument()
    expect(screen.getAllByText('In limits')).toHaveLength(4)
  })

  it('Admin › Usage and cost and the cost tab answer from the mock', async () => {
    const m = (await (await handle('/api/call', { method: 'POST', body: JSON.stringify({ action: 'usage.month' }) })).json()).result as UsageMonth
    expect(m.projects).toHaveLength(3)
    const c = (await (await handle('/api/call', { method: 'POST', body: JSON.stringify({ action: 'cost.get', repo: 'acme/soil-sensor' }) })).json()).result as CostView
    expect(explorerLine(c.explorer)).toMatchObject({ status: 'met', text: expect.stringMatching(/^Next read in/) })
  })
})

describe('small rules', () => {
  it('says a limit in words, and names a check by its part', () => {
    expect(limitText({ min: 3.25, max: 3.35, unit: 'V' })).toBe('3.25 V to 3.35 V')
    expect(limitText({ max: 0.15, unit: 'A' })).toBe('at most 150 mA')
    expect(limitText({ min: 1000, unit: 'Ω' })).toBe('at least 1 kΩ')
    expect(limitText({ unit: 'V' })).toBe('no limit')
    expect(checkId('hand', ' j2 ')).toBe('hand-J2')
    expect(checkId('count', 'x')).toBe('count')
  })

  it('the gate\'s line says nothing without money, and counts the budget left after what is committed', () => {
    expect(gateSpendLine({ money: false, currency: 'USD', spent: { cloud: null, orders: null }, committed: null, forecast: null, stages: [], lines: [] })).toBeNull()
    const line = gateSpendLine({ money: true, currency: 'USD', spent: { cloud: 12, orders: 100, detail: { estimated: { agents: 12, gpu: 0, cpu: 0, total: 12 }, actual: { total: 3, byService: {}, through: null, estimatedDays: 0 }, basis: 'estimate' } }, committed: 50, forecast: 0, budget: 300, stages: [], lines: [] })
    expect(line).toBe('Spent so far US$112, US$12 of it cloud use (estimated; US$3 billed by AWS so far), US$100 on orders. Budget US$300: US$138 left after what is committed and forecast.')
  })
})

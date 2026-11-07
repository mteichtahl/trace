/**
 * The build and cost pieces of the app against what the API really answers (lib/api-answers.json: build.get, cost.get,
 * usage.month from test/api/web-answers.test.ts) and the mocks: the order's Wait line and shipping form, the boards,
 * the readings against their limits, the cloud breakdown with when Cost Explorer reads next, the gate's cost line and
 * the Operations cost tile.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import answers from '@/lib/api-answers.json'
import type { BuildView, CostView, UsageMonth } from '@/lib/types-s1'
import { costTile } from '@/components/ops/ops-model'
import { checkId } from '@/components/skills/inspection-panel'
import { handle } from '@/mock/handlers'
import { BenchReadings, BoardList, PlacedOrders, limitText } from './build-record'
import { CloudBreakdown, explorerLine, pricesLine } from './cloud-cost'
import { ago } from '@/lib/format'
import { budgetsOf, gateSpendLine } from './gate-spend'
import { Budgets } from './budgets'

vi.mock('@tanstack/react-router', async (orig) => ({ ...(await orig<object>()), Link: ({ children }: { children: ReactNode }) => children }))

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
    expect(c.spent.detail?.estimated).toEqual({ agents: 0, gpu: 0, cpu: 0, tools: 0, total: 0 })
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

  it('the gate\'s line says nothing without money, and counts the build budget left after the orders and what is committed', () => {
    expect(gateSpendLine({ money: false, currency: 'USD', spent: { cloud: null, orders: null }, committed: null, forecast: null, stages: [], lines: [] })).toBeNull()
    const line = gateSpendLine({ money: true, currency: 'USD', spent: { cloud: 12, orders: 100, detail: { estimated: { agents: 12, gpu: 0, cpu: 0, total: 12 }, actual: { total: 3, byService: {}, through: null, estimatedDays: 0 }, basis: 'estimate' } }, committed: 50, forecast: 0, budget: 300, stages: [], lines: [] })
    // the cloud work is not taken off the build budget: US$300 less US$100 paid and US$50 committed
    expect(line).toBe('Spent so far US$112, US$12 of it cloud work (estimated; US$3 billed by AWS so far), US$100 on orders. Build budget US$300 (boards, parts and case): US$150 left after US$100 paid for orders and US$50 committed for orders placed but not paid yet. trace\'s cloud work does not count against the build budget, and no cloud-work allowance is set (Settings).')
  })

  it('the gate\'s line keeps the order and trace\'s cloud work apart, the forecast with its source (test-esp32 run 2, #91: US$1.59 spent, "US$18.41 left")', () => {
    const define = { money: true, currency: 'USD', spent: { cloud: 1.59, orders: 0 }, committed: 0, forecast: 80, budget: 100, quantity: 10, unit_cost: 8, stages: [], lines: [] }
    expect(gateSpendLine(define)).toBe('Spent so far US$1.59, US$1.59 of it cloud work (estimated). Build budget US$100 (boards, parts and case): US$20 left after US$80 forecast for the order (10 boards at US$8 each, the build plan\'s target unit cost). trace\'s cloud work does not count against the build budget, and no cloud-work allowance is set (Settings).')
    // the Architect gate with an allowance: the build still has its US$20, the cloud work is counted against its own
    const architect = { ...define, spent: { cloud: 21.28, orders: 0 }, cloudBudget: 60 }
    expect(gateSpendLine(architect)).toMatch(/Build budget US\$100 \(boards, parts and case\): US\$20 left after US\$80 forecast for the order .* Cloud-work allowance US\$60: US\$38.72 left after US\$21.28 of trace's cloud work \(estimated\)\.$/)
    // over the allowance says by how much, never US$0
    expect(gateSpendLine({ ...architect, cloudBudget: 20 })).toMatch(/Cloud-work allowance US\$20: US\$1.28 over after US\$21.28 of trace's cloud work \(estimated\)\. Cost and time shows what each job cost\.$/)
    // over the build budget is the order's alone
    expect(gateSpendLine({ ...architect, budget: 75 })).toMatch(/Build budget US\$75 \(boards, parts and case\): US\$5 over after US\$80 forecast for the order/)
    expect(budgetsOf(architect)).toMatchObject({ build: { budget: 100, forecast: 80, left: 20 }, cloud: { allowance: 60, spent: 21.28, left: 38.72 } })
  })

  it('Cost and time and the Overview show the two budgets apart, each with what counts against it', async () => {
    const r = await handle('/api/call', { method: 'POST', body: JSON.stringify({ action: 'cost.get', repo: 'acme/soil-sensor' }) })
    const c = (await r.json()).result as CostView
    render(wrap(<Budgets cost={c} id="acme~soil-sensor" />))
    const build = screen.getByRole('region', { name: 'Build budget' })
    expect(build).toHaveTextContent('US$200')
    expect(build).toHaveTextContent('US$80 to spare')
    expect(build).toHaveTextContent('10 boards at US$12 each, the build plan\'s target unit cost')
    expect(build).toHaveTextContent('trace\'s cloud work is not in it')
    const cloud = screen.getByRole('region', { name: 'Cloud-work allowance' })
    expect(cloud).toHaveTextContent('US$60')
    expect(cloud).toHaveTextContent('US$21.88 left')
    expect(cloud).toHaveTextContent('US$38.12')
  })

  it('says so when no cloud-work allowance is set, and never reads the build budget as one', () => {
    render(wrap(<Budgets cost={{ money: true, currency: 'USD', spent: { cloud: 41.66, orders: 0 }, committed: 0, forecast: 80, budget: 100, quantity: 10, unit_cost: 8, stages: [], lines: [] }} id="x" />))
    expect(screen.getByRole('region', { name: 'Cloud-work allowance' })).toHaveTextContent('No allowance set')
    expect(screen.getByRole('region', { name: 'Build budget' })).toHaveTextContent('US$20 to spare')
  })
})

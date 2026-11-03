import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handle } from '@/mock/handlers'
import type { HealthView, RunSummary } from '@/lib/types'
import { BuildHealth, fixingWords, showsHealth } from './build-health'

const build = (o: Partial<HealthView['build']> = {}): HealthView['build'] => ({ state: 'failing', sha: 'a'.repeat(40), at: null, failing: [{ job_id: 1, name: 'erc', step: 'Run ERC', tail: 'x' }], why: 'w', fixing: { job_id: 'j', attempt: 1, of: 3 }, ...o })

describe('the words', () => {
  it('shows only for a failing build, or one running again after a failure', () => {
    expect(showsHealth({ build: build(), asks: [] })).toBe(true)
    expect(showsHealth({ build: build({ state: 'running' }), asks: [] })).toBe(true)
    expect(showsHealth({ build: build({ state: 'running', failing: [] }), asks: [] })).toBe(false)
    expect(showsHealth({ build: build({ state: 'passing', failing: [] }), asks: [] })).toBe(false)
    expect(showsHealth(undefined)).toBe(false)
  })

  it('says what trace is doing about it', () => {
    const running: RunSummary = { id: 'j', title: 't', state: 'running' }
    expect(fixingWords(build(), running)).toBe('trace is fixing it (try 1 of 3).')
    expect(fixingWords(build({ fixing: { job_id: 'j', attempt: 3, of: 3 } }), { ...running, state: 'failed' })).toMatch(/tried 3 times and stopped\. It is under Needs you/)
    expect(fixingWords(build({ fixing: null }))).toMatch(/not started on it yet/)
    expect(fixingWords(build({ state: 'running' }))).toBe('trace is checking the build again now.')
  })
})

describe('the build card, with the mock API', () => {
  afterEach(() => { vi.restoreAllMocks() })
  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const sent: Record<string, unknown>[] = []
  const mock = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return handle(String(url), init)
  })

  async function show(ui: ReactNode) {
    const root = createRootRoute()
    const page = createRoute({ getParentRoute: () => root, path: '/', component: () => ui })
    const agent = createRoute({ getParentRoute: () => root, path: '/agents/$agent', component: () => <p>agent page</p> })
    const router = createRouter({ routeTree: root.addChildren([page, agent]), history: createMemoryHistory({ initialEntries: ['/'] }) })
    await act(async () => { render(<QueryClientProvider client={client()}><RouterProvider router={router as never} /></QueryClientProvider>) })
  }

  it('a failing build: red card, Failing, the reason, the log extract, the whole log, and Watch trace fix it', async () => {
    mock()
    const jobs: RunSummary[] = [{ id: 'job_v1', title: 'Fix the build', state: 'running', agent: 'verify' }]
    await show(<BuildHealth repo="acme/soil-sensor" jobs={jobs} write />)
    const card = await screen.findByTestId('build-health')
    expect(card.className).toMatch(/border-destructive/)
    expect(within(card).getByText('Failing')).toBeInTheDocument()
    expect(within(card).getByText(/failed at its step "Check the schematic \(ERC\)"/)).toBeInTheDocument()
    expect(within(card).getByText('trace is fixing it (try 2 of 3).')).toBeInTheDocument()
    expect(within(card).getByTestId('log-extract').textContent).toMatch(/Symbol U3 Pin 4[\s\S]*Error: Process completed with exit code 5\.$/)
    // no GitHub link for someone who is not an admin
    expect(card.querySelector('a[href^="https://github.com"]')).toBeNull()
    expect(within(card).getByRole('link', { name: 'Watch trace fix it' })).toHaveAttribute('href', '/agents/verify')

    await userEvent.click(within(card).getByRole('button', { name: 'Read the whole log' }))
    const whole = await screen.findByTestId('whole-log')
    expect(whole.textContent).toMatch(/^Setting up the runner: step 1 of 120/)
    expect(sent).toContainEqual({ action: 'health.log', repo: 'acme/soil-sensor', job_id: 31001 })

    // the fixes asked for, with where each stands
    expect(screen.getByText('The power light is too bright on the bench')).toBeInTheDocument()
    expect(screen.getByText('trace gave up: see Needs you')).toBeInTheDocument()
  })

  it('a passing build shows no card; Ask trace to fix something starts a task and shows the job', async () => {
    mock()
    await show(<BuildHealth repo="acme/panel-controller" jobs={[]} write />)
    const ask = await screen.findByRole('button', { name: /Ask trace to fix something/ })
    expect(screen.queryByTestId('build-health')).toBeNull()
    await userEvent.click(ask)
    const send = screen.getByRole('button', { name: 'Ask trace' })
    expect(send).toBeDisabled()
    await userEvent.type(screen.getByLabelText('What should trace fix?'), 'Make the power light half as bright.')
    await userEvent.click(send)
    await waitFor(() => expect(sent).toContainEqual({ action: 'task', repo: 'acme/panel-controller', request: 'Make the power light half as bright.' }))
    expect(await screen.findByText('Make the power light half as bright.')).toBeInTheDocument()
  })

  it('a reviewer with nothing to show sees nothing', async () => {
    mock()
    await show(<div data-testid="page"><BuildHealth repo="acme/panel-controller" jobs={[]} write={false} /></div>)
    await waitFor(() => expect(sent.some((s) => s.action === 'health.get' && s.repo === 'acme/panel-controller')).toBe(true))
    expect(screen.getByTestId('page')).toBeEmptyDOMElement()
  })
})

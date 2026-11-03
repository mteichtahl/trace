import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TaskConfirmCard } from '@/components/chat/cards'
import { QualityBar } from '@/components/quality-bar'
import { auth } from '@/lib/auth'
import type { AgentSetup } from '@/lib/types'
import { AgentSetupNotice, UpdateProgress, agentBlocked, lookWords, minutesLeft, notReady, openLabel, setupLookEvery, setupWords, stepsDone } from './agent-setup'

const NOW = Date.parse('2026-11-02T10:00:00Z')
const setup = (o: Partial<AgentSetup> = {}): AgentSetup => ({
  repo: 'acme/new', ready: false, state: 'setting_up', text: 'The installation update is running: it tests trace and then deploys this project\'s agent.',
  requested_at: '2026-11-02T09:40:00Z', update: { status: 'running', started_at: '2026-11-02T09:41:00Z', url: 'https://github.com/mteichtahl/trace/actions/runs/1' },
  expected_by: '2026-11-02T10:41:00Z', next_check_s: 60, ...o,
})

describe('the words of the notice', () => {
  it('says trace is setting up the agent, that answers cannot be saved until then, and about when it is ready', () => {
    const w = setupWords(setup(), NOW)
    expect(w.title).toBe('trace is setting up this project\'s agent')
    expect(w.body).toMatch(/^Until it is ready, trace can't save your answers, run this project's tools or start work here\. The installation update is running/)
    expect(w.when).toMatch(/^Usually ready by about \d\d:\d\d\.$/)
    expect(setupWords(setup({ expected_by: null }), NOW).when).toBe('Usually ready within the hour.')
    // past the estimate: the API's text says it is taking longer; no time in the past is promised
    expect(setupWords(setup({ expected_by: '2026-11-02T09:00:00Z' }), NOW).when).toBeNull()
  })

  it('a failed or missing agent: names who can fix it, and promises no time', () => {
    expect(setupWords(setup({ state: 'failed' }), NOW)).toMatchObject({ title: 'This project\'s agent could not be set up yet', when: null })
    expect(setupWords(setup({ state: 'missing' }), NOW).title).toBe('This project has no agent in this installation yet')
  })

  it('when the app looks again: the API\'s time while it is being set up, never once it is ready', () => {
    expect(setupLookEvery(setup())).toBe(60_000)
    expect(setupLookEvery(setup({ ready: true, state: 'ready', next_check_s: null }))).toBe(false)
    expect(setupLookEvery(undefined)).toBe(false)
    expect(lookWords('next look in 40 s')).toBe('trace looks again in 40 s.')
    expect(lookWords('looking now')).toBe('trace is looking now.')
  })

  it('what waits for the agent: only an answer that says it is not ready', () => {
    expect(notReady(setup())).toBe(true)
    expect(notReady({ ready: true })).toBe(false)
    expect(notReady(undefined)).toBe(false)
    expect(notReady({ unexpected: 1 })).toBe(false)
    expect(agentBlocked(setup())).toBe('trace is still setting up this project\'s agent. This can be sent once it is ready.')
    expect(agentBlocked(setup({ state: 'missing' }))).toMatch(/An admin can add it by running the installer/)
    expect(agentBlocked(undefined)).toBeNull()
  })

  it('New project\'s last button says what happens', () => {
    expect(openLabel(true)).toBe('Open project — trace is still setting up its agent')
    expect(openLabel(false)).toBe('Open project')
  })
})

describe('the notice', () => {
  let qc: QueryClient
  beforeEach(() => { qc = new QueryClient({ defaultOptions: { queries: { retry: false } } }) })
  afterEach(() => { vi.restoreAllMocks(); qc.clear() })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  const answer = (body: unknown) => new Response(JSON.stringify({ ok: true, result: body }), { status: 200, headers: { 'content-type': 'application/json' } })

  it('shows while the agent is being set up, with when trace looks again and Check now; clears itself once it is ready', async () => {
    let ready = false
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer(ready ? setup({ ready: true, state: 'ready', next_check_s: null }) : setup({ expected_by: new Date(Date.now() + 30 * 60_000).toISOString() })))
    render(<AgentSetupNotice repo="acme/new" />, { wrapper })
    expect(await screen.findByText('trace is setting up this project\'s agent')).toBeInTheDocument()
    expect(screen.getByText(/trace can't save your answers/)).toBeInTheDocument()
    expect(screen.getByText(/Usually ready by about/)).toBeInTheDocument()
    expect(screen.getByText(/trace looks again in \d+ s\./)).toBeInTheDocument()
    expect(JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body))).toEqual({ action: 'project.agent', repo: 'acme/new' })
    ready = true
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(screen.queryByText('trace is setting up this project\'s agent')).toBeNull())
  })

  it('draws nothing for a project whose agent is set up', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer(setup({ ready: true, state: 'ready', next_check_s: null })))
    const { container } = render(<AgentSetupNotice repo="acme/old" />, { wrapper })
    await waitFor(() => expect(qc.getQueryState(['project.agent', 'acme/old', { repo: 'acme/old' }])?.status).toBe('success'))
    expect(container).toBeEmptyDOMElement()
  })
})

describe('the update\'s progress', () => {
  afterEach(() => { auth.set((s) => ({ ...s, user: null })) })
  const steps = [
    { name: 'Test', state: 'done' as const }, { name: 'Deploy', state: 'running' as const }, { name: 'Mark the projects added', state: 'waiting' as const }, { name: 'Notify', state: 'waiting' as const },
  ]

  it('how far, and the time left from the estimate', () => {
    expect(stepsDone(steps)).toBe(1.5 / 4)
    expect(stepsDone([])).toBeNull()
    expect(minutesLeft('2026-11-02T10:25:00Z', NOW)).toBe('about 25 min left')
    expect(minutesLeft('2026-11-02T09:00:00Z', NOW)).toBeNull()
    expect(minutesLeft(null, NOW)).toBeNull()
  })

  it('shows each step with its state and a bar; on failure the failing step\'s last lines', () => {
    const { rerender } = render(<UpdateProgress setup={setup({ update: { status: 'running', started_at: '2026-11-02T09:41:00Z', steps } })} />)
    expect(screen.getByRole('progressbar', { name: 'The installation update' })).toHaveAttribute('aria-valuenow', '38')
    expect(screen.getByText('Deploy').parentElement).toHaveTextContent('Deploy: running')
    expect(screen.getByText('Notify').parentElement).toHaveTextContent('Notify: waiting')
    rerender(<UpdateProgress setup={setup({ update: { status: 'failed', started_at: '2026-11-02T09:41:00Z', steps: [{ name: 'Deploy', state: 'failed' }], failed_log: 'Error: limit reached' } })} />)
    expect(screen.getByText('Deploy').parentElement).toHaveTextContent('Deploy: failed')
    expect(screen.getByText('Error: limit reached')).toBeInTheDocument()
  })

  it('the run\'s page on GitHub is never a link for someone who is not an admin', async () => {
    let qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: setup({ update: { status: 'running', started_at: '2026-11-02T09:41:00Z', url: 'https://github.com/mteichtahl/trace/actions/runs/1', steps } }) }), { status: 200, headers: { 'content-type': 'application/json' } }))
    auth.set((s) => ({ ...s, user: { sub: 'u', email: 'u@x', groups: [], class: 'user' } as never }))
    const { unmount } = render(<AgentSetupNotice repo="acme/new" />, { wrapper: wrap })
    expect(await screen.findByText('Deploy')).toBeInTheDocument()
    expect(document.querySelector('a[href*="github.com"]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
    unmount()
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    auth.set((s) => ({ ...s, user: { sub: 'a', email: 'a@x', groups: [], class: 'admin' } as never }))
    render(<AgentSetupNotice repo="acme/new" />, { wrapper: wrap })
    expect(await screen.findByRole('button', { name: 'More' })).toBeInTheDocument()
    vi.restoreAllMocks()
  })
})

describe('what waits for the agent', () => {
  it('the quality bar keeps Submit disabled with the reason, even with every check met', () => {
    const { rerender } = render(<TooltipProvider><QualityBar checks={[{ id: 'a', text: 'Purpose stated', status: 'met' }]} onSubmit={() => undefined} submitLabel="Submit intent" blocked={agentBlocked(setup())} /></TooltipProvider>)
    for (const b of screen.getAllByRole('button', { name: 'Submit intent' })) expect(b).toBeDisabled()
    expect(screen.getAllByText(/Waits for the project's agent/).length).toBeGreaterThan(0)
    rerender(<TooltipProvider><QualityBar checks={[{ id: 'a', text: 'Purpose stated', status: 'met' }]} onSubmit={() => undefined} submitLabel="Submit intent" blocked={null} /></TooltipProvider>)
    for (const b of screen.getAllByRole('button', { name: 'Submit intent' })) expect(b).toBeEnabled()
  })

  it('a chat\'s Confirm and start waits, and says why', () => {
    render(<TaskConfirmCard task={{ repo: 'acme/new', request: 'Draft the requirements' }} blocked={agentBlocked(setup())} onConfirm={() => undefined} onCancel={() => undefined} />)
    expect(screen.getByRole('button', { name: /Confirm and start/ })).toBeDisabled()
    expect(screen.getByText('trace is still setting up this project\'s agent. This can be sent once it is ready.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })
})

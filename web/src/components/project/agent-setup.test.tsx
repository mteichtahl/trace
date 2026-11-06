import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskConfirmCard } from '@/components/chat/cards'
import { auth } from '@/lib/auth'
import type { AgentSetup } from '@/lib/types'
import { AgentSetupNotice, UpdateProgress, agentQueueNote, createdTitle, lookLine, lookWords, minutesLeft, notReady, openLabel, setupLookEvery, setupWords, stepsDone } from './agent-setup'

const NOW = Date.parse('2026-11-02T10:00:00Z')
const setup = (o: Partial<AgentSetup> = {}): AgentSetup => ({
  repo: 'acme/new', ready: false, state: 'setting_up', text: 'The installation update is running: it tests trace and then deploys this project\'s agent.',
  requested_at: '2026-11-02T09:40:00Z', update: { status: 'running', started_at: '2026-11-02T09:41:00Z', url: 'https://github.com/mteichtahl/trace/actions/runs/1' },
  expected_by: '2026-11-02T10:41:00Z', next_check_s: 60, ...o,
})

describe('the words of the notice', () => {
  it('says trace is setting up the agent, that work asked for meanwhile is queued, and about when it is ready', () => {
    const w = setupWords(setup(), NOW)
    expect(w.title).toBe('trace is setting up this project\'s agent')
    expect(w.body).toMatch(/^You can carry on: write and submit the intent, or ask trace for work, and trace queues it and starts it once the agent is ready\. Until then it can't run this project's tools or remember what you tell it\. The installation update is running/)
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

  it('what it says of its own looks is what happened: "looking now" only while it looks (log #5: it said so for half an hour)', () => {
    const at = NOW - 30 * 60_000
    const base = { every: 60_000, fetching: false, updatedAt: NOW - 20_000, failedAt: 0, error: null, now: NOW }
    expect(lookLine(base)).toBe('trace looks again in 40 s.')
    expect(lookLine({ ...base, fetching: true })).toBe('trace is looking now.')
    // past its time and nothing looking (a tab the browser held back): when it last looked, not "looking now"
    const stale = lookLine({ ...base, updatedAt: at })
    expect(stale).toMatch(/^trace last looked at \d\d:\d\d\.$/)
    // a look that failed: said, with what is shown and from when, and when it tries again
    const failed = lookLine({ ...base, updatedAt: at, failedAt: NOW - 10_000, error: 'You are making requests too quickly.' })
    expect(failed).toMatch(/^trace could not look just now \(You are making requests too quickly\)\. What is shown is from \d\d:\d\d\. It tries again in 50 s\.$/)
    // a good look after the failed one: the failure is behind it
    expect(lookLine({ ...base, failedAt: NOW - 50_000, error: 'gone' })).toBe('trace looks again in 40 s.')
    expect(lookLine({ ...base, every: false })).toBeNull()
  })

  it('what waits for the agent: only an answer that says it is not ready', () => {
    expect(notReady(setup())).toBe(true)
    expect(notReady({ ready: true })).toBe(false)
    expect(notReady(undefined)).toBe(false)
    expect(notReady({ unexpected: 1 })).toBe(false)
    // work is queued while it is set up, never refused (log #2, #80)
    expect(agentQueueNote(setup())).toBe('trace is still setting up this project\'s agent: the work is queued, and starts by itself once the agent is ready.')
    expect(agentQueueNote(setup({ state: 'missing' }))).toMatch(/queued, and starts once an admin adds the agent by running the installer/)
    expect(agentQueueNote(undefined)).toBeNull()
  })

  it('New project\'s last button says what happens', () => {
    expect(openLabel(true)).toBe('Open project — trace is still setting up its agent')
    expect(openLabel(false)).toBe('Open project')
  })

  it('New project\'s finished screen says "ready" only once the agent is (log #3)', () => {
    expect(createdTitle('test-esp32', true)).toBe('test-esp32 is created; its agent is being set up')
    expect(createdTitle('test-esp32', false)).toBe('test-esp32 is ready')
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
    expect(screen.getByText(/trace queues it and starts it once the agent is ready/)).toBeInTheDocument()
    expect(screen.getByText(/Usually ready by about/)).toBeInTheDocument()
    expect(screen.getByText(/trace looks again in \d+ s\./)).toBeInTheDocument()
    expect(JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body))).toEqual({ action: 'project.agent', repo: 'acme/new' })
    ready = true
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(screen.queryByText('trace is setting up this project\'s agent')).toBeNull())
  })

  it('looks again as soon as the person comes back to the tab, where a hidden tab polls nothing (log #5); not once it is ready', async () => {
    let ready = false
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer(ready ? setup({ ready: true, state: 'ready', next_check_s: null }) : setup()))
    // the app's own default (main.tsx): no look on focus, unless a query asks for one
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
    render(<AgentSetupNotice repo="acme/new" />, { wrapper })
    expect(await screen.findByText('trace is setting up this project\'s agent')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
    ready = true
    try {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
      await waitFor(() => expect(screen.queryByText('trace is setting up this project\'s agent')).toBeNull())
      expect(fetch).toHaveBeenCalledTimes(2)
      focusManager.setFocused(false)
      focusManager.setFocused(true)
      await new Promise((r) => setTimeout(r, 20))
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      focusManager.setFocused(undefined)
    }
  })

  it('a tab in the background still looks at the API\'s time, and the notice moves on with the update as it happens (log #5)', async () => {
    const answers = [
      setup({ text: 'The installation update is waiting for its turn to start.', update: { status: 'queued', started_at: '2026-11-02T09:41:00Z', steps: [{ name: 'Deploy', state: 'waiting' }] }, next_check_s: 1 }),
      setup({ update: { status: 'running', started_at: '2026-11-02T09:41:00Z', steps: [{ name: 'Deploy', state: 'running' }] }, next_check_s: 1 }),
      setup({ ready: true, state: 'ready', next_check_s: null }),
    ]
    let i = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer(answers[Math.min(i++, answers.length - 1)]))
    qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
    try {
      focusManager.setFocused(false)
      render(<AgentSetupNotice repo="acme/new" />, { wrapper })
      expect(await screen.findByText('Deploy')).toBeInTheDocument()
      expect(screen.getByText('Deploy').parentElement).toHaveTextContent('Deploy: waiting')
      await waitFor(() => expect(screen.getByText('Deploy').parentElement).toHaveTextContent('Deploy: running'), { timeout: 3000 })
      await waitFor(() => expect(screen.queryByText('trace is setting up this project\'s agent')).toBeNull(), { timeout: 3000 })
    } finally {
      focusManager.setFocused(undefined)
    }
  })

  it('a look that fails is said, with what is shown and from when; never "looking now" while nothing looks', async () => {
    let fail = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (fail
      ? new Response(JSON.stringify({ ok: false, error: 'trace is busy; try again in a minute.' }), { status: 503, headers: { 'content-type': 'application/json' } })
      : answer(setup())))
    render(<AgentSetupNotice repo="acme/new" />, { wrapper })
    expect(await screen.findByText(/trace looks again in \d+ s\./)).toBeInTheDocument()
    fail = true
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText(/^trace could not look just now \(.+\)\. What is shown is from \d\d:\d\d\. It tries again in \d+ s\.$/)).toBeInTheDocument()
    // what was known stays on screen
    expect(screen.getByText('trace is setting up this project\'s agent')).toBeInTheDocument()
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
  // nothing waits on a disabled button while the agent is set up: the API queues the work (test-esp32 log #2, #80)
  it('a chat\'s Confirm and start goes ahead, and says the work is queued', () => {
    const confirm = vi.fn()
    render(<TaskConfirmCard task={{ repo: 'acme/new', request: 'Draft the requirements' }} note={agentQueueNote(setup())} onConfirm={confirm} onCancel={() => undefined} />)
    const b = screen.getByRole('button', { name: /Confirm and start/ })
    expect(b).toBeEnabled()
    expect(b).toHaveAccessibleDescription('trace is still setting up this project\'s agent: the work is queued, and starts by itself once the agent is ready.')
    fireEvent.click(b)
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('the notice says what the person can do now, not only what waits', () => {
    const w = setupWords(setup(), NOW)
    expect(w.body).toMatch(/^You can carry on: write and submit the intent, or ask trace for work, and trace queues it and starts it once the agent is ready\./)
    expect(w.body).not.toMatch(/can't start work/)
  })
})

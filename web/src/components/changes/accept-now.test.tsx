/**
 * The Overview's "Accept now" (test-esp32 #185, #203: a click that did nothing anyone could see, while the change page
 * then merged the same change at once). It accepts as Needs you does: change.get read again at the click (a copy kept in
 * the cache can carry a head a "bring up to date" since moved), then change.accept with that head. From the click until
 * the API answers the button says "Accepting…" with a spinner and takes no second click; a refusal is said on the card,
 * in the API's words, and in a toast. Nothing is dropped without a word.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextStepCard } from '@/components/next-step-card'
import { ApiError, call } from '@/lib/api'
import type { InboxItem, NextStep } from '@/lib/types'
import { acceptLatest, refusalWords, useAcceptFromInbox, useAcceptNow } from './use-change-actions'

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), call: vi.fn() }))
vi.mock('./after-accept', () => ({ showAfterAccept: vi.fn() }))
const toasts: string[] = []
vi.mock('sonner', () => ({
  toast: Object.assign((t: string) => { toasts.push(t) }, {
    success: (t: string, o?: { description?: string }) => { toasts.push(`${t}: ${o?.description ?? ''}`) },
    warning: (t: string) => { toasts.push(`warning: ${t}`) },
    error: (t: string, o?: { description?: string }) => { toasts.push(`error: ${t}: ${o?.description ?? ''}`) },
  }),
}))
const mockCall = vi.mocked(call)

const REPO = 'acme/soil-sensor'
const SHOWN = 'a'.repeat(40)
const NOW = 'b'.repeat(40)
const change = (o: Record<string, unknown> = {}) => ({ number: 12, title: 'Power sheet', state: 'open', may_accept: true, blockers: [], head: { ref: 'claude/task-12', sha: NOW }, ...o })
const step: NextStep = {
  kind: 'review', owner: 'you', summary: 'trace finished the power sheet. Review it and accept it into the design.',
  // its link needs the router; the card's own button is what is under test
  action: { label: 'Review the change' }, ref: { kind: 'change', id: '12' },
}
const client = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // the copy the Overview was drawn from: the head before a "bring up to date" moved it
  qc.setQueryData(['change.get', REPO, { repo: REPO, number: 12 }], change({ head: { ref: 'claude/task-12', sha: SHOWN } }))
  return qc
}

/** The Overview's wiring of the card, as routes/_app/p/$id/index.tsx does it. */
function Card() {
  const a = useAcceptNow(REPO)
  return <NextStepCard step={step} onAccept={() => a.run({ number: 12, title: 'Power sheet', step: { index: 3, total: 5, stage: 'Capture' } })} accepting={a.busy} acceptRefused={a.refused?.number === 12 ? a.refused.text : null} />
}
const show = (qc = client()) => render(<QueryClientProvider client={qc}><Card /></QueryClientProvider>)

/** change.accept held until `release` is called, so the in-between can be looked at. */
function held() {
  let release!: (v: unknown) => void
  const answer = new Promise((ok) => { release = ok })
  return { answer, release: () => release({ merged: true, sha: 'm', stage: 'capture', next: 'trace checks stock for 10 boards.' }) }
}

beforeEach(() => {
  toasts.length = 0
  mockCall.mockReset()
  mockCall.mockImplementation((async (action: string) => {
    if (action === 'change.get') return change()
    if (action === 'change.accept') return { merged: true, sha: 'm', stage: 'capture', next: 'trace checks stock for 10 boards.' }
    return {}
  }) as never)
})

describe('Accept now on the Overview', () => {
  it('reads the change again and accepts the head it says now, not the copy the card was drawn from', async () => {
    show()
    await userEvent.click(screen.getByRole('button', { name: 'Accept now' }))
    await waitFor(() => expect(mockCall).toHaveBeenCalledWith('change.accept', { repo: REPO, number: 12, head_sha: NOW }))
    const order = mockCall.mock.calls.map((c) => c[0])
    expect(order).toEqual(['change.get', 'change.accept'])
    await waitFor(() => expect(toasts).toEqual(['Accepted into the design: Capture is now on step 4 of 5. trace checks stock for 10 boards.']))
  })

  it('shows its progress from the click until the API answers, and takes no second click meanwhile', async () => {
    const h = held()
    mockCall.mockImplementation((async (action: string) => (action === 'change.get' ? change() : h.answer)) as never)
    show()
    await userEvent.click(screen.getByRole('button', { name: 'Accept now' }))
    const busy = await screen.findByRole('button', { name: 'Accepting…' })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(busy)
    expect(mockCall.mock.calls.filter((c) => c[0] === 'change.accept')).toHaveLength(1)
    h.release()
    await waitFor(() => expect(toasts[0]).toMatch(/^Accepted into the design/))
    expect(screen.getByRole('button', { name: 'Accept now' })).toBeEnabled()
  })

  it('a refusal from the API is said on the card and in a toast, in its own words', async () => {
    const why = 'GitHub is not ready to merge it yet (it says: Required status check "erc" is expected). trace tried for 19 seconds; nothing changed. Accept it again in a minute.'
    mockCall.mockImplementation((async (action: string) => {
      if (action === 'change.get') return change()
      throw new ApiError(why, 200)
    }) as never)
    show()
    await userEvent.click(screen.getByRole('button', { name: 'Accept now' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(`Not accepted: ${why} Nothing changed.`)
    expect(toasts).toEqual([`error: Could not accept the change: ${why} Nothing changed.`])
    // it can be tried again, and the old reason goes while it is
    const h = held()
    mockCall.mockImplementation((async (action: string) => (action === 'change.get' ? change() : h.answer)) as never)
    await userEvent.click(screen.getByRole('button', { name: 'Accept now' }))
    await screen.findByRole('button', { name: 'Accepting…' })
    expect(screen.queryByRole('alert')).toBeNull()
    h.release()
    await waitFor(() => expect(toasts.at(-1)).toMatch(/^Accepted into the design/))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a change the read says cannot be accepted now (a "bring up to date" running) is not sent, and the blockers are said', async () => {
    mockCall.mockImplementation((async (action: string) => (action === 'change.get'
      ? change({ may_accept: false, blockers: ['trace is bringing it up to date with the design; accept it once its checks pass again.'] })
      : { merged: true })) as never)
    show()
    await userEvent.click(screen.getByRole('button', { name: 'Accept now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not accepted: It cannot be accepted now. trace is bringing it up to date with the design; accept it once its checks pass again. Nothing changed.')
    expect(mockCall.mock.calls.map((c) => c[0])).toEqual(['change.get'])
  })

  it('a read that fails is said too, and nothing is sent', async () => {
    mockCall.mockImplementation((async (action: string) => {
      if (action === 'change.get') throw new ApiError('GitHub did not answer in time', 200)
      return { merged: true }
    }) as never)
    show()
    await userEvent.click(screen.getByRole('button', { name: 'Accept now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not accepted: GitHub did not answer in time. Nothing changed.')
    expect(mockCall.mock.calls.map((c) => c[0])).toEqual(['change.get'])
  })
})

describe('acceptLatest', () => {
  it('says a change already accepted, or discarded, rather than sending it', async () => {
    const qc = client()
    mockCall.mockImplementation((async () => change({ state: 'merged' })) as never)
    await expect(acceptLatest(qc, REPO, 12)).rejects.toThrow('It is already accepted.')
    mockCall.mockImplementation((async () => change({ state: 'closed' })) as never)
    await expect(acceptLatest(qc, REPO, 12)).rejects.toThrow('It was discarded, so there is nothing to accept.')
    mockCall.mockImplementation((async () => change({ head: { ref: '', sha: '' } })) as never)
    await expect(acceptLatest(qc, REPO, 12)).rejects.toThrow(/could not read which version of it to accept/)
    expect(mockCall.mock.calls.map((c) => c[0])).not.toContain('change.accept')
  })

  it('refusalWords: the reason, ended once, then that nothing changed', () => {
    expect(refusalWords(new Error('It changed since you looked at it. Look again before accepting.'))).toBe('It changed since you looked at it. Look again before accepting. Nothing changed.')
    expect(refusalWords(new Error('no access'))).toBe('no access. Nothing changed.')
    expect(refusalWords(new Error(''))).toBe('trace did not say why. Nothing changed.')
  })
})

describe('Accept from Needs you', () => {
  it('an item with no change is said, not dropped', async () => {
    const qc = client()
    let run: ReturnType<typeof useAcceptFromInbox>['run'] | undefined
    function Probe() { run = useAcceptFromInbox().run; return null }
    render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>)
    run!({ id: 'x', kind: 'review', project: 'Soil sensor' } as unknown as InboxItem, 'Power sheet')
    expect(toasts).toEqual(['error: Could not accept the change: This item names no change. Open it to review the change there.'])
    expect(mockCall).not.toHaveBeenCalled()
  })

  it('a refusal is said with the API\'s reason', async () => {
    mockCall.mockImplementation((async (action: string) => (action === 'change.get' ? change({ may_accept: false, blockers: ['Its checks are still running.'] }) : { merged: true })) as never)
    const qc = client()
    let run: ReturnType<typeof useAcceptFromInbox>['run'] | undefined
    function Probe() { run = useAcceptFromInbox().run; return null }
    render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>)
    run!({ id: 'review:12', kind: 'review', project: 'Soil sensor', change: { repo: REPO, number: 12 } } as unknown as InboxItem, 'Power sheet')
    await waitFor(() => expect(toasts).toEqual(['error: Could not accept the change: It cannot be accepted now. Its checks are still running. Nothing changed.']))
  })
})

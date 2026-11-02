/**
 * Accepting sends the head the person was shown (docs/guided-flow.md: change.accept's head_sha), wherever it is taken:
 * the review page and the next-step card pass change.get's head.sha to useChangeActions; a Needs you card, which shows
 * no change detail, reads change.get first and sends what that says. Also: the changes list polls no faster than every
 * 60 s while live events are connected, and a change's pictures are fetched only from https or the app's own origin.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call } from '@/lib/api'
import { POLL_LIVE_MS, liveStatus, pollEvery } from '@/lib/live'
import type { InboxItem } from '@/lib/types'
import { fetchable } from './change-file-view'
import { CHANGES_POLL_MS } from './changes-list'
import { useAcceptFromInbox, useChangeActions } from './use-change-actions'

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), call: vi.fn() }))
vi.mock('./after-accept', () => ({ showAfterAccept: vi.fn() }))
const mockCall = vi.mocked(call)

const SHOWN = 'a'.repeat(40)
const NOW = 'b'.repeat(40)
const wrapper = (qc: QueryClient) => ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

beforeEach(() => {
  mockCall.mockReset()
  mockCall.mockImplementation((async (action: string) => {
    if (action === 'change.get') return { number: 12, title: 'Power sheet', head: { ref: 'claude/task-12', sha: NOW } }
    if (action === 'change.accept') return { merged: true, sha: 'm', stage: 'capture', next: 'trace checks Capture.' }
    return {}
  }) as never)
})

describe('accepting sends the head that was shown', () => {
  it('the review page and the next-step card: the sha they displayed', async () => {
    const { result } = renderHook(() => useChangeActions('acme/soil-sensor'), { wrapper: wrapper(client()) })
    await act(async () => { await result.current.accept.mutateAsync({ number: 12, head: SHOWN, title: 'Power sheet', note: 'ok' }) })
    expect(mockCall).toHaveBeenCalledWith('change.accept', { repo: 'acme/soil-sensor', number: 12, head_sha: SHOWN, note: 'ok' })
  })

  it('Needs you: reads change.get first, and sends its head', async () => {
    const qc = client()
    // an older copy in the cache is not trusted: it is read again
    qc.setQueryData(['change.get', 'acme/soil-sensor', { repo: 'acme/soil-sensor', number: 12 }], { head: { sha: SHOWN } })
    const { result } = renderHook(() => useAcceptFromInbox(), { wrapper: wrapper(qc) })
    const item = { id: 'review:12', kind: 'review', project: 'Soil sensor', change: { repo: 'acme/soil-sensor', number: 12 } } as unknown as InboxItem
    act(() => { result.current.run(item, 'Power sheet') })
    await waitFor(() => expect(mockCall).toHaveBeenCalledWith('change.accept', { repo: 'acme/soil-sensor', number: 12, head_sha: NOW }))
    const order = mockCall.mock.calls.map((c) => c[0])
    expect(order.indexOf('change.get')).toBeLessThan(order.indexOf('change.accept'))
  })
})

describe('what a look costs', () => {
  it('the changes list polls every 30 s offline, never faster than 60 s while live', () => {
    liveStatus.set((s) => ({ ...s, state: 'live' }))
    expect(pollEvery(CHANGES_POLL_MS)).toBe(POLL_LIVE_MS)
    expect(POLL_LIVE_MS).toBe(60_000)
    liveStatus.set((s) => ({ ...s, state: 'offline' }))
    expect(pollEvery(CHANGES_POLL_MS)).toBe(30_000)
  })

  it('a change\'s pictures come only from https or the app\'s own origin', () => {
    const origin = 'https://app.example.com'
    expect(fetchable('https://raw.githubusercontent.com/a/b/x.png', origin)).toBe(true)
    expect(fetchable(`${origin}/x.png`, origin)).toBe(true)
    expect(fetchable('blob:https://app.example.com/1234', origin)).toBe(true)
    expect(fetchable('http://evil.example.com/x.png', origin)).toBe(false)
    expect(fetchable('javascript:alert(1)', origin)).toBe(false)
    expect(fetchable('data:image/svg+xml,<svg/>', origin)).toBe(false)
    expect(fetchable('file:///etc/passwd', origin)).toBe(false)
  })
})

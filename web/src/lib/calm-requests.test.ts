import { afterEach, describe, expect, it, vi } from 'vitest'
import { coalescer, COALESCE_MS } from './live'
import { HttpError, RATE_LIMITED, request } from './http'
import { auth, bootstrap, UNREACHABLE_RETRY_MS } from './auth'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('a burst of live events', () => {
  it('makes each screen look again once, after the burst, not once per event', () => {
    vi.useFakeTimers()
    const asked: unknown[] = []
    const apply = coalescer({ invalidateQueries: (o: { queryKey: unknown }) => { asked.push(o.queryKey); return Promise.resolve() } } as never)
    for (let i = 0; i < 50; i++) apply({ type: 'job.updated', repo: 'a/b', id: 'j', state: 'running', at: '' } as never)
    expect(asked).toEqual([])
    vi.advanceTimersByTime(COALESCE_MS)
    expect(asked).toEqual([['job'], ['jobs.list', 'a/b'], ['journey.get', 'a/b'], ['tools.waits', 'a/b'], ['runs', 'a/b'], ['activity.list']])
  })
})

describe('a 429 from the web firewall', () => {
  it('is said in plain words', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 429 }))
    await expect(request('/api/config')).rejects.toMatchObject({ status: 429, code: 'rate_limited', message: RATE_LIMITED })
    expect(new HttpError(RATE_LIMITED, 429).message).toMatch(/too many requests from your network/)
  })

  it('on load is "unreachable", not signed out, and trace looks again later', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls++; return new Response('', { status: 429 }) })
    auth.set({ status: 'unknown', user: null, accessToken: null, idToken: null, expiresAt: null, sessionEnded: false })
    await bootstrap()
    expect(auth.get()).toMatchObject({ status: 'unreachable', sessionEnded: false, unreachable: RATE_LIMITED })
    expect(calls).toBe(1)
    vi.stubGlobal('fetch', async () => { calls++; return new Response(JSON.stringify({ accessToken: 'a', idToken: 'i', expiresIn: 3600, user: { sub: 's', email: 'e', name: 'n', class: 'member' } }), { status: 200 }) })
    await vi.advanceTimersByTimeAsync(UNREACHABLE_RETRY_MS)
    vi.useRealTimers()
    await vi.waitFor(() => expect(auth.get().status).toBe('signed-in'))
    expect(calls).toBe(2)
  })
})

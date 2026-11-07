import { afterEach, describe, expect, it, vi } from 'vitest'
import { coalescer, COALESCE_MS } from './live'
import { HttpError, RATE_LIMITED, UPDATING, isUpdating, request, statusWords } from './http'
import { ApiError, UPDATING_DELAYS_MS, readRetry, readRetryDelay } from './api'
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

describe('trace updating (test-esp32 #223: a bare "424" while the API was redeployed)', () => {
  it('an answer with a status and none of trace\'s words is said in words, never as a bare status', async () => {
    for (const status of [424, 502, 503, 504]) {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ message: 'Received error from runtime' }), { status }))
      const e = await request('/api/call', { method: 'POST', body: {} }).catch((x: unknown) => x)
      expect(e).toMatchObject({ status, code: 'updating', message: UPDATING })
      expect(isUpdating(e)).toBe(true)
    }
    vi.stubGlobal('fetch', async () => new Response('<html>oops</html>', { status: 500 }))
    const e = await request('/api/call', { method: 'POST', body: {} }).catch((x: unknown) => x) as Error
    expect(e.message).toMatch(/^trace's service had a problem answering \(HTTP 500\)\. Try again/)
    expect(statusWords(418)).toBe('trace could not do that (HTTP 418).')
  })

  it('trace\'s own words with those statuses are kept, and its codes count as updating', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: false, error: 'trace is updating, so it could not answer just now. Try again in a minute.', code: 'api_updating' }), { status: 503 }))
    const e = await request('/api/call', { method: 'POST', body: {} }).catch((x: unknown) => x)
    expect(e).toMatchObject({ status: 503, code: 'api_updating' })
    expect(isUpdating(e)).toBe(true)
    expect(isUpdating(new ApiError('no access', 403))).toBe(false)
  })

  it('a screen\'s read tries again for about a minute while trace is updating; twice for anything else; never a 429', () => {
    const up = new ApiError(UPDATING, 424, 'updating')
    expect(readRetry(UPDATING_DELAYS_MS.length - 1, up)).toBe(true)
    expect(readRetry(UPDATING_DELAYS_MS.length, up)).toBe(false)
    expect(UPDATING_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(55_000)
    expect(readRetryDelay(0, up)).toBe(UPDATING_DELAYS_MS[0])
    expect(readRetry(1, new ApiError('boom', 500))).toBe(true)
    expect(readRetry(2, new ApiError('boom', 500))).toBe(false)
    expect(readRetry(0, new ApiError(RATE_LIMITED, 429, 'rate_limited'))).toBe(false)
    expect(readRetry(0, new ApiError('no access', 403))).toBe(false)
  })
})

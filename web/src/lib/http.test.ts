import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call } from './api'
import { accept, auth, refresh } from './auth'
import { request, sha256Hex } from './http'

const hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

describe('the /api request', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('hashes like node (hex SHA-256, UTF-8)', async () => {
    expect(await sha256Hex('')).toBe(hex(''))
    expect(await sha256Hex('{"a":"µΩ"}')).toBe(hex('{"a":"µΩ"}'))
  })

  it('a POST carries x-amz-content-sha256 of its exact body', async () => {
    await request('/api/auth/start', { method: 'POST', body: { email: 'a@b.c' } })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['x-amz-content-sha256']).toBe(hex(String(init.body)))
    expect(headers['content-type']).toBe('application/json')
  })

  it('a GET carries no body hash', async () => {
    await request('/api/config')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-amz-content-sha256']).toBeUndefined()
  })

  it('call() adds the bearer token and the action', async () => {
    accept({ accessToken: 'tok', idToken: 'id', expiresIn: 3600, user: { sub: 's', email: 'e', class: 'user' } })
    await call('projects', {})
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/call')
    expect(JSON.parse(String(init.body))).toEqual({ action: 'projects' })
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect((init.headers as Record<string, string>)['x-amz-content-sha256']).toBe(hex(String(init.body)))
  })

  it('call() refreshes once on 401 and retries with the new token', async () => {
    accept({ accessToken: 'old', idToken: 'id', expiresIn: 3600, user: { sub: 's', email: 'e', class: 'user' } })
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'expired' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'new', idToken: 'id2', expiresIn: 3600, user: { sub: 's', email: 'e', class: 'user' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: ['x'] }), { status: 200 }))
    const r = await call('projects', {})
    expect(r).toEqual(['x'])
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/call', '/api/auth/refresh', '/api/call'])
    expect(((fetchMock.mock.calls[2] as [string, RequestInit])[1].headers as Record<string, string>).authorization).toBe('Bearer new')
    expect(auth.get().accessToken).toBe('new')
  })

  it('a refresh the backend could not answer (503, 429) keeps the session; only a 401 ends it', async () => {
    vi.useFakeTimers()
    try {
      const signedIn = () => accept({ accessToken: 'tok', idToken: 'id', expiresIn: 3600, user: { sub: 's', email: 'e', class: 'user' } })
      for (const status of [503, 429, 500]) {
        signedIn()
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'busy' }), { status }))
        expect(await refresh()).toBe(false)
        expect(auth.get()).toMatchObject({ status: 'signed-in', accessToken: 'tok', sessionEnded: false })
      }
      signedIn()
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'the session has ended: sign in again' }), { status: 401 }))
      expect(await refresh()).toBe(false)
      expect(auth.get()).toMatchObject({ status: 'signed-out', accessToken: null, sessionEnded: true })
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('call() throws the API error words', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'no access' }), { status: 403 }))
    await expect(call('journey.get', { repo: 'a/b' })).rejects.toMatchObject({ message: 'no access', noAccess: true })
  })
})

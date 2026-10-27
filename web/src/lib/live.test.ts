import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyEvent, connectLive, hostOf, invalidationsFor, liveStatus, subprotocols } from './live'

describe('live events → query invalidation', () => {
  it('maps each event to the queries it makes stale', () => {
    expect(invalidationsFor({ type: 'record.changed', repo: 'a/b', what: 'journey', at: '' })).toEqual([['journey.get', 'a/b'], ['inbox'], ['runs', 'a/b']])
    expect(invalidationsFor({ type: 'record.changed', repo: 'a/b', what: 'chats', at: '' })).toContainEqual(['chats.recall', 'a/b'])
    expect(invalidationsFor({ type: 'job.updated', repo: 'a/b', jobId: 'j', state: 'done', at: '' })).toContainEqual(['tools.waits', 'a/b'])
    expect(invalidationsFor({ type: 'notification', id: 'n', kind: 'gate', repo: 'a/b', summary: '', at: '' })).toEqual([['inbox'], ['journey.get', 'a/b']])
  })

  it('invalidates matching queries and leaves the others', async () => {
    const qc = new QueryClient()
    qc.setQueryData(['journey.get', 'a/b', { repo: 'a/b' }], { x: 1 })
    qc.setQueryData(['journey.get', 'c/d', { repo: 'c/d' }], { x: 2 })
    qc.setQueryData(['inbox', {}], [])
    applyEvent(qc, { type: 'record.changed', repo: 'a/b', what: 'journey', at: '' })
    expect(qc.getQueryState(['journey.get', 'a/b', { repo: 'a/b' }])?.isInvalidated).toBe(true)
    expect(qc.getQueryState(['inbox', {}])?.isInvalidated).toBe(true)
    expect(qc.getQueryState(['journey.get', 'c/d', { repo: 'c/d' }])?.isInvalidated).toBe(false)
  })
})

describe('the AppSync Events connection', () => {
  afterEach(() => vi.useRealTimers())

  it('authorizes with the host and id token in the subprotocol header', () => {
    const [p, h] = subprotocols('https://abc.appsync-api.ap-southeast-2.amazonaws.com/event', 'ID')
    expect(p).toBe('aws-appsync-event-ws')
    const json = atob(h!.slice('header-'.length).replace(/-/g, '+').replace(/_/g, '/'))
    expect(JSON.parse(json)).toEqual({ host: 'abc.appsync-api.ap-southeast-2.amazonaws.com', Authorization: 'ID' })
    expect(hostOf('https://x.y/event')).toBe('x.y')
  })

  it('inits, subscribes to the person channel, goes live and delivers events', () => {
    const sent: unknown[] = []
    let sock: FakeWS | null = null
    class FakeWS {
      readyState = 1
      onopen: (() => void) | null = null
      onmessage: ((m: { data: string }) => void) | null = null
      onclose: (() => void) | null = null
      constructor(public url: string, public protocols: string[]) {
        sock = this
      }
      send(s: string) {
        sent.push(JSON.parse(s))
      }
      close() {
        this.onclose?.()
      }
    }
    const events: unknown[] = []
    const stop = connectLive({ http: 'https://h.example/event', realtime: 'wss://r.example/event/realtime', channel: '/trace/users/sub-1', idToken: () => 'ID', onEvent: (e) => events.push(e), WebSocketImpl: FakeWS as unknown as typeof WebSocket })
    const s = sock as unknown as FakeWS
    expect(s.url).toBe('wss://r.example/event/realtime')
    s.onopen?.()
    expect(sent[0]).toEqual({ type: 'connection_init' })
    s.onmessage?.({ data: JSON.stringify({ type: 'connection_ack', connectionTimeoutMs: 300000 }) })
    expect(sent[1]).toMatchObject({ type: 'subscribe', channel: '/trace/users/sub-1', authorization: { host: 'h.example', Authorization: 'ID' } })
    s.onmessage?.({ data: JSON.stringify({ type: 'subscribe_success' }) })
    expect(liveStatus.get().state).toBe('live')
    s.onmessage?.({ data: JSON.stringify({ type: 'data', event: JSON.stringify({ type: 'notification', id: 'n', kind: 'gate', repo: 'a/b', summary: 's', at: '' }) }) })
    expect(events).toHaveLength(1)
    stop()
  })
})

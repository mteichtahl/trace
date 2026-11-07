import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHANGE_CHECKS_MS, CHANGE_MERGEABLE_MS, POLL_LIVE_MS, applyEvent, bumpLog, logTicks, changeLookEvery, conflictNotice, connectLive, hostOf, invalidationsFor, liveStatus, nextLookWords, pollEvery, subprotocols } from './live'

describe('live events → query invalidation', () => {
  it('maps each event to the queries it makes stale', () => {
    expect(invalidationsFor({ type: 'record.changed', repo: 'a/b', what: 'journey', at: '' })).toEqual([['journey.get', 'a/b'], ['inbox'], ['runs', 'a/b'], ['build.get', 'a/b'], ['skill.get', 'a/b'], ['jobs.list', 'a/b'], ['change.get', 'a/b'], ['changes.list', 'a/b'], ['tools.waits', 'a/b'], ['activity.list']])
    expect(invalidationsFor({ type: 'record.changed', repo: 'a/b', what: 'chats', at: '' })).toContainEqual(['chats.recall', 'a/b'])
    expect(invalidationsFor({ type: 'job.updated', repo: 'a/b', jobId: 'j', state: 'done', at: '' })).toContainEqual(['tools.waits', 'a/b'])
    expect(invalidationsFor({ type: 'notification', id: 'n', kind: 'gate', repo: 'a/b', summary: '', at: '' })).toEqual([['inbox'], ['journey.get', 'a/b']])
    // the installation update added a new project's agent (src/web/journey-events.ts): its setup notice looks again now
    expect(invalidationsFor({ type: 'record.changed', repo: 'a/b', what: 'agent', at: '' })).toEqual([['project.agent', 'a/b'], ['journey.get', 'a/b']])
  })

  it('refreshes what trace is doing when a task or a job changes (task, job.control publish \'jobs\')', () => {
    // it fell back to the journey alone: the Overview's "trace is doing" and the Agents page stayed as they were
    const keys = invalidationsFor({ type: 'record.changed', repo: 'a/b', what: 'jobs', at: '' })
    expect(keys).toEqual(expect.arrayContaining([['jobs.list', 'a/b'], ['journey.get', 'a/b'], ['tools.waits', 'a/b'], ['activity.list']]))
    // a job controlled where no project is named: every project's lists
    expect(invalidationsFor({ type: 'record.changed', what: 'jobs', at: '' } as never)).toContainEqual(['jobs.list'])
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

describe('a run\'s log grew (log.appended)', () => {
  it('refreshes what trace is doing, and a check\'s change runs', () => {
    expect(invalidationsFor({ type: 'log.appended', repo: 'a/b', kind: 'check', id: '1/1/board', lines: 4, at: '' })).toEqual([['activity.list'], ['change.runs', 'a/b']])
    expect(invalidationsFor({ type: 'log.appended', repo: 'a/b', kind: 'job', id: 'j1', lines: 2, at: '' })).toEqual([['activity.list']])
    expect(invalidationsFor({ type: 'log.appended', repo: 'a/b', kind: 'tool', id: 't1', lines: 1, at: '' })).toEqual([['activity.list']])
  })
  it('bumps the open log views for that repo only', () => {
    const before = logTicks.get()
    bumpLog('a/b')
    bumpLog('a/b')
    expect(logTicks.get()['a/b']).toBe((before['a/b'] ?? 0) + 2)
    expect(logTicks.get()['c/d']).toBe(before['c/d'])
  })
  it('activity.list matches the panel\'s key by prefix', async () => {
    const qc = new QueryClient()
    qc.setQueryData(['activity.list', {}], { items: [] })
    qc.setQueryData(['change.runs', 'a/b', { repo: 'a/b', number: 3 }], { jobs: [] })
    applyEvent(qc, { type: 'log.appended', repo: 'a/b', kind: 'check', id: 'x', lines: 1, at: '' })
    expect(qc.getQueryState(['activity.list', {}])?.isInvalidated).toBe(true)
    expect(qc.getQueryState(['change.runs', 'a/b', { repo: 'a/b', number: 3 }])?.isInvalidated).toBe(true)
  })
})

describe('a change moved on GitHub (the webhook\'s record.changed, kind change)', () => {
  it('refetches the change\'s status, the lists that show it, the journey, and what is read from the default branch', () => {
    const e = { type: 'record.changed', repo: 'a/b', kind: 'change', number: 7, at: '' } as unknown as Parameters<typeof invalidationsFor>[0]
    // the tools' reads (verify.coverage) and the intent links: a merged change moves the default branch (test-esp32 #65)
    expect(invalidationsFor(e)).toEqual([['pull.status', 'a/b'], ['changes.list', 'a/b'], ['change.get', 'a/b'], ['inbox'], ['journey.get', 'a/b'], ['change.runs', 'a/b'], ['activity.list'], ['tool', 'a/b'], ['requirements.trace', 'a/b']])
  })
})

describe('a push left changes in conflict (the webhook\'s record.changed with conflicts)', () => {
  const ev = (o: Record<string, unknown>) => ({ type: 'record.changed', repo: 'acme/soil-sensor', kind: 'change', at: '', ...o }) as unknown as Parameters<typeof conflictNotice>[0]
  it('says which, and that trace is on them', () => {
    expect(conflictNotice(ev({ conflicts: [4, 9], remade: [9], resolving: [4] }))).toEqual({
      title: '2 changes on soil-sensor conflict with the newest design',
      description: 'trace is bringing #4 and #9 up to date now. Nothing for you to do; they come back when the checks pass.',
    })
  })
  it('names the ones that need a person', () => {
    expect(conflictNotice(ev({ conflicts: [4, 7], remade: [], resolving: [4] }))?.description).toBe('trace is bringing #4 up to date now. #7 needs you: open it to see what to do.')
    expect(conflictNotice(ev({ conflicts: [7], resolving: [] }))).toEqual({ title: 'A change on soil-sensor conflicts with the newest design', description: '#7 needs you: open it and choose Bring it up to date.' })
  })
  it('nothing for an ordinary change event, and the screens still look again', () => {
    expect(conflictNotice(ev({ number: 3 }))).toBeNull()
    expect(invalidationsFor(ev({ conflicts: [4] }))).toContainEqual(['changes.list', 'acme/soil-sensor'])
  })
})

describe('polling, as the fallback', () => {
  it('slows to POLL_LIVE_MS while the live connection is up, and keeps its own pace otherwise', () => {
    expect(POLL_LIVE_MS).toBe(60_000)
    expect(pollEvery(15_000, 'live')).toBe(60_000)
    expect(pollEvery(120_000, 'live')).toBe(120_000)
    for (const s of ['connecting', 'reconnecting', 'offline'] as const) expect(pollEvery(15_000, s)).toBe(15_000)
  })

  it('says when it next looks', () => {
    expect(nextLookWords(1_000_000, 60_000, 1_020_000)).toBe('next look in 40 s')
    expect(nextLookWords(1_000_000, 60_000, 1_059_500)).toBe('next look in 1 s')
    expect(nextLookWords(1_000_000, 60_000, 1_060_000)).toBe('looking now')
    expect(nextLookWords(0, 60_000, 5)).toBe('looking now')
    expect(nextLookWords(0 + 1, 300_000, 1)).toBe('next look in 5 min')
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

describe('a change\'s review page looks again by itself', () => {
  const ch = (o: Partial<{ state: string; mergeable: string; verdict: string; checks: { running: number; total: number } | null }> = {}) =>
    ({ state: 'open', mergeable: 'clean', verdict: 'ready', checks: { running: 0, total: 2 }, ...o })
  it('polls often while GitHub works out whether it can merge, live or not: no event says when it is done', () => {
    expect(changeLookEvery(ch({ mergeable: 'unknown', verdict: 'checking' }), 'live')).toBe(CHANGE_MERGEABLE_MS)
    expect(changeLookEvery(ch({ mergeable: 'unknown', verdict: 'checking' }), 'offline')).toBe(CHANGE_MERGEABLE_MS)
  })
  it('polls running checks only as a fallback to their events', () => {
    expect(changeLookEvery(ch({ mergeable: 'blocked', verdict: 'checking', checks: { running: 1, total: 2 } }), 'offline')).toBe(CHANGE_CHECKS_MS)
    expect(changeLookEvery(ch({ mergeable: 'blocked', verdict: 'checking', checks: { running: 1, total: 2 } }), 'live')).toBe(POLL_LIVE_MS)
  })
  it('does not poll a settled change, or one waiting on a person', () => {
    expect(changeLookEvery(ch(), 'live')).toBe(false)
    expect(changeLookEvery(ch({ verdict: 'unfinished' }), 'live')).toBe(false)
    expect(changeLookEvery(ch({ state: 'merged', mergeable: 'unknown' }), 'live')).toBe(false)
    expect(changeLookEvery(undefined, 'live')).toBe(false)
  })
})

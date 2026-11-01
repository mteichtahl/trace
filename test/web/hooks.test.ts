/**
 * GitHub's webhook on the web backend (src/web/hooks.ts, docs/guided-flow.md "Live updates"): the signature (HMAC
 * SHA-256, constant time), which deliveries are taken and which dropped (204 and a log line), who is told (the API's
 * hook.members with the backend's own token, never the access store), what is published, and the debounce that turns
 * one push's dozens of deliveries into a couple of events, shared between containers through its store.
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEBOUNCE_MS, Debounce, type DebounceStore, MAX_BODY, MemoryDebounceStore, readDelivery, signatureOk } from '../../src/web/hooks.js'
import { DynamoDebounceStore } from '../../src/web/hooks-store.js'
import type { WebConfig } from '../../src/web/config.js'
import { CONFIG, FakePublisher, FakeRuntime, NOW, RecordingSink } from './fakes.js'
import { hooksApp } from '../../src/web/app.js'
import type { WebDeps } from '../../src/web/deps.js'
import { verifier } from '../api/fixtures.js'

const SECRET = 'a-webhook-secret-of-some-length'
const CLIENT_SECRET = 'the-backends-own-client-secret'
const HOOKS: NonNullable<WebConfig['hooks']> = {
  secret: 'trace/web/github-hooks', tokenUrl: 'https://trace-111122223333.auth.us-east-1.amazoncognito.com/oauth2/token',
  clientId: 'hooks-client', scope: 'trace-internal/members', table: 'trace-web-hooks',
}
const sign = (body: string, secret = SECRET): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
const pr = (repo: string, number: number, action = 'synchronize'): string => JSON.stringify({ action, number, pull_request: { number, title: 'Regulator ../../etc/passwd' }, repository: { full_name: repo } })
const checkRun = (repo: string, number: number | null): string => JSON.stringify({ action: 'completed', check_run: { name: 'build', pull_requests: number ? [{ number }] : [] }, repository: { full_name: repo } })

/** A world for the hooks function alone: the API runtime (hook.members), the token address, Secrets Manager, AppSync. */
function hooksWorld(o: { hooks?: WebConfig['hooks'] | null; secret?: () => string; store?: DebounceStore; now?: () => number } = {}) {
  const runtime = new FakeRuntime()
  const publisher = new FakePublisher()
  const logs: Record<string, unknown>[] = []
  const tokens: { auth: string; body: string }[] = []
  const secretReads: string[] = []
  let issued = 0
  runtime.answers.set('hook.members', (a) => ({ body: { ok: true, result: a.repo === 'acme/board' ? { repo: a.repo, project: true, subs: ['sub-ada', 'sub-bob'] } : { repo: a.repo, project: false, subs: [] } } }))
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input) === HOOKS.tokenUrl) {
      tokens.push({ auth: String((init?.headers as Record<string, string>).authorization), body: String(init?.body) })
      return new Response(JSON.stringify({ access_token: `backend-token-${++issued}`, expires_in: 3600, token_type: 'Bearer' }), { status: 200 })
    }
    return runtime.fetch(input, init)
  }
  const config = { ...CONFIG, ...(o.hooks === null ? {} : { hooks: o.hooks ?? HOOKS }) } as WebConfig
  const sleeps: number[] = []
  const store = o.store ?? new MemoryDebounceStore()
  let clock = o.now ? null : NOW
  const now = o.now ?? (() => clock ?? NOW)
  const deps: WebDeps = {
    config: async () => config,
    verifier: () => verifier(),
    cognito: () => { throw new Error('no cognito here') },
    bedrock: () => { throw new Error('no bedrock here') },
    polly: () => { throw new Error('no polly here') },
    store: () => { throw new Error('no store here') },
    cloudwatch: () => { throw new Error('no cloudwatch here') },
    secrets: () => ({ get: async (id) => { secretReads.push(id); return o.secret ? o.secret() : JSON.stringify({ webhookSecret: SECRET, clientSecret: CLIENT_SECRET }) } }),
    credentials: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }),
    fetch,
    agentcoreEndpoint: 'https://agentcore.test',
    log: (l) => { logs.push(l) },
    now,
  }
  // the window ends when the holder sleeps: the clock moves on by what it asked
  const debounce = new Debounce(store, { now, sleep: async (ms) => { sleeps.push(ms); if (clock !== null) clock += ms }, log: deps.log })
  const handle = hooksApp(deps, { publisher: () => publisher, debounce })
  const deliver = async (event: string, body: string, headers: Record<string, string> = {}) => {
    const sink = new RecordingSink()
    await handle({ method: 'POST', path: '/api/hooks/github', query: new URLSearchParams(), cookies: {}, body, headers: { 'x-github-event': event, 'x-hub-signature-256': sign(body), 'x-github-delivery': 'd-1', ...headers } }, sink)
    return sink.r
  }
  const tick = (ms: number): void => { if (clock !== null) clock += ms }
  return { runtime, publisher, logs, tokens, secretReads, deliver, sleeps, tick, deps }
}

const dropped = (logs: Record<string, unknown>[]): unknown[] => logs.filter((l) => l.hook === 'dropped').map((l) => l.why)

describe('the signature', () => {
  it('is the HMAC SHA-256 of the exact body with the secret, as GitHub sends it', () => {
    const body = '{"zen":"Keep it logically awesome."}'
    expect(signatureOk(SECRET, body, sign(body))).toBe(true)
    // a byte changed, another secret, the old SHA-1 header's form, nothing, a truncated one: all refused
    expect(signatureOk(SECRET, `${body} `, sign(body))).toBe(false)
    expect(signatureOk(SECRET, body, sign(body, 'another-secret-entirely'))).toBe(false)
    expect(signatureOk(SECRET, body, `sha1=${createHmac('sha1', SECRET).update(body).digest('hex')}`)).toBe(false)
    expect(signatureOk(SECRET, body, undefined)).toBe(false)
    expect(signatureOk(SECRET, body, sign(body).slice(0, 20))).toBe(false)
    expect(signatureOk('', body, sign(body, ''))).toBe(false)
  })

  it('a delivery without one, or with a wrong one, is dropped with 204 before anyone is asked anything', async () => {
    const w = hooksWorld()
    const body = pr('acme/board', 7)
    expect((await w.deliver('pull_request', body, { 'x-hub-signature-256': '' })).status).toBe(204)
    expect((await w.deliver('pull_request', body, { 'x-hub-signature-256': sign(body, 'not-the-secret-at-all') })).status).toBe(204)
    expect(dropped(w.logs)).toEqual(['unsigned', 'bad signature'])
    expect(w.runtime.calls).toEqual([])
    expect(w.publisher.sent).toEqual([])
    // the log names why and the delivery, never the body (a pull request's text)
    expect(JSON.stringify(w.logs)).not.toContain('Regulator')
  })

  it('reads the secret again once when a signature does not match an older copy (the installer replaced it)', async () => {
    let current = SECRET
    let t = NOW
    const w = hooksWorld({ secret: () => JSON.stringify({ webhookSecret: current, clientSecret: CLIENT_SECRET }), now: () => t })
    const body = pr('acme/board', 7)
    expect((await w.deliver('pull_request', body)).status).toBe(202)
    expect(w.secretReads).toEqual(['trace/web/github-hooks'])
    current = 'a-new-secret-the-installer-wrote'
    t += 60_000
    const again = pr('acme/board', 8)
    expect((await w.deliver('pull_request', again, { 'x-hub-signature-256': sign(again, current) })).status).toBe(202)
    // the first copy, then the bad match read it again (the token's own read of the client secret is cached)
    expect(w.secretReads.length).toBe(2)
    // a copy just read is not read again for every bad delivery
    expect((await w.deliver('pull_request', again, { 'x-hub-signature-256': sign(again, 'forged-forged-forged') })).status).toBe(204)
    expect(w.secretReads.length).toBe(2)
  })

  it('a secret that cannot be read takes nothing', async () => {
    const w = hooksWorld({ secret: () => { throw Object.assign(new Error('nope'), { name: 'ResourceNotFoundException' }) } })
    expect((await w.deliver('pull_request', pr('acme/board', 7))).status).toBe(204)
    expect(dropped(w.logs)).toEqual(['the webhook secret cannot be read'])
  })
})

describe('which deliveries are taken', () => {
  it('only pull_request, check_run, check_suite and status: anything else is 204 without reading the secret', async () => {
    const w = hooksWorld()
    for (const e of ['push', 'issues', 'ping', 'workflow_run']) expect((await w.deliver(e, pr('acme/board', 7))).status).toBe(204)
    expect(w.secretReads).toEqual([])
    expect(dropped(w.logs)).toEqual(['push', 'issues', 'ping', 'workflow_run'].map((e) => `not an event trace takes (${e})`))
  })

  it('a body over the cap is dropped unread', async () => {
    const w = hooksWorld()
    const big = JSON.stringify({ repository: { full_name: 'acme/board' }, pad: 'x'.repeat(MAX_BODY) })
    expect((await w.deliver('pull_request', big)).status).toBe(204)
    expect(dropped(w.logs)).toEqual(['too large'])
    expect(w.secretReads).toEqual([])
  })

  it('a repository that is not a trace project is dropped with 204 (the API says so), and nothing is published', async () => {
    const w = hooksWorld()
    expect((await w.deliver('pull_request', pr('someone/else', 3))).status).toBe(204)
    expect(dropped(w.logs)).toEqual(['not a trace project'])
    expect(w.publisher.sent).toEqual([])
  })

  it('with live updates from GitHub off (no hooks in the settings), everything is dropped', async () => {
    const w = hooksWorld({ hooks: null })
    expect((await w.deliver('pull_request', pr('acme/board', 7))).status).toBe(204)
    expect(dropped(w.logs)).toEqual(['live updates from GitHub are off'])
  })

  it('reads the change a delivery is about: its number, or the check\'s first change, or none for a status', () => {
    expect(readDelivery('pull_request', pr('Acme/Board', 7))).toEqual({ repo: 'acme/board', number: 7, event: 'pull_request' })
    expect(readDelivery('check_run', checkRun('acme/board', 9))).toEqual({ repo: 'acme/board', number: 9, event: 'check_run' })
    expect(readDelivery('check_suite', JSON.stringify({ check_suite: { pull_requests: [{ number: 4 }] }, repository: { full_name: 'acme/board' } }))).toMatchObject({ number: 4 })
    expect(readDelivery('status', JSON.stringify({ sha: 'abc', state: 'success', repository: { full_name: 'acme/board' } }))).toEqual({ repo: 'acme/board', number: null, event: 'status' })
    expect(readDelivery('pull_request', 'not json')).toEqual({ drop: 'not JSON' })
    expect(readDelivery('pull_request', JSON.stringify({ repository: { full_name: '../../etc' } }))).toEqual({ drop: 'no repository in it' })
  })
})

describe('who is told, and what', () => {
  it('asks the API runtime with the backend\'s own token (client credentials), and publishes record.changed to each person on the project', async () => {
    const w = hooksWorld()
    const r = await w.deliver('pull_request', pr('Acme/Board', 7))
    expect(r.status).toBe(202)
    // the token: client credentials of the backend's own client, its one scope
    expect(w.tokens).toHaveLength(1)
    expect(w.tokens[0]!.auth).toBe(`Basic ${Buffer.from(`hooks-client:${CLIENT_SECRET}`).toString('base64')}`)
    expect(new URLSearchParams(w.tokens[0]!.body).get('grant_type')).toBe('client_credentials')
    expect(new URLSearchParams(w.tokens[0]!.body).get('scope')).toBe('trace-internal/members')
    // the API decides who: hook.members, with that token, never the access store
    expect(w.runtime.calls.map((c) => [c.action, c.args, c.headers.authorization])).toEqual([['hook.members', { repo: 'acme/board' }, 'Bearer backend-token-1']])
    expect(w.publisher.sent.map((s) => s.channel)).toEqual(['/trace/users/sub-ada', '/trace/users/sub-bob'])
    expect(w.publisher.sent[0]!.events).toEqual([{ type: 'record.changed', repo: 'acme/board', kind: 'change', number: 7, at: new Date(NOW).toISOString() }])
    // no content in the event: not the title, not the body
    expect(JSON.stringify(w.publisher.sent)).not.toContain('Regulator')
  })

  it('keeps the token and the members for a while: a second delivery asks Cognito and the API nothing', async () => {
    const w = hooksWorld()
    await w.deliver('pull_request', pr('acme/board', 7))
    w.tick(DEBOUNCE_MS + 1)
    await w.deliver('pull_request', pr('acme/board', 7, 'closed'))
    expect(w.tokens).toHaveLength(1)
    expect(w.runtime.calls).toHaveLength(1)
    expect(w.publisher.sent).toHaveLength(4)
  })

  it('a token the API no longer takes is renewed once', async () => {
    const w = hooksWorld()
    let refused = 1
    w.runtime.answers.set('hook.members', (a) => (refused-- > 0 ? { status: 401, body: { ok: false, error: 'not signed in' } } : { body: { ok: true, result: { repo: a.repo, project: true, subs: ['sub-ada'] } } }))
    expect((await w.deliver('pull_request', pr('acme/board', 7))).status).toBe(202)
    expect(w.tokens).toHaveLength(2)
    expect(w.publisher.sent.map((s) => s.channel)).toEqual(['/trace/users/sub-ada'])
  })

  it('a failed publish is logged, and GitHub still had its 202', async () => {
    const w = hooksWorld()
    w.publisher.fail = true
    expect((await w.deliver('pull_request', pr('acme/board', 7))).status).toBe(202)
    expect(w.logs.find((l) => l.hook === 'published')).toMatchObject({ people: 2, failed: 2 })
  })
})

describe('the debounce', () => {
  it('one push\'s burst of deliveries becomes two events: the first at once, the rest of the window once at its end', async () => {
    const store = new MemoryDebounceStore()
    let t = NOW
    const published: (number | null)[] = []
    const sleeps: number[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((ok) => { release = ok })
    const d = new Debounce(store, { now: () => t, sleep: async (ms) => { sleeps.push(ms); await gate; t += ms } })
    const first = d.offer('acme/board', 7, async (n) => { published.push(n) })
    await Promise.resolve()
    await Promise.resolve()
    expect(published).toEqual([7])
    // twenty check runs and statuses of the same change inside the window: each only notes itself
    const rest = await Promise.all(Array.from({ length: 20 }, (_, i) => d.offer('acme/board', i % 2 ? 7 : null, async (n) => { published.push(n) })))
    expect(rest.every((x) => x === 'joined')).toBe(true)
    release()
    expect(await first).toBe('published')
    // one more at the window's end; two numbers were noted (7 and none), so it names none
    expect(published).toEqual([7, null])
    expect(sleeps).toEqual([DEBOUNCE_MS, DEBOUNCE_MS])
  })

  it('a window that saw one change names it; a quiet window ends the holder; another repository has its own window', async () => {
    const store = new MemoryDebounceStore()
    let t = NOW
    const published: string[] = []
    const d = new Debounce(store, {
      now: () => t,
      sleep: async (ms) => { if (t === NOW) { await d.offer('acme/board', 7, async (n) => { published.push(`board:${n}`) }) } t += ms },
    })
    await d.offer('acme/board', 7, async (n) => { published.push(`board:${n}`) })
    expect(published).toEqual(['board:7', 'board:7'])
    expect(await d.offer('acme/fw', 2, async (n) => { published.push(`fw:${n}`) })).toBe('published')
    expect(published).toEqual(['board:7', 'board:7', 'fw:2'])
  })

  it('is shared through its store: a delivery in another container joins the window instead of publishing', async () => {
    const shared = new MemoryDebounceStore()
    const t = NOW + 0
    const a: (number | null)[] = []
    const b: (number | null)[] = []
    let wake: () => void = () => undefined
    let slept = 0
    // the first window waits for the other container's delivery; the holder's next window is quiet
    const one = new Debounce(shared, { now: () => t, sleep: () => (slept++ ? Promise.resolve() : new Promise((ok) => { wake = ok })) })
    const two = new Debounce(shared, { now: () => t, sleep: async () => undefined })
    const held = one.offer('acme/board', 7, async (n) => { a.push(n) })
    await Promise.resolve()
    await Promise.resolve()
    expect(await two.offer('acme/board', 8, async (n) => { b.push(n) })).toBe('joined')
    expect(b).toEqual([])
    wake()
    await held
    expect(a).toEqual([7, 8])
  })

  it('fails open: when the store cannot be reached each delivery publishes on its own', async () => {
    const broken: DebounceStore = { claim: async () => { throw new Error('DynamoDB is down') }, join: async () => false, release: async () => [] }
    const logs: Record<string, unknown>[] = []
    const out: (number | null)[] = []
    const d = new Debounce(broken, { log: (l) => { logs.push(l) } })
    expect(await d.offer('acme/board', 7, async (n) => { out.push(n) })).toBe('alone')
    expect(out).toEqual([7])
    expect(logs[0]).toMatchObject({ warning: expect.stringMatching(/debounce store failed/) })
  })

  it('through the route: a burst of deliveries is one publish at once and one at the window\'s end', async () => {
    const w = hooksWorld()
    // the first delivery holds the window; its hold ends when the fake sleep moves the clock, so drive the others in
    // while it waits by delivering them before awaiting it
    const first = w.deliver('pull_request', pr('acme/board', 7))
    const rest = Array.from({ length: 5 }, () => w.deliver('check_run', checkRun('acme/board', 7)))
    const all = await Promise.all([first, ...rest])
    expect(all.map((r) => r.status)).toEqual([202, 202, 202, 202, 202, 202])
    // two people, at most two publishes each, however many deliveries
    expect(w.publisher.sent.length).toBeLessThanOrEqual(4)
    expect(w.publisher.sent.length).toBeGreaterThanOrEqual(2)
    expect(w.logs.filter((l) => l.hook === 'debounced').length).toBeGreaterThanOrEqual(1)
  })
})

describe('the shared store in DynamoDB', () => {
  it('claims, joins and releases with conditional UpdateItems, and a refused condition is a no', async () => {
    const calls: Record<string, unknown>[] = []
    let open = false
    let noted: string[] = []
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      const b = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push(b)
      const refused = () => new Response(JSON.stringify({ __type: 'com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException', message: 'The conditional request failed' }), { status: 400 })
      const expr = String(b.UpdateExpression)
      if (expr.startsWith('SET #u = :until')) { if (open) return refused(); open = true; noted = []; return new Response('{}', { status: 200 }) }
      if (expr.startsWith('ADD noted')) { if (!open) return refused(); noted.push(...((b.ExpressionAttributeValues as { ':n': { SS: string[] } })[':n'].SS)); return new Response('{}', { status: 200 }) }
      const old = noted
      open = false
      noted = []
      return new Response(JSON.stringify(old.length ? { Attributes: { noted: { SS: old } } } : {}), { status: 200 })
    }
    const s = new DynamoDebounceStore({ table: 'trace-web-hooks', region: 'us-east-1', credentials: async () => ({ accessKeyId: 'AKID', secretAccessKey: 'secret' }), fetch })
    expect(await s.claim('acme/board', NOW + 5000, NOW)).toBe(true)
    expect(await s.claim('acme/board', NOW + 5000, NOW)).toBe(false)
    expect(await s.join('acme/board', 7, NOW)).toBe(true)
    expect(await s.join('acme/board', null, NOW)).toBe(true)
    expect((await s.release('acme/board', NOW + 5000)).sort()).toEqual([7, null].sort())
    expect(await s.join('acme/board', 9, NOW + 6000)).toBe(false)
    expect(calls[0]).toMatchObject({ TableName: 'trace-web-hooks', Key: { k: { S: 'acme/board' } }, ConditionExpression: 'attribute_not_exists(#u) OR #u <= :now' })
    expect(calls[2]).toMatchObject({ ConditionExpression: '#u > :now', ExpressionAttributeValues: { ':n': { SS: ['7'] } } })
  })

  it('throws on anything but a refused condition (the debounce then fails open)', async () => {
    const s = new DynamoDebounceStore({ table: 't', region: 'us-east-1', credentials: async () => ({ accessKeyId: 'A', secretAccessKey: 'B' }), fetch: async () => new Response(JSON.stringify({ __type: 'x#ResourceNotFoundException' }), { status: 400 }) })
    await expect(s.claim('acme/board', 1, 0)).rejects.toThrow(/ResourceNotFoundException/)
  })
})

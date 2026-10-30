import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SignatureV4 } from '@smithy/signature-v4'
import { API_FIRST_BYTE_MS, API_UNAVAILABLE, callApi, runtimeSession } from '../../src/web/call.js'
import { API_READ_TIMEOUT_SECONDS } from '../../src/infra/web.js'
import { appsyncPublisher, changeOf } from '../../src/web/events.js'
import { EMPTY_SHA256, contentSha256 } from '../../src/web/content-hash.js'
import { streamSink, toRequest } from '../../src/web/event.js'
import { Writable } from 'node:stream'
import { accessToken, otherKeys, sign, ISSUER, CLIENT_ID } from '../api/fixtures.js'
import { CONFIG, FakeRuntime, NOW, bearerOf, world } from './fakes.js'

const tok = accessToken('sub-ada', ['trace-users'])
const call = (body: unknown, token = tok) => ({ method: 'POST', path: '/api/call', headers: bearerOf(token), body: JSON.stringify(body) })

describe('/api/call', () => {
  it('rejects a missing or bad token locally, before the API runtime is asked', async () => {
    const w = world()
    expect((await w.serve({ method: 'POST', path: '/api/call', body: '{"action":"projects"}' })).status).toBe(401)
    const now = Math.floor(Date.now() / 1000)
    const forged = sign({ sub: 'x', iss: ISSUER, token_use: 'access', client_id: CLIENT_ID, exp: now + 60 }, { key: otherKeys.privateKey })
    expect((await w.serve(call({ action: 'projects' }, forged))).status).toBe(401)
    expect(w.runtime.calls).toEqual([])
  })

  it('forwards to the API runtime like the CLI: bearer, a stable session per person, the body as { action, ...args }', async () => {
    const w = world()
    w.runtime.answers.set('status', (a) => ({ body: { ok: true, result: { repo: a.repo, pulls: [] } } }))
    const r = await w.serve(call({ action: 'status', repo: 'acme/board' }))
    expect(r.status).toBe(200)
    expect(r.json()).toEqual({ ok: true, result: { repo: 'acme/board', pulls: [] } })
    expect(r.headers['content-type']).toMatch(/application\/json/)
    const c = w.runtime.calls[0]!
    expect(c.url).toBe(`https://agentcore.test/runtimes/${encodeURIComponent(CONFIG.apiRuntimeArn)}/invocations?qualifier=DEFAULT`)
    expect(c.headers.authorization).toBe(`Bearer ${tok}`)
    expect(c.headers['x-amzn-bedrock-agentcore-runtime-session-id']).toBe(`trace-web-${createHash('sha256').update('sub-ada').digest('hex').slice(0, 40)}`)
    expect(runtimeSession('sub-ada').length).toBeGreaterThanOrEqual(33)
    // a new API build is a new session (a session keeps the runtime version it started on); no build: as before
    expect(runtimeSession('sub-ada', 'v0.1.0-bbbbbbbbbbbbbbbb')).not.toBe(runtimeSession('sub-ada', 'v0.1.0-aaaaaaaaaaaaaaaa'))
    expect(runtimeSession('sub-ada', 'v0.1.0-aaaaaaaaaaaaaaaa')).toMatch(/^trace-web-[0-9a-f]{40}$/)
    expect(runtimeSession('sub-ada', '')).toBe(runtimeSession('sub-ada'))
    expect(c.args).toEqual({ repo: 'acme/board' })
    // a read publishes nothing
    expect(w.publisher.sent).toEqual([])
  })

  it('passes the runtime\'s status and body through as they are (403 no access)', async () => {
    const w = world()
    w.runtime.answers.set('status', () => ({ status: 403, body: { ok: false, error: 'no access' } }))
    const r = await w.serve(call({ action: 'status', repo: 'other/secret' }))
    expect(r.status).toBe(403)
    expect(r.json()).toEqual({ ok: false, error: 'no access' })
  })

  it('a mutating action publishes record.changed to every member of the project and the caller', async () => {
    const w = world()
    w.runtime.answers.set('settings.set', () => ({ body: { ok: true, result: { branch: 'trace/settings-x' } } }))
    w.runtime.answers.set('project.members', (a) => ({ body: { ok: true, result: a.repo === 'acme/board' ? [{ sub: 'sub-ada' }, { sub: 'sub-bob' }, { sub: 'sub-cy' }] : [] } }))
    const r = await w.serve(call({ action: 'settings.set', repo: 'Acme/Board', key: 'a.b', value: 1 }))
    expect(r.status).toBe(200)
    expect(w.runtime.calls.map((c) => c.action)).toEqual(['settings.set', 'project.members'])
    expect(w.runtime.calls[1]?.headers.authorization).toBe(`Bearer ${tok}`)
    expect(w.publisher.sent.map((s) => s.channel).sort()).toEqual(['/trace/users/sub-ada', '/trace/users/sub-bob', '/trace/users/sub-cy'])
    expect(w.publisher.sent[0]?.events).toEqual([{ type: 'record.changed', repo: 'acme/board', what: 'settings', at: new Date(NOW).toISOString() }])
  })

  it('me.set publishes only to the caller; a refused change publishes nothing', async () => {
    const w = world()
    w.runtime.answers.set('me.set', () => ({ body: { ok: true, result: {} } }))
    await w.serve(call({ action: 'me.set', key: 'voice', value: 'Olivia' }))
    expect(w.publisher.sent).toEqual([{ channel: '/trace/users/sub-ada', events: [expect.objectContaining({ type: 'record.changed', what: 'preferences' })] }])
    expect(w.runtime.calls.map((c) => c.action)).toEqual(['me.set'])
    w.publisher.sent = []
    w.runtime.answers.set('task', () => ({ body: { ok: false, error: 'task: request: too short' } }))
    await w.serve(call({ action: 'task', repo: 'acme/board', request: '' }))
    expect(w.publisher.sent).toEqual([])
  })

  it('a failed publish never fails the call', async () => {
    const w = world()
    w.publisher.fail = true
    w.runtime.answers.set('chats.append', () => ({ body: { ok: true, result: { id: 'm1' } } }))
    w.runtime.answers.set('project.members', () => ({ body: { ok: true, result: [{ sub: 'sub-bob' }] } }))
    const r = await w.serve(call({ action: 'chats.append', repo: 'acme/board', thread: 't', message: {} }))
    expect(r.status).toBe(200)
    expect(r.json()).toEqual({ ok: true, result: { id: 'm1' } })
    expect(w.logs.some((l) => l.warning === 'publish: some events were not delivered')).toBe(true)
  })

  it('never passes chats.reply on: trace\'s words are kept by the chat agent alone', async () => {
    const w = world()
    const r = await w.serve(call({ action: 'chats.reply', repo: 'acme/board', thread: 'abcdefgh', after: 'm', messages: [{ role: 'assistant', text: 'Started.' }] }))
    expect(r.status).toBe(403)
    expect(w.runtime.calls).toEqual([])
  })

  it('rejects a body over 1 MB, and one with no action', async () => {
    const w = world()
    expect((await w.serve(call({ action: 'status', blob: 'x'.repeat(1024 * 1024) }))).status).toBe(413)
    expect((await w.serve(call({ repo: 'a/b' }))).status).toBe(400)
  })
})

describe('what is published', () => {
  it('knows the mutating actions', () => {
    expect(changeOf('settings.set')).toBe('settings')
    expect(changeOf('users.invite')).toBe('people')
    expect(changeOf('users.list')).toBeNull()
    expect(changeOf('integrations.set')).toBe('integrations')
    expect(changeOf('integrations.list')).toBeNull()
    expect(changeOf('gate.sign')).toBe('journey')
    expect(changeOf('question.answer')).toBe('journey')
    expect(changeOf('journey.get')).toBeNull()
    expect(changeOf('status')).toBeNull()
    expect(changeOf('chats.list')).toBeNull()
    expect(changeOf('chats.rename')).toBe('chats')
    expect(changeOf('order.record')).toBe('journey')
    expect(changeOf('skill.submit')).toBe('journey')
    expect(changeOf('design.decide')).toBe('journey')
    expect(changeOf('job.control')).toBe('jobs')
    expect(changeOf('policy.set')).toBe('preferences')
    expect(changeOf('skill.draft')).toBeNull()
  })

  it('AppSync Events: POST https://<http>/event, SigV4 for appsync, events as JSON text', async () => {
    const rt = new FakeRuntime()
    const creds = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'tok' })
    await appsyncPublisher(CONFIG, creds, rt.fetch).publish('/trace/users/u1', [{ type: 'record.changed', repo: 'a/b', what: 'kb', at: 't' }])
    const p = rt.appsync[0]!
    expect(p.url).toBe('https://abc.appsync-api.us-east-1.amazonaws.com/event')
    expect(JSON.parse(p.body)).toEqual({ channel: '/trace/users/u1', events: [JSON.stringify({ type: 'record.changed', repo: 'a/b', what: 'kb', at: 't' })] })
    expect(p.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/appsync\/aws4_request, SignedHeaders=[^,]*host[^,]*, Signature=[0-9a-f]{64}$/)
    expect(p.headers['x-amz-security-token']).toBe('tok')
    expect(SignatureV4).toBeDefined()
  })
})

describe('the Lambda edge', () => {
  it('turns a function URL event into a request (base64 body, cookies, lower-cased headers)', () => {
    const r = toRequest({
      version: '2.0', routeKey: '$default', rawPath: '/api/call', rawQueryString: 'range=24h&repo=a%2Fb',
      headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' }, cookies: ['trace_rt=abc%3D', 'other=1'],
      body: Buffer.from('{"action":"projects"}').toString('base64'), isBase64Encoded: true,
      requestContext: { http: { method: 'POST', path: '/api/call', protocol: 'HTTP/1.1', sourceIp: '1.1.1.1', userAgent: 'x' } },
    } as unknown as Parameters<typeof toRequest>[0])
    expect(r).toMatchObject({ method: 'POST', path: '/api/call', body: '{"action":"projects"}', cookies: { trace_rt: 'abc=', other: '1' } })
    expect(r.headers.authorization).toBe('Bearer x')
    expect(r.query.get('repo')).toBe('a/b')
  })

  it('writes the metadata once, then the body', () => {
    let out = ''
    const meta: unknown[] = []
    const w = new Writable({ write(c, _e, cb) { out += String(c); cb() } })
    const s = streamSink(w, (x, m) => { meta.push(m); return x })
    s.open(201, { a: 'b' }, ['c=1'])
    s.open(500, {})
    s.write('hello')
    s.end()
    expect(meta).toEqual([{ statusCode: 201, headers: { a: 'b' }, cookies: ['c=1'] }])
    expect(out).toBe('hello')
  })

  it('the content hash helper is the hex sha256 the function URL wants', async () => {
    expect(await contentSha256('')).toBe(EMPTY_SHA256)
    expect(await contentSha256('{"action":"projects"}')).toBe(createHash('sha256').update('{"action":"projects"}').digest('hex'))
  })
})

describe('the bundle', () => {
  it('bundles the Lambda into one ESM file with no SQLite and the SDK clients inside', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { bundleWebBackend } = await import('../../src/web/bundle.js')
    const out = mkdtempSync(join(tmpdir(), 'trace-web-bundle-'))
    try {
      bundleWebBackend(join(import.meta.dirname, '..', '..'), out)
      const js = readFileSync(join(out, 'index.mjs'), 'utf8')
      expect(js).toContain('streamifyResponse')
      expect(js).not.toContain('node:sqlite')
      expect(js).not.toMatch(/from\s*["']@aws-sdk\//)
      // and the live events' authorizer beside it
      const auth = readFileSync(join(out, 'authorizer.mjs'), 'utf8')
      expect(auth).toContain('EVENT_SUBSCRIBE')
      expect(auth).not.toContain('node:sqlite')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})

describe('/api/call when the API runtime does not answer', () => {
  it('waits for the runtime\'s first byte for less than CloudFront waits for the backend, so the app never sees a bare 504', () => {
    expect(API_FIRST_BYTE_MS).toBeLessThan(API_READ_TIMEOUT_SECONDS * 1000)
    // and long enough for a cold start that does come up
    expect(API_FIRST_BYTE_MS).toBeGreaterThanOrEqual(30_000)
  })

  it('a runtime that cannot be reached is 503 api_unavailable, in plain words, and the log says which runtime', async () => {
    const w = world()
    w.runtime.down.add('projects')
    const r = await w.serve(call({ action: 'projects' }))
    expect(r.status).toBe(503)
    expect(r.json()).toEqual({ ok: false, error: API_UNAVAILABLE, code: 'api_unavailable' })
    const line = w.logs.find((l) => l.warning === 'api runtime: not reachable')
    expect(line).toMatchObject({ action: 'projects', runtime: CONFIG.apiRuntimeArn, error: 'TypeError: fetch failed' })
    expect(JSON.stringify(w.logs)).not.toContain(tok)
  })

  it('a runtime that does not start answering in time is api_unavailable; one that answers late but in time is not', async () => {
    const w = world()
    const hang: typeof fetch = (_u, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => { rej(new DOMException('aborted', 'AbortError')) })
    })
    const who = { config: CONFIG, token: tok, sub: 'sub-ada' }
    const t0 = Date.now()
    await expect(callApi({ ...w.deps, fetch: hang }, who, 'projects', {}, { firstByteMs: 30 })).rejects.toMatchObject({ status: 503, code: 'api_unavailable' })
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(w.logs.find((l) => l.warning === 'api runtime: no answer in time')).toMatchObject({ action: 'projects', firstByteMs: 30 })

    const slow: typeof fetch = async () => { await new Promise((r) => setTimeout(r, 10)); return new Response('{"ok":true,"result":[]}', { status: 200 }) }
    const a = await callApi({ ...w.deps, fetch: slow }, who, 'projects', {}, { firstByteMs: 1_000 })
    expect(a).toMatchObject({ status: 200, json: { ok: true, result: [] } })
  })

  it('a call the caller abandons is not blamed on the runtime', async () => {
    const w = world()
    const hang: typeof fetch = (_u, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener('abort', () => { rej(new DOMException('aborted', 'AbortError')) })
    })
    const gone = new AbortController()
    const p = callApi({ ...w.deps, fetch: hang }, { config: CONFIG, token: tok, sub: 'sub-ada' }, 'projects', {}, { signal: gone.signal, firstByteMs: 60_000 })
    gone.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(w.logs.filter((l) => typeof l.warning === 'string' && l.warning.startsWith('api runtime'))).toEqual([])
  })
})

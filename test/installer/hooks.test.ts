/**
 * Live updates from GitHub, the installer's part (src/installer/hooks.ts, bootstrap.ts setUpWebhooks): the secret is
 * made once and kept, the backend's client secret written beside it; every project repository gets one webhook, found
 * by its URL and updated in place on a second run, never a second one; a repository that refuses is a warning.
 */
import { describe, expect, it } from 'vitest'
import { GithubError } from '../../src/installer/github.js'
import { HOOK_EVENTS, type HooksSecretIo, ensureHooksSecret, hookRefusedNote, registerWebhook, registerWebhooks } from '../../src/installer/hooks.js'
import { setUpWebhooks } from '../../src/installer/bootstrap.js'
import { WEB_HOOKS_OUTPUTS } from '../../src/infra/props.js'

const URL_ = 'https://d111111abcdef8.cloudfront.net/api/hooks/github'

/** GitHub's hooks API for a few repositories: list, create, update; a repository in `refuse` answers 404. */
class FakeHooksApi {
  hooks = new Map<string, { id: number; name: string; active: boolean; events: string[]; config: Record<string, string> }[]>()
  calls: string[] = []
  refuse = new Set<string>()
  private n = 0
  fetch: typeof fetch = async (input, init) => {
    const u = new URL(String(input))
    const method = init?.method ?? 'GET'
    const m = /^\/repos\/([^/]+\/[^/]+)\/hooks(?:\/(\d+))?$/.exec(u.pathname)
    if (!m) return new Response('{"message":"Not Found"}', { status: 404 })
    const repo = m[1] as string
    this.calls.push(`${method} ${repo}${m[2] ? `/${m[2]}` : ''}`)
    if (this.refuse.has(repo)) return new Response('{"message":"Not Found"}', { status: 404 })
    const list = this.hooks.get(repo) ?? []
    this.hooks.set(repo, list)
    const body = init?.body ? JSON.parse(String(init.body)) as { name?: string; active: boolean; events: string[]; config: Record<string, string> } : null
    if (method === 'GET') return new Response(JSON.stringify(list), { status: 200 })
    if (method === 'POST' && body) { const h = { id: ++this.n, name: body.name ?? 'web', active: body.active, events: body.events, config: body.config }; list.push(h); return new Response(JSON.stringify(h), { status: 201 }) }
    if (method === 'PATCH' && body) {
      const h = list.find((x) => x.id === Number(m[2]))
      if (!h) return new Response('{"message":"Not Found"}', { status: 404 })
      Object.assign(h, { active: body.active, events: body.events, config: body.config })
      return new Response(JSON.stringify(h), { status: 200 })
    }
    return new Response('{}', { status: 405 })
  }
}

class FakeSecrets implements HooksSecretIo {
  values = new Map<string, string>()
  writes: string[] = []
  async read(name: string): Promise<string | null> { return this.values.get(name) ?? null }
  async create(name: string, value: string): Promise<void> { this.writes.push(`create ${name}`); this.values.set(name, value) }
  async put(name: string, value: string): Promise<void> { this.writes.push(`put ${name}`); this.values.set(name, value) }
}

describe('the hooks secret', () => {
  it('is made once with a random webhook secret, then kept; the client secret is written when it changes', async () => {
    const io = new FakeSecrets()
    const a = await ensureHooksSecret(io, 'trace/web/github-hooks', 'client-1', () => 'a'.repeat(64))
    expect(a).toEqual({ webhookSecret: 'a'.repeat(64), state: 'created' })
    const b = await ensureHooksSecret(io, 'trace/web/github-hooks', 'client-1', () => 'b'.repeat(64))
    expect(b).toEqual({ webhookSecret: 'a'.repeat(64), state: 'unchanged' })
    const c = await ensureHooksSecret(io, 'trace/web/github-hooks', 'client-2', () => 'c'.repeat(64))
    expect(c).toEqual({ webhookSecret: 'a'.repeat(64), state: 'updated' })
    expect(JSON.parse(io.values.get('trace/web/github-hooks') ?? '')).toEqual({ webhookSecret: 'a'.repeat(64), clientSecret: 'client-2' })
    // the client secret could not be read this time: the one stored stays
    expect((await ensureHooksSecret(io, 'trace/web/github-hooks', null)).state).toBe('unchanged')
    expect(io.writes).toEqual(['create trace/web/github-hooks', 'put trace/web/github-hooks'])
  })

  it('one that does not parse is made again', async () => {
    const io = new FakeSecrets()
    io.values.set('s', 'not json')
    expect((await ensureHooksSecret(io, 's', null, () => 'z'.repeat(64))).state).toBe('updated')
    expect(JSON.parse(io.values.get('s') ?? '')).toEqual({ webhookSecret: 'z'.repeat(64) })
  })
})

describe('registering the webhook', () => {
  it('creates one with the address, JSON, the four events and the secret; a second run updates it in place', async () => {
    const gh = new FakeHooksApi()
    gh.hooks.set('acme/board', [{ id: 99, name: 'web', active: true, events: ['push'], config: { url: 'https://ci.example.com/hook' } }])
    expect(await registerWebhook('tok', 'acme/board', URL_, 's1', gh.fetch)).toBe('created')
    expect(await registerWebhook('tok', 'acme/board', URL_, 's2', gh.fetch)).toBe('updated')
    const hooks = gh.hooks.get('acme/board') ?? []
    // someone else's hook is left alone, and there is still exactly one of trace's
    expect(hooks).toHaveLength(2)
    expect(hooks[0]).toEqual({ id: 99, name: 'web', active: true, events: ['push'], config: { url: 'https://ci.example.com/hook' } })
    expect(hooks[1]).toMatchObject({ active: true, events: [...HOOK_EVENTS], config: { url: URL_, content_type: 'json', secret: 's2', insecure_ssl: '0' } })
    expect(HOOK_EVENTS).toEqual(['pull_request', 'check_run', 'check_suite', 'status'])
    expect(gh.calls).toEqual(['GET acme/board', 'POST acme/board', 'GET acme/board', `PATCH acme/board/${hooks[1]?.id}`])
  })

  it('every repository, several at once: one that refuses is a warning, the rest are done', async () => {
    const gh = new FakeHooksApi()
    gh.refuse.add('acme/locked')
    const r = await registerWebhooks('tok', ['acme/board', 'acme/locked', 'acme/fw'], URL_, 's', { register: (t, repo, u, s) => registerWebhook(t, repo, u, s, gh.fetch) })
    expect(r.done).toEqual([{ repo: 'acme/board', state: 'created' }, { repo: 'acme/fw', state: 'created' }])
    expect(r.warnings).toEqual([expect.stringMatching(/^acme\/locked: live updates from GitHub are not registered \(the token may not manage its webhooks .*\)\. Its screens look again every 60 s instead/)])
    expect(hookRefusedNote('x/y', new GithubError('boom', 500))).toMatch(/x\/y: .*boom/)
  })
})

describe('the installer\'s web step (setUpWebhooks)', () => {
  const outputs = { [WEB_HOOKS_OUTPUTS.address]: URL_, [WEB_HOOKS_OUTPUTS.clientId]: 'hooks-client', UserPoolId: 'us-east-1_X' }

  it('makes the secret, writes the client secret into it, registers every project; run again, it changes nothing it should not', async () => {
    const gh = new FakeHooksApi()
    const io = new FakeSecrets()
    const lines: string[] = []
    const asked: string[] = []
    const once = () => setUpWebhooks({
      prefix: 'trace', outputs, repos: ['acme/board', 'acme/fw'], token: 'tok', secrets: io,
      clientSecret: async (pool, client) => { asked.push(`${pool}/${client}`); return 'the-client-secret' },
      register: (t, r, u, s) => registerWebhook(t, r, u, s, gh.fetch), log: (l) => { lines.push(l) },
    })
    expect(await once()).toEqual({ url: URL_, warnings: [] })
    const stored = JSON.parse(io.values.get('trace/web/github-hooks') ?? '') as { webhookSecret: string; clientSecret: string }
    expect(stored.clientSecret).toBe('the-client-secret')
    expect(stored.webhookSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(asked).toEqual(['us-east-1_X/hooks-client'])
    expect(await once()).toEqual({ url: URL_, warnings: [] })
    // still one hook each, with the same secret; the secret written once
    for (const r of ['acme/board', 'acme/fw']) {
      expect(gh.hooks.get(r)).toHaveLength(1)
      expect(gh.hooks.get(r)?.[0]?.config.secret).toBe(stored.webhookSecret)
    }
    expect(io.writes).toEqual(['create trace/web/github-hooks'])
    expect(lines).toContain(`acme/board: webhook created (${URL_})`)
    expect(lines).toContain(`acme/board: webhook updated (${URL_})`)
  })

  it('a refused repository and an unwritable secret are warnings, never a throw; no address is nothing to do', async () => {
    const gh = new FakeHooksApi()
    gh.refuse.add('acme/fw')
    const ok = await setUpWebhooks({
      prefix: 'trace', outputs, repos: ['acme/board', 'acme/fw'], token: 'tok', secrets: new FakeSecrets(), clientSecret: async () => null,
      register: (t, r, u, s) => registerWebhook(t, r, u, s, gh.fetch), log: () => undefined,
    })
    expect(ok.warnings).toHaveLength(1)
    expect(ok.warnings[0]).toMatch(/^acme\/fw:/)
    const broken: HooksSecretIo = { read: async () => { throw new Error('AccessDenied') }, create: async () => undefined, put: async () => undefined }
    const bad = await setUpWebhooks({ prefix: 'trace', outputs, repos: ['acme/board'], token: 'tok', secrets: broken, clientSecret: async () => null, log: () => undefined })
    expect(bad.warnings[0]).toMatch(/Live updates from GitHub are not set up: the secret trace\/web\/github-hooks could not be written \(AccessDenied\)/)
    expect(await setUpWebhooks({ prefix: 'trace', outputs: {}, repos: ['acme/board'], token: 'tok', secrets: broken, clientSecret: async () => null, log: () => undefined })).toEqual({ url: null, warnings: [] })
  })
})

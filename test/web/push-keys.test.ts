import { beforeEach, describe, expect, it } from 'vitest'
import { PUSH_SUBJECT, type PushKeysIo, forgetPushKey, pushPublicKey } from '../../src/web/push-keys.js'
import { generateVapidKeys } from '../../src/web/web-push.js'

function io(start: Record<string, string> = {}) {
  const store = new Map(Object.entries(start))
  let creates = 0
  const x: PushKeysIo & { creates: () => number; store: Map<string, string> } = {
    store,
    creates: () => creates,
    async read(n) { return store.get(n) ?? null },
    async create(n, v) { creates++; if (store.has(n)) return false; store.set(n, v); return true },
  }
  return x
}

describe('the push key pair', () => {
  beforeEach(() => forgetPushKey())

  it('makes the key pair the first time, keeps it after that, and gives out only the public half', async () => {
    const x = io()
    const k = await pushPublicKey('acme', x)
    expect(k).toMatch(/^B[A-Za-z0-9_-]{86}$/)
    const stored = JSON.parse(x.store.get('acme/web/push-keys')!)
    expect(stored).toMatchObject({ publicKey: k, subject: PUSH_SUBJECT })
    forgetPushKey()
    expect(await pushPublicKey('acme', x)).toBe(k)
    expect(x.creates()).toBe(1)
  })

  it('when another call made it first, reads that one', async () => {
    const other = generateVapidKeys(PUSH_SUBJECT)
    const x = io()
    x.create = async (n) => { x.store.set(n, JSON.stringify(other)); return false }
    expect(await pushPublicKey('acme', x)).toBe(other.publicKey)
  })

  it('never overwrites a secret that is not whole: devices may have subscribed with it', async () => {
    const x = io({ 'acme/web/push-keys': '{"publicKey":"nope"}' })
    expect(await pushPublicKey('acme', x)).toBeNull()
    expect(x.creates()).toBe(0)
    expect(x.store.get('acme/web/push-keys')).toBe('{"publicKey":"nope"}')
  })
})

describe('GET /api/push/key', () => {
  beforeEach(() => forgetPushKey())

  it('gives a signed-in person the public half, making the pair the first time; refuses anyone not signed in', async () => {
    const { world, bearerOf } = await import('./fakes.js')
    const { accessToken } = await import('../api/fixtures.js')
    const w = world()
    const x = io()
    w.deps.pushKeys = () => x
    const signedOut = await w.serve({ method: 'GET', path: '/api/push/key' })
    expect(signedOut.status).toBe(401)
    const r = await w.serve({ method: 'GET', path: '/api/push/key', headers: bearerOf(accessToken('s', ['trace-users'])) })
    expect(r.status).toBe(200)
    const body = r.json() as { publicKey: string }
    expect(body.publicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/)
    expect(r.body).not.toContain('privateKey')
    expect([...x.store.keys()]).toEqual([expect.stringMatching(/\/web\/push-keys$/)])
  })
})

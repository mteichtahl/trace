/**
 * The optional integrations (src/core/integrations.ts): the catalog covers every key the tools read, the store keeps
 * one secret per integration, a worker loads them at start without overwriting, the tools say which key to add, and
 * the API lets admins (only) set and remove them without ever reading one back.
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ActionError, perform } from '../../src/api/actions.js'
import {
  INTEGRATIONS, INTEGRATION_KEYS, INTEGRATION_NAMES, IntegrationStore, type SecretsApi, addKeyHint, checkIntegration, integrationOf, integrationSecretName, loadIntegrations, valuesFor,
} from '../../src/core/integrations.js'
import { Central } from '../../src/core/central.js'
import { PartsDb } from '../../src/tools/parts/db.js'
import { lookup } from '../../src/tools/parts/lookup.js'

function fakeSecrets(): SecretsApi & { data: Map<string, { value: string; tags: Record<string, string> }> } {
  const data = new Map<string, { value: string; tags: Record<string, string> }>()
  return {
    data,
    get: async (n) => data.get(n)?.value ?? null,
    put: async (n, value, tags) => { data.set(n, { value, tags: data.get(n)?.tags ?? tags }) },
    describe: async (n) => (data.has(n) ? { changed: new Date('2026-10-26T00:00:00Z') } : null),
    remove: async (n) => data.delete(n),
  }
}

describe('the catalog', () => {
  it('lists every credential the tools read from the environment', () => {
    // every *_KEY / *_CLIENT_ID / *_SECRET / *_TOKEN name the tools read, except trace's own (TRACE_*, set by the runtime)
    const found = new Set<string>()
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts')) for (const m of readFileSync(p, 'utf8').matchAll(/env\.([A-Z][A-Z0-9_]*(?:API_KEY|CLIENT_ID|CLIENT_SECRET|_TOKEN))\b/g)) if (!m[1]?.startsWith('TRACE_')) found.add(m[1] ?? '')
      }
    }
    walk(join(import.meta.dirname, '..', '..', 'src', 'tools'))
    expect([...found].sort()).toEqual([...INTEGRATION_KEYS].sort())
    expect(integrationOf('NEXAR_CLIENT_SECRET')).toBe('nexar')
    for (const n of INTEGRATION_NAMES) expect(INTEGRATIONS[n].url).toMatch(/^https:\/\//)
  })

  it('takes exactly an integration\'s keys', () => {
    expect(valuesFor('nexar', { NEXAR_CLIENT_ID: ' id ', NEXAR_CLIENT_SECRET: 'secret' })).toEqual({ NEXAR_CLIENT_ID: 'id', NEXAR_CLIENT_SECRET: 'secret' })
    expect(() => valuesFor('nexar', { NEXAR_CLIENT_ID: 'id' })).toThrow(/NEXAR_CLIENT_SECRET is required/)
    expect(() => valuesFor('mouser', { MOUSER_API_KEY: 'k', OTHER: 'x' })).toThrow(/unknown key OTHER/)
    expect(integrationSecretName('lab', 'digikey')).toBe('lab/integrations/digikey')
  })
})

describe('the store and loading at run time', () => {
  it('keeps one tagged secret per integration, lists them without values, and removes them', async () => {
    const sm = fakeSecrets()
    const store = new IntegrationStore('trace', sm)
    expect(await store.set('mouser', { MOUSER_API_KEY: 'm-key' })).toBe('trace/integrations/mouser')
    expect(sm.data.get('trace/integrations/mouser')).toEqual({ value: '{"MOUSER_API_KEY":"m-key"}', tags: { 'trace:installation': 'trace', 'trace:integration': 'mouser' } })
    const list = await store.list()
    expect(list.map((i) => `${i.name}:${i.configured}`)).toEqual(['nexar:false', 'mouser:true', 'digikey:false'])
    expect(JSON.stringify(list)).not.toContain('m-key')
    expect(await store.get('mouser')).toEqual({ MOUSER_API_KEY: 'm-key' })
    expect(await store.remove('mouser')).toBe(true)
    expect(await store.remove('mouser')).toBe(false)
  })

  it('loads what can be read into the environment, never overwriting, and skips the rest', async () => {
    const sm = fakeSecrets()
    await new IntegrationStore('trace', sm).set('nexar', { NEXAR_CLIENT_ID: 'id', NEXAR_CLIENT_SECRET: 'sec' })
    await new IntegrationStore('trace', sm).set('mouser', { MOUSER_API_KEY: 'stored' })
    const env: NodeJS.ProcessEnv = { MOUSER_API_KEY: 'already-set' }
    const r = await loadIntegrations('trace/integrations/', async (n) => {
      if (n.endsWith('digikey')) throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
      return sm.get(n)
    }, env)
    expect(r.loaded).toEqual(['nexar'])
    expect(r.skipped).toEqual(['digikey: not readable by this role'])
    expect(env).toEqual({ MOUSER_API_KEY: 'already-set', NEXAR_CLIENT_ID: 'id', NEXAR_CLIENT_SECRET: 'sec' })
  })

  it('checks a key with its service and reports, never throws', async () => {
    const seen: string[] = []
    const ok = await checkIntegration('nexar', { NEXAR_CLIENT_ID: 'i', NEXAR_CLIENT_SECRET: 's' }, async (u) => { seen.push(u); return new Response('{"access_token":"x"}', { status: 200 }) })
    expect(ok).toEqual({ ok: true, detail: 'Nexar (Octopart) accepted the credentials' })
    expect(seen).toEqual(['https://identity.nexar.com/connect/token'])
    expect((await checkIntegration('digikey', { DIGIKEY_CLIENT_ID: 'i', DIGIKEY_CLIENT_SECRET: 's' }, async () => new Response('{"error":"invalid_client"}', { status: 401 }))).detail).toMatch(/refused these credentials \(HTTP 401: invalid client\)/)
    expect((await checkIntegration('mouser', { MOUSER_API_KEY: 'k' }, async () => new Response('{"Errors":[{"Message":"Invalid unique identifier."}]}', { status: 200 }))).ok).toBe(false)
    const offline = await checkIntegration('mouser', { MOUSER_API_KEY: 'k' }, async () => { throw new Error('ENOTFOUND') })
    expect(offline).toMatchObject({ ok: false, detail: expect.stringMatching(/could not reach Mouser: ENOTFOUND \(stored anyway/) })
  })

  it('makes the parts tools say which key to add', async () => {
    const r = await lookup('LM358', { env: {}, currency: 'USD', providers: ['mouser', 'nexar'], fetch: async () => new Response('{}', { status: 200 }), db: new PartsDb(new Central({ home: mkdtempSync(join(tmpdir(), 'trace-parts-')) })) }).catch((e: unknown) => e)
    const text = JSON.stringify(r)
    expect(text).toContain('trace integrations set mouser')
    expect(text).toContain('trace integrations set nexar')
    expect(addKeyHint('digikey')).toMatch(/^no Digi-Key credentials \(DIGIKEY_CLIENT_ID \/ DIGIKEY_CLIENT_SECRET\): add them with `trace integrations set digikey`/)
  })
})

describe('the API', () => {
  const admin = { sub: 'a', email: 'a@example.com', groups: ['trace-admins'] }
  const user = { sub: 'u', email: 'u@example.com', groups: ['trace-users'] }
  const sm = fakeSecrets()
  const deps = {
    github: async () => { throw new Error('unused') }, cognito: () => { throw new Error('unused') }, jobs: async () => { throw new Error('unused') },
    tools: () => { throw new Error('unused') }, scratch: '/tmp',
    integrations: async () => new IntegrationStore('trace', sm),
    checkIntegration: async () => ({ ok: true, detail: 'checked' }),
  } as never

  it('lets admins set, list and remove integrations, and nobody else', async () => {
    const set = await perform('integrations.set', { name: 'mouser', values: { MOUSER_API_KEY: 'api-key' } }, { principal: admin, deps })
    expect(set.result).toMatchObject({ name: 'mouser', secret: 'trace/integrations/mouser', check: { ok: true } })
    const list = await perform('integrations.list', {}, { principal: admin, deps })
    expect(JSON.stringify(list.result)).not.toContain('api-key')
    await expect(perform('integrations.list', {}, { principal: user, deps })).rejects.toThrow(/admins only/)
    await expect(perform('integrations.set', { name: 'mouser', values: { MOUSER_API_KEY: 'x' } }, { principal: user, deps })).rejects.toThrow(/admins only/)
    await expect(perform('integrations.set', { name: 'octopus', values: {} }, { principal: admin, deps })).rejects.toThrow(ActionError)
    expect((await perform('integrations.remove', { name: 'mouser' }, { principal: admin, deps })).result).toEqual({ name: 'mouser', removed: true })
  })
})

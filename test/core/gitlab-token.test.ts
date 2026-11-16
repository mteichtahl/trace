import { describe, expect, it } from 'vitest'
import { ROTATE_BEFORE_DAYS, type StoredToken, agentTokenSecretName, parseStored, rotateAgentTokens } from '../../src/core/gitlab-token.js'
import { run } from '../../src/infra/lambda/gitlab-token-rotate.js'

const NOW = Date.parse('2026-11-16T10:00:00Z')
const day = (n: number) => new Date(NOW + n * 86_400_000).toISOString().slice(0, 10)

function gitlab(tokens: Record<number, { id: number; name: string; active: boolean; expires_at: string; user_id: number }[]>, fail: number[] = []) {
  const asked: { method: string; path: string; body?: unknown }[] = []
  const projects = [{ id: 1, path: 'board', path_with_namespace: 'tr/board' }, { id: 2, path: 'case', path_with_namespace: 'tr/case' }, { id: 3, path: 'old', path_with_namespace: 'tr/old', archived: true }]
  const fetch = (async (u: string, init: RequestInit) => {
    const path = new URL(u).pathname.replace('/api/v4', '') + new URL(u).search
    const method = init.method ?? 'GET'
    asked.push({ method, path, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) })
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
    if (path.startsWith('/groups/tr/projects')) return ok(projects)
    const m = /^\/projects\/(\d+)\/access_tokens(?:\/(\d+)\/rotate)?/.exec(path)
    if (m) {
      const id = Number(m[1])
      if (fail.includes(id)) return new Response('{}', { status: 500 })
      if (!m[2]) return ok(tokens[id] ?? [])
      return ok({ id: Number(m[2]), name: 'trace-agents', active: true, user_id: 900 + id, token: `glpat-new-${id}` })
    }
    const u2 = /^\/users\/(\d+)$/.exec(path)
    if (u2) return ok({ username: `project_${Number(u2[1]) - 900}_bot_x` })
    return new Response('{}', { status: 404 })
  }) as unknown as typeof globalThis.fetch
  return { fetch, asked }
}

const stored = (project: string): string => JSON.stringify({ token: 't', expiresAt: day(3), login: 'b', project })

describe('rotateAgentTokens', () => {
  it('rotates a token near its end or without a stored value, keeps a fresh one, skips archived projects', async () => {
    const gl = gitlab({
      1: [{ id: 11, name: 'trace-agents', active: true, expires_at: day(ROTATE_BEFORE_DAYS + 1), user_id: 901 }],
      2: [{ id: 21, name: 'trace-agents', active: true, expires_at: day(1), user_id: 902 }],
    })
    const kept = new Map<string, StoredToken>()
    const r = await rotateAgentTokens({
      url: 'https://git.example', adminToken: 'adm', group: 'tr', fetch: gl.fetch, now: () => NOW,
      read: async (slug) => (slug === 'board' ? stored('tr/board') : slug === 'case' ? stored('tr/case') : null),
      write: async (slug, v) => { kept.set(slug, v) },
    })
    expect(r).toEqual([{ project: 'tr/board', outcome: 'fresh' }, { project: 'tr/case', outcome: 'rotated', detail: `until ${day(3)}` }])
    expect(kept.get('case')).toEqual({ token: 'glpat-new-2', expiresAt: day(3), login: 'project_2_bot_x', project: 'tr/case' })
    expect(gl.asked.find((a) => a.path.endsWith('/rotate'))).toMatchObject({ method: 'POST', path: '/projects/2/access_tokens/21/rotate', body: { expires_at: day(3) } })
    expect(gl.asked.some((a) => a.path.startsWith('/projects/3'))).toBe(false)
  })

  it('rotates a fresh token that has no stored value, so its value is kept', async () => {
    const gl = gitlab({ 1: [{ id: 11, name: 'trace-agents', active: true, expires_at: day(2.9), user_id: 901 }], 2: [] })
    const kept = new Map<string, StoredToken>()
    const r = await rotateAgentTokens({ url: 'https://git.example', adminToken: 'adm', group: 'tr', fetch: gl.fetch, now: () => NOW, read: async () => null, write: async (s, v) => { kept.set(s, v) } })
    expect(r.map((x) => x.outcome)).toEqual(['rotated', 'no-token'])
    expect(kept.get('board')?.token).toBe('glpat-new-1')
  })

  it('one project failing does not stop the others', async () => {
    const gl = gitlab({ 2: [{ id: 21, name: 'trace-agents', active: true, expires_at: day(1), user_id: 902 }] }, [1])
    const r = await rotateAgentTokens({ url: 'https://git.example', adminToken: 'adm', group: 'tr', fetch: gl.fetch, now: () => NOW, read: async () => null, write: async () => {} })
    expect(r.map((x) => x.outcome)).toEqual(['failed', 'rotated'])
  })
})

describe('the rotation function', () => {
  it('does nothing until GitLab has made the admin token, and never logs a token', async () => {
    const lines: Record<string, unknown>[] = []
    const store = { read: async () => 'pending', write: async () => {} }
    expect(await run({ prefix: 'tr', url: 'https://git.example', adminSecret: 'arn:admin', store, log: (l) => lines.push(l) })).toEqual([])
    expect(lines).toEqual([{ outcome: 'skipped', reason: 'GitLab has not made trace\'s admin token yet' }])

    const gl = gitlab({ 1: [], 2: [{ id: 21, name: 'trace-agents', active: true, expires_at: day(1), user_id: 902 }] })
    const written = new Map<string, string>()
    const store2 = { read: async (n: string) => (n === 'arn:admin' ? '{"token":"adm"}' : null), write: async (n: string, v: string) => { written.set(n, v) } }
    const logged: Record<string, unknown>[] = []
    await run({ prefix: 'tr', url: 'https://git.example', adminSecret: 'arn:admin', store: store2, fetch: gl.fetch, log: (l) => logged.push(l) })
    expect(parseStored(written.get(agentTokenSecretName('tr', 'case')))?.token).toBe('glpat-new-2')
    expect(JSON.stringify(logged)).not.toContain('glpat')
  })
})

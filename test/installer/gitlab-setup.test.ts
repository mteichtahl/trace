import { describe, expect, it } from 'vitest'
import { ACCESS, GitlabAdmin, GitlabSetupError, TRACE_LABELS, setUpGitlabProject } from '../../src/installer/gitlab-setup.js'

type Req = { method: string; path: string; body: Record<string, unknown> | undefined }

/** A small GitLab that keeps what is made, so a second run finds it. */
function fakeGitlab() {
  const asked: Req[] = []
  const groups = new Map<string, number>()
  const projects = new Map<string, { id: number; default_branch: string }>()
  const protectedBranches = new Map<number, Map<string, Record<string, unknown>>>()
  const tokens = new Map<number, { id: number; name: string; active: boolean; user_id: number }[]>()
  const variables = new Map<string, string>()
  const hooks = new Map<number, { id: number; url: string }[]>()
  const labels = new Map<number, Set<string>>()
  let next = 100
  const res = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status })
  const fetch = (async (u: string, init: RequestInit) => {
    const url = new URL(u)
    const path = decodeURIComponent(url.pathname.replace('/api/v4', '')) + url.search
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    asked.push({ method, path, body })
    let m: RegExpExecArray | null
    if (method === 'GET' && (m = /^\/groups\/([^/?]+)$/.exec(path))) return groups.has(m[1]!) ? res(200, { id: groups.get(m[1]!) }) : res(404, { message: '404 Group Not Found' })
    if (method === 'POST' && path === '/groups') { const id = next++; groups.set(String(body?.path), id); return res(201, { id }) }
    if (method === 'GET' && (m = /^\/projects\/([^/?]+\/[^/?]+)$/.exec(path))) {
      const p = projects.get(m[1]!)
      return p ? res(200, { id: p.id, path_with_namespace: m[1], default_branch: p.default_branch }) : res(404, { message: '404 Project Not Found' })
    }
    if (method === 'POST' && path === '/projects') {
      const id = next++
      const group = [...groups.entries()].find(([, g]) => g === body?.namespace_id)?.[0]
      projects.set(`${group}/${body?.path}`, { id, default_branch: String(body?.default_branch) })
      return res(201, { id, path_with_namespace: `${group}/${body?.path}`, default_branch: body?.default_branch })
    }
    if ((m = /^\/projects\/(\d+)(.*)$/.exec(path))) {
      const id = Number(m[1])
      const rest = m[2]!.replace(/\?.*$/, '')
      if (method === 'PUT' && rest === '') return res(200, { id })
      const pb = protectedBranches.get(id) ?? new Map()
      protectedBranches.set(id, pb)
      if ((m = /^\/protected_branches\/(.+)$/.exec(rest))) {
        if (method === 'GET') return pb.has(m[1]!) ? res(200, pb.get(m[1]!)) : res(404, {})
        if (method === 'DELETE') { pb.delete(m[1]!); return res(204, null) }
      }
      if (rest === '/protected_branches' && method === 'POST') {
        if (pb.has(String(body?.name))) return res(409, { message: 'Protected branch already exists' })
        pb.set(String(body?.name), body ?? {}); return res(201, body)
      }
      if (rest === '/access_tokens') {
        const list = tokens.get(id) ?? []
        tokens.set(id, list)
        if (method === 'GET') return res(200, list)
        const t = { id: next++, name: String(body?.name), active: true, user_id: 900 + id }
        list.push(t)
        return res(201, { ...t, token: `glpat-${id}` })
      }
      if (rest === '/variables' && method === 'POST') { variables.set(`${id}:${body?.key}`, String(body?.value)); return res(201, body) }
      if ((m = /^\/variables\/(.+)$/.exec(rest))) {
        const k = `${id}:${m[1]}`
        if (method === 'GET') return variables.has(k) ? res(200, { value: variables.get(k) }) : res(404, {})
        if (method === 'PUT') { variables.set(k, String(body?.value)); return res(200, body) }
      }
      if (rest === '/hooks') {
        const list = hooks.get(id) ?? []
        hooks.set(id, list)
        if (method === 'GET') return res(200, list)
        list.push({ id: next++, url: String(body?.url) }); return res(201, {})
      }
      if (/^\/hooks\/\d+$/.test(rest) && method === 'PUT') return res(200, {})
      if (rest === '/labels') {
        const set = labels.get(id) ?? new Set<string>()
        labels.set(id, set)
        if (method === 'GET') return res(200, [...set].map((name) => ({ name })))
        set.add(String(body?.name)); return res(201, body)
      }
    }
    if (method === 'GET' && (m = /^\/users\/(\d+)$/.exec(path))) return res(200, { username: `project_${Number(m[1]) - 900}_bot_abc` })
    return res(404, { message: `no route ${method} ${path}` })
  }) as unknown as typeof globalThis.fetch
  return { fetch, asked, projects, protectedBranches, tokens, variables, hooks, labels }
}

describe('setUpGitlabProject', () => {
  it('makes the group, the project, its rules, labels, the agents\' token and webhook; a second run makes nothing new', async () => {
    const gl = fakeGitlab()
    const admin = new GitlabAdmin('glpat-admin', { url: 'https://git.example/', fetch: gl.fetch })
    const first = await setUpGitlabProject(admin, { group: 'trace', slug: 'test-esp32', branch: 'main', hook: { url: 'https://hooks.example/gitlab', secret: 's3' } })
    const id = first.id
    expect(first).toMatchObject({ path: 'trace/test-esp32', defaultBranch: 'main', agentToken: `glpat-${id}`, agentLogin: `project_${id}_bot_abc` })
    expect(gl.protectedBranches.get(id)?.get('main')).toMatchObject({ push_access_level: ACCESS.none, merge_access_level: ACCESS.maintainer, allow_force_push: false })
    expect([...gl.labels.get(id) ?? []]).toEqual(TRACE_LABELS.map((l) => l.name))
    expect(gl.variables.get(`${id}:TRACE_AGENT_LOGIN`)).toBe(`project_${id}_bot_abc`)
    expect(gl.hooks.get(id)).toHaveLength(1)
    const tokenAsk = gl.asked.find((a) => a.method === 'POST' && a.path.endsWith('/access_tokens'))
    expect(tokenAsk?.body).toMatchObject({ name: 'trace-agents', access_level: ACCESS.developer, scopes: ['api', 'write_repository'] })
    expect(gl.asked.every((a) => a.method !== 'POST' || !a.path.includes('/users'))).toBe(true)

    const second = await setUpGitlabProject(admin, { group: 'trace', slug: 'test-esp32', branch: 'main', hook: { url: 'https://hooks.example/gitlab', secret: 's3' } })
    expect(second.agentToken).toBeNull()
    expect(second.lines).toContain('trace/test-esp32 is there')
    expect(gl.tokens.get(id)).toHaveLength(1)
    expect(gl.hooks.get(id)).toHaveLength(1)
    expect(gl.projects.size).toBe(1)
  })

  it('keeps the project\'s own default branch when it has one', async () => {
    const gl = fakeGitlab()
    const admin = new GitlabAdmin('t', { url: 'https://git.example', fetch: gl.fetch })
    await setUpGitlabProject(admin, { group: 'trace', slug: 'board', branch: 'trunk' })
    const again = await setUpGitlabProject(admin, { group: 'trace', slug: 'board', branch: 'main' })
    expect(again.defaultBranch).toBe('trunk')
    expect(gl.protectedBranches.get(again.id)?.has('trunk')).toBe(true)
  })

  it('says what GitLab refused', async () => {
    const fetch = (async () => new Response(JSON.stringify({ message: '403 Forbidden' }), { status: 403 })) as unknown as typeof globalThis.fetch
    const admin = new GitlabAdmin('t', { url: 'https://git.example', fetch })
    const e = await setUpGitlabProject(admin, { group: 'trace', slug: 'x', branch: 'main' }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(GitlabSetupError)
    expect(e).toMatchObject({ status: 403 })
  })
})

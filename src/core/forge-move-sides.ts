/**
 * The two homes a project's repository can have, as the mover sees them (src/core/forge-move.ts MoveSide): GitHub
 * (REST, with a token that may make and push to the repository: trace's GitHub app, which the default branch's
 * ruleset lets through) and trace's GitLab (REST v4, with its admin token, before the project's default branch is
 * protected: the mover runs before the set-up that protects it). Plain fetch, each answer read with zod.
 */
import { z } from 'zod'
import type { MoveSide, OpenChange, OpenIssue } from './forge-move.js'

class SideError extends Error {
  override name = 'SideError'
  constructor(readonly status: number, message: string) { super(message) }
}

function client(base: string, auth: string, f: typeof fetch) {
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    const r = await f(`${base}${path}`, {
      method,
      headers: { authorization: auth, accept: 'application/json', 'user-agent': 'trace-move', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
    return { status: r.status, json: r.status === 204 ? null : await r.json().catch(() => null) }
  }
  const ok = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const r = await call(method, path, body)
    if (r.status < 200 || r.status >= 300) throw new SideError(r.status, `${method} ${path.split('?')[0]}: ${r.status}`)
    return r.json
  }
  return { call, ok }
}

const basic = (user: string, token: string): string => `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`

/** GitHub: `owner/name`. */
export function githubSide(o: { repository: string; token: string; fetch?: typeof fetch; api?: string }): MoveSide {
  const api = client(o.api ?? 'https://api.github.com', `Bearer ${o.token}`, o.fetch ?? fetch)
  const R = `/repos/${o.repository}`
  const [owner = '', name = ''] = o.repository.split('/')
  const Repo = z.object({ default_branch: z.string(), archived: z.boolean().optional() }).loose()
  const Pull = z.object({ number: z.number(), title: z.string(), body: z.string().nullable(), head: z.object({ ref: z.string() }).loose(), base: z.object({ ref: z.string() }).loose(), labels: z.array(z.object({ name: z.string() }).loose()), user: z.object({ login: z.string() }).loose().nullable() }).loose()
  const Comment = z.object({ body: z.string().nullable(), created_at: z.string(), user: z.object({ login: z.string() }).loose().nullable() }).loose()
  const Issue = z.object({ number: z.number(), title: z.string(), body: z.string().nullable(), labels: z.array(z.object({ name: z.string() }).loose()), user: z.object({ login: z.string() }).loose().nullable(), pull_request: z.unknown().optional() }).loose()
  return {
    forge: 'github', where: o.repository,
    ensure: async () => {
      const had = await api.call('GET', R)
      if (had.status === 200) {
        if (Repo.parse(had.json).archived) await api.ok('PATCH', R, { archived: false })
        return { made: false }
      }
      if (had.status !== 404) throw new SideError(had.status, `GET ${R}: ${had.status}`)
      const me = z.object({ login: z.string() }).loose().safeParse((await api.call('GET', '/user')).json)
      const path = me.success && me.data.login.toLowerCase() === owner.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`
      await api.ok('POST', path, { name, private: true, has_wiki: false, auto_init: false })
      return { made: true }
    },
    git: async () => ({ url: `https://github.com/${o.repository}.git`, header: `Authorization: ${basic('x-access-token', o.token)}` }),
    defaultBranch: async () => Repo.parse(await api.ok('GET', R)).default_branch,
    openChanges: async () => {
      const pulls = z.array(Pull).parse(await api.ok('GET', `${R}/pulls?state=open&per_page=100`))
      return Promise.all(pulls.map(async (p): Promise<OpenChange> => {
        const comments = z.array(Comment).parse(await api.ok('GET', `${R}/issues/${p.number}/comments?per_page=100`))
        return {
          number: p.number, title: p.title, body: p.body ?? '', head: p.head.ref, base: p.base.ref, labels: p.labels.map((l) => l.name), author: p.user?.login ?? null,
          comments: comments.map((c) => ({ author: c.user?.login ?? 'someone', body: c.body ?? '', at: c.created_at })),
        }
      }))
    },
    openIssues: async () => z.array(Issue).parse(await api.ok('GET', `${R}/issues?state=open&per_page=100`)).filter((i) => !i.pull_request)
      .map((i): OpenIssue => ({ number: i.number, title: i.title, body: i.body ?? '', labels: i.labels.map((l) => l.name), author: i.user?.login ?? null })),
    openChange: async (c) => {
      const p = z.object({ number: z.number() }).loose().parse(await api.ok('POST', `${R}/pulls`, { title: c.title, body: c.body, head: c.head, base: c.base }))
      if (c.labels.length) await api.ok('POST', `${R}/issues/${p.number}/labels`, { labels: c.labels })
      return p.number
    },
    openIssue: async (i) => z.object({ number: z.number() }).loose().parse(await api.ok('POST', `${R}/issues`, { title: i.title, body: i.body, labels: i.labels })).number,
    archive: async () => { await api.ok('PATCH', R, { archived: true }) },
  }
}

/** trace's GitLab: `<group>/<name>`, made private in the installation's group. */
export function gitlabSide(o: { url: string; token: string; group: string; name: string; fetch?: typeof fetch }): MoveSide {
  const base = o.url.replace(/\/+$/, '')
  const api = client(`${base}/api/v4`, `Bearer ${o.token}`, o.fetch ?? fetch)
  const path = `${o.group}/${o.name}`
  const P = `/projects/${encodeURIComponent(path)}`
  const Project = z.object({ id: z.number(), default_branch: z.string().nullable().optional(), archived: z.boolean().optional() }).loose()
  const Mr = z.object({ iid: z.number(), title: z.string(), description: z.string().nullable().optional(), source_branch: z.string(), target_branch: z.string(), labels: z.array(z.string()).default([]), author: z.object({ username: z.string() }).loose().nullable().optional() }).loose()
  const Note = z.object({ body: z.string(), system: z.boolean().optional(), created_at: z.string(), author: z.object({ username: z.string() }).loose() }).loose()
  const Issue = z.object({ iid: z.number(), title: z.string(), description: z.string().nullable().optional(), labels: z.array(z.string()).default([]), author: z.object({ username: z.string() }).loose().nullable().optional() }).loose()
  return {
    forge: 'gitlab', where: path,
    ensure: async () => {
      const had = await api.call('GET', P)
      if (had.status === 200) {
        const p = Project.parse(had.json)
        if (p.archived) await api.ok('POST', `/projects/${p.id}/unarchive`)
        return { made: false }
      }
      if (had.status !== 404) throw new SideError(had.status, `GET project: ${had.status}`)
      const g = await api.call('GET', `/groups/${encodeURIComponent(o.group)}`)
      const groupId = g.status === 200
        ? z.object({ id: z.number() }).loose().parse(g.json).id
        : z.object({ id: z.number() }).loose().parse(await api.ok('POST', '/groups', { name: `trace ${o.group}`, path: o.group, visibility: 'private' })).id
      await api.ok('POST', '/projects', { name: o.name, path: o.name, namespace_id: groupId, visibility: 'private', initialize_with_readme: false })
      return { made: true }
    },
    git: async () => ({ url: `${base}/${path}.git`, header: `Authorization: ${basic('oauth2', o.token)}` }),
    defaultBranch: async () => Project.parse(await api.ok('GET', P)).default_branch ?? 'main',
    openChanges: async () => {
      const mrs = z.array(Mr).parse(await api.ok('GET', `${P}/merge_requests?state=opened&per_page=100`))
      return Promise.all(mrs.map(async (m): Promise<OpenChange> => {
        const notes = z.array(Note).parse(await api.ok('GET', `${P}/merge_requests/${m.iid}/notes?sort=asc&per_page=100`)).filter((n) => !n.system)
        return {
          number: m.iid, title: m.title, body: m.description ?? '', head: m.source_branch, base: m.target_branch, labels: m.labels, author: m.author?.username ?? null,
          comments: notes.map((n) => ({ author: n.author.username, body: n.body, at: n.created_at })),
        }
      }))
    },
    openIssues: async () => z.array(Issue).parse(await api.ok('GET', `${P}/issues?state=opened&per_page=100`))
      .map((i): OpenIssue => ({ number: i.iid, title: i.title, body: i.description ?? '', labels: i.labels, author: i.author?.username ?? null })),
    openChange: async (c) => z.object({ iid: z.number() }).loose().parse(await api.ok('POST', `${P}/merge_requests`, {
      source_branch: c.head, target_branch: c.base, title: c.title, description: c.body, labels: c.labels.join(','), remove_source_branch: true,
    })).iid,
    openIssue: async (i) => z.object({ iid: z.number() }).loose().parse(await api.ok('POST', `${P}/issues`, { title: i.title, description: i.body, labels: i.labels.join(',') })).iid,
    archive: async () => { await api.ok('POST', `${P}/archive`) },
  }
}

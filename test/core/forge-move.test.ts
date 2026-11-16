import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type MoveSide, type OpenChange, carriedComment, moveRepository, stackOrder } from '../../src/core/forge-move.js'
import { githubSide, gitlabSide } from '../../src/core/forge-move-sides.js'

const g = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' }, stdio: ['ignore', 'pipe', 'pipe'] })
const change = (number: number, head: string, base: string, o: Partial<OpenChange> = {}): OpenChange => ({ number, title: `c${number}`, body: '', head, base, labels: [], author: 'project_9_bot', comments: [], ...o })

describe('stackOrder', () => {
  it('puts each change after the one it is built on, whatever their numbers', () => {
    const order = stackOrder([change(9, 'trace/top', 'trace/mid'), change(3, 'trace/other', 'main'), change(7, 'trace/mid', 'trace/base'), change(5, 'trace/base', 'main')])
    expect(order.map((c) => c.number)).toEqual([3, 5, 7, 9])
    expect(stackOrder([change(2, 'a', 'b'), change(1, 'b', 'a')]).map((c) => c.number)).toHaveLength(2)
  })
})

/** A forge of one bare repository and open changes and issues kept in memory. */
function localSide(forge: 'github' | 'gitlab', where: string, root: string, o: { changes?: OpenChange[]; issues?: { number: number; title: string; body: string; labels: string[]; author: string | null }[]; exists?: boolean } = {}) {
  const bare = join(root, `${where.replace('/', '-')}.git`)
  if (o.exists) g(root, 'init', '-q', '--bare', '-b', 'main', bare)
  const made: { changes: { title: string; body: string; head: string; base: string; labels: string[] }[]; issues: { title: string; body: string; labels: string[] }[]; archived: boolean } = { changes: [], issues: [], archived: false }
  let next = 100
  const side: MoveSide = {
    forge, where,
    ensure: async () => { if (o.exists) return { made: false }; g(root, 'init', '-q', '--bare', '-b', 'main', bare); return { made: true } },
    git: async () => ({ url: bare, header: 'Authorization: Basic eDp5' }),
    defaultBranch: async () => 'main',
    openChanges: async () => o.changes ?? [],
    openIssues: async () => o.issues ?? [],
    openChange: async (c) => { made.changes.push(c); return next++ },
    openIssue: async (i) => { made.issues.push(i); return next++ },
    archive: async () => { made.archived = true },
  }
  return { side, made, bare }
}

describe('moveRepository', () => {
  it('copies every branch and tag, recreates open changes bottom first and issues, and archives the old home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'move-'))
    const from = localSide('github', 'mteichtahl/board', root, {
      exists: true,
      changes: [change(12, 'trace/top', 'trace/power', { comments: [{ author: 'marc', body: 'looks good', at: '2026-11-16' }] }), change(11, 'trace/power', 'main', { labels: ['trace'] })],
      issues: [{ number: 4, title: 'Fix the LED', body: 'b', labels: ['agent-fix'], author: 'marc' }],
    })
    const work = mkdtempSync(join(tmpdir(), 'w-'))
    g(work, 'init', '-q', '-b', 'main'); writeFileSync(join(work, 'a'), '1'); g(work, 'add', '.'); g(work, 'commit', '-qm', 'one'); g(work, 'tag', 'v1')
    g(work, 'checkout', '-qb', 'trace/power'); writeFileSync(join(work, 'b'), '2'); g(work, 'add', '.'); g(work, 'commit', '-qm', 'power')
    g(work, 'checkout', '-qb', 'trace/top'); writeFileSync(join(work, 'c'), '3'); g(work, 'add', '.'); g(work, 'commit', '-qm', 'top')
    g(work, 'push', '-q', from.bare, '--all'); g(work, 'push', '-q', from.bare, '--tags')
    const to = localSide('gitlab', 'tr/board', root)

    const r = await moveRepository(from.side, to.side)
    expect(g(to.bare, 'branch', '--list').split('\n').map((l) => l.trim().replace('* ', '')).filter(Boolean).sort()).toEqual(['main', 'trace/power', 'trace/top'])
    expect(g(to.bare, 'tag', '--list').trim()).toBe('v1')
    expect(g(to.bare, 'rev-parse', 'trace/top')).toBe(g(from.bare, 'rev-parse', 'trace/top'))
    expect(to.made.changes.map((c) => [c.head, c.base])).toEqual([['trace/power', 'main'], ['trace/top', 'trace/power']])
    expect(r.changes).toEqual({ 11: 100, 12: 101 })
    expect(r.issues).toEqual({ 4: 102 })
    expect(to.made.changes[1]?.body).toContain('**marc** (2026-11-16):')
    expect(to.made.issues[0]).toMatchObject({ labels: ['agent-fix'], body: expect.stringContaining('Moved from mteichtahl/board#4') })
    expect(from.made.archived).toBe(true)
    expect(r.lines).toEqual(['made tr/board', 'copied every branch and tag', 'recreated 2 open changes', 'recreated 1 open issue', 'archived mteichtahl/board (read-only, not deleted)'])
  })

  it('a failure before the old home is archived leaves it as it was', async () => {
    const root = mkdtempSync(join(tmpdir(), 'move-'))
    const from = localSide('github', 'mteichtahl/board', root, { exists: true })
    const to = localSide('gitlab', 'tr/board', root)
    to.side.openIssue = async () => { throw new Error('GitLab said no') }
    const work = mkdtempSync(join(tmpdir(), 'w-'))
    g(work, 'init', '-q', '-b', 'main'); writeFileSync(join(work, 'a'), '1'); g(work, 'add', '.'); g(work, 'commit', '-qm', 'one'); g(work, 'push', '-q', from.bare, 'main')
    from.side.openIssues = async () => [{ number: 1, title: 't', body: '', labels: [], author: null }]
    await expect(moveRepository(from.side, to.side)).rejects.toThrow('GitLab said no')
    expect(from.made.archived).toBe(false)
  })

  it('the carried comment says where a change came from and who opened it', () => {
    const { side } = localSide('gitlab', 'tr/board', mkdtempSync(join(tmpdir(), 'x-')), { exists: true })
    expect(carriedComment(side, change(3, 'h', 'main'))).toBe("Moved from trace's GitLab (tr/board, #3), opened by project_9_bot.")
  })
})

describe('the two homes', () => {
  function fake(routes: Record<string, [number, unknown]>) {
    const asked: { method: string; path: string; body?: unknown; auth?: string }[] = []
    const fetch = (async (u: string, init: RequestInit) => {
      const url = new URL(u)
      const path = url.pathname + url.search
      asked.push({ method: init.method ?? 'GET', path, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}), auth: (init.headers as Record<string, string>).authorization })
      const hit = routes[`${init.method ?? 'GET'} ${path}`]
      return new Response(hit ? JSON.stringify(hit[1]) : '{}', { status: hit ? hit[0] : 404 })
    }) as unknown as typeof globalThis.fetch
    return { fetch, asked }
  }

  it('GitHub: an archived repository from an earlier move is un-archived and reused; git signs in by header', async () => {
    const { fetch, asked } = fake({ 'GET /repos/mteichtahl/board': [200, { default_branch: 'main', archived: true }], 'PATCH /repos/mteichtahl/board': [200, {}] })
    const s = githubSide({ repository: 'mteichtahl/board', token: 'ghs_x', fetch })
    expect(await s.ensure()).toEqual({ made: false })
    expect(asked.at(-1)).toMatchObject({ method: 'PATCH', body: { archived: false } })
    const git = await s.git()
    expect(git.url).toBe('https://github.com/mteichtahl/board.git')
    expect(git.url).not.toContain('ghs_x')
    expect(git.header).toBe(`Authorization: Basic ${Buffer.from('x-access-token:ghs_x').toString('base64')}`)
  })

  it('GitHub: makes a private repository in an organisation when missing', async () => {
    const { fetch, asked } = fake({ 'GET /user': [200, { login: 'marc' }], 'POST /orgs/acme/repos': [201, {}] })
    expect(await githubSide({ repository: 'acme/board', token: 't', fetch }).ensure()).toEqual({ made: true })
    expect(asked.at(-1)).toMatchObject({ method: 'POST', path: '/orgs/acme/repos', body: { name: 'board', private: true } })
  })

  it('GitLab: makes the project private in the installation\'s group; recreates a change with its labels', async () => {
    const { fetch, asked } = fake({
      'GET /api/v4/groups/tr': [200, { id: 5 }], 'POST /api/v4/projects': [201, { id: 9 }],
      'POST /api/v4/projects/tr%2Fboard/merge_requests': [201, { iid: 3 }],
    })
    const s = gitlabSide({ url: 'https://git.example/', token: 'glpat', group: 'tr', name: 'board', fetch })
    expect(await s.ensure()).toEqual({ made: true })
    expect(asked.find((a) => a.path === '/api/v4/projects')?.body).toMatchObject({ path: 'board', namespace_id: 5, visibility: 'private' })
    expect(await s.openChange({ title: 't', body: 'b', head: 'trace/top', base: 'trace/power', labels: ['trace', 'hold'] })).toBe(3)
    expect(asked.at(-1)?.body).toMatchObject({ source_branch: 'trace/top', target_branch: 'trace/power', labels: 'trace,hold' })
    expect((await s.git()).url).toBe('https://git.example/tr/board.git')
  })
})

import { describe, expect, it } from 'vitest'
import { HttpGitHub } from '../../src/api/github.js'

/** A fetch that answers from a table of "METHOD path" → [status, body], and records what was asked. */
function fakeFetch(routes: Record<string, [number, unknown]>): { fetch: typeof fetch; asked: { url: string; accept: string }[] } {
  const asked: { url: string; accept: string }[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    asked.push({ url, accept: headers.accept ?? '' })
    const key = `${init?.method ?? 'GET'} ${url.replace('https://api.github.com', '')}`
    const hit = routes[key]
    if (!hit) return new Response('{"message":"Not Found"}', { status: 404 })
    return new Response(JSON.stringify(hit[1]), { status: hit[0], headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetch: f, asked }
}

describe('HttpGitHub: what the web app\'s actions add', () => {
  it('branchSha: the branch\'s commit, or null when there is none', async () => {
    const { fetch } = fakeFetch({ 'GET /repos/acme/board/git/ref/heads/trace/onboard': [200, { object: { sha: 'abc' } }] })
    const gh = new HttpGitHub('t', { fetch })
    expect(await gh.branchSha('acme/board', 'trace/onboard')).toBe('abc')
    expect(await gh.branchSha('acme/board', 'trace/none')).toBeNull()
  })

  it('tree: the blobs only, recursively, with truncation', async () => {
    const { fetch, asked } = fakeFetch({ 'GET /repos/acme/board/git/trees/main?recursive=1': [200, { truncated: true, tree: [
      { path: 'hw', type: 'tree', sha: 't1' }, { path: 'hw/a.kicad_sch', type: 'blob', sha: 'b1', size: 12 },
    ] }] })
    const r = await new HttpGitHub('t', { fetch }).tree('acme/board', 'main')
    expect(r).toEqual({ truncated: true, files: [{ path: 'hw/a.kicad_sch', size: 12, sha: 'b1' }] })
    expect(asked[0]?.url).toBe('https://api.github.com/repos/acme/board/git/trees/main?recursive=1')
  })

  it('fileInfo: size, sha and the download link of a file; null for a folder or nothing', async () => {
    const { fetch } = fakeFetch({
      'GET /repos/acme/board/contents/big/render.mp4?ref=main': [200, { type: 'file', size: 9e7, sha: 's', download_url: 'https://raw.githubusercontent.com/x?token=y' }],
      'GET /repos/acme/board/contents/hw?ref=main': [200, [{ type: 'file' }]],
    })
    const gh = new HttpGitHub('t', { fetch })
    expect(await gh.fileInfo('acme/board', 'big/render.mp4', 'main')).toEqual({ size: 9e7, sha: 's', downloadUrl: 'https://raw.githubusercontent.com/x?token=y' })
    expect(await gh.fileInfo('acme/board', 'hw', 'main')).toBeNull()
    expect(await gh.fileInfo('acme/board', 'none', 'main')).toBeNull()
  })
})

describe('checks for a fine-grained token (no "Checks: read" exists for one)', () => {
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const gh = (o: { actions: number; statuses: number }) => new HttpGitHub('github_pat_x', {
    fetch: (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/check-runs')) return json(403, { message: 'Resource not accessible by personal access token' })
      if (url.includes('/actions/runs?head_sha=abc')) {
        return o.actions === 200 ? json(200, { workflow_runs: [
          { id: 1, name: 'ci', path: '.github/workflows/ci.yml', event: 'pull_request', status: 'completed', conclusion: 'failure', head_branch: 'claude/x', html_url: 'u', created_at: '2026-11-01T00:00:00Z' },
          { id: 2, name: 'ci', path: '.github/workflows/ci.yml', event: 'pull_request', status: 'completed', conclusion: 'success', head_branch: 'claude/x', html_url: 'u', created_at: '2026-11-01T01:00:00Z' },
          { id: 3, name: 'erc', path: '.github/workflows/erc.yml', event: 'pull_request', status: 'in_progress', conclusion: null, head_branch: 'claude/x', html_url: 'u', created_at: '2026-11-01T01:00:00Z' },
        ] }) : json(o.actions, { message: 'no' })
      }
      if (url.endsWith('/commits/abc/status')) return o.statuses === 200 ? json(200, { state: 'success', statuses: [{ context: 'drc', state: 'success', description: 'clean' }] }) : json(o.statuses, { message: 'no' })
      return json(404, { message: 'Not Found' })
    }) as typeof fetch,
  })

  it('reads the commit\'s workflow runs (the latest of each) and commit statuses when check runs are refused', async () => {
    expect(await gh({ actions: 200, statuses: 200 }).checkRuns('acme/board', 'abc')).toEqual([
      { name: 'ci', status: 'completed', conclusion: 'success', summary: null },
      { name: 'erc', status: 'in_progress', conclusion: null, summary: null },
      { name: 'drc', status: 'completed', conclusion: 'success', summary: 'clean' },
    ])
  })

  it('uses whichever of the two it may read, and refuses only when both are refused', async () => {
    expect((await gh({ actions: 403, statuses: 200 }).checkRuns('acme/board', 'abc')).map((c) => c.name)).toEqual(['drc'])
    await expect(gh({ actions: 403, statuses: 403 }).checkRuns('acme/board', 'abc')).rejects.toMatchObject({ status: 403 })
  })
})

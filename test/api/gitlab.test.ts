import { describe, expect, it } from 'vitest'
import { GitHubError } from '../../src/api/github.js'
import { HttpGitLab, diffCounts, gitlabRateLimitWords, gitlabStatus, mergeableOf } from '../../src/api/gitlab.js'

const BASE = 'https://git.example/api/v4'
type Route = [number, unknown, Record<string, string>?]

/** A fetch that answers from a table of "METHOD path" → [status, body, headers], and records what was asked. */
function fakeFetch(routes: Record<string, Route>): { fetch: typeof fetch; asked: { method: string; path: string; body: unknown }[] } {
  const asked: { method: string; path: string; body: unknown }[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace(BASE, '')
    const method = init?.method ?? 'GET'
    asked.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const hit = routes[`${method} ${path}`]
    if (!hit) return new Response('{"message":"404 Not Found"}', { status: 404 })
    const [status, body, headers] = hit
    return new Response(body === null ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  }) as typeof fetch
  return { fetch: f, asked }
}

const P = '/projects/trace%2Fboard'
const mr = (o: Record<string, unknown> = {}) => ({
  iid: 4, title: 'Add the regulator', draft: false, web_url: 'https://git.example/trace/board/-/merge_requests/4', updated_at: '2026-11-16T01:00:00Z',
  created_at: '2026-11-15T01:00:00Z', source_branch: 'trace/power', target_branch: 'main', sha: 'h1', labels: ['trace'],
  author: { username: 'trace-bot' }, project_id: 9, source_project_id: 9, ...o,
})

describe('HttpGitLab', () => {
  it('takes the address with or without /api/v4, and names a project by its path', async () => {
    const { fetch, asked } = fakeFetch({ [`GET ${P}/repository/branches/trace%2Fpower`]: [200, { commit: { id: 'abc' } }] })
    for (const base of ['https://git.example', 'https://git.example/', 'https://git.example/api/v4']) {
      expect(await new HttpGitLab('t', { base, fetch }).branchSha('trace/board', 'trace/power')).toBe('abc')
    }
    expect(await new HttpGitLab('t', { base: 'https://git.example', fetch }).branchSha('trace/board', 'none')).toBeNull()
    expect(asked[0]?.path).toBe(`${P}/repository/branches/trace%2Fpower`)
  })

  it('defaultBranch: the branch and its commit', async () => {
    const { fetch } = fakeFetch({ [`GET ${P}`]: [200, { default_branch: 'main' }], [`GET ${P}/repository/branches/main`]: [200, { commit: { id: 's1' } }] })
    expect(await new HttpGitLab('t', { base: BASE, fetch }).defaultBranch('trace/board')).toEqual({ branch: 'main', sha: 's1' })
  })

  it('openPulls: merge requests as pull requests, a fork\'s branch told apart, every page read', async () => {
    const { fetch } = fakeFetch({
      [`GET ${P}/merge_requests?state=opened&per_page=100&page=1`]: [200, [mr()], { 'x-next-page': '2' }],
      [`GET ${P}/merge_requests?state=opened&per_page=100&page=2`]: [200, [mr({ iid: 5, source_project_id: 77 })]],
    })
    const pulls = await new HttpGitLab('t', { base: BASE, fetch }).openPulls('trace/board')
    expect(pulls).toEqual([
      { number: 4, title: 'Add the regulator', head: 'trace/power', draft: false, labels: ['trace'], url: mr().web_url, updated_at: mr().updated_at, created_at: mr().created_at, headRepo: 'trace/board', author: 'trace-bot', sha: 'h1', base: 'main' },
      expect.objectContaining({ number: 5, headRepo: 'fork:77' }),
    ])
  })

  it('checkRuns: the newest pipeline\'s jobs, each one openable', async () => {
    const { fetch } = fakeFetch({
      [`GET ${P}/pipelines?sha=h1&order_by=id&sort=desc&per_page=1`]: [200, [{ id: 31, status: 'running', web_url: 'u', created_at: 'c' }]],
      [`GET ${P}/pipelines/31/jobs?include_retried=false&per_page=100&page=1`]: [200, [
        { id: 1, name: 'typescript', status: 'success', finished_at: '2026-11-16T02:00:00Z' },
        { id: 2, name: 'smoke', status: 'running' },
      ]],
    })
    expect(await new HttpGitLab('t', { base: BASE, fetch }).checkRuns('trace/board', 'h1')).toEqual([
      { name: 'typescript', status: 'completed', conclusion: 'success', summary: null, id: 'job:1', completed_at: '2026-11-16T02:00:00Z' },
      { name: 'smoke', status: 'in_progress', conclusion: null, summary: null, id: 'job:2' },
    ])
  })

  it('pullStatus: state, mergeability in GitHub\'s words and its checks', async () => {
    const { fetch } = fakeFetch({
      [`GET ${P}/merge_requests/4`]: [200, { ...mr(), state: 'opened', detailed_merge_status: 'conflict' }],
      [`GET ${P}/pipelines?sha=h1&order_by=id&sort=desc&per_page=1`]: [200, [{ id: 31, status: 'failed', web_url: 'u', created_at: 'c' }]],
      [`GET ${P}/pipelines/31/jobs?include_retried=false&per_page=100&page=1`]: [200, [{ id: 1, name: 'typescript', status: 'failed' }]],
    })
    const s = await new HttpGitLab('t', { base: BASE, fetch }).pullStatus('trace/board', 4)
    expect(s).toMatchObject({ number: 4, state: 'open', mergeable: 'dirty', head: 'trace/power', sha: 'h1', checks: { total: 1, failed: 1, failing: ['typescript'] } })
    expect(await new HttpGitLab('t', { base: BASE, fetch }).pullStatus('trace/board', 99)).toBeNull()
  })

  it('openPull: answers the open one for the branch, or opens one that deletes its branch on merge', async () => {
    const { fetch, asked } = fakeFetch({
      [`GET ${P}/merge_requests?state=opened&source_branch=trace%2Fnew&per_page=10`]: [200, []],
      [`POST ${P}/merge_requests`]: [201, mr({ iid: 6, source_branch: 'trace/new' })],
      [`GET ${P}/merge_requests?state=opened&source_branch=trace%2Fpower&per_page=10`]: [200, [mr()]],
    })
    const gl = new HttpGitLab('t', { base: BASE, fetch })
    expect(await gl.openPull('trace/board', { head: 'trace/power', base: 'main', title: 'x', body: '' })).toEqual({ number: 4, existed: true })
    expect(await gl.openPull('trace/board', { head: 'trace/new', base: 'trace/power', title: 'Stacked', body: 'b' })).toEqual({ number: 6, existed: false })
    expect(asked.find((a) => a.method === 'POST')?.body).toEqual({ source_branch: 'trace/new', target_branch: 'trace/power', title: 'Stacked', description: 'b', remove_source_branch: true })
  })

  it('mergePull: only at the commit the person looked at, squashing when asked; a refusal keeps GitLab\'s words', async () => {
    const { fetch, asked } = fakeFetch({ [`PUT ${P}/merge_requests/4/merge`]: [200, { ...mr(), state: 'merged', merge_commit_sha: 'm1' }] })
    expect(await new HttpGitLab('t', { base: BASE, fetch }).mergePull('trace/board', 4, { method: 'merge', sha: 'h1' })).toEqual({ sha: 'm1' })
    expect(asked[0]?.body).toEqual({ sha: 'h1', squash: false })
    const refused = fakeFetch({ [`PUT ${P}/merge_requests/4/merge`]: [409, { message: 'SHA does not match HEAD of source branch' }] })
    const e = await new HttpGitLab('t', { base: BASE, fetch: refused.fetch }).mergePull('trace/board', 4, { method: 'squash', sha: 'old' }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(GitHubError)
    expect(e).toMatchObject({ status: 409, said: 'SHA does not match HEAD of source branch' })
  })

  it('commitFiles: one commit on a new branch from the base, each file created, updated or removed as the base has it', async () => {
    const { fetch, asked } = fakeFetch({
      [`HEAD ${P}/repository/files/trace%2Fsettings.json?ref=main`]: [200, null, { 'x-gitlab-size': '10', 'x-gitlab-blob-id': 'b1' }],
      [`HEAD ${P}/repository/files/old.txt?ref=main`]: [200, null, { 'x-gitlab-blob-id': 'b2' }],
      [`POST ${P}/repository/commits`]: [201, { id: 'c9' }],
    })
    const r = await new HttpGitLab('t', { base: BASE, fetch }).commitFiles('trace/board', {
      branch: 'trace/edit', base: 'main', message: 'Edit settings',
      files: [{ path: 'trace/settings.json', content: new TextEncoder().encode('{}') }, { path: 'new.md', content: new TextEncoder().encode('hi') }, { path: 'old.txt', content: null }, { path: 'gone.txt', content: null }],
    })
    expect(r).toEqual({ commit: 'c9' })
    expect(asked.at(-1)?.body).toEqual({
      branch: 'trace/edit', start_branch: 'main', commit_message: 'Edit settings', actions: [
        { action: 'update', file_path: 'trace/settings.json', content: 'e30=', encoding: 'base64' },
        { action: 'create', file_path: 'new.md', content: 'aGk=', encoding: 'base64' },
        { action: 'delete', file_path: 'old.txt' },
      ],
    })
  })

  it('workflowRuns: pipelines, narrowed to one named workflow and branch', async () => {
    const pl = (id: number, name: string) => ({ id, name, status: 'success', source: 'push', ref: 'main', web_url: `u${id}`, created_at: 'c' })
    const { fetch } = fakeFetch({ [`GET ${P}/pipelines?order_by=id&sort=desc&ref=main&per_page=100&page=1`]: [200, [pl(3, 'trace-ci'), pl(2, 'trace-deploy'), pl(1, 'trace-deploy')]] })
    const runs = await new HttpGitLab('t', { base: BASE, fetch }).workflowRuns('trace/board', 1, { workflow: 'trace-deploy.yml', branch: 'main' })
    expect(runs).toEqual([{ id: 2, name: 'trace-deploy', path: '.gitlab-ci.yml#trace-deploy', event: 'push', status: 'completed', conclusion: 'success', branch: 'main', url: 'u2', created_at: 'c' }])
  })

  it('dispatchWorkflowWith: a pipeline naming the workflow, its inputs as variables', async () => {
    const { fetch, asked } = fakeFetch({ [`POST ${P}/pipeline`]: [201, { id: 40 }] })
    await new HttpGitLab('t', { base: BASE, fetch }).dispatchWorkflowWith('trace/board', 'trace-deploy.yml', 'main', { 'approval-id': 'a1' })
    expect(asked[0]?.body).toEqual({ ref: 'main', variables: [{ key: 'TRACE_WORKFLOW', value: 'trace-deploy' }, { key: 'TRACE_INPUT_APPROVAL_ID', value: 'a1' }] })
  })

  it('removeLabel: false when it did not have it', async () => {
    const { fetch, asked } = fakeFetch({ [`GET ${P}/merge_requests/4`]: [200, { ...mr(), state: 'opened' }], [`PUT ${P}/merge_requests/4`]: [200, mr()] })
    const gl = new HttpGitLab('t', { base: BASE, fetch })
    expect(await gl.removeLabel('trace/board', 4, 'hold')).toBe(false)
    expect(await gl.removeLabel('trace/board', 4, 'trace')).toBe(true)
    expect(asked.at(-1)).toMatchObject({ method: 'PUT', body: { remove_labels: 'trace' } })
  })

  it('pullFiles: each file\'s status and line counts from its diff', async () => {
    const { fetch } = fakeFetch({
      [`GET ${P}/merge_requests/4/diffs?per_page=100&page=1`]: [200, [
        { old_path: 'a.kicad_sch', new_path: 'a.kicad_sch', new_file: false, deleted_file: false, renamed_file: false, diff: '@@ -1 +1,2 @@\n-x\n+y\n+z\n' },
        { old_path: 'old.md', new_path: 'new.md', new_file: false, deleted_file: false, renamed_file: true, diff: '' },
      ]],
    })
    expect(await new HttpGitLab('t', { base: BASE, fetch }).pullFiles('trace/board', 4)).toEqual([
      { path: 'a.kicad_sch', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1,2 @@\n-x\n+y\n+z\n', previous: null },
      { path: 'new.md', status: 'renamed', additions: 0, deletions: 0, patch: null, previous: 'old.md' },
    ])
  })
})

describe('GitLab in GitHub\'s words', () => {
  it('gitlabStatus', () => {
    expect(gitlabStatus('success')).toEqual({ status: 'completed', conclusion: 'success' })
    expect(gitlabStatus('failed')).toEqual({ status: 'completed', conclusion: 'failure' })
    expect(gitlabStatus('canceled')).toEqual({ status: 'completed', conclusion: 'cancelled' })
    expect(gitlabStatus('pending')).toEqual({ status: 'queued', conclusion: null })
    expect(gitlabStatus('manual')).toEqual({ status: 'waiting', conclusion: null })
  })

  it('mergeableOf', () => {
    expect(mergeableOf('mergeable', 'success')).toBe('clean')
    expect(mergeableOf('conflict', null)).toBe('dirty')
    expect(mergeableOf('need_rebase', null)).toBe('behind')
    expect(mergeableOf('ci_must_pass', 'failed')).toBe('unstable')
    expect(mergeableOf('ci_must_pass', 'running')).toBe('blocked')
    expect(mergeableOf('checking', null)).toBe('unknown')
  })

  it('diffCounts leaves the file headers out', () => {
    expect(diffCounts('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')).toEqual({ additions: 1, deletions: 1 })
  })

  it('gitlabRateLimitWords only for a 429', () => {
    expect(gitlabRateLimitWords(403, new Headers())).toBeNull()
    expect(gitlabRateLimitWords(429, new Headers({ 'retry-after': '30' }), 0)).toMatch(/try again in a minute/)
  })
})

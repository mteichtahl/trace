import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { gitlabOctokit, ForgeRefusal } from '../../src/harness/gitlab-octokit.js'
import { eventName, gitlabContext } from '../../src/harness/gitlab.js'
import { gitlabCiTemplate, renderGitlabCi } from '../../src/core/gitlab-ci.js'

const URL0 = 'https://git.example'
const P = '/api/v4/projects/tr%2Fboard'

function fake(routes: Record<string, [number, unknown]>) {
  const asked: { method: string; path: string; body?: unknown }[] = []
  const fetch = (async (u: string, init: RequestInit) => {
    const url = new URL(u)
    const path = url.pathname + url.search
    const method = init.method ?? 'GET'
    asked.push({ method, path, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) })
    const hit = routes[`${method} ${path}`]
    if (!hit) return new Response('{"message":"404"}', { status: 404 })
    return new Response(JSON.stringify(hit[1]), { status: hit[0] })
  }) as unknown as typeof globalThis.fetch
  return { fetch, asked }
}
const mr = (o: Record<string, unknown> = {}) => ({
  iid: 7, title: 'Regulator', description: 'b', state: 'opened', web_url: 'w', created_at: 'c', updated_at: 'u', source_branch: 'trace/power',
  target_branch: 'main', sha: 'h1', labels: ['trace'], author: { username: 'project_9_bot_x', bot: true }, project_id: 9, source_project_id: 9,
  detailed_merge_status: 'mergeable', ...o,
})
const client = (f: typeof globalThis.fetch, mergeRequests: number[] = []) => gitlabOctokit({ url: URL0, token: 't', project: 'tr/board', repository: 'mteichtahl/board', mergeRequests, fetch: f })

describe('the harness\'s client on GitLab', () => {
  it('lists merge requests as pull requests, named as trace names the project', async () => {
    const { fetch } = fake({ [`GET ${P}/merge_requests?state=opened&target_branch=main&per_page=30&page=1`]: [200, [mr()]] })
    const { data } = await client(fetch).rest.pulls.list({ owner: 'mteichtahl', repo: 'board', state: 'open', base: 'main' }) as { data: Record<string, unknown>[] }
    expect(data[0]).toMatchObject({ number: 7, state: 'open', mergeable_state: 'clean', head: { ref: 'trace/power', sha: 'h1', repo: { full_name: 'mteichtahl/board' } }, base: { ref: 'main' }, labels: [{ name: 'trace' }], user: { login: 'project_9_bot_x', type: 'Bot' } })
  })

  it('comments on a merge request it has met, and on an issue otherwise', async () => {
    const { fetch, asked } = fake({ [`POST ${P}/merge_requests/7/notes`]: [201, { id: 1 }], [`POST ${P}/issues/3/notes`]: [201, { id: 2 }] })
    const gl = client(fetch, [7])
    await gl.rest.issues.createComment({ issue_number: 7, body: 'on the change' })
    await gl.rest.issues.createComment({ issue_number: 3, body: 'on the issue' })
    expect(asked.map((a) => a.path)).toEqual([`${P}/merge_requests/7/notes`, `${P}/issues/3/notes`])
  })

  it('compares two refs both ways for ahead and behind', async () => {
    const { fetch } = fake({
      [`GET ${P}/repository/compare?from=main&to=trace%2Fpower&straight=false`]: [200, { commits: [{ id: 'a' }, { id: 'b' }], diffs: [{ new_path: 'x' }] }],
      [`GET ${P}/repository/compare?from=trace%2Fpower&to=main&straight=false`]: [200, { commits: [{ id: 'c' }], diffs: [] }],
    })
    const { data } = await client(fetch).rest.repos.compareCommits({ base: 'main', head: 'mteichtahl:trace/power' })
    expect(data).toMatchObject({ status: 'diverged', ahead_by: 2, behind_by: 1, files: [{ filename: 'x' }] })
  })

  it('starts a named pipeline for a workflow dispatch, its inputs as variables', async () => {
    const { fetch, asked } = fake({ [`POST ${P}/pipeline`]: [201, { id: 4 }] })
    await client(fetch).rest.actions.createWorkflowDispatch({ workflow_id: 'trace-deploy.yml', ref: 'main', inputs: { approval: 'a1' } })
    expect(asked[0]?.body).toEqual({ ref: 'main', variables: [{ key: 'TRACE_WORKFLOW', value: 'trace-deploy' }, { key: 'TRACE_INPUT_APPROVAL', value: 'a1' }] })
  })

  it('paginates like Octokit, flattening each page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ iid: i + 1, title: 't', state: 'opened', web_url: 'w', created_at: 'c', updated_at: 'u' }))
    const { fetch } = fake({
      [`GET ${P}/issues?state=opened&per_page=100&page=1`]: [200, page1],
      [`GET ${P}/issues?state=opened&per_page=100&page=2`]: [200, [{ iid: 101, title: 't', state: 'opened', web_url: 'w', created_at: 'c', updated_at: 'u' }]],
    })
    const gl = client(fetch)
    const all = await gl.paginate(gl.rest.issues.listForRepo, { state: 'open' })
    expect(all).toHaveLength(101)
  })
})

describe('a GitLab job as the harness\'s event', () => {
  it('maps GitLab\'s sources to GitHub\'s event names', () => {
    expect(eventName('merge_request_event')).toBe('pull_request')
    expect(eventName('push')).toBe('push')
    expect(eventName('schedule')).toBe('schedule')
    expect(eventName('api')).toBe('workflow_dispatch')
  })

  it('reads a merge request pipeline\'s change, keyed by trace\'s name for the project', () => {
    const c = gitlabContext({
      TRACE_REPOSITORY: 'mteichtahl/board', CI_PROJECT_PATH: 'tr/board', CI_SERVER_URL: URL0, CI_PIPELINE_ID: '55', CI_PIPELINE_SOURCE: 'merge_request_event',
      CI_COMMIT_SHA: 'h1', CI_MERGE_REQUEST_IID: '7', CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'trace/power', CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'main',
      CI_MERGE_REQUEST_LABELS: 'trace,hold', GITLAB_USER_LOGIN: 'project_9_bot_x',
    })
    expect(c).toMatchObject({ repo: { owner: 'mteichtahl', repo: 'board' }, eventName: 'pull_request', runId: 55, ref: 'refs/heads/trace/power', sha: 'h1' })
    expect(c.payload.pull_request).toMatchObject({ number: 7, head: { ref: 'trace/power' }, base: { ref: 'main' }, labels: [{ name: 'trace' }, { name: 'hold' }] })
    expect(c.payload.sender).toEqual({ login: 'project_9_bot_x', type: 'Bot' })
  })
})

describe('a project\'s .gitlab-ci.yml', () => {
  const values = { source: 'mteichtahl/trace', ref: 'main', branch: 'main', repository: 'mteichtahl/board', runner: 'trace-ci-ab12cd34', hold: 'hold' }

  it('fills every value, runs each job on its CodeBuild runner, and the queue one at a time', () => {
    const y = renderGitlabCi(gitlabCiTemplate(process.cwd()), values)
    expect(y).not.toMatch(/__TR_/)
    expect(y).toContain('codebuild-trace-ci-ab12cd34-$CI_PROJECT_ID-$CI_PIPELINE_IID-$CI_JOB_NAME')
    expect(y).toContain('resource_group: trace-update-queue')
    expect(y).toContain('/harness/dist/gitlab.cjs')
    expect(y).not.toContain('TRACE_TOKEN')
  })

  it('ends the build with ci-doctor, and runs the worker as the project\'s own role with GitLab\'s ID token', () => {
    const y = renderGitlabCi(gitlabCiTemplate(process.cwd()), values)
    expect(y).toMatch(/ci-doctor:[\s\S]*stage: \.post[\s\S]*when: always/)
    expect(y).toMatch(/worker:[\s\S]*aud: sts\.amazonaws\.com[\s\S]*assume-role-with-web-identity/)
    expect(y).toContain('exists: [.gitlab/build.yml]')
  })

  it('refuses a value that could break the file', () => {
    expect(() => renderGitlabCi(gitlabCiTemplate(process.cwd()), { ...values, branch: 'main"\nevil: x' })).toThrow(/branch must be/)
  })

  it('the GitLab harness bundle is committed beside the GitHub one', () => {
    expect(readFileSync('harness/dist/gitlab.cjs', 'utf8').slice(0, 80)).toMatch(/Generated by scripts\/bundle-harness\.mjs/)
  })
})

describe('the merges GitLab\'s API cannot make, done with git as the agents', () => {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
  const { mkdtempSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  const g = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } })

  /** a "GitLab" of one bare repository, tr/board.git, with main and a stacked branch on it */
  function world(conflict = false) {
    const root = mkdtempSync(join(tmpdir(), 'gl-'))
    execFileSync('mkdir', ['-p', join(root, 'tr')])
    g(root, 'init', '-q', '--bare', '-b', 'main', join(root, 'tr', 'board.git'))
    const work = mkdtempSync(join(tmpdir(), 'w-'))
    g(work, 'init', '-q', '-b', 'main')
    writeFileSync(join(work, 'a.txt'), 'one\n'); g(work, 'add', '.'); g(work, 'commit', '-qm', 'one')
    g(work, 'checkout', '-qb', 'trace/power'); writeFileSync(join(work, 'b.txt'), 'power\n'); g(work, 'add', '.'); g(work, 'commit', '-qm', 'power')
    g(work, 'checkout', '-q', 'main'); writeFileSync(join(work, conflict ? 'b.txt' : 'c.txt'), 'main moved\n'); g(work, 'add', '.'); g(work, 'commit', '-qm', 'main moved')
    g(work, 'push', '-q', join(root, 'tr', 'board.git'), 'main', 'trace/power')
    return { root, bare: join(root, 'tr', 'board.git') }
  }

  it('repos.merge merges the base into a stacked branch with a merge commit and pushes it; nothing to merge is a 204', async () => {
    const w = world()
    const gl = gitlabOctokit({ url: w.root, token: 't', project: 'tr/board', repository: 'mteichtahl/board', fetch: fake({}).fetch })
    const r = await gl.rest.repos.merge({ base: 'trace/power', head: 'main', commit_message: 'Merge main into trace/power (stacked on it)' })
    expect(r.status).toBe(201)
    const log = g(w.bare, 'log', '--format=%P|%s', '-1', 'trace/power')
    expect(log.split('|')[0]?.split(' ')).toHaveLength(2)
    expect(log).toContain('Merge main into trace/power')
    expect((await gl.rest.repos.merge({ base: 'trace/power', head: 'main' })).status).toBe(204)
  })

  it('a conflict is a 409 and leaves the branch as it was', async () => {
    const w = world(true)
    const before = g(w.bare, 'rev-parse', 'trace/power')
    const gl = gitlabOctokit({ url: w.root, token: 't', project: 'tr/board', repository: 'mteichtahl/board', fetch: fake({}).fetch })
    const e = await gl.rest.repos.merge({ base: 'trace/power', head: 'main' }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ForgeRefusal)
    expect(e).toMatchObject({ status: 409 })
    expect(g(w.bare, 'rev-parse', 'trace/power')).toBe(before)
  })

  it('pulls.updateBranch merges the change\'s target into its branch, only at the head it was asked for', async () => {
    const { fetch } = fake({ [`GET ${P}/merge_requests/7`]: [200, mr({ sha: 'stale' })] })
    const gl = gitlabOctokit({ url: URL0, token: 't', project: 'tr/board', repository: 'mteichtahl/board', fetch })
    const e = await gl.rest.pulls.updateBranch({ pull_number: 7, expected_head_sha: 'other' }).catch((x: unknown) => x)
    expect(e).toMatchObject({ status: 422 })
  })
})

describe('the GitLab job\'s worker and ci-doctor', () => {
  it('ci-doctor\'s run is this pipeline: failed when another job failed', async () => {
    const { pipelineAsRun } = await import('../../src/harness/gitlab.js')
    const { fetch } = fake({ [`GET ${P}/pipelines/55/jobs?include_retried=false&per_page=100`]: [200, [{ id: 1, name: 'check', status: 'failed' }, { id: 2, name: 'ci-doctor', status: 'running' }]] })
    const run = await pipelineAsRun(client(fetch), { CI_PIPELINE_ID: '55', CI_JOB_ID: '2', CI_COMMIT_BRANCH: 'trace/power', CI_COMMIT_SHA: 'h1', CI_PIPELINE_SOURCE: 'push', TRACE_REPOSITORY: 'mteichtahl/board' })
    expect(run).toMatchObject({ id: 55, conclusion: 'failure', head_branch: 'trace/power', head_sha: 'h1', event: 'push' })
    const { fetch: ok } = fake({ [`GET ${P}/pipelines/55/jobs?include_retried=false&per_page=100`]: [200, [{ id: 1, name: 'check', status: 'success' }, { id: 2, name: 'ci-doctor', status: 'running' }]] })
    expect((await pipelineAsRun(client(ok), { CI_PIPELINE_ID: '55', CI_JOB_ID: '2' })).conclusion).toBe('success')
  })

  it('a capturing core keeps what a task outputs', async () => {
    const { capturingCore } = await import('../../src/harness/gitlab.js')
    const c = capturingCore()
    c.setOutput('items', '[{"number":3}]')
    expect(c.outputs.items).toBe('[{"number":3}]')
  })
})


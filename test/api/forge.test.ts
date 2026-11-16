import { describe, expect, it, vi } from 'vitest'
import { forgeFromEnv, forgeRouter, gitlabRepos } from '../../src/api/forge.js'
import { GitHubError, type GitHubApi } from '../../src/api/github.js'

/** A client that answers branchSha with its own name, and has no checkRun. */
const named = (name: string, calls: string[]): GitHubApi => ({
  defaultBranch: async () => ({ branch: 'main', sha: name }),
  branchSha: async (repo, branch) => { calls.push(`${name} ${repo} ${branch}`); return name },
  tree: async () => ({ files: [], truncated: false }),
  fileInfo: async () => null, rawFile: async () => null, fileSha: async () => null,
  createBranch: async () => {}, putFile: async () => ({ commit: name }),
  openPulls: async () => [], openIssues: async () => [], workflowRuns: async () => [], lastDeploy: async () => null,
  request: async () => `${name} raw`,
})

describe('forgeRouter', () => {
  it('sends a GitLab project\'s calls to GitLab and every other repository\'s to GitHub', async () => {
    const calls: string[] = []
    const f = forgeRouter({ github: async () => named('github', calls), gitlab: async () => named('gitlab', calls), onGitlab: (r) => r === 'trace/board' })
    expect(await f.branchSha('trace/board', 'main')).toBe('gitlab')
    expect(await f.branchSha('acme/other', 'main')).toBe('github')
    expect(calls).toEqual(['gitlab trace/board main', 'github acme/other main'])
  })

  it('without trace\'s GitLab, everything is GitHub\'s', async () => {
    const f = forgeRouter({ github: async () => named('github', []), gitlab: null, onGitlab: () => true })
    expect(await f.branchSha('trace/board', 'main')).toBe('github')
  })

  it('a call the GitLab client cannot make is refused in plain words, never sent to GitHub', async () => {
    const f = forgeRouter({ github: async () => ({ ...named('github', []), checkRun: async () => null }), gitlab: async () => named('gitlab', []), onGitlab: () => true })
    const e = await f.checkRun?.('trace/board', 1).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(GitHubError)
    expect(e).toMatchObject({ status: 501, message: expect.stringMatching(/trace's GitLab, which cannot do this yet/) })
  })

  it('GitHub\'s raw calls stay GitHub\'s', async () => {
    const f = forgeRouter({ github: async () => named('github', []), gitlab: async () => named('gitlab', []), onGitlab: () => true })
    expect(await f.request?.('GET', '/user')).toBe('github raw')
  })
})

describe('the forge from the environment', () => {
  it('gitlabRepos: space separated, case kept out', () => {
    expect([...gitlabRepos(' trace/Board  trace/case\n')]).toEqual(['trace/board', 'trace/case'])
    expect(gitlabRepos(undefined).size).toBe(0)
  })

  it('sends a listed repository to the configured GitLab, with its token, and the rest to GitHub', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (u: string, init: RequestInit) => {
      urls.push(`${String(u)} ${(init.headers as Record<string, string>).authorization}`)
      return new Response('{}', { status: 200 })
    })
    try {
      const env = { TRACE_GITLAB_URL: 'https://git.example', TRACE_GITLAB_SECRET_ARN: 'arn:x', TRACE_GITLAB_TOKEN: 'glpat', TRACE_GITLAB_REPOS: 'trace/board' }
      const f = forgeFromEnv(env, async () => 'ghp')
      await f.repoExists?.('trace/board')
      await f.repoExists?.('acme/other')
      expect(urls).toEqual(['https://git.example/api/v4/projects/trace%2Fboard Bearer glpat', 'https://api.github.com/repos/acme/other Bearer ghp'])
      // without an address, nothing goes to GitLab
      urls.length = 0
      await forgeFromEnv({ TRACE_GITLAB_REPOS: 'trace/board' }, async () => 'ghp').repoExists?.('trace/board')
      expect(urls).toEqual(['https://api.github.com/repos/trace/board Bearer ghp'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

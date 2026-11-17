/** The worker runtime on GitHub or on trace's GitLab (src/agents/runtime/forge.ts). */
import { describe, expect, it } from 'vitest'
import { forgeClient, remoteUrl, runtimeForge, serverUrl, tokenSecret } from '../../src/agents/runtime/forge.js'
import { gitAuthEnv, redactor } from '../../src/agents/runtime/job.js'

const GL = { TRACE_GITLAB_URL: 'https://d1.cloudfront.net/', TRACE_GITLAB_PATH: 'trace/fdsafdsa', TRACE_GITLAB_SECRET: 'trace/gitlab/agents/fdsafdsa', TRACE_GITHUB_SECRET_ARN: 'arn:gh' }

describe('the runtime\'s forge', () => {
  it('is GitHub unless its environment names trace\'s GitLab', () => {
    const gh = runtimeForge({ TRACE_GITHUB_SECRET_ARN: 'arn:gh' })
    expect(gh).toEqual({ kind: 'github' })
    expect(remoteUrl(gh, 'mteichtahl/fdsafdsa')).toBe('https://github.com/mteichtahl/fdsafdsa.git')
    expect(tokenSecret(gh, { TRACE_GITHUB_SECRET_ARN: 'arn:gh' })).toBe('arn:gh')
    expect(gitAuthEnv('ghs_0123456789', gh).GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader')
  })

  it('on GitLab clones and pushes there, signs in with the agents\' token, and links there', () => {
    const f = runtimeForge(GL)
    expect(f).toEqual({ kind: 'gitlab', url: 'https://d1.cloudfront.net', path: 'trace/fdsafdsa', secret: 'trace/gitlab/agents/fdsafdsa' })
    expect(remoteUrl(f, 'mteichtahl/fdsafdsa')).toBe('https://d1.cloudfront.net/trace/fdsafdsa.git')
    expect(tokenSecret(f, GL)).toBe('trace/gitlab/agents/fdsafdsa')
    expect(serverUrl(f)).toBe('https://d1.cloudfront.net')
    const auth = gitAuthEnv('glpat-0123456789', f)
    expect(auth.GIT_CONFIG_KEY_0).toBe('http.https://d1.cloudfront.net/.extraheader')
    expect(auth.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${Buffer.from('oauth2:glpat-0123456789').toString('base64')}`)
    expect(redactor('glpat-0123456789')(auth.GIT_CONFIG_VALUE_0 ?? '')).not.toContain(Buffer.from('oauth2:glpat-0123456789').toString('base64'))
    expect(() => runtimeForge({ TRACE_GITLAB_URL: 'https://x' })).toThrow(/TRACE_GITLAB_PATH/)
  })

  it('on GitLab its client asks GitLab, answering merge requests as pull requests', async () => {
    const asked: string[] = []
    const fetch = (async (u: string) => {
      asked.push(String(u))
      return new Response(JSON.stringify({ id: 9, default_branch: 'main', path_with_namespace: 'trace/fdsafdsa', visibility: 'private', web_url: 'https://d1.cloudfront.net/trace/fdsafdsa' }), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const real = globalThis.fetch
    globalThis.fetch = fetch
    try {
      const gh = forgeClient(runtimeForge(GL), 'mteichtahl/fdsafdsa')('glpat-x')
      expect((await gh.rest.repos.get({ owner: 'mteichtahl', repo: 'fdsafdsa' })).data.default_branch).toBe('main')
      expect(asked[0]).toBe('https://d1.cloudfront.net/api/v4/projects/trace%2Ffdsafdsa')
    } finally { globalThis.fetch = real }
  })
})

import { describe, expect, it } from 'vitest'
import { IMMUTABLE_SUBJECT } from '../../src/core/github-subject.js'
import { createRepo, immutableSubject, repoExists } from '../../src/installer/github.js'

const github = (answer: (method: string, url: string) => [number, unknown]) => (async (url: string, init?: RequestInit) => {
  const [status, body] = answer(init?.method ?? 'GET', url)
  return new Response(JSON.stringify(body), { status })
}) as typeof fetch

describe('repositories the installer creates', () => {
  it('says whether the token sees a repository, and when GitHub cannot say', async () => {
    expect(await repoExists('t', 'me/a', github(() => [200, { full_name: 'me/a' }]))).toBe(true)
    expect(await repoExists('t', 'me/a', github(() => [404, { message: 'Not Found' }]))).toBe(false)
    expect(await repoExists('t', 'me/a', github(() => [502, { message: 'Bad Gateway' }]))).toBeNull()
  })

  it('says plainly when a repository it cannot see exists already', async () => {
    const f = github((method, url) => (url.endsWith('/user') ? [200, { login: 'me', type: 'User' }]
      : method === 'POST' ? [422, { message: 'Repository creation failed: name already exists on this account' }]
        : [404, { message: 'Not Found' }]))
    await expect(createRepo('t', 'me/trace-sample', { private: true }, f)).rejects.toThrow(/exists on GitHub, but this token can't see it: give the token access to me\/trace-sample/)
  })

  it('reads a repository\'s immutable OIDC subject from its ids, with GitHub\'s own spelling of its names', async () => {
    const urls: string[] = []
    const f = github((_m, url) => { urls.push(url); return [200, { id: 1433970189, name: 'trace', full_name: 'mteichtahl/trace', owner: { id: 1817657, login: 'mteichtahl' } }] })
    const subject = await immutableSubject('t', 'mteichtahl/trace', f)
    expect(subject).toBe('repo:mteichtahl@1817657/trace@1433970189')
    expect(subject).toMatch(IMMUTABLE_SUBJECT)
    expect(urls).toEqual(['https://api.github.com/repos/mteichtahl/trace'])
    await expect(immutableSubject('t', 'me/gone', github(() => [404, { message: 'Not Found' }]))).rejects.toThrow(/404 Not Found/)
  })
})

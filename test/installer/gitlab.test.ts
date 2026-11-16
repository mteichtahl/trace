import { describe, expect, it } from 'vitest'
import { adminToken, gitlabConnectionReady, waitForGitlab, waitForGitlabConnection } from '../../src/installer/gitlab.js'

const instant = async (): Promise<void> => {}

describe('adminToken', () => {
  it('reads the instance\'s token, never the stack\'s placeholder', () => {
    expect(adminToken('{"token":"glpat-x"}')).toBe('glpat-x')
    expect(adminToken('pending')).toBeNull()
    expect(adminToken('')).toBeNull()
    expect(adminToken(null)).toBeNull()
    expect(adminToken('glpat-plain')).toBe('glpat-plain')
  })
})

describe('waitForGitlab', () => {
  it('waits while GitLab installs itself, then while its address does not answer, and is done when it answers with the token', async () => {
    const secrets = ['pending', '{"token":"glpat-x"}', '{"token":"glpat-x"}', '{"token":"glpat-x"}']
    const seen: string[] = []
    let calls = 0
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`)
      if (calls++ === 0) throw new Error('getaddrinfo ENOTFOUND')
      return new Response(JSON.stringify({ version: '18.6.1' }), { status: 200 })
    }) as typeof globalThis.fetch
    const states: (string | null)[] = []
    const r = await waitForGitlab({
      url: 'https://d1.cloudfront.net/', readSecret: async () => secrets.shift() ?? null, fetch, sleep: instant, pollMs: 1,
      report: (n) => states.push(n.state),
    })
    expect(r).toEqual({ ok: true, detail: 'GitLab 18.6.1 is up at https://d1.cloudfront.net' })
    expect(states).toEqual(['installing', 'unreachable', 'up'])
    expect(seen[0]).toBe('https://d1.cloudfront.net/api/v4/version Bearer glpat-x')
  })

  it('stops at once when GitLab refuses the token', async () => {
    const fetch = (async () => new Response('{}', { status: 401 })) as unknown as typeof globalThis.fetch
    const r = await waitForGitlab({ url: 'https://d1.cloudfront.net', readSecret: async () => '{"token":"old"}', fetch, sleep: instant, pollMs: 1 })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/refused trace's admin token \(401\)/)
  })

  it('says what it was waiting on when time runs out', async () => {
    let t = 0
    const r = await waitForGitlab({ url: 'https://git.example.com', readSecret: async () => 'pending', sleep: instant, pollMs: 1, timeoutMs: 5, now: () => (t += 2) })
    expect(r).toEqual({ ok: false, detail: 'GitLab is not up yet: it is still installing itself. Run the installer again later to check it' })
  })

  it('has nothing to wait for without an address', async () => {
    expect(await waitForGitlab({ url: '', readSecret: async () => null })).toEqual({ ok: false, detail: 'no GitLab address to wait for (none)' })
  })
})

describe('waitForGitlabConnection', () => {
  it('says once what to do, then waits until the host and the connection are both available', async () => {
    const states = [{ host: 'PENDING', connection: 'PENDING' }, { host: 'AVAILABLE', connection: 'PENDING' }, { host: 'AVAILABLE', connection: 'AVAILABLE' }]
    const lines: string[] = []
    const r = await waitForGitlabConnection({ read: async () => states.shift()!, consoleUrl: 'https://console/x', name: 'tr-gitlab', report: (l) => lines.push(l), sleep: instant, pollMs: 1 })
    expect(r.ok).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/Hosts tab choose tr-gitlab.*api and admin_mode scopes only.*Update pending connection/)
  })

  it('stops at once on ERROR, and says what to do when time runs out', async () => {
    const err = await waitForGitlabConnection({ read: async () => ({ host: 'ERROR', connection: 'PENDING' }), consoleUrl: 'u', name: 'tr-gitlab', report: () => {}, sleep: instant, pollMs: 1 })
    expect(err).toMatchObject({ ok: false, detail: expect.stringMatching(/status ERROR/) })
    let t = 0
    const late = await waitForGitlabConnection({ read: async () => ({ host: 'PENDING', connection: 'PENDING' }), consoleUrl: 'u', name: 'tr-gitlab', report: () => {}, sleep: instant, pollMs: 1, timeoutMs: 5, now: () => (t += 2) })
    expect(late).toMatchObject({ ok: false, detail: expect.stringMatching(/not set up yet.*run the installer again/) })
    expect(gitlabConnectionReady({ host: 'AVAILABLE', connection: 'AVAILABLE' })).toBe(true)
  })
})

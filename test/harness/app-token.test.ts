/**
 * The harness acts as trace's GitHub app when the app is installed on the repository, with a quota of its own, and as
 * TRACE_TOKEN's account otherwise (src/harness/app-token.ts). In the test run the workflows shared one person's quota,
 * used it up, and `open-pr` and `automerge` failed on "API rate limit exceeded for user ID 1817657" (test-esp32 run 2,
 * #126 and #128).
 */
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Octokit } from '@octokit/rest'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { appCredentials, appJwt, chooseToken, fallback, notAllowed } from '../../src/harness/app-token.js'
import { actAs } from '../../src/harness/index.js'
import * as prs from '../../src/harness/prs.js'
import type { GitHub } from '../../src/harness/types.js'
import { cfgOf, context, deps, fakeCore, fakeGithub } from './fake.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const creds = { appId: '123456', privateKey: PEM }
const NOW = 1_800_000_000_000

interface Sent { url: string; method: string; headers: Record<string, string>; body?: string | undefined }
/** GitHub's app endpoints, answered by `answers` keyed "METHOD path" (status and body), every request kept. */
function github(answers: Record<string, [number, unknown]>) {
  const sent: Sent[] = []
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    sent.push({ url, ...init })
    const [status, body] = answers[`${init.method} ${new URL(url).pathname}`] ?? [404, { message: 'Not Found' }]
    return { status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) }
  }
  return { fetch, sent }
}
const INSTALLED = {
  'GET /repos/o/r/installation': [200, { id: 42, app_slug: 'trace-tr' }] as [number, unknown],
  'POST /app/installations/42/access_tokens': [201, { token: 'ghs_app', expires_at: '2027-01-15T09:00:00Z' }] as [number, unknown],
}

describe('the app\'s credentials', () => {
  it('needs both the id and the key', () => {
    expect(appCredentials({ APP_ID: '1', APP_KEY: 'k' })).toEqual({ appId: '1', privateKey: 'k' })
    expect(appCredentials({ APP_ID: '1' })).toBeNull()
    expect(appCredentials({ APP_ID: ' ', APP_KEY: 'k' })).toBeNull()
    expect(appCredentials({})).toBeNull()
  })

  it('signs a JSON web token GitHub takes: RS256, issued by the app, a minute back, for nine minutes', () => {
    const jwt = appJwt(creds, NOW)
    const [h, b, s] = jwt.split('.')
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(b!, 'base64url').toString())).toEqual({ iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: '123456' })
    expect(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true)
  })

  it('reads a key pasted with literal \\n in place of line breaks', () => {
    const jwt = appJwt({ appId: '1', privateKey: PEM.replace(/\n/g, '\\n') }, NOW)
    const [h, b, s] = jwt.split('.')
    expect(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true)
  })
})

describe('choosing the token', () => {
  it('is the app\'s installation token, for this repository alone, when the app is installed on it', async () => {
    const g = github(INSTALLED)
    const c = await chooseToken(creds, { owner: 'o', repo: 'r', fetch: g.fetch, now: () => NOW })
    expect(c).toEqual({ kind: 'app', token: 'ghs_app', login: 'trace-tr[bot]', expiresAt: '2027-01-15T09:00:00Z' })
    expect(g.sent.map((s) => `${s.method} ${s.url}`)).toEqual(['GET https://api.github.com/repos/o/r/installation', 'POST https://api.github.com/app/installations/42/access_tokens'])
    expect(g.sent[0]!.headers.authorization).toBe(`Bearer ${appJwt(creds, NOW)}`)
    expect(JSON.parse(g.sent[1]!.body!)).toEqual({ repositories: ['r'] })
  })

  it('uses the runner\'s GitHub API address', async () => {
    const g = github(INSTALLED)
    await chooseToken(creds, { owner: 'o', repo: 'r', api: 'https://ghe.example/api/v3/', fetch: g.fetch })
    expect(g.sent[0]!.url).toBe('https://ghe.example/api/v3/repos/o/r/installation')
  })

  it('falls back to the person\'s token, saying why: no app set up, not installed here, refused, a bad key', async () => {
    expect(await chooseToken(null, { owner: 'o', repo: 'r' })).toMatchObject({ kind: 'person', why: expect.stringContaining('TRACE_APP_ID') })

    const none = github({})
    expect(await chooseToken(creds, { owner: 'o', repo: 'r', fetch: none.fetch })).toEqual({ kind: 'person', why: 'trace\'s GitHub app is not installed on o/r' })
    expect(none.sent).toHaveLength(1)

    const refused = github({ ...INSTALLED, 'POST /app/installations/42/access_tokens': [401, { message: 'A JSON web token could not be decoded' }] })
    expect(await chooseToken(creds, { owner: 'o', repo: 'r', fetch: refused.fetch })).toEqual({ kind: 'person', why: 'GitHub would not give trace\'s GitHub app a token for o/r (401: A JSON web token could not be decoded)' })

    const unknown = github({ 'GET /repos/o/r/installation': [401, { message: 'Bad credentials' }] })
    expect(await chooseToken(creds, { owner: 'o', repo: 'r', fetch: unknown.fetch })).toMatchObject({ kind: 'person', why: expect.stringContaining('401: Bad credentials') })

    const badKey = github(INSTALLED)
    const c = await chooseToken({ appId: '1', privateKey: 'not a key' }, { owner: 'o', repo: 'r', fetch: badKey.fetch })
    expect(c).toMatchObject({ kind: 'person', why: expect.stringContaining('could not get a token') })
    expect(badKey.sent).toHaveLength(0)

    const down = await chooseToken(creds, { owner: 'o', repo: 'r', fetch: async () => { throw new Error('fetch failed') } })
    expect(down).toEqual({ kind: 'person', why: 'trace\'s GitHub app could not get a token (fetch failed)' })
  })
})

/** An Octokit whose every request is answered by `answer` (the request's method and URL), recording the token used. */
function octokit(token: string, answer: (method: string, url: string) => [number, unknown], seen: string[]): Octokit {
  return new Octokit({
    auth: token,
    request: {
      fetch: async (url: string, init: { method: string; headers: Record<string, string> }) => {
        seen.push(`${token} ${init.method} ${new URL(url).pathname}`)
        const [status, body] = answer(init.method, url)
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      },
    },
  })
}

describe('a request the app may not make', () => {
  it('is made again as the person, with one warning', async () => {
    const seen: string[] = []
    const said: string[] = []
    const person = octokit('person', () => [200, { ok: 'person' }], seen)
    const app = fallback(octokit('app', (m) => (m === 'POST' ? [403, { message: 'Resource not accessible by integration' }] : [200, { ok: 'app' }]), seen), person, (s) => said.push(s))
    expect((await app.rest.pulls.get({ owner: 'o', repo: 'r', pull_number: 1 })).data).toEqual({ ok: 'app' })
    expect((await app.rest.actions.reRunWorkflowFailedJobs({ owner: 'o', repo: 'r', run_id: 9 })).data).toEqual({ ok: 'person' })
    await app.rest.actions.reRunWorkflowFailedJobs({ owner: 'o', repo: 'r', run_id: 10 })
    expect(seen).toEqual([
      'app GET /repos/o/r/pulls/1',
      'app POST /repos/o/r/actions/runs/9/rerun-failed-jobs', 'person POST /repos/o/r/actions/runs/9/rerun-failed-jobs',
      'app POST /repos/o/r/actions/runs/10/rerun-failed-jobs', 'person POST /repos/o/r/actions/runs/10/rerun-failed-jobs',
    ])
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('done with TRACE_TOKEN')
  })

  it('is not a rate limit, nor the request\'s own answer: those are thrown as they are', async () => {
    const seen: string[] = []
    const person = octokit('person', () => [200, {}], seen)
    const app = fallback(octokit('app', () => [404, { message: 'Not Found' }], seen), person, () => undefined)
    await expect(app.rest.pulls.get({ owner: 'o', repo: 'r', pull_number: 1 })).rejects.toMatchObject({ status: 404 })
    expect(seen).toEqual(['app GET /repos/o/r/pulls/1'])

    const limited = (status: number, message: string, headers: Record<string, string> = {}) => Object.assign(new Error(message), { status, response: { headers } })
    expect(notAllowed(limited(403, 'API rate limit exceeded for installation ID 42.', { 'x-ratelimit-remaining': '0' }))).toBe(false)
    expect(notAllowed(limited(403, 'Resource not accessible by integration'))).toBe(true)
    expect(notAllowed(limited(422, 'refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission'))).toBe(true)
    expect(notAllowed(limited(422, 'Validation Failed'))).toBe(false)
  })
})

describe('which client a step acts through', () => {
  const core = fakeCore
  const made: string[] = []
  const getOctokit = (token: string): GitHub => { made.push(token); return fakeGithub().gh }

  it('is the app\'s, when the step has the person\'s token and the app is installed here', async () => {
    made.length = 0
    const c = core()
    const person = fakeGithub().gh
    const g = github(INSTALLED)
    const gh = await actAs({ context: context(), core: c, getOctokit }, { OWN_TOKEN: 'ghp_person', APP_ID: '123456', APP_KEY: PEM }, person, {}, { fetch: g.fetch })
    expect(made).toEqual(['ghs_app'])
    expect(gh).not.toBe(person)
    expect(c.infos.join('\n')).toContain('acts as its GitHub app here (trace-tr[bot])')
  })

  it('is the person\'s when the app is not installed here, or not set up, saying so; and the job\'s token is left alone', async () => {
    made.length = 0
    const person = fakeGithub().gh
    const c = core()
    expect(await actAs({ context: context(), core: c, getOctokit }, { OWN_TOKEN: 'ghp_person', APP_ID: '123456', APP_KEY: PEM }, person, {}, { fetch: github({}).fetch })).toBe(person)
    expect(c.infos.join('\n')).toContain('trace acts as TRACE_TOKEN\'s account here: trace\'s GitHub app is not installed on o/r.')
    expect(await actAs({ context: context(), core: core(), getOctokit }, { OWN_TOKEN: 'ghp_person' }, person, {})).toBe(person)
    const asked = github(INSTALLED)
    expect(await actAs({ context: context(), core: core(), getOctokit }, { APP_ID: '123456', APP_KEY: PEM }, person, {}, { fetch: asked.fetch })).toBe(person)
    expect(asked.sent).toHaveLength(0)
    expect(made).toEqual([])
  })
})

describe('open-pr as the app', () => {
  it('reads as the app and opens the pull request as TRACE_TOKEN\'s account, which trace knows its changes by', async () => {
    const app = fakeGithub({ 'pulls.list': [], 'repos.compareCommits': { ahead_by: 1, commits: [{ sha: 'a'.repeat(40), commit: { message: 'Board: route the I2C bus' } }] } })
    const person = fakeGithub({ 'pulls.create': { number: 19, html_url: 'u' } })
    await prs.openPr({ ...deps(app, fakeCore(), cfgOf(), context({ ref: 'refs/heads/claude/layout' }), { OWN_TOKEN: 't' }), author: person.gh })
    expect(app.called('pulls.list').length).toBeGreaterThan(0)
    expect(app.called('pulls.create')).toHaveLength(0)
    expect(person.calls.map((c) => c.key)).toEqual(['pulls.create'])
  })
})

describe('the project workflows', () => {
  const ROOT = join(import.meta.dirname, '..', '..', 'templates', 'workflows')
  for (const [file, tasks] of [['trace-prs.yml', ['open-pr', 'automerge', 'update-queue']], ['trace-ci.yml', ['ci-doctor']]] as const) {
    it(`${file}: every harness step given TRACE_TOKEN is given the app's id and key too`, () => {
      const wf = parse(readFileSync(join(ROOT, file), 'utf8')) as { jobs: Record<string, { steps: { uses?: string; with?: Record<string, string> }[] }> }
      const steps = Object.values(wf.jobs).flatMap((j) => j.steps).filter((s) => s.uses?.includes('/harness/actions/run@') && s.with?.token)
      expect(steps.map((s) => s.with!.task).sort()).toEqual([...tasks].sort())
      for (const s of steps) expect(s.with).toMatchObject({ 'app-id': '${{ vars.TRACE_APP_ID }}', 'app-key': '${{ secrets.TRACE_APP_KEY }}' })
    })
  }
})

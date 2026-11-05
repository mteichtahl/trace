/**
 * The harness acts as trace's GitHub app, with a token from the installation's broker, when it can get one, and as
 * TRACE_TOKEN's account otherwise (src/harness/app-token.ts). In the test run the workflows shared one person's quota,
 * used it up, and `open-pr` and `automerge` failed on "API rate limit exceeded for user ID 1817657" (test-esp32 run 2,
 * #126 and #128).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Octokit } from '@octokit/rest'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { awsCredentials, brokerRegion, chooseToken, fallback, notAllowed, signedRequest } from '../../src/harness/app-token.js'
import { actAs } from '../../src/harness/index.js'
import * as prs from '../../src/harness/prs.js'
import type { GitHub } from '../../src/harness/types.js'
import { cfgOf, context, deps, fakeCore, fakeGithub } from './fake.js'

const URL_ = 'https://abcdefghijklmnop.lambda-url.ap-southeast-2.on.aws/'
const AWS = { AWS_ACCESS_KEY_ID: 'ASIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'session', AWS_REGION: 'us-east-1' }
const creds = awsCredentials(AWS)
const at = () => new Date('2026-11-05T07:23:00Z')

interface Sent { url: string; method: string; headers: Record<string, string>; body?: string | undefined }
/** The broker, answering every request with `status` and `body`, every request kept. */
function broker(status: number, body: unknown) {
  const sent: Sent[] = []
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    sent.push({ url, ...init })
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) }
  }
  return { fetch, sent }
}
const TOKEN = { token: 'ghs_app', login: 'trace-tr[bot]', expiresAt: '2026-11-05T08:23:00Z', repository: 'o/r' }

describe('asking the broker', () => {
  it('takes the step\'s AWS credentials from its environment, the session token too', () => {
    expect(awsCredentials(AWS)).toEqual({ accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session' })
    expect(awsCredentials({ AWS_ACCESS_KEY_ID: 'a' })).toBeNull()
    expect(awsCredentials({})).toBeNull()
  })

  it('signs for the function URL\'s region, else the step\'s', () => {
    expect(brokerRegion(URL_, AWS)).toBe('ap-southeast-2')
    expect(brokerRegion('https://broker.example/', AWS)).toBe('us-east-1')
    expect(brokerRegion('https://broker.example/', {})).toBeNull()
  })

  it('signs the request with SigV4 for lambda, and names no repository: the broker decides it from the role', async () => {
    const r = await signedRequest(URL_, 'ap-southeast-2', creds!, at)
    expect(r.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\/20261105\/ap-southeast-2\/lambda\/aws4_request, SignedHeaders=[a-z0-9;-]*host[a-z0-9;-]*, Signature=[0-9a-f]{64}$/)
    expect(r.headers['x-amz-security-token']).toBe('session')
    expect(r.headers['x-amz-date']).toBe('20261105T072300Z')
    expect(JSON.parse(r.body)).toEqual({})
    // the same request at the same moment signs the same: what the function URL checks
    expect((await signedRequest(URL_, 'ap-southeast-2', creds!, at)).headers.authorization).toBe(r.headers.authorization)
  })

  it('is the app\'s installation token when the broker gives one', async () => {
    const b = broker(200, TOKEN)
    const c = await chooseToken({ url: URL_, credentials: creds, fetch: b.fetch, now: at })
    expect(c).toEqual({ kind: 'app', token: 'ghs_app', login: 'trace-tr[bot]', expiresAt: '2026-11-05T08:23:00Z' })
    expect(b.sent).toHaveLength(1)
    expect(b.sent[0]).toMatchObject({ url: URL_, method: 'POST', body: '{}' })
    expect(b.sent[0]!.headers.authorization).toContain('/ap-southeast-2/lambda/aws4_request')
  })

  it('falls back to the person\'s token, saying why: no broker, no AWS credentials, refused, not answering', async () => {
    expect(await chooseToken({ url: '', credentials: creds })).toMatchObject({ kind: 'person', why: expect.stringContaining('TRACE_GITHUB_APP_BROKER') })
    const unasked = broker(200, TOKEN)
    expect(await chooseToken({ url: URL_, credentials: null, fetch: unasked.fetch })).toMatchObject({ kind: 'person', why: expect.stringContaining('no AWS credentials') })
    expect(unasked.sent).toHaveLength(0)
    expect(await chooseToken({ url: URL_, credentials: creds, fetch: broker(403, { message: 'This role is not one of trace\'s projects\' roles' }).fetch }))
      .toEqual({ kind: 'person', why: 'trace\'s token broker gave no token (403: This role is not one of trace\'s projects\' roles)' })
    expect(await chooseToken({ url: URL_, credentials: creds, fetch: broker(404, { message: 'trace\'s GitHub app is not installed on o/r' }).fetch }))
      .toEqual({ kind: 'person', why: 'trace\'s token broker gave no token (404: trace\'s GitHub app is not installed on o/r)' })
    expect(await chooseToken({ url: URL_, credentials: creds, fetch: broker(200, { message: 'odd' }).fetch })).toMatchObject({ kind: 'person', why: expect.stringContaining('without a token') })
    expect(await chooseToken({ url: URL_, credentials: creds, fetch: async () => { throw new Error('fetch failed') } }))
      .toEqual({ kind: 'person', why: 'trace\'s token broker could not be asked (fetch failed)' })
    expect(await chooseToken({ url: 'https://broker.example/', credentials: creds, env: {} })).toMatchObject({ kind: 'person', why: expect.stringContaining('region') })
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
  const made: string[] = []
  const getOctokit = (token: string): GitHub => { made.push(token); return fakeGithub().gh }

  it('is the app\'s, when the step has the person\'s token and the broker gives the app\'s', async () => {
    made.length = 0
    const c = fakeCore()
    const person = fakeGithub().gh
    const gh = await actAs({ context: context(), core: c, getOctokit }, { OWN_TOKEN: 'ghp_person', BROKER_URL: URL_ }, person, {}, { aws: AWS, fetch: broker(200, TOKEN).fetch })
    expect(made).toEqual(['ghs_app'])
    expect(gh).not.toBe(person)
    expect(c.infos.join('\n')).toContain('acts as its GitHub app here (trace-tr[bot])')
  })

  it('is the person\'s when the broker refuses or is not set up, saying so; and the job\'s token is left alone', async () => {
    made.length = 0
    const person = fakeGithub().gh
    const c = fakeCore()
    expect(await actAs({ context: context(), core: c, getOctokit }, { OWN_TOKEN: 'ghp_person', BROKER_URL: URL_ }, person, {}, { aws: AWS, fetch: broker(404, { message: 'trace\'s GitHub app is not installed on o/r' }).fetch })).toBe(person)
    expect(c.infos.join('\n')).toContain('trace acts as TRACE_TOKEN\'s account here: trace\'s token broker gave no token (404: trace\'s GitHub app is not installed on o/r).')
    expect(await actAs({ context: context(), core: fakeCore(), getOctokit }, { OWN_TOKEN: 'ghp_person' }, person, {}, { aws: AWS })).toBe(person)
    expect(await actAs({ context: context(), core: fakeCore(), getOctokit }, { OWN_TOKEN: 'ghp_person', BROKER_URL: URL_ }, person, {}, { aws: {} })).toBe(person)
    const asked = broker(200, TOKEN)
    expect(await actAs({ context: context(), core: fakeCore(), getOctokit }, { BROKER_URL: URL_ }, person, {}, { aws: AWS, fetch: asked.fetch })).toBe(person)
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
  type Step = { uses?: string; if?: string; 'continue-on-error'?: boolean; with?: Record<string, string> }
  for (const [file, tasks] of [['trace-prs.yml', ['open-pr', 'automerge', 'update-queue']], ['trace-ci.yml', ['ci-doctor']]] as const) {
    it(`${file}: every harness step given TRACE_TOKEN asks the broker, with the token role's credentials got just before`, () => {
      const wf = parse(readFileSync(join(ROOT, file), 'utf8')) as { jobs: Record<string, { permissions: Record<string, string>; steps: Step[] }> }
      const seen: string[] = []
      for (const job of Object.values(wf.jobs)) {
        const i = job.steps.findIndex((s) => s.uses?.includes('/harness/actions/run@') && s.with?.token)
        if (i < 0) continue
        const run = job.steps[i]!
        seen.push(run.with!.task!)
        expect(run.with!['broker-url']).toBe('${{ vars.TRACE_GITHUB_APP_BROKER }}')
        const creds = job.steps[i - 1]!
        expect(creds.uses).toMatch(/^aws-actions\/configure-aws-credentials@[0-9a-f]{40}$/)
        expect(creds.with!['role-to-assume']).toBe('${{ vars.TRACE_GITHUB_APP_ROLE }}')
        // left out without a broker; and a refused role falls back to TRACE_TOKEN, never fails the job
        expect(creds.if).toContain('vars.TRACE_GITHUB_APP_BROKER != \'\'')
        expect(creds['continue-on-error']).toBe(true)
        expect(job.permissions['id-token']).toBe('write')
        // the key is never the repository's
        expect(JSON.stringify(job)).not.toMatch(/APP_KEY|private/i)
      }
      expect(seen.sort()).toEqual([...tasks].sort())
    })
  }
})

/** A GitHub read retries a gateway timeout or server error, and every request waits out a rate limit (src/harness/retry.ts). */
import { describe, expect, it } from 'vitest'
import { Octokit } from '@octokit/rest'
import { patient, rateLimitWait, retried } from '../../src/harness/retry.js'

const failing = (statuses: (number | undefined)[], value = 'ok') => {
  let n = 0
  return { calls: () => n, read: async () => { const s = statuses[n++]; if (n <= statuses.length) throw Object.assign(new Error(`status ${s}`), s === undefined ? {} : { status: s }); return value } }
}
const waits: number[] = []
const sleep = async (ms: number) => { waits.push(ms) }

describe('retried', () => {
  it('retries a 504 (a large blob GitHub could not answer in time) and returns the read', async () => {
    waits.length = 0
    const r = failing([504, 502])
    expect(await retried(r.read, { sleep, waitMs: 10 })).toBe('ok')
    expect(r.calls()).toBe(3)
    expect(waits).toEqual([10, 20])
  })
  it('gives up after the tries, with the last error', async () => {
    const r = failing([503, 503, 503, 503])
    await expect(retried(r.read, { sleep, tries: 3 })).rejects.toThrow('status 503')
    expect(r.calls()).toBe(3)
  })
  it('throws a 4xx or an error without a status at once', async () => {
    const notFound = failing([404])
    await expect(retried(notFound.read, { sleep })).rejects.toMatchObject({ status: 404 })
    expect(notFound.calls()).toBe(1)
    const plain = failing([undefined])
    await expect(retried(plain.read, { sleep })).rejects.toThrow()
    expect(plain.calls()).toBe(1)
  })
})

/** GitHub's rate limits are waited out, not failed on (test-esp32 run 2, #126: open-pr and automerge died on them). */
describe('rateLimitWait', () => {
  const refusal = (status: number, message: string, headers: Record<string, string> = {}) => Object.assign(new Error(message), { status, response: { headers } })
  const now = 1_700_000_000_000

  it('waits until the hourly quota comes back, by x-ratelimit-reset', () => {
    const e = refusal(403, 'API rate limit exceeded for user ID 1817657.', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 90) })
    expect(rateLimitWait(e, now)).toBe(91_000)
  })
  it('waits as long as retry-after says (a secondary limit), and a minute when GitHub says nothing more', () => {
    expect(rateLimitWait(refusal(403, 'You have exceeded a secondary rate limit.', { 'retry-after': '30' }), now)).toBe(30_000)
    expect(rateLimitWait(refusal(429, 'Too many requests', { 'retry-after': '5' }), now)).toBe(5_000)
    expect(rateLimitWait(refusal(403, 'You have exceeded a secondary rate limit.'), now)).toBe(60_000)
  })
  it('takes GraphQL\'s RATE_LIMITED errors for one', () => {
    expect(rateLimitWait(Object.assign(new Error('API rate limit exceeded'), { errors: [{ type: 'RATE_LIMITED' }] }), now)).toBe(60_000)
  })
  it('is null for a refusal that is not a rate limit: a 403 for permissions, a 404, a server error', () => {
    expect(rateLimitWait(refusal(403, 'Resource not accessible by integration'), now)).toBeNull()
    expect(rateLimitWait(refusal(404, 'Not Found'), now)).toBeNull()
    expect(rateLimitWait(refusal(502, 'Bad Gateway'), now)).toBeNull()
    expect(rateLimitWait(new Error('socket hang up'), now)).toBeNull()
  })
})

describe('patient', () => {
  /** A real Octokit whose requests GitHub answers from `answers`, in turn. */
  const octokit = (answers: { status: number; body: unknown; headers?: Record<string, string> }[]) => {
    const seen: string[] = []
    const fetch = async (url: string | URL) => {
      seen.push(String(url))
      const a = answers.shift() ?? { status: 200, body: {} }
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json', ...a.headers } })
    }
    return { gh: new Octokit({ request: { fetch } }), seen }
  }
  const limited = { status: 403, body: { message: 'API rate limit exceeded for user ID 1817657.' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000030' } }
  const now = () => 1_700_000_000_000

  it('waits out a rate limit and makes the same request again, a write too, saying so', async () => {
    const { gh, seen } = octokit([limited, { status: 201, body: { number: 19 } }])
    const said: string[] = []
    const slept: number[] = []
    patient(gh, { sleep: async (ms) => { slept.push(ms) }, now, say: (s) => said.push(s) })
    const r = await gh.rest.pulls.create({ owner: 'o', repo: 'r', head: 'claude/layout', base: 'main', title: 't' })
    expect(r.data).toEqual({ number: 19 })
    expect(seen).toHaveLength(2)
    expect(slept).toEqual([31_000])
    expect(said[0]).toMatch(/GitHub was busy.*Waiting 31 s/)
  })

  it('gives up at once, with GitHub\'s own error, when the wait is longer than the job may wait', async () => {
    const far = { ...limited, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(1_700_000_000 + 3600) } }
    const { gh, seen } = octokit([far])
    const said: string[] = []
    const slept: number[] = []
    patient(gh, { sleep: async (ms) => { slept.push(ms) }, now, say: (s) => said.push(s) })
    await expect(gh.rest.pulls.list({ owner: 'o', repo: 'r' })).rejects.toThrow(/API rate limit exceeded/)
    expect(seen).toHaveLength(1)
    expect(slept).toEqual([])
    expect(said[0]).toMatch(/longer than this job may wait/)
  })

  it('shares one budget between clients, and leaves every other refusal alone', async () => {
    const budget = { leftMs: 40_000 }
    const a = octokit([limited, { status: 200, body: [] }])
    const b = octokit([limited])
    const sleep = async () => undefined
    patient(a.gh, { budget, sleep, now })
    patient(b.gh, { budget, sleep, now })
    await a.gh.rest.pulls.list({ owner: 'o', repo: 'r' })
    expect(budget.leftMs).toBe(9_000)
    await expect(b.gh.rest.pulls.list({ owner: 'o', repo: 'r' })).rejects.toThrow(/rate limit/)
    const c = octokit([{ status: 403, body: { message: 'Resource not accessible by integration' } }])
    patient(c.gh, { sleep, now })
    await expect(c.gh.rest.pulls.list({ owner: 'o', repo: 'r' })).rejects.toMatchObject({ status: 403 })
    expect(c.seen).toHaveLength(1)
  })

  it('leaves a client without a request hook (a test\'s fake) as it is', () => {
    const fake = { rest: {} }
    expect(patient(fake)).toBe(fake)
  })
})

/**
 * A GitHub read that a gateway timeout or a server error should not fail: GitHub answers a large git blob (the
 * project database, up to 100 MB) with a 504 now and then, which failed a whole worker run (testyyyu, pick). Only for
 * reads, which are safe to repeat; a 4xx is the request's own answer and is thrown at once.
 */
const TRANSIENT = new Set([500, 502, 503, 504])

type Sleep = (ms: number) => Promise<void>
const realSleep: Sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms))

export async function retried<T>(read: () => Promise<T>, o: { tries?: number; waitMs?: number; sleep?: Sleep } = {}): Promise<T> {
  const tries = o.tries ?? 3
  const wait = o.waitMs ?? 2000
  const sleep = o.sleep ?? realSleep
  for (let i = 1; ; i++) {
    try {
      return await read()
    } catch (e) {
      const status = (e as { status?: number }).status
      if (i >= tries || status === undefined || !TRANSIENT.has(status)) throw e
      await sleep(wait * i)
    }
  }
}

// ------------------------------------------------------------------ GitHub's rate limits

/**
 * How long a refusal says to wait before the same request may go again, or null when it is not a rate limit.
 *
 * trace's workflows share one GitHub account, and a busy hour used up its quota: `open-pr` and `automerge` died on
 * "API rate limit exceeded for user ID …" and left red checks on a sound change, which the app then said to send back
 * (test-esp32 run 2, #126 and #128). A refusal for a rate limit did nothing, so any request, a write too, may go again:
 *
 * - `retry-after` (seconds): GitHub's secondary limits, and some primary ones, say how long.
 * - `x-ratelimit-remaining: 0` with `x-ratelimit-reset` (epoch seconds): the hourly quota, back at that moment.
 * - a 403 or 429 whose message names a rate limit, with neither header: a minute, as GitHub's documentation asks.
 * - GraphQL answers a used-up quota with errors of type RATE_LIMITED (and a 200): the same.
 */
export function rateLimitWait(e: unknown, now = Date.now()): number | null {
  const err = e as { status?: number; message?: string; response?: { headers?: Record<string, string | number | undefined> }; errors?: { type?: string }[] }
  const headers = err?.response?.headers ?? {}
  const header = (k: string): string | undefined => { const v = headers[k] ?? headers[k.toLowerCase()]; return v === undefined ? undefined : String(v) }
  const graphqlLimited = Array.isArray(err?.errors) && err.errors.some((x) => x?.type === 'RATE_LIMITED')
  const said = /rate limit|abuse detection/i.test(String(err?.message ?? ''))
  const limited = graphqlLimited || ((err?.status === 403 || err?.status === 429) && (said || header('retry-after') !== undefined || header('x-ratelimit-remaining') === '0'))
  if (!limited) return null
  const after = Number(header('retry-after'))
  if (Number.isFinite(after) && after >= 0) return Math.max(1000, after * 1000)
  const reset = Number(header('x-ratelimit-reset'))
  if (header('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset > 0) return Math.max(1000, reset * 1000 - now + 1000)
  return 60_000
}

/**
 * How long one job waits on GitHub's rate limits in all. open-pr and automerge have five minutes (templates/workflows/
 * trace-prs.yml), so a wait longer than this gives up at once rather than run the job into its timeout: the job then
 * fails with GitHub's own words, which the change page reads as GitHub being busy, not as the work failing
 * (src/api/changes.ts infraReason), and offers to run it again.
 */
export const RATE_LIMIT_BUDGET_MS = 3 * 60_000

/** The Octokit surface patient() needs: its request hook (absent in a test's fake, which then is left as it is). */
interface Hooked { hook?: { wrap(name: 'request', fn: (request: (o: unknown) => Promise<unknown>, options: unknown) => Promise<unknown>): void } }

/**
 * The client made patient with GitHub's rate limits: every request it makes (REST, pagination and GraphQL all go
 * through its request hook) that GitHub refuses for a rate limit waits as long as GitHub says and goes again, while the
 * job's budget lasts. Anything else is thrown as before.
 */
export function patient<T>(github: T, o: { budget?: { leftMs: number }; sleep?: Sleep; now?: () => number; say?: (s: string) => void } = {}): T {
  const hooked = github as T & Hooked
  if (!hooked?.hook || typeof hooked.hook.wrap !== 'function') return github
  const sleep = o.sleep ?? realSleep
  const now = o.now ?? Date.now
  // shared by every client of one job (the job's own token and TRACE_TOKEN): one wait in all, not one each
  const budget = o.budget ?? { leftMs: RATE_LIMIT_BUDGET_MS }
  hooked.hook.wrap('request', async (request, options) => {
    for (;;) {
      try {
        return await request(options)
      } catch (e) {
        const wait = rateLimitWait(e, now())
        if (wait === null) throw e
        if (wait > budget.leftMs) {
          o.say?.(`GitHub was busy: it limited trace's requests, and would take ${Math.ceil(wait / 1000)} s to allow more, longer than this job may wait. Run the check again once GitHub allows requests again.`)
          throw e
        }
        budget.leftMs -= wait
        o.say?.(`GitHub was busy: it limited trace's requests. Waiting ${Math.ceil(wait / 1000)} s, then trying again.`)
        await sleep(wait)
      }
    }
  })
  return github
}

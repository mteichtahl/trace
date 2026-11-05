/**
 * Which GitHub identity a harness step acts as: trace's GitHub app's installation on the repository when the app is
 * installed there, else the person's token (TRACE_TOKEN), as before.
 *
 * Why: every project's workflows acted as one GitHub account (the person whose token is TRACE_TOKEN), and so shared that
 * account's hourly quota of 5,000 requests. With ten pull requests open and many agents at work it ran out: `open-pr`
 * and `automerge` failed on "API rate limit exceeded for user ID …" and left red checks on a sound change (test-esp32
 * run 2, #126 and #128). An app installation has a quota of its own (5,000 an hour and more, per installation), so the
 * workflows no longer spend the person's.
 *
 *   what the step is given   the app's id (repository variable TRACE_APP_ID) and its private key (secret TRACE_APP_KEY),
 *                            which the installer sets with TRACE_TOKEN; neither: the person's token, as before
 *   the token                minted here, for this one repository only, and good for an hour (longer than any harness
 *                            job runs): a JSON web token signed with the key asks GitHub for the app's installation on
 *                            the repository, then for an installation token limited to it
 *   falling back             the app not installed on the repository, or GitHub refusing the key: the person's token,
 *                            with a notice that says why. Never a failure: the step works as it did before the app
 *   what stays the person's  opening a pull request (trace tells its changes apart by the login that opened them,
 *                            TRACE_AGENT_LOGIN), git pushes (they are not API requests, so they spend no quota), and any
 *                            request the app is not allowed to make (fallback() below)
 */
import { createSign } from 'node:crypto'
import { rateLimitWait } from './retry.js'

export interface AppCredentials {
  /** the app's id (a number, as text) */
  appId: string
  /** the app's private key, PEM; a key pasted with literal "\n" is read too */
  privateKey: string
}

export type TokenChoice =
  | { kind: 'app'; token: string; login: string; expiresAt: string }
  | { kind: 'person'; why: string }

/** The app's credentials from the step's environment (APP_ID, APP_KEY), or null when either is missing. */
export function appCredentials(env: { APP_ID?: string | undefined; APP_KEY?: string | undefined }): AppCredentials | null {
  const appId = env.APP_ID?.trim() ?? ''
  const privateKey = env.APP_KEY?.trim() ?? ''
  return appId && privateKey ? { appId, privateKey } : null
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url')

/**
 * The app's JSON web token (RS256), which GitHub takes only for the app's own endpoints. Issued a minute in the past
 * (GitHub's advice: the runner's clock may be ahead of GitHub's) and good for nine minutes (GitHub allows ten).
 */
export function appJwt(c: AppCredentials, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: c.appId }))
  const key = c.privateKey.includes('\\n') ? c.privateKey.replace(/\\n/g, '\n') : c.privateKey
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key)
  return `${head}.${body}.${b64url(sig)}`
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>

export interface MintOptions {
  owner: string
  repo: string
  /** GitHub's API (GITHUB_API_URL on a runner) */
  api?: string | undefined
  fetch?: Fetch
  now?: () => number
}

/** Why an answer from GitHub was not what was asked for, in a few words (its message, else its status). */
async function said(r: { status: number; text(): Promise<string> }): Promise<string> {
  const text = await r.text().catch(() => '')
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message
    if (typeof m === 'string' && m) return `${r.status}: ${m}`
  } catch {
    // not JSON: the status says enough
  }
  return String(r.status)
}

/**
 * An installation token of trace's app for owner/repo, limited to that repository; or, when there is none to have,
 * the person's token and why. Never throws.
 */
export async function chooseToken(creds: AppCredentials | null, o: MintOptions): Promise<TokenChoice> {
  if (!creds) return { kind: 'person', why: 'trace\'s GitHub app is not set up for this repository (no TRACE_APP_ID variable and TRACE_APP_KEY secret)' }
  const api = (o.api || 'https://api.github.com').replace(/\/+$/, '')
  const fetchImpl = o.fetch ?? (globalThis.fetch as unknown as Fetch)
  const now = o.now ?? Date.now
  try {
    const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${appJwt(creds, now())}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'trace-harness' }
    const found = await fetchImpl(`${api}/repos/${o.owner}/${o.repo}/installation`, { method: 'GET', headers })
    if (found.status === 404) return { kind: 'person', why: `trace's GitHub app is not installed on ${o.owner}/${o.repo}` }
    if (!found.ok) return { kind: 'person', why: `GitHub would not say whether trace's GitHub app is installed on ${o.owner}/${o.repo} (${await said(found)})` }
    const inst = await found.json() as { id?: unknown; app_slug?: unknown }
    if (typeof inst.id !== 'number') return { kind: 'person', why: 'GitHub named no installation of trace\'s GitHub app' }
    const minted = await fetchImpl(`${api}/app/installations/${inst.id}/access_tokens`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ repositories: [o.repo] }),
    })
    if (!minted.ok) return { kind: 'person', why: `GitHub would not give trace's GitHub app a token for ${o.owner}/${o.repo} (${await said(minted)})` }
    const t = await minted.json() as { token?: unknown; expires_at?: unknown }
    if (typeof t.token !== 'string' || !t.token) return { kind: 'person', why: 'GitHub gave trace\'s GitHub app no token' }
    const slug = typeof inst.app_slug === 'string' && inst.app_slug ? inst.app_slug : 'trace'
    return { kind: 'app', token: t.token, login: `${slug}[bot]`, expiresAt: typeof t.expires_at === 'string' ? t.expires_at : '' }
  } catch (e) {
    // a key that is not a private key fails to sign; a network failure fails the fetch: the person's token either way
    return { kind: 'person', why: `trace's GitHub app could not get a token (${(e instanceof Error ? e.message : String(e)).split('\n')[0]})` }
  }
}

/** Whether GitHub refused a request because the app may not make it (a permission it lacks; a workflow file it may not
 * change), not because of the request itself or a rate limit. */
export function notAllowed(e: unknown): boolean {
  const err = e as { status?: number; message?: string }
  if (rateLimitWait(e) !== null) return false
  const msg = String(err?.message ?? '')
  if (err?.status === 403) return true
  // a push or branch update that would change .github/workflows/** needs the app's `workflows` permission
  return (err?.status === 422 || err?.status === 409) && /workflow/i.test(msg) && /permission|refus|allow/i.test(msg)
}

/** The Octokit surface fallback() needs: its request hook and request (absent in a test's fake, left as it is). */
interface Hooked {
  hook?: { wrap(name: 'request', fn: (request: (o: unknown) => Promise<unknown>, options: unknown) => Promise<unknown>): void }
}
interface Requester { request: (options: never) => Promise<unknown> }

/**
 * The app's client, with every request the app is not allowed to make sent again as the person (their client), once,
 * with a notice: a repository's app installation that lacks a permission degrades to the old way rather than failing
 * the step. A rate limit is not that: it is waited out on the app's own quota (retry.ts patient).
 */
export function fallback<T>(app: T, person: Requester, say: (s: string) => void): T {
  const hooked = app as T & Hooked
  if (!hooked?.hook || typeof hooked.hook.wrap !== 'function') return app
  let told = false
  hooked.hook.wrap('request', async (request, options) => {
    try {
      return await request(options)
    } catch (e) {
      if (!notAllowed(e)) throw e
      if (!told) {
        told = true
        const o = options as { method?: string; url?: string }
        say(`trace's GitHub app may not do this here (${o.method ?? ''} ${o.url ?? ''}: ${(e as Error).message?.split('\n')[0] ?? ''}), so it was done with TRACE_TOKEN. Give the app that permission to keep it off the person's quota.`)
      }
      // without the app's own request hook and fetch, which the options carry: the person's client brings its own
      // (with the app's hook the request would come back here, refused again, for ever)
      const { request: own, ...rest } = options as { request?: Record<string, unknown> }
      const { hook: _hook, fetch: _fetch, ...keep } = own ?? {}
      return person.request({ ...rest, request: keep } as never)
    }
  })
  return app
}

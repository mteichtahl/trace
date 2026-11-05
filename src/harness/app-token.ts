/**
 * Which GitHub identity a harness step acts as: trace's GitHub app's installation on the repository, from the
 * installation's token broker, when the step can reach it; else the person's token (TRACE_TOKEN), as before.
 *
 * Why: every project's workflows acted as one GitHub account (the person whose token is TRACE_TOKEN), and so shared that
 * account's hourly quota of 5,000 requests. With ten pull requests open and many agents at work it ran out: `open-pr`
 * and `automerge` failed on "API rate limit exceeded for user ID …" and left red checks on a sound change (test-esp32
 * run 2, #126 and #128). An app installation has a quota of its own (5,000 an hour and more, per installation), so the
 * workflows no longer spend the person's.
 *
 *   the broker               a Lambda function URL with IAM sign-in (`<prefix>-github-app-token`, docs/agent-identity.md;
 *                            repository variable TRACE_GITHUB_APP_BROKER). It holds the app's private key (Secrets
 *                            Manager, never a repository secret) and gives a token for ONE repository, which it decides
 *                            from the AWS role that signed the request, never from the request: this step names none
 *   signing                  SigV4 (service lambda) with the job's AWS credentials, which the workflow gets from the
 *                            repository's token role by GitHub OIDC (vars.TRACE_GITHUB_APP_ROLE) just before this step
 *   the token                an installation token for this repository alone, good for an hour (longer than any
 *                            harness job runs)
 *   falling back             no broker, no AWS credentials, the broker refusing (an unknown role, the app not
 *                            installed on the repository) or not answering: the person's token, with a notice that
 *                            says why. Never a failure: the step works as it did before the app
 *   what stays the person's  opening a pull request (trace tells its changes apart by the login that opened them,
 *                            TRACE_AGENT_LOGIN), git pushes (they are not API requests, so they spend no quota), and any
 *                            request the app is not allowed to make (fallback() below)
 */
import type { AwsCredentialIdentity } from '@smithy/types'
import { rateLimitWait } from './retry.js'

export type TokenChoice =
  | { kind: 'app'; token: string; login: string; expiresAt: string }
  | { kind: 'person'; why: string }

/** The step's AWS credentials (configure-aws-credentials puts them in the environment), or null without them. */
export function awsCredentials(env: Record<string, string | undefined>): AwsCredentialIdentity | null {
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim()
  if (!accessKeyId || !secretAccessKey) return null
  const sessionToken = env.AWS_SESSION_TOKEN?.trim()
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
}

/** A function URL's region (https://<id>.lambda-url.<region>.on.aws/), else the step's. */
export function brokerRegion(url: string, env: Record<string, string | undefined>): string | null {
  const m = /\.lambda-url\.([a-z0-9-]+)\.on\.aws$/.exec(new URL(url).hostname)
  return m?.[1] ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? null
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>

export interface BrokerOptions {
  /** the broker's function URL (TRACE_GITHUB_APP_BROKER); empty: none */
  url?: string | undefined
  credentials: AwsCredentialIdentity | null
  /** the step's environment, for the region when the URL does not say it */
  env?: Record<string, string | undefined>
  fetch?: Fetch
  /** the signing clock (tests) */
  now?: () => Date
}

/** The broker's request, signed with SigV4 for the function URL's service (lambda). */
export async function signedRequest(url: string, region: string, credentials: AwsCredentialIdentity, now?: () => Date): Promise<{ headers: Record<string, string>; body: string }> {
  const [{ SignatureV4 }, { Sha256 }, { HttpRequest }] = await Promise.all([
    import('@smithy/signature-v4'), import('@aws-crypto/sha256-js'), import('@smithy/protocol-http'),
  ])
  const u = new URL(url)
  // no repository: the broker decides it from the role that signed this, and would ignore one named here
  const body = '{}'
  const signer = new SignatureV4({ service: 'lambda', region, credentials, sha256: Sha256 })
  const signed = await signer.sign(
    new HttpRequest({ method: 'POST', protocol: 'https:', hostname: u.hostname, path: u.pathname || '/', headers: { host: u.hostname, 'content-type': 'application/json' }, body }),
    now ? { signingDate: now() } : {},
  )
  return { headers: signed.headers as Record<string, string>, body }
}

/** What the broker said, in a few words (its message, else its status). */
function said(status: number, text: string): string {
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message
    if (typeof m === 'string' && m) return `${status}: ${m}`
  } catch {
    // not JSON: the status says enough
  }
  return String(status)
}

/**
 * The app's installation token for this step's repository, from the broker; or, when there is none to have, the
 * person's token and why. Never throws.
 */
export async function chooseToken(o: BrokerOptions): Promise<TokenChoice> {
  const url = o.url?.trim()
  if (!url) return { kind: 'person', why: 'no token broker for trace\'s GitHub app is set up for this repository (the TRACE_GITHUB_APP_BROKER variable)' }
  if (!o.credentials) return { kind: 'person', why: 'this step has no AWS credentials to ask trace\'s token broker with (the TRACE_GITHUB_APP_ROLE variable, or the role could not be assumed)' }
  try {
    const region = brokerRegion(url, o.env ?? {})
    if (!region) return { kind: 'person', why: 'the token broker\'s region is not known (its address names none, and AWS_REGION is not set)' }
    const req = await signedRequest(url, region, o.credentials, o.now)
    const r = await (o.fetch ?? (globalThis.fetch as unknown as Fetch))(url, { method: 'POST', headers: req.headers, body: req.body })
    const text = await r.text()
    if (!r.ok) return { kind: 'person', why: `trace's token broker gave no token (${said(r.status, text)})` }
    const t = JSON.parse(text) as { token?: unknown; login?: unknown; expiresAt?: unknown }
    if (typeof t.token !== 'string' || !t.token) return { kind: 'person', why: 'trace\'s token broker answered without a token' }
    return { kind: 'app', token: t.token, login: typeof t.login === 'string' && t.login ? t.login : 'trace[bot]', expiresAt: typeof t.expiresAt === 'string' ? t.expiresAt : '' }
  } catch (e) {
    return { kind: 'person', why: `trace's token broker could not be asked (${(e instanceof Error ? e.message : String(e)).split('\n')[0]})` }
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

/** The Octokit surface fallback() needs: its request hook (absent in a test's fake, left as it is). */
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

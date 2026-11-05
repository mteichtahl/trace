/**
 * trace's token broker (docs/agent-identity.md, "Tokens come from a broker"): the Lambda `<prefix>-github-app-token`
 * behind a function URL with IAM sign-in (src/infra/github-app.ts). It gives an installation token of trace's GitHub app
 * for ONE repository, good for an hour.
 *
 *   which repository   the caller's own project's, from the role that signed the request (requestContext.authorizer.iam
 *                      .userArn: a project's worker, GitHub OIDC or token role, looked up in the installation's
 *                      registry, TRACE_GITHUB_APP_PROJECTS), never from the request: a caller can reach its own
 *                      project's repository and no other, as with per-project tokens. Anything the request says is
 *                      ignored
 *   who may ask        the function URL's IAM sign-in admits only roles granted lambda:InvokeFunctionUrl on it (the
 *                      projects' roles); here a role of another account, or none of the registry's, is refused (403)
 *   the key            Secrets Manager, TRACE_GITHUB_APP_SECRET (JSON { appId, privateKey }), read here and nowhere
 *                      else, kept in memory five minutes so a busy hour reads it a few times, not on every token
 *   answers            200 { token, expiresAt, login, repository }; 403 not a project's role; 404 the app is not
 *                      installed on the repository; 502 GitHub refused; 503 the app is not set up (no key yet)
 *
 * The token is never logged: each answer logs the role, the repository and the outcome only.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import type { LambdaFunctionURLEvent } from 'aws-lambda'
import { type AppCredentials, type Fetch, assumedRole, mintRepositoryToken, parseAppSecret, repositoryOfRole } from '../../core/github-app.js'

export interface Deps {
  prefix: string
  region: string
  /** this function's account: a caller of another account is refused */
  account: string
  /** the registry: the onboarded repositories, space separated */
  registry: string
  /** the secret's text (Secrets Manager GetSecretValue) */
  secret: () => Promise<string>
  fetch?: Fetch
  now?: () => number
  log?: (line: Record<string, unknown>) => void
}

/** What the function URL answers. */
export interface Answer { statusCode: number; headers: Record<string, string>; body: string }

const answer = (statusCode: number, body: Record<string, unknown>): Answer => ({
  statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body),
})

const KEY_TTL_MS = 5 * 60_000
let kept: { at: number; creds: AppCredentials } | null = null

/** The app's credentials, read from the secret at most every five minutes; null when the secret holds none. */
async function credentials(d: Deps, now: number): Promise<AppCredentials | null> {
  if (kept && now - kept.at < KEY_TTL_MS) return kept.creds
  const creds = parseAppSecret(await d.secret())
  if (creds) kept = { at: now, creds }
  return creds
}

/** Forget the kept key (tests). */
export const forgetKey = (): void => { kept = null }

export async function handle(event: LambdaFunctionURLEvent, d: Deps): Promise<Answer> {
  const now = (d.now ?? Date.now)()
  const log = d.log ?? ((l) => console.log(JSON.stringify(l)))
  // the function URL's IAM sign-in puts the signer here; the request's own body and query are never read
  const iam = (event.requestContext as { authorizer?: { iam?: { userArn?: string } } }).authorizer?.iam
  const caller = assumedRole(iam?.userArn ?? '')
  const repository = caller && caller.account === d.account ? repositoryOfRole(caller.role, d) : null
  if (!caller || !repository) {
    log({ outcome: 'refused', caller: iam?.userArn ?? null })
    return answer(403, { message: 'Only a role of one of trace\'s projects may ask for a token, and this is not one.' })
  }
  try {
    const creds = await credentials(d, now)
    if (!creds) {
      log({ outcome: 'not set up', role: caller.role, repository })
      return answer(503, { message: 'trace\'s GitHub app is not set up in this installation yet (its secret holds no app id and key).' })
    }
    const r = await mintRepositoryToken(creds, repository, { ...(d.fetch ? { fetch: d.fetch } : {}), now: () => now })
    if (!r.ok) {
      log({ outcome: 'no token', role: caller.role, repository, status: r.status, message: r.message })
      return answer(r.status, { message: r.message, repository })
    }
    log({ outcome: 'token', role: caller.role, repository, expiresAt: r.expiresAt })
    return answer(200, { token: r.token, expiresAt: r.expiresAt, login: r.login, repository })
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? ''
    log({ outcome: 'failed', role: caller.role, repository, message })
    // the secret missing (ResourceNotFoundException) is the app not set up, as an empty one is
    if ((e as { name?: string }).name === 'ResourceNotFoundException') return answer(503, { message: 'trace\'s GitHub app is not set up in this installation yet (no secret).' })
    return answer(502, { message: `No token: ${message}`, repository })
  }
}

let sm: SecretsManagerClient | null = null
const real = (): Deps => {
  const env = process.env
  const name = env.TRACE_GITHUB_APP_SECRET ?? ''
  return {
    prefix: env.TRACE_PREFIX ?? '', region: env.AWS_REGION ?? '', account: env.TRACE_ACCOUNT ?? '', registry: env.TRACE_GITHUB_APP_PROJECTS ?? '',
    secret: async () => (await (sm ??= new SecretsManagerClient({})).send(new GetSecretValueCommand({ SecretId: name }))).SecretString ?? '',
  }
}

export const handler = (event: LambdaFunctionURLEvent): Promise<Answer> => handle(event, real())

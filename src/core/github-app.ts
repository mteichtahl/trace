/**
 * trace's GitHub app (docs/agent-identity.md): its names in the installation, and minting a token of its installation
 * on one repository. Used by the token broker (src/infra/lambda/github-app-token.ts), the only thing that reads the
 * app's private key.
 */
import { createSign } from 'node:crypto'
import { projectHash } from './project.js'

/** Where the app's id and private key are kept (Secrets Manager; JSON { appId, privateKey }). Nowhere else. */
export const githubAppSecretName = (prefix: string): string => `${prefix}/github-app`
/** The token broker: a Lambda function behind a function URL with IAM sign-in. */
export const githubAppBrokerName = (prefix: string): string => `${prefix}-github-app-token`
/** The stack output carrying the broker's function URL (the projects' TRACE_GITHUB_APP_BROKER). */
export const GITHUB_APP_BROKER_OUTPUT = 'GithubAppBrokerUrl'

/**
 * A project's roles that may ask the broker, by name (src/infra/project.ts makes them):
 *   worker  its worker runtime's execution role (the agents)
 *   actions its GitHub OIDC role, default branch only (TRACE_AWS_ROLE)
 *   token   its token role: GitHub OIDC from any of the repository's runs, allowed nothing but asking the broker
 *           (TRACE_GITHUB_APP_ROLE); open-pr and automerge run on branches and pull requests, where `actions` is refused
 */
export const projectRoleNames = (prefix: string, repository: string, region: string): { worker: string; actions: string; token: string } => {
  const h = projectHash(repository)
  return { worker: `${prefix}-w-${h}-${region}`, actions: `${prefix}-gh-${h}-${region}`, token: `${prefix}-gt-${h}-${region}` }
}

/** The broker's registry: the onboarded repositories, as one environment value (space separated). */
export const registryValue = (repositories: readonly string[]): string => repositories.join(' ')

/** The repository a role belongs to, from the registry; null when the role is none of its projects'. */
export function repositoryOfRole(role: string, o: { prefix: string; region: string; registry: string }): string | null {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`^${esc(o.prefix)}-(w|gh|gt)-([0-9a-f]{8})-${esc(o.region)}$`).exec(role)
  if (!m) return null
  const repos = o.registry.split(/\s+/).filter(Boolean)
  return repos.find((r) => projectHash(r) === m[2]) ?? null
}

/** The role and account of an assumed-role caller (arn:aws:sts::<account>:assumed-role/<role>/<session>); null for any
 * other caller (a user, the root, a federated session). */
export function assumedRole(arn: string): { account: string; role: string } | null {
  const m = /^arn:aws[a-z-]*:sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/.exec(arn)
  return m ? { account: m[1]!, role: m[2]! } : null
}

export interface AppCredentials {
  /** the app's id (a number, as text) */
  appId: string
  /** the app's private key, PEM */
  privateKey: string
}

/** The app's credentials from the secret's text (JSON { appId, privateKey }), or null when it is not that. */
export function parseAppSecret(text: string): AppCredentials | null {
  try {
    const o = JSON.parse(text) as { appId?: unknown; privateKey?: unknown }
    const appId = typeof o.appId === 'number' ? String(o.appId) : typeof o.appId === 'string' ? o.appId.trim() : ''
    const privateKey = typeof o.privateKey === 'string' ? o.privateKey.trim() : ''
    return appId && privateKey ? { appId, privateKey } : null
  } catch {
    return null
  }
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url')

/**
 * The app's JSON web token (RS256), which GitHub takes only for the app's own endpoints. Issued a minute in the past
 * (GitHub's advice: clocks drift) and good for nine minutes (GitHub allows ten).
 */
export function appJwt(c: AppCredentials, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: c.appId }))
  const key = c.privateKey.includes('\\n') ? c.privateKey.replace(/\\n/g, '\n') : c.privateKey
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(key)
  return `${head}.${body}.${b64url(sig)}`
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>

export type Minted =
  | { ok: true; token: string; expiresAt: string; login: string }
  | { ok: false; status: number; message: string }

/** What GitHub said, in a few words (its message, else its status). */
async function said(r: { status: number; text(): Promise<string> }): Promise<string> {
  const text = await r.text().catch(() => '')
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message
    if (typeof m === 'string' && m) return `${r.status}: ${m}`
  } catch {
    // not JSON
  }
  return String(r.status)
}

/**
 * An installation token of the app for `repository` (owner/repo), limited to that one repository; good for an hour.
 * Not installed there: 404. GitHub refusing: its status (502 when it answered with a server error).
 */
export async function mintRepositoryToken(c: AppCredentials, repository: string, o: { api?: string; fetch?: Fetch; now?: () => number } = {}): Promise<Minted> {
  const api = (o.api || 'https://api.github.com').replace(/\/+$/, '')
  const fetchImpl = o.fetch ?? (globalThis.fetch as unknown as Fetch)
  const [owner, repo] = repository.split('/')
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${appJwt(c, (o.now ?? Date.now)())}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'trace-github-app-token' }
  const found = await fetchImpl(`${api}/repos/${owner}/${repo}/installation`, { method: 'GET', headers })
  if (found.status === 404) return { ok: false, status: 404, message: `trace's GitHub app is not installed on ${repository}` }
  if (!found.ok) return { ok: false, status: 502, message: `GitHub would not say whether trace's GitHub app is installed on ${repository} (${await said(found)})` }
  const inst = await found.json() as { id?: unknown; app_slug?: unknown }
  if (typeof inst.id !== 'number') return { ok: false, status: 502, message: 'GitHub named no installation of trace\'s GitHub app' }
  const minted = await fetchImpl(`${api}/app/installations/${inst.id}/access_tokens`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ repositories: [repo] }),
  })
  if (!minted.ok) return { ok: false, status: 502, message: `GitHub would not give trace's GitHub app a token for ${repository} (${await said(minted)})` }
  const t = await minted.json() as { token?: unknown; expires_at?: unknown }
  if (typeof t.token !== 'string' || !t.token) return { ok: false, status: 502, message: 'GitHub gave trace\'s GitHub app no token' }
  const slug = typeof inst.app_slug === 'string' && inst.app_slug ? inst.app_slug : 'trace'
  return { ok: true, token: t.token, expiresAt: typeof t.expires_at === 'string' ? t.expires_at : '', login: `${slug}[bot]` }
}

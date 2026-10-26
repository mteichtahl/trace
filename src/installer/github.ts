/**
 * The installer's GitHub calls: who the token belongs to and what it can reach, and writing each onboarded
 * repository's Actions variables and the TRACE_TOKEN secret. Secrets are encrypted in this process with the
 * repository's public key (libsodium sealed box, as GitHub requires) before they leave the machine.
 */
import sodium from 'libsodium-wrappers'
import { z } from 'zod'

const API = 'https://api.github.com'

export class GithubError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'GithubError' }
}

type Fetch = typeof fetch

export class Github {
  constructor(private readonly token: string, private readonly fetchImpl: Fetch = fetch) {}

  async request<S extends z.ZodType>(method: string, path: string, schema: S, body?: unknown): Promise<{ data: z.output<S>; headers: Headers }> {
    const r = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        'user-agent': 'trace-installer', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await r.text()
    if (!r.ok) {
      let msg = text.slice(0, 300)
      try { msg = String((JSON.parse(text) as { message?: unknown }).message ?? msg) } catch { /* not JSON */ }
      throw new GithubError(`${method} ${path}: ${r.status} ${msg}`, r.status)
    }
    const parsed = schema.safeParse(text ? JSON.parse(text) : null)
    if (!parsed.success) throw new GithubError(`${method} ${path}: unexpected response (${parsed.error.issues[0]?.message})`, 500)
    return { data: parsed.data, headers: r.headers }
  }
}

const User = z.object({ login: z.string(), name: z.string().nullable().optional(), type: z.string() }).loose()
const RepoItem = z.object({ full_name: z.string(), private: z.boolean(), default_branch: z.string().default('main'), archived: z.boolean().optional(), permissions: z.object({ admin: z.boolean().optional(), push: z.boolean().optional() }).loose().optional() }).loose()

export interface TokenInfo {
  login: string
  name: string | null
  kind: 'classic' | 'fine-grained' | 'app' | 'unknown'
  scopes: string[]
  repos: { fullName: string; private: boolean; admin: boolean; push: boolean; defaultBranch: string }[]
  warnings: string[]
}

export async function checkToken(token: string, fetchImpl?: Fetch): Promise<TokenInfo> {
  const gh = new Github(token, fetchImpl)
  const { data: user, headers } = await gh.request('GET', '/user', User)
  const kind = token.startsWith('github_pat_') ? 'fine-grained' : token.startsWith('ghp_') ? 'classic' : token.startsWith('ghs_') ? 'app' : 'unknown'
  const scopes = (headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const repos: TokenInfo['repos'] = []
  for (let page = 1; page <= 10; page++) {
    const { data } = await gh.request('GET', `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`, z.array(RepoItem))
    for (const r of data) if (!r.archived) repos.push({ fullName: r.full_name, private: r.private, admin: Boolean(r.permissions?.admin), push: Boolean(r.permissions?.push), defaultBranch: r.default_branch })
    if (data.length < 100) break
  }
  const warnings: string[] = []
  if (kind === 'classic' && !scopes.includes('repo')) warnings.push('This classic token lacks the `repo` scope.')
  if (kind === 'classic' && !scopes.includes('workflow')) warnings.push('This classic token lacks the `workflow` scope, so the agents cannot change workflow files.')
  if (kind === 'classic') warnings.push('A fine-grained token limited to the onboarded repositories is safer than a classic token.')
  return { login: user.login, name: user.name ?? null, kind, scopes, repos, warnings }
}

/** Check that the token can manage one repository's Actions secrets and variables (what installing needs). */
export async function canConfigure(token: string, repo: string, fetchImpl?: Fetch): Promise<{ ok: boolean; reason: string }> {
  const gh = new Github(token, fetchImpl)
  try {
    await gh.request('GET', `/repos/${repo}/actions/secrets/public-key`, z.object({ key: z.string(), key_id: z.string() }).loose())
    await gh.request('GET', `/repos/${repo}/actions/variables?per_page=1`, z.object({ total_count: z.number() }).loose())
    return { ok: true, reason: '' }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Encrypt `value` for GitHub with the repository's public key (base64 sealed box). */
export async function seal(publicKeyB64: string, value: string): Promise<string> {
  await sodium.ready
  const key = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL)
  return sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(value), key), sodium.base64_variants.ORIGINAL)
}

export async function setSecret(token: string, repo: string, name: string, value: string, fetchImpl?: Fetch): Promise<void> {
  const gh = new Github(token, fetchImpl)
  const { data: key } = await gh.request('GET', `/repos/${repo}/actions/secrets/public-key`, z.object({ key: z.string(), key_id: z.string() }).loose())
  await gh.request('PUT', `/repos/${repo}/actions/secrets/${name}`, z.unknown(), { encrypted_value: await seal(key.key, value), key_id: key.key_id })
}

export async function setVariable(token: string, repo: string, name: string, value: string, fetchImpl?: Fetch): Promise<'created' | 'updated'> {
  const gh = new Github(token, fetchImpl)
  try {
    await gh.request('PATCH', `/repos/${repo}/actions/variables/${name}`, z.unknown(), { name, value })
    return 'updated'
  } catch (e) {
    if (!(e instanceof GithubError) || e.status !== 404) throw e
    await gh.request('POST', `/repos/${repo}/actions/variables`, z.unknown(), { name, value })
    return 'created'
  }
}

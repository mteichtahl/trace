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

const Issue = z.object({ number: z.number(), html_url: z.string(), title: z.string(), labels: z.array(z.union([z.string(), z.object({ name: z.string() }).loose()])).default([]) }).loose()

/** Open issues in a repository (pull requests left out), up to 300. */
export async function listIssues(token: string, slug: string, fetchImpl?: Fetch): Promise<{ number: number; url: string; title: string; labels: string[] }[]> {
  const gh = new Github(token, fetchImpl)
  const out: { number: number; url: string; title: string; labels: string[] }[] = []
  for (let page = 1; page <= 3; page++) {
    const { data } = await gh.request('GET', `/repos/${slug}/issues?state=all&per_page=100&page=${page}`, z.array(Issue.extend({ pull_request: z.unknown().optional() }).loose()))
    for (const i of data) if (!i.pull_request) out.push({ number: i.number, url: i.html_url, title: i.title, labels: i.labels.map((l) => typeof l === 'string' ? l : l.name) })
    if (data.length < 100) break
  }
  return out
}

/** Open an issue, with labels (GitHub creates a label that does not exist yet). */
export async function openIssue(token: string, slug: string, issue: { title: string; body: string; labels: readonly string[] }, fetchImpl?: Fetch): Promise<{ number: number; url: string }> {
  const gh = new Github(token, fetchImpl)
  const { data } = await gh.request('POST', `/repos/${slug}/issues`, Issue, { title: issue.title, body: issue.body, labels: [...issue.labels] })
  return { number: data.number, url: data.html_url }
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

// ------------------------------------------------------------------ what the token can do (the preflight)

const Email = z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }).loose()

/** The token's verified primary email: GET /user/emails (classic `user:email`, fine-grained "Email addresses: read"),
 * else the account's public email; null when neither is visible. */
export async function tokenEmail(token: string, fetchImpl?: Fetch): Promise<string | null> {
  const gh = new Github(token, fetchImpl)
  try {
    const { data } = await gh.request('GET', '/user/emails', z.array(Email))
    const primary = data.find((e) => e.primary && e.verified) ?? data.find((e) => e.verified)
    if (primary) return primary.email
  } catch (e) {
    if (!(e instanceof GithubError) || ![401, 403, 404].includes(e.status)) throw e
  }
  try {
    const { data } = await gh.request('GET', '/user', z.object({ email: z.string().nullable().optional() }).loose())
    return data.email || null
  } catch {
    return null
  }
}

/** One repository: what installing needs of the token there, and which permission is missing for each part. */
export interface RepoAccess {
  repo: string
  /** the token sees the repository at all */
  visible: boolean
  /** Actions variables and secrets can be written (what installing needs at least) */
  configure: boolean
  /** repository settings, the ruleset and CodeBuild's runner registration (Administration) */
  administer: boolean
  /** CodeBuild's webhook (Webhooks) */
  webhooks: boolean
  /** each missing permission, said the way GitHub's token settings say it */
  missing: string[]
}

/**
 * Probe what the token may do on a repository, without changing anything: each read stands for the permission
 * installing needs (a fine-grained token's permissions are granted read-and-write for these in practice; a write
 * can't be probed without writing). `kind`: the token's type, for the wording.
 */
export async function repoAccess(token: string, repo: string, kind: TokenInfo['kind'], fetchImpl?: Fetch): Promise<RepoAccess> {
  const gh = new Github(token, fetchImpl)
  const ok = async (path: string): Promise<boolean> => {
    try { await gh.request('GET', path, z.unknown()); return true } catch (e) { if (e instanceof GithubError && [403, 404].includes(e.status)) return false; throw e }
  }
  let perms: { admin?: boolean | undefined; push?: boolean | undefined } = {}
  try {
    perms = (await gh.request('GET', `/repos/${repo}`, z.object({ permissions: z.object({ admin: z.boolean().optional(), push: z.boolean().optional() }).loose().optional() }).loose())).data.permissions ?? {}
  } catch (e) {
    if (e instanceof GithubError && [403, 404].includes(e.status)) {
      return { repo, visible: false, configure: false, administer: false, webhooks: false, missing: [kind === 'fine-grained' ? `access to ${repo} (add it under "Repository access")` : `access to ${repo}`] }
    }
    throw e
  }
  const [secrets, variables, hooks, admin] = await Promise.all([
    ok(`/repos/${repo}/actions/secrets/public-key`), ok(`/repos/${repo}/actions/variables?per_page=1`), ok(`/repos/${repo}/hooks?per_page=1`), ok(`/repos/${repo}/actions/permissions`),
  ])
  const missing: string[] = []
  if (kind === 'classic') {
    if (!perms.admin) missing.push(`admin on ${repo} (the token's account is not an admin there: its settings, Actions secrets, ruleset and webhooks need it)`)
  } else {
    if (!secrets) missing.push('Secrets: read and write')
    if (!variables) missing.push('Variables: read and write')
    if (!admin) missing.push('Administration: read and write')
    if (!hooks) missing.push('Webhooks: read and write')
  }
  return { repo, visible: true, configure: secrets && variables, administer: admin && Boolean(perms.admin || kind !== 'classic'), webhooks: hooks, missing }
}

/** What a missing permission costs, in the plan and the summary. */
export function accessNote(a: RepoAccess): string | null {
  if (!a.missing.length) return null
  const parts: string[] = []
  if (!a.visible) return `${a.repo}: the token cannot see it: ${a.missing.join('; ')}.`
  if (!a.configure) parts.push('its Actions variables and TRACE_TOKEN secret cannot be set (installing needs them: give the token Secrets and Variables, or an admin token)')
  if (!a.administer) parts.push('its settings and the "trace" ruleset are left alone')
  // CodeBuild makes the runner's webhook with its GitHub credential: with the token as that credential it needs both
  if (!a.administer || !a.webhooks) parts.push('with the token as CodeBuild\'s GitHub credential its build runner can\'t be made (CodeBuild needs Administration and Webhooks: read and write), so the deploy fails; a GitHub connection (Advanced) needs neither')
  return `${a.repo}: the token lacks ${a.missing.join(', ')}: ${parts.join('; ')}.`
}

/** GET a path, its JSON, or null on 404 (or 403: a token that cannot see it). */
export async function getOrNull(token: string, path: string, fetchImpl?: Fetch): Promise<Record<string, unknown> | null> {
  try { return (await new Github(token, fetchImpl).request('GET', path, z.record(z.string(), z.unknown()))).data } catch (e) {
    if (e instanceof GithubError && [403, 404].includes(e.status)) return null
    throw e
  }
}

/** Can repositories outside trace's own use its actions (`uses: <source>/harness/actions/...`)? A public source:
 * always. A private one: only with its Actions access level `user` or `organization`, which its admin may set. */
export async function sourceAccess(token: string, source: string, fetchImpl?: Fetch): Promise<{ ok: boolean; private: boolean; level: string | null; canFix: boolean; admin: boolean; detail: string }> {
  const gh = new Github(token, fetchImpl)
  let repo: { private: boolean; permissions?: { admin?: boolean | undefined } | undefined; owner: { type: string } }
  try {
    repo = (await gh.request('GET', `/repos/${source}`, z.object({ private: z.boolean(), permissions: z.object({ admin: z.boolean().optional() }).loose().optional(), owner: z.object({ type: z.string() }).loose() }).loose())).data
  } catch (e) {
    if (e instanceof GithubError && [403, 404].includes(e.status)) return { ok: false, private: true, level: null, canFix: false, admin: false, detail: `the token cannot see ${source}, whose actions every trace workflow uses: ask its owner for access` }
    throw e
  }
  if (!repo.private) return { ok: true, private: false, level: null, canFix: false, admin: Boolean(repo.permissions?.admin), detail: `${source} is public: every repository can use its actions` }
  let level: string | null = null
  try { level = (await gh.request('GET', `/repos/${source}/actions/permissions/access`, z.object({ access_level: z.string() }).loose())).data.access_level } catch { level = null }
  const ok = level === 'user' || level === 'organization' || level === 'enterprise'
  const admin = Boolean(repo.permissions?.admin)
  return {
    ok, private: true, level, canFix: !ok && admin, admin,
    detail: ok ? `${source} is private and lets repositories of the same ${level === 'user' ? 'account' : level} use its actions`
      : `${source} is private and its actions are not shared (access level ${level ?? 'unknown'}): workflows in other repositories cannot use them. ${admin ? 'trace can set its Actions access to "accessible from repositories owned by the same ' + (repo.owner.type === 'Organization' ? 'organization' : 'user') + '".' : `Its admin must allow it in ${source}'s Settings → Actions → General → Access.`}`,
  }
}

/** Share a private source repository's actions with the repositories of its owner. */
export async function shareSource(token: string, source: string, fetchImpl?: Fetch): Promise<void> {
  const gh = new Github(token, fetchImpl)
  const { data } = await gh.request('GET', `/repos/${source}`, z.object({ owner: z.object({ type: z.string() }).loose() }).loose())
  await gh.request('PUT', `/repos/${source}/actions/permissions/access`, z.unknown(), { access_level: data.owner.type === 'Organization' ? 'organization' : 'user' })
}

/** Create a repository for a new project (the token's own account, or an organisation it may create in). */
export async function createRepo(token: string, slug: string, o: { private: boolean; description?: string }, fetchImpl?: Fetch): Promise<{ fullName: string; defaultBranch: string; created: boolean }> {
  const gh = new Github(token, fetchImpl)
  const [owner, name] = slug.split('/')
  if (!owner || !name) throw new GithubError(`expected OWNER/REPO, got ${slug}`, 400)
  const Repo = z.object({ full_name: z.string(), default_branch: z.string().default('main') }).loose()
  try {
    const { data } = await gh.request('GET', `/repos/${slug}`, Repo)
    return { fullName: data.full_name, defaultBranch: data.default_branch, created: false }
  } catch (e) {
    if (!(e instanceof GithubError) || e.status !== 404) throw e
  }
  const { data: me } = await gh.request('GET', '/user', User)
  const path = me.login.toLowerCase() === owner.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`
  const { data } = await gh.request('POST', path, Repo, { name, private: o.private, auto_init: false, ...(o.description ? { description: o.description } : {}) })
  return { fullName: data.full_name, defaultBranch: 'main', created: true }
}

/** Remove a repository's Actions variable. Returns whether there was one. */
export async function deleteVariable(token: string, repo: string, name: string, fetchImpl?: Fetch): Promise<boolean> {
  const gh = new Github(token, fetchImpl)
  try {
    await gh.request('DELETE', `/repos/${repo}/actions/variables/${name}`, z.unknown())
    return true
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) return false
    throw e
  }
}

/** A repository's Actions variable's value, or null when it has none. */
export async function getVariable(token: string, repo: string, name: string, fetchImpl?: Fetch): Promise<string | null> {
  const gh = new Github(token, fetchImpl)
  try {
    const { data } = await gh.request('GET', `/repos/${repo}/actions/variables/${name}`, z.object({ value: z.string() }).loose())
    return data.value
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) return null
    throw e
  }
}

/** A repository's default branch. */
export async function repositoryDefaultBranch(token: string, repo: string, fetchImpl?: Fetch): Promise<string> {
  const gh = new Github(token, fetchImpl)
  const { data } = await gh.request('GET', `/repos/${repo}`, z.object({ default_branch: z.string() }).loose())
  return data.default_branch
}

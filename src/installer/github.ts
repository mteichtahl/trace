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

const RepoInfo = z.object({ full_name: z.string(), default_branch: z.string().default('main'), private: z.boolean(), size: z.number().default(0), html_url: z.string().default('') }).loose()

/** A repository that exists now: whether this call created it, its default branch and its address. */
export interface EnsuredRepo { created: boolean; defaultBranch: string; url: string; private: boolean }

/**
 * Make sure OWNER/NAME exists: leave one that does alone; else create it, in the token's own account when OWNER is its
 * login, else in the organization OWNER, with a first commit (auto_init) so files can be committed onto its default
 * branch. Creating needs the token's Administration write permission (a fine-grained token) or the `repo` scope.
 */
export async function ensureRepo(token: string, slug: string, o: { private?: boolean; description?: string } = {}, fetchImpl?: Fetch): Promise<EnsuredRepo> {
  const gh = new Github(token, fetchImpl)
  try {
    const { data } = await gh.request('GET', `/repos/${slug}`, RepoInfo)
    return { created: false, defaultBranch: data.default_branch, url: data.html_url || `https://github.com/${slug}`, private: data.private }
  } catch (e) {
    if (!(e instanceof GithubError) || e.status !== 404) throw e
  }
  const [owner = '', name = ''] = slug.split('/')
  const { data: me } = await gh.request('GET', '/user', User)
  const body = { name, private: o.private ?? true, auto_init: true, ...(o.description ? { description: o.description } : {}) }
  const path = me.login.toLowerCase() === owner.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`
  try {
    const { data } = await gh.request('POST', path, RepoInfo, body)
    return { created: true, defaultBranch: data.default_branch, url: data.html_url || `https://github.com/${slug}`, private: data.private }
  } catch (e) {
    if (e instanceof GithubError && (e.status === 403 || e.status === 404)) {
      throw new GithubError(`could not create ${slug}: the token cannot create repositories ${path === '/user/repos' ? 'in its account' : `in ${owner}`} (a fine-grained token needs Administration: read and write; a classic one the repo scope). Create ${slug} yourself, empty, and run the installer again, or give an admin token. (${e.message})`, e.status)
    }
    throw e
  }
}

/** A file to commit: its path in the repository and its bytes. */
export interface RepoFile { path: string; content: Buffer | string; executable?: boolean }

const Ref = z.object({ object: z.object({ sha: z.string() }).loose() }).loose()
const CommitInfo = z.object({ sha: z.string(), tree: z.object({ sha: z.string() }).loose() }).loose()
const Sha = z.object({ sha: z.string() }).loose()

/**
 * Commit `files` onto `branch` in one commit, through the Git data API (no clone, no gh CLI): every file is added or
 * replaced, nothing else is touched. A commit that would change nothing is not made. Returns the new commit's sha, or
 * null when nothing changed.
 */
export async function commitFiles(token: string, slug: string, branch: string, files: readonly RepoFile[], message: string, fetchImpl?: Fetch): Promise<string | null> {
  const gh = new Github(token, fetchImpl)
  const { data: ref } = await gh.request('GET', `/repos/${slug}/git/ref/heads/${encodeURIComponent(branch)}`, Ref)
  const parent = ref.object.sha
  const { data: head } = await gh.request('GET', `/repos/${slug}/git/commits/${parent}`, CommitInfo)
  const entries: { path: string; mode: string; type: 'blob'; sha: string }[] = []
  for (const f of files) {
    const bytes = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content
    const { data: blob } = await gh.request('POST', `/repos/${slug}/git/blobs`, Sha, { content: bytes.toString('base64'), encoding: 'base64' })
    entries.push({ path: f.path, mode: f.executable ? '100755' : '100644', type: 'blob', sha: blob.sha })
  }
  const { data: tree } = await gh.request('POST', `/repos/${slug}/git/trees`, Sha, { base_tree: head.tree.sha, tree: entries })
  if (tree.sha === head.tree.sha) return null
  const { data: commit } = await gh.request('POST', `/repos/${slug}/git/commits`, Sha, { message, tree: tree.sha, parents: [parent] })
  await gh.request('PATCH', `/repos/${slug}/git/refs/heads/${encodeURIComponent(branch)}`, z.unknown(), { sha: commit.sha, force: false })
  return commit.sha
}

/** Does `path` exist on `branch`? */
export async function hasFile(token: string, slug: string, branch: string, path: string, fetchImpl?: Fetch): Promise<boolean> {
  const gh = new Github(token, fetchImpl)
  try {
    await gh.request('GET', `/repos/${slug}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`, z.unknown())
    return true
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) return false
    throw e
  }
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

/** Start a workflow_dispatch workflow on `ref`. */
export async function dispatchWorkflow(token: string, slug: string, workflow: string, ref: string, inputs: Record<string, string> = {}, fetchImpl?: Fetch): Promise<void> {
  const gh = new Github(token, fetchImpl)
  await gh.request('POST', `/repos/${slug}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, z.unknown(), { ref, inputs })
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

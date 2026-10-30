/**
 * The GitHub REST calls the API runtime makes (plain fetch; Octokit is only a dev dependency). Every response body is
 * parsed with zod into exactly the fields used here.
 */
import { z } from 'zod'

export class GitHubError extends Error {
  override name = 'GitHubError'
  constructor(readonly status: number, message: string) { super(message) }
}

export interface PullSummary { number: number; title: string; head: string; draft: boolean; labels: string[]; url: string; updated_at: string }
export interface IssueSummary { number: number; title: string; labels: string[]; url: string; updated_at: string }
export interface RunSummary { id: number; name: string; path: string; event: string; status: string; conclusion: string | null; branch: string | null; url: string; created_at: string }
export interface DeploySummary { id: number; environment: string; ref: string; sha: string; created_at: string; state: string | null; url: string | null }

/** One file in a repository's tree. */
export interface TreeEntry { path: string; size: number; sha: string }
export interface CommitSummary { sha: string; at: string | null; by: string | null; message: string }

export interface GitHubApi {
  defaultBranch(repo: string): Promise<{ branch: string; sha: string }>
  /** The commit sha a branch points at, or null when there is no such branch. */
  branchSha(repo: string, branch: string): Promise<string | null>
  /** Every file (blobs only) in the tree at `ref`, recursively; `truncated` when GitHub cut the listing short. */
  tree(repo: string, ref: string): Promise<{ files: TreeEntry[]; truncated: boolean }>
  /** One file's size and GitHub's short-lived download link (carrying a token for a private repository), or null when
   * there is no such file (or it is a folder). */
  fileInfo(repo: string, path: string, ref: string): Promise<{ size: number; sha: string; downloadUrl: string | null } | null>
  /** The file's bytes at `ref`, or null when it isn't there. */
  rawFile(repo: string, path: string, ref: string): Promise<Uint8Array | null>
  /** The blob sha of the file at `ref`, or null. */
  fileSha(repo: string, path: string, ref: string): Promise<string | null>
  createBranch(repo: string, branch: string, sha: string): Promise<void>
  putFile(repo: string, o: { path: string; branch: string; content: Uint8Array; message: string; sha: string | null }): Promise<{ commit: string }>
  /** The commits that changed `path` on `ref`, newest first (at most `limit`). Optional: absent, no history is shown. */
  commits?(repo: string, path: string, ref: string, limit: number): Promise<CommitSummary[]>
  openPulls(repo: string): Promise<PullSummary[]>
  openIssues(repo: string, label: string): Promise<IssueSummary[]>
  workflowRuns(repo: string, limit: number): Promise<RunSummary[]>
  /** Start a workflow_dispatch run of `workflow` (its file name) on `ref`. Optional: absent, nothing is started. */
  dispatchWorkflow?(repo: string, workflow: string, ref: string): Promise<void>
  lastDeploy(repo: string): Promise<DeploySummary | null>
}

const Label = z.union([z.string(), z.object({ name: z.string() }).loose()])
const labelNames = (ls: readonly z.output<typeof Label>[]): string[] => ls.map((l) => (typeof l === 'string' ? l : l.name))

const Pull = z.object({
  number: z.number(), title: z.string(), draft: z.boolean().optional(), html_url: z.string(), updated_at: z.string(),
  head: z.object({ ref: z.string() }).loose(), labels: z.array(Label).default([]),
}).loose()
const Issue = z.object({
  number: z.number(), title: z.string(), html_url: z.string(), updated_at: z.string(), labels: z.array(Label).default([]),
  pull_request: z.unknown().optional(),
}).loose()
const Run = z.object({
  id: z.number(), name: z.string().nullable().optional(), path: z.string().default(''), event: z.string(), status: z.string().nullable(),
  conclusion: z.string().nullable(), head_branch: z.string().nullable(), html_url: z.string(), created_at: z.string(),
}).loose()
const Tree = z.object({
  truncated: z.boolean().default(false),
  tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string(), size: z.number().optional() }).loose()),
}).loose()
const Deployment = z.object({ id: z.number(), environment: z.string(), ref: z.string(), sha: z.string(), created_at: z.string() }).loose()
const DeployStatus = z.object({ state: z.string(), environment_url: z.string().nullable().optional(), log_url: z.string().nullable().optional() }).loose()

export class HttpGitHub implements GitHubApi {
  private readonly base: string
  private readonly fetch: typeof fetch

  constructor(private readonly token: string, o: { base?: string; fetch?: typeof fetch } = {}) {
    this.base = (o.base ?? 'https://api.github.com').replace(/\/+$/, '')
    this.fetch = o.fetch ?? fetch
  }

  private async req(method: string, path: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<Response> {
    const r = await this.fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'trace-api',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
    return r
  }

  private async json(method: string, path: string, body?: unknown): Promise<unknown> {
    const r = await this.req(method, path, body)
    if (!r.ok) throw new GitHubError(r.status, `GitHub ${method} ${path.split('?')[0]}: ${r.status}`)
    return r.status === 204 ? null : r.json()
  }

  private p(repo: string): string {
    const [o, n] = repo.split('/')
    return `/repos/${encodeURIComponent(o ?? '')}/${encodeURIComponent(n ?? '')}`
  }

  async defaultBranch(repo: string): Promise<{ branch: string; sha: string }> {
    const { default_branch: branch } = z.object({ default_branch: z.string() }).loose().parse(await this.json('GET', this.p(repo)))
    const ref = z.object({ object: z.object({ sha: z.string() }).loose() }).loose()
      .parse(await this.json('GET', `${this.p(repo)}/git/ref/heads/${encodeURIComponent(branch)}`))
    return { branch, sha: ref.object.sha }
  }

  async branchSha(repo: string, branch: string): Promise<string | null> {
    const r = await this.req('GET', `${this.p(repo)}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`)
    if (r.status === 404) return null
    if (!r.ok) throw new GitHubError(r.status, `GitHub GET ref: ${r.status}`)
    return z.object({ object: z.object({ sha: z.string() }).loose() }).loose().parse(await r.json()).object.sha
  }

  async tree(repo: string, ref: string): Promise<{ files: TreeEntry[]; truncated: boolean }> {
    const t = Tree.parse(await this.json('GET', `${this.p(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`))
    return { truncated: t.truncated, files: t.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, size: e.size ?? 0, sha: e.sha })) }
  }

  async fileInfo(repo: string, path: string, ref: string): Promise<{ size: number; sha: string; downloadUrl: string | null } | null> {
    const r = await this.req('GET', this.contentsPath(repo, path, ref))
    if (r.status === 404) return null
    if (!r.ok) throw new GitHubError(r.status, `GitHub GET contents: ${r.status}`)
    const body: unknown = await r.json()
    if (Array.isArray(body)) return null // a folder
    const f = z.object({ type: z.string(), size: z.number(), sha: z.string(), download_url: z.string().nullable().optional() }).loose().parse(body)
    return f.type === 'file' ? { size: f.size, sha: f.sha, downloadUrl: f.download_url ?? null } : null
  }

  private contentsPath(repo: string, path: string, ref: string): string {
    return `${this.p(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`
  }

  async rawFile(repo: string, path: string, ref: string): Promise<Uint8Array | null> {
    const r = await this.req('GET', this.contentsPath(repo, path, ref), undefined, 'application/vnd.github.raw')
    if (r.status === 404) return null
    if (!r.ok) throw new GitHubError(r.status, `GitHub GET contents: ${r.status}`)
    return new Uint8Array(await r.arrayBuffer())
  }

  async fileSha(repo: string, path: string, ref: string): Promise<string | null> {
    const r = await this.req('GET', this.contentsPath(repo, path, ref))
    if (r.status === 404) return null
    if (!r.ok) throw new GitHubError(r.status, `GitHub GET contents: ${r.status}`)
    return z.object({ sha: z.string() }).loose().parse(await r.json()).sha
  }

  async dispatchWorkflow(repo: string, workflow: string, ref: string): Promise<void> {
    await this.json('POST', `${this.p(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref })
  }

  async createBranch(repo: string, branch: string, sha: string): Promise<void> {
    await this.json('POST', `${this.p(repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha })
  }

  async putFile(repo: string, o: { path: string; branch: string; content: Uint8Array; message: string; sha: string | null }): Promise<{ commit: string }> {
    const r = z.object({ commit: z.object({ sha: z.string() }).loose() }).loose().parse(await this.json('PUT', `${this.p(repo)}/contents/${o.path.split('/').map(encodeURIComponent).join('/')}`, {
      message: o.message, branch: o.branch, content: Buffer.from(o.content).toString('base64'), ...(o.sha ? { sha: o.sha } : {}),
    }))
    return { commit: r.commit.sha }
  }

  async commits(repo: string, path: string, ref: string, limit: number): Promise<CommitSummary[]> {
    const C = z.object({ sha: z.string(), commit: z.object({ message: z.string().default(''), author: z.object({ name: z.string().optional(), date: z.string().optional() }).loose().nullable().optional() }).loose() }).loose()
    const q = `path=${encodeURIComponent(path)}&sha=${encodeURIComponent(ref)}&per_page=${Math.min(100, Math.max(1, limit))}`
    return z.array(C).parse(await this.json('GET', `${this.p(repo)}/commits?${q}`)).map((c) => ({
      sha: c.sha, at: c.commit.author?.date ?? null, by: c.commit.author?.name ?? null, message: c.commit.message.split('\n')[0] ?? '',
    }))
  }

  async openPulls(repo: string): Promise<PullSummary[]> {
    return z.array(Pull).parse(await this.json('GET', `${this.p(repo)}/pulls?state=open&per_page=100`)).map((p) => ({
      number: p.number, title: p.title, head: p.head.ref, draft: p.draft ?? false, labels: labelNames(p.labels), url: p.html_url, updated_at: p.updated_at,
    }))
  }

  async openIssues(repo: string, label: string): Promise<IssueSummary[]> {
    return z.array(Issue).parse(await this.json('GET', `${this.p(repo)}/issues?state=open&per_page=100&labels=${encodeURIComponent(label)}`))
      .filter((i) => i.pull_request === undefined)
      .map((i) => ({ number: i.number, title: i.title, labels: labelNames(i.labels), url: i.html_url, updated_at: i.updated_at }))
  }

  async workflowRuns(repo: string, limit: number): Promise<RunSummary[]> {
    const r = z.object({ workflow_runs: z.array(Run) }).loose().parse(await this.json('GET', `${this.p(repo)}/actions/runs?per_page=${Math.min(100, limit)}`))
    return r.workflow_runs.map((w) => ({
      id: w.id, name: w.name ?? '', path: w.path, event: w.event, status: w.status ?? 'unknown', conclusion: w.conclusion,
      branch: w.head_branch, url: w.html_url, created_at: w.created_at,
    }))
  }

  async lastDeploy(repo: string): Promise<DeploySummary | null> {
    const ds = z.array(Deployment).parse(await this.json('GET', `${this.p(repo)}/deployments?per_page=1`))
    const d = ds[0]
    if (!d) return null
    const st = z.array(DeployStatus).parse(await this.json('GET', `${this.p(repo)}/deployments/${d.id}/statuses?per_page=1`))[0]
    return { id: d.id, environment: d.environment, ref: d.ref, sha: d.sha, created_at: d.created_at, state: st?.state ?? null, url: st?.environment_url ?? st?.log_url ?? null }
  }
}

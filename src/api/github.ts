/**
 * The GitHub REST calls the API runtime makes (plain fetch; Octokit is only a dev dependency). Every response body is
 * parsed with zod into exactly the fields used here.
 */
import { z } from 'zod'

export class GitHubError extends Error {
  override name = 'GitHubError'
  /** `said`: GitHub's own message from the body, when it gave one (a merge refused: "At least 1 approving review is
   * required…"), so the caller can tell a review rule from a conflict and say which in plain words */
  constructor(readonly status: number, message: string, readonly said: string | null = null) { super(message) }
}

/**
 * One open pull request. `headRepo`: the repository its head branch lives in (owner/name; null when GitHub no longer
 * knows it, a deleted fork), so a fork's branch that happens to share a trace branch's name is told apart. `sha`: its
 * head commit. `author`: the login that opened it.
 */
export interface PullSummary {
  number: number; title: string; head: string; draft: boolean; labels: string[]; url: string; updated_at: string; created_at?: string | undefined
  headRepo?: string | null | undefined; sha?: string | undefined; author?: string | null | undefined
}
export interface IssueSummary { number: number; title: string; labels: string[]; url: string; updated_at: string }
export interface RunSummary { id: number; name: string; path: string; event: string; status: string; conclusion: string | null; branch: string | null; url: string; created_at: string }
/** One pull request's state now: open, merged or closed, whether it can merge, and its checks on the head commit. */
export interface PullStatus {
  number: number; title: string; url: string; state: 'open' | 'merged' | 'closed'; draft: boolean
  /** GitHub's mergeable_state: clean, blocked, behind, dirty (a conflict), unstable (checks failing), unknown (still computing) */
  mergeable: string; head: string; sha: string; updated_at: string
  /** the head commit's check runs, by how they stand (null: GitHub would not list them) */
  checks: { total: number; passed: number; failed: number; running: number; skipped: number; failing: string[] } | null
}

/** One pull request as the review page needs it: PullStatus's facts plus what it says and where it goes. */
export interface PullDetail {
  number: number; title: string; url: string; state: 'open' | 'merged' | 'closed'; draft: boolean; mergeable: string
  body: string; labels: string[]; created_at: string; updated_at: string
  /** `repo`: the repository its head branch lives in (null: a deleted fork) */
  head: { ref: string; sha: string; repo: string | null }; base: { ref: string; sha: string }
  /** the login that opened it */
  author: string | null
}
/** One file a pull request changes. `patch` is null when GitHub gives none (a binary file, or a diff too large). */
export interface PullFile {
  path: string; status: 'added' | 'modified' | 'removed' | 'renamed'; additions: number; deletions: number; patch: string | null; previous: string | null
}
/** One check run on a commit, with its own one-line result when it wrote one (its output's title or summary). */
export interface CheckRunDetail { name: string; status: string; conclusion: string | null; summary: string | null }
export type MergeMethod = 'squash' | 'merge' | 'rebase'

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
  /** One pull request's state and its head commit's checks. Optional: absent, its status is not shown. */
  pullStatus?(repo: string, number: number): Promise<PullStatus | null>

  // ---- what the guided flow's changes need (src/api/actions-changes.ts). Optional, like pullStatus: an installation
  // (or a test's fake) without them answers that it cannot review changes, and nothing else changes.
  /** One pull request with its body, labels and both ends, or null when there is none. */
  pullDetail?(repo: string, number: number): Promise<PullDetail | null>
  /** The files it changes (at most 300: a change of more is not one a person reviews file by file). */
  pullFiles?(repo: string, number: number): Promise<PullFile[]>
  /** Its commits' messages, oldest first (at most 100). */
  pullCommits?(repo: string, number: number): Promise<string[]>
  /** The check runs on one commit, each with its own result line. */
  checkRuns?(repo: string, sha: string): Promise<CheckRunDetail[]>
  /** The merge methods the repository allows, in trace's order of preference: squash, merge, rebase. */
  mergeMethods?(repo: string): Promise<MergeMethod[]>
  /** Merge it with `method`, only if its head is still `sha` (what the person looked at). Throws GitHubError (with
   * GitHub's message in `said`) when GitHub refuses. */
  mergePull?(repo: string, number: number, o: { method: MergeMethod; sha: string }): Promise<{ sha: string }>
  /** Add a comment to it (to GitHub, a pull request's comments are its issue's). */
  comment?(repo: string, number: number, body: string): Promise<void>
  /** Close it without merging. */
  closePull?(repo: string, number: number): Promise<void>
  /** Take a label off it: false when it did not have it. */
  removeLabel?(repo: string, number: number, label: string): Promise<boolean>
  /** A repository variable's value (Actions variables), or null when there is none or the token may not read it. Used
   * for TRACE_AGENT_LOGIN, the login trace's agents open pull requests as. */
  repoVariable?(repo: string, name: string): Promise<string | null>
}

const Label = z.union([z.string(), z.object({ name: z.string() }).loose()])
const labelNames = (ls: readonly z.output<typeof Label>[]): string[] => ls.map((l) => (typeof l === 'string' ? l : l.name))

/** A head's repository (null when GitHub no longer knows it: a fork that was deleted) and a pull request's author. */
const HeadRepo = z.object({ full_name: z.string() }).loose().nullable().optional()
const User = z.object({ login: z.string() }).loose().nullable().optional()
const Pull = z.object({
  number: z.number(), title: z.string(), draft: z.boolean().optional(), html_url: z.string(), updated_at: z.string(), created_at: z.string().optional(),
  head: z.object({ ref: z.string(), sha: z.string().optional(), repo: HeadRepo }).loose(), labels: z.array(Label).default([]), user: User,
}).loose()
const Issue = z.object({
  number: z.number(), title: z.string(), html_url: z.string(), updated_at: z.string(), labels: z.array(Label).default([]),
  pull_request: z.unknown().optional(),
}).loose()
const Run = z.object({
  id: z.number(), name: z.string().nullable().optional(), path: z.string().default(''), event: z.string(), status: z.string().nullable(),
  conclusion: z.string().nullable(), head_branch: z.string().nullable(), html_url: z.string(), created_at: z.string(),
}).loose()
const PullFull = z.object({
  number: z.number(), title: z.string(), html_url: z.string(), state: z.string(), draft: z.boolean().optional(), merged_at: z.string().nullable().optional(),
  mergeable_state: z.string().optional(), updated_at: z.string(), head: z.object({ ref: z.string(), sha: z.string(), repo: HeadRepo }).loose(),
  user: User,
}).loose()
const CheckRun = z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() }).loose()
const CheckRunOut = CheckRun.extend({ output: z.object({ title: z.string().nullable().optional(), summary: z.string().nullable().optional() }).loose().nullable().optional() })
const PullDetailBody = PullFull.extend({
  body: z.string().nullable().optional(), labels: z.array(Label).default([]), created_at: z.string(),
  base: z.object({ ref: z.string(), sha: z.string() }).loose(),
})
const FileBody = z.object({
  filename: z.string(), status: z.string(), additions: z.number().default(0), deletions: z.number().default(0),
  patch: z.string().optional(), previous_filename: z.string().optional(),
}).loose()
const RepoMerge = z.object({ allow_squash_merge: z.boolean().optional(), allow_merge_commit: z.boolean().optional(), allow_rebase_merge: z.boolean().optional() }).loose()

/** GitHub's file statuses in the four words the review page uses: copied, changed and unchanged (a mode change only)
 * are modifications. */
const fileStatus = (s: string): PullFile['status'] => (s === 'added' || s === 'removed' || s === 'renamed' ? s : 'modified')

/** GitHub's own message in an error body ({ message }), or null. */
async function saidBy(r: Response): Promise<string | null> {
  try {
    const b = z.object({ message: z.string() }).loose().safeParse(await r.json())
    return b.success ? b.data.message.slice(0, 500) : null
  } catch {
    return null
  }
}

/** Check runs by how they stand: a run not completed is running; neutral and skipped are neither passed nor failed. */
export function checksOf(runs: readonly z.output<typeof CheckRun>[]): NonNullable<PullStatus['checks']> {
  const out = { total: runs.length, passed: 0, failed: 0, running: 0, skipped: 0, failing: [] as string[] }
  for (const c of runs) {
    if (c.status !== 'completed') out.running++
    else if (c.conclusion === 'success') out.passed++
    else if (c.conclusion === 'skipped' || c.conclusion === 'neutral') out.skipped++
    else { out.failed++; if (!out.failing.includes(c.name)) out.failing.push(c.name) }
  }
  return out
}

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
    if (!r.ok) throw new GitHubError(r.status, `GitHub ${method} ${path.split('?')[0]}: ${r.status}`, await saidBy(r))
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
      ...(p.created_at ? { created_at: p.created_at } : {}),
      headRepo: p.head.repo?.full_name ?? null, author: p.user?.login ?? null, ...(p.head.sha ? { sha: p.head.sha } : {}),
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

  async pullStatus(repo: string, number: number): Promise<PullStatus | null> {
    const r = await this.req('GET', `${this.p(repo)}/pulls/${number}`)
    if (r.status === 404) return null
    if (!r.ok) throw new GitHubError(r.status, `GitHub GET pull ${number}: ${r.status}`)
    const p = PullFull.parse(await r.json())
    let checks: PullStatus['checks'] = null
    try {
      checks = checksOf(z.object({ check_runs: z.array(CheckRun) }).loose().parse(await this.json('GET', `${this.p(repo)}/commits/${p.head.sha}/check-runs?per_page=100`)).check_runs)
    } catch {
      // the token may not read checks: the pull request's own state is still worth showing
    }
    return {
      number: p.number, title: p.title, url: p.html_url, state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open', draft: p.draft ?? false,
      mergeable: p.mergeable_state ?? 'unknown', head: p.head.ref, sha: p.head.sha, updated_at: p.updated_at, checks,
    }
  }

  async pullDetail(repo: string, number: number): Promise<PullDetail | null> {
    const r = await this.req('GET', `${this.p(repo)}/pulls/${number}`)
    if (r.status === 404) return null
    if (!r.ok) throw new GitHubError(r.status, `GitHub GET pull ${number}: ${r.status}`)
    const p = PullDetailBody.parse(await r.json())
    return {
      number: p.number, title: p.title, url: p.html_url, state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open', draft: p.draft ?? false,
      mergeable: p.mergeable_state ?? 'unknown', body: p.body ?? '', labels: labelNames(p.labels), created_at: p.created_at, updated_at: p.updated_at,
      head: { ref: p.head.ref, sha: p.head.sha, repo: p.head.repo?.full_name ?? null }, base: { ref: p.base.ref, sha: p.base.sha }, author: p.user?.login ?? null,
    }
  }

  async pullFiles(repo: string, number: number): Promise<PullFile[]> {
    // at most three pages of 100: each page is a call, and a change of more than 300 files is not reviewed file by file
    const out: PullFile[] = []
    for (let page = 1; page <= 3; page++) {
      const got = z.array(FileBody).parse(await this.json('GET', `${this.p(repo)}/pulls/${number}/files?per_page=100&page=${page}`))
      out.push(...got.map((f) => ({ path: f.filename, status: fileStatus(f.status), additions: f.additions, deletions: f.deletions, patch: f.patch ?? null, previous: f.previous_filename ?? null })))
      if (got.length < 100) break
    }
    return out
  }

  async pullCommits(repo: string, number: number): Promise<string[]> {
    const C = z.object({ commit: z.object({ message: z.string().default('') }).loose() }).loose()
    return z.array(C).parse(await this.json('GET', `${this.p(repo)}/pulls/${number}/commits?per_page=100`)).map((c) => c.commit.message)
  }

  async checkRuns(repo: string, sha: string): Promise<CheckRunDetail[]> {
    const r = z.object({ check_runs: z.array(CheckRunOut) }).loose().parse(await this.json('GET', `${this.p(repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`))
    return r.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, summary: (c.output?.title || c.output?.summary || null)?.slice(0, 300) ?? null }))
  }

  async mergeMethods(repo: string): Promise<MergeMethod[]> {
    const m = RepoMerge.parse(await this.json('GET', this.p(repo)))
    // a field GitHub left out (a token that may not read the settings) counts as allowed: the merge itself then decides
    return ([['squash', m.allow_squash_merge], ['merge', m.allow_merge_commit], ['rebase', m.allow_rebase_merge]] as const).filter(([, on]) => on !== false).map(([k]) => k)
  }

  async mergePull(repo: string, number: number, o: { method: MergeMethod; sha: string }): Promise<{ sha: string }> {
    const r = z.object({ sha: z.string() }).loose().parse(await this.json('PUT', `${this.p(repo)}/pulls/${number}/merge`, { merge_method: o.method, sha: o.sha }))
    return { sha: r.sha }
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    z.object({ id: z.number() }).loose().parse(await this.json('POST', `${this.p(repo)}/issues/${number}/comments`, { body }))
  }

  async closePull(repo: string, number: number): Promise<void> {
    z.object({ state: z.string() }).loose().parse(await this.json('PATCH', `${this.p(repo)}/pulls/${number}`, { state: 'closed' }))
  }

  async removeLabel(repo: string, number: number, label: string): Promise<boolean> {
    const r = await this.req('DELETE', `${this.p(repo)}/issues/${number}/labels/${encodeURIComponent(label)}`)
    if (r.status === 404) return false
    if (!r.ok) throw new GitHubError(r.status, `GitHub DELETE label: ${r.status}`, await saidBy(r))
    return true
  }

  async repoVariable(repo: string, name: string): Promise<string | null> {
    const r = await this.req('GET', `${this.p(repo)}/actions/variables/${encodeURIComponent(name)}`)
    // none, or a token that may not read the repository's variables: either way there is nothing to go by
    if (!r.ok) return null
    const v = z.object({ value: z.string() }).loose().safeParse(await r.json().catch(() => null))
    return v.success ? v.data.value : null
  }

  async lastDeploy(repo: string): Promise<DeploySummary | null> {
    const ds = z.array(Deployment).parse(await this.json('GET', `${this.p(repo)}/deployments?per_page=1`))
    const d = ds[0]
    if (!d) return null
    const st = z.array(DeployStatus).parse(await this.json('GET', `${this.p(repo)}/deployments/${d.id}/statuses?per_page=1`))[0]
    return { id: d.id, environment: d.environment, ref: d.ref, sha: d.sha, created_at: d.created_at, state: st?.state ?? null, url: st?.environment_url ?? st?.log_url ?? null }
  }
}

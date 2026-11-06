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
  /** the branch it targets: the default branch, or, for a stacked change, the branch of the change it builds on */
  base?: string | undefined
}
export interface IssueSummary { number: number; title: string; labels: string[]; url: string; updated_at: string }
export interface RunSummary { id: number; name: string; path: string; event: string; status: string; conclusion: string | null; branch: string | null; url: string; created_at: string; updated_at?: string }
/** One pull request's state now: open, merged or closed, whether it can merge, and its checks on the head commit. */
export interface PullStatus {
  number: number; title: string; url: string; state: 'open' | 'merged' | 'closed'; draft: boolean
  /** GitHub's mergeable_state: clean, blocked, behind, dirty (a conflict), unstable (checks failing), unknown (still computing) */
  mergeable: string; head: string; sha: string; updated_at: string
  /** the head commit's check runs, by how they stand (null: GitHub would not list them) */
  checks: { total: number; passed: number; failed: number; running: number; skipped: number; failing: string[] } | null
  /** GitHub refused every way of reading them (403; checkRuns) */
  checks_denied?: boolean
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
export interface CheckRunDetail {
  name: string; status: string; conclusion: string | null; summary: string | null
  /**
   * What change.check opens it by: `cr:<check run id>` for a check run, `job:<Actions job id>` for a workflow run's job.
   * Absent for a commit status, and for a workflow run read in place of check runs (a run is several jobs: nothing one
   * check can open).
   */
  id?: string | null | undefined
  /** when it finished (a check run's completed_at, a finished workflow run's updated_at), when GitHub says */
  completed_at?: string | null | undefined
}
export type MergeMethod = 'squash' | 'merge' | 'rebase'
/** One check run in full, for change.check: its report, its times, the commit it ran on and who made it. */
export interface CheckRunFull {
  id: number; name: string; status: string; conclusion: string | null; head_sha: string
  started_at: string | null; completed_at: string | null
  /** its output: title (one line), summary and text (markdown) */
  title: string | null; summary: string | null; text: string | null
  /** how many annotations it wrote */
  annotations: number
  /** the GitHub App that made it, by slug (github-actions: an Actions job, whose id the check run's id is) */
  app: string | null
  /** its page on GitHub, and the page its maker links to */
  url: string | null; details_url: string | null
}
/** One annotation a check run wrote on a file. */
export interface CheckAnnotation { path: string; start_line: number | null; level: string; title: string | null; message: string }

export interface DeploySummary { id: number; environment: string; ref: string; sha: string; created_at: string; state: string | null; url: string | null }

/** One file in a repository's tree. */
export interface TreeEntry { path: string; size: number; sha: string }
export interface CommitSummary { sha: string; at: string | null; by: string | null; message: string }

export interface GitHubApi {
  defaultBranch(repo: string): Promise<{ branch: string; sha: string }>
  /** Whether the repository is there (and this token may see it). Optional: absent, trace cannot say before it tries. */
  repoExists?(repo: string): Promise<boolean>
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
  /** The newest runs, of every workflow; `only` narrows them to one workflow (its file name) and branch on GitHub's side,
   * so a busy repository's other runs never push the ones asked for out of the page. */
  workflowRuns(repo: string, limit: number, only?: { workflow: string; branch?: string }): Promise<RunSummary[]>
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
  /**
   * The check runs on one commit, each with its own result line. `jobs`: when check runs cannot be read and workflow
   * runs stand in for them, each run is read as its jobs (one call per workflow), so each carries a job id to open.
   */
  checkRuns?(repo: string, sha: string, o?: { jobs?: boolean }): Promise<CheckRunDetail[]>
  /** One check run of the repository in full, or null when it has none by that id (or the token may not read it). */
  checkRun?(repo: string, id: number): Promise<CheckRunFull | null>
  /** The annotations a check run wrote, at most `max` (50 at most). */
  checkAnnotations?(repo: string, id: number, max: number): Promise<CheckAnnotation[]>
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

  // ---- what "stay in trace" needs (docs/stay-in-trace.md). Optional, like the rest: absent, the action that needs one
  // says this installation cannot do it.
  /** Open a pull request from `head` to `base`, or answer the one already open for `head`. */
  openPull?(repo: string, o: { head: string; base: string; title: string; body: string }): Promise<{ number: number; existed: boolean }>
  /** Point `branch` at `sha`, forced (only ever a branch of trace's own: an edit made again on a newer default branch). */
  resetBranch?(repo: string, branch: string, sha: string): Promise<void>
  /**
   * One commit of several files on a new branch made from `base` (blobs, a tree on the base commit's tree, a commit, the
   * branch). Answers the commit. Throws when the branch already exists. A file whose content is null is removed.
   */
  commitFiles?(repo: string, o: { branch: string; base: string; message: string; files: { path: string; content: Uint8Array | null }[] }): Promise<{ commit: string }>
  /** Start a workflow_dispatch run with inputs. Absent: dispatchWorkflow without inputs. */
  dispatchWorkflowWith?(repo: string, workflow: string, ref: string, inputs: Record<string, string>): Promise<void>
  /** Any other GitHub REST call, as JSON (rulesets, branch protection, issues, run jobs and logs). */
  request?(method: string, path: string, body?: unknown): Promise<unknown>
  /** A text response (a job's log), at most `max` bytes from its end. */
  requestText?(path: string, max: number): Promise<{ text: string; truncated: boolean }>
}

const Label = z.union([z.string(), z.object({ name: z.string() }).loose()])
const labelNames = (ls: readonly z.output<typeof Label>[]): string[] => ls.map((l) => (typeof l === 'string' ? l : l.name))

/** A head's repository (null when GitHub no longer knows it: a fork that was deleted) and a pull request's author. */
const HeadRepo = z.object({ full_name: z.string() }).loose().nullable().optional()
const User = z.object({ login: z.string() }).loose().nullable().optional()
const Pull = z.object({
  number: z.number(), title: z.string(), draft: z.boolean().optional(), html_url: z.string(), updated_at: z.string(), created_at: z.string().optional(),
  head: z.object({ ref: z.string(), sha: z.string().optional(), repo: HeadRepo }).loose(), labels: z.array(Label).default([]), user: User,
  base: z.object({ ref: z.string() }).loose().optional(),
}).loose()
const Issue = z.object({
  number: z.number(), title: z.string(), html_url: z.string(), updated_at: z.string(), labels: z.array(Label).default([]),
  pull_request: z.unknown().optional(),
}).loose()
const Run = z.object({
  id: z.number(), name: z.string().nullable().optional(), path: z.string().default(''), event: z.string(), status: z.string().nullable(),
  conclusion: z.string().nullable(), head_branch: z.string().nullable(), html_url: z.string(), created_at: z.string(), updated_at: z.string().optional(),
}).loose()
const PullFull = z.object({
  number: z.number(), title: z.string(), html_url: z.string(), state: z.string(), draft: z.boolean().optional(), merged_at: z.string().nullable().optional(),
  mergeable_state: z.string().optional(), updated_at: z.string(), head: z.object({ ref: z.string(), sha: z.string(), repo: HeadRepo }).loose(),
  user: User,
}).loose()
const CheckRun = z.object({ id: z.number().optional(), name: z.string(), status: z.string(), conclusion: z.string().nullable(), completed_at: z.string().nullable().optional() }).loose()
const CheckRunOut = CheckRun.extend({ output: z.object({ title: z.string().nullable().optional(), summary: z.string().nullable().optional() }).loose().nullable().optional() })
const CheckRunBody = z.object({
  id: z.number(), name: z.string(), status: z.string(), conclusion: z.string().nullable().optional(), head_sha: z.string(),
  started_at: z.string().nullable().optional(), completed_at: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(), details_url: z.string().nullable().optional(),
  app: z.object({ slug: z.string().nullable().optional() }).loose().nullable().optional(),
  output: z.object({ title: z.string().nullable().optional(), summary: z.string().nullable().optional(), text: z.string().nullable().optional(), annotations_count: z.number().optional() }).loose().nullable().optional(),
}).loose()
const AnnotationBody = z.object({
  path: z.string(), start_line: z.number().nullable().optional(), annotation_level: z.string().nullable().optional(),
  title: z.string().nullable().optional(), message: z.string().nullable().optional(),
}).loose()
const CombinedStatus = z.object({ statuses: z.array(z.object({ context: z.string(), state: z.string(), description: z.string().nullable().optional() }).loose()).default([]) }).loose()

/** Workflow runs on a commit as checks: the latest run of each workflow (a re-run replaces the one before). */
function latestRuns(runs: readonly z.output<typeof Run>[]): [string, z.output<typeof Run>][] {
  const latest = new Map<string, z.output<typeof Run>>()
  for (const r of runs) {
    const name = r.name || r.path || String(r.id)
    const had = latest.get(name)
    if (!had || had.created_at < r.created_at) latest.set(name, r)
  }
  return [...latest.entries()]
}
export function runsAsChecks(runs: readonly z.output<typeof Run>[]): CheckRunDetail[] {
  return latestRuns(runs).map(([name, r]) => ({ name, status: r.status ?? 'queued', conclusion: r.conclusion, summary: null, ...(r.status === 'completed' && r.updated_at ? { completed_at: r.updated_at } : {}) }))
}

/** A workflow run's jobs as checks, each with its job id to open (change.check). */
export function jobsAsChecks(jobs: readonly { id: number; name: string; status: string; conclusion?: string | null | undefined; completed_at?: string | null | undefined }[]): CheckRunDetail[] {
  return jobs.map((j) => ({ name: j.name, status: j.status, conclusion: j.conclusion ?? null, summary: null, id: `job:${j.id}`, ...(j.status === 'completed' && j.completed_at ? { completed_at: j.completed_at } : {}) }))
}
const RunJobs = z.object({ jobs: z.array(z.object({ id: z.number(), name: z.string(), status: z.string(), conclusion: z.string().nullable().optional(), completed_at: z.string().nullable().optional() }).loose()) }).loose()
/** At most this many workflow runs are read as their jobs for one commit. */
const MAX_RUN_JOBS = 10

/** Commit statuses as checks: success passes, failure and error fail, pending runs. */
export function statusesAsChecks(statuses: readonly { context: string; state: string; description?: string | null | undefined }[]): CheckRunDetail[] {
  return statuses.map((x) => x.state === 'pending'
    ? { name: x.context, status: 'in_progress', conclusion: null, summary: x.description ?? null }
    : { name: x.context, status: 'completed', conclusion: x.state === 'success' ? 'success' : 'failure', summary: x.description ?? null })
}
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
export function checksOf(runs: readonly { name: string; status: string; conclusion: string | null }[]): NonNullable<PullStatus['checks']> {
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

  async repoExists(repo: string): Promise<boolean> {
    const r = await this.req('GET', this.p(repo))
    if (r.status === 404) return false
    if (!r.ok) throw new GitHubError(r.status, `GitHub GET repository: ${r.status}`, await saidBy(r))
    return true
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

  async openPull(repo: string, o: { head: string; base: string; title: string; body: string }): Promise<{ number: number; existed: boolean }> {
    const [owner] = repo.split('/')
    const open = z.array(z.object({ number: z.number() }).loose()).parse(await this.json('GET', `${this.p(repo)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${o.head}`)}&per_page=1`))
    if (open[0]) return { number: open[0].number, existed: true }
    const r = z.object({ number: z.number() }).loose().parse(await this.json('POST', `${this.p(repo)}/pulls`, { head: o.head, base: o.base, title: o.title.slice(0, 250), body: o.body }))
    return { number: r.number, existed: false }
  }

  async resetBranch(repo: string, branch: string, sha: string): Promise<void> {
    await this.json('PATCH', `${this.p(repo)}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { sha, force: true })
  }

  async commitFiles(repo: string, o: { branch: string; base: string; message: string; files: { path: string; content: Uint8Array | null }[] }): Promise<{ commit: string }> {
    const Sha = z.object({ sha: z.string() }).loose()
    const head = await this.branchSha(repo, o.base)
    if (!head) throw new GitHubError(404, `GitHub: no branch ${o.base}`)
    const baseTree = z.object({ tree: z.object({ sha: z.string() }).loose() }).loose().parse(await this.json('GET', `${this.p(repo)}/git/commits/${head}`)).tree.sha
    const tree: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = []
    for (const f of o.files) {
      // content null removes the file (a tree entry with a null sha)
      if (f.content === null) { tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); continue }
      const b = Sha.parse(await this.json('POST', `${this.p(repo)}/git/blobs`, { content: Buffer.from(f.content).toString('base64'), encoding: 'base64' }))
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: b.sha })
    }
    const t = Sha.parse(await this.json('POST', `${this.p(repo)}/git/trees`, { base_tree: baseTree, tree }))
    const c = Sha.parse(await this.json('POST', `${this.p(repo)}/git/commits`, { message: o.message, tree: t.sha, parents: [head] }))
    await this.createBranch(repo, o.branch, c.sha)
    return { commit: c.sha }
  }

  async dispatchWorkflowWith(repo: string, workflow: string, ref: string, inputs: Record<string, string>): Promise<void> {
    await this.json('POST', `${this.p(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref, inputs })
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!path.startsWith('/')) throw new GitHubError(400, 'GitHub: a path from the API root, starting with /')
    return this.json(method, path, body)
  }

  async requestText(path: string, max: number): Promise<{ text: string; truncated: boolean }> {
    const r = await this.req('GET', path, undefined, 'application/vnd.github+json')
    if (!r.ok) throw new GitHubError(r.status, `GitHub GET ${path.split('?')[0]}: ${r.status}`, await saidBy(r))
    const all = Buffer.from(await r.arrayBuffer())
    return all.length > max ? { text: all.subarray(all.length - max).toString('utf8'), truncated: true } : { text: all.toString('utf8'), truncated: false }
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
      ...(p.base?.ref ? { base: p.base.ref } : {}),
    }))
  }

  async openIssues(repo: string, label: string): Promise<IssueSummary[]> {
    return z.array(Issue).parse(await this.json('GET', `${this.p(repo)}/issues?state=open&per_page=100&labels=${encodeURIComponent(label)}`))
      .filter((i) => i.pull_request === undefined)
      .map((i) => ({ number: i.number, title: i.title, labels: labelNames(i.labels), url: i.html_url, updated_at: i.updated_at }))
  }

  async workflowRuns(repo: string, limit: number, only?: { workflow: string; branch?: string }): Promise<RunSummary[]> {
    const path = only ? `/actions/workflows/${encodeURIComponent(only.workflow)}/runs` : '/actions/runs'
    const branch = only?.branch ? `&branch=${encodeURIComponent(only.branch)}` : ''
    const r = z.object({ workflow_runs: z.array(Run) }).loose().parse(await this.json('GET', `${this.p(repo)}${path}?per_page=${Math.min(100, limit)}${branch}`))
    return r.workflow_runs.map((w) => ({
      id: w.id, name: w.name ?? '', path: w.path, event: w.event, status: w.status ?? 'unknown', conclusion: w.conclusion,
      branch: w.head_branch, url: w.html_url, created_at: w.created_at, ...(w.updated_at ? { updated_at: w.updated_at } : {}),
    }))
  }

  async pullStatus(repo: string, number: number): Promise<PullStatus | null> {
    const r = await this.req('GET', `${this.p(repo)}/pulls/${number}`)
    if (r.status === 404) return null
    if (!r.ok) throw new GitHubError(r.status, `GitHub GET pull ${number}: ${r.status}`)
    const p = PullFull.parse(await r.json())
    let checks: PullStatus['checks'] = null
    let denied = false
    try {
      checks = checksOf(await this.checkRuns(repo, p.head.sha))
    } catch (e) {
      // the token may not read checks: the pull request's own state is still worth showing, and a refusal is said as one
      denied = e instanceof GitHubError && e.status === 403
    }
    return {
      number: p.number, title: p.title, url: p.html_url, state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open', draft: p.draft ?? false,
      mergeable: p.mergeable_state ?? 'unknown', head: p.head.ref, sha: p.head.sha, updated_at: p.updated_at, checks,
      ...(denied ? { checks_denied: true } : {}),
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

  /**
   * A commit's checks. GitHub lists check runs only to tokens with "Checks: read", which a fine-grained personal access
   * token cannot have (GitHub Apps only). Refused that (403), they are read as GitHub Actions workflow runs on the
   * commit ("Actions: read") and commit statuses ("Commit statuses: read"), which are what a repository's checks are
   * made of when its CI is Actions; refused those too, the 403 is thrown.
   */
  async checkRuns(repo: string, sha: string, o: { jobs?: boolean } = {}): Promise<CheckRunDetail[]> {
    const ref = encodeURIComponent(sha)
    try {
      const r = z.object({ check_runs: z.array(CheckRunOut) }).loose().parse(await this.json('GET', `${this.p(repo)}/commits/${ref}/check-runs?per_page=100`))
      return r.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, summary: (c.output?.title || c.output?.summary || null)?.slice(0, 300) ?? null, ...(c.completed_at ? { completed_at: c.completed_at } : {}), ...(c.id !== undefined ? { id: `cr:${c.id}` } : {}) }))
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 403) throw e
      const refused = e
      const [runs, statuses] = await Promise.all([
        this.json('GET', `${this.p(repo)}/actions/runs?head_sha=${ref}&per_page=100`).then((j) => this.runChecks(repo, z.object({ workflow_runs: z.array(Run) }).loose().parse(j).workflow_runs, o.jobs === true), (x: unknown) => { if (x instanceof GitHubError && x.status === 403) return null; throw x }),
        this.json('GET', `${this.p(repo)}/commits/${ref}/status`).then((j) => statusesAsChecks(CombinedStatus.parse(j).statuses), (x: unknown) => { if (x instanceof GitHubError && x.status === 403) return null; throw x }),
      ])
      if (runs === null && statuses === null) throw refused
      return [...(runs ?? []), ...(statuses ?? [])]
    }
  }

  /**
   * Workflow runs as checks: the latest run of each workflow; with `jobs`, each of those (at most MAX_RUN_JOBS) read as
   * its jobs, so each can be opened. A run whose jobs cannot be read stays one check, with nothing to open.
   */
  private async runChecks(repo: string, runs: readonly z.output<typeof Run>[], jobs: boolean): Promise<CheckRunDetail[]> {
    const checks = runsAsChecks(runs)
    if (!jobs) return checks
    const latest = latestRuns(runs)
    const parts = await Promise.all(latest.map(([, r], i) => (i < MAX_RUN_JOBS
      ? this.json('GET', `${this.p(repo)}/actions/runs/${r.id}/jobs?per_page=100`).then((j) => { const js = RunJobs.parse(j).jobs; return js.length ? jobsAsChecks(js) : null }, () => null)
      : Promise.resolve(null))))
    return checks.flatMap((c, i) => parts[i] ?? [c])
  }

  async checkRun(repo: string, id: number): Promise<CheckRunFull | null> {
    const r = await this.req('GET', `${this.p(repo)}/check-runs/${id}`)
    if (r.status === 404 || r.status === 403) return null
    if (!r.ok) throw new GitHubError(r.status, `GitHub GET check run ${id}: ${r.status}`, await saidBy(r))
    const c = CheckRunBody.parse(await r.json())
    return {
      id: c.id, name: c.name, status: c.status, conclusion: c.conclusion ?? null, head_sha: c.head_sha, started_at: c.started_at ?? null, completed_at: c.completed_at ?? null,
      title: c.output?.title ?? null, summary: c.output?.summary ?? null, text: c.output?.text ?? null, annotations: c.output?.annotations_count ?? 0,
      app: c.app?.slug ?? null, url: c.html_url ?? null, details_url: c.details_url ?? null,
    }
  }

  async checkAnnotations(repo: string, id: number, max: number): Promise<CheckAnnotation[]> {
    const n = Math.min(50, Math.max(1, max))
    return z.array(AnnotationBody).parse(await this.json('GET', `${this.p(repo)}/check-runs/${id}/annotations?per_page=${n}`)).slice(0, n).map((a) => ({
      path: a.path, start_line: a.start_line ?? null, level: a.annotation_level ?? 'notice', title: a.title ?? null, message: a.message ?? '',
    }))
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

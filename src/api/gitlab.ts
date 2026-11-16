/**
 * The GitLab side of the forge calls the API runtime makes (docs/gitlab-projects.md), behind the same interface as
 * GitHub's (GitHubApi, src/api/github.ts), so the actions above it do not change when a project lives on trace's own
 * GitLab. Plain fetch against GitLab's REST API v4; every response body is parsed with zod into exactly the fields used.
 *
 * How GitHub's words map onto GitLab's:
 * - a repository `owner/name` is a GitLab project path `group/project` (any depth of subgroups);
 * - a pull request is a merge request, and its number is the merge request's iid;
 * - check runs are the jobs of the newest pipeline on the commit (`job:<id>`), and workflow runs are pipelines;
 * - a workflow is a named pipeline: trace's generated `.gitlab-ci.yml` sets `workflow:name` to the GitHub workflow's
 *   file name without its extension (trace-ci, trace-deploy, …) and runs the jobs a `TRACE_WORKFLOW` variable names,
 *   so dispatching a workflow is starting a pipeline with that variable, and its inputs ride as `TRACE_INPUT_<NAME>`.
 *
 * Refusals throw GitHubError (the forge's error type, whatever the forge), so callers that tell a 403 from a 404 keep
 * working unchanged. GitLab has no equivalent of GitHub's raw REST escape hatch (`request`, `requestText`), check-run
 * reports or annotations: those stay absent here, and the actions that need them say this installation cannot do it.
 */
import { z } from 'zod'
import {
  type CheckRunDetail, type CommitSummary, type DeploySummary, GitHubError, type GitHubApi, type IssueSummary, type MergeMethod, type PullDetail,
  type PullFile, type PullStatus, type PullSummary, type RunSummary, type TreeEntry, checksOf,
} from './github.js'

/** At most this many pages of 100 are read from any one listing (a tree of 5,000 files, say). */
const MAX_PAGES = 50

/** When GitLab's refusal is its rate limit (429), the words for it and when to try again. Null for any other refusal. */
export function gitlabRateLimitWords(status: number, headers: Headers, now = Date.now()): string | null {
  if (status !== 429) return null
  const reset = Number(headers.get('ratelimit-reset') ?? NaN)
  const after = Number(headers.get('retry-after') ?? NaN)
  const at = !Number.isNaN(after) ? now + after * 1000 : !Number.isNaN(reset) ? reset * 1000 : null
  const when = at === null ? 'in a few minutes' : at <= now + 60_000 ? 'in a minute' : `in about ${Math.ceil((at - now) / 60_000)} min`
  return `trace's GitLab is limiting how often it may be asked, so it refused this for now. Nothing changed: try again ${when}.`
}

/** A pipeline's or job's status in GitHub's terms: status (queued, in_progress, completed) and conclusion. */
export function gitlabStatus(s: string): { status: string; conclusion: string | null } {
  switch (s) {
    case 'success': return { status: 'completed', conclusion: 'success' }
    case 'failed': return { status: 'completed', conclusion: 'failure' }
    case 'canceled': case 'canceling': return { status: 'completed', conclusion: 'cancelled' }
    case 'skipped': return { status: 'completed', conclusion: 'skipped' }
    case 'running': return { status: 'in_progress', conclusion: null }
    // waiting for a person to start it: GitHub's nearest is a run waiting on approval
    case 'manual': return { status: 'waiting', conclusion: null }
    default: return { status: 'queued', conclusion: null } // created, waiting_for_resource, preparing, pending, scheduled
  }
}

/**
 * A merge request's detailed_merge_status in GitHub's mergeable_state words, which the app already explains: clean,
 * dirty (a conflict), behind, blocked, unstable (its pipeline failed), draft, unknown (still working it out).
 */
export function mergeableOf(detailed: string | null | undefined, pipeline: string | null | undefined): string {
  switch (detailed) {
    case 'mergeable': return 'clean'
    case 'conflict': case 'broken_status': return 'dirty'
    case 'need_rebase': return 'behind'
    case 'draft_status': return 'draft'
    case 'ci_must_pass': return pipeline === 'failed' ? 'unstable' : 'blocked'
    case 'checking': case 'unchecked': case 'preparing': case 'approvals_syncing': case undefined: case null: return 'unknown'
    default: return 'blocked' // ci_still_running, discussions_not_resolved, not_approved, blocked_status, not_open, …
  }
}

/** How many lines a unified diff adds and removes (its hunk headers and file headers left out). */
export function diffCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

const User = z.object({ username: z.string() }).loose().nullable().optional()
const Mr = z.object({
  iid: z.number(), title: z.string(), draft: z.boolean().optional(), web_url: z.string(), updated_at: z.string(), created_at: z.string().optional(),
  source_branch: z.string(), target_branch: z.string(), sha: z.string().nullable().optional(), labels: z.array(z.string()).default([]),
  author: User, project_id: z.number().optional(), source_project_id: z.number().optional(),
}).loose()
const MrFull = Mr.extend({
  state: z.string(), merged_at: z.string().nullable().optional(), detailed_merge_status: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  head_pipeline: z.object({ status: z.string() }).loose().nullable().optional(),
  diff_refs: z.object({ base_sha: z.string().nullable().optional(), head_sha: z.string().nullable().optional() }).loose().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(), squash_commit_sha: z.string().nullable().optional(),
})
const Pipeline = z.object({
  id: z.number(), name: z.string().nullable().optional(), status: z.string(), source: z.string().optional(), ref: z.string().nullable().optional(),
  web_url: z.string(), created_at: z.string(), updated_at: z.string().optional(),
}).loose()
const Job = z.object({ id: z.number(), name: z.string(), status: z.string(), finished_at: z.string().nullable().optional() }).loose()

type Action = { action: 'create' | 'update' | 'delete'; file_path: string; content?: string; encoding?: 'base64' }

export class HttpGitLab implements GitHubApi {
  private readonly base: string
  private readonly fetch: typeof fetch

  /** `base`: the GitLab address, such as https://d123.cloudfront.net (its /api/v4 is added). */
  constructor(private readonly token: string, o: { base: string; fetch?: typeof fetch }) {
    this.base = `${o.base.replace(/\/+$/, '').replace(/\/api\/v4$/, '')}/api/v4`
    this.fetch = o.fetch ?? fetch
  }

  private async req(method: string, path: string, body?: unknown): Promise<Response> {
    return this.fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`, accept: 'application/json', 'user-agent': 'trace-api',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
  }

  private async fail(r: Response, method: string, path: string): Promise<never> {
    const said = await saidBy(r)
    const limit = gitlabRateLimitWords(r.status, r.headers)
    throw new GitHubError(r.status, limit ?? `GitLab ${method} ${path.split('?')[0]}: ${r.status}`, said, limit !== null)
  }

  private async json(method: string, path: string, body?: unknown): Promise<unknown> {
    const r = await this.req(method, path, body)
    if (!r.ok) return this.fail(r, method, path)
    return r.status === 204 ? null : r.json()
  }

  /** Every page of a listing (GitLab's x-next-page), at most `max` items. */
  private async all(path: string, max = MAX_PAGES * 100): Promise<unknown[]> {
    const out: unknown[] = []
    let page: string | null = '1'
    for (let i = 0; page && i < MAX_PAGES && out.length < max; i++) {
      const url: string = `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`
      const r = await this.req('GET', url)
      if (!r.ok) return this.fail(r, 'GET', path)
      out.push(...z.array(z.unknown()).parse(await r.json()))
      page = r.headers.get('x-next-page') || null
    }
    return out.slice(0, max)
  }

  private p(repo: string): string {
    return `/projects/${encodeURIComponent(repo)}`
  }

  private f(path: string): string {
    return encodeURIComponent(path)
  }

  async repoExists(repo: string): Promise<boolean> {
    const r = await this.req('GET', this.p(repo))
    if (r.status === 404) return false
    if (!r.ok) return this.fail(r, 'GET', 'project')
    return true
  }

  async defaultBranch(repo: string): Promise<{ branch: string; sha: string }> {
    const { default_branch: branch } = z.object({ default_branch: z.string() }).loose().parse(await this.json('GET', this.p(repo)))
    const sha = await this.branchSha(repo, branch)
    if (!sha) throw new GitHubError(404, `GitLab: ${repo} has no ${branch} branch`)
    return { branch, sha }
  }

  async branchSha(repo: string, branch: string): Promise<string | null> {
    const r = await this.req('GET', `${this.p(repo)}/repository/branches/${this.f(branch)}`)
    if (r.status === 404) return null
    if (!r.ok) return this.fail(r, 'GET', 'branch')
    return z.object({ commit: z.object({ id: z.string() }).loose() }).loose().parse(await r.json()).commit.id
  }

  async tree(repo: string, ref: string): Promise<{ files: TreeEntry[]; truncated: boolean }> {
    const Entry = z.object({ id: z.string(), path: z.string(), type: z.string() }).loose()
    const max = MAX_PAGES * 100
    const entries = z.array(Entry).parse(await this.all(`${this.p(repo)}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true`, max))
    // GitLab's tree listing gives no sizes: 0 stands for "not known" until a file is opened (fileInfo)
    return { truncated: entries.length >= max, files: entries.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, size: 0, sha: e.id })) }
  }

  async fileInfo(repo: string, path: string, ref: string): Promise<{ size: number; sha: string; downloadUrl: string | null } | null> {
    const r = await this.req('HEAD', `${this.p(repo)}/repository/files/${this.f(path)}?ref=${encodeURIComponent(ref)}`)
    if (r.status === 404) return null
    if (!r.ok) return this.fail(r, 'HEAD', 'file')
    // no short-lived link: GitLab's raw file needs the token, so the API streams the bytes itself (rawFile)
    return { size: Number(r.headers.get('x-gitlab-size') ?? 0), sha: r.headers.get('x-gitlab-blob-id') ?? '', downloadUrl: null }
  }

  async rawFile(repo: string, path: string, ref: string): Promise<Uint8Array | null> {
    const r = await this.req('GET', `${this.p(repo)}/repository/files/${this.f(path)}/raw?ref=${encodeURIComponent(ref)}`)
    if (r.status === 404) return null
    if (!r.ok) return this.fail(r, 'GET', 'raw file')
    return new Uint8Array(await r.arrayBuffer())
  }

  async fileSha(repo: string, path: string, ref: string): Promise<string | null> {
    return (await this.fileInfo(repo, path, ref))?.sha || null
  }

  async createBranch(repo: string, branch: string, sha: string): Promise<void> {
    await this.json('POST', `${this.p(repo)}/repository/branches?branch=${encodeURIComponent(branch)}&ref=${encodeURIComponent(sha)}`)
  }

  private async commit(repo: string, o: { branch: string; message: string; actions: Action[]; start?: string }): Promise<{ commit: string }> {
    const r = z.object({ id: z.string() }).loose().parse(await this.json('POST', `${this.p(repo)}/repository/commits`, {
      branch: o.branch, commit_message: o.message, actions: o.actions, ...(o.start ? { start_branch: o.start } : {}),
    }))
    return { commit: r.id }
  }

  async putFile(repo: string, o: { path: string; branch: string; content: Uint8Array; message: string; sha: string | null }): Promise<{ commit: string }> {
    const content = Buffer.from(o.content).toString('base64')
    return this.commit(repo, { branch: o.branch, message: o.message, actions: [{ action: o.sha ? 'update' : 'create', file_path: o.path, content, encoding: 'base64' }] })
  }

  async commitFiles(repo: string, o: { branch: string; base: string; message: string; files: { path: string; content: Uint8Array | null }[] }): Promise<{ commit: string }> {
    if (await this.branchSha(repo, o.branch)) throw new GitHubError(422, `GitLab: branch ${o.branch} exists already`)
    // GitLab's commit actions must say whether each file is new: ask the base for each one
    const actions = await Promise.all(o.files.map(async (f): Promise<Action | null> => {
      const had = await this.fileInfo(repo, f.path, o.base)
      if (f.content === null) return had ? { action: 'delete', file_path: f.path } : null
      return { action: had ? 'update' : 'create', file_path: f.path, content: Buffer.from(f.content).toString('base64'), encoding: 'base64' }
    }))
    return this.commit(repo, { branch: o.branch, start: o.base, message: o.message, actions: actions.filter((a): a is Action => a !== null) })
  }

  async resetBranch(repo: string, branch: string, sha: string): Promise<void> {
    // GitLab cannot move a branch in place: remove it and make it again at `sha` (an open merge request from it is kept,
    // and shows the new commits once the branch is back)
    const r = await this.req('DELETE', `${this.p(repo)}/repository/branches/${this.f(branch)}`)
    if (!r.ok && r.status !== 404) return this.fail(r, 'DELETE', 'branch')
    await this.createBranch(repo, branch, sha)
  }

  async commits(repo: string, path: string, ref: string, limit: number): Promise<CommitSummary[]> {
    const C = z.object({ id: z.string(), committed_date: z.string().nullable().optional(), author_name: z.string().nullable().optional(), message: z.string() }).loose()
    const n = Math.min(Math.max(limit, 1), 100)
    const list = z.array(C).parse(await this.json('GET', `${this.p(repo)}/repository/commits?ref_name=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&per_page=${n}`))
    return list.map((c) => ({ sha: c.id, at: c.committed_date ?? null, by: c.author_name ?? null, message: c.message }))
  }

  private summary(repo: string, m: z.output<typeof Mr>): PullSummary {
    const fork = m.project_id !== undefined && m.source_project_id !== undefined && m.project_id !== m.source_project_id
    return {
      number: m.iid, title: m.title, head: m.source_branch, draft: m.draft ?? false, labels: m.labels, url: m.web_url, updated_at: m.updated_at,
      ...(m.created_at ? { created_at: m.created_at } : {}),
      // a fork's branch is told apart from the project's own by never naming the project itself
      headRepo: fork ? `fork:${m.source_project_id}` : repo, author: m.author?.username ?? null, ...(m.sha ? { sha: m.sha } : {}), base: m.target_branch,
    }
  }

  async openPulls(repo: string): Promise<PullSummary[]> {
    return z.array(Mr).parse(await this.all(`${this.p(repo)}/merge_requests?state=opened`, 100)).map((m) => this.summary(repo, m))
  }

  async mergedPullFor(repo: string, branch: string): Promise<{ number: number; mergedAt: string } | null> {
    const M = z.object({ iid: z.number(), merged_at: z.string().nullable().optional(), project_id: z.number().optional(), source_project_id: z.number().optional() }).loose()
    const list = z.array(M).parse(await this.json('GET', `${this.p(repo)}/merge_requests?state=merged&source_branch=${encodeURIComponent(branch)}&order_by=updated_at&sort=desc&per_page=10`))
    const m = list.find((x) => x.merged_at && (x.source_project_id === undefined || x.source_project_id === x.project_id))
    return m ? { number: m.iid, mergedAt: m.merged_at as string } : null
  }

  async openIssues(repo: string, label: string): Promise<IssueSummary[]> {
    const I = z.object({ iid: z.number(), title: z.string(), web_url: z.string(), updated_at: z.string(), labels: z.array(z.string()).default([]) }).loose()
    return z.array(I).parse(await this.all(`${this.p(repo)}/issues?state=opened&labels=${encodeURIComponent(label)}`, 100))
      .map((i) => ({ number: i.iid, title: i.title, labels: i.labels, url: i.web_url, updated_at: i.updated_at }))
  }

  async workflowRuns(repo: string, limit: number, only?: { workflow: string; branch?: string }): Promise<RunSummary[]> {
    const name = only ? only.workflow.replace(/\.ya?ml$/, '') : null
    const ref = only?.branch ? `&ref=${encodeURIComponent(only.branch)}` : ''
    // a named workflow is a filter GitLab's listing does not take: read a few pages and keep its pipelines only
    const wanted = Math.max(1, Math.min(limit, 100))
    const list = z.array(Pipeline).parse(await this.all(`${this.p(repo)}/pipelines?order_by=id&sort=desc${ref}`, name ? wanted * 5 : wanted))
    return list.filter((p) => !name || p.name === name).slice(0, wanted).map((p) => {
      const s = gitlabStatus(p.status)
      return {
        id: p.id, name: p.name ?? '', path: p.name ? `.gitlab-ci.yml#${p.name}` : '.gitlab-ci.yml', event: p.source ?? 'push',
        status: s.status, conclusion: s.conclusion, branch: p.ref ?? null, url: p.web_url, created_at: p.created_at,
        ...(p.updated_at ? { updated_at: p.updated_at } : {}),
      }
    })
  }

  async dispatchWorkflow(repo: string, workflow: string, ref: string): Promise<void> {
    await this.dispatchWorkflowWith(repo, workflow, ref, {})
  }

  async dispatchWorkflowWith(repo: string, workflow: string, ref: string, inputs: Record<string, string>): Promise<void> {
    const variables = [
      { key: 'TRACE_WORKFLOW', value: workflow.replace(/\.ya?ml$/, '') },
      ...Object.entries(inputs).map(([k, value]) => ({ key: `TRACE_INPUT_${k.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`, value })),
    ]
    z.object({ id: z.number() }).loose().parse(await this.json('POST', `${this.p(repo)}/pipeline`, { ref, variables }))
  }

  async lastDeploy(repo: string): Promise<DeploySummary | null> {
    const D = z.object({
      id: z.number(), ref: z.string(), sha: z.string(), created_at: z.string(), status: z.string().nullable().optional(),
      environment: z.object({ name: z.string(), external_url: z.string().nullable().optional() }).loose(),
    }).loose()
    const [d] = z.array(D).parse(await this.json('GET', `${this.p(repo)}/deployments?order_by=created_at&sort=desc&per_page=1`))
    if (!d) return null
    return { id: d.id, environment: d.environment.name, ref: d.ref, sha: d.sha, created_at: d.created_at, state: d.status ?? null, url: d.environment.external_url ?? null }
  }

  private async mr(repo: string, number: number): Promise<z.output<typeof MrFull> | null> {
    const r = await this.req('GET', `${this.p(repo)}/merge_requests/${number}`)
    if (r.status === 404) return null
    if (!r.ok) return this.fail(r, 'GET', `merge request ${number}`)
    return MrFull.parse(await r.json())
  }

  private stateOf(m: z.output<typeof MrFull>): 'open' | 'merged' | 'closed' {
    return m.state === 'merged' ? 'merged' : m.state === 'opened' ? 'open' : 'closed'
  }

  async pullStatus(repo: string, number: number): Promise<PullStatus | null> {
    const m = await this.mr(repo, number)
    if (!m) return null
    const sha = m.sha ?? m.diff_refs?.head_sha ?? ''
    let checks: PullStatus['checks'] = null
    let denied = false
    try {
      checks = sha ? checksOf(await this.checkRuns(repo, sha)) : null
    } catch (e) {
      denied = e instanceof GitHubError && e.status === 403
    }
    return {
      number: m.iid, title: m.title, url: m.web_url, state: this.stateOf(m), draft: m.draft ?? false,
      mergeable: mergeableOf(m.detailed_merge_status, m.head_pipeline?.status), head: m.source_branch, sha, updated_at: m.updated_at, checks,
      ...(denied ? { checks_denied: true } : {}),
    }
  }

  async pullDetail(repo: string, number: number): Promise<PullDetail | null> {
    const m = await this.mr(repo, number)
    if (!m) return null
    const fork = m.project_id !== undefined && m.source_project_id !== undefined && m.project_id !== m.source_project_id
    return {
      number: m.iid, title: m.title, url: m.web_url, state: this.stateOf(m), draft: m.draft ?? false,
      mergeable: mergeableOf(m.detailed_merge_status, m.head_pipeline?.status), body: m.description ?? '', labels: m.labels,
      created_at: m.created_at ?? m.updated_at, updated_at: m.updated_at,
      head: { ref: m.source_branch, sha: m.sha ?? m.diff_refs?.head_sha ?? '', repo: fork ? `fork:${m.source_project_id}` : repo },
      base: { ref: m.target_branch, sha: m.diff_refs?.base_sha ?? '' }, author: m.author?.username ?? null,
    }
  }

  async pullFiles(repo: string, number: number): Promise<PullFile[]> {
    const D = z.object({
      old_path: z.string(), new_path: z.string(), new_file: z.boolean(), deleted_file: z.boolean(), renamed_file: z.boolean(),
      diff: z.string().nullable().optional(), too_large: z.boolean().nullable().optional(),
    }).loose()
    const diffs = z.array(D).parse(await this.all(`${this.p(repo)}/merge_requests/${number}/diffs`, 300))
    return diffs.map((d) => {
      const patch = d.diff && !d.too_large ? d.diff : null
      const counts = patch ? diffCounts(patch) : { additions: 0, deletions: 0 }
      const status = d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified'
      return { path: d.new_path, status, ...counts, patch, previous: d.renamed_file ? d.old_path : null }
    })
  }

  async pullCommits(repo: string, number: number): Promise<string[]> {
    const C = z.object({ message: z.string() }).loose()
    // GitLab lists them newest first: trace wants the order they were made in
    return z.array(C).parse(await this.all(`${this.p(repo)}/merge_requests/${number}/commits`, 100)).map((c) => c.message).reverse()
  }

  async checkRuns(repo: string, sha: string): Promise<CheckRunDetail[]> {
    const [pipeline] = z.array(Pipeline).parse(await this.json('GET', `${this.p(repo)}/pipelines?sha=${encodeURIComponent(sha)}&order_by=id&sort=desc&per_page=1`))
    if (!pipeline) return []
    // a retried job's earlier attempts are left out: the newest attempt of each job is its result, as on GitHub
    const jobs = z.array(Job).parse(await this.all(`${this.p(repo)}/pipelines/${pipeline.id}/jobs?include_retried=false`, 300))
    return jobs.map((j) => {
      const s = gitlabStatus(j.status)
      return { name: j.name, ...s, summary: null, id: `job:${j.id}`, ...(j.finished_at ? { completed_at: j.finished_at } : {}) }
    })
  }

  async mergeMethods(repo: string): Promise<MergeMethod[]> {
    const P = z.object({ merge_method: z.string().optional(), squash_option: z.string().optional() }).loose()
    const p = P.parse(await this.json('GET', this.p(repo)))
    const out: MergeMethod[] = []
    if (p.squash_option !== 'never') out.push('squash')
    // fast-forward only: no merge commit is ever made, the nearest of GitHub's methods is rebase
    out.push(p.merge_method === 'ff' ? 'rebase' : 'merge')
    return out
  }

  async mergePull(repo: string, number: number, o: { method: MergeMethod; sha: string }): Promise<{ sha: string }> {
    const m = MrFull.parse(await this.json('PUT', `${this.p(repo)}/merge_requests/${number}/merge`, { sha: o.sha, squash: o.method === 'squash' }))
    return { sha: m.merge_commit_sha ?? m.squash_commit_sha ?? m.sha ?? o.sha }
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    z.object({ id: z.number() }).loose().parse(await this.json('POST', `${this.p(repo)}/merge_requests/${number}/notes`, { body }))
  }

  async closePull(repo: string, number: number): Promise<void> {
    z.object({ state: z.string() }).loose().parse(await this.json('PUT', `${this.p(repo)}/merge_requests/${number}`, { state_event: 'close' }))
  }

  async removeLabel(repo: string, number: number, label: string): Promise<boolean> {
    const m = await this.mr(repo, number)
    if (!m || !m.labels.includes(label)) return false
    await this.json('PUT', `${this.p(repo)}/merge_requests/${number}`, { remove_labels: label })
    return true
  }

  async repoVariable(repo: string, name: string): Promise<string | null> {
    const r = await this.req('GET', `${this.p(repo)}/variables/${encodeURIComponent(name)}`)
    // none, or a token that may not read the project's variables: either way there is nothing to go by
    if (!r.ok) return null
    const v = z.object({ value: z.string() }).loose().safeParse(await r.json().catch(() => null))
    return v.success ? v.data.value : null
  }

  async openPull(repo: string, o: { head: string; base: string; title: string; body: string }): Promise<{ number: number; existed: boolean }> {
    const open = z.array(Mr).parse(await this.json('GET', `${this.p(repo)}/merge_requests?state=opened&source_branch=${encodeURIComponent(o.head)}&per_page=10`))
    const had = open.find((m) => m.source_project_id === undefined || m.source_project_id === m.project_id)
    if (had) return { number: had.iid, existed: true }
    const m = Mr.parse(await this.json('POST', `${this.p(repo)}/merge_requests`, {
      source_branch: o.head, target_branch: o.base, title: o.title, description: o.body, remove_source_branch: true,
    }))
    return { number: m.iid, existed: false }
  }
}

async function saidBy(r: Response): Promise<string | null> {
  const body = await r.json().catch(() => null) as unknown
  const m = z.object({ message: z.unknown().optional(), error: z.string().optional() }).loose().safeParse(body)
  if (!m.success) return null
  const said = m.data.message ?? m.data.error
  if (typeof said === 'string') return said
  // GitLab's validation refusals are { message: { field: [reasons] } } or { message: [reasons] }
  if (said && typeof said === 'object') return Object.values(said as Record<string, unknown>).flat().map(String).join('; ') || null
  return null
}

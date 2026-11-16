/**
 * The harness's GitHub client, answered by trace's GitLab (docs/gitlab-projects.md, build step 5). The harness was
 * written against Octokit (`github.rest.<area>.<call>`); on a project that lives on trace's GitLab its pipeline jobs
 * get this instead, which speaks GitLab's REST API v4 and answers in the shapes Octokit gives, for the calls the
 * harness makes and no others. So the harness's logic (open a change, merge it, keep the queue moving, restack, report)
 * is the same code on both forges.
 *
 * GitHub's words in GitLab's: a pull request is a merge request (its number its iid); an issue is an issue; a check
 * run is a job of the newest pipeline on the commit; a workflow run is a pipeline, and a workflow a named pipeline
 * (`workflow:name`); a workflow dispatch is a pipeline started with TRACE_WORKFLOW and TRACE_INPUT_* variables.
 *
 * Numbers: on GitHub an issue and a pull request share one series, so `issues.*` works on either. On GitLab they are
 * two. A number this client has met as a merge request (in the event, or from pulls.*) is taken as one; any other as
 * an issue. The harness only comments on, labels or closes changes it has just read, so this is always the right one.
 *
 * Not available on GitLab, and refused with a 501 the harness reports: merging one branch into another outside a merge
 * request (repos.merge) and bringing a change up to date by merge (pulls.updateBranch). trace's restack does those with
 * git itself on GitLab.
 */
import { z } from 'zod'

export class ForgeRefusal extends Error {
  override name = 'HttpError'
  constructor(readonly status: number, message: string, readonly response?: { data: unknown }) { super(message) }
}

type Params = Record<string, unknown>
type Answer<T = unknown> = Promise<{ data: T; status: number; headers: Record<string, string> }>

const ok = <T>(data: T, status = 200): { data: T; status: number; headers: Record<string, string> } => ({ data, status, headers: {} })

/** A merge request's mergeability in GitHub's mergeable_state words. */
function mergeableState(detailed: string | null | undefined, pipeline: string | null | undefined): string {
  switch (detailed) {
    case 'mergeable': return 'clean'
    case 'conflict': case 'broken_status': return 'dirty'
    case 'need_rebase': return 'behind'
    case 'draft_status': return 'draft'
    case 'ci_must_pass': return pipeline === 'failed' ? 'unstable' : 'blocked'
    case 'checking': case 'unchecked': case 'preparing': case undefined: case null: return 'unknown'
    default: return 'blocked'
  }
}

/** A job's or pipeline's status in GitHub's status and conclusion. */
function runState(s: string): { status: string; conclusion: string | null } {
  switch (s) {
    case 'success': return { status: 'completed', conclusion: 'success' }
    case 'failed': return { status: 'completed', conclusion: 'failure' }
    case 'canceled': case 'canceling': return { status: 'completed', conclusion: 'cancelled' }
    case 'skipped': return { status: 'completed', conclusion: 'skipped' }
    case 'running': return { status: 'in_progress', conclusion: null }
    case 'manual': return { status: 'waiting', conclusion: null }
    default: return { status: 'queued', conclusion: null }
  }
}

const Mr = z.object({
  iid: z.number(), title: z.string(), description: z.string().nullable().optional(), state: z.string(), draft: z.boolean().optional(),
  web_url: z.string(), created_at: z.string(), updated_at: z.string(), merged_at: z.string().nullable().optional(), closed_at: z.string().nullable().optional(),
  source_branch: z.string(), target_branch: z.string(), sha: z.string().nullable().optional(), labels: z.array(z.string()).default([]),
  author: z.object({ username: z.string(), bot: z.boolean().optional() }).loose().nullable().optional(),
  project_id: z.number().optional(), source_project_id: z.number().optional(),
  detailed_merge_status: z.string().nullable().optional(), head_pipeline: z.object({ status: z.string() }).loose().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(), squash_commit_sha: z.string().nullable().optional(),
  diff_refs: z.object({ base_sha: z.string().nullable().optional(), head_sha: z.string().nullable().optional() }).loose().nullable().optional(),
}).loose()
const Issue = z.object({
  iid: z.number(), title: z.string(), description: z.string().nullable().optional(), state: z.string(), web_url: z.string(),
  created_at: z.string(), updated_at: z.string(), labels: z.array(z.string()).default([]),
  author: z.object({ username: z.string() }).loose().nullable().optional(),
  assignees: z.array(z.object({ username: z.string() }).loose()).default([]),
}).loose()
const Pipeline = z.object({
  id: z.number(), name: z.string().nullable().optional(), status: z.string(), ref: z.string().nullable().optional(), sha: z.string().nullable().optional(),
  web_url: z.string(), created_at: z.string(), updated_at: z.string().optional(), source: z.string().optional(),
}).loose()
const Job = z.object({ id: z.number(), name: z.string(), status: z.string(), started_at: z.string().nullable().optional(), finished_at: z.string().nullable().optional(), web_url: z.string().optional() }).loose()

export interface GitlabOctokitOptions {
  /** trace's GitLab address, https://… */
  url: string
  token: string
  /** the project's path on GitLab (`<prefix>/<name>`) */
  project: string
  /** trace's name for the project (`owner/name`): what `full_name` answers, so the harness's own comparisons hold */
  repository: string
  /** numbers already known to be merge requests (the event's) */
  mergeRequests?: Iterable<number>
  fetch?: typeof fetch
}

export function gitlabOctokit(o: GitlabOctokitOptions) {
  const f = o.fetch ?? fetch
  const base = `${o.url.replace(/\/+$/, '')}/api/v4`
  const P = `/projects/${encodeURIComponent(o.project)}`
  const mrs = new Set<number>(o.mergeRequests ?? [])
  const fullName = o.repository

  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown; next: string | null }> => {
    const r = await f(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${o.token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
    const json = r.status === 204 ? null : await r.json().catch(() => null)
    if (!r.ok) {
      const said = z.object({ message: z.unknown() }).loose().safeParse(json)
      throw new ForgeRefusal(r.status, `GitLab ${method} ${path.split('?')[0]}: ${r.status}${said.success ? ` ${JSON.stringify(said.data.message)}` : ''}`, { data: json })
    }
    return { status: r.status, json, next: r.headers.get('x-next-page') || null }
  }
  const get = async (path: string): Promise<unknown> => (await call('GET', path)).json
  const page = (p: Params): string => `per_page=${Math.min(Number(p.per_page ?? 30), 100)}&page=${Number(p.page ?? 1)}`
  const q = (s: string): string => encodeURIComponent(s)

  const pull = (m: z.output<typeof Mr>) => {
    mrs.add(m.iid)
    const fork = m.project_id !== undefined && m.source_project_id !== undefined && m.project_id !== m.source_project_id
    return {
      number: m.iid, title: m.title, body: m.description ?? '', state: m.state === 'opened' ? 'open' : 'closed', draft: m.draft ?? false,
      html_url: m.web_url, created_at: m.created_at, updated_at: m.updated_at, merged_at: m.merged_at ?? null, closed_at: m.closed_at ?? null,
      merged: m.state === 'merged', merge_commit_sha: m.merge_commit_sha ?? m.squash_commit_sha ?? null,
      mergeable_state: mergeableState(m.detailed_merge_status, m.head_pipeline?.status),
      head: { ref: m.source_branch, sha: m.sha ?? m.diff_refs?.head_sha ?? '', repo: fork ? { full_name: `fork:${m.source_project_id}` } : { full_name: fullName } },
      base: { ref: m.target_branch, sha: m.diff_refs?.base_sha ?? '' },
      labels: m.labels.map((name) => ({ name })),
      user: m.author ? { login: m.author.username, type: m.author.bot ? 'Bot' : 'User' } : null,
    }
  }
  const issue = (i: z.output<typeof Issue>) => ({
    number: i.iid, title: i.title, body: i.description ?? '', state: i.state === 'opened' ? 'open' : 'closed', html_url: i.web_url,
    created_at: i.created_at, updated_at: i.updated_at, labels: i.labels.map((name) => ({ name })),
    user: i.author ? { login: i.author.username } : null, assignees: i.assignees.map((a) => ({ login: a.username })),
  })
  /** the issue or merge request a GitHub issue number names here */
  const thing = (n: number): string => (mrs.has(n) ? `${P}/merge_requests/${n}` : `${P}/issues/${n}`)
  const userId = async (username: string): Promise<number | null> => {
    const [u] = z.array(z.object({ id: z.number() }).loose()).parse(await get(`/users?username=${q(username)}`))
    return u?.id ?? null
  }

  const rest = {
    issues: {
      get: async (p: Params): Answer => {
        const n = Number(p.issue_number)
        if (mrs.has(n)) return ok({ ...pull(Mr.parse(await get(`${P}/merge_requests/${n}`))), pull_request: {} })
        return ok(issue(Issue.parse(await get(`${P}/issues/${n}`))))
      },
      createComment: async (p: Params): Answer => {
        const r = z.object({ id: z.number(), created_at: z.string().optional() }).loose().parse((await call('POST', `${thing(Number(p.issue_number))}/notes`, { body: p.body })).json)
        return ok({ id: r.id, body: p.body, created_at: r.created_at }, 201)
      },
      listComments: async (p: Params): Answer => {
        const N = z.object({ id: z.number(), body: z.string(), system: z.boolean().optional(), created_at: z.string(), updated_at: z.string().optional(), author: z.object({ username: z.string() }).loose() }).loose()
        const notes = z.array(N).parse(await get(`${thing(Number(p.issue_number))}/notes?sort=asc&order_by=created_at&${page(p)}`))
        // GitLab's own notes (label changes, pushes) are not comments
        return ok(notes.filter((n) => !n.system).map((n) => ({ id: n.id, body: n.body, created_at: n.created_at, updated_at: n.updated_at ?? n.created_at, user: { login: n.author.username } })))
      },
      update: async (p: Params): Answer => {
        const body: Record<string, unknown> = {}
        if (typeof p.title === 'string') body.title = p.title
        if (typeof p.body === 'string') body.description = p.body
        if (p.state === 'closed') body.state_event = 'close'
        if (p.state === 'open') body.state_event = 'reopen'
        if (Array.isArray(p.labels)) body.labels = (p.labels as unknown[]).map((l) => (typeof l === 'string' ? l : z.object({ name: z.string() }).loose().parse(l).name)).join(',')
        const n = Number(p.issue_number)
        const r = (await call('PUT', thing(n), body)).json
        return ok(mrs.has(n) ? pull(Mr.parse(r)) : issue(Issue.parse(r)))
      },
      create: async (p: Params): Answer => {
        const labels = Array.isArray(p.labels) ? (p.labels as string[]).join(',') : undefined
        const r = Issue.parse((await call('POST', `${P}/issues`, { title: p.title, description: p.body ?? '', ...(labels ? { labels } : {}) })).json)
        return ok(issue(r), 201)
      },
      listForRepo: async (p: Params): Answer => {
        const state = p.state === 'closed' ? 'closed' : p.state === 'all' ? 'all' : 'opened'
        const labels = typeof p.labels === 'string' && p.labels ? `&labels=${q(p.labels)}` : ''
        return ok(z.array(Issue).parse(await get(`${P}/issues?state=${state}${labels}&${page(p)}`)).map(issue))
      },
      addLabels: async (p: Params): Answer => {
        const labels = (p.labels as unknown[]).map((l) => (typeof l === 'string' ? l : z.object({ name: z.string() }).loose().parse(l).name))
        await call('PUT', thing(Number(p.issue_number)), { add_labels: labels.join(',') })
        return ok(labels.map((name) => ({ name })))
      },
      removeLabel: async (p: Params): Answer => {
        const n = Number(p.issue_number)
        const had = z.object({ labels: z.array(z.string()).default([]) }).loose().parse(await get(thing(n))).labels
        if (!had.includes(String(p.name))) throw new ForgeRefusal(404, `GitLab: ${String(p.name)} is not on ${n}`)
        await call('PUT', thing(n), { remove_labels: String(p.name) })
        return ok([])
      },
      getLabel: async (p: Params): Answer => {
        const L = z.object({ name: z.string(), color: z.string(), description: z.string().nullable().optional() }).loose()
        const l = L.parse(await get(`${P}/labels/${q(String(p.name))}`))
        return ok({ name: l.name, color: l.color.replace(/^#/, ''), description: l.description ?? '' })
      },
      createLabel: async (p: Params): Answer => {
        await call('POST', `${P}/labels`, { name: p.name, color: `#${String(p.color ?? '888888').replace(/^#/, '')}`, description: p.description ?? '' })
        return ok({ name: p.name }, 201)
      },
      addAssignees: async (p: Params): Answer => {
        const ids = (await Promise.all((p.assignees as string[]).map(userId))).filter((x): x is number => x !== null)
        await call('PUT', thing(Number(p.issue_number)), { assignee_ids: ids })
        return ok({})
      },
    },
    pulls: {
      list: async (p: Params): Answer => {
        const state = p.state === 'closed' ? 'closed' : p.state === 'all' ? 'all' : 'opened'
        const head = typeof p.head === 'string' ? `&source_branch=${q(p.head.split(':').at(-1) ?? '')}` : ''
        const baseRef = typeof p.base === 'string' ? `&target_branch=${q(p.base)}` : ''
        // GitHub's closed includes merged ones: GitLab keeps them apart
        const list = state === 'closed'
          ? [...z.array(Mr).parse(await get(`${P}/merge_requests?state=closed${head}${baseRef}&${page(p)}`)), ...z.array(Mr).parse(await get(`${P}/merge_requests?state=merged${head}${baseRef}&${page(p)}`))]
          : z.array(Mr).parse(await get(`${P}/merge_requests?state=${state}${head}${baseRef}&${page(p)}`))
        return ok(list.map(pull))
      },
      get: async (p: Params): Answer => ok(pull(Mr.parse(await get(`${P}/merge_requests/${Number(p.pull_number)}`)))),
      update: async (p: Params): Answer => {
        const body: Record<string, unknown> = {}
        if (typeof p.base === 'string') body.target_branch = p.base
        if (typeof p.title === 'string') body.title = p.title
        if (typeof p.body === 'string') body.description = p.body
        if (p.state === 'closed') body.state_event = 'close'
        if (p.state === 'open') body.state_event = 'reopen'
        return ok(pull(Mr.parse((await call('PUT', `${P}/merge_requests/${Number(p.pull_number)}`, body)).json)))
      },
      listFiles: async (p: Params): Answer => {
        const D = z.object({ old_path: z.string(), new_path: z.string(), new_file: z.boolean(), deleted_file: z.boolean(), renamed_file: z.boolean(), diff: z.string().nullable().optional() }).loose()
        const diffs = z.array(D).parse(await get(`${P}/merge_requests/${Number(p.pull_number)}/diffs?${page(p)}`))
        return ok(diffs.map((d) => {
          const lines = (d.diff ?? '').split('\n')
          const additions = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
          const deletions = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length
          const status = d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified'
          return { filename: d.new_path, previous_filename: d.renamed_file ? d.old_path : undefined, status, additions, deletions, changes: additions + deletions, patch: d.diff ?? undefined }
        }))
      },
      listCommits: async (p: Params): Answer => {
        const C = z.object({ id: z.string(), message: z.string(), author_name: z.string().optional(), authored_date: z.string().optional(), parent_ids: z.array(z.string()).default([]) }).loose()
        const list = z.array(C).parse(await get(`${P}/merge_requests/${Number(p.pull_number)}/commits?${page(p)}`))
        // GitLab lists newest first; GitHub oldest first
        return ok(list.reverse().map((c) => ({ sha: c.id, commit: { message: c.message, author: { name: c.author_name ?? '', date: c.authored_date ?? '' } }, parents: c.parent_ids.map((sha) => ({ sha })) })))
      },
      updateBranch: async (_p?: Params): Answer => { throw new ForgeRefusal(501, 'GitLab cannot bring a merge request up to date by merge through its API: trace\'s restack merges the base in with git') },
    },
    repos: {
      get: async (_p?: Params): Answer => {
        const r = z.object({ default_branch: z.string(), visibility: z.string().optional(), web_url: z.string() }).loose().parse(await get(P))
        return ok({ full_name: fullName, default_branch: r.default_branch, private: r.visibility !== 'public', html_url: r.web_url, allow_auto_merge: true, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: false })
      },
      getBranch: async (p: Params): Answer => {
        const b = z.object({ name: z.string(), protected: z.boolean().optional(), commit: z.object({ id: z.string() }).loose() }).loose().parse(await get(`${P}/repository/branches/${q(String(p.branch))}`))
        return ok({ name: b.name, protected: b.protected ?? false, commit: { sha: b.commit.id } })
      },
      getCommit: async (p: Params): Answer => {
        const C = z.object({ id: z.string(), message: z.string(), author_name: z.string().optional(), authored_date: z.string().optional(), committed_date: z.string().optional(), parent_ids: z.array(z.string()).default([]) }).loose()
        const c = C.parse(await get(`${P}/repository/commits/${q(String(p.ref))}`))
        return ok({ sha: c.id, commit: { message: c.message, author: { name: c.author_name ?? '', date: c.authored_date ?? '' }, committer: { date: c.committed_date ?? '' } }, parents: c.parent_ids.map((sha) => ({ sha })) })
      },
      compareCommits: async (p: Params): Answer => {
        const from = String(p.base)
        const to = String(p.head).split(':').at(-1) ?? ''
        const Cmp = z.object({ commits: z.array(z.object({ id: z.string(), message: z.string().optional() }).loose()).default([]), diffs: z.array(z.object({ new_path: z.string() }).loose()).default([]) }).loose()
        const [ahead, behind] = await Promise.all([
          get(`${P}/repository/compare?from=${q(from)}&to=${q(to)}&straight=false`).then((j) => Cmp.parse(j)),
          get(`${P}/repository/compare?from=${q(to)}&to=${q(from)}&straight=false`).then((j) => Cmp.parse(j)),
        ])
        const a = ahead.commits.length
        const b = behind.commits.length
        const status = a && b ? 'diverged' : a ? 'ahead' : b ? 'behind' : 'identical'
        return ok({ status, ahead_by: a, behind_by: b, total_commits: a, commits: ahead.commits.map((c) => ({ sha: c.id, commit: { message: c.message ?? '' } })), files: ahead.diffs.map((d) => ({ filename: d.new_path })) })
      },
      merge: async (_p?: Params): Answer => { throw new ForgeRefusal(501, 'GitLab cannot merge one branch into another outside a merge request through its API: trace merges with git on GitLab') },
      getContent: async (p: Params): Answer => {
        const ref = typeof p.ref === 'string' ? `?ref=${q(p.ref)}` : ''
        const F = z.object({ file_name: z.string(), file_path: z.string(), size: z.number(), encoding: z.string(), content: z.string(), blob_id: z.string() }).loose()
        const file = F.parse(await get(`${P}/repository/files/${q(String(p.path))}${ref || `?ref=HEAD`}`))
        return ok({ type: 'file', name: file.file_name, path: file.file_path, size: file.size, encoding: file.encoding, content: file.content, sha: file.blob_id })
      },
      getCollaboratorPermissionLevel: async (p: Params): Answer => {
        const id = await userId(String(p.username))
        if (id === null) return ok({ permission: 'none', user: { login: p.username } })
        try {
          const m = z.object({ access_level: z.number() }).loose().parse(await get(`${P}/members/all/${id}`))
          const permission = m.access_level >= 50 ? 'admin' : m.access_level >= 40 ? 'maintain' : m.access_level >= 30 ? 'write' : m.access_level >= 10 ? 'read' : 'none'
          return ok({ permission, user: { login: p.username } })
        } catch (e) {
          if (e instanceof ForgeRefusal && e.status === 404) return ok({ permission: 'none', user: { login: p.username } })
          throw e
        }
      },
    },
    users: {
      getByUsername: async (p: Params): Answer => {
        const [u] = z.array(z.object({ id: z.number(), username: z.string(), bot: z.boolean().optional() }).loose()).parse(await get(`/users?username=${q(String(p.username))}`))
        if (!u) throw new ForgeRefusal(404, `GitLab: no user ${String(p.username)}`)
        return ok({ id: u.id, login: u.username, type: u.bot || /^project_\d+_bot/.test(u.username) ? 'Bot' : 'User' })
      },
    },
    git: {
      getBlob: async (p: Params): Answer => {
        const B = z.object({ size: z.number(), encoding: z.string(), content: z.string(), sha: z.string() }).loose()
        const b = B.parse(await get(`${P}/repository/blobs/${q(String(p.file_sha))}`))
        return ok({ sha: b.sha, size: b.size, encoding: b.encoding, content: b.content })
      },
    },
    checks: {
      listForRef: async (p: Params): Answer => {
        const [pl] = z.array(Pipeline).parse(await get(`${P}/pipelines?sha=${q(String(p.ref))}&order_by=id&sort=desc&per_page=1`))
        if (!pl) return ok({ total_count: 0, check_runs: [] })
        const jobs = z.array(Job).parse(await get(`${P}/pipelines/${pl.id}/jobs?include_retried=false&per_page=100`))
        const runs = jobs.map((j) => ({ id: j.id, name: j.name, ...runState(j.status), started_at: j.started_at ?? null, completed_at: j.finished_at ?? null, html_url: j.web_url ?? pl.web_url, head_sha: pl.sha ?? '' }))
        return ok({ total_count: runs.length, check_runs: runs })
      },
    },
    actions: {
      listWorkflowRuns: async (p: Params): Answer => {
        const name = typeof p.workflow_id === 'string' ? p.workflow_id.replace(/\.ya?ml$/, '') : null
        const ref = typeof p.branch === 'string' ? `&ref=${q(p.branch)}` : ''
        const list = z.array(Pipeline).parse(await get(`${P}/pipelines?order_by=id&sort=desc${ref}&per_page=100`)).filter((x) => !name || x.name === name)
        const runs = list.slice(0, Number(p.per_page ?? 30)).map((x) => ({
          id: x.id, name: x.name ?? '', ...runState(x.status), head_branch: x.ref ?? null, head_sha: x.sha ?? '', html_url: x.web_url,
          created_at: x.created_at, updated_at: x.updated_at ?? x.created_at, event: x.source ?? 'push', run_attempt: 1,
        }))
        const wanted = typeof p.status === 'string' ? runs.filter((r) => r.status === p.status || r.conclusion === p.status) : runs
        return ok({ total_count: wanted.length, workflow_runs: wanted })
      },
      listJobsForWorkflowRunAttempt: async (p: Params): Answer => {
        const jobs = z.array(Job).parse(await get(`${P}/pipelines/${Number(p.run_id)}/jobs?include_retried=false&per_page=100`))
        return ok({ total_count: jobs.length, jobs: jobs.map((j) => ({ id: j.id, name: j.name, ...runState(j.status), started_at: j.started_at ?? null, completed_at: j.finished_at ?? null, html_url: j.web_url ?? '', steps: [] })) })
      },
      reRunWorkflowFailedJobs: async (p: Params): Answer => {
        await call('POST', `${P}/pipelines/${Number(p.run_id)}/retry`)
        return ok({}, 201)
      },
      createWorkflowDispatch: async (p: Params): Answer => {
        const inputs = (p.inputs ?? {}) as Record<string, string>
        const variables = [
          { key: 'TRACE_WORKFLOW', value: String(p.workflow_id).replace(/\.ya?ml$/, '') },
          ...Object.entries(inputs).map(([k, value]) => ({ key: `TRACE_INPUT_${k.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`, value: String(value) })),
        ]
        await call('POST', `${P}/pipeline`, { ref: p.ref, variables })
        return ok(null, 204)
      },
    },
  }

  /** Octokit's paginate: every page of a listing call, flattened (the first array a non-array answer carries). */
  const paginate = async <T>(fn: (p: Params) => Answer, params: Params = {}): Promise<T[]> => {
    const out: T[] = []
    for (let n = 1; n <= 50; n++) {
      const { data } = await fn({ ...params, per_page: 100, page: n })
      const items = (Array.isArray(data) ? data : Object.values(data as Record<string, unknown>).find(Array.isArray) ?? []) as T[]
      out.push(...items)
      if (items.length < 100) break
    }
    return out
  }

  const request = async (route: string): Answer => { throw new ForgeRefusal(501, `GitLab has no equivalent of GitHub's ${route}`) }

  return { rest, paginate, request, knownMergeRequests: mrs }
}

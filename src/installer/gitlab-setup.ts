/**
 * Setting trace's GitLab up for its projects (docs/gitlab-projects.md "Two identities"), with the admin token the
 * instance made (`<prefix>/gitlab/admin-token`). Every call is safe to repeat: a second run finds what the first made
 * and brings it in line.
 *
 *   group      `<prefix>`: every project of the installation lives in it, private
 *   project    `<prefix>/<slug>`: merge commits, pipelines must pass, source branches removed on merge
 *   branch     its default branch protected: no one pushes, Maintainers merge. trace's API holds the admin token and
 *              is the only Maintainer that merges; the agents' token is a Developer's, which may push branches and
 *              open merge requests but never update the default branch
 *   agents     a project access token, Developer role, `api` and `write_repository`, one per project (its own bot
 *              user, so an agent's token reaches its own project and no other). GitLab's shortest life is a day: the
 *              broker rotates it (a later layer); here it is made, and its bot's username returned for
 *              TRACE_AGENT_LOGIN
 *   hook       a webhook on the project to trace's hooks endpoint, with its secret token (group webhooks are a
 *              Premium feature: one per project, as on GitHub)
 *   labels     the labels trace's harness uses
 *
 * Everything here is in GitLab Community Edition.
 */
import { z } from 'zod'

/** GitLab's role levels. */
export const ACCESS = { none: 0, developer: 30, maintainer: 40 } as const

/** The labels trace's harness and app use on changes and issues (src/harness, src/api). */
export const TRACE_LABELS: readonly { name: string; color: string; description: string }[] = [
  { name: 'trace', color: '#534AB7', description: 'opened by trace' },
  { name: 'hold', color: '#A32D2D', description: 'trace will not merge this until a person lets it' },
  { name: 'agent-fix', color: '#854F0B', description: 'for an agent to fix' },
  { name: 'ci-red', color: '#E24B4A', description: 'the default branch is failing its checks' },
]

export class GitlabSetupError extends Error {
  override name = 'GitlabSetupError'
  constructor(readonly status: number, message: string) { super(message) }
}

export interface ProjectSetup {
  /** the project's path, `<group>/<slug>` */
  path: string
  /** its numeric id */
  id: number
  defaultBranch: string
  /** the agents' token (only when one was made on this run) and its bot's username */
  agentToken: string | null
  agentLogin: string
  lines: string[]
}

export class GitlabAdmin {
  private readonly base: string
  private readonly fetch: typeof fetch

  constructor(private readonly token: string, o: { url: string; fetch?: typeof fetch }) {
    this.base = `${o.url.replace(/\/+$/, '')}/api/v4`
    this.fetch = o.fetch ?? fetch
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const r = await this.fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
    const json = r.status === 204 ? null : await r.json().catch(() => null)
    return { status: r.status, json }
  }

  private async ok(method: string, path: string, body?: unknown): Promise<unknown> {
    const r = await this.call(method, path, body)
    if (r.status >= 200 && r.status < 300) return r.json
    const said = z.object({ message: z.unknown() }).loose().safeParse(r.json)
    throw new GitlabSetupError(r.status, `GitLab ${method} ${path.split('?')[0]}: ${r.status}${said.success ? ` (${JSON.stringify(said.data.message)})` : ''}`)
  }

  /** The installation's group, made private when missing. */
  async ensureGroup(path: string): Promise<{ id: number; made: boolean }> {
    const G = z.object({ id: z.number() }).loose()
    const had = await this.call('GET', `/groups/${encodeURIComponent(path)}`)
    if (had.status === 200) return { id: G.parse(had.json).id, made: false }
    if (had.status !== 404) throw new GitlabSetupError(had.status, `GitLab GET group: ${had.status}`)
    const g = G.parse(await this.ok('POST', '/groups', { name: `trace ${path}`, path, visibility: 'private', project_creation_level: 'maintainer', subgroup_creation_level: 'owner' }))
    return { id: g.id, made: true }
  }

  /** A project in the group, made empty (its default branch `branch`) when missing. */
  async ensureProject(groupId: number, groupPath: string, slug: string, branch: string): Promise<{ id: number; path: string; defaultBranch: string; made: boolean }> {
    const P = z.object({ id: z.number(), path_with_namespace: z.string(), default_branch: z.string().nullable().optional() }).loose()
    const path = `${groupPath}/${slug}`
    const had = await this.call('GET', `/projects/${encodeURIComponent(path)}`)
    if (had.status === 200) {
      const p = P.parse(had.json)
      return { id: p.id, path: p.path_with_namespace, defaultBranch: p.default_branch || branch, made: false }
    }
    if (had.status !== 404) throw new GitlabSetupError(had.status, `GitLab GET project: ${had.status}`)
    const p = P.parse(await this.ok('POST', '/projects', {
      name: slug, path: slug, namespace_id: groupId, visibility: 'private', default_branch: branch, initialize_with_readme: false,
    }))
    return { id: p.id, path: p.path_with_namespace, defaultBranch: p.default_branch || branch, made: true }
  }

  /** The project's settings trace's loop needs. */
  async applySettings(projectId: number): Promise<void> {
    await this.ok('PUT', `/projects/${projectId}`, {
      merge_method: 'merge', squash_option: 'default_off', only_allow_merge_if_pipeline_succeeds: true,
      remove_source_branch_after_merge: true, auto_cancel_pending_pipelines: 'enabled', ci_forward_deployment_enabled: true,
      // the agents never force-push a branch others build on (docs/stacked-changes.md); stacks merge bottom first
      only_allow_merge_if_all_discussions_are_resolved: false,
    })
  }

  /** The default branch: no one pushes, Maintainers (trace's API) merge, no force push. Replaces any other rule for it. */
  async protectDefaultBranch(projectId: number, branch: string): Promise<void> {
    const had = await this.call('GET', `/projects/${projectId}/protected_branches/${encodeURIComponent(branch)}`)
    if (had.status === 200) await this.ok('DELETE', `/projects/${projectId}/protected_branches/${encodeURIComponent(branch)}`)
    await this.ok('POST', `/projects/${projectId}/protected_branches`, {
      name: branch, push_access_level: ACCESS.none, merge_access_level: ACCESS.maintainer, unprotect_access_level: ACCESS.maintainer, allow_force_push: false,
    })
  }

  /**
   * The agents' project access token: kept when one named `trace-agents` is still active (its value is not readable
   * again, so `token` is null: the broker has it), made when there is none. Developer role; a day's life, the
   * shortest GitLab allows, so the broker's rotation is what keeps it alive.
   */
  async ensureAgentToken(projectId: number, today: Date = new Date()): Promise<{ token: string | null; login: string; id: number }> {
    const T = z.object({ id: z.number(), name: z.string(), active: z.boolean(), revoked: z.boolean().optional(), user_id: z.number() }).loose()
    const list = z.array(T).parse(await this.ok('GET', `/projects/${projectId}/access_tokens?per_page=100`))
    const live = list.find((t) => t.name === 'trace-agents' && t.active && !t.revoked)
    const login = async (userId: number): Promise<string> => z.object({ username: z.string() }).loose().parse(await this.ok('GET', `/users/${userId}`)).username
    if (live) return { token: null, login: await login(live.user_id), id: live.id }
    const expires = new Date(today.getTime() + 2 * 86_400_000).toISOString().slice(0, 10)
    const made = T.extend({ token: z.string() }).parse(await this.ok('POST', `/projects/${projectId}/access_tokens`, {
      name: 'trace-agents', scopes: ['api', 'write_repository'], access_level: ACCESS.developer, expires_at: expires,
    }))
    return { token: made.token, login: await login(made.user_id), id: made.id }
  }

  /** A project variable, made or updated; masked and protected unless said otherwise. */
  async setVariable(projectId: number, key: string, value: string, o: { masked?: boolean; protect?: boolean } = {}): Promise<void> {
    const body = { key, value, masked: o.masked ?? false, protected: o.protect ?? false, raw: true }
    const had = await this.call('GET', `/projects/${projectId}/variables/${encodeURIComponent(key)}`)
    if (had.status === 200) await this.ok('PUT', `/projects/${projectId}/variables/${encodeURIComponent(key)}`, body)
    else await this.ok('POST', `/projects/${projectId}/variables`, body)
  }

  /** trace's webhook on the project, made or updated in place (one per address). */
  async ensureHook(projectId: number, url: string, secret: string): Promise<{ made: boolean }> {
    const H = z.object({ id: z.number(), url: z.string() }).loose()
    const hooks = z.array(H).parse(await this.ok('GET', `/projects/${projectId}/hooks?per_page=100`))
    const body = {
      url, token: secret, enable_ssl_verification: true, push_events: true, merge_requests_events: true, pipeline_events: true,
      job_events: true, note_events: true, deployment_events: true, issues_events: true, tag_push_events: false,
    }
    const had = hooks.find((h) => h.url === url)
    if (had) { await this.ok('PUT', `/projects/${projectId}/hooks/${had.id}`, body); return { made: false } }
    await this.ok('POST', `/projects/${projectId}/hooks`, body)
    return { made: true }
  }

  /**
   * The project's `.gitlab-ci.yml` (src/core/gitlab-ci.ts): committed straight to `branch` while the project is empty
   * (its first commit makes the branch, before it is protected); on a project with history, left as it is when it
   * matches, else proposed as a merge request trace's API merges once its pipeline passes (no one pushes to a
   * protected default branch, the admin included).
   */
  async ensureCiFile(projectId: number, branch: string, content: string): Promise<'committed' | 'unchanged' | 'proposed'> {
    const file = '.gitlab-ci.yml'
    const head = await this.call('GET', `/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`)
    const actions = (action: 'create' | 'update') => [{ action, file_path: file, content }]
    if (head.status === 404) {
      await this.ok('POST', `/projects/${projectId}/repository/commits`, { branch, commit_message: 'trace: pipelines', actions: actions('create') })
      return 'committed'
    }
    const had = await this.call('GET', `/projects/${projectId}/repository/files/${encodeURIComponent(file)}?ref=${encodeURIComponent(branch)}`)
    const now = had.status === 200 ? Buffer.from(z.object({ content: z.string() }).loose().parse(had.json).content, 'base64').toString('utf8') : null
    if (now === content) return 'unchanged'
    const work = 'trace/pipelines'
    await this.call('DELETE', `/projects/${projectId}/repository/branches/${encodeURIComponent(work)}`)
    await this.ok('POST', `/projects/${projectId}/repository/commits`, { branch: work, start_branch: branch, commit_message: 'trace: pipelines', actions: actions(now === null ? 'create' : 'update') })
    const open = z.array(z.object({ iid: z.number() }).loose()).parse(await this.ok('GET', `/projects/${projectId}/merge_requests?state=opened&source_branch=${encodeURIComponent(work)}`))
    if (!open.length) {
      await this.ok('POST', `/projects/${projectId}/merge_requests`, {
        source_branch: work, target_branch: branch, title: 'trace: pipelines', labels: 'trace', remove_source_branch: true,
        description: 'trace\'s pipelines for this project (templates/gitlab/trace.gitlab-ci.yml). trace merges this once its pipeline passes.',
      })
    }
    return 'proposed'
  }

  /** The update queue's safety net: a schedule twice an hour on the default branch (as GitHub's trace-prs has). */
  async ensureSchedule(projectId: number, branch: string): Promise<{ made: boolean }> {
    const S = z.object({ id: z.number(), description: z.string() }).loose()
    const description = 'trace update-queue (safety net)'
    const had = z.array(S).parse(await this.ok('GET', `/projects/${projectId}/pipeline_schedules?per_page=100`)).find((x) => x.description === description)
    const body = { description, ref: branch, cron: '17,47 * * * *', cron_timezone: 'UTC', active: true }
    if (had) { await this.ok('PUT', `/projects/${projectId}/pipeline_schedules/${had.id}`, body); return { made: false } }
    await this.ok('POST', `/projects/${projectId}/pipeline_schedules`, body)
    return { made: true }
  }

  /** trace's labels on the project, made when missing. */
  async ensureLabels(projectId: number): Promise<string[]> {
    const L = z.object({ name: z.string() }).loose()
    const have = new Set(z.array(L).parse(await this.ok('GET', `/projects/${projectId}/labels?per_page=100`)).map((l) => l.name))
    const made: string[] = []
    for (const l of TRACE_LABELS) {
      if (have.has(l.name)) continue
      await this.ok('POST', `/projects/${projectId}/labels`, l)
      made.push(l.name)
    }
    return made
  }
}

/**
 * One project, set up from end to end: group, project, settings, protected branch, labels, the agents' token and its
 * login as TRACE_AGENT_LOGIN, and (when trace's hooks endpoint is known) its webhook.
 */
export async function setUpGitlabProject(admin: GitlabAdmin, o: { group: string; slug: string; branch: string; hook?: { url: string; secret: string } | undefined; ci?: string | undefined }): Promise<ProjectSetup> {
  const lines: string[] = []
  const g = await admin.ensureGroup(o.group)
  if (g.made) lines.push(`made the group ${o.group}`)
  const p = await admin.ensureProject(g.id, o.group, o.slug, o.branch)
  lines.push(p.made ? `made ${p.path}` : `${p.path} is there`)
  await admin.applySettings(p.id)
  // its pipelines first: an empty project's first commit makes its default branch, which is then protected
  if (o.ci) {
    const c = await admin.ensureCiFile(p.id, p.defaultBranch, o.ci)
    lines.push(c === 'committed' ? '.gitlab-ci.yml committed' : c === 'unchanged' ? '.gitlab-ci.yml is current' : '.gitlab-ci.yml proposed (trace/pipelines): trace merges it once its pipeline passes')
  }
  await admin.protectDefaultBranch(p.id, p.defaultBranch)
  lines.push(`${p.defaultBranch} protected: no one pushes, trace's API merges`)
  const labels = await admin.ensureLabels(p.id)
  if (labels.length) lines.push(`labels made: ${labels.join(', ')}`)
  const t = await admin.ensureAgentToken(p.id)
  lines.push(t.token ? `the agents' token made (${t.login}, Developer)` : `the agents' token is there (${t.login})`)
  await admin.setVariable(p.id, 'TRACE_AGENT_LOGIN', t.login)
  if (o.hook) {
    const h = await admin.ensureHook(p.id, o.hook.url, o.hook.secret)
    lines.push(h.made ? 'trace\'s webhook added' : 'trace\'s webhook updated')
  }
  if (o.ci) {
    const sch = await admin.ensureSchedule(p.id, p.defaultBranch)
    if (sch.made) lines.push('the update queue\'s schedule made (twice an hour)')
  }
  return { path: p.path, id: p.id, defaultBranch: p.defaultBranch, agentToken: t.token, agentLogin: t.login, lines }
}

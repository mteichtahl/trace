/**
 * The installer's GitLab step (docs/gitlab-projects.md): after the deploy made trace's own GitLab (src/infra/gitlab.ts),
 * wait until it is really there. Its instance installs GitLab at first start (10–20 minutes), then writes trace's admin
 * token into `<prefix>/gitlab/admin-token`; the step is done when that token is there and GitLab answers its own
 * health check through CloudFront with it.
 *
 * A timer, as the GPU image's is (the installer runs on the person's computer, which AWS cannot send the instance's
 * events to): every 30 s, at most 40 minutes, on the record with when it checks next, and Check now checks at once.
 * Nothing waits on GitLab yet (projects stay on GitHub until they are moved), so a timeout is reported, not a failure of
 * the installation.
 */
import { z } from 'zod'
import { type Check, type WaitNotice, waitWithTimer } from '../core/wait.js'

export const GITLAB_WAIT_WHY = 'GitLab installs itself on its instance at first start, and the installer runs on your computer, where AWS cannot send it the instance\'s events'

/** The token in `<prefix>/gitlab/admin-token`: `{ "token": "…" }`, or null while it is the stack's placeholder. */
export function adminToken(secret: string | null | undefined): string | null {
  const raw = (secret ?? '').trim()
  if (!raw || raw === 'pending') return null
  try {
    const p = z.object({ token: z.string().min(1) }).loose().safeParse(JSON.parse(raw))
    return p.success ? p.data.token : null
  } catch {
    return raw
  }
}

export interface GitlabWait {
  /** GitLab's address, https://… (the stack's GitlabUrl output) */
  url: string
  /** the admin token secret's current value, or null when it cannot be read yet */
  readSecret: () => Promise<string | null>
  fetch?: typeof fetch
  log?: (line: string) => void
  report?: (n: WaitNotice) => void
  signal?: AbortSignal
  pollMs?: number
  timeoutMs?: number
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Wait until GitLab is installed, has made trace's token, and answers through its address with it. */
export async function waitForGitlab(o: GitlabWait): Promise<{ ok: boolean; detail: string }> {
  const base = o.url.replace(/\/+$/, '')
  if (!/^https:\/\//.test(base)) return { ok: false, detail: `no GitLab address to wait for (${o.url || 'none'})` }
  const f = o.fetch ?? fetch
  const now = o.now ?? Date.now
  const look = async (): Promise<Check<{ ok: boolean; detail: string }>> => {
    const token = adminToken(await o.readSecret().catch(() => null))
    if (!token) return { done: false, state: 'installing' }
    let r: Response
    try {
      r = await f(`${base}/api/v4/version`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
    } catch {
      // the token is there but the address does not answer yet: CloudFront still deploying, or a custom domain whose
      // DNS does not point at it yet
      return { done: false, state: 'unreachable' }
    }
    if (r.status === 401 || r.status === 403) return { done: true, value: { ok: false, detail: `GitLab at ${base} refused trace's admin token (${r.status}): the token in Secrets Manager does not match GitLab's` }, state: 'refused' }
    if (!r.ok) return { done: false, state: `answering ${r.status}` }
    const v = z.object({ version: z.string() }).loose().safeParse(await r.json().catch(() => null))
    return { done: true, value: { ok: true, detail: `GitLab ${v.success ? v.data.version : ''} is up at ${base}`.replace('  ', ' ') }, state: 'up' }
  }
  const r = await waitWithTimer({
    what: `trace's GitLab at ${base} to start`, why: GITLAB_WAIT_WHY, check: look,
    intervalMs: Math.max(o.pollMs ?? 30_000, 1), deadlineAt: now() + (o.timeoutMs ?? 40 * 60_000), now,
    ...(o.report ? { report: o.report } : {}), ...(o.signal ? { signal: o.signal } : {}), ...(o.sleep ? { sleep: o.sleep } : {}),
  })
  if (r.done) return r.value
  const where = r.state === 'unreachable' ? `its token is made but ${base} does not answer yet (a custom domain's DNS must point at CloudFront)` : r.state === 'installing' ? 'it is still installing itself' : `it last said "${r.state ?? 'nothing'}"`
  return { ok: false, detail: r.reason === 'aborted' ? `stopped waiting for GitLab; it carries on, and the next installer run checks it` : `GitLab is not up yet: ${where}. Run the installer again later to check it` }
}

/** What a person does, once, so CodeBuild can reach trace's GitLab (docs/gitlab-projects.md, build step 5). */
export const gitlabConnectionTodo = (consoleUrl: string, name: string): string =>
  `CodeBuild needs a one-time set-up to reach trace's GitLab. Open ${consoleUrl}: on the Hosts tab choose ${name}, then "Set up host", and give it a GitLab personal access token of the root user with the api and admin_mode scopes only (made in GitLab under your avatar > Edit profile > Access tokens; the root password is in Secrets Manager). Then on the Connections tab choose ${name} and "Update pending connection". The installer carries on by itself once both are available.`

export interface GitlabConnectionWait {
  /** the host's and the connection's status now (CodeConnections GetHost, GetConnection) */
  read: () => Promise<{ host: string; connection: string }>
  consoleUrl: string
  name: string
  report: (line: string) => void
  onWait?: (n: WaitNotice) => void
  pollMs?: number
  timeoutMs?: number
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Whether both are set up. */
export const gitlabConnectionReady = (s: { host: string; connection: string }): boolean => s.host === 'AVAILABLE' && s.connection === 'AVAILABLE'

/**
 * Wait until a person has set up the host and the connection (both AVAILABLE): every 30 s, at most 30 minutes, with
 * Check now. Answers whether they are; says once what to do. A host or connection in ERROR stops at once.
 */
export async function waitForGitlabConnection(o: GitlabConnectionWait): Promise<{ ok: boolean; detail: string }> {
  const now = o.now ?? Date.now
  let told = false
  const r = await waitWithTimer<{ ok: boolean; detail: string }>({
    what: `${o.name} (CodeBuild's way into trace's GitLab) to be set up`,
    why: 'AWS sends no event when a person sets up a host or a connection',
    intervalMs: Math.max(o.pollMs ?? 30_000, 1), deadlineAt: now() + (o.timeoutMs ?? 30 * 60_000), now,
    ...(o.sleep ? { sleep: o.sleep } : {}),
    check: async () => {
      const s = await o.read()
      if (gitlabConnectionReady(s)) return { done: true, value: { ok: true, detail: `${o.name} is set up: GitLab projects get their build runners` }, state: 'AVAILABLE' }
      if (s.host === 'ERROR' || s.connection === 'ERROR') return { done: true, value: { ok: false, detail: `${o.name} is in status ERROR (host ${s.host}, connection ${s.connection}): delete it at ${o.consoleUrl} and run the installer again` }, state: 'ERROR' }
      if (!told) { o.report(gitlabConnectionTodo(o.consoleUrl, o.name)); told = true }
      return { done: false, state: `host ${s.host || 'unknown'}, connection ${s.connection || 'unknown'}` }
    },
    report: (n) => o.onWait?.(n),
  })
  if (r.done) return r.value
  return { ok: false, detail: `${o.name} is not set up yet, so GitLab projects have no build runners. ${gitlabConnectionTodo(o.consoleUrl, o.name)} Then run the installer again` }
}

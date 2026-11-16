/**
 * Keeping the agents' GitLab tokens alive (docs/gitlab-projects.md "Two identities"). Each project on trace's GitLab
 * has one `trace-agents` project access token (Developer role, its own bot user: src/installer/gitlab-setup.ts). GitLab
 * tokens expire; this rotates each one before it does and keeps its current value in Secrets Manager, at
 * `<prefix>/gitlab/agents/<slug>`, where only that project's roles may read it (granted with the project's roles).
 *
 * Rotation, not a new token: GitLab's rotate keeps the same bot user, so the project's TRACE_AGENT_LOGIN (how trace
 * tells its agents' changes from people's) never changes. Rotating revokes the old value at once, so callers read the
 * secret again and retry once when GitLab answers 401.
 *
 * Each token lives TOKEN_DAYS and is rotated once fewer than ROTATE_BEFORE_DAYS remain: run twice a day, every token is
 * rotated about once a day and never comes near its end. A token with no stored value (the installer just made it,
 * and GitLab never shows a value twice) is rotated at once, so its value is stored.
 */
import { z } from 'zod'

export const TOKEN_NAME = 'trace-agents'
export const TOKEN_DAYS = 3
export const ROTATE_BEFORE_DAYS = 2
/** keyed by the project's path within the group (its repository's name: src/core/gitlab-path.ts gitlabAgentSecret) */
export const agentTokenSecretName = (prefix: string, name: string): string => `${prefix}/gitlab/agents/${name}`

/** What the secret holds. */
export const StoredToken = z.object({ token: z.string().min(1), expiresAt: z.string(), login: z.string(), project: z.string() })
export type StoredToken = z.infer<typeof StoredToken>

export function parseStored(text: string | null | undefined): StoredToken | null {
  if (!text) return null
  try { const r = StoredToken.safeParse(JSON.parse(text)); return r.success ? r.data : null } catch { return null }
}

export interface RotationDeps {
  /** GitLab's address, https://… */
  url: string
  /** the admin token */
  adminToken: string
  /** the installation's group (its prefix) */
  group: string
  /** the stored value for a project's slug, or null */
  read: (slug: string) => Promise<string | null>
  /** store a project's new value */
  write: (slug: string, value: StoredToken) => Promise<void>
  fetch?: typeof fetch
  now?: () => number
}

export interface RotationReport { project: string; outcome: 'rotated' | 'fresh' | 'no-token' | 'failed'; detail?: string }

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** Rotate every project's agents' token that needs it; one project failing never stops the others. */
export async function rotateAgentTokens(d: RotationDeps): Promise<RotationReport[]> {
  const f = d.fetch ?? fetch
  const now = (d.now ?? Date.now)()
  const base = `${d.url.replace(/\/+$/, '')}/api/v4`
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const r = await f(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${d.adminToken}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    })
    if (!r.ok) throw new Error(`GitLab ${method} ${path.split('?')[0]}: ${r.status}`)
    return r.json()
  }
  const P = z.object({ id: z.number(), path: z.string(), path_with_namespace: z.string(), archived: z.boolean().optional() }).loose()
  const T = z.object({ id: z.number(), name: z.string(), active: z.boolean(), revoked: z.boolean().optional(), expires_at: z.string().nullable().optional(), user_id: z.number() }).loose()
  const projects = z.array(P).parse(await call('GET', `/groups/${encodeURIComponent(d.group)}/projects?per_page=100&include_subgroups=false&archived=false`))
  const out: RotationReport[] = []
  for (const p of projects) {
    if (p.archived) continue
    try {
      const tokens = z.array(T).parse(await call('GET', `/projects/${p.id}/access_tokens?per_page=100`))
      const t = tokens.find((x) => x.name === TOKEN_NAME && x.active && !x.revoked)
      if (!t) { out.push({ project: p.path_with_namespace, outcome: 'no-token', detail: 'the installer makes it' }); continue }
      const stored = parseStored(await d.read(p.path))
      const ends = t.expires_at ? Date.parse(`${t.expires_at}T00:00:00Z`) : Number.POSITIVE_INFINITY
      if (stored && ends - now > ROTATE_BEFORE_DAYS * 86_400_000) { out.push({ project: p.path_with_namespace, outcome: 'fresh' }); continue }
      const expiresAt = isoDay(now + TOKEN_DAYS * 86_400_000)
      const rotated = T.extend({ token: z.string() }).parse(await call('POST', `/projects/${p.id}/access_tokens/${t.id}/rotate`, { expires_at: expiresAt }))
      const login = z.object({ username: z.string() }).loose().parse(await call('GET', `/users/${rotated.user_id}`)).username
      await d.write(p.path, { token: rotated.token, expiresAt, login, project: p.path_with_namespace })
      out.push({ project: p.path_with_namespace, outcome: 'rotated', detail: `until ${expiresAt}` })
    } catch (e) {
      out.push({ project: p.path_with_namespace, outcome: 'failed', detail: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

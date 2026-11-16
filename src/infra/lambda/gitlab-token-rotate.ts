/**
 * Rotates the agents' GitLab tokens twice a day (src/core/gitlab-token.ts rotateAgentTokens) and keeps each current
 * value at `<prefix>/gitlab/agents/<slug>`. Made with trace's GitLab (src/infra/gitlab.ts). A token is never logged:
 * each run logs one line per project, its outcome only.
 */
import { CreateSecretCommand, GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { type RotationReport, type StoredToken, agentTokenSecretName, rotateAgentTokens } from '../../core/gitlab-token.js'

const notFound = (e: unknown): boolean => (e as { name?: string }).name === 'ResourceNotFoundException'

export interface Store {
  read: (name: string) => Promise<string | null>
  write: (name: string, value: string) => Promise<void>
}

/** Secrets Manager as the store: a missing secret reads as null and is made on first write. */
export function secretsStore(sm: Pick<SecretsManagerClient, 'send'>, prefix: string): Store {
  return {
    read: async (name) => {
      try { return (await sm.send(new GetSecretValueCommand({ SecretId: name }))).SecretString ?? null } catch (e) { if (notFound(e)) return null; throw e }
    },
    write: async (name, value) => {
      try {
        await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }))
      } catch (e) {
        if (!notFound(e)) throw e
        await sm.send(new CreateSecretCommand({
          Name: name, SecretString: value, Description: 'trace: the agents\' GitLab token for one project (rotated twice a day)',
          Tags: [{ Key: 'trace:installation', Value: prefix }],
        }))
      }
    },
  }
}

export async function run(o: { prefix: string; url: string; adminSecret: string; store: Store; fetch?: typeof fetch; log?: (l: Record<string, unknown>) => void }): Promise<RotationReport[]> {
  const log = o.log ?? ((l) => console.log(JSON.stringify(l)))
  const raw = await o.store.read(o.adminSecret)
  let admin: string | null = null
  try { admin = (JSON.parse(raw ?? '') as { token?: string }).token ?? null } catch { admin = raw && raw !== 'pending' ? raw : null }
  if (!admin) { log({ outcome: 'skipped', reason: 'GitLab has not made trace\'s admin token yet' }); return [] }
  const reports = await rotateAgentTokens({
    url: o.url, adminToken: admin, group: o.prefix,
    read: (slug) => o.store.read(agentTokenSecretName(o.prefix, slug)),
    write: (slug, value: StoredToken) => o.store.write(agentTokenSecretName(o.prefix, slug), JSON.stringify(value)),
    ...(o.fetch ? { fetch: o.fetch } : {}),
  })
  for (const r of reports) log({ ...r })
  if (reports.some((r) => r.outcome === 'failed')) throw new Error(`could not rotate: ${reports.filter((r) => r.outcome === 'failed').map((r) => r.project).join(', ')}`)
  return reports
}

let sm: SecretsManagerClient | null = null
export const handler = async (): Promise<{ rotated: number }> => {
  const env = process.env
  const prefix = env.TRACE_PREFIX ?? ''
  const reports = await run({ prefix, url: env.TRACE_GITLAB_URL ?? '', adminSecret: env.TRACE_GITLAB_ADMIN_SECRET ?? '', store: secretsStore(sm ??= new SecretsManagerClient({}), prefix) })
  return { rotated: reports.filter((r) => r.outcome === 'rotated').length }
}

/**
 * Live updates from GitHub, the installer's part (docs/guided-flow.md "Live updates", src/web/hooks.ts):
 *
 *   secret    `<prefix>/web/github-hooks` in Secrets Manager, JSON { webhookSecret, clientSecret }: made when missing
 *             with a new random webhook secret, which is then kept (every repository's hook is registered with it,
 *             so changing it would break the ones this run cannot reach); the backend's own app client's secret
 *             (`<prefix>-web-hooks`, read from Cognito) written beside it on every run, so a client made again by a
 *             deploy is picked up. The stack never holds either value
 *   register  on every project repository, one webhook to the app's address (CloudFront's own, the stack's
 *             WebHooksAddress output) + /api/hooks/github, JSON, the four events the backend takes, active. Found by
 *             its exact URL and updated in place (its secret, events and content type set again), else created: a
 *             second run changes nothing it should not and never adds a second hook. A repository it cannot register
 *             on (the token lacks admin, or "Webhooks: read and write") is a warning, never a failed install: that
 *             project's screens look again every 60 s instead
 *
 * Run by the installer (and so `tracectl upgrade`) at its web step, and by the self-update for the projects it adds
 * (src/installer/update.ts), with the secret it may read.
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { HOOK_EVENTS } from '../web/hooks.js'
import { Github, GithubError } from './github.js'

export { HOOK_EVENTS }

const Stored = z.object({ webhookSecret: z.string().min(16), clientSecret: z.string().optional() }).loose()
export type HooksSecretValue = z.output<typeof Stored>

/** Secrets Manager, as the hooks secret needs it (tests replace it). */
export interface HooksSecretIo {
  /** the secret's string, or null when there is no such secret */
  read(name: string): Promise<string | null>
  create(name: string, value: string, description: string): Promise<void>
  put(name: string, value: string): Promise<void>
}

/**
 * Make the secret when it is missing, keep its webhook secret when it is there (one that does not parse is made
 * again), and write the backend's client secret into it when given and different. Returns the webhook secret.
 */
export async function ensureHooksSecret(io: HooksSecretIo, name: string, clientSecret: string | null, random: () => string = () => randomBytes(32).toString('hex')): Promise<{ webhookSecret: string; state: 'created' | 'updated' | 'unchanged' }> {
  const raw = await io.read(name)
  let had: HooksSecretValue | null = null
  if (raw !== null) {
    try { const p = Stored.safeParse(JSON.parse(raw)); had = p.success ? p.data : null } catch { had = null }
  }
  const next: HooksSecretValue = { ...(had ?? {}), webhookSecret: had?.webhookSecret ?? random(), ...(clientSecret ? { clientSecret } : {}) }
  const text = JSON.stringify(next)
  if (raw === null) {
    await io.create(name, text, 'trace: GitHub webhook secret and the web backend\'s own client secret (written by the installer)')
    return { webhookSecret: next.webhookSecret, state: 'created' }
  }
  if (had && had.webhookSecret === next.webhookSecret && had.clientSecret === next.clientSecret) return { webhookSecret: next.webhookSecret, state: 'unchanged' }
  await io.put(name, text)
  return { webhookSecret: next.webhookSecret, state: 'updated' }
}

const Hook = z.object({ id: z.number(), config: z.object({ url: z.string().optional() }).loose().default({}) }).loose()

/** One repository's webhook to `url`: updated when there is one, else created. */
export async function registerWebhook(token: string, repo: string, url: string, secret: string, fetchImpl?: typeof fetch): Promise<'created' | 'updated'> {
  const gh = new Github(token, fetchImpl)
  const config = { url, content_type: 'json', secret, insecure_ssl: '0' }
  let found: number | null = null
  for (let page = 1; page <= 5 && found === null; page++) {
    const { data } = await gh.request('GET', `/repos/${repo}/hooks?per_page=100&page=${page}`, z.array(Hook))
    found = data.find((h) => h.config.url === url)?.id ?? null
    if (data.length < 100) break
  }
  if (found !== null) {
    await gh.request('PATCH', `/repos/${repo}/hooks/${found}`, z.unknown(), { active: true, events: [...HOOK_EVENTS], config })
    return 'updated'
  }
  await gh.request('POST', `/repos/${repo}/hooks`, z.unknown(), { name: 'web', active: true, events: [...HOOK_EVENTS], config })
  return 'created'
}

/** Why a repository's hook could not be registered, in words a person can act on. */
export function hookRefusedNote(repo: string, e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  const why = e instanceof GithubError && [403, 404].includes(e.status)
    ? 'the token may not manage its webhooks (it needs admin on it, or "Webhooks: read and write")'
    : m.slice(0, 200)
  return `${repo}: live updates from GitHub are not registered (${why}). Its screens look again every 60 s instead; give the token that permission and run the installer again.`
}

export interface RegisterResult { done: { repo: string; state: 'created' | 'updated' }[]; warnings: string[] }

/** Every repository's webhook, several at once; a refusal is a warning, never a throw. */
export async function registerWebhooks(token: string, repos: readonly string[], url: string, secret: string, o: { register?: typeof registerWebhook; concurrency?: number } = {}): Promise<RegisterResult> {
  const register = o.register ?? registerWebhook
  const out: RegisterResult = { done: [], warnings: [] }
  const queue = [...repos]
  const worker = async (): Promise<void> => {
    for (let r = queue.shift(); r !== undefined; r = queue.shift()) {
      try { out.done.push({ repo: r, state: await register(token, r, url, secret) }) } catch (e) { out.warnings.push(hookRefusedNote(r, e)) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 4, Math.max(1, repos.length)) }, worker))
  out.done.sort((a, b) => a.repo.localeCompare(b.repo))
  out.warnings.sort()
  return out
}

/** Secrets Manager for the hooks secret, with these credentials. */
export async function liveHooksSecretIo(creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string | undefined }, region: string): Promise<HooksSecretIo> {
  const sm = await import('@aws-sdk/client-secrets-manager')
  const c = new sm.SecretsManagerClient({ region, credentials: creds })
  return {
    async read(name) {
      try { return (await c.send(new sm.GetSecretValueCommand({ SecretId: name }))).SecretString ?? null } catch (e) {
        if ((e as { name?: string }).name === 'ResourceNotFoundException') return null
        throw e
      }
    },
    async create(name, value, description) { await c.send(new sm.CreateSecretCommand({ Name: name, SecretString: value, Description: description })) },
    async put(name, value) { await c.send(new sm.PutSecretValueCommand({ SecretId: name, SecretString: value })) },
  }
}

/** The backend's own app client's secret, from Cognito (DescribeUserPoolClient, the installer's credentials). */
export async function liveClientSecret(creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string | undefined }, region: string, poolId: string, clientId: string): Promise<string | null> {
  const idp = await import('@aws-sdk/client-cognito-identity-provider')
  const r = await new idp.CognitoIdentityProviderClient({ region, credentials: creds }).send(new idp.DescribeUserPoolClientCommand({ UserPoolId: poolId, ClientId: clientId }))
  return r.UserPoolClient?.ClientSecret ?? null
}

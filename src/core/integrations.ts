/**
 * Optional integrations: the external services some tools use, each with its own credentials. None of them is
 * needed to install or deploy trace; without one, the tools that use it say so and carry on with what they have.
 *
 *   nexar     Nexar (Octopart's data): every distributor Octopart knows, for parts.lookup / search / alternatives /
 *             bom_check (src/tools/parts/providers/nexar.ts)
 *   mouser    Mouser's Search API, for the same tools (providers/mouser.ts)
 *   digikey   Digi-Key's Product Information API v4, for the same tools (providers/digikey.ts)
 *
 *   dhl       DHL's Shipment Tracking - Unified API, for following a shipped order's parcel (src/core/shipping.ts and
 *             the order-watch Lambda; not a tool, so the worker never reads it)
 *
 * LCSC needs no key (providers/lcsc.ts), and the datasheet tools fetch public URLs, so neither is listed here. That is
 * every credential the tools read (src/tools/**; checked by test/core/integrations.test.ts).
 *
 * Where they live: one Secrets Manager secret per integration and installation, `<prefix>/integrations/<name>`, a JSON
 * object of the environment names the provider reads (NEXAR_CLIENT_ID, …). They are written by the installer, by
 * `tracectl integrations set <name>`, or by an admin through the API (integrations.set), and tagged with the
 * installation. Nothing writes them into a CloudFormation template.
 *
 * Who reads them: with the library gateway off, each project's worker role may read `<prefix>/integrations/*` and
 * the worker loads them into its environment when it starts (TRACE_INTEGRATIONS_PREFIX). The agent has Bash and that
 * role's credentials, so it can read them too. With the library gateway on, only the gateway's Lambda may read them
 * (src/infra/gateway.ts), so no agent can: the parts tools run there. README "Optional integrations".
 */
import { z } from 'zod'
import { INTEGRATIONS, INTEGRATION_NAMES, TOOL_INTEGRATIONS, type IntegrationName, integrationSecretName, valuesFor } from './integrations-catalog.js'

export * from './integrations-catalog.js'
export const IntegrationNameSchema = z.enum(INTEGRATION_NAMES)

// ------------------------------------------------------------------ checking a key (never blocks anything)

export interface KeyCheck { ok: boolean; detail: string }

type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** Ask the service whether these credentials work. A failure is reported, never thrown. */
export async function checkIntegration(name: IntegrationName, values: Record<string, string>, fetchImpl: Fetch = (u, i) => fetch(u, i)): Promise<KeyCheck> {
  const timeout = (): AbortSignal => AbortSignal.timeout(15_000)
  try {
    if (name === 'nexar' || name === 'digikey') {
      const url = name === 'nexar' ? 'https://identity.nexar.com/connect/token' : 'https://api.digikey.com/v1/oauth2/token'
      const id = values[name === 'nexar' ? 'NEXAR_CLIENT_ID' : 'DIGIKEY_CLIENT_ID'] ?? ''
      const secret = values[name === 'nexar' ? 'NEXAR_CLIENT_SECRET' : 'DIGIKEY_CLIENT_SECRET'] ?? ''
      const r = await fetchImpl(url, {
        method: 'POST', signal: timeout(),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
      })
      const body = await r.text()
      if (!r.ok) return { ok: false, detail: `${INTEGRATIONS[name].title} refused these credentials (HTTP ${r.status}${/invalid_client/.test(body) ? ': invalid client' : ''})` }
      return /access_token/.test(body) ? { ok: true, detail: `${INTEGRATIONS[name].title} accepted the credentials` } : { ok: false, detail: `${INTEGRATIONS[name].title} answered without a token` }
    }
    if (name === 'dhl') {
      // a known-unknown number: a working key answers 404 (no such shipment), a wrong one 401
      const r = await fetchImpl('https://api-eu.dhl.com/track/shipments?trackingNumber=0000000000', { method: 'GET', signal: timeout(), headers: { 'DHL-API-Key': values.DHL_API_KEY ?? '', accept: 'application/json' } })
      if (r.status === 401 || r.status === 403) return { ok: false, detail: `DHL refused this key (HTTP ${r.status})` }
      return r.ok || r.status === 404 ? { ok: true, detail: 'DHL accepted the key' } : { ok: false, detail: `DHL answered HTTP ${r.status}` }
    }
    const r = await fetchImpl(`https://api.mouser.com/api/v1/search/partnumber?apiKey=${encodeURIComponent(values.MOUSER_API_KEY ?? '')}`, {
      method: 'POST', signal: timeout(), headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ SearchByPartRequest: { mouserPartNumber: 'LM358', partSearchOptions: 'Exact' } }),
    })
    const body = await r.text()
    let errors: unknown[] = []
    try { errors = ((JSON.parse(body) as { Errors?: unknown[] }).Errors) ?? [] } catch { /* not JSON */ }
    if (!r.ok || errors.length) return { ok: false, detail: `Mouser refused this key (HTTP ${r.status}${errors.length ? `: ${JSON.stringify(errors[0]).slice(0, 120)}` : ''})` }
    return { ok: true, detail: 'Mouser accepted the key' }
  } catch (e) {
    return { ok: false, detail: `could not reach ${INTEGRATIONS[name].title}: ${e instanceof Error ? e.message : String(e)} (stored anyway; check it later with \`tracectl integrations check ${name}\`)` }
  }
}

// ------------------------------------------------------------------ the store (Secrets Manager)

/** The Secrets Manager calls the store makes, so tests give it a fake. */
export interface SecretsApi {
  get(name: string): Promise<string | null>
  /** create (with these tags) or overwrite the value */
  put(name: string, value: string, tags: Record<string, string>): Promise<void>
  /** null when it does not exist */
  describe(name: string): Promise<{ changed: Date | null } | null>
  remove(name: string): Promise<boolean>
}

export interface IntegrationStatus { name: IntegrationName; title: string; configured: boolean; changed: string | null; keys: readonly string[]; enables: string; url: string }

export class IntegrationStore {
  constructor(private readonly prefix: string, private readonly api: SecretsApi) {}

  async list(): Promise<IntegrationStatus[]> {
    return Promise.all(INTEGRATION_NAMES.map(async (n) => {
      const d = await this.api.describe(integrationSecretName(this.prefix, n))
      const i = INTEGRATIONS[n]
      return { name: n, title: i.title, configured: Boolean(d), changed: d?.changed?.toISOString() ?? null, keys: i.keys, enables: i.enables, url: i.url }
    }))
  }

  async set(name: IntegrationName, raw: Record<string, unknown>): Promise<string> {
    const values = valuesFor(name, raw)
    const secret = integrationSecretName(this.prefix, name)
    await this.api.put(secret, JSON.stringify(values), { 'trace:installation': this.prefix, 'trace:integration': name })
    return secret
  }

  async get(name: IntegrationName): Promise<Record<string, string> | null> {
    const v = await this.api.get(integrationSecretName(this.prefix, name))
    return v === null ? null : parseValues(name, v)
  }

  async remove(name: IntegrationName): Promise<boolean> {
    return this.api.remove(integrationSecretName(this.prefix, name))
  }
}

/** A secret's JSON, keeping only the integration's own keys (strings). */
export function parseValues(name: IntegrationName, text: string): Record<string, string> {
  let obj: unknown
  try { obj = JSON.parse(text) } catch { return {} }
  if (typeof obj !== 'object' || obj === null) return {}
  const out: Record<string, string> = {}
  for (const k of INTEGRATIONS[name].keys) {
    const v = (obj as Record<string, unknown>)[k]
    if (typeof v === 'string' && v.trim()) out[k] = v.trim()
  }
  return out
}

/** Secrets Manager behind SecretsApi (the SDK is loaded only when it is used). */
export async function secretsManagerApi(o: { region?: string; credentials?: unknown } = {}): Promise<SecretsApi> {
  const sm = await import('@aws-sdk/client-secrets-manager')
  const client = new sm.SecretsManagerClient({ ...(o.region ? { region: o.region } : {}), ...(o.credentials ? { credentials: o.credentials as never } : {}) })
  const missing = (e: unknown): boolean => (e as { name?: string }).name === 'ResourceNotFoundException'
  return {
    get: async (name) => {
      try { return (await client.send(new sm.GetSecretValueCommand({ SecretId: name }))).SecretString ?? null } catch (e) { if (missing(e)) return null; throw e }
    },
    put: async (name, value, tags) => {
      try {
        await client.send(new sm.PutSecretValueCommand({ SecretId: name, SecretString: value }))
      } catch (e) {
        if (!missing(e)) throw e
        await client.send(new sm.CreateSecretCommand({
          Name: name, SecretString: value, Description: 'trace: credentials of an optional integration (written by trace, never by CloudFormation)',
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        }))
      }
    },
    describe: async (name) => {
      try {
        const d = await client.send(new sm.DescribeSecretCommand({ SecretId: name }))
        return d.DeletedDate ? null : { changed: d.LastChangedDate ?? d.CreatedDate ?? null }
      } catch (e) { if (missing(e)) return null; throw e }
    },
    remove: async (name) => {
      try { await client.send(new sm.DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true })); return true } catch (e) { if (missing(e)) return false; throw e }
    },
  }
}

// ------------------------------------------------------------------ at run time

/**
 * Load the installation's integrations into the environment (the worker at start, the library Lambda on its first
 * call): every integration under `prefix` whose secret can be read, without overwriting a variable already set.
 * A missing or unreadable secret is skipped: the tools then say which key to add. Returns what was loaded and why
 * any was not.
 */
export async function loadIntegrations(prefix: string, get: (name: string) => Promise<string | null>, env: NodeJS.ProcessEnv = process.env): Promise<{ loaded: IntegrationName[]; skipped: string[] }> {
  const loaded: IntegrationName[] = []
  const skipped: string[] = []
  // only what the tools read: the order watch's carrier key is read by its own Lambda, never put in a worker
  await Promise.all(TOOL_INTEGRATIONS.map(async (n) => {
    try {
      const text = await get(`${prefix}${n}`)
      if (text === null) return
      const values = parseValues(n, text)
      let any = false
      for (const [k, v] of Object.entries(values)) if (!env[k]) { env[k] = v; any = true }
      if (any) loaded.push(n)
    } catch (e) {
      const name = (e as { name?: string }).name ?? ''
      skipped.push(`${n}: ${name === 'AccessDeniedException' ? 'not readable by this role' : e instanceof Error ? e.message : String(e)}`)
    }
  }))
  return { loaded: loaded.sort(), skipped }
}

/** loadIntegrations from TRACE_INTEGRATIONS_PREFIX with Secrets Manager; nothing when it is not set. */
export async function loadIntegrationsFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{ loaded: IntegrationName[]; skipped: string[] } | null> {
  const prefix = env.TRACE_INTEGRATIONS_PREFIX
  if (!prefix) return null
  const api = await secretsManagerApi(env.AWS_REGION ? { region: env.AWS_REGION } : {})
  return loadIntegrations(prefix, api.get, env)
}

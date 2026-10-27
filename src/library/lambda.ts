/**
 * The library gateway's Lambda target (src/infra/gateway.ts): the datasheets and parts tools that may run behind
 * AgentCore Gateway (src/core/gateway.ts LIBRARY_TOOLS), on the central database at TRACE_HOME, with the gateway
 * target's role.
 *
 * The gateway calls it with the tool's arguments as the event and names the tool in the client context
 * (`bedrockAgentCoreToolName`, `library___datasheets_find`). It answers with an envelope (EnvelopeSchema) that the
 * worker's `tracectl mcp` unwraps, so a forwarded call reads the same as one run in-process. A ToolError is an answer
 * (`ok: false`); anything else is thrown and the gateway reports the call as failed.
 *
 * It never takes a local file or another store: an argument named in LOCAL_INPUTS is refused, whoever sends it. The
 * distributors' credentials (MOUSER_API_KEY, DIGIKEY_CLIENT_ID/_SECRET, NEXAR_CLIENT_ID/_SECRET) come from one
 * Secrets Manager secret (TRACE_LIBRARY_KEYS_SECRET_ARN, a JSON object), read once per container; only this
 * function's role may read it, so no agent holds them.
 */
import { Registry, ToolError } from '../core/registry.js'
import { type Envelope, LIBRARY_TOOLS, LOCAL_INPUTS, type LibraryTool, libraryToolOf, localInputs } from '../core/gateway.js'
import { tools as datasheets } from '../tools/datasheets/tools.js'
import { tools as parts } from '../tools/parts/tools.js'

/** The distributor credentials the secret may carry, by the environment names the providers read. */
export const KEY_NAMES = ['MOUSER_API_KEY', 'DIGIKEY_CLIENT_ID', 'DIGIKEY_CLIENT_SECRET', 'NEXAR_CLIENT_ID', 'NEXAR_CLIENT_SECRET'] as const

export interface LambdaContext {
  clientContext?: { custom?: Record<string, unknown> } | null
}

/** Only the tools the gateway serves, so nothing else can be reached through it. */
export function libraryRegistry(): Registry {
  const all = new Registry([...datasheets, ...parts])
  return new Registry((Object.keys(LIBRARY_TOOLS) as LibraryTool[]).map((n) => {
    const t = all.get(n)
    if (!t) throw new Error(`the library tool ${n} is not defined`)
    return t
  }))
}

/** Run one library tool for the gateway. */
export async function runLibraryTool(registry: Registry, gatewayName: string, args: unknown): Promise<Envelope> {
  const name = libraryToolOf(gatewayName)
  if (!name) return { trace: 1, ok: false, error: `unknown tool ${JSON.stringify(gatewayName)}` }
  const local = localInputs(args)
  if (local.length) {
    return { trace: 1, ok: false, error: `${name}: ${local.join(', ')} name${local.length === 1 ? 's' : ''} something on the caller's side; the library gateway takes none of ${LOCAL_INPUTS.join(', ')}` }
  }
  try {
    const result = await registry.call(name, args ?? {}, { hardware: false, via: 'gateway' })
    return { trace: 1, ok: true, result: JSON.parse(JSON.stringify(result, (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v))) as unknown }
  } catch (e) {
    if (e instanceof ToolError) return { trace: 1, ok: false, error: e.message }
    throw e
  }
}

/** Copy the distributor credentials from the secret's JSON into the environment (known names only, strings only). */
export function applyKeys(secret: string, env: NodeJS.ProcessEnv = process.env, o: { keep?: boolean } = {}): string[] {
  let obj: unknown
  try { obj = JSON.parse(secret) } catch { return [] }
  if (typeof obj !== 'object' || obj === null) return []
  const set: string[] = []
  for (const k of KEY_NAMES) {
    const v = (obj as Record<string, unknown>)[k]
    if (o.keep && env[k]) continue
    if (typeof v === 'string' && v.trim()) { env[k] = v.trim(); set.push(k) }
  }
  return set
}

let keys: Promise<void> | null = null

async function loadKeys(): Promise<void> {
  // the installation's integrations first (<prefix>/integrations/<name>, src/core/integrations.ts), then the older
  // single secret for any key they leave unset
  const { loadIntegrationsFromEnv } = await import('../core/integrations.js')
  const r = await loadIntegrationsFromEnv()
  if (r?.skipped.length) console.error(`integrations skipped: ${r.skipped.join('; ')}`)
  const arn = process.env.TRACE_LIBRARY_KEYS_SECRET_ARN
  if (!arn) return
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager')
  const s = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }))
  if (s.SecretString) applyKeys(s.SecretString, process.env, { keep: true })
}

let registry: Registry | null = null

export async function handler(event: unknown, context: LambdaContext): Promise<Envelope> {
  // a failed read is tried again on the next call; the providers without credentials say so in their answers
  keys ??= loadKeys().catch((e: unknown) => { keys = null; console.error(`library keys not read: ${e instanceof Error ? e.message : String(e)}`) })
  await keys
  registry ??= libraryRegistry()
  const name = context.clientContext?.custom?.bedrockAgentCoreToolName
  if (typeof name !== 'string') return { trace: 1, ok: false, error: 'no tool name in the call (bedrockAgentCoreToolName)' }
  return runLibraryTool(registry, name, event)
}

/**
 * The shared library behind AgentCore Gateway (README "Library gateway"): which tools go there, what the gateway is
 * told about them, and the client a worker's `tracectl mcp` uses to reach it.
 *
 * Only the shared library moves: the datasheets and parts tools that read and write the central database, which every
 * project shares on purpose. A Lambda or Smithy target runs with the gateway's own role, never the caller's, so a
 * per-project tool behind a shared gateway would have to reach every project; those stay in the worker, where the
 * project's own role is the line between projects. Of the library tools, only calls that need nothing on the caller's
 * disk go remote: a call naming a local file (`file`, `path`) or another store (`library`) runs where it was made, and
 * so do the tools that hand back a local path or need Python or poppler (datasheets.get, .tables, .params,
 * .page_image).
 *
 * The worker's MCP configuration does not change: `tracectl mcp` stays its one server (src/core/mcp.ts) and forwards these
 * calls, signed with SigV4 by the runtime's own credentials (the gateway's inbound auth is AWS_IAM, and an MCP client's
 * remote configuration takes static headers only). With TRACE_GATEWAY_URL unset (local runs, the GitHub Actions
 * fallback, an installation without the gateway) everything runs in-process, as before.
 *
 * Reads fall back to in-process when the gateway can't be reached; writes don't, so when the gateway is on, every
 * write to the shared library goes through the one path that is logged in one place.
 */
import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Registry } from './registry.js'

/** The gateway target's name: tools reach the gateway as `<target>___<tool>`. */
export const LIBRARY_TARGET = 'library'
/** How the gateway joins a target's name to its tools' names. */
export const TARGET_DELIMITER = '___'

/** The library tools that may run behind the gateway, and whether each writes the shared library. */
export const LIBRARY_TOOLS = {
  'datasheets.list': 'read',
  'datasheets.find': 'read',
  'datasheets.text': 'read',
  'datasheets.history': 'read',
  'datasheets.add': 'write',
  'datasheets.acknowledge': 'write',
  'parts.lookup': 'read',
  'parts.search': 'read',
  'parts.alternatives': 'read',
  'parts.bom_check': 'read',
  'parts.fetch_datasheet': 'write',
} as const satisfies Record<string, 'read' | 'write'>
export type LibraryTool = keyof typeof LIBRARY_TOOLS

/** Inputs that name something on the caller's side: a local file, or another store. Never sent to the gateway, and
 * refused by the Lambda if a caller sends them anyway. */
export const LOCAL_INPUTS = ['library', 'file', 'path'] as const

export const isLibraryTool = (name: string): name is LibraryTool => Object.hasOwn(LIBRARY_TOOLS, name)
export const writesLibrary = (name: string): boolean => isLibraryTool(name) && LIBRARY_TOOLS[name] === 'write'

/** The local inputs a call carries (present and not undefined). */
export function localInputs(args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return []
  return LOCAL_INPUTS.filter((k) => (args as Record<string, unknown>)[k] !== undefined)
}

/** Whether this call goes to the gateway (when there is one). */
export const goesRemote = (name: string, args: unknown): boolean => isLibraryTool(name) && localInputs(args).length === 0

/** `datasheets.find` → `library___datasheets_find`, as the gateway lists it. */
export const gatewayToolName = (name: string): string => `${LIBRARY_TARGET}${TARGET_DELIMITER}${name.replaceAll('.', '_')}`

/** The registry name of a gateway tool name (`library___datasheets_find`, or a bare `datasheets_find`); null for a
 * name that isn't one of the library tools. */
export function libraryToolOf(gatewayName: string): LibraryTool | null {
  const i = gatewayName.indexOf(TARGET_DELIMITER)
  const bare = i >= 0 ? gatewayName.slice(i + TARGET_DELIMITER.length) : gatewayName
  return (Object.keys(LIBRARY_TOOLS) as LibraryTool[]).find((n) => n.replaceAll('.', '_') === bare) ?? null
}

// ------------------------------------------------------------------ the tool schema the gateway target is given

/** AgentCore Gateway's SchemaDefinition (CfnGatewayTarget): type, description, properties, items, required only. */
export interface SchemaDefinition {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  description?: string
  properties?: Record<string, SchemaDefinition>
  items?: SchemaDefinition
  required?: string[]
}
export interface ToolDefinition { name: string; description: string; inputSchema: SchemaDefinition }

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])
type Json = Record<string, unknown>

/**
 * JSON Schema (as zod writes it) narrowed to what Gateway accepts. What it has no keyword for (enums, bounds,
 * defaults, patterns) is kept in the description, so the model still reads it; the Lambda validates the call with
 * the tool's full zod schema either way.
 */
export function toSchemaDefinition(s: Json, drop: readonly string[] = []): SchemaDefinition {
  const anyOf = (s.anyOf ?? s.oneOf) as Json[] | undefined
  if (anyOf && !s.type) {
    const real = anyOf.find((x) => x.type !== 'null') ?? anyOf[0] ?? {}
    return toSchemaDefinition({ ...real, ...(s.description ? { description: s.description } : {}) }, drop)
  }
  const raw = Array.isArray(s.type) ? (s.type as string[]).find((x) => x !== 'null') : s.type
  const type = (typeof raw === 'string' && TYPES.has(raw) ? raw : s.enum ? 'string' : 'string') as SchemaDefinition['type']
  const notes: string[] = []
  if (Array.isArray(s.enum)) notes.push(`one of ${(s.enum as unknown[]).map((v) => JSON.stringify(v)).join(', ')}`)
  if (s.const !== undefined) notes.push(`always ${JSON.stringify(s.const)}`)
  for (const [k, label] of [['minimum', 'at least'], ['maximum', 'at most'], ['minLength', 'at least'], ['maxLength', 'at most'], ['minItems', 'at least'], ['maxItems', 'at most']] as const) {
    if (typeof s[k] === 'number') notes.push(`${label} ${s[k] as number}${k.endsWith('Length') ? ' characters' : k.endsWith('Items') ? ' items' : ''}`)
  }
  if (typeof s.pattern === 'string') notes.push(`matching ${s.pattern}`)
  if (typeof s.format === 'string') notes.push(`a ${s.format}`)
  if (s.default !== undefined) notes.push(`default ${JSON.stringify(s.default)}`)
  const base = typeof s.description === 'string' ? s.description : ''
  const description = [base, notes.length ? `(${notes.join('; ')})` : ''].filter(Boolean).join(' ')
  const out: SchemaDefinition = { type, ...(description ? { description } : {}) }
  if (type === 'object') {
    const props = (s.properties ?? {}) as Record<string, Json>
    out.properties = Object.fromEntries(Object.entries(props).filter(([k]) => !drop.includes(k)).map(([k, v]) => [k, toSchemaDefinition(v)]))
    const req = ((s.required ?? []) as string[]).filter((k) => !drop.includes(k))
    if (req.length) out.required = req
  }
  if (type === 'array') out.items = s.items && typeof s.items === 'object' ? toSchemaDefinition(s.items as Json) : { type: 'string' }
  return out
}

/** The gateway target's tool definitions: every library tool, without its local inputs. */
export function libraryToolDefinitions(registry: Registry): ToolDefinition[] {
  return (Object.keys(LIBRARY_TOOLS) as LibraryTool[]).map((name) => {
    const t = registry.get(name)
    if (!t) throw new Error(`the library tool ${name} is not in the registry`)
    return {
      name: name.replaceAll('.', '_'),
      description: (t.description + (writesLibrary(name) ? ' Writes the shared library.' : '')).slice(0, 4000),
      inputSchema: toSchemaDefinition(Registry.jsonSchema(t), LOCAL_INPUTS),
    }
  })
}

// ------------------------------------------------------------------ what the Lambda answers

/** The Lambda's answer, which the gateway hands back as the tool result's text. */
export const EnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({ trace: z.literal(1), ok: z.literal(true), result: z.unknown() }),
  z.object({ trace: z.literal(1), ok: z.literal(false), error: z.string() }),
])
export type Envelope = z.infer<typeof EnvelopeSchema>

const text = (obj: unknown): string =>
  typeof obj === 'string' ? obj : JSON.stringify(obj, (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v), 1)

/** A gateway tool result as the agent sees it: the envelope unwrapped, so a call answers the same wherever it ran. */
export function unwrap(r: CallToolResult): CallToolResult {
  const first = r.content?.[0]
  if (!first || first.type !== 'text') return r
  let parsed: unknown
  try { parsed = JSON.parse(first.text) } catch { return r }
  const e = EnvelopeSchema.safeParse(parsed)
  if (!e.success) return r
  return e.data.ok
    ? { content: [{ type: 'text', text: text(e.data.result) }], isError: false }
    : { content: [{ type: 'text', text: e.data.error }], isError: true }
}

// ------------------------------------------------------------------ the client a worker uses

/** What a forwarded call came to: the gateway's answer, or why it couldn't be reached. */
export type GatewayOutcome = { kind: 'result'; result: CallToolResult } | { kind: 'unreachable'; reason: string }

export interface GatewayCaller {
  call(name: LibraryTool, args: Record<string, unknown>): Promise<GatewayOutcome>
}

/** The region in an AgentCore Gateway URL (`https://<id>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp`). */
export function regionOf(url: string): string | null {
  try {
    return /\.bedrock-agentcore\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com$/.exec(new URL(url).hostname)?.[1] ?? null
  } catch {
    return null
  }
}

/** How long one forwarded call may take: a BOM check of 2,000 lines asks the providers line by line. A little longer
 * than the Lambda's own limit (src/infra/gateway.ts LAMBDA_TIMEOUT_MINUTES), so the Lambda's timeout is what answers. */
export const CALL_TIMEOUT_MS = 11 * 60 * 1000

/** A fetch that signs every request with SigV4 for `bedrock-agentcore`, with the default credential chain (the
 * AgentCore runtime's execution role in a worker). */
export async function signedFetch(region: string): Promise<typeof fetch> {
  const [{ SignatureV4 }, { Sha256 }, { HttpRequest }, { fromNodeProviderChain }] = await Promise.all([
    import('@smithy/signature-v4'), import('@aws-crypto/sha256-js'), import('@smithy/protocol-http'), import('@aws-sdk/credential-providers'),
  ])
  const signer = new SignatureV4({ service: 'bedrock-agentcore', region, credentials: fromNodeProviderChain(), sha256: Sha256 })
  return async (input, init = {}) => {
    // the MCP client passes a URL and a string body; anything else would be signed wrong, so it is refused
    if (typeof input !== 'string' && !(input instanceof URL)) throw new Error('signedFetch takes a URL, not a Request')
    if (init.body != null && typeof init.body !== 'string') throw new Error('signedFetch signs string bodies only')
    const url = new URL(typeof input === 'string' ? input : input.href)
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => { headers[k] = v })
    headers.host = url.host
    const body = typeof init.body === 'string' ? init.body : undefined
    const signed = await signer.sign(new HttpRequest({
      method: init.method ?? 'GET', protocol: url.protocol, hostname: url.hostname, ...(url.port ? { port: Number(url.port) } : {}),
      path: url.pathname, query: Object.fromEntries(url.searchParams), headers, ...(body !== undefined ? { body } : {}),
    }))
    const out = new Headers()
    for (const [k, v] of Object.entries(signed.headers)) if (k !== 'host') out.set(k, String(v))
    return fetch(url, { ...init, headers: out, ...(body !== undefined ? { body } : {}) })
  }
}

/** HTTP answers that mean the gateway did not take the call: auth refused, throttled, unavailable. */
const NOT_TAKEN = new Set([401, 403, 429, 503])

/**
 * What a failed call came to. Only a failure that means the call never ran is `unreachable` (the session could not be
 * opened, the connection was refused, the gateway refused or shed the request), so a read can run here instead
 * without running twice. Anything else (an MCP error, a timeout, another HTTP status) may have run behind the gateway:
 * it is answered as an error and never run again here.
 */
export function classify(e: unknown, opened: boolean): GatewayOutcome | 'expired' {
  const reason = e instanceof Error ? e.message : String(e)
  const code = typeof (e as { code?: unknown } | null)?.code === 'number' ? (e as { code: number }).code : null
  const http = (e as { name?: string } | null)?.name !== 'McpError' && /^Streamable HTTP error/.test(reason) ? code : null
  if (!opened) return { kind: 'unreachable', reason }
  if (http === 404) return 'expired' // the session ended (idle): the call was not taken
  if (http !== null && NOT_TAKEN.has(http)) return { kind: 'unreachable', reason }
  if (e instanceof TypeError) return { kind: 'unreachable', reason } // fetch failed: no connection
  return { kind: 'result', result: { content: [{ type: 'text', text: `the library gateway answered with an error, and the call may have run there: ${reason}` }], isError: true } }
}

/** The gateway at `url`, through one MCP session kept for the life of the process (opened on the first call, and
 * again when it has expired). */
export function gatewayClient(url: string, o: { fetch?: typeof fetch; region?: string } = {}): GatewayCaller {
  type Client = import('@modelcontextprotocol/sdk/client/index.js').Client
  let session: Promise<Client> | null = null
  const open = async (): Promise<Client> => {
    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ])
    const region = o.region ?? regionOf(url) ?? process.env.AWS_REGION ?? ''
    if (!region) throw new Error('no region for the gateway (AWS_REGION is not set and the URL names none)')
    const client = new Client({ name: 'trace-mcp', version: '0.1.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: o.fetch ?? (await signedFetch(region)) }))
    return client
  }
  const once = async (name: LibraryTool, args: Record<string, unknown>): Promise<GatewayOutcome | 'expired'> => {
    let client: Client
    try {
      session ??= open()
      client = await session
    } catch (e) {
      session = null
      return classify(e, false)
    }
    try {
      const r = await client.callTool({ name: gatewayToolName(name), arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })
      return { kind: 'result', result: unwrap(r as CallToolResult) }
    } catch (e) {
      session = null // opened again on the next call
      return classify(e, true)
    }
  }
  return {
    async call(name, args) {
      const first = await once(name, args)
      if (first !== 'expired') return first
      const again = await once(name, args)
      return again === 'expired' ? { kind: 'unreachable', reason: 'the gateway session expired twice in a row' } : again
    },
  }
}

let cached: { url: string; client: GatewayCaller } | null = null

/** The gateway this process forwards to (TRACE_GATEWAY_URL), or null: then every tool runs in-process. */
export function gatewayFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayCaller | null {
  const url = env.TRACE_GATEWAY_URL?.trim()
  if (!url) return null
  if (cached?.url !== url) cached = { url, client: gatewayClient(url) }
  return cached.client
}

/** Forget the cached client (tests). */
export function resetGateway(): void {
  cached = null
}

/** The project's parts settings for a forwarded parts call that leaves them out: the Lambda has no project config. */
export function withProjectParts(name: LibraryTool, args: Record<string, unknown>, parts: { providers: string[]; currency: string } | null): Record<string, unknown> {
  if (!parts || !name.startsWith('parts.')) return args
  const out = { ...args }
  if (out.providers === undefined) out.providers = parts.providers
  if (name !== 'parts.fetch_datasheet' && out.currency === undefined) out.currency = parts.currency
  return out
}


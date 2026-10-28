/**
 * The MCP endpoint for connected systems (TRACE_AGENT_MODE=mcp, docs/external-access.md "MCP endpoint"): a stateless
 * streamable-HTTP MCP server on 0.0.0.0:8000/mcp, AgentCore Runtime's MCP protocol contract, with GET /ping for health.
 *
 *   tools/list   one tool per action a connected system may call (src/api/service-policy.ts) that the caller's
 *                scopes allow, named trace_<action> (dots and anything else not a letter or digit as `_`), described
 *                in plain words (descriptions.ts), with the action's zod arguments as its input schema
 *   tools/call   forwarded to the external runtime with the caller's own bearer token, as { action, ...args };
 *                ok: true → the result as pretty JSON text (cut above about 200 KB, saying so); ok: false → a tool
 *                result with isError, so the model reads it and adjusts; 401 or 403 → an MCP error ("not allowed")
 *
 * This runtime decides nothing about access: the token's scope claim is read WITHOUT verifying it, only to leave out
 * tools the caller could not use; every call is verified and checked by the external runtime, which runs the API's
 * perform. It holds no AWS permissions and makes no AWS call: the external runtime's address is in its environment
 * (TRACE_EXTERNAL_URL, else TRACE_EXTERNAL_RUNTIME_ARN and AWS_REGION through invocationUrl).
 *
 * Stateless: a new MCP server and transport per request (sessionIdGenerator undefined), so any container can answer
 * any request. The runtime session id sent onward is a hash of the token's client_id and the client's MCP session id
 * when it sends one (else random), never the client's id itself: AgentCore keeps a session's storage per runtime
 * session id, so two systems that pick the same MCP session id still never share one. The client_id is read from the
 * token like the scope (AgentCore's authorizer has checked the token's signature before the request gets here, and
 * the external runtime checks it again).
 *
 * tools/list and the `tool` tool's description never offer the shared library's or the parts search's tools
 * (src/api/service-policy.ts SHARED_TOOL_PREFIXES): a system may not run them.
 */
import { createHash, randomUUID } from 'node:crypto'
import { type IncomingMessage, type Server as HttpServer, type ServerResponse, createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, type CallToolResult, ErrorCode, ListToolsRequestSchema, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { type ServiceScope } from '../core/access.js'
import { ACTIONS } from '../api/actions.js'
import { bearer } from '../api/jwt.js'
import { invocationUrl } from '../api/runtime-url.js'
import { DEFAULT_RESOURCE_SERVER, tokenScopes } from '../api/service-auth.js'
import { SERVICE_ACTIONS, offeredTo } from '../api/service-policy.js'
import { DESCRIPTIONS } from './descriptions.js'

export const VERSION = '0.1.0'
/** Text answers longer than this are cut, with a note saying so. */
export const MAX_TEXT = 200_000
const CALL_TIMEOUT_MS = 120_000
const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id'

const INSTRUCTIONS = 'trace: electronics projects from requirements to boards. Call trace_projects first to see the projects ' +
  'this system is on and its part on each; every other tool takes repo (OWNER/REPO). Reviewers read only.'

/** An action's MCP tool name: trace_ + the action with every non-alphanumeric character as `_` (journey.get → trace_journey_get). */
export const toolName = (action: string): string => `trace_${action.replace(/[^A-Za-z0-9]/g, '_')}`

const Claims = z.object({ scope: z.string().optional(), client_id: z.string().optional() }).loose()

/** A bearer token's claims, read without verifying them (null when unreadable). */
function claims(token: string | null): z.output<typeof Claims> | null {
  const payload = token?.split('.')[1]
  if (!payload) return null
  try {
    const c = Claims.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    return c.success ? c.data : null
  } catch {
    return null
  }
}

/** The resource-server scopes a bearer token claims, read without verifying it: it only shapes the tool list. */
export function claimedScopes(token: string | null, resourceServer = DEFAULT_RESOURCE_SERVER): ServiceScope[] {
  const c = claims(token)
  return c ? tokenScopes(c.scope, resourceServer) : []
}

/** The token's client_id claim (the connected system), or null. */
export const claimedClient = (token: string | null): string | null => claims(token)?.client_id ?? null

/** The input schema of an action's arguments as MCP wants it: JSON Schema of what the caller sends (defaults optional). */
export function inputSchema(action: string): Tool['inputSchema'] {
  const a = (ACTIONS as Record<string, { args: z.ZodType } | undefined>)[action]
  if (!a) return { type: 'object' }
  const { $schema: _s, ...schema } = z.toJSONSchema(a.args, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  return { ...schema, type: 'object' } as Tool['inputSchema']
}

/** The tools offered to a caller with these scopes. */
export function toolsFor(scopes: readonly ServiceScope[]): Tool[] {
  return Object.keys(SERVICE_ACTIONS).filter((a) => offeredTo(a, scopes)).map((a) => ({
    name: toolName(a), description: DESCRIPTIONS[a] ?? a, inputSchema: inputSchema(a),
  }))
}

const BY_TOOL: ReadonlyMap<string, string> = new Map(Object.keys(SERVICE_ACTIONS).map((a) => [toolName(a), a]))

const Answer = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }).loose(),
  z.object({ ok: z.literal(false), error: z.string() }).loose(),
])

/** A result as text a model reads: pretty JSON, cut above MAX_TEXT with a note saying how much was left out. */
export function resultText(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2) ?? 'null'
  if (text.length <= MAX_TEXT) return text
  return `${text.slice(0, MAX_TEXT)}\n\n[cut: the answer is ${text.length} characters and only the first ${MAX_TEXT} are shown. Ask for less: a limit, a narrower kind, one item.]`
}

export interface Forwarder {
  /** the external runtime's invocation URL */
  url: string
  fetch?: typeof fetch
}

/** One tools/call: the action forwarded to the external runtime with the caller's own token. */
export async function forward(f: Forwarder, token: string, action: string, args: Record<string, unknown>, session: string): Promise<CallToolResult> {
  let r: Response
  try {
    r = await (f.fetch ?? fetch)(f.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', [SESSION_HEADER]: session },
      body: JSON.stringify({ ...args, action }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
  } catch (e) {
    return { content: [{ type: 'text', text: `trace could not be reached: ${e instanceof Error ? e.message : String(e)}` }], isError: true }
  }
  const text = await r.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  const a = Answer.safeParse(json)
  if (r.status === 401 || r.status === 403) {
    throw new McpError(ErrorCode.InvalidRequest, `not allowed: ${a.success && !a.data.ok ? a.data.error : r.status === 401 ? 'the token was not accepted' : 'no access'}`)
  }
  if (r.status === 429) {
    return { content: [{ type: 'text', text: `too many requests: try again in ${r.headers.get('retry-after') ?? 'a few'} seconds` }], isError: true }
  }
  if (!a.success) return { content: [{ type: 'text', text: `trace answered ${r.status} with something that is not an answer` }], isError: true }
  if (!a.data.ok) return { content: [{ type: 'text', text: a.data.error }], isError: true }
  return { content: [{ type: 'text', text: resultText(a.data.result) }], isError: false }
}

/**
 * The runtime session id sent onward (33+ characters): one per system and MCP session when the client keeps one, a
 * hash of both, so another system that sends the same MCP session id gets another runtime session; else random.
 */
export function sessionFor(clientId: string | null, mcpSession: string | string[] | undefined): string {
  const s = Array.isArray(mcpSession) ? mcpSession[0] : mcpSession
  if (!s || !clientId) return `trace-mcp-${randomUUID()}`
  return `trace-mcp-${createHash('sha256').update(JSON.stringify([clientId, s])).digest('hex').slice(0, 40)}`
}

export interface McpOptions {
  forwarder: Forwarder
  resourceServer?: string | undefined
  log?: (line: Record<string, unknown>) => void
}

/** The MCP server for one request, for the caller holding `token`. */
export function mcpServer(o: McpOptions, token: string, session: string): Server {
  const s = new Server({ name: 'trace', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS })
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsFor(claimedScopes(token, o.resourceServer)) }))
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    const action = BY_TOOL.get(req.params.name)
    if (!action) return { content: [{ type: 'text', text: `unknown tool ${JSON.stringify(req.params.name)}` }], isError: true }
    return forward(o.forwarder, token, action, req.params.arguments ?? {}, session)
  })
  return s
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

export function handler(o: McpOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const log = o.log ?? ((l) => { process.stdout.write(`${JSON.stringify(l)}\n`) })
  return (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'GET' && path === '/ping') return send(res, 200, { status: 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) })
    if (path !== '/mcp') return send(res, 404, { error: 'not found' })
    const token = bearer(req.headers.authorization)
    if (!token) return send(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'not allowed: no bearer token' }, id: null })
    const t0 = Date.now()
    const server = mcpServer(o, token, sessionFor(claimedClient(token), req.headers['mcp-session-id']))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { void transport.close(); void server.close() })
    void (async () => {
      try {
        await server.connect(transport)
        await transport.handleRequest(req, res)
        log({ at: new Date(t0).toISOString(), method: req.method, status: res.statusCode, ms: Date.now() - t0 })
      } catch (e) {
        log({ at: new Date(t0).toISOString(), method: req.method, error: e instanceof Error ? e.message : String(e) })
        if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: ErrorCode.InternalError, message: 'internal error' }, id: null })
      }
    })()
  }
}

export function listen(o: McpOptions, port = 8000, host = '0.0.0.0'): Promise<HttpServer> {
  const server = createServer(handler(o))
  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(port, host, () => ok(server))
  })
}

const Env = z.object({
  TRACE_EXTERNAL_URL: z.string().url().optional(),
  TRACE_EXTERNAL_RUNTIME_ARN: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).optional(),
  TRACE_AGENTCORE_ENDPOINT: z.string().url().optional(),
  TRACE_EXTERNAL_RESOURCE_SERVER: z.string().min(1).optional(),
}).loose()

/** The external runtime's invocation URL from the environment: TRACE_EXTERNAL_URL, else the ARN and region. */
export function externalUrl(env: Record<string, string | undefined> = process.env): string {
  const e = Env.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')))
  if (e.TRACE_EXTERNAL_URL) return e.TRACE_EXTERNAL_URL
  if (e.TRACE_EXTERNAL_RUNTIME_ARN && e.AWS_REGION) return invocationUrl(e.AWS_REGION, e.TRACE_EXTERNAL_RUNTIME_ARN, e.TRACE_AGENTCORE_ENDPOINT)
  throw new Error('the MCP endpoint needs TRACE_EXTERNAL_URL, or TRACE_EXTERNAL_RUNTIME_ARN and AWS_REGION')
}

/** The MCP runtime's entry (src/agents/runtime/main.ts, TRACE_AGENT_MODE=mcp): port 8000, as AgentCore requires. */
export async function start(): Promise<void> {
  const url = externalUrl()
  const server = await listen({ forwarder: { url }, resourceServer: process.env.TRACE_EXTERNAL_RESOURCE_SERVER })
  process.stdout.write('trace mcp listening on 0.0.0.0:8000/mcp\n')
  const stop = (): void => { server.close(); process.exit(0) }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}

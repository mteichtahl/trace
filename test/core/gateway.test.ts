/**
 * The library gateway's worker side (src/core/gateway.ts, src/core/mcp.ts): which calls are forwarded, the schema the
 * gateway target is given, the envelope, the fallback rules, and the real MCP client against a local streamable-HTTP
 * server that checks every request is SigV4-signed for bedrock-agentcore.
 */
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type GatewayCaller, type GatewayOutcome, type SchemaDefinition, LIBRARY_TOOLS, LOCAL_INPUTS, classify, gatewayClient, gatewayFromEnv, gatewayToolName, goesRemote,
  libraryToolDefinitions, libraryToolOf, regionOf, resetGateway, signedFetch, toSchemaDefinition, unwrap, withProjectParts,
} from '../../src/core/gateway.js'
import { callTool } from '../../src/core/mcp.js'
import { Registry } from '../../src/core/registry.js'
import { allTools } from '../../src/tools/index.js'
import { libraryRegistry } from '../../src/library/lambda.js'

const text = (r: CallToolResult): string => (r.content[0]?.type === 'text' ? r.content[0].text : '')

describe('which calls go to the gateway', () => {
  it('only the library tools, and only without anything local', () => {
    expect(goesRemote('datasheets.find', { mpn: 'X', query: 'IQ' })).toBe(true)
    expect(goesRemote('parts.bom_check', { rows: [{ mpn: 'X', qty: 1 }] })).toBe(true)
    expect(goesRemote('parts.bom_check', { path: 'bom.csv' })).toBe(false)
    expect(goesRemote('datasheets.add', { mpn: 'X', url: 'https://example.com/x.pdf' })).toBe(true)
    expect(goesRemote('datasheets.add', { mpn: 'X', file: 'x.pdf' })).toBe(false)
    expect(goesRemote('datasheets.list', { library: '/tmp/lib' })).toBe(false)
    expect(goesRemote('datasheets.list', { library: undefined })).toBe(true)
    // these hand back a local path, or need Python or poppler: never forwarded
    for (const n of ['datasheets.get', 'datasheets.tables', 'datasheets.params', 'datasheets.page_image', 'kb.search', 'memory.recall', 'kicad.erc']) expect(goesRemote(n, {})).toBe(false)
  })

  it('names tools the way the gateway does, and back', () => {
    expect(gatewayToolName('parts.bom_check')).toBe('library___parts_bom_check')
    expect(libraryToolOf('library___parts_bom_check')).toBe('parts.bom_check')
    expect(libraryToolOf('datasheets_find')).toBe('datasheets.find')
    expect(libraryToolOf('library___datasheets_get')).toBeNull()
    for (const n of Object.keys(LIBRARY_TOOLS)) expect(libraryToolOf(gatewayToolName(n))).toBe(n)
  })

  it('reads the region from a gateway URL', () => {
    expect(regionOf('https://trace-library-abc1234567.gateway.bedrock-agentcore.ap-southeast-2.amazonaws.com/mcp')).toBe('ap-southeast-2')
    expect(regionOf('http://127.0.0.1:1234/mcp')).toBeNull()
    expect(regionOf('not a url')).toBeNull()
  })

  it('fills in the project\'s parts settings, never over the caller\'s', () => {
    const parts = { providers: ['mouser', 'lcsc'], currency: 'AUD' }
    expect(withProjectParts('parts.lookup', { mpn: 'X' }, parts)).toEqual({ mpn: 'X', providers: ['mouser', 'lcsc'], currency: 'AUD' })
    expect(withProjectParts('parts.lookup', { mpn: 'X', providers: ['lcsc'], currency: 'EUR' }, parts)).toEqual({ mpn: 'X', providers: ['lcsc'], currency: 'EUR' })
    expect(withProjectParts('parts.fetch_datasheet', { mpn: 'X' }, parts)).toEqual({ mpn: 'X', providers: ['mouser', 'lcsc'] })
    expect(withProjectParts('datasheets.list', {}, parts)).toEqual({})
    expect(withProjectParts('parts.lookup', { mpn: 'X' }, null)).toEqual({ mpn: 'X' })
  })
})

describe('the schema the gateway target is given', () => {
  const defs = libraryToolDefinitions(libraryRegistry())
  const walk = (s: SchemaDefinition, f: (s: SchemaDefinition) => void): void => {
    f(s)
    for (const v of Object.values(s.properties ?? {})) walk(v, f)
    if (s.items) walk(s.items, f)
  }

  it('has every library tool, under its MCP name', () => {
    expect(defs.map((d) => d.name).sort()).toEqual(Object.keys(LIBRARY_TOOLS).map((n) => n.replaceAll('.', '_')).sort())
  })

  it('uses only what Gateway accepts, and never a local input', () => {
    const allowed = new Set(['type', 'description', 'properties', 'items', 'required'])
    for (const d of defs) {
      expect(d.inputSchema.type).toBe('object')
      for (const k of LOCAL_INPUTS) expect(d.inputSchema.properties ?? {}).not.toHaveProperty(k)
      walk(d.inputSchema, (s) => {
        for (const k of Object.keys(s)) expect(allowed.has(k), `${d.name}: ${k}`).toBe(true)
        expect(['string', 'number', 'integer', 'boolean', 'array', 'object']).toContain(s.type)
        for (const r of s.required ?? []) expect(s.properties ?? {}).toHaveProperty(r)
      })
    }
  })

  it('keeps enums, bounds and defaults in the description', () => {
    const list = defs.find((d) => d.name === 'datasheets_list')
    expect(list?.inputSchema.properties?.status?.description).toMatch(/one of "current", "retired", "changed", "all".*default "current"/)
    expect(list?.inputSchema.properties?.limit).toMatchObject({ type: 'integer' })
    expect(list?.inputSchema.properties?.limit?.description).toMatch(/at least 1; at most 200; default 50/)
    const bom = defs.find((d) => d.name === 'parts_bom_check')
    expect(bom?.inputSchema.properties?.rows).toMatchObject({ type: 'array', items: { type: 'object' } })
    expect(defs.find((d) => d.name === 'datasheets_add')?.description).toMatch(/Writes the shared library\.$/)
  })

  it('narrows nullable and union types to their first real type', () => {
    expect(toSchemaDefinition({ anyOf: [{ type: 'null' }, { type: 'number', minimum: 0 }], description: 'v' })).toEqual({ type: 'number', description: 'v (at least 0)' })
    expect(toSchemaDefinition({ type: ['string', 'null'] })).toEqual({ type: 'string' })
    expect(toSchemaDefinition({ type: 'array' })).toEqual({ type: 'array', items: { type: 'string' } })
  })
})

describe('the envelope', () => {
  it('is unwrapped to what an in-process call answers', () => {
    expect(unwrap({ content: [{ type: 'text', text: JSON.stringify({ trace: 1, ok: true, result: { a: 1 } }) }] })).toEqual({ content: [{ type: 'text', text: '{\n "a": 1\n}' }], isError: false })
    expect(unwrap({ content: [{ type: 'text', text: JSON.stringify({ trace: 1, ok: false, error: 'no such part' }) }] })).toEqual({ content: [{ type: 'text', text: 'no such part' }], isError: true })
    const other = { content: [{ type: 'text' as const, text: 'plain' }], isError: true }
    expect(unwrap(other)).toBe(other)
  })
})

describe('tracectl mcp with a gateway', () => {
  const reg = allTools()
  const fake = (answer: (name: string, args: Record<string, unknown>) => GatewayOutcome): GatewayCaller & { calls: [string, Record<string, unknown>][] } => {
    const calls: [string, Record<string, unknown>][] = []
    return { calls, call: async (name, args) => { calls.push([name, args]); return answer(name, args) } }
  }

  it('forwards a library call and answers with the gateway\'s result', async () => {
    const gw = fake(() => ({ kind: 'result', result: { content: [{ type: 'text', text: 'from the gateway' }], isError: false } }))
    const r = await callTool(reg, 'datasheets_list', { query: 'TPX' }, false, gw)
    expect(text(r)).toBe('from the gateway')
    expect(gw.calls).toEqual([['datasheets.list', { query: 'TPX' }]])
  })

  it('runs a read here when the gateway can\'t be reached', async () => {
    const gw = fake(() => ({ kind: 'unreachable', reason: 'ECONNREFUSED' }))
    const r = await callTool(reg, 'datasheets_list', {}, false, gw)
    expect(gw.calls).toHaveLength(1)
    expect(r.isError).toBe(false)
    expect(JSON.parse(text(r))).toHaveProperty('total')
  })

  it('refuses a write when the gateway can\'t be reached, rather than write around it', async () => {
    const gw = fake(() => ({ kind: 'unreachable', reason: 'ECONNREFUSED' }))
    const r = await callTool(reg, 'datasheets_acknowledge', { mpn: 'TPX123' }, false, gw)
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/goes only through the library gateway.*ECONNREFUSED/)
  })

  it('keeps calls with local inputs, and every other tool, in-process', async () => {
    const gw = fake(() => { throw new Error('must not be called') })
    await callTool(reg, 'datasheets_list', { library: '/nonexistent-trace-store' }, false, gw)
    await callTool(reg, 'calc_divider', { vin: 12, vout: 3.3 }, false, gw)
    expect(gw.calls).toEqual([])
  })

  it('without TRACE_GATEWAY_URL, there is no gateway', () => {
    resetGateway()
    expect(gatewayFromEnv({})).toBeNull()
    expect(gatewayFromEnv({ TRACE_GATEWAY_URL: 'https://x.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp' })).not.toBeNull()
    resetGateway()
  })
})

describe('the client, against a streamable-HTTP MCP server', () => {
  let http: HttpServer
  let url = ''
  const seen: { authorization: string; amzDate: string; token: string | undefined; method: string | undefined }[] = []
  const called: { name: string; args: unknown }[] = []
  const saved = { ...process.env }

  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE'
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
    process.env.AWS_SESSION_TOKEN = 'session-token'
    http = createServer(async (req, res) => {
      seen.push({ authorization: String(req.headers.authorization ?? ''), amzDate: String(req.headers['x-amz-date'] ?? ''), token: req.headers['x-amz-security-token'] as string | undefined, method: req.method })
      // a stateless server per request, as a gateway answers each call on its own
      const mcp = new Server({ name: 'fake-gateway', version: '1' }, { capabilities: { tools: {} } })
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
      mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
        called.push({ name: r.params.name, args: r.params.arguments })
        if (r.params.name === 'library___parts_bom_check') throw new McpError(ErrorCode.InternalError, 'Lambda timed out')
        if (r.params.name === 'library___datasheets_history') return { content: [{ type: 'text', text: JSON.stringify({ trace: 1, ok: false, error: 'TPX9: not in the library' }) }] }
        return { content: [{ type: 'text', text: JSON.stringify({ trace: 1, ok: true, result: { total: 3 } }) }] }
      })
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await mcp.connect(t)
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown : undefined
      await t.handleRequest(req, res, body)
    })
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`
  })
  afterEach(() => { seen.length = 0; called.length = 0 })
  afterAll(async () => {
    process.env = saved
    http.closeAllConnections() // the client keeps its connection alive
    await new Promise<void>((r) => http.close(() => r()))
  })

  it('signs every request with SigV4 for bedrock-agentcore', async () => {
    const f = await signedFetch('us-west-2')
    await f(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })
    expect(seen[0]?.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/bedrock-agentcore\/aws4_request, SignedHeaders=[^,]*host[^,]*, Signature=[0-9a-f]{64}$/)
    expect(seen[0]?.amzDate).toMatch(/^\d{8}T\d{6}Z$/)
    expect(seen[0]?.token).toBe('session-token')
  })

  it('opens a session, calls the target\'s tool and unwraps the answer', async () => {
    const c = gatewayClient(url, { region: 'us-west-2' })
    const r = await c.call('datasheets.list', { query: 'TPX' })
    expect(r).toEqual({ kind: 'result', result: { content: [{ type: 'text', text: '{\n "total": 3\n}' }], isError: false } })
    expect(called).toEqual([{ name: 'library___datasheets_list', args: { query: 'TPX' } }])
    expect(seen.length).toBeGreaterThanOrEqual(2) // initialize, then the call (and its notification)
    for (const s of seen) expect(s.authorization).toMatch(/^AWS4-HMAC-SHA256 /)
    const e = await c.call('datasheets.history', { mpn: 'TPX9' })
    expect(e).toEqual({ kind: 'result', result: { content: [{ type: 'text', text: 'TPX9: not in the library' }], isError: true } })
  })

  it('answers a gateway error as an error, never as unreachable (the call may have run)', async () => {
    const r = await gatewayClient(url, { region: 'us-west-2' }).call('parts.bom_check', { rows: [] })
    expect(r.kind).toBe('result')
    expect(r.kind === 'result' && r.result.isError).toBe(true)
    expect(r.kind === 'result' ? text(r.result) : '').toMatch(/may have run there.*Lambda timed out/)
  })

  it('opens a new session when the old one has expired, and sends the call once more', async () => {
    let refused = 0
    const f = await signedFetch('us-west-2')
    const expiring: typeof fetch = async (input, init) => {
      if (refused === 0 && typeof init?.body === 'string' && init.body.includes('"tools/call"')) { refused++; return new Response('session not found', { status: 404 }) }
      return f(input, init)
    }
    const r = await gatewayClient(url, { region: 'us-west-2', fetch: expiring }).call('datasheets.list', {})
    expect(refused).toBe(1)
    expect(r.kind).toBe('result')
    expect(called).toEqual([{ name: 'library___datasheets_list', args: {} }])
  })

  it('reports a gateway it can\'t reach as unreachable', async () => {
    const r = await gatewayClient('http://127.0.0.1:9/mcp', { region: 'us-west-2' }).call('datasheets.list', {})
    expect(r.kind).toBe('unreachable')
  })
})

describe('what a failed call came to', () => {
  it('is unreachable only when the call can\'t have run', () => {
    expect(classify(new Error('boom'), false)).toEqual({ kind: 'unreachable', reason: 'boom' })
    expect(classify(new TypeError('fetch failed'), true)).toEqual({ kind: 'unreachable', reason: 'fetch failed' })
    for (const code of [401, 403, 429, 503]) expect(classify(new StreamableHTTPError(code, 'x'), true)).toMatchObject({ kind: 'unreachable' })
    expect(classify(new StreamableHTTPError(404, 'Session not found'), true)).toBe('expired')
    for (const e of [new StreamableHTTPError(500, 'x'), new StreamableHTTPError(504, 'x'), new McpError(ErrorCode.RequestTimeout, 'Request timed out'), new McpError(ErrorCode.InvalidParams, 'bad')]) {
      expect(classify(e, true)).toMatchObject({ kind: 'result', result: { isError: true } })
    }
  })

  it('signs only what it can sign faithfully', async () => {
    const f = await signedFetch('us-east-1')
    await expect(f(new Request('http://127.0.0.1:9/'))).rejects.toThrow(/not a Request/)
    await expect(f('http://127.0.0.1:9/', { method: 'POST', body: new Uint8Array([1]) })).rejects.toThrow(/string bodies only/)
  })
})

describe('the registry is unchanged for everything else', () => {
  it('still offers every tool by its MCP name', () => {
    const names = new Registry(allTools().list()).list().map((t) => t.name)
    for (const n of Object.keys(LIBRARY_TOOLS)) expect(names).toContain(n)
  })
})

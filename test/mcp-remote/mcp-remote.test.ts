/**
 * The MCP endpoint (src/mcp-remote/server.ts): tools/list shaped by the caller's scopes, tools/call forwarded to a
 * local fake of the external runtime with the caller's token, and its answers turned into tool results.
 */
import { type IncomingMessage, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ACTION_NAMES } from '../../src/api/actions.js'
import { SERVICE_ACTIONS } from '../../src/api/service-policy.js'
import { DESCRIPTIONS } from '../../src/mcp-remote/descriptions.js'
import { MAX_TEXT, claimedScopes, externalUrl, inputSchema, listen, resultText, sessionFor, toolName, toolsFor } from '../../src/mcp-remote/server.js'

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
/** A token-shaped string: the MCP runtime reads only its scope, unverified. */
const tok = (scope: string): string => `${b64({ alg: 'RS256' })}.${b64({ scope, client_id: 'c1' })}.sig`
const READ = tok('trace-external/read')
const BOTH = tok('trace-external/read trace-external/write')

describe('the tool list', () => {
  it('has a plain description for every allowed action, and nothing else', () => {
    expect(Object.keys(DESCRIPTIONS).sort()).toEqual(Object.keys(SERVICE_ACTIONS).sort())
    for (const a of Object.keys(SERVICE_ACTIONS)) expect(ACTION_NAMES as string[]).toContain(a)
  })
  it('names tools trace_<action>', () => {
    expect(toolName('journey.get')).toBe('trace_journey_get')
    expect(toolName('tools.list')).toBe('trace_tools_list')
  })
  it('reads the scope claim without trusting it, and anything unreadable as none', () => {
    expect(claimedScopes(BOTH)).toEqual(['read', 'write'])
    expect(claimedScopes('garbage')).toEqual([])
    expect(claimedScopes(null)).toEqual([])
  })
  it('hides write tools from a read-only caller', () => {
    const ro = toolsFor(['read']).map((t) => t.name)
    expect(ro).toContain('trace_journey_get')
    expect(ro).toContain('trace_tool')
    expect(ro).not.toContain('trace_task')
    expect(ro).not.toContain('trace_settings_set')
    expect(toolsFor(['read', 'write']).map((t) => t.name)).toContain('trace_task')
    expect(toolsFor([])).toEqual([])
  })
  it('gives each an object input schema made from the action\'s arguments (defaults optional, no $schema)', () => {
    const s = inputSchema('runs') as { type: string; properties: Record<string, unknown>; required?: string[]; $schema?: string }
    expect(s.type).toBe('object')
    expect(s.$schema).toBeUndefined()
    expect(Object.keys(s.properties)).toEqual(expect.arrayContaining(['repo', 'limit', 'kind']))
    expect(s.required).toEqual(['repo'])
    for (const a of Object.keys(SERVICE_ACTIONS)) expect(inputSchema(a).type).toBe('object')
  })
  it('cuts a long answer and says so', () => {
    const t = resultText({ x: 'y'.repeat(MAX_TEXT + 10) })
    expect(t.length).toBeLessThan(MAX_TEXT + 300)
    expect(t).toMatch(/\[cut:/)
    expect(resultText({ a: 1 })).toBe('{\n  "a": 1\n}')
  })
  it('gives a runtime session id of at least 33 characters', () => {
    expect(sessionFor('abc').length).toBeGreaterThanOrEqual(33)
    expect(sessionFor('abc')).toBe(sessionFor('abc'))
    expect(sessionFor(undefined).length).toBeGreaterThanOrEqual(33)
  })
  it('finds the external runtime from TRACE_EXTERNAL_URL, else its ARN and region', () => {
    expect(externalUrl({ TRACE_EXTERNAL_URL: 'https://x.example/inv' })).toBe('https://x.example/inv')
    expect(externalUrl({ TRACE_EXTERNAL_RUNTIME_ARN: 'arn:aws:bedrock-agentcore:us-east-1:1:runtime/ext', AWS_REGION: 'us-east-1' }))
      .toBe(`https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/${encodeURIComponent('arn:aws:bedrock-agentcore:us-east-1:1:runtime/ext')}/invocations?qualifier=DEFAULT`)
    expect(() => externalUrl({})).toThrow(/TRACE_EXTERNAL/)
  })
})

describe('the MCP server over HTTP', () => {
  let fake: Server
  let mcp: Server
  let base = ''
  const seen: { auth: string | undefined; session: string | undefined; body: Record<string, unknown> }[] = []

  beforeAll(async () => {
    // the external runtime, faked: answers by action
    fake = createServer((req: IncomingMessage, res) => {
      let text = ''
      req.on('data', (c) => { text += String(c) })
      req.on('end', () => {
        const body = JSON.parse(text) as Record<string, unknown>
        seen.push({ auth: req.headers.authorization, session: req.headers['x-amzn-bedrock-agentcore-runtime-session-id'] as string | undefined, body })
        const answer = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)) }
        if (body.action === 'projects') return answer(200, { ok: true, result: [{ repo: 'acme/board', role: 'read', part: 'reviewer' }] })
        if (body.action === 'run') return answer(200, { ok: false, error: 'no run r9' })
        if (body.action === 'task') return answer(403, { ok: false, error: 'no access' })
        return answer(401, { ok: false, error: 'not signed in' })
      })
    })
    await new Promise<void>((ok) => fake.listen(0, '127.0.0.1', ok))
    const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/invocations`
    mcp = await listen({ forwarder: { url: fakeUrl }, log: () => undefined }, 0, '127.0.0.1')
    base = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}`
  })
  afterAll(() => { mcp.close(); fake.close() })

  const client = async (token: string): Promise<Client> => {
    const c = new Client({ name: 'test', version: '1' })
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    return c
  }

  it('answers /ping, and 401s a request without a token', async () => {
    expect(await (await fetch(`${base}/ping`)).json()).toMatchObject({ status: 'Healthy' })
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    expect(r.status).toBe(401)
  })

  it('lists tools by the caller\'s scopes', async () => {
    const ro = await client(READ)
    const names = (await ro.listTools()).tools.map((t) => t.name)
    expect(names).toContain('trace_projects')
    expect(names).not.toContain('trace_task')
    await ro.close()
    const rw = await client(BOTH)
    expect((await rw.listTools()).tools.map((t) => t.name)).toContain('trace_task')
    await rw.close()
  })

  it('forwards a call with the caller\'s own token and a session id, and returns the result as JSON text', async () => {
    const c = await client(READ)
    const r = await c.callTool({ name: 'trace_projects', arguments: {} })
    expect(r.isError).toBe(false)
    expect(JSON.parse((r.content as { text: string }[])[0]!.text)).toEqual([{ repo: 'acme/board', role: 'read', part: 'reviewer' }])
    expect(seen.at(-1)).toMatchObject({ auth: `Bearer ${READ}`, body: { action: 'projects' } })
    expect(seen.at(-1)!.session!.length).toBeGreaterThanOrEqual(33)
    await c.close()
  })

  it('an ok:false answer is a tool error the model reads', async () => {
    const c = await client(READ)
    const r = await c.callTool({ name: 'trace_run', arguments: { repo: 'acme/board', id: 'r9' } })
    expect(r).toMatchObject({ isError: true, content: [{ type: 'text', text: 'no run r9' }] })
    expect(seen.at(-1)!.body).toEqual({ action: 'run', repo: 'acme/board', id: 'r9' })
    await c.close()
  })

  it('a 401 or 403 is an MCP error saying not allowed', async () => {
    const c = await client(BOTH)
    await expect(c.callTool({ name: 'trace_task', arguments: { repo: 'acme/board', request: 'x' } })).rejects.toThrow(/not allowed: no access/)
    await expect(c.callTool({ name: 'trace_whoami', arguments: {} })).rejects.toThrow(/not allowed/)
    const u = await c.callTool({ name: 'trace_users_list', arguments: {} })
    expect(u.isError).toBe(true)
    await c.close()
  })
})

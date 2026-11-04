/**
 * The ways in that are not the browser: the external API, the remote MCP endpoint, tracectl, and web push. Live only;
 * each skips with a reason when what it needs is not configured.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { external, externalReady, live } from './env'
import { expect, test } from './fixtures'

test.describe.configure({ mode: 'serial' })

let token = ''
async function accessToken(): Promise<string> {
  if (token) return token
  const r = await fetch(external.tokenUrl!, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${external.clientId}:${external.clientSecret}`).toString('base64')}` },
    body: 'grant_type=client_credentials',
  })
  expect(r.status, 'the token address gave a token').toBe(200)
  token = ((await r.json()) as { access_token: string }).access_token
  return token
}

test('external API: a connected system reads its projects', async () => {
  test.skip(!externalReady, 'needs the TRACE_SMOKE_TOKEN_URL, _CLIENT_ID, _CLIENT_SECRET, _API_URL and _MCP_URL of a read-only connected system')
  const call = async (action: string) => {
    const r = await fetch(external.apiUrl!, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await accessToken()}` }, body: JSON.stringify({ action }) })
    expect(r.status, `${action} answered`).toBe(200)
    const body = (await r.json()) as { ok: boolean; result?: unknown; error?: string }
    expect(body.ok, body.error).toBe(true)
    return body.result
  }
  expect(await call('whoami')).toMatchObject({ kind: 'service' })
  expect(Array.isArray(await call('projects')) || typeof (await call('projects')) === 'object').toBe(true)
})

test('remote MCP: lists its tools and answers a read-only call', async () => {
  test.skip(!externalReady, 'needs a connected system (see the external API check)')
  const rpc = async (id: number, method: string, params: unknown = {}) => {
    const r = await fetch(external.mcpUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${await accessToken()}` },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    expect(r.status, `${method} answered`).toBe(200)
    const text = await r.text()
    const json = text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:'))!.slice(5)
    return JSON.parse(json) as { result?: { tools?: { name: string }[]; isError?: boolean }; error?: unknown }
  }
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'trace-smoke', version: '1' } })
  const tools = (await rpc(2, 'tools/list')).result?.tools ?? []
  expect(tools.map((t) => t.name)).toContain('trace_whoami')
  const who = await rpc(3, 'tools/call', { name: 'trace_whoami', arguments: {} })
  expect(who.error).toBeUndefined()
  expect(who.result?.isError ?? false).toBe(false)
})

test('tracectl starts and lists its tools', () => {
  const bin = fileURLToPath(new URL('../../dist/bin.js', import.meta.url))
  test.skip(!existsSync(bin), 'tracectl is not built here (npm run build at the repository root)')
  const help = execFileSync(process.execPath, [bin, 'help'], { encoding: 'utf8', timeout: 30_000 })
  expect(help).toMatch(/tracectl/)
  const tools = execFileSync(process.execPath, [bin, 'tools'], { encoding: 'utf8', timeout: 60_000 })
  expect(tools.trim().length).toBeGreaterThan(0)
})

test('web push: the service worker registers and push can be turned on', async ({ app, page, context, baseURL }) => {
  test.skip(!live, 'the mock has no push service')
  await context.grantPermissions(['notifications'], { origin: baseURL })
  await app.open('/me')
  await page.getByRole('button', { name: 'Notifications' }).click()
  const ready = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/')))
  expect(ready, 'the service worker registered').toBe(true)
  await expect(page.getByRole('switch', { name: /push|this device/i }).first()).toBeVisible()
})

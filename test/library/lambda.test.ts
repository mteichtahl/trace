/**
 * The library gateway's Lambda (src/library/lambda.ts): what it runs, what it refuses, the keys it takes, and the
 * real esbuild bundle CloudFormation ships, run here against a local store (node:sqlite and pdfjs-dist from beside
 * the bundle, as on Lambda).
 */
import { mkdtempSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bridge } from '../../src/core/bridge.js'
import { Central, resetCentral } from '../../src/core/central.js'
import { LIBRARY_TOOLS, type Envelope } from '../../src/core/gateway.js'
import { DatasheetLibrary } from '../../src/tools/datasheets/library.js'
import { bundleLibraryLambda } from '../../src/infra/gateway.js'
import { KEY_NAMES, applyKeys, libraryRegistry, runLibraryTool } from '../../src/library/lambda.js'
import { fixturePdf } from '../tools/datasheets/fixture.js'

const ROOT = join(import.meta.dirname, '..', '..')
const home = mkdtempSync(join(tmpdir(), 'trace-gw-home-'))
let sha = ''

beforeAll(async () => {
  process.env.TRACE_HOME = home
  resetCentral()
  const lib = new DatasheetLibrary({ central: new Central({ home }) })
  sha = (await lib.add({ mpn: 'TPX123', file: fixturePdf('A'), manufacturer: 'Example Semi', by: 'test' })).sha256
}, 120_000)
afterAll(() => bridge().close())

const ok = (e: Envelope): unknown => {
  if (!e.ok) throw new Error(`not ok: ${e.error}`)
  return e.result
}

describe('the library Lambda', () => {
  const reg = libraryRegistry()

  it('serves exactly the library tools', () => {
    expect(reg.list().map((t) => t.name).sort()).toEqual(Object.keys(LIBRARY_TOOLS).sort())
  })

  it('runs a tool named as the gateway names it', async () => {
    const r = ok(await runLibraryTool(reg, 'library___datasheets_list', {})) as { total: number; parts: { mpn: string }[] }
    expect(r.total).toBe(1)
    expect(r.parts[0]?.mpn).toBe('TPX123')
    const f = ok(await runLibraryTool(reg, 'library___datasheets_find', { mpn: 'tpx123', query: 'Electrical Characteristics' })) as { sha256: string; total: number }
    expect(f.sha256).toBe(sha)
    expect(f.total).toBeGreaterThan(0)
  })

  it('answers a ToolError as ok: false, and an unknown tool the same way', async () => {
    const e = await runLibraryTool(reg, 'library___datasheets_history', { mpn: 'NOPE999' })
    expect(e.ok).toBe(false)
    expect(await runLibraryTool(reg, 'library___kicad_erc', {})).toEqual({ trace: 1, ok: false, error: 'unknown tool "library___kicad_erc"' })
    // a tool outside the gateway's set is unknown even when it is a library area's tool
    expect((await runLibraryTool(reg, 'library___datasheets_get', { mpn: 'TPX123' })).ok).toBe(false)
  })

  it('refuses anything that names a local file or another store, whoever sends it', async () => {
    for (const [tool, args] of [
      ['library___datasheets_list', { library: '/etc' }],
      ['library___datasheets_add', { mpn: 'X1', file: '/etc/passwd' }],
      ['library___parts_bom_check', { path: '/etc/passwd' }],
    ] as const) {
      const e = await runLibraryTool(reg, tool, args)
      expect(e.ok).toBe(false)
      expect(e.ok ? '' : e.error).toMatch(/caller's side/)
    }
  })

  it('takes the distributor keys it knows, and nothing else', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(applyKeys(JSON.stringify({ MOUSER_API_KEY: ' k1 ', NEXAR_CLIENT_ID: 'id', NEXAR_CLIENT_SECRET: '', PATH: '/x', unused: 'abc' }), env)).toEqual(['MOUSER_API_KEY', 'NEXAR_CLIENT_ID'])
    expect(env).toEqual({ MOUSER_API_KEY: 'k1', NEXAR_CLIENT_ID: 'id' })
    expect(applyKeys('not json', env)).toEqual([])
    expect([...KEY_NAMES]).toContain('DIGIKEY_CLIENT_SECRET')
  })
})

describe('the bundle CloudFormation ships', () => {
  const out = mkdtempSync(join(tmpdir(), 'trace-gw-bundle-'))
  type Handler = (event: unknown, context: unknown) => Promise<Envelope>
  let handler: Handler

  beforeAll(async () => {
    bundleLibraryLambda(ROOT, out)
    // a fresh process view of the store: the page text is dropped so the bundle must extract it with its own pdfjs
    await new Central({ home }).update((db) => { db.prepare('DELETE FROM datasheet_pages WHERE sha256=?').run(sha) })
    for (const t of ['datasheet_pages_fts']) {
      await new Central({ home }).update((db) => {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(t)) db.prepare(`DELETE FROM ${t} WHERE sha256=?`).run(sha)
      })
    }
    handler = ((await import(pathToFileURL(join(out, 'index.mjs')).href)) as { handler: Handler }).handler
  }, 120_000)

  it('is one ESM file with the pdfjs-dist parts beside it', () => {
    expect(statSync(join(out, 'index.mjs')).size).toBeGreaterThan(10_000)
    for (const f of ['package.json', 'legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs', 'standard_fonts']) expect(existsSync(join(out, 'node_modules', 'pdfjs-dist', f))).toBe(true)
  })

  it('answers a gateway call, extracting page text with the pdfjs beside it', async () => {
    const ctx = { clientContext: { custom: { bedrockAgentCoreToolName: 'library___datasheets_text', bedrockAgentCoreGatewayId: 'gw' } } }
    const e = await handler({ mpn: 'TPX123', pages: [2] }, ctx)
    const r = ok(e) as { sha256: string; pages: { page: number; text: string }[] }
    expect(r.sha256).toBe(sha)
    expect(r.pages[0]?.text).toMatch(/Electrical Characteristics/)
  })

  it('says so when the gateway names no tool', async () => {
    expect(await handler({}, {})).toEqual({ trace: 1, ok: false, error: 'no tool name in the call (bedrockAgentCoreToolName)' })
  })
})

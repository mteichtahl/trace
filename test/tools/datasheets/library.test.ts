import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bridge } from '../../../src/core/bridge.js'
import { Central } from '../../../src/core/central.js'
import { ToolError, Registry } from '../../../src/core/registry.js'
import { DownloadError, downloadPdf, guardedFetch, isPrivateAddress } from '../../../src/tools/datasheets/download.js'
import { DatasheetLibrary } from '../../../src/tools/datasheets/library.js'
import { mpnKey, mpnLoose, packagingBase } from '../../../src/tools/datasheets/mpn.js'
import { tools } from '../../../src/tools/datasheets/tools.js'
import { FakeS3 } from '../../core/fake-s3.js'
import { fixtureBytes, fixturePdf } from './fixture.js'

const ctx = { hardware: false, via: 'test' } as const
const home = () => mkdtempSync(join(tmpdir(), 'trace-lib-'))
const reg = new Registry(tools)
const call = <T = Record<string, unknown>>(name: string, args: Record<string, unknown>) => reg.call(name, args, ctx) as Promise<T>

afterAll(() => bridge().close())

describe('mpn keys', () => {
  it('normalises case, whitespace and dashes only', () => {
    expect(mpnKey(' lm5069mm-1/nopb ')).toBe('LM5069MM-1/NOPB')
    expect(mpnKey('LM5069MM‑1/NOPB')).toBe('LM5069MM-1/NOPB')
    expect(mpnKey('TPS 62130')).toBe('TPS62130')
    expect(mpnLoose('GRM155R71C104KA88-D')).toBe('GRM155R71C104KA88D')
  })

  it('suggests packaging variants without merging them', () => {
    expect(packagingBase('TPS62130RGTR/TR')).toBe('TPS62130RGTR')
    expect(packagingBase('LM5069MM-1/NOPB')).toBe('LM5069MM-1')
    expect(packagingBase('AD8605ARTZ-REEL7')).toBe('AD8605ARTZ')
    expect(packagingBase('BC847B,215')).toBe('BC847B')
    expect(packagingBase('TPS62130')).toBeNull()
  })
})

describe('the library on a local store', () => {
  const lib = new DatasheetLibrary({ central: new Central({ home: home() }) })

  it('adds from a file, extracts text once, and is idempotent', async () => {
    const r = await lib.add({ mpn: 'tpx123', file: fixturePdf('A'), manufacturer: 'Example Semi', by: 'test' })
    expect(r.outcome).toBe('added')
    expect(r.entry.key).toBe('TPX123')
    expect(r.entry.current?.via).toBe('upload')
    expect(r.entry.current?.pages).toBe(3)
    const again = await lib.add({ mpn: 'TPX123', file: fixturePdf('A') })
    expect(again.outcome).toBe('unchanged')
    expect(again.sha256).toBe(r.sha256)
    const texts = await lib.pageTexts(r.sha256)
    expect(texts[1]).toMatch(/Electrical Characteristics/)
  })

  it('a new document becomes current, keeps history, and opens a change until acknowledged', async () => {
    const before = await lib.entry('TPX123')
    const r = await lib.add({ mpn: 'TPX123', file: fixturePdf('B') })
    expect(r.outcome).toBe('new-version')
    expect(r.entry.current?.sha256).not.toBe(before.current?.sha256)
    expect(r.entry.history.map((v) => v.sha256)).toEqual([before.current?.sha256])
    expect(r.entry.history[0]?.replaced_at).toBeTruthy()
    expect(r.entry.changed).toMatchObject({ from: before.current?.sha256, to: r.sha256 })
    expect((await lib.list({ status: 'changed' })).total).toBe(1)
    const ack = await lib.acknowledge('tpx123', 'reviewer')
    expect(ack.acknowledged).toBe(1)
    expect(ack.entry.changed).toBeNull()
    // the pinned old version is still readable
    const old = await lib.version('TPX123', before.current?.sha256.slice(0, 12))
    expect(old.pinned).toBe(true)
    expect(existsSync(await lib.localPath(old.version.sha256))).toBe(true)
  })

  it('shares one document across parts and resolves aliases', async () => {
    const r = await lib.add({ mpn: 'TPX123A', bytes: fixtureBytes('A'), aliases: ['TPX123A/TR'] })
    expect(r.outcome).toBe('added')
    const e = await lib.entry('tpx123a/tr')
    expect(e.key).toBe('TPX123A')
    await expect(lib.entry('TPX123B/TR')).rejects.toThrow(ToolError)
    await expect(lib.entry('TPX123A-REEL7')).rejects.toThrow(/TPX123A is there/)
  })

  it('finds text with page and snippet, plain and regex', async () => {
    const r = await lib.find('TPX123', 'quiescent current')
    expect(r.hits[0]).toMatchObject({ mpn: 'TPX123', page: 2, sha256: r.sha256 })
    expect(r.hits[0]?.snippet.toLowerCase()).toContain('quiescent current')
    const rx = await lib.find('TPX123', 'f\\s*SW', { regex: true })
    expect(rx.total).toBeGreaterThan(0)
    await expect(lib.find('TPX123', '(', { regex: true })).rejects.toThrow(/bad regex/)
  })

  it('retires without deleting', async () => {
    const e = await lib.retire('TPX123A')
    expect(e.status).toBe('retired')
    expect(existsSync(await lib.localPath(e.current?.sha256 ?? ''))).toBe(true)
    expect((await lib.list()).parts.map((p) => p.key)).not.toContain('TPX123A')
    expect((await lib.add({ mpn: 'TPX123A', bytes: fixtureBytes('A') })).outcome).toBe('restored')
  })

  it('refuses what is not a PDF', async () => {
    await expect(lib.add({ mpn: 'X1', bytes: new TextEncoder().encode('<html>') })).rejects.toThrow(/not a PDF/)
  })
})

describe('the library on S3', () => {
  it('two writers adding at once both land', async () => {
    const s3 = new FakeS3()
    const a = new DatasheetLibrary({ central: new Central({ home: 's3://lib/shared', s3 }) })
    const b = new DatasheetLibrary({ central: new Central({ home: 's3://lib/shared', s3 }) })
    await Promise.all([a.add({ mpn: 'PART-A', bytes: fixtureBytes('A') }), b.add({ mpn: 'PART-B', bytes: fixtureBytes('B') })])
    const keys = (await a.list()).parts.map((p) => p.key)
    expect(keys).toEqual(['PART-A', 'PART-B'])
    expect([...s3.objects.keys()].filter((k) => k.includes('/docs/')).length).toBe(2)
  })
})

describe('downloads', () => {
  const pdf = fixtureBytes('A')
  const resolveHost = async () => ['93.184.216.34']

  it('follows redirects with a browser UA and checks the magic bytes', async () => {
    const seen: { url: string; ua: string | null }[] = []
    const fetch = async (url: string, init: RequestInit) => {
      seen.push({ url, ua: new Headers(init.headers).get('user-agent') })
      if (url.endsWith('/ds')) return new Response(null, { status: 302, headers: { location: '/files/tpx123.pdf' } })
      return new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } })
    }
    const d = await downloadPdf('https://vendor.example/ds', { fetch, resolveHost })
    expect(d.filename).toBe('tpx123.pdf')
    expect(seen.map((s) => s.url)).toEqual(['https://vendor.example/ds', 'https://vendor.example/files/tpx123.pdf'])
    expect(seen[0]?.ua).toMatch(/Mozilla/)
  })

  it('refuses product pages and private addresses', async () => {
    const html = async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
    await expect(downloadPdf('https://vendor.example/p', { fetch: html, resolveHost })).rejects.toThrow(/not a PDF/)
    await expect(downloadPdf('http://169.254.169.254/latest', { fetch: html })).rejects.toThrow(/not a public address/)
    expect(isPrivateAddress('10.1.2.3')).toBe(true)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
  })

  it('reads IPv4 written inside IPv6, however it is spelled', async () => {
    for (const ip of ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:0001', '::ffff:a9fe:a9fe', '::127.0.0.1', '::a00:1', '64:ff9b::a9fe:a9fe',
      '::', '::1', 'fd00::1', 'fe80::1', 'ff02::1', 'not-an-address', '1::2::3']) expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ['::ffff:8.8.8.8', '::ffff:808:808', '2606:4700:4700::1111', '64:ff9b::808:808']) expect(isPrivateAddress(ip), ip).toBe(false)
    // what new URL() makes of a bracketed mapped address is the hex form
    const html = async () => new Response('<html>')
    expect(new URL('http://[::ffff:127.0.0.1]:9001/').hostname).toBe('[::ffff:7f00:1]')
    await expect(downloadPdf('http://[::ffff:127.0.0.1]:9001/2018-06-01/runtime/invocation/next', { fetch: html })).rejects.toThrow(/not a public address/)
  })

  it('connects only to the address it checked (a name that turns private between checks is refused)', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((_q, r) => { r.end('%PDF-1.4 secret') })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      // the name check passed (a public address), but the connection resolves localhost: refused at connect time
      await expect(guardedFetch(`http://localhost:${port}/`, { headers: {} })).rejects.toBeInstanceOf(DownloadError)
      await expect(downloadPdf(`http://localhost:${port}/`, { resolveHost: async () => ['93.184.216.34'] })).rejects.toThrow(/not a public address/)
    } finally {
      server.close()
    }
  })

  it('records a URL source in the library', async () => {
    const lib = new DatasheetLibrary({
      central: new Central({ home: home() }), resolveHost,
      fetch: async () => new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } }),
    })
    const r = await lib.add({ mpn: 'TPX123', url: 'https://vendor.example/tpx123.pdf' })
    expect(r.entry.current).toMatchObject({ via: 'url', source_url: 'https://vendor.example/tpx123.pdf', file: 'tpx123.pdf' })
  })
})

describe('tools', () => {
  const library = home()

  it('registers exactly the datasheets tools', () => {
    expect(reg.list().map((t) => t.name)).toEqual([
      'datasheets.acknowledge', 'datasheets.add', 'datasheets.find', 'datasheets.get', 'datasheets.history', 'datasheets.list',
      'datasheets.page_image', 'datasheets.params', 'datasheets.tables', 'datasheets.text',
    ])
  })

  it('add, get, list, text, history through the registry', async () => {
    const r = await call<{ outcome: string; sha256: string }>('datasheets.add', { mpn: 'TPX123', file: fixturePdf('A'), library })
    expect(r.outcome).toBe('added')
    const g = await call<{ path: string; version: { sha256: string } }>('datasheets.get', { mpn: 'tpx123', library })
    expect(readFileSync(g.path).subarray(0, 5).toString()).toBe('%PDF-')
    const l = await call<{ total: number }>('datasheets.list', { query: 'tpx', library })
    expect(l.total).toBe(1)
    const t = await call<{ pages: { page: number; text: string }[] }>('datasheets.text', { mpn: 'TPX123', pages: [1], library })
    expect(t.pages[0]?.text).toMatch(/TPX123/)
    await expect(call('datasheets.text', { mpn: 'TPX123', pages: [9], library })).rejects.toThrow(/out of range/)
    const h = await call<{ total: number }>('datasheets.history', { mpn: 'TPX123', library })
    expect(h.total).toBe(1)
  })

  it('params returns min/typ/max/unit with a citation, and raw text when it cannot parse', async () => {
    const sha = (await call<{ version: { sha256: string } }>('datasheets.get', { mpn: 'TPX123', library })).version.sha256
    const p = await call<{ rows: { symbol?: string; typ?: string | null; max?: string | null; unit?: string | null; parsed: boolean; cite: { sha256: string; page: number; mpn: string } }[] }>(
      'datasheets.params', { mpn: 'TPX123', query: 'quiescent', library })
    const row = p.rows.find((r) => r.symbol === 'IQ')
    expect(row).toMatchObject({ typ: '45', max: '70', unit: 'µA', parsed: true, cite: { mpn: 'TPX123', sha256: sha, page: 2 } })
    const tsd = await call<{ rows: { parsed: boolean; raw: string }[] }>('datasheets.params', { mpn: 'TPX123', query: 'TSD', library })
    expect(tsd.rows[0]).toMatchObject({ parsed: false })
    expect(tsd.rows[0]?.raw).toContain('see note 1')
    const pins = await call<{ total: number; rows: { raw: string }[] }>('datasheets.params', { mpn: 'TPX123', query: '^FB$', regex: true, kind: 'pins', library })
    expect(pins.rows[0]?.raw).toContain('Feedback input')
  })

  it('tables and page images', async () => {
    const t = await call<{ count: number; page: number }>('datasheets.tables', { mpn: 'TPX123', page: 2, library })
    expect(t.count).toBe(2)
    const img = await call<{ path: string; cite: { page: number } }>('datasheets.page_image', { mpn: 'TPX123', page: 3, library })
    expect(readFileSync(img.path).subarray(1, 4).toString()).toBe('PNG')
    expect(img.cite.page).toBe(3)
  })

  it('find and acknowledge', async () => {
    const f = await call<{ hits: { page: number }[] }>('datasheets.find', { mpn: 'TPX123', query: 'Efficiency vs', library })
    expect(f.hits[0]?.page).toBe(3)
    await call('datasheets.add', { mpn: 'TPX123', file: fixturePdf('B'), library })
    const a = await call<{ acknowledged: number }>('datasheets.acknowledge', { mpn: 'TPX123', library })
    expect(a.acknowledged).toBe(1)
  })
})

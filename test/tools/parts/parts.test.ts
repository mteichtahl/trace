import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Central } from '../../../src/core/central.js'
import { Registry } from '../../../src/core/registry.js'
import { PartsDb } from '../../../src/tools/parts/db.js'
import { alternatives, bomCheck, buyQuantity, lookup, parseBomCsv, unitPriceAt, type LookupOptions } from '../../../src/tools/parts/lookup.js'
import { DIGIKEY_SEARCH_URL, DIGIKEY_TOKEN_URL, digikeyOffers, resetDigikeyToken } from '../../../src/tools/parts/providers/digikey.js'
import { JLC_SEARCH_URL, jlcOffers } from '../../../src/tools/parts/providers/lcsc.js'
import { MOUSER_URL, mouserOffers } from '../../../src/tools/parts/providers/mouser.js'
import { NEXAR_API_URL, NEXAR_TOKEN_URL, nexarOffers, resetNexarToken } from '../../../src/tools/parts/providers/nexar.js'
import { http, tools } from '../../../src/tools/parts/tools.js'
import { intOrNull, priceOrNull } from '../../../src/tools/parts/types.js'
import { fixtureBytes } from '../datasheets/fixture.js'
import * as canned from './canned.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'trace-parts-'))
const allEnv = { MOUSER_API_KEY: 'mk', DIGIKEY_CLIENT_ID: 'dk', DIGIKEY_CLIENT_SECRET: 'ds', NEXAR_CLIENT_ID: 'nx', NEXAR_CLIENT_SECRET: 'ns' }

function routes(overrides: Record<string, unknown> = {}) {
  return canned.fakeFetch({
    [JLC_SEARCH_URL]: canned.jlcAnswer,
    [MOUSER_URL]: canned.mouserAnswer,
    [DIGIKEY_TOKEN_URL]: canned.digikeyToken,
    [DIGIKEY_SEARCH_URL]: canned.digikeyAnswer,
    [NEXAR_TOKEN_URL]: canned.nexarToken,
    [NEXAR_API_URL]: (r: canned.Recorded) => (r.body.includes('supSearchMpn') ? canned.nexarAnswer : canned.nexarSearchAnswer),
    ...overrides,
  })
}

beforeEach(() => { resetDigikeyToken(); resetNexarToken() })

describe('provider parsing (canned answers)', () => {
  it('lcsc', () => {
    const o = jlcOffers(canned.jlcAnswer)
    expect(o).toHaveLength(2)
    expect(o[0]).toMatchObject({ mpn: 'TPS62130RGTR', provider: 'lcsc', provider_part: 'C116592', stock: 1520, moq: 1, package: 'VQFN-16(3x3)', datasheet_url: expect.stringContaining('lcsc') })
    expect(o[0]?.price_breaks).toEqual([{ qty: 1, price: 1.92, currency: 'USD' }, { qty: 10, price: 1.71, currency: 'USD' }, { qty: 30, price: 1.55, currency: 'USD' }])
    expect(o[0]?.attributes['JLC library']).toBe('extended')
    expect(() => jlcOffers(canned.jlcError)).toThrow(/500: system busy/)
  })

  it('mouser', () => {
    const o = mouserOffers(canned.mouserAnswer)
    expect(o[0]).toMatchObject({ provider_part: '595-TPS62130RGTR', stock: 4210, moq: 1, package: 'VQFN-16' })
    expect(o[0]?.price_breaks[2]).toEqual({ qty: 100, price: 1.93, currency: 'USD' })
    expect(() => mouserOffers(canned.mouserError)).toThrow(/Invalid unique identifier/)
  })

  it('digikey: one offer per packaging variation', () => {
    const o = digikeyOffers(canned.digikeyAnswer, 'USD')
    expect(o.map((x) => x.provider_part)).toEqual(['296-38544-1-ND', '296-38544-2-ND'])
    expect(o[1]).toMatchObject({ moq: 3000, stock: 6000, lifecycle: 'Active', package: '16-VFQFN Exposed Pad' })
    expect(o[1]?.attributes['Packaging']).toBe('Tape & Reel (TR)')
  })

  it('nexar: one offer per seller, foreign-currency prices labelled', () => {
    const o = nexarOffers(canned.nexarAnswer, 'USD')
    expect(o.map((x) => x.seller)).toEqual(['Arrow Electronics', 'Farnell'])
    expect(o[0]).toMatchObject({ stock: 12000, lifecycle: expect.stringContaining('Production'), package: 'VQFN-16' })
    expect(o[1]?.price_breaks).toEqual([{ qty: 5, price: 2.6, currency: 'GBP' }])
    expect(() => nexarOffers(canned.nexarError, 'USD')).toThrow(/Monthly part limit/)
  })

  it('numbers as distributors print them', () => {
    expect(intOrNull('4,210 In Stock')).toBe(4210)
    expect(intOrNull('none')).toBeNull()
    expect(priceOrNull('$1.93')).toBe(1.93)
    expect(priceOrNull('0,123 €')).toBe(0.123)
    expect(priceOrNull('-')).toBeNull()
  })
})

describe('lookup', () => {
  const opts = (f: ReturnType<typeof routes>, extra: Partial<LookupOptions> = {}): LookupOptions => ({
    providers: ['lcsc', 'mouser', 'digikey', 'nexar'], currency: 'USD', fetch: f.fetch, env: allEnv,
    db: new PartsDb(new Central({ home: tmp() })), ...extra,
  })

  it('merges every provider, exact part first', async () => {
    const f = routes()
    const r = await lookup('tps62130rgtr', opts(f))
    expect(r.providers.map((p) => [p.provider, p.ok])).toEqual([['lcsc', true], ['mouser', true], ['digikey', true], ['nexar', true]])
    expect(new Set(r.offers.map((o) => o.provider))).toEqual(new Set(['lcsc', 'mouser', 'digikey', 'nexar']))
    expect(r.offers.map((o) => o.mpn)).not.toContain('TPS62130RGTT') // another orderable part number, not merged in
    expect((await lookup('TPS62130', opts(routes(), { providers: ['lcsc'] }))).offers.map((o) => o.mpn)).toEqual(['TPS62130RGTR', 'TPS62130RGTT']) // a base number finds its variants, in stock first
    expect(r.part).toMatchObject({ manufacturer: 'Texas Instruments', lifecycle: 'Active' })
    const mouserCall = f.calls.find((c) => c.url.startsWith(MOUSER_URL))
    expect(mouserCall?.url).toContain('apiKey=mk')
    const dk = f.calls.find((c) => c.url === DIGIKEY_SEARCH_URL)
    expect(dk?.headers.get('authorization')).toBe('Bearer dk-token')
    expect(f.calls.find((c) => c.url === DIGIKEY_TOKEN_URL)?.body).toContain('grant_type=client_credentials')
  })

  it('skips providers without credentials with a note, never an error', async () => {
    const f = routes()
    const r = await lookup('TPS62130RGTR', opts(f, { env: {} }))
    expect(r.providers).toEqual([
      { provider: 'lcsc', ok: true },
      { provider: 'mouser', ok: false, note: 'skipped: no MOUSER_API_KEY set' },
      { provider: 'digikey', ok: false, note: 'skipped: no DIGIKEY_CLIENT_ID / DIGIKEY_CLIENT_SECRET set' },
      { provider: 'nexar', ok: false, note: 'skipped: no NEXAR_CLIENT_ID / NEXAR_CLIENT_SECRET set' },
    ])
    expect(f.calls.every((c) => c.url === JLC_SEARCH_URL)).toBe(true)
  })

  it('a failing provider is reported and the others still answer', async () => {
    const f = routes({ [NEXAR_API_URL]: canned.nexarError })
    const r = await lookup('TPS62130RGTR', opts(f))
    expect(r.providers.find((p) => p.provider === 'nexar')).toMatchObject({ ok: false, note: expect.stringContaining('Monthly part limit') })
    expect(r.offers.length).toBeGreaterThan(0)
  })

  it('answers from the central parts database within the TTL', async () => {
    const f = routes()
    const o = opts(f, { providers: ['lcsc'] })
    await lookup('TPS62130RGTR', o)
    const n = f.calls.length
    const again = await lookup('TPS62130RGTR', o)
    expect(f.calls.length).toBe(n)
    expect(again.providers[0]).toMatchObject({ cached: true })
    await lookup('TPS62130RGTR', { ...o, fresh: true })
    expect(f.calls.length).toBe(n + 1)
  })
})

describe('BOM check', () => {
  it('prices at quantity × boards, respects MOQ, flags stock and lifecycle', async () => {
    const out = { ...canned.jlcAnswer, data: { componentPageInfo: { list: [{ ...canned.jlcAnswer.data?.componentPageInfo?.list?.[0], componentCode: 'C999', componentModelEn: 'OUT1', stockCount: 0 }] } } }
    const short = { ...canned.jlcAnswer, data: { componentPageInfo: { list: [{ ...canned.jlcAnswer.data?.componentPageInfo?.list?.[0], componentCode: 'C998', componentModelEn: 'SHORT1', stockCount: 15, leastPatchNumber: 1 }] } } }
    const f = canned.fakeFetch({
      [JLC_SEARCH_URL]: (r: canned.Recorded) => {
        const kw = (JSON.parse(r.body) as { keyword: string }).keyword
        if (kw === 'OUT1') return out
        if (kw === 'SHORT1') return short
        if (kw === 'NOPE') return { code: 200, data: { componentPageInfo: { list: [] } } }
        return canned.jlcAnswer
      },
    })
    const rows = parseBomCsv('MPN,Qty,LCSC,Designator\r\nTPS62130RGTR,2,C116592,"U1,U2"\nOUT1,1,,R1\nSHORT1,4,,"C1,C2,C3,C4"\nNOPE,1,,X1\n')
    expect(rows[0]).toEqual({ mpn: 'TPS62130RGTR', qty: 2, lcsc: 'C116592', refs: 'U1,U2' })
    const r = await bomCheck(rows, 5, { providers: ['lcsc'], currency: 'USD', fetch: f.fetch, env: {}, db: new PartsDb(new Central({ home: tmp() })) })
    const [a, b, c, d] = r.lines
    expect(a).toMatchObject({ need: 10, buy: 10, unit_price: 1.71, line_total: 17.1, status: 'ok' }) // 2 × 5 boards reaches the 10+ break
    expect(b).toMatchObject({ status: 'out', flags: ['out-of-stock'] })
    expect(c).toMatchObject({ need: 20, status: 'short', note: expect.stringContaining('5 short') })
    expect(d).toMatchObject({ status: 'not-found' })
    expect(r.counts).toMatchObject({ ok: 1, out: 1, short: 1, 'not-found': 1 })
    expect(r.blocking).toBe(3)
    // total = every priced line: 17.10 + out (1 × 5 at 1.92 = 9.60) + short (20 at 1.71 = 34.20)
    expect(r.total).toBe(60.9)
  })

  it('MOQ and first break raise what is bought; foreign currency is kept out of the total', () => {
    expect(buyQuantity(7, 3000, [{ qty: 3000, price: 1.21, currency: 'USD' }])).toBe(3000)
    expect(buyQuantity(7, null, [{ qty: 10, price: 1, currency: 'USD' }])).toBe(10)
    expect(unitPriceAt(99, [{ qty: 1, price: 3, currency: 'USD' }, { qty: 100, price: 2, currency: 'USD' }])?.price).toBe(3)
    expect(unitPriceAt(0, [{ qty: 1, price: 3, currency: 'USD' }])).toBeNull()
  })

  it('flags end of life and other currencies', async () => {
    const eol = { ...canned.mouserAnswer, SearchResults: { Parts: [{ ...canned.mouserAnswer.SearchResults?.Parts?.[0], LifecycleStatus: 'Obsolete', PriceBreaks: [{ Quantity: 1, Price: '2,00 €', Currency: 'EUR' }] }] } }
    const f = canned.fakeFetch({ [MOUSER_URL]: eol })
    const r = await bomCheck([{ mpn: 'TPS62130RGTR', qty: 1 }], 1, { providers: ['mouser'], currency: 'USD', fetch: f.fetch, env: allEnv, db: new PartsDb(new Central({ home: tmp() })) })
    expect(r.lines[0]?.flags).toEqual(expect.arrayContaining(['end-of-life', 'other-currency']))
    expect(r.lines[0]?.line_total).toBeNull()
    expect(r.total).toBe(0)
    expect(r.unpriced).toBe(1)
  })
})

describe('alternatives', () => {
  it('same package and key attributes, marked for review, never the part itself', async () => {
    const f = routes()
    const r = await alternatives('TPS62130RGTR', { providers: ['digikey', 'nexar'], currency: 'USD', fetch: f.fetch, env: allEnv, db: new PartsDb(new Central({ home: tmp() })), in_stock: false })
    const names = r.candidates.map((c) => c.mpn)
    expect(names).not.toContain('TPS62130RGTT')
    expect(names).not.toContain('LMR33630') // another package
    expect(names).not.toContain('TPS62130A') // a key attribute differs
    expect(r.note).toMatch(/drop-in/)
    for (const c of r.candidates) expect(c.review).toMatch(/engineer/)
  })
})

describe('tools', () => {
  const reg = new Registry(tools)
  const ctx = { hardware: false, via: 'test' } as const
  let home: string
  beforeEach(() => {
    home = tmp()
    process.env.TRACE_HOME = home
  })
  afterEach(() => { http.fetch = undefined; http.resolveHost = undefined })

  it('registers exactly the parts tools', () => {
    expect(reg.list().map((t) => t.name)).toEqual(['parts.alternatives', 'parts.bom_check', 'parts.fetch_datasheet', 'parts.lookup', 'parts.search'])
  })

  it('lookup and bom_check (path) through the registry, default provider lcsc', async () => {
    http.fetch = routes().fetch
    const r = await reg.call('parts.lookup', { mpn: 'TPS62130RGTR' }, ctx) as { total: number; providers: { provider: string }[] }
    expect(r.providers.map((p) => p.provider)).toEqual(['lcsc'])
    expect(r.total).toBe(1)
    const bom = join(tmp(), 'bom.csv')
    writeFileSync(bom, 'MPN,Qty\nTPS62130RGTR,1\n')
    const b = await reg.call('parts.bom_check', { path: bom, boards: 30 }, ctx) as { total: number; lines: { buy: number; unit_price: number }[] }
    expect(b.lines[0]).toMatchObject({ buy: 30, unit_price: 1.55 })
    expect(b.total).toBe(46.5)
  })

  it('fetch_datasheet adds the provider\'s datasheet to the shared library and links it', async () => {
    const pdf = fixtureBytes('A')
    http.fetch = routes({ 'https://www.lcsc.com/datasheet/': new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } }) }).fetch
    http.resolveHost = async () => ['93.184.216.34']
    const r = await reg.call('parts.fetch_datasheet', { mpn: 'TPS62130RGTR', library: home }, ctx) as { outcome: string; sha256: string; source_url: string }
    expect(r.outcome).toBe('added')
    expect(r.source_url).toContain('lcsc_datasheet_TPS62130.pdf')
    const linked = await new PartsDb(new Central({ home })).part('TPS62130RGTR')
    expect(linked?.datasheet_sha256).toBe(r.sha256)
  })
})

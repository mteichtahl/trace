/**
 * The price table from the AWS price list (src/core/price-list.ts, src/core/prices-store.ts, the cost Lambda's
 * refreshPrices): real product records mapped onto the table, what it lacks filled from the built-in table and said,
 * the precedence (overrides, fetched, built-in), the file the Lambda writes and the readers' cache, each ledger row's
 * source, and the screens' line when the prices are fetched, old, or could not be fetched.
 *
 * The fixtures are product records copied from the public AWS price list files (the same records GetProducts returns,
 * there as one JSON string each): test/core/fixtures/price-list-bedrock.json (Claude on Bedrock in us-east-1, October
 * 2026) and price-list-ec2.json (g6.xlarge and c7i.xlarge on demand in us-east-1). No test calls AWS.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { pricesView } from '../../src/api/actions-cost.js'
import { backendFor } from '../../src/core/central.js'
import { CostLedger, estimateTotals, loadUsage, modelRows, recordModelUse } from '../../src/core/cost.js'
import {
  type PriceListProduct, askedType, ec2Filters, instancePrice, matchKey, modelsFromPriceList, namesModel, parsePriceList, pricingEndpoint, variantOf,
} from '../../src/core/price-list.js'
import { DEFAULT_PRICES, type PriceTable, jobCost, modelCost, modelPrice, resolvePrices } from '../../src/core/prices.js'
import { CACHE_MS, PRICES_KEY, type PriceFile, clearPriceCache, fetchedPrices, installationFromEnv, pricesFor, readPriceFile } from '../../src/core/prices-store.js'
import { fetchPriceTable, refreshPrices, nextDaily, type PricingApi } from '../../src/infra/lambda/cost-explorer.js'
import { FakeS3 } from './fake-s3.js'

const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'trace-prices-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
beforeEach(() => clearPriceCache())

const fixture = (name: string): string[] =>
  (JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as { PriceList: unknown[] }).PriceList.map((p) => JSON.stringify(p))
// as GetProducts answers: PriceList is a list of JSON strings
const BEDROCK = fixture('price-list-bedrock.json')
const EC2 = fixture('price-list-ec2.json')
const products = (list: string[]): PriceListProduct[] => parsePriceList(list)
const NOW = Date.parse('2026-10-27T06:20:00Z')

describe('the price list mapped onto the table', () => {
  it('reads the model, the variant and the field from real Claude records, per million tokens', () => {
    expect(matchKey('Claude Sonnet 4.6')).toBe('claude-sonnet-4-6')
    expect(matchKey('Claude 3.7 Sonnet')).toBe('claude-3-7-sonnet')
    expect(matchKey('Claude Opus 4.7')).toBe('claude-opus-4-7')
    // names no model id contains are left out
    expect(matchKey('Claude 3.5 Sonnet v2')).toBeNull()
    expect(matchKey('Claude Mythos Preview')).toBeNull()
    expect(variantOf('USE1-MP:USE1_InputTokenCount-Units')).toBe('regional')
    expect(variantOf('USE1-MP:USE1_InputTokenCount_Global-Units')).toBe('global')
    expect(variantOf('USE1-MP:USE1_input_tokens_global_standard-Units')).toBe('global')
    expect(variantOf('USE1-MP:USE1_input_tokens_standard-Units')).toBe('regional')
    // what trace does not use: batch, the 1-hour cache write, long context
    for (const u of ['USE1-MP:USE1_InputTokenCount_Batch-Units', 'USE1-MP:USE1_CacheWrite1hInputTokenCount-Units', 'USE1-MP:USE1_input_tokens_long_ctx_global_standard-Units', 'USE1-MP:USE1_cache_write_tokens_1h_standard-Units']) expect(variantOf(u)).toBeNull()
    expect(parsePriceList(['not json', '{"product":1}', ...BEDROCK.slice(0, 1)])).toHaveLength(1)
  })

  it('gives each model its global prices and its in-region ones, for the configured models and the current family', () => {
    const { models, notes } = modelsFromPriceList(products(BEDROCK), { region: 'us-east-1', models: ['us.anthropic.claude-sonnet-4-6'] })
    const by = Object.fromEntries(models.map((m) => [m.match, m]))
    // the price list's own figures (test/core/fixtures/price-list-bedrock.json)
    expect(by['claude-sonnet-4-6']).toMatchObject({ input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3, inRegion: { input: 3.3, output: 16.5, cacheWrite: 4.125, cacheRead: 0.33 }, regional: 1 })
    expect(by['claude-opus-4-7']).toMatchObject({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, inRegion: { input: 5.5, output: 27.5, cacheWrite: 6.875, cacheRead: 0.55 } })
    // the configured model first
    expect(models[0]?.match).toBe('claude-sonnet-4-6')
    // a 3.x model nobody configured is not taken; Claude 3.5 Sonnet (input and output only) neither
    expect(by['claude-3-7-sonnet']).toBeUndefined()
    expect(by['claude-3-5-sonnet']).toBeUndefined()
    // Haiku 5.5's records here are long context only: nothing trace uses, so no entry and no note
    expect(by['claude-haiku-5-5']).toBeUndefined()
    expect(notes).toEqual([])
    // the batch record in the fixture did not change the on-demand price
    expect(by['claude-sonnet-4-6']?.input).toBe(3)
  })

  it('takes an older model when it is configured, and says what the price list lacked and what was used instead', () => {
    const { models, notes } = modelsFromPriceList(products(BEDROCK), { region: 'us-east-1', models: ['us.anthropic.claude-3-5-sonnet-20240620-v1:0', 'anthropic.claude-3-7-sonnet-20250219-v1:0'] })
    const by = Object.fromEntries(models.map((m) => [m.match, m]))
    // 3.7 Sonnet: all four fields, in-region only (the same price in-region and global)
    expect(by['claude-3-7-sonnet']).toMatchObject({ input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3, regional: 1 })
    expect(by['claude-3-7-sonnet']?.inRegion).toBeUndefined()
    // 3.5 Sonnet: input and output from the price list, no built-in entry for its cache prices: left out, and said
    expect(by['claude-3-5-sonnet']).toBeUndefined()
    expect(notes.join(' ')).toMatch(/Claude 3\.5 Sonnet: the price list has no cache write or cache read price and the built-in table has no entry for it/)
    // no cache prices and no built-in entry of that name (claude-sonnet-4-6): left out, and said
    const noCache = products(BEDROCK).filter((p) => !(p.product.attributes.model === 'Claude Sonnet 4.6' && /cache/i.test(p.product.attributes.inferenceType ?? '')))
    const withBuiltIn = modelsFromPriceList(noCache, { region: 'us-east-1', models: [] })
    expect(withBuiltIn.models.find((m) => m.match === 'claude-sonnet-4-6')).toBeUndefined()
    expect(withBuiltIn.notes.join(' ')).toMatch(/Claude Sonnet 4\.6: the price list has no cache write or cache read price/)
  })

  it('fills a missing field from the built-in entry of the same match, never inventing one', () => {
    const noCacheRead = products(BEDROCK).filter((p) => !(p.product.attributes.model === 'Claude Opus 4.7' && p.product.attributes.inferenceType === 'Prompt cache read input tokens'))
      .map((p) => (p.product.attributes.model === 'Claude Opus 4.7' ? { ...p, product: { ...p.product, attributes: { ...p.product.attributes, model: 'Claude Opus 4.5' } } } : p))
    const { models, notes } = modelsFromPriceList(noCacheRead, { region: 'us-east-1', models: [] })
    const opus = models.find((m) => m.match === 'claude-opus-4-5')
    // the built-in claude-opus-4-5 cache read (0.5 global; x1.1 in-region)
    expect(opus).toMatchObject({ input: 5, cacheRead: DEFAULT_PRICES.models.find((m) => m.match === 'claude-opus-4-5')!.cacheRead, filled: ['cacheRead'], inRegion: { cacheRead: 0.55 } })
    expect(notes).toEqual([`Claude Opus 4.5: the price list has no cache read price; the built-in table's (${DEFAULT_PRICES.asOf}) is used for it.`])
  })

  it('says when a configured model is not in the price list (a newly released one), and leaves it to the built-in table', () => {
    const { notes } = modelsFromPriceList(products(BEDROCK), { region: 'us-east-1', models: ['global.anthropic.claude-sonnet-4-6', 'us.anthropic.claude-opus-9-1-v1:0', 'amazon.titan-embed-text-v2:0'] })
    expect(notes).toEqual(['us.anthropic.claude-opus-9-1-v1:0: the price list for us-east-1 has no entry for this model, so it is priced by the closest entry the table has (the longest name it starts with), or by the Agent SDK\'s own figure when there is none.'])
    expect(namesModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5')).toBe(true)
    expect(namesModel('us.anthropic.claude-opus-4-8', 'claude-opus-4')).toBe(false)
  })

  it('leaves out another region\'s records', () => {
    expect(modelsFromPriceList(products(BEDROCK), { region: 'ap-southeast-2', models: [] }).models).toEqual([])
  })

  it('prices the Batch pools from EC2 on demand: the GPU instance per hour, the CPU family per vCPU', () => {
    expect(instancePrice(products(EC2), 'g6.xlarge', 'us-east-1')).toEqual({ perHour: 0.8048, vcpus: 4 })
    expect(instancePrice(products(EC2), 'c7i.xlarge', 'us-east-1')).toEqual({ perHour: 0.1785, vcpus: 4 })
    expect(instancePrice(products(EC2), 'g6.xlarge', 'eu-west-1')).toBeNull()
    expect(askedType('c7i')).toBe('c7i.xlarge')
    expect(askedType('g6.xlarge')).toBe('g6.xlarge')
    expect(ec2Filters('g6.xlarge', 'us-east-1').map((f) => `${f.Field}=${f.Value}`)).toEqual([
      'instanceType=g6.xlarge', 'regionCode=us-east-1', 'operatingSystem=Linux', 'tenancy=Shared', 'preInstalledSw=NA', 'capacitystatus=Used', 'licenseModel=No License required', 'marketoption=OnDemand',
    ])
    expect(pricingEndpoint('ap-southeast-2')).toBe('ap-south-1')
    expect(pricingEndpoint('eu-west-1')).toBe('eu-central-1')
    expect(pricingEndpoint('us-west-2')).toBe('us-east-1')
    expect(pricingEndpoint('ca-central-1')).toBe('us-east-1')
  })
})

/** A fake Price List client: answers from the fixtures by service code, a page at a time; `fail` refuses. */
function fakePricing(o: { fail?: string; pageSize?: number } = {}): { api: PricingApi; asked: { ServiceCode?: string | undefined; Filters?: unknown; NextToken?: string | undefined }[] } {
  const asked: { ServiceCode?: string | undefined; Filters?: unknown; NextToken?: string | undefined }[] = []
  const size = o.pageSize ?? 10
  return {
    asked,
    api: {
      getProducts: async (i) => {
        asked.push({ ServiceCode: i.ServiceCode, Filters: i.Filters, NextToken: i.NextToken })
        if (o.fail) throw Object.assign(new Error(o.fail), { name: 'AccessDeniedException' })
        const all = i.ServiceCode === 'AmazonEC2'
          ? EC2.filter((s) => (i.Filters ?? []).every((f) => f.Field !== 'instanceType' || s.includes(`"instanceType":"${f.Value}"`)))
          : BEDROCK
        const from = Number(i.NextToken ?? 0)
        return { PriceList: all.slice(from, from + size), ...(from + size < all.length ? { NextToken: String(from + size) } : {}) }
      },
    },
  }
}

describe('the daily price refresh (the cost Lambda)', () => {
  const deps = (s3: FakeS3, api: PricingApi, now = NOW) => ({
    pricing: api, endpoint: 'us-east-1', bucket: 'b', region: 'us-east-1', models: ['us.anthropic.claude-sonnet-4-6'],
    gpuTypes: ['g6.xlarge', 'g5.xlarge'], cpuTypes: ['c7i', 'c6i'], nextAt: nextDaily(6, 17), now: () => now, s3, log: () => undefined,
  })

  it('asks GetProducts for Claude in the region and the pools\' first instances, page by page, and writes the dated table', async () => {
    const s3 = new FakeS3()
    const p = fakePricing()
    const file = await refreshPrices(deps(s3, p.api))
    expect(p.asked[0]).toMatchObject({ ServiceCode: 'AmazonBedrockFoundationModels', Filters: [{ Type: 'TERM_MATCH', Field: 'provider', Value: 'Anthropic' }, { Type: 'TERM_MATCH', Field: 'regionCode', Value: 'us-east-1' }, { Type: 'TERM_MATCH', Field: 'feature', Value: 'On-demand Inference' }] })
    // three pages of ten for the 29 records, then one query per pool
    expect(p.asked.map((a) => [a.ServiceCode, a.NextToken ?? null])).toEqual([['AmazonBedrockFoundationModels', null], ['AmazonBedrockFoundationModels', '10'], ['AmazonBedrockFoundationModels', '20'], ['AmazonEC2', null], ['AmazonEC2', null]])
    expect(JSON.stringify(p.asked[3]?.Filters)).toContain('g6.xlarge')
    expect(JSON.stringify(p.asked[4]?.Filters)).toContain('c7i.xlarge')
    expect(file).toMatchObject({ fetchedAt: NOW / 1000, region: 'us-east-1', endpoint: 'us-east-1', tried: { ok: true, error: null }, nextAt: Date.parse('2026-10-28T06:17:00Z') / 1000 })
    expect(file.table).toMatchObject({ asOf: '2026-10-27', gpu: { perHour: 0.8048, basis: 'g6.xlarge on demand in us-east-1 (one job holds the instance)' }, cpu: { perVcpuHour: 0.044625 } })
    expect(file.table?.sources).toEqual(['https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html'])
    // what the workers and the API read back
    const read = await readPriceFile(backendFor('s3://b/installation', s3))
    expect(read).toEqual(file)
    expect([...s3.objects.keys()]).toEqual([`b/installation/${PRICES_KEY}`])
  })

  it('keeps the last good table when the price list cannot be read, and says why and when it tries next', async () => {
    const s3 = new FakeS3()
    await refreshPrices(deps(s3, fakePricing().api))
    const later = NOW + 86_400_000
    const file = await refreshPrices(deps(s3, fakePricing({ fail: 'User is not authorized to perform: pricing:GetProducts' }).api, later))
    expect(file.table?.asOf).toBe('2026-10-27')
    expect(file.fetchedAt).toBe(NOW / 1000)
    expect(file.tried).toEqual({ at: later / 1000, ok: false, error: 'AccessDeniedException: User is not authorized to perform: pricing:GetProducts' })
    // a first fetch that fails: no table, the reason
    const fresh = await refreshPrices(deps(new FakeS3(), fakePricing({ fail: 'throttled' }).api))
    expect(fresh).toMatchObject({ table: null, fetchedAt: null, tried: { ok: false } })
  })

  it('keeps the built-in price of a pool the price list does not answer, and says so', async () => {
    const out = await fetchPriceTable({ ...deps(new FakeS3(), fakePricing().api), gpuTypes: ['g4dn.xlarge'], cpuTypes: [] }, NOW)
    expect(out.table.gpu).toMatchObject({ perHour: DEFAULT_PRICES.gpu.perHour, source: 'built-in', asOf: DEFAULT_PRICES.asOf })
    expect(out.table.cpu).toMatchObject({ source: 'built-in' })
    expect(out.notes).toContain('The price list has no on-demand price for g4dn.xlarge in us-east-1; the graphics card pool keeps the built-in price.')
    expect(out.notes).toContain('There is no CPU pool; its built-in price is kept.')
  })
})

describe('precedence: the admin\'s overrides, the fetched table, the built-in one', () => {
  const fetched = async (): Promise<PriceTable> => (await fetchPriceTable({
    pricing: fakePricing().api, endpoint: 'us-east-1', region: 'us-east-1', models: [], gpuTypes: ['g6.xlarge'], cpuTypes: ['c7i'], now: () => NOW, log: () => undefined,
  }, NOW)).table

  it('prices each model from the highest source that has it, and records the source and date on the row', async () => {
    const f = await fetched()
    const t = resolvePrices(f, { asOf: '2026-10-20', models: [{ match: 'claude-opus-4-7', input: 4, output: 20, cacheWrite: 5, cacheRead: 0.4, regional: 1 }] })
    expect(t.asOf).toBe('2026-10-20')
    // the override
    expect(modelPrice(t, 'global.anthropic.claude-opus-4-7')).toMatchObject({ input: 4, source: 'override', asOf: '2026-10-20' })
    // the fetched price list, global and in-region
    expect(modelPrice(t, 'us.anthropic.claude-sonnet-4-6')).toMatchObject({ source: 'fetched', asOf: '2026-10-27' })
    const tok = { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 }
    expect(modelCost(t, 'global.anthropic.claude-sonnet-4-6', tok)).toMatchObject({ amount: 4.5, by: { source: 'fetched', asOf: '2026-10-27' } })
    expect(modelCost(t, 'us.anthropic.claude-sonnet-4-6', tok)).toMatchObject({ amount: 4.95 })
    // the built-in table, for what the price list did not give (here: Sonnet 4.5 is not in the fixture)
    expect(modelPrice(t, 'us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toMatchObject({ match: 'claude-sonnet-4-5', source: 'built-in', asOf: DEFAULT_PRICES.asOf })
    // the pools: fetched
    expect(t.gpu).toMatchObject({ perHour: 0.8048, source: 'fetched' })
    expect(jobCost(t, 'cpu', 3600, 16)).toBeCloseTo(16 * 0.044625, 6)
    // the same match from two sources: the higher one wins
    const both = resolvePrices({ ...f, models: [{ match: 'claude-sonnet-4-5', input: 9, output: 9, cacheWrite: 9, cacheRead: 9, regional: 1 }] }, null)
    expect(modelPrice(both, 'anthropic.claude-sonnet-4-5')).toMatchObject({ input: 9, source: 'fetched' })
    // no fetched table, no overrides: the built-in one
    expect(resolvePrices(null, null).models.every((m) => m.source === 'built-in')).toBe(true)
    const rows = modelRows(t, [{ model: 'us.anthropic.claude-sonnet-4-6', tokens: tok, sdkCost: null }, { model: 'us.anthropic.claude-opus-4-7', tokens: tok, sdkCost: null }, { model: 'x.unknown', tokens: tok, sdkCost: 1 }], { at: 1, jobId: 'j', agent: 'a', region: 'us-east-1' })
    expect(rows.map((r) => [r.pricesSource, r.pricesAsOf])).toEqual([['fetched', '2026-10-27'], ['override', '2026-10-20'], [null, null]])
    expect(estimateTotals(rows).bySource).toEqual({ fetched: 1, override: 1, sdk: 1 })
  })

  it('reads the fetched file once an hour per container, and the worker\'s ledger prices with it', async () => {
    const s3 = new FakeS3()
    await refreshPrices({ pricing: fakePricing().api, endpoint: 'us-east-1', bucket: 'b', region: 'us-east-1', models: [], gpuTypes: ['g6.xlarge'], cpuTypes: ['c7i'], nextAt: nextDaily(6, 17), now: () => NOW, s3, log: () => undefined })
    const store = backendFor('s3://b/installation', s3)
    let gets = 0
    const counting = { ...store, url: store.url, get: async (k: string) => { gets++; return store.get(k) } } as typeof store
    expect((await fetchedPrices(counting, { now: NOW })).file?.table?.asOf).toBe('2026-10-27')
    await fetchedPrices(counting, { now: NOW + CACHE_MS - 1 })
    expect(gets).toBe(1)
    await fetchedPrices(counting, { now: NOW + CACHE_MS })
    expect(gets).toBe(2)
    // a file that cannot be read: the built-in table, and why
    clearPriceCache()
    const broken = { ...store, url: 'broken', get: async () => { throw new Error('AccessDenied') } } as typeof store
    const p = await pricesFor({ TRACE_PRICES: JSON.stringify({ asOf: '2026-10-01', gpu: { perHour: 1.2, basis: 'negotiated' } }) }, { store: broken })
    expect(p.fetched.error).toBe('AccessDenied')
    expect(p.table.gpu).toMatchObject({ perHour: 1.2, source: 'override' })
    expect(p.table.cpu).toMatchObject({ source: 'built-in' })
    // the worker: TRACE_HOME's installation prefix, and each row's source
    expect(installationFromEnv({ TRACE_HOME: 's3://bucket/central' })).toBe('s3://bucket/installation')
    clearPriceCache()
    const ledger = new CostLedger(backendFor(join(tmp(), 'projects')), 'acme/board', { scratch: tmp() })
    const t = (await pricesFor({}, { store })).table
    await recordModelUse([{ model: 'us.anthropic.claude-sonnet-4-6', tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, sdkCost: 3 }], { jobId: 'j', agent: 'verify', env: { AWS_REGION: 'us-east-1' }, ledger, prices: t })
    const row = (await ledger.read((db) => loadUsage(db))).result[0]
    expect(row).toMatchObject({ amount: 3.3, pricesSource: 'fetched', pricesAsOf: '2026-10-27' })
  })
})

describe('the screens\' line about the prices', () => {
  const file = (o: Partial<PriceFile> = {}): PriceFile => ({
    version: 1, table: { ...DEFAULT_PRICES, asOf: '2026-10-27', models: [] }, fetchedAt: NOW / 1000, region: 'us-east-1', endpoint: 'us-east-1', notes: [],
    tried: { at: NOW / 1000, ok: true, error: null }, nextAt: Date.parse('2026-10-28T06:17:00Z') / 1000, ...o,
  })
  const use = (f: PriceFile | null, error: string | null = null) => ({ table: resolvePrices(f?.table ?? null, null), fetched: { file: f, error }, overrides: null })

  it('says the prices are from the AWS price list, when they were fetched and when next', () => {
    const v = pricesView(use(file()), { now: NOW, by: { fetched: 3, 'built-in': 1 }, enabled: true })
    expect(v).toMatchObject({ source: 'price-list', status: 'met', asOf: '2026-10-27', stale: false, fetchedAt: '2026-10-27T06:20:00.000Z' })
    expect(v.text).toMatch(/^Estimates use prices from the AWS price list, fetched 2026-10-27 for us-east-1 \(/)
    expect(v.text).toMatch(/Next fetch 2026-10-28 06:17 UTC\. Priced here: 3 from the AWS price list, 1 from the built-in table\.$/)
  })

  it('warns when the latest fetch failed, keeping the last prices, with why and the next try', () => {
    const v = pricesView(use(file({ tried: { at: NOW / 1000 + 86400, ok: false, error: 'AccessDeniedException: not authorized' } })), { now: NOW, enabled: true })
    expect(v).toMatchObject({ source: 'price-list', status: 'warning' })
    expect(v.text).toMatch(/The latest fetch, 2026-10-28 06:20 UTC, failed \(AccessDeniedException: not authorized\), so these are the last prices fetched; next try 2026-10-28 06:17 UTC\./)
  })

  it('warns when the built-in table is in use because the fetch failed, and says why and when it tries again', () => {
    const v = pricesView(use(file({ table: null, fetchedAt: null, tried: { at: NOW / 1000, ok: false, error: 'ThrottlingException: Rate exceeded' } })), { now: NOW, enabled: true })
    expect(v).toMatchObject({ source: 'built-in', status: 'warning', asOf: DEFAULT_PRICES.asOf })
    expect(v.text).toMatch(new RegExp(`^Estimates use the built-in price table of ${DEFAULT_PRICES.asOf} \\(.*\\): the AWS price list could not be fetched 2026-10-27 06:20 UTC \\(ThrottlingException: Rate exceeded\\)\\. Next try 2026-10-28 06:17 UTC\\.`))
    // the built-in table is more than six months old by then
    expect(v.stale).toBe(true)
    expect(v.text).toMatch(/The built-in table is more than six months old\.$/)
  })

  it('says when it has not been fetched yet, or is off, or the file cannot be read; and when an admin\'s prices come first', () => {
    expect(pricesView(use(null), { now: NOW, enabled: true }).text).toMatch(/: the AWS price list has not been fetched yet\. It is fetched once a day with the Cost Explorer read/)
    expect(pricesView(use(null), { now: NOW, enabled: false }).text).toMatch(/fetching prices from the AWS price list is off \(the stack setting cost\.priceList\.enabled\)/)
    expect(pricesView(use(null, 'AccessDenied'), { now: NOW, enabled: true })).toMatchObject({ status: 'warning', text: expect.stringMatching(/the fetched price list could not be read \(AccessDenied\)/) })
    const o = { table: resolvePrices(file().table, { asOf: '2026-10-01', gpu: { perHour: 1.2, basis: 'negotiated' } }), fetched: { file: file(), error: null }, overrides: { asOf: '2026-10-01' } }
    expect(pricesView(o, { now: NOW, enabled: true })).toMatchObject({ overrides: true, text: expect.stringMatching(/Prices an admin set with the stack setting cost\.prices \(of 2026-10-01\) come first\./) })
    const lacking = pricesView(use(file({ notes: ['Claude Opus 4.5: the price list has no cache read price; the built-in table\'s (2025-11-24) is used for it.'] })), { now: NOW, enabled: true })
    expect(lacking.text).toMatch(/The price list lacks one entry; the built-in table's prices are used for it \(see the notes\)\./)
    expect(lacking.notes).toHaveLength(1)
  })
})

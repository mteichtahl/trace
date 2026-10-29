/**
 * Cloud cost per project (src/core/prices.ts, src/core/cost.ts, src/infra/lambda/cost-explorer.ts): the dated price
 * table and its overrides, pricing a run per model and a job by its running time, the ledger written by the worker and
 * read by the API, recording from the Agent SDK's result and from a Batch job's times, and the daily Cost Explorer
 * read with its tag activation and its plain-words status.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { modelUsesOf } from '../../src/agents/runtime/job.js'
import { backendFor } from '../../src/core/central.js'
import {
  ActualsStore, CostLedger, actualTotals, estimateTotals, jobRow, loadActuals, loadExplorerStatus, loadUsage, modelRows, recordModelUse, recordUsage, usageLine,
} from '../../src/core/cost.js'
import { DEFAULT_PRICES, PriceOverridesSchema, ageDays, bareModel, isStale, jobCost, mergePrices, modelCost, modelPrice, pricesFromEnv } from '../../src/core/prices.js'
import { batchCostRow } from '../../src/gpu/batch.js'
import { LOOKBACK_DAYS, nextDaily, readCosts, statusMessage, window } from '../../src/infra/lambda/cost-explorer.js'
import { FakeS3 } from './fake-s3.js'

const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'trace-cost-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('the price table', () => {
  it('is dated, prices models by the longest match without their routing prefix, and adds the regional premium', () => {
    expect(DEFAULT_PRICES.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(bareModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('anthropic.claude-sonnet-4-5-20250929-v1:0')
    expect(modelPrice(DEFAULT_PRICES, 'us.anthropic.claude-sonnet-4-5-20250929-v1:0')?.match).toBe('claude-sonnet-4-5')
    expect(modelPrice(DEFAULT_PRICES, 'anthropic.claude-sonnet-4-20250514-v1:0')?.match).toBe('claude-sonnet-4')
    expect(modelPrice(DEFAULT_PRICES, 'meta.llama3')).toBeNull()
    const tok = { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 0 }
    // 3 + 1.5 + 0.6 = 5.10 on a global profile, and 10% more in-region
    expect(modelCost(DEFAULT_PRICES, 'global.anthropic.claude-sonnet-4-5-v1:0', tok)).toEqual({ amount: 5.1, basis: 'table', match: 'claude-sonnet-4-5', by: { source: 'built-in', asOf: DEFAULT_PRICES.asOf } })
    expect(modelCost(DEFAULT_PRICES, 'us.anthropic.claude-sonnet-4-5-v1:0', tok).amount).toBeCloseTo(5.61, 6)
    // an unknown model falls back to the Agent SDK's own figure, else is unpriced
    expect(modelCost(DEFAULT_PRICES, 'x.unknown', tok, { sdkCost: 0.42 })).toEqual({ amount: 0.42, basis: 'sdk', match: null, by: null })
    expect(modelCost(DEFAULT_PRICES, 'x.unknown', tok)).toEqual({ amount: null, basis: 'none', match: null, by: null })
  })

  it('takes an installation\'s overrides (a model, a region-only entry, a pool, a date), and says when it is old', () => {
    const o = PriceOverridesSchema.parse({ asOf: '2026-10-01', models: [{ match: 'claude-sonnet-4-5', input: 3.3, output: 16.5, cacheWrite: 4.125, cacheRead: 0.33, regions: ['ap-southeast-2'] }], gpu: { perHour: 1.1, basis: 'g6.xlarge in Sydney' } })
    const t = mergePrices(DEFAULT_PRICES, o)
    expect(t.asOf).toBe('2026-10-01')
    expect(modelPrice(t, 'anthropic.claude-sonnet-4-5', 'ap-southeast-2')?.input).toBe(3.3)
    expect(modelPrice(t, 'anthropic.claude-sonnet-4-5', 'us-east-1')?.input).toBe(3)
    expect(jobCost(t, 'gpu', 1800, 4)).toBeCloseTo(0.55, 6)
    expect(jobCost(t, 'cpu', 3600, 16)).toBeCloseTo(16 * DEFAULT_PRICES.cpu.perVcpuHour, 6)
    expect(pricesFromEnv({ TRACE_PRICES: JSON.stringify(o) }).asOf).toBe('2026-10-01')
    expect(pricesFromEnv({ TRACE_PRICES: '{not json' })).toBe(DEFAULT_PRICES)
    expect(ageDays({ asOf: '2026-01-01' }, Date.parse('2026-01-11T12:00:00Z'))).toBe(10)
    expect(isStale({ asOf: '2025-01-01' }, Date.parse('2026-01-01T00:00:00Z'))).toBe(true)
  })
})

describe('the ledger', () => {
  it('records a run per model from the Agent SDK\'s result, and a Batch job by its running time; the API reads it back', async () => {
    const store = backendFor(join(tmp(), 'projects'))
    const ledger = new CostLedger(store, 'acme/board', { scratch: tmp() })
    const uses = modelUsesOf({
      type: 'result', subtype: 'success', total_cost_usd: 0.6,
      modelUsage: { 'us.anthropic.claude-sonnet-4-5-v1:0': { inputTokens: 100_000, outputTokens: 10_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.45 }, 'claude-haiku-4-5': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 } },
    } as never)
    expect(uses).toHaveLength(2)
    expect(await recordModelUse(uses, { jobId: 'job-1', agent: 'verify', env: { AWS_REGION: 'us-east-1' }, ledger, now: Date.parse('2026-10-20T00:00:00Z') })).toBe(true)
    const row = batchCostRow({ pool: 'gpu', detail: { status: 'SUCCEEDED', startedAt: Date.parse('2026-10-21T00:00:00Z'), stoppedAt: Date.parse('2026-10-21T00:30:00Z') }, vcpus: null, id: 'blender-1', kind: 'blender', env: { AWS_REGION: 'us-east-1' } })
    expect(row).toMatchObject({ kind: 'gpu', seconds: 1800, basis: 'table', pricesAsOf: DEFAULT_PRICES.asOf, pricesSource: 'built-in' })
    expect(batchCostRow({ pool: 'gpu', detail: { status: 'FAILED' }, vcpus: null, id: 'x', kind: 'blender', env: {} })).toBeNull()
    await recordUsage([row!], { ledger })
    const rows = (await ledger.read((db) => loadUsage(db))).result
    // the model with no tokens and no cost is left out
    expect(rows.map((r) => [r.kind, r.model ?? r.agent, r.basis])).toEqual([['agents', 'us.anthropic.claude-sonnet-4-5-v1:0', 'table'], ['gpu', 'blender', 'table']])
    expect(rows[0]?.amount).toBeCloseTo((0.3 + 0.15) * 1.1, 6)
    expect(rows[0]?.sdkCost).toBe(0.45)
    const t = estimateTotals(rows)
    expect(t.byKind.gpu).toBeCloseTo(0.4, 2)
    expect(t.total).toBe(Math.round((t.byKind.agents + t.byKind.gpu) * 100) / 100)
    expect(usageLine(rows[0]!)).toMatchObject({ kind: 'agents', estimate: true, what: expect.stringMatching(/^verify \(job job-1\): 110,000 tokens/) })
    expect(usageLine(rows[1]!).what).toBe('Graphics card job blender: 30 min')
  })

  it('never fails the run when it cannot be written', async () => {
    const broken = { update: async () => { throw new Error('denied') } } as unknown as CostLedger
    const log: string[] = []
    expect(await recordUsage([jobRow(DEFAULT_PRICES, { pool: 'cpu', seconds: 60, vcpus: 4, at: 1, jobId: 'j', kind: 'openems', region: null })], { ledger: broken, log: (l) => log.push(l) })).toBe(false)
    expect(log).toEqual(['cost: not recorded (denied)'])
    expect(await recordUsage([], { ledger: broken })).toBe(true)
  })
})

describe('the daily Cost Explorer read', () => {
  type Sent = { input: Record<string, unknown>; name: string }
  function fakeCe(o: { tags: Record<string, 'Active' | 'Inactive'>; refuse?: boolean; pages?: unknown[] }) {
    const sent: Sent[] = []
    const pages = [...(o.pages ?? [])]
    return {
      sent,
      ce: {
        send: async (c: { input: Record<string, unknown>; constructor: { name: string } }) => {
          sent.push({ input: c.input, name: c.constructor.name })
          if (c.constructor.name === 'ListCostAllocationTagsCommand') return { CostAllocationTags: Object.entries(o.tags).map(([TagKey, Status]) => ({ TagKey, Status, Type: 'UserDefined' })) }
          if (c.constructor.name === 'UpdateCostAllocationTagsStatusCommand') {
            if (o.refuse) throw Object.assign(new Error('Linked account doesn\'t have access to cost allocation tags'), { name: 'AccessDeniedException' })
            return { Errors: [] }
          }
          return pages.shift() ?? { ResultsByTime: [] }
        },
      } as never,
    }
  }
  const NOW = Date.parse('2026-10-27T07:00:00Z')

  it('activates inactive tags, reads 14 days grouped by project and service for this installation, and writes rows and status', async () => {
    const s3 = new FakeS3()
    const f = fakeCe({
      tags: { 'trace:project': 'Inactive', 'trace:installation': 'Active' },
      pages: [
        { ResultsByTime: [{ TimePeriod: { Start: '2026-10-25' }, Estimated: false, Groups: [{ Keys: ['trace:project$acme/board', 'Amazon Bedrock AgentCore'], Metrics: { UnblendedCost: { Amount: '1.25' } } }, { Keys: ['trace:project$', 'AWS Batch'], Metrics: { UnblendedCost: { Amount: '0.40' } } }] }], NextPageToken: 'p2' },
        { ResultsByTime: [{ TimePeriod: { Start: '2026-10-26' }, Estimated: true, Groups: [{ Keys: ['trace:project$acme/board', 'Amazon Bedrock AgentCore'], Metrics: { UnblendedCost: { Amount: '0.75' } } }, { Keys: ['trace:project$acme/board', 'Tax'], Metrics: { UnblendedCost: { Amount: '0' } } }] }] },
      ],
    })
    const out = await readCosts({ ce: f.ce, bucket: 'b', prefix: 'trace', activate: true, nextAt: nextDaily(6, 17), now: () => NOW, s3, log: () => undefined, scratch: tmp() })
    expect(out.rows).toBe(3)
    expect(out.status).toMatchObject({ ok: true, tag: 'active', nextAt: Date.parse('2026-10-28T06:17:00Z') / 1000 })
    expect(f.sent.map((x) => x.name)).toEqual(['ListCostAllocationTagsCommand', 'UpdateCostAllocationTagsStatusCommand', 'GetCostAndUsageCommand', 'GetCostAndUsageCommand'])
    expect(f.sent[1]?.input).toEqual({ CostAllocationTagsStatus: [{ TagKey: 'trace:project', Status: 'Active' }] })
    const q = f.sent[2]?.input as Record<string, unknown>
    expect(q).toMatchObject({ Granularity: 'DAILY', Metrics: ['UnblendedCost'], TimePeriod: { Start: '2026-10-14', End: '2026-10-28' }, Filter: { Tags: { Key: 'trace:installation', Values: ['trace'] } } })
    expect(f.sent[3]?.input).toMatchObject({ NextPageToken: 'p2' })
    const store = new ActualsStore(backendFor('s3://b/installation', s3), { scratch: tmp() })
    const got = (await store.read((db) => ({ a: loadActuals(db, { repo: 'acme/board' }), all: loadActuals(db), s: loadExplorerStatus(db) }))).result
    expect(got.a.map((r) => [r.day, r.amount, r.estimated])).toEqual([['2026-10-25', 1.25, false], ['2026-10-26', 0.75, true]])
    expect(got.all.find((r) => r.repo === '')?.service).toBe('AWS Batch')
    expect(actualTotals(got.a)).toEqual({ byService: { 'Amazon Bedrock AgentCore': 2 }, total: 2, estimatedDays: 1, lastDay: '2026-10-26' })
    expect(got.s?.message).toMatch(/settle about 24 hours later/)
  })

  it('says what a person does when the tag is inactive and may not be activated, and reads nothing then', async () => {
    const s3 = new FakeS3()
    const f = fakeCe({ tags: { 'trace:project': 'Inactive' }, refuse: true })
    const out = await readCosts({ ce: f.ce, bucket: 'b', prefix: 'trace', activate: true, nextAt: nextDaily(6, 17), now: () => NOW, s3, log: () => undefined, scratch: tmp() })
    expect(out.status).toMatchObject({ ok: false, tag: 'inactive' })
    expect(out.status.message).toMatch(/Billing and Cost Management console, under Cost allocation tags \(in an organization, from its management account\)/)
    expect(f.sent.map((x) => x.name)).not.toContain('GetCostAndUsageCommand')
    expect(statusMessage({ 'trace:project': 'not_found' }, null, true)).toMatch(/up to a day after the first tagged resource/)
    expect(window(NOW, LOOKBACK_DAYS).days).toHaveLength(14)
    expect(nextDaily(6, 17)(Date.parse('2026-10-27T05:00:00Z'))).toBe(Date.parse('2026-10-27T06:17:00Z'))
  })
})

describe('the tools function in the ledger', () => {
  it('prices a call by its billed seconds, memory, /tmp over 512 MB and the call itself', async () => {
    const { toolsRow } = await import('../../src/core/cost.js')
    const { toolsCost, DEFAULT_TOOLS_PRICE } = await import('../../src/core/prices.js')
    const r = toolsRow(DEFAULT_PRICES, { seconds: 100, memoryMb: 4096, storageMb: 10_240, at: 1, jobId: 'kicad-1', kind: 'kicad', region: 'us-east-1' })
    const want = 100 * 4 * DEFAULT_TOOLS_PRICE.perGbSecond + DEFAULT_TOOLS_PRICE.perRequest + 100 * 9.5 * DEFAULT_TOOLS_PRICE.perStorageGbSecond
    expect(r).toMatchObject({ kind: 'tools', agent: 'kicad', seconds: 100, memoryMb: 4096, basis: 'table', pricesSource: 'built-in' })
    expect(r.amount).toBeCloseTo(want, 6)
    // a table from before the tools function (fetched or overridden without it) still prices it, at the built-in price
    const { tools: _, ...old } = DEFAULT_PRICES
    expect(toolsCost(old as typeof DEFAULT_PRICES, 100, 4096, 10_240)).toBeCloseTo(want, 6)
    expect(estimateTotals([r]).byKind.tools).toBe(Math.round(want * 100) / 100)
    expect(usageLine(r).what).toBe('Tools function job kicad: 100 s with 4 GB')
  })

  it('opens a ledger made before it, keeping every row, and then takes its rows', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { applyUsageSchema, insertUsage, toolsRow } = await import('../../src/core/cost.js')
    const db = new DatabaseSync(':memory:')
    // the schema as it was: no 'tools' in the CHECK, no memory_mb, no prices_source
    db.exec(`CREATE TABLE usage (id TEXT PRIMARY KEY, at REAL NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('agents', 'gpu', 'cpu')), job_id TEXT, agent TEXT,
      model TEXT, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, seconds REAL, vcpus INTEGER, amount REAL, basis TEXT NOT NULL,
      prices_as_of TEXT, sdk_cost REAL, region TEXT); CREATE INDEX usage_at ON usage(at);`)
    db.exec(`INSERT INTO usage (id, at, kind, agent, seconds, amount, basis) VALUES ('old1', 5, 'gpu', 'blender', 600, 0.13, 'table')`)
    applyUsageSchema(db)
    insertUsage(db, [toolsRow(DEFAULT_PRICES, { seconds: 3, memoryMb: 4096, storageMb: 512, at: 6, jobId: 'k', kind: 'kicad', region: null })])
    const rows = loadUsage(db)
    expect(rows.map((r) => [r.id === 'old1' ? 'old1' : 'new', r.kind])).toEqual([['old1', 'gpu'], ['new', 'tools']])
    expect(rows[0]).toMatchObject({ seconds: 600, amount: 0.13, memoryMb: null })
    // and again is a no-op
    applyUsageSchema(db)
    expect(loadUsage(db)).toHaveLength(2)
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'usage_at'").all())).toHaveLength(1)
  })
})

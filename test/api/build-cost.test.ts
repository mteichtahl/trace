/**
 * The build and cost actions (src/api/actions-build.ts, src/api/actions-cost.ts): an order's shipping recorded by a
 * person and followed with DHL on a backed-off timer (src/core/shipping.ts, src/infra/lambda/order-watch.ts), boards
 * by serial with their incoming inspection, the bench's identities and readings in build.get and the skills' bars,
 * and cost.get / usage.month from the ledger: estimates and actuals for admins, never money for anyone else.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { assign, seen } from '../../src/core/access.js'
import { BenchStore, insertIds, insertReadings, newReading } from '../../src/core/bench.js'
import { backendFor } from '../../src/core/central.js'
import { ActualsStore, CostLedger, insertUsage, jobRow, modelRows, writeActuals } from '../../src/core/cost.js'
import { IntegrationStore, type SecretsApi } from '../../src/core/integrations.js'
import { signGate, startJourney } from '../../src/core/journey.js'
import { DEFAULT_PRICES } from '../../src/core/prices.js'
import { Registry } from '../../src/core/registry.js'
import { BASE_INTERVAL_S, MAX_INTERVAL_S, WatchStore, nextInterval, orderWait, watches } from '../../src/core/shipping.js'
import { openProject } from '../../src/core/store.js'
import { checkDue, dhlTrack } from '../../src/infra/lambda/order-watch.js'
import '../../src/tools/verify/db.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'b-admin', email: 'b-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'b-user', email: 'b-user@example.com', groups: ['trace-users'] }
const REVIEWER = { sub: 'b-rev', email: 'b-rev@example.com', groups: ['trace-users'] }
const OUTSIDER = { sub: 'b-out', email: 'b-out@example.com', groups: ['trace-users'] }
const REPO = 'acme/build'
const github = new FakeGitHub([REPO])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-build-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-build-bucket-'))
const store = (p: string) => backendFor(join(bucket, p))

const secrets = new Map<string, string>()
const sm: SecretsApi = { get: async (n) => secrets.get(n) ?? null, put: async (n, v) => { secrets.set(n, v) }, describe: async (n) => (secrets.has(n) ? { changed: new Date() } : null), remove: async (n) => secrets.delete(n) }
const asked: string[] = []
const deps: ActionDeps = {
  github: async () => github, cognito: () => cognito, jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  tools: () => new Registry([]), scratch, store,
  integrations: async () => new IntegrationStore('trace', sm),
  checkIntegration: async () => ({ ok: true, detail: 'fine' }),
  orderWatch: async (repo, id) => { asked.push(`${repo}:${id}`) },
}
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<any> => (await perform(action, args, { principal: who, deps })).result

function seed(fn: (db: DatabaseSync) => void): void {
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  fn(db)
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  rmSync(dir, { recursive: true, force: true })
}

beforeAll(async () => {
  cognito.add(ADMIN.email, ADMIN.sub, 'trace-admins', 'Ada')
  for (const p of [USER, REVIEWER, OUTSIDER]) cognito.add(p.email, p.sub, 'trace-users')
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await assign(ADMIN, REVIEWER, REPO, { part: 'reviewer', class: 'user' })
  await seen(USER)
  seed((db) => {
    startJourney(db, { template: 'board', by: 'seed', name: 'Build', build: { quantity: 2, unit_cost: 20, budget: 300 } })
    const t = Date.now() / 1000
    db.prepare("INSERT INTO settings (key, value, updated) VALUES ('hil.instruments', ?, ?)").run(JSON.stringify([
      { name: 'bench-psu', kind: 'psu', address: 'tcp://127.0.0.1:5555', limits: { max_voltage_v: 13, max_current_a: 0.1 } },
      { name: 'bench-dmm', kind: 'dmm', address: 'tcp://127.0.0.1:5557' },
    ]), t)
    // the fab files: J2 is fitted by hand
    db.prepare('INSERT INTO runs (id, kind, subject, started, status, summary, result) VALUES (?,?,?,?,?,?,?)').run('run-fab', 'kicad.fab', 'hw', t, 'pass', 'fab', JSON.stringify({ files: [], hand_placed: ['J2'] }))
    // the bench, as the repository's run record has it: the PSU answered
    db.prepare('INSERT INTO runs (id, kind, subject, started, status, summary, result) VALUES (?,?,?,?,?,?,?)').run('run-idn', 'hil.idn', 'bench-psu', t, 'pass', 'RIGOL DP832', JSON.stringify({ manufacturer: 'RIGOL TECHNOLOGIES', model: 'DP832', serial: 'DP8A1', firmware: '00.01' }))
    db.prepare('INSERT INTO artifacts VALUES (?,?,?,?)').run('run-fab', 'top.jpg', 'image/jpeg', new Uint8Array([1, 2, 3]))
  })
})
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

describe('access', () => {
  it('gives no access to an unassigned person, and refuses writes to a reviewer', async () => {
    const why = async (repo: string, a: string, args: Record<string, unknown>): Promise<string> => run(OUTSIDER, a, { repo, ...args }).then(() => 'answered', (e: Error) => e.message.replace(repo, '<repo>'))
    for (const [a, args] of [['build.get', {}], ['cost.get', {}], ['order.check_now', { order: 'x' }]] as const) {
      // the same answer for a project that is not theirs and one that does not exist
      expect(await why(REPO, a, args)).toMatch(/no read access/)
      expect(await why('acme/nonexistent', a, args)).toBe(await why(REPO, a, args))
    }
    for (const [a, args] of [['order.update', { order: 'x', state: 'delivered' }], ['board.record', { serial: 'SN-1' }], ['board.check', { serial: 'SN-1', check: 'count', kind: 'count', result: 'pass' }]] as const) {
      await expect(run(REVIEWER, a, { repo: REPO, ...args })).rejects.toThrow(/no access|write/)
    }
    await expect(run(USER, 'usage.month', {})).rejects.toThrow(/no access|admin/)
  })
})

describe('an order through to the boards', () => {
  it('records the order, then the shipping notice with a DHL number, and follows the parcel on a backed-off timer', async () => {
    // get the project to the order: sign the gates up to Fabricate as an admin would (here: straight into the record)
    await run(USER, 'order.record', { repo: REPO, number: 'Y12-0001', paid: 48.5, ship: '2026-11-04' })
    const placed = await run(USER, 'build.get', { repo: REPO })
    expect(placed.orders[0]).toMatchObject({ number: 'Y12-0001', state: 'placed' })
    expect(placed.orders[0].wait).toMatchObject({ checkable: false, source: 'manual' })
    expect(placed.orders[0].wait.text).toMatch(/partner companies/)
    await expect(run(USER, 'order.update', { repo: REPO, order: 'Y12-0001', state: 'shipped' })).rejects.toThrow(/tracking number/)
    await expect(run(USER, 'order.update', { repo: REPO, order: 'Y12-0001', tracking: '1234567890' })).rejects.toThrow(/carrier/)
    await expect(run(USER, 'order.update', { repo: REPO, order: 'nope', state: 'delivered' })).rejects.toThrow(/No order nope/)
    // no DHL key yet: recorded and watched, but the line says an admin adds the key
    const u = await run(USER, 'order.update', { repo: REPO, order: 'Y12-0001', state: 'shipped', carrier: 'dhl', tracking: '1234 5678 90' })
    expect(u).toMatchObject({ ok: true, order: { state: 'shipped' }, tracking: { carrier: 'dhl', number: '1234567890' } })
    expect(u.wait.text).toMatch(/once an admin adds the DHL key/)
    await run(ADMIN, 'integrations.set', { name: 'dhl', values: { DHL_API_KEY: 'k-1' } })
    expect([...secrets.keys()]).toContain('trace/order-watch/dhl')
    const b = await run(USER, 'build.get', { repo: REPO })
    expect(b.orders[0]).toMatchObject({ state: 'shipped', tracking: { carrier: 'dhl', number: '1234567890', checkable: true } })
    expect(b.orders[0].wait).toMatchObject({ source: 'timer', checkable: true, nextCheckAt: expect.any(String) })
    expect(b.orders[0].wait.text).toMatch(/next check in about 1 hour .*DHL sends no events/)
    // a check now asks the order watch for this order only
    expect(await run(REVIEWER, 'order.check_now', { repo: REPO, order: 'Y12-0001' })).toEqual({ ok: true })
    expect(asked).toEqual([`${REPO}:${b.orders[0].id}`])
    const j = await run(USER, 'journey.get', { repo: REPO })
    expect(j.decisions[0]).toMatchObject({ kind: 'order.shipped' })
  })

  it('the order watch checks what is due with DHL, backs off while nothing moves, and ends on delivery without changing the order', async () => {
    const now = { t: Date.now() + BASE_INTERVAL_S * 1000 + 1000 }
    const answers = [
      { status: 200, body: { shipments: [{ status: { statusCode: 'transit', description: 'Arrived at hub', timestamp: '2026-11-05T10:00:00' } }] } },
      { status: 200, body: { shipments: [{ status: { statusCode: 'transit', description: 'Arrived at hub', timestamp: '2026-11-05T10:00:00' } }] } },
      { status: 200, body: { shipments: [{ status: { statusCode: 'delivered', description: 'Delivered', timestamp: '2026-11-07T09:00:00' } }] } },
    ]
    const urls: string[] = []
    const watchDeps = {
      bucket: 'unused', now: () => now.t, dhlKey: async () => 'k-1', log: () => undefined, scratch,
      fetch: async (u: string, i: RequestInit) => { urls.push(`${u} ${(i.headers as Record<string, string>)['DHL-API-Key']}`); const a = answers.shift()!; return new Response(JSON.stringify(a.body), { status: a.status }) },
    }
    // the Lambda's store is the same backend the API wrote, under installation/
    const ws = new WatchStore(store('installation'), { scratch })
    const run1 = async (): Promise<void> => {
      const list = (await ws.read((db) => watches(db))).result.filter((w) => w.endedAt === null && w.nextAt !== null && w.nextAt <= now.t / 1000)
      if (!list.length) return
      const { recordCheck } = await import('../../src/core/shipping.js')
      const results = await Promise.all(list.map(async (w) => ({ w, ...(await dhlTrack(w.tracking, 'k-1', watchDeps.fetch)) })))
      await ws.update((db) => ({ result: results.map((x) => recordCheck(db, x.w, x.reading, x.error, now.t / 1000)) }))
    }
    await run1()
    let w = (await ws.read((db) => watches(db, REPO))).result[0]!
    expect(w).toMatchObject({ state: 'transit', status: 'Arrived at hub', intervalS: BASE_INTERVAL_S, checks: 1 })
    expect(urls[0]).toBe('https://api-eu.dhl.com/track/shipments?trackingNumber=1234567890 k-1')
    now.t += BASE_INTERVAL_S * 1000 + 1000
    await run1()
    w = (await ws.read((db) => watches(db, REPO))).result[0]!
    expect(w.intervalS).toBe(BASE_INTERVAL_S * 2)
    now.t += BASE_INTERVAL_S * 2 * 1000 + 1000
    await run1()
    w = (await ws.read((db) => watches(db, REPO))).result[0]!
    expect(w).toMatchObject({ state: 'delivered', nextAt: null })
    expect(w.endedAt).not.toBeNull()
    // the order is still shipped: the person records delivery
    const b = await run(USER, 'build.get', { repo: REPO })
    expect(b.orders[0].state).toBe('shipped')
    expect(b.orders[0].wait.text).toMatch(/DHL says order Y12-0001 was delivered.*Mark it delivered/)
    expect(nextInterval({ ...w, intervalS: MAX_INTERVAL_S, state: 'transit' }, { state: 'transit', status: '', eventAt: null, eta: null })).toBe(MAX_INTERVAL_S)
    expect(typeof checkDue).toBe('function')
    expect((await dhlTrack('x', 'bad', async () => new Response('', { status: 401 }))).error).toMatch(/refused the key/)
    expect((await dhlTrack('x', 'k', async () => new Response('', { status: 404 }))).error).toMatch(/does not know this tracking number/)
    const done = await run(USER, 'order.update', { repo: REPO, order: 'Y12-0001', state: 'delivered' })
    expect(done.order.state).toBe('delivered')
    expect(done.wait).toBeNull()
    await expect(run(USER, 'order.update', { repo: REPO, order: 'Y12-0001', state: 'shipped' })).rejects.toThrow(/already delivered/)
    expect(orderWait({ fab: 'JLCPCB', number: 'n', ship: null, state: 'placed' }, { ...w, carrier: 'ups', endedAt: null }, { carrierKey: true, now: 0 })?.text).toMatch(/cannot check UPS/)
  })

  it('records boards by serial with each inspection check, and the Incoming inspection bar is computed from them', async () => {
    const before = await run(USER, 'skill.get', { repo: REPO, skill: 'incoming-inspection' })
    const by = (v: { checks: { id: string; status: string; detail?: string; unavailable?: string }[] }) => Object.fromEntries(v.checks.map((c) => [c.id, c]))
    expect(by(before).count).toMatchObject({ status: 'not_met', detail: 'No boards of this revision are recorded yet.' })
    expect(by(before).count?.unavailable).toBeUndefined()
    await run(USER, 'board.record', { repo: REPO, serial: 'SN-001', photos: ['runs/runfab/top.jpg'] })
    await expect(run(USER, 'board.check', { repo: REPO, serial: 'SN-009', check: 'count', kind: 'count', result: 'pass' })).rejects.toThrow(/not recorded/)
    await expect(run(USER, 'board.check', { repo: REPO, serial: 'SN-001', check: 'bridge', kind: 'fault', result: 'fail' })).rejects.toThrow(/reference/)
    await run(USER, 'board.check', { repo: REPO, serial: 'SN-001', check: 'count', kind: 'count', result: 'pass' })
    await run(USER, 'board.check', { repo: REPO, serial: 'SN-001', check: 'label', kind: 'label', result: 'pass' })
    const mid = by(await run(USER, 'skill.get', { repo: REPO, skill: 'incoming-inspection' }))
    expect(mid.count?.detail).toBe('1 of the 2 boards ordered are recorded.')
    expect(mid.hand).toMatchObject({ status: 'not_met', detail: 'Not fitted or marked: SN-001 J2.' })
    await run(USER, 'board.record', { repo: REPO, serial: 'SN-002', photos: ['runs/runfab/top.jpg'] })
    await run(USER, 'board.check', { repo: REPO, serial: 'SN-002', check: 'u3-rotation', kind: 'fault', result: 'fail', ref: 'U3', note: 'rotated 180°' })
    for (const s of ['SN-001', 'SN-002']) await run(USER, 'board.check', { repo: REPO, serial: s, check: 'hand-j2', kind: 'hand', result: s === 'SN-001' ? 'pass' : 'marked', ref: 'J2' })
    const after = await run(USER, 'skill.get', { repo: REPO, skill: 'incoming-inspection' })
    expect(after.checks.map((c: { id: string; status: string }) => [c.id, c.status])).toEqual([['count', 'met'], ['faults', 'met'], ['hand', 'met'], ['reasons', 'met']])
    expect(after.boards.map((x: { serial: string; status: string }) => [x.serial, x.status])).toEqual([['SN-001', 'inspected'], ['SN-002', 'failed']])
    const b = await run(REVIEWER, 'build.get', { repo: REPO })
    expect(b.boards.map((x: { serial: string; state: string; order: string }) => [x.serial, x.state, x.order])).toEqual([['SN-001', 'inspected', 'Y12-0001'], ['SN-002', 'failed', 'Y12-0001']])
    expect(b.boards[1].checks.find((c: { check: string }) => c.check === 'u3-rotation')).toMatchObject({ result: 'fail', ref: 'U3' })
  })
})

describe('the bench', () => {
  it('build.get and Bench setup show who answered, from the run record and the live copy; Bring-up run reads the readings against limits', async () => {
    const setup0 = await run(USER, 'skill.get', { repo: REPO, skill: 'bench-setup' })
    expect(setup0.checks.find((c: { id: string }) => c.id === 'idn')).toMatchObject({ status: 'not_met', detail: expect.stringMatching(/bench-dmm has not answered/) })
    // the bench machine answers and measures: its live copy
    const live = new BenchStore(store('projects'), REPO, { scratch })
    const t = Date.now() / 1000
    await live.update((db) => {
      insertIds(db, [{ instrument: 'bench-dmm', manufacturer: 'Keysight', model: '34465A', serial: 'MY1', firmware: 'A.03', ok: true, at: t, runId: 'r1' }])
      insertReadings(db, [
        newReading({ board: 'SN-001', step: 'unpowered', instrument: 'bench-dmm', quantity: '3V3 to GND', value: 12_000, unit: 'Ω', min: 1000, max: null, by: 'verify', runId: 'r2', at: t + 1 }),
        newReading({ board: 'SN-001', step: 'rails', instrument: 'bench-psu', quantity: 'VIN current', value: 0.012, unit: 'A', min: null, max: 0.05, by: 'verify', runId: 'r3', at: t + 2 }),
        newReading({ board: 'SN-001', step: 'rails', instrument: 'bench-dmm', quantity: '3V3 rail', value: 3.1, unit: 'V', min: 3.25, max: 3.35, by: 'verify', runId: 'r4', at: t + 3 }),
      ])
      return { result: null }
    })
    const setup = await run(USER, 'skill.get', { repo: REPO, skill: 'bench-setup' })
    expect(setup.checks.find((c: { id: string }) => c.id === 'idn')).toMatchObject({ status: 'met' })
    expect(setup.bench.checklist.map((c: { id: string; done: boolean }) => [c.id, c.done])).toEqual([['idn-bench-psu', true], ['idn-bench-dmm', true]])
    const b = await run(USER, 'build.get', { repo: REPO })
    expect(b.bench.instruments.map((i: { name: string; answered: boolean; identity?: { model: string } }) => [i.name, i.answered, i.identity?.model])).toEqual([['bench-psu', true, 'DP832'], ['bench-dmm', true, '34465A']])
    expect(b.bench.boards).toEqual([{ serial: 'SN-001', steps: [{ step: 'unpowered', readings: 1, passed: true, failing: [] }, { step: 'rails', readings: 2, passed: false, failing: ['3V3 rail'] }] }])
    const bu = await run(USER, 'skill.get', { repo: REPO, skill: 'bring-up-run' })
    const c = Object.fromEntries(bu.checks.map((x: { id: string }) => [x.id, x]))
    expect(c.limits).toMatchObject({ status: 'not_met', detail: 'SN-001 rails: 3V3 rail out of limits.' })
    expect(c.shorts).toMatchObject({ status: 'met' })
    expect(bu.bench).toMatchObject({ board: 'SN-001', powered: true })
    expect(bu.bench.readouts.find((r: { label: string }) => r.label.startsWith('3V3 rail'))).toMatchObject({ value: 3.1, min: 3.25, max: 3.35, unit: 'V' })
    expect(bu.bench.checklist.find((x: { text: string }) => x.text.startsWith('3V3 rail'))).toMatchObject({ by: 'trace', done: false, powered: true })
  })
})

describe('cost', () => {
  it('cost.get counts the ledger\'s estimates by kind and per stage, the actuals a day behind, and says when Cost Explorer reads next; money for admins only', async () => {
    const t = Date.now() / 1000
    await new CostLedger(store('projects'), REPO, { scratch }).update((db) => {
      insertUsage(db, [
        ...modelRows(DEFAULT_PRICES, [{ model: 'global.anthropic.claude-sonnet-4-5', tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, sdkCost: 3 }], { at: t, jobId: 'job-a', agent: 'verify', region: 'us-east-1' }),
        jobRow(DEFAULT_PRICES, { pool: 'cpu', seconds: 3600, vcpus: 10, at: t, jobId: 'openems-1', kind: 'openems', region: 'us-east-1' }),
      ])
      return { result: null }
    })
    await new ActualsStore(store('installation'), { scratch }).update((db) => {
      const day = new Date().toISOString().slice(0, 10)
      writeActuals(db, [{ repo: REPO, day, service: 'Amazon Bedrock AgentCore', amount: 1.5, estimated: true }, { repo: '', day, service: 'AWS Batch', amount: 2 }].map((r) => ({ estimated: false, ...r })), [day],
        { checkedAt: t, nextAt: t + 86400, ok: true, tag: 'active', message: 'Read from Cost Explorer by the trace:project cost allocation tag.' }, t)
      return { result: null }
    })
    const a = await run(ADMIN, 'cost.get', { repo: REPO })
    expect(a.spent.detail.estimated).toEqual({ agents: 3, gpu: 0, cpu: 0.45, total: 3.45 })
    expect(a.spent).toMatchObject({ cloud: 3.45, orders: 48.5 })
    expect(a.spent.detail.actual).toMatchObject({ total: 1.5, estimatedDays: 1 })
    expect(a.stages.find((s: { state: string }) => s.state === 'current').cloud).toBe(3.45)
    expect(a.lines.filter((l: { kind: string }) => l.kind !== 'order').map((l: { kind: string; estimate: boolean }) => [l.kind, l.estimate])).toEqual([['agents', true], ['cpu', true]])
    expect(a.explorer).toMatchObject({ ok: true, tag: 'active', nextAt: expect.any(String) })
    expect(a.explorer.text).toMatch(/next read/)
    expect(a.prices).toMatchObject({ asOf: DEFAULT_PRICES.asOf })
    for (const who of [USER, REVIEWER]) {
      const u = await run(who, 'cost.get', { repo: REPO })
      expect(u).toMatchObject({ money: false, spent: { cloud: null, orders: null }, committed: null, forecast: null, lines: [] })
      expect(JSON.stringify(u)).not.toMatch(/explorer|3\.45|48\.5/)
      expect(u.stages.every((s: { cloud: null }) => s.cloud === null)).toBe(true)
    }
    const m = await run(ADMIN, 'usage.month', {})
    expect(m.projects.find((p: { repo: string }) => p.repo === REPO)).toMatchObject({ estimated: { total: 3.45 }, actual: 1.5, orders: 48.5, budget: 300 })
    expect(m.shared).toMatchObject({ total: 2 })
    expect(m.totals).toMatchObject({ actual: 3.5 })
    void signGate
  })
})

/**
 * JLCPCB quotes through the API (src/api/actions-build.ts quote.record, build.get, order.record; actions-cost.ts
 * cost.get): the person records each quote they read off JLCPCB; build.get lists every one newest first with its change
 * from the one before and why, and the order being prepared costs the newest quote (the estimate kept beside it);
 * cost.get forecasts from it, saying so; an order is linked to the quote it was placed against.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { assign, seen } from '../../src/core/access.js'
import { AgentFactsStore } from '../../src/core/agent-facts.js'
import { backendFor } from '../../src/core/central.js'
import { PROJECTS_PREFIX } from '../../src/core/project.js'
import { recordAgentQuote } from '../../src/core/quotes.js'
import { startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import '../../src/tools/verify/db.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'q-admin', email: 'q-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'q-user', email: 'q-user@example.com', groups: ['trace-users'] }
const REVIEWER = { sub: 'q-rev', email: 'q-rev@example.com', groups: ['trace-users'] }
const REPO = 'acme/quotes'
const github = new FakeGitHub([REPO])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-quotes-api-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-quotes-api-bucket-'))
const store = (p: string) => backendFor(join(bucket, p))
const deps: ActionDeps = {
  github: async () => github, cognito: () => cognito, jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  tools: () => new Registry([]), scratch, store,
}
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<any> => (await perform(action, args, { principal: who, deps })).result

/** The repository's record: the journey at Fabricate, the release package with its options, and the parts checks. */
function seed(checks: [string, number][]): void {
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Quotes', build: { quantity: 10, unit_cost: 9, budget: 300 } })
  db.prepare("UPDATE journey SET current_stage='fabricate' WHERE id='current'").run()
  db.prepare("UPDATE stages SET started=? WHERE id='fabricate'").run(Date.now() / 1000 - 3600)
  const t = Date.now() / 1000
  const runRow = db.prepare('INSERT INTO runs (id, kind, subject, started, status, summary, result) VALUES (?,?,?,?,?,?,?)')
  runRow.run('fab-1', 'kicad.fab', 'hw', t - 60, 'pass', 'fab', JSON.stringify({ files: ['b-gerbers.zip'], order_options: [{ group: 'pcb', option: 'Layers', value: '2' }, { group: 'pcb', option: 'Surface finish', value: 'HASL' }] }))
  checks.forEach(([id, price], n) => {
    runRow.run(id, 'parts.bom_check', 'rows', t - 50 + n, 'pass', 'bom', '{}')
    db.prepare("INSERT INTO parts_list_lines (run_id, line, refs, mpn, order_code, per_board, need, status, flags, stock, unit_price, line_total) VALUES (?, 1, 'U1', 'ESP32', 'C701341', 1, 10, 'ok', '[]', 500, ?, ?)").run(id, price, price * 10)
  })
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  rmSync(dir, { recursive: true, force: true })
}

beforeAll(async () => {
  cognito.add(ADMIN.email, ADMIN.sub, 'trace-admins', 'Ada')
  for (const p of [USER, REVIEWER]) cognito.add(p.email, p.sub, 'trace-users')
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await assign(ADMIN, REVIEWER, REPO, { part: 'reviewer', class: 'user' })
  await seen(USER)
  seed([['bom-1', 3.4]])
})
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

describe('JLCPCB quotes', () => {
  it('before any quote: the order costs the estimate or the target, and there are no quotes', async () => {
    const b = await run(USER, 'build.get', { repo: REPO })
    expect(b.quotes).toEqual([])
    expect(b.orders[0]).toMatchObject({ id: 'next', basis: 'target' })
    expect(b.orders[0].quote).toBeUndefined()
    await expect(run(REVIEWER, 'quote.record', { repo: REPO, total: 100 })).rejects.toThrow(/no access|write/)
  })

  it('keeps every quote, newest first, each with its change from the one before and why; the newest is the order\'s cost', async () => {
    const one = await run(USER, 'quote.record', { repo: REPO, on: '2026-11-01', total: 120, lines: [{ kind: 'pcb', amount: 20 }, { kind: 'components', amount: 34 }, { kind: 'shipping', amount: 40 }], why: 'First quote after uploading the package.' })
    expect(one.quote).toMatchObject({ total: 120, currency: 'USD', quantity: 10, revision: 'A', optionsFrom: 'fab-1', partsRun: 'bom-1', change: null, by: 'q-user@example.com' })
    expect(one.quote.options).toEqual([{ option: 'Layers', value: '2' }, { option: 'Surface finish', value: 'HASL' }])
    // the parts are checked again (a price went up), then quoted again with ENIG and cheaper shipping
    seed([['bom-1', 3.4], ['bom-2', 3.72]])
    await run(USER, 'quote.record', { repo: REPO, on: '2026-11-04', total: 118.2, options: [{ option: 'Layers', value: '2' }, { option: 'Surface finish', value: 'ENIG' }], lines: [{ kind: 'pcb', amount: 24 }, { kind: 'components', amount: 37.2 }, { kind: 'shipping', amount: 35 }], why: 'ENIG for the fine-pitch module.' })
    await run(USER, 'quote.record', { repo: REPO, on: '2026-11-06', total: 210, quantity: 20, link: 'https://cart.jlcpcb.com/quote/Q-998', why: 'Twenty boards for the field trial.' })

    const b = await run(USER, 'build.get', { repo: REPO })
    expect(b.quotes.map((q: { total: number }) => q.total)).toEqual([210, 118.2, 120])
    const [third, second] = b.quotes
    expect(second.change).toEqual({
      amount: -1.8, pct: -1.5,
      reasons: ['Options changed: Surface finish HASL to ENIG.', 'Parts re-checked (bom-2): +US$3.20 at the checked prices.', 'PCB +US$4.00, Components +US$3.20, Shipping −US$5.00.'],
    })
    expect(second.why).toBe('ENIG for the fine-pitch module.')
    expect(third.change).toMatchObject({ amount: 91.8, pct: 77.7, reasons: ['Quantity 10 to 20 boards.'] })
    // no options given: the second quote's ENIG stands, not the package's HASL again
    expect(third.options).toEqual(second.options)
    expect(third.link).toBe('https://cart.jlcpcb.com/quote/Q-998')
    // the order being prepared costs the newest quote; the estimate stays beside it to compare
    expect(b.orders[0]).toMatchObject({ id: 'next', basis: 'quote', total: 210, quote: { total: 210, on: '2026-11-06', quantity: 20 } })
    expect(b.orders[0].estimate).not.toBeNull()
  })

  it('cost.get forecasts the order from the newest quote, and says so', async () => {
    const c = await run(ADMIN, 'cost.get', { repo: REPO })
    expect(c.forecast).toBe(210)
    expect(c.forecastBasis).toMatchObject({ kind: 'quote', total: 210, on: '2026-11-06' })
  })

  it('an agent\'s quote from a person\'s words is listed as theirs, with the words', async () => {
    const facts = new AgentFactsStore(store(PROJECTS_PREFIX), REPO, { scratch })
    await facts.update((db) => ({ result: recordAgentQuote(db, { on: '2026-11-07', total: 205.5, quantity: 20, said: 'JLCPCB now says US$205.50 for the twenty.' }, { revision: 'A', fab: 'JLCPCB', currency: 'USD', quantity: 10, options: [], optionsFrom: null, partsRun: null, partsTotal: null }, { agent: 'worker', label: 'the worker agent', jobId: 'j9' }) }))
    const b = await run(USER, 'build.get', { repo: REPO })
    expect(b.quotes[0]).toMatchObject({ total: 205.5, by: 'the worker agent', said: 'JLCPCB now says US$205.50 for the twenty.', change: { amount: -4.5 } })
    expect(b.orders[0]).toMatchObject({ basis: 'quote', total: 205.5, quote: { agent: true } })
  })

  it('an order is linked to the quote it was placed against, with what was paid against it', async () => {
    const o = await run(USER, 'order.record', { repo: REPO, number: 'Y12-0042', paid: 213.4, ship: '2026-11-12' })
    // the newest of the person's own quotes with no order yet (an agent's is entered by the person to link it)
    expect(o.quote).toMatchObject({ total: 210, difference: 3.4 })
    const b = await run(USER, 'build.get', { repo: REPO })
    const placed = b.orders.find((x: { number: string }) => x.number === 'Y12-0042')
    expect(placed.quote).toMatchObject({ total: 210, on: '2026-11-06', difference: 3.4 })
    expect(b.quotes.find((q: { total: number }) => q.total === 210).order).toMatchObject({ number: 'Y12-0042', paid: 213.4, difference: 3.4 })
    await expect(run(USER, 'order.record', { repo: REPO, number: 'Y12-0043', paid: 1, ship: null, quote: 'qnope' })).rejects.toThrow(/No quote qnope/)
  })
})

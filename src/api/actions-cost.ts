/**
 * Cost and time (docs/ui-design.md "Cost and time", "Admin › Usage and cost"): what a project has spent, has
 * committed and is forecast to spend, from the cost ledger (src/core/cost.ts) and the journey's orders.
 *
 *   cost.get     read (money: admins)   the stage timeline (started, finished, days per stage) for anyone on the
 *                                       project; for admins only (reviewers and contributors never see money):
 *                                         spent.cloud           { estimated: { agents, gpu, cpu, total }, actual: {
 *                                                               total, byService, through, estimatedDays } | null,
 *                                                               basis }: estimates from each run and job, priced from
 *                                                               the dated price table; actuals from Cost Explorer by the
 *                                                               project's tag, a day behind (the screen says so)
 *                                         spent.orders          what the recorded orders cost
 *                                         committed             the order ready to place (its expected total) until it
 *                                                               is recorded
 *                                         forecast              the build: quantity x unit cost, for the revision not
 *                                                               ordered yet
 *                                         stages[].cloud        the estimated cloud spend of the runs in each stage's span
 *                                         lines                 the spend lines: orders, and each run and job (marked
 *                                                               estimate)
 *                                         explorer              the daily read's status: when it read, when it reads
 *                                                               next, whether the trace:project tag is active
 *                                         prices                where the prices come from (the AWS price list, fetched
 *                                                               when; or the built-in table, and why), the table's date,
 *                                                               whether it is old, the admin's overrides, and which
 *                                                               source priced this project's rows
 *   usage.month  admin                  every project the admin sees: this month's estimated and actual cloud spend,
 *                                       orders paid, and the budget, for Admin › Usage and cost
 */
import { z } from 'zod'
import { isAdmin, projectsFor } from '../core/access.js'
import {
  ACTUALS_PREFIX, ActualsStore, CostLedger, type ActualRow, type ExplorerStatus, type PricedBySource, type UsageRow, actualTotals, estimateTotals, loadActuals, loadExplorerStatus, loadUsage, usageLine,
} from '../core/cost.js'
import { type JourneyRecord, STAGE_NAMES, type StageId, loadJourney, loadOrders } from '../core/journey.js'
import { type PriceSource, type PriceTable, DEFAULT_PRICES, isStale } from '../core/prices.js'
import { type PricesInUse, PRICES_PREFIX, pricesFor } from '../core/prices-store.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { type Context, Repo, def, storeAt, withJourneyDb } from './action-kit.js'

const iso = (t: number | null): string | null => (t === null ? null : new Date(t * 1000).toISOString())
const DAY = 86400
const cents = (n: number): number => Math.round(n * 100) / 100
const stageOrd = (r: JourneyRecord, id: StageId | string): number => r.stages.find((s) => s.id === id)?.ord ?? -1

const ledger = (ctx: Context, repo: string): CostLedger => new CostLedger(storeAt(ctx, PROJECTS_PREFIX), repo, { scratch: ctx.deps.scratch })
const actualsStore = (ctx: Context): ActualsStore => new ActualsStore(storeAt(ctx, ACTUALS_PREFIX), { scratch: ctx.deps.scratch })

/** A project's estimates (none when the ledger cannot be read: the notes say so). */
async function usageOf(ctx: Context, repo: string, since = 0): Promise<{ rows: UsageRow[]; error: string | null }> {
  try { return { rows: (await ledger(ctx, repo).read((db) => loadUsage(db, since))).result, error: null } } catch (e) { return { rows: [], error: e instanceof Error ? e.message : String(e) } }
}

/** The installation's actuals and the read's status. */
async function actualsOf(ctx: Context, o: { repo?: string; since?: string } = {}): Promise<{ rows: ActualRow[]; status: ExplorerStatus | null }> {
  try { return (await actualsStore(ctx).read((db) => ({ rows: loadActuals(db, o), status: loadExplorerStatus(db) }))).result } catch { return { rows: [], status: null } }
}

/** The daily read's status as the screens show it: when it read, when it reads next, in words. */
export function explorerView(s: ExplorerStatus | null) {
  if (!s) {
    return {
      checkedAt: null, nextAt: null, ok: false, tag: 'unknown' as const,
      text: 'What AWS billed is read from Cost Explorer once a day; it has not run yet (it starts with the next stack update, at the time cost.explorer.at sets). Figures lag about 24 hours.',
    }
  }
  return {
    checkedAt: iso(s.checkedAt), nextAt: iso(s.nextAt), ok: s.ok, tag: s.tag,
    text: `${s.message ?? ''} Read ${iso(s.checkedAt)?.slice(0, 16).replace('T', ' ')} UTC${s.nextAt ? `; next read ${iso(s.nextAt)?.slice(0, 16).replace('T', ' ')} UTC` : ''}.`.trim(),
  }
}

const at = (t: number | null | undefined): string => (t ? `${iso(t)?.slice(0, 16).replace('T', ' ')} UTC` : '')
const SOURCE_WORDS: Record<PriceSource | 'sdk' | 'unknown', string> = { fetched: 'the AWS price list', 'built-in': 'the built-in table', override: 'an admin\'s prices (cost.prices)', sdk: 'the Agent SDK\'s own figure', unknown: 'a table of before sources were kept' }

/** Which sources priced the rows, in words: "12 from the AWS price list, 3 from the built-in table". */
export function pricedByText(by: PricedBySource): string {
  return (Object.entries(by) as [keyof PricedBySource, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n} from ${SOURCE_WORDS[s]}`).join(', ')
}

/** The table in use for the API (TRACE_PRICES over the fetched table over the built-in one), never failing. */
async function pricesInUse(ctx: Context): Promise<PricesInUse> {
  try {
    return await pricesFor(process.env, { store: storeAt(ctx, PRICES_PREFIX) })
  } catch (e) {
    return { table: DEFAULT_PRICES, fetched: { file: null, error: e instanceof Error ? e.message : String(e) }, overrides: null }
  }
}

/**
 * Where the prices come from, as the screens say it: the AWS price list (fetched when, next fetch), or the built-in
 * table and why (not fetched yet, the fetch failed and when it tries again, the price list is off), an admin's prices
 * over either, and which sources priced the rows counted (`by`). Pure but for `enabled` (TRACE_PRICE_LIST).
 */
export function pricesView(p: PricesInUse, o: { now?: number; by?: PricedBySource; enabled?: boolean } = {}) {
  const now = o.now ?? Date.now()
  const t: PriceTable = p.table
  const f = p.fetched.file
  const enabled = o.enabled ?? process.env.TRACE_PRICE_LIST !== '0'
  const fetchedTable = f?.table ?? null
  const stale = isStale(t, now)
  const what = `Claude on Bedrock per million tokens per model; ${t.gpu.basis}; ${t.cpu.basis}`
  let source: 'price-list' | 'built-in'
  let status: 'met' | 'warning' | 'waiting'
  let text: string
  const failed = f && !f.tried.ok ? { at: iso(f.tried.at), error: f.tried.error } : null
  if (fetchedTable) {
    source = 'price-list'
    status = failed ? 'warning' : 'met'
    text = `Estimates use prices from the AWS price list, fetched ${fetchedTable.asOf} for ${f?.region ?? 'this region'} (${what}).`
    if (failed) text += ` The latest fetch, ${at(f?.tried.at)}, failed (${(failed.error ?? 'no reason given').slice(0, 160)}), so these are the last prices fetched; next try ${at(f?.nextAt)}.`
    else if (f?.nextAt) text += ` Next fetch ${at(f.nextAt)}.`
    if (f?.notes.length) text += ` The price list lacks ${f.notes.length === 1 ? 'one entry' : `${f.notes.length} entries`}; the built-in table's prices are used for ${f.notes.length === 1 ? 'it' : 'them'} (see the notes).`
  } else {
    source = 'built-in'
    status = 'waiting'
    text = `Estimates use the built-in price table of ${DEFAULT_PRICES.asOf} (${what})`
    if (p.fetched.error) { status = 'warning'; text += `: the fetched price list could not be read (${p.fetched.error.slice(0, 160)}).` }
    else if (failed) { status = 'warning'; text += `: the AWS price list could not be fetched ${at(f?.tried.at)} (${(failed.error ?? 'no reason given').slice(0, 160)}). Next try ${at(f?.nextAt)}.` }
    else if (!enabled) text += ': fetching prices from the AWS price list is off (the stack setting cost.priceList.enabled).'
    else text += ': the AWS price list has not been fetched yet. It is fetched once a day with the Cost Explorer read (cost.explorer.at), from the next stack update.'
    if (stale) { status = 'warning'; text += ' The built-in table is more than six months old.' }
  }
  if (p.overrides) text += ` Prices an admin set with the stack setting cost.prices${p.overrides.asOf ? ` (of ${p.overrides.asOf})` : ''} come first.`
  const by = o.by && Object.keys(o.by).length ? o.by : null
  if (by) text += ` Priced here: ${pricedByText(by)}.`
  return {
    asOf: t.asOf, stale, sources: t.sources, source, status,
    fetchedAt: iso(f?.fetchedAt ?? null), nextAt: iso(f?.nextAt ?? null), failed,
    overrides: Boolean(p.overrides), notes: f?.notes ?? [], pricedBy: by ?? {},
    text,
  }
}

export const COST_ACTIONS = {
  'cost.get': def('read', Repo, async ({ repo }, ctx) => {
    const money = isAdmin(ctx.principal)
    // the ledger and the actuals are read only for admins: nobody else's answer carries money
    const [usage, actuals, prices] = money ? await Promise.all([usageOf(ctx, repo), actualsOf(ctx, { repo }), pricesInUse(ctx)]) : [{ rows: [], error: null }, { rows: [], status: null }, null]
    return withJourneyDb(ctx, repo, (db) => {
      const r = loadJourney(db)
      const notes: string[] = []
      if (!r) return { repo, money, currency: 'USD', spent: { cloud: null, orders: money ? 0 : null }, committed: money ? 0 : null, forecast: null, stages: [], lines: [], notes: ['This project has not started its journey yet.'] }
      const now = Date.now() / 1000
      const cur = stageOrd(r, r.journey.currentStage)
      const est = (from: number | null, to: number | null): number | null => {
        if (!money || from === null) return null
        return cents(usage.rows.filter((u) => u.at >= from && u.at < (to ?? Infinity) && u.amount !== null).reduce((n, u) => n + (u.amount ?? 0), 0))
      }
      const stages = r.stages.map((s) => {
        const state = s.ord < cur ? 'done' as const : s.ord === cur ? 'current' as const : 'queued' as const
        const days = s.started !== null ? Math.round((((s.finished ?? now) - s.started) / DAY) * 10) / 10 : 0
        return { stage: STAGE_NAMES[s.id], id: s.id, state, started: iso(s.started), finished: iso(s.finished), days, cloud: est(s.started, s.finished), forecastDays: null as number | null }
      })
      notes.push('Forecast days per stage are not computed yet: there is no history of how long each stage takes.')
      if (!money) {
        notes.push('Cost is shown to admins only.')
        return { repo, money, currency: r.journey.build.currency, spent: { cloud: null, orders: null }, committed: null, forecast: null, stages, lines: [], notes }
      }
      const b = r.journey.build
      const orders = loadOrders(db).filter((o) => o.state !== 'cancelled')
      const paid = orders.reduce((n, o) => n + (o.paid ?? 0), 0)
      const unpaid = orders.filter((o) => o.paid === null).length
      if (unpaid) notes.push(`${unpaid} recorded order${unpaid === 1 ? ' has' : 's have'} no cost given.`)
      const planned = b.unit_cost !== null ? Math.round(b.unit_cost * b.quantity * 100) / 100 : null
      const placedThisRevision = orders.some((o) => o.revision === r.journey.revision)
      const committed = !placedThisRevision && cur >= stageOrd(r, 'fabricate') && stageOrd(r, 'fabricate') >= 0 && planned !== null ? planned : 0
      if (planned === null) notes.push('No unit cost is set in the build plan, so the build\'s forecast is unknown.')
      const e = estimateTotals(usage.rows)
      const a = actuals.rows.length ? actualTotals(actuals.rows) : null
      if (usage.error) notes.push(`The cost ledger could not be read (${usage.error.slice(0, 160)}), so cloud estimates are missing.`)
      if (e.unpriced) notes.push(`${e.unpriced} run${e.unpriced === 1 ? '' : 's'} could not be priced: the price table has no entry for its model and the Agent SDK gave no figure.`)
      notes.push('Cloud estimates (agents, graphics card and CPU jobs) are computed from each run\'s tokens and each job\'s running time with the price table; they are estimates. What AWS billed comes from Cost Explorer, a day behind, and counts only resources tagged with the project (Bedrock and the shared job instances are not tagged per project).')
      const pv = prices ? pricesView(prices, { by: e.bySource }) : null
      if (pv?.notes.length) notes.push(...pv.notes.map((n) => `Price list: ${n}`))
      const cloud = {
        estimated: { ...e.byKind, total: e.total },
        actual: a ? { total: a.total, byService: a.byService, through: a.lastDay, estimatedDays: a.estimatedDays } : null,
        basis: 'estimate' as const,
      }
      return {
        repo, money, currency: 'USD',
        ...(b.currency !== 'USD' ? { orderCurrency: b.currency } : {}),
        spent: { cloud: cents(e.total), orders: Math.round(paid * 100) / 100, detail: cloud },
        committed,
        forecast: placedThisRevision ? 0 : planned,
        ...(b.budget !== null ? { budget: b.budget } : {}),
        quantity: b.quantity, unit_cost: b.unit_cost,
        stages,
        lines: [
          ...orders.map((o) => ({ id: o.id, at: iso(o.placedAt) as string, what: `Order ${o.number} with ${o.fab}: ${o.boards} boards of revision ${o.revision}`, kind: 'order' as const, amount: o.paid ?? 0, estimate: false })),
          ...usage.rows.map(usageLine),
        ],
        explorer: explorerView(actuals.status),
        ...(pv ? { prices: pv } : {}),
        notes,
      }
    })
  }),

  'usage.month': def('admin', z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'a month such as 2026-10').optional() }), async (a, ctx) => {
    const month = a.month ?? new Date().toISOString().slice(0, 7)
    const start = Date.parse(`${month}-01T00:00:00Z`) / 1000
    const [y, m] = month.split('-').map(Number) as [number, number]
    const end = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) / 1000
    const projects = await projectsFor(ctx.principal)
    const [actuals, prices] = await Promise.all([actualsOf(ctx, { since: `${month}-01` }), pricesInUse(ctx)])
    const inMonth = actuals.rows.filter((r) => r.day < new Date(end * 1000).toISOString().slice(0, 10))
    const rows = await Promise.all(projects.map(async (p) => {
      const [u, j] = await Promise.all([
        usageOf(ctx, p.repo, start),
        withJourneyDb(ctx, p.repo, (db) => { const r = loadJourney(db); return { r, orders: r ? loadOrders(db) : [] } }).catch(() => ({ r: null, orders: [] })),
      ])
      const e = estimateTotals(u.rows.filter((x) => x.at < end))
      const act = actualTotals(inMonth.filter((x) => x.repo === p.repo.toLowerCase()))
      const orders = j.orders.filter((o) => o.state !== 'cancelled' && o.placedAt >= start && o.placedAt < end).reduce((n, o) => n + (o.paid ?? 0), 0)
      return {
        bySource: e.bySource,
        repo: p.repo, estimated: { ...e.byKind, total: e.total }, actual: act.lastDay ? act.total : null, orders: cents(orders),
        orderCurrency: j.r?.journey.build.currency ?? 'USD', budget: j.r?.journey.build.budget ?? null, started: Boolean(j.r),
      }
    }))
    const untagged = actualTotals(inMonth.filter((x) => x.repo === ''))
    const by: PricedBySource = {}
    for (const r of rows) for (const [k, n] of Object.entries(r.bySource) as [keyof PricedBySource, number][]) by[k] = (by[k] ?? 0) + n
    return {
      month, currency: 'USD', projects: rows.map(({ bySource: _, ...r }) => r),
      totals: { estimated: cents(rows.reduce((n, r) => n + r.estimated.total, 0)), actual: inMonth.length ? cents(rows.reduce((n, r) => n + (r.actual ?? 0), 0) + untagged.total) : null, orders: cents(rows.reduce((n, r) => n + r.orders, 0)) },
      ...(untagged.lastDay ? { shared: { total: untagged.total, byService: untagged.byService, text: 'This installation\'s spend that carries no project tag: the shared job queues, the web app, the API.' } } : {}),
      explorer: explorerView(actuals.status),
      prices: pricesView(prices, { by }),
    }
  }),
}

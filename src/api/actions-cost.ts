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
 *                                         committed             an order of the revision placed with no cost given yet
 *                                                               (its target); nothing before an order is placed
 *                                         forecast              the build, for the revision not ordered yet (an order
 *                                                               being prepared included): the newest order estimate's
 *                                                               high end, else quantity x target unit cost
 *                                         forecastBasis         which: { kind: 'quote', total, on, id } (the newest
 *                                                               JLCPCB quote of the revision, when there is one), or
 *                                                               { kind: 'estimate', low, high, at, partsRun } or
 *                                                               { kind: 'target' }
 *                                         stages[].cloud        the estimated cloud spend of each stage: its jobs' (by
 *                                                               the stage the project was in when each started), and the
 *                                                               spend no job claims, by when it ran
 *                                         jobs                  spend by job (src/core/cost-jobs.ts): each job's
 *                                                               specialist, request, stage, outcome, running time and
 *                                                               estimated cost, work done again marked (sent back,
 *                                                               redone, duplicated); per stage what was done again or
 *                                                               lost
 *                                         orderEstimate         the order estimate (src/core/order-estimate.ts): the
 *                                                               order from the newest parts check, board and case at
 *                                                               the fab's published prices, against the cost
 *                                                               requirements; absent before a parts check
 *                                         budget                the build budget: what the order (boards, parts, case)
 *                                                               may cost; spent orders, committed and forecast count
 *                                                               against it, cloud work never does
 *                                         cloudBudget           the cloud-work allowance: what trace's own cloud work
 *                                                               may cost; absent while none is set
 *                                         warning               the current stage near or past its share of what the
 *                                                               cloud-work allowance has left, with its biggest jobs
 *                                                               (stageWarning); absent while within it or without one
 *                                         lines                 the spend lines: orders, and each run and job (marked
 *                                                               estimate)
 *                                         explorer              the daily read's status: when it read, when it reads
 *                                                               next, whether the trace:project tag is active
 *                                         prices                where the prices come from (the AWS price list, fetched
 *                                                               when; or the built-in table, and why), the table's date,
 *                                                               whether it is old, the admin's overrides, and which
 *                                                               source priced this project's rows
 *   usage.month  admin                  every project the admin sees: this month's estimated and actual cloud spend,
 *                                       orders paid, the build budget and the cloud-work allowance, for Admin › Usage
 *                                       and cost
 */
import { z } from 'zod'
import { isAdmin, projectsFor } from '../core/access.js'
import {
  ACTUALS_PREFIX, ActualsStore, CostLedger, type ActualRow, type ExplorerStatus, type PricedBySource, type UsageRow, actualTotals, estimateTotals, loadActuals, loadExplorerStatus, loadUsage, usageLine,
} from '../core/cost.js'
import { type JourneyRecord, STAGE_NAMES, type StageId, loadJourney, loadOrders } from '../core/journey.js'
import { type SpendByJob, spendByJob, stageTimeline, stageWarning } from '../core/cost-jobs.js'
import { type BatchRow, type JobRow, STALE_AFTER_S, loadBatch, loadJobs } from '../core/job-index.js'
import { jobIndex } from './actions-jobs.js'
import { type PriceSource, type PriceTable, DEFAULT_PRICES, isStale } from '../core/prices.js'
import { type PricesInUse, PRICES_PREFIX, pricesFor } from '../core/prices-store.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { SPECIALIST_WORDS, type SpecialistKind, WORKER } from '../agents/kinds.js'
import { type Context, Repo, agentFactsStore, def, storeAt, withJourneyDb, withRecordDb } from './action-kit.js'
import { type OrderEstimate, orderEstimateFrom } from '../core/order-estimate.js'
import { type QuoteRow, allQuotes, latestQuote, loadAgentQuotes, loadQuotes } from '../core/quotes.js'

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

/** A project's job index (none when it cannot be read: the jobs are then shown by their ids). */
async function jobsOf(ctx: Context, repo: string): Promise<{ rows: JobRow[]; batch: BatchRow[] }> {
  try { return (await jobIndex(ctx, repo).read((db) => ({ rows: loadJobs(db), batch: loadBatch(db) }))).result } catch { return { rows: [], batch: [] } }
}

/** The jobs a person's "ask for changes" started (change.asked): work sent back. */
const sentBackJobs = (r: JourneyRecord): Set<string> =>
  new Set(r.decisions.filter((d) => d.kind === 'change.asked').map((d) => (d.detail as { job_id?: unknown } | null)?.job_id).filter((x): x is string => typeof x === 'string'))

/** The order estimate from the project's record (none when it cannot be read, or there is no parts check yet). */
async function estimateOf(ctx: Context, repo: string): Promise<OrderEstimate | null> {
  try { return await withRecordDb(ctx, repo, (db) => orderEstimateFrom(db)) } catch { return null }
}

/** The order estimate as cost.get answers it: its figures, each limit's verdict, and its date. */
export function estimateView(e: OrderEstimate) {
  return {
    currency: e.currency, quantity: e.quantity, low: e.low, high: e.high, perBoard: e.perBoard, at: iso(e.at) as string, partsRun: e.partsRun,
    lines: e.lines, notIn: e.notIn, verdict: e.verdict,
    limits: e.limits.map((l) => ({ requirement: l.requirement, kind: l.kind, amount: l.amount, currency: l.currency, verdict: l.verdict, text: l.text })),
    text: e.text,
  }
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

/**
 * The build's cost against the build budget, counted once: a forecast (the build plan's target) until an order of the
 * revision is placed; then the order's paid cost (spent), or, placed but with no cost given yet, committed. Nothing is
 * committed before an order is placed: an order being prepared at Fabricate is still a forecast from the target, not a
 * quote (test-esp32 run 2, #218: "Committed: the order ready to place US$90" and "Forecast US$0" with nothing ordered).
 * Pure.
 */
export function buildCost(o: { planned: number | null; placed: boolean; paid: boolean }): { committed: number; forecast: number | null } {
  if (o.placed) return { committed: o.paid || o.planned === null ? 0 : o.planned, forecast: 0 }
  return { committed: 0, forecast: o.planned }
}

/**
 * What the order is forecast to cost before it is placed: the newest JLCPCB quote of the revision when there is one in
 * the build's currency; else the newest order estimate's high end when there is one in that currency; else the build
 * plan's target, with which it is. Pure.
 */
export function orderForecast(o: { target: number | null; estimate: OrderEstimate | null; currency: string; quote?: Pick<QuoteRow, 'id' | 'on' | 'total' | 'currency'> | null | undefined }) {
  const q = o.quote
  if (q && q.currency === o.currency) return { planned: q.total, basis: { kind: 'quote' as const, total: q.total, on: q.on, id: q.id } }
  const e = o.estimate
  if (e && e.currency === o.currency) return { planned: e.high, basis: { kind: 'estimate' as const, low: e.low, high: e.high, at: iso(e.at) as string, partsRun: e.partsRun } }
  return { planned: o.target, basis: o.target !== null ? { kind: 'target' as const } : null }
}

/** One job's spend as the screens show it: its stage and specialist in words, its times as dates. */
function jobLine(j: SpendByJob['jobs'][number]) {
  return {
    id: j.id, agent: j.agent, specialist: j.agent && j.agent in SPECIALIST_WORDS ? SPECIALIST_WORDS[j.agent as SpecialistKind] : j.agent === WORKER ? 'Worker' : j.agent,
    title: j.title, stage: j.stage ? STAGE_NAMES[j.stage] : null, stageId: j.stage, outcome: j.outcome,
    started: iso(j.started), ended: iso(j.ended), seconds: j.seconds, amount: j.amount, byKind: j.byKind, workers: j.workers,
    repeat: j.repeat ? { kind: j.repeat.kind, of: j.repeat.of, text: REPEAT_WORDS[j.repeat.kind] } : null,
  }
}
const REPEAT_WORDS: Record<NonNullable<SpendByJob['jobs'][number]['repeat']>['kind'], string> = {
  sent_back: 'Sent back: a person asked for changes',
  redone: 'Redone: worked again on an earlier job\'s change',
  duplicate: 'Duplicate: the same request as an earlier job',
}

/** Spend by job for cost.get: the jobs, newest first, and per stage in the journey's order. */
function spendView(s: SpendByJob, r: JourneyRecord) {
  const ord = (id: StageId): number => stageOrd(r, id)
  return {
    total: s.total, repeated: s.repeated, wasted: s.wasted,
    stages: s.stages.map((x) => ({ ...x, stage: STAGE_NAMES[x.stage], id: x.stage })).sort((a, b) => ord(a.id) - ord(b.id)),
    jobs: [...s.jobs].reverse().map(jobLine),
  }
}

export const COST_ACTIONS = {
  'cost.get': def('read', Repo, async ({ repo }, ctx) => {
    const money = isAdmin(ctx.principal)
    // the ledger and the actuals are read only for admins: nobody else's answer carries money
    const [usage, actuals, prices, jobs, estimate, agentQuoted] = money
      ? await Promise.all([usageOf(ctx, repo), actualsOf(ctx, { repo }), pricesInUse(ctx), jobsOf(ctx, repo), estimateOf(ctx, repo), agentFactsStore(ctx, repo).read((db) => loadAgentQuotes(db)).then((x) => x.result, () => [] as QuoteRow[])])
      : [{ rows: [], error: null }, { rows: [], status: null }, null, { rows: [], batch: [] }, null, [] as QuoteRow[]]
    return withJourneyDb(ctx, repo, (db) => {
      const r = loadJourney(db)
      const notes: string[] = []
      if (!r) return { repo, money, currency: 'USD', spent: { cloud: null, orders: money ? 0 : null }, committed: money ? 0 : null, forecast: null, stages: [], lines: [], notes: ['This project has not started its journey yet.'] }
      const now = Date.now() / 1000
      const cur = stageOrd(r, r.journey.currentStage)
      // by job, each in the stage the project was in when it started (a reopened stage's spans overlap the later
      // stages', so a span would count the same run in two stages)
      const byJob: SpendByJob | null = money
        ? spendByJob({ usage: usage.rows, jobs: jobs.rows, batch: jobs.batch, timeline: stageTimeline(db, r.journey.currentStage), sentBack: sentBackJobs(r), now, staleAfter: STALE_AFTER_S })
        : null
      const est = (s: { id: StageId; started: number | null }): number | null => {
        if (!byJob) return null
        const spent = byJob.stages.find((x) => x.stage === s.id)?.amount ?? null
        return spent ?? (s.started === null ? null : 0)
      }
      const stages = r.stages.map((s) => {
        const state = s.ord < cur ? 'done' as const : s.ord === cur ? 'current' as const : 'queued' as const
        const days = s.started !== null ? Math.round((((s.finished ?? now) - s.started) / DAY) * 10) / 10 : 0
        return { stage: STAGE_NAMES[s.id], id: s.id, state, started: iso(s.started), finished: iso(s.finished), days, cloud: est(s), forecastDays: null as number | null }
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
      const placedThisRevision = orders.filter((o) => o.revision === r.journey.revision)
      // the order's forecast: the newest order estimate's high end when there is one in the build's currency, else the
      // build plan's target (test-esp32 run 2, #178: "10 boards at US$9 each, the build plan's target" with an
      // estimate of US$141 to 244 on record)
      // the newest JLCPCB quote of the revision before either, when one is recorded (the person's, or an agent's from
      // the person's words), as the Build tab's headline is
      const of = orderForecast({ target: planned, estimate, currency: b.currency, quote: latestQuote(allQuotes(loadQuotes(db), agentQuoted), r.journey.revision) })
      const { committed, forecast } = buildCost({ planned: of.planned, placed: placedThisRevision.length > 0, paid: placedThisRevision.every((o) => o.paid !== null) })
      const forecastBasis = of.basis
      const useEstimate = of.basis?.kind === 'estimate' || of.basis?.kind === 'quote'
      if (planned === null && !useEstimate) notes.push('No unit cost is set in the build plan and there is no order estimate yet, so the build\'s forecast is unknown.')
      const e = estimateTotals(usage.rows)
      const a = actuals.rows.length ? actualTotals(actuals.rows) : null
      if (usage.error) notes.push(`The cost ledger could not be read (${usage.error.slice(0, 160)}), so cloud estimates are missing.`)
      if (e.unpriced) notes.push(`${e.unpriced} run${e.unpriced === 1 ? '' : 's'} could not be priced: the price table has no entry for its model and the Agent SDK gave no figure.`)
      notes.push('Cloud estimates (agents, graphics card and CPU jobs) are computed from each run\'s tokens and each job\'s running time with the price table; they are estimates. What AWS billed comes from Cost Explorer, a day behind, and counts only resources tagged with the project (Bedrock and the shared job instances are not tagged per project).')
      const pv = prices ? pricesView(prices, { by: e.bySource }) : null
      // the cloud-work allowance, split across the stages still to do. Only cloud work counts against it: the build
      // budget is the order's (boards, parts, case), so the orders, the committed order and the build's forecast never
      // come off it (test-esp32 run 2, #91, #151: one budget for both said "nothing left for cloud work" at Layout)
      const curStage = r.stages.find((s) => s.ord === cur)
      const warning = byJob && curStage && b.cloud_budget !== null
        ? stageWarning({ budget: b.cloud_budget, other: 0, cloud: e.total, stage: curStage.id, stagesLeft: r.stages.filter((s) => s.ord >= cur).length, spend: byJob })
        : null
      if (b.cloud_budget === null) notes.push('No cloud-work allowance is set, so nothing warns before trace\'s cloud work runs long. Set one in Settings › Build and budget; the build budget is the order\'s and does not cover cloud work.')
      if (byJob && !jobs.rows.length && byJob.jobs.length) notes.push('The job index has none of these jobs (it could not be read, or they are older than it keeps), so they are shown without their requests.')
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
        forecast,
        ...(forecastBasis ? { forecastBasis } : {}),
        // two budgets: the build's (the order: boards, parts, case) and the cloud-work allowance (trace's own spend)
        ...(b.budget !== null ? { budget: b.budget } : {}),
        ...(b.cloud_budget !== null ? { cloudBudget: b.cloud_budget } : {}),
        quantity: b.quantity, unit_cost: b.unit_cost,
        // the order estimate against the cost requirements, from the newest parts check (#162)
        ...(estimate ? { orderEstimate: estimateView(estimate) } : {}),
        stages,
        lines: [
          ...orders.map((o) => ({ id: o.id, at: iso(o.placedAt) as string, what: `Order ${o.number} with ${o.fab}: ${o.boards} boards of revision ${o.revision}`, kind: 'order' as const, amount: o.paid ?? 0, estimate: false })),
          ...usage.rows.map(usageLine),
        ],
        jobs: byJob ? spendView(byJob, r) : null,
        ...(warning ? { warning: { ...warning, stage: STAGE_NAMES[warning.stage], top: warning.top.map(jobLine) } } : {}),
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
        orderCurrency: j.r?.journey.build.currency ?? 'USD', budget: j.r?.journey.build.budget ?? null, cloudBudget: j.r?.journey.build.cloud_budget ?? null, started: Boolean(j.r),
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

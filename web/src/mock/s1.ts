/**
 * Mock handlers for the gate, the guided skills, New project and the project tabs (web s1). handlers.ts asks this
 * first (`s1Action`) and falls through to its own cases when this answers undefined. State lives in memory for the
 * session: opened evidence, signatures, returns, waivers, recorded orders and created projects.
 */
import { JOURNEYS, MEMBERS } from './fixtures'
import { OPS_RUNS } from './fixtures-admin'
import {
  BUILD, COST, COVERAGE, DECISIONS, DESIGN, EXISTING_USERS, FILE_URLS, FILES, JOB_ROUTE, PANEL_GATE, QUESTIONS, QUESTIONS_BY_ID, RUNS, SETTINGS, SKILL_VIEWS, SOIL_GATES, TRACE,
} from './fixtures-s1'
import { QUOTES, payWithQuote, quoteCheck, recordQuote, withQuotes } from './quotes'
import type { Gate } from '@/lib/types'
import type { GateMore, JourneyMore } from '@/lib/types-s1'

/**
 * VITE_MOCK_ORDER=empty: the order at Fabricate before the release package is built and the parts checked again (test-esp32
 * run 2, #217): build.get says it is not ready and what is missing, and its cost is the target.
 */
const UNPACKAGED = {
  ...BUILD,
  orders: BUILD.orders.map((o) => ({
    ...o, ready: false, files: [], options: [], parts: [], render: null, checkedAt: undefined, checkRun: undefined, hardware: undefined,
    cost: o.cost.filter((c) => c.kind === 'target'),
    missing: ['The release package is not built yet: kicad.fab builds the Gerbers, BOM and placement file.', 'There is no parts check yet: parts.bom_check checks stock and price at 10 boards.'],
  })),
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const fail = (error: string, status = 200) => json({ ok: false, error }, status)
const later = (r: Response, ms = 700) => new Promise<Response>((res) => setTimeout(() => res(r), ms)) as unknown as Response

// enrich the shared journeys once: gate criteria, waivers, recommendation, decisions
for (const g of JOURNEYS['acme/soil-sensor']!.gates as GateMore[]) Object.assign(g, SOIL_GATES[g.id] ?? {})
;(JOURNEYS['acme/soil-sensor'] as JourneyMore).decisions = DECISIONS
for (const g of JOURNEYS['acme/panel-controller']!.gates as GateMore[]) if (g.state === 'open') Object.assign(g, PANEL_GATE)
for (const g of JOURNEYS['acme/motor-driver']!.gates as GateMore[])
  if (g.state === 'signed') Object.assign(g, { criteria: SOIL_GATES.requirements!.criteria })

/** Withdraw a waiver in the mock's memory: closed in the journey and off its gate, with the log's entry. */
function withdrawMock(j: JourneyMore, id: string, reason: string, replacedBy: string | null): void {
  const at = new Date().toISOString()
  for (const w of j.waivers.filter((x) => x.id === id)) Object.assign(w, { closed: true, mayWithdraw: false, withdrawn: { by: 'Marc Teichtahl', at, reason, replacedBy } })
  for (const g of j.gates) g.waivers = g.waivers.filter((x) => x.id !== id)
  j.decisions?.unshift({ id: `d-w-${id}-${at}`, kind: 'waiver', ref: id, title: `The waiver ${id} was ${replacedBy ? 'taken again' : 'withdrawn'} by Marc Teichtahl: ${reason}`, by: 'Marc Teichtahl', at, state: 'withdrawn' })
}

const gateOf = (repo: string, id: string): GateMore | undefined => JOURNEYS[repo]?.gates.find((g: Gate) => g.id === id) as GateMore | undefined
let settings: Record<string, unknown> = { ...SETTINGS }
const drafts: Record<string, { step: number; data: unknown; saved: string } | undefined> = {}

export function s1Action(name: string, a: Record<string, unknown>): Response | undefined {
  const repo = a.repo as string
  switch (name) {
    case 'journey.criterion.open': {
      const c = gateOf(repo, String(a.gate))?.criteria.find((x) => x.id === a.criterion)
      if (c) c.opened = true
      // a waiver's open (its Acknowledge box): counted for this signing, as journey.get's opened_by_you says
      if (a.waiver) for (const w of [...(JOURNEYS[repo]?.waivers ?? []), ...(JOURNEYS[repo]?.gates.flatMap((g: Gate) => g.waivers) ?? [])]) if (w.id === a.waiver) w.opened = true
      return ok({ ok: true })
    }
    case 'criterion.confirm': {
      const c = (JOURNEYS[repo]?.gates as GateMore[] | undefined)?.flatMap((g) => g.criteria).find((x) => x.id === a.criterion)
      if (!c?.added) return fail('That criterion is met by its own check or guided step, not by signing it off here.')
      const met = a.met !== false
      if (met && String(a.note ?? '').trim().length < 3) return fail('Say what you checked: it is the evidence the gate is signed on.')
      c.status = met ? 'met' : 'not_met'
      if (met) c.evidence = { kind: 'record', label: String(a.note).trim(), id: c.id, summary: String(a.note).trim() }
      else delete c.evidence
      c.opened = false
      return ok({ repo, criterion: c.id, met, summary: met ? 'Signed off.' : 'Taken back: it is not met.' })
    }
    case 'gate.sign': {
      const g = gateOf(repo, String(a.gate))
      if (!g) return fail('no such gate')
      const missing = g.criteria.filter((c) => c.status === 'not_met' || !c.opened)
      if (missing.length) return fail(`${missing.length} criteria are not met or their evidence was not opened`)
      g.state = 'signed'
      g.signature = { by: 'Marc Teichtahl', at: new Date().toISOString() }
      g.record = { notes: (a.notes as string) || undefined, acknowledged: g.waivers.map((w) => w.id) }
      const j = JOURNEYS[repo]!
      const i = j.stages.findIndex((s) => s.id === g.after)
      if (i >= 0) {
        j.stages[i]!.state = 'done'
        if (j.stages[i + 1]) j.stages[i + 1]!.state = 'current'
        const next = j.gates[i + 1]
        if (next) next.state = 'open'
        j.current = j.stages[i + 1]?.id ?? j.current
      }
      j.next = { kind: 'working', owner: 'trace', summary: `trace is starting ${j.stages[i + 1]?.name ?? 'the next stage'}.`, short: 'trace starts the next stage' }
      return later(ok({ ok: true, started: [`${j.stages[i + 1]?.name ?? 'Next stage'}: ${j.jobs.find((x) => x.state === 'queued')?.title ?? 'work'}`] }))
    }
    case 'gate.return': {
      const g = gateOf(repo, String(a.gate))
      if (!g) return fail('no such gate')
      g.state = 'returned'
      g.record = { ...(g.record ?? {}), returned: { by: 'Marc Teichtahl', at: new Date().toISOString(), reason: String(a.reason) } }
      return later(ok({ ok: true }))
    }
    case 'runs':
      return ok(RUNS.filter(() => repo === 'acme/soil-sensor').map(({ id, kind, subject, started, finished, status, summary }) => ({ id, kind, subject, started, finished, status, summary })))
    case 'run': {
      // the Evidence page lists runs from the admin fixtures (OPS_RUNS): a listed run must open too, so fall back to
      // its row when this file's fuller records do not have it
      const r = RUNS.find((x) => x.id === a.id) ?? Object.values(OPS_RUNS).flat().find((x) => x.id === a.id)
      return r ? ok(r) : fail(`no run ${String(a.id)}`)
    }
    case 'job':
      return ok(a.id === JOB_ROUTE.id ? JOB_ROUTE : { id: a.id, kind: 'task', state: 'done', version: 1 })
    case 'job.control':
      // a job the project's index does not list (mock/jobs.ts answers the listed ones): as the API, cancel only
      return a.op === 'cancel'
        ? later(ok({ ok: true, state: 'aborted', kept: 'Commits the agent had already pushed stay on their branch.' }))
        : ok({ ok: false, reason: 'trace does not list this job, so it can only be cancelled while it runs.' })
    case 'skill.draft':
      drafts[`${repo}|${String(a.skill)}`] = a.data === null ? undefined : { step: Number(a.step ?? 0), data: a.data, saved: new Date().toISOString() }
      return ok({ kept: a.data !== null, saved: a.data === null ? null : new Date().toISOString() })
    case 'skill.drafts':
      return ok({ drafts: Object.entries(drafts).filter(([k, v]) => v && k.startsWith(`${repo}|`)).map(([k, v]) => ({ skill: k.split('|')[1], name: k.split('|')[1], step: v!.step, steps: 6, saved: v!.saved })) })
    case 'policy.set':
      return ok({ locks: {}, changed: true })
    case 'users.history':
      return ok({ sub: a.who, email: null, entries: [{ at: new Date(Date.now() - 86_400_000).toISOString(), by: 'marc@example.com', repo: 'acme/soil-sensor', action: 'assign', detail: 'part: contributor', text: 'marc@example.com added them to acme/soil-sensor as a contributor.' }] })
    case 'tool':
      if (a.name === 'verify.coverage') return repo === 'acme/soil-sensor' ? later(ok(COVERAGE), 200) : ok({ summary: {}, requirements: [] })
      return undefined
    case 'requirements.trace':
      return repo === 'acme/soil-sensor' ? ok(TRACE) : ok({ intent: [], links: [] })
    case 'design.get':
      return repo === 'acme/soil-sensor' ? ok(DESIGN) : ok({ sheets: [] })
    case 'files.list':
      return ok(repo === 'acme/soil-sensor' ? FILES : [])
    case 'files.url':
      return FILE_URLS[String(a.path)] ? ok({ url: FILE_URLS[String(a.path)] }) : fail('no such file')
    case 'build.get':
      return repo === 'acme/soil-sensor' ? ok(withQuotes(import.meta.env.VITE_MOCK_ORDER === 'empty' ? UNPACKAGED : BUILD)) : ok({ releases: [], orders: [], boards: [] })
    case 'order.record': {
      const o = BUILD.orders.find((x) => x.id === a.order)
      // linked to the newest quote, with what was paid against it
      const q = QUOTES.find((x) => x.order === null)
      if (o) Object.assign(o, { state: 'placed', number: a.number, paid: a.paid, ship: a.ship, total: a.paid ?? 0, ...(q ? { quote: { id: q.id, on: q.on, total: q.total, currency: q.currency, difference: typeof a.paid === 'number' ? Math.round((a.paid - q.total) * 100) / 100 : null } } : {}) })
      if (o && q) q.order = { id: o.id, number: String(a.number), paid: (a.paid as number | null) ?? null, difference: typeof a.paid === 'number' ? Math.round((a.paid - q.total) * 100) / 100 : null }
      return later(ok({ ok: true, wait: o?.wait }))
    }
    case 'quote.record': {
      if (!(Number(a.total) > 0)) return fail('Give the quote\'s total, as JLCPCB shows it.')
      return later(ok({ ok: true, quote: recordQuote(a as never) }))
    }
    case 'cost.get':
      return repo === 'acme/soil-sensor' ? ok(COST) : fail('cost.get: no record yet')
    case 'skill.get': {
      // the panel controller has not started its intent: the Intent builder opens on its first topic (test-esp32 #8)
      const fresh = repo === 'acme/panel-controller' && a.skill === 'intent-builder' ? { summary: '0 of 7 checks met.', recommendation: undefined, checks: [], intent: { topic: 0, answered: [], statements: [], questions: [] } } : {}
      const v0 = { ...SKILL_VIEWS[String(a.skill)], ...fresh }
      // Order submit's pay step shows the newest quote (mock/quotes.ts)
      const v = a.skill === 'order-submit' && v0.order ? { ...v0, order: { ...v0.order, pay: payWithQuote(v0.order.pay) }, checks: quoteCheck(v0.checks ?? []) } : v0
      // the question its link names (test-esp32 #107), else the project's first
      const question = String(a.skill) === 'question-answer' ? (a.question ? QUESTIONS_BY_ID[String(a.question)] : undefined) ?? QUESTIONS[repo] : undefined
      const d = drafts[`${repo}|${String(a.skill)}`]
      return ok({ skill: a.skill, ...v, ...(question ? { question } : {}), ...(d ? { draft: d.data, step: d.step, saved: d.saved } : {}) })
    }
    case 'skill.submit': {
      // VITE_MOCK_AGENT=setting_up: the Intent builder's drafting is queued until the project's agent is set up
      if (import.meta.env.VITE_MOCK_AGENT === 'setting_up' && a.skill === 'intent-builder') return later(ok({ ok: true, id: `rec_${Math.random().toString(16).slice(2, 6)}`, queued: true, jobId: `queued~${repo.replace('/', '~')}~3f2a9c1d0e4b` }))
      // a waiver taken again withdraws the one it replaces
      const draft = (a.draft ?? {}) as { replaces?: string }
      const j = JOURNEYS[repo] as JourneyMore | undefined
      const id = `rec_${Math.random().toString(16).slice(2, 6)}`
      if (a.skill === 'waiver' && draft.replaces && j) withdrawMock(j, draft.replaces, `taken again as waiver ${id}`, id)
      return later(ok({ ok: true, id }))
    }
    case 'waiver.withdraw': {
      const j = JOURNEYS[repo] as JourneyMore | undefined
      const w = j?.waivers.find((x) => x.id === a.waiver)
      if (!j || !w) return fail(`There is no waiver called ${String(a.waiver)} in this project.`)
      if (!w.mayWithdraw) return fail(w.withdrawBlocked ?? 'This waiver is already withdrawn.')
      if (String(a.reason ?? '').trim().length < 5) return fail('Say in a sentence why the waiver is withdrawn; it is kept in the record.')
      withdrawMock(j, w.id, String(a.reason).trim(), null)
      return later(ok({ repo, waiver: { id: w.id, closed: true }, summary: `Withdrawn. ${w.target?.kind === 'criterion' ? 'The criterion counts again: it is not met until it is met or waived again.' : `The ${w.target?.kind ?? 'finding'} counts again.`}` }), 400)
    }
    case 'waiver.add': {
      const j = JOURNEYS[repo]
      const id = `W-${(j?.waivers.length ?? 0) + 4}`
      j?.waivers.push({ id, title: String(a.finding ?? 'Waiver'), reason: String(a.reason), risk: (a.severity as 'degraded') ?? 'degraded', caught: String(a.caught) })
      return later(ok({ id }))
    }
    case 'task':
      return later(ok({ accepted: true, jobId: 'job_cr' }))
    case 'users.list':
      return ok(EXISTING_USERS)
    case 'projects.create':
      return later(ok({
        // projects.create takes `repo` (owner/name); an older draft of the mock read `repository`
        repo: typeof a.repo === 'string' ? a.repo : `${(a.repository as { owner: string }).owner}/${(a.repository as { name: string }).name}`,
        done: ['Created the repository', 'Opened the onboarding pull request', ...(import.meta.env.VITE_MOCK_AGENT === 'setting_up' ? [] : ["Set up the project's agent, knowledge base and build runner"]), 'Sent the invitations'],
        waits: [
          { id: 'w-pr', what: "Waiting for the onboarding pull request's checks", text: 'Checks run on the new repository', lastCheckedAt: new Date().toISOString(), nextCheckAt: new Date(Date.now() + 60_000).toISOString() },
          // VITE_MOCK_AGENT=setting_up: the project's agent arrives with the installation update (project.agent, mock/small.ts)
          ...(import.meta.env.VITE_MOCK_AGENT === 'setting_up' ? [{ id: 'installation-update', what: "The project's agent and knowledge base", text: "trace is updating itself to add this project's agent and knowledge base. The project page shows how far it has got and about when it will be ready." }] : []),
        ],
      }), 1400)
    case 'settings.get':
      return ok({ repo, set: settings, config: { branch: 'main' }, errors: [] })
    case 'settings.set':
      settings = { ...settings, [String(a.key)]: a.value }
      return later(ok({ branch: `trace/settings-${String(a.key)}`, commit: 'c0ffee1' }), 400)
    case 'assign':
      for (const list of Object.values(MEMBERS)) for (const m of list) if (m.sub === a.who || m.email === a.who) m.part = (a.part as 'contributor') ?? m.part
      return ok({ ok: true })
    default:
      return undefined
  }
}

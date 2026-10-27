/**
 * Mock handlers for the gate, the guided skills, New project and the project tabs (web s1). handlers.ts asks this
 * first (`s1Action`) and falls through to its own cases when this answers undefined. State lives in memory for the
 * session: opened evidence, signatures, returns, waivers, recorded orders and created projects.
 */
import { JOURNEYS, MEMBERS } from './fixtures'
import {
  BUILD, COST, COVERAGE, DECISIONS, DESIGN, EXISTING_USERS, FILE_URLS, FILES, JOB_ROUTE, QUESTIONS, RUNS, SETTINGS, SKILL_VIEWS, SOIL_GATES, TRACE,
} from './fixtures-s1'
import type { Gate } from '@/lib/types'
import type { GateMore, JourneyMore } from '@/lib/types-s1'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const fail = (error: string, status = 200) => json({ ok: false, error }, status)
const later = (r: Response, ms = 700) => new Promise<Response>((res) => setTimeout(() => res(r), ms)) as unknown as Response

// enrich the shared journeys once: gate criteria, waivers, recommendation, decisions
for (const g of JOURNEYS['acme/soil-sensor']!.gates as GateMore[]) Object.assign(g, SOIL_GATES[g.id] ?? {})
;(JOURNEYS['acme/soil-sensor'] as JourneyMore).decisions = DECISIONS
for (const g of JOURNEYS['acme/motor-driver']!.gates as GateMore[])
  if (g.state === 'signed') Object.assign(g, { criteria: SOIL_GATES.requirements!.criteria })

const gateOf = (repo: string, id: string): GateMore | undefined => JOURNEYS[repo]?.gates.find((g: Gate) => g.id === id) as GateMore | undefined
let settings: Record<string, unknown> = { ...SETTINGS }
const drafts: Record<string, { step: number; data: unknown; saved: string } | undefined> = {}

export function s1Action(name: string, a: Record<string, unknown>): Response | undefined {
  const repo = a.repo as string
  switch (name) {
    case 'journey.criterion.open': {
      const c = gateOf(repo, String(a.gate))?.criteria.find((x) => x.id === a.criterion)
      if (c) c.opened = true
      return ok({ ok: true })
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
      const r = RUNS.find((x) => x.id === a.id)
      return r ? ok(r) : fail(`no run ${String(a.id)}`)
    }
    case 'job':
      return ok(a.id === JOB_ROUTE.id ? JOB_ROUTE : { id: a.id, kind: 'task', state: 'done', version: 1 })
    case 'job.control':
      // as the API: only cancel can be done; the rest say why
      return a.op === 'cancel'
        ? later(ok({ ok: true, state: 'aborted', kept: 'Commits the agent had already pushed stay on their branch.' }))
        : ok({ ok: false, reason: a.op === 'move_up' ? 'Jobs are not queued: each starts as soon as it is asked for, so there is nothing to move up.' : 'A running job cannot be paused. Cancel it instead; commits it already pushed are kept.' })
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
      return repo === 'acme/soil-sensor' ? ok(BUILD) : ok({ releases: [], orders: [], boards: [] })
    case 'order.record': {
      const o = BUILD.orders.find((x) => x.id === a.order)
      if (o) Object.assign(o, { state: 'placed', number: a.number, paid: a.paid, ship: a.ship })
      return later(ok({ ok: true, wait: o?.wait }))
    }
    case 'cost.get':
      return repo === 'acme/soil-sensor' ? ok(COST) : fail('cost.get: no record yet')
    case 'skill.get': {
      const v = SKILL_VIEWS[String(a.skill)] ?? {}
      const question = String(a.skill) === 'question-answer' ? QUESTIONS[repo] : undefined
      const d = drafts[`${repo}|${String(a.skill)}`]
      return ok({ skill: a.skill, ...v, ...(question ? { question } : {}), ...(d ? { draft: d.data, step: d.step, saved: d.saved } : {}) })
    }
    case 'skill.submit':
      return later(ok({ ok: true, id: `rec_${Math.random().toString(16).slice(2, 6)}` }))
    case 'waiver.add': {
      const j = JOURNEYS[repo]
      const id = `W-${(j?.waivers.length ?? 0) + 4}`
      j?.waivers.push({ id, title: String(a.finding ?? 'Waiver'), reason: String(a.reason), risk: (a.severity as 'degraded') ?? 'minor', caught: String(a.caught) })
      return later(ok({ id }))
    }
    case 'task':
      return later(ok({ accepted: true, jobId: 'job_cr' }))
    case 'users.list':
      return ok(EXISTING_USERS)
    case 'projects.create':
      return later(ok({
        repo: `${(a.repository as { owner: string }).owner}/${(a.repository as { name: string }).name}`,
        done: ['Created the repository', 'Opened the onboarding pull request', "Set up the project's agent, knowledge base and build runner", 'Sent the invitations'],
        waits: [{ id: 'w-pr', what: "Waiting for the onboarding pull request's checks", text: 'Checks run on the new repository', lastCheckedAt: new Date().toISOString(), nextCheckAt: new Date(Date.now() + 60_000).toISOString() }],
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

/**
 * Mock answers for deploys (docs/stay-in-trace.md "2. Deploys"): the Soil sensor has a request waiting to go to its
 * bench, with three commits since what runs there now, and a short history. Deploy runs it through its steps over a
 * few seconds and records it deployed; Skip this one closes the request; Roll back puts an earlier commit back. A
 * reviewer on a project reads deploys and cannot decide. State lives in memory for the session.
 */
import type { DeploysView } from '@/lib/types'
import { JOURNEYS, PROJECTS } from './fixtures'

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const S = (prefix: string) => prefix.padEnd(40, '0')

const STEPS = ['Checking the approval', 'Checking what runs now', 'Deploying', 'Checking it works', 'Reporting']
const STEP_MS = 1500

interface Running { sha: string; started: number; by: string; rollback: boolean }

const state: Record<string, { view: DeploysView; running: Running | null }> = {
  'acme/soil-sensor': {
    running: null,
    view: {
      enabled: true, environment: 'bench', url: 'https://bench.soil-sensor.example', auto: false, may_approve: true,
      running: { sha: S('a41c9e2'), at: ago(26 * HOUR) },
      request: {
        sha: S('7f3e21a'), opened_at: ago(40 * MIN), held: false, held_reasons: [], build_passed: true,
        commits: [
          { sha: S('7f3e21a'), subject: 'power: the AP2112K regulator, in stock and the same price' },
          { sha: S('5b90d14'), subject: 'usb: protect the input against reverse and over-voltage' },
          { sha: S('c02e7f8'), subject: 'firmware: report the soil reading every 10 minutes' },
        ],
      },
      in_progress: null,
      recent: [
        { sha: S('a41c9e2'), result: 'deployed', at: ago(26 * HOUR), by: 'Priya S.' },
        { sha: S('e8d1b03'), result: 'failed', at: ago(27 * HOUR), by: 'Priya S.' },
        { sha: S('91f0a6c'), result: 'deployed', at: ago(3 * 24 * HOUR), by: 'Marc T.' },
        { sha: S('3c77d25'), result: 'skipped', at: ago(4 * 24 * HOUR), by: 'Marc T.' },
      ],
      recommendation: { verdict: 'deploy', why: 'Its build passed and it is the newest commit that passed. It brings 3 changes since what runs now.' },
    },
  },
}

const partOf = (repo: string) => PROJECTS.find((p) => p.repo === repo)?.part ?? 'contributor'

/** Move a running deploy on by the clock: its step, then its result. */
function tick(repo: string): DeploysView {
  const s = state[repo]!
  const r = s.running
  if (!r) return s.view
  const i = Math.floor((Date.now() - r.started) / STEP_MS)
  if (i < STEPS.length) {
    s.view.in_progress = { sha: r.sha, started_at: new Date(r.started).toISOString(), by: r.by, step: r.rollback && i === 2 ? 'Rolling back' : STEPS[i]! }
    s.view.recommendation = { verdict: 'none', why: 'A deploy is running now. Wait for it to finish before deciding anything else.' }
    return s.view
  }
  s.running = null
  s.view.in_progress = null
  s.view.running = { sha: r.sha, at: new Date().toISOString() }
  s.view.recent = [{ sha: r.sha, result: r.rollback ? 'rolled_back' as const : 'deployed' as const, at: new Date().toISOString(), by: r.by }, ...s.view.recent].slice(0, 10)
  if (!r.rollback) s.view.request = null
  s.view.recommendation = s.view.request
    ? { verdict: 'deploy', why: 'Its build passed and it is the newest commit that passed.' }
    : { verdict: 'none', why: `Nothing is waiting: ${s.view.environment} runs the newest commit that passed its build.` }
  return s.view
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown) => json({ ok: true, result })
const fail = (error: string) => json({ ok: false, error })
const later = (r: Response, ms = 500) => new Promise<Response>((res) => setTimeout(() => res(r), ms)) as unknown as Response

const OFF: Omit<DeploysView, 'environment'> = {
  enabled: false, url: null, auto: false, may_approve: false, running: null, request: null, in_progress: null, recent: [],
  recommendation: { verdict: 'none', why: 'Deploys are off for this project. An admin turns them on in the project\'s settings (deploy.enabled).' },
}

/** An answer for the deploy actions, or undefined for any other action. */
export function deploysAction(name: string, a: Record<string, unknown>): Response | undefined {
  if (name !== 'deploys.get' && !name.startsWith('deploy.')) return undefined
  const repo = String(a.repo ?? '')
  if (!JOURNEYS[repo]) return json({ ok: false, error: 'no access' }, 403)
  const reviewer = partOf(repo) === 'reviewer'
  const s = state[repo]
  if (name === 'deploys.get') {
    if (!s) return ok({ ...OFF, environment: 'production' })
    const v = tick(repo)
    return ok({ ...v, may_approve: v.may_approve && !reviewer })
  }
  if (!s || reviewer) return fail('Only trace\'s admins and the people named in the project\'s deploy setting (deploy.people) can decide deploys.')
  if (s.running) return fail('A deploy is running now. Wait for it to finish.')
  switch (name) {
    case 'deploy.approve':
      if (!s.view.request) return fail('Nothing is waiting to be deployed.')
      if (a.sha !== s.view.request.sha) return fail('The request moved to a newer commit since you looked at it. Look again before deploying.')
      s.running = { sha: s.view.request.sha, started: Date.now(), by: 'Marc T.', rollback: false }
      tick(repo)
      return later(ok({ started: true, approval: `${s.view.request.sha}-mock.json`, next: `trace started the deploy of ${s.view.request.sha.slice(0, 7)} to ${s.view.environment}. Its progress shows here.` }))
    case 'deploy.skip':
      if (!s.view.request) return fail('Nothing is waiting to be deployed.')
      s.view.recent = [{ sha: s.view.request.sha, result: 'skipped' as const, at: new Date().toISOString(), by: 'Marc T.' }, ...s.view.recent].slice(0, 10)
      s.view.request = null
      s.view.recommendation = { verdict: 'none', why: 'Nothing is waiting. A request appears here when the build passes on the main branch.' }
      return later(ok({ skipped: true }))
    case 'deploy.rollback': {
      const to = String(a.to)
      if (s.view.running?.sha === to) return fail(`${s.view.environment} already runs ${to.slice(0, 7)}.`)
      if (!s.view.recent.some((r) => r.sha === to && (r.result === 'deployed' || r.result === 'rolled_back'))) return fail(`${to.slice(0, 7)} has not run in ${s.view.environment} lately.`)
      s.running = { sha: to, started: Date.now(), by: 'Marc T.', rollback: true }
      tick(repo)
      return later(ok({ started: true, approval: `${to}-mock.json` }))
    }
    default:
      return undefined
  }
}

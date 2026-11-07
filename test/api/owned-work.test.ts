/**
 * trace's own criteria with nothing working on them (src/api/owned-work.ts, test-esp32 log #161), and a person's review
 * with nothing to review yet (#33, #92). In run 2 the Overview said "trace is working on Sign-off: every requirement is
 * verified or waived" for 85 minutes while nothing ran: journey.get now starts the work once, and after that says
 * "trace is not working on it" with Start it. Straight after signing, it said "Your move" while trace was still
 * proposing what the person reviews.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, type JobsApi, perform } from '../../src/api/actions.js'
import { jobIndex } from '../../src/api/actions-jobs.js'
import { journeyStore } from '../../src/api/action-kit.js'
import { ownedWork } from '../../src/api/actions-journey.js'
import { OWNED_REFUSED, OWNED_STARTED, ownedDue, ownedStep, reviewWaits } from '../../src/api/owned-work.js'
import { parseHandle } from '../../src/api/workers.js'
import { assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { type JobRow, putJob } from '../../src/core/job-index.js'
import { type GateView, type JourneyRecord, type NextStep, loadJourney, setCriterion, startJourney } from '../../src/core/journey.js'
import { projectHash } from '../../src/core/project.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const AT = Date.parse('2026-11-06T02:00:00Z') / 1000
const OPENED = AT - 3 * 3600

// the step journey.get had in run 2 at 00:43 to 02:12 UTC
const working: NextStep = {
  kind: 'working', belongs_to: 'trace', yours: false, summary: 'trace is working on Sign-off: every requirement is verified or waived.',
  why: 'Release approval needs it (3 of 5 criteria met).', recommendation: null, button: 'Watch', stage: 'signoff',
  ref: { kind: 'criterion', id: 'signoff.coverage' }, step: { index: 1, total: 5 }, after: 'Then the release report is yours to review.',
}
type Crit = GateView['criteria'][number]
const crit = (id: string, owner: 'trace' | 'person', status: Crit['status'] = 'not_met', text = 'Every requirement is verified or waived.'): Crit => ({
  id, text, owner, status, evidence: [], evidence_label: null, waiver: null, opened_by_you: false, checked_at: null,
})
const signoff = [{ id: 'signoff', criteria: [crit('signoff.coverage', 'trace'), crit('signoff.emc', 'trace', 'waived'), crit('signoff.bom', 'trace', 'met'), crit('signoff.report', 'person')] }]
type Rec = Pick<JourneyRecord, 'journey' | 'stages' | 'decisions'>
const rec = (stage: string, decisions: JourneyRecord['decisions'] = [], opened = OPENED): Rec => ({
  journey: { currentStage: stage } as JourneyRecord['journey'],
  stages: [{ id: stage, ord: 1, revision: 'A', started: opened, finished: null, reopenedAt: null, reopenedReason: null, reopenedBy: null }] as JourneyRecord['stages'],
  decisions,
})
const row = (o: Partial<JobRow>): JobRow => ({
  id: 'job-1', handle: null, session: 'sess-1', kind: 'task', agent: 'verify', title: 'Sign-off work', number: null, requestedBySub: null, requestedBy: null, state: 'succeeded',
  step: null, queuedAt: OPENED, startedAt: OPENED, endedAt: AT - 90 * 60, beatAt: null, where: null, branch: null, parentJob: null, handoff: null, resumeOf: null, resumedBy: null,
  summary: null, error: null, payload: null, claudeSession: null, pausedBy: null, pausedAt: null, tail: null, vitals: null, updatedAt: AT - 90 * 60, ...o,
})
const quiet = { gates: signoff, rows: [row({})], working: 0, queued: 0, changes: 0, at: AT }
const decision = (kind: string, at: number, detail: unknown = null): JourneyRecord['decisions'][number] => ({ id: `d-${at}`, at, kind, stage: 'signoff', ref: 'signoff.coverage', summary: '', by: 'trace', detail })
const contributor = { admin: false, part: 'contributor' as const }
const reviewer = { admin: false, part: 'reviewer' as const }

describe('trace\'s criterion with nothing working on it (#161)', () => {
  it('the stage\'s job ended, nothing queued, no change open: its work is due to start', () => {
    expect(ownedDue(working, rec('signoff'), quiet)).toMatchObject({ state: 'start', criterion: 'signoff.coverage', gate: 'signoff', stage: 'signoff' })
  })

  it('anything that is or may be working on it leaves the step as it is', () => {
    expect(ownedDue(working, rec('signoff'), { ...quiet, working: 1 })).toBeNull()
    expect(ownedDue(working, rec('signoff'), { ...quiet, queued: 1 })).toBeNull()
    expect(ownedDue(working, rec('signoff'), { ...quiet, changes: 1 })).toBeNull()
    // the stage opened a moment ago: its own job may not be listed yet
    expect(ownedDue(working, rec('signoff', [], AT - 30), quiet)).toBeNull()
    // a job ended a moment ago: its change may still be opening
    expect(ownedDue(working, rec('signoff'), { ...quiet, rows: [row({ endedAt: AT - 20, updatedAt: AT - 20 })] })).toBeNull()
    // a criterion met or waived, a person's, or a step that is not trace's criterion
    expect(ownedDue({ ...working, ref: { kind: 'criterion', id: 'signoff.emc' } }, rec('signoff'), quiet)).toBeNull()
    expect(ownedDue({ ...working, ref: { kind: 'criterion', id: 'signoff.report' } }, rec('signoff'), quiet)).toBeNull()
    expect(ownedDue({ ...working, kind: 'task' }, rec('signoff'), quiet)).toBeNull()
  })

  it('started once already: starting for a moment, then stopped, and never started again on its own', () => {
    expect(ownedDue(working, rec('signoff', [decision(OWNED_STARTED, AT - 30, { job: 'h.job-9' })]), quiet)).toMatchObject({ state: 'starting', job: 'h.job-9' })
    const stopped = ownedDue(working, rec('signoff', [decision(OWNED_STARTED, AT - 3600)]), quiet)
    expect(stopped).toMatchObject({ state: 'stopped', why: 'trace started its work once, and that work ended without meeting it.' })
    // a start from before the stage opened (again) does not count
    expect(ownedDue(working, rec('signoff', [decision(OWNED_STARTED, OPENED - 60)]), quiet)).toMatchObject({ state: 'start' })
    // a refused start says why
    expect(ownedDue(working, rec('signoff', [decision(OWNED_REFUSED, AT - 600, { reason: 'the budget has nothing left for cloud work.' })]), quiet))
      .toMatchObject({ state: 'stopped', why: 'trace could not start its work: the budget has nothing left for cloud work.' })
  })

  it('never says "trace is working" over nothing: started, it says trace started it; stopped, it offers Start it', () => {
    const due = ownedDue(working, rec('signoff'), quiet)!
    const started = ownedStep(working, { ...due, state: 'starting' }, contributor, { words: 'The Verification agent works on "Every requirement is verified or waived".', job: 'h.job-9' })
    expect(started.stopped).toBe(false)
    expect(started.step).toMatchObject({ kind: 'working', belongs_to: 'trace', job_id: 'h.job-9', summary: 'trace started work on Sign-off: every requirement is verified or waived.' })
    expect(started.step.why).toMatch(/^Nothing was working on it, so trace started it: the Verification agent works on/)
    const stopped = ownedStep(working, { ...due, state: 'stopped', why: 'trace started its work once, and that work ended without meeting it.' }, contributor)
    expect(stopped.stopped).toBe(true)
    expect(stopped.step).toMatchObject({
      kind: 'task', belongs_to: 'you', yours: true, button: 'Start it', ref: { kind: 'action', id: 'journey.start_work' },
      summary: 'trace is not working on Sign-off: every requirement is verified or waived. trace started its work once, and that work ended without meeting it.',
      why: 'Nothing is working on it now, and release approval needs it (3 of 5 criteria met).',
    })
    expect(stopped.step.summary).not.toMatch(/trace is working/)
    // a reviewer cannot start it: they read the gate
    expect(ownedStep(working, { ...due, state: 'stopped', why: 'x.' }, reviewer).step).toMatchObject({ belongs_to: 'contributors', yours: false, button: 'Read the stage', ref: { kind: 'gate', id: 'signoff' } })
  })

  it('asks the stage\'s specialist for that criterion only; the documents\' criterion is Scribe\'s; the case its own specialist\'s', () => {
    const w = ownedWork('signoff', 'signoff.coverage', 'Every requirement is verified or waived.')
    expect(w).toMatchObject({ agent: 'verify', started: 'The Verification agent works on "Every requirement is verified or waived".' })
    expect(w.request).toMatch(/^The project is in Sign-off\. Its criterion "Every requirement is verified or waived" \(signoff\.coverage\) is not met, and no job is working on it/)
    expect(w.request).toMatch(/do not redo it[\s\S]*What the stage asks, for context:\nThe layout review gate was signed/)
    expect(ownedWork('signoff', 'signoff.docs', 'The documents are current.')).toMatchObject({ scribe: true })
    expect(ownedWork('layout', 'layout.fit', 'The board fits.')).toMatchObject({ agent: 'impl', request: expect.stringMatching(/mech_build/) })
    // a stage with no work of its own leaves the agent to trace's router
    expect(ownedWork('bringup', 'bringup.verified', 'Every requirement is verified on hardware.').agent).toBeUndefined()
  })
})

describe('a person\'s review while trace still prepares it (#33, #92)', () => {
  const blocks: NextStep = {
    kind: 'task', belongs_to: 'you', yours: true, summary: 'Architect: The blocks and key parts are approved.', why: 'The architecture review needs it (0 of 3 criteria met).',
    recommendation: null, button: 'Continue', stage: 'architect', ref: { kind: 'criterion', id: 'architect.blocks' }, step: { index: 1, total: 4 }, after: null,
  }
  const architect = [{ id: 'architect', criteria: [crit('architect.blocks', 'person', 'not_met', 'The blocks and key parts are approved.'), crit('architect.mapped', 'trace', 'not_met', 'Every requirement maps to at least one block.')] }]
  const words = 'The Implementation agent proposes the architecture options for Architecture choice.'
  const running = row({ id: 'job-a', agent: 'impl', state: 'running', queuedAt: AT - 300, startedAt: AT - 290, endedAt: null, beatAt: AT - 10, updatedAt: AT - 10 })

  it('straight after signing, with the stage\'s job running: trace is working, and the review follows', () => {
    const s = reviewWaits(blocks, rec('architect', [], AT - 400), { gates: architect, rows: [running], repo: 'acme/owned', at: AT, words })
    expect(s).toMatchObject({
      kind: 'working', belongs_to: 'trace', yours: false, button: 'Watch', ref: { kind: 'stage', id: 'architect' },
      summary: 'trace is working on Architect: the Implementation agent proposes the architecture options for Architecture choice.',
      why: 'There is nothing for you to review yet: "The blocks and key parts are approved" is yours once trace\'s work is ready.',
      after: 'Then it is your move: the blocks and key parts are approved.',
    })
    expect(s.job_id).toMatch(/job-a$/)
    // the stage opened a moment ago and its job is not listed yet: the same
    expect(reviewWaits(blocks, rec('architect', [], AT - 20), { gates: architect, rows: [], repo: 'acme/owned', at: AT, words }).kind).toBe('working')
  })

  it('the person\'s move once trace\'s job ended, or trace\'s criteria are met, or the job is from before the stage', () => {
    const o = { gates: architect, repo: 'acme/owned', at: AT, words }
    expect(reviewWaits(blocks, rec('architect', [], AT - 3600), { ...o, rows: [row({ id: 'job-a', state: 'succeeded' })] })).toBe(blocks)
    expect(reviewWaits(blocks, rec('architect', [], AT - 400), { ...o, gates: [{ id: 'architect', criteria: [architect[0]!.criteria[0]!, { ...architect[0]!.criteria[1]!, status: 'met' }] }], rows: [running] })).toBe(blocks)
    expect(reviewWaits(blocks, rec('architect', [], AT - 200), { ...o, rows: [running] })).toBe(blocks)
  })
})

// journey.get itself, as in run 2: Sign-off open for hours, its job ended, coverage not met, nothing running
const ADMIN = { sub: 'o-admin', email: 'o-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'o-user', email: 'o-user@example.com', groups: ['trace-users'] }
const REPO = 'acme/owned-work'
const H = projectHash(REPO)
const S = (n: string): string => `trace-api-${H}-${n.repeat(24).slice(0, 24)}`
const github = new FakeGitHub([REPO])
const scratch = mkdtempSync(join(tmpdir(), 'trace-owned-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-owned-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })
type Started = Parameters<JobsApi['startJob']>[0]
const started: Started[] = []
let refuse: string | null = null
const jobsApi: JobsApi = {
  repositoryOf: (id) => { const h = parseHandle(id); return h?.hash === H ? REPO : null },
  startJob: async (p) => {
    if (refuse) return { accepted: false, jobId: '', reason: refuse }
    started.push(p)
    return { accepted: true, jobId: `${S(String(started.length))}.job-o${started.length}` }
  },
  jobStatus: async () => [],
}
const deps: ActionDeps = { github: async () => github, cognito: () => new FakeCognito(), jobs: async () => jobsApi, tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)) }
const ctx = (principal: Context['principal']): Context => ({ principal, deps })
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> =>
  (await perform(action, args, ctx(who))).result as Record<string, any>
const decisions = async (): Promise<string[]> => (await journeyStore(ctx(ADMIN), REPO).read((d) => loadJourney(d)!.decisions.filter((x) => x.kind.startsWith('work.')).map((x) => `${x.kind} ${x.ref}`))).result
/** Sign-off opened `ago` seconds ago, and every earlier start for it forgotten. */
const openSignoff = async (ago: number): Promise<void> => {
  await journeyStore(ctx(ADMIN), REPO).update((d) => {
    const now = Date.now() / 1000
    d.prepare("UPDATE journey SET current_stage='signoff'").run()
    d.prepare("UPDATE stages SET started=? WHERE id='signoff'").run(now - ago)
    for (const c of loadJourney(d)!.criteria.filter((x) => x.gate === 'signoff' && x.id !== 'signoff.coverage' && x.id !== 'signoff.report')) setCriterion(d, c.id, 'met', [{ kind: 'run', ref: `run-${c.id}` }], 'seed')
    return { result: null }
  })
}

beforeAll(async () => {
  await assign(ADMIN, USER, REPO, { class: 'user' })
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Owned work' })
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  await (await journeyStore(ctx(ADMIN), REPO).read((d) => loadJourney(d))).result
  await openSignoff(3 * 3600)
  // Sign-off's own job ran when the gate was signed, and ended 85 minutes ago
  await jobIndex(ctx(ADMIN), REPO).update((d) => {
    const now = Date.now() / 1000
    putJob(d, 'job-signoff', { kind: 'task', agent: 'verify', title: 'Sign-off', state: 'succeeded', session: S('s'), queuedAt: now - 3 * 3600, startedAt: now - 3 * 3600, endedAt: now - 85 * 60 }, now - 85 * 60)
    return { result: null }
  })
})

describe('journey.get with trace\'s criterion and nothing running (#161)', () => {
  it('starts its work once, and says trace started it', async () => {
    const j = await run(USER, 'journey.get', { repo: REPO })
    expect(started.length).toBe(1)
    expect(started[0]).toMatchObject({ kind: 'task', agent: 'verify', request: expect.stringMatching(/criterion "Every requirement is verified or waived" \(signoff\.coverage\)/) })
    expect(j.next).toMatchObject({ kind: 'working', belongs_to: 'trace', summary: 'trace started work on Sign-off: every requirement is verified or waived.', job_id: `${S('1')}.job-o1` })
    expect(j.work_started).toEqual([expect.stringMatching(/^The Verification agent works on/)])
    expect(await decisions()).toEqual(['work.started signoff.coverage'])
    // a second look while it starts starts nothing more
    const again = await run(USER, 'journey.get', { repo: REPO })
    expect(started.length).toBe(1)
    expect(again.next).toMatchObject({ kind: 'working', summary: 'trace started work on Sign-off: every requirement is verified or waived.' })
  })

  it('once that work ended without meeting it: Start it, never "trace is working", and no second start on its own', async () => {
    await journeyStore(ctx(ADMIN), REPO).update((d) => { d.prepare("UPDATE decisions SET at = at - 3600 WHERE kind='work.started'").run(); return { result: null } })
    const j = await run(USER, 'journey.get', { repo: REPO })
    expect(started.length).toBe(1)
    expect(j.next).toMatchObject({ kind: 'task', yours: true, button: 'Start it', ref: { kind: 'action', id: 'journey.start_work' } })
    expect(j.next.summary).toMatch(/^trace is not working on Sign-off: every requirement is verified or waived\. trace started its work once/)
    // the stage guide's step reads as stopped, not as trace at work
    const steps = (j.stages as { id: string; steps?: { state: string; owner: string; stopped?: true }[] }[]).find((s) => s.id === 'signoff')!.steps ?? []
    expect(steps.filter((s) => s.state === 'now' && s.owner === 'trace').every((s) => s.stopped)).toBe(true)
    // Start it starts it, as the person
    const s = await run(USER, 'journey.start_work', { repo: REPO })
    expect(s).toMatchObject({ criterion: 'signoff.coverage', jobId: `${S('2')}.job-o2`, started: [expect.stringMatching(/Verification agent/)] })
    expect(started.length).toBe(2)
    expect(started[1]).toMatchObject({ agent: 'verify', requestedBySub: USER.sub })
  })

  it('a start the jobs API refuses is said, with Start it', async () => {
    // a fresh start of the criterion: no earlier start in the record
    await journeyStore(ctx(ADMIN), REPO).update((d) => { d.prepare("DELETE FROM decisions WHERE kind LIKE 'work.%'").run(); return { result: null } })
    refuse = 'the budget has nothing left for cloud work'
    const j = await run(USER, 'journey.get', { repo: REPO })
    expect(j.next).toMatchObject({ kind: 'task', button: 'Start it', summary: 'trace is not working on Sign-off: every requirement is verified or waived. trace could not start its work: the budget has nothing left for cloud work.' })
    expect((await decisions())[0]).toBe('work.not_started signoff.coverage')
    // and the next look says the same without trying again
    await run(USER, 'journey.get', { repo: REPO })
    expect((await decisions()).filter((d) => d.startsWith('work.not_started')).length).toBe(1)
    await expect(run(USER, 'journey.start_work', { repo: REPO })).rejects.toThrow(/trace could not start its work on "Every requirement is verified or waived": the budget has nothing left for cloud work\./)
    refuse = null
  })

  it('Start it is refused while a job of trace\'s is working on the project', async () => {
    await jobIndex(ctx(ADMIN), REPO).update((d) => {
      const now = Date.now() / 1000
      putJob(d, 'job-busy', { kind: 'task', agent: 'emc', title: 'busy', state: 'running', session: S('b'), queuedAt: now - 60, startedAt: now - 60, beatAt: now - 5 }, now)
      return { result: null }
    })
    await expect(run(USER, 'journey.start_work', { repo: REPO })).rejects.toThrow(/trace is working on this project already/)
  })
})

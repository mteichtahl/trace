/**
 * A job that ended without finishing is never a dead end (test-esp32 log #45, #46, #56): its card offers Start again
 * (the same request on the same branch, as a new attempt that links back to it) and Dismiss (with an optional reason,
 * recorded); the next step says it ended and offers Start again instead of "trace works on …" or a person's Continue;
 * and a lost first attempt that left no change is started again by trace on its own, once (src/api/actions-jobs.ts).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, type JobsApi, perform } from '../../src/api/actions.js'
import { attemptOf, jobIndex, lostJobStep, settledOf, stoppedSteps } from '../../src/api/actions-jobs.js'
import { journeyStore } from '../../src/api/action-kit.js'
import { parseHandle } from '../../src/api/workers.js'
import { AccessDenied, assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { STALE_AFTER_S, loadControls, putJob } from '../../src/core/job-index.js'
import { type NextStep, type StageView, loadJourney, startJourney } from '../../src/core/journey.js'
import { projectHash } from '../../src/core/project.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'l-admin', email: 'l-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'l-user', email: 'l-user@example.com', groups: ['trace-users'] }
const REVIEWER = { sub: 'l-rev', email: 'l-rev@example.com', groups: ['trace-users'] }
const REPO = 'acme/lost'
const AUTO = 'acme/lost-auto'
const MERGED = 'acme/lost-merged'
const S = (repo: string, n: string): string => `trace-api-${projectHash(repo)}-${n.repeat(24).slice(0, 24)}`
const github = new FakeGitHub([REPO, AUTO, MERGED])
const scratch = mkdtempSync(join(tmpdir(), 'trace-lost-jobs-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-lost-jobs-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

const started: Record<string, unknown>[] = []
let accept = true
const jobsApi: JobsApi = {
  repositoryOf: (id) => { const h = parseHandle(id); return h?.hash === projectHash(REPO) ? REPO : h?.hash === projectHash(AUTO) ? AUTO : h?.hash === projectHash(MERGED) ? MERGED : null },
  startJob: async (p) => { started.push(p); return accept ? { accepted: true, jobId: `${S(p.repository, 'f')}.job-again-${started.length}` } : { accepted: false, jobId: '', reason: 'the runtime is busy' } },
  jobStatus: async () => [],
}
const deps: ActionDeps = { github: async () => github, cognito: () => new FakeCognito(), jobs: async () => jobsApi, tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)) }
const ctx = (principal: Context['principal']): Context => ({ principal, deps })
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  (await perform(action, args, ctx(who))).result as Record<string, unknown>
const listed = async (repo: string, id: string): Promise<Record<string, unknown> | undefined> =>
  ((await run(USER, 'jobs.list', { repo })).jobs as Record<string, unknown>[]).find((j) => j.workerJobId === id)
const decisions = async (repo: string) => (await journeyStore(ctx(USER), repo).read((d) => loadJourney(d)?.decisions ?? [])).result

const payload = (repo: string, request: string) => JSON.stringify({ kind: 'task', repository: repo, request, requestedBy: USER.email, requestedBySub: USER.sub, agent: 'impl' })

beforeAll(async () => {
  for (const repo of [REPO, AUTO, MERGED]) {
    await assign(ADMIN, USER, repo, { class: 'user' })
    await assign(ADMIN, REVIEWER, repo, { part: 'reviewer', class: 'user' })
    const dir = mkdtempSync(join(scratch, 'seed-'))
    mkdirSync(join(dir, '.git'))
    const db = openProject(dir)
    startJourney(db, { template: 'board', by: 'seed', name: 'Lost' })
    db.close()
    github.files.set(`${repo}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  }
  // silent for longer than STALE_AFTER_S: lost. Each is already a second attempt (resume_of), so trace does not start
  // it again on its own: a person decides
  const silent = Date.now() / 1000 - STALE_AFTER_S - 120
  await jobIndex(ctx(ADMIN), REPO).update((d) => {
    const put = (id: string, f: Parameters<typeof putJob>[2]) => putJob(d, id, { kind: 'task', agent: 'impl', title: id, state: 'running', startedAt: silent - 60, beatAt: silent, resumeOf: 'job-first', ...f }, silent)
    put('job-sch', { title: 'Draw the schematic', session: S(REPO, 'a'), branch: 'claude/task-draw-the-schematic', payload: payload(REPO, 'Draw the schematic') })
    put('job-docs', { title: 'Write the user guide', agent: 'docs', session: S(REPO, 'b'), branch: 'claude/task-user-guide', payload: payload(REPO, 'Write the user guide') })
    // a workflow's work item: its request is the workflow's, not recorded here; it can only be dismissed
    put('job-wi', { kind: 'work-item', agent: 'emc', session: 'trace-acme-lost-5-abcdef1234567890', resumeOf: null })
    return { result: null }
  })
  await jobIndex(ctx(ADMIN), AUTO).update((d) => {
    putJob(d, 'job-route', { kind: 'task', agent: 'impl', title: 'Route the board', state: 'running', session: S(AUTO, 'c'), startedAt: silent - 60, beatAt: silent, branch: 'claude/task-route', payload: payload(AUTO, 'Route the board') }, silent)
    return { result: null }
  })
  // #202: the Documentation specialist's job opened its change and went quiet; its request was not recorded (owned work),
  // so before the merge it can only be dismissed
  await jobIndex(ctx(ADMIN), MERGED).update((d) => {
    putJob(d, 'job-guide', { kind: 'task', agent: 'docs', title: 'Write the sign-off documents', state: 'running', session: S(MERGED, 'd'), startedAt: silent - 60, beatAt: silent, branch: 'claude/docs-sign-off' }, silent)
    putJob(d, 'job-open', { kind: 'task', agent: 'docs', title: 'Write the release notes', state: 'running', session: S(MERGED, 'e'), startedAt: silent - 60, beatAt: silent, branch: 'claude/docs-release-notes' }, silent)
    putJob(d, 'job-old', { kind: 'task', agent: 'docs', title: 'Write the assembly notes', state: 'running', session: S(MERGED, '9'), startedAt: silent - 60, beatAt: silent, branch: 'claude/docs-assembly' }, silent)
    return { result: null }
  })
})

describe('a lost job\'s card', () => {
  it('offers Start again and Dismiss to a contributor, Dismiss only for a job whose request was not recorded, nothing to a reviewer', async () => {
    expect(await listed(REPO, 'job-sch')).toMatchObject({ state: 'lost', controls: ['restart', 'dismiss'], settled: null })
    expect(await listed(REPO, 'job-wi')).toMatchObject({ state: 'lost', controls: ['dismiss'] })
    expect(((await run(REVIEWER, 'jobs.list', { repo: REPO })).jobs as { controls: string[] }[]).every((j) => j.controls.length === 0)).toBe(true)
    await expect(run(REVIEWER, 'job.control', { id: `${S(REPO, 'a')}.job-sch`, op: 'restart' })).rejects.toThrow(AccessDenied)
  })

  it('the next step says the job ended without finishing and offers Start again, never "trace works on …"', async () => {
    const j = await run(USER, 'journey.get', { repo: REPO })
    const next = j.next as NextStep
    expect(next).toMatchObject({ kind: 'task', yours: true, button: 'Start it again', ref: { kind: 'action', id: 'job.restart' }, job_id: `${S(REPO, 'a')}.job-sch` })
    expect(next.summary).toMatch(/ended without finishing: trace lost contact with it, and nothing is doing its work now\. 2 more jobs ended the same way/)
    expect(next.after ?? '').not.toMatch(/trace works on/)
    // second attempts are not started again by trace on its own
    expect(j.jobs_restarted).toBeUndefined()
    expect(started).toEqual([])
    // a reviewer reads the stage
    expect(((await run(REVIEWER, 'journey.get', { repo: REPO })).next as NextStep).button).toBe('Read the stage')
  })

  it('Start again asks for the same request on the same branch as a new attempt, linked to the lost one, and once', async () => {
    const r = await run(USER, 'job.control', { id: `${S(REPO, 'a')}.job-sch`, op: 'restart' })
    expect(r).toMatchObject({ ok: true, state: 'queued', jobId: `${S(REPO, 'f')}.job-again-1`, kept: 'It starts again on claude/task-draw-the-schematic, from what the lost attempt left there.' })
    expect(started.at(-1)).toEqual({
      kind: 'task', repository: REPO, request: 'Draw the schematic', requestedBy: USER.email, requestedBySub: USER.sub, agent: 'impl',
      branch: 'claude/task-draw-the-schematic', restart: { job: 'job-sch', by: USER.email }, attempt: 3,
    })
    // it leaves the card at once (before the new job is in the index), and a second press starts nothing
    expect(await listed(REPO, 'job-sch')).toMatchObject({ settled: { how: 'restarted', by: USER.email }, controls: [] })
    expect(await run(USER, 'job.control', { id: `${S(REPO, 'a')}.job-sch`, op: 'restart' })).toMatchObject({ ok: false, reason: expect.stringMatching(/started again already/) })
    expect(started).toHaveLength(1)
    expect((await decisions(REPO)).find((d) => d.kind === 'job.restarted')).toMatchObject({ ref: 'job-sch', by: USER.email, summary: expect.stringMatching(/started "Draw the schematic" again on claude\/task-draw-the-schematic/) })
  })

  it('a refused start takes the claim back, so the card offers Start again again', async () => {
    accept = false
    expect(await run(USER, 'job.control', { id: `${S(REPO, 'b')}.job-docs`, op: 'restart' })).toMatchObject({ ok: false, reason: 'trace could not start it again: the runtime is busy.' })
    accept = true
    expect(await listed(REPO, 'job-docs')).toMatchObject({ settled: null, controls: ['restart', 'dismiss'] })
  })

  it('Dismiss, with a reason, takes it off the card and the next step, and is recorded', async () => {
    expect(await run(USER, 'job.control', { id: `${S(REPO, 'b')}.job-docs`, op: 'dismiss', reason: 'The guide was written by hand.' })).toMatchObject({ ok: true, dismissed: true })
    expect(await listed(REPO, 'job-docs')).toMatchObject({ settled: { how: 'dismissed', by: USER.email, reason: 'The guide was written by hand.' }, controls: [] })
    const c = (await journeyStore(ctx(USER), REPO).read((d) => loadControls(d))).result.get('job-docs')
    expect(c).toMatchObject({ dismissed: true, reason: 'The guide was written by hand.', by: USER.email })
    expect((await decisions(REPO)).find((d) => d.kind === 'job.dismissed')).toMatchObject({ ref: 'job-docs', summary: `${USER.email} dismissed "Write the user guide", which ended without finishing: The guide was written by hand.` })
    // without a reason too
    expect(await run(USER, 'job.control', { id: `p${projectHash(REPO)}.trace-acme-lost-5-abcdef1234567890.job-wi`, op: 'dismiss' })).toMatchObject({ ok: true })
    // nothing lost is left: the next step is the stage's own again
    const next = (await run(USER, 'journey.get', { repo: REPO })).next as NextStep
    expect(next.ref?.kind).not.toBe('action')
    expect(next.summary).not.toMatch(/ended without finishing/)
  })
})

describe('trace starts a lost job again on its own', () => {
  it('once, when it is a first attempt that left no change, with a note in the decisions', async () => {
    const before = started.length
    const j = await run(USER, 'journey.get', { repo: AUTO })
    expect(j.jobs_restarted).toEqual(['Route the board'])
    expect(started.slice(before)).toEqual([expect.objectContaining({ request: 'Route the board', branch: 'claude/task-route', restart: { job: 'job-route', by: 'trace' }, attempt: 2 })])
    expect((await decisions(AUTO)).find((d) => d.kind === 'job.restarted')).toMatchObject({ by: 'trace', summary: expect.stringMatching(/trace started "Route the board" again on its own.*If this attempt stops too, trace asks you/) })
    // the lost one is settled: no card, and the next step is not about it
    expect((j.next as NextStep).ref?.id).not.toBe('job.restart')
    // a second look starts nothing more
    await run(USER, 'journey.get', { repo: AUTO })
    expect(started.length).toBe(before + 1)
  })
})

describe('a lost job whose change was merged is finished (#186, #202)', () => {
  const asked = (branch: string): number => github.calls.filter((c) => c === `mergedPullFor ${MERGED} ${branch}`).length
  const silentAt = Date.now() / 1000 - STALE_AFTER_S - 120

  it('before the merge: lost, on the card and the next step, with Dismiss', async () => {
    expect(await listed(MERGED, 'job-guide')).toMatchObject({ state: 'lost', settled: null, controls: ['dismiss'] })
    const j = await run(USER, 'journey.get', { repo: MERGED })
    expect(j.next as NextStep).toMatchObject({ button: 'Dismiss it', ref: { kind: 'action', id: 'job.dismiss' } })
  })

  it('once its pull request merged: succeeded, settled as merged, no controls, not the next step', async () => {
    github.mergedList.set(`${MERGED}:claude/docs-sign-off`, { number: 35, mergedAt: new Date((silentAt + 30) * 1000).toISOString() })
    // a pull request from the branch merged before the job started is an earlier job's: this one stays lost
    github.mergedList.set(`${MERGED}:claude/docs-assembly`, { number: 12, mergedAt: new Date((silentAt - 3600) * 1000).toISOString() })
    // a branch whose pull request is still open is not asked about
    github.openList = [{ number: 36, title: 'Release notes', head: 'claude/docs-release-notes', headRepo: MERGED, draft: false, labels: [], url: 'https://github.com/acme/lost-merged/pull/36', updated_at: new Date().toISOString() }]
    const before = asked('claude/docs-release-notes')
    try {
      const guide = await listed(MERGED, 'job-guide')
      expect(guide).toMatchObject({ state: 'succeeded', error: null, step: null, controls: [], settled: { how: 'merged', by: 'trace', number: 35 } })
      expect(guide?.summary).toMatch(/#35\) was accepted into the design/)
      expect(await listed(MERGED, 'job-old')).toMatchObject({ state: 'lost', settled: null })
      expect(await listed(MERGED, 'job-open')).toMatchObject({ state: 'lost', settled: null })
      expect(asked('claude/docs-release-notes')).toBe(before)
      // a job.control on it is refused in words: there is nothing to dismiss or start again
      expect(await run(USER, 'job.control', { id: `${S(MERGED, 'd')}.job-guide`, op: 'dismiss' })).toMatchObject({ ok: false })
      // the next step is no longer about it (so the step it worked on does not read stopped for it: stoppedSteps follows the next step)
      const j = await run(USER, 'journey.get', { repo: MERGED })
      expect((j.next as NextStep & { job_id?: string }).job_id).not.toBe(`${S(MERGED, 'd')}.job-guide`)
      // the other two are still lost, so dismiss them: then nothing is left to stop a step
      for (const [s, id] of [['e', 'job-open'], ['9', 'job-old']] as const) expect(await run(USER, 'job.control', { id: `${S(MERGED, s)}.${id}`, op: 'dismiss' })).toMatchObject({ ok: true })
      const after = await run(USER, 'journey.get', { repo: MERGED })
      expect((after.next as NextStep).ref?.kind).not.toBe('action')
      expect((after.next as NextStep).summary).not.toMatch(/ended without finishing/)
      // trace never starts a merged job again on its own
      expect(after.jobs_restarted).toBeUndefined()
      // once known merged, it is not asked again
      const n = asked('claude/docs-sign-off')
      await listed(MERGED, 'job-guide')
      expect(asked('claude/docs-sign-off')).toBe(n)
    } finally {
      github.openList = []
    }
  })

  it('settledOf: dismissed and started again come first; merged settles one nobody decided about', () => {
    const merged = { number: 35, mergedAt: '2026-11-05T10:00:00.000Z' }
    expect(settledOf({ resumedBy: null }, undefined, 1, merged)).toEqual({ how: 'merged', by: 'trace', at: merged.mergedAt, reason: null, number: 35 })
    expect(settledOf({ resumedBy: null }, undefined, 1, null)).toBeNull()
    const dismissed = { job: 'b', held: false, order: null, discarded: false, dismissed: true, reason: null, restartedBy: null, restartedAt: null, by: 'n@example.com', at: 1000 }
    expect(settledOf({ resumedBy: null }, dismissed, 1000, merged)).toMatchObject({ how: 'dismissed' })
    expect(settledOf({ resumedBy: 'job-new' }, undefined, 1, merged)).toMatchObject({ how: 'restarted' })
  })
})

describe('the pieces', () => {
  const working: NextStep = {
    kind: 'working', belongs_to: 'trace', yours: false, summary: 'trace is working on Capture: draw the schematic.', why: 'The schematic gate needs it (1 of 3 criteria met).',
    recommendation: null, button: 'Watch', stage: 'capture', ref: { kind: 'criterion', id: 'capture.schematic' }, step: { index: 1, total: 3 }, after: 'When trace has done this, trace works on the next criterion: check the parts.',
  }
  const lost = [{ id: 'h.job-1', title: 'Draw the schematic', agentName: 'Implementation', kind: 'task', parentJob: null, handoff: null }]
  const you = { admin: false, part: 'contributor' as const }

  it('lostJobStep replaces "trace is working" and a person\'s Continue, and leaves questions, gates and changes first', () => {
    const s = lostJobStep(working, lost, you, () => true)
    expect(s).toMatchObject({ kind: 'task', yours: true, button: 'Start it again', ref: { kind: 'action', id: 'job.restart' }, job_id: 'h.job-1', step: null })
    expect(s.summary).toBe('The Implementation job "Draw the schematic" ended without finishing: trace lost contact with it, and nothing is doing its work now.')
    expect(s.after).not.toMatch(/trace works on/)
    expect(lostJobStep({ ...working, kind: 'task', belongs_to: 'you', yours: true, button: 'Continue' }, lost, you, () => true).button).toBe('Start it again')
    for (const kind of ['gate', 'review', 'answer', 'failed', 'waiting_person'] as const) expect(lostJobStep({ ...working, kind }, lost, you, () => true)).toEqual({ ...working, kind })
    // drafting the requirements again is its own action
    const draft = { ...working, kind: 'task' as const, ref: { kind: 'action' as const, id: 'requirements.draft' } }
    expect(lostJobStep(draft, lost, you, () => true)).toBe(draft)
    expect(lostJobStep(working, [], you, () => true)).toBe(working)
    // one that cannot be started again from here: Dismiss
    expect(lostJobStep(working, lost, you, () => false)).toMatchObject({ button: 'Dismiss it', ref: { kind: 'action', id: 'job.dismiss' }, recommendation: null })
  })

  it('stoppedSteps marks trace\'s step now as stopped, and nothing else', () => {
    const stages = [{ steps: [
      { id: 'a', text: 'Draw the schematic', owner: 'trace', state: 'now', ref: null },
      { id: 'b', text: 'Agree the pin plan', owner: 'you', state: 'next', ref: null },
    ] }] as Pick<StageView, 'steps'>[]
    expect(stoppedSteps(stages)[0]?.steps.map((s) => s.stopped ?? false)).toEqual([true, false])
  })

  it('attemptOf counts the jobs a job starts again or carries on; settledOf lets a stale claim go', () => {
    const rows = [{ id: 'a', resumeOf: null }, { id: 'b', resumeOf: 'a' }, { id: 'c', resumeOf: 'b' }]
    expect(attemptOf(rows[2]!, rows)).toBe(3)
    expect(attemptOf({ id: 'x', resumeOf: 'x' }, [])).toBe(1)
    const claim = { job: 'b', held: false, order: null, discarded: false, dismissed: false, reason: null, restartedBy: 'n@example.com', restartedAt: 1000, by: 'n@example.com', at: 1000 }
    expect(settledOf({ resumedBy: null }, claim, 1000 + 60)).toMatchObject({ how: 'restarted' })
    expect(settledOf({ resumedBy: null }, claim, 1000 + 3600)).toBeNull()
    expect(settledOf({ resumedBy: 'job-new' }, undefined, 1)).toMatchObject({ how: 'restarted', by: 'trace' })
  })
})

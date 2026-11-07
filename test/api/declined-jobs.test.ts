/**
 * A person's task its specialist declined as another specialist's work (test log R26: Implementation was asked to change
 * a requirement's criterion, said it was Verification's, changed nothing, and the job read as a plain success). Its view
 * says it was declined and for whom, and offers Send it to <specialist> (job.control send), once.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, type JobsApi, perform } from '../../src/api/actions.js'
import { jobIndex } from '../../src/api/actions-jobs.js'
import { journeyStore } from '../../src/api/action-kit.js'
import { parseHandle } from '../../src/api/workers.js'
import { AccessDenied, assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { putJob } from '../../src/core/job-index.js'
import { loadJourney, startJourney } from '../../src/core/journey.js'
import { projectHash } from '../../src/core/project.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { declinedSummary } from '../../src/agents/declines.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'd-admin', email: 'd-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'd-user', email: 'd-user@example.com', groups: ['trace-users'] }
const REVIEWER = { sub: 'd-rev', email: 'd-rev@example.com', groups: ['trace-users'] }
const REPO = 'acme/declined'
const S = (n: string): string => `trace-api-${projectHash(REPO)}-${n.repeat(24).slice(0, 24)}`
const github = new FakeGitHub([REPO])
const scratch = mkdtempSync(join(tmpdir(), 'trace-declined-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-declined-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

const started: Record<string, unknown>[] = []
let accept = true
const jobsApi: JobsApi = {
  repositoryOf: (id) => (parseHandle(id)?.hash === projectHash(REPO) ? REPO : null),
  startJob: async (p) => { started.push(p); return accept ? { accepted: true, jobId: `${S('f')}.job-sent-${started.length}` } : { accepted: false, jobId: '', reason: 'the runtime is busy' } },
  jobStatus: async () => [],
}
const deps: ActionDeps = { github: async () => github, cognito: () => new FakeCognito(), jobs: async () => jobsApi, tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)) }
const ctx = (principal: Context['principal']): Context => ({ principal, deps })
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  (await perform(action, args, ctx(who))).result as Record<string, unknown>
const listed = async (id: string, who: Context['principal'] = USER): Promise<Record<string, unknown> | undefined> =>
  ((await run(who, 'jobs.list', { repo: REPO })).jobs as Record<string, unknown>[]).find((j) => j.workerJobId === id)

const REQUEST = 'Change REQ-7ec888\'s acceptance criterion to: blinks at 1 Hz ± 10 %'
const R26 = 'I didn\'t change REQ-7ec888. Editing a requirement\'s acceptance criterion belongs to the Verification specialist, not to Implementation, so this job should go to them.'

beforeAll(async () => {
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await assign(ADMIN, REVIEWER, REPO, { part: 'reviewer', class: 'user' })
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Declined' })
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  const at = Date.now() / 1000 - 600
  const payload = JSON.stringify({ kind: 'task', repository: REPO, request: REQUEST, requestedBy: USER.email, requestedBySub: USER.sub, agent: 'impl' })
  await jobIndex(ctx(ADMIN), REPO).update((d) => {
    const put = (id: string, n: string, summary: string) => putJob(d, id, {
      kind: 'task', agent: 'impl', title: 'Change the criterion', state: 'succeeded', session: S(n), startedAt: at, endedAt: at + 60, summary, payload,
    }, at + 60)
    put('job-r26', 'a', declinedSummary('impl', { to: 'verify', why: R26 }, R26))
    put('job-busy', 'b', declinedSummary('impl', { to: 'verify', why: R26 }, R26))
    put('job-done', 'c', 'impl: done in 4 turns: routed the board')
    return { result: null }
  })
})

describe('a declined job', () => {
  it('reads as declined for the specialist it named, with Send it on for a contributor only', async () => {
    expect(await listed('job-r26')).toMatchObject({
      state: 'succeeded', controls: ['send'],
      declined: { from: 'impl', to: 'verify', toName: 'Verification', sent: null, why: expect.stringMatching(/^I didn't change REQ-7ec888/) },
      step: 'Declined: the Implementation specialist changed nothing; it says this is the Verification specialist\'s work.',
    })
    expect(await listed('job-done')).toMatchObject({ declined: null, controls: [] })
    expect(await listed('job-r26', REVIEWER)).toMatchObject({ declined: { to: 'verify' }, controls: [] })
    await expect(run(REVIEWER, 'job.control', { id: `${S('a')}.job-r26`, op: 'send' })).rejects.toThrow(AccessDenied)
  })

  it('Send it on starts the same request for that specialist on a new branch, once, and notes it', async () => {
    const r = await run(USER, 'job.control', { id: `${S('a')}.job-r26`, op: 'send' })
    expect(r).toMatchObject({ ok: true, state: 'queued', jobId: `${S('f')}.job-sent-1`, kept: 'The Verification specialist takes it on a new branch.' })
    expect(started).toEqual([{ kind: 'task', repository: REPO, request: REQUEST, requestedBy: USER.email, requestedBySub: USER.sub, agent: 'verify' }])
    expect(await listed('job-r26')).toMatchObject({ declined: { sent: { by: USER.email } }, controls: [], step: expect.stringMatching(/d-user@example\.com sent it to them\.$/) })
    expect(await run(USER, 'job.control', { id: `${S('a')}.job-r26`, op: 'send' })).toMatchObject({ ok: false, reason: expect.stringMatching(/sent to the Verification specialist already/) })
    expect(started).toHaveLength(1)
    const decisions = (await journeyStore(ctx(USER), REPO).read((d) => loadJourney(d)?.decisions ?? [])).result
    expect(decisions.find((d) => d.kind === 'job.sent')).toMatchObject({ ref: 'job-r26', by: USER.email, summary: expect.stringMatching(/to the Verification specialist: the Implementation specialist changed nothing/) })
    // a job that was not declined cannot be sent on
    expect(await run(USER, 'job.control', { id: `${S('c')}.job-done`, op: 'send' })).toMatchObject({ ok: false, reason: expect.stringMatching(/declined as another's work/) })
  })

  it('a refused start takes the claim back, so the card offers Send it on again', async () => {
    accept = false
    expect(await run(USER, 'job.control', { id: `${S('b')}.job-busy`, op: 'send' })).toMatchObject({ ok: false, reason: 'trace could not send it on: the runtime is busy.' })
    accept = true
    expect(await listed('job-busy')).toMatchObject({ declined: { sent: null }, controls: ['send'] })
  })
})

/**
 * Intent builder's Submit: with every check of the bar met, it records the person's decisions and then starts the
 * Verification agent drafting the candidate requirements that open Requirements review (docs/user-journey.md,
 * Intent builder: "What it produces"). When the job cannot start, the submission still stands and says why.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { REQUIREMENTS_FROM_INTENT } from '../../src/api/actions-skills.js'
import { jobIndex } from '../../src/api/actions-jobs.js'
import { AccessDenied, assign, seen } from '../../src/core/access.js'
import { putJob } from '../../src/core/job-index.js'
import { projectHash, projectSlug } from '../../src/core/project.js'
import { backendFor } from '../../src/core/central.js'
import { type JourneyRecord, type NextStep, startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { DesignDb } from '../../src/tools/design/db.js'
import { VerifyDb } from '../../src/tools/verify/db.js'
import { draftingOf, draftingStep, needsCount } from '../../src/api/drafting.js'
import { GitHubCache } from '../../src/api/github-cache.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'i-admin', email: 'i-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'i-user', email: 'i-user@example.com', groups: ['trace-users'] }
const REVIEWER = { sub: 'i-rev', email: 'i-rev@example.com', groups: ['trace-users'] }
const REPO = 'acme/intent'
const github = new FakeGitHub([REPO])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-intent-api-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-intent-bucket-'))
const started: { repository: string; request: string; agent?: string | undefined; requestedBy: string; attempt?: number | undefined }[] = []
let refuse: string | null = null
const deps: ActionDeps = {
  github: async () => github, cognito: () => cognito,
  jobs: async () => ({
    repositoryOf: () => null, jobStatus: async () => [],
    startJob: async (p) => { if (refuse) return { accepted: false, jobId: '', reason: refuse }; started.push(p); return { accepted: true, jobId: `job-${started.length}` } },
  }),
  tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)),
}
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<unknown> => (await perform(action, args, { principal: who, deps })).result

beforeAll(async () => {
  cognito.add(ADMIN.email, ADMIN.sub, 'trace-admins')
  cognito.add(USER.email, USER.sub, 'trace-users')
  cognito.add(REVIEWER.email, REVIEWER.sub, 'trace-users')
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await assign(ADMIN, REVIEWER, REPO, { part: 'reviewer', class: 'user' })
  await seen(USER)
  await seen(REVIEWER)
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Flasher' })
  const d = new DesignDb(dir)
  d.addIntent([
    { id: 'INT-purpose', topic: 'purpose', text: 'A 20 × 20 mm board where a TLC555 flashes a red LED once every 2 seconds.' },
    { id: 'INT-env', topic: 'environment', text: 'Indoor desk use, 0 to 40 °C ambient.' },
    { id: 'INT-power', topic: 'power', text: 'Runs from 5 V ± 0.25 V on a USB-C socket.' },
    { id: 'INT-usb', topic: 'interfaces', text: 'USB-C power input.', interface: { type: 'power input', connector: 'USB-C receptacle', protocol: 'none (sink, 5.1 kΩ on CC1 and CC2)', rate: 'not applicable', direction: 'in' } },
    { id: 'INT-old', topic: 'interfaces', text: 'Works with USB-C chargers.', interface: { type: 'USB-C sink', connector: 'USB-C receptacle' } },
    { id: 'INT-flash', topic: 'performance', text: 'Flashes at 0.5 Hz ± 10 %.' },
    { id: 'INT-size', topic: 'physical', text: 'The board is at most 20 × 20 mm.' },
    { id: 'INT-comp', topic: 'compliance', text: 'None required: internal prototype.' },
    { id: 'INT-build', topic: 'build', text: '10 boards assembled at JLCPCB.' },
    { id: 'INT-part', topic: 'constraints', text: 'Use the CMOS TLC555 timer.' },
    { id: 'INT-refs', topic: 'references', text: 'docs/requirements.md' },
  ])
  d.close()
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
  rmSync(dir, { recursive: true, force: true })
})

describe('Intent builder draft panel', () => {
  it('shows a statement Accepted only once the person accepts it: the preview does not accept the rest', async () => {
    await run(USER, 'skill.draft', { repo: REPO, skill: 'intent-builder', step: 0, data: { decisions: [{ statement: 'INT-purpose', choice: 'accept' }] } })
    const v = await run(USER, 'skill.get', { repo: REPO, skill: 'intent-builder' }) as { intent: { statements: { id: string; state: string }[] } }
    const state = (id: string) => v.intent.statements.find((x) => x.id === id)?.state
    expect(state('INT-purpose')).toBe('accepted')
    expect(state('INT-env')).toBe('draft')
    await run(USER, 'skill.draft', { repo: REPO, skill: 'intent-builder', step: 0, data: null })
  })
})

type Next = { kind: string; summary: string; button: string; ref: { kind: string; id: string } | null; job_id?: string; after: string | null }
const journey = async (who: Context['principal'] = USER) => await run(who, 'journey.get', { repo: REPO }) as { next: Next; drafting?: { state: string; job: { id: string; state: string } | null; why: string | null } }

describe('the next step before the requirements exist', () => {
  it('is to write the intent in the Intent builder, not to accept requirements that do not exist', async () => {
    const calls = github.calls.length
    const j = await journey()
    // nothing submitted and no drafting job: the step is the intent whatever the record holds, so it is not read
    expect(github.calls.slice(calls)).toEqual([])
    expect(j.next).toMatchObject({ kind: 'task', summary: 'Define: Write the product intent in the Intent builder.', button: 'Open the Intent builder', ref: { kind: 'skill', id: 'intent-builder' } })
    expect(j.next.summary).not.toMatch(/accepted or struck/)
    expect(j.drafting).toMatchObject({ state: 'intent', job: null })
    // drafting again is refused while there is no intent to draft from
    await expect(run(USER, 'requirements.draft', { repo: REPO })).rejects.toThrow(/Intent builder first/)
  })
})

describe('Intent builder Submit', () => {
  it('records the decisions, then starts the Verification agent drafting the candidate requirements', async () => {
    // INT-old lacks the protocol and rate, so the bar is not met until the person rejects it
    await expect(run(USER, 'skill.submit', { repo: REPO, skill: 'intent-builder', draft: {} })).rejects.toThrow(/Interfaces fully specified/)
    expect(started).toEqual([])
    const r = await run(USER, 'skill.submit', { repo: REPO, skill: 'intent-builder', draft: { decisions: [{ statement: 'INT-old', choice: 'reject', reason: 'superseded by INT-usb' }] } }) as { ok: boolean; jobId?: string; jobError?: string; started: string[] }
    expect(r).toMatchObject({ ok: true, jobId: 'job-1', started: [expect.stringMatching(/drafts the candidate requirements/)] })
    expect(r.jobError).toBeUndefined()
    expect(started).toEqual([{ kind: 'task', repository: REPO, request: REQUIREMENTS_FROM_INTENT, agent: 'verify', requestedBy: USER.email, requestedBySub: USER.sub }])
    expect(REQUIREMENTS_FROM_INTENT).toMatch(/design\.intent list/)
    expect(REQUIREMENTS_FROM_INTENT).toMatch(/Leave every requirement proposed/)
    const t = await run(USER, 'requirements.trace', { repo: REPO }) as { intent: { id: string; state: string }[] }
    expect(t.intent.find((s) => s.id === 'INT-old')).toBeUndefined()
    expect(t.intent.find((s) => s.id === 'INT-usb')?.state).toBe('accepted')
  })

  it('stands when the job cannot start, and says why', async () => {
    refuse = "acme/intent's agent is not set up yet"
    try {
      const r = await run(USER, 'skill.submit', { repo: REPO, skill: 'intent-builder', draft: {} }) as { ok: boolean; jobId?: string; jobError?: string; started: string[] }
      expect(r).toMatchObject({ ok: true, jobError: "acme/intent's agent is not set up yet", started: [] })
      expect(r.jobId).toBeUndefined()
    } finally { refuse = null }
  })
})

describe('after Submit, until the requirements are drafted', () => {
  const at = () => Date.now() / 1000
  const draftingRow = (id: string, f: Partial<Parameters<typeof putJob>[2]>) => jobIndex({ principal: ADMIN, deps }, REPO).update((d) => {
    putJob(d, id, {
      kind: 'task', agent: 'verify', title: REQUIREMENTS_FROM_INTENT.replace(/\s+/g, ' ').slice(0, 200), session: `trace-api-${projectHash(projectSlug(REPO))}-${'a'.repeat(24)}`,
      payload: JSON.stringify({ kind: 'task', repository: REPO, request: REQUIREMENTS_FROM_INTENT, agent: 'verify', requestedBy: USER.email }), ...f,
    } as Parameters<typeof putJob>[2], at())
    return { result: null }
  })

  it('says trace is drafting them while the job runs, with the job, never "accept every requirement"', async () => {
    // queued by the Submit just made (a row from before a Submit is an earlier one's: then the new job is starting)
    await draftingRow('job-draft-1', { state: 'running', queuedAt: at(), startedAt: at(), beatAt: at() })
    const j = await journey()
    expect(j.next).toMatchObject({ kind: 'working', summary: 'trace is drafting the requirements from your intent.', ref: null })
    expect(j.next.job_id).toMatch(/\.job-draft-1$/)
    expect(j.drafting?.state).toBe('drafting')
    await expect(run(USER, 'requirements.draft', { repo: REPO })).rejects.toThrow(/drafting the requirements already/)
  })

  it('a lost job: the step and the page offer to draft them again, which starts the same job as a new attempt', async () => {
    // the runtime went silent for 15 minutes (test-2): past the heartbeat's limit, lost
    await draftingRow('job-draft-1', { state: 'running', beatAt: at() - 15 * 60 })
    const j = await journey()
    expect(j.drafting).toMatchObject({ state: 'stopped', job: { state: 'lost' } })
    expect(j.drafting?.why).toMatch(/stopped answering .* has not heard from it for 15 minutes, so it is lost/)
    expect(j.next).toMatchObject({ kind: 'task', button: 'Draft the requirements again', ref: { kind: 'action', id: 'requirements.draft' } })
    expect(j.next.summary).toMatch(/lost\. Draft the requirements again/)
    // a reviewer reads it, and may not start it
    expect((await journey(REVIEWER)).next).toMatchObject({ button: 'Read the stage' })
    await expect(run(REVIEWER, 'requirements.draft', { repo: REPO })).rejects.toThrow(AccessDenied)
    started.length = 0
    const r = await run(USER, 'requirements.draft', { repo: REPO }) as { jobId: string; attempt: number; started: string[] }
    // the same request and agent as Submit, as the second attempt (its own session: src/api/workers.ts taskSession)
    expect(started).toEqual([{ kind: 'task', repository: REPO, request: REQUIREMENTS_FROM_INTENT, agent: 'verify', requestedBy: USER.email, requestedBySub: USER.sub, attempt: 2 }])
    expect(r).toMatchObject({ attempt: 2, started: [expect.stringMatching(/drafts the candidate requirements again/)] })
  })

  it('a second press before the new job is listed is refused, not started again in the same session', async () => {
    // the retry is logged with its time: until its job is in the index, the grace counts from it (not from Submit)
    expect((await journey()).drafting?.state).toBe('drafting')
    started.length = 0
    await expect(run(USER, 'requirements.draft', { repo: REPO })).rejects.toThrow(/drafting the requirements already/)
    expect(started).toEqual([])
  })

  it('a failed job is drafted again too, as the next attempt recorded even after the index dropped older rows', async () => {
    // the second attempt's job, listed after the retry, and the first one's row pruned from the index (it keeps only its
    // newest finished rows): a count of rows would say 1 and repeat attempt 2 and its session
    await jobIndex({ principal: ADMIN, deps }, REPO).update((d) => { d.prepare("DELETE FROM jobs WHERE id='job-draft-1'").run(); return { result: null } })
    await draftingRow('job-draft-2', { state: 'failed', queuedAt: at() + 1, startedAt: at() + 1, endedAt: at() + 2, error: 'the runtime ran out of memory' })
    expect((await journey()).drafting).toMatchObject({ state: 'stopped', why: 'The Verification specialist could not draft the requirements: the runtime ran out of memory.' })
    started.length = 0
    const r = await run(USER, 'requirements.draft', { repo: REPO }) as { attempt: number }
    expect(r.attempt).toBe(3)
    expect(started[0]).toMatchObject({ attempt: 3 })
  })

  it('a finished one waits in its change', async () => {
    await draftingRow('job-draft-3', { state: 'succeeded', queuedAt: at() + 3, startedAt: at() + 3, endedAt: at() + 4 })
    expect((await journey()).drafting?.state).toBe('drafted')
    await expect(run(USER, 'requirements.draft', { repo: REPO })).rejects.toThrow(/wait in a change/)
  })

  it('once the requirements are in the record, journey.get reads them once per default-branch commit, not on every look', async () => {
    // the drafted requirements merged into the default branch's record
    const dir = mkdtempSync(join(scratch, 'reqs-'))
    writeFileSync(join(dir, 'project.db'), github.files.get(`${REPO}:main:.trace/project.db`) as Uint8Array)
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, '.trace'))
    writeFileSync(join(dir, '.trace', 'project.db'), readFileSync(join(dir, 'project.db')))
    const v = new VerifyDb(dir)
    v.addRequirement({ id: 'R1', text: 'The LED flashes at 0.5 Hz.', kind: 'functional', acceptance: '0.5 Hz ± 10 %', status: 'proposed' })
    v.close()
    github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
    const cache = { principal: USER, deps: { ...deps, githubCache: new GitHubCache() } }
    const look = async () => (await perform('journey.get', { repo: REPO }, cache)).result as { next: Next; drafting?: { state: string } }
    const before = github.calls.length
    const first = await look()
    expect(first.drafting?.state).toBe('done')
    // with requirements, the gate's own step: Requirements review, not drafting
    expect(first.next).toMatchObject({ kind: 'task', ref: { kind: 'criterion', id: 'define.accepted' } })
    const once = github.calls.length - before
    expect(once).toBeGreaterThan(0)
    await look()
    await look()
    // the default branch and the record were read for the first look only
    expect(github.calls.length - before).toBe(once)
  })
})

describe('where nothing about drafting could change the step, the record is not read', () => {
  const rec = (o: { start?: 'idea' | 'import'; stage?: string; submitted?: boolean }) => ({
    journey: { currentStage: o.stage ?? 'define', start: o.start ?? 'idea' },
    decisions: o.submitted ? [{ id: 'd', at: 1, kind: 'skill.submitted', stage: 'define', ref: 'intent-builder', summary: '', by: null, detail: null }] : [],
  }) as unknown as JourneyRecord
  const task = { kind: 'task', belongs_to: 'you', yours: true, summary: 'Define: Every requirement is accepted or struck.', why: 'x', recommendation: null, button: 'Continue', stage: 'define', ref: { kind: 'criterion', id: 'define.accepted' }, step: null, after: null } as NextStep
  const viewer = { hash: 'h', label: 'u', admin: false, part: 'contributor' } as const

  it('before Submit with no drafting job, in another stage, or when the step is a question or a gate', () => {
    expect(needsCount(rec({}), [])).toBe(false)
    expect(needsCount(rec({ submitted: true }), [])).toBe(true)
    expect(needsCount(rec({ submitted: true, stage: 'architect' }), [])).toBe(false)
    expect(needsCount(rec({ submitted: true }), [], { kind: 'gate' })).toBe(false)
    expect(needsCount(rec({ submitted: true }), [], { kind: 'answer' })).toBe(false)
  })

  it('an imported project in Define keeps its own next step: its requirements come from the import', () => {
    const d = draftingOf(REPO, rec({ start: 'import' }), [], 0, 1000)
    expect(d.state).toBe('intent')
    expect(draftingStep(task, rec({ start: 'import' }), d, viewer, '')).toBe(task)
    // the same record started from an idea is sent to the Intent builder
    expect(draftingStep(task, rec({}), d, viewer, '').ref).toEqual({ kind: 'skill', id: 'intent-builder' })
  })

  it('a reviewer\'s "Read the stage" for a stopped drafting opens the stage\'s gate, never a dead button', () => {
    const d = { state: 'stopped' as const, job: null, attempts: 1 }
    expect(draftingStep(task, rec({ submitted: true }), d, { ...viewer, part: 'reviewer' }, 'It is lost.')).toMatchObject({ button: 'Read the stage', ref: { kind: 'gate', id: 'define' } })
    expect(draftingStep(task, rec({ submitted: true }), d, viewer, 'It is lost.')).toMatchObject({ ref: { kind: 'action', id: 'requirements.draft' } })
  })
})

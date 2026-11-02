/**
 * Intent builder's Submit: with every check of the bar met, it records the person's decisions and then starts the
 * Verification agent drafting the candidate requirements that open Requirements review (docs/user-journey.md,
 * Intent builder: "What it produces"). When the job cannot start, the submission still stands and says why.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { DesignDb } from '../../src/tools/design/db.js'
import '../../src/tools/verify/db.js'
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
    const j = await journey()
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

  it('a failed job is drafted again too; a finished one waits in its change', async () => {
    await draftingRow('job-draft-1', { state: 'failed', endedAt: at() - 30, error: 'the runtime ran out of memory' })
    expect((await journey()).drafting).toMatchObject({ state: 'stopped', why: 'The Verification specialist could not draft the requirements: the runtime ran out of memory.' })
    await draftingRow('job-draft-1', { state: 'succeeded', endedAt: at() - 30 })
    expect((await journey()).drafting?.state).toBe('drafted')
    await expect(run(USER, 'requirements.draft', { repo: REPO })).rejects.toThrow(/wait in a change/)
  })
})

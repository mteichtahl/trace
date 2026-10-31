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
import { assign, seen } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { DesignDb } from '../../src/tools/design/db.js'
import '../../src/tools/verify/db.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'i-admin', email: 'i-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'i-user', email: 'i-user@example.com', groups: ['trace-users'] }
const REPO = 'acme/intent'
const github = new FakeGitHub([REPO])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-intent-api-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-intent-bucket-'))
const started: { repository: string; request: string; agent?: string | undefined; requestedBy: string }[] = []
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
  await assign(ADMIN, USER, REPO, { class: 'user' })
  await seen(USER)
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

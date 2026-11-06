/**
 * A stage's documents are written from its design as accepted (src/api/docs-follow.ts): Scribe does not start on an
 * agent's check that sits on a change not accepted yet, nor while a change carrying the stage's design work is open,
 * and the push that accepts the last of that work starts it, whatever records that push itself changed. In the test
 * run Scribe wrote the Prove and Architect documents before the record they describe was accepted, so their sections
 * said "pending", "no requirement is verified yet" and "No option has been chosen yet" (test-esp32 #58, #98).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { journeyStore } from '../../src/api/action-kit.js'
import { jobIndex } from '../../src/api/actions-jobs.js'
import { putJob } from '../../src/core/job-index.js'
import { designDoneAt } from '../../src/api/docs-follow.js'
import { loadJourney, setCriterion, startJourney } from '../../src/core/journey.js'
import type { Principal } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { register } from '../../src/core/onboard.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const REPO = 'acme/docs-after-design'
const ADMIN = { sub: 'dad-admin', email: 'dad-admin@example.com', groups: ['trace-admins'] }
const BACKEND: Principal = { sub: 'hooks-client', email: null, groups: [], kind: 'backend', name: 'web-hooks' }

class CommitsGitHub extends FakeGitHub {
  commit: { files: string[]; parent: string } = { files: [], parent: 'sha-parent' }
  async request(method: string, path: string): Promise<unknown> {
    if (method === 'GET' && path === `/repos/${REPO}/commits/sha-main`) return { parents: [{ sha: this.commit.parent }], files: this.commit.files.map((filename) => ({ filename })) }
    throw new Error(`unexpected ${method} ${path}`)
  }
}

const github = new CommitsGitHub([REPO])
const started: { request: string; agent?: string }[] = []
const scratch = mkdtempSync(join(tmpdir(), 'trace-docs-after-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-docs-after-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })
const deps: ActionDeps = {
  github: async () => github, cognito: () => new FakeCognito(), tools: () => new Registry([]), scratch,
  jobs: async () => ({
    repositoryOf: () => null,
    startJob: async (p) => {
      started.push({ request: p.request, ...(p.agent ? { agent: p.agent } : {}) })
      const id = `job-${started.length}`
      const t = Date.now() / 1000
      await jobIndex(ctx(ADMIN), REPO).update((db) => { putJob(db, id, { state: 'running', kind: 'task', agent: p.agent ?? null, title: id, startedAt: t }, t); return { result: null } })
      return { accepted: true, jobId: id }
    },
    jobStatus: async () => [],
  }),
  store: (p) => backendFor(join(bucket, p)),
}
const ctx = (principal: Principal): Context => ({ principal, deps })
const push = async (files: string[]): Promise<Record<string, any>> => {
  github.commit = { files, parent: 'sha-parent' }
  return (await perform('hook.docs', { repo: REPO }, ctx(BACKEND))).result as Record<string, any>
}
const CAPTURE = ['capture.erc', 'capture.datasheets', 'capture.stock', 'capture.pins']

/** The default branch's record: the runs Capture's criteria cite (their change accepted) and a clean rule check, or none. */
const accepted = (runs: boolean): void => {
  const dir = mkdtempSync(join(scratch, 'main-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  if (runs) {
    for (const id of CAPTURE) db.prepare("INSERT INTO runs (id, kind, started, status) VALUES (?, 'verify.run', 1, 'pass')").run(`run-${id}`)
    db.prepare("INSERT INTO runs (id, kind, subject, started, status) VALUES ('erc-clean', 'kicad.erc', 'hw/board.kicad_pro', 2, 'pass')").run()
    db.prepare('INSERT INTO artifacts VALUES (?,?,?,?)').run('erc-clean', 'erc-report.json', 'application/json', new TextEncoder().encode(JSON.stringify({ kicad_version: '9.0.0', coordinate_units: 'mm', sheets: [{ path: '/', violations: [] }] })))
  }
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
}

beforeAll(async () => {
  await register(REPO, null)
  await journeyStore(ctx(ADMIN), REPO).update((db) => {
    startJourney(db, { template: 'board', by: 'seed', name: 'Soil sensor' })
    db.prepare("UPDATE journey SET current_stage='capture'").run()
    // the agents checked every criterion of Capture, on their branches
    for (const id of CAPTURE) setCriterion(db, id, 'met', [{ kind: 'run', ref: `run-${id}` }], 'seed')
    return { result: null }
  })
  accepted(false)
})

describe('the documents wait for the design as accepted', () => {
  it('not for a check on a change that is not accepted yet (#58)', async () => {
    const r = await push(['hardware/board.kicad_sch'])
    expect(r).toMatchObject({ records: ['schematic'], started: null })
    expect(r.waiting).toMatch(/^Capture's documents are written once its design work lands; still to come: the electrical rule check is clean, or each finding is waived with a reason \(checked, but not in the accepted design yet\)/)
    expect(started).toEqual([])
  })

  it('not while a change carrying the stage\'s design work is open; Scribe\'s own change does not count (#98)', async () => {
    accepted(true)
    const t = Date.now() / 1000
    await jobIndex(ctx(ADMIN), REPO).update((db) => {
      putJob(db, 'job-fix', { state: 'succeeded', kind: 'task', agent: 'impl', title: 'Fix the pull-up', branch: 'claude/task-fix', startedAt: 1, endedAt: 2, payload: JSON.stringify({ request: 'Fix the IO0 pull-up and record capture.datasheets again' }) }, t)
      putJob(db, 'job-old-docs', { state: 'succeeded', kind: 'task', agent: 'docs', title: 'Architect documents', branch: 'claude/task-docs', startedAt: 1, endedAt: 2 }, t)
      return { result: null }
    })
    const pull = (number: number, head: string, title: string) => ({ number, title, head, headRepo: REPO, draft: false, labels: [], url: `https://github.com/${REPO}/pull/${number}`, updated_at: '2026-11-05T00:00:00Z' })
    github.openList = [pull(11, 'claude/task-fix', 'Fix the IO0 pull-up'), pull(12, 'claude/task-docs', 'Docs: Architect documents')]
    const r = await push(['hardware/board.kicad_sch'])
    expect(r.started).toBeNull()
    expect(r.waiting).toBe('Capture\'s documents are written once its design is accepted; still open: change #11 ("Fix the IO0 pull-up").')
    expect(started).toEqual([])
  })

  it('the push that accepts the last of it starts them, though its own records feed no section due now', async () => {
    github.openList = []
    // the change accepted: it held only the case (its records are due at a later stage)
    const r = await push(['mechanical/case.py'])
    expect(r).toMatchObject({ records: ['enclosure'], job: 'job-1' })
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ agent: 'docs' })
    // the stage's decisions are what they waited for
    expect(started[0]!.request).toMatch(/outside the repository: journey/)
  })

  it('once written, a push feeding no section due starts nothing again, nor does a push of no record', async () => {
    const r = await push(['mechanical/case.py'])
    expect(r).toMatchObject({ started: null, skipped: expect.stringMatching(/^The records that changed \(enclosure\) feed no section due at Capture/) })
    expect(await push(['docs/design/high-level-design.md'])).toMatchObject({ started: null, why: 'the push changed no record a document is written from' })
    expect(started).toHaveLength(1)
  })
})

describe('designDoneAt', () => {
  it('is the newest check or waiver of the stage\'s design work, its documents left out', async () => {
    const r = (await journeyStore(ctx(ADMIN), REPO).read((db) => loadJourney(db)!)).result
    const at = (id: string, t: number): typeof r => ({ ...r, criteria: r.criteria.map((c) => (c.id === id ? { ...c, checkedAt: t } : c)) })
    expect(designDoneAt(at('capture.stock', 9e9))).toBe(9e9)
    // a criterion of another stage does not count
    expect(designDoneAt({ ...r, criteria: r.criteria.filter((c) => c.gate !== 'capture') })).toBeNull()
  })
})

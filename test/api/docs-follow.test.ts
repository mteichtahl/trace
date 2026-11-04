/**
 * Scribe starting on its own (src/api/docs-follow.ts, hook.docs; docs/scribe.md "Event driven"): a push to the default
 * branch that changed a record a document is written from starts the Documentation agent, with what changed in its
 * request; a push of only the documents, a project before Architect and a project with Scribe already working start
 * nothing. The backend's identity only. The nightly drift check (hook.projects, hook.drift; "Publishing") compares the
 * documents' last commit with the default branch; documents.get and documents.pdf show what was printed.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { journeyStore } from '../../src/api/action-kit.js'
import { docsReleaseRequest, docsRequest } from '../../src/api/docs-follow.js'
import { skeleton } from '../../src/docs/catalog.js'
import { decide } from '../../src/core/journey.js'
import { recordRelease, storePrinted } from '../../src/docs/printed.js'
import { AccessDenied, type Principal } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { startJourney } from '../../src/core/journey.js'
import { register } from '../../src/core/onboard.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const REPO = 'acme/docs-follow'
const ADMIN = { sub: 'df-admin', email: 'df-admin@example.com', groups: ['trace-admins'] }
const BACKEND: Principal = { sub: 'hooks-client', email: null, groups: [], kind: 'backend', name: 'web-hooks' }

/** The fake, answering GET /repos/<repo>/commits/<sha> with the files and parent this test sets. */
class CommitsGitHub extends FakeGitHub {
  commit: { files: string[]; parent: string } = { files: [], parent: 'sha-parent' }
  /** GET /repos/<repo>/compare/<base>...sha-main: the files changed since each base */
  compare = new Map<string, string[]>()
  async request(method: string, path: string): Promise<unknown> {
    if (method === 'GET' && path === `/repos/${REPO}/commits/sha-main`) return { parents: [{ sha: this.commit.parent }], files: this.commit.files.map((filename) => ({ filename })) }
    const c = /^\/repos\/[^/]+\/[^/]+\/compare\/([^.]+)\.\.\.sha-main$/.exec(path)
    if (method === 'GET' && c && this.compare.has(c[1]!)) return { files: this.compare.get(c[1]!)!.map((filename) => ({ filename })) }
    throw new Error(`unexpected ${method} ${path}`)
  }
}

const github = new CommitsGitHub([REPO])
const started: { request: string; agent?: string }[] = []
let running: { id: string; repository: string; agent: string; state: string; kind: string }[] = []
const scratch = mkdtempSync(join(tmpdir(), 'trace-docs-follow-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-docs-follow-bucket-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })
const deps: ActionDeps = {
  github: async () => github, cognito: () => new FakeCognito(), tools: () => new Registry([]), scratch,
  jobs: async () => ({
    repositoryOf: () => null,
    startJob: async (p) => { started.push({ request: p.request, ...(p.agent ? { agent: p.agent } : {}) }); return { accepted: true, jobId: `job-${started.length}` } },
    jobStatus: async () => running,
  }),
  store: (p) => backendFor(join(bucket, p)),
}
const ctx = (principal: Principal): Context => ({ principal, deps })
const run = async (p: Principal, args: Record<string, unknown>): Promise<Record<string, any>> => (await perform('hook.docs', args, ctx(p))).result as Record<string, any>
const atStage = async (stage: string): Promise<void> => {
  await journeyStore(ctx(ADMIN), REPO).update((db) => { db.prepare('UPDATE journey SET current_stage=?').run(stage); return { result: null } })
}

/** Two project databases on the fake: the parent's, and the commit's with one requirement more. */
function seedDatabases(): void {
  const before = mkdtempSync(join(scratch, 'before-'))
  mkdirSync(join(before, '.git'))
  openProject(before).close()
  github.files.set(`${REPO}:sha-parent:.trace/project.db`, readFileSync(join(before, '.trace', 'project.db')))
  const after = mkdtempSync(join(scratch, 'after-'))
  mkdirSync(join(after, '.git'))
  const db = openProject(after)
  db.prepare("INSERT INTO requirements (id, text, kind, status, created, updated) VALUES ('R-001', 'Shows the reading within 1 s', 'functional', 'proposed', 0, 0)").run()
  db.close()
  github.files.set(`${REPO}:sha-main:.trace/project.db`, readFileSync(join(after, '.trace', 'project.db')))
}

beforeAll(async () => {
  await register(REPO, null)
  await journeyStore(ctx(ADMIN), REPO).update((db) => { startJourney(db, { template: 'board', by: 'seed', name: 'Docs follow' }); return { result: null } })
})

describe('Scribe starting on a push', () => {
  it('is the backend\'s only', async () => {
    await expect(run(ADMIN, { repo: REPO })).rejects.toBeInstanceOf(AccessDenied)
  })

  it('starts nothing before Architect, or for a repository that is not a project', async () => {
    github.commit = { files: ['hardware/board.kicad_sch'], parent: 'sha-parent' }
    expect(await run(BACKEND, { repo: REPO })).toMatchObject({ started: null, why: 'no documents before Architect' })
    expect(await run(BACKEND, { repo: 'acme/not-a-project' })).toMatchObject({ started: null })
    expect(started).toEqual([])
  })

  it('starts Scribe when the push changed a record, naming the records and the stage', async () => {
    await atStage('capture')
    github.commit = { files: ['hardware/board.kicad_sch', 'README.md'], parent: 'sha-parent' }
    const r = await run(BACKEND, { repo: REPO })
    expect(r).toMatchObject({ records: ['schematic'], job: 'job-1' })
    expect(started[0]).toMatchObject({ agent: 'docs' })
    expect(started[0]!.request).toMatch(/default branch moved to sha-main/)
    expect(started[0]!.request).toMatch(/The records that changed: schematic\./)
    expect(started[0]!.request).toMatch(/stage capture/)
  })

  it('reads a changed project database table by table: a new requirement marks the requirements', async () => {
    seedDatabases()
    github.commit = { files: ['.trace/project.db'], parent: 'sha-parent' }
    const r = await run(BACKEND, { repo: REPO })
    expect(r.records).toEqual(['requirements'])
  })

  it('starts nothing for a push of only the documents, so Scribe\'s own change never starts Scribe again', async () => {
    const before = started.length
    github.commit = { files: ['docs/design/high-level-design.md', 'docs/design/figures/render-top.png'], parent: 'sha-parent' }
    expect(await run(BACKEND, { repo: REPO })).toMatchObject({ records: [], started: null })
    expect(started.length).toBe(before)
  })

  it('starts no second Scribe while one is working on the project', async () => {
    const before = started.length
    running = [{ id: 'job-x', repository: REPO, agent: 'docs', state: 'running', kind: 'task' }]
    github.commit = { files: ['mechanical/case.py'], parent: 'sha-parent' }
    const r = await run(BACKEND, { repo: REPO })
    expect(r.skipped).toMatch(/already working/)
    expect(started.length).toBe(before)
    running = []
  })

  it('asks Scribe to compare with the documents\' last commit, and to stop when nothing needs writing', () => {
    const q = docsRequest('The design gate was signed.', { stage: 'capture' })
    expect(q).toMatch(/leaving base unset/)
    expect(q).toMatch(/If nothing needs writing, say so and stop/)
  })
})

describe('the nightly drift check', () => {
  const drift = async (repo = REPO): Promise<Record<string, any>> => (await perform('hook.drift', { repo }, ctx(BACKEND))).result as Record<string, any>
  const hld = (commit: string): Uint8Array => Buffer.from(skeleton('hld', { project: 'Docs follow', revision: 'A', commit, date: '2026-11-05' }))

  it('lists the projects it goes through, for the backend only', async () => {
    expect(((await perform('hook.projects', {}, ctx(BACKEND))).result as { projects: string[] }).projects).toContain(REPO)
    await expect(perform('hook.projects', {}, ctx(ADMIN))).rejects.toBeInstanceOf(AccessDenied)
    await expect(perform('hook.drift', { repo: REPO }, ctx(ADMIN))).rejects.toBeInstanceOf(AccessDenied)
  })

  it('starts Scribe when a record changed since the documents were last written', async () => {
    await atStage('capture')
    const before = started.length
    github.files.set(`${REPO}:sha-main:docs/design/high-level-design.md`, hld('abc1234def'))
    github.files.set(`${REPO}:sha-main:docs/design/low-level-design.md`, Buffer.from(skeleton('lld', { project: 'Docs follow', revision: 'A', commit: 'abc1234def', date: '2026-11-05' })))
    github.compare.set('abc1234def', ['hardware/board.kicad_sch', 'docs/design/high-level-design.md'])
    const r = await drift()
    expect(r).toMatchObject({ since: ['abc1234def'], records: ['schematic'], missing: [], job: expect.any(String) })
    expect(started.length).toBe(before + 1)
    expect(started.at(-1)!.request).toMatch(/nightly check found the documents behind/)
  })

  it('starts nothing when the documents are current', async () => {
    const before = started.length
    github.compare.set('abc1234def', ['docs/design/high-level-design.md'])
    expect(await drift()).toMatchObject({ records: [], missing: [], started: null })
    expect(started.length).toBe(before)
  })

  it('starts Scribe when a document the stage needs is missing', async () => {
    github.files.delete(`${REPO}:sha-main:docs/design/low-level-design.md`)
    const r = await drift()
    expect(r.missing).toEqual(['lld'])
    expect(started.at(-1)!.request).toMatch(/missing: low level design/)
  })

  it('checks nothing before Architect, or for a repository that is not a project', async () => {
    await atStage('define')
    expect(await drift()).toMatchObject({ started: null, why: 'no documents before Architect' })
    expect(await drift('acme/not-a-project')).toMatchObject({ started: null })
    await atStage('capture')
  })
})

describe('a revision cut', () => {
  it('asks Scribe to bring the documents up to date, then print the release copies', () => {
    const q = docsReleaseRequest('B', '2026-11-05', { stage: 'release' })
    expect(q).toMatch(/Revision B was cut on 2026-11-05/)
    expect(q).toMatch(/docs_publish release=B/)
    expect(q).toMatch(/quality=release/)
  })
})

describe('documents.get and documents.pdf', () => {
  const READER = { sub: 'df-reader', email: 'df-reader@example.com', groups: ['trace-users'] }

  it('shows each document, each revision\'s release copies with its record, and the next check', async () => {
    const store = backendFor(join(bucket, 'projects'))
    const kept = await storePrinted(store, REPO, Buffer.from('%PDF-1.7 hld'))
    await recordRelease(store, REPO, 'A', [{ kind: 'hld', sha256: kept.sha256, bytes: 12, commit: 'abc1234def', run: 'r-1', at: 1 }])
    await journeyStore(ctx(ADMIN), REPO).update((db) => {
      decide(db, { kind: 'journey.snapshot', stage: null, ref: 'c0ffee', by: 'seed', summary: 'copied', detail: { revision: 'A', commit: 'c0ffee', branch: 'trace/release-a-1' } })
      return { result: null }
    })
    const r = (await perform('documents.get', { repo: REPO }, ctx(ADMIN))).result as Record<string, any>
    expect(r.documents.find((d: any) => d.kind === 'hld')).toMatchObject({ exists: true, commit: 'abc1234def', revision: 'A' })
    expect(r.documents.find((d: any) => d.kind === 'guide')).toMatchObject({ exists: false })
    expect(r.releases).toMatchObject([{ revision: 'A', cut: { commit: 'c0ffee', branch: 'trace/release-a-1' }, documents: [{ kind: 'hld', title: 'High level design', sha256: kept.sha256 }] }])
    expect(Date.parse(r.next_check)).toBeGreaterThan(Date.now())
    const pdf = (await perform('documents.pdf', { repo: REPO, sha256: kept.sha256 }, ctx(ADMIN))).result as Record<string, any>
    expect(Buffer.from(pdf.base64, 'base64').toString()).toBe('%PDF-1.7 hld')
    await expect(perform('documents.pdf', { repo: REPO, sha256: '0'.repeat(64) }, ctx(ADMIN))).rejects.toThrow(/no printed copy/)
    // someone not on the project reads nothing
    await expect(perform('documents.get', { repo: REPO }, ctx(READER))).rejects.toBeInstanceOf(AccessDenied)
  })
})

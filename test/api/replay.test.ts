/**
 * journey.replay (plan P8.4) through the API: a project's record played back a page at a time, with its chapters,
 * its people and the graph nodes the events name; only to whom the project is shared, and not to connected systems.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { SERVICE_ACTIONS } from '../../src/api/service-policy.js'
import { assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { loadJourney, recordOpen, setCriterion, signGate, startJourney } from '../../src/core/journey.js'
import { Registry } from '../../src/core/registry.js'
import { openProject } from '../../src/core/store.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'a-admin', email: 'admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'a-user', email: 'user@example.com', groups: ['trace-users'] }
const OTHER = { sub: 'a-other', email: 'other@example.com', groups: ['trace-users'] }
const REPO = 'acme/replayed'
const github = new FakeGitHub([REPO])
const scratch = mkdtempSync(join(tmpdir(), 'trace-replay-api-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-replay-api-bucket-'))
const deps: ActionDeps = { github: async () => github, cognito: () => new FakeCognito(), jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [], cancel: async () => ({ ok: true, state: 'aborted' }), pause: async () => ({ ok: true, state: 'running' }) }), tools: () => new Registry([]), scratch, store: (p) => backendFor(join(bucket, p)) }
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<any> => (await perform(action, args, { principal: who, deps })).result
const SIGNER = { hash: 'a'.repeat(16), label: 'admin@example.com' }

beforeAll(async () => {
  await assign(ADMIN, USER, REPO, { class: 'user' })
  const dir = mkdtempSync(join(scratch, 'seed-'))
  mkdirSync(join(dir, '.git'))
  const db = openProject(dir)
  startJourney(db, { template: 'board', by: 'seed', name: 'Replayed' })
  for (const c of loadJourney(db)!.criteria.filter((x) => x.gate === 'define')) {
    setCriterion(db, c.id, 'met', [{ kind: 'run', ref: `run-${c.id}` }], c.owner === 'trace' ? 'trace' : SIGNER.label)
    recordOpen(db, { criterion: c.id }, SIGNER.hash)
  }
  signGate(db, 'define', SIGNER)
  db.close()
  github.files.set(`${REPO}:main:.trace/project.db`, readFileSync(join(dir, '.trace', 'project.db')))
})
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

describe('journey.replay', () => {
  it('plays the record back oldest first, a page at a time, with its chapters, people and nodes', async () => {
    const all = await run(USER, 'journey.replay', { repo: REPO })
    expect(all.total).toBe(all.events.length)
    expect(all.next).toBeNull()
    expect(all.events[0]).toMatchObject({ kind: 'journey.started', caption: 'The journey started: Replayed' })
    expect(all.events.some((e: { kind: string; node: string }) => e.kind === 'gate.signed' && e.node === 'gate:define')).toBe(true)
    expect(all.chapters.map((c: { stage: string }) => c.stage)).toEqual(expect.arrayContaining(['define', 'architect']))
    expect(all.people).toContain('admin@example.com')
    expect(all.nodes['gate:define']).toMatchObject({ kind: 'gate', label: expect.stringMatching(/gate/) })
    // pages: the same events, in the same order
    const one = await run(USER, 'journey.replay', { repo: REPO, limit: 3 })
    expect(one.events).toHaveLength(3)
    const two = await run(USER, 'journey.replay', { repo: REPO, after: one.next, limit: 1000 })
    expect([...one.events, ...two.events].map((e: { id: string }) => e.id)).toEqual(all.events.map((e: { id: string }) => e.id))
  })

  it('only to whom the project is shared; not on the connected systems\' list', async () => {
    await expect(run(OTHER, 'journey.replay', { repo: REPO })).rejects.toThrow()
    expect(SERVICE_ACTIONS['journey.replay']).toBeUndefined()
  })
})

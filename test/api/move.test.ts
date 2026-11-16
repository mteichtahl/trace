/**
 * Asking to move a project between GitHub and trace's GitLab (src/api/actions-move.ts): who may, the pause it puts on
 * the project, the record the installation's update takes, and cancelling.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { storeAt } from '../../src/api/action-kit.js'
import { forgeOf } from '../../src/api/actions-move.js'
import { assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { MoveRecordSchema, moveKey } from '../../src/core/forge-move-record.js'
import { changeLifecycle, lifecycleOf } from '../../src/core/lifecycle.js'
import { register } from '../../src/core/onboard.js'
import { Registry } from '../../src/core/registry.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'm-admin', email: 'm-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'm-user', email: 'm-user@example.com', groups: ['trace-users'] }
const P = 'move/board'
const Q = 'move/held'
const github = new FakeGitHub([P, Q])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-move-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-move-bucket-'))
const deps: ActionDeps = {
  github: async () => github, cognito: () => cognito,
  jobs: async () => ({ repositoryOf: () => null, startJob: async () => ({ accepted: true, jobId: 'j' }), jobStatus: async () => [] }),
  tools: () => new Registry([]), scratch, store: (prefix) => backendFor(join(bucket, prefix)),
}
const ctx = (principal: Context['principal']): Context => ({ principal, deps })
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<any> => (await perform(action, args, ctx(who))).result
const stored = async (repo: string) => {
  const got = await storeAt(ctx(ADMIN), 'installation').get(moveKey(repo))
  return got ? MoveRecordSchema.parse(JSON.parse(new TextDecoder().decode(got.body))) : null
}

const saved = { url: process.env.TRACE_GITLAB_URL, repos: process.env.TRACE_GITLAB_REPOS }
beforeAll(async () => {
  for (const p of [ADMIN, USER]) cognito.add(p.email, p.sub, p.groups[0])
  for (const r of [P, Q]) { await register(r, null); await assign(ADMIN, USER, r, { class: 'user' }) }
})
beforeEach(() => { process.env.TRACE_GITLAB_URL = 'https://git.example'; process.env.TRACE_GITLAB_REPOS = '' })
afterAll(() => {
  process.env.TRACE_GITLAB_URL = saved.url; process.env.TRACE_GITLAB_REPOS = saved.repos
  if (saved.url === undefined) delete process.env.TRACE_GITLAB_URL
  if (saved.repos === undefined) delete process.env.TRACE_GITLAB_REPOS
  rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true })
})

describe('moving a project', () => {
  it('only an admin may ask', async () => {
    await expect(perform('project.move', { repo: P, to: 'gitlab' }, ctx(USER))).rejects.toThrow()
  })

  it('refuses without GitLab, and to where it is already', async () => {
    delete process.env.TRACE_GITLAB_URL
    await expect(run(ADMIN, 'project.move', { repo: P, to: 'gitlab' })).rejects.toThrow(/no GitLab yet/)
    process.env.TRACE_GITLAB_URL = 'https://git.example'
    await expect(run(ADMIN, 'project.move', { repo: P, to: 'github' })).rejects.toThrow(/on GitHub already/)
    process.env.TRACE_GITLAB_REPOS = `other/x ${P.toUpperCase()}`
    expect(forgeOf(P)).toBe('gitlab')
  })

  it('pauses the project, records the move for the update, and refuses a second one', async () => {
    const r = await run(ADMIN, 'project.move', { repo: P, to: 'gitlab' })
    expect(r.move).toMatchObject({ repo: P, from: 'github', to: 'gitlab', when: 'idle', status: 'waiting', paused_for_move: true })
    expect(r.summary).toMatch(/^Moving to trace's GitLab\. The project is paused meanwhile\./)
    expect((await lifecycleOf(P)).paused?.reason).toBe("moving to trace's GitLab")
    expect(await stored(P)).toMatchObject({ status: 'waiting', requested_by: expect.any(String) })
    await expect(run(ADMIN, 'project.move', { repo: P, to: 'gitlab' })).rejects.toThrow(/waiting already/)
    expect((await run(USER, 'project.move_status', { repo: P })).move).toMatchObject({ status: 'waiting' })
  })

  it('cancelling before the update takes it resumes the project; a move under way cannot be cancelled', async () => {
    const r = await run(ADMIN, 'project.move_cancel', { repo: P })
    expect(r.summary).toBe('The move was cancelled: the project stays on GitHub. It is resumed.')
    expect((await lifecycleOf(P)).paused).toBeNull()
    expect((await stored(P))?.status).toBe('cancelled')
    await expect(run(ADMIN, 'project.move_cancel', { repo: P })).rejects.toThrow(/no move to cancel/)

    await run(ADMIN, 'project.move', { repo: P, to: 'gitlab', when: 'now' })
    const s = storeAt(ctx(ADMIN), 'installation')
    const got = await s.get(moveKey(P))
    const rec = { ...MoveRecordSchema.parse(JSON.parse(new TextDecoder().decode(got!.body))), status: 'moving', step: 'copy' }
    await s.put(moveKey(P), new TextEncoder().encode(JSON.stringify(rec)), { ifMatch: got!.etag })
    await expect(run(ADMIN, 'project.move_cancel', { repo: P })).rejects.toThrow(/under way/)
  })

  it('a project someone paused stays paused after its move is cancelled', async () => {
    await changeLifecycle(Q, 'paused', 'someone', 'waiting for parts')
    expect((await run(ADMIN, 'project.move', { repo: Q, to: 'gitlab' })).move.paused_for_move).toBe(false)
    expect((await run(ADMIN, 'project.move_cancel', { repo: Q })).summary).toBe('The move was cancelled: the project stays on GitHub.')
    expect((await lifecycleOf(Q)).paused?.reason).toBe('waiting for parts')
  })
})

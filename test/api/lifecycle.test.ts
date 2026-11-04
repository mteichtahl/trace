/**
 * Pausing and retiring a project (src/core/lifecycle.ts, src/api/actions-lifecycle.ts): who may, what a paused or
 * retired project refuses, what stays readable, how a retired project leaves every list and comes back, and that the
 * worker's queue and the harness hold work for it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ActionDeps, type Context, perform } from '../../src/api/actions.js'
import { journeyStore, storeAt } from '../../src/api/action-kit.js'
import { CHANGES_THOUGH_NOT_WRITE, changesProject } from '../../src/api/actions-lifecycle.js'
import { HELD_FAILS, HELD_SKIPS, mayRun } from '../../src/harness/index.js'
import { AccessDenied, assign } from '../../src/core/access.js'
import { backendFor } from '../../src/core/central.js'
import { JobIndexStore, putJob } from '../../src/core/job-index.js'
import { loadJourney, startJourney } from '../../src/core/journey.js'
import { changeLifecycle, forgetLifecycles, heldReason, lifecycleOf } from '../../src/core/lifecycle.js'
import { register } from '../../src/core/onboard.js'
import { PROJECTS_PREFIX } from '../../src/core/project.js'
import { Registry } from '../../src/core/registry.js'
import { FakeCognito, FakeGitHub } from './fixtures.js'

const ADMIN = { sub: 'l-admin', email: 'l-admin@example.com', groups: ['trace-admins'] }
const USER = { sub: 'l-user', email: 'l-user@example.com', groups: ['trace-users'] }
const REVIEWER = { sub: 'l-rev', email: 'l-rev@example.com', groups: ['trace-users'] }

const P = 'life/board'
const Q = 'life/old'
const github = new FakeGitHub([P, Q])
const cognito = new FakeCognito()
const scratch = mkdtempSync(join(tmpdir(), 'trace-life-'))
const bucket = mkdtempSync(join(tmpdir(), 'trace-life-bucket-'))
const started: string[] = []
const paused: string[] = []
const deps: ActionDeps = {
  github: async () => github,
  cognito: () => cognito,
  jobs: async () => ({
    repositoryOf: (id) => (id.startsWith('life-board.') ? P : null),
    startJob: async (p) => { started.push(p.request); return { accepted: true, jobId: 'j' } },
    jobStatus: async () => [],
    pause: async (id) => { paused.push(id); return { ok: true, state: 'running' } },
  }),
  tools: () => new Registry([]),
  scratch,
  store: (prefix) => backendFor(join(bucket, prefix)),
}
const ctx = (principal: Context['principal']): Context => ({ principal, deps })
const run = async (who: Context['principal'], action: string, args: Record<string, unknown> = {}): Promise<any> => (await perform(action, args, ctx(who))).result
const repos = async (who: Context['principal']): Promise<string[]> => (await run(who, 'projects') as { repo: string }[]).map((p) => p.repo)

beforeAll(async () => {
  for (const p of [ADMIN, USER, REVIEWER]) cognito.add(p.email, p.sub, p.groups[0])
  await register(P, null)
  await register(Q, null)
  await assign(ADMIN, USER, P, { class: 'user' })
  await assign(ADMIN, REVIEWER, P, { part: 'reviewer', class: 'user' })
  await assign(ADMIN, USER, Q, { class: 'user' })
  for (const r of [P, Q]) await journeyStore(ctx(ADMIN), r).update((db) => { startJourney(db, { template: 'board', by: 'seed', name: r === P ? 'Soil sensor' : 'Old probe' }); return { result: null } })
  // a task running on P, which pausing asks to stop at its next safe point
  const now = Date.now() / 1000
  await new JobIndexStore(storeAt(ctx(ADMIN), PROJECTS_PREFIX), P).update((db) => {
    putJob(db, 'life-task', { kind: 'task', agent: 'impl', title: 'Lay out the board', state: 'running', branch: 'claude/task-layout', startedAt: now - 60, beatAt: now }, now)
    return { result: null }
  })
})
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(bucket, { recursive: true, force: true }) })

describe('pausing a project', () => {
  it('a reviewer cannot pause; a contributor can, and its running task is asked to pause', async () => {
    await expect(run(REVIEWER, 'project.pause', { repo: P })).rejects.toBeInstanceOf(AccessDenied)
    const r = await run(USER, 'project.pause', { repo: P, reason: 'waiting on the enclosure supplier' })
    expect(r.paused).toMatchObject({ by: 'l-user@example.com', reason: 'waiting on the enclosure supplier' })
    expect(r.work).toEqual({ asked: 1, running: 1 })
    expect(r.summary).toMatch(/^Paused\. The running task was asked to pause/)
    expect(paused).toHaveLength(1)
    await expect(run(USER, 'project.pause', { repo: P })).rejects.toThrow(/already paused \(by l-user@example\.com\)/)
  })

  it('refuses changes and new work, in plain words; reads still work', async () => {
    await expect(run(USER, 'task', { repo: P, request: 'Route the board' })).rejects.toThrow(/This project is paused \(by l-user@example\.com: waiting on the enclosure supplier\), so nothing can change and no work starts\. Resume it to carry on\./)
    await expect(run(ADMIN, 'project.update', { repo: P, name: 'Renamed' })).rejects.toThrow(/is paused/)
    await expect(run(USER, 'job.control', { id: 'life-board.life-task', op: 'resume' })).rejects.toThrow(/is paused/)
    expect(started).toEqual([])
    // people still see it, and what it is
    expect(await run(REVIEWER, 'project.members', { repo: P })).toBeTruthy()
    const life = await run(REVIEWER, 'project.lifecycle', { repo: P })
    expect(life).toMatchObject({ repo: P, paused: { by: 'l-user@example.com' }, retired: null })
    expect(life.history[0]).toMatchObject({ change: 'paused', by: 'l-user@example.com' })
  })

  it('shows as paused in lists, and leaves Next', async () => {
    const mine = (await run(USER, 'projects') as { repo: string; paused?: unknown }[]).find((p) => p.repo === P)
    expect(mine?.paused).toMatchObject({ by: 'l-user@example.com' })
    const inbox = await run(USER, 'inbox')
    expect(inbox.paused).toEqual([expect.objectContaining({ repo: P })])
  })

  it('is logged in the project\'s decisions, and resuming lets work start again', async () => {
    const r = await run(REVIEWER, 'project.resume', { repo: P }).catch((e: unknown) => e)
    expect(r).toBeInstanceOf(AccessDenied)
    expect((await run(USER, 'project.resume', { repo: P })).paused).toBeNull()
    await run(USER, 'task', { repo: P, request: 'Route the board' })
    expect(started).toEqual(['Route the board'])
    const decisions = (await journeyStore(ctx(ADMIN), P).read((db) => loadJourney(db))).result?.decisions ?? []
    expect(decisions.map((d) => d.kind)).toEqual(expect.arrayContaining(['project.paused', 'project.resumed']))
  })
})

describe('retiring a project', () => {
  it('only an admin retires; it then leaves everyone\'s lists and is "no access" to all but admins', async () => {
    await expect(run(USER, 'project.retire', { repo: Q })).rejects.toBeInstanceOf(AccessDenied)
    const r = await run(ADMIN, 'project.retire', { repo: Q, reason: 'replaced by the v2 probe' })
    expect(r.retired).toMatchObject({ by: 'l-admin@example.com', reason: 'replaced by the v2 probe' })
    expect(await repos(USER)).not.toContain(Q)
    expect(await repos(ADMIN)).not.toContain(Q)
    await expect(run(USER, 'project.members', { repo: Q })).rejects.toBeInstanceOf(AccessDenied)
    await expect(run(USER, 'project.lifecycle', { repo: Q })).rejects.toBeInstanceOf(AccessDenied)
    // an admin can still look at it, but not change it
    expect(await run(ADMIN, 'project.lifecycle', { repo: Q })).toMatchObject({ retired: { by: 'l-admin@example.com' } })
    await expect(run(ADMIN, 'task', { repo: Q, request: 'x' })).rejects.toThrow(/This project is retired \(by l-admin@example\.com\).*An admin can restore it\./)
  })

  it('admins see it among the retired, with its name; only they restore it, as it was', async () => {
    await expect(run(USER, 'projects.retired')).rejects.toBeInstanceOf(AccessDenied)
    const list = (await run(ADMIN, 'projects.retired')).projects as { repo: string; name: string | null }[]
    expect(list).toEqual([expect.objectContaining({ repo: Q, name: 'Old probe' })])
    await expect(run(USER, 'project.restore', { repo: Q })).rejects.toBeInstanceOf(AccessDenied)
    const r = await run(ADMIN, 'project.restore', { repo: Q })
    expect(r.retired).toBeNull()
    expect(await repos(USER)).toContain(Q)
    expect((await run(ADMIN, 'projects.retired')).projects).toEqual([])
    await expect(run(ADMIN, 'project.restore', { repo: Q })).rejects.toThrow(/It is not retired\./)
  })

  it('a project paused before it was retired is still paused when restored', async () => {
    await run(USER, 'project.pause', { repo: Q })
    await run(ADMIN, 'project.retire', { repo: Q })
    const r = await run(ADMIN, 'project.restore', { repo: Q })
    expect(r.paused).toMatchObject({ by: 'l-user@example.com' })
    expect(r.summary).toMatch(/still paused/)
    await run(USER, 'project.resume', { repo: Q })
  })
})

describe('what counts as a change', () => {
  it('every write, the listed reads that save, and the lifecycle actions never', () => {
    const c = ctx(USER)
    expect(changesProject('task', 'write', {}, c)).toBe(true)
    expect(changesProject('journey.get', 'read', {}, c)).toBe(false)
    expect(changesProject('chats.append', 'read', {}, c)).toBe(false)
    expect(changesProject('project.resume', 'write', {}, c)).toBe(false)
    for (const n of CHANGES_THOUGH_NOT_WRITE) expect(changesProject(n, 'read', {}, c)).toBe(true)
  })
})

describe('work outside the API', () => {
  it('the worker and the harness are told the project waits, and why', async () => {
    const R = 'life/held'
    await changeLifecycle(R, 'paused', 'm@example.com', 'bench is down')
    expect(await heldReason(R)).toBe('the project is paused (by m@example.com: bench is down): it starts when the project is resumed')
    expect(await heldReason(R, {})).toBeNull()
    const lines: string[] = []
    const core = { info: (l: string) => lines.push(l), warning: () => undefined, setFailed: (l: string) => lines.push(`FAILED ${l}`), setOutput: () => undefined, summary: { addRaw: () => ({ write: async () => undefined }) } }
    const context = { repo: { owner: 'life', repo: 'held' }, payload: {} } as never
    expect(await mayRun('worker-pick', context, core, process.env)).toBe(false)
    expect(await mayRun('deploy-guard', context, core, process.env)).toBe(false)
    expect(await mayRun('worker-report', context, core, process.env)).toBe(true)
    expect(lines.some((l) => l.startsWith('trace worker-pick did not run: the project is paused'))).toBe(true)
    expect(lines.some((l) => l.startsWith('FAILED trace deploy-guard did not run') && l.endsWith('Nothing was deployed.'))).toBe(true)
    expect([...HELD_FAILS].every((t) => !HELD_SKIPS.has(t))).toBe(true)
    await changeLifecycle(R, 'resumed', 'm@example.com')
    forgetLifecycles()
    expect(await lifecycleOf(R)).toEqual({ paused: null, retired: null })
    expect(await mayRun('worker-pick', context, core, process.env)).toBe(true)
  })
})

describe('the worker while a project is paused', () => {
  it('a queued task waits, saying why, and starts once the project is resumed', async () => {
    const { queueAdmit } = await import('../../src/agents/runtime/job-index.js')
    const { createJobs } = await import('../../src/agents/runtime/jobs.js')
    const { JourneyStore } = await import('../../src/core/journey-store.js')
    const projects = backendFor(join(bucket, 'worker'))
    let why: string | null = 'the project is paused (by m@example.com): it starts when the project is resumed'
    let poke = (): void => undefined
    const admit = queueAdmit({
      store: new JobIndexStore(projects, P), controls: new JourneyStore(projects, P), log: () => undefined, held: async () => why,
      changes: async () => ({ how: 'test', next: (_t, signal) => new Promise<boolean>((r) => { poke = () => r(true); signal.addEventListener('abort', () => r(false), { once: true }) }), close: async () => undefined }),
    })
    const ran: string[] = []
    const jobs = createJobs(async (p, c) => { await c.admit?.('verify', { maxParallel: 4 }); ran.push(p.kind === 'task' ? p.request : ''); return 'ok' }, { echo: () => undefined, admit })
    const j = jobs.startJob({ kind: 'task', repository: P, request: 'check the range', requestedBy: 'm@example.com', agent: 'verify' })
    const until = async (f: () => boolean): Promise<void> => { const end = Date.now() + 3000; while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)) } }
    await until(() => (jobs.jobStatus(j.jobId)[0]?.step ?? '').includes('the project is paused'))
    expect(ran).toEqual([])
    why = null
    poke()
    await until(() => ran.length === 1)
    jobs.dispose()
  })
})

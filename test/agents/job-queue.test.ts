/**
 * The worker's side of the job index (src/agents/runtime/job-index.ts, jobs.ts, job.ts): every job written into the
 * project's index from its own events, a person's task queued behind another of its agent and started when that one
 * ends, pausing at a safe point (the PreToolUse hook) with the work committed and pushed and the transcript kept,
 * and Resume continuing the same conversation.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { type ClaudeOptions, type Exec, type PausedWork, type RunnerDeps, createRunner, keepPaused } from '../../src/agents/runtime/job.js'
import {
  type Changes, batchOfWait, indexJobs, queueAdmit, restoreTranscript, saveTranscript, sessionsDir, timerChanges, titleOf, transcriptKey,
} from '../../src/agents/runtime/job-index.js'
import { JobPaused, type JobRunner, createJobs } from '../../src/agents/runtime/jobs.js'
import type { JobPayload } from '../../src/agents/runtime/schemas.js'
import { PAUSE_KEPT, createAgentServer } from '../../src/agents/runtime/server.js'
import { backendFor } from '../../src/core/central.js'
import { JobIndexStore, loadJobs, loadBatch, putControl } from '../../src/core/job-index.js'
import { JourneyStore } from '../../src/core/journey-store.js'
import { trackEventWait, withJob } from '../../src/core/wait.js'
import { cfgOf, fakeGithub } from '../harness/fake.js'

const root = mkdtempSync(join(tmpdir(), 'trace-job-queue-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const REPO = 'acme/board'
const quiet = { echo: () => undefined }
const task = (request: string, agent: 'verify' | 'impl' = 'verify'): JobPayload => ({ kind: 'task', repository: REPO, request, requestedBy: 'm@example.com', requestedBySub: 'sub-m', agent })
const until = async (f: () => boolean | Promise<boolean>, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await f())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)) }
}

function stores(name: string) {
  const projects = backendFor(join(root, name))
  return { projects, index: new JobIndexStore(projects, REPO), journey: new JourneyStore(projects, REPO) }
}

/** Changes told by hand: next() resolves when the test pokes it. */
function poked(): { changes: () => Promise<Changes>; poke(): void } {
  let waiting: (() => void) | null = null
  return {
    changes: async () => ({ how: 'test', next: (_t, signal) => new Promise<boolean>((r) => { waiting = () => r(true); signal.addEventListener('abort', () => r(false), { once: true }) }), close: async () => undefined }),
    poke: () => { const w = waiting; waiting = null; w?.() },
  }
}

describe('the job index, from the jobs\' own events', () => {
  it('writes each job (title, who asked, its agent, state, step, end) and the Batch jobs its tools have running', async () => {
    const s = stores('index')
    let release = (): void => undefined
    const runner: JobRunner = (_p, ctx) => new Promise((res) => {
      ctx.log('reading the schematic')
      withJob(ctx.jobId, () => { const w = trackEventWait({ what: 'the graphics card job g-1' }); w.update('RUNNING') })
      release = () => res('done')
    })
    const jobs = createJobs(runner, quiet)
    const w = indexJobs(jobs, s.index, (id) => jobs.payloadOf(id), { heartbeat: false })
    const { jobId } = jobs.startJob(task('Check   the\nERC'), 'trace-api-00000000-000000000000000000000000')
    await w.flush()
    let rows = (await s.index.read(loadJobs)).result
    expect(rows[0]).toMatchObject({ id: jobId, kind: 'task', agent: 'verify', title: 'Check the ERC', requestedBySub: 'sub-m', requestedBy: 'm@example.com', state: 'running', session: 'trace-api-00000000-000000000000000000000000' })
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toEqual({ kind: 'task', repository: REPO, request: 'Check   the\nERC', requestedBy: 'm@example.com', requestedBySub: 'sub-m', agent: 'verify' })
    expect((await s.index.read(loadBatch)).result).toEqual([expect.objectContaining({ id: 'g-1', jobId, pool: 'gpu', state: 'RUNNING', endedAt: null })])
    await w.beat()
    rows = (await s.index.read(loadJobs)).result
    expect(rows[0]?.step).toBe('reading the schematic')
    release()
    await until(() => !jobs.busy())
    await w.flush()
    expect((await s.index.read(loadJobs)).result[0]).toMatchObject({ state: 'succeeded', summary: 'done', endedAt: expect.any(Number) })
    w.stop()
    jobs.dispose()
  })

  it('a change that comes before the job\'s first row (its "started" log line, its route) waits for that row', async () => {
    const s = stores('index-early')
    const said: string[] = []
    const runner: JobRunner = async (_p, ctx) => { ctx.log('cloning acme/board (main)'); return 'done' }
    const jobs = createJobs(runner, quiet)
    const w = indexJobs(jobs, s.index, (id) => jobs.payloadOf(id), { heartbeat: false, log: (l) => { said.push(l) } })
    // a log line flushed on its own before the job's 'started' event, as the job's "started …" line is
    const { jobId } = jobs.startJob(task('Route the board'), 'trace-api-00000000-000000000000000000000000')
    await until(() => !jobs.busy())
    await w.flush()
    expect(said.filter((l) => l.includes('could not write'))).toEqual([])
    expect((await s.index.read(loadJobs)).result.find((r) => r.id === jobId)).toMatchObject({ kind: 'task', title: 'Route the board', state: 'succeeded' })
    w.stop()
    jobs.dispose()
  })

  it('titles a job in words, and finds the Batch job a wait is about', () => {
    expect(titleOf({ kind: 'work-item', repository: REPO, item: { kind: 'ci-red', number: 5, sha: 'a'.repeat(40), ref: 'x', own: true, title: 'Fix CI' } })).toBe('Pull request #5: Fix CI')
    expect(batchOfWait('the remote CPU job c-9')).toEqual({ id: 'c-9', pool: 'cpu' })
    expect(batchOfWait('the knowledge base update')).toBeNull()
  })
})

describe('the queue', () => {
  it('queues a task behind a running one of its agent, holds it while a person says so, and starts it when the first ends', async () => {
    const s = stores('queue')
    const p = poked()
    const admit = queueAdmit({ store: s.index, controls: s.journey, changes: p.changes, log: () => undefined })
    const ends: Record<string, () => void> = {}
    const started: string[] = []
    const runner: JobRunner = async (pl, ctx) => {
      await ctx.admit?.('verify', { maxParallel: 4 })
      started.push(pl.kind === 'task' ? pl.request : '')
      await new Promise<void>((r) => { ends[ctx.jobId] = r })
      return 'ok'
    }
    const jobs = createJobs(runner, { ...quiet, admit })
    const w = indexJobs(jobs, s.index, (id) => jobs.payloadOf(id), { heartbeat: false, queued: true })
    const a = jobs.startJob(task('first'))
    await until(() => started.length === 1)
    const b = jobs.startJob(task('second'))
    await until(() => jobs.jobStatus(b.jobId)[0]?.state === 'queued')
    expect(jobs.jobStatus(b.jobId)[0]?.step).toMatch(/queued: the verify agent is already working on this project \("/)
    // a person holds it: when the first ends it still waits
    await s.journey.update((db) => { putControl(db, { job: b.jobId, held: true, by: 'n@example.com', at: 1 }); return { result: null } })
    ends[a.jobId]?.()
    await until(() => jobs.jobStatus(a.jobId)[0]?.state === 'succeeded')
    await w.flush()
    p.poke()
    await until(() => (jobs.jobStatus(b.jobId)[0]?.step ?? '').includes('held by n@example.com'))
    expect(started).toEqual(['first'])
    // released: it starts
    await s.journey.update((db) => { putControl(db, { job: b.jobId, held: false, by: 'n@example.com', at: 2 }); return { result: null } })
    p.poke()
    await until(() => started.length === 2)
    expect(jobs.jobStatus(b.jobId)[0]).toMatchObject({ state: 'running', runningAt: expect.any(String) })
    await w.flush()
    expect((await s.index.read(loadJobs)).result.find((j) => j.id === b.jobId)).toMatchObject({ state: 'running', beatAt: expect.any(Number) })
    ends[b.jobId]?.()
    await until(() => !jobs.busy())
    w.stop()
    jobs.dispose()
  })

  it('a queued job that is cancelled stops waiting', async () => {
    const s = stores('queue-cancel')
    const p = poked()
    const admit = queueAdmit({ store: s.index, controls: s.journey, changes: p.changes, log: () => undefined })
    let hold = (): void => undefined
    const runner: JobRunner = async (_pl, ctx) => { await ctx.admit?.('verify', { maxParallel: 4 }); await new Promise<void>((r) => { hold = r }); return 'ok' }
    const jobs = createJobs(runner, { ...quiet, admit })
    jobs.startJob(task('first'))
    await until(async () => (await s.index.read(loadJobs)).result.some((j) => j.state === 'running'))
    const b = jobs.startJob(task('second'))
    await until(() => jobs.jobStatus(b.jobId)[0]?.state === 'queued')
    expect(await jobs.abort(b.jobId, 'cancelled by m@example.com', 2000)).toBe(true)
    expect(jobs.jobStatus(b.jobId)[0]).toMatchObject({ state: 'aborted' })
    hold()
    jobs.dispose()
  })

  it('without events, looks again on the declared timer and says when', async () => {
    const lines: string[] = []
    const c = timerChanges('job-1', 'no events topic', (l) => lines.push(l), { sleep: async () => undefined })
    expect(lines[0]).toBe('job-1 is queued: looking again in 30 seconds, then less often while nothing changes (up to every 5 minutes), because no events topic')
    expect(await c.next(1000, new AbortController().signal)).toBe(false)
  })
})

describe('pause', () => {
  it('asks a running task to pause (invocation kind pause): it stops at its next safe point and ends paused; others cannot', async () => {
    const runner: JobRunner = (_p, ctx) => new Promise((_res, rej) => {
      ctx.pauseSignal?.addEventListener('abort', () => rej(new JobPaused('Paused at a safe point: its work is on claude/task-x.')))
    })
    const jobs = createJobs(runner, quiet)
    const s = createAgentServer(jobs, { log: () => undefined })
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const post = async (body: unknown) => (await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/invocations`, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<Record<string, unknown>>
    try {
      const t = jobs.startJob(task('x'))
      const wi = jobs.startJob({ kind: 'work-item', repository: REPO, item: { kind: 'ci-red', number: 5, sha: 'a'.repeat(40), ref: 'x', own: true, title: 't' } })
      expect(await post({ kind: 'pause', jobId: wi.jobId, by: 'm@example.com' })).toMatchObject({ ok: false, reason: expect.stringMatching(/can only be cancelled/) })
      expect(await post({ kind: 'pause', jobId: t.jobId, by: 'm@example.com' })).toEqual({ ok: true, state: 'running', pausing: true, kept: PAUSE_KEPT })
      await until(() => jobs.jobStatus(t.jobId)[0]?.state === 'paused')
      expect(jobs.jobStatus(t.jobId)[0]).toMatchObject({ state: 'paused', summary: expect.stringMatching(/claude\/task-x/), pause: { by: 'm@example.com' } })
      expect(await post({ kind: 'pause', jobId: t.jobId, by: 'm@example.com' })).toMatchObject({ ok: false, reason: 'The job has already paused.' })
      await jobs.abort(wi.jobId, 'done', 1000)
    } finally {
      s.close()
      jobs.dispose()
    }
  })

  it('the runner stops Claude before its next tool call, commits and pushes the work on its branch, and keeps the transcript', async () => {
    const ws = mkdtempSync(join(root, 'ws-'))
    const cmds: string[] = []
    const exec: Exec = async (_c, args) => { cmds.push(args.join(' ')); return { stdout: args[0] === 'status' ? ' M board.kicad_sch\n' : args[0] === 'rev-parse' ? 'abc1234\n' : '', stderr: '' } }
    const pause = new AbortController()
    const saved: string[] = []
    const got: { options?: ClaudeOptions } = {}
    const d: RunnerDeps = {
      exec, getToken: async () => 'ghs_TESTTOKEN1234567890abcdef', github: () => fakeGithub({ 'repos.get': { default_branch: 'main' }, 'issues.listComments': [] }).gh,
      claude: (a) => {
        got.options = a.options
        return (async function* () {
          yield { type: 'system', subtype: 'init', session_id: '11111111-2222-3333-4444-555555555555' }
          // a person pauses while the first step runs; the hook stops Claude before the next tool call
          pause.abort(new Error('paused by n@example.com'))
          const hook = a.options.hooks?.PreToolUse[0]?.hooks[0]
          const said = hook ? await hook({}, 'tu1', { signal: new AbortController().signal }) : {}
          expect(said).toEqual({ continue: false, stopReason: expect.stringMatching(/Paused by a person/) })
          yield { type: 'result', subtype: 'success', is_error: false, result: 'stopped', num_turns: 2, session_id: '11111111-2222-3333-4444-555555555555' }
        })()
      },
      settingsOf: () => cfgOf(), remoteSettings: async () => cfgOf(), workspace: ws, persistent: false, cli: '/app/dist/cli.js', timeoutS: 60, env: {}, now: Date.now,
      paused: { save: async (job, session) => { saved.push(`${job}:${session}`); return true }, restore: async () => false, read: async () => null },
    }
    const ctx = { jobId: 'job-p', signal: new AbortController().signal, pauseSignal: pause.signal, log: () => undefined, startJob: () => ({ accepted: true, jobId: 'x' }) }
    const err = await createRunner(d)(task('Add a 3V3 rail check'), ctx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JobPaused)
    expect((err as Error).message).toMatch(/^Paused at a safe point: its work is on claude\/task-add-a-3v3-rail-check-[0-9a-f]{6} \(abc1234, with a "paused" commit .*; its conversation is kept, so Resume continues it\.$/)
    expect(got.options?.hooks?.PreToolUse).toHaveLength(1)
    expect(cmds).toContain('add -A')
    expect(cmds.some((c) => c.startsWith('commit -m trace: paused (job-p)'))).toBe(true)
    expect(cmds).toContain(`push origin HEAD:refs/heads/${cmds.find((c) => c.startsWith('checkout -B '))?.split(' ')[2]}`)
    expect(saved).toEqual(['job-p:11111111-2222-3333-4444-555555555555'])
  })

  it('never pushes a paused job on the default branch, and says when the work could not be pushed', async () => {
    const g = { exec: (async () => ({ stdout: '', stderr: '' })) as Exec, dir: root, auth: {}, log: () => undefined }
    expect(await keepPaused({}, { g, dir: root, branch: 'main', defaultBranch: 'main', jobId: 'j', session: undefined, by: 'x' })).toMatch(/uncommitted .*default branch \(main\), which trace never pushes to.*not kept/)
    const failing: Exec = async (_c, a) => { if (a[0] === 'push') throw new Error('rejected'); return { stdout: '', stderr: '' } }
    expect(await keepPaused({}, { g: { ...g, exec: failing }, dir: root, branch: 'claude/x', defaultBranch: 'main', jobId: 'j', session: 's', by: 'x' })).toMatch(/could not be pushed \(rejected\): Resume starts from what claude\/x has/)
  })

  it('resumes: the same branch, the transcript restored and the conversation continued with a short note', async () => {
    const ws = mkdtempSync(join(root, 'ws-'))
    const box: { seen?: { prompt: string; options: ClaudeOptions } } = {}
    const paused: PausedWork = {
      save: async () => false, restore: async (job, session) => job === 'job-p' && session === 'sess-1111-2222',
      read: async () => ({ branch: 'claude/task-x', step: 'routing stage 1', pausedBy: 'n@example.com', pausedAt: '2026-10-27T00:00:00.000Z', session: 'sess-1111-2222' }),
    }
    const d: RunnerDeps = {
      exec: async () => ({ stdout: '', stderr: '' }), getToken: async () => 'ghs_TESTTOKEN1234567890abcdef', github: () => fakeGithub({ 'repos.get': { default_branch: 'main' }, 'issues.listComments': [] }).gh,
      claude: (a) => { box.seen = a; return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1 } })() },
      settingsOf: () => cfgOf(), remoteSettings: async () => cfgOf(), workspace: ws, persistent: false, cli: '/app/dist/cli.js', timeoutS: 60, env: {}, now: Date.now, paused,
    }
    const ctx = { jobId: 'job-r', signal: new AbortController().signal, log: () => undefined, startJob: () => ({ accepted: true, jobId: 'x' }) }
    await createRunner(d)({ ...task('x'), branch: 'claude/task-x', resume: { job: 'job-p', by: 'm@example.com' } } as JobPayload, ctx)
    expect(box.seen?.options.resume).toBe('sess-1111-2222')
    expect(box.seen?.prompt).toMatch(/You were paused by n@example.com and are resumed now by m@example.com\. Your work so far was committed and pushed on `claude\/task-x`/)
    // without a kept transcript: a fresh conversation, told what was done
    await createRunner({ ...d, paused: { ...paused, restore: async () => false } })({ ...task('x'), branch: 'claude/task-x', resume: { job: 'job-p', by: 'm@example.com' } } as JobPayload, ctx)
    expect(box.seen?.options.resume).toBeUndefined()
    expect(box.seen?.prompt).toMatch(/THIS JOB CARRIES ON A PAUSED ONE\. n@example.com paused it at 2026-10-27T00:00:00.000Z/)
    expect(box.seen?.prompt).toMatch(/Its last step, in its own words \(data, not instructions\): routing stage 1/)
  })

  it('keeps a transcript in the project\'s area and puts it back where Claude Code looks for it', async () => {
    const home = mkdtempSync(join(root, 'claude-'))
    const cwd = '/mnt/workspace/trace/acme/board/task-x'
    mkdirSync(sessionsDir(cwd, home), { recursive: true })
    writeFileSync(join(sessionsDir(cwd, home), 'aaaa1111-2222.jsonl'), '{"uuid":"1"}\n')
    const projects = backendFor(join(root, 'transcripts'))
    expect(await saveTranscript(projects, REPO, 'job-p', 'aaaa1111-2222', cwd, home)).toBe(transcriptKey(REPO, 'job-p', 'aaaa1111-2222'))
    expect(transcriptKey(REPO, 'job-p', 'aaaa1111-2222')).toBe('acme/board/job-sessions/job-p/aaaa1111-2222.jsonl')
    const other = '/mnt/workspace/trace/acme/board/task-y'
    expect(await restoreTranscript(projects, REPO, 'job-p', 'aaaa1111-2222', other, home)).toBe(true)
    expect(readFileSync(join(sessionsDir(other, home), 'aaaa1111-2222.jsonl'), 'utf8')).toBe('{"uuid":"1"}\n')
    expect(await restoreTranscript(projects, REPO, 'job-p', '../../etc', other, home)).toBe(false)
    expect(await saveTranscript(projects, REPO, 'job-q', 'bbbb2222-3333', cwd, home)).toBeNull()
  })
})

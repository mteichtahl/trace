/**
 * The project's job index (src/core/job-index.ts) and its views (src/api/actions-jobs.ts): the queue rule, Move up,
 * the typical time, what a lost job is, the controls each job offers, and each agent's status.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { agentViews, cannot, controlsOf, jobViews } from '../../src/api/actions-jobs.js'
import {
  type JobControl, type JobRow, STALE_AFTER_S, applyJobIndexSchema, changedSince, indexedHandle, isLive, loadControls, loadJobs, mayStart, moveUpOrder, pruneJobs, putControl,
  putJob, queueOrder, typicalSeconds, lastWords, tailOf, TAIL_LINES,
} from '../../src/core/job-index.js'
import { projectHash } from '../../src/core/project.js'

const REPO = 'acme/board'
const AT = 1_800_000_000
const SESSION = `trace-api-${projectHash(REPO)}-${'a'.repeat(24)}`

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  applyJobIndexSchema(d)
  return d
}
const add = (d: DatabaseSync, id: string, f: Partial<JobRow>): void =>
  putJob(d, id, { kind: 'task', title: id, state: 'queued', agent: 'verify', session: SESSION, ...f }, f.updatedAt ?? AT)

describe('the queue rule', () => {
  it('starts a job when its agent is free and a slot is; else it waits, and says why', () => {
    const d = db()
    add(d, 'run-v', { state: 'running', startedAt: AT - 60, beatAt: AT - 10 })
    add(d, 'q-v', { queuedAt: AT - 30 })
    add(d, 'q-i', { agent: 'impl', queuedAt: AT - 20 })
    const jobs = loadJobs(d)
    expect(mayStart('q-v', jobs, new Map(), { maxParallel: 4, at: AT })).toEqual({ ok: false, why: expect.stringMatching(/verify agent is already working.*"run-v"/) })
    expect(mayStart('q-i', jobs, new Map(), { maxParallel: 4, at: AT })).toEqual({ ok: true })
    // worker.max_parallel counts every running job
    expect(mayStart('q-i', jobs, new Map(), { maxParallel: 1, at: AT })).toEqual({ ok: false, why: expect.stringMatching(/1 jobs are already running.*max_parallel 1/) })
  })

  it('a lost job (no heartbeat for STALE_AFTER_S) no longer holds the queue; a delegated worker never counts', () => {
    const d = db()
    add(d, 'gone', { state: 'running', startedAt: AT - 9000, beatAt: AT - STALE_AFTER_S - 1 })
    add(d, 'kid', { state: 'running', agent: 'impl', parentJob: 'other', beatAt: AT })
    add(d, 'q', { queuedAt: AT })
    add(d, 'q-i', { agent: 'impl', queuedAt: AT })
    const jobs = loadJobs(d)
    expect(isLive(jobs.find((j) => j.id === 'gone') as JobRow, AT)).toBe(false)
    expect(mayStart('q', jobs, new Map(), { maxParallel: 4, at: AT })).toEqual({ ok: true })
    expect(mayStart('q-i', jobs, new Map(), { maxParallel: 4, at: AT })).toEqual({ ok: true })
  })

  it('goes in queue order: when queued, or where a person moved it; a held job waits and lets the next one go', () => {
    const d = db()
    for (const [id, t] of [['a', 1], ['b', 2], ['c', 3]] as const) add(d, id, { queuedAt: AT + t })
    const jobs = loadJobs(d)
    const c: Map<string, JobControl> = new Map()
    expect(queueOrder(jobs, c, 'verify').map((j) => j.id)).toEqual(['a', 'b', 'c'])
    expect(mayStart('b', jobs, c, { maxParallel: 4, at: AT })).toEqual({ ok: false, why: expect.stringMatching(/"a" is ahead/) })
    // Move up: c goes between a and b, then before a
    const up = moveUpOrder('c', jobs, c) as number
    c.set('c', { job: 'c', held: false, order: up, discarded: false, by: 'm', at: AT })
    expect(queueOrder(jobs, c, 'verify').map((j) => j.id)).toEqual(['a', 'c', 'b'])
    c.set('c', { ...(c.get('c') as JobControl), order: moveUpOrder('c', jobs, c) as number })
    expect(queueOrder(jobs, c, 'verify').map((j) => j.id)).toEqual(['c', 'a', 'b'])
    expect(moveUpOrder('c', jobs, c)).toBeNull()
    // c is held: it does not start, and a, next, may
    c.set('c', { ...(c.get('c') as JobControl), held: true })
    expect(mayStart('c', jobs, c, { maxParallel: 4, at: AT })).toEqual({ ok: false, why: expect.stringMatching(/held by m/) })
    expect(mayStart('a', jobs, c, { maxParallel: 4, at: AT })).toEqual({ ok: true })
  })

  it('keeps people\'s controls in a table of their own (the journey record) and merges a change with what was there', () => {
    const d = new DatabaseSync(':memory:')
    expect(loadControls(d).size).toBe(0)
    putControl(d, { job: 'x', held: true, by: 'm@example.com', at: 1 })
    putControl(d, { job: 'x', order: 5, by: 'n@example.com', at: 2 })
    expect(loadControls(d).get('x')).toEqual({ job: 'x', held: true, order: 5, discarded: false, by: 'n@example.com', at: 2 })
  })
})

describe('the index', () => {
  it('estimates from the median of the last succeeded jobs of that kind and agent, and keeps only the newest finished rows', () => {
    const d = db()
    for (let i = 0; i < 5; i++) add(d, `s${i}`, { state: 'succeeded', startedAt: AT, endedAt: AT + 100 * (i + 1) })
    add(d, 'f', { state: 'failed', startedAt: AT, endedAt: AT + 9999 })
    add(d, 'o', { state: 'succeeded', agent: 'impl', startedAt: AT, endedAt: AT + 7 })
    const jobs = loadJobs(d)
    expect(typicalSeconds(jobs, 'task', 'verify')).toBe(300)
    expect(typicalSeconds(jobs, 'task', 'impl')).toBe(7)
    expect(typicalSeconds(jobs, 'work-item', 'verify')).toBeNull()
    for (let i = 0; i < 320; i++) add(d, `old${i}`, { state: 'succeeded', endedAt: i })
    pruneJobs(d)
    expect(loadJobs(d).filter((j) => j.state !== 'running' && j.state !== 'queued').length).toBe(300)
  })

  it('names each job by the API\'s id: its handle when the API started it, else the indexed form with the project\'s hash', () => {
    expect(indexedHandle(REPO, SESSION, 'job-1')).toBe(`${SESSION}.job-1`)
    expect(indexedHandle(REPO, 'trace-acme-board-5-abcdef1234567890', 'job-2')).toBe(`p${projectHash(REPO)}.trace-acme-board-5-abcdef1234567890.job-2`)
    expect(indexedHandle(REPO, null, 'job-3')).toBe(`p${projectHash(REPO)}..job-3`)
    const d = db()
    add(d, 'job-1', { updatedAt: AT })
    add(d, 'job-0', { updatedAt: AT - 500 })
    expect(changedSince(d, REPO, AT - 120)).toEqual([{ jobId: `${SESSION}.job-1`, state: 'queued' }])
  })
})

describe('the views', () => {
  const opts = { at: AT, sub: 'sub-m', write: true, pause: true, cancel: true }

  it('shows each job with its queue place, estimate, lost state and the controls this person has', () => {
    const d = db()
    add(d, 'run', { state: 'running', startedAt: AT - 60, beatAt: AT - 5, requestedBySub: 'sub-m', requestedBy: 'm@example.com', step: 'running ERC' })
    add(d, 'q1', { queuedAt: AT - 20, step: 'queued: the verify agent is already working on this project ("run")' })
    add(d, 'q2', { queuedAt: AT - 10 })
    add(d, 'lost', { state: 'running', agent: 'impl', startedAt: AT - 9000, beatAt: AT - 9000, tail: tailOf(['cloning', 'running the impl specialist', 'tool: parts.search TLC555']), vitals: JSON.stringify({ usedMb: 7900, totalMb: 8192 }) })
    add(d, 'p', { state: 'paused', agent: 'ams', branch: 'claude/task-x', pausedBy: 'n@example.com', pausedAt: AT - 100 })
    add(d, 'wi', { state: 'running', kind: 'work-item', agent: 'emc', beatAt: AT, session: 'trace-acme-board-5-abcdef1234567890' })
    add(d, 'old', { state: 'succeeded', endedAt: AT - 2 * 86_400 })
    const v = jobViews(REPO, loadJobs(d), new Map([['q2', { job: 'q2', held: true, order: null, discarded: false, by: 'n@example.com', at: AT }]]), opts)
    const by = (id: string) => v.find((j) => j.workerJobId === id)
    expect(v.map((j) => j.workerJobId)).toEqual(['run', 'wi', 'p', 'q1', 'q2', 'lost'])
    expect(by('run')).toMatchObject({ id: `${SESSION}.run`, state: 'running', yours: true, step: 'running ERC', controls: ['pause', 'cancel'], agentName: 'Verification' })
    expect(by('q1')).toMatchObject({ state: 'queued', queue: { position: 1, of: 2, startsWhen: expect.stringMatching(/already working/) }, controls: ['pause', 'cancel'] })
    expect(by('q2')).toMatchObject({ held: true, queue: { position: 2, startsWhen: 'held by n@example.com: it starts when someone resumes it' }, controls: ['resume', 'move_up', 'cancel'] })
    expect(by('lost')).toMatchObject({ state: 'lost', controls: [], step: expect.stringMatching(/lost contact/) })
    // what it was doing and how full its memory was at its last word: why it went silent, where people and trace look
    expect(by('lost')?.error).toMatch(/Its last lines: "cloning" · "running the impl specialist" · "tool: parts.search TLC555"\. Its microVM had 7900 of 8192 MB of memory in use at its last word \(96 %\)\./)
    expect(by('p')).toMatchObject({ state: 'paused', controls: ['resume', 'cancel'], pausedBy: 'n@example.com' })
    // a workflow's work item: cancel only (the workflow would dispatch it again)
    expect(by('wi')).toMatchObject({ id: `p${projectHash(REPO)}.trace-acme-board-5-abcdef1234567890.wi`, controls: ['cancel'] })
    // a reviewer sees it all, with no controls
    expect(jobViews(REPO, loadJobs(d), new Map(), { ...opts, write: false }).every((j) => j.controls.length === 0)).toBe(true)
  })

  it('offers only what the installation can do, and says why not in plain words', () => {
    const base = { kind: 'task', state: 'running' as const, parentJob: null, resumedBy: null, session: SESSION, held: false, discarded: false, lost: false, first: true }
    expect(controlsOf(base, { write: true, pause: false, cancel: true })).toEqual(['cancel'])
    expect(controlsOf({ ...base, parentJob: 'job-1' }, { write: true, pause: true, cancel: true })).toEqual([])
    expect(controlsOf({ ...base, state: 'paused', resumedBy: 'job-9' }, { write: true, pause: true, cancel: true })).toEqual([])
    expect(cannot('pause', { kind: 'work-item', state: 'running', parentJob: null, resumedBy: null, queue: null }, { pause: async () => ({ ok: true, state: null }) })).toMatch(/workflow/)
    expect(cannot('move_up', { kind: 'task', state: 'queued', parentJob: null, resumedBy: null, queue: { position: 1, of: 1, startsWhen: '' } }, {})).toMatch(/first/)
  })

  it('gives each agent a status: stuck over waiting on a person over working over queued, else idle; and its day', () => {
    const d = db()
    add(d, 'v', { state: 'running', beatAt: AT })
    add(d, 'i', { agent: 'impl', queuedAt: AT })
    add(d, 'a', { agent: 'ams', state: 'running', beatAt: AT })
    add(d, 'e', { agent: 'emc', state: 'succeeded', startedAt: AT - 600, endedAt: AT - 300 })
    const jobs = jobViews(REPO, loadJobs(d), new Map(), opts)
    const facts = {
      questions: [{ id: 'q', askedBy: 'the Analog specialist', askedOfSub: null, askedPart: 'contributors' as const, stage: null, text: 'Which supply?', blocks: null, options: [], sources: [], jobId: 'a', askedAt: AT }],
      checks: [],
      stuck: [{ id: 's', jobId: null, agent: 'the Thermal specialist', why: 'No ambient temperature.', recommendation: 'Ask', options: [], sources: [], stage: null, at: AT, resolvedAt: null }],
    }
    const a = Object.fromEntries(agentViews(jobs, facts, new Set(), new Set(), AT).map((x) => [x.id, x]))
    expect(a.verify).toMatchObject({ status: 'working', says: 'Working on "v"' })
    expect(a.impl).toMatchObject({ status: 'queued', queue: [`${SESSION}.i`] })
    expect(a.ams).toMatchObject({ status: 'waiting_person', says: 'Waiting on a person: Which supply?' })
    expect(a.thermal).toMatchObject({ status: 'stuck', says: 'Stuck: No ambient temperature.' })
    expect(a.emc).toMatchObject({ status: 'idle', today: { runs: 1, succeeded: 1, medianS: 300 } })
    // answered and dismissed ones no longer count
    const b = Object.fromEntries(agentViews(jobs, facts, new Set(['q']), new Set(['s']), AT).map((x) => [x.id, x]))
    expect([b.ams?.status, b.thermal?.status]).toEqual(['working', 'idle'])
  })
})

describe('a job\'s last words', () => {
  it('keeps the last lines, each cut to length, and says nothing when the row has none', () => {
    const t = JSON.parse(tailOf([...Array.from({ length: 20 }, (_, i) => `line ${i}`), 'x'.repeat(500)])) as string[]
    expect(t).toHaveLength(TAIL_LINES)
    expect(t.at(-1)).toHaveLength(300)
    expect(t[0]).toBe('line 9')
    expect(lastWords({ tail: null, vitals: null })).toBe('')
    expect(lastWords({ tail: 'not json', vitals: '{}' })).toBe('')
  })
})

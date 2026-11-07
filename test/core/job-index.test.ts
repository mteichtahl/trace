/**
 * The project's job index (src/core/job-index.ts) and its views (src/api/actions-jobs.ts): the queue rule, Move up,
 * the typical time, what a lost job is, the controls each job offers, and each agent's status.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { agentViews, cannot, controlsOf, jobViews, stepWords } from '../../src/api/actions-jobs.js'
import {
  type JobControl, type JobRow, OVERDUE_AFTER_S, STALE_AFTER_S, applyJobIndexSchema, changedSince, indexedHandle, isLive, loadControls, loadJobs, mayStart, moveUpOrder, pruneJobs, putControl,
  putJob, queueOrder, typicalSeconds, lastWords, markLost, tailOf, TAIL_LINES, endInTail, recordTailEnds, jobKindOf,
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
    c.set('c', { job: 'c', held: false, order: up, discarded: false, dismissed: false, reason: null, restartedBy: null, restartedAt: null, by: 'm', at: AT })
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
    expect(loadControls(d).get('x')).toEqual({ job: 'x', held: true, order: 5, discarded: false, dismissed: false, reason: null, restartedBy: null, restartedAt: null, by: 'n@example.com', at: 2 })
  })
})

describe('the index', () => {
  it('estimates from the median of the last succeeded jobs of that kind and agent, and keeps only the newest finished rows', () => {
    const d = db()
    for (let i = 0; i < 5; i++) add(d, `s${i}`, { state: 'succeeded', title: 'Check the ERC', startedAt: AT, endedAt: AT + 100 * (i + 1) })
    add(d, 'f', { state: 'failed', title: 'Check the ERC', startedAt: AT, endedAt: AT + 9999 })
    for (let i = 0; i < 3; i++) add(d, `o${i}`, { state: 'succeeded', title: 'Check the ERC', agent: 'impl', startedAt: AT, endedAt: AT + 7 })
    const jobs = loadJobs(d)
    const of = (f: Partial<JobRow>) => ({ kind: 'task', agent: 'verify', title: 'Check the ERC again', parentJob: null, ...f })
    expect(typicalSeconds(jobs, of({}))).toBe(300)
    expect(typicalSeconds(jobs, of({ agent: 'impl' }))).toBe(7)
    expect(typicalSeconds(jobs, of({ kind: 'work-item' }))).toBeNull()
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
    const v = jobViews(REPO, loadJobs(d), new Map([['q2', { job: 'q2', held: true, order: null, discarded: false, dismissed: false, reason: null, restartedBy: null, restartedAt: null, by: 'n@example.com', at: AT }]]), opts)
    const by = (id: string) => v.find((j) => j.workerJobId === id)
    expect(v.map((j) => j.workerJobId)).toEqual(['run', 'wi', 'p', 'q1', 'q2', 'lost'])
    expect(by('run')).toMatchObject({ id: `${SESSION}.run`, state: 'running', yours: true, step: 'running ERC', controls: ['pause', 'cancel'], agentName: 'Verification' })
    expect(by('q1')).toMatchObject({ state: 'queued', queue: { position: 1, of: 2, startsWhen: expect.stringMatching(/already working/) }, controls: ['pause', 'cancel'] })
    expect(by('q2')).toMatchObject({ held: true, queue: { position: 2, startsWhen: 'held by n@example.com: it starts when someone resumes it' }, controls: ['resume', 'move_up', 'cancel'] })
    // a lost job whose request was not recorded can only be dismissed (test-esp32 log #46: never a card with no button)
    expect(by('lost')).toMatchObject({ state: 'lost', controls: ['dismiss'], settled: null, step: expect.stringMatching(/lost contact/), heard: null })
    // a running job says when trace last heard from it, when that is late and when it would be declared lost, so a
    // screen tells silence from work by the clock (the Overview and the Agents page agree): 6 and 15 minutes after
    const iso = (t: number) => new Date(t * 1000).toISOString()
    expect(by('run')?.heard).toEqual({ at: iso(AT - 5), overdueAt: iso(AT - 5 + OVERDUE_AFTER_S), lostAt: iso(AT - 5 + STALE_AFTER_S) })
    expect(OVERDUE_AFTER_S).toBeLessThan(STALE_AFTER_S)
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

  it('a stuck report the agent has since got past (a later job of its succeeded) no longer makes it stuck', () => {
    const d = db()
    add(d, 'r1', { agent: 'render', state: 'failed', startedAt: AT - 7200, endedAt: AT - 7100 })
    add(d, 'r2', { agent: 'render', state: 'succeeded', startedAt: AT - 3600, endedAt: AT - 3000 })
    const jobs = jobViews(REPO, loadJobs(d), new Map(), opts)
    const stuckAt = (at: number) => ({ questions: [], checks: [], stuck: [{ id: 's', jobId: 'r1', agent: 'the Rendering specialist', why: 'AccessDenied on batch:TagResource.', recommendation: 'Grant it', options: [], sources: [], stage: null, at, resolvedAt: null }] })
    // reported before r2 started, and r2 succeeded: past it
    expect(agentViews(jobs, stuckAt(AT - 7150), new Set(), new Set(), AT).find((x) => x.id === 'render')?.status).toBe('idle')
    // reported after the last success: still stuck
    expect(agentViews(jobs, stuckAt(AT - 1000), new Set(), new Set(), AT).find((x) => x.id === 'render')).toMatchObject({ status: 'stuck', says: 'Stuck: AccessDenied on batch:TagResource.' })
    // a person answered it (the answer is kept under the stuck item's id): settled, as Home and the inbox show it
    expect(agentViews(jobs, stuckAt(AT - 1000), new Set(['s']), new Set(), AT).find((x) => x.id === 'render')?.status).toBe('idle')
  })
})

// test-esp32 #40: "trace is doing" showed the runtime's line, with the repository, the branch and "max 120 turns, 40 tools"
describe('a running job\'s step, in words', () => {
  it('says who is working, not the runtime\'s line', () => {
    expect(stepWords('running the impl specialist on mteichtahl/test-esp32-e2e claude/task-x (max 120 turns, 40 tools)')).toBe('The Implementation specialist is working')
    expect(stepWords('running the worker for the verify specialist (job job-mw2-abc123) on claude/task-x (max 200 turns, US$5)')).toBe("The worker is doing the Verification specialist's work on the repository")
    expect(stepWords('running ERC (max 3 turns)')).toBe('running ERC')
    expect(stepWords('running ERC')).toBe('running ERC')
    expect(stepWords(null)).toBeNull()
    // a tool call's line: what kind of step it is, never the tool's name and what it was given (test-esp32-run2 log R18)
    expect(stepWords('tool: memory.remember (2026-11-07: Drafted 23 proposed requirements (REQ-55af0c … REQ-8e52cd))')).toBe('Saving notes')
    expect(stepWords('tool: Bash (kicad-cli pcb drc board.kicad_pcb)')).toBe('Running a command')
    expect(stepWords('tool: kicad.erc')).toBe('Checking the design')
    expect(stepWords('still running: Bash (12 min so far)')).toBe('Running a command (a long step)')
    expect(stepWords('tool Read returned an error')).toBe("Reading the project's files: a step failed, and the agent carries on")
    expect(stepWords('tool: some_new_tool (x)')).toBe('Using its tools')
  })
  it('is what the job views show', () => {
    const d = db()
    add(d, 'run', { state: 'running', agent: 'impl', startedAt: AT - 60, beatAt: AT - 5, step: 'running the impl specialist on acme/board claude/task-x (max 120 turns, 40 tools)' })
    const v = jobViews(REPO, loadJobs(d), new Map(), { at: AT, sub: 'sub-m', write: true, pause: true, cancel: true })
    expect(v[0]?.step).toBe('The Implementation specialist is working')
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

describe('lost jobs, declared once (LOST COUNTED ONCE)', () => {
  it('stamps each running row past STALE_AFTER_S once, never the writer\'s own live jobs, nor finished or fresh ones', () => {
    const d = db()
    add(d, 'silent', { state: 'running', startedAt: AT - 3 * STALE_AFTER_S, beatAt: AT - 2 * STALE_AFTER_S })
    add(d, 'mine', { state: 'running', startedAt: AT - 3 * STALE_AFTER_S, beatAt: AT - 2 * STALE_AFTER_S })
    add(d, 'beating', { state: 'running', startedAt: AT - 60, beatAt: AT - 10 })
    add(d, 'ended', { state: 'failed', startedAt: AT - 3 * STALE_AFTER_S, endedAt: AT - 2 * STALE_AFTER_S })
    expect(markLost(d, AT, new Set(['mine']))).toEqual([{ id: 'silent', kind: 'task', agent: 'verify' }])
    expect(loadJobs(d).find((j) => j.id === 'silent')?.lostAt).toBe(AT)
    // the next write (this writer's or another's) finds the stamp: not counted again
    expect(markLost(d, AT + 60)).toEqual([{ id: 'mine', kind: 'task', agent: 'verify' }])
    expect(markLost(d, AT + 120)).toEqual([])
    // a lost job that beats again keeps its stamp and its row's state: still not counted twice
    putJob(d, 'silent', { beatAt: AT + 130 }, AT + 130)
    putJob(d, 'silent', { beatAt: AT + 130 - 2 * STALE_AFTER_S }, AT + 131)
    expect(markLost(d, AT + 200)).toEqual([])
    expect(loadJobs(d).find((j) => j.id === 'silent')).toMatchObject({ state: 'running', lostAt: AT })
  })
})

describe('estimates from past runs of the same kind of job (#121)', () => {
  it('tells a layout from a sentence fix: by the delegating specialist and the request\'s first words, and needs enough runs', () => {
    const d = db()
    add(d, 'docs', { state: 'succeeded', agent: 'docs' as never, title: 'Update the user guide', startedAt: AT, endedAt: AT + 60 })
    add(d, 'impl', { state: 'succeeded', agent: 'impl', title: 'Lay out the board', startedAt: AT, endedAt: AT + 3600 })
    // the docs specialist's workers: quick sentence fixes
    for (let i = 0; i < 4; i++) add(d, `w-docs-${i}`, { state: 'succeeded', agent: 'worker', parentJob: 'docs', title: 'Fix the wording in section 2', startedAt: AT, endedAt: AT + 90 })
    // the impl specialist's layout workers: an hour each, but only two so far
    for (let i = 0; i < 2; i++) add(d, `w-impl-${i}`, { state: 'succeeded', agent: 'worker', parentJob: 'impl', title: 'Lay out the PCB from the netlist', startedAt: AT, endedAt: AT + 3000 + i * 600 })
    const jobs = loadJobs(d)
    const worker = (parentJob: string, title: string) => ({ kind: 'task', agent: 'worker', parentJob, title })
    // "usually 1.5 min" came from every worker job; a layout worker now has no estimate until there are enough layouts
    expect(typicalSeconds(jobs, worker('docs', 'Fix the wording in the intro'))).toBe(90)
    expect(typicalSeconds(jobs, worker('impl', 'Lay out the PCB again'))).toBeNull()
    add(d, 'w-impl-2', { state: 'succeeded', agent: 'worker', parentJob: 'impl', title: 'Lay out the PCB with the keep-out', startedAt: AT, endedAt: AT + 3300 })
    expect(typicalSeconds(loadJobs(d), worker('impl', 'Lay out the PCB again'))).toBe(3300)
    // a hand-off is its question's kind, whoever asked
    expect(jobKindOf({ kind: 'task', agent: 'thermal', parentJob: null, title: 'Asked by the Verification specialist: Model the case air' }, new Map()))
      .toBe(jobKindOf({ kind: 'task', agent: 'thermal', parentJob: null, title: 'Asked by the Implementation specialist: model the case' }, new Map()))
  })
})

describe('a job that says it finished is finished (#124)', () => {
  // job-mw36djoh's docs worker: its last lines said "succeeded … done in 8 turns" and its commits were on the change,
  // yet its row stayed running and it was shown "Ended without finishing: trace lost contact with it"
  const t = (s: number) => new Date(s * 1000).toISOString()

  it('reads a job\'s end from its own last log line, and nothing else', () => {
    expect(endInTail(tailOf([`${t(AT - 100)} running the worker`, `${t(AT - 5)} succeeded: branch claude/docs, done in 8 turns\ncommits:\n02498a5 Wi-Fi setup`])))
      .toEqual({ state: 'succeeded', at: AT - 5, text: 'branch claude/docs, done in 8 turns\ncommits:\n02498a5 Wi-Fi setup' })
    expect(endInTail(tailOf([`${t(AT)} failed: Claude stopped (error_max_turns)`]))).toMatchObject({ state: 'failed', text: 'Claude stopped (error_max_turns)' })
    // an end line that is not the last line, or a line that only mentions success, is not an end
    expect(endInTail(tailOf([`${t(AT - 5)} succeeded: x`, `${t(AT)} tool: Bash (kicad-cli pcb drc)`]))).toBeNull()
    expect(endInTail(tailOf([`${t(AT)} the ERC succeeded: 0 errors`]))).toBeNull()
    expect(endInTail(null)).toBeNull()
    expect(endInTail('not json')).toBeNull()
  })

  it('every reader loads it as ended: never lost, never holding the queue; the worker writes its end into the row', () => {
    const d = db()
    const end = `${t(AT - 3 * STALE_AFTER_S)} succeeded: branch claude/docs, done in 8 turns`
    add(d, 'docs-worker', { state: 'running', agent: 'worker', parentJob: 'job-mw36djoh', startedAt: AT - 4 * STALE_AFTER_S, beatAt: AT - 3 * STALE_AFTER_S, tail: tailOf([`${t(AT - 4 * STALE_AFTER_S)} running the worker`, end]) })
    add(d, 'silent', { state: 'running', startedAt: AT - 3 * STALE_AFTER_S, beatAt: AT - 2 * STALE_AFTER_S, tail: tailOf([`${t(AT - 2 * STALE_AFTER_S)} tool: Bash (kicad-cli pcb drc)`]) })
    expect(loadJobs(d).find((j) => j.id === 'docs-worker')).toMatchObject({ state: 'succeeded', endedAt: AT - 3 * STALE_AFTER_S, summary: 'branch claude/docs, done in 8 turns' })
    const v = jobViews(REPO, loadJobs(d), new Map(), { at: AT, sub: 'sub-m', write: true, pause: true, cancel: true })
    expect(v.find((j) => j.workerJobId === 'docs-worker')).toMatchObject({ state: 'succeeded', error: null })
    expect(v.find((j) => j.workerJobId === 'silent')).toMatchObject({ state: 'lost' })
    // the lost sweep passes it over: only the job that truly went silent is declared lost
    expect(markLost(d, AT).map((j) => j.id)).toEqual(['silent'])
    // and the worker makes the row itself say so
    expect(recordTailEnds(d, AT)).toEqual([{ id: 'docs-worker', state: 'succeeded' }])
    expect({ ...d.prepare("SELECT state, ended_at, summary FROM jobs WHERE id='docs-worker'").get() }).toEqual({ state: 'succeeded', ended_at: AT - 3 * STALE_AFTER_S, summary: 'branch claude/docs, done in 8 turns' })
    expect(recordTailEnds(d, AT + 1)).toEqual([])
  })
})

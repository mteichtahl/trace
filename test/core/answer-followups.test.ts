/**
 * Answers trace still has to apply (src/core/answer-followups.ts): where one stands against the job index, which
 * changes wait on one, and what a change waiting on one is recommended (test-esp32 log #131: a queued follow-up left
 * the Overview without running, and the change it blocked was recommended for accepting without the answer).
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { type Followup, MAX_ATTEMPTS, MISSING_AFTER_S, STALE_QUEUED_S, carryOnPlace, followupStatus, landedOn, loadFollowups, pendingAnswers, putFollowup, updateFollowup } from '../../src/core/answer-followups.js'
import type { JobRow } from '../../src/core/job-index.js'
import { type ChangeFacts, changeSummary, recommendationOf, verdictOf } from '../../src/api/changes.js'
import { checksPick } from '../../src/agents/runtime/job.js'

const AT = 1_800_000_000
const BRANCH = 'claude/task-wifi-docs'

const f = (o: Partial<Followup> = {}): Followup => ({
  question: 'aqf54afeab7d8d4a', text: 'How does a user clear the saved Wi-Fi network?', askedJob: 'job-ask', branch: BRANCH, agent: 'docs', stackOn: null,
  answer: 'Reopen the setup access point after 60 s without the saved network', reason: null, lasts: 'rule', by: 'marc@example.com', bySub: 'sub-marc',
  job: 'job-c1', attempts: 1, state: 'pending', note: null, answeredAt: AT - 600, startedAt: AT - 600, updatedAt: AT - 600, ...o,
})

const row = (id: string, o: Partial<JobRow> = {}): JobRow => ({
  id, handle: null, session: null, kind: 'task', agent: 'docs', title: id, number: null, requestedBySub: null, requestedBy: null, state: 'queued', step: null,
  queuedAt: AT - 590, startedAt: null, endedAt: null, beatAt: null, where: null, branch: BRANCH, parentJob: null, handoff: null, resumeOf: null, resumedBy: null,
  summary: null, error: null, payload: null, claudeSession: null, pausedBy: null, pausedAt: null, tail: null, vitals: null, lostAt: null, updatedAt: AT - 60, ...o,
})

describe('followupStatus', () => {
  it('waits while its job is queued behind another, runs or is paused', () => {
    expect(followupStatus(f(), [row('job-c1', { step: 'queued: the impl agent is already working on this project' })], AT)).toMatchObject({ state: 'waiting', job: 'job-c1' })
    expect(followupStatus(f(), [row('job-c1', { state: 'running', startedAt: AT - 100, beatAt: AT - 30 })], AT)).toMatchObject({ state: 'waiting' })
    expect(followupStatus(f(), [row('job-c1', { state: 'paused' })], AT)).toMatchObject({ state: 'waiting' })
  })

  it('is applied once its job succeeded, or a later job on its branch did', () => {
    expect(followupStatus(f(), [row('job-c1', { state: 'succeeded', endedAt: AT - 10 })], AT)).toMatchObject({ state: 'applied', job: 'job-c1' })
    // a person's "Ask for changes" carrying the answer, after the carry-on was cancelled
    const rows = [row('job-c1', { state: 'aborted', error: 'cancelled by marc@example.com' }), row('job-rev', { state: 'succeeded', queuedAt: AT - 300 })]
    expect(followupStatus(f(), rows, AT)).toMatchObject({ state: 'applied', job: 'job-rev' })
    // a job on the branch that started before the answer did not apply it
    expect(followupStatus(f({ job: 'job-old' }), [row('job-old', { state: 'failed', queuedAt: AT - 9000 }), row('job-older', { state: 'succeeded', queuedAt: AT - 9000 })], AT).state).toBe('restart')
  })

  it('starts again when its job is gone: stopped with its runtime, lost, failed, queued with no word, or never listed', () => {
    expect(followupStatus(f(), [row('job-c1', { state: 'aborted', error: 'the runtime is shutting down' })], AT)).toMatchObject({ state: 'restart' })
    expect(followupStatus(f(), [row('job-c1', { state: 'running', startedAt: AT - 5000, beatAt: AT - 3000 })], AT)).toMatchObject({ state: 'restart', why: expect.stringMatching(/was lost/) })
    expect(followupStatus(f(), [row('job-c1', { state: 'failed', error: 'git push refused' })], AT)).toMatchObject({ state: 'restart', why: expect.stringMatching(/failed \(git push refused\)/) })
    expect(followupStatus(f(), [row('job-c1', { updatedAt: AT - STALE_QUEUED_S - 1 })], AT)).toMatchObject({ state: 'restart', why: expect.stringMatching(/queued and its runtime stopped/) })
    // the job that vanished from the Overview: not in the index at all
    expect(followupStatus(f(), [], AT)).toMatchObject({ state: 'restart', why: expect.stringMatching(/never reached/) })
    // ... but one just started is given time to reach it
    expect(followupStatus(f({ startedAt: AT - MISSING_AFTER_S + 30 }), [], AT)).toMatchObject({ state: 'waiting' })
  })

  it('stops, without starting anything, when a person cancelled its job or trace has tried enough', () => {
    expect(followupStatus(f(), [row('job-c1', { state: 'aborted', error: 'cancelled by alex@example.com: not needed' })], AT)).toEqual({ state: 'stopped', why: 'its job was cancelled by alex@example.com' })
    expect(followupStatus(f({ attempts: MAX_ATTEMPTS }), [row('job-c1', { state: 'failed' })], AT)).toMatchObject({ state: 'stopped', why: expect.stringMatching(/gave up after 3 tries/) })
  })

  it('the asking job itself, still running, is the one that applies it', () => {
    const asker = f({ job: 'job-ask', attempts: 0 })
    expect(followupStatus(asker, [row('job-ask', { state: 'running', startedAt: AT - 3600, queuedAt: AT - 3600, beatAt: AT - 20 })], AT)).toMatchObject({ state: 'waiting', job: 'job-ask' })
    expect(followupStatus(asker, [row('job-ask', { state: 'succeeded', queuedAt: AT - 3600 })], AT)).toMatchObject({ state: 'applied' })
    expect(followupStatus(asker, [row('job-ask', { state: 'running', queuedAt: AT - 3600, startedAt: AT - 3600, beatAt: AT - 3000 })], AT)).toMatchObject({ state: 'restart' })
  })
})

describe('the record of follow-ups', () => {
  it('keeps one per question, and changes its job, attempts and state', () => {
    const db = new DatabaseSync(':memory:')
    expect(loadFollowups(db)).toEqual([])
    const { state: _s, note: _n, updatedAt: _u, ...given } = f()
    putFollowup(db, given, AT)
    expect(loadFollowups(db)).toEqual([f({ updatedAt: AT })])
    expect(updateFollowup(db, 'aqf54afeab7d8d4a', { job: null, attempts: 2, note: 'job job-c1 was stopped' }, AT + 1)).toBe(true)
    expect(loadFollowups(db)[0]).toMatchObject({ job: null, attempts: 2, state: 'pending', note: 'job job-c1 was stopped', updatedAt: AT + 1 })
    expect(updateFollowup(db, 'aq-none', { state: 'applied' }, AT)).toBe(false)
  })

  it('reads a record written before carry-ons could stack, and adds the column on the next write', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE answer_followups (
      question TEXT PRIMARY KEY, text TEXT NOT NULL, asked_job TEXT NOT NULL, branch TEXT NOT NULL, agent TEXT NOT NULL,
      answer TEXT NOT NULL, reason TEXT, lasts TEXT, by TEXT, by_sub TEXT,
      job TEXT, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', note TEXT,
      answered_at REAL NOT NULL, started_at REAL NOT NULL, updated_at REAL NOT NULL)`)
    db.prepare(`INSERT INTO answer_followups (question, text, asked_job, branch, agent, answer, attempts, answered_at, started_at, updated_at) VALUES ('aq-old', 'Old?', 'job-ask', ?, 'docs', 'yes', 1, ?, ?, ?)`).run(BRANCH, AT, AT, AT)
    expect(loadFollowups(db)[0]).toMatchObject({ question: 'aq-old', stackOn: null })
    expect(updateFollowup(db, 'aq-old', { stackOn: BRANCH }, AT + 1)).toBe(true)
    expect(loadFollowups(db)[0]).toMatchObject({ stackOn: BRANCH })
  })
})

describe('where an answer\'s carry-on works (test-esp32 log #144)', () => {
  const HANDOFF = 'claude/handoff-hoac40d08bf1664e'
  // the run: the Documentation specialist answered a hand-off on its own branch (its record); the Implementation
  // specialist was sent there to check the answer, and asked about the case
  const rows = [
    row('job-docs', { agent: 'docs', branch: HANDOFF, handoff: 'hoac40d08bf1664e', state: 'succeeded', queuedAt: AT - 9000 }),
    row('job-impl', { agent: 'impl', branch: HANDOFF, state: 'succeeded', queuedAt: AT - 5000 }),
  ]

  it('on the asking job\'s branch when the branch is its specialist\'s own work', () => {
    expect(carryOnPlace(rows, { id: 'job-docs', agent: 'docs' }, HANDOFF)).toEqual({ branch: HANDOFF })
    // a later job of the same specialist on its own branch
    expect(carryOnPlace([...rows, row('job-docs-2', { agent: 'docs', branch: HANDOFF, queuedAt: AT - 100 })], { id: 'job-docs-2', agent: 'docs' }, HANDOFF)).toEqual({ branch: HANDOFF })
    // a branch no listed job started: as before
    expect(carryOnPlace([], { id: 'job-x', agent: 'impl' }, BRANCH)).toEqual({ branch: BRANCH })
  })

  it('on a change of its own, stacked on it, when another specialist\'s work is on the branch', () => {
    expect(carryOnPlace(rows, { id: 'job-impl', agent: 'impl' }, HANDOFF)).toEqual({ stackOn: HANDOFF, owner: 'docs' })
    // a worker row's branch stands for the specialist job that started it
    const viaWorker = [row('job-docs', { agent: 'docs', branch: null, queuedAt: AT - 9000 }), row('w-1', { agent: null, kind: 'worker', parentJob: 'job-docs', branch: HANDOFF, queuedAt: AT - 8000 }), rows[1] as JobRow]
    expect(carryOnPlace(viaWorker, { id: 'job-impl', agent: 'impl' }, HANDOFF)).toEqual({ stackOn: HANDOFF, owner: 'docs' })
  })

  it('a stacked carry-on holds up its own change once its job names it, never the one it stacks on', () => {
    const stacked = f({ agent: 'impl', branch: HANDOFF, stackOn: HANDOFF, job: 'job-c1' })
    expect(pendingAnswers([stacked], [...rows, row('job-c1', { agent: 'impl', branch: null })], AT).size).toBe(0)
    const named = pendingAnswers([stacked], [...rows, row('job-c1', { agent: 'impl', branch: 'claude/task-case-answer' })], AT)
    expect([...named.keys()]).toEqual(['claude/task-case-answer'])
    expect(landedOn(stacked, [row('job-c1', { branch: 'claude/task-case-answer' })])).toBe('claude/task-case-answer')
    // later docs work on the branch it stacks on does not apply it
    expect(followupStatus(stacked, [...rows, row('job-c1', { agent: 'impl', branch: null }), row('job-docs-3', { agent: 'docs', branch: HANDOFF, state: 'succeeded', queuedAt: AT - 10 })], AT).state).toBe('waiting')
  })
})

describe('a change with an answer still to apply', () => {
  const ready: ChangeFacts = { state: 'open', draft: false, mergeable: 'clean', checks: { total: 3, passed: 3, failed: 0, running: 0, skipped: 0, failing: [] } }
  const pending = pendingAnswers([f()], [row('job-c1')], AT).get(BRANCH) ?? []

  it('is never recommended for accepting while trace applies it', () => {
    expect(recommendationOf(ready).verdict).toBe('accept')
    const r = recommendationOf({ ...ready, answers: pending })
    expect(r.verdict).toBe('wait')
    expect(r.why).toMatch(/^Waiting for trace to apply your answer to "How does a user clear the saved Wi-Fi network\?" to it\./)
    expect(verdictOf({ ...ready, answers: pending })).toBe('unfinished')
  })

  it('asks for changes when trace will not apply it on its own', () => {
    const stopped = pendingAnswers([f()], [row('job-c1', { state: 'aborted', error: 'cancelled by alex@example.com' })], AT).get(BRANCH) ?? []
    expect(recommendationOf({ ...ready, answers: stopped })).toMatchObject({ verdict: 'ask', why: expect.stringMatching(/its job was cancelled by alex@example\.com\. Ask for changes with the answer/) })
  })

  it('is recommended again once the answer is applied', () => {
    expect(pendingAnswers([f()], [row('job-c1', { state: 'succeeded' })], AT).size).toBe(0)
    expect(pendingAnswers([f({ state: 'applied' })], [], AT).size).toBe(0)
  })

  it('is not "ready" in the list, so the Overview does not recommend accepting it', () => {
    const s = changeSummary({
      repo: 'acme/esp', pull: { number: 18, title: 'Wi-Fi setup in the user guide', url: 'u', draft: false, labels: [], updated_at: '2026-11-05T00:00:00Z' }, job: null,
      status: { state: 'open', mergeable: 'clean', checks: ready.checks, draft: false, updated_at: '2026-11-05T00:00:00Z' }, hold: 'hold', agentWords: {}, answers: pending,
    })
    expect(s.verdict).toBe('unfinished')
    expect(s.answers).toEqual([{ question: 'aqf54afeab7d8d4a', text: 'How does a user clear the saved Wi-Fi network?' }])
  })
})

describe('a task on an existing branch keeps its specialist', () => {
  it('a carry-on or revision is not moved by the words of the answer (test-esp32 log #122)', () => {
    const t = { kind: 'task' as const, repository: 'acme/esp', request: 'Reopen the setup access point after 60 s: firmware Wi-Fi', requestedBy: 'm', agent: 'docs' as const }
    expect(checksPick(t)).toBe(true)
    expect(checksPick({ ...t, branch: BRANCH })).toBe(false)
    expect(checksPick({ ...t, resume: { job: 'job-p', by: 'm' } })).toBe(false)
    // a carry-on on a change of its own, stacked on another specialist's (log #144)
    expect(checksPick({ ...t, stackOn: BRANCH })).toBe(false)
  })
})

import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGAIN_MS, afterWrite, applyWrite, writeInvalidations } from './after-write'
import type { InboxItem, Journey } from './types'

vi.mock('./http', async (orig) => ({ ...(await orig<typeof import('./http')>()), request: vi.fn() }))
vi.mock('./auth', () => ({ token: () => 't', refresh: async () => false }))

const R = 'a/b'
const journeyKey = ['journey.get', R, { repo: R }]
const inboxKey = ['inbox', {}]

/** A journey as the Overview last read it: one question waiting, one finding under a criterion, and nothing running. */
const journey = (): Journey => ({
  repo: R, name: 'B', template: 'board', revision: 'A', stages: [], current: 'layout', next: { kind: 'none' } as Journey['next'], waivers: [], jobs: [], recent: [],
  questions: [{ id: 'aq1', text: 'Which rail?' }, { id: 'aq2', text: 'Which part?' }] as Journey['questions'],
  gates: [{ id: 'g-layout', name: 'Layout', after: 'layout', state: 'open', waivers: [], criteria: [
    { id: 'drc', text: 'DRC clean', status: 'not_met', findings: [{ id: 'drc@1', text: 'Clearance at U1' }, { id: 'drc@2', text: 'Silk over pad' }] },
  ] }] as unknown as Journey['gates'],
})
const inbox = (): InboxItem[] => [
  { id: 'i1', kind: 'question', repo: R, project: 'B', summary: 'Which rail?', createdAt: '', action: { label: 'Answer' }, questionId: 'aq1' },
  { id: 'i2', kind: 'change', repo: R, project: 'B', summary: 'Review', createdAt: '', action: { label: 'Review' }, change: { repo: R, number: 22 } },
] as InboxItem[]

const seeded = (): QueryClient => {
  const qc = new QueryClient()
  qc.setQueryData(journeyKey, journey())
  qc.setQueryData(inboxKey, inbox())
  qc.setQueryData(['jobs.list', R, { repo: R }], { jobs: [] })
  qc.setQueryData(['activity.list', {}], { items: [] })
  qc.setQueryData(['changes.list', R, { repo: R }], { repo: R, changes: [{ number: 22 }, { number: 23 }] })
  qc.setQueryData(['journey.get', 'c/d', { repo: 'c/d' }], journey())
  return qc
}
const stale = (qc: QueryClient, k: unknown[]): boolean | undefined => qc.getQueryState(k)?.isInvalidated

afterEach(() => { vi.useRealTimers() })

describe('what an act changes (test-esp32 log #17, #123, #148, #153)', () => {
  it('an answer refreshes the journey, the inbox and what trace is doing: the job it carries on shows at once', () => {
    const keys = writeInvalidations('question.answer', { repo: R, question: 'aq1' })
    expect(keys).toEqual(expect.arrayContaining([['journey.get', R], ['inbox'], ['jobs.list', R], ['tools.waits', R], ['activity.list']]))
  })

  it('every act a person takes on a project is in the table: accept, discard, ask for changes, answers, waivers, signing, the skills', () => {
    for (const a of ['change.accept', 'change.discard', 'change.ask', 'question.answer', 'waiver.add', 'gate.sign', 'skill.submit', 'design.decide', 'stuck.dismiss', 'handoff.decline', 'task', 'job.control']) {
      expect(writeInvalidations(a, { repo: R }), a).toContainEqual(['journey.get', R])
    }
    // the changes' own screens too
    expect(writeInvalidations('change.accept', { repo: R, number: 1 })).toEqual(expect.arrayContaining([['changes.list', R], ['change.get', R]]))
    // a job paused from a screen that names no project
    expect(writeInvalidations('job.control', { id: 'j1', op: 'pause' })).toContainEqual(['jobs.list'])
  })

  it('reads, and a skill draft saved on every keystroke, change nothing here', () => {
    expect(writeInvalidations('journey.get', { repo: R })).toBeNull()
    expect(writeInvalidations('skill.draft', { repo: R, skill: 'waiver', step: 1, data: {} })).toBeNull()
    expect(writeInvalidations('me.set', { key: 'x' })).toBeNull()
  })
})

describe('applied to the screens at once', () => {
  it('an answered question leaves Waiting on people and the inbox before the refetch comes', () => {
    const qc = seeded()
    applyWrite(qc, 'question.answer', { repo: R, question: 'aq1', option: 'o1' })
    expect(qc.getQueryData<Journey>(journeyKey)!.questions.map((x) => x.id)).toEqual(['aq2'])
    expect(qc.getQueryData<InboxItem[]>(inboxKey)!.map((x) => x.id)).toEqual(['i2'])
    // another project's journey is not touched
    expect(qc.getQueryData<Journey>(['journey.get', 'c/d', { repo: 'c/d' }])!.questions).toHaveLength(2)
  })

  it('an accepted change leaves the inbox and the change list', () => {
    const qc = seeded()
    applyWrite(qc, 'change.accept', { repo: R, number: 22, head_sha: 'a'.repeat(40) })
    expect(qc.getQueryData<InboxItem[]>(inboxKey)!.map((x) => x.id)).toEqual(['i1'])
    expect(qc.getQueryData<{ changes: { number: number }[] }>(['changes.list', R, { repo: R }])!.changes.map((c) => c.number)).toEqual([23])
  })

  it('a waived finding leaves its criterion, from the waiver skill (Take the waiver) and from waiver.add', () => {
    const qc = seeded()
    const findings = () => qc.getQueryData<Journey>(journeyKey)!.gates[0]!.criteria[0]!.findings!.map((f) => f.id)
    applyWrite(qc, 'skill.submit', { repo: R, skill: 'waiver', draft: { what: 'finding:drc@1', reason: 'x' } })
    expect(findings()).toEqual(['drc@2'])
    applyWrite(qc, 'waiver.add', { repo: R, target: { kind: 'finding', id: 'drc@2' }, reason: 'x', risk: 'y', severity: 'cosmetic', caught_where: null })
    expect(findings()).toEqual([])
  })
})

describe('the listener: now, and once more a moment later', () => {
  it('invalidates what the act changed at once, and again after AGAIN_MS (the job it starts, GitHub catching up)', () => {
    vi.useFakeTimers()
    const qc = seeded()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    afterWrite(qc)('question.answer', { repo: R, question: 'aq1' })
    expect(stale(qc, journeyKey)).toBe(true)
    expect(stale(qc, ['jobs.list', R, { repo: R }])).toBe(true)
    expect(stale(qc, ['activity.list', {}])).toBe(true)
    expect(stale(qc, ['journey.get', 'c/d', { repo: 'c/d' }])).toBe(false)
    const now = spy.mock.calls.length
    vi.advanceTimersByTime(AGAIN_MS)
    expect(spy.mock.calls.length).toBe(now * 2)
  })

  it('does nothing for a read', () => {
    const qc = seeded()
    const spy = vi.spyOn(qc, 'invalidateQueries')
    afterWrite(qc)('journey.get', { repo: R })
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('call tells the listener of every ok answer', () => {
  it('after the answer, never for a refusal', async () => {
    const { request } = await import('./http')
    const { call, onAnswer } = await import('./api')
    const heard: string[] = []
    const stop = onAnswer((a) => heard.push(a))
    vi.mocked(request).mockResolvedValueOnce({ ok: true, result: { repo: R, summary: 'Answered.' } })
    await call('question.answer', { repo: R, question: 'aq1', option: 'o1' })
    vi.mocked(request).mockResolvedValueOnce({ ok: false, error: 'No such question.' })
    await expect(call('question.answer', { repo: R, question: 'nope' })).rejects.toThrow('No such question.')
    stop()
    vi.mocked(request).mockResolvedValueOnce({ ok: true, result: { repo: R, summary: 'Answered.' } })
    await call('question.answer', { repo: R, question: 'aq2', option: 'o1' })
    expect(heard).toEqual(['question.answer'])
  })
})

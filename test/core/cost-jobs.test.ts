/**
 * Spend by job (src/core/cost-jobs.ts): the ledger's rows put together by the job that caused them, each job in the
 * stage the project was in when it started (a reopened stage counts once), work done again marked, and the warning
 * before the current stage overruns its share of the budget. The figures follow run 2 of the test-esp32 project
 * (issue log #100, #113): US$100 a revision, 10 boards at US$8, so US$20 for cloud work across nine stages.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { UsageRow } from '../../src/core/cost.js'
import { NEAR_SHARE, spendByJob, stageAt, stageTimeline, stageWarning } from '../../src/core/cost-jobs.js'
import type { BatchRow, JobRow } from '../../src/core/job-index.js'
import { applyJourneySchema, startJourney } from '../../src/core/journey.js'

const use = (o: Partial<UsageRow> & { at: number; amount: number }): UsageRow => ({
  id: `u${Math.random()}`, kind: 'agents', jobId: null, agent: null, model: 'm', tokens: null, seconds: null, vcpus: null, basis: 'table',
  pricesAsOf: null, pricesSource: null, sdkCost: null, region: null, ...o,
})
const job = (o: Partial<JobRow> & { id: string; startedAt: number }): JobRow => ({
  handle: null, session: null, kind: 'task', agent: 'impl', title: 'Propose the architecture', number: null, requestedBySub: null, requestedBy: null,
  state: 'succeeded', step: null, queuedAt: o.startedAt, endedAt: o.startedAt + 600, beatAt: null, where: null, branch: null, parentJob: null, handoff: null,
  resumeOf: null, resumedBy: null, summary: null, error: null, payload: null, claudeSession: null, pausedBy: null, pausedAt: null, tail: null, vitals: null,
  lostAt: null, updatedAt: o.startedAt, ...o,
})
const timeline = [{ at: Number.NEGATIVE_INFINITY, stage: 'define' as const }, { at: 1000, stage: 'architect' as const }, { at: 5000, stage: 'capture' as const }, { at: 8000, stage: 'define' as const }, { at: 9000, stage: 'capture' as const }]

describe('spend by job', () => {
  it('puts each run, Batch job and delegated worker in the job that caused it, in the stage it started in', () => {
    const jobs = [
      job({ id: 'job-arch', startedAt: 1100, branch: 'trace/arch' }),
      job({ id: 'job-worker', startedAt: 1200, agent: 'worker', parentJob: 'job-arch' }),
      job({ id: 'job-thermal', agent: 'thermal', title: 'Thermal model of the case', startedAt: 2000, endedAt: 2600 }),
      // started while Define was reopened: Define's spend, not Capture's
      job({ id: 'job-req', agent: 'verify', title: 'Revise REQ-367d71', startedAt: 8100 }),
    ]
    const batch: BatchRow[] = [{ id: 'gpu-1', jobId: 'job-thermal', pool: 'cpu', state: 'SUCCEEDED', submittedAt: 2100, endedAt: 2500 }]
    const s = spendByJob({
      usage: [
        use({ at: 1700, amount: 4, jobId: 'job-arch', agent: 'impl' }),
        use({ at: 1300, amount: 1.25, jobId: 'job-worker', agent: 'worker' }),
        use({ at: 2500, amount: 2, jobId: 'job-thermal', agent: 'thermal' }),
        use({ at: 2500, amount: 0.5, kind: 'cpu', jobId: 'gpu-1', agent: 'openems', model: null }),
        // a tools function call the batch table does not name, while only the thermal job ran: the thermal job's
        use({ at: 2400, amount: 0.1, kind: 'tools', jobId: 'fn-1', agent: 'kicad', model: null }),
        // a job before the index's oldest row: kept, by its id
        use({ at: 900, amount: 0.3, jobId: 'job-gone', agent: 'verify' }),
        // nothing ran then: spend no job claims, in the stage of when it ran
        use({ at: 6000, amount: 0.2, kind: 'gpu', jobId: 'r-9', agent: 'render', model: null }),
        use({ at: 8200, amount: 0.75, jobId: 'job-req', agent: 'verify' }),
        use({ at: 8300, amount: null as unknown as number, jobId: 'job-req', agent: 'verify' }),
      ],
      jobs, batch, timeline, now: 10_000, staleAfter: 900,
    })
    const by = new Map(s.jobs.map((j) => [j.id, j]))
    expect(by.get('job-arch')).toMatchObject({ amount: 5.25, workers: 1, stage: 'architect', seconds: 600, outcome: 'finished' })
    expect(by.has('job-worker')).toBe(false)
    expect(by.get('job-thermal')).toMatchObject({ amount: 2.6, byKind: { agents: 2, cpu: 0.5, tools: 0.1, gpu: 0 }, stage: 'architect' })
    expect(by.get('job-gone')).toMatchObject({ title: 'A job no longer in the job index', stage: 'define', agent: 'verify' })
    expect(by.get(null)).toMatchObject({ title: 'Not tied to a job', amount: 0.2 })
    expect(by.get('job-req')).toMatchObject({ stage: 'define', amount: 0.75 })
    expect(s.stages).toEqual([
      { stage: 'define', amount: 1.05, jobs: 2, repeated: 0, wasted: 0 },
      { stage: 'architect', amount: 7.85, jobs: 2, repeated: 0, wasted: 0 },
      { stage: 'capture', amount: 0.2, jobs: 0, repeated: 0, wasted: 0 },
    ])
    expect(s.total).toBe(9.1)
  })

  it('marks work done again: sent back, redone on an earlier branch, the same request again; a resumed job is not a repeat', () => {
    const jobs = [
      job({ id: 'a1', startedAt: 1100, branch: 'trace/arch-a' }),
      job({ id: 'a2', startedAt: 1500, branch: 'trace/arch-b', title: 'propose the architecture.' }),
      job({ id: 'd1', agent: 'docs', title: 'Write the design docs', startedAt: 2000, branch: 'trace/docs' }),
      job({ id: 'd2', agent: 'docs', title: 'Changes asked on #7', startedAt: 2500, branch: 'trace/docs' }),
      job({ id: 'd3', agent: 'docs', title: 'Bring #7 up to date', kind: 'work-item', startedAt: 3000, branch: 'trace/docs', state: 'failed' }),
      job({ id: 'p1', agent: 'verify', title: 'Check the pins', startedAt: 3500, branch: 'trace/pins', state: 'paused' }),
      job({ id: 'p2', agent: 'verify', title: 'Check the pins', startedAt: 3600, branch: 'trace/pins', resumeOf: 'p1' }),
      job({ id: 'l1', agent: 'docs', title: 'Make the PDF', startedAt: 4000, endedAt: null, state: 'running', beatAt: 4100 }),
    ]
    const s = spendByJob({
      usage: jobs.map((j) => use({ at: j.startedAt as number + 10, amount: 2, jobId: j.id, agent: j.agent })),
      jobs, batch: [], timeline, sentBack: new Set(['d2']), now: 10_000, staleAfter: 900,
    })
    const by = new Map(s.jobs.map((j) => [j.id, j]))
    expect(by.get('a1')?.repeat).toBeNull()
    expect(by.get('a2')?.repeat).toEqual({ kind: 'duplicate', of: 'a1' })
    expect(by.get('d1')?.repeat).toBeNull()
    expect(by.get('d2')?.repeat).toEqual({ kind: 'sent_back', of: 'd1' })
    expect(by.get('d3')).toMatchObject({ repeat: { kind: 'redone', of: 'd1' }, outcome: 'failed' })
    expect(by.get('p2')?.repeat).toBeNull()
    expect(by.get('l1')).toMatchObject({ outcome: 'lost', seconds: 100 })
    expect(s.repeated).toBe(6)
    expect(s.wasted).toBe(4)
    expect(s.stages.find((x) => x.stage === 'architect')).toMatchObject({ amount: 16, repeated: 6, wasted: 4 })
  })
})

describe('the stage timeline', () => {
  it('follows the current stage through signing and reopening, from the journey\'s history', () => {
    const db = new DatabaseSync(':memory:')
    applyJourneySchema(db)
    startJourney(db, { template: 'board', by: 'seed', name: 'T', build: { quantity: 10, unit_cost: 8, budget: 100 } })
    expect(stageTimeline(db, 'define')).toEqual([{ at: Number.NEGATIVE_INFINITY, stage: 'define' }])
    const move = (stage: string, at: number): void => { db.prepare("UPDATE journey SET current_stage=?, updated=? WHERE id='current'").run(stage, at) }
    move('architect', 2000)
    move('capture', 3000)
    move('define', 4000)
    move('capture', 5000)
    const t = stageTimeline(db, 'capture')
    expect(t.map((m) => m.stage)).toEqual(['define', 'architect', 'capture', 'define', 'capture'])
    expect([1500, 2000, 2999, 4500, 6000].map((x) => stageAt(t, x))).toEqual(['define', 'architect', 'architect', 'define', 'capture'])
  })
})

describe('the warning before a stage overruns', () => {
  const spend = (amount: number) => spendByJob({
    usage: [use({ at: 1100, amount: amount * 0.7, jobId: 'a1', agent: 'impl' }), use({ at: 1600, amount: amount * 0.3, jobId: 'd1', agent: 'docs' })],
    jobs: [job({ id: 'a1', startedAt: 1050 }), job({ id: 'd1', agent: 'docs', title: 'Docs', startedAt: 1500 })],
    batch: [], timeline, now: 3000, staleAfter: 900,
  })
  it('says nothing while the stage is well within its share, and warns near it and past it with the biggest jobs', () => {
    // US$100 budget, US$80 forecast for the build, US$1.59 spent in Define: US$18.41 for cloud across 8 stages
    expect(stageWarning({ budget: 100, other: 80, cloud: 1.59 + 1, stage: 'architect', stagesLeft: 8, spend: spend(1) })).toBeNull()
    const near = stageWarning({ budget: 100, other: 80, cloud: 1.59 + 2, stage: 'architect', stagesLeft: 8, spend: spend(2) })
    expect(near).toMatchObject({ level: 'near', share: 2.3, left: 18.41, spent: 2 })
    expect(near!.spent).toBeGreaterThanOrEqual(near!.share * NEAR_SHARE)
    const over = stageWarning({ budget: 100, other: 80, cloud: 1.59 + 5, stage: 'architect', stagesLeft: 8, spend: spend(5) })
    expect(over).toMatchObject({ level: 'over', spent: 5 })
    expect(over!.top.map((j) => j.id)).toEqual(['a1', 'd1'])
    // run 2's Architect: US$19.69 in the stage, more than all that was left for cloud work
    expect(stageWarning({ budget: 100, other: 80, cloud: 21.28, stage: 'architect', stagesLeft: 8, spend: spend(19.69) })).toMatchObject({ level: 'spent', left: 18.41 })
    // and once nothing is left at all
    expect(stageWarning({ budget: 100, other: 80, cloud: 30, stage: 'capture', stagesLeft: 7, spend: spend(0) })).toMatchObject({ level: 'spent', share: 0 })
  })
  it('says nothing without a budget', () => {
    expect(stageWarning({ budget: null, other: 80, cloud: 50, stage: 'architect', stagesLeft: 8, spend: spend(30) })).toBeNull()
  })
})

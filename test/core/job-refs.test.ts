/**
 * trace's internal job ids out of person-facing words, and stuck notes retired once what they waited on has landed
 * (test-esp32-run2 log R18; src/core/job-refs.ts, src/core/journey.ts mergeAgentFacts, useButton).
 */
import { describe, expect, it } from 'vitest'
import { type JobLook, jobRefs, plainJobRefs } from '../../src/core/job-refs.js'
import { type AgentFacts, type JourneyRecord, type StuckFact, USE_RECOMMENDED, mergeAgentFacts, stuckRetired, useButton } from '../../src/core/journey.js'

const look = (titles: Record<string, string>, landed: Record<string, boolean> = {}): JobLook => ({
  title: (ref) => titles[ref.toLowerCase()] ?? titles[ref.slice(-12)] ?? null,
  landed: (ref) => landed[ref.toLowerCase()] ?? landed[ref.slice(-12)] ?? null,
})

describe('job ids in an agent\'s words', () => {
  it('finds each kind of id an agent names a job by', () => {
    expect(jobRefs('Re-run the I20 note after job 473ee5ad94f6 lands; see job queued~mteichtahl~test-esp32-run2~473ee5ad94f6 and job-mw6tp02o-ebfc934b.'))
      .toEqual(['473ee5ad94f6', 'queued~mteichtahl~test-esp32-run2~473ee5ad94f6', 'job-mw6tp02o-ebfc934b'])
    expect(jobRefs('Change R4 to 10k, rated 0402.')).toEqual([])
  })

  it('reads as the job\'s title when it is known, else as "another job"', () => {
    const l = look({ '473ee5ad94f6': 'Record the intent statements' })
    expect(plainJobRefs('Re-run the I20 note and Q4 closure after job 473ee5ad94f6 lands.', l)).toBe('Re-run the I20 note and Q4 closure after the job "Record the intent statements" lands.')
    expect(plainJobRefs('It waits for the earlier job queued~mteichtahl~test-esp32-run2~473ee5ad94f6.', l)).toBe('It waits for the job "Record the intent statements".')
    expect(plainJobRefs('It blocks the job job-mw6tp02o-ebfc934b.')).toBe('It blocks another job.')
    expect(plainJobRefs('Nothing to change here.')).toBe('Nothing to change here.')
  })
})

const stages = [{ id: 'define', ord: 1 }, { id: 'architect', ord: 2 }] as unknown as JourneyRecord['stages']
const at = (stage: string) => ({ journey: { currentStage: stage }, stages }) as unknown as Pick<JourneyRecord, 'journey' | 'stages'>
const note: StuckFact = {
  id: 's1', jobId: 'job-b-111111', agent: 'the Verification specialist', why: 'The earlier job has not recorded its statements here, or recorded them somewhere else.',
  recommendation: 'Re-run the I20 note and Q4 closure after job 473ee5ad94f6 lands.', stage: 'define', at: 1, resolvedAt: null, sources: [],
  options: [{ id: 'a', label: 'Re-run the I20 note and Q4 closure after job 473ee5ad94f6 lands', recommended: true, why: '' }],
}

describe('a stuck note is retired', () => {
  it('once every other job it names has ended and left no open change', () => {
    expect(stuckRetired(at('define'), note, look({}, { '473ee5ad94f6': true }))).toBe(true)
    expect(stuckRetired(at('define'), note, look({}, { '473ee5ad94f6': false }))).toBe(false)
    // not known (the open changes could not be read): kept
    expect(stuckRetired(at('define'), note, look({}))).toBe(false)
    expect(stuckRetired(at('define'), note, null)).toBe(false)
    // one that names no other job is not retired by this
    expect(stuckRetired(at('define'), { ...note, recommendation: 'Ask an admin.', options: [] }, look({}, { 'job-b-111111': true }))).toBe(false)
  })

  it('once the project moved on past its stage', () => {
    expect(stuckRetired(at('architect'), { ...note, recommendation: 'Ask an admin.', options: [] }, null)).toBe(true)
  })

  it('leaves the views, and one still open reads with titles, never ids', () => {
    const r = { journey: { currentStage: 'define' }, stages, questions: [], criteria: [] } as unknown as JourneyRecord
    const facts = (l: JobLook): AgentFacts => ({ questions: [], checks: [], stuck: [note], jobs: l })
    expect(mergeAgentFacts(r, facts(look({}, { '473ee5ad94f6': true }))).questions).toEqual([])
    const open = mergeAgentFacts(r, facts(look({ '473ee5ad94f6': 'Record the intent statements', 'job-b-111111': 'Add I24 and change I20' }, { '473ee5ad94f6': false }))).questions
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ blocks: 'the job "Add I24 and change I20"', recommendation: expect.stringContaining('after the job "Record the intent statements" lands') })
    const q = open[0]!
    expect(JSON.stringify([q.text, q.blocks, q.recommendation, q.options])).not.toMatch(/473ee5ad94f6|job-b-111111/)
  })
})

describe('the button for a recommended option', () => {
  it('names a short option, and never puts "Use" before a sentence', () => {
    expect(useButton('3.3 V')).toBe('Use 3.3 V')
    expect(useButton('GND-VCC')).toBe('Use GND-VCC')
    expect(useButton('Re-run the I20 note and Q4 closure after the job "Record the intent statements" lands')).toBe(USE_RECOMMENDED)
    expect(useButton('Retry it later')).toBe(USE_RECOMMENDED)
  })
})

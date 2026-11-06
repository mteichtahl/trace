/**
 * Spend by job and the stage warning (spend-by-job.tsx) in words and on screen: the summary with what was done again,
 * each job's specialist and running time, the stages in order with the jobs that repeat work marked, and the warning
 * at each level, as test-esp32's run 2 needed it (issue log #72, #100, #113).
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { JobSpendView, SpendByJobView, SpendWarning } from '@/lib/types-s1'
import { SpendByJob, jobMeta, spendSummary, warningText } from './spend-by-job'

vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: unknown }) => children }))

const job = (o: Partial<JobSpendView> & Pick<JobSpendView, 'id' | 'title' | 'amount'>): JobSpendView => ({
  agent: 'impl', specialist: 'Implementation', stage: 'Architect', stageId: 'architect', outcome: 'finished', started: null, ended: null, seconds: 1140,
  byKind: { agents: o.amount, gpu: 0, cpu: 0, tools: 0 }, workers: 0, repeat: null, ...o,
})
const spend: SpendByJobView = {
  total: 21.28, repeated: 9.1, wasted: 1.2,
  stages: [
    { stage: 'Define', id: 'define', amount: 1.59, jobs: 1, repeated: 0, wasted: 0 },
    { stage: 'Architect', id: 'architect', amount: 19.69, jobs: 4, repeated: 9.1, wasted: 1.2 },
  ],
  jobs: [
    job({ id: 'j5', agent: 'docs', specialist: 'Documentation', title: 'Make the design documents PDF', amount: 1.2, outcome: 'lost', seconds: 1860 }),
    job({ id: 'j4', agent: 'docs', specialist: 'Documentation', title: 'Changes asked on #9', amount: 3.4, repeat: { kind: 'sent_back', of: 'j3', text: 'Sent back: a person asked for changes' } }),
    job({ id: 'j3', title: 'Propose the architecture', amount: 5.7, repeat: { kind: 'duplicate', of: 'j2', text: 'Duplicate: the same request as an earlier job' } }),
    job({ id: 'j2', title: 'Propose the architecture', amount: 9.39, workers: 1 }),
    job({ id: 'j1', agent: 'verify', specialist: 'Verification', title: 'Draft the requirements', amount: 1.59, stage: 'Define', stageId: 'define', seconds: 45 }),
  ],
}

describe('spend by job', () => {
  it('says the total, and how much was done again or lost', () => {
    expect(spendSummary(spend, 'USD')).toBe('US$21.28 of cloud use across 5 jobs. US$9.10 of it was work done again (sent back, redone or asked twice). US$1.20 went on jobs that failed, were cancelled or were lost.')
    expect(spendSummary({ ...spend, repeated: 0, wasted: 0 }, 'USD')).toBe('US$21.28 of cloud use across 5 jobs.')
    expect(jobMeta(spend.jobs[3]!)).toBe('Implementation · ran 19 min · with 1 worker job')
  })

  it('lists the jobs by stage, in the journey\'s order, with the repeats and the lost job marked', () => {
    render(<SpendByJob spend={spend} currency="USD" />)
    const architect = screen.getByRole('region', { name: 'Architect: US$19.69' })
    expect(within(architect).getByText(/4 jobs · US\$9.10 done again · US\$1.20 lost/)).toBeInTheDocument()
    expect(within(architect).getAllByText('Propose the architecture')).toHaveLength(2)
    expect(within(architect).getByText('Duplicate')).toBeInTheDocument()
    expect(within(architect).getByText('Sent back')).toBeInTheDocument()
    expect(within(architect).getByText('Lost')).toBeInTheDocument()
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))
    expect(regions).toEqual(['Define: US$1.59', 'Architect: US$19.69'])
  })
})

describe('the warning before a stage overruns', () => {
  const w: SpendWarning = { level: 'near', stage: 'Architect', spent: 2, share: 2.3, left: 18.41, stagesLeft: 8, top: [] }
  it('says where the stage is against its share, and where the share comes from', () => {
    // the cloud-work allowance alone: the build budget's forecast is not in it (test-esp32 run 2, #151)
    expect(warningText(w, 'USD')).toEqual({
      title: 'Architect is near its share of the cloud-work allowance',
      body: 'US$2 of cloud work so far, of about US$2.30 a stage: US$18.41 of the cloud-work allowance was left when it started, split across it and the 7 stages after it.',
    })
    expect(warningText({ ...w, level: 'over', spent: 5 }, 'USD').title).toBe('Architect is past its share of the cloud-work allowance')
    // run 2's Architect: all that was left of the allowance, and more
    expect(warningText({ ...w, level: 'spent', spent: 19.69 }, 'USD')).toEqual({
      title: 'Architect has used all the cloud-work allowance left',
      body: 'US$19.69 so far, of US$18.41 left of the allowance when it started, for it and the 7 stages after it. Raise the cloud-work allowance in Settings (the build budget stays as it is), or cut work done again.',
    })
    const gone = warningText({ ...w, level: 'spent', left: -1.28, share: 0, stage: 'Capture' }, 'USD')
    expect(gone.title).toBe('The cloud-work allowance is used up')
    expect(gone.body).not.toMatch(/forecast for the build/)
  })
})

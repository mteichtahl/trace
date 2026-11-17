import { describe, expect, it } from 'vitest'
import { modelHealth } from './model-health'
import type { RunSummary } from './types'

const FAILED = "trace could not reach its model: the AWS account's data retention setting for Amazon Bedrock does not allow the model this installation uses. An admin runs the installer again and chooses another model, or changes the account's Bedrock data retention setting in AWS. (The model said: API Error: 400 data retention mode 'default' is not available for this model.)"
const job = (state: RunSummary['state'], endedAt: string, error?: string): RunSummary => ({ id: endedAt, title: 'a job', state, endedAt, ...(error ? { error } : {}) })

describe('the agents\' model health', () => {
  it('is idle before any job has ended', () => {
    expect(modelHealth([{ id: '1', title: 'x', state: 'running' }]).status).toBe('idle')
  })
  it('fails when the newest jobs all stopped on the model, with what to do', () => {
    const h = modelHealth([job('done', '2026-11-16T03:00:00Z'), job('failed', '2026-11-17T02:26:00Z', FAILED), job('failed', '2026-11-17T02:29:00Z', FAILED)])
    expect(h.status).toBe('failing')
    expect(h.detail).toContain('The last 2 jobs stopped at once: the AWS account\'s data retention setting')
    expect(h.todo).toMatch(/^An admin runs the installer again/)
  })
  it('answers once a job succeeds after the failures', () => {
    expect(modelHealth([job('failed', '2026-11-17T02:26:00Z', FAILED), job('done', '2026-11-17T04:00:00Z')]).status).toBe('verified')
  })
  it('does not blame the model for another failure', () => {
    expect(modelHealth([job('failed', '2026-11-17T02:26:00Z', 'kicad-cli exited 1')]).status).toBe('verified')
  })
})

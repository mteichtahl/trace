import { describe, expect, it } from 'vitest'
import { isRunId, readEvidence } from './readers'

describe('evidence that cites a run', () => {
  it('opens as a run only when its reference can be a run id', () => {
    expect(isRunId('5e6f7a8b9c0d1e2f')).toBe(true)
    expect(isRunId('the DRC run after the move')).toBe(false)
    expect(isRunId('x'.repeat(65))).toBe(false)
    expect(readEvidence({ kind: 'run', ref: '5e6f7a8b9c0d1e2f', label: 'DRC' }, 'acme/board')).toMatchObject({ kind: 'run', to: '/p/acme~board/runs/5e6f7a8b9c0d1e2f' })
    const long = readEvidence({ kind: 'run', ref: 'the design intents the person accepted, with the run that checked each of them', label: 'intents' }, 'acme/board')
    expect(long.kind).toBe('record')
    expect(long.to).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { mergeAgents } from './use-agents'
import type { AgentState, RunSummary } from '@/lib/types'

const agent = (id: string, status: AgentState['status'], o: Partial<AgentState> = {}): AgentState => ({ id, name: id, status, says: status, now: [], queue: [], today: { runs: 0, succeeded: 0, medianS: null }, ...o })
const run = (id: string, state: RunSummary['state']): RunSummary => ({ id, title: id, state })

describe('one agent across projects', () => {
  it('takes the most pressing status (stuck, waiting on a person, working, queued, idle), with its project, and gathers its work', () => {
    const m = mergeAgents([
      { repo: 'a/one', project: 'One', jobs: [run('j1', 'running')], agents: [agent('verify', 'working', { now: ['j1'], today: { runs: 2, succeeded: 2, medianS: 300 } })] },
      { repo: 'a/two', project: 'Two', jobs: [run('j2', 'queued')], agents: [agent('verify', 'stuck', { says: 'Stuck: no datasheet', queue: ['j2'], today: { runs: 5, succeeded: 4, medianS: 120 } })] },
      { repo: 'a/three', project: 'Three', jobs: [], agents: [agent('verify', 'idle', { today: { runs: 1, succeeded: 1, medianS: 900 } })] },
    ])
    const v = m.get('verify')!
    expect(v).toMatchObject({ status: 'stuck', says: 'Stuck: no datasheet', project: 'Two', today: { runs: 8, succeeded: 7, medianS: 120 } })
    expect(v.now.map((x) => `${x.project}:${x.run.id}`)).toEqual(['One:j1'])
    expect(v.queue.map((x) => `${x.project}:${x.run.id}`)).toEqual(['Two:j2'])
  })
})

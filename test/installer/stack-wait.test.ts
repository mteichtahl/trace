/** Waiting for the trace stack to be free before deploying it (src/installer/stack-wait.ts). */
import { describe, expect, it } from 'vitest'
import { stackBusy, waitForStack, waitingCdk } from '../../src/installer/stack-wait.js'

function clock(statuses: (string | null)[]) {
  let t = 0
  const lines: string[] = []
  return {
    lines,
    deps: { status: async () => (statuses.length > 1 ? statuses.shift()! : statuses[0]!), log: (l: string) => lines.push(l), sleep: async (ms: number) => { t += ms }, now: () => t, every: 1000 },
  }
}

describe('waiting for the stack', () => {
  it('knows a busy stack', () => {
    expect(stackBusy('UPDATE_IN_PROGRESS')).toBe(true)
    expect(stackBusy('UPDATE_COMPLETE_CLEANUP_IN_PROGRESS')).toBe(true)
    expect(stackBusy('REVIEW_IN_PROGRESS')).toBe(false)
    expect(stackBusy('UPDATE_COMPLETE')).toBe(false)
    expect(stackBusy(null)).toBe(false)
  })

  it('goes straight on when the stack is free', async () => {
    const c = clock(['UPDATE_COMPLETE'])
    expect(await waitForStack('TraceStack', c.deps)).toBe(0)
    expect(c.lines).toEqual([])
  })

  it('waits while another update runs, saying so once per change, then deploys', async () => {
    const c = clock(['UPDATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS', 'UPDATE_COMPLETE'])
    expect(await waitForStack('TraceStack', c.deps)).toBe(3000)
    expect(c.lines).toEqual([
      'TraceStack is UPDATE_IN_PROGRESS: another update is running (the installer, or trace updating itself after a change to its main branch). Waiting for it to finish before deploying.',
      'TraceStack is UPDATE_COMPLETE_CLEANUP_IN_PROGRESS now; still waiting.',
      'TraceStack is UPDATE_COMPLETE now: deploying.',
    ])
  })

  it('gives up after its timeout, naming the update still running', async () => {
    const c = clock(['UPDATE_ROLLBACK_IN_PROGRESS'])
    await expect(waitForStack('TraceStack', { ...c.deps, timeout: 5000 })).rejects.toThrow('TraceStack was still UPDATE_ROLLBACK_IN_PROGRESS after 0 minutes')
  })

  it('only a deploy of the trace stack waits', async () => {
    const waited: string[] = []
    const cdk = waitingCdk(async () => 0, () => 'TraceStack', async (s) => { waited.push(s) })
    await cdk(['deploy', 'TraceStack', '--app', 'x'], {}, () => undefined)
    await cdk(['deploy', 'trace-edge'], {}, () => undefined)
    await cdk(['bootstrap'], {}, () => undefined)
    expect(waited).toEqual(['TraceStack'])
  })
})

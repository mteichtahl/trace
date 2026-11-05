/**
 * What a piece of agent work delivers (src/core/deliverables.ts), and the open work that already covers a new request:
 * log #93 (a second architecture proposal while the first waited for review) and #110 (two documentation changes on
 * the same document).
 */
import { describe, expect, it } from 'vitest'
import { type Work, coveredWords, coveringWork, deliverablesOf } from '../../src/core/deliverables.js'

const AT = 1_800_000_000
const job = (id: string, f: Partial<Work['job']>): Work['job'] => ({
  id, agent: 'impl', kind: 'task', state: 'succeeded', title: '', summary: null, payload: null, branch: null, parentJob: null,
  beatAt: null, startedAt: AT - 600, updatedAt: AT - 300, ...f,
})

describe('deliverablesOf', () => {
  it('names the architecture proposal, the pin and sheet plans, and each design document', () => {
    expect(deliverablesOf('Propose the architecture: options A, B and C').map((d) => d.key)).toEqual(['architecture'])
    expect(deliverablesOf('compare architectures for the power stage').map((d) => d.key)).toEqual(['architecture'])
    expect(deliverablesOf('record it with design.architecture').map((d) => d.key)).toEqual(['architecture'])
    expect(deliverablesOf('Agree the pin plan for the ESP32').map((d) => d.key)).toEqual(['pins'])
    expect(deliverablesOf('the sheet plan has five sheets').map((d) => d.key)).toEqual(['sheets'])
    expect(deliverablesOf('Edit docs/design/high-level-design.md').map((d) => d.key)).toEqual(['doc:hld'])
    expect(deliverablesOf('the HLD thermal summary').map((d) => d.key)).toEqual(['doc:hld'])
    expect(deliverablesOf('Write the low level design and the high level design sections').map((d) => d.key)).toEqual(['doc:hld', 'doc:lld'])
    expect(deliverablesOf('the protocol specification').map((d) => d.words)).toEqual(['the protocol specification'])
  })

  it('names nothing for work every job touches, or for the word "architecture" alone', () => {
    expect(deliverablesOf('Fix the ERC errors on the schematic')).toEqual([])
    expect(deliverablesOf('route the board')).toEqual([])
    expect(deliverablesOf('check the part against the architecture')).toEqual([])
    expect(deliverablesOf(null, undefined, '')).toEqual([])
  })
})

describe('coveringWork', () => {
  const ask = 'Propose the architecture for the board: compare the options.'

  it('finds the specialist\'s change that waits for review and names the same deliverable', () => {
    const work: Work[] = [{ job: job('job-1', { title: 'Propose the architecture', branch: 'claude/task-arch' }), change: { number: 4, title: 'Architecture options A/B/C' } }]
    const c = coveringWork(ask, 'impl', work, { at: AT })
    expect(c).toMatchObject({ job: 'job-1', change: { number: 4 }, state: 'review', deliverables: [{ key: 'architecture' }] })
    expect(coveredWords(c!, 'The Implementation specialist')).toMatch(/^The Implementation specialist is already doing the architecture proposal: change #4 \("Architecture options A\/B\/C"\), which waits for a person's review\. .*Build on that work instead/)
  })

  it('finds a job still working (queued, paused, or running and alive), read from its request too', () => {
    const payload = JSON.stringify({ kind: 'task', request: 'Compare architecture options A and B', agent: 'impl' })
    for (const f of [{ state: 'queued' as const }, { state: 'paused' as const }, { state: 'running' as const, beatAt: AT - 10 }]) {
      expect(coveringWork(ask, 'impl', [{ job: job('job-2', { title: 'Task', payload, ...f }) }], { at: AT })).toMatchObject({ job: 'job-2', state: 'working', change: null })
    }
  })

  it('ignores ended work without an open change, lost jobs, other specialists, the asker and sub-jobs', () => {
    const t = { title: 'Architecture options' }
    expect(coveringWork(ask, 'impl', [{ job: job('a', t) }], { at: AT })).toBeNull()
    expect(coveringWork(ask, 'impl', [{ job: job('b', { ...t, state: 'running', beatAt: AT - 3600 }) }], { at: AT })).toBeNull()
    expect(coveringWork(ask, 'impl', [{ job: job('c', { ...t, state: 'queued', agent: 'docs' }) }], { at: AT })).toBeNull()
    expect(coveringWork(ask, 'impl', [{ job: job('d', { ...t, state: 'queued' }) }], { at: AT, except: 'd' })).toBeNull()
    expect(coveringWork(ask, 'impl', [{ job: job('e', { ...t, state: 'queued', parentJob: 'x' }) }], { at: AT })).toBeNull()
  })

  it('credits a job to the specialist it was asked of, and covers nothing for a request that names no deliverable', () => {
    const payload = JSON.stringify({ request: 'Propose the architecture', agent: 'impl' })
    expect(coveringWork(ask, 'impl', [{ job: job('f', { state: 'queued', agent: 'worker', payload }) }], { at: AT })).toMatchObject({ job: 'f' })
    expect(coveringWork('Size the output capacitor of U3', 'impl', [{ job: job('g', { state: 'queued', payload }) }], { at: AT })).toBeNull()
    // the same specialist busy with a different deliverable: not covered
    expect(coveringWork(ask, 'impl', [{ job: job('h', { state: 'queued', title: 'Agree the pin plan' }) }], { at: AT })).toBeNull()
  })
})

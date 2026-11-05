import { describe, expect, it } from 'vitest'
import type { AgentState, Handoff, InboxItem, RunSummary } from '@/lib/types'
import { countsText, footerOf, glanceOf, handoffText, layoutOf, linkedAgents, linksOf, onMap, projectTone, rowsOf, sidesFor } from './map-model'
import { mergeAgents, type ProjectWork } from './use-agents'

const NOW = Date.parse('2026-11-05T10:00:00Z')
const MIN = 60_000
const at = (ms: number) => new Date(NOW - ms).toISOString()

const run = (id: string, o: Partial<RunSummary> = {}): RunSummary => ({ id, title: id, state: 'running', ...o })
const agent = (id: string, o: Partial<AgentState> = {}): AgentState => ({ id, name: id, status: 'idle', says: 'Idle', now: [], queue: [], today: { runs: 0, succeeded: 0, medianS: null }, ...o })
const handoff = (id: string, o: Partial<Handoff> = {}): Handoff => ({
  id, from: 'verify', fromName: 'Verification', to: 'impl', toName: 'Implementation', question: 'q', blocks: 'b', evidence: [], acceptance: [], summary: 's',
  state: 'queued', says: 'Queued', createdAt: at(5 * MIN), fromWorkerJobId: 'w', ...o,
})
const project = (repo: string, o: Partial<ProjectWork> = {}): ProjectWork => ({ repo, project: repo.split('/')[1]!, agents: [], jobs: [], handoffs: [], paused: false, ...o })

describe('an agent box on All projects', () => {
  const per = [
    project('acme/esp', { jobs: [run('a', { title: 'Display check', stepIndex: 3, stepCount: 5 }), run('b', { title: 'Later', state: 'queued', position: 1 })], agents: [agent('verify', { status: 'working', now: ['a'], queue: ['b'], today: { runs: 9, succeeded: 8, medianS: 60 } })] }),
    project('acme/led', { jobs: [run('c', { title: 'Current sim', progress: 0.25 })], agents: [agent('verify', { status: 'working', now: ['c'], today: { runs: 5, succeeded: 4, medianS: 60 } })] }),
  ]
  const w = mergeAgents(per).get('verify')

  it('has one line per project, with its step and progress', () => {
    const rows = rowsOf(w)
    expect(rows.map((r) => [r.project, r.title, r.step, r.progress, r.more])).toEqual([
      ['esp', 'Display check', '3/5', 0.6, 1],
      ['led', 'Current sim', null, 0.25, 0],
    ])
  })

  it('sums its queue and day across the projects', () => {
    expect(footerOf(w)).toBe('Queue 1 · Today 12 of 14 passed')
    expect(footerOf(undefined)).toBe('No runs today')
  })

  it('puts the project it is stuck or waiting on first, saying why', () => {
    const per2 = [
      project('acme/esp', { jobs: [run('a', { title: 'Display check' })], agents: [agent('ams', { status: 'working', now: ['a'] })] }),
      project('acme/soil', { jobs: [run('p', { title: 'Size the regulator', state: 'paused' })], agents: [agent('ams', { status: 'waiting_person', says: 'Waiting on a person: Which regulator?', now: ['p'] })] }),
    ]
    const rows = rowsOf(mergeAgents(per2).get('ams'))
    expect(rows[0]).toMatchObject({ project: 'soil', state: 'waiting', title: 'Which regulator?' })
    expect(rows[1]).toMatchObject({ project: 'esp', state: 'running' })
  })

  it('gets a line for a stuck project with no job there', () => {
    const rows = rowsOf(mergeAgents([project('acme/m', { agents: [agent('thermal', { status: 'stuck', says: 'Stuck: No ambient temperature.' })] })]).get('thermal'))
    expect(rows).toEqual([expect.objectContaining({ project: 'm', state: 'stuck', title: 'No ambient temperature.' })])
  })
})

describe('hand-off arrows', () => {
  it('are one per pair of agents, counting every project, livelier first', () => {
    const items = [
      { repo: 'acme/esp', project: 'esp', handoff: handoff('1', { state: 'running' }) },
      { repo: 'acme/led', project: 'led', handoff: handoff('2', { state: 'queued' }) },
      { repo: 'acme/esp', project: 'esp', handoff: handoff('3', { from: 'thermal', fromName: 'Thermal', to: 'ams', toName: 'AMS', state: 'requested' }) },
    ]
    const links = linksOf(items, NOW)
    expect(links.map((l) => [l.id, l.state, l.items.length])).toEqual([['verify>impl', 'running', 2], ['thermal>ams', 'waiting', 1]])
  })

  it('keep an ended hand-off for an hour, then let it go', () => {
    const answered = (ms: number) => handoff('x', { state: 'answered', answer: { answered: true, text: 't', summary: 't', evidence: [], at: at(ms) } })
    expect(onMap(answered(30 * MIN), NOW)).toBe(true)
    expect(onMap(answered(90 * MIN), NOW)).toBe(false)
    expect(linksOf([{ repo: 'r', project: 'p', handoff: answered(30 * MIN) }], NOW)[0]?.state).toBe('answered')
  })

  it('light the agents an agent works with', () => {
    const l = [{ id: 'a>b', from: 'a', to: 'b' }, { id: 'c>d', from: 'c', to: 'd' }]
    expect(linkedAgents(l, 'b')).toEqual({ nodes: new Set(['b', 'a']), links: new Set(['a>b']) })
  })
})

describe('where the boxes sit', () => {
  it('keeps each known agent in its place and fills free cells with the rest', () => {
    const cells = layoutOf(['verify', 'impl', 'worker', 'ams', 'emc', 'thermal', 'docs', 'render', 'parts', 'other'])
    expect(cells.get('verify')).toEqual({ col: 0, row: 0 })
    expect(cells.get('render')).toEqual({ col: 2, row: 2 })
    expect(cells.get('parts')).toEqual({ col: 2, row: 1 })
    expect(cells.get('other')).toEqual({ col: 0, row: 3 })
  })

  it('joins boxes by the sides that face each other', () => {
    expect(sidesFor({ col: 0, row: 0 }, { col: 1, row: 0 })).toEqual({ from: 'right', to: 'left' })
    expect(sidesFor({ col: 1, row: 0 }, { col: 1, row: 1 })).toEqual({ from: 'bottom', to: 'top' })
    expect(sidesFor({ col: 0, row: 2 }, { col: 0, row: 1 })).toEqual({ from: 'top', to: 'bottom' })
  })
})

describe('projects at a glance', () => {
  it('summarises each project: agents by state, jobs, hand-offs and what is on Next', () => {
    const per = [project('acme/soil', {
      agents: [agent('a', { status: 'working' }), agent('b', { status: 'waiting_person' }), agent('c', { status: 'stuck' }), agent('d')],
      jobs: [run('1'), run('2', { state: 'queued' })],
      handoffs: [handoff('h1'), handoff('h2', { state: 'answered', answer: { answered: true, text: '', summary: '', evidence: [], at: at(10 * MIN) } })],
    })]
    const inbox = [{ repo: 'acme/soil' }, { repo: 'acme/other' }] as InboxItem[]
    const [g] = glanceOf(per, inbox, NOW, new Map([['acme/soil', 'var(--project-2)']]))
    expect(g).toMatchObject({ tone: 'var(--project-2)', running: 1, queued: 1, open: 1, recent: 1, needs: 1 })
    expect(countsText(g!.counts)).toBe('1 working · 1 waiting on a person · 1 stuck')
    expect(handoffText(g!.open, g!.recent)).toBe('1 hand-off open · 1 ended in the last hour')
    expect(countsText({ working: 0, waiting_person: 0, stuck: 0, queued: 0, idle: 3 })).toBe('Nothing running')
  })

  it('gives each project a theme colour, reusing them past six', () => {
    expect(projectTone(0)).toBe('var(--project-1)')
    expect(projectTone(6)).toBe('var(--project-1)')
    expect(projectTone(7)).toBe('var(--project-2)')
  })
})

describe('a hand-off job in a box', () => {
  it('drops the "Asked by" lead, since the arrow says who asked', async () => {
    const { workTitle } = await import('./map-model')
    expect(workTitle('Asked by the Thermal specialist: What is the dissipation?')).toBe('What is the dissipation?')
    expect(workTitle('Check the ERC')).toBe('Check the ERC')
  })
})

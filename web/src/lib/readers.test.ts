/**
 * The readers against what the API runtime really answers (lib/api-answers.json, written by the API's own test,
 * test/api/web-answers.test.ts): every action the screens read comes out in the shape the screens use.
 */
import { describe, expect, it } from 'vitest'
import answers from './api-answers.json'
import { READERS, readFileUrl, readJob, readJourney } from './readers'
import type { InboxItem, Journey, Member, MeDoc, ProjectJobs } from './types'
import type { JourneyMore } from './types-s1'

const read = <T>(action: keyof typeof answers): T => {
  const a = answers[action] as { args: Record<string, unknown>; result: unknown }
  return READERS[action]!(a.result, a.args) as T
}

describe('reading the API\'s answers', () => {
  it('journey.get: stages, gates with criteria and evidence, waivers, the next step, questions and decisions', () => {
    const j = read<JourneyMore>('journey.get')
    expect(j).toMatchObject({ repo: 'acme/answers', name: 'Answers', template: 'board', revision: 'Rev A', current: 'define', hasMemory: false })
    // its jobs: the project's job index, as run lines (a hand-off job among them)
    expect(j.jobs.filter((r) => !r.handoff).map((r) => [r.title, r.state])).toEqual([['Check the ERC', 'running'], ['Check the DRC', 'queued'], ['Check the BOM', 'done']])
    expect(j.stages.map((s) => s.state)).toEqual(['current', 'queued', 'queued', 'queued', 'queued', 'queued', 'queued', 'queued', 'queued'])
    expect(j.stages[0]).toMatchObject({ id: 'define', name: 'Define', criteria: { met: 2, total: 2 } })
    const g = j.gates.find((x) => x.id === 'define')!
    expect(g).toMatchObject({ name: 'the requirements baseline gate', after: 'define', state: 'ready' })
    expect(g.criteria.map((c) => [c.id, c.status])).toEqual([['define.accepted', 'met'], ['define.measurable', 'waived']])
    expect(g.criteria[0]!.evidence).toEqual({ kind: 'run', label: 'the requirements list', id: 'run-1', to: '/p/acme~answers/runs/run-1' })
    expect(g.waivers).toEqual([expect.objectContaining({ risk: 'degraded', caught: 'Bring up', reason: 'Two criteria wait for the bench.' })])
    expect(j.gates.find((x) => x.id === 'capture')?.state).toBe('locked')
    expect(j.next).toMatchObject({ kind: 'task', owner: 'you', action: { label: 'Use 2.7 to 3.6 V', to: '/p/acme~answers/do/question-answer' } })
    expect(j.next.summary).toMatch(/\*\*trace recommends 2\.7 to 3\.6 V/)
    expect(j.questions).toEqual([expect.objectContaining({ text: 'What is the supply range?', recommended: { id: 'a', label: '2.7 to 3.6 V' }, blocks: 'sizing the regulator' })])
    expect(j.decisions?.[0]).toMatchObject({ kind: 'waiver', state: 'active' })
    expect(j.recent.length).toBeGreaterThan(0)
  })

  it('jobs.list: each job as a run line (its step, typical time, queue place and controls), and each agent\'s state', () => {
    const r = read<ProjectJobs>('jobs.list')
    const [run, queued, done] = r.jobs.filter((j) => !j.handoff)
    expect(run).toMatchObject({ title: 'Check the ERC', state: 'running', step: 'running ERC on the main sheet', typicalS: 600, controls: ['pause', 'cancel'], agentName: 'Verification', yours: true, branch: 'claude/task-erc' })
    expect(run!.id).toMatch(/^trace-api-[0-9a-f]{8}-[0-9a-f]{24}\.job-run$/)
    expect(queued).toMatchObject({ state: 'queued', position: 1, startsWhen: expect.stringMatching(/already working/), controls: ['pause', 'cancel'] })
    expect(queued!.step).toBeUndefined()
    expect(done).toMatchObject({ state: 'done', controls: [], summary: 'verify: done in 9 turns' })
    expect(r.agents.find((a) => a.id === 'verify')).toMatchObject({ status: 'working', now: [run!.id], queue: [queued!.id], today: { runs: 1, succeeded: 1 } })
  })

  it('jobs.list: a failed or lost job keeps why (its error), for the agent page\'s ended jobs', () => {
    const lost = readJob({ id: 'h.job-x', workerJobId: 'job-x', title: 'Draft the schematic', state: 'lost', agent: 'impl', error: 'trace lost contact with it. Its last lines: "tool: kicad.erc".', step: 'trace lost contact with it.', startedAt: '2026-10-31T23:00:00Z' })
    expect(lost).toMatchObject({ state: 'lost', agent: 'impl', error: expect.stringMatching(/Its last lines/) })
    expect(readJob({ id: 'h.job-y', workerJobId: 'job-y', title: 't', state: 'succeeded' }).error).toBeUndefined()
  })

  it('jobs.list and journey.get: the hand-offs between specialists, and a hand-off job that says who asked', () => {
    const r = read<ProjectJobs>('jobs.list')
    expect(r.handoffs.map((h) => [h.fromName, h.toName, h.state])).toEqual([['Thermal', 'Analog and mixed-signal', 'answered'], ['Thermal', 'Analog and mixed-signal', 'queued']])
    const [answered, queued] = r.handoffs
    expect(answered).toMatchObject({
      from: 'thermal', to: 'ams', summary: expect.stringMatching(/^Thermal → Analog and mixed-signal: /), fromWorkerJobId: 'job-th', workerJobId: 'job-ho2',
      evidence: [{ kind: 'run', id: 'run-1', label: 'the thermal run', to: '/p/acme~answers/runs/run-1' }], acceptance: ['the dissipation in watts at 500 mA, with the run id'],
      answer: { answered: true, text: '15 µA typical at 85 °C (datasheet page 5).', confidence: 0.9, acceptanceMet: true },
    })
    expect(answered!.jobId).toMatch(/^trace-api-[0-9a-f]{8}-[0-9a-f]{24}\.job-ho2$/)
    expect(queued).toMatchObject({ state: 'queued', says: expect.stringMatching(/^Queued for the Analog and mixed-signal specialist/) })
    expect(queued!.answer).toBeUndefined()
    const job = r.jobs.find((j) => j.handoff)!
    expect(job).toMatchObject({ title: expect.stringMatching(/^Asked by the Thermal specialist: /), state: 'queued', handoff: { id: queued!.id, from: 'thermal', fromName: 'Thermal' } })
    expect(read<JourneyMore>('journey.get').handoffs?.map((h) => h.id)).toEqual(r.handoffs.map((h) => h.id))
    const d = (answers['handoff.decline'] as { result: { declined: { reason: string }; summary: string } }).result
    expect(d).toMatchObject({ declined: { reason: 'The bench measures it on Friday.' }, summary: expect.stringMatching(/^Declined: the Analog and mixed-signal specialist will not answer it/) })
  })

  it('journey.get without a journey says how one starts', () => {
    const j = readJourney({ repo: 'acme/x', started: false, summary: 'This project has not started its journey yet.', next: 'An admin starts it.' }) as Journey & { started: boolean }
    expect(j).toMatchObject({ started: false, stages: [], next: { kind: 'none', summary: 'This project has not started its journey yet. An admin starts it.' } })
  })

  it('an answer already in the app\'s shape passes through unchanged (mock mode)', () => {
    const mine = { repo: 'acme/x', stages: [], gates: [] }
    expect(readJourney(mine)).toBe(mine)
    expect(READERS.inbox!([{ id: 'x' }], {})).toEqual([{ id: 'x' }])
  })

  it('inbox: the items, with an address and the question to answer', () => {
    const items = read<InboxItem[]>('inbox')
    expect(items).toEqual([expect.objectContaining({ kind: 'question', repo: 'acme/answers', project: 'Answers', action: { label: 'Answer', to: '/p/acme~answers/do/question-answer' }, recommended: { id: 'a', label: '2.7 to 3.6 V' }, questionId: expect.any(String) })])
    expect(items[0]!.createdAt).toMatch(/^2026-/)
  })

  it('inbox: a review item is a change that opens in the app; GitHub\'s link is kept only for View on GitHub', () => {
    const items = READERS.inbox!({ items: [{
      id: 'review:1', kind: 'review', repo: 'acme/x', project: 'X', stage: 'define', summary: 'X: The Verification agent opened pull request #1, "Requirements R1-R10". Its work counts once it is merged.', since: '2026-10-31T07:40:00.000Z',
      waited: '20 min', blocking: false, action: 'Review on GitHub', ref: { kind: 'pull', id: '1', url: 'https://github.com/acme/x/pull/1' },
    }, {
      id: 'review:2', kind: 'review', repo: 'acme/x', project: 'X', stage: 'define', summary: 'x', since: '2026-10-31T07:40:00.000Z',
      waited: '', blocking: false, action: 'Review the change', ref: { kind: 'pull', id: '2', url: 'https://evil.example/pull/2', to: '/p/acme~x/changes/2' },
    }, {
      id: 'review:3', kind: 'review', repo: 'acme/x', project: 'X', stage: 'define', summary: 'x', since: '2026-10-31T07:40:00.000Z',
      waited: '', blocking: false, action: 'Review the change', ref: { kind: 'pull', id: '3', to: 'https://evil.example/' },
    }] }, {}) as InboxItem[]
    // an older API (no `to`): the in-app address is worked out, and the words say change
    expect(items[0]).toMatchObject({ kind: 'review', action: { label: 'Review the change', to: '/p/acme~x/changes/1' }, change: { repo: 'acme/x', number: 1, url: 'https://github.com/acme/x/pull/1' } })
    expect(items[0]!.summary).toBe('X: The Verification agent finished "Requirements R1-R10". Review it and accept it into the design.')
    expect(items[0]!.action.href).toBeUndefined()
    // the API's `to` is used; only a github.com link is kept
    expect(items[1]).toMatchObject({ action: { label: 'Review the change', to: '/p/acme~x/changes/2' }, change: { repo: 'acme/x', number: 2 } })
    expect(items[1]!.change!.url).toBeUndefined()
    // a `to` outside the app is never followed
    expect(items[2]!.action.to).toBe('/p/acme~x/changes/3')
  })

  it('me.get: the document, its views, and the admins\' locks', () => {
    expect(read<MeDoc & { locks: Record<string, string> }>('me.get')).toEqual({ prefs: {}, views: {}, locks: {} })
  })

  it('project.members and users.list', () => {
    const m = read<Member[]>('project.members')
    expect(m[0]).toMatchObject({ email: 'admin@example.com', admin: true, class: 'admin', part: 'contributor' })
    const u = read<{ email: string; lastSeen: string | null; name?: string }[]>('users.list')
    expect(u.find((x) => x.email === 'user@example.com')?.lastSeen).toMatch(/^2026-/)
    expect(u.find((x) => x.email === 'admin@example.com')?.name).toBe('Ada Admin')
  })

  it('files.list is a flat list; files.url\'s bytes become an address', () => {
    expect(read<{ path: string; kind: string; revision?: string }[]>('files.list')).toEqual([
      expect.objectContaining({ path: 'hw/answers.kicad_sch', kind: 'design', revision: 'A' }), expect.objectContaining({ path: 'README.md', kind: 'documents', revision: 'A' }),
    ])
    const u = read<{ url: string; mime: string }>('files.url')
    expect(u.mime).toBe('text/markdown')
    expect(u.url).toMatch(/^(blob:|data:text\/markdown;base64,)/)
    // the same version again: the same address
    expect((readFileUrl(answers['files.url'].result) as { url: string }).url).toBe(u.url)
    expect(readFileUrl({ url: 'https://github.example/raw' })).toEqual({ url: 'https://github.example/raw' })
  })
})

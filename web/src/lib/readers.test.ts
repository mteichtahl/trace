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
  // test-esp32 #142: the person must know before choosing that an option records a waiver in their name
  it('journey.get: an agent\'s option that waives carries what it records, in words', () => {
    const a = answers['journey.get'] as { args: Record<string, unknown>; result: Record<string, unknown> }
    const result = structuredClone(a.result) as { questions: Record<string, unknown>[] }
    result.questions = [{ id: 'aq1', kind: 'question', for: 'you', text: 'Waive the fit findings under the window?', asked_at: '2026-11-05T00:00:00Z', answered: null, recommended: { id: 'w', label: 'Waive the Q1, R4, R5 findings' }, options: [
      { id: 'w', label: 'Waive the Q1, R4, R5 findings', recommended: true, why: 'The glass covers them.', waives: { targets: [{ kind: 'finding', id: 'f1' }, { kind: 'finding', id: 'f2' }, { kind: 'finding', id: 'f3' }], risk: 'A part could touch the glass.', severity: 'cosmetic', caught_where: null, scope: 'this revision only' } },
      { id: 'm', label: 'Model the module', recommended: false, why: 'Measured.' },
    ], sources: [] }]
    const j = READERS['journey.get']!(result, a.args) as Journey
    expect(j.questions[0]!.options).toEqual([
      { id: 'w', label: 'Waive the Q1, R4, R5 findings', waiver: 'Records a waiver in your name: 3 findings, rated cosmetic, this revision only. Risk: A part could touch the glass.' },
      { id: 'm', label: 'Model the module' },
    ])
  })

  it('journey.get: a criterion its shape finds not met carries each finding, under the run that found them', () => {
    const a = answers['journey.get'] as { args: Record<string, unknown>; result: { gates: { id: string; criteria: Record<string, unknown>[] }[] } }
    const result = structuredClone(a.result)
    const c = result.gates.find((x) => x.id === 'define')!.criteria[0]!
    Object.assign(c, { status: 'not_met', evidence: [
      { kind: 'run', ref: 'run-9', label: 'the define.accepted shape: 2 finding(s)' },
      { kind: 'finding', ref: 'define.accepted@urn:trace:acme:acme%2Fanswers:requirement:R-1', label: 'No block of the chosen architecture serves "Runs a year". Add it to a block, or strike it with a reason.' },
      { kind: 'finding', ref: 'define.accepted@urn:trace:acme:acme%2Fanswers:requirement:R-2', label: 'No block of the chosen architecture serves "Survives rain". Add it to a block, or strike it with a reason.' },
    ] })
    const g = (READERS['journey.get']!(result, a.args) as JourneyMore).gates.find((x) => x.id === 'define')!
    expect(g.criteria[0]).toMatchObject({ status: 'not_met', evidence: { kind: 'run', id: 'run-9' } })
    // everything it was checked on, findings apart (they are its findings)
    expect(g.criteria[0]!.checked).toEqual([{ kind: 'run', label: 'the define.accepted shape: 2 finding(s)', id: 'run-9', to: '/p/acme~answers/runs/run-9' }])
    expect(g.criteria[0]!.findings).toEqual([
      { id: 'define.accepted@urn:trace:acme:acme%2Fanswers:requirement:R-1', text: 'No block of the chosen architecture serves "Runs a year". Add it to a block, or strike it with a reason.' },
      { id: 'define.accepted@urn:trace:acme:acme%2Fanswers:requirement:R-2', text: 'No block of the chosen architecture serves "Survives rain". Add it to a block, or strike it with a reason.' },
    ])
  })

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
    expect(g.criteria.every((c) => c.findings === undefined)).toBe(true)
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
    expect(run).toMatchObject({ title: 'Check the ERC', state: 'running', step: 'running ERC on the main sheet', controls: ['pause', 'cancel'], agentName: 'Verification', yours: true, branch: 'claude/task-erc' })
    // one earlier run of another request is no estimate (#121): no typical time rather than a tiny one
    expect(run).not.toHaveProperty('typicalS')
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

  describe('journey.get: the next step\'s button goes where the step is done', () => {
    const raw = (answers['journey.get'] as { args: Record<string, unknown>; result: Record<string, unknown> })
    const withNext = (next: Record<string, unknown>, extra: Record<string, unknown> = {}) => READERS['journey.get']!({ ...raw.result, next, ...extra }, raw.args) as JourneyMore

    it('a person\'s criterion opens its skill, not the gate (test-2: Continue opened the gate-signing page at 0 of 2 met)', () => {
      const j = withNext({ kind: 'task', belongs_to: 'you', yours: true, summary: 'Define: Every requirement is accepted or struck.', button: 'Continue', ref: { kind: 'criterion', id: 'define.accepted' } })
      expect(j.next.action).toEqual({ label: 'Continue', to: '/p/acme~answers/do/requirements-review' })
      // a reviewer cannot do it: "Read the stage" reads the gate's evidence
      const rev = withNext({ kind: 'task', belongs_to: 'contributors', yours: false, summary: 'Define: …', button: 'Read the stage', ref: { kind: 'criterion', id: 'define.accepted' } })
      expect(rev.next.action?.to).toBe('/p/acme~answers/gates/define')
      // signing is the gate's page
      expect(withNext({ kind: 'gate', belongs_to: 'you', yours: true, summary: 'x', button: 'Review and sign', ref: { kind: 'gate', id: 'define' } }).next.action?.to).toBe('/p/acme~answers/gates/define')
      // the intent first: the Intent builder
      expect(withNext({ kind: 'task', belongs_to: 'you', yours: true, summary: 'x', button: 'Open the Intent builder', ref: { kind: 'skill', id: 'intent-builder' } }).next.action?.to).toBe('/p/acme~answers/do/intent-builder')
    })

    it('drafting again is an action the card calls, and trace drafting names its job', () => {
      const j = withNext({ kind: 'task', belongs_to: 'you', yours: true, summary: 'x', button: 'Draft the requirements again', ref: { kind: 'action', id: 'requirements.draft' } },
        { drafting: { state: 'stopped', job: { id: 'h.job-1', state: 'lost', error: null }, why: 'It is lost.' } })
      expect(j.next.action).toEqual({ label: 'Draft the requirements again', call: 'requirements.draft' })
      // trace's criterion that nothing works on: Start it calls journey.start_work (test-esp32 log #161)
      expect(withNext({ kind: 'task', belongs_to: 'you', yours: true, summary: 'trace is not working on Sign-off: x.', button: 'Start it', ref: { kind: 'action', id: 'journey.start_work' } }).next.action)
        .toEqual({ label: 'Start it', call: 'journey.start_work' })
      expect(j.drafting).toEqual({ state: 'stopped', jobId: 'h.job-1', jobState: 'lost', why: 'It is lost.' })
      // a reviewer's form of the same step reads the stage: the Define gate's page, a link, never a dead button
      const rev = withNext({ kind: 'task', belongs_to: 'contributors', yours: false, summary: 'x', button: 'Read the stage', ref: { kind: 'gate', id: 'define' } })
      expect(rev.next.action).toEqual({ label: 'Read the stage', to: '/p/acme~answers/gates/define' })
      expect(withNext({ kind: 'working', belongs_to: 'trace', yours: false, summary: 'trace is drafting the requirements from your intent.', button: 'Watch', ref: null, job_id: 'h.job-2' }).next.jobId).toBe('h.job-2')
    })
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

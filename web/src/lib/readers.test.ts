/**
 * The readers against what the API runtime really answers (lib/api-answers.json, written by the API's own test,
 * test/api/web-answers.test.ts): every action the screens read comes out in the shape the screens use.
 */
import { describe, expect, it } from 'vitest'
import answers from './api-answers.json'
import { READERS, readFileUrl, readJourney } from './readers'
import type { InboxItem, Journey, Member, MeDoc } from './types'
import type { JourneyMore } from './types-s1'

const read = <T>(action: keyof typeof answers): T => {
  const a = answers[action] as { args: Record<string, unknown>; result: unknown }
  return READERS[action]!(a.result, a.args) as T
}

describe('reading the API\'s answers', () => {
  it('journey.get: stages, gates with criteria and evidence, waivers, the next step, questions and decisions', () => {
    const j = read<JourneyMore>('journey.get')
    expect(j).toMatchObject({ repo: 'acme/answers', name: 'Answers', template: 'board', revision: 'Rev A', current: 'define', jobs: [], hasMemory: false })
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
    expect(read<{ path: string; kind: string; revision?: string }[]>('files.list')).toEqual([expect.objectContaining({ path: 'README.md', kind: 'documents', revision: 'A' })])
    const u = read<{ url: string; mime: string }>('files.url')
    expect(u.mime).toBe('text/markdown')
    expect(u.url).toMatch(/^(blob:|data:text\/markdown;base64,)/)
    // the same version again: the same address
    expect((readFileUrl(answers['files.url'].result) as { url: string }).url).toBe(u.url)
    expect(readFileUrl({ url: 'https://github.example/raw' })).toEqual({ url: 'https://github.example/raw' })
  })
})

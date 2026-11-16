/**
 * Applying the web app's moves between GitHub and trace's GitLab (src/installer/moves.ts): the homes the settings get,
 * which moves an update takes, and a move's progress as its record shows it.
 */
import { describe, expect, it } from 'vitest'
import type { MoveSide } from '../../src/core/forge-move.js'
import { type MoveRecord, MoveRecordSchema, forgeNow, readyToMove } from '../../src/core/forge-move-record.js'
import type { InfraInput } from '../../src/infra/props.js'
import { type MoveEntry, applyMove, forgesOf, withForges } from '../../src/installer/moves.js'

const PROPS: InfraInput = {
  prefix: 'tr', layout: 'nested', account: '123456789012', region: 'us-east-1', repositories: ['mteichtahl/board@main', 'mteichtahl/probe@main'],
  model: 'us.anthropic.claude-sonnet-4-6', adminEmail: 'marc@example.com', gitlab: { enabled: true },
}
const rec = (o: Partial<MoveRecord> & { repo: string }): MoveRecord => MoveRecordSchema.parse({ from: 'github', to: 'gitlab', requested_by: 'marc', requested_at: '2026-11-16T00:00:00Z', ...o })
const entry = (r: MoveRecord): MoveEntry => ({ key: `installation/pending-moves/${r.repo}.json`, record: r })
const forgeIn = (p: InfraInput, repo: string): unknown => (p.projectSettings as Record<string, { forge?: string }> | undefined)?.[repo]?.forge

describe('the homes in the settings', () => {
  it('a ready move and a done one get the new home; a waiting, failed or cancelled one keeps the old', () => {
    expect(readyToMove(rec({ repo: 'a/b', when: 'idle' }))).toBe(false)
    expect(readyToMove(rec({ repo: 'a/b', when: 'idle', idle_at: 'x' }))).toBe(true)
    expect(readyToMove(rec({ repo: 'a/b', when: 'now' }))).toBe(true)
    const r = withForges(PROPS, [entry(rec({ repo: 'mteichtahl/board', when: 'now' })), entry(rec({ repo: 'mteichtahl/probe', from: 'gitlab', to: 'github', status: 'failed' }))])
    expect(r.taken.map((t) => t.record.repo)).toEqual(['mteichtahl/board'])
    expect(forgeIn(r.props, 'mteichtahl/board')).toBe('gitlab')
    expect(forgeIn(r.props, 'mteichtahl/probe')).toBe('gitlab')
    expect(forgeNow(rec({ repo: 'a/b', status: 'moved' }))).toBe('gitlab')
    expect(forgeNow(rec({ repo: 'a/b', status: 'moving', step: 'copy' }))).toBe('github')
    expect(forgesOf([entry(rec({ repo: 'mteichtahl/Board', status: 'moved' }))]).get('mteichtahl/board')).toBe('gitlab')
  })

  it('skips a ready move it cannot make, and says why', () => {
    const off = { ...PROPS, gitlab: { enabled: false } }
    const r = withForges(off, [entry(rec({ repo: 'mteichtahl/board', when: 'now' })), entry(rec({ repo: 'other/thing', when: 'now' }))])
    expect(r.taken).toEqual([])
    expect(r.skipped.map((s) => s.why)).toEqual([expect.stringContaining('needs gitlab.enabled'), expect.stringContaining('not one of this installation\'s projects')])
    expect(forgeIn(r.props, 'mteichtahl/board')).toBeUndefined()
  })
})

describe('a move', () => {
  const side = (forge: 'github' | 'gitlab', o: { fail?: string } = {}): MoveSide => ({
    forge, where: forge === 'github' ? 'mteichtahl/board' : 'tr/board',
    ensure: async () => ({ made: true }), git: async () => ({ url: '/nowhere', header: 'x' }), defaultBranch: async () => 'main',
    openChanges: async () => [{ number: 7, title: 't', body: '', head: 'trace/a', base: 'main', labels: [], author: 'bot', comments: [] }],
    openIssues: async () => [{ number: 2, title: 'i', body: '', labels: [], author: null }],
    openChange: async () => { if (o.fail) throw new Error(o.fail); return 1 },
    openIssue: async () => 3, archive: async () => undefined,
  })
  const git = (): void => undefined

  it('writes each step as it goes and ends moved with the numbers mapped', async () => {
    const writes: MoveRecord[] = []
    const r = await applyMove({
      put: async (_k, x) => { writes.push(x) }, log: () => undefined, git,
      sides: async () => ({ from: side('github'), to: side('gitlab') }),
      setup: async () => ({ lines: ['tr/board is there'], todo: [] }),
      now: () => new Date('2026-11-16T01:00:00Z'),
    }, entry(rec({ repo: 'mteichtahl/board', when: 'now', status: 'moving', step: 'deploy' })))
    expect(writes.map((w) => `${w.status}:${w.step}`)).toEqual(['moving:copy', 'moving:copy', 'moving:changes', 'moving:issues', 'moving:archive', 'moving:setup', 'moving:setup', 'moved:null'])
    expect(r).toMatchObject({ status: 'moved', changes: { 7: 1 }, issues: { 2: 3 }, finished_at: '2026-11-16T01:00:00.000Z' })
    expect(r.lines.at(-1)).toBe("set up on trace's GitLab for trace")
  })

  it('a failure is recorded at its step, and the old home is not archived', async () => {
    let archived = false
    const from = { ...side('github'), archive: async () => { archived = true } }
    const r = await applyMove({ put: async () => undefined, log: () => undefined, git, sides: async () => ({ from, to: side('gitlab', { fail: 'GitLab: 500' }) }), setup: async () => ({ lines: [], todo: [] }) },
      entry(rec({ repo: 'mteichtahl/board', when: 'now' })))
    expect(r).toMatchObject({ status: 'failed', step: 'changes', error: 'GitLab: 500' })
    expect(archived).toBe(false)
  })

  it('a set-up that cannot finish leaves the move standing, with what is left to do', async () => {
    const r = await applyMove({ put: async () => undefined, log: () => undefined, git, sides: async () => ({ from: side('github'), to: side('gitlab') }), setup: async () => { throw new Error('no admin token yet') } },
      entry(rec({ repo: 'mteichtahl/board', when: 'now' })))
    expect(r.status).toBe('moved')
    expect(r.todo).toEqual(["set up on trace's GitLab could not finish (no admin token yet): run the installer again to carry on"])
  })
})

import { describe, expect, it } from 'vitest'
import type { ForgeMove } from '@/lib/types'
import { bannerWords, movePause } from './lifecycle'
import { going, moveLists, moveWords, stepStates } from './move'

const move = (o: Partial<ForgeMove> = {}): ForgeMove => ({
  repo: 'acme/board', from: 'github', to: 'gitlab', when: 'now', requested_by: 'marc@example.com', requested_at: '2026-11-16T00:00:00Z',
  status: 'waiting', step: null, lines: [], changes: {}, issues: {}, todo: [], ...o,
})
const NOW = Date.parse('2026-11-16T01:00:00Z')

describe('the move screens', () => {
  it('marks each step done, now, stopped or to do', () => {
    expect(stepStates(move({ status: 'moving', step: 'changes' })).map((s) => s.state)).toEqual(['done', 'done', 'now', 'todo', 'todo', 'todo'])
    expect(stepStates(move({ status: 'failed', step: 'copy' })).map((s) => s.state)).toEqual(['done', 'failed', 'todo', 'todo', 'todo', 'todo'])
    expect(stepStates(move({ status: 'moved' })).every((s) => s.state === 'done')).toBe(true)
    expect(going(move())).toBe(true)
    expect(going(move({ status: 'moved' }))).toBe(false)
  })

  it('says what is happening in plain words', () => {
    expect(moveWords(move({ when: 'idle' }), NOW).title).toBe("Moving to trace's GitLab once the work running now finishes")
    expect(moveWords(move({ status: 'moving', step: 'copy' }), NOW).line).toMatch(/^Copying every branch and tag\. The project is paused/)
    expect(moveWords(move({ status: 'moved', changes: { 12: 3 }, finished_at: '2026-11-16T00:30:00Z' }), NOW).line).toMatch(/1 open change has new numbers there\. The old home on GitHub is archived/)
    expect(moveWords(move({ status: 'failed', error: 'GitLab: 500' }), NOW).line).toMatch(/^GitLab: 500\. The project is still on GitHub, exactly as it was/)
    expect(moveLists('gitlab', 'github').stays[0]).toMatch(/^The old repository on trace's GitLab, archived/)
  })

  it('a move\'s pause has no Resume: the move resumes it', () => {
    const paused = { at: NOW / 1000, by: 'marc@example.com', reason: "moving to trace's GitLab" }
    expect(movePause(paused)).toBe(true)
    expect(movePause({ ...paused, reason: 'waiting for parts' })).toBe(false)
    expect(bannerWords({ paused, retired: null }, NOW)?.title).toBe('This project is moving')
  })
})

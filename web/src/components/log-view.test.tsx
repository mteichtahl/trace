import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bumpLog, liveStatus } from '@/lib/live'
import type { LogLine } from '@/lib/types'
import { LogView, appendLines, clock, findMatches, logFileName, logText, problemWords, problems, timeAgainstUsual } from './log-view'
import { stepsFromLines } from './run-sheet'

const L = (text: string, mark: LogLine['mark'] = null, at = '2026-11-03T10:44:02Z'): LogLine => ({ at, text, mark })

describe('the log\'s pure parts', () => {
  it('keeps at most the cap, the earliest dropped, and counts what was dropped', () => {
    const a = appendLines([], [L('1'), L('2'), L('3')], 4)
    expect(a).toEqual({ lines: [L('1'), L('2'), L('3')], trimmed: 0 })
    const b = appendLines(a.lines, [L('4'), L('5'), L('6')], 4, a.trimmed)
    expect(b.lines.map((l) => l.text)).toEqual(['3', '4', '5', '6'])
    expect(b.trimmed).toBe(2)
  })
  it('finds in the log, any case', () => {
    const lines = [L('drc: 412 of 2,480'), L('Silkscreen: R14'), L('drc: 980 of 2,480')]
    expect(findMatches(lines, 'DRC')).toEqual([0, 2])
    expect(findMatches(lines, '  ')).toEqual([])
  })
  it('counts notes and problems and finds the first problem (an error before a warning)', () => {
    const lines = [L('a'), L('⚠ w', 'warn'), L('b'), L('✗ e', 'error')]
    expect(problems(lines)).toEqual({ warns: 1, errors: 1, first: 3 })
    expect(problemWords({ warns: 1, errors: 0 })).toBe('1 note')
    expect(problemWords({ warns: 2, errors: 1 })).toBe('1 problem · 2 notes')
    expect(problemWords({ warns: 0, errors: 0 })).toBeNull()
  })
  it('the download: one line each with its time, named after the project and run', () => {
    expect(logText([L('a'), L('b')])).toBe('2026-11-03T10:44:02Z  a\n2026-11-03T10:44:02Z  b\n')
    expect(logFileName('acme/soil-sensor', 'check:5512')).toBe('soil-sensor-check-5512.txt')
    expect(clock('2026-11-03T10:44:02Z', true)).toBe('44:02')
  })
  it('time against the usual', () => {
    const now = Date.parse('2026-11-03T10:47:33Z')
    expect(timeAgainstUsual('2026-11-03T10:44:33Z', 360, now)).toBe('3 min so far, usually 6 min')
    expect(timeAgainstUsual('2026-11-03T10:45:33Z', 180, now)).toBe('2 min so far, about 1 min left')
    expect(timeAgainstUsual('2026-11-03T10:47:00Z', null, now)).toBe('33 s so far')
    expect(timeAgainstUsual(null, 60, now)).toBeNull()
  })
  it('steps from the log\'s own step lines', () => {
    const lines = [L('▸ Step 1 · Get the design', 'step', '2026-11-03T10:44:02Z'), L('x', null, '2026-11-03T10:44:05Z'), L('▸ Load the board', 'step', '2026-11-03T10:44:08Z')]
    const s = stepsFromLines(lines, false, Date.parse('2026-11-03T10:44:20Z'))
    expect(s).toEqual([{ name: 'Get the design', state: 'passed', seconds: 6 }, { name: 'Load the board', state: 'running', seconds: 12 }])
  })
})

describe('LogView reads on from its cursor', () => {
  afterEach(() => vi.restoreAllMocks())
  it('asks with the last cursor when its repo\'s log grows, and keeps every line', async () => {
    liveStatus.set({ state: 'live', lastUpdate: Date.now(), liveSince: Date.now() })
    const api = await import('@/lib/api')
    const seen: unknown[] = []
    let n = 0
    vi.spyOn(api, 'call').mockImplementation((async (_a: string, args: { after?: string }) => {
      seen.push(args.after ?? null)
      n++
      const lines = n === 1 ? [L('▸ Step 1 · Get the design', 'step'), L('⚠ silkscreen moved', 'warn')] : [L('drc: 412 of 2,480 items checked')]
      return { repo: 'a/b', run: 'check:1', source: 'cloudwatch', lines, next: `c${n}`, done: false, heardAt: new Date().toISOString(), step: null, usualQuietS: 60 }
    }) as never)
    render(<LogView repo="a/b" run="check:1" />)
    await screen.findByText('⚠ silkscreen moved')
    expect(screen.getByRole('button', { name: /1 note/ })).toBeInTheDocument()
    act(() => bumpLog('a/b'))
    await screen.findByText('drc: 412 of 2,480 items checked')
    expect(seen).toEqual([null, 'c1'])
    // the step line is still there
    expect(screen.getByText('▸ Step 1 · Get the design')).toBeInTheDocument()
    // find marks the match
    await userEvent.type(screen.getByLabelText('Find in log'), 'drc')
    await waitFor(() => expect(screen.getByText('1 of 1')).toBeInTheDocument())
  })
})

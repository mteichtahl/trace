import { describe, expect, it } from 'vitest'
import type { OpsTile, OpsWidget } from '@/lib/admin-types'
import type { OpsProcess } from '@/lib/admin-types'
import { chartRows, momentSummary, opsUrl, processCharts, refreshIn, reworkRows, seriesLabel, stageBars, stepOf, tileViews, timeParts, timeWords, waitRows } from './ops-model'

const tile = (id: string, o: Partial<OpsTile> = {}): OpsTile => ({ id, label: id, value: 3, unit: 'runs', spark: [1, 2, 3], status: 'ok', ...o })

describe('Operations', () => {
  it('shows the five designed tiles in order, cloud spend for admins only, the others behind More numbers', () => {
    const tiles = [
      tile('runs', { detail: { successRate: 0.96 } }), tile('latency', { value: 384, unit: 's' }), tile('cost', { value: 412, unit: 'USD' }),
      tile('builds', { value: 94, unit: '%', detail: { passed: 47, failed: 3, total: 50 } }),
      tile('jobs', { value: 31, unit: 'jobs', detail: { done: 27, failed: 0, lost: 4, cancelled: 0 }, status: 'warn' }),
      tile('waiting', { value: 13 * 60, unit: 's', detail: { slowest: 72 * 60, count: 35 } }),
    ]
    const admin = tileViews(tiles, true)
    expect(admin.filter((t) => !t.extra).map((t) => t.label)).toEqual(['Builds passed', 'Agent jobs finished', 'Waiting on people', 'Time trace was working', 'Cloud spend this month'])
    expect(admin[0]).toMatchObject({ value: '94', unit: '%', sub: '47 of 50 · 3 failed' })
    expect(admin[1]).toMatchObject({ value: '31', sub: '27 done · 0 failed · ', subWarn: '4 lost', statusWord: 'Lost jobs above 0', status: 'warn' })
    expect(admin[2]).toMatchObject({ value: '13', unit: 'min', sub: 'median · slowest 10 % over 72 min' })
    // not reported: said honestly, with what it needs
    expect(admin[3]!.missing).toMatch(/Not reported yet/)
    expect(admin[4]!.value).toBe('US$412')
    expect(admin.filter((t) => t.extra).map((t) => [t.label, t.value, t.unit])).toEqual([['runs', '3', undefined], ['latency', '6', 'min']])
    expect(admin.find((t) => t.id === 'runs')?.sub).toBe('96% succeeded')
    expect(tileViews(tiles, false).map((t) => t.label)).not.toContain('Cloud spend this month')
    // no lost jobs: no warning words
    expect(tileViews([tile('jobs', { value: 2, detail: { done: 2, failed: 0, lost: 0, cancelled: 0 } })], false)[1]!.statusWord).toBeUndefined()
    expect(tileViews([tile('working', { value: 61, unit: '%' })], false)[3]).toMatchObject({ value: '61', unit: '%', statusWord: 'Higher is better', plain: true })
  })

  it('says lengths of time with their units', () => {
    expect(timeParts(40)).toEqual({ value: '40', unit: 's' })
    expect(timeParts(72 * 60)).toEqual({ value: '72', unit: 'min' })
    expect(timeParts(4.9 * 3600)).toEqual({ value: '4.9', unit: 'h' })
    expect(timeParts(3 * 86_400)).toEqual({ value: '3', unit: 'd' })
    expect(timeWords(null)).toBe('–')
  })

  it('the Process tab: coloured stacked charts, every kind and cause in order, stage bars split working and waiting', () => {
    const p: OpsProcess = {
      builds: { passed: 5, failed: 1, own: { passed: 0, failed: 0 }, projects: { passed: 5, failed: 1 }, points: [[1, 3, 0], [2, 2, 1]] },
      jobs: { done: 4, failed: 0, lost: 1, cancelled: 0, points: [[1, 2, 0, 1, 0], [2, 2, 0, 0, 0]] },
      waits: [{ kind: 'gate', count: 6, median: 60, slowest: 4.9 * 3600 }],
      wait: null, rework: [{ cause: 'sent_back', count: 2 }], working: null, runTime: null,
    }
    const c = processCharts(p)
    expect(c.builds?.series.map((s) => [s.label, s.color, s.points])).toEqual([['Passed', 'var(--verified)', [[1, 3], [2, 2]]], ['Failed', 'var(--destructive)', [[1, 0], [2, 1]]]])
    expect(c.jobs?.series.map((s) => s.label)).toEqual(['Done', 'Failed', 'Lost (no word for 15 min)', 'Cancelled'])
    expect(c.jobs?.series[2]?.points).toEqual([[1, 1], [2, 0]])
    expect(processCharts(undefined)).toEqual({ builds: null, jobs: null })
    expect(waitRows(p)).toEqual([
      { kind: 'question', what: 'Question answered', count: 0, median: '–', slowest: '–', slow: false },
      { kind: 'change', what: 'Change accepted', count: 0, median: '–', slowest: '–', slow: false },
      { kind: 'gate', what: 'Gate signed', count: 6, median: '1 min', slowest: '4.9 h', slow: true },
    ])
    expect(reworkRows(p).map((r) => [r.cause, r.count])).toEqual([['job_restarted', 0], ['conflict_resolved', 0], ['sent_back', 2], ['asked_again', 0]])
    const bars = stageBars([{ id: 'layout', name: 'Layout', seconds: 5 * 3600, waiting: 2 * 3600 }, { id: 'signoff', name: 'Sign-off', seconds: 10 * 3600, waiting: 20 * 3600 }])
    expect(bars).toEqual([
      { id: 'layout', name: 'Layout', width: 50, working: 60, waiting: 40, hours: '5.0 h' },
      // a wait longer than its stage (a clock difference) is the whole stage, never more
      { id: 'signoff', name: 'Sign-off', width: 100, working: 0, waiting: 100, hours: '10.0 h' },
    ])
  })

  it('refreshes on the API\'s interval, and more slowly when the tab is hidden', () => {
    const a = { updatedAt: new Date(0).toISOString(), nextAt: new Date(60_000).toISOString() }
    expect(refreshIn(a, 40_000, true)).toBe(20_000)
    expect(refreshIn(a, 40_000, false)).toBeGreaterThanOrEqual(5 * 60_000)
  })

  it('asks for the range or the custom dates, and the project', () => {
    expect(opsUrl('7d', 'acme/soil-sensor')).toBe('/api/ops?range=7d&repo=acme%2Fsoil-sensor')
    expect(opsUrl('custom', null, { start: '2026-10-01T00:00', end: '2026-10-02T00:00' })).toMatch(/start=.*&end=/)
    expect(stepOf('24h')).toBe(3_600_000)
  })

  it('merges series by time and sums a moment in words', () => {
    const w: OpsWidget = { id: 'w', title: 'Runs', kind: 'bar', unit: 'runs', series: [{ label: 'Verification', points: [[1, 2], [2, 1]] }, { label: 'Analog', points: [[1, 2]] }] }
    expect(chartRows(w)).toHaveLength(2)
    expect(momentSummary(w, 1)).toBe('4 runs in all: Verification 2, Analog 2.')
  })

  it('names a series by its runtime or memory, not its whole ARN', () => {
    expect(seriesLabel('GetMemory arn:aws:bedrock-agentcore:us-east-1:346073464284:memory/trace_m_8a9ca7b7-n7ExQ1Gm5V Invocations')).toBe('GetMemory trace_m_8a9ca7b7-n7ExQ1Gm5V Invocations')
    expect(seriesLabel('MicroVM trace_w_8a9ca7b7::DEFAULT InvokeAgentRuntime arn:aws:bedrock-agentcore:us-east-1:346073464284:runtime/trace_w_8a9ca7b7-cBaApuCAk0 Invocations'))
      .toBe('MicroVM trace_w_8a9ca7b7::DEFAULT InvokeAgentRuntime trace_w_8a9ca7b7-cBaApuCAk0 Invocations')
    expect(seriesLabel('Agent runs')).toBe('Agent runs')
  })
})

import { describe, expect, it } from 'vitest'
import type { OpsTile, OpsWidget } from '@/lib/admin-types'
import { chartRows, momentSummary, opsUrl, refreshIn, stepOf, tileViews } from './ops-model'

const tile = (id: string, o: Partial<OpsTile> = {}): OpsTile => ({ id, label: id, value: 3, unit: 'runs', spark: [1, 2, 3], status: 'ok', ...o })

describe('Operations', () => {
  it('shows the five designed tiles in order, cloud spend for admins only', () => {
    const tiles = [tile('runs', { detail: { successRate: 0.96 } }), tile('latency', { value: 384_000, unit: 'ms' }), tile('cost', { value: 412, unit: 'USD' })]
    const admin = tileViews(tiles, true)
    expect(admin.map((t) => t.label)).toEqual(['Agent runs', 'Median run time', 'Jobs waiting', 'Build failures', 'Cloud spend this month'])
    expect(admin[0]!.sub).toBe('96% succeeded')
    expect(admin[1]).toMatchObject({ value: '6.4', unit: 'min' })
    expect(admin[2]!.missing).toMatch(/Not reported yet/)
    expect(admin[4]!.value).toBe('US$412')
    expect(tileViews(tiles, false).map((t) => t.label)).not.toContain('Cloud spend this month')
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
})

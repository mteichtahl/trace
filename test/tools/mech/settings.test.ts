/** Case settings (src/tools/mech/settings.ts) and the capabilities table (src/tools/mech/capabilities.ts). */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CAPABILITIES, FIGURES, RECOMMENDED, STALE_DAYS, engineCapabilities, figureStatus, minWall, pageText, processRow, staleness,
} from '../../../src/tools/mech/capabilities.js'
import {
  CASE_JSON, CaseSettingsSchema, defaults, describe as describeSettings, missingReasons, readSettings, recommendations, withClearance, withValue, writeSettings,
} from '../../../src/tools/mech/settings.js'

const dir = mkdtempSync(join(tmpdir(), 'mech-settings-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('case settings', () => {
  it('default to the recommendation: MJF PA12-HP, 2 mm walls, 0.5 mm edge and 1.0 mm above the tallest part', () => {
    const s = defaults('hardware/x.kicad_pcb')
    expect(s).toMatchObject({
      version: 1, board: 'hardware/x.kicad_pcb', template: 'printed-shell', source: 'script',
      process: { service: 'jlc3dp', process: 'MJF', material: 'PA12-HP' },
      params: { wall_mm: 2, floor_mm: 2, lid_mm: 2, corner_radius_mm: 3, standoff_d_mm: 7, lip_mm: 2, lip_h_mm: 3 },
      clearance: { edge_mm: 0.5, above_tallest_mm: 1, below_mm: 1, parts: {} },
      openings: { skip: [], extra_mm: 0.5 }, quantity: 5, reasons: {},
    })
    expect(s.process).toEqual(RECOMMENDED)
  })

  it('validate: a board, version 1, the one template, positive walls, a file for source "file"; unknown keys are kept', () => {
    expect(CaseSettingsSchema.safeParse({}).success).toBe(false)
    expect(CaseSettingsSchema.safeParse({ board: 'b', version: 2 }).success).toBe(false)
    expect(CaseSettingsSchema.safeParse({ board: 'b', template: 'din-rail' }).success).toBe(false)
    expect(CaseSettingsSchema.safeParse({ board: 'b', params: { wall_mm: 0 } }).success).toBe(false)
    expect(CaseSettingsSchema.safeParse({ board: 'b', clearance: { edge_mm: -1 } }).success).toBe(false)
    expect(CaseSettingsSchema.safeParse({ board: 'b', source: 'file' }).success).toBe(false)
    expect(CaseSettingsSchema.safeParse({ board: 'b', source: 'file', file: 'mechanical/x.step' }).success).toBe(true)
    expect(CaseSettingsSchema.parse({ board: 'b', note: 'mine' })).toMatchObject({ note: 'mine' })
  })

  it('refuse a change from the recommendation without a reason, and keep the reason with it', () => {
    const s = defaults('b')
    expect(() => withValue(s, 'params.wall_mm', 1.5)).toThrow(/differs from the recommendation \(2\): give the reason/)
    expect(() => withValue(s, 'params.wall_mm', 1.5, 'no')).toThrow(/give the reason/)
    const t = withValue(s, 'params.wall_mm', 2.5, 'drop test from 1.5 m')
    expect(t.params.wall_mm).toBe(2.5)
    expect(t.reasons['params.wall_mm']).toBe('drop test from 1.5 m')
    // changed again, the reason given before stands
    expect(withValue(t, 'params.wall_mm', 3).reasons['params.wall_mm']).toBe('drop test from 1.5 m')
    // back to the recommendation: no reason needed, and the old one goes
    const back = withValue(t, 'params.wall_mm', 2)
    expect(back.reasons).toEqual({})
    expect(() => withValue(s, 'params.nope', 1, 'x y z')).toThrow(/is not a setting/)
    expect(() => withValue(s, 'params.wall_mm', -1, 'a reason')).toThrow(/params\.wall_mm/)
    expect(withValue(s, 'openings.skip', ['J3'], 'J3 is a debug header').openings.skip).toEqual(['J3'])
  })

  it('give a part its clearance only with a reason, and remove it', () => {
    const s = defaults('b')
    expect(() => withClearance(s, 'J1', 2)).toThrow(/needs its reason/)
    const t = withClearance(s, 'J1', 2, 'mating face of the plug')
    expect(t.clearance.parts.J1).toEqual({ mm: 2, reason: 'mating face of the plug' })
    expect(t.reasons['clearance.parts.J1']).toBe('mating face of the plug')
    const u = withClearance(t, 'J1', null)
    expect(u.clearance.parts).toEqual({})
    expect(u.reasons).toEqual({})
  })

  it('say which values differ without a reason (a hand-edited file) and describe each with its recommendation', () => {
    const s = CaseSettingsSchema.parse({ board: 'b', params: { wall_mm: 1.2 }, reasons: { 'params.lid_mm': 'unused' } })
    expect(missingReasons(s)).toEqual(['params.wall_mm'])
    const rows = describeSettings(s)
    expect(rows.find((r) => r.path === 'params.wall_mm')).toEqual({ path: 'params.wall_mm', value: 1.2, recommended: 2, changed: true, reason: null })
    expect(Object.keys(recommendations())).toContain('clearance.edge_mm')
  })

  it('read and write mechanical/case.json, and say what is wrong with a bad one', () => {
    expect(readSettings(dir)).toBeNull()
    writeSettings(dir, defaults('b'))
    expect(JSON.parse(readFileSync(join(dir, CASE_JSON), 'utf8')).board).toBe('b')
    expect(readSettings(dir)?.board).toBe('b')
    mkdirSync(join(dir, 'bad', 'mechanical'), { recursive: true })
    writeFileSync(join(dir, 'bad', CASE_JSON), '{"board": "b", "params": {"wall_mm": "thick"}}')
    expect(() => readSettings(join(dir, 'bad'))).toThrow(/params\.wall_mm/)
    writeFileSync(join(dir, 'bad', CASE_JSON), '{')
    expect(() => readSettings(join(dir, 'bad'))).toThrow(/not valid JSON/)
  })
})

describe('capabilities', () => {
  it('hold the rows as read on 29 October 2026, each with its source', () => {
    expect(CAPABILITIES.checked).toBe('2026-10-29')
    const mjf = processRow(RECOMMENDED)!
    expect(mjf).toMatchObject({ max_mm: [370, 276, 360], assembly_clearance_mm: 0.2, assembly_clearance: '0.2–0.4 mm', moving_clearance_mm: 0.6, hole_min_d_mm: 1.5 })
    expect(minWall(mjf, 55)).toBe(2.0)
    expect(minWall(mjf, 50)).toBe(1.5)
    expect(minWall(mjf, 500)).toBe(2.0)
    expect(processRow({ service: 'JLC3DP', process: 'sla', material: 'imagine black' })?.max_mm).toEqual([580, 580, 380])
    expect(processRow({ service: 'jlc3dp', process: 'FDM', material: 'PLA-P' })).toMatchObject({ max_mm: [250, 250, 300], min_mm: [30, 30, 10], assembly_clearance_mm: 0.5 })
    expect(minWall(processRow({ service: 'jlc3dp', process: 'FDM', material: 'ABS' })!, 20)).toBe(1.6)
    expect(processRow({ service: 'jlc3dp', process: 'MJF', material: 'unobtainium' })).toBeNull()
    for (const r of CAPABILITIES.processes) expect(r.source).toMatch(/^https:\/\/jlc3dp\.com\//)
    expect(CAPABILITIES.cnc).toMatchObject({ wall_min_mm: { metal: 0.5, plastic: 1.0 }, wall_recommended_mm: { metal: 0.8, plastic: 1.5 } })
    expect(engineCapabilities()).toMatchObject({ checked: '2026-10-29', processes: expect.arrayContaining([expect.objectContaining({ process: 'MJF', materials: ['PA12-HP', 'PA12S', 'PA11-HP'] })]) })
  })

  it('go stale 90 days after they were read', () => {
    expect(STALE_DAYS).toBe(90)
    expect(staleness(new Date('2026-11-15T12:00:00Z'))).toMatchObject({ age_days: 17, stale: false })
    expect(staleness(new Date('2027-01-27T00:00:00Z'))).toMatchObject({ age_days: 90, stale: false })
    expect(staleness(new Date('2027-01-28T00:00:00Z'))).toMatchObject({ age_days: 91, stale: true })
  })

  it('tell a page that still states a figure from one that changed it or cannot be read', () => {
    const html = '<table><tr><td>MJF (Nylon)</td><td>PA12</td><td>370&nbsp;&times;&nbsp;276 × 360</td></tr></table><script>var PA12 = 1</script>'
    const t = pageText(html)
    expect(t).toBe('MJF (Nylon) PA12 370 × 276 × 360')
    const f = FIGURES.find((x) => x.id === 'max_mm.PA12')!
    expect(figureStatus(f, t)).toBe('same')
    expect(figureStatus(f, t.replace('370', '380'))).toBe('changed')
    expect(figureStatus(f, 'nothing here')).toBe('unreadable')
    expect(figureStatus(f, null)).toBe('unreadable')
    expect(new Set(FIGURES.map((x) => x.id)).size).toBe(FIGURES.length)
  })
})

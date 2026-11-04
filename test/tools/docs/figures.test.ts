/**
 * The figures and values documents carry (src/docs/values.ts, src/tools/docs/figures.ts; docs/scribe.md): values read
 * from the run record with their basis and source, ready tables that pass the quality bar, timing diagrams made from
 * protocol.model runs with stable names and a manifest, and a figure kept when its inputs have not changed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { skeleton } from '../../../src/docs/catalog.js'
import { checkDoc } from '../../../src/docs/checks.js'
import { replaceSection } from '../../../src/docs/markers.js'
import { openProject, Work } from '../../../src/core/store.js'
import { recordedValues, valuesTable } from '../../../src/docs/values.js'
import { stale } from '../../../src/tools/docs/figures.js'
import { allTools } from '../../../src/tools/index.js'

type Dict = Record<string, any>
const reg = allTools()
const call = async (name: string, args: Dict): Promise<Dict> => (await reg.call(name, args, { hardware: false, via: 'test' })) as Dict
const dir = mkdtempSync(join(tmpdir(), 'trace-figures-'))
const repo = join(dir, 'repo')
const cwd = process.cwd()

beforeAll(() => {
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repo })
  process.chdir(repo)
})
afterAll(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }) })

describe('values from the record', () => {
  it('nothing recorded: no rows, and says what to run', async () => {
    const v = await call('docs.values', {})
    expect(v.values).toEqual({ power: [], thermal: [], load: [] })
    expect(v.missing.join()).toMatch(/thermal\.budget/)
  })

  it('the power budget per rail and in total, estimated and citing the budget', async () => {
    await call('thermal.budget', { scenario: 'nominal', entries: [
      { method: 'explicit', ref: 'U1', rail: '3V3', power_w: 0.44, citation: { source: 'bench estimate' } }, { method: 'explicit', ref: 'U2', rail: '3V3', power_w: 0.002, citation: { source: 'datasheet' } }, { method: 'explicit', ref: 'R1', rail: 'VIN', power_w: 0.003, power_max_w: 0.004, citation: { source: 'divider' } },
    ] })
    const rows = recordedValues(openProject()).power
    expect(rows.map((r) => [r.quantity, r.value, r.basis, r.source])).toEqual([
      ['Power on 3V3', '442 mW', 'estimated', 'budget:nominal'],
      ['Power on VIN', '3 mW', 'estimated', 'budget:nominal'],
      ['Board power, typical', '445 mW', 'estimated', 'budget:nominal'],
      ['Board power, worst case', '446 mW', 'estimated', 'budget:nominal'],
    ])
  })

  it('junction temperatures from thermal.check with their margin; bench readings measured', () => {
    const w = new Work()
    try {
      const id = w.start('thermal.check', { subject: 'board' })
      w.measure(id, 'U1.tj_c', 87.2, 'C')
      w.measure(id, 'U1.margin_c', 37.8, 'C')
      w.measure(id, 'U1.board_c', 61, 'C')
      w.finish(id, 'pass', 'ok')
      const m = w.start('thermal.measure', { subject: 'bench' })
      w.measure(m, 'U1.measured_c', 84.9, 'C')
      w.finish(m, 'pass', 'ok')
    } finally { w.db.close() }
    const t = recordedValues(openProject()).thermal
    expect(t.map((r) => [r.quantity, r.value, r.limit, r.margin, r.basis])).toEqual([
      ['`U1` junction temperature, worst case', '87.2 °C', '125 °C', '37.8 °C', 'simulated'],
      ['`U1` temperature on the bench', '84.9 °C', '', '', 'measured'],
    ])
    expect(t.every((r) => r.source.startsWith('run:'))).toBe(true)
  })

  it('the ready tables pass the quality bar, with pending rows for what is not worked out', () => {
    const db = openProject()
    const v = recordedValues(db)
    const body = ['## Power budget', '', valuesTable('power', v.power, ['Battery life'])].join('\n')
    const md = replaceSection(skeleton('lld', { project: 'p', revision: 'A', commit: 'abc1234', date: '2026-11-05' }), 'power-budget', body)
    expect(checkDoc('lld', md, { stage: 'capture' }).filter((f) => f.section === 'power-budget')).toEqual([])
    expect(valuesTable('load', [], ['Connector J1 current'])).toMatch(/\| Connector J1 current \| pending \| \| \| pending \| \|/)
  })
})

describe('figures', () => {
  it('a figure is made again only for new inputs, or a release over a draft', () => {
    const e = { file: 'f', kind: 'render-top', source: 'run:1', inputs: 'a', quality: 'draft' as const, made: '' }
    expect(stale(undefined, 'a')).toBe(true)
    expect(stale(e, 'a', 'draft')).toBe(false)
    expect(stale(e, 'b', 'draft')).toBe(true)
    expect(stale(e, 'a', 'release')).toBe(true)
    expect(stale({ ...e, quality: 'release' }, 'a', 'draft')).toBe(false)
  })

  it('draws a timing diagram per protocol modelled, with a stable name, and keeps it while the model stands', async () => {
    const none = await call('docs.figures', { renders: false, drawings: false })
    expect(none.notes.join()).toMatch(/No protocol modelled/)
    await call('protocol.model', { protocol: 'i2c', config: { speed: 'fast' }, transactions: [{ addr: 0x3c, write: [0x00, 0xaf] }] })
    const r = await call('docs.figures', { renders: false, drawings: false })
    expect(r.made.map((f: Dict) => [f.file, f.kind])).toEqual([['docs/design/figures/timing-i2c.svg', 'timing-diagram']])
    expect(r.made[0].source).toMatch(/^run:/)
    expect(readFileSync('docs/design/figures/timing-i2c.svg', 'utf8')).toMatch(/^<svg/)
    const manifest = JSON.parse(readFileSync('docs/design/figures/figures.json', 'utf8'))
    expect(manifest['timing-i2c'].source).toBe(r.made[0].source)
    const again = await call('docs.figures', { renders: false, drawings: false })
    expect(again.made).toEqual([])
    expect(again.kept).toEqual(['timing-i2c'])
  })

  it('without a board there are no renders, and it says so', async () => {
    const r = await call('docs.figures', { timing: false })
    expect(r.notes).toEqual(['No board yet: no renders.', 'No case built yet (mech.build): no mechanical drawings.'])
    expect(existsSync('docs/design/figures/render-top.png')).toBe(false)
  })
})

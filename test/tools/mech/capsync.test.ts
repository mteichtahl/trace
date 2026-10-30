import { describe, expect, it } from 'vitest'
import {
  BASE_CAPABILITIES, BASE_FIGURES, CAPABILITIES, CHECKED, type CapabilityUpdates, type Figure, capabilitiesStamp, numbersIn, processRow, withUpdates,
} from '../../../src/tools/mech/capabilities.js'
import { type Pages, planSync, pullRequest, renderUpdates, reviewIssue, sameShape } from '../../../src/tools/mech/capsync.js'
import { staleReasons } from '../../../src/tools/mech/stale.js'

const NONE: CapabilityUpdates = { checked: null, figures: {} }

/** Pages that state every figure as stored, one "label text" after another, with `edit` applied to the text. */
function pages(edit: (id: string, text: string) => string | null = (_, t) => t, figures: readonly Figure[] = BASE_FIGURES): Pages {
  const by: Record<string, string[]> = {}
  for (const f of figures) {
    const t = edit(f.id, f.text)
    // a figure that is a later text of its shape in its row (nth) gets that many others of the shape before it
    const before = Array.from({ length: f.nth ?? 0 }, () => f.text.replace(/\d+(?:\.\d+)?/g, '999')).join(' ')
    if (t !== null) (by[f.page] ??= []).push(`${f.label} ${before ? `${before} ` : ''}${t}`)
  }
  return Object.fromEntries([...new Set(figures.map((f) => f.page))].map((u) => [u, { text: (by[u] ?? []).join(' | '), error: null }]))
}

const days = (n: number): string => new Date(Date.parse(`${CHECKED}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

describe('the scheduled capability check', () => {
  it('does nothing when every figure is stated and the table is recent', () => {
    const p = planSync({ pages: pages(), updates: NONE, today: days(5) })
    expect(p.kind).toBe('none')
    expect(p.same).toBe(BASE_FIGURES.length)
    expect(p.review).toEqual([])
    expect(p.next).toEqual(NONE)
  })

  it('moves the date on when every figure is stated and the table is 30 days old', () => {
    const p = planSync({ pages: pages(), updates: NONE, today: days(31) })
    expect(p.kind).toBe('reverify')
    expect(p.next).toEqual({ checked: days(31), figures: {} })
    expect(pullRequest(p).title).toBe(`Capabilities: every figure confirmed on ${days(31)}`)
    expect(reviewIssue(p)).toBeNull()
  })

  it('writes a figure the page states with other numbers, and applies it to its rows only', () => {
    const p = planSync({ pages: pages((id, t) => (id === 'wall_by_size.MJF' ? '1.0mm 1.2mm 1.6mm 2.0mm 2.0mm' : t)), updates: NONE, today: days(2) })
    expect(p.kind).toBe('update')
    expect(p.updated.map((u) => u.id)).toEqual(['wall_by_size.MJF'])
    expect(p.next.checked).toBe(days(2))
    const caps = withUpdates(BASE_CAPABILITIES, p.next)
    const mjf = processRow({ service: 'jlc3dp', process: 'MJF', material: 'PA12-HP' }, caps)!
    const sls = processRow({ service: 'jlc3dp', process: 'SLS', material: '3301PA' }, caps)!
    expect(mjf.wall_by_size).toEqual([[5, 1.0], [10, 1.2], [50, 1.6], [100, 2.0], [200, 2.0]])
    // MJF and SLS rows share one spread-in table in the source: SLS keeps its own figures
    expect(sls.wall_by_size).toEqual([[5, 1.0], [10, 1.2], [50, 1.5], [100, 2.0], [200, 2.0]])
    expect(pullRequest(p).body).toContain('| `wall_by_size.MJF` | 1.0mm 1.2mm 1.5mm 2.0mm 2.0mm |')
  })

  it('reports a figure that changed and is not written back, and does not move the date', () => {
    const p = planSync({ pages: pages((id, t) => (id === 'cnc.corner_radius' ? 'R=(H/8)+0.5' : t)), updates: NONE, today: days(40) })
    expect(p.kind).toBe('none')
    expect(p.review).toHaveLength(1)
    expect(p.review[0]).toMatchObject({ id: 'cnc.corner_radius', found: 'R=(H/8)+0.5' })
    expect(p.review[0]!.why).toMatch(/not written back automatically/)
    expect(p.next).toEqual(NONE)
    expect(reviewIssue(p)!.body).toContain('`cnc.corner_radius`')
  })

  it('reports an unreadable page for a person and changes nothing', () => {
    const pg = pages()
    for (const u of Object.keys(pg)) if (u.includes('jlccnc')) pg[u] = { text: null, error: 'HTTP 503' }
    const p = planSync({ pages: pg, updates: NONE, today: days(45) })
    expect(p.kind).toBe('none')
    expect(p.review.length).toBeGreaterThan(0)
    expect(p.review.every((r) => r.why.includes('HTTP 503'))).toBe(true)
    expect(p.next.checked).toBeNull()
  })

  it('applies the update but leaves the date while another figure needs a person', () => {
    const pg = pages((id, t) => (id === 'general.lead_time' ? '72h-120h' : id === 'cnc.thread_length' ? 'twice the hole diameter' : t))
    const p = planSync({ pages: pg, updates: NONE, today: days(3) })
    expect(p.kind).toBe('update')
    expect(p.next.figures['general.lead_time']).toEqual({ text: '72h-120h', read: days(3) })
    expect(p.next.checked).toBeNull()
    expect(withUpdates(BASE_CAPABILITIES, p.next).general.lead_time).toBe('72–120 h')
  })

  it('sends disagreeing figures of one table row to a person', () => {
    const row = (label: string): Figure => ({
      id: `size.${label}`, page: 'https://example.test/guide', label, text: '370 × 276 × 360',
      apply: (c, n) => { for (const r of c.processes.filter((x) => x.materials.includes('PA12-HP'))) r.max_mm = [n[0]!, n[1]!, n[2]!] },
    })
    const figures = [row('alpha'), row('omega')]
    const p = planSync({ pages: pages((id, t) => (id === 'size.alpha' ? '380 × 276 × 360' : t), figures), updates: NONE, today: days(1), figures })
    expect(p.kind).toBe('none')
    expect(p.review.map((r) => r.id)).toEqual(['size.alpha'])
    expect(p.review[0]!.why).toMatch(/disagrees/)
  })

  it('drops an update when the page goes back to the reviewed figure', () => {
    const updates: CapabilityUpdates = { checked: days(10), figures: { 'general.lead_time': { text: '72h-120h', read: days(10) } } }
    const p = planSync({ pages: pages(), updates, today: days(12) })
    expect(p.kind).toBe('update')
    expect(p.next.figures).toEqual({})
  })

  it('finds a figure in the same shape, and nothing in another shape', () => {
    const f = BASE_FIGURES.find((x) => x.id === 'cnc.wall')!
    expect(sameShape(f, `${f.label} should be 1.0 mm (absolute minimum 0.6 mm), and 1.5 mm (absolute minimum 1 mm) for plastic parts`)).toMatchObject({ numbers: [1, 0.6, 1.5, 1] })
    expect(sameShape(f, `${f.label} should be 1.0 mm (absolute minimum 0.6 mm), and 1.5 mm (absolute minimum 1 mm) for plastic parts | ${f.label} should be 2.0 mm (absolute minimum 0.6 mm), and 1.5 mm (absolute minimum 1 mm) for plastic parts`)).toHaveProperty('ambiguous')
    expect(sameShape(f, `${f.label} is whatever you like`)).toBeNull()
    expect(numbersIn('1.0—3.0mm')).toEqual([1, 3])
  })

  it('reads a table row, not the next one with the same numbers, nor a longer name, nor a later column header', () => {
    const walls = BASE_FIGURES.find((x) => x.id === 'wall_by_size.MJF')!
    const page = 'Nylon (MJF) 1.0mm 1.2mm 1.7mm 2.0mm 2.0mm Nylon (SLS) 1.0mm 1.2mm 1.5mm 2.0mm 2.0mm | Resin (SLA) Nylon (MJF) 0.5mm 0.6mm 0.6mm 1.0mm 1.0mm'
    expect(sameShape(walls, page)).toMatchObject({ found: '1.0mm 1.2mm 1.7mm 2.0mm 2.0mm' })
    const pa12 = BASE_FIGURES.find((x) => x.id === 'max_mm.PA12')!
    const sizes = 'PA12-HP Nylon PA12-CF Plastic | PA12 380 × 276 × 360 5 × 5 × 5 | PA12S 370 × 276 × 360 | PA12-CF 580 × 480 × 480'
    expect(sameShape(pa12, sizes)).toMatchObject({ found: '380 × 276 × 360', numbers: [380, 276, 360] })
    // a table cell's number is whole: "360" and the next cell's "5" are two numbers, not 3605
    expect(sameShape(pa12, 'PA12 370 × 276 × 360 5 × 5 × 5')).toMatchObject({ found: '370 × 276 × 360' })
  })

  it('writes the updates file deterministically, and the table refuses a figure it cannot apply', () => {
    const u: CapabilityUpdates = { checked: '2026-12-01', figures: { 'wall_by_size.SLA': { text: '0.5mm 0.8mm 1.0mm 1.5mm 2.5mm', read: '2026-12-01' }, 'general.lead_time': { text: '48h-96h', read: '2026-12-01' } } }
    const src = renderUpdates(u)
    expect(src.indexOf('"general.lead_time"')).toBeLessThan(src.indexOf('"wall_by_size.SLA"'))
    expect(src).toContain('checked: "2026-12-01"')
    expect(renderUpdates({ checked: null, figures: {} })).toContain('figures: {},')
    expect(() => withUpdates(BASE_CAPABILITIES, { checked: null, figures: { 'cnc.corner_radius': { text: 'R=(H/8)+0.5', read: 'x' } } })).toThrow(/no figure/)
  })
})

describe('builds and the capability table', () => {
  it('a date moved on leaves a build current; a changed figure makes it stale', () => {
    const was = { capabilities_checked: CAPABILITIES.checked, capabilities_sha256: capabilitiesStamp() }
    const reverified = withUpdates(BASE_CAPABILITIES, { checked: days(40), figures: {} })
    expect(reverified.checked).toBe(days(40))
    expect(staleReasons(was, { capabilities_checked: reverified.checked, capabilities_sha256: capabilitiesStamp(reverified) })).toEqual([])
    const changed = withUpdates(BASE_CAPABILITIES, { checked: days(40), figures: { 'wall_by_size.MJF': { text: '1.0mm 1.2mm 1.6mm 2.0mm 2.0mm', read: days(40) } } })
    const reasons = staleReasons(was, { capabilities_checked: changed.checked, capabilities_sha256: capabilitiesStamp(changed) })
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/process capabilities changed/)
  })

  it('every figure with an apply accepts its own stored numbers without changing the table', () => {
    for (const f of BASE_FIGURES.filter((x) => x.apply)) {
      const c = structuredClone(BASE_CAPABILITIES)
      f.apply!(c, numbersIn(f.text))
      expect(JSON.stringify(c), f.id).toBe(JSON.stringify(BASE_CAPABILITIES))
    }
  })
})

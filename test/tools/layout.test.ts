/**
 * pcb.placement_check, pcb.length_match and pcb.floorplan on a synthetic board built to trip every check, on the
 * sensor-node example board (a finished design: no errors expected), and the geometry underneath.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { capacitanceUf, diffPairs, druRules } from '../../src/tools/layout/checks.js'
import { arcPoints, area, clip, hull, inside, loops, overlapArea, overlaps, rectPoly } from '../../src/tools/layout/geom.js'
import { pointInPolygon, polygonOverlapArea, polygonsOverlap, segmentsCross, triangulate } from '../../src/tools/pcb/geometry.js'
import { readLayout } from '../../src/tools/layout/board.js'
import { allTools } from '../../src/tools/index.js'

type Dict = Record<string, unknown>
const reg = allTools()
const call = async (name: string, args: Dict): Promise<Dict> => (await reg.call(name, args, { hardware: false, via: 'test' })) as Dict
const SENSOR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'sensor-node', 'hardware', 'sensor-node.kicad_pcb')

let n = 0
const uid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

interface Fp { ref: string; value: string; x: number; y: number; cy: number; cx?: number; sheet: string; pads: { num: string; x: number; y: number; net: string }[]; side?: 'F' | 'B'; noCourtyard?: boolean }

function boardText(fps: Fp[], extra: string, nets: string[]): string {
  const code = new Map(nets.map((m, i) => [m, i + 1]))
  const fp = (f: Fp): string => {
    const s = f.side ?? 'F'
    const cx = f.cx ?? f.cy
    return `\t(footprint "test:${f.ref}" (layer "${s}.Cu") (uuid "${uid()}") (at ${f.x} ${f.y})
\t\t(property "Reference" "${f.ref}" (at 0 0) (layer "${s}.SilkS") (uuid "${uid()}") (effects (font (size 1 1))))
\t\t(property "Value" "${f.value}" (at 0 0) (layer "${s}.Fab") (uuid "${uid()}") (effects (font (size 1 1))))
\t\t(path "/${uid()}") (sheetname "${f.sheet}") (sheetfile "x.kicad_sch")
\t\t(attr smd)
${f.noCourtyard ? '' : `\t\t(fp_rect (start ${-cx} ${-f.cy}) (end ${cx} ${f.cy}) (stroke (width 0.05) (type solid)) (fill no) (layer "${s}.CrtYd") (uuid "${uid()}"))\n`}${f.pads.map((p) => `\t\t(pad "${p.num}" smd rect (at ${p.x} ${p.y}) (size 0.6 0.6) (layers "${s}.Cu" "${s}.Mask") (net ${code.get(p.net)} "${p.net}") (uuid "${uid()}"))`).join('\n')}
\t)`
  }
  return `(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0")
\t(general (thickness 1.6))
\t(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user) (31 "F.CrtYd" user) (29 "B.CrtYd" user))
\t(setup (stackup (layer "F.Cu" (type "copper") (thickness 0.035)) (layer "dielectric 1" (type "core") (thickness 1.5) (material "FR4") (epsilon_r 4.5)) (layer "B.Cu" (type "copper") (thickness 0.035))))
\t(net 0 "")
${nets.map((m) => `\t(net ${code.get(m)} "${m}")`).join('\n')}
${fps.map(fp).join('\n')}
${extra.replaceAll('NET:', '').replace(/\(net "([^"]+)"\)/g, (_m, name: string) => `(net ${code.get(name)})`)}
\t(gr_rect (start 0 0) (end 50 40) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "${uid()}"))
)
`
}

const seg = (x1: number, y1: number, x2: number, y2: number, net: string): string => `\t(segment (start ${x1} ${y1}) (end ${x2} ${y2}) (width 0.2) (layer "F.Cu") (net "${net}") (uuid "${uid()}"))`

const dir = mkdtempSync(join(tmpdir(), 'layout-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fixture(): string {
  const nets = ['+3V3', 'GND', 'USB_D+', 'USB_D-', 'SIG']
  const fps: Fp[] = [
    { ref: 'U1', value: 'MCU', x: 20, y: 20, cy: 3, sheet: '/MCU/', pads: [{ num: '1', x: -2, y: -2, net: '+3V3' }, { num: '2', x: 2, y: 2, net: 'GND' }, { num: '3', x: 2, y: -2, net: 'USB_D+' }, { num: '4', x: 2, y: -1, net: 'USB_D-' }, { num: '5', x: -2, y: 2, net: '+3V3' }] },
    { ref: 'C1', value: '100n', x: 28, y: 26, cy: 1, sheet: '/MCU/', pads: [{ num: '1', x: -0.5, y: 0, net: '+3V3' }, { num: '2', x: 0.5, y: 0, net: 'GND' }] },
    { ref: 'C2', value: '1u', x: 16, y: 17, cy: 0.8, sheet: '/MCU/', pads: [{ num: '1', x: -0.5, y: 0, net: '+3V3' }, { num: '2', x: 0.5, y: 0, net: 'GND' }] },
    { ref: 'C3', value: '10n', x: 8, y: 8, cy: 0.8, sheet: '/', pads: [{ num: '1', x: -0.5, y: 0, net: 'SIG' }, { num: '2', x: 0.5, y: 0, net: 'GND' }] },
    { ref: 'R1', value: '10k', x: 23.5, y: 20, cy: 1, sheet: '/', pads: [{ num: '1', x: -0.5, y: 0, net: 'SIG' }, { num: '2', x: 0.5, y: 0, net: 'GND' }] },
    { ref: 'R2', value: '10k', x: 49.5, y: 10, cy: 1, sheet: '/', pads: [{ num: '1', x: -0.5, y: 0, net: 'SIG' }, { num: '2', x: 0.5, y: 0, net: 'GND' }] },
    { ref: 'R3', value: '10k', x: 35, y: 34, cy: 1, sheet: '/', pads: [{ num: '1', x: -0.5, y: 0, net: 'SIG' }, { num: '2', x: 0.5, y: 0, net: 'GND' }] },
    { ref: 'R4', value: '10k', x: 10, y: 30, cy: 1, sheet: '/', noCourtyard: true, pads: [{ num: '1', x: -0.5, y: 0, net: 'SIG' }, { num: '2', x: 0.5, y: 0, net: 'GND' }] },
    { ref: 'J1', value: 'USB', x: 25, y: 37, cy: 2, cx: 4, sheet: '/IO/', pads: [{ num: '1', x: 0, y: 0, net: 'USB_D+' }, { num: '2', x: 1, y: 0, net: 'USB_D-' }] },
    { ref: 'J2', value: 'HDR', x: 40, y: 18, cy: 2, sheet: '/IO/', pads: [{ num: '1', x: 0, y: 0, net: 'SIG' }, { num: '2', x: 0, y: 1, net: 'GND' }] },
  ]
  // USB_D+ from U1.3 (22,18) to J1.1 (25,37): 3 + 19 = 22 mm; USB_D- from U1.4 (22,19) to J1.2 (26,37): 4 + 18 + 0.5 detour each way
  const extra = [
    seg(22, 18, 25, 18, 'USB_D+'), seg(25, 18, 25, 37, 'USB_D+'),
    seg(22, 19, 26, 19, 'USB_D-'), seg(26, 19, 26.25, 19.25, 'USB_D-'), seg(26.25, 19.25, 26, 19.5, 'USB_D-'), seg(26, 19.5, 26, 37, 'USB_D-'),
    `\t(zone (net 0) (net_name "") (layers "F.Cu" "B.Cu") (uuid "${uid()}") (name "antenna") (hatch edge 0.5)
\t\t(keepout (tracks not_allowed) (vias not_allowed) (pads not_allowed) (copperpour not_allowed) (footprints not_allowed))
\t\t(polygon (pts (xy 30 30) (xy 40 30) (xy 40 38) (xy 30 38))))`,
  ].join('\n')
  const pcb = join(dir, 'board.kicad_pcb')
  writeFileSync(pcb, boardText(fps, extra, nets))
  writeFileSync(join(dir, 'board.kicad_pro'), JSON.stringify({ meta: { filename: 'board.kicad_pro', version: 3 }, net_settings: { classes: [{ name: 'Default' }, { name: 'USB' }], netclass_patterns: [{ netclass: 'USB', pattern: 'USB_*' }] } }))
  writeFileSync(join(dir, 'board.kicad_dru'), '(version 1)\n(rule "usb skew"\n  (constraint skew (max 0.2mm))\n  (condition "A.NetClass == \'USB\'"))\n(rule "odd" (constraint length (max 5mm)) (condition "A.Type == \'track\'"))\n')
  return pcb
}

describe('geometry', () => {
  it('hulls, clips and measures polygons', () => {
    expect(area(hull([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1]]))).toBe(4)
    expect(overlapArea(rectPoly(0, 0, 2, 2), rectPoly(1, 1, 3, 3))).toBeCloseTo(1, 9)
    expect(overlapArea(rectPoly(0, 0, 1, 1), rectPoly(2, 2, 3, 3))).toBe(0)
    expect(area(clip(rectPoly(0, 0, 4, 4), [[2, -1], [5, 2], [2, 5], [-1, 2]]))).toBeCloseTo(14, 6)
    expect(inside([1, 1], rectPoly(0, 0, 2, 2))).toBe(true)
    expect(inside([3, 1], rectPoly(0, 0, 2, 2))).toBe(false)
  })

  it('joins edge segments into loops and samples arcs', () => {
    const sq = rectPoly(0, 0, 10, 10)
    const segs = sq.map((p, i) => [p, sq[(i + 1) % 4]] as [[number, number], [number, number]])
    const ls = loops([segs[2] as never, segs[0] as never, segs[3] as never, segs[1] as never])
    expect(ls).toHaveLength(1)
    expect(area(ls[0] as never)).toBe(100)
    const arc = arcPoints([1, 0], [0, 1], [-1, 0], 4)
    expect(arc[2]?.[0]).toBeCloseTo(0, 9)
    expect(arc[2]?.[1]).toBeCloseTo(1, 9)
  })

  it('reads capacitor values, pairs and design rules', () => {
    expect(capacitanceUf('100n')).toBeCloseTo(0.1)
    expect(capacitanceUf('4.7uF')).toBeCloseTo(4.7)
    expect(capacitanceUf('2u2')).toBeCloseTo(2.2)
    expect(capacitanceUf('10µF 16V')).toBeCloseTo(10)
    expect(capacitanceUf('100p')).toBeCloseTo(1e-4)
    expect(capacitanceUf('MCU')).toBeNull()
    expect(diffPairs(['/USB_D+', '/USB_D-', 'LVDS_P', 'LVDS_N', 'VIN', 'EN'])).toEqual([{ p: '/USB_D+', n: '/USB_D-' }, { p: 'LVDS_P', n: 'LVDS_N' }])
    const d = druRules('(version 1)\n(rule "a" (constraint skew (max 5mil)) (condition "A.inDiffPair(\'/USB*\')"))\n(rule "b" (constraint clearance (min 0.2mm)) (condition "A.NetClass == \'X\'"))')
    expect(d.rules).toHaveLength(1)
    expect(d.rules[0]?.skew_max_mm).toBeCloseTo(0.127)
    expect(d.rules[0]?.match('/USB_D+', null, true)).toBe(true)
    expect(d.rules[0]?.match('/USB_D+', null, false)).toBe(false)
  })
})

/** An L-shaped courtyard (6 fp_lines; 4×4 with the top-right 2×2 notch cut out), as KiCad draws one, around (0,0). */
const L_LINES = [[-2, -2, 0, -2], [0, -2, 0, 0], [0, 0, 2, 0], [2, 0, 2, 2], [2, 2, -2, 2], [-2, 2, -2, -2]]
  .map(([a, b, c, d]) => `\t\t(fp_line (start ${a} ${b}) (end ${c} ${d}) (stroke (width 0.05) (type solid)) (layer "F.CrtYd") (uuid "${uid()}"))`)

function lBoard(name: string, lines: string[]): string {
  const fp = (ref: string, x: number, y: number, body: string): string => `\t(footprint "test:${ref}" (layer "F.Cu") (uuid "${uid()}") (at ${x} ${y})
\t\t(property "Reference" "${ref}" (at 0 0) (layer "F.SilkS") (uuid "${uid()}") (effects (font (size 1 1))))
\t\t(property "Value" "x" (at 0 0) (layer "F.Fab") (uuid "${uid()}") (effects (font (size 1 1))))
\t\t(attr smd)
${body}
\t\t(pad "1" smd rect (at 0 0) (size 0.5 0.5) (layers "F.Cu") (net 1 "N") (uuid "${uid()}"))
\t)`
  const rect = (x0: number, y0: number, x1: number, y1: number): string => `\t\t(fp_rect (start ${x0} ${y0}) (end ${x1} ${y1}) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd") (uuid "${uid()}"))`
  const text = `(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0")
\t(general (thickness 1.6))
\t(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user) (31 "F.CrtYd" user))
\t(net 0 "")
\t(net 1 "N")
${fp('U1', 20, 20, lines.join('\n'))}
${fp('C1', 21, 19, rect(-0.8, -0.8, 0.8, 0.8))}
${fp('C2', 18.5, 21.5, rect(-0.75, -0.75, 0.75, 0.75))}
\t(gr_rect (start 0 0) (end 50 40) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "${uid()}"))
)
`
  const f = join(dir, `${name}.kicad_pcb`)
  writeFileSync(f, text)
  return f
}

describe('courtyard polygons', () => {
  it('overlaps concave polygons exactly, and tells touching from crossing', () => {
    const L: [number, number][] = [[-2, -2], [0, -2], [0, 0], [2, 0], [2, 2], [-2, 2]]
    expect(area(L)).toBe(12)
    expect(triangulate(L).reduce((s, t) => s + area(t as never), 0)).toBeCloseTo(12, 9)
    const notch = rectPoly(0.2, -1.8, 1.8, -0.2) // in the L's hull, outside the L
    expect(overlapArea(L, notch)).toBeCloseTo(0, 9)
    expect(overlaps(L, notch)).toBe(false)
    expect(area(clip(notch, hull(L)))).toBeGreaterThan(1) // the hull would call it an overlap
    expect(polygonOverlapArea(L, rectPoly(-1, -1, 1, 1))).toBeCloseTo(3, 9)
    expect(polygonsOverlap(rectPoly(0, 0, 1, 1), rectPoly(1, 0, 2, 1))).toBe(false) // a shared edge only
    expect(polygonsOverlap(rectPoly(0, 0, 4, 4), rectPoly(1, 1, 2, 2))).toBe(true) // containment, no crossing
    expect(polygonsOverlap(rectPoly(0, 0, 1, 1), rectPoly(0, 0, 1, 1))).toBe(true) // the same outline
    expect(segmentsCross([0, 0], [2, 2], [0, 2], [2, 0])).toBe(true)
    expect(segmentsCross([0, 0], [1, 0], [1, 0], [2, 0])).toBe(false)
    expect(pointInPolygon([0, 1], rectPoly(0, 0, 2, 2))).toBe('on')
    expect(pointInPolygon([1, -1], L)).toBe('out')
  })

  it('reads an L-shaped courtyard as an L, and finds only the real overlap', async () => {
    const pcb = lBoard('l-closed', L_LINES)
    const lay = readLayout(pcb)
    const u1 = lay.footprints.find((f) => f.ref === 'U1')
    expect(u1?.courtyard_from).toBe('courtyard')
    expect(u1?.courtyards).toHaveLength(1)
    expect(area(u1?.courtyard ?? [])).toBeCloseTo(12, 6)
    const r = await call('pcb.placement_check', { project: pcb, decap_max_mm: 100, connector_refs: '^$', edge_clearance_mm: 0 })
    const ov = (r.findings as { check: string; refs: string[]; value_mm?: number; message: string }[]).filter((f) => f.check === 'courtyard_overlap')
    // C1 sits in the notch (inside the hull, outside the L): no overlap. C2 overlaps the L's lower-left arm.
    expect(ov.map((f) => f.refs)).toEqual([['C2', 'U1']])
    // C2 spans 17.75..19.25 × 20.75..22.25 against the L's lower-left corner at 18, 22: 1.25 × 1.25
    expect(ov[0]?.value_mm).toBeCloseTo(1.5625, 3)
  })

  it('falls back to the hull when the outline does not close, and says so', async () => {
    const pcb = lBoard('l-open', L_LINES.slice(0, -1)) // the last edge missing
    const lay = readLayout(pcb)
    const u1 = lay.footprints.find((f) => f.ref === 'U1')
    expect(u1?.courtyard_from).toBe('hull')
    expect(u1?.courtyard_note).toMatch(/does not close/)
    const r = await call('pcb.placement_check', { project: pcb, decap_max_mm: 100, connector_refs: '^$', edge_clearance_mm: 0 })
    const f = r.findings as { check: string; refs: string[]; message: string }[]
    const ov = f.filter((x) => x.check === 'courtyard_overlap')
    expect(ov.map((x) => x.refs.join()).sort()).toEqual(['C1,U1', 'C2,U1'])
    expect(ov.every((x) => /convex hull/.test(x.message))).toBe(true)
    expect(f.find((x) => x.check === 'courtyard_open')?.refs).toEqual(['U1'])
  })
})

describe('pcb.placement_check', () => {
  it('finds every planted problem', async () => {
    const r = await call('pcb.placement_check', { project: fixture() })
    expect(r.passed).toBe(false)
    const f = r.findings as { check: string; refs: string[]; value_mm?: number }[]
    const of = (c: string): string[][] => f.filter((x) => x.check === c).map((x) => x.refs)
    expect(of('courtyard_overlap')).toEqual([['R1', 'U1']])
    expect(of('outside_edge')).toEqual([['R2']])
    expect(of('keepout')).toEqual([['R3']])
    expect(of('decoupling_distance')).toEqual([['C1', 'U1']])
    expect(of('connector_not_at_edge')).toEqual([['J2']])
    expect(of('no_courtyard')).toEqual([['R4']])
    // C2 is within 3 mm of U1.1; U1.5, the other +3V3 pin, has none (C2 is 5.6 mm away, C1 farther)
    expect(f.filter((x) => x.check === 'power_pin_without_decoupling').map((x) => (x as unknown as { message: string }).message)).toEqual([expect.stringMatching(/^U1\.5 \(\+3V3\)/)])
    const dec = r.decoupling as { cap: string; ok: boolean | null }[]
    expect(dec.map((d) => [d.cap, d.ok])).toEqual([['C1', false], ['C2', true]]) // C3 is on a signal: not decoupling
    const fine = await call('pcb.placement_check', { project: join(dir, 'board.kicad_pcb'), ignore: ['R*'], interior_connectors: ['J2'], decap_max_mm: 10 })
    expect(fine.passed).toBe(true)
  })

  it('is clean on the finished sensor-node board', async () => {
    const r = await call('pcb.placement_check', { project: SENSOR })
    expect(r.passed).toBe(true)
    expect(r.counts).toEqual({})
    expect((r.connectors as { ok: boolean }[]).every((c) => c.ok)).toBe(true)
  })
})

describe('pcb.length_match', () => {
  it('checks the diff pair against the .kicad_dru skew rule, and groups against a tolerance', async () => {
    const r = await call('pcb.length_match', { project: fixture(), groups: [{ name: 'usb', nets: ['USB_*'], tolerance_mm: 2 }] })
    const pairs = r.pairs as { p: string; skew_mm: number; tolerance_mm: number; tolerance_from: string; status: string; net_class: string }[]
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ p: 'USB_D+', net_class: 'USB', tolerance_mm: 0.2, tolerance_from: 'rule usb skew', status: 'fail' })
    // D+ 3 + 19 = 22; D- 4 + 2·0.3536 + 17.5 = 22.207
    expect(pairs[0]?.skew_mm).toBeCloseTo(0.207, 3)
    expect((r.groups as { status: string; spread_mm: number }[])[0]).toMatchObject({ status: 'pass' })
    expect(r.dru_skipped).toEqual([expect.stringMatching(/odd/)])
    const loose = await call('pcb.length_match', { project: join(dir, 'board.kicad_pcb'), max_skew_mm: 0.25 })
    expect((loose.pairs as { status: string }[])[0]?.status).toBe('pass')
  })
})

describe('pcb.floorplan', () => {
  it('groups by sheet, with boxes, overlaps and inter-block nets', async () => {
    const r = await call('pcb.floorplan', { project: fixture() })
    const blocks = r.blocks as { name: string; count: number; bbox: number[] }[]
    expect(blocks.map((b) => [b.name, b.count])).toEqual([['/', 5], ['/IO/', 2], ['/MCU/', 3]])
    expect((r.connections as { a: string; b: string; nets: number }[]).find((c) => c.a === '/IO/' && c.b === '/MCU/')?.nets).toBe(2) // USB_D+ and USB_D-
    expect((r.board as { area_mm2: number }).area_mm2).toBe(2000)
    const given = await call('pcb.floorplan', { project: join(dir, 'board.kicad_pcb'), blocks: [{ name: 'usb', refs: ['U1', 'J1'] }] })
    expect((given.blocks as { name: string; count: number }[])).toEqual([expect.objectContaining({ name: 'usb', count: 2 })])
    expect((given.unassigned as string[]).length).toBe(8)
  })
})

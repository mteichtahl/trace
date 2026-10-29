/**
 * Board facts for the enclosure engine (src/tools/mech/board.ts) from the sample board and from synthetic boards that
 * use every kind of Edge.Cuts item, and the height table (src/tools/mech/heights.ts).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { boardFacts, edgeLoops, nearestSide, sampleArc } from '../../../src/tools/mech/board.js'
import { DEFAULT_HEIGHT_MM, heightField, partHeight } from '../../../src/tools/mech/heights.js'
import { area } from '../../../src/tools/layout/geom.js'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const SAMPLE = join(ROOT, 'templates', 'sample', 'hardware', 'trace-sample.kicad_pcb')
const dir = mkdtempSync(join(tmpdir(), 'mech-board-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('board facts of the sample board', () => {
  const f = boardFacts(SAMPLE, ROOT)

  it('names the board by its repository path, with its hash and thickness', () => {
    expect(f.version).toBe(1)
    expect(f.board).toBe('templates/sample/hardware/trace-sample.kicad_pcb')
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(f.thickness_mm).toBe(1.6)
  })

  it('closes the outline loop: the 60 × 40 mm gr_rect, no cutouts', () => {
    expect(f.outline).toHaveLength(4)
    expect(area(f.outline)).toBeCloseTo(60 * 40, 6)
    const xs = f.outline.map((p) => p[0])
    const ys = f.outline.map((p) => p[1])
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([100, 160, 100, 140])
    expect(f.cutouts).toEqual([])
  })

  it('lists the header pins as plated holes and no mounting holes (the sample has none)', () => {
    expect(f.holes.length).toBe(16) // J1 2 + J2 8 + J3 6
    expect(f.holes.every((h) => h.kind === 'pth' && h.d === 1)).toBe(true)
    expect(new Set(f.holes.map((h) => h.ref))).toEqual(new Set(['J1', 'J2', 'J3']))
  })

  it('boxes each part by its courtyard, in board coordinates', () => {
    expect(f.parts).toHaveLength(17)
    expect(f.parts.every((p) => p.box_source === 'courtyard')).toBe(true)
    const u1 = f.parts.find((p) => p.ref === 'U1')!
    expect(u1.footprint).toBe('Package_TO_SOT_SMD:SOT-223-3_TabPin2')
    expect(u1.box.min_x).toBeLessThan(u1.x)
    expect(u1.box.max_x).toBeGreaterThan(u1.x)
    expect(u1.box).toEqual({ min_x: 107.6, min_y: 123.4, max_x: 116.4, max_y: 130.6 })
  })

  it('gives each part a height with its source, and leads below for through-hole parts', () => {
    const by = Object.fromEntries(f.parts.map((p) => [p.ref, p]))
    expect(by.U1).toMatchObject({ height_mm: 1.8, height_source: 'table', below_mm: 0, mount: 'smd' })
    expect(by.R1).toMatchObject({ height_mm: 0.55, height_source: 'table' })
    expect(by.J2).toMatchObject({ height_mm: 11, height_source: 'table', mount: 'through_hole', below_mm: 2, connector: true })
    expect(f.parts.some((p) => p.height_source === 'default')).toBe(false)
    expect(f.warnings).toEqual([])
  })

  it('marks connectors at the outline, by compass side', () => {
    const j1 = f.parts.find((p) => p.ref === 'J1')!
    expect(j1.edge).toEqual({ side: 'west', distance_mm: 1.23 })
    expect(f.parts.find((p) => p.ref === 'J3')!.edge).toBeNull()
    expect(f.parts.find((p) => p.ref === 'R1')!.connector).toBe(false)
  })
})

describe('Edge.Cuts loops', () => {
  const wrap = (body: string): string => `(kicad_pcb (version 20241229) (generator "pcbnew")
\t(general (thickness 1.2))
\t(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user) (31 "F.CrtYd" user))
${body}
)`

  it('chains lines and arcs end to end, samples arcs every 0.5 mm, and keeps inner loops as cutouts', () => {
    // a 50 × 40 board with rounded corners of radius 3 (lines and arcs), a 10 × 6 slot (gr_rect) and a 3.2 mm hole circle
    const r = 3
    const L = (a: [number, number], b: [number, number]): string => `(gr_line (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (layer "Edge.Cuts"))`
    const A = (s: [number, number], m: [number, number], e: [number, number]): string => `(gr_arc (start ${s[0]} ${s[1]}) (mid ${m[0]} ${m[1]}) (end ${e[0]} ${e[1]}) (layer "Edge.Cuts"))`
    const k = r - r / Math.SQRT2
    const body = [
      L([r, 0], [50 - r, 0]), A([50 - r, 0], [50 - k, k], [50, r]),
      L([50, r], [50, 40 - r]), A([50, 40 - r], [50 - k, 40 - k], [50 - r, 40]),
      // the bottom edge drawn reversed, with an end 0.004 mm off, to test the join tolerance
      L([r + 0.004, 40], [50 - r, 40]), A([r, 40], [k, 40 - k], [0, 40 - r]),
      L([0, 40 - r], [0, r]), A([0, r], [k, k], [r, 0]),
      '(gr_rect (start 20 10) (end 30 16) (layer "Edge.Cuts"))',
      '(gr_circle (center 40 30) (end 41.6 30) (layer "Edge.Cuts"))',
    ].join('\n')
    const loops = edgeLoops(wrap(body))
    expect(loops).toHaveLength(3)
    const outer = loops[0]!
    expect(area(outer)).toBeCloseTo(50 * 40 - (4 - Math.PI) * r * r, 0)
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i]!
      const b = outer[(i + 1) % outer.length]!
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (len < 40 - 2 * r - 0.1) expect(len).toBeLessThanOrEqual(0.5 + 1e-9)
    }
    expect(area(loops[1]!)).toBeCloseTo(60, 6)
    expect(area(loops[2]!)).toBeCloseTo(Math.PI * 1.6 * 1.6, 0)

    const pcb = join(dir, 'rounded.kicad_pcb')
    writeFileSync(pcb, wrap(body))
    const f = boardFacts(pcb, dir)
    expect(f.board).toBe('rounded.kicad_pcb')
    expect(f.thickness_mm).toBe(1.2)
    expect(f.cutouts).toHaveLength(2)
    expect(f.parts).toEqual([])
  })

  it('samples an arc within the step, ends included', () => {
    const pts = sampleArc([10, 0], [0, 10], [-10, 0])
    expect(pts[0]).toEqual([10, 0])
    expect(pts.at(-1)).toEqual([-10, 0])
    expect(pts.length - 1).toBeGreaterThanOrEqual(Math.ceil((Math.PI * 10) / 0.5))
  })

  it('refuses a board with no closed outline', () => {
    const pcb = join(dir, 'open.kicad_pcb')
    writeFileSync(pcb, wrap('(gr_line (start 0 0) (end 10 0) (layer "Edge.Cuts"))\n(gr_line (start 10 0) (end 10 10) (layer "Edge.Cuts"))'))
    expect(() => boardFacts(pcb, dir)).toThrow(/no closed outline on Edge.Cuts/)
  })

  it('reads mounting holes, npth, heights from fields and defaults, pads boxes, DNP and the bottom side', () => {
    const fp = (ref: string, name: string, at: string, inner: string, layer = 'F.Cu'): string => `(footprint "${name}" (layer "${layer}") (at ${at})
\t(property "Reference" "${ref}" (at 0 0) (layer "F.SilkS"))
\t(property "Value" "v" (at 0 0) (layer "F.Fab"))
${inner}
)`
    const body = [
      '(gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts"))',
      fp('H1', 'MountingHole:MountingHole_3.2mm_M3_Pad', '3.5 3.5', '(attr exclude_from_pos_files)\n(pad "1" thru_hole circle (at 0 0) (size 6 6) (drill 3.2) (layers "*.Cu" "*.Mask"))'),
      fp('H2', 'test:Tooling', '36.5 3.5', '(pad "" np_thru_hole circle (at 0 0) (size 2 2) (drill 2) (layers "*.Cu" "*.Mask"))'),
      // a USB-C at the south edge, rotated 180°, courtyard in footprint coordinates
      fp('J1', 'Connector_USB:USB_C_Receptacle_GCT_USB4105', '20 28 180', '(attr smd)\n(fp_rect (start -4.5 -2) (end 4.5 2.5) (layer "F.CrtYd"))\n(pad "A1" smd rect (at -1 0) (size 0.6 1) (layers "F.Cu"))'),
      fp('U1', 'custom:BIGTHING', '15 15', '(property "Height" "12.5 mm" (at 0 0) (layer "F.Fab"))\n(attr smd)\n(pad "1" smd rect (at -2 0) (size 1 1) (layers "F.Cu"))\n(pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu"))'),
      fp('U2', 'custom:MYSTERY', '25 15', '(attr smd)\n(pad "1" smd rect (at 0 0) (size 1 1) (layers "B.Cu"))', 'B.Cu'),
      fp('U3', 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', '30 20', '(attr smd dnp)\n(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))'),
    ].join('\n')
    const pcb = join(dir, 'parts.kicad_pcb')
    writeFileSync(pcb, wrap(body))
    const f = boardFacts(pcb, dir)
    expect(f.holes).toEqual([
      { x: 3.5, y: 3.5, d: 3.2, kind: 'mounting', ref: 'H1' },
      { x: 36.5, y: 3.5, d: 2, kind: 'npth', ref: 'H2' },
    ])
    const by = Object.fromEntries(f.parts.map((p) => [p.ref, p]))
    expect(Object.keys(by).sort()).toEqual(['J1', 'U1', 'U2']) // H1 is a mounting hole and H2 only a non-plated hole: holes, not parts; U3 is DNP
    expect(by.J1).toMatchObject({ connector: true, height_mm: 3.3, height_source: 'table', box_source: 'courtyard', edge: { side: 'south', distance_mm: 0 } })
    // rotated 180°: local y -2..2.5 becomes board y 25.5..30
    expect(by.J1!.box).toEqual({ min_x: 15.5, min_y: 25.5, max_x: 24.5, max_y: 30 })
    expect(by.U1).toMatchObject({ height_mm: 12.5, height_source: 'field', box_source: 'pads', connector: false, edge: null })
    expect(by.U1!.box).toEqual({ min_x: 12.25, min_y: 14.25, max_x: 17.75, max_y: 15.75 })
    expect(by.U2).toMatchObject({ side: 'bottom', height_mm: DEFAULT_HEIGHT_MM, height_source: 'default' })
    expect(f.warnings).toEqual(['U2 (MYSTERY) has no Height field and no table entry: assumed 5 mm'])
  })
})

describe('heights', () => {
  it('reads a Height field with or without mm, and nothing else', () => {
    expect(heightField('3.3')).toBe(3.3)
    expect(heightField('3,3 mm')).toBe(3.3)
    expect(heightField(' 4mm ')).toBe(4)
    expect(heightField('tall')).toBeNull()
    expect(heightField('3 in')).toBeNull()
  })
  it('takes the field first, then the table, then the default', () => {
    expect(partHeight('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', { Height: '2' })).toMatchObject({ height_mm: 2, source: 'field' })
    expect(partHeight('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', {})).toMatchObject({ height_mm: 1.75, source: 'table' })
    expect(partHeight('Capacitor_SMD:CP_Elec_6.3x5.8', {})).toMatchObject({ height_mm: 6.1, source: 'table' })
    expect(partHeight('Capacitor_THT:CP_Radial_D8.0mm_P3.50mm', {})).toMatchObject({ height_mm: 17, source: 'table' })
    expect(partHeight('Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Horizontal', {})).toMatchObject({ height_mm: 2.5 })
    expect(partHeight('Package_TO_SOT_THT:TO-220-3_Vertical', {})).toMatchObject({ height_mm: 20 })
    expect(partHeight('Crystal:Crystal_HC49-4H_Vertical', {})).toMatchObject({ height_mm: 4.2 })
    expect(partHeight('Connector_JST:JST_PH_B2B-PH-K_1x02_P2.00mm_Vertical', {})).toMatchObject({ height_mm: 6 })
    expect(partHeight('Button_Switch_SMD:SW_SPST_TL3342', {})).toMatchObject({ height_mm: 2 })
    expect(partHeight('x:unknown', {})).toMatchObject({ height_mm: DEFAULT_HEIGHT_MM, source: 'default' })
  })
  it('finds the nearest outline side within 1.5 mm', () => {
    const o = { min_x: 0, min_y: 0, max_x: 50, max_y: 40 }
    expect(nearestSide({ min_x: 10, min_y: 38, max_x: 20, max_y: 40 }, o)).toEqual({ side: 'south', distance_mm: 0 })
    expect(nearestSide({ min_x: 1, min_y: 10, max_x: 5, max_y: 20 }, o)).toEqual({ side: 'west', distance_mm: 1 })
    expect(nearestSide({ min_x: 10, min_y: 10, max_x: 20, max_y: 20 }, o)).toBeNull()
  })
})

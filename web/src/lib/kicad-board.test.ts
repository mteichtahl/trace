import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { arcPoints, maskHex, readBoard, toBoard } from './kicad-board'

const soil = readFileSync(resolve(__dirname, '../mock/files/soil-sensor.kicad_pcb'), 'utf8')
const sensor = readFileSync(resolve(__dirname, '../../../examples/sensor-node/hardware/sensor-node.kicad_pcb'), 'utf8')

describe('readBoard', () => {
  it('reads the outline, thickness, parts and copper of the mock board', () => {
    const b = readBoard(soil)
    expect(b.thickness).toBe(1.6)
    expect(b.bounds).toEqual({ minX: 0, minY: 0, maxX: 50, maxY: 30 })
    expect(b.copperLayers).toBe(4)
    expect(b.footprints.map((f) => f.ref)).toEqual(['R1', 'R2', 'C1', 'R101'])
    expect(b.footprints.find((f) => f.ref === 'R101')!.side).toBe('B')
    expect(b.tracks).toHaveLength(6)
    expect(b.tracks.filter((t) => t.mid)).toHaveLength(1)
    expect(b.vias).toHaveLength(2)
    expect(b.notes).toEqual([])
  })

  it('places a turned footprint\'s pads on the board', () => {
    const c1 = readBoard(soil).footprints.find((f) => f.ref === 'C1')!
    // C1 is at (30, 10) turned 90°: its pads at x = ±0.5 land above and below it
    const ys = c1.pads.map((p) => Math.round(p.at[1] * 100) / 100).sort((a, b) => a - b)
    expect(ys).toEqual([9.5, 10.5])
    expect(c1.pads.every((p) => Math.abs(p.at[0] - 30) < 1e-9)).toBe(true)
  })

  it('reads the sample project: headers with holes, silkscreen and a ground pour', () => {
    const b = readBoard(sensor)
    expect(b.bounds).toEqual({ minX: 100, minY: 100, maxX: 140, maxY: 125 })
    expect(b.footprints).toHaveLength(10)
    const j2 = b.footprints.find((f) => f.ref === 'J2')!
    expect(j2.pads).toHaveLength(4)
    expect(j2.pads.every((p) => p.drill === 1 && p.sides.includes('F') && p.sides.includes('B'))).toBe(true)
    expect(b.texts.some((t) => t.text === 'SENSOR NODE rev A')).toBe(true)
  })

  it('refuses a file that is not a board', () => {
    expect(() => readBoard('(kicad_sch (version 1))')).toThrow(/not a KiCad board/)
  })

  it('makes do without an outline', () => {
    const b = readBoard('(kicad_pcb (general (thickness 1.0)) (segment (start 0 0) (end 10 0) (width 0.2) (layer "F.Cu")))')
    expect(b.thickness).toBe(1)
    expect(b.outline).toHaveLength(4)
    expect(b.notes[0]).toMatch(/no outline/)
  })

  it('chains edge lines and arcs into one outline', () => {
    const b = readBoard(`(kicad_pcb
      (gr_line (start 0 0) (end 10 0) (layer "Edge.Cuts"))
      (gr_arc (start 10 0) (mid 12 2) (end 10 4) (layer "Edge.Cuts"))
      (gr_line (start 0 4) (end 10 4) (layer "Edge.Cuts"))
      (gr_line (start 0 4) (end 0 0) (layer "Edge.Cuts"))
      (gr_circle (center 5 2) (end 5.5 2) (layer "Edge.Cuts")))`)
    expect(b.notes).toEqual([])
    expect(b.cutouts).toHaveLength(1)
    expect(b.bounds.maxX).toBeCloseTo(12, 1)
  })
})

describe('geometry', () => {
  it('turns counter-clockwise as KiCad does', () => {
    const [x, y] = toBoard([0, 0], 90, [1, 0])
    expect(x).toBeCloseTo(0)
    expect(y).toBeCloseTo(-1)
  })
  it('draws an arc through its middle', () => {
    const pts = arcPoints([0, 0], [1, 1], [2, 0])
    expect(pts.some(([x, y]) => Math.abs(x - 1) < 0.05 && Math.abs(y - 1) < 0.05)).toBe(true)
  })
  it('names mask colours', () => {
    expect(maskHex('Black')).toBe('#121314')
    expect(maskHex('#11223344')).toBe('#112233')
    expect(maskHex(null)).toBeNull()
  })
})

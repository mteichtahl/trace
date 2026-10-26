import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  arcLength, clearMemo, describeLayer, designRules, layerOf, loadBoard, microstrip, Net, netNames, parseBoard, stackupKnown,
  stripline, striplineSymmetric, viaLength, z0,
} from '../../../src/tools/kicad/pcb.js'
import { DEMO_PCB, DEMO_PRO, hasReal, REAL } from './helpers.js'

describe('closed-form impedance', () => {
  it('air microstrip w/h = 1 is about 126 ohm (Wheeler / Hammerstad-Jensen)', () => {
    const [z, ee] = microstrip(1, 1, 0, 1)
    expect(z).toBeCloseTo(126.5, 0)
    expect(ee).toBeCloseTo(1, 6)
  })

  it('Pozar example 3.7: er 2.2, d 1.27 mm, W/d 3.081 is a 50 ohm line with er_eff 1.87', () => {
    const [z, ee] = microstrip(3.081 * 1.27, 1.27, 0, 2.2)
    expect(z).toBeCloseTo(50, 0)
    expect(ee).toBeCloseTo(1.87, 1)
  })

  it('copper thickness widens the trace and lowers Z0', () => {
    expect(microstrip(0.3, 0.2, 0.035, 4.4)[0]).toBeLessThan(microstrip(0.3, 0.2, 0, 4.4)[0])
  })

  it('IPC-2141A symmetric stripline matches the formula worked by hand', () => {
    // 60/sqrt(4.3) * ln(4*1.0 / (0.67*pi*(0.8*0.2 + 0.035))) = 65.88
    expect(striplineSymmetric(0.2, 1.0, 0.035, 4.3)).toBeCloseTo(65.88, 1)
  })

  it('the asymmetric stripline reduces to the symmetric one when centred', () => {
    expect(stripline(0.15, 0.2, 0.2, 0.0175, 4.2)).toBeCloseTo(striplineSymmetric(0.15, 0.4175, 0.0175, 4.2), 9)
    expect(stripline(0.15, 0.2, 0.6, 0.0175, 4.2)).toBeGreaterThan(stripline(0.15, 0.2, 0.2, 0.0175, 4.2))
  })

  it('rejects impossible geometry', () => {
    expect(() => microstrip(0, 1, 0, 4)).toThrow(RangeError)
  })
})

describe('arcLength', () => {
  it('measures a semicircle and a quarter circle, and falls back to the chord', () => {
    expect(arcLength(20, 10, 22.5, 7.5, 25, 10)).toBeCloseTo(Math.PI * 2.5, 9)
    const r = 3
    expect(arcLength(r, 0, r * Math.SQRT1_2, r * Math.SQRT1_2, 0, r)).toBeCloseTo((Math.PI * r) / 2, 9)
    expect(arcLength(0, 0, 1, 0, 2, 0)).toBe(2)
  })
})

describe('the fixture board (4 layers)', () => {
  const b = parseBoard(DEMO_PCB)

  it('reads the stackup top-down with the dielectrics between copper', () => {
    expect(b.layers.map((l) => l.name)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'])
    expect(stackupKnown(b)).toBe(true)
    const f = layerOf(b, 'F.Cu')
    expect(f.outer).toBe(true)
    expect(f.t).toBeCloseTo(35e-6, 12)
    expect(f.below?.[0]).toBeCloseTo(0.2e-3, 12)
    expect(f.below?.[1]).toBe(4.4)
    expect(f.mask?.[0]).toBeCloseTo(10e-6, 12)
    const in1 = layerOf(b, 'In1.Cu')
    expect(in1.above?.[1]).toBe(4.4)
    expect(in1.below?.[0]).toBeCloseTo(1.065e-3, 12)
    expect(in1.below?.[1]).toBe(4.6)
    expect(viaLength(b, 'F.Cu', 'B.Cu')).toBeCloseTo(1.535e-3, 9)
  })

  it('gives impedance per layer from the closed forms', () => {
    const f = layerOf(b, 'F.Cu')
    expect(z0(f, 0.2e-3)).toBeCloseTo(microstrip(0.2e-3, 0.2e-3, 35e-6, 4.4)[0], 9)
    const d = describeLayer(layerOf(b, 'In1.Cu'), 0.2e-3)
    expect(d.model).toMatch(/IPC-2141A/)
    expect(d.z0_ohm).toBeGreaterThan(30)
    expect(d.z0_ohm).toBeLessThan(60)
  })

  it('reads footprints with board positions, sides and rotated pads', () => {
    expect(b.footprints.map((f) => f.ref).sort()).toEqual(['C1', 'R1', 'R101', 'R2'])
    const c1 = b.footprints.find((f) => f.ref === 'C1')
    expect(c1).toMatchObject({ side: 'top', x_mm: 30, y_mm: 10, rotation_deg: 90, mount: 'smd' })
    expect(c1?.pads.map((p) => [p.num, p.x_mm, p.y_mm, p.net])).toEqual([['1', 30, 10.5, 'MID'], ['2', 30, 9.5, 'GND']])
    const r101 = b.footprints.find((f) => f.ref === 'R101')
    expect(r101?.side).toBe('bottom')
    expect(r101?.pads[0]?.x_mm).toBe(40.5)
    expect(b.footprints.find((f) => f.ref === 'R1')?.fields).toEqual({ MPN: 'RC0402FR-0710KL' })
  })

  it('reads the outline, zones, nets and setup', () => {
    expect(b.outline).toEqual({ min_x_mm: 0, min_y_mm: 0, max_x_mm: 50, max_y_mm: 30, width_mm: 50, height_mm: 30 })
    expect(b.zones).toEqual([{ net: 'GND', layers: ['In1.Cu'], copper: true, keepout: false, name: null }])
    expect(netNames(b)).toEqual(['+3V3', '/Filter A/OUT', 'GND', 'MID'])
    expect(b.thickness_mm).toBe(1.6)
    expect(b.setup.pad_to_mask_clearance).toBe(0)
    expect(b.kicad.kicad).toBe('9')
  })

  it('measures a net in total and per layer (arcs as arcs)', () => {
    const n = new Net(b, 'MID')
    const arc = Math.PI * 2.5
    expect(n.length_m * 1e3).toBeCloseTo(29.5 + arc, 6)
    const by = n.byLayer()
    expect((by.get('F.Cu') ?? 0) * 1e3).toBeCloseTo(29.5, 6)
    expect((by.get('B.Cu') ?? 0) * 1e3).toBeCloseTo(arc, 6)
    expect(n.vias.length).toBe(2)
    expect(n.unreached()).toEqual(['R101.1']) // on the board but not routed
    expect(n.capacitance()).toBeGreaterThan(0)
  })

  it('finds the routed path between two pads, through vias and an arc', () => {
    const n = new Net(b, 'MID')
    const p = n.path('R1.2', 'C1.1')
    const j = p.toJSON(b)
    expect(j.trace_mm).toBeCloseTo(9.5 + Math.PI * 2.5 + 5.5, 3)
    expect(j.vias).toBe(2)
    expect(j.via_barrel_mm).toBeCloseTo(2 * 1.535, 3)
    expect(j.length_mm).toBeCloseTo(9.5 + Math.PI * 2.5 + 5.5 + 3.07, 3)
    expect(Object.keys(j.by_layer_mm)).toEqual(['F.Cu', 'B.Cu'])
    expect(j.z0_ohm).not.toBeNull()
    expect(j.delay_ps).toBeGreaterThan(0)
    // through the T-junction at x = 15
    expect(n.path('R1.2', 'R2.1').toJSON(b).length_mm).toBeCloseTo(19, 6)
  })

  it('cuts a net into branches at forks', () => {
    const b2 = parseBoard(DEMO_PCB)
    // drop the unrouted pad so every pad is reachable
    b2.pads.MID = (b2.pads.MID ?? []).filter((p) => p.ref !== 'R101')
    const tree = new Net(b2, 'MID').tree('R1.2').map((x) => x.toJSON(b2))
    const ends = tree.map((t) => `${t.from}->${t.to}:${t.trace_mm}`).sort()
    expect(ends).toEqual(['R1.2->j1:4.5', `j1->C1.1:${Math.round((10.5 + Math.PI * 2.5) * 1e4) / 1e4}`, 'j1->R2.1:14.5'].sort())
    expect(() => new Net(b, 'MID').tree('R1.2')).toThrow(/not connected/)
  })

  it('reports an unknown net with similar names', () => {
    expect(() => new Net(b, 'mi')).toThrow(/similar: MID/)
  })

  it('caches the parse by content', () => {
    clearMemo()
    const a = loadBoard(DEMO_PCB)
    clearMemo()
    const c = loadBoard(DEMO_PCB) // from the cache database
    expect(c.sha256).toBe(a.sha256)
    expect(c.footprints).toEqual(a.footprints)
    expect(new Net(c, 'MID').length_m).toBeCloseTo(new Net(a, 'MID').length_m, 12)
  })

  it('reads design rules from the project file', () => {
    const r = designRules(b, DEMO_PRO)
    expect(r.rules).toEqual({ min_clearance: 0.15, min_track_width: 0.15, min_via_diameter: 0.5 })
    expect(r.net_classes).toEqual([{ name: 'Default', clearance: 0.2, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3 }])
  })
})

describe('KiCad 6–9 numbered nets and a missing stackup', () => {
  it('maps net numbers to names and gives null impedance without a stackup', () => {
    const text = `(kicad_pcb (version 20221018) (generator pcbnew)
      (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
      (net 0 "") (net 1 "SIG")
      (segment (start 0 0) (end 3 4) (width 0.25) (layer "F.Cu") (net 1) (tstamp x))
      (gr_circle (center 10 10) (end 15 10) (layer "Edge.Cuts") (width 0.1)))`
    const p = join(mkdtempSync(join(tmpdir(), 'pcb-')), 'old.kicad_pcb')
    writeFileSync(p, text)
    const b = parseBoard(p)
    expect(b.kicad.kicad).toBe('7')
    expect(b.layers.map((l) => l.name)).toEqual(['F.Cu', 'B.Cu'])
    expect(new Net(b, 'SIG').length_m).toBeCloseTo(5e-3, 12)
    expect(stackupKnown(b)).toBe(false)
    expect(z0(layerOf(b, 'F.Cu'), 2e-4)).toBeNull()
    expect(b.outline?.width_mm).toBe(10)
  })
})

describe.skipIf(!hasReal)('a real KiCad 10 board', () => {
  const b = loadBoard(`${REAL}.kicad_pcb`)

  it('reads the board', () => {
    expect(b.footprints.length).toBe(816)
    expect(netNames(b).length).toBe(859)
    expect(b.outline).toMatchObject({ width_mm: 200, height_mm: 160 })
    expect(b.zones.length).toBe(61)
  })

  it('matches the hand-checked net length and layer impedances', () => {
    const n = new Net(b, '+5V_LOGIC')
    expect(n.length_m * 1e3).toBeCloseTo(167.4, 0)
    expect(describeLayer(layerOf(b, 'F.Cu'), 1e-4).z0_ohm).toBeCloseTo(68.82, 1)
    expect(describeLayer(layerOf(b, 'In1.Cu'), 1e-4).z0_ohm).toBeCloseTo(44.14, 1)
  })
})

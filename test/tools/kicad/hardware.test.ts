import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildBom, parseCsv } from '../../../src/tools/kicad/bom.js'
import { buildHardware, hardwareCsv, hardwareKindOf, readCaseRecords, screwFor } from '../../../src/tools/kicad/hardware.js'
import type { Schematic, Symbol } from '../../../src/tools/kicad/schematic.js'

const sym = (ref: string, value: string, fields: Record<string, string> = {}, more: Partial<Symbol> = {}): Symbol => ({
  ref, value, footprint: 'X:Y', lib_id: 'Device:R', unit: 1, uuid: ref, sheet: '/', instance_path: '/', file: 'a.kicad_sch',
  fields, dnp: false, in_bom: true, on_board: true, exclude_from_sim: false, power: false, at: null, ...more,
})

// what python/tracebridge/mech/records.py writes for a printed shell with two M2.5 screws and one M3
const CASE = [
  { '@id': 'case:enclosure', '@type': 'Enclosure', hasPart: [{ '@id': 'case:base' }, { '@id': 'case:lid' }] },
  { '@id': 'material:case', '@type': 'Material', name: 'PA12', process: 'MJF', service: 'JLC3DP' },
  { '@id': 'board:main', '@type': 'BoardOutline', sha256: 'abc' },
  { '@id': 'case:base', '@type': 'EnclosurePart', partKind: 'base', boundingBox: [60.04, 40, 12.5] },
  { '@id': 'case:lid', '@type': 'EnclosurePart', partKind: 'lid', boundingBox: [60, 40, 3] },
  { '@id': 'fastener:H2', '@type': 'Fastener', fastenerKind: 'screw', size: 'M2.5', length: 6, pilotDiameter: 2 },
  { '@id': 'mount:H2', '@type': 'MountingPoint', reference: 'H2', fastener: { '@id': 'fastener:H2' } },
  { '@id': 'fastener:H1', '@type': 'Fastener', fastenerKind: 'screw', size: 'M2.5', length: 6, pilotDiameter: 2 },
  { '@id': 'mount:H1', '@type': 'MountingPoint', reference: 'H1', fastener: { '@id': 'fastener:H1' } },
  { '@id': 'fastener:H3', '@type': 'Fastener', fastenerKind: 'screw', size: 'M3', length: 8, pilotDiameter: 2.4 },
  { '@id': 'mount:H3', '@type': 'MountingPoint', reference: 'H3', fastener: { '@id': 'fastener:H3' } },
  { '@id': 'joint:lid-base', '@type': 'Joint', jointKind: 'press-fit' },
]

describe('panel and mounting hardware', () => {
  it('knows which parts are hardware', () => {
    expect(hardwareKindOf(sym('MP1', 'Knob'))).toBe('mounting')
    expect(hardwareKindOf(sym('MP2', 'Knob', { Hardware: 'Panel' }))).toBe('panel')
    expect(hardwareKindOf(sym('SW1', 'Pot nut', { hardware: ' mounting ' }))).toBe('mounting')
    expect(hardwareKindOf(sym('R1', '10k'))).toBeNull()
    expect(hardwareKindOf(sym('R2', '10k', { Hardware: 'no' }))).toBeNull()
  })

  it('keeps hardware out of the main BOM, listed with its reason', () => {
    const sch = { symbols: [sym('R1', '10k'), sym('MP1', 'Knob', { Hardware: 'panel' }), sym('H1', 'MountingHole', {}, { in_bom: false })] } as unknown as Schematic
    const b = buildBom(sch)
    expect(b.lines.map((l) => l.refs)).toEqual([['R1']])
    expect(b.excluded).toEqual([{ ref: 'H1', value: 'MountingHole', reason: 'not_in_bom' }, { ref: 'MP1', value: 'Knob', reason: 'hardware' }])
  })

  it('lists the case parts and its screws from the case build, grouped by size and length', () => {
    const h = buildHardware({ caseRecords: CASE, boardSha256: 'abc', mountingHoles: [{ ref: 'H9', d: 5 }] })
    expect(h.case_built).toBe(true)
    expect(h.case_stale).toBe(false)
    expect(h.lines.map((l) => [l.quantity, l.item, l.kind, l.refs.join(' ')])).toEqual([
      [1, 'Case base', 'panel', 'base'],
      [1, 'Case lid', 'panel', 'lid'],
      [2, 'M2.5 pan head screw, 6 mm', 'mounting', 'H1 H2'],
      [1, 'M3 pan head screw, 8 mm', 'mounting', 'H3'],
    ])
    expect(h.lines[0]?.size).toBe('60 × 40 × 12.5 mm')
    expect(h.lines[0]?.note).toContain('PA12, MJF, JLC3DP')
    expect(h.total_items).toBe(5)
    expect(h.notes.join(' ')).toMatch(/without screws/)
  })

  it('says when the case was built for an earlier board', () => {
    const h = buildHardware({ caseRecords: CASE, boardSha256: 'def' })
    expect(h.case_stale).toBe(true)
    expect(h.notes.join(' ')).toMatch(/rebuild it \(mech.build\)/)
  })

  it('falls back to the board\'s mounting holes without a case build', () => {
    expect([2.2, 2.7, 3.2, 4.3].map(screwFor)).toEqual(['M2', 'M2.5', 'M3', 'M4'])
    const h = buildHardware({ mountingHoles: [{ ref: 'H2', d: 3.2 }, { ref: 'H1', d: 3.2 }, { ref: null, d: 2.2 }] })
    expect(h.lines.map((l) => [l.quantity, l.item, l.length_mm, l.refs.join(' '), l.source])).toEqual([
      [2, 'M3 pan head screw', null, 'H1 H2', 'board'],
      [1, 'M2 pan head screw', null, 'hole 3', 'board'],
    ])
    expect(h.notes[0]).toMatch(/No case is built yet/)
  })

  it('adds parts marked as hardware, panel items first, and writes its own CSV', () => {
    const h = buildHardware({
      mountingHoles: [{ ref: 'H1', d: 3.2 }],
      symbols: [
        sym('MP2', 'Knob 6mm', { Hardware: 'panel', MPN: 'K-6' }), sym('MP1', 'Knob 6mm', { Hardware: 'panel', MPN: 'K-6' }),
        sym('MP3', 'Standoff M3 10mm', { Description: 'Brass standoff' }), sym('MP4', 'gone', { Hardware: 'panel' }, { dnp: true }), sym('R1', '10k'),
      ],
    })
    expect(h.lines.map((l) => [l.quantity, l.item, l.kind, l.refs.join(' '), l.mpn])).toEqual([
      [2, 'Knob 6mm', 'panel', 'MP1 MP2', 'K-6'],
      [1, 'M3 pan head screw', 'mounting', 'H1', null],
      [1, 'Brass standoff', 'mounting', 'MP3', null],
    ])
    const rows = parseCsv(hardwareCsv(h))
    expect(rows[0]).toEqual(['Quantity', 'Item', 'Kind', 'Size', 'Length (mm)', 'For', 'MPN', 'Manufacturer', 'LCSC', 'Source', 'Note'])
    expect(rows[1]?.slice(0, 7)).toEqual(['2', 'Knob 6mm', 'panel', '', '', 'MP1 MP2', 'K-6'])
  })

  it('says so when there is nothing to list', () => {
    const h = buildHardware({})
    expect(h.lines).toEqual([])
    expect(h.notes[0]).toMatch(/No panel or mounting hardware found/)
  })

  it('reads the case records from the repository, and nothing when they are missing or broken', () => {
    const r = mkdtempSync(join(tmpdir(), 'hw-'))
    expect(readCaseRecords(r)).toBeNull()
    expect(readCaseRecords(null)).toBeNull()
    mkdirSync(join(r, 'mechanical', 'out'), { recursive: true })
    writeFileSync(join(r, 'mechanical', 'out', 'case.jsonld'), '{not json')
    expect(readCaseRecords(r)).toBeNull()
    writeFileSync(join(r, 'mechanical', 'out', 'case.jsonld'), JSON.stringify({ '@graph': CASE }))
    expect(readCaseRecords(r)).toHaveLength(CASE.length)
  })
})

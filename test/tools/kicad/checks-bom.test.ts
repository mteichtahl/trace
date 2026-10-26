import { describe, expect, it } from 'vitest'
import { bomCsv, buildBom, footprintName, jlcBomCsv, jlcCplCsv, parseCsv, parsePos } from '../../../src/tools/kicad/bom.js'
import { parseDrc, parseErc, refFromDescription } from '../../../src/tools/kicad/checks.js'
import { readSchematic } from '../../../src/tools/kicad/schematic.js'
import { DEMO_PCB, DEMO_SCH, hasKicad } from './helpers.js'

describe('ERC/DRC report parsing', () => {
  const erc = JSON.stringify({
    kicad_version: '10.0.7', coordinate_units: 'mm',
    sheets: [
      { path: '/', violations: [
        { type: 'pin_not_connected', severity: 'error', description: 'Pin not connected', items: [{ description: 'Symbol U1 Pin 3 [GPIO, Bidirectional]', pos: { x: 1, y: 2 }, uuid: 'u-1' }] },
        { type: 'lib_symbol_issues', severity: 'warning', description: 'lib', items: [{ description: 'Symbol #PWR01 [GND]', pos: { x: 3, y: 4 } }] },
      ] },
      { path: '/Power/', violations: [
        { type: 'pin_not_connected', severity: 'error', description: 'Pin not connected', excluded: true, items: [] },
      ] },
    ],
  })

  it('counts by severity and type, errors first, exclusions apart', () => {
    const r = parseErc(erc)
    expect(r).toMatchObject({ check: 'erc', kicad_version: '10.0.7', errors: 1, warnings: 1, excluded: 1, by_type: { pin_not_connected: 2, lib_symbol_issues: 1 } })
    expect(r.violations[0]?.items[0]).toEqual({ ref: 'U1', uuid: 'u-1', description: 'Symbol U1 Pin 3 [GPIO, Bidirectional]', pos: { x_mm: 1, y_mm: 2 } })
    expect(r.violations.map((v) => v.where)).toEqual(['/', '/', '/Power/'])
  })

  it('reads DRC sections and converts inch reports to mm', () => {
    const r = parseDrc(JSON.stringify({
      coordinate_units: 'in',
      violations: [{ type: 'clearance', severity: 'error', description: 'Clearance violation', items: [{ description: 'Track [GND] on F.Cu', pos: { x: 1, y: 0.5 } }] }],
      unconnected_items: [{ type: 'unconnected_items', severity: 'error', description: 'Missing connection', items: [{ description: 'Pad 2 [MID] of R101 on B.Cu' }] }],
      schematic_parity: [{ type: 'missing_footprint', severity: 'warning', description: 'Missing footprint R3', items: [] }],
    }))
    expect(r).toMatchObject({ errors: 2, warnings: 1, unconnected: 1, parity: 1 })
    expect(r.violations[0]?.items[0]?.pos).toEqual({ x_mm: 25.4, y_mm: 12.7 })
    expect(r.violations.find((v) => v.where === 'unconnected')?.items[0]?.ref).toBe('R101')
  })

  it('refuses a report it does not understand rather than reading it as clean', () => {
    expect(() => parseErc(JSON.stringify({ sheets: [{ violations: [{ severity: 'error' }] }] }))).toThrow(/does not understand/)
  })

  it('pulls references out of item descriptions', () => {
    expect(refFromDescription('Footprint C130')).toBe('C130')
    expect(refFromDescription('Symbol #FLG01 [PWR_FLAG]')).toBe('#FLG01')
    expect(refFromDescription('Via [GND] on F.Cu - B.Cu')).toBeNull()
  })
})

describe('BOM', () => {
  const bom = buildBom(readSchematic(DEMO_SCH, 'demo'))

  it('groups by value, footprint and part number with natural-order refs', () => {
    expect(bom.lines.map((l) => [l.quantity, l.refs.join(' '), l.value, l.mpn, l.lcsc])).toEqual([
      [1, 'C1', '100n', null, 'C1525'],
      [2, 'C101 C201', '1u', 'CL10A105KB8NNNC', null],
      [2, 'R1 R2', '10k', 'RC0402FR-0710KL', 'C25744'],
      [2, 'R101 R201', '4k7', 'RC0402FR-074K7L', null],
    ])
    expect(bom.total_parts).toBe(7)
    expect(bom.unique_lines).toBe(4)
    expect(bom.missing_part_number).toBe(0)
  })

  it('keeps DNP and BOM-excluded parts out of the quantities, listed', () => {
    expect(bom.excluded).toEqual([{ ref: 'R3', value: 'DNF test', reason: 'not_in_bom' }, { ref: 'R10', value: '0R', reason: 'dnp' }])
  })

  it('writes the CSVs', () => {
    const rows = parseCsv(bomCsv(bom))
    expect(rows[0]).toEqual(['Quantity', 'References', 'Value', 'Footprint', 'MPN', 'Manufacturer', 'LCSC', 'Description'])
    expect(rows[3]).toEqual(['2', 'R1 R2', '10k', 'Resistor_SMD:R_0402_1005Metric', 'RC0402FR-0710KL', 'Yageo', 'C25744', ''])
    const jlc = parseCsv(jlcBomCsv(bom))
    expect(jlc[0]).toEqual(['Comment', 'Designator', 'Footprint', 'LCSC Part #'])
    expect(jlc[3]).toEqual(['10k', 'R1,R2', 'R_0402_1005Metric', 'C25744'])
    expect(footprintName('Lib:Name')).toBe('Name')
  })

  it('reads kicad-cli position files and writes the JLC CPL', () => {
    const pos = parsePos('Ref,Val,Package,PosX,PosY,Rot,Side\r\n"R10","1k, 1%","R_0402",1.5,-2.25,90.000000,top\n"C2","1u","C_0603",3,4,180,bottom\n')
    expect(pos[0]).toEqual({ ref: 'R10', value: '1k, 1%', package: 'R_0402', x_mm: 1.5, y_mm: -2.25, rotation_deg: 90, side: 'top' })
    expect(parseCsv(jlcCplCsv(pos))).toEqual([
      ['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation'],
      ['C2', '3mm', '4mm', 'Bottom', '180'],
      ['R10', '1.5mm', '-2.25mm', 'Top', '90'],
    ])
    expect(() => parsePos('A,B\n1,2\n')).toThrow(/no ref column/)
  })
})

describe.skipIf(!hasKicad)('checks and placements through kicad-cli', () => {
  it('runs ERC on the fixture', async () => {
    const { erc } = await import('../../../src/tools/kicad/checks.js')
    const [r, raw] = await erc(DEMO_SCH)
    expect(JSON.parse(raw)).toHaveProperty('sheets')
    expect(r.errors).toBe(2)
    expect(r.by_type.power_pin_not_driven).toBe(2)
    expect(r.warnings).toBeGreaterThan(0)
  })

  it('runs DRC with schematic parity on the fixture', async () => {
    const { drc } = await import('../../../src/tools/kicad/checks.js')
    const [r] = await drc(DEMO_PCB, { parity: true })
    expect(r.unconnected).toBe(2)
    expect(r.parity).toBe(9)
    expect(r.by_type.clearance).toBe(2)
  })

  it('reads placements (DNP excluded)', async () => {
    const { placements } = await import('../../../src/tools/kicad/bom.js')
    const p = await placements(DEMO_PCB)
    expect(p.map((x) => x.ref).sort()).toEqual(['C1', 'R1', 'R101', 'R2'])
    expect(p.find((x) => x.ref === 'R101')).toMatchObject({ side: 'bottom', x_mm: 40, rotation_deg: 180 })
  })
})

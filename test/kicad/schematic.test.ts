import { describe, expect, it } from 'vitest'
import { lcscOf, mpnOf, naturalCompare, parseNetlistXml, parts, powerNets, readSchematic, symbolSummary } from '../../src/kicad/schematic.js'
import { DEMO_SCH, hasKicad, hasReal, REAL } from './helpers.js'

describe('readSchematic (2-sheet hierarchy, one sub-sheet placed twice)', () => {
  const sch = readSchematic(DEMO_SCH, 'demo')

  it('reads the title, sheets and their pages', () => {
    expect(sch.title).toEqual({ title: 'Demo board', rev: 'A', company: 'Example "Co"' })
    expect(sch.sheets.map((s) => [s.name, s.file, s.path, s.page])).toEqual([
      ['Filter A', 'filter.kicad_sch', '/Filter A/', '2'],
      ['Filter B', 'filter.kicad_sch', '/Filter B/', '3'],
    ])
    expect(sch.problems).toEqual([])
  })

  it('resolves references per sheet instance', () => {
    const refs = parts(sch).map((s) => s.ref)
    expect(refs).toEqual(['C1', 'C101', 'C201', 'R1', 'R2', 'R3', 'R10', 'R101', 'R201'])
    const r201 = parts(sch).find((s) => s.ref === 'R201')
    expect(r201?.sheet).toBe('/Filter B/')
    expect(r201?.value).toBe('4k7')
  })

  it('keeps power symbols apart and finds the power nets', () => {
    // five on the root, and the sub-sheet's GND once per placement of the sheet
    expect(parts(sch, true).filter((s) => s.power).length).toBe(7)
    expect(powerNets(sch)).toEqual(['+3V3', 'GND'])
  })

  it('reads fields and flags', () => {
    const by = new Map(parts(sch).map((s) => [s.ref, s]))
    const r1 = by.get('R1')
    expect(r1 && mpnOf(r1)).toBe('RC0402FR-0710KL')
    expect(r1 && lcscOf(r1)).toBe('C25744')
    const c1 = by.get('C1')
    expect(c1 && lcscOf(c1)).toBe('C1525') // "LCSC Part #"
    expect(by.get('R10')?.dnp).toBe(true)
    expect(by.get('R3')?.in_bom).toBe(false)
    expect(r1 && symbolSummary(r1)).toMatchObject({ ref: 'R1', footprint: 'Resistor_SMD:R_0402_1005Metric', manufacturer: 'Yageo', lib_id: 'Device:R' })
  })

  it('reads labels and no-connects across sheets', () => {
    expect(sch.labels.filter((l) => l.kind === 'global_label' && l.text === 'MID').length).toBe(6) // 4 on the root + 1 per sub-sheet placement
    expect(sch.labels.filter((l) => l.kind === 'label' && l.text === 'OUT').map((l) => l.sheet)).toEqual(['/Filter A/', '/Filter A/', '/Filter B/', '/Filter B/'])
    expect(sch.no_connects).toEqual([{ sheet: '/', at: [180, 96.19] }])
  })
})

describe('naturalCompare', () => {
  it('orders R2 before R10 and U1 before U1A', () => {
    expect(['R10', 'R2', 'C1', 'R1', 'U1A', 'U1'].sort(naturalCompare)).toEqual(['C1', 'R1', 'R2', 'R10', 'U1', 'U1A'])
  })
})

describe('parseNetlistXml', () => {
  it('reads nets, nodes, pin functions and components', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<export version="E">
  <components>
    <comp ref="U1"><value>MCU &amp; co</value><footprint>Pkg:QFN</footprint>
      <fields><field name="MPN">ABC-1</field></fields>
      <libsource lib="MCU" part="X" description="d"/><property name="dnp" value=""/>
      <sheetpath names="/" tstamps="/"/></comp>
  </components>
  <nets>
    <net code="1" name="/SPI &lt;MOSI&gt;" class="Fast">
      <node ref="U1" pin="3" pinfunction="GPIO3" pintype="bidirectional"/>
      <node ref="R1" pin="1" pintype="passive"/>
    </net>
  </nets>
</export>`
    const nl = parseNetlistXml(xml)
    expect([...nl.nets.keys()]).toEqual(['/SPI <MOSI>'])
    expect(nl.nets.get('/SPI <MOSI>')?.[0]).toEqual({ ref: 'U1', pin: '3', function: 'GPIO3', type: 'bidirectional' })
    expect(nl.classes.get('/SPI <MOSI>')).toBe('Fast')
    expect(nl.components.get('U1')).toMatchObject({ value: 'MCU & co', lib_id: 'MCU:X', dnp: true, fields: { MPN: 'ABC-1' } })
  })

  it('rejects something that is not a netlist', () => {
    expect(() => parseNetlistXml('<html></html>')).toThrow(/not a KiCad XML netlist/)
    expect(() => parseNetlistXml('<export><nets>')).toThrow(/unreadable/)
  })
})

describe.skipIf(!hasKicad)('netlist via kicad-cli', () => {
  it('joins the global label across both sheet instances', async () => {
    const { netlist } = await import('../../src/kicad/schematic.js')
    const nl = await netlist(DEMO_SCH)
    const mid = (nl.nets.get('MID') ?? []).map((n) => `${n.ref}.${n.pin}`).sort()
    expect(mid).toEqual(['C1.1', 'R1.2', 'R10.1', 'R101.1', 'R2.1', 'R201.1'])
    expect((nl.nets.get('/Filter B/OUT') ?? []).map((n) => n.ref).sort()).toEqual(['C201', 'R201'])
    expect(nl.nets.get('GND')?.length).toBe(6)
    expect(nl.components.size).toBe(9)
  })
})

describe.skipIf(!hasReal)('a real KiCad 10 project', () => {
  it('reads every sheet and part', () => {
    const sch = readSchematic(`${REAL}.kicad_sch`)
    expect(sch.symbols.length).toBe(830)
    expect(parts(sch).length).toBe(811)
    expect(sch.sheets.length).toBe(19)
    expect(sch.problems).toEqual([])
  })

  it.skipIf(!hasKicad)('matches kicad-cli\'s netlist', async () => {
    const { netlist } = await import('../../src/kicad/schematic.js')
    const nl = await netlist(`${REAL}.kicad_sch`)
    expect(nl.nets.size).toBe(859)
    expect(nl.components.size).toBe(811)
  })
})

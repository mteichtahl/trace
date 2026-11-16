/**
 * An off-board part against the connector it plugs into (test-esp32 #169): the OLED module's datasheet (ea9a571f p2)
 * gives pin 1 VCC, pin 2 GND, the reverse of J2's GND, VCC, SCL, SDA in the pin plan, and no check caught it.
 */
import { describe, expect, it } from 'vitest'
import { type CheckInput, checkSkill } from '../../src/api/skill-checks.js'
import type { ArchBlockRow, ArchOptionRow, BlockPart, DesignRows, PinRow } from '../../src/tools/design/db.js'
import { type MatedPart, architectureView, mateCheck, matedParts, pinCheck } from '../../src/tools/design/record.js'

const pin = (n: string, name: string, net: string, kind: PinRow['kind'] = 'power'): PinRow => ({
  part: 'J2', pin: n, name, function: name === 'VCC' ? 'POWER' : name, peripheral: null, use: null, net, kind, reserved: null, alternates: [], constraints: null, note: null, status: 'proposed', updated: 1, by: 'impl',
})
// the project's J2, as the run recorded it
const J2 = [pin('1', 'GND', 'GND'), pin('2', 'VCC', '+3V3'), pin('3', 'SCL', '/I2C_SCL', 'signal'), pin('4', 'SDA', '/I2C_SDA', 'signal')]
const OLED = 'SSD1306-0.96-OLED-128x64-I2C-module'
const module = (pins: string[] | null): MatedPart => ({ mpn: OLED, block: 'OLED header, I2C pull-ups and OLED module', mates: pins ? [{ connector: 'J2', pins, source: 'ea9a571f p2' }] : null })

describe('an off-board part against its connector', () => {
  it('names both orders when the module\'s supply is the reverse of the connector\'s, and blocks', () => {
    const [f, ...rest] = mateCheck([module(['VCC', 'GND', 'SCL', 'SDA'])], J2)
    expect(rest).toEqual([])
    expect(f).toMatchObject({ id: `mate:J2:${OLED}:order`, kind: 'mate_order', severity: 'blocks', target: 'pin:J2.1' })
    expect(f?.text).toContain('J2\'s pins are 1 GND, 2 VCC, 3 SCL, 4 SDA')
    expect(f?.text).toContain(`${OLED}, which plugs into it, has 1 VCC, 2 GND, 3 SCL, 4 SDA (its datasheet ea9a571f p2)`)
    expect(f?.text).toContain('Pin 1: J2\'s GND meets the part\'s VCC; Pin 2: J2\'s VCC meets the part\'s GND')
    expect(f?.text).toContain('its supply is on the wrong pins')
  })

  it('passes a module in the connector\'s order, under its own names for the same pins', () => {
    expect(mateCheck([module(['GND', 'VDD', 'SCL', 'SDA'])], J2)).toEqual([])
    expect(mateCheck([module(['0V', '3V3', 'I2C_SCL', 'I2C_SDA'])], J2)).toEqual([])
  })

  it('a signal pair crossed is to fix; a pin missing on one side is a difference', () => {
    expect(mateCheck([module(['GND', 'VCC', 'SDA', 'SCL'])], J2)[0]).toMatchObject({ severity: 'fix', target: 'pin:J2.3', text: expect.stringContaining('these signals cross') })
    expect(mateCheck([module(['GND', 'VCC', 'SCL'])], J2)[0]?.text).toContain('Pin 4: J2\'s SDA meets the part\'s no pin')
  })

  it('a part whose order or connector is not recorded is to fix: nothing could be checked', () => {
    expect(mateCheck([module(null)], J2)[0]).toMatchObject({ kind: 'mate_unknown', severity: 'fix', text: expect.stringContaining('sits off the board') })
    expect(mateCheck([module(['VCC', 'GND'])], [])[0]).toMatchObject({ kind: 'mate_unknown', text: expect.stringContaining('J2 has no pins in the pin plan') })
  })

  // poo: a compute module (CM5, SC1576) sits on two 100-pin board-to-board connectors. One mate per part could not
  // say that, so its finding could never be fixed, only waived, and Pin plan review stayed one check short
  describe('a module on two connectors', () => {
    const row = (part: string, n: number, name: string, net: string, kind: PinRow['kind'] = 'signal'): PinRow => ({ ...pin(String(n), name, net, kind), part, function: name })
    const J1 = [row('J1', 1, 'GND', 'GND', 'power'), row('J1', 2, 'GND', 'GND', 'power'), row('J1', 3, 'ETH_P3', '/HOST/ETH_P3'), row('J1', 5, '+5V', '+5V_SYS', 'power')]
    const J2b = [row('J2', 1, 'GND', 'GND', 'power'), row('J2', 2, 'USB_OTG_ID', '/HOST/USB_OTG_ID')]
    const cm5 = (j1: string[], j2: string[]): MatedPart => ({ mpn: 'SC1576', block: 'CM5 host', mates: [{ connector: 'J1', pins: j1, source: '80070fef p18' }, { connector: 'J2', pins: j2, source: '80070fef p21', first: 101 }] })

    it('is checked connector by connector, and passes when each is in its order', () => {
      expect(mateCheck([cm5(['GND', 'GND', 'ETH_P3', 'ETH_N3', '5V'], ['GND', 'USB_OTG_ID', 'PCIE_CLK_NREQ'])], [...J1, ...J2b])).toEqual([])
    })
    it('a module signal the board leaves unconnected is no finding; a supply pin left out is', () => {
      // ETH_N3 (J1 pin 4) and PCIE_CLK_NREQ (J2 pin 3) have no row: nothing crosses
      expect(mateCheck([cm5(['GND', 'GND', 'ETH_P3', 'ETH_N3', '5V'], ['GND', 'USB_OTG_ID', 'PCIE_CLK_NREQ'])], [...J1, ...J2b])).toEqual([])
      const [f] = mateCheck([cm5(['GND', 'GND', 'ETH_P3', 'ETH_N3', '5V', '5V'], ['GND', 'USB_OTG_ID'])], [...J1, ...J2b])
      expect(f).toMatchObject({ id: 'mate:J1:SC1576:order', severity: 'blocks', target: 'pin:J1.6' })
    })
    it('a wrong pin on the second connector names that connector and the module\'s own pin number', () => {
      const [f, ...rest] = mateCheck([cm5(['GND', 'GND', 'ETH_P3', 'ETH_N3', '5V'], ['5V', 'USB_OTG_ID'])], [...J1, ...J2b])
      expect(rest).toEqual([])
      expect(f).toMatchObject({ id: 'mate:J2:SC1576:order', kind: 'mate_order', severity: 'blocks', target: 'pin:J2.1' })
      expect(f?.text).toContain('Pin 1: J2\'s GND meets the part\'s 5V (its pin 101)')
    })
    it('a connector of it with no pins in the plan is named, with what to do', () => {
      const all = mateCheck([cm5(['GND', 'GND', 'ETH_P3', 'ETH_N3', '5V'], ['GND', 'USB_OTG_ID'])], J1)
      expect(all).toHaveLength(1)
      expect(all[0]).toMatchObject({ id: 'mate:J2:SC1576:unknown', kind: 'mate_unknown' })
      expect(all[0]?.text).toContain('Add J2\'s pins to the pin plan')
    })
    it('a long order is said in short', () => {
      const names = Array.from({ length: 100 }, (_, i) => (i === 0 ? '5V' : `SIG${i + 1}`))
      const [f] = mateCheck([{ mpn: 'SC1576', block: 'CM5 host', mates: [{ connector: 'J1', pins: names }] }], J1)
      expect(f?.text).toContain('and 88 more')
      expect(f?.text.length).toBeLessThan(900)
    })
    it('matedParts reads one mate or a list of them, and drops an empty one', () => {
      const host = (mates: BlockPart['mates']): BlockPart => ({ mpn: 'SC1576', key: true, off_board: true, size_mm: [55, 40, 4.7], mates })
      const two = [{ connector: 'J1', pins: ['GND'] }, { connector: 'J2', pins: ['GND'], first: 101 }]
      expect(matedParts(architectureView(rows([host(two)]), []))[0]?.mates).toEqual(two)
      expect(matedParts(architectureView(rows([host([two[0]!, { connector: 'J2', pins: [] }])]), []))[0]?.mates).toEqual([two[0]])
      expect(matedParts(architectureView(rows([host([])]), []))[0]?.mates).toBeNull()
    })
  })

  it('pinCheck adds them when given the off-board parts, and only then', () => {
    expect(pinCheck(J2).some((f) => f.kind === 'mate_order')).toBe(false)
    expect(pinCheck(J2, null, [module(['VCC', 'GND', 'SCL', 'SDA'])]).map((f) => f.kind)).toContain('mate_order')
  })
})

// the record: option A going ahead with the module off the board on J2
const option: ArchOptionRow = { id: 'A', name: 'ESP32-C3', summary: 's', recommended: true, why: null, gives_up: null, risks: [], status: 'proposed', created: 1, updated: 1, by: 'impl' }
const block = (parts: BlockPart[]): ArchBlockRow => ({ option: 'A', id: 'oled', name: 'OLED', role: null, parts, requirements: [], x: null, y: null, status: 'proposed', updated: 1, by: 'impl' })
const rows = (parts: BlockPart[]): DesignRows => ({ intent: [], links: [], options: [option], criteria: [], scores: [], blocks: [block(parts)], connections: [], pins: J2, sheets: [] })
const header: BlockPart = { mpn: '2.54-1*4PFemale', key: true }
const vccFirst: BlockPart = { mpn: OLED, key: true, off_board: true, size_mm: [27.3, 27.3, 2.37], mates: { connector: 'J2', pins: ['VCC', 'GND', 'SCL', 'SDA'], source: 'ea9a571f p2' } }

describe('the architecture\'s off-board parts', () => {
  it('are the parts off the board of the option going ahead, with what they plug into', () => {
    expect(matedParts(architectureView(rows([header, vccFirst]), []))).toEqual([{ mpn: OLED, block: 'OLED', mates: [vccFirst.mates] }])
    expect(matedParts(architectureView(rows([header, { ...vccFirst, mates: undefined }]), []))).toEqual([{ mpn: OLED, block: 'OLED', mates: null }])
  })

  it('Pin plan review cannot be submitted over the reversed supply, until it is waived', () => {
    const input = (design: DesignRows, waived: string[] = []): CheckInput => ({
      r: waived.length ? { waivers: waived.map((target) => ({ targetKind: 'finding', target, closedAt: null })) } as unknown as CheckInput['r'] : null,
      viewer: { admin: false } as CheckInput['viewer'], requirements: [], struck: [], erc: null, drc: null, bom: null, board: null, placement: null,
      instruments: [], orders: [], tests: [], draft: null, gate: null, question: null, design: { rows: design, decisions: [] },
    } as CheckInput)
    const mates = (i: CheckInput) => checkSkill('pin-plan-review', i)?.find((c) => c.id === 'mates')
    expect(mates(input(rows([header, vccFirst])))).toMatchObject({ status: 'not_met', detail: expect.stringContaining('J2\'s pins are 1 GND, 2 VCC') })
    expect(mates(input(rows([header, vccFirst]), [`mate:J2:${OLED}:order`]))).toMatchObject({ status: 'waived' })
    expect(mates(input(rows([header, { ...vccFirst, mates: { connector: 'J2', pins: ['GND', 'VCC', 'SCL', 'SDA'] } }])))).toMatchObject({ status: 'met' })
  })
})

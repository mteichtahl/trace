import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { checkOverview, designators, drillFile, fromFunction, fromName, gerberExtents, importPaths, inspect, inspectionView, jobFile, mmOf, readBom, readCpl, readGerbers, toolWords } from '../../../src/tools/fab/inspect.js'

const dir = join(import.meta.dirname, '../../fixtures/fab-import')
const zip = readFileSync(join(dir, 'potroller-supervisor-gerbers.zip'))
const bom = readFileSync(join(dir, 'potroller-carrier-bom-jlc.csv'), 'utf8')
const cpl = readFileSync(join(dir, 'potroller-carrier-cpl-jlc.csv'), 'utf8')
const OVERVIEW = [
  'The Potroller carrier is a board that hosts a Raspberry Pi CM5 and eight hot-pluggable capability modules for a flight simulator cockpit.',
  'It is powered from 12 to 24 V DC through a 30 A blade fuse and makes 5 V and 3.3 V rails.',
  'Interfaces: USB-C, Ethernet, two micro HDMI, I2C to each module and a GPIO header.',
  'It is 200 x 160 mm, mounted on standoffs in a rack enclosure. We will build 5 boards for a prototype run with a budget of 1500 USD.',
].join(' ')

/** A zip of these files, stored deflated (the reader under test reads what JLCPCB's exports and zip tools write). */
function zipOf(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let at = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text)
    const packed = deflateRawSync(raw)
    const n = Buffer.from(name)
    const l = Buffer.alloc(30)
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8)
    l.writeUInt32LE(packed.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(n.length, 26)
    locals.push(l, n, packed)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10)
    c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(at, 42)
    central.push(c, n)
    at += 30 + n.length + packed.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(at, 16)
  return Buffer.concat([...locals, cd, end])
}

const OUTLINE = '%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.050000*%\nD10*\nX0Y0D02*\nX50000000Y0D01*\nX50000000Y-40000000D01*\nX0Y-40000000D01*\nX0Y0D01*\nM02*\n'
const COPPER = (fn: string): string => `%TF.FileFunction,${fn}*%\n%FSLAX46Y46*%\n%MOMM*%\nM02*\n`
const DRILL = 'M48\nMETRIC\nT1C0.300\nT2C1.000\n%\nT1\nX10.0Y-10.0\nX20.0Y-10.0\nT2\nX5.0Y-5.0\nM30\n'

describe('the Gerbers', () => {
  it('reads the sample: ten copper layers by their X2 functions, the outline, the job file and the drills', () => {
    const g = readGerbers(zip)
    expect(g.copper).toBe(10)
    expect(g.files.filter((f) => f.kind === 'copper').every((f) => f.from === 'attribute')).toBe(true)
    expect(g.files.find((f) => f.name.endsWith('F_Cu.gtl'))).toMatchObject({ kind: 'copper', side: 'top', layer: 1 })
    expect(g.files.find((f) => f.name.endsWith('B_Cu.gbl'))).toMatchObject({ kind: 'copper', side: 'bottom', layer: 10 })
    expect(g.outline).toMatchObject({ x0: 100, x1: 300, y0: -260, y1: -100, width_mm: 200, height_mm: 160 })
    expect(g.job).toMatchObject({ layers: 10, thickness_mm: 1.6, finish: 'ENIG', impedance: true })
    expect(g.drills).toMatchObject({ smallest_mm: 0.15, plated_files: 1, unplated_files: 1 })
    expect(g.drills.holes).toBeGreaterThan(100)
    expect(g.files.filter((f) => f.kind === 'drill-map')).toHaveLength(2)
    // the version without its build and packaging suffix ("10.0.8-10.0.8~ubuntu24.04.1")
    expect(g.tool).toBe('KiCad Pcbnew 10.0.8')
    expect(toolWords('KiCad,Pcbnew,10.0.8-10.0.8~ubuntu24.04.1')).toBe('KiCad Pcbnew 10.0.8')
    expect(toolWords('EasyEDA,,v6.5.40')).toBe('EasyEDA v6.5.40')
    expect(g.project).toEqual({ name: 'potroller-supervisor', revision: 'M.20' })
  })

  it('knows a layer by its file function', () => {
    expect(fromFunction('Copper,L3,Inr')).toMatchObject({ kind: 'copper', side: 'inner', layer: 3 })
    expect(fromFunction('Soldermask,Bot')).toMatchObject({ kind: 'mask', side: 'bottom' })
    expect(fromFunction('Profile,NP')).toMatchObject({ kind: 'outline' })
    expect(fromFunction('NonPlated,1,10,NPTH')).toMatchObject({ kind: 'drill', plated: false })
    expect(fromFunction('Something')).toBeNull()
  })

  it('knows a layer by its name when it carries no attributes (Protel, KiCad, EasyEDA)', () => {
    expect(fromName('board.GTL')).toMatchObject({ kind: 'copper', side: 'top' })
    expect(fromName('board.GBL')).toMatchObject({ kind: 'copper', side: 'bottom' })
    expect(fromName('board.G2')).toMatchObject({ kind: 'copper', side: 'inner', layer: 3 })
    expect(fromName('Gerber_TopSolderMaskLayer.GTS')).toMatchObject({ kind: 'mask', side: 'top' })
    expect(fromName('board-Edge_Cuts.gbr')).toMatchObject({ kind: 'outline' })
    expect(fromName('board.GKO')).toMatchObject({ kind: 'outline' })
    expect(fromName('board-NPTH.drl')).toMatchObject({ kind: 'drill', plated: false })
    expect(fromName('board-PTH-drl_map.gbr')).toMatchObject({ kind: 'drill-map' })
    expect(fromName('readme.txt')).toMatchObject({ kind: 'other' })
  })

  it('measures an outline in inches and in another number format', () => {
    expect(gerberExtents('%FSLAX24Y24*%\n%MOIN*%\nX0Y0D02*\nX20000Y0D01*\nX20000Y10000D01*\n')).toMatchObject({ width_mm: 50.8, height_mm: 25.4 })
    expect(gerberExtents('%FSLAX46Y46*%\nG04 nothing*\n')).toBeNull()
  })

  it('reads a drill file\'s holes and smallest tool, in inches too', () => {
    expect(drillFile(DRILL)).toEqual({ holes: 3, smallest_mm: 0.3 })
    expect(drillFile('M48\nINCH\nT1C0.012\n%\nT1\nX1.0Y1.0\nM30\n').smallest_mm).toBeCloseTo(0.305, 3)
  })

  it('reads a job file, and nothing else as one', () => {
    expect(jobFile('{"GeneralSpecs":{"LayerNumber":4,"BoardThickness":1.2,"Size":{"X":10,"Y":20}}}')).toMatchObject({ layers: 4, thickness_mm: 1.2, width_mm: 10, height_mm: 20, finish: null })
    expect(jobFile('not json')).toBeNull()
  })

  it('refuses what is not a zip, in plain words', () => {
    expect(() => readGerbers(Buffer.from('hello'))).toThrow(/could not be opened as a zip/)
  })
})

describe('the bill of materials and the pick and place', () => {
  it('reads the sample BOM: designators split, LCSC parts, library and stock', () => {
    const b = readBom(bom)
    expect(b.lines).toHaveLength(133)
    expect(b.has).toEqual({ lcsc: true, stock: true, library: true, mpn: true })
    const caps = b.lines.find((l) => l.lcsc === 'C71629')!
    expect(caps.refs).toHaveLength(110)
    expect(caps).toMatchObject({ value: '100n', qty: 110, library: 'extended', footprint: 'C_0402_1005Metric' })
    expect(b.lines.find((l) => l.refs.includes('F1'))).toMatchObject({ stock: 0, lcsc: 'C5249699' })
    expect(b.lines.find((l) => l.refs.includes('D11'))?.manufacturer).toBe('Nexperia')
    expect(b.lines.find((l) => l.refs.includes('C84'))?.manufacturer).toBeNull()
  })

  it('reads other tools\' column names and ranges', () => {
    const b = readBom('Reference,Value,Footprint,LCSC,Quantity\n"R1-R3",10k,0402,c25744,3\nU1,MCU,QFN,,1\n')
    expect(b.lines[0]).toMatchObject({ refs: ['R1', 'R2', 'R3'], lcsc: 'C25744', qty: 3 })
    expect(b.lines[1]?.lcsc).toBeNull()
    expect(b.has.stock).toBe(false)
    expect(designators('C1, C2 C3;C4')).toEqual(['C1', 'C2', 'C3', 'C4'])
    expect(() => readBom('a,b\n1,2\n')).toThrow(/no designator column/)
  })

  it('reads the sample placements with both sides', () => {
    const p = readCpl(cpl)
    expect(p).toHaveLength(774)
    expect(p[0]).toEqual({ row: 2, ref: 'C84', x: 279.05, y: -220.2, side: 'bottom', rotation: 180 })
    expect(p.filter((x) => x.side === 'bottom')).toHaveLength(99)
  })

  it('reads lengths with their units', () => {
    expect(mmOf('279.05mm')).toBe(279.05)
    expect(mmOf('100mil')).toBeCloseTo(2.54)
    expect(mmOf('1in')).toBe(25.4)
    expect(mmOf('abc')).toBeNull()
    expect(() => readCpl('Designator,Layer\nR1,Top\n')).toThrow(/no centre columns/)
  })
})

describe('the overview', () => {
  it('finds all six topics in a full overview', () => {
    const o = checkOverview(OVERVIEW)
    expect(o.topics.filter((t) => !t.found).map((t) => t.id)).toEqual([])
    expect(o.ok).toBe(true)
  })

  it('asks for what a thin one leaves out', () => {
    const o = checkOverview('A board.')
    expect(o.ok).toBe(false)
    expect(o.topics.find((t) => t.id === 'power')).toMatchObject({ found: false, ask: expect.stringMatching(/What powers it/) })
  })
})

describe('the inspection', () => {
  it('passes the sample, with its real warnings and the order options from the files', () => {
    const r = inspect({ gerbers: zip, bom, cpl, overview: OVERVIEW, quantity: 5 })
    expect(r.ok).toBe(true)
    expect(r.summary.board).toMatchObject({ layers: 10, width_mm: 200, height_mm: 160, thickness_mm: 1.6, finish: 'ENIG', impedance: true, smallest_hole_mm: 0.15 })
    expect(r.summary.bom).toMatchObject({ lines: 133, with_lcsc: 133, basic: 5, extended: 128, out_of_stock: 2 })
    expect(r.summary.placements).toMatchObject({ total: 774, top: 675, bottom: 99 })
    const ids = r.findings.map((f) => f.id)
    // F1 (the fuse holder) and J701 (the USB 3 stack) had no stock; ADS7828 has 207 for 2 × 5 needed: enough
    expect(r.findings.find((f) => f.id === 'bom.out_of_stock')?.refs).toEqual(['F1', 'J701'])
    expect(ids).not.toContain('cpl.origin')
    expect(ids).not.toContain('overview.thin')
    expect(r.order_options).toEqual(expect.arrayContaining([
      expect.objectContaining({ option: 'Layers', value: '10', decided: true }),
      expect.objectContaining({ option: 'Dimensions', value: '200 x 160 mm' }),
      expect.objectContaining({ option: 'Surface finish', value: 'ENIG', source: 'the Gerber job file' }),
      expect.objectContaining({ option: 'Assembly side', value: 'Both sides (774 placed parts: 675 top, 99 bottom)' }),
      expect.objectContaining({ option: 'Solder mask colour', decided: false }),
    ]))
    expect(r.recommended.entry).toBe('fabricate')
  })

  it('cross-checks the BOM and the placements both ways', () => {
    const r = inspect({ gerbers: zip, bom: 'Designator,Comment,LCSC Part #\n"C84,X1",22u,C7198\n', cpl: 'Designator,Mid X,Mid Y,Layer,Rotation\nC84,279.05mm,-220.2mm,Bottom,180\nTP1,200,-200,Top,0\n', overview: OVERVIEW })
    expect(r.hand_placed).toEqual(['X1'])
    expect(r.findings.find((f) => f.id === 'match.unplaced')?.refs).toEqual(['X1'])
    expect(r.findings.find((f) => f.id === 'match.unlisted')?.refs).toEqual(['TP1'])
    expect(r.ok).toBe(true)
  })

  it('blocks placements that do not share the Gerbers\' origin', () => {
    const r = inspect({ gerbers: zip, bom: 'Designator,Comment\nR1,1k\nR2,1k\n', cpl: 'Designator,Mid X,Mid Y,Layer,Rotation\nR1,10,10,Top,0\nR2,12,10,Top,0\n', overview: OVERVIEW })
    expect(r.findings[0]).toMatchObject({ id: 'cpl.origin', severity: 'blocking' })
    expect(r.ok).toBe(false)
  })

  it('blocks what is missing, and a designator listed twice', () => {
    const g = zipOf({ 'b-F_Cu.gtl': COPPER('Copper,L1,Top'), 'b-B_Cu.gbl': COPPER('Copper,L3,Bot') , 'b-In1_Cu.g1': COPPER('Copper,L2,Inr') })
    const r = inspect({ gerbers: g, bom: 'Designator,Comment,Qty\nR1,1k,2\n"R1,R2",2k,2\n', cpl: null, overview: 'short' })
    const blocking = r.findings.filter((f) => f.severity === 'blocking').map((f) => f.id)
    expect(blocking).toEqual(expect.arrayContaining(['gerbers.outline', 'gerbers.drill', 'bom.duplicate', 'cpl.missing', 'overview.thin']))
    expect(r.findings.map((f) => f.id)).toEqual(expect.arrayContaining(['gerbers.layers_odd', 'bom.qty', 'bom.no_lcsc_column', 'gerbers.mask_top']))
    expect(r.ok).toBe(false)
    // blocking first
    expect(r.findings[0]?.severity).toBe('blocking')
  })

  it('reads a small two-layer board named the Protel way, with a drill file called .txt', () => {
    const g = zipOf({ 'b.GTL': COPPER('X'), 'b.GBL': COPPER('X'), 'b.GTS': '', 'b.GBS': '', 'b.GTO': '', 'b.GKO': OUTLINE, 'holes.txt': DRILL })
    const r = inspect({ gerbers: g, bom: 'Designator,Comment,LCSC\nR1,1k,C1\n', cpl: 'Designator,Mid X,Mid Y,Layer,Rotation\nR1,10,-10,T,0\n', overview: OVERVIEW, built: true })
    expect(r.summary.board).toMatchObject({ layers: 2, width_mm: 50, height_mm: 40, smallest_hole_mm: 0.3, holes: 3 })
    expect(r.gerbers?.files.find((f) => f.name === 'holes.txt')).toMatchObject({ kind: 'drill', from: 'content' })
    expect(r.ok).toBe(true)
    expect(r.recommended.entry).toBe('bringup')
  })

  it('never throws on unreadable files: each is a blocking finding', () => {
    const r = inspect({ gerbers: Buffer.from('nope'), bom: 'x', cpl: 'y', overview: OVERVIEW })
    expect(r.findings.filter((f) => f.severity === 'blocking').map((f) => f.id)).toEqual(['gerbers.unreadable', 'bom.unreadable', 'cpl.unreadable'])
  })

  it('keeps a view without each line and placement', () => {
    const v = inspectionView(inspect({ gerbers: zip, bom, cpl, overview: OVERVIEW }))
    expect(v).not.toHaveProperty('placements')
    expect(v.layers).toHaveLength(22)
    expect(JSON.stringify(v).length).toBeLessThan(20_000)
  })

  it('names where the files go in the repository', () => {
    expect(importPaths('Potroller Carrier')).toEqual({
      dir: 'hardware/potroller-carrier/release/revA', gerbers: 'hardware/potroller-carrier/release/revA/potroller-carrier-gerbers.zip',
      bom: 'hardware/potroller-carrier/release/revA/potroller-carrier-jlc-bom.csv', cpl: 'hardware/potroller-carrier/release/revA/potroller-carrier-jlc-cpl.csv',
      inspection: 'hardware/potroller-carrier/release/revA/import.json', overview: 'docs/overview.md',
    })
  })
})

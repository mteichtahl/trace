/**
 * The enclosure engine's outputs that changed only in what every export changes (test-esp32 log #222: the release
 * package's change rewrote mechanical/out/case*.step and .3mf, their only differences a STEP time stamp and lib3mf's
 * random UUIDs) are the same file, so mech.build leaves them as they are.
 */
import { crc32, deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { modelWithoutStamps, sameApartFromStamps, stepWithoutStamp, unzip } from '../../../src/tools/mech/stable-output.js'

const step = (stamp: string, body = '#1=CARTESIAN_POINT(\'\',(0.,0.,0.));'): Buffer => Buffer.from([
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('Open CASCADE Model'),'2;1');",
  `FILE_NAME('case','${stamp}',('Author'),('Open CASCADE'),`, "  'Open CASCADE STEP processor 8.0','build123d','Unknown');",
  "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", 'ENDSEC;', 'DATA;', body, 'ENDSEC;', 'END-ISO-10303-21;', '',
].join('\n'))

/** A zip of deflated entries (the entry dates given); `zip64` as lib3mf writes it: sizes and offsets in zip64 fields. */
function zip(entries: [string, string][], date = 0, zip64 = false): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of entries) {
    const raw = Buffer.from(text)
    const data = deflateRawSync(raw)
    const n = Buffer.from(name)
    const l = Buffer.alloc(30)
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt16LE(date, 12)
    l.writeUInt32LE(crc32(raw), 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(n.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(45, 4); c.writeUInt16LE(45, 6); c.writeUInt16LE(8, 10); c.writeUInt16LE(date, 14)
    c.writeUInt32LE(crc32(raw), 16); c.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20); c.writeUInt32LE(zip64 ? 0xffffffff : raw.length, 24)
    c.writeUInt16LE(n.length, 28); c.writeUInt32LE(zip64 ? 0xffffffff : offset, 42)
    const x = Buffer.alloc(zip64 ? 28 : 0)
    if (zip64) { x.writeUInt16LE(1, 0); x.writeUInt16LE(24, 2); x.writeBigUInt64LE(BigInt(raw.length), 4); x.writeBigUInt64LE(BigInt(data.length), 12); x.writeBigUInt64LE(BigInt(offset), 20) }
    c.writeUInt16LE(x.length, 30)
    locals.push(l, n, data)
    central.push(c, n, x)
    offset += 30 + n.length + data.length
  }
  const cd = Buffer.concat(central)
  const e = Buffer.alloc(22)
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(zip64 ? 0xffff : entries.length, 8); e.writeUInt16LE(zip64 ? 0xffff : entries.length, 10)
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(zip64 ? 0xffffffff : offset, 16)
  if (!zip64) return Buffer.concat([...locals, cd, e])
  const z = Buffer.alloc(56)
  z.writeUInt32LE(0x06064b50, 0); z.writeBigUInt64LE(44n, 4); z.writeBigUInt64LE(BigInt(entries.length), 24); z.writeBigUInt64LE(BigInt(entries.length), 32)
  z.writeBigUInt64LE(BigInt(cd.length), 40); z.writeBigUInt64LE(BigInt(offset), 48)
  const loc = Buffer.alloc(20)
  loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(offset + cd.length), 8); loc.writeUInt32LE(1, 16)
  return Buffer.concat([...locals, cd, z, loc, e])
}
const model = (uuid: string, created: string, v = '0'): string =>
  `<?xml version="1.0"?>\n<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">\n`
  + `<metadata name="CreationDate">${created}</metadata>\n<resources><object id="1" name="lid" p:UUID="${uuid}"><mesh><vertices><vertex x="${v}" y="0" z="0"/></vertices></mesh></object></resources>\n`
  + `<build p:UUID="${uuid}-b"><item objectid="1" p:UUID="${uuid}-i"/></build></model>`
const threemf = (uuid: string, created: string, v = '0', date = 0, zip64 = false): Buffer =>
  zip([['3D/3dmodel.model', model(uuid, created, v)], ['[Content_Types].xml', '<Types/>'], ['_rels/.rels', '<Relationships/>']], date, zip64)

describe('the same case file, apart from its export stamps', () => {
  it('STEP: only the header\'s time stamp differs (change #44) → the same; a point moved → changed', () => {
    expect(sameApartFromStamps('case.step', step('2026-11-05T10:41:13'), step('2026-11-06T12:08:19'))).toBe(true)
    expect(sameApartFromStamps('case-lid.step', step('2026-11-05T10:41:13'), step('2026-11-06T12:08:19', "#1=CARTESIAN_POINT('',(0.,0.,1.));"))).toBe(false)
    // a FILE_NAME in the data is content, not the header
    expect(stepWithoutStamp(step('x', "#1=DESCRIPTION('FILE_NAME(''a'',''b''');").toString())).toContain("FILE_NAME(''a'',''b''")
  })

  it('3MF: new random UUIDs, a new creation date and new zip entry dates → the same; a vertex moved → changed', () => {
    const before = threemf('49cb9c15-80d0-4fe0-8615-ab9ff459279f', '2026-11-05')
    expect(sameApartFromStamps('case-lid.3mf', before, threemf('ff1f3d37-cfa8-48c9-93e5-55a4d23fc0fa', '2026-11-06', '0', 0x5a21))).toBe(true)
    expect(sameApartFromStamps('case-lid.3mf', before, threemf('ff1f3d37-cfa8-48c9-93e5-55a4d23fc0fa', '2026-11-06', '0.5'))).toBe(false)
    expect(modelWithoutStamps(model('u', 'd'))).not.toMatch(/"u"|>d</)
    // lib3mf writes zip64 (its sizes and offsets in the extra fields): read the same way
    const lib3mf = threemf('49cb9c15', '2026-11-05', '0', 0, true)
    expect([...unzip(lib3mf)!.keys()]).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels'])
    expect(sameApartFromStamps('case-lid.3mf', lib3mf, threemf('ff1f3d37', '2026-11-06', '0', 0, true))).toBe(true)
    expect(sameApartFromStamps('case-lid.3mf', lib3mf, threemf('ff1f3d37', '2026-11-06', '1', 0, true))).toBe(false)
  })

  it('anything it cannot read, or another kind of file, counts as changed (written as before)', () => {
    expect(sameApartFromStamps('case-lid.3mf', Buffer.from('not a zip'), Buffer.from('not a zip either'))).toBe(false)
    expect(sameApartFromStamps('case-lid.3mf', threemf('a', 'd'), zip([['3D/3dmodel.model', model('b', 'd')]]))).toBe(false)
    expect(sameApartFromStamps('case-lid.stl', Buffer.from('solid a'), Buffer.from('solid b'))).toBe(false)
    expect(sameApartFromStamps('fit.json', Buffer.from('{}'), Buffer.from('{}'))).toBe(true)
    expect(unzip(Buffer.from('PK'))).toBeNull()
  })
})

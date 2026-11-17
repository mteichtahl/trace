import { deflateRawSync } from 'node:zlib'

/** A zip of these files, stored deflated (the reader under test reads what JLCPCB's exports and zip tools write). */
export function zipOf(files: Record<string, string>): Buffer {
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

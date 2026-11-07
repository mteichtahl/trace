/**
 * Whether a file the enclosure engine wrote again is the same as the one already in mechanical/out, apart from what
 * changes on every export (test-esp32 log #222). A build that changed nothing must not put the case files in a change:
 * the release package's change (#44) rewrote case*.step and case-*.3mf, and their only differences were
 *
 *   STEP   the header's FILE_NAME time stamp (OCCT writes the time of export; the name beside it too)
 *   3MF    lib3mf's production-extension p:UUID attributes (new random ones on each write), and the CreationDate and
 *          ModificationDate metadata when a writer sets them; the zip's own entry dates are not content
 *
 * Anything else that differs, or a file that cannot be read (a zip this reader does not handle), counts as changed:
 * the new file is written, as before.
 */
import { extname } from 'node:path'
import { inflateRawSync } from 'node:zlib'

/** The STEP text with its header's FILE_NAME name and time stamp blanked. */
export function stepWithoutStamp(text: string): string {
  const end = text.indexOf('ENDSEC;')
  if (end < 0) return text
  const header = text.slice(0, end).replace(/FILE_NAME\s*\(\s*'(?:[^']|'')*'\s*,\s*'(?:[^']|'')*'/, "FILE_NAME('',''")
  return header + text.slice(end)
}

/** A 3MF model part with its random identifiers and dates blanked. */
export function modelWithoutStamps(xml: string): string {
  return xml
    .replace(/(\s(?:[A-Za-z_][\w.-]*:)?UUID=")[^"]*"/g, '$1"')
    .replace(/(<metadata\b[^>]*\bname="(?:CreationDate|ModificationDate)"[^>]*>)[^<]*(<\/metadata>)/g, '$1$2')
}

/** A zip's entries by name, uncompressed (zip64 too: lib3mf writes it); null when this reader cannot read it
 * (encryption, a compression other than stored or deflate, a damaged file). */
export function unzip(buf: Buffer): Map<string, Buffer> | null {
  const MAX = 0xffffffff
  try {
    // the end of the central directory: its signature, searched back over a comment of at most 64 KiB
    let eocd = -1
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    if (eocd < 0) return null
    let count = buf.readUInt16LE(eocd + 10)
    let at = buf.readUInt32LE(eocd + 16)
    if (count === 0xffff || at === MAX) {
      // zip64: the locator just before names the zip64 end record, which has the real count and offset
      if (eocd < 20 || buf.readUInt32LE(eocd - 20) !== 0x07064b50) return null
      const z = Number(buf.readBigUInt64LE(eocd - 12))
      if (buf.readUInt32LE(z) !== 0x06064b50) return null
      count = Number(buf.readBigUInt64LE(z + 32))
      at = Number(buf.readBigUInt64LE(z + 48))
    }
    const out = new Map<string, Buffer>()
    for (let n = 0; n < count; n++) {
      if (buf.readUInt32LE(at) !== 0x02014b50) return null
      const flags = buf.readUInt16LE(at + 8)
      const method = buf.readUInt16LE(at + 10)
      let packed = buf.readUInt32LE(at + 20)
      let size = buf.readUInt32LE(at + 24)
      const nameLen = buf.readUInt16LE(at + 28)
      const extraLen = buf.readUInt16LE(at + 30)
      const commentLen = buf.readUInt16LE(at + 32)
      let local = buf.readUInt32LE(at + 42)
      const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8')
      // the zip64 extra field holds, in this order, each of these that is 0xffffffff above
      for (let e = at + 46 + nameLen; e + 4 <= at + 46 + nameLen + extraLen;) {
        const id = buf.readUInt16LE(e)
        const len = buf.readUInt16LE(e + 2)
        if (id === 0x0001) {
          let f = e + 4
          const next = (): number => { const v = Number(buf.readBigUInt64LE(f)); f += 8; return v }
          if (size === MAX) size = next()
          if (packed === MAX) packed = next()
          if (local === MAX) local = next()
        }
        e += 4 + len
      }
      if (flags & 1 || buf.readUInt32LE(local) !== 0x04034b50) return null
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
      const data = buf.subarray(start, start + packed)
      const raw = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null
      if (!raw || raw.length !== size) return null
      out.set(name, raw)
      at += 46 + nameLen + extraLen + commentLen
    }
    return out
  } catch {
    return null
  }
}

/** Whether `next` says the same as `prev` for the engine output `name`, apart from what changes on every export. */
export function sameApartFromStamps(name: string, prev: Uint8Array, next: Uint8Array): boolean {
  const a = Buffer.from(prev)
  const b = Buffer.from(next)
  if (a.equals(b)) return true
  const ext = extname(name).toLowerCase()
  if (ext === '.step' || ext === '.stp') return stepWithoutStamp(a.toString('latin1')) === stepWithoutStamp(b.toString('latin1'))
  if (ext === '.3mf') {
    const za = unzip(a)
    const zb = unzip(b)
    if (!za || !zb || za.size !== zb.size) return false
    for (const [entry, x] of za) {
      const y = zb.get(entry)
      if (!y) return false
      if (x.equals(y)) continue
      if (!entry.toLowerCase().endsWith('.model') || modelWithoutStamps(x.toString('utf8')) !== modelWithoutStamps(y.toString('utf8'))) return false
    }
    return true
  }
  return false
}

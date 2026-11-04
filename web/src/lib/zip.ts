/**
 * A zip made in the browser, for downloading several files at once (a revision's renders). Files are stored, not
 * compressed: PNGs are already compressed, so deflate would cost time for almost nothing. Any unzip tool opens it.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** The DOS date and time a zip entry carries. */
function dosTime(at: Date): { time: number; date: number } {
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((Math.max(at.getFullYear(), 1980) - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  }
}

/** A stored zip of `files` (names as given, UTF-8). */
export function zipStored(files: readonly { name: string; bytes: Uint8Array }[], at: Date = new Date()): Uint8Array {
  const enc = new TextEncoder()
  const { time, date } = dosTime(at)
  const local: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const name = enc.encode(f.name)
    const crc = crc32(f.bytes)
    const head = new Uint8Array(30 + name.length)
    const h = new DataView(head.buffer)
    h.setUint32(0, 0x04034b50, true)
    h.setUint16(4, 20, true)
    h.setUint16(6, 0x0800, true) // names are UTF-8
    h.setUint16(8, 0, true) // stored
    h.setUint16(10, time, true)
    h.setUint16(12, date, true)
    h.setUint32(14, crc, true)
    h.setUint32(18, f.bytes.length, true)
    h.setUint32(22, f.bytes.length, true)
    h.setUint16(26, name.length, true)
    head.set(name, 30)
    local.push(head, f.bytes)

    const dir = new Uint8Array(46 + name.length)
    const d = new DataView(dir.buffer)
    d.setUint32(0, 0x02014b50, true)
    d.setUint16(4, 20, true)
    d.setUint16(6, 20, true)
    d.setUint16(8, 0x0800, true)
    d.setUint16(10, 0, true)
    d.setUint16(12, time, true)
    d.setUint16(14, date, true)
    d.setUint32(16, crc, true)
    d.setUint32(20, f.bytes.length, true)
    d.setUint32(24, f.bytes.length, true)
    d.setUint16(28, name.length, true)
    d.setUint32(42, offset, true)
    dir.set(name, 46)
    central.push(dir)
    offset += head.length + f.bytes.length
  }
  const size = central.reduce((s, c) => s + c.length, 0)
  const end = new Uint8Array(22)
  const e = new DataView(end.buffer)
  e.setUint32(0, 0x06054b50, true)
  e.setUint16(8, files.length, true)
  e.setUint16(10, files.length, true)
  e.setUint32(12, size, true)
  e.setUint32(16, offset, true)
  const out = new Uint8Array(offset + size + end.length)
  let at2 = 0
  for (const part of [...local, ...central, end]) { out.set(part, at2); at2 += part.length }
  return out
}

/** Save bytes as a file the person downloads. */
export function saveBytes(name: string, bytes: Uint8Array, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

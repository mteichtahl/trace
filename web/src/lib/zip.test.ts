/** The browser's stored zip (lib/zip.ts): the standard CRC-32, and a zip whose headers and directory point at its files. */
import { describe, expect, it } from 'vitest'
import { crc32, zipStored } from './zip'

const enc = new TextEncoder()

describe('zipStored', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })

  it('stores each file after its header, and the directory and its end record count and find them', () => {
    const files = [{ name: 'a_rev-B_2026-11-05_board.png', bytes: enc.encode('board bytes') }, { name: 'b.png', bytes: enc.encode('xy') }]
    const z = zipStored(files, new Date(2026, 10, 5, 9, 30, 0))
    const v = new DataView(z.buffer)
    // the first local header, its name and its bytes
    expect(v.getUint32(0, true)).toBe(0x04034b50)
    expect(v.getUint16(8, true)).toBe(0) // stored
    expect(v.getUint32(14, true)).toBe(crc32(files[0]!.bytes))
    const n0 = v.getUint16(26, true)
    expect(new TextDecoder().decode(z.slice(30, 30 + n0))).toBe(files[0]!.name)
    expect(new TextDecoder().decode(z.slice(30 + n0, 30 + n0 + 11))).toBe('board bytes')
    // the end record: two entries, and the directory where it says
    const end = z.length - 22
    expect(v.getUint32(end, true)).toBe(0x06054b50)
    expect(v.getUint16(end + 10, true)).toBe(2)
    const dir = v.getUint32(end + 16, true)
    expect(v.getUint32(dir, true)).toBe(0x02014b50)
    // the second entry's local header is where the directory says
    const second = dir + 46 + n0
    expect(v.getUint32(second, true)).toBe(0x02014b50)
    expect(v.getUint32(v.getUint32(second + 42, true), true)).toBe(0x04034b50)
    // the date: 5 Nov 2026
    expect(v.getUint16(12, true)).toBe(((2026 - 1980) << 9) | (11 << 5) | 5)
  })
})

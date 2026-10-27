/**
 * Section sizes from an ELF image's section headers (32 or 64 bit, either byte order), read in the browser so a
 * firmware image shows something true even before trace's `firmware.size` has run: what goes to flash (allocated
 * and not writable, plus initialised data) and what to RAM (writable: .data and .bss).
 */
export interface ElfSection {
  name: string
  size: number
  addr: number
  alloc: boolean
  write: boolean
  exec: boolean
  nobits: boolean
}

export interface ElfSizes {
  sections: ElfSection[]
  flash: number
  ram: number
  bits: 32 | 64
}

export function readElf(buf: ArrayBuffer): ElfSizes | null {
  const v = new DataView(buf)
  if (buf.byteLength < 52 || v.getUint32(0) !== 0x7f454c46) return null
  const bits = v.getUint8(4) === 2 ? 64 : 32
  const le = v.getUint8(5) === 1
  const u16 = (o: number) => v.getUint16(o, le)
  const u32 = (o: number) => v.getUint32(o, le)
  const uN = (o: number) => (bits === 64 ? Number(v.getBigUint64(o, le)) : u32(o))
  const shoff = bits === 64 ? uN(0x28) : u32(0x20)
  const shentsize = u16(bits === 64 ? 0x3a : 0x2e)
  const shnum = u16(bits === 64 ? 0x3c : 0x30)
  const shstrndx = u16(bits === 64 ? 0x3e : 0x32)
  if (!shoff || shoff + shnum * shentsize > buf.byteLength) return null
  const hdr = (i: number) => {
    const o = shoff + i * shentsize
    return bits === 64
      ? { name: u32(o), type: u32(o + 4), flags: uN(o + 8), addr: uN(o + 0x10), offset: uN(o + 0x18), size: uN(o + 0x20) }
      : { name: u32(o), type: u32(o + 4), flags: u32(o + 8), addr: u32(o + 0x0c), offset: u32(o + 0x10), size: u32(o + 0x14) }
  }
  const strs = hdr(shstrndx)
  const nameAt = (off: number) => {
    let s = ''
    for (let i = strs.offset + off; i < buf.byteLength && v.getUint8(i) !== 0; i++) s += String.fromCharCode(v.getUint8(i))
    return s
  }
  const sections: ElfSection[] = []
  for (let i = 1; i < shnum; i++) {
    const h = hdr(i)
    const alloc = (h.flags & 2) !== 0
    if (!alloc || h.size === 0) continue
    sections.push({ name: nameAt(h.name), size: h.size, addr: h.addr, alloc, write: (h.flags & 1) !== 0, exec: (h.flags & 4) !== 0, nobits: h.type === 8 })
  }
  const flash = sections.filter((s) => !s.nobits).reduce((n, s) => n + s.size, 0)
  const ram = sections.filter((s) => s.write).reduce((n, s) => n + s.size, 0)
  return { sections: sections.sort((a, b) => b.size - a.size), flash, ram, bits }
}

/** The bytes an Intel HEX file programs (data records only). */
export function hexBytes(text: string): number {
  let n = 0
  for (const line of text.split(/\r?\n/)) {
    if (line[0] !== ':' || line.length < 11) continue
    if (line.slice(7, 9) === '00') n += parseInt(line.slice(1, 3), 16) || 0
  }
  return n
}

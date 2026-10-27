/** Archives opened in the browser (.zip with fflate; .tar and .tar.gz with fflate's gunzip and a small tar reader). */
export interface Entry {
  path: string
  size: number
  bytes: Uint8Array
}

/** A tar archive's regular files (ustar and old-style headers; long names via the ustar prefix or GNU 'L'). */
export function untar(data: Uint8Array): Entry[] {
  const out: Entry[] = []
  const dec = new TextDecoder()
  const str = (b: Uint8Array) => dec.decode(b).replace(/\0[\s\S]*$/, '')
  let i = 0
  let longName: string | null = null
  while (i + 512 <= data.length) {
    const h = data.subarray(i, i + 512)
    if (h.every((b) => b === 0)) break
    const name = str(h.subarray(0, 100))
    const size = parseInt(str(h.subarray(124, 136)).trim() || '0', 8) || 0
    const type = String.fromCharCode(h[156] || 48)
    const prefix = dec.decode(h.subarray(257, 263)).startsWith('ustar') ? str(h.subarray(345, 500)) : ''
    const body = data.subarray(i + 512, i + 512 + size)
    i += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') {
      longName = str(body)
      continue
    }
    const path = longName ?? (prefix ? `${prefix}/${name}` : name)
    longName = null
    if (type === '0' || type === '\0' || type === '7') out.push({ path, size, bytes: body.slice() })
  }
  return out
}

export async function unpack(bytes: ArrayBuffer, ext: string): Promise<Entry[]> {
  const fflate = await import('fflate')
  const u8 = new Uint8Array(bytes)
  if (ext === 'zip' || ext === 'gerber-zip') {
    const files = fflate.unzipSync(u8)
    return Object.entries(files)
      .filter(([p]) => !p.endsWith('/') && !p.startsWith('__MACOSX/'))
      .map(([path, b]) => ({ path, size: b.length, bytes: b }))
  }
  if (ext === 'tar.gz' || ext === 'tgz') return untar(fflate.gunzipSync(u8))
  if (ext === 'tar') return untar(u8)
  throw new Error(`Cannot open .${ext} archives here.`)
}

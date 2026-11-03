/**
 * Single-file gzip (netlist.json.gz, a bitstream .gz): the name inside (without .gz) and the bytes, unpacked in the
 * browser with DecompressionStream, or fflate where the browser has none.
 */

/** "netlist.json.gz" → "netlist.json"; null when the name does not end in .gz (or is a .tar.gz). */
export function innerName(name: string): string | null {
  const m = /^(.*[^/])\.gz$/i.exec(name)
  if (!m || /\.tar$/i.test(m[1]!)) return null
  return m[1]!
}

/** Is it gzip (its magic bytes)? */
export const isGzip = (b: Uint8Array): boolean => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b

export async function gunzip(bytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (!isGzip(u8)) throw new Error('This file is not gzip compressed.')
  if (typeof DecompressionStream !== 'undefined' && typeof Response !== 'undefined') {
    try {
      const stream = new Blob([u8 as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'))
      return new Uint8Array(await new Response(stream).arrayBuffer())
    } catch {
      // fall through to fflate
    }
  }
  const { gunzipSync } = await import('fflate')
  return gunzipSync(u8)
}

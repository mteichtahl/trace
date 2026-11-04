/** A 6-digit authenticator code (RFC 6238, SHA-1, 30 s) from a base32 secret, for the smoke user's sign-in. */
import { createHmac } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32(secret: string): Buffer {
  const clean = secret.replace(/[\s=-]/g, '').toUpperCase()
  let bits = ''
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch)
    if (v < 0) throw new Error('The authenticator secret is not base32')
    bits += v.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

export function totp(secret: string, now = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)))
  const mac = createHmac('sha1', base32(secret)).update(counter).digest()
  const off = mac[mac.length - 1]! & 0x0f
  const n = (mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000
  return String(n).padStart(6, '0')
}

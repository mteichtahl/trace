/**
 * Web Push, by hand on node:crypto (docs/push.md): no library, so nothing new to keep up to date.
 *
 *   encryption  RFC 8291 (Message Encryption for Web Push) with RFC 8188's aes128gcm content coding: an ephemeral
 *               P-256 key pair per message, ECDH with the browser's key, HKDF keyed by the browser's auth secret.
 *               The push service sees only ciphertext
 *   identity    RFC 8292 (VAPID): a short ES256 JWT for the push service's origin, signed with the installation's
 *               key pair (made once, the first time the app asks for it: src/web/push-keys.ts), and its public key, which the
 *               browser subscribed with
 *
 * One send is one HTTP POST to the subscription's endpoint. 201 (or 200/202): accepted. 404 or 410: the subscription
 * is gone (the person turned notifications off, or the browser dropped it): the caller stops using it. 429 and 5xx:
 * try later. Anything else is a mistake here and is logged.
 */
import { createECDH, createHmac, createCipheriv, createPrivateKey, randomBytes, sign } from 'node:crypto'

export const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url')
export const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url')

/** The installation's push key pair: raw P-256, base64url (the private scalar d, the uncompressed public point). */
export interface VapidKeys { publicKey: string; privateKey: string; subject: string }

/** A new key pair (once per installation: src/web/push-keys.ts). */
export function generateVapidKeys(subject: string): VapidKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()), subject }
}

/** Whether a stored key pair is whole: a 65-byte public point, a 32-byte scalar that makes it, and a subject. */
export function validVapid(k: unknown): k is VapidKeys {
  if (!k || typeof k !== 'object') return false
  const v = k as Partial<VapidKeys>
  if (typeof v.publicKey !== 'string' || typeof v.privateKey !== 'string' || typeof v.subject !== 'string') return false
  if (!/^(mailto:|https:\/\/)/.test(v.subject)) return false
  try {
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(fromB64url(v.privateKey))
    return ecdh.getPublicKey().equals(fromB64url(v.publicKey))
  } catch {
    return false
  }
}

const hmac = (key: Uint8Array, data: Uint8Array): Buffer => createHmac('sha256', key).update(data).digest()
const ONE = Buffer.from([1])

/** The aes128gcm body for one message (RFC 8291 section 3.4). `as` and `salt` are for tests only. */
export function encrypt(payload: Uint8Array, p256dh: string, auth: string, o: { asPrivate?: Uint8Array; salt?: Uint8Array } = {}): Buffer {
  const uaPublic = fromB64url(p256dh)
  const authSecret = fromB64url(auth)
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('the subscription key is not an uncompressed P-256 point')
  if (authSecret.length !== 16) throw new Error('the subscription auth secret is not 16 bytes')
  const as = createECDH('prime256v1')
  if (o.asPrivate) as.setPrivateKey(Buffer.from(o.asPrivate))
  else as.generateKeys()
  const asPublic = as.getPublicKey()
  const ecdhSecret = as.computeSecret(uaPublic)
  // IKM from the shared secret, keyed by the browser's auth secret, bound to both public keys
  const prkKey = hmac(authSecret, ecdhSecret)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, ONE])
  const ikm = hmac(prkKey, keyInfo)
  const salt = o.salt ? Buffer.from(o.salt) : randomBytes(16)
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), ONE])).subarray(0, 16)
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), ONE])).subarray(0, 12)
  // one record: the payload, then the last-record delimiter 0x02, no padding
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(4096)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body])
}

/** The VAPID Authorization header for an endpoint's push service (RFC 8292). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, nowS: number, ttlS = 12 * 3600): string {
  const aud = new URL(endpoint).origin
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(Buffer.from(JSON.stringify({ aud, exp: Math.floor(nowS) + ttlS, sub: keys.subject })))
  const pub = fromB64url(keys.publicKey)
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) }, format: 'jwk' })
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`
}

export interface PushTarget { endpoint: string; p256dh: string; auth: string }
export interface PushOptions {
  /** seconds the push service keeps it for a device that is off (default a day) */
  ttl?: number
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
  /** a newer message with the same topic replaces one still waiting at the push service (at most 32 base64url chars) */
  topic?: string
}
export type PushResult = { ok: true; status: number } | { ok: false; status: number; gone: boolean; retry: boolean; detail: string }

/** Send one message. Never throws for an HTTP answer; a network failure is `retry`. */
export async function sendPush(target: PushTarget, payload: unknown, keys: VapidKeys, o: PushOptions & { now: () => number; fetch: typeof fetch }): Promise<PushResult> {
  const body = encrypt(Buffer.from(JSON.stringify(payload)), target.p256dh, target.auth)
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(o.ttl ?? 24 * 3600),
    Urgency: o.urgency ?? 'normal',
    Authorization: vapidAuthorization(target.endpoint, keys, o.now() / 1000),
  }
  if (o.topic) headers.Topic = o.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
  try {
    const res = await o.fetch(target.endpoint, { method: 'POST', headers, body: new Uint8Array(body) })
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status }
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    return { ok: false, status: res.status, gone: res.status === 404 || res.status === 410, retry: res.status === 429 || res.status >= 500, detail }
  } catch (e) {
    return { ok: false, status: 0, gone: false, retry: true, detail: e instanceof Error ? e.message : String(e) }
  }
}

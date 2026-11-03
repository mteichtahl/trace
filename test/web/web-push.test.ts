import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { b64url, encrypt, fromB64url, generateVapidKeys, sendPush, validVapid, vapidAuthorization } from '../../src/web/web-push.js'

// RFC 8291, Appendix A: the worked example
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

/** What a browser does: decrypt with its own private key and auth secret. */
function decrypt(body: Buffer, uaPrivate: string, auth: string): string {
  const salt = body.subarray(0, 16)
  const idlen = body[20]!
  const asPublic = body.subarray(21, 21 + idlen)
  const ua = createECDH('prime256v1')
  ua.setPrivateKey(fromB64url(uaPrivate))
  const h = (k: Uint8Array, d: Uint8Array) => createHmac('sha256', k).update(d).digest()
  const prkKey = h(fromB64url(auth), ua.computeSecret(asPublic))
  const ikm = h(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]))
  const prk = h(salt, ikm)
  const cek = h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16)
  const nonce = h(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12)
  const ct = body.subarray(21 + idlen)
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(ct.subarray(ct.length - 16))
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  expect(pt[pt.length - 1]).toBe(2)
  return pt.subarray(0, -1).toString()
}

describe('Web Push encryption (RFC 8291)', () => {
  it('matches the RFC\'s worked example byte for byte', () => {
    const out = encrypt(Buffer.from(RFC.plaintext), RFC.uaPublic, RFC.auth, { asPrivate: fromB64url(RFC.asPrivate), salt: fromB64url(RFC.salt) })
    expect(b64url(out)).toBe(RFC.body)
  })
  it('a browser can read what it sends, with a fresh key and salt each time', () => {
    const a = encrypt(Buffer.from('{"title":"Motor driver"}'), RFC.uaPublic, RFC.auth)
    const b = encrypt(Buffer.from('{"title":"Motor driver"}'), RFC.uaPublic, RFC.auth)
    expect(a.equals(b)).toBe(false)
    expect(decrypt(a, RFC.uaPrivate, RFC.auth)).toBe('{"title":"Motor driver"}')
  })
  it('refuses a key that is not a P-256 point', () => {
    expect(() => encrypt(Buffer.from('x'), b64url(Buffer.alloc(33, 2)), RFC.auth)).toThrow(/P-256/)
  })
})

describe('VAPID (RFC 8292)', () => {
  const keys = generateVapidKeys('mailto:admin@example.com')
  it('makes a whole key pair, and tells a broken one apart', () => {
    expect(validVapid(keys)).toBe(true)
    expect(validVapid({ ...keys, publicKey: generateVapidKeys('mailto:x@y').publicKey })).toBe(false)
    expect(validVapid({ ...keys, subject: 'admin@example.com' })).toBe(false)
  })
  it('signs a token for the push service\'s origin that its public key verifies', () => {
    const h = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 1_800_000_000)
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!
    expect(m[4]).toBe(keys.publicKey)
    const claims = JSON.parse(fromB64url(m[2]!).toString())
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 12 * 3600, sub: 'mailto:admin@example.com' })
    const pub = fromB64url(keys.publicKey)
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) }, format: 'jwk' })
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64url(m[3]!))).toBe(true)
  })
})

describe('sendPush', () => {
  const keys = generateVapidKeys('mailto:admin@example.com')
  const target = { endpoint: 'https://web.push.apple.com/abc', p256dh: RFC.uaPublic, auth: RFC.auth }
  it('posts the encrypted body with the push headers', async () => {
    const f = vi.fn(async () => new Response(null, { status: 201 }))
    const r = await sendPush(target, { title: 't' }, keys, { now: () => 1e12, fetch: f as never, urgency: 'high', topic: 'gate:architecture' })
    expect(r).toEqual({ ok: true, status: 201 })
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1]
    const hd = init.headers as Record<string, string>
    expect(hd['Content-Encoding']).toBe('aes128gcm')
    expect(hd.Urgency).toBe('high')
    expect(hd.Topic).toBe('gatearchitecture')
    expect(hd.Authorization).toMatch(/^vapid t=/)
    expect(decrypt(Buffer.from(init.body as Uint8Array), RFC.uaPrivate, RFC.auth)).toBe('{"title":"t"}')
  })
  it('says a subscription is gone on 410, and to retry on 429 or a network failure', async () => {
    expect(await sendPush(target, {}, keys, { now: () => 1e12, fetch: (async () => new Response('', { status: 410 })) as never })).toMatchObject({ ok: false, gone: true, retry: false })
    expect(await sendPush(target, {}, keys, { now: () => 1e12, fetch: (async () => new Response('', { status: 429 })) as never })).toMatchObject({ ok: false, gone: false, retry: true })
    expect(await sendPush(target, {}, keys, { now: () => 1e12, fetch: (async () => { throw new Error('offline') }) as never })).toMatchObject({ ok: false, retry: true })
  })
})

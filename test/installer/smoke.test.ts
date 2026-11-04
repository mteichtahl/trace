import { describe, expect, it } from 'vitest'
import { SmokeSignIn, type SmokeIo, ensureSmokeUser, projectAddress, smokeEmail, smokePassword, totpCode } from '../../src/installer/smoke.js'

const SECRET = 'trace/smoke/sign-in'
const TOTP = 'JBSWY3DPEHPK3PXP'
const NOW = 1_700_000_000_000

/** Cognito and Secrets Manager in memory, recording every call in order. */
function world(o: { user?: boolean; secret?: string } = {}) {
  const calls: string[] = []
  const secrets = new Map<string, string>(o.secret ? [[SECRET, o.secret]] : [])
  const tags: Record<string, string>[] = []
  let user = o.user ?? false
  let mfa = true
  let verified = ''
  const io: SmokeIo = {
    exists: async () => { calls.push('exists'); return user },
    create: async () => { calls.push('create'); user = true },
    admin: async () => { calls.push('admin') },
    password: async () => { calls.push('password') },
    mfaOff: async () => { calls.push('mfaOff'); mfa = false },
    signIn: async () => {
      calls.push('signIn')
      if (mfa && o.user) throw new Error('asked for a code')
      return 'access-token'
    },
    associate: async (t) => { calls.push(`associate:${t}`); return TOTP },
    verify: async (_t, code) => { calls.push('verify'); verified = code },
    read: async (n) => { calls.push('read'); return secrets.get(n) ?? null },
    write: async (n, v, t) => { calls.push('write'); secrets.set(n, v); tags.push(t) },
  }
  return { io, calls, secrets, tags, verified: () => verified }
}

const opts = { prefix: 'trace', url: 'https://d1ubkf6kpykgil.cloudfront.net/', project: 'mteichtahl/test-esp32', now: () => NOW }

describe('the smoke user', () => {
  it('makes authenticator codes as an authenticator app does (RFC 6238 test vector)', () => {
    // RFC 6238 appendix B, SHA-1, T = 59 s: 94287082, whose last six digits an app shows
    expect(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082')
    expect(() => totpCode('not base32!')).toThrow(/base32/)
  })

  it('has a password Cognito\'s policy takes, and an address that receives no mail', () => {
    const p = smokePassword()
    expect(p.length).toBeGreaterThanOrEqual(32)
    expect(p).toMatch(/[A-Z]/)
    expect(p).toMatch(/[a-z]/)
    expect(p).toMatch(/\d/)
    expect(smokePassword()).not.toBe(p)
    expect(smokeEmail('Trace')).toBe('smoke@trace.trace.invalid')
    expect(projectAddress('mteichtahl/test-esp32')).toBe('mteichtahl~test-esp32')
  })

  it('is made with a password and an authenticator, and its sign-in saved for the smoke test', async () => {
    const w = world()
    const r = await ensureSmokeUser(w.io, opts)
    expect(r).toEqual({ email: 'smoke@trace.trace.invalid', secret: SECRET, state: 'made' })
    expect(w.calls).toEqual(['exists', 'read', 'create', 'admin', 'password', 'mfaOff', 'signIn', 'associate:access-token', 'verify', 'write'])
    expect(w.verified()).toBe(totpCode(TOTP, NOW))
    const saved = SmokeSignIn.parse(JSON.parse(w.secrets.get(SECRET) ?? '{}'))
    expect(saved).toEqual({
      TRACE_SMOKE_URL: 'https://d1ubkf6kpykgil.cloudfront.net', TRACE_SMOKE_EMAIL: 'smoke@trace.trace.invalid',
      TRACE_SMOKE_PASSWORD: expect.stringMatching(/^Sm0k-/), TRACE_SMOKE_TOTP_SECRET: TOTP, TRACE_SMOKE_PROJECT: 'mteichtahl~test-esp32',
    })
    // every key is one the live job passes on (web/smoke/load-secret.mjs takes single-line TRACE_SMOKE_* strings only)
    for (const [k, v] of Object.entries(saved)) {
      expect(k).toMatch(/^TRACE_SMOKE_[A-Z_]+$/)
      expect(v).not.toMatch(/[\r\n]/)
    }
    expect(w.tags[0]).toEqual({ 'trace:installation': 'trace', 'trace:purpose': 'smoke-test' })
  })

  it('is kept as it is when it already works, and stays an admin', async () => {
    const first = world()
    await ensureSmokeUser(first.io, opts)
    const w = world({ user: true, secret: first.secrets.get(SECRET) ?? '' })
    expect((await ensureSmokeUser(w.io, opts)).state).toBe('kept')
    expect(w.calls).toEqual(['exists', 'read', 'admin'])
  })

  it('keeps its password when only the address or the project changed', async () => {
    const first = world()
    await ensureSmokeUser(first.io, opts)
    const before = SmokeSignIn.parse(JSON.parse(first.secrets.get(SECRET) ?? '{}'))
    const w = world({ user: true, secret: first.secrets.get(SECRET) ?? '' })
    expect((await ensureSmokeUser(w.io, { ...opts, url: 'https://trace.example.com', project: 'mteichtahl/trace-sample' })).state).toBe('updated')
    expect(w.calls).not.toContain('password')
    expect(SmokeSignIn.parse(JSON.parse(w.secrets.get(SECRET) ?? '{}'))).toEqual({ ...before, TRACE_SMOKE_URL: 'https://trace.example.com', TRACE_SMOKE_PROJECT: 'mteichtahl~trace-sample' })
  })

  it('gets a new password and authenticator when its secret is gone or unusable, switching the old authenticator off first', async () => {
    for (const secret of [undefined, '{"TRACE_SMOKE_EMAIL":"smoke@trace.trace.invalid"}', 'not json']) {
      const w = world({ user: true, ...(secret ? { secret } : {}) })
      expect((await ensureSmokeUser(w.io, opts)).state).toBe('made')
      expect(w.calls).not.toContain('create')
      expect(w.calls.indexOf('mfaOff')).toBeLessThan(w.calls.indexOf('signIn'))
      expect(SmokeSignIn.safeParse(JSON.parse(w.secrets.get(SECRET) ?? '{}')).success).toBe(true)
    }
  })
})

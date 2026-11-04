import { describe, expect, it } from 'vitest'
import { SmokeSignIn, type SmokeIo, ensureSmokeUser, projectAddress, removeSmokeUser, smokeEmail, smokePassword, totpCode } from '../../src/installer/smoke.js'

const SECRET = 'trace/smoke/sign-in'
const TOTP = 'JBSWY3DPEHPK3PXP'
const NOW = 1_700_000_000_000

/**
 * Cognito and Secrets Manager in memory, recording every call in order. The user signs in only with its current
 * password, and, once an authenticator is on, only with a correct code from it.
 */
function world(o: { user?: boolean; secret?: string; password?: string; mfa?: boolean } = {}) {
  const calls: string[] = []
  const secrets = new Map<string, string>(o.secret ? [[SECRET, o.secret]] : [])
  const tags: Record<string, string>[] = []
  let user = o.user ?? false
  let password = o.password ?? ''
  let mfa = o.mfa ?? Boolean(o.user)
  let verified = ''
  const io: SmokeIo = {
    sub: async () => { calls.push('sub'); return user ? 'sub-smoke' : null },
    create: async () => { calls.push('create'); user = true; mfa = false; return 'sub-smoke' },
    user: async () => { calls.push('user') },
    password: async (_e, p) => { calls.push('password'); password = p },
    mfaOff: async () => { calls.push('mfaOff'); mfa = false },
    signIn: async (_e, p, code) => {
      calls.push(code ? 'signIn+code' : 'signIn')
      if (!user || p !== password) return null
      if (!mfa) return 'access-token'
      return code && code() === totpCode(TOTP, NOW) ? 'access-token' : null
    },
    associate: async (t) => { calls.push(`associate:${t}`); return TOTP },
    verify: async (_t, code) => { calls.push('verify'); verified = code; mfa = true },
    remove: async () => { calls.push('remove'); user = false },
    read: async (n) => { calls.push('read'); return secrets.get(n) ?? null },
    write: async (n, v, t) => { calls.push('write'); secrets.set(n, v); tags.push(t) },
    forget: async (n) => { calls.push('forget'); secrets.delete(n) },
  }
  return { io, calls, secrets, tags, verified: () => verified, password: () => password, exists: () => user }
}

const opts = { prefix: 'trace', url: 'https://d1ubkf6kpykgil.cloudfront.net/', project: 'mteichtahl/test-esp32', now: () => NOW }

/** A smoke user made once, and a world that starts where that one ended. */
async function madeOnce(extra: Record<string, string> = {}) {
  const first = world()
  await ensureSmokeUser(first.io, opts)
  const stored = { ...JSON.parse(first.secrets.get(SECRET) ?? '{}') as Record<string, string>, ...extra }
  return { stored, again: (o: { password?: string; mfa?: boolean } = {}) => world({ user: true, secret: JSON.stringify(stored), password: first.password(), ...o }) }
}

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

  it('is made an ordinary user with a password and an authenticator, and its sign-in saved for the smoke test', async () => {
    const w = world()
    const r = await ensureSmokeUser(w.io, opts)
    expect(r).toEqual({ email: 'smoke@trace.trace.invalid', sub: 'sub-smoke', secret: SECRET, state: 'made' })
    expect(w.calls).toEqual(['sub', 'read', 'create', 'user', 'password', 'mfaOff', 'signIn', 'associate:access-token', 'verify', 'write'])
    expect(w.verified()).toBe(totpCode(TOTP, NOW))
    const saved = SmokeSignIn.parse(JSON.parse(w.secrets.get(SECRET) ?? '{}'))
    expect(saved).toEqual({
      TRACE_SMOKE_URL: 'https://d1ubkf6kpykgil.cloudfront.net', TRACE_SMOKE_EMAIL: 'smoke@trace.trace.invalid',
      TRACE_SMOKE_PASSWORD: w.password(), TRACE_SMOKE_TOTP_SECRET: TOTP, TRACE_SMOKE_PROJECT: 'mteichtahl~test-esp32',
    })
    // every key is one the live job passes on (web/smoke/load-secret.mjs takes single-line TRACE_SMOKE_* strings only)
    for (const [k, v] of Object.entries(saved)) {
      expect(k).toMatch(/^TRACE_SMOKE_[A-Z_]+$/)
      expect(v).not.toMatch(/[\r\n]/)
    }
    expect(w.tags[0]).toEqual({ 'trace:installation': 'trace', 'trace:purpose': 'smoke-test' })
  })

  it('is kept as it is only after it really signs in, password and authenticator code', async () => {
    const { again } = await madeOnce()
    const w = again()
    expect((await ensureSmokeUser(w.io, opts)).state).toBe('kept')
    expect(w.calls).toEqual(['sub', 'read', 'signIn+code', 'user'])
  })

  it('keeps its password when only the address or the project changed', async () => {
    const { stored, again } = await madeOnce()
    const w = again()
    expect((await ensureSmokeUser(w.io, { ...opts, url: 'https://trace.example.com', project: 'mteichtahl/trace-sample' })).state).toBe('updated')
    expect(w.calls).not.toContain('password')
    expect(JSON.parse(w.secrets.get(SECRET) ?? '{}')).toEqual({ ...stored, TRACE_SMOKE_URL: 'https://trace.example.com', TRACE_SMOKE_PROJECT: 'mteichtahl~trace-sample' })
  })

  it('is made again when its password was reset by hand, keeping the keys added to its secret by hand', async () => {
    const { again } = await madeOnce({ TRACE_SMOKE_WRITES: '1' })
    const w = again({ password: 'changed by an admin' })
    expect((await ensureSmokeUser(w.io, opts)).state).toBe('made')
    expect(w.calls).not.toContain('create')
    expect(w.calls.indexOf('mfaOff')).toBeLessThan(w.calls.lastIndexOf('signIn'))
    const saved = JSON.parse(w.secrets.get(SECRET) ?? '{}') as Record<string, string>
    expect(saved.TRACE_SMOKE_WRITES).toBe('1')
    expect(saved.TRACE_SMOKE_PASSWORD).toBe(w.password())
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

  it('says so when it cannot sign in with the password it was just given', async () => {
    const w = world()
    w.io.signIn = async () => null
    await expect(ensureSmokeUser(w.io, opts)).rejects.toThrow(/could not sign in/)
    expect(w.secrets.has(SECRET)).toBe(false)
  })

  it('is removed with its secret when the smoke test is turned off', async () => {
    const { again } = await madeOnce()
    const w = again()
    expect(await removeSmokeUser(w.io, 'trace')).toEqual({ user: true, secret: true })
    expect(w.exists()).toBe(false)
    expect(w.secrets.has(SECRET)).toBe(false)
    expect(await removeSmokeUser(world().io, 'trace')).toEqual({ user: false, secret: false })
  })
})

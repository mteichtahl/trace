import { describe, expect, it } from 'vitest'
import { GROUPS } from '../../src/core/access.js'
import { CLASS_GROUPS, REFRESH_COOKIE } from '../../src/web/auth.js'
import { parseCookies } from '../../src/web/http.js'
import { accessToken } from '../api/fixtures.js'
import { CONFIG, awsError, bearerOf, idToken, world } from './fakes.js'

const EMAIL = 'ada@example.com'
const tokens = (groups = ['trace-users']) => ({
  AccessToken: accessToken('sub-ada', groups), IdToken: idToken('sub-ada', EMAIL, groups), RefreshToken: 'refresh-secret-123', ExpiresIn: 3600,
})
const post = (path: string, body: unknown, extra: Record<string, unknown> = {}) => ({ method: 'POST', path, body: JSON.stringify(body), ...extra })

describe('sign-in', () => {
  it('keeps the class groups in step with the access module', () => {
    expect(Object.fromEntries(CLASS_GROUPS)).toEqual(GROUPS)
  })

  it('start asks USER_AUTH with no preferred challenge and offers the pool\'s choices, best first, the same for any address', async () => {
    const w = world()
    w.cognito.answers.set('InitiateAuth', () => ({ ChallengeName: 'SELECT_CHALLENGE', Session: 's1', AvailableChallenges: ['PASSWORD_SRP', 'PASSWORD', 'EMAIL_OTP', 'WEB_AUTHN'] }))
    const r = await w.serve(post('/api/auth/start', { email: EMAIL }))
    expect(r.status).toBe(200)
    expect(r.json()).toEqual({ session: 's1', choices: ['passkey', 'email_code', 'password'] })
    expect(w.cognito.calls[0]).toEqual({ op: 'InitiateAuth', input: { AuthFlow: 'USER_AUTH', ClientId: CONFIG.clientId, AuthParameters: { USERNAME: EMAIL } } })
    expect(r.headers['cache-control']).toBe('no-store')
    // an address without an account gets a random pick of the pool's challenges from Cognito: the answer is the same
    w.cognito.answers.set('InitiateAuth', () => ({ ChallengeName: 'SELECT_CHALLENGE', Session: 's1', AvailableChallenges: ['EMAIL_OTP'] }))
    expect((await w.serve(post('/api/auth/start', { email: 'nobody@example.com' }))).json()).toEqual({ session: 's1', choices: ['passkey', 'email_code', 'password'] })
    // a pool without passkeys or email codes offers what it has
    w.deps.config = async () => ({ ...CONFIG, features: { ...CONFIG.features, passkeys: false, email: false } })
    expect((await w.serve(post('/api/auth/start', { email: EMAIL }))).json()).toMatchObject({ choices: ['password'] })
  })

  it('a choice the account has not set up is said as such, so the app offers the others', async () => {
    const w = world()
    w.cognito.answers.set('RespondToAuthChallenge', () => { throw awsError('InvalidParameterException') })
    const r = await w.serve(post('/api/auth/respond', { email: EMAIL, session: 's1', kind: 'passkey' }))
    expect(r.status).toBe(400)
    expect(r.json()).toMatchObject({ code: 'choice_unavailable' })
    expect(r.body).not.toContain('must not leak')
  })

  it('a password signs in: tokens in the body, the refresh token only in the cookie, the person from the id token', async () => {
    const w = world()
    w.cognito.answers.set('RespondToAuthChallenge', () => ({ AuthenticationResult: tokens() }))
    const r = await w.serve(post('/api/auth/respond', { email: EMAIL, session: 's1', kind: 'password', answer: 'hunter2-password' }))
    expect(r.status).toBe(200)
    const body = r.json() as Record<string, unknown>
    expect(body).toMatchObject({ signedIn: true, expiresIn: 3600, user: { sub: 'sub-ada', email: EMAIL, class: 'user' } })
    expect(typeof body.accessToken).toBe('string')
    expect(JSON.stringify(body)).not.toContain('refresh-secret-123')
    expect(r.cookies).toEqual([`${REFRESH_COOKIE}=refresh-secret-123; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=2592000`])
    expect(w.cognito.calls[0]?.input).toEqual({
      ClientId: CONFIG.clientId, ChallengeName: 'SELECT_CHALLENGE', Session: 's1',
      ChallengeResponses: { USERNAME: EMAIL, ANSWER: 'PASSWORD', PASSWORD: 'hunter2-password' },
    })
    // nothing secret in the logs
    expect(JSON.stringify(w.logs)).not.toMatch(/hunter2|refresh-secret|eyJ/)
  })

  it('an email code is asked for, then answered', async () => {
    const w = world()
    w.cognito.answers.set('RespondToAuthChallenge', (i) => {
      const c = i.ChallengeResponses as Record<string, string>
      return c.ANSWER === 'EMAIL_OTP'
        ? { ChallengeName: 'EMAIL_OTP', Session: 's2', ChallengeParameters: { CODE_DELIVERY_DESTINATION: 'a***@e***' } }
        : { AuthenticationResult: tokens() }
    })
    const first = await w.serve(post('/api/auth/respond', { email: EMAIL, session: 's1', kind: 'email_code' }))
    expect(first.json()).toEqual({ signedIn: false, next: 'email_code', session: 's2', options: { destination: 'a***@e***' } })
    const second = await w.serve(post('/api/auth/respond', { email: EMAIL, session: 's2', kind: 'email_code', answer: ' 123456 ' }))
    expect(second.json()).toMatchObject({ signedIn: true })
    expect(w.cognito.calls[1]?.input).toMatchObject({ ChallengeName: 'EMAIL_OTP', ChallengeResponses: { USERNAME: EMAIL, EMAIL_OTP_CODE: '123456' } })
  })

  it('a passkey: the request options, then the assertion as CREDENTIAL', async () => {
    const w = world()
    const options = { challenge: 'abc', rpId: 'd123.cloudfront.net', allowCredentials: [] }
    w.cognito.answers.set('RespondToAuthChallenge', (i) => (i.ChallengeName === 'SELECT_CHALLENGE'
      ? { ChallengeName: 'WEB_AUTHN', Session: 's2', ChallengeParameters: { CREDENTIAL_REQUEST_OPTIONS: JSON.stringify(options) } }
      : { AuthenticationResult: tokens(['trace-admins']) }))
    const first = await w.serve(post('/api/auth/respond', { email: EMAIL, session: 's1', kind: 'passkey' }))
    expect(first.json()).toEqual({ signedIn: false, next: 'passkey', session: 's2', options })
    const assertion = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: { clientDataJSON: 'x', authenticatorData: 'y', signature: 'z' } }
    const second = await w.serve(post('/api/auth/respond', { email: EMAIL, session: 's2', kind: 'passkey', answer: assertion }))
    expect(second.json()).toMatchObject({ signedIn: true, user: { class: 'admin' } })
    expect(w.cognito.calls[1]?.input).toMatchObject({ ChallengeName: 'WEB_AUTHN', ChallengeResponses: { USERNAME: EMAIL, CREDENTIAL: JSON.stringify(assertion) } })
  })

  it('an authenticator code and a new password are the next steps when Cognito asks', async () => {
    const w = world()
    w.cognito.answers.set('RespondToAuthChallenge', (i) => {
      if (i.ChallengeName === 'SELECT_CHALLENGE') return { ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 's2' }
      if (i.ChallengeName === 'SOFTWARE_TOKEN_MFA') return { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's3' }
      return { AuthenticationResult: tokens() }
    })
    expect((await w.serve(post('/api/auth/respond', { email: EMAIL, session: 's1', kind: 'password', answer: 'pw' }))).json()).toEqual({ signedIn: false, next: 'totp', session: 's2' })
    expect((await w.serve(post('/api/auth/respond', { email: EMAIL, session: 's2', kind: 'totp', answer: '654321' }))).json()).toEqual({ signedIn: false, next: 'new_password', session: 's3' })
    expect((await w.serve(post('/api/auth/respond', { email: EMAIL, session: 's3', kind: 'new_password', answer: 'Better-Passw0rd!' }))).json()).toMatchObject({ signedIn: true })
    expect(w.cognito.calls.map((c) => (c.input.ChallengeResponses as Record<string, string>))).toEqual([
      { USERNAME: EMAIL, ANSWER: 'PASSWORD', PASSWORD: 'pw' },
      { USERNAME: EMAIL, SOFTWARE_TOKEN_MFA_CODE: '654321' },
      { USERNAME: EMAIL, NEW_PASSWORD: 'Better-Passw0rd!' },
    ])
  })

  it('a wrong password is 401 and Cognito throttling is 429, without Cognito\'s text', async () => {
    const w = world()
    w.cognito.answers.set('RespondToAuthChallenge', () => { throw awsError('NotAuthorizedException') })
    const r = await w.serve(post('/api/auth/respond', { email: EMAIL, session: 's1', kind: 'password', answer: 'pw' }))
    expect(r.status).toBe(401)
    expect(r.body).not.toContain('must not leak')
    w.cognito.answers.set('InitiateAuth', () => { throw awsError('TooManyRequestsException') })
    const t = await w.serve(post('/api/auth/start', { email: EMAIL }))
    expect(t.status).toBe(429)
    expect(t.json()).toMatchObject({ ok: false, code: 'throttled' })
  })

  it('rejects a bad body with 400', async () => {
    const w = world()
    expect((await w.serve(post('/api/auth/start', { email: 'not-an-email' }))).status).toBe(400)
    expect((await w.serve({ method: 'POST', path: '/api/auth/start', body: '{nope' })).status).toBe(400)
    expect((await w.serve(post('/api/auth/respond', { email: EMAIL, session: 's', kind: 'password' }))).status).toBe(400)
  })
})

describe('the session cookie', () => {
  it('refresh uses REFRESH_TOKEN_AUTH with the cookie alone (no client secret, so no username)', async () => {
    const w = world()
    w.cognito.answers.set('InitiateAuth', () => ({ AuthenticationResult: { ...tokens(), RefreshToken: undefined } }))
    const r = await w.serve({ method: 'POST', path: '/api/auth/refresh', cookies: { [REFRESH_COOKIE]: 'refresh-secret-123' } })
    expect(r.status).toBe(200)
    expect(r.json()).toMatchObject({ expiresIn: 3600, user: { sub: 'sub-ada', email: EMAIL, class: 'user' } })
    expect((r.json() as Record<string, unknown>).signedIn).toBeUndefined()
    expect(r.cookies).toEqual([])
    expect(w.cognito.calls[0]?.input).toEqual({ AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: CONFIG.clientId, AuthParameters: { REFRESH_TOKEN: 'refresh-secret-123' } })
  })

  it('refresh with a rotated refresh token sets the new cookie', async () => {
    const w = world()
    w.cognito.answers.set('InitiateAuth', () => ({ AuthenticationResult: { ...tokens(), RefreshToken: 'rotated-456' } }))
    const r = await w.serve({ method: 'POST', path: '/api/auth/refresh', cookies: { [REFRESH_COOKIE]: 'refresh-secret-123' } })
    expect(r.cookies[0]).toMatch(/^__Secure-trace_rt=rotated-456; HttpOnly; Secure; SameSite=Strict; Path=\/api\/auth; Max-Age=2592000$/)
  })

  it('refresh without a cookie, or with a revoked one, is 401 (and the cookie is cleared)', async () => {
    const w = world()
    expect((await w.serve({ method: 'POST', path: '/api/auth/refresh' })).status).toBe(401)
    w.cognito.answers.set('InitiateAuth', () => { throw awsError('NotAuthorizedException') })
    const r = await w.serve({ method: 'POST', path: '/api/auth/refresh', cookies: { [REFRESH_COOKIE]: 'old' } })
    expect(r.status).toBe(401)
    expect(r.cookies).toEqual(['__Secure-trace_rt=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0'])
  })

  it('the cookie is __Secure-trace_rt; the old name is read once and moved; a name sent twice is ignored', async () => {
    expect(REFRESH_COOKIE).toBe('__Secure-trace_rt')
    const w = world()
    w.cognito.answers.set('InitiateAuth', () => ({ AuthenticationResult: { ...tokens(), RefreshToken: undefined } }))
    const r = await w.serve({ method: 'POST', path: '/api/auth/refresh', cookies: { trace_rt: 'refresh-secret-123' } })
    expect(r.status).toBe(200)
    expect(r.cookies).toEqual([
      '__Secure-trace_rt=refresh-secret-123; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=2592000',
      'trace_rt=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0',
    ])
    // two cookies of the same name (one planted from elsewhere): neither is used
    expect(parseCookies(['__Secure-trace_rt=a; other=1', '__Secure-trace_rt=b'])).toEqual({ other: '1' })
    expect((await w.serve({ method: 'POST', path: '/api/auth/refresh', cookies: parseCookies(['__Secure-trace_rt=a; __Secure-trace_rt=b']) })).status).toBe(401)
  })

  it('sign-out revokes the refresh token and clears the cookie, even when the revoke fails', async () => {
    const w = world()
    w.cognito.answers.set('RevokeToken', () => { throw awsError('UnsupportedTokenTypeException') })
    const r = await w.serve({ method: 'POST', path: '/api/auth/sign-out', cookies: { [REFRESH_COOKIE]: 'refresh-secret-123' } })
    expect(r.status).toBe(200)
    expect(w.cognito.calls[0]).toEqual({ op: 'RevokeToken', input: { ClientId: CONFIG.clientId, Token: 'refresh-secret-123' } })
    expect(r.cookies[0]).toContain('Max-Age=0')
  })
})

describe('passwords, passkeys and authenticator apps', () => {
  it('forgot always answers sent (no telling who has an account); reset confirms', async () => {
    const w = world()
    w.cognito.answers.set('ForgotPassword', () => { throw awsError('UserNotFoundException') })
    const r = await w.serve(post('/api/auth/forgot', { email: 'nobody@example.com' }))
    expect(r.status).toBe(200)
    expect(r.json()).toEqual({ sent: true })
    const reset = await w.serve(post('/api/auth/reset', { email: EMAIL, code: '123456', password: 'New-Passw0rd!' }))
    expect(reset.json()).toEqual({ ok: true })
    expect(w.cognito.calls[1]?.input).toEqual({ ClientId: CONFIG.clientId, Username: EMAIL, ConfirmationCode: '123456', Password: 'New-Passw0rd!' })
  })

  it('passkey registration, list and delete use the person\'s access token; no token is 401', async () => {
    const w = world()
    const tok = accessToken('sub-ada', ['trace-users'])
    expect((await w.serve({ method: 'POST', path: '/api/auth/passkeys/start' })).status).toBe(401)
    w.cognito.answers.set('StartWebAuthnRegistration', () => ({ CredentialCreationOptions: { challenge: 'c', rp: { id: 'd123.cloudfront.net' } } }))
    w.cognito.answers.set('ListWebAuthnCredentials', (i) => (i.NextToken
      ? { Credentials: [{ CredentialId: 'k2', FriendlyCredentialName: 'Phone', RelyingPartyId: 'rp', CreatedAt: new Date('2026-01-01T00:00:00Z') }] }
      : { Credentials: [{ CredentialId: 'k1', FriendlyCredentialName: 'Laptop', RelyingPartyId: 'rp', AuthenticatorAttachment: 'platform', CreatedAt: new Date('2025-12-01T00:00:00Z') }], NextToken: 'n' }))
    expect((await w.serve({ method: 'POST', path: '/api/auth/passkeys/start', headers: bearerOf(tok) })).json()).toEqual({ options: { challenge: 'c', rp: { id: 'd123.cloudfront.net' } } })
    expect((await w.serve({ method: 'POST', path: '/api/auth/passkeys/finish', headers: bearerOf(tok), body: JSON.stringify({ credential: { id: 'k3' } }) })).json()).toEqual({ ok: true })
    const list = await w.serve({ method: 'GET', path: '/api/auth/passkeys', headers: bearerOf(tok) })
    expect((list.json() as { passkeys: { id: string }[] }).passkeys.map((p) => p.id)).toEqual(['k1', 'k2'])
    expect((await w.serve({ method: 'DELETE', path: '/api/auth/passkeys/k1', headers: bearerOf(tok) })).json()).toEqual({ ok: true })
    expect(w.cognito.calls.map((c) => [c.op, c.input.AccessToken === tok])).toEqual([
      ['StartWebAuthnRegistration', true], ['CompleteWebAuthnRegistration', true], ['ListWebAuthnCredentials', true], ['ListWebAuthnCredentials', true], ['DeleteWebAuthnCredential', true],
    ])
    expect(w.cognito.calls[4]?.input.CredentialId).toBe('k1')
  })

  it('an authenticator app: the secret and its otpauth URI, then verify and make it the preferred factor', async () => {
    const w = world()
    const tok = accessToken('sub-ada', ['trace-users'])
    w.cognito.answers.set('AssociateSoftwareToken', () => ({ SecretCode: 'JBSWY3DPEHPK3PXP' }))
    w.cognito.answers.set('VerifySoftwareToken', () => ({ Status: 'SUCCESS' }))
    const s = await w.serve({ method: 'POST', path: '/api/auth/totp/start', headers: bearerOf(tok) })
    expect(s.json()).toEqual({ secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/trace%3Asub-ada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=trace' })
    const v = await w.serve({ method: 'POST', path: '/api/auth/totp/verify', headers: bearerOf(tok), body: JSON.stringify({ code: '123456' }) })
    expect(v.json()).toEqual({ ok: true })
    expect(w.cognito.calls.at(-1)).toEqual({ op: 'SetUserMFAPreference', input: { AccessToken: tok, SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } } })
  })
})

describe('the router', () => {
  it('answers 404 and 405, and config without secrets', async () => {
    const w = world()
    expect((await w.serve({ method: 'GET', path: '/api/nope' })).status).toBe(404)
    expect((await w.serve({ method: 'GET', path: '/api/auth/start' })).status).toBe(405)
    const c = await w.serve({ method: 'GET', path: '/api/config' })
    expect(c.json()).toEqual({
      region: 'us-east-1', prefix: 'trace', userPoolId: 'us-east-1_TEST', clientId: CONFIG.clientId,
      events: { http: CONFIG.events.http, realtime: CONFIG.events.realtime }, features: { passkeys: true, email: true, voice: true, ops: true },
    })
    expect(w.logs.at(-1)).toMatchObject({ method: 'GET', path: '/api/config', status: 200, who: null })
  })

  it('logs who as a hash, never the email', async () => {
    const w = world()
    w.cognito.answers.set('InitiateAuth', () => ({ ChallengeName: 'SELECT_CHALLENGE', Session: 's', AvailableChallenges: ['PASSWORD'] }))
    await w.serve(post('/api/auth/start', { email: EMAIL }))
    expect(w.logs.at(-1)?.who).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(w.logs)).not.toContain(EMAIL)
  })
})

describe('id token verification', () => {
  it('accepts an id token for this client, and refuses an access token or another audience', async () => {
    const { verifier, sign, ISSUER } = await import('../api/fixtures.js')
    const v = verifier()
    const id = await v.verifyId(idToken('u1', 'u1@example.com', ['trace-guests']))
    expect(id).toMatchObject({ sub: 'u1', email: 'u1@example.com', 'cognito:groups': ['trace-guests'] })
    await expect(v.verifyId(accessToken('u1', []))).rejects.toThrow(/malformed token claims|not an id token/)
    const now = Math.floor(Date.now() / 1000)
    await expect(v.verifyId(sign({ sub: 'u1', iss: ISSUER, token_use: 'id', aud: 'someone-else', exp: now + 60 }))).rejects.toThrow(/wrong client/)
    await expect(v.verify(idToken('u1', 'u1@example.com', []))).rejects.toThrow(/not an access token/)
  })
})

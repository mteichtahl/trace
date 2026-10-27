/**
 * trace's own sign-in: Cognito's user-pool API, called from here so the refresh token never reaches browser storage.
 *
 *   start        InitiateAuth USER_AUTH with no preferred challenge → its session, and the choices the pool offers
 *                (FIXED_CHOICES: passkey when passkeys are on, email_code when email codes are, password), the same
 *                for every address. Cognito's own AvailableChallenges are not passed on: for an address without an
 *                account (preventUserExistenceErrors) they are a random pick of the pool's, for a real one the
 *                person's own, so they would tell the two apart. A choice the account has not set up fails at
 *                respond (choice_unavailable) and the app starts again and offers the others
 *   respond      one step, inferred from `kind` and whether an `answer` came with it:
 *                  password + answer          SELECT_CHALLENGE  ANSWER=PASSWORD, PASSWORD
 *                  email_code, no answer      SELECT_CHALLENGE  ANSWER=EMAIL_OTP (Cognito emails a code) → next email_code
 *                  email_code + answer        EMAIL_OTP         EMAIL_OTP_CODE
 *                  passkey, no answer         SELECT_CHALLENGE  ANSWER=WEB_AUTHN → next passkey, options (the
 *                                             CREDENTIAL_REQUEST_OPTIONS for navigator.credentials.get)
 *                  passkey + answer           WEB_AUTHN         CREDENTIAL (the AuthenticationResponseJSON)
 *                  totp + answer              SOFTWARE_TOKEN_MFA SOFTWARE_TOKEN_MFA_CODE
 *                  new_password + answer      NEW_PASSWORD_REQUIRED NEW_PASSWORD
 *                Signed in: the access and id tokens in the body, the refresh token in the `__Secure-trace_rt` cookie
 *                (HttpOnly; Secure; SameSite=Strict; Path=/api/auth; 30 days), and the person from the verified id
 *                token. Otherwise the next step and its session.
 *   refresh      REFRESH_TOKEN_AUTH with the cookie. The web app client has no secret, so no USERNAME or SECRET_HASH
 *                is needed and the cookie holds the refresh token alone. A cookie name sent twice is ignored
 *                (src/web/http.ts parseCookies). The old name, `trace_rt`, is read once when the new one is absent:
 *                the answer sets the new cookie and clears the old
 *   invitation   no route of its own: the invitation email sends people to the app's /invite page, where they enter
 *                their email and the temporary password (start, then respond password → new_password), and then add
 *                a passkey or an authenticator app with the routes below. Nothing secret is ever in a link
 *   sign-out     RevokeToken, and the cookie cleared (whether or not the revoke worked)
 *   forgot/reset ForgotPassword (always { sent: true }: no telling who has an account) / ConfirmForgotPassword
 *   passkeys     Start/CompleteWebAuthnRegistration, List/DeleteWebAuthnCredential with the person's access token
 *   totp         AssociateSoftwareToken → { secret, uri }; VerifySoftwareToken then SetUserMFAPreference (TOTP preferred)
 *
 * Cognito's throttling answers 429; nothing here rate-limits on its own. Tokens, codes and passwords are never logged
 * or put in an error message.
 */
import type { AuthenticationResultType, ChallengeNameType, RespondToAuthChallengeCommandOutput } from '@aws-sdk/client-cognito-identity-provider'
import type { DocumentType } from '@smithy/types'
import { z } from 'zod'
import { AuthError } from '../api/jwt.js'
import type { WebConfig } from './config.js'
import { type WebDeps, signedIn } from './deps.js'
import { type Reply, type WebRequest, WebError, cookie, parseBody, route, whoHash } from './http.js'

export const REFRESH_COOKIE = '__Secure-trace_rt'
/** The cookie's name before it took the __Secure- prefix: read once, then cleared. */
export const OLD_REFRESH_COOKIE = 'trace_rt'
export const REFRESH_PATH = '/api/auth'
export const REFRESH_MAX_AGE = 30 * 24 * 3600

/** The account classes' Cognito groups, highest first (the same as src/core/access.ts GROUPS; a test keeps them so). */
export const CLASS_GROUPS = [['admin', 'trace-admins'], ['user', 'trace-users'], ['guest', 'trace-guests']] as const
export type WebClass = (typeof CLASS_GROUPS)[number][0]
export const classOfGroups = (groups: readonly string[]): WebClass | null => CLASS_GROUPS.find(([, g]) => groups.includes(g))?.[0] ?? null

const Email = z.string().trim().min(3).max(320).email()
const Kind = z.enum(['password', 'email_code', 'passkey', 'totp', 'new_password'])
type Kind = z.output<typeof Kind>
type Choice = 'passkey' | 'email_code' | 'password'

const Start = z.object({ email: Email })
const Respond = z.object({
  email: Email,
  session: z.string().min(1).max(8192),
  kind: Kind,
  answer: z.union([z.string().max(4096), z.record(z.string(), z.unknown())]).optional(),
})
const Forgot = z.object({ email: Email })
const Reset = z.object({ email: Email, code: z.string().trim().min(1).max(32), password: z.string().min(1).max(256) })
const Credential = z.object({ credential: z.record(z.string(), z.unknown()) })
const TotpVerify = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'six digits'), name: z.string().max(64).optional() })

const CHOICE: Partial<Record<string, Choice>> = { WEB_AUTHN: 'passkey', EMAIL_OTP: 'email_code', PASSWORD: 'password', PASSWORD_SRP: 'password' }
const NEXT: Partial<Record<string, Kind>> = { EMAIL_OTP: 'email_code', SOFTWARE_TOKEN_MFA: 'totp', NEW_PASSWORD_REQUIRED: 'new_password', WEB_AUTHN: 'passkey' }
const ORDER: readonly Choice[] = ['passkey', 'email_code', 'password']

/** The choices start offers for every address alike: the pool's first factors (src/infra/stack.ts signInPolicy). */
export const fixedChoices = (c: Pick<WebConfig, 'features'>): Choice[] => ORDER.filter((x) => x === 'password' || (x === 'passkey' ? c.features.passkeys : c.features.email))

/** Cognito's errors as answers: the error's name decides, never its text when it could echo an input. */
export function cognitoError(e: unknown): WebError {
  const name = e instanceof Error ? e.name : ''
  switch (name) {
    case 'TooManyRequestsException': case 'LimitExceededException': case 'TooManyFailedAttemptsException': case 'ThrottlingException':
      return new WebError(429, 'too many attempts: wait a moment and try again', 'throttled')
    case 'NotAuthorizedException': case 'UserNotFoundException':
      return new WebError(401, 'that did not work: check your details and try again', 'not_authorized')
    case 'CodeMismatchException': return new WebError(400, 'that code is not right', 'code_mismatch')
    case 'ExpiredCodeException': return new WebError(400, 'that code has expired: ask for a new one', 'code_expired')
    case 'InvalidPasswordException': return new WebError(400, 'that password does not meet the rules', 'invalid_password')
    case 'PasswordResetRequiredException': return new WebError(403, 'your password must be reset', 'password_reset_required')
    case 'UserNotConfirmedException': return new WebError(403, 'your account is not confirmed yet', 'not_confirmed')
    case 'WebAuthnNotEnabledException': case 'WebAuthnConfigurationMissingException': case 'WebAuthnRelyingPartyMismatchException':
      return new WebError(400, 'passkeys are not set up for this sign-in', 'passkeys_unavailable')
    case 'WebAuthnChallengeNotFoundException': case 'WebAuthnCredentialNotSupportedException': case 'WebAuthnOriginNotAllowedException': case 'WebAuthnClientMismatchException':
      return new WebError(400, 'the passkey was not accepted', 'passkey_rejected')
    case 'EnableSoftwareTokenMFAException': return new WebError(400, 'that code is not right', 'code_mismatch')
    case 'InvalidParameterException': return new WebError(400, 'the request was not accepted', 'invalid_parameter')
    default: return new WebError(500, 'sign-in is not available right now', 'cognito')
  }
}

async function cognitoCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw e instanceof WebError ? e : cognitoError(e)
  }
}

const refreshCookie = (token: string): string => cookie(REFRESH_COOKIE, token, { path: REFRESH_PATH, maxAge: REFRESH_MAX_AGE })
const clearCookie = (): string => cookie(REFRESH_COOKIE, '', { path: REFRESH_PATH, maxAge: 0 })
const clearOldCookie = (): string => cookie(OLD_REFRESH_COOKIE, '', { path: REFRESH_PATH, maxAge: 0 })

/** The refresh token the request carries: the cookie, else (once) the old name's; and whether it was the old one. */
const refreshTokenOf = (req: WebRequest): { token: string; old: boolean } | null => {
  const now = req.cookies[REFRESH_COOKIE]
  if (now) return { token: now, old: false }
  const old = req.cookies[OLD_REFRESH_COOKIE]
  return old ? { token: old, old: true } : null
}

/** The signed-in answer: tokens, the person from the verified id token, and (when Cognito gave one) the cookie. */
async function signedInReply(r: AuthenticationResultType, deps: WebDeps, c: WebConfig): Promise<Reply> {
  if (!r.AccessToken || !r.IdToken) throw new WebError(500, 'Cognito answered without tokens', 'cognito')
  let user: { sub: string; email: string | null; class: WebClass | null }
  try {
    const id = await deps.verifier(c).verifyId(r.IdToken)
    user = { sub: id.sub, email: id.email ?? null, class: classOfGroups(id['cognito:groups'] ?? []) }
  } catch (e) {
    throw e instanceof AuthError ? new WebError(401, `the id token did not verify: ${e.message}`, 'unauthenticated') : e
  }
  return {
    body: { signedIn: true, accessToken: r.AccessToken, idToken: r.IdToken, expiresIn: r.ExpiresIn ?? 3600, user },
    ...(r.RefreshToken ? { cookies: [refreshCookie(r.RefreshToken)] } : {}),
  }
}

/** The answer to one challenge response: signed in, or the next step. */
async function stepReply(out: RespondToAuthChallengeCommandOutput, deps: WebDeps, c: WebConfig): Promise<Reply> {
  if (out.AuthenticationResult) return signedInReply(out.AuthenticationResult, deps, c)
  const name = out.ChallengeName ?? ''
  if (!out.Session) throw new WebError(500, 'Cognito answered without a session', 'cognito')
  if (name === 'SELECT_CHALLENGE') return { body: { signedIn: false, next: 'select', session: out.Session, choices: choices(out.AvailableChallenges) } }
  if (name === 'MFA_SETUP') throw new WebError(403, 'this account must set up an authenticator app before signing in: ask an admin', 'mfa_setup')
  const next = NEXT[name]
  if (!next) throw new WebError(400, `this sign-in step is not supported here (${name})`, 'unsupported_challenge')
  const p = out.ChallengeParameters ?? {}
  let options: unknown
  if (next === 'passkey' && p.CREDENTIAL_REQUEST_OPTIONS) {
    try { options = JSON.parse(p.CREDENTIAL_REQUEST_OPTIONS) } catch { throw new WebError(500, 'Cognito sent passkey options that are not JSON', 'cognito') }
  }
  if (next === 'email_code' && p.CODE_DELIVERY_DESTINATION) options = { destination: p.CODE_DELIVERY_DESTINATION }
  return { body: { signedIn: false, next, session: out.Session, ...(options !== undefined ? { options } : {}) } }
}

const choices = (available: readonly (ChallengeNameType | string)[] | undefined): Choice[] => {
  const got = new Set((available ?? []).map((a) => CHOICE[a]).filter((x): x is Choice => x !== undefined))
  return ORDER.filter((c) => got.has(c))
}

const text = (a: unknown): string | null => (typeof a === 'string' && a.length ? a : null)

/** The challenge response for one step (see the module header). */
export function challengeFor(kind: Kind, email: string, answer: string | Record<string, unknown> | undefined): { name: ChallengeNameType; responses: Record<string, string> } {
  const s = text(answer)
  const need = (): string => { if (s === null) throw new WebError(400, `${kind} needs an answer`, 'bad_request'); return s }
  switch (kind) {
    case 'password': return { name: 'SELECT_CHALLENGE', responses: { USERNAME: email, ANSWER: 'PASSWORD', PASSWORD: need() } }
    case 'email_code': return s === null
      ? { name: 'SELECT_CHALLENGE', responses: { USERNAME: email, ANSWER: 'EMAIL_OTP' } }
      : { name: 'EMAIL_OTP', responses: { USERNAME: email, EMAIL_OTP_CODE: s.trim() } }
    case 'passkey': {
      if (answer === undefined || answer === '') return { name: 'SELECT_CHALLENGE', responses: { USERNAME: email, ANSWER: 'WEB_AUTHN' } }
      return { name: 'WEB_AUTHN', responses: { USERNAME: email, CREDENTIAL: typeof answer === 'string' ? answer : JSON.stringify(answer) } }
    }
    case 'totp': return { name: 'SOFTWARE_TOKEN_MFA', responses: { USERNAME: email, SOFTWARE_TOKEN_MFA_CODE: need().trim() } }
    case 'new_password': return { name: 'NEW_PASSWORD_REQUIRED', responses: { USERNAME: email, NEW_PASSWORD: need() } }
  }
}

export function authRoutes(deps: WebDeps) {
  return [
    route('POST', '/api/auth/start', async (req, ctx) => {
      const { email } = parseBody(req, Start)
      const c = await deps.config()
      ctx.who = whoHash(email)
      const out = await cognitoCall(() => deps.cognito(c).initiateAuth({ AuthFlow: 'USER_AUTH', ClientId: c.clientId, AuthParameters: { USERNAME: email } }))
      if (out.AuthenticationResult) return signedInReply(out.AuthenticationResult, deps, c)
      if (!out.Session) throw new WebError(500, 'Cognito answered without a session', 'cognito')
      if (out.ChallengeName && out.ChallengeName !== 'SELECT_CHALLENGE') return stepReply({ ...out, $metadata: out.$metadata }, deps, c)
      return { body: { session: out.Session, choices: fixedChoices(c) } }
    }),

    route('POST', '/api/auth/respond', async (req, ctx) => {
      const b = parseBody(req, Respond)
      const c = await deps.config()
      ctx.who = whoHash(b.email)
      const { name, responses } = challengeFor(b.kind, b.email, b.answer)
      let out: RespondToAuthChallengeCommandOutput
      try {
        out = await deps.cognito(c).respondToAuthChallenge({ ClientId: c.clientId, ChallengeName: name, Session: b.session, ChallengeResponses: responses })
      } catch (e) {
        const we = cognitoError(e)
        // choosing a way this account has not set up (a passkey it has none of): said as such, the same for an
        // address without an account, so the app offers the other ways
        if (name === 'SELECT_CHALLENGE' && b.answer === undefined && (we.code === 'invalid_parameter' || we.code === 'passkeys_unavailable' || we.code === 'not_authorized')) {
          throw new WebError(400, 'that way of signing in is not set up for this account: choose another', 'choice_unavailable')
        }
        throw we
      }
      return stepReply(out, deps, c)
    }),

    route('POST', '/api/auth/refresh', async (req, ctx) => {
      const found = refreshTokenOf(req)
      if (!found) throw new WebError(401, 'not signed in', 'unauthenticated')
      const rt = found.token
      const c = await deps.config()
      try {
        const out = await deps.cognito(c).initiateAuth({ AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: c.clientId, AuthParameters: { REFRESH_TOKEN: rt } })
        if (!out.AuthenticationResult) throw new WebError(401, 'the session has ended', 'unauthenticated')
        const reply = await signedInReply(out.AuthenticationResult, deps, c)
        const body = reply.body as { user: { sub: string }; signedIn?: boolean }
        ctx.who = whoHash(body.user.sub)
        const { signedIn: _s, ...rest } = body
        // the old name: moved to the new one (Cognito sends no new refresh token unless rotation is on), and cleared
        const cookies = [...(reply.cookies ?? (found.old ? [refreshCookie(rt)] : [])), ...(found.old ? [clearOldCookie()] : [])]
        return { body: rest, ...(cookies.length ? { cookies } : {}) }
      } catch (e) {
        const we = e instanceof WebError ? e : cognitoError(e)
        // an expired or revoked refresh token ends the session: the cookie goes with it
        if (we.status === 401) return { status: 401, body: { ok: false, error: 'the session has ended: sign in again', code: 'unauthenticated' }, cookies: [clearCookie(), ...(found.old ? [clearOldCookie()] : [])] }
        throw we
      }
    }),

    route('POST', '/api/auth/sign-out', async (req) => {
      const rt = refreshTokenOf(req)?.token
      if (rt) {
        const c = await deps.config()
        await deps.cognito(c).revokeToken({ ClientId: c.clientId, Token: rt }).catch((e: unknown) => {
          deps.log({ warning: 'sign-out: RevokeToken failed', error: e instanceof Error ? e.name : 'Error' })
        })
      }
      return { body: { ok: true }, cookies: [clearCookie(), clearOldCookie()] }
    }),

    route('POST', '/api/auth/forgot', async (req, ctx) => {
      const { email } = parseBody(req, Forgot)
      const c = await deps.config()
      ctx.who = whoHash(email)
      try {
        await deps.cognito(c).forgotPassword({ ClientId: c.clientId, Username: email })
      } catch (e) {
        const we = cognitoError(e)
        // throttling says nothing about whether the account exists; everything else is answered the same way
        if (we.status === 429) throw we
      }
      return { body: { sent: true } }
    }),

    route('POST', '/api/auth/reset', async (req, ctx) => {
      const b = parseBody(req, Reset)
      const c = await deps.config()
      ctx.who = whoHash(b.email)
      await cognitoCall(() => deps.cognito(c).confirmForgotPassword({ ClientId: c.clientId, Username: b.email, ConfirmationCode: b.code, Password: b.password }))
      return { body: { ok: true } }
    }),

    route('POST', '/api/auth/passkeys/start', async (req, ctx) => {
      const s = await signedIn(req, ctx, deps)
      const out = await cognitoCall(() => deps.cognito(s.config).startWebAuthnRegistration({ AccessToken: s.token }))
      return { body: { options: out.CredentialCreationOptions } }
    }),

    route('POST', '/api/auth/passkeys/finish', async (req, ctx) => {
      const s = await signedIn(req, ctx, deps)
      const b = parseBody(req, Credential)
      await cognitoCall(() => deps.cognito(s.config).completeWebAuthnRegistration({ AccessToken: s.token, Credential: b.credential as DocumentType }))
      return { body: { ok: true } }
    }),

    route('GET', '/api/auth/passkeys', async (req, ctx) => {
      const s = await signedIn(req, ctx, deps)
      const passkeys: Record<string, unknown>[] = []
      let next: string | undefined
      do {
        const out = await cognitoCall(() => deps.cognito(s.config).listWebAuthnCredentials({ AccessToken: s.token, ...(next ? { NextToken: next } : {}) }))
        for (const k of out.Credentials ?? []) {
          passkeys.push({
            id: k.CredentialId, name: k.FriendlyCredentialName ?? null, relyingParty: k.RelyingPartyId ?? null,
            attachment: k.AuthenticatorAttachment ?? null, createdAt: k.CreatedAt ? new Date(k.CreatedAt).toISOString() : null,
          })
        }
        next = out.NextToken
      } while (next)
      return { body: { passkeys } }
    }),

    route('DELETE', '/api/auth/passkeys/:id', async (req, ctx) => {
      const s = await signedIn(req, ctx, deps)
      const id = ctx.params.id ?? ''
      if (!id || id.length > 1024) throw new WebError(400, 'which passkey?', 'bad_request')
      await cognitoCall(() => deps.cognito(s.config).deleteWebAuthnCredential({ AccessToken: s.token, CredentialId: id }))
      return { body: { ok: true } }
    }),

    route('POST', '/api/auth/totp/start', async (req, ctx) => {
      const s = await signedIn(req, ctx, deps)
      const out = await cognitoCall(() => deps.cognito(s.config).associateSoftwareToken({ AccessToken: s.token }))
      if (!out.SecretCode) throw new WebError(500, 'Cognito answered without a secret', 'cognito')
      const label = encodeURIComponent(`trace:${s.claims.username ?? s.claims.sub}`)
      return { body: { secret: out.SecretCode, uri: `otpauth://totp/${label}?secret=${out.SecretCode}&issuer=trace` } }
    }),

    route('POST', '/api/auth/totp/verify', async (req, ctx) => {
      const s = await signedIn(req, ctx, deps)
      const b = parseBody(req, TotpVerify)
      const out = await cognitoCall(() => deps.cognito(s.config).verifySoftwareToken({ AccessToken: s.token, UserCode: b.code, FriendlyDeviceName: b.name ?? 'Authenticator app' }))
      if (out.Status !== 'SUCCESS') return { body: { ok: false } }
      await cognitoCall(() => deps.cognito(s.config).setUserMfaPreference({ AccessToken: s.token, SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } }))
      return { body: { ok: true } }
    }),
  ]
}

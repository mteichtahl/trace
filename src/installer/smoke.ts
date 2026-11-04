/**
 * The smoke user (docs/smoke-test.md "Live runs"): the account the live screen smoke test signs in as, after every
 * self-update, so nobody sets one up by hand.
 *
 *   who       `smoke@<prefix>.trace.invalid` (an address that can never receive mail: Cognito is told not to send any),
 *             an ordinary user (trace-users) and a Reviewer of one project, the smoke project, so it can only read: it
 *             signs nothing, accepts nothing and sees no other project. The installer assigns it (bootstrap.ts smoke
 *             step). Its password is random (32 characters) and it has an authenticator enrolled here, with a secret
 *             only this installation keeps
 *   where     one Secrets Manager secret, `<prefix>/smoke/sign-in` (smokeSecret), JSON of the TRACE_SMOKE_* variables the
 *             test reads (web/smoke/env.ts): the web app's address, the user's email, password and authenticator secret,
 *             and the project the screens are checked on. Only the installer writes it; the self-update role reads it
 *             (src/infra/stack.ts SmokeUserSecret), and trace's own repository's TRACE_SMOKE_SECRET names it, which
 *             turns on its ci workflow's smoke-live job
 *   again     a run that finds the user and a secret it can actually sign in with (password, then a code from the
 *             authenticator) keeps both, and only brings the address and the project up to date. Otherwise (deleted,
 *             reset by hand, a failed run) it gets a new password and a new authenticator: its old one is switched off
 *             first, so the sign-in that enrols the new one asks for no code
 *   off       removeSmokeUser: the user and the secret are deleted (the secret at once, without a recovery window: it is
 *             made again when wanted)
 */
import { createHmac, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { GROUPS } from '../core/access.js'
import { INSTALLATION_TAG } from '../infra/lambda/cost-explorer.js'
import { smokeSecret } from '../infra/props.js'

/** The smoke user's address: one per installation (its prefix), never deliverable (.invalid, RFC 2606). */
export const smokeEmail = (prefix: string): string => `smoke@${prefix.toLowerCase()}.trace.invalid`

/** The repository variable that names the secret: the ci workflow's smoke-live job runs only when it is set. */
export const SMOKE_SECRET_VARIABLE = 'TRACE_SMOKE_SECRET'

/** What the secret holds: exactly what web/smoke reads, so web/smoke/load-secret.mjs passes it on as it is. */
export const SmokeSignIn = z.object({
  TRACE_SMOKE_URL: z.string().url(),
  TRACE_SMOKE_EMAIL: z.string().email(),
  TRACE_SMOKE_PASSWORD: z.string().min(12),
  TRACE_SMOKE_TOTP_SECRET: z.string().regex(/^[A-Z2-7]+=*$/),
  TRACE_SMOKE_PROJECT: z.string().regex(/^[A-Za-z0-9-]+~[A-Za-z0-9._-]+$/),
}).loose()
export type SmokeSignIn = z.infer<typeof SmokeSignIn>

/** Cognito and Secrets Manager, as the smoke user needs them (tests replace them; liveSmokeIo is the real one). */
export interface SmokeIo {
  /** the user's sub, or null when there is no such user */
  sub(email: string): Promise<string | null>
  /** create the user with its email verified, sending nothing; its sub */
  create(email: string): Promise<string>
  /** make it an ordinary user (trace-users), and only that */
  user(email: string): Promise<void>
  /** set its password, permanent (no change asked at the first sign-in) */
  password(email: string, password: string): Promise<void>
  /** switch its authenticator off, so a sign-in asks for no code */
  mfaOff(email: string): Promise<void>
  /** sign in with the password, and with a code from the authenticator when one is asked for (`code`); the access
   * token, or null when the sign-in is refused or asks for something else */
  signIn(email: string, password: string, code?: () => string): Promise<string | null>
  /** start enrolling an authenticator; its base32 secret */
  associate(accessToken: string): Promise<string>
  /** finish enrolling with a code from it, and make it the user's second step from now on */
  verify(accessToken: string, code: string): Promise<void>
  /** delete the user (nothing when there is none) */
  remove(email: string): Promise<void>
  /** the secret's string, or null when there is none (or it is waiting to be deleted) */
  read(name: string): Promise<string | null>
  /** write the secret, creating it (with these tags) when missing, restoring it when it was waiting to be deleted */
  write(name: string, value: string, tags: Record<string, string>): Promise<void>
  /** delete the secret at once (nothing when there is none) */
  forget(name: string): Promise<void>
}

export interface SmokeOptions {
  prefix: string
  /** the web app's address (the stack's WebUrl) */
  url: string
  /** the project the screens are checked on, OWNER/NAME */
  project: string
  log?: (line: string) => void
  /** for tests: the clock (authenticator codes) and the password's randomness */
  now?: () => number
  random?: (n: number) => Buffer
}

export interface SmokeResult {
  email: string
  /** the user's sub, for its project assignment */
  sub: string
  secret: string
  /** made: a new password and authenticator; updated: the address or project changed; kept: nothing to do */
  state: 'made' | 'updated' | 'kept'
}

/** A random password Cognito's policy takes (src/infra/stack.ts: 12+ characters, upper and lower case, a digit). */
export function smokePassword(random: (n: number) => Buffer = randomBytes): string {
  return `Sm0k-${random(24).toString('base64url')}`
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** A 6-digit authenticator code (RFC 6238: SHA-1, 30 s) from a base32 secret, as an authenticator app makes it. */
export function totpCode(secret: string, now = Date.now()): string {
  let bits = ''
  for (const ch of secret.replace(/[\s=-]/g, '').toUpperCase()) {
    const v = ALPHABET.indexOf(ch)
    if (v < 0) throw new Error('the authenticator secret is not base32')
    bits += v.toString(2).padStart(5, '0')
  }
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)))
  const mac = createHmac('sha1', key).update(counter).digest()
  const off = mac[mac.length - 1]! & 0x0f
  return String((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

/** OWNER/NAME → the project's address in the web app (OWNER~NAME, web/src/lib/api.ts projectId). */
export const projectAddress = (repo: string): string => repo.replace('/', '~')

/** Make the smoke user and its secret, or bring them up to date (see the file's header). Throws on a failure. */
export async function ensureSmokeUser(io: SmokeIo, o: SmokeOptions): Promise<SmokeResult> {
  const log = o.log ?? (() => undefined)
  const now = o.now ?? Date.now
  const email = smokeEmail(o.prefix)
  const name = smokeSecret(o.prefix)
  const tags = { [INSTALLATION_TAG]: o.prefix, 'trace:purpose': 'smoke-test' }
  const where = { TRACE_SMOKE_URL: o.url.replace(/\/+$/, ''), TRACE_SMOKE_PROJECT: projectAddress(o.project) }

  let sub = await io.sub(email)
  const raw = await io.read(name)
  let stored: SmokeSignIn | null = null
  if (raw) {
    try { stored = SmokeSignIn.parse(JSON.parse(raw)) } catch { stored = null }
  }
  // kept only when it really signs in with what is stored: a password or authenticator reset by hand is made again
  const works = sub && stored && stored.TRACE_SMOKE_EMAIL === email
    ? await io.signIn(email, stored.TRACE_SMOKE_PASSWORD, () => totpCode(stored!.TRACE_SMOKE_TOTP_SECRET, now())) !== null
    : false
  if (sub && stored && works) {
    await io.user(email)
    if (stored.TRACE_SMOKE_URL === where.TRACE_SMOKE_URL && stored.TRACE_SMOKE_PROJECT === where.TRACE_SMOKE_PROJECT) {
      log(`${email}: kept, it signs in (${name})`)
      return { email, sub, secret: name, state: 'kept' }
    }
    await io.write(name, JSON.stringify({ ...stored, ...where }), tags)
    log(`${email}: kept; ${name} now points at ${where.TRACE_SMOKE_URL}, project ${where.TRACE_SMOKE_PROJECT}`)
    return { email, sub, secret: name, state: 'updated' }
  }

  if (!sub) {
    sub = await io.create(email)
    log(`${email}: created (no email sent)`)
  } else {
    log(`${email}: ${stored ? 'its stored sign-in no longer works' : `no usable sign-in in ${name}`}: giving it a new password and authenticator`)
  }
  await io.user(email)
  const password = smokePassword(o.random)
  await io.password(email, password)
  await io.mfaOff(email)
  const token = await io.signIn(email, password)
  if (!token) throw new Error('the smoke user could not sign in with the password just set')
  const totp = await io.associate(token)
  await io.verify(token, totpCode(totp, now()))
  // optional keys added by hand (TRACE_SMOKE_WRITES, a connected system's) stay
  const extra = Object.fromEntries(Object.entries(raw ? (() => { try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} } })() : {})
    .filter(([k, v]) => /^TRACE_SMOKE_[A-Z_]+$/.test(k) && typeof v === 'string'))
  const value = { ...extra, ...where, TRACE_SMOKE_EMAIL: email, TRACE_SMOKE_PASSWORD: password, TRACE_SMOKE_TOTP_SECRET: totp }
  await io.write(name, JSON.stringify(value), tags)
  log(`${email}: an ordinary user with a password and an authenticator; its sign-in is in ${name}`)
  return { email, sub, secret: name, state: 'made' }
}

/** The smoke test turned off: delete the smoke user and its secret. Returns what was there. */
export async function removeSmokeUser(io: SmokeIo, prefix: string): Promise<{ user: boolean; secret: boolean }> {
  const email = smokeEmail(prefix)
  const name = smokeSecret(prefix)
  const user = (await io.sub(email)) !== null
  const secret = (await io.read(name)) !== null
  if (user) await io.remove(email)
  await io.forget(name)
  return { user, secret }
}

type Creds = { accessKeyId: string; secretAccessKey: string; sessionToken?: string | undefined }

/** Cognito (the pool and the web app's own client) and Secrets Manager, with the installer's credentials. */
export async function liveSmokeIo(creds: Creds, region: string, poolId: string, webClientId: string): Promise<SmokeIo> {
  const idp = await import('@aws-sdk/client-cognito-identity-provider')
  const sm = await import('@aws-sdk/client-secrets-manager')
  const c = new idp.CognitoIdentityProviderClient({ region, credentials: creds })
  const s = new sm.SecretsManagerClient({ region, credentials: creds })
  const named = (e: unknown, n: string): boolean => (e as { name?: string }).name === n
  // a secret scheduled for deletion answers InvalidRequestException ("…marked for deletion")
  const deleting = (e: unknown): boolean => named(e, 'InvalidRequestException') && /deletion/i.test(String((e as Error).message))
  const refused = (e: unknown): boolean => ['NotAuthorizedException', 'UserNotFoundException', 'CodeMismatchException', 'PasswordResetRequiredException', 'UserNotConfirmedException'].some((n) => named(e, n))
  return {
    async sub(email) {
      try {
        const u = await c.send(new idp.AdminGetUserCommand({ UserPoolId: poolId, Username: email }))
        return u.UserAttributes?.find((x) => x.Name === 'sub')?.Value ?? ''
      } catch (e) {
        if (named(e, 'UserNotFoundException')) return null
        throw e
      }
    },
    async create(email) {
      const r = await c.send(new idp.AdminCreateUserCommand({
        UserPoolId: poolId, Username: email, MessageAction: 'SUPPRESS',
        UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: 'trace smoke test' }],
      }))
      return r.User?.Attributes?.find((x) => x.Name === 'sub')?.Value ?? ''
    },
    async user(email) {
      await c.send(new idp.AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: email, GroupName: GROUPS.user }))
      const groups = await c.send(new idp.AdminListGroupsForUserCommand({ UserPoolId: poolId, Username: email }))
      for (const g of groups.Groups ?? []) {
        if (g.GroupName && g.GroupName !== GROUPS.user && Object.values(GROUPS).includes(g.GroupName as never)) {
          await c.send(new idp.AdminRemoveUserFromGroupCommand({ UserPoolId: poolId, Username: email, GroupName: g.GroupName }))
        }
      }
    },
    async password(email, password) {
      await c.send(new idp.AdminSetUserPasswordCommand({ UserPoolId: poolId, Username: email, Password: password, Permanent: true }))
    },
    async mfaOff(email) {
      await c.send(new idp.AdminSetUserMFAPreferenceCommand({ UserPoolId: poolId, Username: email, SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false } }))
    },
    async signIn(email, password, code) {
      try {
        const start = await c.send(new idp.InitiateAuthCommand({ AuthFlow: 'USER_AUTH', ClientId: webClientId, AuthParameters: { USERNAME: email } }))
        let out: { AuthenticationResult?: { AccessToken?: string | undefined } | undefined; ChallengeName?: string | undefined; Session?: string | undefined } = start
        if (!out.AuthenticationResult) {
          out = await c.send(new idp.RespondToAuthChallengeCommand({
            ClientId: webClientId, Session: start.Session, ChallengeName: 'SELECT_CHALLENGE',
            ChallengeResponses: { USERNAME: email, ANSWER: 'PASSWORD', PASSWORD: password },
          }))
        }
        if (!out.AuthenticationResult && out.ChallengeName === 'SOFTWARE_TOKEN_MFA' && code) {
          out = await c.send(new idp.RespondToAuthChallengeCommand({
            ClientId: webClientId, Session: out.Session, ChallengeName: 'SOFTWARE_TOKEN_MFA',
            ChallengeResponses: { USERNAME: email, SOFTWARE_TOKEN_MFA_CODE: code() },
          }))
        }
        return out.AuthenticationResult?.AccessToken ?? null
      } catch (e) {
        if (refused(e)) return null
        throw e
      }
    },
    async associate(accessToken) {
      const r = await c.send(new idp.AssociateSoftwareTokenCommand({ AccessToken: accessToken }))
      if (!r.SecretCode) throw new Error('Cognito gave no authenticator secret')
      return r.SecretCode
    },
    async verify(accessToken, code) {
      const r = await c.send(new idp.VerifySoftwareTokenCommand({ AccessToken: accessToken, UserCode: code, FriendlyDeviceName: 'trace smoke test' }))
      if (r.Status !== 'SUCCESS') throw new Error(`Cognito did not accept the authenticator code (${r.Status ?? 'no status'})`)
      await c.send(new idp.SetUserMFAPreferenceCommand({ AccessToken: accessToken, SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } }))
    },
    async remove(email) {
      try { await c.send(new idp.AdminDeleteUserCommand({ UserPoolId: poolId, Username: email })) } catch (e) {
        if (!named(e, 'UserNotFoundException')) throw e
      }
    },
    async read(name) {
      try { return (await s.send(new sm.GetSecretValueCommand({ SecretId: name }))).SecretString ?? null } catch (e) {
        if (named(e, 'ResourceNotFoundException') || deleting(e)) return null
        throw e
      }
    },
    async write(name, value, tags) {
      const put = () => s.send(new sm.PutSecretValueCommand({ SecretId: name, SecretString: value }))
      try {
        await put()
      } catch (e) {
        if (deleting(e)) {
          await s.send(new sm.RestoreSecretCommand({ SecretId: name }))
          await put()
          return
        }
        if (!named(e, 'ResourceNotFoundException')) throw e
        await s.send(new sm.CreateSecretCommand({
          Name: name, SecretString: value, Description: 'The smoke test user\'s sign-in (docs/smoke-test.md): read by the self-update role only',
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        }))
      }
    },
    async forget(name) {
      try { await s.send(new sm.DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true })) } catch (e) {
        if (!named(e, 'ResourceNotFoundException')) throw e
      }
    },
  }
}

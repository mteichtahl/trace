/**
 * The smoke user (docs/smoke-test.md "Live runs"): the account the live screen smoke test signs in as, after every
 * self-update, so nobody sets one up by hand.
 *
 *   who       `smoke@<prefix>.trace.invalid` (an address that can never receive mail: Cognito is told not to send any),
 *             an admin, because the admin screens are part of what the smoke test opens. Its password is random
 *             (32 characters) and it has an authenticator enrolled here, with a secret only this installation keeps
 *   where     one Secrets Manager secret, `<prefix>/smoke/sign-in` (smokeSecret), JSON of the TRACE_SMOKE_* variables the
 *             test reads (web/smoke/env.ts): the web app's address, the user's email, password and authenticator secret,
 *             and the project the screens are checked on. Only the installer writes it; the self-update role reads it
 *             (src/infra/stack.ts SmokeUserSecret), and trace's own repository's TRACE_SMOKE_SECRET names it, which
 *             turns on its ci workflow's smoke-live job
 *   again     a run that finds the user and a complete secret keeps both, and only brings the address and the project up
 *             to date. A user without a usable secret (deleted, or from a failed run) gets a new password and a new
 *             authenticator: its old one is switched off first, so the sign-in that enrols the new one asks for no code
 *
 * Whoever can read the secret can sign in as an admin. That is the self-update role, which can already deploy the whole
 * installation again: it gains no new power over it.
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
  /** whether the user exists */
  exists(email: string): Promise<boolean>
  /** create the user with its email verified, sending nothing */
  create(email: string): Promise<void>
  /** make it an admin (trace-admins), and only that */
  admin(email: string): Promise<void>
  /** set its password, permanent (no change asked at the first sign-in) */
  password(email: string, password: string): Promise<void>
  /** switch its authenticator off, so a sign-in asks for no code */
  mfaOff(email: string): Promise<void>
  /** sign in with the password alone (the web app's own way: USER_AUTH, then PASSWORD); the access token */
  signIn(email: string, password: string): Promise<string>
  /** start enrolling an authenticator; its base32 secret */
  associate(accessToken: string): Promise<string>
  /** finish enrolling with a code from it, and make it the user's second step from now on */
  verify(accessToken: string, code: string): Promise<void>
  /** the secret's string, or null when there is none */
  read(name: string): Promise<string | null>
  /** write the secret, creating it (with these tags) when missing */
  write(name: string, value: string, tags: Record<string, string>): Promise<void>
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
  const email = smokeEmail(o.prefix)
  const name = smokeSecret(o.prefix)
  const tags = { [INSTALLATION_TAG]: o.prefix, 'trace:purpose': 'smoke-test' }
  const where = { TRACE_SMOKE_URL: o.url.replace(/\/+$/, ''), TRACE_SMOKE_PROJECT: projectAddress(o.project) }

  const exists = await io.exists(email)
  const raw = await io.read(name)
  let stored: SmokeSignIn | null = null
  if (raw) {
    try { stored = SmokeSignIn.parse(JSON.parse(raw)) } catch { stored = null }
  }
  if (exists && stored && stored.TRACE_SMOKE_EMAIL === email) {
    // keep the sign-in; it stays an admin either way (a class changed by hand is put back)
    await io.admin(email)
    if (stored.TRACE_SMOKE_URL === where.TRACE_SMOKE_URL && stored.TRACE_SMOKE_PROJECT === where.TRACE_SMOKE_PROJECT) {
      log(`${email}: kept (${name})`)
      return { email, secret: name, state: 'kept' }
    }
    await io.write(name, JSON.stringify({ ...stored, ...where }), tags)
    log(`${email}: kept; ${name} now points at ${where.TRACE_SMOKE_URL}, project ${where.TRACE_SMOKE_PROJECT}`)
    return { email, secret: name, state: 'updated' }
  }

  if (!exists) {
    await io.create(email)
    log(`${email}: created (no email sent)`)
  } else {
    log(`${email}: found without a usable sign-in in ${name}: giving it a new password and authenticator`)
  }
  await io.admin(email)
  const password = smokePassword(o.random)
  await io.password(email, password)
  await io.mfaOff(email)
  const token = await io.signIn(email, password)
  const totp = await io.associate(token)
  await io.verify(token, totpCode(totp, (o.now ?? Date.now)()))
  const value: SmokeSignIn = { ...where, TRACE_SMOKE_EMAIL: email, TRACE_SMOKE_PASSWORD: password, TRACE_SMOKE_TOTP_SECRET: totp }
  await io.write(name, JSON.stringify(value), tags)
  log(`${email}: an admin with a password and an authenticator; its sign-in is in ${name}`)
  return { email, secret: name, state: 'made' }
}

type Creds = { accessKeyId: string; secretAccessKey: string; sessionToken?: string | undefined }

/** Cognito (the pool and the web app's own client) and Secrets Manager, with the installer's credentials. */
export async function liveSmokeIo(creds: Creds, region: string, poolId: string, webClientId: string): Promise<SmokeIo> {
  const idp = await import('@aws-sdk/client-cognito-identity-provider')
  const sm = await import('@aws-sdk/client-secrets-manager')
  const c = new idp.CognitoIdentityProviderClient({ region, credentials: creds })
  // the user-facing calls (sign in, enrol) take the user's own token, no AWS credentials
  const s = new sm.SecretsManagerClient({ region, credentials: creds })
  const notFound = (e: unknown, n: string): boolean => (e as { name?: string }).name === n
  return {
    async exists(email) {
      try { await c.send(new idp.AdminGetUserCommand({ UserPoolId: poolId, Username: email })); return true } catch (e) {
        if (notFound(e, 'UserNotFoundException')) return false
        throw e
      }
    },
    async create(email) {
      await c.send(new idp.AdminCreateUserCommand({
        UserPoolId: poolId, Username: email, MessageAction: 'SUPPRESS',
        UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: 'trace smoke test' }],
      }))
    },
    async admin(email) {
      await c.send(new idp.AdminAddUserToGroupCommand({ UserPoolId: poolId, Username: email, GroupName: GROUPS.admin }))
      const groups = await c.send(new idp.AdminListGroupsForUserCommand({ UserPoolId: poolId, Username: email }))
      for (const g of groups.Groups ?? []) {
        if (g.GroupName && g.GroupName !== GROUPS.admin && Object.values(GROUPS).includes(g.GroupName as never)) {
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
    async signIn(email, password) {
      const start = await c.send(new idp.InitiateAuthCommand({ AuthFlow: 'USER_AUTH', ClientId: webClientId, AuthParameters: { USERNAME: email } }))
      const out = start.AuthenticationResult
        ? start
        : await c.send(new idp.RespondToAuthChallengeCommand({
          ClientId: webClientId, Session: start.Session, ChallengeName: 'SELECT_CHALLENGE',
          ChallengeResponses: { USERNAME: email, ANSWER: 'PASSWORD', PASSWORD: password },
        }))
      const token = out.AuthenticationResult?.AccessToken
      if (!token) throw new Error(`the smoke user's sign-in stopped at ${out.ChallengeName ?? 'an unexpected step'}`)
      return token
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
    async read(name) {
      try { return (await s.send(new sm.GetSecretValueCommand({ SecretId: name }))).SecretString ?? null } catch (e) {
        if (notFound(e, 'ResourceNotFoundException')) return null
        throw e
      }
    },
    async write(name, value, tags) {
      try {
        await s.send(new sm.PutSecretValueCommand({ SecretId: name, SecretString: value }))
      } catch (e) {
        if (!notFound(e, 'ResourceNotFoundException')) throw e
        await s.send(new sm.CreateSecretCommand({
          Name: name, SecretString: value, Description: 'The smoke test user\'s sign-in (docs/smoke-test.md): read by the self-update role only',
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        }))
      }
    },
  }
}

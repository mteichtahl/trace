/**
 * The AWS calls the API runtime makes, behind small interfaces so tests run offline:
 *
 *   Cognito       AdminGetUser, ListUsers, ListUsersInGroup, AdminCreateUser, AdminListGroupsForUser,
 *                 AdminAddUserToGroup, AdminRemoveUserFromGroup — the JSON protocol, signed with SigV4 here (the
 *                 Cognito SDK client is not a dependency; credentials come from the runtime role via the SDK chain)
 *   Secrets       the GitHub token (TRACE_GITHUB_SECRET_ARN), cached for 10 minutes
 */
import { createHash, createHmac } from 'node:crypto'
import { z } from 'zod'

// ------------------------------------------------------------------ SigV4 (POST, JSON body, no query string)

export interface Credentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string | undefined }

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const hmac = (k: Buffer | string, s: string): Buffer => createHmac('sha256', k).update(s).digest()

export function signV4(o: { host: string; region: string; service: string; body: string; headers: Record<string, string>; creds: Credentials; now?: Date }): Record<string, string> {
  const t = (o.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = t.slice(0, 8)
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(o.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: o.host, 'x-amz-date': t }
  if (o.creds.sessionToken) headers['x-amz-security-token'] = o.creds.sessionToken
  const names = Object.keys(headers).sort()
  const canonical = ['POST', '/', '', ...names.map((n) => `${n}:${headers[n] ?? ''}`), '', names.join(';'), sha256(o.body)].join('\n')
  const scope = `${day}/${o.region}/${o.service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', t, scope, sha256(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac(`AWS4${o.creds.secretAccessKey}`, day), o.region), o.service), 'aws4_request')
  const sig = createHmac('sha256', key).update(toSign).digest('hex')
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${o.creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`
  delete headers.host
  return headers
}

async function defaultCredentials(): Promise<Credentials> {
  const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers')
  const c = await fromNodeProviderChain()()
  return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken }
}

// ------------------------------------------------------------------ Cognito

export interface CognitoUser { sub: string; username: string; email: string | null; status: string | null; enabled: boolean }

export interface CognitoAdmin {
  getUser(username: string): Promise<CognitoUser | null>
  /** A person by email or sub (ListUsers with a filter), or null. */
  find(who: string): Promise<CognitoUser | null>
  listUsers(): Promise<CognitoUser[]>
  usersInGroup(group: string): Promise<CognitoUser[]>
  createUser(email: string): Promise<CognitoUser>
  groupsFor(username: string): Promise<string[]>
  addToGroup(username: string, group: string): Promise<void>
  removeFromGroup(username: string, group: string): Promise<void>
}

const Attr = z.object({ Name: z.string(), Value: z.string().optional() }).loose()
const UserShape = z.object({
  Username: z.string(),
  Attributes: z.array(Attr).optional(),
  UserAttributes: z.array(Attr).optional(),
  UserStatus: z.string().optional(),
  Enabled: z.boolean().optional(),
}).loose()

function toUser(u: z.output<typeof UserShape>): CognitoUser {
  const attrs = u.Attributes ?? u.UserAttributes ?? []
  const at = (n: string): string | null => attrs.find((a) => a.Name === n)?.Value ?? null
  return { sub: at('sub') ?? u.Username, username: u.Username, email: at('email'), status: u.UserStatus ?? null, enabled: u.Enabled ?? true }
}

export class CognitoError extends Error {
  override name = 'CognitoError'
  constructor(readonly type: string, message: string) { super(message) }
}

export class HttpCognito implements CognitoAdmin {
  constructor(private readonly o: { region: string; poolId: string; credentials?: () => Promise<Credentials>; fetch?: typeof fetch }) {}

  private async call(op: string, body: Record<string, unknown>): Promise<unknown> {
    const host = `cognito-idp.${this.o.region}.amazonaws.com`
    const text = JSON.stringify({ UserPoolId: this.o.poolId, ...body })
    const headers = signV4({
      host, region: this.o.region, service: 'cognito-idp', body: text,
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${op}` },
      creds: await (this.o.credentials ?? defaultCredentials)(),
    })
    const r = await (this.o.fetch ?? fetch)(`https://${host}/`, { method: 'POST', headers, body: text, signal: AbortSignal.timeout(15_000) })
    const json: unknown = await r.json().catch(() => ({}))
    if (!r.ok) {
      const e = z.object({ __type: z.string().optional(), message: z.string().optional() }).loose().safeParse(json)
      const type = (e.success ? e.data.__type : undefined)?.split('#').at(-1) ?? `HTTP${r.status}`
      throw new CognitoError(type, `Cognito ${op}: ${type}${e.success && e.data.message ? `: ${e.data.message}` : ''}`)
    }
    return json
  }

  async getUser(username: string): Promise<CognitoUser | null> {
    try {
      return toUser(UserShape.parse(await this.call('AdminGetUser', { Username: username })))
    } catch (e) {
      if (e instanceof CognitoError && e.type === 'UserNotFoundException') return null
      throw e
    }
  }

  private async paged(op: string, extra: Record<string, unknown>, tokenKey: 'PaginationToken' | 'NextToken'): Promise<CognitoUser[]> {
    const out: CognitoUser[] = []
    let token: string | undefined
    const Page = z.object({ Users: z.array(UserShape).optional(), PaginationToken: z.string().optional(), NextToken: z.string().optional() }).loose()
    for (let i = 0; i < 100; i++) {
      const p = Page.parse(await this.call(op, { ...extra, Limit: 60, ...(token ? { [tokenKey]: token } : {}) }))
      out.push(...(p.Users ?? []).map(toUser))
      token = p[tokenKey]
      if (!token) break
    }
    return out
  }

  listUsers(): Promise<CognitoUser[]> { return this.paged('ListUsers', {}, 'PaginationToken') }

  async find(who: string): Promise<CognitoUser | null> {
    const attr = who.includes('@') ? 'email' : 'sub'
    if (!/^[^"\\\s]+$/.test(who)) return null
    const found = await this.paged('ListUsers', { Filter: `${attr} = "${who}"` }, 'PaginationToken')
    return found[0] ?? null
  }
  usersInGroup(group: string): Promise<CognitoUser[]> { return this.paged('ListUsersInGroup', { GroupName: group }, 'NextToken') }

  async createUser(email: string): Promise<CognitoUser> {
    const r = z.object({ User: UserShape }).loose().parse(await this.call('AdminCreateUser', {
      Username: email, DesiredDeliveryMediums: ['EMAIL'],
      UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
    }))
    return toUser(r.User)
  }

  async groupsFor(username: string): Promise<string[]> {
    const Page = z.object({ Groups: z.array(z.object({ GroupName: z.string() }).loose()).optional(), NextToken: z.string().optional() }).loose()
    const out: string[] = []
    let token: string | undefined
    for (let i = 0; i < 20; i++) {
      const p = Page.parse(await this.call('AdminListGroupsForUser', { Username: username, Limit: 60, ...(token ? { NextToken: token } : {}) }))
      out.push(...(p.Groups ?? []).map((g) => g.GroupName))
      token = p.NextToken
      if (!token) break
    }
    return out
  }

  async addToGroup(username: string, group: string): Promise<void> { await this.call('AdminAddUserToGroup', { Username: username, GroupName: group }) }
  async removeFromGroup(username: string, group: string): Promise<void> { await this.call('AdminRemoveUserFromGroup', { Username: username, GroupName: group }) }
}

// ------------------------------------------------------------------ the GitHub token

let cached: { arn: string; token: string; at: number } | null = null

export async function githubToken(arn = process.env.TRACE_GITHUB_SECRET_ARN ?? ''): Promise<string> {
  if (process.env.TRACE_GITHUB_TOKEN) return process.env.TRACE_GITHUB_TOKEN
  if (!arn) throw new Error('TRACE_GITHUB_SECRET_ARN is not set')
  if (cached && cached.arn === arn && Date.now() - cached.at < 600_000) return cached.token
  const { GetSecretValueCommand, SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager')
  const r = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }))
  const token = (r.SecretString ?? '').trim()
  if (!token) throw new Error('the GitHub token secret is empty')
  cached = { arn, token, at: Date.now() }
  return token
}

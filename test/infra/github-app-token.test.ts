/**
 * trace's token broker (src/infra/lambda/github-app-token.ts, docs/agent-identity.md): a token of trace's GitHub app for
 * the calling project's repository alone, decided from the caller's role and never from the request; the app's key read
 * from Secrets Manager, nowhere else.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto'
import type { LambdaFunctionURLEvent } from 'aws-lambda'
import { App, Stack } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { beforeEach, describe, expect, it } from 'vitest'
import { appJwt, assumedRole, parseAppSecret, projectRoleNames, repositoryOfRole } from '../../src/core/github-app.js'
import { projectHash } from '../../src/core/project.js'
import { GithubAppBroker, brokerInvokeStatements } from '../../src/infra/github-app.js'
import { type Deps, forgetKey, handle } from '../../src/infra/lambda/github-app-token.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const SECRET = JSON.stringify({ appId: '123456', privateKey: PEM })
const BOARD = 'mteichtahl/test-esp32'
const OTHER = 'mteichtahl/potroller'
const ACCOUNT = '123456789012'
const NOW = 1_800_000_000_000
const roles = projectRoleNames('trace', BOARD, 'us-east-1')

interface Sent { url: string; method: string; headers: Record<string, string>; body?: string | undefined }
/** GitHub, answering `answers` keyed "METHOD path", every request kept. */
function github(answers: Record<string, [number, unknown]> = {
  [`GET /repos/${BOARD}/installation`]: [200, { id: 42, app_slug: 'trace-tr' }],
  'POST /app/installations/42/access_tokens': [201, { token: 'ghs_board', expires_at: '2027-01-15T09:00:00Z' }],
}) {
  const sent: Sent[] = []
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    sent.push({ url, ...init })
    const [status, body] = answers[`${init.method} ${new URL(url).pathname}`] ?? [404, { message: 'Not Found' }]
    return { status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) }
  }
  return { fetch, sent }
}

function deps(o: Partial<Deps> = {}) {
  let reads = 0
  const lines: Record<string, unknown>[] = []
  const g = github()
  const d: Deps = {
    prefix: 'trace', region: 'us-east-1', account: ACCOUNT, registry: `${BOARD} ${OTHER}`,
    secret: async () => { reads++; return SECRET }, fetch: g.fetch, now: () => NOW, log: (l) => lines.push(l), ...o,
  }
  return { d, sent: g.sent, reads: () => reads, lines }
}

/** A function URL request signed by `arn`, with whatever body and query the caller chose. */
const event = (arn: string | null, body = '{}', query: Record<string, string> = {}): LambdaFunctionURLEvent => ({
  version: '2.0', routeKey: '$default', rawPath: '/', rawQueryString: new URLSearchParams(query).toString(), headers: {}, queryStringParameters: query,
  body, isBase64Encoded: false,
  requestContext: {
    accountId: ACCOUNT, apiId: 'x', domainName: 'x.lambda-url.us-east-1.on.aws', domainPrefix: 'x', requestId: 'r', routeKey: '$default', stage: '$default', time: '', timeEpoch: 0,
    http: { method: 'POST', path: '/', protocol: 'HTTP/1.1', sourceIp: '1.2.3.4', userAgent: 'test' },
    ...(arn ? { authorizer: { iam: { accessKey: 'AKIA', accountId: ACCOUNT, callerId: 'AROA:s', cognitoIdentity: null, principalOrgId: null, userArn: arn, userId: 'AROA:s' } } } : {}),
  },
} as unknown as LambdaFunctionURLEvent)
const signer = (role: string, account = ACCOUNT) => `arn:aws:sts::${account}:assumed-role/${role}/trace-open-pr-123`
const json = (r: { body?: string | undefined }) => JSON.parse(r.body ?? '{}') as Record<string, unknown>

describe('the token broker', () => {
  beforeEach(() => forgetKey())

  it('gives a token for the caller\'s own repository, picked from its role: the token, worker and OIDC roles alike', async () => {
    for (const role of [roles.token, roles.worker, roles.actions]) {
      forgetKey()
      const f = deps()
      const r = await handle(event(signer(role)), f.d)
      expect(r.statusCode).toBe(200)
      expect(json(r)).toEqual({ token: 'ghs_board', expiresAt: '2027-01-15T09:00:00Z', login: 'trace-tr[bot]', repository: BOARD })
      expect(f.sent.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([`GET /repos/${BOARD}/installation`, 'POST /app/installations/42/access_tokens'])
    }
  })

  it('scopes the token to that one repository, asked with the app\'s own signed JSON web token', async () => {
    const f = deps()
    await handle(event(signer(roles.token)), f.d)
    expect(JSON.parse(f.sent[1]!.body!)).toEqual({ repositories: ['test-esp32'] })
    const jwt = f.sent[0]!.headers.authorization!.replace(/^Bearer /, '')
    expect(jwt).toBe(appJwt({ appId: '123456', privateKey: PEM }, NOW))
    const [h, b, s] = jwt.split('.')
    expect(JSON.parse(Buffer.from(b!, 'base64url').toString())).toEqual({ iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: '123456' })
    expect(createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true)
  })

  it('ignores a repository the request names: the token is still for the caller\'s own', async () => {
    const f = deps()
    const r = await handle(event(signer(roles.token), JSON.stringify({ repository: OTHER, repositories: [OTHER] }), { repository: OTHER }), f.d)
    expect(json(r).repository).toBe(BOARD)
    expect(f.sent.some((s) => s.url.includes('potroller') || (s.body ?? '').includes('potroller'))).toBe(false)
  })

  it('refuses a role that is none of the projects\', another account\'s, another region\'s, or no signer, without reading the key', async () => {
    const callers = [
      signer('trace-gh-ffffffff-us-east-1'), signer('admin'), signer(roles.token, '999999999999'),
      signer(projectRoleNames('trace', BOARD, 'eu-west-1').token), signer(projectRoleNames('other', BOARD, 'us-east-1').token),
      `arn:aws:iam::${ACCOUNT}:user/marc`, null,
    ]
    for (const arn of callers) {
      const f = deps()
      const r = await handle(event(arn), f.d)
      expect(r.statusCode, String(arn)).toBe(403)
      expect(f.reads()).toBe(0)
      expect(f.sent).toHaveLength(0)
    }
  })

  it('reads the app\'s key from Secrets Manager, and keeps it five minutes', async () => {
    let at = NOW
    const f = deps({ now: () => at })
    await handle(event(signer(roles.token)), f.d)
    await handle(event(signer(roles.token)), f.d)
    expect(f.reads()).toBe(1)
    at += 5 * 60_000
    await handle(event(signer(roles.token)), f.d)
    expect(f.reads()).toBe(2)
  })

  it('says so when the app is not set up, not installed, or GitHub refuses; and never logs the token', async () => {
    expect((await handle(event(signer(roles.token)), deps({ secret: async () => '' }).d)).statusCode).toBe(503)
    forgetKey()
    const missing = Object.assign(new Error('Secrets Manager can\'t find the specified secret.'), { name: 'ResourceNotFoundException' })
    expect((await handle(event(signer(roles.token)), deps({ secret: async () => { throw missing } }).d)).statusCode).toBe(503)
    forgetKey()
    const none = github({})
    const r = await handle(event(signer(roles.token)), deps({ fetch: none.fetch }).d)
    expect(r.statusCode).toBe(404)
    expect(json(r).message).toBe(`trace's GitHub app is not installed on ${BOARD}`)
    forgetKey()
    const refused = github({ [`GET /repos/${BOARD}/installation`]: [200, { id: 42 }], 'POST /app/installations/42/access_tokens': [401, { message: 'A JSON web token could not be decoded' }] })
    expect((await handle(event(signer(roles.token)), deps({ fetch: refused.fetch }).d)).statusCode).toBe(502)
    forgetKey()
    const f = deps()
    await handle(event(signer(roles.token)), f.d)
    expect(JSON.stringify(f.lines)).not.toContain('ghs_board')
    expect(f.lines.at(-1)).toMatchObject({ outcome: 'token', role: roles.token, repository: BOARD })
  })
})

describe('the broker\'s pieces', () => {
  it('reads an assumed role\'s account and name, and nothing else', () => {
    expect(assumedRole(`arn:aws:sts::${ACCOUNT}:assumed-role/trace-gt-abc-us-east-1/s`)).toEqual({ account: ACCOUNT, role: 'trace-gt-abc-us-east-1' })
    expect(assumedRole(`arn:aws:iam::${ACCOUNT}:role/x`)).toBeNull()
    expect(assumedRole('')).toBeNull()
  })

  it('finds a role\'s repository by its hash in the registry', () => {
    const o = { prefix: 'trace', region: 'us-east-1', registry: `${BOARD} ${OTHER}` }
    expect(repositoryOfRole(`trace-gt-${projectHash(OTHER)}-us-east-1`, o)).toBe(OTHER)
    expect(repositoryOfRole(`trace-gt-${projectHash('someone/else')}-us-east-1`, o)).toBeNull()
    expect(repositoryOfRole(`trace-x-${projectHash(BOARD)}-us-east-1`, o)).toBeNull()
  })

  it('takes the secret as JSON with the app\'s id and key', () => {
    expect(parseAppSecret(SECRET)).toEqual({ appId: '123456', privateKey: PEM.trim() })
    expect(parseAppSecret(JSON.stringify({ appId: 7, privateKey: 'k' }))).toEqual({ appId: '7', privateKey: 'k' })
    expect(parseAppSecret('{}')).toBeNull()
    expect(parseAppSecret('not json')).toBeNull()
  })

  it('the function: its URL takes IAM sign-in only, it reads the one secret, and it knows the registry', () => {
    process.env.TRACE_WEB_SKIP_BUNDLE = '1'
    const stack = new Stack(new App(), 'BrokerTest', { env: { account: ACCOUNT, region: 'us-east-1' } })
    new GithubAppBroker(stack, 'Broker', { prefix: 'trace', repositories: [BOARD, OTHER], root: process.cwd() })
    const t = Template.fromStack(stack)
    t.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' })
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'trace-github-app-token',
      Environment: { Variables: { TRACE_PREFIX: 'trace', TRACE_ACCOUNT: ACCOUNT, TRACE_GITHUB_APP_SECRET: 'trace/github-app', TRACE_GITHUB_APP_PROJECTS: `${BOARD} ${OTHER}` } },
    })
    const policies = JSON.stringify(t.findResources('AWS::IAM::Policy'))
    expect(policies).toContain(`secret:trace/github-app-??????`)
    expect(policies).not.toMatch(/secretsmanager:\*|"Resource":"\*"/)
    expect(t.findResources('AWS::Lambda::Permission')).toEqual({})
    expect(Object.keys(t.findOutputs('GithubAppBrokerUrl'))).toEqual(['GithubAppBrokerUrl'])
    const ask = brokerInvokeStatements('aws', 'us-east-1', ACCOUNT, 'trace').map((s) => s.toJSON())
    expect(ask[0]).toMatchObject({ Action: 'lambda:InvokeFunctionUrl', Resource: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:trace-github-app-token`, Condition: { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } } })
  }, 120_000)
})

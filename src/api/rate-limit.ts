/**
 * The external runtime's request limits (docs/external-access.md "External API"), in two lines:
 *
 *   in memory   a token bucket per system in this container (server.ts RateLimiter: 10 a second, bursting to 20). Cheap,
 *               and it turns away a flood before anything else is asked
 *   shared      fixed windows counted in DynamoDB (TRACE_RATE_TABLE, made with external.enabled): per system, at most
 *               10 requests in any one second and 300 in any one minute, across every container. AgentCore starts a
 *               container per runtime session and the caller picks the session id, so a per-container limit alone
 *               is skipped by sending a new session id with every request; the shared one is not
 *
 * Each window is one item, `<client_id>#s#<epoch second>` or `<client_id>#m#<epoch minute>`, counted with
 * UpdateItem `ADD n :one` on the condition `attribute_not_exists(n) OR n < :limit`. A refused condition is the limit:
 * 429 with Retry-After (1 s for the second's window, the rest of the minute for the minute's). Items expire by TTL a few
 * minutes after their window. A refused request still counts in the window that let it through.
 *
 * When DynamoDB itself fails (throttled, unreachable, the table missing), the request goes ahead (fail open) and the
 * failure is logged once, and again only after it has recovered and failed anew. The limit protects the installation's
 * capacity and cost, not access, which the verifier and the allow-list decide on every call; failing closed would let
 * an outage of the counter shut every connected system out, and the in-memory bucket still holds each container.
 *
 * DynamoDB's JSON API is called directly, signed with SigV4 (src/api/aws.ts), as Cognito is: the DynamoDB client is
 * not a dependency.
 */
import { z } from 'zod'
import { type Credentials, signV4 } from './aws.js'

export const PER_SECOND = 10
export const PER_MINUTE = 300

export interface SharedLimitOptions {
  table: string
  region: string
  perSecond?: number
  perMinute?: number
  credentials?: () => Promise<Credentials>
  fetch?: typeof fetch
  now?: () => number
  log?: (line: Record<string, unknown>) => void
  /** DynamoDB's address (tests); default https://dynamodb.<region>.amazonaws.com/ */
  endpoint?: string
}

/** The limit was reached: wait this many seconds. */
export interface Limited { wait: number; window: 'second' | 'minute' }

async function defaultCredentials(): Promise<Credentials> {
  const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers')
  const c = await fromNodeProviderChain()()
  return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken }
}

const ErrorShape = z.object({ __type: z.string().optional(), message: z.string().optional() }).loose()

/** The shared limit, per system, over every external container. */
export class SharedLimit {
  private readonly perSecond: number
  private readonly perMinute: number
  private readonly now: () => number
  private failing = false

  constructor(private readonly o: SharedLimitOptions) {
    this.perSecond = o.perSecond ?? PER_SECOND
    this.perMinute = o.perMinute ?? PER_MINUTE
    this.now = o.now ?? Date.now
  }

  /** Count one request of `clientId`: null when it may go ahead, else how long to wait. Never throws. */
  async take(clientId: string): Promise<Limited | null> {
    const t = this.now() / 1000
    const second = Math.floor(t)
    const minute = Math.floor(t / 60)
    try {
      const [s, m] = await Promise.all([
        this.count(`${clientId}#s#${second}`, this.perSecond, second + 120),
        this.count(`${clientId}#m#${minute}`, this.perMinute, (minute + 1) * 60 + 180),
      ])
      if (this.failing) { this.failing = false; this.o.log?.({ at: new Date().toISOString(), warning: 'rate limit: DynamoDB answers again' }) }
      if (!s) return { wait: 1, window: 'second' }
      if (!m) return { wait: Math.max(1, Math.ceil((minute + 1) * 60 - t)), window: 'minute' }
      return null
    } catch (e) {
      // fail open (see the module comment), logged once until it recovers
      if (!this.failing) {
        this.failing = true
        this.o.log?.({ at: new Date().toISOString(), warning: `rate limit: DynamoDB failed, requests go ahead without the shared limit until it answers again: ${e instanceof Error ? e.message : String(e)}` })
      }
      return null
    }
  }

  /** One window's counter: true when it was under the limit (and is now one more), false when it was at it. */
  private async count(key: string, limit: number, ttl: number): Promise<boolean> {
    const host = `dynamodb.${this.o.region}.amazonaws.com`
    const body = JSON.stringify({
      TableName: this.o.table,
      Key: { k: { S: key } },
      UpdateExpression: 'ADD n :one SET #ttl = :ttl',
      ConditionExpression: 'attribute_not_exists(n) OR n < :limit',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': { N: '1' }, ':limit': { N: String(limit) }, ':ttl': { N: String(ttl) } },
    })
    const headers = signV4({
      host, region: this.o.region, service: 'dynamodb', body,
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.UpdateItem' },
      creds: await (this.o.credentials ?? defaultCredentials)(),
    })
    const r = await (this.o.fetch ?? fetch)(this.o.endpoint ?? `https://${host}/`, { method: 'POST', headers, body, signal: AbortSignal.timeout(2_000) })
    if (r.ok) return true
    const e = ErrorShape.safeParse(await r.json().catch(() => ({})))
    const type = (e.success ? e.data.__type : undefined)?.split('#').at(-1) ?? `HTTP${r.status}`
    if (type === 'ConditionalCheckFailedException') return false
    throw new Error(`DynamoDB UpdateItem: ${type}${e.success && e.data.message ? `: ${e.data.message}` : ''}`)
  }
}

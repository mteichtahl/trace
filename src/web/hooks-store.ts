/**
 * The webhook debounce's shared windows (src/web/hooks.ts DebounceStore) in DynamoDB: `<prefix>-web-hooks`, one item
 * per repository, `{ k: <owner/repo>, until: <epoch ms>, noted: <string set>, ttl }`. GitHub's deliveries of one push
 * arrive as separate invocations, often in separate containers, so a window kept in memory would not hold them.
 *
 *   claim    UpdateItem SET until, REMOVE noted, if the item is missing or its window is over
 *   join     UpdateItem ADD noted :n, if a window is open (a number, or `-` for a delivery that named none)
 *   release  UpdateItem SET until = now, REMOVE noted, ReturnValues UPDATED_OLD: what was noted, only if the window
 *            is still the holder's (its `until` is the one the holder claimed): a window another delivery claimed after
 *            this one ended is that delivery's, and releasing it would drop what was noted in it
 *   delivery UpdateItem SET ttl on `delivery#<X-GitHub-Delivery>`, if there is none or it has expired: a delivery
 *            seen in the last day (DELIVERY_TTL_S) is a replay
 *
 * Every write is conditional and atomic, so two containers never both hold a window. Items expire by TTL a day after
 * their last window (the table's TTL is on `ttl`: src/infra/web.ts). Called with DynamoDB's JSON API, signed with SigV4 by the backend's role, as the external
 * runtime's request limit is (src/api/rate-limit.ts): the DynamoDB client is not a dependency.
 */
import { z } from 'zod'
import { type Credentials, signV4 } from '../api/aws.js'
import { DELIVERY_TTL_S, type DebounceStore } from './hooks.js'

const ErrorShape = z.object({ __type: z.string().optional(), message: z.string().optional() }).loose()
const Old = z.object({ Attributes: z.object({ noted: z.object({ SS: z.array(z.string()) }).loose().optional() }).loose().optional() }).loose()

const NONE = '-'

export interface DynamoDebounceOptions {
  table: string
  region: string
  credentials: () => Promise<Credentials>
  fetch?: typeof fetch
  /** DynamoDB's address (tests); default https://dynamodb.<region>.amazonaws.com/ */
  endpoint?: string
}

export class DynamoDebounceStore implements DebounceStore {
  constructor(private readonly o: DynamoDebounceOptions) {}

  async claim(repo: string, until: number, now: number): Promise<boolean> {
    return this.update(repo, {
      UpdateExpression: 'SET #u = :until, #ttl = :ttl REMOVE noted',
      ConditionExpression: 'attribute_not_exists(#u) OR #u <= :now',
      ExpressionAttributeNames: { '#u': 'until', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':until': { N: String(until) }, ':now': { N: String(now) }, ':ttl': { N: String(Math.floor(until / 1000) + 86_400) } },
    }).then((r) => r !== null)
  }

  async join(repo: string, number: number | null, now: number): Promise<boolean> {
    return this.update(repo, {
      UpdateExpression: 'ADD noted :n',
      ConditionExpression: '#u > :now',
      ExpressionAttributeNames: { '#u': 'until' },
      ExpressionAttributeValues: { ':n': { SS: [number === null ? NONE : String(number)] }, ':now': { N: String(now) } },
    }).then((r) => r !== null)
  }

  async release(repo: string, until: number, now: number): Promise<(number | null)[]> {
    const r = await this.update(repo, {
      UpdateExpression: 'SET #u = :now REMOVE noted',
      ConditionExpression: '#u = :until',
      ExpressionAttributeNames: { '#u': 'until' },
      ExpressionAttributeValues: { ':now': { N: String(now) }, ':until': { N: String(until) } },
      ReturnValues: 'UPDATED_OLD',
    })
    if (r === null) return []
    const old = Old.safeParse(r)
    return (old.success ? old.data.Attributes?.noted?.SS ?? [] : []).map((s) => (s === NONE ? null : Number(s))).filter((n) => n === null || Number.isInteger(n))
  }

  async firstDelivery(id: string, now: number): Promise<boolean> {
    const s = Math.floor(now / 1000)
    return this.update(`delivery#${id}`, {
      UpdateExpression: 'SET #ttl = :ttl',
      ConditionExpression: 'attribute_not_exists(#ttl) OR #ttl < :now',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':ttl': { N: String(s + DELIVERY_TTL_S) }, ':now': { N: String(s) } },
    }).then((r) => r !== null)
  }

  /** One conditional UpdateItem on item `key`: its answer, or null when its condition did not hold. Throws on anything else. */
  private async update(key: string, x: Record<string, unknown>): Promise<unknown> {
    const host = `dynamodb.${this.o.region}.amazonaws.com`
    const body = JSON.stringify({ TableName: this.o.table, Key: { k: { S: key } }, ...x })
    const headers = signV4({
      host, region: this.o.region, service: 'dynamodb', body,
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.UpdateItem' },
      creds: await this.o.credentials(),
    })
    const r = await (this.o.fetch ?? fetch)(this.o.endpoint ?? `https://${host}/`, { method: 'POST', headers, body, signal: AbortSignal.timeout(2_000) })
    const json = await r.json().catch(() => ({}))
    if (r.ok) return json
    const e = ErrorShape.safeParse(json)
    const type = (e.success ? e.data.__type : undefined)?.split('#').at(-1) ?? `HTTP${r.status}`
    if (type === 'ConditionalCheckFailedException') return null
    throw new Error(`DynamoDB UpdateItem: ${type}${e.success && e.data.message ? `: ${e.data.message}` : ''}`)
  }
}

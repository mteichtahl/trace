/**
 * Push notifications for one project (docs/push.md), run by the journey-events Lambda whenever the project's journey
 * record or its agents' facts are written (src/web/journey-events.ts).
 *
 *   who      the project's admins and assigned people who have a device subscribed (src/core/push-subscriptions.ts)
 *            and push turned on for at least one kind; nobody → nothing more is read
 *   what     for each of them, exactly what Next shows them on this project (src/core/journey.ts inboxItems, with
 *            their own viewer: admin, part, sub and hashes), of the four kinds that earn a notification (a gate is
 *            ready, a question blocks work, money is about to be spent, an agent is stuck), less the kinds they turned
 *            off and, on a project set to "gates and spend", questions and stuck agents
 *   once     each (person, item) is pushed once: a claim in the push ledger (DynamoDB, `sent#…`, kept SENT_TTL_S). A
 *            gate that becomes ready again within that time is not pushed again; it is in Next
 *   when     not in the device's quiet hours (its own time zone). When every device of the person is in quiet hours
 *            the item is not claimed, so the next change of the project after them pushes it if it still waits
 *   where    every device of the person, the newest first; a device the push service says is gone (404, 410) is
 *            marked dead in the ledger and skipped (a browser that subscribes again gets a new endpoint).
 *            When no device took it and one asked to retry later, the claim is let go, for the next change
 *
 * The message carries the project's name, the kind, and the item's summary as Next shows it, encrypted end to end to
 * the device (src/web/web-push.ts): the push service sees none of it. A tap opens the item in the app.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { type Credentials, signV4 } from '../api/aws.js'
import { AGENT_FACTS_DB, AGENT_FACTS_FOLDER, applyAgentFactsSchema, loadAgentFacts } from '../core/agent-facts.js'
import { Central, S3Backend, type S3Api } from '../core/central.js'
import { BucketDb, JourneyStore } from '../core/journey-store.js'
import { type InboxItem, type Viewer, inboxItems, loadJourney } from '../core/journey.js'
import { NOTIFY_KINDS, type NotifyKind, isQuiet, notifyPrefs, wantsPush } from '../core/notify-prefs.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { type Device, devicesOf } from '../core/push-subscriptions.js'
import { type VapidKeys, type PushResult, sendPush } from './web-push.js'

/** How long a pushed item is remembered: it is not pushed again in this time. */
export const SENT_TTL_S = 30 * 86_400
/** How long a dead device is skipped (the app subscribes it again sooner when the person opens it). */
export const DEAD_TTL_S = 90 * 86_400

const personHash = (who: string): string => createHash('sha256').update(who.trim().toLowerCase()).digest('hex').slice(0, 16)
export const endpointKey = (endpoint: string): string => `dead#${createHash('sha256').update(endpoint).digest('base64url').slice(0, 32)}`

/** What was pushed, and to whom. */
export interface Ledger {
  /** true when this caller is the first (or the earlier claim expired) */
  claim(key: string, ttlS: number, nowS: number): Promise<boolean>
  /** let go of a claim (no device took the message) */
  release(key: string, nowS: number): Promise<void>
  /** whether the key is held and not expired, without taking it */
  held(key: string, nowS: number): Promise<boolean>
}

/** A person on the project, as the access store records them. */
export interface Person { sub: string; email: string | null; admin: boolean; part: 'contributor' | 'reviewer' | null; prefs: unknown }

const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))

/** The project's admins and assigned people, with their preferences and devices (from the access store). */
export function peopleOf(db: DatabaseSync, repo: string): { people: Person[]; devices: Device[] } {
  const users = has(db, 'users') ? (db.prepare('SELECT sub, email, class FROM users').all() as Record<string, unknown>[]) : []
  const byId = new Map(users.map((u) => [String(u.sub), u]))
  const parts = new Map<string, 'contributor' | 'reviewer' | null>()
  if (has(db, 'assignments')) {
    const cols = (db.prepare("SELECT name FROM pragma_table_info('assignments')").all() as { name: string }[]).map((c) => c.name)
    for (const r of db.prepare(`SELECT sub, ${cols.includes('part') ? 'part' : 'NULL AS part'} FROM assignments WHERE repo=?`).all(repo) as Record<string, unknown>[]) {
      const u = byId.get(String(r.sub))
      parts.set(String(r.sub), u?.class === 'guest' || r.part === 'reviewer' ? 'reviewer' : 'contributor')
    }
  }
  const subs = new Set([...users.filter((u) => u.class === 'admin').map((u) => String(u.sub)), ...parts.keys()])
  const devices = devicesOf(db, [...subs])
  const withDevice = new Set(devices.map((d) => d.sub))
  const prefs = new Map<string, unknown>()
  if (withDevice.size && has(db, 'preferences')) {
    const list = [...withDevice]
    for (const r of db.prepare(`SELECT sub, doc FROM preferences WHERE sub IN (${list.map(() => '?').join(',')})`).all(...list) as Record<string, unknown>[]) {
      try { prefs.set(String(r.sub), JSON.parse(String(r.doc))) } catch { /* a broken document is the defaults */ }
    }
  }
  const people = [...withDevice].map((sub): Person => {
    const u = byId.get(sub)
    return { sub, email: u?.email ? String(u.email) : null, admin: u?.class === 'admin', part: parts.get(sub) ?? null, prefs: prefs.get(sub) ?? {} }
  })
  return { people, devices }
}

const KIND_WORD: Record<NotifyKind, string> = { gate: 'Gate ready', question: 'Question', spend: 'Ready to spend', stuck: 'Agent stuck', renders: 'Renders ready' }

/** The message for one item: what the device shows, and where a tap goes. */
export function messageFor(item: InboxItem): { id: string; kind: string; title: string; body: string; url: string; tag: string } {
  const kind = item.kind as NotifyKind
  const lead = `${item.project}: `
  const text = item.summary.startsWith(lead) ? item.summary.slice(lead.length) : item.summary
  const body = text.length > 180 ? `${text.slice(0, 177).trimEnd()}…` : text
  const pid = item.repo.replace('/', '~')
  const url = item.ref.kind === 'gate'
    ? `/p/${encodeURIComponent(pid)}/gates/${encodeURIComponent(item.ref.id)}`
    : item.ref.kind === 'renders'
      ? `/p/${encodeURIComponent(pid)}/renders`
      : `/next?item=${encodeURIComponent(item.id)}&repo=${encodeURIComponent(item.repo)}`
  return { id: item.id, kind, title: `${item.project} · ${KIND_WORD[kind] ?? 'Needs you'}`, body, url, tag: `${item.repo}:${item.id}` }
}

export interface PushDeps {
  bucket: string
  s3?: S3Api | undefined
  ledger: Ledger
  /** the installation's push keys, or null when push is not set up (nothing is sent) */
  keys: () => Promise<VapidKeys | null>
  fetch: typeof fetch
  now: () => number
  log: (entry: Record<string, unknown>) => void
  scratch?: string | undefined
}

export interface PushOutcome { repo: string; people: number; items: number; sent: number; quiet: number; gone: number; failed: number }

/** Push what is new on `repo` to the people who asked for it (see the module comment). */
export async function pushForProject(repo: string, d: PushDeps): Promise<PushOutcome> {
  const out: PushOutcome = { repo, people: 0, items: 0, sent: 0, quiet: 0, gone: 0, failed: 0 }
  const access = new Central({ home: `s3://${d.bucket}/access`, ...(d.s3 ? { s3: d.s3 } : {}) })
  const { people, devices } = await access.query((db) => peopleOf(db, repo))
  const askers = people.filter((p) => { const n = notifyPrefs(p.prefs); return NOTIFY_KINDS.some((k) => wantsPush(n, k, repo)) })
  if (!askers.length) return out
  const keys = await d.keys()
  if (!keys) {
    d.log({ warning: 'push: devices are subscribed but the push keys could not be read', repo })
    return out
  }
  const projects = new S3Backend(d.bucket, PROJECTS_PREFIX, d.s3)
  const scratch = d.scratch ? { scratch: d.scratch } : {}
  const [record, facts] = await Promise.all([
    new JourneyStore(projects, repo, scratch).read((db) => loadJourney(db)).then((r) => r.result),
    new BucketDb(projects, repo, { folder: AGENT_FACTS_FOLDER, file: AGENT_FACTS_DB, schema: applyAgentFactsSchema }, scratch).read((db) => loadAgentFacts(db)).then((r) => r.result).catch(() => null),
  ])
  if (!record) return out
  const at = d.now()
  const nowS = Math.floor(at / 1000)
  out.people = askers.length
  for (const p of askers) {
    const prefs = notifyPrefs(p.prefs)
    const viewer: Viewer = { hash: personHash(p.sub), also: p.email ? [personHash(p.email)] : [], label: p.email ?? p.sub, admin: p.admin, part: p.part, sub: p.sub }
    const items = inboxItems(repo, record, viewer, nowS, facts)
      .filter((i): i is InboxItem & { kind: NotifyKind } => (NOTIFY_KINDS as readonly string[]).includes(i.kind) && wantsPush(prefs, i.kind as NotifyKind, repo))
    if (!items.length) continue
    const mine = devices.filter((x) => x.sub === p.sub).sort((a, b) => b.created - a.created)
    const live: Device[] = []
    for (const x of mine) if (!(await d.ledger.held(endpointKey(x.endpoint), nowS))) live.push(x)
    const awake = live.filter((x) => !isQuiet(prefs.quiet, at, x.tz))
    for (const item of items) {
      out.items++
      if (!awake.length) { if (live.length) out.quiet++; continue }
      const key = `sent#${p.sub}#${repo}#${item.id}`
      if (!(await d.ledger.claim(key, SENT_TTL_S, nowS))) continue
      const msg = messageFor(item)
      const results: PushResult[] = []
      for (const x of awake) {
        const r = await sendPush(x, msg, keys, { now: d.now, fetch: d.fetch, urgency: item.blocking ? 'high' : 'normal', ttl: 86_400, topic: createHash('sha256').update(msg.tag).digest('base64url').slice(0, 32) })
        results.push(r)
        if (r.ok) continue
        if (r.gone) { out.gone++; await d.ledger.claim(endpointKey(x.endpoint), DEAD_TTL_S, nowS) }
        else { out.failed++; d.log({ warning: 'push: a push service refused a message', repo, status: r.status, detail: r.detail, host: new URL(x.endpoint).host }) }
      }
      if (results.some((r) => r.ok)) out.sent++
      else if (results.some((r) => !r.ok && r.retry)) await d.ledger.release(key, nowS)
    }
  }
  return out
}

/** The push ledger in DynamoDB (`<prefix>-web-push`: key `k`, TTL on `ttl`), by its JSON API with SigV4, as the hooks' is. */
export class DynamoLedger implements Ledger {
  constructor(private readonly o: { table: string; region: string; credentials: () => Promise<Credentials>; fetch?: typeof fetch; endpoint?: string }) {}

  claim(key: string, ttlS: number, nowS: number): Promise<boolean> {
    return this.update(key, {
      UpdateExpression: 'SET #ttl = :ttl',
      ConditionExpression: 'attribute_not_exists(#ttl) OR #ttl < :now',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':ttl': { N: String(nowS + ttlS) }, ':now': { N: String(nowS) } },
    })
  }

  async release(key: string, nowS: number): Promise<void> {
    await this.update(key, {
      UpdateExpression: 'SET #ttl = :past',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':past': { N: String(nowS - 1) } },
    })
  }

  /** An update that only succeeds when the key is held: it changes nothing that matters (when it was last asked). */
  held(key: string, nowS: number): Promise<boolean> {
    return this.update(key, {
      UpdateExpression: 'SET #seen = :now',
      ConditionExpression: 'attribute_exists(#ttl) AND #ttl >= :now',
      ExpressionAttributeNames: { '#ttl': 'ttl', '#seen': 'seen' },
      ExpressionAttributeValues: { ':now': { N: String(nowS) } },
    })
  }

  /** One UpdateItem: true when it was made, false when its condition did not hold. Throws on anything else. */
  private async update(key: string, x: Record<string, unknown>): Promise<boolean> {
    const host = `dynamodb.${this.o.region}.amazonaws.com`
    const body = JSON.stringify({ TableName: this.o.table, Key: { k: { S: key } }, ...x })
    const headers = signV4({
      host, region: this.o.region, service: 'dynamodb', body,
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.UpdateItem' },
      creds: await this.o.credentials(),
    })
    const r = await (this.o.fetch ?? fetch)(this.o.endpoint ?? `https://${host}/`, { method: 'POST', headers, body, signal: AbortSignal.timeout(3_000) })
    if (r.ok) return true
    const json = (await r.json().catch(() => ({}))) as { __type?: string; message?: string }
    const type = json.__type?.split('#').at(-1) ?? `HTTP${r.status}`
    if (type === 'ConditionalCheckFailedException') return false
    throw new Error(`DynamoDB UpdateItem: ${type}${json.message ? `: ${json.message}` : ''}`)
  }
}

/** A ledger in memory (tests, and a local backend). */
export class MemoryLedger implements Ledger {
  readonly items = new Map<string, number>()
  async claim(key: string, ttlS: number, nowS: number): Promise<boolean> {
    const t = this.items.get(key)
    if (t !== undefined && t >= nowS) return false
    this.items.set(key, nowS + ttlS)
    return true
  }
  async release(key: string, nowS: number): Promise<void> { this.items.set(key, nowS - 1) }
  async held(key: string, nowS: number): Promise<boolean> { const t = this.items.get(key); return t !== undefined && t >= nowS }
}

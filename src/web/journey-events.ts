/**
 * Live updates when an agent records a fact or a job changes: the Lambda `<prefix>-journey-events`. Agents write their
 * facts beside the journey record (projects/<slug>/journey-agent/facts.db, src/core/agent-facts.ts), and a project's
 * worker writes its job index (projects/<slug>/job-index/jobs.db, src/core/job-index.ts), straight to the central
 * bucket, so nothing passes the web backend that would tell people's screens. The bucket sends its object events to
 * EventBridge; a rule (src/infra/web.ts JourneyEvents) sends this function the "Object Created" events of those
 * objects only.
 *
 *   job index  `job.updated { repo, jobId, state }` to every person on the project for each job the write changed
 *              (rows updated within NEW_WITHIN_S of the event; at most MAX_JOB_EVENTS, then one for the project),
 *              so Home's Running now, the project's "trace is doing" and Agents and tools refetch. The job id is the
 *              API's (src/core/job-index.ts indexedHandle); the state is a word; no title or step leaves
 *
 *   project   from the key: projects/<owner>/<repo>/journey-agent/facts.db → owner/repo (src/core/project.ts slugs)
 *   people    the project's admins and the people assigned to it, from the access store (access/central.db: users
 *             with class admin, as recorded when they last signed in, and assignments of this repo), read only
 *   publish   `record.changed { repo, what: 'journey' }` to each person's channel /trace/users/<sub> (AppSync Events,
 *             IAM), so Home, the inbox and the project refetch. And `notification { id, kind, repo, summary }` for a
 *             question or stuck report written in this change, to the people it is for (a question asked of one
 *             person: that person; of the admins: the admins; else the contributors and admins; a stuck report: the
 *             contributors and admins). The summary is a fixed line ("An agent asks a question."): no project content
 *             leaves in an event, as with every live event
 *
 * Telling a new question from a check needs the facts themselves: this reads the one object that changed, never any
 * other of the project. "New" is a row asked within NEW_WITHIN_S of the event: each write of the facts is a whole
 * database put a moment after its row is made, so an earlier row is older than that; a row near the edge may be
 * notified twice, which only makes the app refetch again.
 *
 *   push      after the live events, push notifications (src/web/push-sender.ts) for the project, to the people who
 *             turned them on: what is new in Next for them. The journey record's own writes (a gate signed, waived or
 *             made ready by a person) come here too, for push only: they publish no live event (see below)
 *
 *   run logs  the runs log group's subscription (src/infra/web.ts) sends each batch of a run's lines here:
 *             `log.appended { repo, kind, id, lines }` to everyone on the project, at most once a second per stream,
 *             never the lines themselves (onRunLogs)
 *
 * Writes by people (the journey record itself) are published by the web backend after the API answers
 * (src/web/call.ts), with the right `what` and to the caller at once, so they are not matched here: two routes would
 * send every answer's event twice. One event is published per S3 event, unbatched: an agent writes its facts a few
 * times a job, not in floods.
 */
import type { DatabaseSync } from 'node:sqlite'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { Central, S3Backend, type S3Api } from '../core/central.js'
import { AGENT_FACTS_DB, AGENT_FACTS_FOLDER, applyAgentFactsSchema } from '../core/agent-facts.js'
import { BucketDb, JOURNEY_DB, JOURNEY_FOLDER } from '../core/journey-store.js'
import { BENCH_DB } from '../core/bench.js'
import { JOB_INDEX_DB, JOB_INDEX_FOLDER, JobIndexStore, changedSince } from '../core/job-index.js'
import { PROJECTS_PREFIX } from '../core/project.js'
import { parseStream } from '../core/run-logs.js'
import { type LiveEvent, type Publisher, appsyncPublisher, userChannel } from './events.js'
import { DynamoLedger, type PushDeps, type PushOutcome, pushForProject } from './push-sender.js'
import { type VapidKeys, validVapid } from './web-push.js'

/** A row asked this close to the event is taken as written by it. */
export const NEW_WITHIN_S = 120

/** The EventBridge event of an S3 object created (only the fields read here). */
export interface S3ObjectEvent { 'detail-type'?: string; time?: string; detail?: { bucket?: { name?: string }; object?: { key?: string } } }

const FACTS_KEY = new RegExp(`^${PROJECTS_PREFIX}/([A-Za-z0-9-]+/[A-Za-z0-9._-]+)/${AGENT_FACTS_FOLDER}/(${AGENT_FACTS_DB.replace('.', '\\.')}|${BENCH_DB.replace('.', '\\.')})$`)
const JOURNEY_KEY = new RegExp(`^${PROJECTS_PREFIX}/([A-Za-z0-9-]+/[A-Za-z0-9._-]+)/${JOURNEY_FOLDER}/${JOURNEY_DB.replace('.', '\\.')}$`)
const INDEX_KEY = new RegExp(`^${PROJECTS_PREFIX}/([A-Za-z0-9-]+/[A-Za-z0-9._-]+)/${JOB_INDEX_FOLDER}/${JOB_INDEX_DB.replace('.', '\\.')}$`)
/** The most job.updated events one write sends each person (more: one for the project, with no job). */
export const MAX_JOB_EVENTS = 10

/** The project (owner/repo, lower case) whose facts the key is, or null for any other key. */
export function projectOfKey(key: string): string | null {
  const m = FACTS_KEY.exec(key)
  if (!m?.[1] || m[1].includes('..')) return null
  return m[1].toLowerCase()
}

/** The project whose journey record the key is, or null for any other key (push only: see the file's comment). */
export function projectOfJourneyKey(key: string): string | null {
  const m = JOURNEY_KEY.exec(key)
  if (!m?.[1] || m[1].includes('..')) return null
  return m[1].toLowerCase()
}

/** Whether the key is the bench's live copy (src/core/bench.ts): a reading was taken. Never read here. */
export const isBenchKey = (key: string): boolean => key.endsWith(`/${AGENT_FACTS_FOLDER}/${BENCH_DB}`)
/** The project whose job index the key is, or null for any other key. */
export function projectOfIndexKey(key: string): string | null {
  const m = INDEX_KEY.exec(key)
  if (!m?.[1] || m[1].includes('..')) return null
  return m[1].toLowerCase()
}

export interface Audience { admins: string[]; contributors: string[]; reviewers: string[] }

const has = (db: DatabaseSync, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))

/** The people on `repo`, by part (admins apart), from the access store. A guest is always a reviewer. */
export function audienceOf(db: DatabaseSync, repo: string): Audience {
  const admins = has(db, 'users') ? (db.prepare("SELECT sub FROM users WHERE class='admin'").all() as { sub: string }[]).map((r) => String(r.sub)) : []
  const adminSet = new Set(admins)
  const contributors: string[] = []
  const reviewers: string[] = []
  if (has(db, 'assignments')) {
    const cols = (db.prepare("SELECT name FROM pragma_table_info('assignments')").all() as { name: string }[]).map((c) => c.name)
    const part = cols.includes('part') ? 'a.part' : 'NULL'
    const rows = db.prepare(`SELECT a.sub, ${part} AS part, u.class FROM assignments a LEFT JOIN users u ON u.sub = a.sub WHERE a.repo=?`).all(repo) as { sub: string; part: unknown; class: unknown }[]
    for (const r of rows) {
      if (adminSet.has(r.sub)) continue
      const reviewer = r.class === 'guest' || r.part === 'reviewer'
      ;(reviewer ? reviewers : contributors).push(String(r.sub))
    }
  }
  return { admins, contributors, reviewers }
}

export interface NewFact { id: string; kind: 'question' | 'stuck'; askedOfSub: string | null; askedPart: 'contributors' | 'admins' }

/** Questions and stuck reports asked within NEW_WITHIN_S of `at` (seconds since the epoch). */
export function newFacts(db: DatabaseSync, at: number): NewFact[] {
  const since = at - NEW_WITHIN_S
  const q = (db.prepare('SELECT id, asked_of_sub, asked_part FROM agent_questions WHERE asked_at >= ?').all(since) as Record<string, unknown>[]).map((r): NewFact => ({
    id: String(r.id), kind: 'question', askedOfSub: r.asked_of_sub === null || r.asked_of_sub === undefined ? null : String(r.asked_of_sub), askedPart: r.asked_part === 'admins' ? 'admins' : 'contributors',
  }))
  const s = (db.prepare('SELECT id FROM stuck WHERE at >= ? AND resolved_at IS NULL').all(since) as Record<string, unknown>[]).map((r): NewFact => ({ id: String(r.id), kind: 'stuck', askedOfSub: null, askedPart: 'contributors' }))
  return [...q, ...s]
}

/** Who a new fact is for (inbox rules, src/core/journey.ts questionFor). */
export function recipients(f: NewFact, a: Audience): string[] {
  if (f.askedOfSub) return [f.askedOfSub]
  if (f.askedPart === 'admins') return a.admins
  return [...a.admins, ...a.contributors]
}

const SUMMARY: Record<NewFact['kind'], string> = { question: 'An agent asks a question.', stuck: 'An agent is stuck.' }

export interface JourneyEventsDeps {
  /** the central bucket (the event's bucket must be it) */
  bucket: string
  s3?: S3Api | undefined
  publisher: Publisher
  now: () => number
  log: (entry: Record<string, unknown>) => void
  /** where temporary copies go */
  scratch?: string | undefined
  /** push notifications; absent: none are sent (an installation without push set up) */
  push?: Pick<PushDeps, 'ledger' | 'keys' | 'fetch'> | undefined
}

/** Push for the project, never failing the live events: a failure is logged. */
async function pushFor(repo: string, d: JourneyEventsDeps): Promise<PushOutcome | null> {
  if (!d.push) return null
  try {
    const out = await pushForProject(repo, { ...d.push, bucket: d.bucket, s3: d.s3, now: d.now, log: d.log, scratch: d.scratch })
    if (out.sent || out.gone || out.failed) d.log({ event: 'push', ...out })
    return out
  } catch (e) {
    d.log({ warning: 'push: could not send for the project', repo, error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

/** A write of a project's job index: job.updated to everyone on the project, for each job it changed. */
async function onJobIndex(repo: string, e: S3ObjectEvent, d: JourneyEventsDeps): Promise<{ repo: string; changed: number; notified: number; jobs: number }> {
  const projects = new S3Backend(d.bucket, PROJECTS_PREFIX, d.s3)
  const access = new Central({ home: `s3://${d.bucket}/access`, ...(d.s3 ? { s3: d.s3 } : {}) })
  const index = new JobIndexStore(projects, repo, d.scratch ? { scratch: d.scratch } : {})
  const at = e.time ? Date.parse(e.time) / 1000 : d.now() / 1000
  const [audience, changed] = await Promise.all([access.query((db) => audienceOf(db, repo)), index.read((db) => changedSince(db, repo, at - NEW_WITHIN_S)).then((r) => r.result)])
  const everyone = [...new Set([...audience.admins, ...audience.contributors, ...audience.reviewers])]
  const stamp = new Date(d.now()).toISOString()
  // the newest change of each job, and at most MAX_JOB_EVENTS of them (more: the project's jobs as a whole)
  const latest = [...new Map(changed.map((c) => [c.jobId, c])).values()]
  const events: LiveEvent[] = latest.length > MAX_JOB_EVENTS
    ? [{ type: 'job.updated', repo, jobId: null, state: null, at: stamp }]
    : latest.map((c) => ({ type: 'job.updated', repo, jobId: c.jobId, state: c.state, at: stamp }))
  if (!events.length) return { repo, changed: 0, notified: 0, jobs: 0 }
  const results = await Promise.allSettled(everyone.map((sub) => d.publisher.publish(userChannel(sub), events)))
  const failed = results.filter((r) => r.status === 'rejected').length
  if (failed) d.log({ warning: 'journey-events: some job events were not delivered', repo, failed, of: everyone.length })
  return { repo, changed: everyone.length, notified: 0, jobs: events.length }
}

/** One S3 event: what was published, to how many people (tests read it). */
export async function onObjectCreated(e: S3ObjectEvent, d: JourneyEventsDeps): Promise<{ repo: string | null; changed: number; notified: number; jobs?: number; pushed?: number }> {
  const key = e.detail?.object?.key ?? ''
  const ours = e.detail?.bucket?.name === d.bucket
  const indexed = ours ? projectOfIndexKey(key) : null
  if (indexed) return onJobIndex(indexed, e, d)
  // a person's write of the journey record: its live events are the web backend's; here, push only
  const journal = ours ? projectOfJourneyKey(key) : null
  if (journal) {
    const p = await pushFor(journal, d)
    return { repo: journal, changed: 0, notified: 0, pushed: p?.sent ?? 0 }
  }
  const repo = ours ? projectOfKey(key) : null
  if (!repo) {
    d.log({ warning: 'journey-events: not an agents\' facts or job index object of this installation', key })
    return { repo: null, changed: 0, notified: 0 }
  }
  const projects = new S3Backend(d.bucket, PROJECTS_PREFIX, d.s3)
  const access = new Central({ home: `s3://${d.bucket}/access`, ...(d.s3 ? { s3: d.s3 } : {}) })
  const facts = new BucketDb(projects, repo, { folder: AGENT_FACTS_FOLDER, file: AGENT_FACTS_DB, schema: applyAgentFactsSchema }, d.scratch ? { scratch: d.scratch } : {})
  const at = e.time ? Date.parse(e.time) / 1000 : d.now() / 1000
  // a bench reading tells the screens to refetch, and notifies no one: nothing in it is read here
  const [audience, fresh] = await Promise.all([access.query((db) => audienceOf(db, repo)), isBenchKey(key) ? Promise.resolve([] as NewFact[]) : facts.read((db) => newFacts(db, at)).then((r) => r.result)])
  const everyone = [...new Set([...audience.admins, ...audience.contributors, ...audience.reviewers])]
  const stamp = new Date(d.now()).toISOString()
  const per = new Map<string, LiveEvent[]>()
  const add = (sub: string, ev: LiveEvent): void => { per.set(sub, [...(per.get(sub) ?? []), ev]) }
  for (const sub of everyone) add(sub, { type: 'record.changed', repo, what: 'journey', at: stamp })
  let notified = 0
  for (const f of fresh) {
    for (const sub of new Set(recipients(f, audience))) {
      add(sub, { type: 'notification', id: `${f.kind}:${f.id}`, kind: f.kind, repo, summary: SUMMARY[f.kind], at: stamp })
      notified++
    }
  }
  const results = await Promise.allSettled([...per].map(([sub, evs]) => d.publisher.publish(userChannel(sub), evs)))
  const failed = results.filter((r) => r.status === 'rejected').length
  if (failed) d.log({ warning: 'journey-events: some events were not delivered', repo, failed, of: per.size })
  // a bench reading changes nothing in Next: no push
  const p = isBenchKey(key) ? null : await pushFor(repo, d)
  return { repo, changed: everyone.length, notified, ...(p ? { pushed: p.sent } : {}) }
}

// ------------------------------------------------------------------ run logs (docs/progress-and-logs.md, decision C)

/** CloudWatch Logs' subscription delivery: base64 of a gzipped batch of one stream's events. */
export interface AwsLogsEvent { awslogs?: { data?: string } }
interface LogsBatch { messageType?: string; logGroup?: string; logStream?: string; logEvents?: { id?: string; timestamp?: number; message?: string }[] }

/** How long the people on a project are kept between batches: a running job sends one a second or so. */
export const AUDIENCE_FOR_MS = 60_000
/** The least time between two log.appended events for one stream (a chatty run is told once a second). */
export const LOG_EVENT_EVERY_MS = 1_000

const audiences = new Map<string, { subs: string[]; at: number }>()
const lastLogEvent = new Map<string, number>()

/** Decode a subscription delivery (null: not one). */
export async function decodeLogs(e: AwsLogsEvent): Promise<LogsBatch | null> {
  const data = e.awslogs?.data
  if (!data) return null
  const { gunzipSync } = await import('node:zlib')
  try {
    return JSON.parse(gunzipSync(Buffer.from(data, 'base64')).toString('utf8')) as LogsBatch
  } catch {
    return null
  }
}

/**
 * A batch of lines in the runs log group: `log.appended { repo, kind, id, lines }` to everyone on the project, no text.
 * A check's id is "<run id>/<attempt>/<job key>". Streams trace did not name, and the group's control messages, send
 * nothing.
 */
export async function onRunLogs(batch: LogsBatch, d: Pick<JourneyEventsDeps, 'bucket' | 's3' | 'publisher' | 'now' | 'log'> & { sleep?: (ms: number) => Promise<void> }): Promise<{ repo: string | null; sent: number }> {
  if (batch.messageType !== 'DATA_MESSAGE') return { repo: null, sent: 0 }
  const p = parseStream(batch.logStream ?? '')
  const lines = batch.logEvents?.length ?? 0
  if (!p || !lines) return { repo: null, sent: 0 }
  const repo = p.repo
  const cachedAudience = audiences.get(repo.toLowerCase())
  let subs: string[]
  if (cachedAudience && d.now() - cachedAudience.at < AUDIENCE_FOR_MS) subs = cachedAudience.subs
  else {
    const access = new Central({ home: `s3://${d.bucket}/access`, ...(d.s3 ? { s3: d.s3 } : {}) })
    const a = await access.query((db) => audienceOf(db, repo))
    subs = [...new Set([...a.admins, ...a.contributors, ...a.reviewers])]
    audiences.set(repo.toLowerCase(), { subs, at: d.now() })
  }
  if (!subs.length) return { repo, sent: 0 }
  const stream = batch.logStream ?? ''
  const since = d.now() - (lastLogEvent.get(stream) ?? 0)
  if (since < LOG_EVENT_EVERY_MS) await (d.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms) })))(LOG_EVENT_EVERY_MS - since)
  lastLogEvent.set(stream, d.now())
  if (lastLogEvent.size > 2000) lastLogEvent.clear()
  const id = p.kind === 'check' ? `${p.runId}/${p.attempt}/${p.job}` : p.id
  const ev: LiveEvent = { type: 'log.appended', repo, kind: p.kind, id, lines, at: new Date(d.now()).toISOString() }
  const results = await Promise.allSettled(subs.map((sub) => d.publisher.publish(userChannel(sub), [ev])))
  const failed = results.filter((r) => r.status === 'rejected').length
  if (failed) d.log({ warning: 'journey-events: some log events were not delivered', repo, failed, of: subs.length })
  return { repo, sent: subs.length - failed }
}

let publisher: Publisher | null = null

/** The Lambda handler (bundled beside the backend as journey-events.mjs): the bucket's object events, and the runs log
 * group's subscription deliveries. */
export async function handler(e: S3ObjectEvent & AwsLogsEvent): Promise<void> {
  const bucket = process.env.TRACE_CENTRAL_BUCKET
  const http = process.env.TRACE_EVENTS_HTTP
  const region = process.env.AWS_REGION
  if (!bucket || !http || !region) throw new Error('TRACE_CENTRAL_BUCKET, TRACE_EVENTS_HTTP and AWS_REGION are needed')
  publisher ??= appsyncPublisher({ region, events: { http } }, fromNodeProviderChain(), fetch)
  const log = (entry: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify(entry)}\n`) }
  if (e.awslogs) {
    const batch = await decodeLogs(e)
    const out = batch ? await onRunLogs(batch, { bucket, publisher, now: Date.now, log }) : { repo: null, sent: 0 }
    // the run's own lines are not logged here: they are in the runs group already
    if (out.repo) log({ event: 'run-logs', ...out })
    return
  }
  const out = await onObjectCreated(e, { bucket, publisher, now: Date.now, log, scratch: '/tmp', push: pushDeps(region, log) })
  log({ event: 'journey-events', ...out })
}

let vapid: { keys: VapidKeys | null; at: number } | null = null
/** How long the push keys are kept in memory before they are read again (a rotation shows within this). */
const KEYS_FOR_MS = 15 * 60_000

/** Push, from the environment: TRACE_PUSH_TABLE (the ledger) and TRACE_PUSH_SECRET (the keys' secret name). */
function pushDeps(region: string, log: (e: Record<string, unknown>) => void): JourneyEventsDeps['push'] {
  const table = process.env.TRACE_PUSH_TABLE
  const secret = process.env.TRACE_PUSH_SECRET
  if (!table || !secret) return undefined
  const creds = fromNodeProviderChain()
  return {
    ledger: new DynamoLedger({ table, region, credentials: async () => creds() }),
    fetch,
    keys: async () => {
      if (vapid && Date.now() - vapid.at < KEYS_FOR_MS) return vapid.keys
      const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager')
      try {
        const r = await new SecretsManagerClient({ region }).send(new GetSecretValueCommand({ SecretId: secret }))
        const parsed: unknown = JSON.parse(r.SecretString ?? 'null')
        vapid = { keys: validVapid(parsed) ? parsed : null, at: Date.now() }
        if (!vapid.keys) log({ warning: 'push: the push keys secret is not a whole key pair', secret })
      } catch (e) {
        log({ warning: 'push: could not read the push keys', secret, error: e instanceof Error ? e.message : String(e) })
        vapid = { keys: null, at: Date.now() }
      }
      return vapid.keys
    },
  }
}

/**
 * `trace kb sync`: put the knowledge base's documents (content.ts) into S3 under projects/<slug>/kb/, changed ones
 * only, remove the ones that went away, then start an ingestion job and report how it went.
 *
 *   1. desired   every document, and its `.metadata.json` sidecar, each with a tracking hash: a document's is the
 *                sha256 of its bytes; a sidecar's covers its document and its attributes but not the commit, so a
 *                document synced once keeps the commit it was first synced from (sidecarHash)
 *   2. present   ListObjectsV2 of the prefix: each key with its ETag
 *   3. diff      unchanged when the project database's kb_objects row for the key has the same hash and the ETag S3
 *                lists; else, when the key is listed, HeadObject: unchanged when its x-amz-meta-trace-sha256 is the
 *                hash (a fresh checkout, such as the kb-sync workflow job, has no rows); else uploaded. Listed keys
 *                that are not desired are deleted (DeleteObjects).
 *   4. ingest    StartIngestionJob when anything changed, when the data source has never been ingested, when its
 *                last job failed or stopped or began before the newest upload kb_objects records, or with force; one already running (ConflictException) is waited for first. Then GetIngestionJob until it
 *                is COMPLETE, FAILED or STOPPED, or the wait runs out (the job carries on; `trace kb status` reports
 *                it). Its statistics and failure reasons are the report's. Both waits are timers, every pollMs
 *                (10 s), because Bedrock sends no event when an ingestion job ends: they are waitWithTimer's
 *                (core/wait.ts), so each is on the record (activeWaits, checkNow) and `progress` gets a plain line
 *                ("Waiting for … Checked just now; next check in 10 seconds.") whenever the job's state changes.
 *
 * kb_objects (the project database, registered with ensureProjectSchema) keeps one row per object: key, the repository
 * path it is for, its tracking hash, its ETag and when it was uploaded. `trace db merge` keeps, per key, the row
 * uploaded last. It only saves HeadObject calls: S3 is what decides.
 *
 * Every call is observed as the span `trace.kb.sync` with counts and durations only, never paths or text.
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  ConflictException, GetIngestionJobCommand, type IngestionJob, ListIngestionJobsCommand, type ListIngestionJobsCommandOutput,
  StartIngestionJobCommand, type GetIngestionJobCommandOutput, type StartIngestionJobCommandOutput,
} from '@aws-sdk/client-bedrock-agent'
import { ensureProjectSchema } from '../../core/store.js'
import { ATTR, setAttrs, span } from '../../core/telemetry.js'
import { type WaitNotice, describeWait, waitWithTimer } from '../../core/wait.js'
import { type KbDoc, SIDECAR, sha256, sidecar, sidecarHash } from './content.js'
import type { KbS3 } from './env.js'

ensureProjectSchema({
  table: 'kb_objects',
  sql: `
CREATE TABLE IF NOT EXISTS kb_objects (
  s3_key TEXT PRIMARY KEY,        -- the object's full key: projects/<slug>/kb/…
  path TEXT NOT NULL,             -- the repository path it is for (datasheets/<part> for a datasheet page)
  hash TEXT NOT NULL,             -- its tracking hash (sync.ts): the sha256 of a document, of a sidecar's attributes
  etag TEXT,                      -- the ETag S3 gave it
  uploaded_at REAL NOT NULL
);`,
  merge: `INSERT INTO kb_objects SELECT * FROM theirs.kb_objects WHERE true
  ON CONFLICT(s3_key) DO UPDATE SET path=excluded.path, hash=excluded.hash, etag=excluded.etag, uploaded_at=excluded.uploaded_at
  WHERE excluded.uploaded_at > kb_objects.uploaded_at`,
})

/** One S3 object the knowledge base should hold. */
export interface Wanted { key: string; path: string; hash: string; body: Uint8Array; contentType: string }

/** Documents and their sidecars, with full keys under `prefix` and tracking hashes. */
export function wanted(docs: readonly KbDoc[], prefix: string, commit: string): Wanted[] {
  const out: Wanted[] = []
  for (const d of docs) {
    const h = sha256(d.body)
    const key = `${prefix}/${d.key}`
    out.push({ key, path: d.meta.path, hash: h, body: d.body, contentType: d.contentType })
    out.push({ key: `${key}${SIDECAR}`, path: d.meta.path, hash: sidecarHash(h, d.meta), body: sidecar(d.meta, commit), contentType: 'application/json' })
  }
  return out
}

export interface Row { s3_key: string; path: string; hash: string; etag: string | null; uploaded_at: number }

export interface Plan { upload: Wanted[]; unchanged: Wanted[]; remove: string[]; headed: number }

/** What to upload, keep and delete (step 3 above). `head` is called only for listed keys without a matching row. */
export async function plan(want: readonly Wanted[], listed: readonly { key: string; etag: string }[], rows: ReadonlyMap<string, Row>,
  head: (key: string) => Promise<{ etag: string; sha256: string | null }>): Promise<Plan> {
  const present = new Map(listed.map((o) => [o.key, o.etag]))
  const upload: Wanted[] = []
  const unchanged: Wanted[] = []
  let headed = 0
  for (const w of want) {
    const etag = present.get(w.key)
    if (etag === undefined) { upload.push(w); continue }
    const row = rows.get(w.key)
    if (row && row.hash === w.hash && row.etag === etag) { unchanged.push(w); continue }
    headed++
    const h = await head(w.key)
    if (h.sha256 === w.hash) unchanged.push(w)
    else upload.push(w)
  }
  const keep = new Set(want.map((w) => w.key))
  const remove = listed.map((o) => o.key).filter((k) => !keep.has(k)).sort()
  return { upload, unchanged, remove, headed }
}

// ------------------------------------------------------------------ ingestion

export type IngestClient = {
  send(c: StartIngestionJobCommand): Promise<StartIngestionJobCommandOutput>
  send(c: GetIngestionJobCommand): Promise<GetIngestionJobCommandOutput>
  send(c: ListIngestionJobsCommand): Promise<ListIngestionJobsCommandOutput>
}

export async function awsIngest(region?: string): Promise<IngestClient> {
  const { BedrockAgentClient } = await import('@aws-sdk/client-bedrock-agent')
  return new BedrockAgentClient(region ? { region } : {})
}

export interface IngestionView {
  job_id: string
  status: string
  started_at: string | null
  updated_at: string | null
  statistics: Record<string, number>
  failure_reasons: string[]
}

export const viewOf = (j: IngestionJob | undefined): IngestionView | null => (j?.ingestionJobId
  ? {
      job_id: j.ingestionJobId, status: j.status ?? 'UNKNOWN', started_at: j.startedAt?.toISOString() ?? null, updated_at: j.updatedAt?.toISOString() ?? null,
      statistics: Object.fromEntries(Object.entries(j.statistics ?? {}).filter(([, v]) => typeof v === 'number')) as Record<string, number>,
      failure_reasons: (j.failureReasons ?? []).slice(0, 10).map((r) => r.slice(0, 500)),
    }
  : null)

const RUNNING = new Set(['STARTING', 'IN_PROGRESS', 'STOPPING'])

/** Why the ingestion waits are timers. */
export const WHY_TIMER = 'Bedrock sends no event when an ingestion job finishes'

/** A wait's report as progress lines: one on the first check and one each time the awaited state changes. */
const progressOf = (line: ((l: string) => void) | undefined, now: () => number): ((n: WaitNotice) => void) | undefined => {
  if (!line) return undefined
  let seen: string | null | undefined
  return (n) => {
    if (n.checks > 1 && n.state === seen) return
    seen = n.state
    line(describeWait(n, now()))
  }
}

/** The data source's newest ingestion job, or null when it has none. */
export async function lastIngestion(c: IngestClient, kb: string, ds: string): Promise<IngestionView | null> {
  const r = await c.send(new ListIngestionJobsCommand({ knowledgeBaseId: kb, dataSourceId: ds, sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' }, maxResults: 1 }))
  const s = r.ingestionJobSummaries?.[0]
  if (!s?.ingestionJobId) return null
  return { job_id: s.ingestionJobId, status: s.status ?? 'UNKNOWN', started_at: s.startedAt?.toISOString() ?? null, updated_at: s.updatedAt?.toISOString() ?? null,
    statistics: Object.fromEntries(Object.entries(s.statistics ?? {}).filter(([, v]) => typeof v === 'number')) as Record<string, number>, failure_reasons: [] }
}

// ------------------------------------------------------------------ the sync

export interface SyncTarget { bucket: string; prefix: string; knowledgeBaseId: string; dataSourceId: string }

export interface SyncDeps {
  s3: KbS3
  ingest: IngestClient
  /** the project database (kb_objects), or null to keep no rows */
  db: DatabaseSync | null
  now?: () => number
  /** tests: the timer waits' sleep (waitWithTimer's; a check now does not cut it short) */
  sleep?: (ms: number) => Promise<void>
}

export interface SyncOptions {
  commit: string
  /** start an ingestion job even when nothing changed */
  force?: boolean
  /** how long to wait for the ingestion job (0: start it and return) */
  waitMs?: number
  /** how often to check on the ingestion job: Bedrock sends no event when one finishes (default 10 s) */
  pollMs?: number
  /** a line a person reads each time a wait's state changes: what is awaited, when it was checked, when it is next */
  progress?: (line: string) => void
  /** work out what would change, and change nothing */
  dryRun?: boolean
}

export interface SyncReport {
  documents: number
  objects: number
  uploaded: number
  unchanged: number
  deleted: number
  /** why ingestion was (not) started */
  ingest: 'changed' | 'first' | 'retry' | 'forced' | 'nothing changed' | 'dry run'
  ingestion: IngestionView | null
  /** the wait ran out with the job still running */
  waiting: boolean
}

const readRows = (db: DatabaseSync | null, prefix: string): Map<string, Row> => new Map((db
  ? db.prepare('SELECT s3_key, path, hash, etag, uploaded_at FROM kb_objects WHERE s3_key LIKE ?').all(`${prefix}/%`).map((r) => ({
      s3_key: String(r.s3_key), path: String(r.path), hash: String(r.hash), etag: r.etag === null ? null : String(r.etag), uploaded_at: Number(r.uploaded_at),
    }))
  : []).map((r) => [r.s3_key, r]))

/** Run `fn` on each item, at most `n` at a time. */
async function pool<T>(items: readonly T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++] as T) }))
}

export async function syncKb(t: SyncTarget, docs: readonly KbDoc[], d: SyncDeps, o: SyncOptions): Promise<SyncReport> {
  const now = d.now ?? Date.now
  return span('trace.kb.sync', { [ATTR.kbDocuments]: docs.length }, async (s) => {
    const started = now()
    const want = wanted(docs, t.prefix, o.commit)
    const listed = await d.s3.list(t.bucket, `${t.prefix}/`)
    const rows = readRows(d.db, t.prefix)
    const p = await plan(want, listed, rows, (key) => d.s3.head(t.bucket, key))
    const report: SyncReport = {
      documents: docs.length, objects: want.length, uploaded: p.upload.length, unchanged: p.unchanged.length, deleted: p.remove.length,
      ingest: 'dry run', ingestion: null, waiting: false,
    }
    setAttrs(s, { [ATTR.kbObjects]: want.length, [ATTR.kbUploaded]: p.upload.length, [ATTR.kbUnchanged]: p.unchanged.length, [ATTR.kbDeleted]: p.remove.length, [ATTR.kbHeaded]: p.headed })
    if (o.dryRun) return report

    // uploads first, then deletions; the ingestion job starts only after both
    const uploaded: { w: Wanted; etag: string }[] = []
    await pool(p.upload, 8, async (w) => { uploaded.push({ w, etag: (await d.s3.put(t.bucket, w.key, w.body, w.contentType, w.hash)).etag }) })
    if (p.remove.length) await d.s3.remove(t.bucket, p.remove)
    if (d.db) {
      const at = now() / 1000
      const up = d.db.prepare('INSERT OR REPLACE INTO kb_objects (s3_key, path, hash, etag, uploaded_at) VALUES (?,?,?,?,?)')
      for (const { w, etag } of uploaded) up.run(w.key, w.path, w.hash, etag, at)
      // keys found unchanged by HeadObject: recorded, so the next sync needs no HeadObject for them
      const listedEtag = new Map(listed.map((x) => [x.key, x.etag]))
      for (const w of p.unchanged) if (rows.get(w.key)?.hash !== w.hash) up.run(w.key, w.path, w.hash, listedEtag.get(w.key) ?? null, at)
      const del = d.db.prepare('DELETE FROM kb_objects WHERE s3_key=?')
      for (const k of p.remove) del.run(k)
      const keys = new Set(want.map((w) => w.key))
      for (const k of rows.keys()) if (!keys.has(k)) del.run(k)
    }

    const changed = p.upload.length + p.remove.length > 0
    let last = await lastIngestion(d.ingest, t.knowledgeBaseId, t.dataSourceId)
    // nothing to upload, but the last job failed, was stopped, or started before the newest upload this database saw
    // (an earlier sync that uploaded and then never ingested): ingest again
    const newest = Math.max(0, ...[...rows.values()].map((r) => r.uploaded_at))
    const stale = last !== null && (['FAILED', 'STOPPED'].includes(last.status) || (last.started_at !== null && newest * 1000 > Date.parse(last.started_at)))
    report.ingest = o.force ? 'forced' : changed ? 'changed' : !last ? 'first' : stale ? 'retry' : 'nothing changed'
    if (report.ingest === 'nothing changed') {
      report.ingestion = last
      setAttrs(s, { [ATTR.kbIngestion]: 'skipped', [ATTR.durationMs]: now() - started })
      return report
    }
    const waitMs = o.waitMs ?? 15 * 60_000
    const pollMs = o.pollMs ?? 10_000
    const deadline = now() + Math.max(waitMs, 0)
    // both waits are timers: Bedrock sends no event when an ingestion job finishes (waitWithTimer, core/wait.ts)
    const sleep = d.sleep
    const timer = {
      why: WHY_TIMER, intervalMs: Math.max(pollMs, 1), deadlineAt: deadline, now,
      ...(sleep ? { sleep: (ms: number) => sleep(ms) } : {}),
      report: progressOf(o.progress, now),
    }
    // one job at a time per data source: a running one started before these uploads may miss them, so wait for it
    const start = await waitWithTimer<IngestionJob | undefined>({
      ...timer,
      what: 'the knowledge base\'s other ingestion job to finish before this one can start',
      check: async () => {
        try {
          const job = (await d.ingest.send(new StartIngestionJobCommand({
            knowledgeBaseId: t.knowledgeBaseId, dataSourceId: t.dataSourceId, description: `trace kb sync at ${o.commit.slice(0, 12)}`.slice(0, 200),
          }))).ingestionJob
          return { done: true, value: job }
        } catch (e) {
          if (!(e instanceof ConflictException || (e as { name?: string }).name === 'ConflictException')) throw e
          last = await lastIngestion(d.ingest, t.knowledgeBaseId, t.dataSourceId)
          return { done: false, state: last?.status ?? 'RUNNING' }
        }
      },
    })
    if (!start.done) { report.ingestion = last; report.waiting = true; setAttrs(s, { [ATTR.kbIngestion]: 'busy' }); return report }
    let view = viewOf(start.value)
    if (view && RUNNING.has(view.status)) {
      // the first check is the job StartIngestionJob returned; GetIngestionJob from the second on
      let first = true
      await waitWithTimer<null>({
        ...timer,
        what: `the knowledge base ingestion job ${view.job_id}`,
        check: async () => {
          if (!first && view) view = viewOf((await d.ingest.send(new GetIngestionJobCommand({ knowledgeBaseId: t.knowledgeBaseId, dataSourceId: t.dataSourceId, ingestionJobId: view.job_id }))).ingestionJob) ?? view
          first = false
          const st = view?.status ?? 'UNKNOWN'
          return RUNNING.has(st) ? { done: false, state: st } : { done: true, value: null, state: st }
        },
      })
    }
    report.ingestion = view
    report.waiting = Boolean(view && RUNNING.has(view.status))
    setAttrs(s, {
      [ATTR.kbIngestion]: view?.status ?? 'none', [ATTR.durationMs]: now() - started,
      [ATTR.kbIndexed]: (view?.statistics.numberOfNewDocumentsIndexed ?? 0) + (view?.statistics.numberOfModifiedDocumentsIndexed ?? 0),
      [ATTR.kbFailed]: view?.statistics.numberOfDocumentsFailed ?? 0,
    })
    return report
  })
}

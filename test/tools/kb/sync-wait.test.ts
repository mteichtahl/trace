/**
 * The knowledge base sync's two waits (another ingestion job holding the data source, then its own job) are declared
 * timer waits: on the record while they last, with why there is no event, the same 10 s default and the same deadline,
 * and a progress line each time the job's state changes.
 */
import { ConflictException, GetIngestionJobCommand, ListIngestionJobsCommand, StartIngestionJobCommand } from '@aws-sdk/client-bedrock-agent'
import { describe, expect, it } from 'vitest'
import { type WaitNotice, activeWaits } from '../../../src/core/wait.js'
import type { KbDoc } from '../../../src/tools/kb/content.js'
import type { KbS3 } from '../../../src/tools/kb/env.js'
import { type IngestClient, WHY_TIMER, syncKb } from '../../../src/tools/kb/sync.js'

class FakeS3 implements KbS3 {
  objects = new Map<string, string>()
  async list(_b: string, prefix: string) { return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, etag]) => ({ key, etag })) }
  async head(): Promise<{ etag: string; sha256: string | null }> { throw new Error('404') }
  async put(_b: string, key: string) { this.objects.set(key, '"e"'); return { etag: '"e"' } }
  async remove() { /* nothing */ }
}

/** `busy` refused starts, then a job that is STARTING, IN_PROGRESS for `running` GetIngestionJob calls, then COMPLETE. */
function ingest(o: { busy?: number; running?: number; forever?: boolean }) {
  let busy = o.busy ?? 0
  let gets = 0
  const seen: WaitNotice[][] = []
  const client = {
    send: async (c: unknown) => {
      seen.push(activeWaits())
      if (c instanceof StartIngestionJobCommand) {
        if (busy > 0) { busy--; throw new ConflictException({ message: 'busy', $metadata: {} }) }
        return { ingestionJob: { ingestionJobId: 'job1', status: 'STARTING' } }
      }
      if (c instanceof GetIngestionJobCommand) {
        gets++
        const status = o.forever || gets <= (o.running ?? 0) ? 'IN_PROGRESS' : 'COMPLETE'
        return { ingestionJob: { ingestionJobId: 'job1', status, statistics: { numberOfDocumentsScanned: 1 } } }
      }
      if (c instanceof ListIngestionJobsCommand) return { ingestionJobSummaries: [{ ingestionJobId: 'other', status: 'IN_PROGRESS' }] }
      throw new Error('unexpected')
    },
  } as unknown as IngestClient
  return { client, seen, gets: () => gets }
}

const target = { bucket: 'b', prefix: 'projects/acme/board/kb', knowledgeBaseId: 'KB12345678', dataSourceId: 'DS12345678' }
const doc: KbDoc = { key: 'repo/a.md', body: new TextEncoder().encode('a'), contentType: 'text/markdown', meta: { source: 'repo', kind: 'markdown', path: 'a.md' } }

/** A clock that only moves when the sync sleeps. */
function clock(start = 1_700_000_000_000) {
  let t = start
  const slept: number[] = []
  return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms }, slept }
}

describe('the knowledge base sync waits on a declared timer', () => {
  it('records the wait (why, interval) while it lasts, says so on each state change, and leaves the record after', async () => {
    const c = clock()
    const ing = ingest({ busy: 2, running: 3 })
    const lines: string[] = []
    const r = await syncKb(target, [doc], { s3: new FakeS3(), ingest: ing.client, db: null, now: c.now, sleep: c.sleep }, { commit: 'c1', progress: (l) => lines.push(l) })
    expect(r).toMatchObject({ ingest: 'changed', waiting: false })
    expect(r.ingestion?.status).toBe('COMPLETE')
    // the default cadence is unchanged: 10 s
    expect(c.slept.every((ms) => ms === 10_000)).toBe(true)
    // while checking, each wait is on the record as a timer with its reason
    const during = ing.seen.flat()
    expect(during.length).toBeGreaterThan(0)
    expect(during.every((n) => n.source === 'timer' && n.why === WHY_TIMER && n.intervalMs === 10_000)).toBe(true)
    expect(new Set(during.map((n) => n.what))).toEqual(new Set([
      'the knowledge base\'s other ingestion job to finish before this one can start', 'the knowledge base ingestion job job1']))
    expect(activeWaits().some((n) => n.why === WHY_TIMER)).toBe(false)
    // progress: the busy wait once (its state does not change), then the job: starting, in progress, complete
    expect(lines[0]).toMatch(/^Waiting for the knowledge base's other ingestion job .* \(in progress\)\. Checked just now; next check in 10 seconds\.$/)
    expect(lines.filter((l) => l.includes('other ingestion job'))).toHaveLength(1)
    expect(lines.filter((l) => l.includes('job job1'))).toEqual([
      'Waiting for the knowledge base ingestion job job1 (starting). Checked just now; next check in 10 seconds.',
      'Waiting for the knowledge base ingestion job job1 (in progress). Checked just now; next check in 10 seconds.',
      'Waiting for the knowledge base ingestion job job1 (complete). Checked just now; no further check is planned.',
    ])
  })

  it('keeps the deadline: waitMs from the start of the ingestion step, the job carries on', async () => {
    const c = clock()
    const t0 = c.now()
    const ing = ingest({ forever: true })
    const r = await syncKb(target, [doc], { s3: new FakeS3(), ingest: ing.client, db: null, now: c.now, sleep: c.sleep }, { commit: 'c1', waitMs: 60_000, pollMs: 10_000 })
    expect(r.waiting).toBe(true)
    expect(r.ingestion?.status).toBe('IN_PROGRESS')
    expect(c.now() - t0).toBe(60_000)
    expect(ing.gets()).toBe(6)
    // busy past the deadline: the other job is reported, nothing started
    const c2 = clock()
    const t2 = c2.now()
    const busy = ingest({ busy: 1000 })
    const b = await syncKb(target, [doc], { s3: new FakeS3(), ingest: busy.client, db: null, now: c2.now, sleep: c2.sleep }, { commit: 'c1', waitMs: 30_000, pollMs: 10_000 })
    expect(b).toMatchObject({ waiting: true, ingestion: { job_id: 'other', status: 'IN_PROGRESS' } })
    expect(c2.now() - t2).toBe(30_000)
  })

  it('with no wait (waitMs 0) starts the job and returns at once', async () => {
    const c = clock()
    const ing = ingest({ forever: true })
    const r = await syncKb(target, [doc], { s3: new FakeS3(), ingest: ing.client, db: null, now: c.now, sleep: c.sleep }, { commit: 'c1', waitMs: 0 })
    expect(r).toMatchObject({ waiting: true, ingestion: { status: 'STARTING' } })
    expect(c.slept).toEqual([])
    expect(ing.gets()).toBe(0)
  })
})

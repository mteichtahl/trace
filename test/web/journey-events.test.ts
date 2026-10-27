/**
 * Live updates when an agent records a fact (src/web/journey-events.ts): the project from the key, the people on it
 * from the access store, `record.changed` to each, and `notification` for a new question or stuck report to the people
 * it is for, with no project content. S3 is in memory; the publisher records what it is given.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import '../../src/core/access.js'
import { AgentFactsStore, addAgentQuestion, addCriterionCheck, addStuck } from '../../src/core/agent-facts.js'
import { Central, S3Backend } from '../../src/core/central.js'
import { loadJourney, startJourney } from '../../src/core/journey.js'
import { JourneyStore, forgetNoJourney } from '../../src/core/journey-store.js'
import type { LiveEvent, Publisher } from '../../src/web/events.js'
import { MAX_JOB_EVENTS, NEW_WITHIN_S, onObjectCreated, projectOfIndexKey, projectOfKey } from '../../src/web/journey-events.js'
import { JobIndexStore, putJob } from '../../src/core/job-index.js'
import { projectHash } from '../../src/core/project.js'
import { FakeS3 } from '../core/fake-s3.js'

const BUCKET = 'central-bucket'
const KEY = 'projects/acme/board/journey-agent/facts.db'
const VERIFY = { agent: 'verify', label: 'the Verification specialist', jobId: 'job-1' }
const opts = [
  { id: 'a', label: '2.7 to 3.6 V', recommended: true, why: 'the sensor datasheet, page 4' },
  { id: 'b', label: '1.8 to 3.6 V', recommended: false, why: 'if a coin cell must run it' },
]
const scratch = mkdtempSync(join(tmpdir(), 'trace-journey-events-'))
const prevCache = process.env.XDG_CACHE_HOME
process.env.XDG_CACHE_HOME = scratch
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  if (prevCache === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = prevCache
})

class Recorder implements Publisher {
  sent: { channel: string; events: LiveEvent[] }[] = []
  fail = new Set<string>()
  async publish(channel: string, events: readonly LiveEvent[]): Promise<void> {
    if (this.fail.has(channel)) throw new Error('refused')
    this.sent.push({ channel, events: [...events] })
  }
  to(sub: string): LiveEvent[] { return this.sent.filter((x) => x.channel === `/trace/users/${sub}`).flatMap((x) => x.events) }
}

async function rig() {
  const s3 = new FakeS3()
  // who is on acme/board: an admin, a contributor, a reviewer, a guest (always a reviewer); and someone on another project
  await new Central({ home: `s3://${BUCKET}/access`, s3 }).update((db) => {
    const user = db.prepare('INSERT INTO users (sub, email, class, first_seen, last_seen) VALUES (?,?,?,0,0)')
    for (const [sub, cls] of [['admin-1', 'admin'], ['user-1', 'user'], ['user-2', 'user'], ['guest-1', 'guest'], ['other-1', 'user']] as const) user.run(sub, `${sub}@example.com`, cls)
    const assign = db.prepare("INSERT INTO assignments (sub, repo, assigned_by, assigned_at, part) VALUES (?,?,'admin',0,?)")
    assign.run('user-1', 'acme/board', 'contributor')
    assign.run('user-2', 'acme/board', 'reviewer')
    assign.run('guest-1', 'acme/board', 'contributor')
    assign.run('other-1', 'acme/other', 'contributor')
  })
  const projects = new S3Backend(BUCKET, 'projects', s3)
  const journey = new JourneyStore(projects, 'acme/board')
  await journey.update((db) => { startJourney(db, { template: 'board', by: 'admin-1@example.com', name: 'Soil sensor' }); return { result: null } })
  const record = (await journey.read((db) => loadJourney(db))).result
  const facts = new AgentFactsStore(projects, 'acme/board')
  const pub = new Recorder()
  const logs: Record<string, unknown>[] = []
  let t = Date.now()
  const event = (key = KEY, bucket = BUCKET) => ({ 'detail-type': 'Object Created', time: new Date(t).toISOString(), detail: { bucket: { name: bucket }, object: { key } } })
  const run = (e = event()) => onObjectCreated(e, { bucket: BUCKET, s3, publisher: pub, now: () => t, log: (x) => logs.push(x), scratch })
  return { s3, facts, record, pub, logs, event, run, later: (s: number) => { t += s * 1000 }, index: new JobIndexStore(projects, 'acme/board'), now: () => t }
}

describe('live updates when an agent records a fact', () => {
  beforeEach(() => forgetNoJourney())

  it('takes the project from the key, and only an agents\' facts object', () => {
    expect(projectOfKey('projects/Acme/Board/journey-agent/facts.db')).toBe('acme/board')
    expect(projectOfKey('projects/acme/board/journey/journey.db')).toBeNull()
    expect(projectOfKey('projects/acme/board/journey-agent/other.db')).toBeNull()
    expect(projectOfKey('projects/acme/../journey-agent/facts.db')).toBeNull()
    expect(projectOfKey('access/central.db')).toBeNull()
  })

  it('tells everyone on the project that the journey changed, and no one else', async () => {
    const r = await rig()
    await r.facts.update((db) => ({ result: addCriterionCheck(db, VERIFY, { criterion: 'architect.mapped', status: 'met', evidence: [{ kind: 'run', ref: 'run-a' }] }, r.record) }))
    expect(await r.run()).toEqual({ repo: 'acme/board', changed: 4, notified: 0 })
    expect(r.pub.sent.map((x) => x.channel).sort()).toEqual(['/trace/users/admin-1', '/trace/users/guest-1', '/trace/users/user-1', '/trace/users/user-2'])
    for (const x of r.pub.sent) expect(x.events).toEqual([{ type: 'record.changed', repo: 'acme/board', what: 'journey', at: expect.any(String) }])
  })

  it('notifies a new question to the people it is for, with no project content', async () => {
    const r = await rig()
    await r.facts.update((db) => ({ result: addAgentQuestion(db, VERIFY, { text: 'What is the supply range of the sensor?', blocks: 'sizing the regulator', options: opts }, r.record) }))
    const out = await r.run()
    // the contributors and the admins: not the reviewers (a guest is always one)
    expect(out.notified).toBe(2)
    for (const sub of ['admin-1', 'user-1']) expect(r.pub.to(sub).map((e) => e.type)).toEqual(['record.changed', 'notification'])
    for (const sub of ['user-2', 'guest-1']) expect(r.pub.to(sub).map((e) => e.type)).toEqual(['record.changed'])
    const n = r.pub.to('user-1')[1]
    expect(n).toEqual({ type: 'notification', id: expect.stringMatching(/^question:aq/), kind: 'question', repo: 'acme/board', summary: 'An agent asks a question.', at: expect.any(String) })
    expect(JSON.stringify(r.pub.sent)).not.toMatch(/supply|regulator|sensor/)
  })

  it('a question asked of one person or of the admins goes to them; a stuck report to the contributors and admins', async () => {
    const r = await rig()
    await r.facts.update((db) => ({ result: addAgentQuestion(db, VERIFY, { text: 'Is the coin cell the only source here?', options: opts, askedOfSub: 'user-2' }, r.record) }))
    await r.facts.update((db) => ({ result: addAgentQuestion(db, VERIFY, { text: 'May trace spend on a second board run?', options: opts, askedPart: 'admins' }, r.record) }))
    await r.facts.update((db) => ({ result: addStuck(db, VERIFY, { why: 'The simulator is not installed here.', recommendation: 'Run it on the GPU queue.' }, r.record) }))
    await r.run()
    const kinds = (sub: string): string[] => r.pub.to(sub).filter((e) => e.type === 'notification').map((e) => String(e.kind)).sort()
    expect(kinds('user-2')).toEqual(['question'])
    expect(kinds('admin-1')).toEqual(['question', 'stuck'])
    expect(kinds('user-1')).toEqual(['stuck'])
    expect(kinds('guest-1')).toEqual([])
  })

  it('does not notify again for an older question when a later write is a check', async () => {
    const r = await rig()
    await r.facts.update((db) => ({ result: addAgentQuestion(db, VERIFY, { text: 'What is the supply range of the sensor?', options: opts }, r.record) }))
    r.later(NEW_WITHIN_S + 60)
    await r.facts.update((db) => ({ result: addCriterionCheck(db, VERIFY, { criterion: 'architect.mapped', status: 'met', evidence: [{ kind: 'run', ref: 'run-a' }] }, r.record) }))
    // the check's row is "now" in the store's clock; the event is later: only rows near the event are new
    expect((await r.run()).notified).toBe(0)
  })

  it('ignores another bucket or key, and a failed publish does not stop the others', async () => {
    const r = await rig()
    expect(await r.run(r.event('projects/acme/board/journey/journey.db'))).toEqual({ repo: null, changed: 0, notified: 0 })
    expect(await r.run(r.event(KEY, 'someone-elses'))).toEqual({ repo: null, changed: 0, notified: 0 })
    expect(r.pub.sent).toEqual([])
    r.pub.fail.add('/trace/users/user-1')
    await r.facts.update((db) => ({ result: addStuck(db, VERIFY, { why: 'The simulator is not installed here.', recommendation: 'Run it on the GPU queue.' }, r.record) }))
    await r.run()
    expect(r.pub.sent.map((x) => x.channel).sort()).toEqual(['/trace/users/admin-1', '/trace/users/guest-1', '/trace/users/user-2'])
    expect(r.logs).toContainEqual(expect.objectContaining({ warning: expect.stringMatching(/not delivered/), failed: 1, of: 4 }))
  })
})

describe('live updates when a job changes', () => {
  const INDEX = 'projects/acme/board/journey-agent/jobs.db'
  const S = `trace-api-${projectHash('acme/board')}-${'a'.repeat(24)}`

  it('takes the project from the job index\'s key only', () => {
    expect(projectOfIndexKey(INDEX)).toBe('acme/board')
    expect(projectOfIndexKey(KEY)).toBeNull()
    expect(projectOfKey(INDEX)).toBeNull()
  })

  it('sends job.updated with the API\'s job id and its state to everyone on the project, and nothing of the job\'s content', async () => {
    const r = await rig()
    await r.index.update((db) => {
      putJob(db, 'job-1', { kind: 'task', title: 'Route the secret board', state: 'running', session: S, step: 'routing the secret net' }, r.now() / 1000)
      putJob(db, 'job-old', { kind: 'task', title: 'old', state: 'succeeded' }, r.now() / 1000 - NEW_WITHIN_S - 600)
      return { result: null }
    })
    expect(await r.run(r.event(INDEX))).toEqual({ repo: 'acme/board', changed: 4, notified: 0, jobs: 1 })
    expect(r.pub.sent.map((x) => x.channel).sort()).toEqual(['/trace/users/admin-1', '/trace/users/guest-1', '/trace/users/user-1', '/trace/users/user-2'])
    for (const x of r.pub.sent) expect(x.events).toEqual([{ type: 'job.updated', repo: 'acme/board', jobId: `${S}.job-1`, state: 'running', at: expect.any(String) }])
    expect(JSON.stringify(r.pub.sent)).not.toMatch(/secret/)
  })

  it('sends one event for the project when many jobs changed at once', async () => {
    const r = await rig()
    await r.index.update((db) => {
      for (let i = 0; i <= MAX_JOB_EVENTS; i++) putJob(db, `job-${i}`, { kind: 'task', title: 't', state: 'queued' }, r.now() / 1000)
      return { result: null }
    })
    await r.run(r.event(INDEX))
    expect(r.pub.to('user-1')).toEqual([{ type: 'job.updated', repo: 'acme/board', jobId: null, state: null, at: expect.any(String) }])
  })
})

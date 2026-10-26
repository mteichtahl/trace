import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SAFETY_CHECK_MS, eventDetail, runBatch, waitQueueName, type BatchApi, type BatchJobDetail, type SnsApi, type SqsApi } from '../../src/gpu/batch.js'
import { GpuJobSchema } from '../../src/gpu/jobs.js'
import { main } from '../../src/gpu/runner.js'
import { projectHash } from '../../src/core/project.js'
import { activeWaits, type WaitNotice } from '../../src/core/wait.js'
import { FakeS3 } from '../core/fake-s3.js'

const TOPIC = 'arn:aws:sns:us-east-1:123456789012:trace-batch-events'
const env = { TRACE_GPU_QUEUE: 'q-arn', TRACE_GPU_JOB_DEFINITION: 'def-arn', TRACE_GPU_BUCKET: 'central-bucket', TRACE_GPU_QUEUE_WAIT_S: '600', TRACE_PROJECT: 'Acme/Board', TRACE_BATCH_EVENTS_TOPIC: TOPIC }
const QUEUE = `trace-${projectHash('acme/board')}-wait-job-1`

const event = (status: string, jobId = 'job-1', extra: Partial<BatchJobDetail> = {}): string => JSON.stringify({
  version: '0', 'detail-type': 'Batch Job State Change', source: 'aws.batch',
  detail: { jobId, jobQueue: 'q-arn', status, ...extra },
})

/** A clock that only moves when the fakes say time passes. */
class Clock { t = 1_000_000; now = (): number => this.t }

/** Batch whose job runs the real runner when submitted (so the outputs exist), and answers DescribeJobs from `status`. */
class Batch implements BatchApi {
  submitted = 0
  described: number[] = []
  terminated: string[] = []
  status: string
  constructor(private readonly s3: FakeS3, private readonly clock: Clock, status = 'SUBMITTED', private readonly run = true) { this.status = status }
  async submitJob(i: Parameters<BatchApi['submitJob']>[0]) {
    this.submitted++
    if (this.run) await main({ s3: this.s3, env: Object.fromEntries(i.containerOverrides.environment.map((x) => [x.name, x.value])), echo: false })
    return { jobId: 'job-1' }
  }
  async describeJobs(): Promise<{ jobs: BatchJobDetail[] }> {
    this.described.push(this.clock.t)
    return { jobs: [{ jobId: 'job-1', status: this.status, statusReason: this.status === 'FAILED' ? 'Essential container in task exited' : undefined }] }
  }
  async terminateJob(i: { jobId: string }) { this.terminated.push(i.jobId); return {} }
}

/** SQS with a script of what each ReceiveMessage returns; an empty receive lets its whole wait pass on the clock. */
class Sqs implements SqsApi {
  created: Parameters<SqsApi['createQueue']>[0][] = []
  deleted: string[] = []
  receives: { at: number; waitS: number }[] = []
  acked: string[] = []
  seenWaits: WaitNotice[] = []
  failCreate: Error | null = null
  failReceive: Error | null = null
  onReceive: ((n: number) => void) | null = null
  constructor(private readonly clock: Clock, public script: (string[] | null)[] = []) {}
  async createQueue(i: Parameters<SqsApi['createQueue']>[0]) {
    if (this.failCreate) throw this.failCreate
    this.created.push(i)
    return { QueueUrl: `https://sqs.us-east-1.amazonaws.com/123456789012/${i.QueueName}` }
  }
  async receiveMessage(i: { QueueUrl: string; WaitTimeSeconds: number }) {
    this.receives.push({ at: this.clock.t, waitS: i.WaitTimeSeconds })
    this.seenWaits.push(...activeWaits())
    this.onReceive?.(this.receives.length)
    if (this.failReceive) throw this.failReceive
    const next = this.script.shift() ?? null
    if (!next) { this.clock.t += i.WaitTimeSeconds * 1000; return { Messages: [] } }
    this.clock.t += 50
    return { Messages: next.map((Body, k) => ({ Body, ReceiptHandle: `r${this.receives.length}-${k}` })) }
  }
  async deleteMessage(i: { ReceiptHandle: string }) { this.acked.push(i.ReceiptHandle); return {} }
  async deleteQueue(i: { QueueUrl: string }) { this.deleted.push(i.QueueUrl); return {} }
}

class Sns implements SnsApi {
  subscribed: Parameters<SnsApi['subscribe']>[0][] = []
  unsubscribed: string[] = []
  fail: Error | null = null
  async subscribe(i: Parameters<SnsApi['subscribe']>[0]) {
    if (this.fail) throw this.fail
    this.subscribed.push(i)
    return { SubscriptionArn: `${i.TopicArn}:sub-1` }
  }
  async unsubscribe(i: { SubscriptionArn: string }) { this.unsubscribed.push(i.SubscriptionArn); return {} }
}

const job = (over: Record<string, unknown> = {}) => {
  const d = mkdtempSync(join(tmpdir(), 'gpu-ev-'))
  writeFileSync(join(d, 'a.txt'), 'hello events')
  return GpuJobSchema.parse({ kind: 'blender', gpu: true, timeoutSeconds: 60, argv: ['sh', '-c', 'cat "$0" > "$1"', '{in:a.txt}', '{out:b.txt}'], inputs: { 'a.txt': join(d, 'a.txt') }, outputs: ['b.txt'], ...over })
}

function rig(o: { status?: string; script?: (string[] | null)[]; run?: boolean } = {}) {
  const clock = new Clock()
  const s3 = new FakeS3()
  const batch = new Batch(s3, clock, o.status ?? 'SUBMITTED', o.run ?? true)
  const sqs = new Sqs(clock, o.script ?? [])
  const sns = new Sns()
  const logs: string[] = []
  const sleeps: number[] = []
  const deps = { s3, batch, sqs, sns, env, now: clock.now, log: (l: string) => logs.push(l), sleep: async (ms: number) => { sleeps.push(ms); clock.t += ms } }
  return { clock, s3, batch, sqs, sns, logs, sleeps, deps }
}

describe('waiting on Batch job events', () => {
  it('subscribes its own queue with a filter on the job id, looks once, then returns the moment SUCCEEDED arrives', async () => {
    const r = rig({ script: [[event('RUNNABLE')], [event('STARTING'), event('RUNNING')], [event('SUCCEEDED')]] })
    const res = await runBatch(job(), r.deps)
    expect(res).toMatchObject({ exitCode: 0, where: 'batch', jobId: 'job-1' })
    expect(readFileSync(res.outputs['b.txt'] as string, 'utf8')).toBe('hello events')
    // its own queue: the project's name prefix, tagged, kept an hour at most, and only the stack's topic may send to it
    expect(r.sqs.created).toHaveLength(1)
    const q = r.sqs.created[0]
    expect(q?.QueueName).toBe(QUEUE)
    expect(q?.tags).toEqual({ 'trace:project': 'acme/board' })
    expect(q?.Attributes?.MessageRetentionPeriod).toBe('3600')
    const policy = JSON.parse(q?.Attributes?.Policy ?? '{}')
    expect(policy.Statement).toEqual([expect.objectContaining({
      Effect: 'Allow', Principal: { Service: 'sns.amazonaws.com' }, Action: 'sqs:SendMessage',
      Resource: `arn:aws:sqs:us-east-1:123456789012:${QUEUE}`, Condition: { ArnEquals: { 'aws:SourceArn': TOPIC } },
    })])
    // subscribed raw, filtered on this job's id in the message body
    expect(r.sns.subscribed).toEqual([{
      TopicArn: TOPIC, Protocol: 'sqs', Endpoint: `arn:aws:sqs:us-east-1:123456789012:${QUEUE}`, ReturnSubscriptionArn: true,
      Attributes: { RawMessageDelivery: 'true', FilterPolicyScope: 'MessageBody', FilterPolicy: JSON.stringify({ detail: { jobId: ['job-1'] } }) },
    }])
    // ONE DescribeJobs (after subscribing, before the first receive), then only events
    expect(r.batch.described).toHaveLength(1)
    expect(r.batch.described[0]).toBeLessThanOrEqual(r.sqs.receives[0]?.at ?? 0)
    expect(r.sqs.receives).toHaveLength(3)
    expect(r.sqs.receives.every((x) => x.waitS === 20)).toBe(true)
    expect(r.sleeps).toEqual([]) // no timer
    // every message deleted once read
    expect(r.sqs.acked).toEqual(['r1-0', 'r2-0', 'r2-1', 'r3-0'])
    // each status change logged once, as before
    expect(r.logs.filter((l) => /^job-1: [A-Z_]+$/.test(l))).toEqual(['job-1: SUBMITTED', 'job-1: RUNNABLE', 'job-1: STARTING', 'job-1: RUNNING', 'job-1: SUCCEEDED'])
    expect(r.logs.join('\n')).toMatch(/waiting on its Batch events; a check every 5 minutes/)
    // on the record as an event wait while it lasted, with its state; off it after
    const mine = r.sqs.seenWaits.filter((w) => w.what.startsWith('the graphics card job blender-'))
    expect(mine.length).toBe(3)
    expect(mine.every((w) => w.source === 'event' && w.nextCheckAt === null)).toBe(true)
    expect(mine.map((w) => w.state)).toEqual(['SUBMITTED', 'RUNNABLE', 'RUNNING'])
    expect(activeWaits().filter((w) => w.what.startsWith('the graphics card job'))).toEqual([])
    // and cleaned up
    expect(r.sns.unsubscribed).toEqual([`${TOPIC}:sub-1`])
    expect(r.sqs.deleted).toEqual([`https://sqs.us-east-1.amazonaws.com/123456789012/${QUEUE}`])
  })

  it('needs no event when the job already finished by the look after subscribing (the race)', async () => {
    const r = rig({ status: 'SUCCEEDED' })
    const res = await runBatch(job(), r.deps)
    expect(res.exitCode).toBe(0)
    expect(r.batch.described).toHaveLength(1)
    expect(r.sqs.receives).toHaveLength(0)
    expect(r.sns.unsubscribed).toHaveLength(1)
    expect(r.sqs.deleted).toHaveLength(1)
  })

  it('explains a FAILED event with its reason, and still cleans up', async () => {
    const r = rig({ run: false, script: [[event('RUNNING')], [event('FAILED', 'job-1', { statusReason: 'Host EC2 terminated' })]] })
    await expect(runBatch(job(), r.deps)).rejects.toThrow(/failed before its runner finished: Host EC2 terminated/)
    expect(r.sns.unsubscribed).toHaveLength(1)
    expect(r.sqs.deleted).toHaveLength(1)
  })

  it('ignores another job\'s events and unreadable messages', async () => {
    const r = rig({ script: [[event('SUCCEEDED', 'job-2'), 'not json', JSON.stringify({ hello: 1 })], [event('SUCCEEDED')]] })
    const res = await runBatch(job(), r.deps)
    expect(res.exitCode).toBe(0)
    expect(r.sqs.receives).toHaveLength(2)
    expect(eventDetail(event('RUNNING', 'job-2'), 'job-1')).toBeNull()
    expect(eventDetail(event('RUNNING'), 'job-1')).toMatchObject({ jobId: 'job-1', status: 'RUNNING' })
  })

  it('takes the ending when events arrive out of order', async () => {
    const r = rig({ script: [[event('SUCCEEDED'), event('RUNNING')]] })
    expect((await runBatch(job(), r.deps)).exitCode).toBe(0)
    expect(r.logs.filter((l) => /^job-1: [A-Z]+$/.test(l)).at(-1)).toBe('job-1: SUCCEEDED')
  })

  it('looks with DescribeJobs every 5 minutes when no event comes, and finds the job finished', async () => {
    const r = rig({ script: [] })
    // the job ends after 7 minutes, and its event is lost
    r.sqs.onReceive = () => { if (r.clock.t - 1_000_000 >= 7 * 60_000) r.batch.status = 'SUCCEEDED' }
    const t0 = r.clock.t
    const res = await runBatch(job(), r.deps)
    expect(res.exitCode).toBe(0)
    // the look after subscribing, then at 5 and 10 minutes
    expect(r.batch.described.map((t) => t - t0)).toEqual([0, SAFETY_CHECK_MS, 2 * SAFETY_CHECK_MS])
    // the receives fill the time between, never past the next look
    expect(r.sqs.receives.length).toBe(30)
    expect(r.sns.unsubscribed).toHaveLength(1)
  })

  it('terminates a job stuck past its deadline, and cleans up', async () => {
    const r = rig({ status: 'RUNNABLE', run: false })
    await expect(runBatch(job(), { ...r.deps, env: { ...env, TRACE_GPU_QUEUE_WAIT_S: '60' } }))
      .rejects.toThrow(/still RUNNABLE after \d+ s and was terminated: no GPU instance came up/)
    expect(r.batch.terminated).toEqual(['job-1'])
    // the deadline is 120 s: receives up to it, and one last look at it
    expect(r.clock.t - 1_000_000).toBe(120_000)
    expect(r.batch.described).toHaveLength(2)
    expect(r.sns.unsubscribed).toHaveLength(1)
    expect(r.sqs.deleted).toHaveLength(1)
  })

  it('cleans up when receiving fails, and carries on on the timer', async () => {
    const r = rig({ run: false })
    r.sqs.failReceive = new Error('AccessDenied')
    r.sqs.onReceive = () => { r.batch.status = 'FAILED' }
    await expect(runBatch(job(), r.deps)).rejects.toThrow(/failed before its runner finished/)
    expect(r.logs.join('\n')).toMatch(/waiting on a timer from now: receiving its Batch events failed \(AccessDenied\)/)
    expect(r.sns.unsubscribed).toHaveLength(1)
    expect(r.sqs.deleted).toHaveLength(1)
  })

  it('swallows a failed clean-up, and says so', async () => {
    const r = rig({ script: [[event('SUCCEEDED')]] })
    r.sns.unsubscribe = async () => { throw new Error('throttled') }
    r.sqs.deleteQueue = async () => { throw new Error('gone') }
    expect((await runBatch(job(), r.deps)).exitCode).toBe(0)
    expect(r.logs.join('\n')).toMatch(/could not remove its event subscription \(throttled\)[\s\S]*could not delete its event queue .* \(gone\)/)
  })
})

describe('waiting on a timer where there are no events', () => {
  it('without TRACE_BATCH_EVENTS_TOPIC: DescribeJobs on the timer, saying why and when it looks next', async () => {
    const r = rig()
    let n = 0
    const seq = ['SUBMITTED', 'RUNNABLE', 'RUNNABLE', 'RUNNING', 'SUCCEEDED']
    r.batch.describeJobs = async () => ({ jobs: [{ jobId: 'job-1', status: seq[Math.min(n++, seq.length - 1)] }] })
    const noTopic = { ...env, TRACE_BATCH_EVENTS_TOPIC: undefined }
    const res = await runBatch(job(), { ...r.deps, env: noTopic })
    expect(res.exitCode).toBe(0)
    expect(r.sqs.created).toHaveLength(0)
    expect(r.sns.subscribed).toHaveLength(0)
    expect(r.sleeps).toEqual([5000, 5000, 7500, 5000])
    const text = r.logs.join('\n')
    expect(text).toMatch(/waiting on a timer: no Batch event subscription on this stack \(TRACE_BATCH_EVENTS_TOPIC is not set\)/)
    // a plain-language line per change of state, not per check
    const lines = r.logs.filter((l) => l.startsWith('Waiting for the graphics card job'))
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/\(submitted\)\. Checked just now; next check in 5 seconds\./)
    expect(lines[1]).toMatch(/\(runnable\)/)
    expect(lines[2]).toMatch(/\(running\)/)
    expect(r.logs.filter((l) => /^job-1: [A-Z]+$/.test(l))).toEqual(['job-1: SUBMITTED', 'job-1: RUNNABLE', 'job-1: RUNNING', 'job-1: SUCCEEDED'])
  })

  it('when the subscription cannot be set up: says why, removes what it made, and waits on the timer', async () => {
    const r = rig({ status: 'SUCCEEDED' })
    r.sns.fail = new Error('AuthorizationError: not authorized to perform SNS:Subscribe')
    const res = await runBatch(job(), r.deps)
    expect(res.exitCode).toBe(0)
    expect(r.logs.join('\n')).toMatch(/waiting on a timer: setting up its Batch event subscription failed \(AuthorizationError/)
    // the queue it had made is deleted
    expect(r.sqs.deleted).toHaveLength(1)
    expect(r.sns.unsubscribed).toHaveLength(0)
    expect(r.sqs.receives).toHaveLength(0)
  })

  it('when the queue cannot be made, and on the deadline, terminates as before', async () => {
    const r = rig({ status: 'RUNNABLE', run: false })
    r.sqs.failCreate = new Error('AccessDenied')
    await expect(runBatch(job(), { ...r.deps, env: { ...env, TRACE_GPU_QUEUE_WAIT_S: '60' } })).rejects.toThrow(/still RUNNABLE after \d+ s and was terminated/)
    expect(r.batch.terminated).toEqual(['job-1'])
    expect(r.sqs.deleted).toHaveLength(0)
    expect(r.logs.join('\n')).toMatch(/setting up its Batch event subscription failed \(AccessDenied\)/)
  })

  it('names the wait queue from the stack\'s topic and the project, or not at all', () => {
    expect(waitQueueName(TOPIC, 'acme/board', 'abc-123')).toBe(`trace-${projectHash('acme/board')}-wait-abc-123`)
    expect(waitQueueName('arn:aws:sns:us-east-1:123456789012:my-lab-batch-events', 'acme/board', 'j')).toBe(`my-lab-${projectHash('acme/board')}-wait-j`)
    expect(waitQueueName('arn:aws:sns:us-east-1:123456789012:other-topic', 'acme/board', 'j')).toBeNull()
    expect(waitQueueName(TOPIC, '_local', 'j')).toBeNull()
  })
})

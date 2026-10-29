/**
 * The AWS Batch backend of runJob (./jobs.ts): a job that wants a GPU, asked for where there is none (an AgentCore
 * runtime, a laptop), runs on the stack's GPU job queue instead; a CPU job sent to the queue (`remote`, or
 * TRACE_GPU_REMOTE=always) runs on the CPU queue when the stack has one.
 *
 *   1. its inputs go to s3://<bucket>/jobs/<slug>/<id>/in/ (./protocol.ts has the layout; slug: TRACE_PROJECT), and
 *      its spec to jobs/<slug>/<id>/spec
 *   2. SubmitJob, tagged trace:project=<slug>, to
 *        gpu: true    TRACE_GPU_QUEUE with TRACE_GPU_JOB_DEFINITION
 *        gpu: false   TRACE_CPU_QUEUE with TRACE_CPU_JOB_DEFINITION, or the GPU queue when those are not set
 *      (each the project's own definition: its job role reaches only jobs/<slug>/). The container gets only
 *      TRACE_GPU_JOB_URI and TRACEPARENT, and runs the definition's own command: DescribeJobs has no resource-level
 *      permission, so nothing that names a file goes into what Batch shows. A `vcpus` hint becomes a VCPU resource
 *      override, capped at TRACE_GPU_JOB_MAX_VCPUS / TRACE_CPU_JOB_MAX_VCPUS (the definition's limit, set by the
 *      stack); without that limit the hint is not applied.
 *   3. wait for SUCCEEDED or FAILED — or the deadline (the job's own time limit plus TRACE_GPU_QUEUE_WAIT_S, default
 *      1800 s, for the queue to scale an instance up from zero and pull the image), when the job is terminated:
 *        on events   (TRACE_BATCH_EVENTS_TOPIC, set by the stack: src/infra/project.ts) the project's own SNS topic,
 *                    <prefix>-<project hash>-batch-events, which an EventBridge rule sends the "Batch Job State Change"
 *                    events of the project's own jobs (its own job definitions on the stack's queues). A short-lived
 *                    SQS queue of this job's own
 *                    (<prefix>-<project hash>-wait-<Batch job id>, tagged trace:project) is subscribed to it with a
 *                    filter on the job's id; then ONE DescribeJobs (an event from before the subscription would be
 *                    missed: this closes that gap), then ReceiveMessage long polls, each returning the moment an event
 *                    arrives. Event delivery is best effort, and a new subscription can take about a minute to start
 *                    delivering, so DescribeJobs also looks 30 s and 90 s after subscribing, then every 5 minutes (said
 *                    in the log when the wait starts). The subscription and the queue are removed when the wait ends,
 *                    however it ends; one left by a process that was killed is swept by a later wait of the project
 *                    (queues older than 24 h, and their subscriptions), alongside that wait and never in its way
 *        on a timer  where there is no subscription (an older stack without the topic, or setting it up failed: the
 *                    log says why), DescribeJobs through waitWithTimer (src/core/wait.ts) from 5 s, backing off to 30 s
 *                    while nothing changes and back to 5 s when it does; the log says when the next check is
 *   4. the outputs, stdout and stderr come back to a local scratch folder, and the runner's exit record gives the code
 *
 * The SDK clients are injected for tests; the real ones are loaded only when a job is shipped (SQS and SNS only when
 * the job is waited on by events).
 */
import { type S3Api } from '../core/central.js'
import { PROJECT_TAG, projectHash } from '../core/project.js'
import { ToolError } from '../core/registry.js'
import { ATTR, annotate, traceEnv } from '../core/telemetry.js'
import { describeWait, trackEventWait, waitWithTimer } from '../core/wait.js'
import type { JobResult } from './jobs.js'
import { trackInFlight } from './inflight.js'
import { type UsageRow, jobRow, ledgerFromEnv, recordUsage } from '../core/cost.js'
import { type PriceTable, pricesFromEnv } from '../core/prices.js'
import { pricesFor } from '../core/prices-store.js'
import { type ParsedJob, fetchOutputs, readResult, stageJob } from './staging.js'

export { newJobId, type ParsedJob } from './staging.js'

/** The three Batch calls used, in the SDK's own shapes (only the fields read here). */
export interface BatchApi {
  submitJob(i: {
    jobName: string
    jobQueue: string
    jobDefinition: string
    containerOverrides: {
      environment: { name: string; value: string }[]
      resourceRequirements?: { type: 'VCPU'; value: string }[]
    }
    timeout: { attemptDurationSeconds: number }
    tags?: Record<string, string>
  }): Promise<{ jobId?: string | undefined }>
  describeJobs(i: { jobs: string[] }): Promise<{ jobs?: BatchJobDetail[] | undefined }>
  terminateJob(i: { jobId: string; reason: string }): Promise<unknown>
}

export interface BatchJobDetail {
  jobId?: string | undefined
  status?: string | undefined
  statusReason?: string | undefined
  container?: { reason?: string | undefined; exitCode?: number | undefined; logStreamName?: string | undefined } | undefined
  /** ms since the epoch: when the container started and stopped (DescribeJobs and the state-change event carry them) */
  startedAt?: number | undefined
  stoppedAt?: number | undefined
}

/** The SQS calls the event wait uses (the SDK's shapes, only the fields read here). */
export interface SqsApi {
  createQueue(i: { QueueName: string; Attributes?: Record<string, string>; tags?: Record<string, string> }): Promise<{ QueueUrl?: string | undefined }>
  receiveMessage(i: { QueueUrl: string; WaitTimeSeconds: number; MaxNumberOfMessages: number }): Promise<{ Messages?: { Body?: string | undefined; ReceiptHandle?: string | undefined }[] | undefined }>
  deleteMessage(i: { QueueUrl: string; ReceiptHandle: string }): Promise<unknown>
  deleteQueue(i: { QueueUrl: string }): Promise<unknown>
  listQueues(i: { QueueNamePrefix: string; MaxResults: number; NextToken?: string | undefined }): Promise<{ QueueUrls?: string[] | undefined; NextToken?: string | undefined }>
  getQueueAttributes(i: { QueueUrl: string; AttributeNames: 'CreatedTimestamp'[] }): Promise<{ Attributes?: Record<string, string> | undefined }>
}

/** The SNS calls the event wait uses. */
export interface SnsApi {
  subscribe(i: { TopicArn: string; Protocol: 'sqs'; Endpoint: string; Attributes: Record<string, string>; ReturnSubscriptionArn: boolean }): Promise<{ SubscriptionArn?: string | undefined }>
  unsubscribe(i: { SubscriptionArn: string }): Promise<unknown>
  listSubscriptionsByTopic(i: { TopicArn: string; NextToken?: string | undefined }): Promise<{
    Subscriptions?: { SubscriptionArn?: string | undefined; Endpoint?: string | undefined; Protocol?: string | undefined }[] | undefined
    NextToken?: string | undefined
  }>
}

export interface BatchDeps {
  batch?: BatchApi
  s3?: S3Api
  sqs?: SqsApi
  sns?: SnsApi
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  env?: NodeJS.ProcessEnv
  /** progress lines (status changes), e.g. for a CLI */
  log?: (line: string) => void
  /** record what the job cost in the project's ledger (src/core/cost.ts); default: recordUsage into the session's ledger */
  recordCost?: (row: UsageRow) => Promise<unknown>
}

/**
 * What a finished job cost, for the ledger: its running time (Batch's startedAt to stoppedAt; a job that never
 * started ran on no instance and costs nothing) x its pool's price (src/core/prices.ts; `prices`: the table in use,
 * else the overrides over the built-in table). An estimate: the instance may have been up longer (scaling down is not
 * counted), and a Spot price is lower.
 */
export function batchCostRow(o: { pool: 'gpu' | 'cpu'; detail: BatchJobDetail | undefined; vcpus: number | null; id: string; kind: string; env: NodeJS.ProcessEnv; prices?: PriceTable }): UsageRow | null {
  const d = o.detail
  if (!d?.startedAt) return null
  const seconds = Math.max(0, ((d.stoppedAt ?? d.startedAt) - d.startedAt) / 1000)
  const vcpus = o.vcpus ?? (Number(o.env[o.pool === 'cpu' ? 'TRACE_CPU_JOB_MAX_VCPUS' : 'TRACE_GPU_JOB_MAX_VCPUS']) || 1)
  return jobRow(o.prices ?? pricesFromEnv(o.env), { pool: o.pool, seconds, vcpus, at: (d.stoppedAt ?? d.startedAt) / 1000, jobId: o.id, kind: o.kind, region: o.env.AWS_REGION ?? null })
}

async function awsBatch(): Promise<BatchApi> {
  const b = await import('@aws-sdk/client-batch')
  const client = new b.BatchClient({})
  return {
    submitJob: (i) => client.send(new b.SubmitJobCommand(i)),
    describeJobs: (i) => client.send(new b.DescribeJobsCommand(i)),
    terminateJob: (i) => client.send(new b.TerminateJobCommand(i)),
  }
}

async function awsSqs(): Promise<SqsApi> {
  const q = await import('@aws-sdk/client-sqs')
  const client = new q.SQSClient({})
  return {
    createQueue: (i) => client.send(new q.CreateQueueCommand(i)),
    receiveMessage: (i) => client.send(new q.ReceiveMessageCommand(i)),
    deleteMessage: (i) => client.send(new q.DeleteMessageCommand(i)),
    deleteQueue: (i) => client.send(new q.DeleteQueueCommand(i)),
    listQueues: (i) => client.send(new q.ListQueuesCommand(i)),
    getQueueAttributes: (i) => client.send(new q.GetQueueAttributesCommand(i)),
  }
}

async function awsSns(): Promise<SnsApi> {
  const n = await import('@aws-sdk/client-sns')
  const client = new n.SNSClient({})
  return {
    subscribe: (i) => client.send(new n.SubscribeCommand(i)),
    unsubscribe: (i) => client.send(new n.UnsubscribeCommand(i)),
    listSubscriptionsByTopic: (i) => client.send(new n.ListSubscriptionsByTopicCommand(i)),
  }
}

/** While waiting on events: one DescribeJobs this often, in case an event was lost. */
export const SAFETY_CHECK_MS = 5 * 60_000
/**
 * And, before that, these long after subscribing: a new SNS subscription can take up to about a minute before it
 * delivers, so a job that ends in that window would otherwise be found only at the first 5-minute check.
 */
export const WARMUP_CHECKS_MS = [30_000, 90_000] as const
/**
 * A wait queue older than this is left over from a wait that never cleaned up (its process was killed) and is swept.
 * The longest a wait can last is the job's time limit (at most 8 h: GpuJobSchema's timeoutSeconds) plus
 * TRACE_GPU_QUEUE_WAIT_S (default 30 min), so 8.5 h by default: 24 h is far above it. A TRACE_GPU_QUEUE_WAIT_S set
 * so high that a wait could outlast 24 h raises the bound to that wait plus an hour (staleAfterMs): every wait of a
 * project runs in its runtime, with the same environment, so the bound this process works out holds for the others.
 */
export const STALE_WAIT_QUEUE_MS = 24 * 3600_000
const MAX_JOB_SECONDS = 8 * 3600

export function staleAfterMs(env: NodeJS.ProcessEnv): number {
  const queueWait = Number(env.TRACE_GPU_QUEUE_WAIT_S ?? 1800)
  const longest = (MAX_JOB_SECONDS + (Number.isFinite(queueWait) && queueWait >= 0 ? queueWait : 1800)) * 1000
  return Math.max(STALE_WAIT_QUEUE_MS, longest + 3600_000)
}
/** The timer used where there are no events (DescribeJobs): from 5 s, backing off to 30 s. */
export const TIMER = { intervalMs: 5000, factor: 1.5, maxIntervalMs: 30_000 }
const NO_EVENTS_WHY = 'AWS job events do not reach this run'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const TERMINAL = new Set(['SUCCEEDED', 'FAILED'])

/** A job id that sorts by time and is safe in S3 keys and Batch job names. */
export interface Placement {
  queue: string
  definition: string
  pool: 'gpu' | 'cpu'
  /** the VCPU override, when a hint was given and the pool's limit is known */
  vcpus: number | null
  /** why a hint was not applied as given */
  note: string | null
}

/** Which queue and definition a job goes to, and the vCPUs it asks for. */
export function placement(job: { gpu: boolean; vcpus?: number | undefined }, env: NodeJS.ProcessEnv): Placement {
  const gpu = { queue: env.TRACE_GPU_QUEUE, definition: env.TRACE_GPU_JOB_DEFINITION }
  const cpu = { queue: env.TRACE_CPU_QUEUE, definition: env.TRACE_CPU_JOB_DEFINITION }
  let pool: 'gpu' | 'cpu'
  if (!job.gpu && cpu.queue && cpu.definition) pool = 'cpu'
  else if (gpu.queue && gpu.definition) pool = 'gpu'
  else {
    throw new ToolError(job.gpu
      ? 'the GPU queue needs TRACE_GPU_QUEUE and TRACE_GPU_JOB_DEFINITION (set by the stack on the runtimes)'
      : 'a CPU job on the queue needs TRACE_CPU_QUEUE and TRACE_CPU_JOB_DEFINITION, or TRACE_GPU_QUEUE and TRACE_GPU_JOB_DEFINITION (set by the stack on the runtimes)')
  }
  const { queue, definition } = (pool === 'cpu' ? cpu : gpu) as { queue: string; definition: string }
  if (job.vcpus === undefined) return { queue, definition, pool, vcpus: null, note: null }
  const limitVar = pool === 'cpu' ? 'TRACE_CPU_JOB_MAX_VCPUS' : 'TRACE_GPU_JOB_MAX_VCPUS'
  const limit = Number(env[limitVar])
  if (!Number.isInteger(limit) || limit < 1) return { queue, definition, pool, vcpus: null, note: `vcpus ${job.vcpus} not applied: ${limitVar} (the job definition's limit) is not set` }
  const vcpus = Math.min(job.vcpus, limit)
  return { queue, definition, pool, vcpus, note: vcpus < job.vcpus ? `vcpus ${job.vcpus} capped at ${limit} (${limitVar})` : null }
}

export async function runBatch(job: ParsedJob, deps: BatchDeps = {}): Promise<JobResult> {
  const env = deps.env ?? process.env
  const place = placement(job, env)
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => undefined)
  const t0 = now()
  const batch = deps.batch ?? (await awsBatch())
  const staged = await stageJob(job, { env, s3: deps.s3, now: t0 })
  const { id, project } = staged
  const environment = [{ name: 'TRACE_GPU_JOB_URI', value: staged.specUri }]
  // the trace context, so the runner's span continues this trace (src/core/telemetry.ts; nothing without a span).
  // Only TRACEPARENT: baggage carries the session id, which other projects have no business reading.
  const parent = traceEnv().TRACEPARENT
  if (parent) environment.push({ name: 'TRACEPARENT', value: parent })
  if (place.note) log(place.note)

  const submitted = await batch.submitJob({
    jobName: `trace-${id}`.slice(0, 128),
    jobQueue: place.queue,
    jobDefinition: place.definition,
    // no command override: the definition's generic `node /app/dist/gpu/runner.js` runs
    containerOverrides: {
      environment,
      ...(place.vcpus !== null ? { resourceRequirements: [{ type: 'VCPU' as const, value: String(place.vcpus) }] } : {}),
    },
    // the runner enforces the job's own limit; Batch's is a backstop for a runner that hangs
    timeout: { attemptDurationSeconds: Math.max(60, job.timeoutSeconds + 600) },
    // the project's role may submit, tag and stop only jobs carrying its own trace:project tag
    tags: { [PROJECT_TAG]: project, 'trace:job': id, 'trace:kind': job.kind },
  })
  const jobId = submitted.jobId
  if (!jobId) throw new ToolError('AWS Batch accepted the job but returned no job id')
  log(`submitted ${id} to the ${place.pool.toUpperCase()} queue as Batch job ${jobId}`)
  annotate({ [ATTR.gpuJobId]: id, [ATTR.gpuBatchJobId]: jobId })

  const queueWait = Number(env.TRACE_GPU_QUEUE_WAIT_S ?? 1800)
  const deadline = t0 + (job.timeoutSeconds + (Number.isFinite(queueWait) && queueWait >= 0 ? queueWait : 1800)) * 1000
  const what = `the ${place.pool === 'gpu' ? 'graphics card' : 'remote CPU'} job ${id}`
  const ctx: WaitCtx = { batch, jobId, deadline, now, log, what, sleep: deps.sleep, staleMs: staleAfterMs(env) }
  let last: { status: string; detail: BatchJobDetail | undefined }
  // while it is waited on, a cancelled job (its tool server closing) terminates it: src/gpu/inflight.ts
  const forget = trackInFlight({ jobId, terminate: (reason) => batch.terminateJob({ jobId, reason: `trace: ${reason}` }) })
  try {
  const topic = env.TRACE_BATCH_EVENTS_TOPIC
  const queueName = topic ? waitQueueName(topic, project, jobId) : null
  const onEvents = topic && queueName
    ? await waitOnEvents(ctx, { topic, queueName, project, sqs: deps.sqs, sns: deps.sns })
    : (log(`${jobId}: waiting on a timer: ${NO_EVENTS_WHY} (${topic ? 'it runs outside a project, or its event settings do not match the installation' : 'the installation does not send them: it predates them (running the installer again adds them), or its layout is flat'})`), null)
  if (onEvents && 'status' in onEvents) last = onEvents
  else last = await waitOnTimer(ctx, onEvents?.why ?? NO_EVENTS_WHY, onEvents?.lastStatus ?? '')
  } finally {
    forget()
  }
  const detail = last.detail
  // its cost, as it ended (best effort: recording never fails the job)
  if (TERMINAL.has(last.status)) {
    // priced with the table in use: the overrides, the fetched price list, the built-in table (src/core/prices-store.ts)
    const prices = detail?.startedAt ? (await pricesFor(env).catch(() => null))?.table : undefined
    const row = batchCostRow({ pool: place.pool, detail, vcpus: place.vcpus, id, kind: job.kind, env, ...(prices ? { prices } : {}) })
    if (row) await (deps.recordCost ?? ((r: UsageRow) => recordUsage([r], { ledger: ledgerFromEnv(env), log })))(row).catch(() => undefined)
  }
  if (!TERMINAL.has(last.status)) {
    const status = last.status
    await batch.terminateJob({ jobId, reason: `trace: no result within ${Math.round((deadline - t0) / 1000)} s` }).catch(() => undefined)
    throw new ToolError(`the GPU job ${id} (Batch ${jobId}) was still ${status} after ${Math.round((now() - t0) / 1000)} s and was terminated`
      + (status === 'RUNNABLE' ? `: no ${place.pool.toUpperCase()} instance came up (check the compute environment's instance types, vCPU quota and Spot capacity)` : ''))
  }

  const { exit, stdout, stderr } = await readResult(staged)
  if (!exit) {
    const why = [detail?.statusReason, detail?.container?.reason].filter(Boolean).join('; ')
    throw new ToolError(`the GPU job ${id} (Batch ${jobId}) ${(detail?.status ?? 'ended').toLowerCase()} before its runner finished${why ? `: ${why}` : ''}`
      + (stderr ? `\n${stderr.slice(-1500)}` : ''))
  }
  if (exit.error && exit.exitCode === 127) throw new ToolError(`the GPU job ${id}: ${exit.error}`)

  const outputs = await fetchOutputs(staged, job, { stdout, stderr })
  return {
    exitCode: exit.exitCode,
    stdout,
    stderr: exit.error ? `${stderr}\n[trace] ${exit.error}`.trim() : stderr,
    outputs,
    where: 'batch',
    jobId,
    seconds: (now() - t0) / 1000,
  }
}

// ------------------------------------------------------------------ waiting for the job (step 3 of the header)

interface WaitCtx {
  batch: BatchApi
  jobId: string
  /** ms since the epoch */
  deadline: number
  now: () => number
  log: (line: string) => void
  /** what is awaited, in plain words */
  what: string
  sleep?: ((ms: number) => Promise<void>) | undefined
  /** wait queues older than this are swept (staleAfterMs) */
  staleMs: number
}

/** How the wait ended: the job's last status (terminal, or not when the deadline came) and its detail. */
interface Seen { status: string; detail: BatchJobDetail | undefined }

/**
 * The job's own wait queue, `<prefix>-<project hash>-wait-<Batch job id>`: the only names the project's role may make
 * (src/infra/project.ts). Both come from the project's own topic, `<prefix>-<project hash>-batch-events`; null when
 * the topic is not named so, or is another project's (its hash is not this project's), or there is no project (a
 * laptop), or the name would not be a valid queue name (at most 80: a 21-character prefix and a Batch job id, a
 * 36-character UUID, make 72).
 */
export function waitQueueName(topicArn: string, project: string, jobId: string): string | null {
  const m = /^arn:[\w-]+:sns:[\w-]+:\d{12}:([a-z][a-z0-9-]{1,20})-([0-9a-f]{8})-batch-events$/.exec(topicArn)
  if (!m) return null
  let hash: string
  try { hash = projectHash(project) } catch { return null }
  if (m[2] !== hash) return null
  const name = `${m[1]}-${hash}-wait-${jobId}`
  return /^[\w-]{1,80}$/.test(name) ? name : null
}

/** The job as DescribeJobs has it now. */
async function describe(c: WaitCtx): Promise<Seen> {
  const detail = (await c.batch.describeJobs({ jobs: [c.jobId] })).jobs?.[0]
  return { status: detail?.status ?? 'UNKNOWN', detail }
}

/**
 * The job's detail from one SQS message (an EventBridge event, delivered raw), or null when it is not this job's
 * state change. The subscription filters on the job id; this checks again, since a filter can take a moment to apply.
 */
export function eventDetail(body: string | undefined, jobId: string): BatchJobDetail | null {
  try {
    const e = JSON.parse(body ?? '') as { 'detail-type'?: unknown; detail?: { jobId?: unknown; status?: unknown } }
    if (e['detail-type'] !== 'Batch Job State Change' || !e.detail || e.detail.jobId !== jobId || typeof e.detail.status !== 'string') return null
    return e.detail as BatchJobDetail
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ a wait queue on a project's topic

/** A wait queue subscribed to a project's topic: what it receives, and its removal. */
export interface WaitQueue {
  /** Long-poll up to waitS seconds; the bodies received (each deleted from the queue). Throws when receiving fails. */
  receive(waitS: number): Promise<string[]>
  /** Remove the subscription and the queue (never throws: what could not be removed is logged, and swept later). */
  close(): Promise<void>
}

export interface WaitQueueOptions {
  /** the project's topic, <prefix>-<hash>-batch-events */
  topic: string
  /** <prefix>-<hash>-wait-<what>: the only names the project's role may make (waitQueueName) */
  queueName: string
  /** <prefix>-<hash>-wait-: this project's wait queues, swept when left over */
  sweepPrefix: string
  /** the project (its tag) */
  project: string
  /** the subscription's filter on the message body: only what this wait is for reaches its queue */
  filterPolicy: Record<string, unknown>
  sqs?: SqsApi | undefined
  sns?: SnsApi | undefined
  now: () => number
  /** wait queues older than this are swept (staleAfterMs) */
  staleMs: number
  log: (line: string) => void
}

/**
 * Make a short-lived SQS queue of this wait's own, that only the project's topic may send to, and subscribe it to the
 * topic with a filter (raw delivery, so a body is the event as published); sweep the project's left-over wait queues
 * alongside. Used by a Batch job's wait (below) and by an agent waiting for a person's answer (src/tools/journey).
 * Throws when it cannot be set up, having removed what it made.
 */
export async function openWaitQueue(o: WaitQueueOptions): Promise<WaitQueue> {
  // the queue is in the topic's account and region (the stack's): its ARN follows from the topic's
  const [arn, partition, , region, account] = o.topic.split(':')
  const queueArn = `${arn}:${partition}:sqs:${region}:${account}:${o.queueName}`
  let sqs: SqsApi | undefined
  let sns: SnsApi | undefined
  let queueUrl: string | undefined
  let subscription: string | undefined
  const close = async (): Promise<void> => {
    if (subscription && sns) await sns.unsubscribe({ SubscriptionArn: subscription }).catch((e: unknown) => o.log(`could not remove its event subscription (${errText(e)})`))
    if (queueUrl && sqs) await sqs.deleteQueue({ QueueUrl: queueUrl }).catch((e: unknown) => o.log(`could not delete its event queue ${o.queueName} (${errText(e)})`))
    subscription = undefined
    queueUrl = undefined
  }
  try {
    sqs = o.sqs ?? (await awsSqs())
    sns = o.sns ?? (await awsSns())
    // this project's wait queues left over by waits that never cleaned up: alongside, never in the way
    startSweep({ sqs, sns, topic: o.topic, prefix: o.sweepPrefix, own: o.queueName, now: o.now, staleMs: o.staleMs, log: o.log })
    queueUrl = (await sqs.createQueue({
      QueueName: o.queueName,
      Attributes: {
        MessageRetentionPeriod: '3600',
        ReceiveMessageWaitTimeSeconds: '20',
        // only the stack's topic may send to it
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{ Sid: 'TraceBatchEvents', Effect: 'Allow', Principal: { Service: 'sns.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: queueArn, Condition: { ArnEquals: { 'aws:SourceArn': o.topic } } }],
        }),
      },
      tags: { [PROJECT_TAG]: o.project },
    })).QueueUrl
    if (!queueUrl) throw new Error('CreateQueue returned no queue URL')
    subscription = (await sns.subscribe({
      TopicArn: o.topic, Protocol: 'sqs', Endpoint: queueArn, ReturnSubscriptionArn: true,
      Attributes: { RawMessageDelivery: 'true', FilterPolicyScope: 'MessageBody', FilterPolicy: JSON.stringify(o.filterPolicy) },
    })).SubscriptionArn
    if (!subscription) throw new Error('Subscribe returned no subscription ARN')
  } catch (e) {
    await close()
    throw e
  }
  const q = sqs
  return {
    async receive(waitS) {
      if (!queueUrl) return []
      const url = queueUrl
      const messages = (await q.receiveMessage({ QueueUrl: url, WaitTimeSeconds: waitS, MaxNumberOfMessages: 10 })).Messages ?? []
      for (const m of messages) if (m.ReceiptHandle) await q.deleteMessage({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }).catch(() => undefined)
      return messages.map((m) => m.Body ?? '')
    },
    close,
  }
}

/**
 * Wait on the job's state-change events. Returns how the job ended (or stood at the deadline), or `why` events could
 * not be used (setting up failed, or receiving did), with the last status seen, for the timer to carry on from.
 */
async function waitOnEvents(c: WaitCtx, o: { topic: string; queueName: string; project: string; sqs?: SqsApi | undefined; sns?: SnsApi | undefined }): Promise<Seen | { why: string; lastStatus: string }> {
  const { jobId, log, now } = c
  let queue: WaitQueue | undefined
  let wait: ReturnType<typeof trackEventWait> | undefined
  let lastStatus = ''
  try {
    try {
      queue = await openWaitQueue({
        topic: o.topic, queueName: o.queueName, sweepPrefix: o.queueName.slice(0, o.queueName.length - jobId.length), project: o.project, filterPolicy: { detail: { jobId: [jobId] } },
        sqs: o.sqs, sns: o.sns, now, staleMs: c.staleMs, log: (line) => log(`${jobId}: ${line}`),
      })
    } catch (e) {
      const why = `setting up its Batch event subscription failed (${errText(e)})`
      log(`${jobId}: waiting on a timer: ${why}`)
      return { why, lastStatus }
    }
    wait = trackEventWait({ what: c.what, now })
    const seen = (s: Seen): void => {
      if (s.status !== lastStatus) {
        log(`${jobId}: ${s.status}`)
        lastStatus = s.status
        wait?.update(s.status)
      }
    }
    // the one look that closes the gap before the subscription existed
    let s = await describe(c)
    seen(s)
    if (TERMINAL.has(s.status)) return s
    log(`${jobId}: waiting for AWS to say the job has changed. In case a message is lost, trace also checks the job ${WARMUP_CHECKS_MS.map((ms) => `${ms / 1000} seconds`).join(' and ')} after subscribing (a new subscription can take about a minute to start delivering), then every ${Math.round(SAFETY_CHECK_MS / 60_000)} minutes`)
    // the safety-net looks, from when the subscription was made: the warm-up ones, then every SAFETY_CHECK_MS
    const subscribedAt = now()
    const warmups = WARMUP_CHECKS_MS.map((ms) => subscribedAt + ms)
    let nextSafety = warmups.shift() ?? subscribedAt + SAFETY_CHECK_MS
    for (;;) {
      const t = now()
      if (t >= c.deadline) {
        // the job may have ended a moment ago: one last look before giving up on it
        s = await describe(c)
        seen(s)
        return s
      }
      if (t >= nextSafety) {
        s = await describe(c)
        seen(s)
        if (TERMINAL.has(s.status)) return s
        nextSafety = warmups.shift() ?? now() + SAFETY_CHECK_MS
        continue
      }
      const waitS = Math.max(1, Math.min(20, Math.ceil((Math.min(nextSafety, c.deadline) - t) / 1000)))
      let bodies: string[]
      try {
        bodies = await queue.receive(waitS)
      } catch (e) {
        const why = `receiving its AWS job events failed (${errText(e)})`
        log(`${jobId}: waiting on a timer from now: ${why}`)
        return { why, lastStatus }
      }
      let terminal: Seen | null = null
      for (const b of bodies) {
        const d = eventDetail(b, jobId)
        if (!d) continue
        const ev = { status: d.status ?? 'UNKNOWN', detail: d }
        // events may arrive out of order: an ending is final, whatever comes with it
        if (TERMINAL.has(ev.status)) terminal ??= ev
        else if (!terminal) seen(ev)
      }
      if (terminal) {
        seen(terminal)
        return terminal
      }
    }
  } finally {
    wait?.end()
    await queue?.close()
  }
}

/** Wait on a timer (no events): DescribeJobs through waitWithTimer, from where the event wait left off. */
async function waitOnTimer(c: WaitCtx, why: string, lastStatus: string): Promise<Seen> {
  const { jobId, log, now } = c
  let last = lastStatus
  let reported: string | null = null
  let seenLast: Seen | undefined
  const outcome = await waitWithTimer<Seen>({
    what: c.what,
    why,
    ...TIMER,
    deadlineAt: c.deadline,
    now,
    ...(c.sleep ? { sleep: (ms: number) => (c.sleep as (ms: number) => Promise<void>)(ms) } : {}),
    check: async () => {
      const s = await describe(c)
      seenLast = s
      if (s.status !== last) {
        log(`${jobId}: ${s.status}`)
        last = s.status
      }
      return TERMINAL.has(s.status) ? { done: true, value: s, state: s.status } : { done: false, state: s.status }
    },
    // a plain-language line when the state changes (not every check): what it is waiting for and when it looks next
    report: (n) => {
      if (!n.nextCheckAt || n.state === reported) return
      reported = n.state
      log(describeWait(n, now()))
    },
  })
  if (outcome.done) return outcome.value
  return seenLast ?? { status: outcome.state ?? 'UNKNOWN', detail: undefined }
}

// ------------------------------------------------------------------ leftover wait queues

let sweeping: Promise<void> | null = null

/** The sweep running now, if any (tests wait for it). */
export function sweepInFlight(): Promise<void> | null { return sweeping }

const missingQueue = (e: unknown): boolean => {
  const n = (e as { name?: unknown; Code?: unknown })?.name ?? (e as { Code?: unknown })?.Code
  return n === 'QueueDoesNotExist' || n === 'AWS.SimpleQueueService.NonExistentQueue'
}

/** Start sweeping this project's stale wait queues unless a sweep is already running in this process. Never throws. */
function startSweep(o: SweepOptions): void {
  if (sweeping) return
  sweeping = sweepWaitQueues(o)
    .catch((e: unknown) => o.log(`could not sweep left-over event queues (${errText(e)})`))
    .finally(() => { sweeping = null })
}

interface SweepOptions {
  sqs: SqsApi
  sns: SnsApi
  topic: string
  /** this project's wait-queue name prefix, `<prefix>-<hash>-wait-` */
  prefix: string
  /** the queue this wait is about to make: never touched */
  own: string
  now: () => number
  staleMs: number
  log: (line: string) => void
}

/**
 * Delete this project's wait queues older than staleMs, and remove the topic's subscriptions of this project's wait
 * queues that are gone. Only names with this project's own prefix are ever touched; a subscription is removed only
 * when its queue was deleted here or SQS says it does not exist (a queue another wait made a moment ago is left alone).
 */
export async function sweepWaitQueues(o: SweepOptions): Promise<void> {
  const [arn, partition, , region, account] = o.topic.split(':')
  const arnPrefix = `${arn}:${partition}:sqs:${region}:${account}:`
  const nameOf = (url: string): string => url.slice(url.lastIndexOf('/') + 1)
  const urls: string[] = []
  let token: string | undefined
  do {
    const page = await o.sqs.listQueues({ QueueNamePrefix: o.prefix, MaxResults: 1000, ...(token ? { NextToken: token } : {}) })
    urls.push(...(page.QueueUrls ?? []))
    token = page.NextToken
  } while (token)
  const urlByName = new Map<string, string>()
  const deleted = new Set<string>()
  for (const url of urls) {
    const name = nameOf(url)
    if (!name.startsWith(o.prefix) || name === o.own) continue
    urlByName.set(name, url)
    try {
      const created = Number((await o.sqs.getQueueAttributes({ QueueUrl: url, AttributeNames: ['CreatedTimestamp'] })).Attributes?.CreatedTimestamp) * 1000
      if (!Number.isFinite(created) || o.now() - created < o.staleMs) continue
      await o.sqs.deleteQueue({ QueueUrl: url })
      deleted.add(name)
      o.log(`deleted the left-over event queue ${name}`)
    } catch (e) {
      if (missingQueue(e)) deleted.add(name)
      else o.log(`could not sweep the event queue ${name} (${errText(e)})`)
    }
  }
  // the queue's URL when the listing did not have it (gone, or made since): SQS's own form for the region
  const urlFor = (name: string): string => urlByName.get(name) ?? `https://sqs.${region}.amazonaws.com${partition === 'aws-cn' ? '.cn' : ''}/${account}/${name}`
  token = undefined
  do {
    const page = await o.sns.listSubscriptionsByTopic({ TopicArn: o.topic, ...(token ? { NextToken: token } : {}) })
    for (const sub of page.Subscriptions ?? []) {
      const endpoint = sub.Endpoint ?? ''
      if (sub.Protocol !== 'sqs' || !endpoint.startsWith(arnPrefix + o.prefix) || !sub.SubscriptionArn || sub.SubscriptionArn === 'PendingConfirmation') continue
      const name = endpoint.slice(arnPrefix.length)
      if (name === o.own) continue
      let gone = deleted.has(name)
      if (!gone) {
        // not deleted here: removed only if SQS says the queue is not there
        try {
          await o.sqs.getQueueAttributes({ QueueUrl: urlFor(name), AttributeNames: ['CreatedTimestamp'] })
        } catch (e) {
          gone = missingQueue(e)
          if (!gone) o.log(`could not check the event queue ${name} (${errText(e)})`)
        }
      }
      if (!gone) continue
      try {
        await o.sns.unsubscribe({ SubscriptionArn: sub.SubscriptionArn })
        o.log(`removed the left-over event subscription of ${name}`)
      } catch (e) {
        o.log(`could not remove the event subscription of ${name} (${errText(e)})`)
      }
    }
    token = page.NextToken
  } while (token)
}

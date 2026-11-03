/**
 * Writing run logs to CloudWatch Logs (docs/progress-and-logs.md, "Who writes what"): one writer per process, any
 * number of streams in the runs group (`/trace/<prefix>/runs`, src/core/run-logs.ts). The worker runtime uses it for
 * its jobs and tool calls (src/agents/runtime/log-stream.ts); tracectl and the harness actions on a CodeBuild runner
 * for a check's own lines (src/core/check-stream.ts).
 *
 *   batching    each stream's lines wait in memory and go in one PutLogEvents: every FLUSH.everyMs (1 s), or at once
 *               when FLUSH.lines (100) or FLUSH.bytes (256 KB) are waiting. One request per stream at a time, its
 *               events in time order (the order CloudWatch asks for within a batch); no sequence tokens (CloudWatch
 *               no longer needs them)
 *   streams     made on the first write to each (CreateLogStream; ResourceAlreadyExistsException means another writer
 *               made it, which is fine)
 *   failures    a writer never throws into its caller and never makes it wait: write() only queues. A failed request
 *               keeps its lines for the next try; after FLUSH.failures failures in a row the writer gives up for good,
 *               says so once on stderr, and drops everything after (a log is a nicety, never a reason to fail work)
 *   memory      at most FLUSH.queued lines wait per stream: past that the oldest go, and one line says how many
 *
 * The CloudWatch client is injected (LogsApi), so tests need no AWS; awsLogsApi() is the real one, loaded only when used.
 */

export const FLUSH = { everyMs: 1_000, lines: 100, bytes: 256 * 1024, failures: 3, queued: 5_000 } as const
/** CloudWatch counts each event as its message's UTF-8 bytes plus this. */
const EVENT_OVERHEAD = 26
/** A message longer than this is cut (CloudWatch allows 256 KB per event; no log line needs that). */
export const MAX_MESSAGE = 16_000

export interface LogEvent { timestamp: number; message: string }

/** The part of CloudWatch Logs a writer uses. */
export interface LogsApi {
  createLogStream(i: { logGroupName: string; logStreamName: string }): Promise<unknown>
  putLogEvents(i: { logGroupName: string; logStreamName: string; logEvents: LogEvent[] }): Promise<unknown>
}

export interface RunLogWriter {
  readonly group: string
  /** Queue one line for a stream (at `at`, default now). Never throws, never waits. */
  write(stream: string, text: string, at?: number): void
  /** Send what is queued (one stream, or all) and wait for it; never rejects. */
  flush(stream?: string): Promise<void>
  /** True while lines are queued or being sent. */
  pending(): boolean
  /** True once the writer has given up (repeated failures): writes are dropped. */
  readonly dropped: boolean
  /** Flush everything (waiting at most `timeoutMs`) and stop the timers. */
  close(timeoutMs?: number): Promise<void>
}

export interface WriterOptions {
  group: string
  /** the CloudWatch client, or how to make it (made on the first send) */
  api: LogsApi | (() => Promise<LogsApi>)
  now?: () => number
  /** where the one "giving up" warning goes (default stderr) */
  warn?: (line: string) => void
  everyMs?: number
  lines?: number
  bytes?: number
  failures?: number
  queued?: number
}

const errName = (e: unknown): string => (e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '')
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8')

interface StreamState {
  queue: LogEvent[]
  bytes: number
  /** lines dropped because the queue was full, not yet said */
  lost: number
  created: boolean
  sending: Promise<void> | null
  timer: NodeJS.Timeout | null
}

/** A writer for one log group (see the module comment). */
export function runLogWriter(o: WriterOptions): RunLogWriter {
  const now = o.now ?? Date.now
  const warn = o.warn ?? ((l: string) => { process.stderr.write(`${l}\n`) })
  const everyMs = o.everyMs ?? FLUSH.everyMs
  const maxLines = o.lines ?? FLUSH.lines
  const maxBytes = o.bytes ?? FLUSH.bytes
  const maxFailures = o.failures ?? FLUSH.failures
  const maxQueued = o.queued ?? FLUSH.queued
  const streams = new Map<string, StreamState>()
  let api: Promise<LogsApi> | null = null
  let failures = 0
  let dropped = false
  let closed = false

  const client = (): Promise<LogsApi> => {
    api ??= typeof o.api === 'function' ? o.api() : Promise.resolve(o.api)
    return api
  }
  const stateOf = (stream: string): StreamState => {
    let s = streams.get(stream)
    if (!s) { s = { queue: [], bytes: 0, lost: 0, created: false, sending: null, timer: null }; streams.set(stream, s) }
    return s
  }
  const giveUp = (why: string): void => {
    if (dropped) return
    dropped = true
    warn(`run logs: not written to ${o.group} any more (${why})`)
    for (const s of streams.values()) {
      if (s.timer) clearTimeout(s.timer)
      s.timer = null
      s.queue = []
      s.bytes = 0
    }
  }

  /** The next batch of a stream's queue: in time order, within the line and byte limits. */
  const take = (s: StreamState): LogEvent[] => {
    if (s.lost) {
      const first = s.queue[0]?.timestamp ?? now()
      s.queue.unshift({ timestamp: first, message: `… ${s.lost} earlier lines were not kept` })
      s.lost = 0
    }
    // a stable sort: lines written in the same millisecond keep their order
    s.queue = s.queue.map((e, i) => ({ e, i })).sort((a, b) => a.e.timestamp - b.e.timestamp || a.i - b.i).map((x) => x.e)
    const out: LogEvent[] = []
    let bytes = 0
    while (s.queue.length && out.length < maxLines) {
      const e = s.queue[0] as LogEvent
      const b = utf8(e.message) + EVENT_OVERHEAD
      if (out.length && bytes + b > maxBytes) break
      out.push(e)
      bytes += b
      s.queue.shift()
    }
    s.bytes = Math.max(0, s.bytes - bytes)
    return out
  }

  const send = async (stream: string, s: StreamState): Promise<void> => {
    while (s.queue.length && !dropped) {
      const batch = take(s)
      try {
        const logs = await client()
        if (!s.created) {
          try {
            await logs.createLogStream({ logGroupName: o.group, logStreamName: stream })
          } catch (e) {
            if (errName(e) !== 'ResourceAlreadyExistsException') throw e
          }
          s.created = true
        }
        await logs.putLogEvents({ logGroupName: o.group, logStreamName: stream, logEvents: batch })
        failures = 0
      } catch (e) {
        // a stream removed under us is made again on the next try
        if (errName(e) === 'ResourceNotFoundException') s.created = false
        failures++
        if (failures >= maxFailures) { giveUp(`${failures} failures in a row; the last: ${errText(e).slice(0, 300)}`); return }
        // the lines go back for the next try, which the timer makes
        s.queue.unshift(...batch)
        s.bytes += batch.reduce((n, x) => n + utf8(x.message) + EVENT_OVERHEAD, 0)
        schedule(stream, s)
        return
      }
    }
  }

  const flushOne = (stream: string): Promise<void> => {
    const s = streams.get(stream)
    if (!s || dropped) return Promise.resolve()
    if (s.timer) { clearTimeout(s.timer); s.timer = null }
    // one request per stream at a time: a flush during a send waits for it, then sends what came meanwhile
    const run = (s.sending ?? Promise.resolve()).then(() => send(stream, s)).catch(() => undefined)
    const mine: Promise<void> = run.finally(() => { if (s.sending === mine) s.sending = null })
    s.sending = mine
    return mine
  }

  function schedule(stream: string, s: StreamState): void {
    if (s.timer || dropped || closed) return
    s.timer = setTimeout(() => { s.timer = null; void flushOne(stream) }, everyMs)
    s.timer.unref?.()
  }

  return {
    group: o.group,
    get dropped() { return dropped },
    write(stream, text, at) {
      try {
        if (dropped || closed || !stream) return
        const message = (text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text) || ' '
        const s = stateOf(stream)
        s.queue.push({ timestamp: Math.round(at ?? now()), message })
        s.bytes += utf8(message) + EVENT_OVERHEAD
        while (s.queue.length > maxQueued) {
          const gone = s.queue.shift() as LogEvent
          s.bytes -= utf8(gone.message) + EVENT_OVERHEAD
          s.lost++
        }
        if (s.queue.length >= maxLines || s.bytes >= maxBytes) void flushOne(stream)
        else schedule(stream, s)
      } catch { /* a log line is never worth a failure */ }
    },
    async flush(stream) {
      if (stream !== undefined) return flushOne(stream)
      await Promise.all([...streams.keys()].map(flushOne))
    },
    pending: () => !dropped && [...streams.values()].some((s) => s.queue.length > 0 || s.sending !== null),
    async close(timeoutMs = 5_000) {
      const all = Promise.all([...streams.keys()].map(flushOne))
      let timer: NodeJS.Timeout | undefined
      await Promise.race([all, new Promise<void>((r) => { timer = setTimeout(r, timeoutMs); timer.unref?.() })])
      if (timer) clearTimeout(timer)
      closed = true
      for (const s of streams.values()) { if (s.timer) clearTimeout(s.timer); s.timer = null }
    },
  }
}

/**
 * The real CloudWatch Logs client. `container`: use the container's own credentials (a CodeBuild build's service role,
 * AWS_CONTAINER_CREDENTIALS_*) even when a step put other credentials in the environment (a workflow that assumed its
 * project's OIDC role with configure-aws-credentials: that role may not write the runs group); else the default chain.
 */
export async function awsLogsApi(o: { container?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<LogsApi> {
  const env = o.env ?? process.env
  const cw = await import('@aws-sdk/client-cloudwatch-logs')
  const fromContainer = o.container && (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI)
  const credentials = fromContainer ? (await import('@aws-sdk/credential-providers')).fromContainerMetadata({ timeout: 2_000, maxRetries: 2 }) : undefined
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION
  const client = new cw.CloudWatchLogsClient({ ...(region ? { region } : {}), ...(credentials ? { credentials } : {}), maxAttempts: 3 })
  return {
    createLogStream: (i) => client.send(new cw.CreateLogStreamCommand(i)),
    putLogEvents: (i) => client.send(new cw.PutLogEventsCommand(i)),
  }
}

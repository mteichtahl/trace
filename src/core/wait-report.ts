/**
 * The wait relay, MCP server side: a job's `tracectl mcp` process reports its open waits to the runtime that started
 * the job, and takes check-now wakes back from it (the runtime side: src/agents/runtime/wait-relay.ts).
 *
 * Only when TRACE_WAITS_URL (the runtime, loopback) and TRACE_WAITS_TOKEN (that job's) are set, which the job runner
 * does for every job's MCP server (src/agents/runtime/job.ts). Both ways are events, never a poll:
 *
 *   report   every change to this process's record (waitChanges: opened, updated, ended) is POSTed to
 *            /waits/report { token, change }, one at a time in order (a serial queue: opened before updated before
 *            ended). Fire and forget: a tool never waits for it. A report that fails is retried twice, then dropped
 *            and logged (stderr); a 403 or 404 (the job ended, no relay there) stops the relay for good.
 *   wakes    one background loop holds POST /waits/wakes { token, timeoutS: 240 }, which the runtime answers the
 *            moment a person asks for a check now on one of this job's timer waits; each id returned is woken here
 *            (checkNow). A failed call backs off (1 s, doubling, up to 60 s); a 400, 403 or 404 stops the loop.
 *
 * Nothing here keeps the process alive: the sockets and the back-off timers are unref'd, and stop() (on stdin's end,
 * src/core/mcp.ts serve) aborts the held call and stops listening.
 */
import { request } from 'node:http'
import { type WaitChange, checkNow, isMirrored, waitChanges } from './wait.js'

export interface WaitRelayEnv { url: string; token: string }

export function waitRelayEnv(env: NodeJS.ProcessEnv = process.env): WaitRelayEnv | null {
  const url = env.TRACE_WAITS_URL?.trim()
  const token = env.TRACE_WAITS_TOKEN?.trim()
  if (!url || !token) return null
  return { url: url.replace(/\/+$/, ''), token }
}

/** The longest one /waits/wakes is asked to hold (the runtime caps it there too: wait-relay.ts MAX_WAKES_S). */
const WAKES_S = 240
const RETRIES = [100, 500]
const BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000

interface Answer { status: number; json: unknown }

/** One POST over loopback http whose socket never keeps the process alive. */
function post(url: string, body: unknown, signal: AbortSignal): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body)
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }, signal }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        let json: unknown = null
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json })
      })
      res.on('error', reject)
    })
    req.on('socket', (s) => s.unref())
    req.on('error', reject)
    req.end(text)
  })
}

const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) return resolve()
  const t = setTimeout(() => { signal.removeEventListener('abort', done); resolve() }, ms)
  t.unref()
  const done = (): void => { clearTimeout(t); resolve() }
  signal.addEventListener('abort', done, { once: true })
})

export interface WaitReporter {
  /** Resolves once every report queued so far has been sent (or dropped). */
  flushed(): Promise<void>
  /** Resolves when the wakes loop has stopped (after stop(), or a refusal). */
  readonly loop: Promise<void>
  stop(): void
}

/**
 * Start the relay: report every change of this process's record, and hold /waits/wakes. Null without the
 * environment. `log`: one line per dropped report or refusal (default: stderr; stdout is the MCP stream).
 */
export function startWaitReporter(e: WaitRelayEnv | null = waitRelayEnv(), o: { log?: (line: string) => void } = {}): WaitReporter | null {
  if (!e) return null
  const log = o.log ?? ((l: string) => { process.stderr.write(`tracectl mcp: ${l}\n`) })
  const abort = new AbortController()
  let refused = false
  const refuse = (why: string): void => {
    if (refused) return
    refused = true
    log(`the runtime refused the wait relay (${why}): waits are no longer reported`)
    stop()
  }

  // ---------------------------------------------------------------- reports, one at a time, in order
  let queue: Promise<void> = Promise.resolve()
  const send = async (change: WaitChange): Promise<void> => {
    const body = { token: e.token, change: { type: change.type, notice: change.notice } }
    for (let attempt = 0; ; attempt++) {
      if (refused || abort.signal.aborted) return
      let why: string
      try {
        const r = await post(`${e.url}/waits/report`, body, abort.signal)
        if (r.status === 200) return
        if (r.status === 403 || r.status === 404) return refuse(`${r.status}`)
        why = `${r.status}`
        if (r.status >= 400 && r.status < 500) attempt = RETRIES.length // the same body is refused again
      } catch (err) {
        if (abort.signal.aborted) return
        why = err instanceof Error ? err.message : String(err)
      }
      if (attempt >= RETRIES.length) { log(`a wait change (${change.type} ${change.notice.id}) was not reported: ${why.slice(0, 200)}`); return }
      await pause(RETRIES[attempt]!, abort.signal)
    }
  }
  const unlisten = waitChanges.on((change) => {
    if (refused || isMirrored(change.notice.id)) return
    queue = queue.then(() => send(change)).catch(() => undefined)
  })

  // ---------------------------------------------------------------- wakes, held by the runtime
  const loop = (async () => {
    let backoff = BACKOFF_MS
    while (!abort.signal.aborted && !refused) {
      try {
        const r = await post(`${e.url}/waits/wakes`, { token: e.token, timeoutS: WAKES_S }, abort.signal)
        if (r.status === 200) {
          backoff = BACKOFF_MS
          const ids = (r.json as { waitIds?: unknown } | null)?.waitIds
          if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') checkNow(id)
          continue
        }
        if (r.status === 400 || r.status === 403 || r.status === 404) return refuse(`${r.status}`)
      } catch {
        if (abort.signal.aborted) return
      }
      await pause(backoff, abort.signal)
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2)
    }
  })()

  function stop(): void {
    unlisten()
    if (!abort.signal.aborted) abort.abort()
  }
  return { flushed: () => queue, loop, stop }
}

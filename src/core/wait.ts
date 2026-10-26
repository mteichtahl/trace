/**
 * Waiting, the trace way: on an event wherever one exists, on a declared timer only where none does.
 *
 *   EventBus             an in-process event channel: on(listener), emit(event), waitFor(match, { timeoutMs, signal })
 *   trackEventWait(o)    put an event-driven wait on the record: what is awaited and its latest state, no timer
 *   waitWithTimer(o)     the only way trace checks on a timer. Every check is recorded: when it last looked, when it
 *                        will look next, how often, and why there is no event to wait on instead. A person can ask
 *                        for a check now (checkNow), and the wait can be stopped (its AbortSignal).
 *   activeWaits()        every wait this process has open, newest first: what a status answer and a screen show
 *   checkNow(id)         wake one timer wait for an immediate check; false when no such timer wait is open
 *   describeWait(n)      the plain-language line a person reads: "Waiting for the order to be confirmed. Checked
 *                        2 minutes ago; next check in 13 minutes."
 *   waitChanges          an EventBus of every change to the record (opened, updated after a check or a new state,
 *                        ended), each with the notice, its line and waitsVersion(): how a screen follows waits as they
 *                        happen, through a held status answer, rather than asking again and again
 *   withJob(jobId, fn)   run fn so that every wait it opens is attributed to that job (notice.jobId)
 *
 * Timer intervals back off while nothing changes (factor, up to maxIntervalMs) and drop back to the base interval
 * the moment the awaited thing's state changes, so a wait that is moving is checked often and one that is idle is
 * not; the next-check time always says which.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'

// ------------------------------------------------------------------ the record of open waits

export type WaitSource = 'event' | 'timer'

/** One open wait, as a status answer or a screen shows it. Times are ISO 8601. */
export interface WaitNotice {
  id: string
  /** what is awaited, in plain words ("the worker job job-…", "the knowledge base update") */
  what: string
  source: WaitSource
  startedAt: string
  /** the job the wait was opened in (withJob), or null for one opened outside any job (a tool call, the CLI) */
  jobId: string | null
  /** the awaited thing's latest state, in its own words (RUNNING, IN_PROGRESS, …), or null before the first news */
  state: string | null
  /** timer waits: when trace last looked, when it will look next, and the interval it is on now */
  lastCheckedAt: string | null
  nextCheckAt: string | null
  intervalMs: number | null
  checks: number
  /** timer waits: why there is no event to wait on instead */
  why: string | null
}

interface Open { notice: WaitNotice; wake: (() => void) | null }
const open = new Map<string, Open>()

/** One change to the record of open waits. `version` is waitsVersion() after the change. */
export interface WaitChange {
  type: 'opened' | 'updated' | 'ended'
  version: number
  notice: WaitNotice
  /** describeWait(notice) at the time of the change */
  line: string
}

let version = 0

/** A counter that only grows: one step per change to the record of open waits (per process, from 0). */
export function waitsVersion(): number { return version }

function changed(type: WaitChange['type'], notice: WaitNotice): void {
  version++
  waitChanges.emit({ type, version, notice: { ...notice }, line: describeWait(notice) })
}

const jobScope = new AsyncLocalStorage<string>()

/** Run fn so that every wait it opens (however deep) is attributed to jobId. */
export function withJob<T>(jobId: string, fn: () => T): T {
  return jobScope.run(jobId, fn)
}

const newId = (): string => `wait-${randomBytes(5).toString('hex')}`

/** Every wait this process has open, newest first. Copies: changing them changes nothing. */
export function activeWaits(): WaitNotice[] {
  return [...open.values()].map((o) => ({ ...o.notice })).reverse()
}

/** A check now within this long of the last check is not made again: the wait was just checked. */
export const CHECK_NOW_MIN_GAP_MS = 2_000

/**
 * Wake one timer wait for an immediate check. False when no timer wait with that id is open. A wait checked less
 * than CHECK_NOW_MIN_GAP_MS ago is not woken again (true: it was just checked), so repeated presses, or a caller
 * asking in a loop, cannot turn into a stream of calls to the service being waited on.
 */
export function checkNow(id: string, now: number = Date.now()): boolean {
  const o = open.get(id)
  if (!o?.wake) return false
  const last = o.notice.lastCheckedAt ? Date.parse(o.notice.lastCheckedAt) : null
  if (last !== null && now - last < CHECK_NOW_MIN_GAP_MS) return true
  o.wake()
  return true
}

// ------------------------------------------------------------------ plain-language times

/** "just now", "40 seconds", "2 minutes", "1 hour 5 minutes" */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s} seconds`
  const m = Math.round(s / 60)
  if (m < 60) return m === 1 ? '1 minute' : `${m} minutes`
  const h = Math.floor(m / 60)
  const rest = m % 60
  const hours = h === 1 ? '1 hour' : `${h} hours`
  return rest ? `${hours} ${rest === 1 ? '1 minute' : `${rest} minutes`}` : hours
}

const ago = (ms: number): string => { const d = duration(ms); return d === 'just now' ? d : `${d} ago` }
const within = (ms: number): string => { const d = duration(ms); return d === 'just now' ? 'a moment' : d }

/** The line a person reads about one open wait. */
export function describeWait(n: WaitNotice, now: number = Date.now()): string {
  // a service's own state word (IN_PROGRESS, RUNNABLE) reads as words; free text (a log line) is left as it is
  const state = n.state && /^[A-Z][A-Z_]*$/.test(n.state) ? n.state.toLowerCase().replace(/_/g, ' ') : n.state
  const head = `Waiting for ${n.what}${state ? ` (${state})` : ''}.`
  if (n.source === 'event') return `${head} trace will know as soon as it changes.`
  const last = n.lastCheckedAt ? `Checked ${ago(now - Date.parse(n.lastCheckedAt))}` : 'Not checked yet'
  const next = n.nextCheckAt ? `next check in ${within(Date.parse(n.nextCheckAt) - now)}` : 'no further check is planned'
  return `${head} ${last}; ${next}.`
}

// ------------------------------------------------------------------ events

export type Listener<E> = (e: E) => void

/** A small in-process event channel. Listeners run in order; one that throws does not stop the others. */
export class EventBus<E> {
  private readonly listeners = new Set<Listener<E>>()

  /** Listen; returns the function that stops listening. */
  on(listener: Listener<E>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(e: E): void {
    for (const l of [...this.listeners]) {
      try { l(e) } catch { /* a listener's failure is its own */ }
    }
  }

  get size(): number { return this.listeners.size }

  /**
   * The first event that matches, or null when timeoutMs passes or the signal aborts first. `already` is asked once,
   * after listening starts, so an event that happened just before the call is not missed.
   */
  waitFor<T extends E>(match: (e: E) => e is T, o?: { timeoutMs?: number; signal?: AbortSignal | undefined; already?: () => T | null }): Promise<T | null>
  waitFor(match: (e: E) => boolean, o?: { timeoutMs?: number; signal?: AbortSignal | undefined; already?: () => E | null }): Promise<E | null>
  waitFor(match: (e: E) => boolean, o: { timeoutMs?: number; signal?: AbortSignal | undefined; already?: () => E | null } = {}): Promise<E | null> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const finish = (v: E | null): void => {
        stop()
        if (timer) clearTimeout(timer)
        o.signal?.removeEventListener('abort', onAbort)
        resolve(v)
      }
      const onAbort = (): void => finish(null)
      const stop = this.on((e) => { if (match(e)) finish(e) })
      if (o.signal?.aborted) return finish(null)
      o.signal?.addEventListener('abort', onAbort, { once: true })
      const prior = o.already?.() ?? null
      if (prior) return finish(prior)
      if (o.timeoutMs !== undefined) timer = setTimeout(() => finish(null), Math.max(0, o.timeoutMs))
    })
  }
}

/** Every change to the record of open waits, as it happens. */
export const waitChanges = new EventBus<WaitChange>()

/** An event-driven wait, on the record while it lasts: no timer, only the latest state. */
export interface EventWait {
  readonly id: string
  update(state: string): void
  end(): void
}

export function trackEventWait(o: { what: string; state?: string | null; now?: () => number }): EventWait {
  const now = o.now ?? Date.now
  const id = newId()
  const notice: WaitNotice = {
    id, what: o.what, source: 'event', startedAt: new Date(now()).toISOString(), jobId: jobScope.getStore() ?? null,
    state: o.state ?? null, lastCheckedAt: null, nextCheckAt: null, intervalMs: null, checks: 0, why: null,
  }
  open.set(id, { notice, wake: null })
  changed('opened', notice)
  return {
    id,
    update(state) {
      if (!open.has(id) || state === notice.state) return
      notice.state = state
      changed('updated', notice)
    },
    end() { if (open.delete(id)) changed('ended', notice) },
  }
}

// ------------------------------------------------------------------ timers (only where no event exists)

/** One check's answer: done with a value, or not yet (with the state seen, if any). */
export type Check<T> = { done: true; value: T; state?: string } | { done: false; state?: string }

export type WaitOutcome<T> =
  | { done: true; value: T; checks: number; waitId: string }
  | { done: false; reason: 'deadline' | 'aborted'; state: string | null; checks: number; waitId: string }

export interface TimerWaitOptions<T> {
  /** what is awaited, in plain words */
  what: string
  /** why a timer: the event trace would wait on instead does not exist ("Bedrock sends no event when …") */
  why: string
  check: () => Promise<Check<T>>
  /** the first interval, and the one used again whenever the state changes */
  intervalMs: number
  /** how much the interval grows after a check that saw no change (default 1: a fixed interval) */
  factor?: number
  /** the longest interval (default: intervalMs) */
  maxIntervalMs?: number
  /** stop at this time (ms since the epoch); the outcome says 'deadline' */
  deadlineAt?: number
  signal?: AbortSignal | undefined
  /** called after every check with the notice as it stands (what a progress line or a screen shows) */
  report?: (n: WaitNotice) => void
  /** tests: the clock, and a sleep that resolves early on the given signal */
  now?: () => number
  sleep?: (ms: number, early: AbortSignal) => Promise<void>
}

const realSleep = (ms: number, early: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (early.aborted) return resolve()
  const t = setTimeout(() => { early.removeEventListener('abort', onEarly); resolve() }, Math.max(0, ms))
  const onEarly = (): void => { clearTimeout(t); resolve() }
  early.addEventListener('abort', onEarly, { once: true })
})

/**
 * Check until done, the deadline, or the signal: the one timer loop in trace. Errors thrown by `check` end the wait
 * (they are the caller's to report); the wait leaves the record either way.
 */
export async function waitWithTimer<T>(o: TimerWaitOptions<T>): Promise<WaitOutcome<T>> {
  if (!(o.intervalMs > 0)) throw new Error('waitWithTimer: intervalMs must be above zero')
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? realSleep
  const factor = o.factor ?? 1
  const max = Math.max(o.maxIntervalMs ?? o.intervalMs, o.intervalMs)
  const id = newId()
  const notice: WaitNotice = {
    id, what: o.what, source: 'timer', startedAt: new Date(now()).toISOString(), jobId: jobScope.getStore() ?? null,
    state: null, lastCheckedAt: null, nextCheckAt: null, intervalMs: o.intervalMs, checks: 0, why: o.why,
  }
  let early = new AbortController()
  const entry: Open = { notice, wake: () => early.abort() }
  open.set(id, entry)
  changed('opened', notice)
  /** after every check: the caller's report, and the record's change event */
  const told = (): void => { o.report?.({ ...notice }); changed('updated', notice) }
  const onAbort = (): void => early.abort()
  o.signal?.addEventListener('abort', onAbort, { once: true })
  let interval = o.intervalMs
  try {
    for (;;) {
      if (o.signal?.aborted) return { done: false, reason: 'aborted', state: notice.state, checks: notice.checks, waitId: id }
      const r = await o.check()
      notice.checks++
      notice.lastCheckedAt = new Date(now()).toISOString()
      const moved = r.state !== undefined && r.state !== notice.state
      if (r.state !== undefined) notice.state = r.state
      if (r.done) {
        notice.nextCheckAt = null
        told()
        return { done: true, value: r.value, checks: notice.checks, waitId: id }
      }
      // moving: check again soon; idle: back off
      interval = moved ? o.intervalMs : notice.checks === 1 ? o.intervalMs : Math.min(max, Math.round(interval * factor))
      const t = now()
      if (o.deadlineAt !== undefined && t >= o.deadlineAt) {
        notice.nextCheckAt = null
        told()
        return { done: false, reason: 'deadline', state: notice.state, checks: notice.checks, waitId: id }
      }
      const at = o.deadlineAt !== undefined ? Math.min(t + interval, o.deadlineAt) : t + interval
      notice.intervalMs = interval
      notice.nextCheckAt = new Date(at).toISOString()
      told()
      await sleep(at - t, early.signal)
      if (early.signal.aborted) early = new AbortController()
    }
  } finally {
    o.signal?.removeEventListener('abort', onAbort)
    if (open.delete(id)) changed('ended', notice)
  }
}

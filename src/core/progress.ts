/**
 * What a tool says while it runs (docs/progress-and-logs.md, "Who writes what"): a channel the caller opens around a
 * tool call, and the tool, or the process helpers it runs programs through, write lines into.
 *
 *   withProgress(sink, fn)       runs fn with `sink` as the channel: every reportLine and reportProgress made inside it,
 *                                however deep in awaits (AsyncLocalStorage), reaches that sink. The worker runtime's
 *                                tool runner opens one per tool call, writing to the call's log stream
 *                                (src/agents/runtime/tool.ts)
 *   reportLine(text)             one line, trimmed; empty lines are skipped. Nothing at all outside a channel, so a
 *                                tool run from the CLI or a test is unchanged
 *   reportProgress(f, text?)     how far along (0..1), written as a line "62% · <text>"; throttled per channel to one
 *                                line every PROGRESS_EVERY_MS (a tool that reports every iteration writes about two lines
 *                                a second), except the first and 100%, which always go
 *   lineSplitter(emit)           chunked stdout or stderr (a child process's 'data') to whole lines, for the process
 *                                helpers (src/tools/sim/proc.ts, the kicad-cli runner src/tools/kicad/project.ts
 *                                runProgram, src/tools/firmware/run.ts): push(chunk), then end() for a last line without
 *                                its newline
 *   forwardOutput()              a pair of such splitters writing to reportLine, or null outside a channel, so a helper
 *                                splits nothing when no one listens
 *   reportOutput(text)           a finished program's last lines, for a job whose output could not be followed live
 *                                (src/tools/thermal/openfoam.ts, src/tools/mech/engine.ts: their jobs go through
 *                                src/gpu/jobs.ts, possibly to another machine)
 *
 * A sink never throws into the tool: what it does with a line is its own business.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface ProgressSink {
  line(text: string): void
}

/** At most one progress line in this window per channel (about two a second). */
export const PROGRESS_EVERY_MS = 500
/** Longer lines are cut: a log line is for a person to read. */
export const MAX_PROGRESS_LINE = 2_000

interface Channel { sink: ProgressSink; lastProgressAt: number; now: () => number }
const channel = new AsyncLocalStorage<Channel>()

/** Run `fn` with `sink` receiving its progress (see the module comment). */
export function withProgress<T>(sink: ProgressSink, fn: () => T, o: { now?: () => number } = {}): T {
  return channel.run({ sink, lastProgressAt: -Infinity, now: o.now ?? Date.now }, fn)
}

/** True inside withProgress. */
export const progressOpen = (): boolean => channel.getStore() !== undefined

const send = (c: Channel, text: string): void => {
  try { c.sink.line(text.length > MAX_PROGRESS_LINE ? `${text.slice(0, MAX_PROGRESS_LINE - 1)}…` : text) } catch { /* the sink's own */ }
}

const lineTo = (c: Channel, text: string): void => {
  // eslint-disable-next-line no-control-regex
  const t = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim()
  if (t) send(c, t)
}

/** One line of what the tool is doing; a no-op outside a channel or for an empty line. */
export function reportLine(text: string): void {
  const c = channel.getStore()
  if (c) lineTo(c, text)
}

/** How far along the tool is (0..1), with what it is doing; throttled (see the module comment). */
export function reportProgress(fraction: number, text?: string): void {
  const c = channel.getStore()
  if (!c || !Number.isFinite(fraction)) return
  const f = Math.min(1, Math.max(0, fraction))
  const at = c.now()
  if (f < 1 && at - c.lastProgressAt < PROGRESS_EVERY_MS) return
  c.lastProgressAt = at
  const words = text?.replace(/\s+/g, ' ').trim()
  send(c, `${Math.round(f * 100)}%${words ? ` · ${words}` : ''}`)
}

export interface LineSplitter {
  /** a chunk of output (a string, or bytes as UTF-8) */
  push(chunk: string | Uint8Array): void
  /** the last line, when the output did not end with a newline */
  end(): void
}

/** Chunks to lines: each whole line (without its \n or \r\n) goes to `emit`. A carriage return alone (a progress bar
 * redrawing itself) ends a line too. A line longer than `max` is emitted in pieces. */
export function lineSplitter(emit: (line: string) => void, max = 4_000): LineSplitter {
  let buf = ''
  const decoder = new TextDecoder()
  const out = (l: string): void => { try { emit(l) } catch { /* the emitter's own */ } }
  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      for (;;) {
        const i = buf.search(/\r\n|\n|\r(?!$)/)
        if (i < 0) break
        out(buf.slice(0, i))
        buf = buf.slice(buf.startsWith('\r\n', i) ? i + 2 : i + 1)
      }
      while (buf.length > max) { out(buf.slice(0, max)); buf = buf.slice(max) }
    },
    end() {
      buf += decoder.decode()
      const rest = buf.replace(/\r$/, '')
      buf = ''
      if (rest) out(rest)
    },
  }
}

/**
 * A finished program's output, its last `maxLines` lines, to the open channel: for helpers whose program ran where its
 * output could not be followed live (a job on the GPU or CPU queue, src/gpu/jobs.ts). A no-op outside a channel.
 */
export function reportOutput(text: string, maxLines = 200): void {
  const c = channel.getStore()
  if (!c || !text) return
  const lines = text.split(/\r\n|\n|\r/).map((l) => l.trim()).filter(Boolean)
  if (lines.length > maxLines) send(c, `… ${lines.length - maxLines} earlier lines`)
  for (const l of lines.slice(-maxLines)) lineTo(c, l)
}

/**
 * Splitters for a child's stdout and stderr that write each line to the channel open now; null outside one. The
 * channel is taken when this is called (inside the tool), so the child's 'data' events reach it whatever async
 * context they fire in.
 */
export function forwardOutput(): { stdout: LineSplitter; stderr: LineSplitter; end(): void } | null {
  const c = channel.getStore()
  if (!c) return null
  const stdout = lineSplitter((l) => lineTo(c, l))
  const stderr = lineSplitter((l) => lineTo(c, l))
  return { stdout, stderr, end: () => { stdout.end(); stderr.end() } }
}

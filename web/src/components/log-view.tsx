/**
 * One log viewer for everything trace runs (docs/progress-and-logs.md, "3. Watch"): a check's build, a specialist's
 * job, a tool call. It reads `run.log` from its cursor and keeps what it has read (at most MAX_KEPT lines, the
 * earliest dropped first: Download fetches the whole log again), follows the newest line until the person scrolls up,
 * finds in the log, wraps long lines, jumps to the first problem (warnings and errors are marked), and downloads the
 * log as a text file.
 *
 * When to read on: log.appended names the repo (lib/live.ts `logTicks`), so nothing polls while the live connection is
 * up; while it is down, every POLL_MS with the next look said in the footer. A run that is `done` is not read again.
 *
 * useRunLog is the reading on its own (the Watch sheet and a running tool card use it); LogPanel draws what it read;
 * LogView is both.
 */
import { ArrowDown, ChevronDown, ChevronUp, Download, Search, TriangleAlert, WrapText } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { call } from '@/lib/api'
import { duration } from '@/lib/format'
import { nextLookWords, useLiveStatus, useLogTick } from '@/lib/live'
import type { LogLine, RunLogResult } from '@/lib/types'
import { cn } from '@/lib/utils'
import { agoShort } from './heartbeat'
import { useNow } from './use-now'

/** The most lines kept in the page; earlier ones are dropped (Download fetches them all). */
export const MAX_KEPT = 5_000
/** How often an open log looks again while the live connection is down. */
export const POLL_MS = 3_000
/** Lines asked for per call (the API's default and most is 500 and 1000). */
const PAGE = 500
/** Pages read back to back before waiting for the next tick (a long log already written). */
const MAX_PAGES_AT_ONCE = 10

// ------------------------------------------------------------------ pure helpers

/** The kept lines after more arrive: at most `cap`, the earliest dropped; `trimmed` counts every line dropped so far. */
export function appendLines(kept: readonly LogLine[], add: readonly LogLine[], cap: number = MAX_KEPT, trimmedBefore = 0): { lines: LogLine[]; trimmed: number } {
  const all = add.length ? [...kept, ...add] : [...kept]
  const over = Math.max(0, all.length - cap)
  return { lines: over ? all.slice(over) : all, trimmed: trimmedBefore + over }
}

/** The indexes of the lines that contain `query` (any case); none for a blank query. */
export function findMatches(lines: readonly LogLine[], query: string): number[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: number[] = []
  lines.forEach((l, i) => { if (l.text.toLowerCase().includes(q)) out.push(i) })
  return out
}

/** Warnings and errors, and where the first problem is (the first error, else the first warning). */
export function problems(lines: readonly LogLine[]): { warns: number; errors: number; first: number | null } {
  let warns = 0
  let errors = 0
  let firstErr: number | null = null
  let firstWarn: number | null = null
  lines.forEach((l, i) => {
    if (l.mark === 'error') { errors++; firstErr ??= i }
    else if (l.mark === 'warn') { warns++; firstWarn ??= i }
  })
  return { warns, errors, first: firstErr ?? firstWarn }
}

/** "1 note", "3 notes", "1 problem", "2 problems · 1 note"; null when there is nothing to point at. */
export function problemWords(p: { warns: number; errors: number }): string | null {
  const parts: string[] = []
  if (p.errors) parts.push(`${p.errors} ${p.errors === 1 ? 'problem' : 'problems'}`)
  if (p.warns) parts.push(`${p.warns} ${p.warns === 1 ? 'note' : 'notes'}`)
  return parts.length ? parts.join(' · ') : null
}

/** A line's clock time, 10:44:02 (or 44:02 on a phone). */
export function clock(at: string, short = false): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return short ? `${p(d.getMinutes())}:${p(d.getSeconds())}` : `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** The log as the downloaded text file: one line each, its time first. */
export const logText = (lines: readonly LogLine[]): string => lines.map((l) => `${l.at}  ${l.text}`).join('\n') + '\n'

/** A file name for the download: "soil-sensor-check-5512.txt". */
export const logFileName = (repo: string, run: string): string => `${repo.split('/').pop() ?? 'trace'}-${run.replace(/[^A-Za-z0-9._-]+/g, '-')}.txt`

/** Hand the browser a file to save. */
export function saveText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

// ------------------------------------------------------------------ reading

export interface RunLog {
  repo: string
  run: string
  lines: LogLine[]
  /** lines dropped from the start to keep the page light */
  trimmed: number
  /** the newest answer, for its source, step, heardAt, note and admins' CloudWatch link */
  last: RunLogResult | null
  done: boolean
  error: unknown
  /** epoch ms of the last read */
  readAt: number
  /** whether the reader is waiting on its own clock (the live connection is down) */
  polling: boolean
  reading: boolean
  /** read on now (Try again) */
  readNow: () => void
}

/** Read one run's log from its cursor, on each log.appended for its repo, or every POLL_MS while not live. */
export function useRunLog(repo: string, run: string | null, o: { enabled?: boolean; cap?: number } = {}): RunLog {
  const enabled = (o.enabled ?? true) && !!run
  const cap = o.cap ?? MAX_KEPT
  const tick = useLogTick(repo)
  const live = useLiveStatus().state === 'live'
  const [st, setSt] = useState<{ lines: LogLine[]; trimmed: number; last: RunLogResult | null; done: boolean; error: unknown; readAt: number; reading: boolean }>(
    { lines: [], trimmed: 0, last: null, done: false, error: null, readAt: 0, reading: false },
  )
  const cursor = useRef<string | null>(null)
  const busy = useRef(false)
  const again = useRef(false)
  const doneRef = useRef(false)
  const key = `${repo} ${run}`
  const keyRef = useRef(key)
  keyRef.current = key

  // a different run starts from the beginning (only when the run changes: StrictMode's second mount keeps the reading)
  const shownKey = useRef(key)
  if (shownKey.current !== key) {
    shownKey.current = key
    cursor.current = null
    doneRef.current = false
    again.current = false
    busy.current = false
  }
  const [stKey, setStKey] = useState(key)
  if (stKey !== key) {
    setStKey(key)
    setSt({ lines: [], trimmed: 0, last: null, done: false, error: null, readAt: 0, reading: false })
  }

  const read = useCallback(async () => {
    if (!enabled || !run || doneRef.current) return
    if (busy.current) { again.current = true; return }
    busy.current = true
    setSt((s) => ({ ...s, reading: true }))
    const mine = key
    try {
      for (let page = 0; page < MAX_PAGES_AT_ONCE; page++) {
        const r = await call('run.log', { repo, run, ...(cursor.current ? { after: cursor.current } : {}), limit: PAGE })
        if (mine !== keyRef.current) return
        if (r.next) cursor.current = r.next
        doneRef.current = r.done
        setSt((s) => {
          const a = appendLines(s.lines, r.lines, cap, s.trimmed)
          return { ...s, lines: a.lines, trimmed: a.trimmed, last: r, done: r.done, error: null, readAt: Date.now() }
        })
        if (r.done || r.lines.length < PAGE) break
      }
    } catch (e) {
      if (mine === keyRef.current) setSt((s) => ({ ...s, error: e, readAt: Date.now() }))
    } finally {
      busy.current = false
      if (mine === keyRef.current) setSt((s) => ({ ...s, reading: false }))
      if (again.current) { again.current = false; void read() }
    }
  }, [enabled, run, repo, key, cap])

  // first read, and every time the repo's logs grow
  useEffect(() => { void read() }, [read, tick])
  // the live connection is down: look every POLL_MS
  const polling = enabled && !live && !st.done
  useEffect(() => {
    if (!polling) return
    const t = setInterval(() => void read(), POLL_MS)
    return () => clearInterval(t)
  }, [polling, read])

  return { repo, run: run ?? '', ...st, polling, readNow: () => void read() }
}

// ------------------------------------------------------------------ drawing

const MARK_CLS: Record<string, string> = {
  step: 'text-log-step',
  ok: 'text-log-ok',
  warn: 'bg-log-warn-bg text-log-warn',
  error: 'bg-log-error-bg text-log-error',
}

/** The line's text with the find's matches marked. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim()
  if (!q) return <>{text}</>
  const out: ReactNode[] = []
  const low = text.toLowerCase()
  const ql = q.toLowerCase()
  let i = 0
  let k = 0
  for (;;) {
    const j = low.indexOf(ql, i)
    if (j < 0) break
    if (j > i) out.push(text.slice(i, j))
    out.push(<mark key={k++} className="match">{text.slice(j, j + q.length)}</mark>)
    i = j + q.length
  }
  out.push(text.slice(i))
  return <>{out}</>
}

export interface LogPanelProps {
  log: RunLog
  /** right of the footer: where it runs ("Build machine: AWS CodeBuild") */
  where?: string
  /** phone: times as mm:ss, the toolbar's find folded */
  compact?: boolean
  /** hide the toolbar (the phone's Steps/Log toggle carries the problems button) */
  toolbar?: boolean
  className?: string
  /** the panel's height (CSS); default fills its parent */
  height?: string
}

export function LogPanel({ log, where, compact, toolbar = true, className, height }: LogPanelProps) {
  const live = useLiveStatus().state === 'live'
  const now = useNow(1000)
  const box = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(true)
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const [saving, setSaving] = useState(false)
  const matches = useMemo(() => findMatches(log.lines, query), [log.lines, query])
  const probs = useMemo(() => problems(log.lines), [log.lines])
  const probWords = problemWords(probs)

  // follow the newest line
  useEffect(() => {
    const el = box.current
    if (follow && el) el.scrollTop = el.scrollHeight
  }, [log.lines, follow, wrap])

  const onScroll = () => {
    const el = box.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (bottom !== follow) setFollow(bottom)
  }
  const show = (i: number) => {
    setFollow(false)
    const el = box.current?.querySelector<HTMLElement>(`[data-i="${i}"]`)
    el?.scrollIntoView({ block: 'center' })
  }
  const jumpNewest = () => {
    setFollow(true)
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }
  const step = (d: 1 | -1) => {
    if (!matches.length) return
    const n = (at + d + matches.length) % matches.length
    setAt(n)
    show(matches[n]!)
  }
  useEffect(() => { setAt(0); if (matches.length) show(matches[0]!) }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  const download = async () => {
    setSaving(true)
    let lines: LogLine[] = log.lines
    // the page keeps only the newest lines: fetch them all again for the file
    if (log.trimmed > 0) {
      try {
        const all: LogLine[] = []
        let after: string | null = null
        for (let i = 0; i < 200; i++) {
          const r: RunLogResult = await call('run.log', { repo: log.repo, run: log.run, ...(after ? { after } : {}), limit: 1000 })
          all.push(...r.lines)
          if (r.done || !r.next || r.lines.length < 1000) break
          after = r.next
        }
        if (all.length >= lines.length) lines = all
      } catch {
        // the kept lines, then
      }
    }
    saveText(logFileName(log.repo, log.run), logText(lines))
    setSaving(false)
  }

  const current = matches.length ? matches[Math.min(at, matches.length - 1)] : null
  const heard = log.last?.heardAt ?? log.lines.at(-1)?.at ?? null
  const nextLook = log.polling ? nextLookWords(log.readAt, POLL_MS, now) : null

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {toolbar && (
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <h3 className="section-label flex-1">What it's saying</h3>
          <div className="flex h-8 items-center gap-1 rounded-md border bg-background px-2 text-sm focus-within:ring-2 focus-within:ring-ring/50">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find in log" aria-label="Find in log"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1) } }}
              className={cn('min-w-0 bg-transparent outline-none placeholder:text-muted-foreground', compact ? 'w-24' : 'w-36')}
            />
            {query.trim() && (
              <>
                <span className="shrink-0 text-xs text-muted-foreground" aria-live="off">{matches.length ? `${at + 1} of ${matches.length}` : 'none'}</span>
                <button type="button" className="rounded p-0.5 hover:bg-muted disabled:opacity-40" disabled={!matches.length} onClick={() => step(-1)} aria-label="Previous match"><ChevronUp className="size-3.5" /></button>
                <button type="button" className="rounded p-0.5 hover:bg-muted disabled:opacity-40" disabled={!matches.length} onClick={() => step(1)} aria-label="Next match"><ChevronDown className="size-3.5" /></button>
              </>
            )}
          </div>
          <Button variant="outline" size="icon-sm" aria-label={wrap ? 'Do not wrap long lines' : 'Wrap long lines'} aria-pressed={wrap} title="Wrap long lines" onClick={() => setWrap((w) => !w)}>
            <WrapText />
          </Button>
          {probWords && (
            <Button variant="outline" size="sm" className={cn('h-8', probs.errors ? 'text-destructive' : '')} onClick={() => probs.first !== null && show(probs.first)} aria-label={`${probWords}: show the first`}>
              <TriangleAlert /> {probWords}
            </Button>
          )}
          <Button variant="outline" size="icon-sm" aria-label="Download the log" title="Download the log" disabled={saving || !log.lines.length} onClick={() => void download()}>
            <Download />
          </Button>
        </div>
      )}

      <div className="relative min-h-0 flex-1" style={height ? { height } : undefined}>
        <div
          ref={box}
          onScroll={onScroll}
          tabIndex={0}
          role="log"
          aria-label="The log"
          className={cn('h-full min-h-40 overflow-auto rounded-lg bg-log p-3 font-mono text-[12px] leading-5 text-log-foreground focus-visible:outline-2 focus-visible:outline-ring', !wrap && 'whitespace-pre')}
        >
          {log.trimmed > 0 && <p className="mb-1 text-log-muted">{log.trimmed.toLocaleString('en-GB')} earlier lines trimmed: download for all.</p>}
          {log.lines.length === 0 ? (
            <p className="text-log-muted">{log.error ? 'trace could not read this log just now.' : log.last?.note ?? (log.last ? (log.done ? 'It said nothing.' : 'Nothing said yet. Lines appear here as they are written.') : 'Reading the log…')}</p>
          ) : (
            log.lines.map((l, i) => (
              <div key={i + log.trimmed} data-i={i} className={cn('flex gap-3 [content-visibility:auto] [contain-intrinsic-size:auto_20px]', i === current && 'outline outline-1 outline-log-warn')}>
                <span className="shrink-0 select-none text-log-muted">{clock(l.at, compact)}</span>
                <span className={cn(wrap ? 'min-w-0 whitespace-pre-wrap break-words' : 'whitespace-pre', l.mark && MARK_CLS[l.mark], (l.mark === 'warn' || l.mark === 'error') && 'rounded-sm px-0.5')}>
                  <Highlighted text={l.text} query={query} />
                </span>
              </div>
            ))
          )}
        </div>
        {log.lines.length > 0 && (!follow || compact) && (
          <button
            type="button"
            onClick={jumpNewest}
            className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs shadow-md"
          >
            <ArrowDown className="size-3.5" aria-hidden />
            {follow ? 'Following the newest line' : 'Jump to newest'}
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5" role="status" aria-live="polite">
          <span className={cn('size-2 rounded-full', log.done ? 'bg-waived' : live ? 'bg-verified' : 'bg-warning')} aria-hidden />
          <span className="text-foreground">{log.done ? 'Finished' : live ? 'Live' : 'Not live'}</span>
        </span>
        <span>
          {log.done
            ? `· ${log.lines.length + log.trimmed} ${log.lines.length + log.trimmed === 1 ? 'line' : 'lines'}`
            : heard ? `· newest line ${agoShort(heard, now)}` : ''}
          {nextLook && ` · ${nextLook}`}
        </span>
        {!compact && !log.done && <span className="flex-1">{follow ? '· following the newest line' : ''}</span>}
        {(compact || log.done) && <span className="flex-1" />}
        {log.error != null && <button type="button" className="text-primary hover:underline" onClick={log.readNow}>Try again</button>}
        {where && <span>{where}</span>}
      </div>
    </div>
  )
}

/** A run's log, read and drawn. */
export function LogView({ repo, run, ...rest }: { repo: string; run: string } & Omit<LogPanelProps, 'log'>) {
  const log = useRunLog(repo, run)
  return <LogPanel log={log} {...rest} />
}

/** "3 min so far, usually 6" / "1 min so far, about 2 left" / "48 s so far". Pure. */
export function timeAgainstUsual(startedAt: string | null | undefined, typicalS: number | null | undefined, now: number): string | null {
  if (!startedAt) return null
  const el = Math.max(0, (now - Date.parse(startedAt)) / 1000)
  const so = `${duration(el, { short: true })} so far`
  if (!typicalS) return so
  if (el <= typicalS * 0.5) return `${so}, usually ${duration(typicalS, { short: true })}`
  if (el < typicalS) return `${so}, about ${duration(typicalS - el, { short: true })} left`
  return `${so}, usually ${duration(typicalS, { short: true })}`
}

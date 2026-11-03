/**
 * A run's steps (docs/ui/phone-results.md, "A run shows its steps"). The API gives the run's `session`: every tool
 * call of the same agent job, oldest first, with what went in and came out for some. An older answer (and some mock
 * runs) gives `steps` instead, the run's own timeline; `stepsOf` reads either into one list, preferring the session.
 * The step this page is about is marked; a failed step opens to show what went in and what came out.
 */
import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { StatusBadge } from '@/components/status-badge'
import { Term } from '@/components/term'
import { duration, time } from '@/lib/format'
import type { RunRecordView } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

export interface StepLine {
  id: string
  title: string
  /** the tool's own name, when the step is a tool call ("kicad.route") */
  kind?: string
  state: 'done' | 'running' | 'queued' | 'failed' | 'skipped'
  detail?: string
  /** seconds since the epoch, when known */
  started?: number
  durationS?: number
  progress?: number
  /** the step this page is about */
  here?: boolean
  args?: unknown
  result?: unknown
}

const SESSION_STATE = { running: 'running', pass: 'done', fail: 'failed', error: 'failed' } as const

/** The run's steps: its session's tool calls when the API gives them, else its own steps. */
export function stepsOf(r: Pick<RunRecordView, 'id' | 'session' | 'steps'>, now = Date.now() / 1000): StepLine[] {
  if (r.session?.steps.length)
    return r.session.steps.map((s) => ({
      id: s.id, title: s.summary ?? s.kind, kind: s.kind, state: SESSION_STATE[s.status] ?? 'done', started: s.started,
      durationS: (s.finished ?? now) - s.started, here: s.id === r.id,
      ...(s.args !== undefined ? { args: s.args } : {}), ...(s.result !== undefined ? { result: s.result } : {}),
    }))
  return (r.steps ?? []).map((s) => ({ ...s }))
}

/** JSON as people can read it, cut short. */
export function pretty(v: unknown, max = 4000): string {
  let t: string
  if (typeof v === 'string') {
    // the API cuts long JSON to text: show it parsed when it still parses
    try { t = JSON.stringify(JSON.parse(v), null, 2) } catch { t = v }
  } else t = JSON.stringify(v, null, 2) ?? String(v)
  return t.length > max ? `${t.slice(0, max)}\n…` : t
}

export function RunSteps({ steps }: { steps: StepLine[] }) {
  return (
    <ol className="space-y-0">
      {steps.map((s, i) => <StepRow key={s.id} step={s} last={i === steps.length - 1} />)}
    </ol>
  )
}

function StepRow({ step: s, last }: { step: StepLine; last: boolean }) {
  const done = s.state === 'done'
  const running = s.state === 'running'
  const failed = s.state === 'failed'
  const opens = s.args !== undefined || s.result !== undefined
  const [open, setOpen] = useState(failed && opens)
  const when = (
    <span className="shrink-0 text-xs">
      {done ? <span className="font-mono text-muted-foreground">{duration(s.durationS ?? 0, { short: true })}</span>
        : running ? <span className="text-primary">Running · {duration(s.durationS ?? 0, { short: true })}</span>
        : <StatusBadge status={failed ? 'failing' : 'queued'} label={failed ? 'Failed' : s.state === 'skipped' ? 'Skipped' : undefined} />}
    </span>
  )
  const title = (
    <span className="min-w-0 flex-1">
      <span className={cn('block text-sm', (running || s.here) && 'font-medium', s.state === 'queued' && 'text-muted-foreground')}>
        <Term>{s.title}</Term>
        {s.here && <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">This run</span>}
      </span>
      <span className="block text-xs text-muted-foreground">
        {s.started ? time(s.started * 1000) : null}
        {s.started && s.kind ? ' · ' : null}
        {s.kind && <span className="font-mono">{s.kind}</span>}
        {s.detail ? `${s.started || s.kind ? ' · ' : ''}${s.detail}` : null}
      </span>
    </span>
  )
  return (
    <li className="relative flex gap-3 pb-4">
      {!last && <span className="absolute left-[9px] top-6 h-[calc(100%-18px)] w-px bg-border" aria-hidden />}
      <span className={cn('z-[1] mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 bg-background', done && 'border-foreground bg-foreground text-background', running && 'border-primary', failed && 'border-destructive bg-destructive/10', s.here && !done && 'ring-2 ring-primary/30')} aria-hidden>
        {done && <Check className="size-3" strokeWidth={3} />}
      </span>
      <div className="min-w-0 flex-1">
        {opens ? (
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="-mx-1 flex w-[calc(100%+0.5rem)] items-start gap-2 rounded-md px-1 text-left hover:bg-muted/60">
            {title}
            {when}
            {open ? <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /> : <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />}
          </button>
        ) : (
          <div className="flex items-start gap-2">{title}{when}</div>
        )}
        {running && s.progress !== undefined && (
          <div className="mt-2 h-1 max-w-xs overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${s.progress * 100}%` }} /></div>
        )}
        {open && opens && (
          <div className="mt-2 space-y-2">
            {s.args !== undefined && <Json label="What went in" value={s.args} />}
            {s.result !== undefined && <Json label="What came out" value={s.result} />}
          </div>
        )}
      </div>
    </li>
  )
}

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words">{pretty(value)}</pre>
    </div>
  )
}

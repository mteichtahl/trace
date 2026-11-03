/**
 * Watch: the one sheet for a check's build, a specialist's job and a tool call (docs/progress-and-logs.md, "3. Watch").
 * A one-line summary of what it is doing now, a progress bar or its time against the usual, the steps with their
 * times, then the log (LogPanel), following the newest line. A right sheet (640 px) on a wide screen; a full-height
 * drawer on a phone, with Steps and Log as a toggle. Admins' "…" holds Open in CloudWatch when the log has a stream.
 *
 * The steps: a check's from change.runs (GitHub's jobs API: named, live); otherwise from the log's own step lines
 * ("▸ name"), each lasting until the next one starts.
 */
import { CircleCheck, CircleX, Circle, CircleMinus, ExternalLink, Loader2, MoreHorizontal } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useAuth } from '@/lib/auth'
import { duration } from '@/lib/format'
import type { CheckJob, CheckStep, LogLine, RunSummary } from '@/lib/types'
import { cn } from '@/lib/utils'
import { LogPanel, problemWords, problems, timeAgainstUsual, useRunLog } from './log-view'
import { useNow } from './use-now'

/** What the opener already knows about the run: shown at once, before the log has been read. */
export interface RunFacts {
  step?: string | null
  stepIndex?: number | null
  stepCount?: number | null
  startedAt?: string | null
  typicalS?: number | null
  /** 0..1 when the size is known */
  progress?: number | null
  /** a check: its job from change.runs, for its steps and its build machine */
  check?: CheckJob | null
  /** the run has ended */
  finished?: boolean
}

export interface RunSheetProps {
  repo: string
  /** job:<id>, tool:<runId>, check:<GitHub job id>; null: closed */
  run: string | null
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  facts?: RunFacts
}

export interface SheetStep { name: string; state: CheckStep['state']; seconds: number | null }

/** Steps from the log's step lines: each lasts until the next starts; the last runs on unless the run is done. Pure. */
export function stepsFromLines(lines: readonly LogLine[], done: boolean, now: number): SheetStep[] {
  const opens = lines.filter((l) => l.mark === 'step')
  const failed = lines.some((l) => l.mark === 'error')
  return opens.map((l, i) => {
    const start = Date.parse(l.at)
    const next = opens[i + 1]
    const end = next ? Date.parse(next.at) : done ? Date.parse(lines.at(-1)!.at) : now
    const last = !next
    return {
      name: l.text.replace(/^\s*▸\s*/, '').replace(/^Step \d+\s*·\s*/, ''),
      state: last ? (done ? (failed ? 'failed' : 'passed') : 'running') : 'passed',
      seconds: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, (end - start) / 1000) : null,
    }
  })
}

/** A check's steps from GitHub's jobs API. Pure. */
export function stepsFromCheck(job: CheckJob, now: number): SheetStep[] {
  return job.steps.map((s) => {
    const a = s.startedAt ? Date.parse(s.startedAt) : NaN
    const b = s.completedAt ? Date.parse(s.completedAt) : s.state === 'running' ? now : NaN
    return { name: s.name, state: s.state, seconds: Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, (b - a) / 1000) : null }
  })
}

/** 2:31 */
export const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** The newest line that says something (not a step's heading). */
export const newestWords = (lines: readonly LogLine[]): string | null => [...lines].reverse().find((l) => l.mark !== 'step' && l.text.trim())?.text ?? null

const STEP_ICON: Record<SheetStep['state'], { I: typeof Circle; cls: string; word: string }> = {
  passed: { I: CircleCheck, cls: 'text-foreground', word: 'done' },
  failed: { I: CircleX, cls: 'text-destructive', word: 'failed' },
  running: { I: Loader2, cls: 'animate-spin text-primary', word: 'running' },
  queued: { I: Circle, cls: 'text-muted-foreground/50', word: 'to come' },
  skipped: { I: CircleMinus, cls: 'text-waived', word: 'skipped' },
}

/** The steps: done ones with their times, the running one, and the rest folded into one line. */
export function StepList({ steps, usualLeftS }: { steps: SheetStep[]; usualLeftS?: number | null }) {
  if (!steps.length) return <p className="text-sm text-muted-foreground">Its steps show here once it names them.</p>
  const firstQueued = steps.findIndex((s) => s.state === 'queued')
  const shown = firstQueued >= 0 ? steps.slice(0, firstQueued + 1) : steps
  const more = firstQueued >= 0 ? steps.length - firstQueued - 1 : 0
  return (
    <ol className="space-y-0.5">
      {shown.map((s, i) => {
        const k = STEP_ICON[s.state]
        const rest = i === firstQueued
        return (
          <li key={i} className={cn('flex items-center gap-2.5 py-1 text-sm', s.state === 'running' && 'font-medium', rest && 'text-muted-foreground')}>
            <k.I className={cn('size-4 shrink-0', k.cls)} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{s.name}{rest && more > 0 ? `, and ${more} more` : ''}<span className="sr-only"> ({k.word})</span></span>
            <span className={cn('shrink-0 text-xs tabular-nums', s.state === 'running' ? 'text-primary' : 'text-muted-foreground')}>
              {s.state === 'running' ? `Running${s.seconds !== null ? ` · ${mmss(s.seconds)}` : ''}` : rest ? (usualLeftS ? `about ${duration(usualLeftS, { short: true })}` : '') : s.seconds !== null && s.state !== 'skipped' ? mmss(s.seconds) : ''}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

const whereOf = (c: CheckJob | null | undefined): string | undefined =>
  c?.runner === 'aws' ? 'Build machine: AWS CodeBuild' : c?.runner === 'github' ? "Build machine: GitHub's own" : undefined

export function RunSheet({ repo, run, title, open, onOpenChange, facts = {} }: RunSheetProps) {
  const phone = useMediaQuery('(max-width: 767px)')
  const admin = useAuth().user?.class === 'admin'
  const now = useNow(1000)
  const log = useRunLog(repo, run, { enabled: open })
  const [tab, setTab] = useState<'steps' | 'log'>('log')
  const check = facts.check ?? null
  const done = log.done || !!facts.finished || (check ? !['queued', 'running'].includes(check.state) : false)
  const steps = useMemo(() => (check?.steps.length ? stepsFromCheck(check, now) : stepsFromLines(log.lines, log.done, now)), [check, log.lines, log.done, now])
  const runningAt = steps.findIndex((s) => s.state === 'running')
  const stepIndex = facts.stepIndex ?? check?.stepIndex ?? (runningAt >= 0 ? runningAt + 1 : null)
  const stepCount = facts.stepCount ?? (check?.stepCount || null) ?? (steps.length || null)
  const stepName = facts.step ?? check?.step ?? log.last?.step ?? (runningAt >= 0 ? steps[runningAt]!.name : null)
  const startedAt = facts.startedAt ?? check?.startedAt ?? log.lines[0]?.at ?? null
  const typicalS = facts.typicalS ?? check?.typicalS ?? null
  const elapsed = startedAt ? (now - Date.parse(startedAt)) / 1000 : null
  const progress = facts.progress ?? (stepIndex && stepCount ? Math.max(0, (stepIndex - 1) / stepCount) : typicalS && elapsed !== null ? Math.min(0.95, elapsed / typicalS) : null)
  const newest = newestWords(log.lines) ?? check?.newest ?? null
  const timeWords = done ? (startedAt ? `took ${duration(((log.lines.at(-1) ? Date.parse(log.lines.at(-1)!.at) : now) - Date.parse(startedAt)) / 1000, { short: true })}` : null) : timeAgainstUsual(startedAt, typicalS, now)
  const usualLeft = typicalS && elapsed !== null && typicalS > elapsed ? typicalS - elapsed : null
  const probs = problemWords(problems(log.lines))
  const cloudwatch = admin ? log.last?.cloudwatch : undefined

  const summary = (
    <div className="space-y-2">
      {stepName && (
        <p className="text-sm font-medium">{stepIndex && stepCount ? `Step ${stepIndex} of ${stepCount} · ` : ''}{stepName}</p>
      )}
      {newest && <p className="line-clamp-2 text-sm text-muted-foreground">{newest}</p>}
      {(progress !== null || timeWords) && (
        <div className="flex items-center gap-3">
          {progress !== null && !done && (
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`${title} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
              <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
          {timeWords && <span className="shrink-0 text-xs text-muted-foreground">{timeWords}</span>}
        </div>
      )}
    </div>
  )

  const menu = cloudwatch ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="More for admins"><MoreHorizontal /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <a href={cloudwatch} target="_blank" rel="noreferrer"><ExternalLink /> Open in CloudWatch</a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null

  const heading = (Title: typeof SheetTitle | typeof DrawerTitle) => (
    <div className="flex items-center gap-2.5 pr-8">
      {done ? <CircleCheck className="size-5 shrink-0 text-muted-foreground" aria-hidden /> : <Loader2 className="size-5 shrink-0 animate-spin text-primary" aria-hidden />}
      <Title className="min-w-0 flex-1 truncate text-lg">{title}</Title>
      {menu}
    </div>
  )

  if (phone)
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="h-[100dvh] max-h-none rounded-none data-[vaul-drawer-direction=bottom]:mt-0 data-[vaul-drawer-direction=bottom]:max-h-none data-[vaul-drawer-direction=bottom]:rounded-none">
          <DrawerHeader className="border-b text-left">
            {heading(DrawerTitle)}
            <DrawerDescription className="sr-only">What it is doing, its steps and its log</DrawerDescription>
          </DrawerHeader>
          <div className="flex min-h-0 flex-1 flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
            {summary}
            <div className="mt-3 flex items-center gap-1.5" role="tablist" aria-label="Show">
              {(['steps', 'log'] as const).map((t) => (
                <button
                  key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                  className={cn('rounded-full border px-3 py-1 text-xs', tab === t ? 'border-foreground bg-foreground text-background' : 'bg-background')}
                >
                  {t === 'steps' ? 'Steps' : 'Log'}
                </button>
              ))}
              <span className="flex-1" />
              {probs && <span className="rounded-full border border-warning/50 bg-warning/15 px-3 py-1 text-xs text-warning-foreground">{probs}</span>}
            </div>
            <div className="mt-3 flex min-h-0 flex-1 flex-col">
              {tab === 'steps' ? <div className="overflow-y-auto"><StepList steps={steps} usualLeftS={usualLeft} /></div> : <LogPanel log={log} compact toolbar={false} className="flex-1" where={whereOf(check)} />}
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-[640px]">
        <SheetHeader className="gap-3 border-b px-6 pb-4 pt-5">
          {heading(SheetTitle)}
          <SheetDescription className="sr-only">What it is doing, its steps and its log</SheetDescription>
          {summary}
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-5 pt-4">
          <section aria-labelledby="run-steps" className="shrink-0">
            <h3 id="run-steps" className="section-label mb-1">Steps</h3>
            <StepList steps={steps} usualLeftS={usualLeft} />
          </section>
          <LogPanel log={log} where={whereOf(check)} className="mt-5 min-h-[360px] flex-1" />
        </div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * Watch for a list of run lines: `onWatch` for RunLine, and the sheet to render once beside the list. `repoOf` names the
 * run's project when the lines mix several (Agents); otherwise `repo`.
 */
export function useWatchRun(repo?: string): { onWatch: (run: RunSummary, repoOverride?: string) => void; sheet: ReactNode } {
  const [w, setW] = useState<{ run: RunSummary; repo: string } | null>(null)
  const onWatch = (run: RunSummary, repoOverride?: string) => {
    const r = repoOverride ?? run.repo ?? repo
    if (r) setW({ run, repo: r })
  }
  const sheet = w ? (
    <RunSheet
      repo={w.repo} run={`job:${w.run.id}`} title={w.run.agentName ? `${w.run.agentName}: ${w.run.title}` : w.run.title}
      open onOpenChange={(o) => !o && setW(null)}
      facts={{ step: w.run.step ?? null, stepIndex: w.run.stepIndex ?? null, stepCount: w.run.stepCount ?? null, startedAt: w.run.startedAt ?? null, typicalS: w.run.typicalS ?? null, progress: w.run.progress ?? null }}
    />
  ) : null
  return { onWatch, sheet }
}

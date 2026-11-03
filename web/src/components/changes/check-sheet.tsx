/**
 * A change's checks, each one openable (docs/ui/phone-results.md, "Every check opens"). `checksLine` is the one line
 * under a change's title on a phone; `ChecksSheet` lists the checks; `CheckSheet` opens one: a bottom drawer on a phone,
 * a side sheet when wide (SideSheet), the result first, then Result (the check's own report as markdown, its notes on
 * files as findings) and Log (the end of the build job's log, when the check is one), with previous and next check.
 * Admins get the check on GitHub under More. Data: change.check, asked again every 10 s while the check runs.
 */
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, CircleCheck, CircleDashed, CircleMinus, CircleX, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Markdown } from '@/components/chat/markdown'
import { MoreForAdmins } from '@/components/more-for-admins'
import { SideSheet } from '@/components/side-sheet'
import { type Status, StatusBadge } from '@/components/status-badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { duration, time } from '@/lib/format'
import { q } from '@/lib/queries'
import type { ChangeCheck, ChangeSummary, CheckAnnotation } from '@/lib/types'
import { cn } from '@/lib/utils'

export const CHECK_ICON: Record<ChangeCheck['state'], { icon: typeof CircleCheck; cls: string; word: string; status: Status }> = {
  passed: { icon: CircleCheck, cls: 'text-verified', word: 'passed', status: 'passed' },
  failed: { icon: CircleX, cls: 'text-destructive', word: 'failed', status: 'failing' },
  running: { icon: Loader2, cls: 'animate-spin text-muted-foreground', word: 'running', status: 'running' },
  skipped: { icon: CircleMinus, cls: 'text-waived', word: 'skipped', status: 'waived' },
}
const STATE_LABEL: Record<ChangeCheck['state'], string> = { passed: 'Passed', failed: 'Failed', running: 'Running', skipped: 'Skipped' }

/**
 * How the checks went, in one line: "7 of 7 checks passed", "1 failing", "3 still running", "1 failing, 3 still
 * running". From the list when there is one, else from the counts.
 */
export function checksLine(list: ChangeCheck[], counts?: ChangeSummary['checks']): string {
  const n = (s: ChangeCheck['state']) => list.filter((k) => k.state === s).length
  const c = list.length
    ? { total: list.length, passed: n('passed'), failed: n('failed'), running: n('running'), skipped: n('skipped') }
    : counts
  if (counts === null && !list.length) return 'trace could not read the checks'
  if (!c?.total) return 'No checks yet'
  const parts: string[] = []
  if (c.failed) parts.push(`${c.failed} failing`)
  if (c.running) parts.push(`${c.running} still running`)
  if (parts.length) return parts.join(', ')
  const counted = c.total - c.skipped
  return `${c.passed} of ${counted} ${counted === 1 ? 'check' : 'checks'} passed${c.skipped ? `, ${c.skipped} skipped` : ''}`
}

/** The worst state among the checks: what the line's icon shows. */
export function checksState(list: ChangeCheck[]): ChangeCheck['state'] | null {
  if (!list.length) return null
  if (list.some((k) => k.state === 'failed')) return 'failed'
  if (list.some((k) => k.state === 'running')) return 'running'
  return list.every((k) => k.state === 'skipped') ? 'skipped' : 'passed'
}

/** One check as a row that opens it: icon, name, its one line, chevron. */
export function CheckRow({ check: k, onOpen, className }: { check: ChangeCheck; onOpen: () => void; className?: string }) {
  const I = CHECK_ICON[k.state]
  return (
    <button type="button" onClick={onOpen} className={cn('flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted/60 active:bg-muted', className)}>
      <I.icon className={cn('mt-0.5 size-4 shrink-0', I.cls)} aria-hidden />
      <span className="min-w-0 flex-1">
        {k.name}{k.summary && <span className="text-muted-foreground">: {k.summary}</span>}<span className="sr-only"> ({I.word})</span>
      </span>
      <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  )
}

/** The list of every check (from the phone's one line), each opening its sheet. */
export function ChecksSheet({ open, onOpenChange, checks, counts, onPick }: { open: boolean; onOpenChange: (o: boolean) => void; checks: ChangeCheck[]; counts: ChangeSummary['checks']; onPick: (i: number) => void }) {
  return (
    <SideSheet open={open} onOpenChange={onOpenChange} title="Checks" description={checksLine(checks, counts)}>
      {checks.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><CircleDashed className="size-4" aria-hidden />{counts === null ? 'trace could not read the checks.' : 'No checks have run yet.'}</p>
      ) : (
        <ul className="-mx-2 space-y-0.5">
          {/* failing first, then running, then the rest: what needs attention leads */}
          {order(checks).map((i) => <li key={`${checks[i]!.name}-${i}`}><CheckRow check={checks[i]!} onOpen={() => onPick(i)} /></li>)}
        </ul>
      )}
    </SideSheet>
  )
}

const RANK: Record<ChangeCheck['state'], number> = { failed: 0, running: 1, passed: 2, skipped: 3 }
/** Indexes of the checks, failing first (stable). */
export const order = (checks: ChangeCheck[]): number[] => checks.map((_, i) => i).sort((a, b) => RANK[checks[a]!.state] - RANK[checks[b]!.state] || a - b)

const LEVEL: Record<CheckAnnotation['level'], { status: Status; label: string }> = {
  failure: { status: 'failing', label: 'Problem' },
  warning: { status: 'warning', label: 'Warning' },
  notice: { status: 'waiting', label: 'Note' },
}

/**
 * One check, opened. `index` picks it from `checks`; previous and next walk the list. A check with no id (a status
 * GitHub keeps) shows its one line and says there is nothing more to open.
 */
export function CheckSheet({ repo, number, checks, index, onIndex }: { repo: string; number: number; checks: ChangeCheck[]; index: number | null; onIndex: (i: number | null) => void }) {
  const k = index === null ? undefined : checks[index]
  const seq = order(checks)
  const at = index === null ? -1 : seq.indexOf(index)
  const go = (d: number) => { const i = seq[at + d]; if (i !== undefined) onIndex(i) }
  return (
    <SideSheet
      open={index !== null && !!k}
      onOpenChange={(o) => { if (!o) onIndex(null) }}
      title={k?.name ?? 'Check'}
      status={k ? <StatusBadge status={CHECK_ICON[k.state].status} label={STATE_LABEL[k.state]} className="shrink-0" /> : undefined}
      description={checks.length > 1 && at >= 0 ? `Check ${at + 1} of ${checks.length}` : undefined}
      footer={checks.length > 1 ? (
        <>
          <Button variant="outline" onClick={() => go(-1)} disabled={at <= 0}><ChevronLeft aria-hidden /> Previous check</Button>
          <Button variant="outline" onClick={() => go(1)} disabled={at < 0 || at >= seq.length - 1}>Next check <ChevronRight aria-hidden /></Button>
        </>
      ) : undefined}
    >
      {k && <CheckBody key={`${k.id ?? k.name}`} repo={repo} number={number} check={k} />}
    </SideSheet>
  )
}

function CheckBody({ repo, number, check: k }: { repo: string; number: number; check: ChangeCheck }) {
  const id = k.id ?? ''
  const d = useQuery({ ...q('change.check', { repo, number, id }), enabled: !!id, refetchInterval: (x) => ((x.state.data?.state ?? k.state) === 'running' ? 10_000 : false) })
  const [tab, setTab] = useState('result')
  const state = d.data?.state ?? k.state
  const summary = d.data?.summary ?? k.summary
  const took = d.data?.started_at && d.data.completed_at ? (Date.parse(d.data.completed_at) - Date.parse(d.data.started_at)) / 1000 : null
  const headline = (
    <div className={cn('rounded-lg px-4 py-3 text-[15px]', state === 'failed' ? 'bg-destructive/10' : 'bg-muted/60')} role="status">
      <span className="font-semibold">{STATE_LABEL[state]}. </span>
      {summary ?? (state === 'running' ? 'It has not finished yet.' : state === 'passed' ? 'Nothing to report.' : '')}
      {d.data?.started_at && (
        <span className="mt-1 block text-xs text-muted-foreground">
          {state === 'running' ? `Started ${time(d.data.started_at)}` : `${time(d.data.started_at)}${took !== null ? ` · took ${duration(took, { short: true })}` : ''}`}
        </span>
      )}
    </div>
  )
  if (!id)
    return (
      <div className="space-y-3">
        {headline}
        <p className="text-sm text-muted-foreground">This check only reports a result, with no report to open.</p>
      </div>
    )
  if (d.isError)
    return (
      <div className="space-y-3">
        {headline}
        <p className="text-sm text-muted-foreground">trace could not read this check&apos;s report. <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => void d.refetch()}>Try again</button></p>
      </div>
    )
  if (!d.data)
    return (
      <div className="space-y-3">{headline}<Skeleton className="h-24 rounded-lg" /><Skeleton className="h-40 rounded-lg" /></div>
    )
  const c = d.data
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">{headline}</div>
        <MoreForAdmins links={[c.url ? { label: 'This check on GitHub', href: c.url } : null]} />
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full">
          <TabsTrigger value="result">Result</TabsTrigger>
          <TabsTrigger value="log" disabled={!c.log}>Log</TabsTrigger>
        </TabsList>
        <TabsContent value="result" className="space-y-4 pt-2">
          {c.annotations.length > 0 && (
            <section aria-labelledby="check-findings">
              <h3 id="check-findings" className="section-label">What it found ({c.annotations.length})</h3>
              <ol className="mt-2 divide-y rounded-lg border">
                {c.annotations.map((a, i) => (
                  <li key={i} className="px-3 py-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={LEVEL[a.level].status} label={LEVEL[a.level].label} />
                      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{a.path}{a.line ? `, line ${a.line}` : ''}</span>
                    </div>
                    {a.title && <p className="mt-1 font-medium">{a.title}</p>}
                    <p className="mt-0.5 whitespace-pre-wrap">{a.message}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {c.text ? (
            <section aria-label="Its report" className="text-sm"><Markdown text={c.text} /></section>
          ) : (
            !c.annotations.length && <p className="text-sm text-muted-foreground">{c.state === 'running' ? 'The report appears when the check finishes.' : 'This check wrote no report.'}</p>
          )}
          {!c.log && <p className="text-xs text-muted-foreground">There is no log: this check is not a build job.</p>}
        </TabsContent>
        <TabsContent value="log" className="pt-2">
          {c.log && (
            <>
              {c.log.truncated && <p className="mb-2 text-xs text-muted-foreground">The end of the log, newest last.</p>}
              <pre className="max-h-[50dvh] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">{c.log.text}</pre>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

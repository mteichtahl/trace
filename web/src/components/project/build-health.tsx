/**
 * The build's health on the project overview (docs/stay-in-trace.md "3. A broken build, stuck work, asking for a
 * fix"), from health.get. The card appears only when the build is failing, or running again after a failure: a red
 * border and the pill "Failing" (or "Checking the fix"), what failed in plain words (trace's own look at it, else the
 * failing step), the end of the failing step's log, "Read the whole log" (a sheet with health.log's text), and "Watch
 * trace fix it" when trace's work on it is a job the app knows (it opens the agent doing it). A passing build shows
 * nothing.
 *
 * Under it, for people who may change the project: "Ask trace to fix something", a small dialog whose words become a
 * task (the `task` action; nothing is opened on GitHub), which then shows the job it started. The open requests for a
 * fix are listed briefly with where each stands (trace working on it, waiting its turn, or given up on: that one is
 * also under "Needs you" with what trace recommends).
 *
 * GitHub's own pages only in the admins' "More" menu (decision C).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Loader2, Wrench } from 'lucide-react'
import { useState } from 'react'
import { MoreForAdmins } from '@/components/more-for-admins'
import { RunLine } from '@/components/run-line'
import { SideSheet } from '@/components/side-sheet'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { call } from '@/lib/api'
import { ago } from '@/lib/format'
import { q } from '@/lib/queries'
import type { HealthView, RunSummary } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Whether the card shows: a failing build, or one running again with a failure before it. */
export const showsHealth = (h: HealthView | undefined): boolean => !!h && (h.build.state === 'failing' || (h.build.state === 'running' && h.build.failing.length > 0))

/** The line under the reason: trace's work on it, in words. */
export function fixingWords(h: HealthView['build'], job?: RunSummary): string {
  const f = h.fixing
  if (h.state === 'running') return 'trace is checking the build again now.'
  if (!f) return 'trace has not started on it yet. It usually does within a few minutes.'
  if (f.attempt >= f.of && !(job && (job.state === 'running' || job.state === 'queued'))) return `trace tried ${f.of} times and stopped. It is under Needs you with what trace recommends.`
  if (job?.state === 'queued') return `trace's fix waits its turn (try ${Math.max(1, f.attempt)} of ${f.of}).`
  if (job?.state === 'running' || f.attempt > 0) return `trace is fixing it (try ${Math.max(1, f.attempt)} of ${f.of}).`
  return 'trace is about to start on it.'
}

const ASK_WORDS: Record<HealthView['asks'][number]['state'], { status: 'working' | 'queued' | 'stuck'; label: string }> = {
  working: { status: 'working', label: 'trace is on it' },
  waiting: { status: 'queued', label: 'Waiting its turn' },
  stuck: { status: 'stuck', label: 'trace gave up: see Needs you' },
}

/** The whole log of one failing job (health.log), monospace and scrolling, in a side sheet. */
export function LogSheet({ repo, job, open, onOpenChange }: { repo: string; job: { job_id: number; name: string } | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const log = useQuery({ ...q('health.log', { repo, job_id: job?.job_id ?? 0 }), enabled: open && !!job, staleTime: 60_000 })
  return (
    <SideSheet open={open} onOpenChange={onOpenChange} title={job ? `The "${job.name}" log` : 'The log'} description={log.data?.truncated ? 'Its last 200 KB: the start is left out.' : 'Everything the step printed.'}>
      {log.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Reading the log…</p>
      ) : log.error ? (
        <p className="text-sm text-destructive">{log.error instanceof Error ? log.error.message : 'The log could not be read.'}</p>
      ) : (
        <pre className="max-h-[70dvh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre" data-testid="whole-log">{log.data?.text}</pre>
      )}
    </SideSheet>
  )
}

/** "Ask trace to fix something": the person's words become a task; the job it started is shown once it has one. */
export function AskForFix({ repo, jobs, className }: { repo: string; jobs: readonly RunSummary[]; className?: string }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState<{ id: string; title: string } | null>(null)
  const qc = useQueryClient()
  const send = async () => {
    const request = text.trim()
    if (request.length < 5) return
    setBusy(true)
    setError(null)
    try {
      const r = await call('task', { repo, request })
      if (!r.accepted) throw new Error(r.reason ?? 'trace did not take the request.')
      setStarted({ id: r.jobId, title: request })
      setText('')
      setOpen(false)
      void qc.invalidateQueries({ queryKey: ['journey.get', repo] })
      void qc.invalidateQueries({ queryKey: ['health.get', repo] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const run = started ? jobs.find((j) => j.id === started.id) ?? { id: started.id, repo, title: started.title, state: 'queued' as const } : null
  return (
    <div className={className}>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Wrench aria-hidden /> Ask trace to fix something
      </Button>
      {run && <RunLine run={run} className="mt-3 rounded-xl border bg-card" />}
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setError(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ask trace to fix something</DialogTitle>
            <DialogDescription>Say what is wrong and what you expect instead. trace picks the right specialist and starts on it.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="ask-fix">What should trace fix?</Label>
            <Textarea id="ask-fix" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="The power light is too bright on the bench: make it half as bright." />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => void send()} disabled={busy || text.trim().length < 5}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Ask trace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export interface BuildHealthProps {
  repo: string
  /** the project's jobs (journey.get's): trace's fix and an asked-for job are looked up here */
  jobs: readonly RunSummary[]
  /** may change the project: Ask trace to fix something */
  write: boolean
  className?: string
}

/** The card (when the build is failing), then the open requests and Ask trace to fix something. */
export function BuildHealth({ repo, jobs, write, className }: BuildHealthProps) {
  const h = useQuery({ ...q('health.get', { repo }), staleTime: 30_000, refetchInterval: 60_000 })
  const [log, setLog] = useState<{ job_id: number; name: string } | null>(null)
  const data = h.data
  const failing = showsHealth(data)
  const asks = data?.asks ?? []
  if (!data || (!failing && !asks.length && !write)) return null
  const b = data.build
  const fix = b.fixing?.job_id ? jobs.find((j) => j.id === b.fixing!.job_id) : undefined
  const first = b.failing[0]
  return (
    <div className={cn('mt-6 space-y-4', className)}>
      {failing && (
        <section aria-label="The build" className="rounded-xl border border-destructive/50 bg-destructive/5 p-5" data-testid="build-health">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">The build</h2>
            <StatusBadge status={b.state === 'running' ? 'running' : 'failing'} label={b.state === 'running' ? 'Checking the fix' : 'Failing'} />
            {b.at && <span className="text-xs text-muted-foreground">{ago(b.at)}</span>}
            <MoreForAdmins className="ml-auto" links={[{ label: 'The build on GitHub', href: `https://github.com/${repo}/actions` }]} />
          </div>
          <p className="mt-3 text-[15px] leading-relaxed">{b.why ?? 'The build failed.'}</p>
          <p className="mt-1 text-sm text-muted-foreground">{fixingWords(b, fix)}</p>
          {first?.tail && (
            <figure className="mt-4">
              <figcaption className="mb-1.5 text-xs text-muted-foreground">
                The end of {first.step ? `"${first.step}"` : `"${first.name}"`}
              </figcaption>
              <pre className="max-h-64 overflow-auto rounded-md border bg-background p-3 font-mono text-xs leading-relaxed whitespace-pre" data-testid="log-extract">{first.tail}</pre>
            </figure>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {b.failing.map((f) => (
              <Button key={f.job_id} variant="outline" size="sm" onClick={() => setLog(f)}>
                {b.failing.length > 1 ? `Read the whole "${f.name}" log` : 'Read the whole log'}
              </Button>
            ))}
            {b.fixing?.job_id && (fix?.agent ? (
              <Button size="sm" asChild>
                <Link to="/agents/$agent" params={{ agent: fix.agent }}>Watch trace fix it</Link>
              </Button>
            ) : (
              <Button size="sm" asChild>
                <a href="#s-trace-is-doing">Watch trace fix it</a>
              </Button>
            ))}
          </div>
          <LogSheet repo={repo} job={log} open={!!log} onOpenChange={(o) => !o && setLog(null)} />
        </section>
      )}
      {asks.length > 0 && (
        <section aria-label="Fixes you asked for">
          <h2 className="section-label mb-2">Fixes asked for ({asks.length})</h2>
          <ul className="divide-y rounded-xl border">
            {asks.map((a) => (
              <li key={a.number} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3" data-density-item>
                <p className="min-w-0 flex-1 text-sm">{a.title}</p>
                <StatusBadge plain status={ASK_WORDS[a.state].status} label={ASK_WORDS[a.state].label} />
                <span className="text-xs text-muted-foreground">asked {ago(a.opened_at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {write && <AskForFix repo={repo} jobs={jobs} />}
    </div>
  )
}

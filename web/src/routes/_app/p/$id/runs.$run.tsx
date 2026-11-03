/**
 * Run detail (/p/:id/runs/:run): the Run line at full size. The header names the run, where it runs and its current
 * step with progress, and holds Pause, Cancel and Move up. Below: the steps as a timeline with each step's duration;
 * once finished, the result at the top (the verdict in a sentence), the plots with their limit lines (Recharts, lazy),
 * the findings and the files; the hand-offs between specialists its job answers or raised (the request and the answer,
 * Decline for a pending one); and the agent's own log as a chat thread.
 *
 * Live: the run's job is read with `job`, whose key the live connection invalidates on job.updated; when the job's
 * version moves on, the run is read again. Nothing polls.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowUp, Check, ChevronRight, CircleX, FileText, Loader2, Pause, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useTraceContext } from '@/components/chat/context'
import { ToolRow } from '@/components/chat/cards'
import { Markdown } from '@/components/chat/markdown'
import { useCrumb } from '@/components/shell/breadcrumbs'
import { useCommands } from '@/components/shell/command-menu'
import { FindingsList } from '@/components/skills/findings'
import { FileSheet } from '@/components/files/file-viewer'
import type { FileRef } from '@/components/files/data'
import { kindLabel } from '@/components/files/kinds'
import { RunSteps, stepsOf } from '@/components/runs/run-steps'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useMediaQuery } from '@/hooks/use-media-query'
import { EmptyState, Loading, QueryError } from '@/components/states'
import { Term } from '@/components/term'
import { useNow } from '@/components/use-now'
import { call, repoOf } from '@/lib/api'
import { duration, eng, time } from '@/lib/format'
import { q, useAction, useProjects } from '@/lib/queries'
import type { RunRecordView } from '@/lib/types-s1'
import { RUN_STATUS } from './evidence'
import { HandoffRow, useDeclineHandoffs } from '@/components/handoff'

const PlotCard = lazy(() => import('@/components/chat/cards').then((m) => ({ default: m.PlotCard })))

/** What the artifact action returns at most (src/api/action-kit.ts MAX_ARTIFACT): a larger file is named, not opened. */
const MAX_RUN_FILE = 8 * 1024 * 1024

export const Route = createFileRoute('/_app/p/$id/runs/$run')({
  staticData: { crumb: 'Run' },
  component: RunPage,
})

function RunPage() {
  const { id, run: runId } = Route.useParams()
  const repo = repoOf(id)
  const qc = useQueryClient()
  const run = useAction('run', { repo, id: runId })
  const r = run.data as RunRecordView | undefined
  const job = useQuery({ ...q('job', { id: r?.jobId ?? '' }), enabled: !!r?.jobId && r.status === 'running' })
  const now = useNow(1000)
  // hand-offs between specialists that concern this run's job: the one it answers, and the ones it raised
  const jobs = useQuery({ ...q('jobs.list', { repo }), enabled: !!r?.jobId })
  const projects = useProjects()
  const decline = useDeclineHandoffs()
  const write = (projects.data?.find((p) => p.repo === repo)?.part ?? 'contributor') !== 'reviewer'
  const workerJob = r?.jobId?.split('.').at(-1)
  const answers = (jobs.data?.handoffs ?? []).filter((h) => workerJob && (h.workerJobId === workerJob || h.jobId === r?.jobId))
  const raised = (jobs.data?.handoffs ?? []).filter((h) => workerJob && (h.fromWorkerJobId === workerJob || h.fromJobId === r?.jobId))
  const [confirm, setConfirm] = useState(false)
  const phone = useMediaQuery('(max-width: 767px)')
  const [tab, setTab] = useState('result')
  const [file, setFile] = useState<FileRef | null>(null)
  useCrumb('/_app/p/$id/runs/$run', r?.title ?? runId)

  // the job moved on (a live job.updated invalidated it): read the run again
  const version = job.data?.version
  useEffect(() => {
    if (version != null) void qc.invalidateQueries({ queryKey: ['run', repo] })
  }, [version, qc, repo])

  // only what job.control can do for this job (its view's controls); a refusal says why in plain words
  const can = (op: 'pause' | 'cancel' | 'move_up') => (job.data?.controls ?? []).includes(op)
  const control = async (op: 'pause' | 'cancel' | 'move_up') => {
    if (!r?.jobId) return
    try {
      const res = await call('job.control', { id: r.jobId, op })
      if (!res.ok) { toast(`Could not ${op === 'move_up' ? 'move it up' : op}.`, { description: res.reason }); return }
      toast(op === 'pause' ? 'Paused. Resume any time.' : op === 'move_up' ? 'Moved up the queue.' : `Cancelled: ${r.title ?? r.kind}`, { description: res.kept })
      void qc.invalidateQueries({ queryKey: ['job'] })
    } catch (e) {
      toast.error(`Could not ${op === 'move_up' ? 'move it up' : op}.`, { description: e instanceof Error ? e.message : String(e) })
    }
  }

  useTraceContext(r ? { label: r.id, description: 'The run the person is looking at', value: { id: r.id, kind: r.kind, status: r.status, summary: r.summary }, mono: true } : null, 'run')
  useCommands(r?.status === 'running' ? [
    ...(can('pause') ? [{ id: 'run-pause', label: 'Pause this run', run: () => void control('pause') }] : []),
    ...(can('cancel') ? [{ id: 'run-cancel', label: 'Cancel this run', run: () => setConfirm(true) }] : []),
  ] : [])

  if (run.isError) return <div className="mt-6"><QueryError error={run.error} what="this run" onRetry={() => void run.refetch()} /></div>
  if (!r)
    return (
      <Loading loading={run.isLoading}>
        <div className="mt-6 space-y-4"><Skeleton className="h-36 rounded-xl" /><Skeleton className="h-64 rounded-xl" /></div>
      </Loading>
    )

  const running = r.status === 'running'
  const st = RUN_STATUS[r.status]
  const elapsed = (r.finished ?? now / 1000) - r.started
  const current = r.steps?.find((s) => s.state === 'running')
  const idx = r.steps ? r.steps.indexOf(current!) : -1
  const progress = current?.progress
  const steps = stepsOf(r, now / 1000)
  const files = r.artifacts ?? []

  return (
    <div className="pb-12">
      <section className="mt-6 rounded-xl border p-5 md:p-6" aria-labelledby="run-title">
        <div className="flex flex-wrap items-start gap-3">
          {running ? <Loader2 className="mt-1.5 size-5 animate-spin text-primary" aria-hidden /> : r.status === 'pass' ? <Check className="mt-1.5 size-5 text-verified" aria-hidden /> : <CircleX className="mt-1.5 size-5 text-destructive" aria-hidden />}
          <div className="min-w-0 flex-1">
            <h1 id="run-title" className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight">
              {r.title ?? r.kind}
              {r.where && <span className="rounded-md border px-2 py-0.5 text-xs font-normal text-muted-foreground">{r.where}</span>}
              <span className="font-mono text-xs font-normal text-muted-foreground">{r.id}</span>
            </h1>
            {running && current && <p className="mt-1.5 text-[15px]">Step {idx + 1} of {r.steps!.length}: <Term>{current.title}</Term>{current.detail ? ` · ${current.detail}` : ''}</p>}
            <p className="mt-1 text-sm text-muted-foreground">
              {running ? `${duration(elapsed, { short: true })} so far${r.typicalS ? `, usually ${duration(r.typicalS, { short: true })}` : ''}` : `${st.label} · took ${duration(elapsed, { short: true })} · ${time(r.started * 1000)}`}
            </p>
            {running && progress !== undefined && (
              <div className="mt-3 flex max-w-xl items-center gap-3">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Progress">
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress * 100}%` }} />
                </div>
                <span className="font-mono text-xs text-muted-foreground">{Math.round(progress * 100)}%</span>
              </div>
            )}
          </div>
          {running && r.jobId && (
            <div className="flex flex-wrap gap-2">
              {can('pause') && <Button variant="outline" onClick={() => void control('pause')}><Pause /> Pause</Button>}
              {can('cancel') && <Button variant="outline" onClick={() => setConfirm(true)}><X /> Cancel</Button>}
              {can('move_up') && <Button variant="outline" onClick={() => void control('move_up')}><ArrowUp /> Move up</Button>}
            </div>
          )}
        </div>
        {!running && r.summary && (
          <p className="mt-4 rounded-lg bg-muted/60 px-4 py-3 text-[15px]" role="status">
            <span className="font-semibold">{r.status === 'pass' ? 'Passed. ' : r.status === 'fail' ? 'Failed. ' : 'Stopped. '}</span>
            {r.summary}
          </p>
        )}
      </section>

      {(() => {
        const plotsEl = (r.plots?.length ?? 0) > 0 && (
          <section className="rounded-xl border p-5" aria-labelledby="plots">
            <h2 id="plots" className="text-lg font-semibold">Plots</h2>
            {r.plots!.map((p) => (
              <Suspense key={p.title} fallback={<Skeleton className="mt-3 h-56" />}>
                <PlotCard data={p} />
              </Suspense>
            ))}
          </section>
        )
        const stepsEl = (
          <section className="rounded-xl border p-5" aria-labelledby="steps">
            <div className="flex items-baseline justify-between gap-2">
              <h2 id="steps" className="text-lg font-semibold">Steps</h2>
              {r.session && <span className="text-xs text-muted-foreground">{r.session.agent ? `${r.session.agent} · ` : ''}{steps.length} in this job, oldest first</span>}
            </div>
            {steps.length ? <div className="mt-3"><RunSteps steps={steps} /></div> : <p className="mt-2 text-sm text-muted-foreground">{running ? 'Steps appear as the run reports them.' : 'This run reported no steps.'}</p>}
          </section>
        )
        const findingsEl = r.findings && r.findings.length > 0 && (
          <section aria-labelledby="findings">
            <h2 id="findings" className="mb-3 text-lg font-semibold">Findings</h2>
            <FindingsList findings={r.findings} />
          </section>
        )
        const handoffsEl = answers.length + raised.length > 0 && (
          <section className="rounded-xl border" aria-labelledby="handoffs">
            <h2 id="handoffs" className="px-5 pt-5 text-lg font-semibold">Hand-offs</h2>
            <p className="px-5 text-sm text-muted-foreground">
              {answers.length ? 'Another specialist asked for this job. ' : ''}{raised.length ? `It asked ${raised.length === 1 ? 'another specialist' : `${raised.length} times`} for an answer in their area.` : ''}
            </p>
            <div className="mt-2 divide-y border-t">
              {[...answers, ...raised].map((h) => (
                <HandoffRow key={h.id} handoff={h} defaultOpen={answers.includes(h)} {...(write ? { onDecline: (x, why) => decline(repo, x, why) } : {})} />
              ))}
            </div>
          </section>
        )
        const logEl = (
          <section className="rounded-xl border p-5" aria-labelledby="log">
            <div className="flex items-baseline justify-between gap-2">
              <h2 id="log" className="text-lg font-semibold">Agent log</h2>
              {r.log?.length ? <span className="text-xs text-muted-foreground">{r.log[0]!.who} · newest last</span> : null}
            </div>
            {!r.log?.length ? (
              <p className="mt-2 text-sm text-muted-foreground">{r.session ? 'The agent\'s own words are not kept with this run; its steps are under Steps.' : 'This run kept no agent log: it was a tool run, not an agent\'s work.'}</p>
            ) : (
              <ol className="mt-3 space-y-5">
                {r.log.map((m) => (
                  <li key={m.id}>
                    <p className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="flex size-4 items-center justify-center rounded bg-foreground font-mono text-[10px] font-semibold text-background">t</span>
                      {time(m.at)} · trace · {m.who}
                    </p>
                    <Markdown text={m.text} />
                    {m.tools?.map((t) => <ToolRow key={t} name="" args={{ step: t }} status="complete" summary={t} />)}
                  </li>
                ))}
                {running && current && <li className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> {current.detail ?? current.title}…</li>}
              </ol>
            )}
          </section>
        )
        const doEl = running && (
          <div className="rounded-xl border p-5 text-sm">
            <h2 className="font-semibold">What you can do</h2>
            <dl className="mt-3 space-y-3">
              {can('pause') && <div><dt className="font-medium">Pause</dt><dd className="text-muted-foreground">Keeps what is done. Resume any time.</dd></div>}
              <div><dt className="font-medium">Cancel</dt><dd className="text-muted-foreground">Stops within seconds and says what was kept: commits the agent already pushed stay on their branch.</dd></div>
              {can('move_up') && <div><dt className="font-medium">Move up the queue</dt><dd className="text-muted-foreground">Runs before your other waiting jobs.</dd></div>}
              {!can('pause') && <div><dt className="font-medium">Pause and Move up</dt><dd className="text-muted-foreground">Not available: a run is one agent session that cannot be held and resumed, and runs start as soon as they are asked for, so there is no queue to move up.</dd></div>}
            </dl>
          </div>
        )
        const measEl = (r.measurements?.length ?? 0) > 0 && (
          <div className="rounded-xl border p-5 text-sm">
            <h2 className="font-semibold">Measurements</h2>
            <dl className="mt-3 space-y-1.5">
              {r.measurements!.map((m) => (
                <div key={m.name} className="flex justify-between gap-3"><dt className="font-mono text-xs text-muted-foreground">{m.name}</dt><dd className="font-mono">{m.value === null ? '—' : m.unit ? eng(m.value, m.unit) : m.value}</dd></div>
              ))}
            </dl>
          </div>
        )
        const filesEl = (
          <div className="rounded-xl border p-5 text-sm">
            <h2 className="font-semibold">Files</h2>
            {files.length === 0 ? (
              <p className="mt-2 text-muted-foreground">{running ? 'Files appear as the run writes them.' : 'This run kept no files.'}</p>
            ) : (
              <ul className="-mx-2 mt-2 space-y-0.5">
                {files.map((a) => {
                  const big = a.size > MAX_RUN_FILE
                  const inner = (
                    <>
                      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-xs">{a.name}</span>
                        <span className="block text-xs text-muted-foreground">{big ? `Too large to open here (${eng(a.size, 'B')}; trace opens run files up to 8 MB)` : `${kindLabel(a.name)} · ${eng(a.size, 'B')}`}</span>
                      </span>
                    </>
                  )
                  return (
                    <li key={a.name}>
                      {big ? (
                        <div className="flex items-center gap-2 px-2 py-2">{inner}</div>
                      ) : (
                        <button type="button" onClick={() => setFile({ repo, path: `runs/${r.id}/${a.name}`, run: { id: r.id, name: a.name }, size: a.size })} className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/60 active:bg-muted">
                          {inner}
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
        const whereEl = (
          <div className="rounded-xl border p-5 text-sm">
            <h2 className="font-semibold">Where it runs</h2>
            <p className="mt-2 text-muted-foreground">{r.where ?? "On the project's agent"} · <span className="font-mono">{r.kind}</span>{r.git_sha ? <> on push <span className="font-mono">{r.git_sha}</span></> : null}</p>
            {r.requirement && <p className="mt-2">Judged against <Link to="/p/$id/requirements/$rid" params={{ id, rid: r.requirement }} className="font-mono text-primary hover:underline">{r.requirement}</Link></p>}
            {running && <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><span className="size-2 rounded-full bg-verified" aria-hidden /> Updates live as the job reports each step.</p>}
          </div>
        )
        if (phone)
          return (
            <Tabs value={tab} onValueChange={setTab} className="mt-4">
              <TabsList className="sticky top-14 z-10 w-full">
                <TabsTrigger value="result">Result</TabsTrigger>
                <TabsTrigger value="steps">Steps{steps.length ? ` (${steps.length})` : ''}</TabsTrigger>
                <TabsTrigger value="log">Log</TabsTrigger>
                <TabsTrigger value="files">Files{files.length ? ` (${files.length})` : ''}</TabsTrigger>
              </TabsList>
              <TabsContent value="result" className="space-y-4 pt-2">{doEl}{plotsEl}{findingsEl}{measEl}{handoffsEl}{whereEl}</TabsContent>
              <TabsContent value="steps" className="pt-2">{stepsEl}</TabsContent>
              <TabsContent value="log" className="pt-2">{logEl}</TabsContent>
              <TabsContent value="files" className="pt-2">{filesEl}</TabsContent>
            </Tabs>
          )
        return (
          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="min-w-0 space-y-6">
              {plotsEl}
              {steps.length > 0 && stepsEl}
              {findingsEl}
              {handoffsEl}
              {logEl}
            </div>
            <aside className="space-y-4">{doEl}{measEl}{filesEl}{whereEl}</aside>
          </div>
        )
      })()}

      <FileSheet file={file} open={!!file} onOpenChange={(o) => { if (!o) setFile(null) }} />

      {!steps.length && !r.log && !r.plots && !r.findings && !r.summary && <EmptyState className="mt-6">This run has not reported anything yet.</EmptyState>}

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {(r.title ?? r.kind).toLowerCase()}?</AlertDialogTitle>
            <AlertDialogDescription>It stops within seconds. Anything already finished is kept, and you will see what.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void control('cancel')}>Cancel the run</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * Review a change (/p/:id/changes/:number): what trace did in plain words, the files it touched in trace's own viewers
 * (schematics and boards in KiCanvas with Before / After, text as a diff, pictures side by side), its checks, the
 * requirements it covers, trace's recommendation with its reason, a note box for the specialist, and the decision bar
 * (Discard, Ask for changes, Accept into the design). Reviewers read it; the bar says why they cannot decide. "View on
 * GitHub" stays a small link.
 *
 * Data: change.get (asked for again every 15 s while checks run), change.diff per file, journey.get (step words).
 */
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { CircleCheck, CircleDashed, CircleMinus, CircleX, ExternalLink, Loader2, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useTraceContext } from '@/components/chat/context'
import { ChangeFileView } from '@/components/changes/change-file-view'
import { DecisionBar } from '@/components/changes/decision-bar'
import { useChangeActions } from '@/components/changes/use-change-actions'
import { TabSkeleton, useCoverage } from '@/components/project/shared'
import { Rich } from '@/components/rich'
import { useCrumb } from '@/components/shell/breadcrumbs'
import { QueryError } from '@/components/states'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { repoOf } from '@/lib/api'
import { ago } from '@/lib/format'
import { changeOf, checksWords, currentStage, nextPlace, recommendationWords, stepWords } from '@/lib/guided'
import { q, useJourney, useProjects } from '@/lib/queries'
import type { ChangeCheck, ChangeDetail, ChangeFile } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/p/$id/changes/$number')({
  staticData: { crumb: 'Change' },
  component: Review,
})

const FILE_TAG: Record<ChangeFile['kind'], string> = { schematic: 'Schematic', board: 'Board', parts: 'Parts list', text: 'Text', image: 'Picture', binary: 'File' }
const CHECK_ICON: Record<ChangeCheck['state'], { icon: typeof CircleCheck; cls: string; word: string }> = {
  passed: { icon: CircleCheck, cls: 'text-verified', word: 'passed' },
  failed: { icon: CircleX, cls: 'text-destructive', word: 'failed' },
  running: { icon: Loader2, cls: 'animate-spin text-muted-foreground', word: 'running' },
  skipped: { icon: CircleMinus, cls: 'text-waived', word: 'skipped' },
}

/** The file's name as people read it ("power.kicad_sch"), its folder dimmed. */
const fileName = (p: string) => p.split('/').pop() ?? p

function Review() {
  const { id, number: raw } = Route.useParams()
  const repo = repoOf(id)
  const number = Number(raw)
  const navigate = useNavigate()
  const j = useJourney(repo)
  const projects = useProjects()
  const part = projects.data?.find((p) => p.repo === repo)?.part
  const c = useQuery({ ...q('change.get', { repo, number }), refetchInterval: (x) => (x.state.data?.checks?.running ? 15_000 : false) })
  const actions = useChangeActions(repo)
  const coverage = useCoverage(repo)
  // the requirement's own words, from the coverage the Requirements tab reads (just the id when it has none)
  const reqText = (rid: string) => coverage.data?.requirements?.find((r) => r.id === rid || r.id.replace('-0', '') === rid.replace('-0', ''))?.text ?? ''
  const [note, setNote] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  useCrumb('/_app/p/$id/changes/$number', c.data?.title ?? `Change ${raw}`)
  useTraceContext({ label: c.data?.title ?? 'A change', description: 'The change the person is reviewing', value: c.data ? { number, title: c.data.title, files: c.data.files.map((f) => f.path), recommendation: c.data.recommendation } : { number } }, 'screen')

  if (c.isError) return <div className="mt-6"><QueryError error={c.error} what="this change" onRetry={() => void c.refetch()} /></div>
  if (!c.data) return <TabSkeleton loading={c.isLoading} />
  const d = c.data
  const file = d.files.find((f) => f.path === picked) ?? d.files[0]
  const stage = j.data ? currentStage(j.data) : null
  const place = j.data ? nextPlace(j.data) : null
  const forYou = d.verdict === 'ready' && part !== 'reviewer'
  const busy = actions.accept.isPending ? 'accept' : actions.ask.isPending ? 'ask' : actions.discard.isPending ? 'discard' : null
  // the next step is this change: its place in the stage, and what accepting moves
  const isNext = !!j.data && j.data.next.kind === 'review' && changeOf(j.data.next) === number
  const acceptSays = place && isNext ? `Accepting adds it to the design and moves ${place.stage} to step ${Math.min(place.total, place.index + 1)}.` : 'Accepting adds it to the design.'
  const back = () => void navigate({ to: '/p/$id', params: { id } })

  return (
    <div className="pt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium">
            <span className={cn('rounded px-1.5 py-0.5', forYou ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>
              {forYou ? 'For you' : d.state === 'open' ? 'Open' : d.state === 'merged' ? 'Accepted' : 'Discarded'}
              {stage && isNext && place ? ` · ${stepWords(place)}` : ''}
            </span>
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">{d.title}</h2>
          <p className="text-sm text-muted-foreground">From {d.from} · {ago(d.opened_at)} · change {d.number}{d.draft ? ' · a draft' : ''}</p>
        </div>
        {d.url && (
          <a href={d.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            View on GitHub <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-5">
          <section className="rounded-xl border bg-card p-5" aria-labelledby="did">
            <h3 id="did" className="section-label">What trace did</h3>
            {d.summary.length ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                {d.summary.map((s, i) => <li key={i}><Rich text={s} /></li>)}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">trace did not write a summary for this change; its files are below.</p>
            )}
          </section>

          <section className="grid overflow-hidden rounded-xl border bg-card md:grid-cols-[220px_minmax(0,1fr)]" aria-label="Files">
            <ul className="border-b md:border-b-0 md:border-r" aria-label={`${d.files.length} files changed`}>
              {d.files.map((f) => (
                <li key={f.path}>
                  <button
                    type="button" onClick={() => setPicked(f.path)} aria-current={f === file ? 'true' : undefined}
                    className={cn('flex w-full items-center gap-2 border-b px-3 py-2.5 text-left text-sm last:border-b-0', f === file ? 'bg-muted font-medium' : 'hover:bg-muted/50')}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate" title={f.path}>{fileName(f.path)}</span>
                      <span className="block text-xs font-normal text-muted-foreground">{FILE_TAG[f.kind]}</span>
                    </span>
                    <span className="shrink-0 font-mono text-xs">
                      {f.additions > 0 && <span className="text-verified">+{f.additions}</span>}
                      {f.deletions > 0 && <span className="ml-1 text-destructive">−{f.deletions}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="min-h-[380px] min-w-0">
              {file ? <ChangeFileView key={file.path} repo={repo} number={number} file={file} /> : <p className="p-5 text-sm text-muted-foreground">This change touches no files.</p>}
            </div>
          </section>

          {part !== 'reviewer' && d.state === 'open' && (
            <section className="rounded-xl border bg-card p-5">
              <Label htmlFor="change-note" className="section-label">Talk to {d.from}</Label>
              <Textarea id="change-note" rows={2} className="mt-2" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: use a 1 A regulator, we may add a radio later." />
              <p className="mt-1.5 text-xs text-muted-foreground">Your note goes with Ask for changes, or is kept with the decision when you accept.</p>
            </section>
          )}
        </div>

        <aside className="space-y-4">
          <Checks d={d} />
          <section className="rounded-xl border bg-card p-5" aria-labelledby="reqs">
            <h3 id="reqs" className="section-label">Requirements it covers</h3>
            {d.requirements.length ? (
              <ul className="mt-2 space-y-1 text-sm">
                {d.requirements.map((r) => (
                  <li key={r}><Link to="/p/$id/requirements/$rid" params={{ id, rid: r }} className="hover:underline"><span className="mr-2 font-mono text-xs text-muted-foreground">{r}</span>{reqText(r)}</Link></li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">This change does not name a requirement.</p>
            )}
          </section>
          <section className={cn('rounded-xl border p-5', d.recommendation.verdict === 'accept' ? 'border-primary/40 bg-primary-soft' : 'bg-card')} aria-labelledby="rec">
            <h3 id="rec" className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary"><Sparkles className="size-3.5" aria-hidden /> {recommendationWords(d.recommendation)}</h3>
            <p className="mt-2 text-sm">{d.recommendation.why || 'trace will recommend once the checks have run.'}</p>
          </section>
        </aside>
      </div>

      <DecisionBar
        className="mt-6"
        change={d}
        part={part}
        note={note}
        acceptSays={acceptSays}
        busy={busy}
        onAccept={(n) => actions.accept.mutate({ number, head: d.head.sha, title: d.title, ...(n ? { note: n } : {}), step: isNext ? place : null }, { onSuccess: back })}
        onAsk={(n) => actions.ask.mutate({ number, title: d.title, note: n, from: d.from }, { onSuccess: () => setNote('') })}
        onDiscard={(r) => actions.discard.mutate({ number, title: d.title, reason: r }, { onSuccess: back })}
      />
    </div>
  )
}

function Checks({ d }: { d: ChangeDetail }) {
  const [all, setAll] = useState(false)
  const list = d.checks_list
  const shown = all ? list : list.slice(0, 3)
  const rest = list.length - shown.length
  return (
    <section className="rounded-xl border bg-card p-5" aria-labelledby="checks">
      <h3 id="checks" className="section-label">Checks · {checksWords(d.checks)}</h3>
      {list.length === 0 ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><CircleDashed className="size-4" aria-hidden />{d.checks === null ? 'trace could not read the checks.' : 'No checks have run yet.'}</p>
      ) : (
        <ul className="mt-2 space-y-1.5 text-sm">
          {shown.map((k) => {
            const I = CHECK_ICON[k.state]
            return (
              <li key={k.name} className="flex items-start gap-2">
                <I.icon className={cn('mt-0.5 size-4 shrink-0', I.cls)} aria-hidden />
                <span>{k.name}{k.summary && <span className="text-muted-foreground">: {k.summary}</span>}<span className="sr-only"> ({I.word})</span></span>
              </li>
            )
          })}
          {rest > 0 && (
            <li>
              <button type="button" onClick={() => setAll(true)} className="flex items-center gap-2 text-sm">
                <CircleCheck className={cn('size-4', list.slice(3).every((k) => k.state === 'passed') ? 'text-verified' : 'text-muted-foreground')} aria-hidden />
                {rest} more {rest === 1 ? 'check' : 'checks'} <span className="text-primary">show</span>
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

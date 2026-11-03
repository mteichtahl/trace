/**
 * Review a change (/p/:id/changes/:number): what trace did in plain words, the files it touched in trace's own viewers
 * (schematics and boards in KiCanvas with Before / After, text as a diff, pictures side by side), its checks, the
 * requirements it covers, trace's recommendation with its reason, a note box for the specialist, and the decision bar
 * (Discard, Ask for changes, Accept into the design). Reviewers read it; the bar says why they cannot decide. GitHub's
 * own page is only in the admins' More menu (docs/stay-in-trace.md, decision C).
 *
 * An edit a person made in the app (a setting, a prompt, a hand-in: docs/stay-in-trace.md) reads the same way, as "What
 * it changes", tagged with its kind; trace applies an admin's own edit by itself, and an admin accepts someone else's.
 * A repository whose rule asks for a review trace cannot give shows admins "Fix the rule and accept" (repo.rules.fix).
 *
 * Data: change.get (asked for again while GitHub works out whether it can merge, every 5 s, and while checks run, as a
 * fallback to the events; the bar says when it looks next), change.diff per file, journey.get (step words).
 */
import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ChevronRight, CircleCheck, CircleDashed, FileStack, Loader2, ShieldAlert, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { MoreForAdmins } from '@/components/more-for-admins'
import { CHECK_ICON, CheckRow, CheckSheet, ChecksSheet, checksLine, checksState, order } from '@/components/changes/check-sheet'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { useMediaQuery } from '@/hooks/use-media-query'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import { call } from '@/lib/api'
import { useState } from 'react'
import { useTraceContext } from '@/components/chat/context'
import { ChangeFileView } from '@/components/changes/change-file-view'
import { viewerKind } from '@/components/files/kinds'
import { ChangeRequirements } from '@/components/changes/change-requirements'
import { DecisionBar } from '@/components/changes/decision-bar'
import { useChangeActions } from '@/components/changes/use-change-actions'
import { TabSkeleton, useCoverage } from '@/components/project/shared'
import { Rich } from '@/components/rich'
import { useCrumb } from '@/components/shell/breadcrumbs'
import { QueryError } from '@/components/states'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { repoOf } from '@/lib/api'
import { changeLookEvery, useLiveStatus, useNextLook } from '@/lib/live'
import { ago } from '@/lib/format'
import { KIND_TAG, changeOf, checksWords, currentStage, nextPlace, recommendationWords, stepWords } from '@/lib/guided'
import { q, useJourney, useProjects } from '@/lib/queries'
import type { ChangeDetail, ChangeFile } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/p/$id/changes/$number')({
  staticData: { crumb: 'Change' },
  component: Review,
})

const FILE_TAG: Record<ChangeFile['kind'], string> = { schematic: 'Schematic', board: 'Board', parts: 'Parts list', text: 'Text', image: 'Picture', binary: 'File' }

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
  const live = useLiveStatus().state
  // GitHub says nothing when it finishes working out whether it can merge: look again often until it has, and say when
  const c = useQuery({ ...q('change.get', { repo, number }), refetchInterval: (x) => changeLookEvery(x.state.data, live) })
  const nextLook = useNextLook(c.dataUpdatedAt, changeLookEvery(c.data, live))
  const actions = useChangeActions(repo)
  const coverage = useCoverage(repo)
  const [note, setNote] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const phone = useMediaQuery('(max-width: 767px)')
  // the checks list (phone) and the one check open in its sheet (an index into checks_list)
  const [checksOpen, setChecksOpen] = useState(false)
  const [check, setCheck] = useState<number | null>(null)
  const [filesOpen, setFilesOpen] = useState(false)
  useCrumb('/_app/p/$id/changes/$number', c.data?.title ?? `Change ${raw}`)
  useTraceContext({ label: c.data?.title ?? 'A change', description: 'The change the person is reviewing', value: c.data ? { number, title: c.data.title, files: c.data.files.map((f) => f.path), recommendation: c.data.recommendation } : { number } }, 'screen')

  if (c.isError) return <div className="mt-6"><QueryError error={c.error} what="this change" onRetry={() => void c.refetch()} /></div>
  if (!c.data) return <TabSkeleton loading={c.isLoading} />
  const d = c.data
  const file = d.files.find((f) => f.path === picked) ?? d.files[0]
  const stage = j.data ? currentStage(j.data) : null
  const place = j.data ? nextPlace(j.data) : null
  const edit = !!d.kind && d.kind !== 'work'
  const forYou = d.verdict === 'ready' && part !== 'reviewer' && d.may_accept
  const busy = actions.accept.isPending ? 'accept' : actions.ask.isPending ? 'ask' : actions.discard.isPending ? 'discard' : null
  // the next step is this change: its place in the stage, and what accepting moves
  const isNext = !!j.data && j.data.next.kind === 'review' && changeOf(j.data.next) === number
  const acceptSays = place && isNext ? `Accepting adds it to the design and moves ${place.stage} to step ${Math.min(place.total, place.index + 1)}.` : 'Accepting adds it to the design.'
  const back = () => void navigate({ to: '/p/$id', params: { id } })

  return (
    <div className="pt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium">
            <span className={cn('rounded px-1.5 py-0.5', forYou ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>
              {forYou ? 'For you' : d.state === 'open' ? 'Open' : d.state === 'merged' ? 'Accepted' : 'Discarded'}
              {stage && isNext && place ? ` · ${stepWords(place)}` : ''}
            </span>
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">{d.title}</h2>
          <p className="text-sm text-muted-foreground">
            {edit && d.kind && KIND_TAG[d.kind] ? <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">{KIND_TAG[d.kind]}</span> : null}
            {edit ? `Made by ${d.mine ? 'you' : d.by_name ?? 'someone'}` : `From ${d.from}`} · {ago(d.opened_at)} · change {d.number}{d.draft ? ' · a draft' : ''}
          </p>
          {phone && <ChecksLine d={d} onOpen={() => setChecksOpen(true)} />}
        </div>
        <MoreForAdmins links={[d.url ? { label: 'This change on GitHub', href: d.url } : null]} />
      </div>
      {d.rule_blocks && d.state === 'open' && <RuleFix repo={repo} change={d} onFixed={(n) => actions.accept.mutate({ number, head: d.head.sha, title: d.title, ...(n ? { note: n } : {}), step: isNext ? place : null }, { onSuccess: back })} note={note.trim()} />}

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-5">
          <section className="rounded-xl border bg-card p-5" aria-labelledby="did">
            <h3 id="did" className="section-label">{edit ? 'What it changes' : 'What trace did'}</h3>
            {d.summary.length ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                {d.summary.map((s, i) => <li key={i}><Rich text={s} /></li>)}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">trace did not write a summary for this change; its files are below.</p>
            )}
          </section>

          {phone ? (
            <button type="button" onClick={() => setFilesOpen(true)} className="flex min-h-[52px] w-full items-center gap-3 rounded-xl border bg-card px-4 py-3 text-left active:bg-muted">
              <FileStack className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium">Files · {d.files.length} changed</span>
                <span className="block truncate text-xs text-muted-foreground">{d.files.map((f) => fileName(f.path)).join(', ') || 'This change touches no files.'}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          ) : (
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
                      <span className="block text-xs font-normal text-muted-foreground">{f.kind === 'binary' && viewerKind(f.path) === 'database' ? 'Database' : FILE_TAG[f.kind]}</span>
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
          )}

          {part !== 'reviewer' && d.state === 'open' && d.may_ask !== false && (
            <section className="rounded-xl border bg-card p-5">
              <Label htmlFor="change-note" className="section-label">Talk to {d.from}</Label>
              <Textarea id="change-note" rows={2} className="mt-2" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: use a 1 A regulator, we may add a radio later." />
              <p className="mt-1.5 text-xs text-muted-foreground">Your note goes with Ask for changes, or is kept with the decision when you accept.</p>
            </section>
          )}
        </div>

        <aside className="space-y-4">
          {!phone && <Checks d={d} onOpen={setCheck} />}
          <section className="rounded-xl border bg-card p-5" aria-labelledby="reqs">
            <h3 id="reqs" className="section-label">Requirements it covers</h3>
            <ChangeRequirements
              ids={d.requirements}
              rows={coverage.data?.requirements}
              loading={coverage.isPending}
              link={(rid, children, className) => <Link to="/p/$id/requirements/$rid" params={{ id, rid }} className={className}>{children}</Link>}
            />
          </section>
          <section className={cn('rounded-xl border p-5', d.recommendation.verdict === 'accept' ? 'border-primary/40 bg-primary-soft' : 'bg-card')} aria-labelledby="rec">
            <h3 id="rec" className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary"><Sparkles className="size-3.5" aria-hidden /> {recommendationWords(d.recommendation)}</h3>
            <p className="mt-2 text-sm">{d.recommendation.why || 'trace will recommend once the checks have run.'}</p>
          </section>
        </aside>
      </div>

      <ChecksSheet open={checksOpen} onOpenChange={setChecksOpen} checks={d.checks_list} counts={d.checks} onPick={(i) => { setChecksOpen(false); setCheck(i) }} />
      <CheckSheet repo={repo} number={number} checks={d.checks_list} index={check} onIndex={setCheck} />
      {phone && <PhoneFiles open={filesOpen} onOpenChange={setFilesOpen} repo={repo} number={number} files={d.files} />}

      <DecisionBar
        className="mt-6"
        change={d}
        part={part}
        note={note}
        acceptSays={acceptSays}
        nextLook={nextLook}
        busy={busy}
        onAccept={(n) => actions.accept.mutate({ number, head: d.head.sha, title: d.title, ...(n ? { note: n } : {}), step: isNext ? place : null }, { onSuccess: back })}
        onAsk={(n) => actions.ask.mutate({ number, title: d.title, note: n, from: d.from }, { onSuccess: () => setNote('') })}
        onDiscard={(r) => actions.discard.mutate({ number, title: d.title, reason: r }, { onSuccess: back })}
      />
    </div>
  )
}

/** On a phone: how the checks went, in one line under the title; it opens the checks list. */
function ChecksLine({ d, onOpen }: { d: ChangeDetail; onOpen: () => void }) {
  const st = checksState(d.checks_list)
  const I = st ? CHECK_ICON[st] : null
  return (
    <button type="button" onClick={onOpen} className="mt-2 -ml-1 flex min-h-11 items-center gap-2 rounded-md px-1 text-left text-[15px] font-medium active:bg-muted">
      {I ? <I.icon className={cn('size-4 shrink-0', I.cls)} aria-hidden /> : <CircleDashed className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      <span>{checksLine(d.checks_list, d.checks)}</span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="sr-only">: open the checks</span>
    </button>
  )
}

/** On a phone: the change's files in a bottom sheet, the list first and then one file in trace's viewer. */
function PhoneFiles({ open, onOpenChange, repo, number, files }: { open: boolean; onOpenChange: (o: boolean) => void; repo: string; number: number; files: ChangeFile[] }) {
  const [path, setPath] = useState<string | null>(null)
  const f = files.find((x) => x.path === path)
  return (
    <Drawer open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setPath(null) }}>
      <DrawerContent className={cn('max-h-none', f ? 'h-[92dvh]' : 'max-h-[90dvh]')}>
        <DrawerHeader className="flex-row items-center gap-2 text-left">
          {f && <Button variant="ghost" size="icon" className="-ml-2 size-9" onClick={() => setPath(null)} aria-label="Back to the files"><ArrowLeft aria-hidden /></Button>}
          <div className="min-w-0 flex-1">
            <DrawerTitle className="truncate">{f ? fileName(f.path) : `Files · ${files.length} changed`}</DrawerTitle>
            <DrawerDescription className="truncate">{f ? f.path : 'Open one to see what changed in it.'}</DrawerDescription>
          </div>
        </DrawerHeader>
        {f ? (
          <div className="min-h-0 flex-1 overflow-hidden border-t"><ChangeFileView key={f.path} repo={repo} number={number} file={f} /></div>
        ) : (
          <ul className="overflow-y-auto px-2 pb-6">
            {files.map((x) => (
              <li key={x.path}>
                <button type="button" onClick={() => setPath(x.path)} className="flex min-h-[52px] w-full items-center gap-3 rounded-lg px-2 py-2 text-left active:bg-muted">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px]">{fileName(x.path)}</span>
                    <span className="block text-xs text-muted-foreground">{x.kind === 'binary' && viewerKind(x.path) === 'database' ? 'Database' : FILE_TAG[x.kind]}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs">
                    {x.additions > 0 && <span className="text-verified">+{x.additions}</span>}
                    {x.deletions > 0 && <span className="ml-1 text-destructive">−{x.deletions}</span>}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </DrawerContent>
    </Drawer>
  )
}

function Checks({ d, onOpen }: { d: ChangeDetail; onOpen: (i: number) => void }) {
  const [all, setAll] = useState(false)
  const list = d.checks_list
  // failing and running first, so what needs attention is never folded away
  const seq = order(list)
  const shown = all ? seq : seq.slice(0, 3)
  const rest = list.length - shown.length
  return (
    <section className="rounded-xl border bg-card p-5" aria-labelledby="checks">
      <h3 id="checks" className="section-label">Checks · {checksWords(d.checks)}</h3>
      {list.length === 0 ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><CircleDashed className="size-4" aria-hidden />{d.checks === null ? 'trace could not read the checks.' : 'No checks have run yet.'}</p>
      ) : (
        <ul className="-mx-2 mt-2 space-y-0.5 text-sm">
          {shown.map((i) => <li key={`${list[i]!.name}-${i}`}><CheckRow check={list[i]!} onOpen={() => onOpen(i)} /></li>)}
          {rest > 0 && (
            <li>
              <button type="button" onClick={() => setAll(true)} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                <CircleCheck className={cn('size-4', seq.slice(3).every((i) => list[i]!.state === 'passed') ? 'text-verified' : 'text-muted-foreground')} aria-hidden />
                {rest} more {rest === 1 ? 'check' : 'checks'} <span className="text-primary">show</span>
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

/**
 * The repository's rule asks for a review trace cannot give, though every check passed (change.get's rule_blocks).
 * An admin fixes the rule here (repo.rules.fix: trace's own rule back to passing checks only; someone else's rule is
 * only named) and the change is accepted straight after; anyone else is told an admin can.
 */
function RuleFix({ repo, change, note, onFixed }: { repo: string; change: ChangeDetail; note: string; onFixed: (note: string) => void }) {
  const { user } = useAuth()
  const admin = user?.class === 'admin'
  const qc = useQueryClient()
  // trace applies an admin's own edit by itself: fixing the rule is all it needs
  const acceptsAfter = change.applies !== 'auto'
  const fix = useMutation({
    mutationFn: () => call('repo.rules.fix', { repo }),
    onSuccess: (r) => {
      if (r.left.length) toast.warning('Fixed trace\'s rule; one more rule asks for a review', { description: r.left.join(' ') })
      else if (acceptsAfter) onFixed(note)
      else toast.success('Fixed the rule', { description: 'trace applies this change now.' })
    },
    onError: (e) => toast.error('Could not fix the rule', { description: e instanceof Error ? e.message : String(e) }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['change.get', repo] }),
  })
  return (
    <section className="mt-4 flex flex-wrap items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4" aria-labelledby="rule-fix">
      <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <h3 id="rule-fix" className="text-sm font-semibold">This repository asks for a review trace cannot give</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {admin
            ? 'Every check passed. trace records who accepted instead. Putting trace\'s rule back changes only what this repository asks for before a change goes in: passing checks.'
            : 'Every check passed. An admin can put trace\'s rule back from this page, and then it can be accepted.'}
        </p>
      </div>
      {admin && (
        <Button onClick={() => fix.mutate()} disabled={fix.isPending}>{fix.isPending && <Loader2 className="animate-spin" aria-hidden />}{acceptsAfter ? 'Fix the rule and accept' : 'Fix the rule'}</Button>
      )}
    </section>
  )
}

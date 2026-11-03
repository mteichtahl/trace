/**
 * Project overview: where is it (stage rail, and under it the current stage's guide: its purpose, its steps with who
 * does each, and what the gate needs; a segmented bar with "step 3 of 5" on phones), what is the one next step (the
 * card, with its place in the stage, trace's recommendation and what happens after), the changes trace made waiting
 * to be reviewed, the build when it is failing (with "Ask trace to fix something"), and what is happening around it (Waiting on people, trace is doing, Queued, and Recently as a short timeline). Any stage on
 * the rail, and "What happens in <Stage>", opens the stage sheet. A job one specialist asked another for reads "Asked by the …
 * specialist: …" (its title), and a queued one can be declined there. A side column holds the requirements and cost
 * summaries.
 * Reference screen for a project tab.
 */
import { useQuery } from '@tanstack/react-query'
import { RecentTimeline } from '@/components/project/recent-timeline'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { CircleHelp } from 'lucide-react'
import { useState } from 'react'
import { StageCelebration, useStageCelebration } from '@/components/changes/celebration'
import { ChangesFromTrace, useChanges } from '@/components/changes/changes-list'
import { FoldLink, FoldRow, FoldRows } from '@/components/fold-row'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useChangeActions } from '@/components/changes/use-change-actions'
import { StageChip, StageGuidePanel, StageSheet } from '@/components/stage-guide'
import { useAuth } from '@/lib/auth'
import { changeOf, nextPlace } from '@/lib/guided'
import { q } from '@/lib/queries'
import type { Stage } from '@/lib/types'
import { Skeleton } from '@/components/ui/skeleton'
import { NextStepCard } from '@/components/next-step-card'
import { RunLine, runControls, splitRuns } from '@/components/run-line'
import { useWatchRun } from '@/components/run-sheet'
import { DraftAgain } from '@/components/draft-again'
import { useNow } from '@/components/use-now'
import { Section } from '@/components/shell/app-shell'
import { StageRail } from '@/components/stage-rail'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState, Loading } from '@/components/states'
import { Explained } from '@/components/term'
import { WaitLine } from '@/components/wait-line'
import { call, repoOf } from '@/lib/api'
import { ago, money, plural, waited } from '@/lib/format'
import { useJourney, useProjects, useWaits } from '@/lib/queries'
import type { Journey } from '@/lib/types'
import { SKILLS } from '@/components/skills/definitions'
import { continueText, useProjectDrafts } from '@/components/skills/draft'
import { DeclineHandoff, declinable, useDeclineHandoffs } from '@/components/handoff'
import { BuildHealth } from '@/components/project/build-health'

export const Route = createFileRoute('/_app/p/$id/')({
  component: Overview,
})

function Overview() {
  const { id } = Route.useParams()
  const repo = repoOf(id)
  const j = useJourney(repo)
  const waits = useWaits(repo)
  const projects = useProjects()
  const navigate = useNavigate()
  const part = projects.data?.find((p) => p.repo === repo)?.part
  const drafts = useProjectDrafts(repo)
  const decline = useDeclineHandoffs()
  const { user } = useAuth()
  const admin = user?.class === 'admin'
  const [sheet, setSheet] = useState<Stage | null>(null)
  const celebrate = useStageCelebration(j.data)
  const actions = useChangeActions(repo)
  // the change the next step is about: whether this person may accept it straight from the card
  const changeNo = j.data?.next.kind === 'review' ? changeOf(j.data.next) : null
  const change = useQuery({ ...q('change.get', { repo, number: changeNo ?? 0 }), enabled: !!changeNo && part !== 'reviewer' })
  const now = useNow(30_000)
  const phone = useMediaQuery('(max-width: 767px)')
  const changes = useChanges(repo)
  const watch = useWatchRun(repo)
  void navigate

  if (!j.data)
    return (
      <Loading loading={j.isLoading}>
        <div className="mt-6 space-y-6">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-44 rounded-xl" />
        </div>
      </Loading>
    )
  const d = j.data
  // a job lost in the last day stays here, with its last words, rather than vanishing without a mention
  // a draft to carry on is one of this stage's skills (or one that belongs to any stage): a draft left in a skill of a
  // stage already signed is not the next step
  const current = d.stages.find((x) => x.state === 'current' || x.state === 'reopened')?.name
  const draft = drafts.find((x) => { const st = SKILLS.find((k) => k.id === x.skill)?.stage; return st === undefined || st === 'Any' || st === 'Every gate' || st === current })
  // what trace is doing: jobs its runtime still reports (by the clock: one silent past its time is lost, the same as the
  // Agents page says, without waiting for the next look). A lost job of the last day is not "doing": it is listed
  // under Ended without finishing, with the recovery where there is one, rather than vanishing without a mention
  const { doing: running, ended: lostJobs } = splitRuns(d.jobs, now)
  const queued = d.jobs.filter((r) => r.state === 'queued')
  const nextRun = d.next.jobId ? d.jobs.find((r) => r.id === d.next.jobId) : undefined
  // a job another specialist asked for, by the hand-off it answers (journey.get `handoffs`)
  const handoffOf = (r: { handoff?: { id: string } }) => (r.handoff ? d.handoffs?.find((h) => h.id === r.handoff!.id) : undefined)
  const write = part !== 'reviewer'
  const place = nextPlace(d, { admin })
  const canAccept = write && !!change.data?.may_accept && change.data.number === changeNo

  const doingCount = running.length + (waits.data?.waits.length ?? 0)

  // each section's list, drawn as a section on wider screens and inside a folded row's drawer on a phone
  const waitingList = d.questions.length === 0 ? (
    <EmptyState>Nothing is waiting on anyone.</EmptyState>
  ) : (
    <ul className="divide-y rounded-xl border">
      {d.questions.map((qn) => (
        <li key={qn.id} className="flex items-center gap-4 px-5 py-4" data-density-item>
          <CircleHelp className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm">{qn.text}</p>
            <p className="text-xs text-muted-foreground">
              Asked {waited(qn.askedAt)} ago{qn.blocks ? ` · blocks ${qn.blocks}` : ''}
            </p>
          </div>
          {part !== 'reviewer' && (
            <Link to="/p/$id/do/$skill" params={{ id, skill: 'question-answer' }} className="text-sm text-primary hover:underline">
              Answer it
            </Link>
          )}
        </li>
      ))}
    </ul>
  )
  const doingList = doingCount === 0 ? (
    <EmptyState>trace is not working on anything here right now.</EmptyState>
  ) : (
    <div className="divide-y rounded-xl border">
      {running.map((r) => (
        <RunLine key={r.id} run={r} {...runControls(write)} onWatch={(x) => watch.onWatch(x)} />
      ))}
      {watch.sheet}
      {waits.data?.waits.map((w) => (
        <WaitLine key={w.id} wait={w} onCheckNow={(x) => call('tools.check_now', { repo, waitId: x.id })} />
      ))}
    </div>
  )
  // trace lost contact with these: nothing is running for them. Drafting the requirements can be started again
  const lostList = (
    <div className="divide-y rounded-xl border">
      {lostJobs.map((r) => (
        <div key={r.id}>
          <RunLine run={r} />
          {projects.data !== undefined && write && d.drafting?.state === 'stopped' && d.drafting.jobId === r.id && <DraftAgain repo={repo} variant="outline" className="mx-5 mb-4" />}
        </div>
      ))}
    </div>
  )
  // in each agent's queue order: Move up, Hold and Cancel for people allowed to
  const queuedList = (
    <div className="divide-y rounded-xl border">
      {queued.map((r) => {
        const h = handoffOf(r)
        return (
          <div key={r.id}>
            <RunLine run={r} {...runControls(write)} />
            {/* a hand-off waiting its turn: a person may decline it, with a reason the asking specialist reads */}
            {h && write && declinable(h) && <DeclineHandoff handoff={h} onDecline={(x, why) => decline(repo, x, why)} className="px-5 pb-4" />}
          </div>
        )
      })}
    </div>
  )
  const recentList = d.recent.length === 0 ? (
    <EmptyState>Nothing has changed the record yet.</EmptyState>
  ) : (
    <RecentTimeline items={d.recent} />
  )
  const nextCard = (
    <NextStepCard
      step={d.next}
      part={part}
      run={nextRun}
      place={place}
      pinned={phone}
      onAccept={canAccept ? () => actions.accept.mutate({ number: change.data!.number, head: change.data!.head.sha, title: change.data!.title, step: place }) : undefined}
      accepting={actions.accept.isPending}
      resume={draft ? { label: continueText(draft), to: `/p/${id}/do/${draft.skill}` } : undefined}
      callButton={d.next.action?.call === 'requirements.draft' && projects.data !== undefined && write ? <DraftAgain repo={repo} size="lg" /> : undefined}
    />
  )

  if (phone) {
    const changeList = changes.data?.changes ?? []
    const forYou = changeList.filter((c) => c.verdict === 'ready').length
    const waitingOn = [...new Set(d.questions.map((qn) => qn.to).filter(Boolean))]
    const working = [doingCount && `${doingCount} now`, queued.length && `${queued.length} queued`].filter(Boolean).join(' · ')
    const r = d.summary?.requirements
    const c = d.summary?.cost
    return (
      // room under the content for the pinned action bar
      <div className="space-y-3 pb-28 pt-3">
        <StageCelebration shown={celebrate} />
        <StageChip j={d} admin={admin} onOpen={(s) => setSheet(s)} />
        <StageSheet j={d} stage={sheet} admin={admin} onOpenChange={(o) => !o && setSheet(null)} />
        {nextCard}
        <FoldRows label="Around this project">
          {(changeList.length > 0 || d.changesUnavailable) && (
            <FoldLink label="Changes from trace" to="/p/$id/changes" params={{ id }} count={forYou ? `${forYou} for you` : changeList.length || undefined} accent={forYou > 0} />
          )}
          <FoldRow label={waitingOn.length === 1 ? `Waiting on ${waitingOn[0]}` : 'Waiting on people'} count={d.questions.length ? plural(d.questions.length, 'question') : 'nothing'}>
            {waitingList}
          </FoldRow>
          <FoldRow label="trace is working" count={working || 'idle'} description="What trace is doing now, and what is queued after it.">
            <div className="space-y-6">
              {doingList}
              {lostJobs.length > 0 && <Section label="Ended without finishing" count={lostJobs.length}>{lostList}</Section>}
              {queued.length > 0 && <Section label="Queued" count={queued.length}>{queuedList}</Section>}
            </div>
          </FoldRow>
          <FoldRow label="Recently" count={d.recent.length ? ago(d.recent[0]!.at) : undefined}>
            {recentList}
            <Link to="/p/$id/$" params={{ id, _splat: 'decisions' }} className="mt-3 inline-block text-sm text-primary hover:underline">Full history</Link>
          </FoldRow>
          {(r || c) && (
            <FoldRow label="Requirements and cost" count={[r && `${r.accepted}`, c && money(c.cloudToDate, c.currency)].filter(Boolean).join(' · ')}>
              <div className="space-y-4"><SideSummary j={d} id={id} /></div>
            </FoldRow>
          )}
        </FoldRows>
      </div>
    )
  }

  return (
    <div className="pb-12">
      <StageCelebration shown={celebrate} />
      <div className="mt-6 overflow-hidden rounded-xl border bg-card">
        <div className="p-5 md:px-6 md:pt-6 md:pb-4">
          <StageRail stages={d.stages} gates={d.gates} onSelect={(s) => setSheet(s)} />
        </div>
        <StageGuidePanel j={d} admin={admin} onWhat={(s) => setSheet(s)} />
      </div>
      <StageSheet j={d} stage={sheet} admin={admin} onOpenChange={(o) => !o && setSheet(null)} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          {nextCard}

          <ChangesFromTrace repo={repo} unavailable={d.changesUnavailable} />

          {/* the build when it is failing, the fixes asked for, and Ask trace to fix something (health.get) */}
          <BuildHealth repo={repo} jobs={d.jobs} write={projects.data !== undefined && write} />

          <Section label="Waiting on people" count={d.questions.length} className="mt-10">
            {waitingList}
          </Section>

          <Section label="trace is doing" count={doingCount}>
            {doingList}
          </Section>

          {lostJobs.length > 0 && (
            <Section label="Ended without finishing" count={lostJobs.length}>
              {lostList}
            </Section>
          )}

          {queued.length > 0 && (
            <Section label="Queued" count={queued.length}>
              {queuedList}
            </Section>
          )}

          <Section label="Recently" action={<Link to="/p/$id/$" params={{ id, _splat: 'decisions' }} className="text-primary hover:underline">Full history</Link>}>
            {recentList}
          </Section>
        </div>

        <aside className="space-y-4">
          <SideSummary j={d} id={id} />
        </aside>
      </div>
    </div>
  )
}

function SideSummary({ j, id }: { j: Journey; id: string }) {
  const r = j.summary?.requirements
  const c = j.summary?.cost
  return (
    <>
      {r && (
        <div className="rounded-xl border p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">Requirements</h2>
            <Link to="/p/$id/$" params={{ id, _splat: 'requirements' }} className="text-sm text-primary hover:underline">
              Open
            </Link>
          </div>
          <p className="mt-3 text-sm">
            <span className="mr-1 text-2xl font-semibold">{r.accepted}</span> accepted.{' '}
            {r.verified === 0 ? 'None verified yet; testing starts in Prove.' : `${r.verified} verified, ${r.failing} failing.`}
          </p>
          <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="bg-verified" style={{ width: `${(r.verified / Math.max(1, r.accepted)) * 100}%` }} />
            <div className="bg-destructive" style={{ width: `${(r.failing / Math.max(1, r.accepted)) * 100}%` }} />
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
            <StatusBadge plain status="verified" label={`Verified ${r.verified}`} />
            {r.failing > 0 && <StatusBadge plain status="failing" label={`Failing ${r.failing}`} />}
            <StatusBadge plain status="untested" label={`Untested ${r.untested}`} />
          </div>
        </div>
      )}
      {c && (
        <div className="rounded-xl border p-5">
          <h2 className="font-semibold">Cost so far</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-muted-foreground">Cloud use to date</dt><dd className="font-semibold">{money(c.cloudToDate, c.currency)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">Forecast to release</dt><dd className="font-semibold">{money(c.forecast, c.currency)}</dd></div>
            {c.bom !== undefined && (
              <div className="flex justify-between"><dt className="text-muted-foreground"><Explained text={`Parts list (BOM) for ${c.quantity ?? ''} boards`} /></dt><dd className="font-semibold">{money(c.bom, c.currency)}</dd></div>
            )}
          </dl>
          <Link to="/p/$id/$" params={{ id, _splat: 'cost' }} className="mt-3 inline-block text-sm text-primary hover:underline">
            Cost and time
          </Link>
        </div>
      )}
    </>
  )
}

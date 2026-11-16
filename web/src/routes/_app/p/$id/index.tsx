/**
 * Project overview, one column on every screen size (docs/ui-simplify.md, "The Overview"): where it is (the stage
 * rail; a segmented bar on a phone; any stage and "What happens in <Stage>" open the stage sheet), the one next step
 * (the card, with its place in the stage, trace's recommendation and what happens after), whatever went wrong or went
 * back as one exception card (the failing build, gates to sign again, checks out of date, the cloud-work allowance
 * warning: the most blocking shown, the rest under "N more"), then everything around the project as folded rows that
 * open in place: the gate's checklist, Changes from trace, Waiting on people, trace is working (doing, ended without
 * finishing, queued, fixes asked for), Recently, and Requirements and cost (for admins, the two budgets:
 * budgets.tsx). A job one specialist asked another for reads "Asked by the … specialist: …" (its title), and a queued
 * one can be declined there.
 * Reference screen for a project tab.
 */
import { useQuery } from '@tanstack/react-query'
import { RecentTimeline } from '@/components/project/recent-timeline'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowRight, CircleHelp } from 'lucide-react'
import { useState } from 'react'
import { StageCelebration, useStageCelebration } from '@/components/changes/celebration'
import { useChanges } from '@/components/changes/changes-list'
import { FoldLink, FoldRow, FoldRows } from '@/components/fold-row'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useAcceptNow } from '@/components/changes/use-change-actions'
import { GateChecklist, StageChip, StageSheet, gateRowCount } from '@/components/stage-guide'
import { ExceptionCard, ExceptionStack } from '@/components/exception-card'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth'
import { changeOf, nextPlace } from '@/lib/guided'
import { q } from '@/lib/queries'
import type { Stage } from '@/lib/types'
import { Skeleton } from '@/components/ui/skeleton'
import { NextStepCard } from '@/components/next-step-card'
import { HeldNextCard, useLifecycle } from '@/components/project/lifecycle'
import { MoveNextCard, going, useMove } from '@/components/project/move'
import { RunLine, askingOf, runControls, splitRuns } from '@/components/run-line'
import { useWatchRun } from '@/components/run-sheet'
import { DraftAgain } from '@/components/draft-again'
import { RerunStuck } from '@/components/rerun-stuck'
import { StartWork } from '@/components/start-work'
import { LostJobActions, useLostJob } from '@/components/lost-job'
import { useNow } from '@/components/use-now'
import { Section } from '@/components/shell/app-shell'
import { StageRail } from '@/components/stage-rail'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState, Loading, SlowLoad } from '@/components/states'
import { Explained } from '@/components/term'
import { WaitLine } from '@/components/wait-line'
import { CloseOutOfDate, OutOfDateNote, ShowDetail } from '@/components/question-notes'
import { call, repoOf } from '@/lib/api'
import { ago, money, plural, waited } from '@/lib/format'
import { useJourney, useProjects, useWaits } from '@/lib/queries'
import type { Journey } from '@/lib/types'
import type { CostView } from '@/lib/types-s1'
import { SKILLS } from '@/components/skills/definitions'
import { continueText, useProjectDrafts } from '@/components/skills/draft'
import { DeclineHandoff, declinable, useDeclineHandoffs } from '@/components/handoff'
import { BuildFailing, FixRequests, showsHealth } from '@/components/project/build-health'
import { SpendWarningCard } from '@/components/project/spend-by-job'
import { Budgets, SpentSoFar } from '@/components/project/budgets'
import { spentTotal } from '@/components/project/gate-spend'
import { ResignGates } from '@/components/project/resign-gates'

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
  // Accept now: the change read again at the click, its head accepted, the progress and any refusal said on the card
  const acceptNow = useAcceptNow(repo)
  const lostJob = useLostJob(repo)
  // the change the next step is about: whether this person may accept it straight from the card
  const changeNo = j.data?.next.kind === 'review' ? changeOf(j.data.next) : null
  const change = useQuery({ ...q('change.get', { repo, number: changeNo ?? 0 }), enabled: !!changeNo && part !== 'reviewer' })
  // the budgets, and the current stage near or past its share of the cloud-work allowance (admins only: cost.get carries no money for anyone else)
  const cost = useQuery(q('cost.get', { repo }, { enabled: admin }))
  const now = useNow(30_000)
  const phone = useMediaQuery('(max-width: 767px)')
  const changes = useChanges(repo)
  const watch = useWatchRun(repo)
  // paused or retired: the next step is to resume it, so its card stands in for the usual one
  const life = useLifecycle(repo)
  const held = !!(life.data?.paused || life.data?.retired)
  // a project paused for a move between GitHub and GitLab: the Next card shows the move
  const moveState = useMove(repo)
  // the build, read here too (the same cached query as the card's) so the exception stack knows whether it has a card
  const health = useQuery({ ...q('health.get', { repo }), staleTime: 30_000, refetchInterval: 60_000 })
  const moving = going(moveState.data?.move) || moveState.data?.move?.status === 'failed'
  void navigate

  if (!j.data)
    return (
      <Loading loading={j.isLoading}>
        <div className="mt-6 space-y-6">
          {/* a load that takes long says so, with Try again, rather than grey placeholders alone (test-esp32 #171) */}
          <SlowLoad loading={j.isLoading} failureReason={j.failureReason} what="this project" onRetry={() => void j.refetch({ cancelRefetch: true })} />
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
            {qn.outOfDate && <OutOfDateNote why={qn.outOfDate} compact />}
            {qn.detail && <ShowDetail detail={qn.detail} />}
          </div>
          {/* each opens its own question, by id (test-esp32 #107: both opened the oldest) */}
          {part !== 'reviewer' && qn.outOfDate && <CloseOutOfDate repo={repo} question={qn.id} />}
          {part !== 'reviewer' && (
            <Link to="/p/$id/do/$skill" params={{ id, skill: 'question-answer' }} search={{ question: qn.id }} className="shrink-0 text-sm text-primary hover:underline" aria-label={`Answer it: ${qn.text}`}>
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
      {running.map((r) => {
        // a job blocked on a person's answer says so, with the question to answer, not "still running" (#197)
        const asked = askingOf(r, d.questions)
        const answer = asked && part !== 'reviewer' ? (
          <Link to="/p/$id/do/$skill" params={{ id, skill: 'question-answer' }} search={{ question: asked.id }} className="shrink-0 text-sm text-primary hover:underline" aria-label={`Answer it: ${asked.text}`}>
            Answer it
          </Link>
        ) : undefined
        return <RunLine key={r.id} run={r} {...runControls(write)} onWatch={(x) => watch.onWatch(x)} {...(asked ? { waiting: { question: asked, answer } } : {})} />
      })}
      {watch.sheet}
      {waits.data?.waits.map((w) => (
        <WaitLine key={w.id} wait={w} onCheckNow={(x) => call('tools.check_now', { repo, waitId: x.id })} />
      ))}
    </div>
  )
  // trace lost contact with these: nothing is running for them. Each can be started again or dismissed (its view's
  // controls); drafting the requirements is started again as drafting (requirements.draft)
  const lostList = (
    <div className="divide-y rounded-xl border">
      {lostJobs.map((r) => {
        const drafting = d.drafting?.state === 'stopped' && d.drafting.jobId === r.id
        return (
          <div key={r.id}>
            <RunLine run={r} />
            {projects.data !== undefined && write && drafting && <DraftAgain repo={repo} variant="outline" className="mx-5 mb-4" />}
            {/* paused or retired: nothing starts, but it can still be dismissed */}
            {projects.data !== undefined && write && !drafting && <LostJobActions run={held ? { ...r, controls: r.controls?.filter((c) => c !== 'restart') } : r} onAct={lostJob} className="mx-5 mb-4" />}
          </div>
        )
      })}
    </div>
  )
  // the next step is a lost job's: its Start again (or Dismiss), drawn by the card
  const lostNext = (d.next.action?.call === 'job.restart' || d.next.action?.call === 'job.dismiss') && nextRun && projects.data !== undefined && write
    ? <LostJobActions run={nextRun} onAct={lostJob} size="lg" />
    : undefined
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
  // evidence gone out of date since it was checked (journey.get stale_evidence): one plain line each, opening its gate
  const outOfDate = d.staleEvidence?.length ? (
    <ExceptionCard
      key="stale"
      tone="warning"
      label="Out of date"
      title={`${plural(d.staleEvidence.length, 'check')} out of date`}
      body="The design changed after these were checked. trace checks them again before the gate can be signed."
      detailLabel="Which ones"
      open={d.staleEvidence.length <= 3}
      detail={
        <div className="space-y-1.5">
          {d.staleEvidence.map((s) => (
            <p key={s.criterion} className="text-sm">
              <Link to="/p/$id/gates/$gate" params={{ id, gate: s.gate }} className="font-medium hover:underline">{s.text}</Link>
              <span className="text-muted-foreground"> {s.why}</span>
            </p>
          ))}
        </div>
      }
    />
  ) : null
  // the two budgets, the build's and the cloud-work allowance, each with what counts against it (admins)
  const budgets = admin && cost.data?.money ? cost.data : undefined
  const spendWarning = admin && cost.data?.money && cost.data.warning
    ? <SpendWarningCard key="spend" warning={cost.data.warning} currency={cost.data.currency} id={id} open={false} />
    : null
  // after a change of requirements: the gates to sign again, and which keep their evidence (journey.get resign)
  const resign = d.resign ? <ResignGates key="resign" resign={d.resign} id={id} /> : null
  // Accept now: kept while an accept is on its way, so the card shows its progress even if a refresh meanwhile says otherwise
  const onAccept = changeNo && (canAccept || acceptNow.busy) ? () => acceptNow.run({ number: changeNo, title: change.data?.title ?? `Change ${changeNo}`, step: place }) : undefined
  const nextCard = held ? (moving ? <MoveNextCard repo={repo} /> : <HeldNextCard repo={repo} part={part} />) : (
    <NextStepCard
      step={d.next}
      part={part}
      run={nextRun}
      place={place}
      pinned={phone}
      onAccept={onAccept}
      accepting={acceptNow.busy}
      acceptRefused={acceptNow.refused?.number === changeNo ? acceptNow.refused.text : null}
      resume={draft ? { label: continueText(draft), to: `/p/${id}/do/${draft.skill}` } : undefined}
      callButton={d.next.action?.call === 'requirements.draft' && projects.data !== undefined && write ? <DraftAgain repo={repo} size="lg" />
        // checks no runner picked up: run them again once the runner is fixed (test-esp32 log #146)
        : d.next.action?.call === 'changes.rerun_stuck' && projects.data !== undefined && write ? <RerunStuck repo={repo} size="lg" />
        // trace's criterion that nothing works on: start its work (test-esp32 log #161)
        : d.next.action?.call === 'journey.start_work' && projects.data !== undefined && write ? <StartWork repo={repo} size="lg" /> : lostNext}
    />
  )

  const changeList = changes.data?.changes ?? []
  const forYou = changeList.filter((c) => c.verdict === 'ready').length
  const waitingOn = [...new Set(d.questions.map((qn) => qn.to).filter(Boolean))]
  const working = [doingCount && `${doingCount} now`, queued.length && `${queued.length} queued`, lostJobs.length && `${lostJobs.length} ended early`].filter(Boolean).join(' · ')
  const r = d.summary?.requirements
  const c = d.summary?.cost
  const gateRow = gateRowCount(d)
  const stage = d.stages.find((x) => x.state === 'current' || x.state === 'reopened')
  // one column on every screen size (docs/ui-simplify.md): where it is, the one next step, at most one exception
  // showing, then everything around the project folded into rows that open in place (in a drawer on a phone)
  return (
    <div className={cn('space-y-3 pt-3 md:mx-auto md:max-w-[1000px] md:space-y-4 md:pt-6', phone ? 'pb-28' : 'pb-12')}>
      <StageCelebration shown={celebrate} />
      {phone ? (
        <StageChip j={d} admin={admin} onOpen={(s) => setSheet(s)} />
      ) : (
        <div className="rounded-xl border bg-card p-5 md:px-6 md:pt-6 md:pb-4">
          <StageRail stages={d.stages} gates={d.gates} onSelect={(s) => setSheet(s)} />
          {stage && (
            <button type="button" onClick={() => setSheet(stage)} className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:underline">
              What happens in {stage.name} <ArrowRight className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      )}
      <StageSheet j={d} stage={sheet} admin={admin} held={held} onOpenChange={(o) => !o && setSheet(null)} />
      {nextCard}
      {/* everything that went wrong or went back, in one shape and one place: the most blocking first */}
      <ExceptionStack>
        {[showsHealth(health.data) ? <BuildFailing key="build" repo={repo} jobs={d.jobs} open={false} /> : null, resign, outOfDate, spendWarning]}
      </ExceptionStack>
      <FoldRows label="Around this project">
        {gateRow && (
          <FoldRow inline={!phone} label={`To pass the ${stage?.name ?? ''} gate`.replace('  ', ' ')} count={gateRow.count} accent={gateRow.ready}>
            <GateChecklist j={d} admin={admin} held={held} />
          </FoldRow>
        )}
        {(changeList.length > 0 || d.changesUnavailable) && (
          <FoldLink label="Changes from trace" to="/p/$id/changes" params={{ id }} count={forYou ? `${forYou} for you` : changeList.length || undefined} accent={forYou > 0} />
        )}
        <FoldRow inline={!phone} label={waitingOn.length === 1 ? `Waiting on ${waitingOn[0]}` : 'Waiting on people'} count={d.questions.length ? plural(d.questions.length, 'question') : 'nothing'}>
          {waitingList}
        </FoldRow>
        <FoldRow inline={!phone} label="trace is working" count={working || 'idle'} description="What trace is doing now, and what is queued after it.">
          <div className="space-y-6" id="s-trace-is-doing">
            {doingList}
            {lostJobs.length > 0 && <Section label="Ended without finishing" count={lostJobs.length}>{lostList}</Section>}
            {queued.length > 0 && <Section label="Queued" count={queued.length}>{queuedList}</Section>}
            {/* the fixes asked for, and Ask trace to fix something (health.get) */}
            <FixRequests repo={repo} jobs={d.jobs} write={projects.data !== undefined && write && !held} />
          </div>
        </FoldRow>
        <FoldRow inline={!phone} label="Recently" count={d.recent.length ? ago(d.recent[0]!.at) : undefined}>
          {recentList}
          <Link to="/p/$id/$" params={{ id, _splat: 'decisions' }} className="mt-3 inline-block text-sm text-primary hover:underline">Full history</Link>
        </FoldRow>
        {(r || c || budgets) && (
          <FoldRow inline={!phone} label="Requirements and cost" count={[r && `${r.accepted} accepted`, budgets ? `${money(spentTotal(budgets).total, budgets.currency)} spent` : c && money(c.cloudToDate, c.currency)].filter(Boolean).join(' · ')}>
            <div className="grid gap-4 md:grid-cols-2"><SideSummary j={d} id={id} budgets={budgets} /></div>
          </FoldRow>
        )}
      </FoldRows>
    </div>
  )
}

function SideSummary({ j, id, budgets }: { j: Journey; id: string; budgets?: CostView | undefined }) {
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
      {budgets ? (
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="font-semibold">Spend and budgets</h2>
            <Link to="/p/$id/cost" params={{ id }} className="text-sm text-primary hover:underline">Cost and time</Link>
          </div>
          <SpentSoFar cost={budgets} compact className="mb-4" />
          <Budgets cost={budgets} id={id} compact />
        </div>
      ) : c && (
        <div className="rounded-xl border p-5">
          <h2 className="font-semibold">Cost so far</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-muted-foreground">Cloud use to date</dt><dd className="font-semibold">{money(c.cloudToDate, c.currency)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">Forecast to release</dt><dd className="font-semibold">{money(c.forecast, c.currency)}</dd></div>
            {c.bom !== undefined && (
              <div className="flex justify-between"><dt className="text-muted-foreground"><Explained text={`Parts list (BOM) for ${c.quantity ?? ''} boards`} /></dt><dd className="font-semibold">{money(c.bom, c.currency)}</dd></div>
            )}
          </dl>
          <Link to="/p/$id/cost" params={{ id }} className="mt-3 inline-block text-sm text-primary hover:underline">
            Cost and time
          </Link>
        </div>
      )}
    </>
  )
}

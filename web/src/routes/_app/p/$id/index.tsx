/**
 * Project overview: where is it (stage rail), what is the one next step (the card), and what is happening around it
 * (Waiting on people, trace is doing, Queued, Recently). A job one specialist asked another for reads "Asked by the …
 * specialist: …" (its title), and a queued one can be declined there. A side column holds the requirements and cost
 * summaries.
 * Reference screen for a project tab.
 */
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { CircleHelp } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { NextStepCard } from '@/components/next-step-card'
import { RunLine, runControls } from '@/components/run-line'
import { Section } from '@/components/shell/app-shell'
import { StageRail } from '@/components/stage-rail'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState, Loading } from '@/components/states'
import { Explained } from '@/components/term'
import { WaitLine } from '@/components/wait-line'
import { call, repoOf } from '@/lib/api'
import { ago, initials, money, waited } from '@/lib/format'
import { useJourney, useProjects, useWaits } from '@/lib/queries'
import type { Journey } from '@/lib/types'
import { continueText, useProjectDrafts } from '@/components/skills/draft'
import { DeclineHandoff, declinable, useDeclineHandoffs } from '@/components/handoff'

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
  const draft = useProjectDrafts(repo)[0]
  const decline = useDeclineHandoffs()

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
  const running = d.jobs.filter((r) => r.state === 'running' || r.state === 'paused' || (r.state === 'lost' && Date.now() - Date.parse(r.startedAt ?? '') < 24 * 3600_000))
  const queued = d.jobs.filter((r) => r.state === 'queued')
  const nextRun = d.next.jobId ? d.jobs.find((r) => r.id === d.next.jobId) : undefined
  // a job another specialist asked for, by the hand-off it answers (journey.get `handoffs`)
  const handoffOf = (r: { handoff?: { id: string } }) => (r.handoff ? d.handoffs?.find((h) => h.id === r.handoff!.id) : undefined)
  const write = part !== 'reviewer'

  return (
    <div className="pb-12">
      <div className="mt-6 rounded-xl border p-5 md:p-6">
        <StageRail stages={d.stages} gates={d.gates} onSelect={(s) => void navigate({ to: `/p/${id}/stages/${s.id}` })} className="max-md:hidden" />
        <StageRail stages={d.stages} gates={d.gates} variant="bar" className="md:hidden" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <NextStepCard step={d.next} part={part} run={nextRun} resume={draft ? { label: continueText(draft), to: `/p/${id}/do/${draft.skill}` } : undefined} />

          <Section label="Waiting on people" count={d.questions.length} className="mt-10">
            {d.questions.length === 0 ? (
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
            )}
          </Section>

          <Section label="trace is doing" count={running.length + (waits.data?.waits.length ?? 0)}>
            {running.length + (waits.data?.waits.length ?? 0) === 0 ? (
              <EmptyState>trace is not working on anything here right now.</EmptyState>
            ) : (
              <div className="divide-y rounded-xl border">
                {running.map((r) => (
                  <RunLine key={r.id} run={r} {...runControls(write)} />
                ))}
                {waits.data?.waits.map((w) => (
                  <WaitLine key={w.id} wait={w} onCheckNow={(x) => call('tools.check_now', { repo, waitId: x.id })} />
                ))}
              </div>
            )}
          </Section>

          {queued.length > 0 && (
            <Section label="Queued" count={queued.length}>
              {/* in each agent's queue order: Move up, Hold and Cancel for people allowed to */}
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
            </Section>
          )}

          <Section label="Recently" action={<Link to="/p/$id/$" params={{ id, _splat: 'decisions' }} className="text-primary hover:underline">Full history</Link>}>
            {d.recent.length === 0 ? (
              <EmptyState>Nothing has changed the record yet.</EmptyState>
            ) : (
              <ul className="divide-y rounded-xl border">
                {d.recent.slice(0, 5).map((r) => (
                  <li key={r.id} className="flex items-center gap-4 px-5 py-3.5" data-density-item>
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{r.who === 'trace' ? 't' : initials(r.who)}</span>
                    <p className="min-w-0 flex-1 text-sm">
                      {r.text} {r.ref && <code className="font-mono text-xs text-muted-foreground">{r.ref}</code>}
                    </p>
                    <span className="shrink-0 text-xs text-muted-foreground">{ago(r.at)}</span>
                  </li>
                ))}
              </ul>
            )}
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

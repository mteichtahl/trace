/**
 * Home: what needs you. One column: the greeting line (the whole page in one sentence), Needs you, Your projects with
 * their stage rails, and In progress (runs and waits across projects). Reference screen: see web/README.md.
 *
 * Data: inbox · projects · journey.get per project · tools.waits per project. All refetch from live events.
 */
import { useQueries } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { Skeleton } from '@/components/ui/skeleton'
import { NeedsYouCard } from '@/components/needs-you-card'
import { RunLine } from '@/components/run-line'
import { Column, Section } from '@/components/shell/app-shell'
import { StageRail } from '@/components/stage-rail'
import { EmptyState, Loading, QueryError, SkeletonRows } from '@/components/states'
import { WaitLine } from '@/components/wait-line'
import { useTraceContext } from '@/components/chat/context'
import { useMediaQuery } from '@/hooks/use-media-query'
import { call, projectId, projectName } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { firstName, greeting, plural } from '@/lib/format'
import { q, useCall, useInbox, useProjects } from '@/lib/queries'
import type { InboxItem, Journey, RunSummary, Wait } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/')({
  staticData: { crumb: 'Home' },
  component: Home,
})

/** "2 things need you. 3 are in progress." */
export function greetingLine(needs: number, running: number): string {
  const a = needs === 0 ? 'Nothing needs you.' : `${plural(needs, 'thing')} ${needs === 1 ? 'needs' : 'need'} you.`
  const b = running === 0 ? '' : ` ${running} ${running === 1 ? 'is' : 'are'} in progress.`
  return a + b
}

function Home() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const inbox = useInbox()
  const projects = useProjects()
  const repos = (projects.data ?? []).map((p) => p.repo)
  const journeys = useQueries({ queries: repos.map((repo) => q('journey.get', { repo })) })
  const waits = useQueries({ queries: repos.map((repo) => q('tools.waits', { repo })) })
  const phone = useMediaQuery('(max-width: 767px)')
  const answer = useCall('question.answer', (a) => [['inbox'], ['journey.get', a.repo]])

  useTraceContext({ label: 'Home', description: 'The screen the person is on', value: 'Home: what needs them across their projects' }, 'screen')

  const running: { run: RunSummary; project: string }[] = journeys.flatMap((j) => (j.data?.jobs ?? []).filter((r) => r.state === 'running').map((run) => ({ run, project: j.data!.name })))
  const waiting: (Wait & { project: string })[] = waits.flatMap((w, i) => (w.data?.waits ?? []).map((x) => ({ ...x, project: projectName(repos[i] ?? '') })))
  const inProgress = running.length + waiting.length
  const items = inbox.data ?? []

  const onAnswer = (item: InboxItem) => {
    if (!item.questionId || !item.recommended) return
    answer.mutate(
      { repo: item.repo, question: item.questionId, option: item.recommended.id },
      {
        onSuccess: () => toast(`Answered: ${item.recommended!.label}`, { description: `${item.project}: the specialist carries on.` }),
        onError: (e) => toast.error('Could not send the answer', { description: `${e.message} Nothing was lost; try again.` }),
      },
    )
  }

  return (
    <Column>
      <h1 className="text-[30px] font-semibold leading-tight tracking-tight">
        {greeting()}, {user ? firstName(user.name ?? user.email) : ''}.
      </h1>
      <p className="mt-2 text-base text-muted-foreground" aria-live="polite">
        {inbox.isLoading ? ' ' : greetingLine(items.length, inProgress)}
      </p>

      <Section label="Needs you" className="mt-12">
        {inbox.isError ? (
          <QueryError error={inbox.error} what="what needs you" onRetry={() => void inbox.refetch()} />
        ) : inbox.isLoading ? (
          <Loading>
            <SkeletonRows rows={2} />
          </Loading>
        ) : items.length === 0 ? (
          <EmptyState>Nothing needs you. trace will tell you when something does.</EmptyState>
        ) : (
          <div className="space-y-3">
            {items.map((i) => (
              <NeedsYouCard key={i.id} item={i} compact={phone} onAnswer={onAnswer} answering={answer.isPending && answer.variables?.question === i.questionId} onOther={(it) => it.action.to && void navigate({ to: it.action.to })} />
            ))}
          </div>
        )}
      </Section>

      <Section label="Your projects" action={<Link to="/projects" className="text-primary hover:underline">See all</Link>}>
        {projects.isError ? (
          <QueryError error={projects.error} what="your projects" onRetry={() => void projects.refetch()} />
        ) : projects.isLoading ? (
          <Loading>
            <SkeletonRows rows={3} />
          </Loading>
        ) : repos.length === 0 ? (
          <EmptyState action={user?.class === 'admin' ? <Button asChild><Link to="/projects/new">Start your first project</Link></Button> : undefined}>
            {user?.class === 'admin' ? 'No projects yet. Start one from an idea or from an existing KiCad design.' : 'You are not on a project yet.'}
          </EmptyState>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border">
            {repos.slice(0, 6).map((repo, i) => (
              <ProjectRow key={repo} repo={repo} journey={journeys[i]?.data} loading={journeys[i]?.isLoading} phone={phone} />
            ))}
          </ul>
        )}
      </Section>

      {inProgress > 0 && (
        <Section label="In progress">
          {phone ? (
            <Drawer>
              <DrawerTrigger asChild>
                <button type="button" className="flex w-full items-center justify-between rounded-xl border px-5 py-4 text-left text-sm">
                  {inProgress} running <ChevronRight className="size-4 text-muted-foreground" />
                </button>
              </DrawerTrigger>
              <DrawerContent>
                <DrawerHeader>
                  <DrawerTitle>In progress</DrawerTitle>
                </DrawerHeader>
                <InProgress running={running} waiting={waiting} />
              </DrawerContent>
            </Drawer>
          ) : (
            <InProgress running={running} waiting={waiting} />
          )}
        </Section>
      )}
    </Column>
  )
}

function InProgress({ running, waiting }: { running: { run: RunSummary; project: string }[]; waiting: (Wait & { project: string })[] }) {
  return (
    <div className="divide-y overflow-hidden rounded-xl border">
      {running.map(({ run, project }) => (
        <RunLine key={run.id} run={run} project={project} onPause={() => { toast('Pause asked for') }} onCancel={() => 'Nothing was kept.'} />
      ))}
      {waiting.map((w) => (
        <WaitLine
          key={w.id}
          wait={{ ...w, what: w.what.replace(new RegExp(`^${w.project}:\\s*`), '') }}
          project={w.what.includes(':') ? w.what.split(':')[0] : w.project}
          onCheckNow={(x) => call('tools.check_now', { repo: x.repo ?? '', waitId: x.id })}
        />
      ))}
    </div>
  )
}

function ProjectRow({ repo, journey: j, loading, phone }: { repo: string; journey?: Journey; loading?: boolean; phone: boolean }) {
  const yours = j?.next.owner === 'you'
  const next = j ? `Next: ${j.next.short ?? j.next.summary.replace(/\*\*/g, '')}` : ''
  return (
    <li>
      <Link to="/p/$id" params={{ id: projectId(repo) }} className="grid gap-x-6 gap-y-2 px-6 py-4 hover:bg-muted/50 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)] md:items-center" data-density-item>
        <div className="min-w-0">
          <p className="truncate font-semibold">{j?.name ?? projectName(repo)}</p>
          {j ? <p className="text-xs text-muted-foreground">{j.revision} · {j.template === 'fpga' ? 'FPGA' : j.template.charAt(0).toUpperCase() + j.template.slice(1)}</p> : loading && <Skeleton className="mt-1 h-3 w-20" />}
        </div>
        {j ? <StageRail stages={j.stages} gates={j.gates} variant={phone ? 'bar' : 'compact'} /> : loading ? <Skeleton className="h-3 w-32" /> : <span />}
        <p className={cn('text-sm', yours ? 'font-medium text-primary' : 'text-muted-foreground')}>{next}</p>
      </Link>
    </li>
  )
}

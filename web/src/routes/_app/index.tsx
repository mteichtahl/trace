/**
 * Home is Next (docs/ui-simplify.md, "One queue"): the greeting line (the whole page in one sentence), the one queue of
 * what needs this person (components/next-queue.tsx: acted on in place, one at a time), and Your projects with their
 * stage rails. Nothing else lists what needs a person: the bell and the phone's Next tab open this page. What trace
 * is working on is in the top bar's "trace is working" (components/activity.tsx), not listed here.
 *
 * Data: inbox · projects · journey.get per project. All refetch from live events.
 */
import { useQueries } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { PauseCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { NextQueue, inboxItems } from '@/components/next-queue'
import { Column, Section } from '@/components/shell/app-shell'
import { StageRail } from '@/components/stage-rail'
import { EmptyState, Loading, QueryError, SkeletonRows } from '@/components/states'
import { useTraceContext } from '@/components/chat/context'
import { useMediaQuery } from '@/hooks/use-media-query'
import { projectId, projectName } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { firstName, greeting, plural } from '@/lib/format'
import { q, useInbox, useProjects } from '@/lib/queries'
import type { Journey, LifecycleMark } from '@/lib/types'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/')({
  staticData: { crumb: 'Next' },
  // a tapped notification opens its item at the front (src/web/push-sender.ts messageFor, by way of /next)
  validateSearch: (s: Record<string, unknown>): { item?: string } => (typeof s.item === 'string' && s.item.length < 200 ? { item: s.item } : {}),
  component: Home,
})

/** "2 things need you. trace is working on 3." */
export function greetingLine(needs: number, running: number): string {
  const a = needs === 0 ? 'Nothing needs you.' : `${plural(needs, 'thing')} ${needs === 1 ? 'needs' : 'need'} you.`
  const b = running === 0 ? '' : ` trace is working on ${running}.`
  return a + b
}

function Home() {
  const { user } = useAuth()
  const { item } = Route.useSearch()
  const inbox = useInbox()
  const projects = useProjects()
  const repos = (projects.data ?? []).map((p) => p.repo)
  const journeys = useQueries({ queries: repos.map((repo) => q('journey.get', { repo })) })
  const phone = useMediaQuery('(max-width: 767px)')
  const needs = inboxItems(inbox.data).length
  const running = journeys.reduce((n, j) => n + (j.data?.jobs ?? []).filter((r) => r.state === 'running').length, 0)

  useTraceContext({ label: 'Home', description: 'The screen the person is on', value: 'Home: what needs them next, one at a time, and their projects' }, 'screen')

  return (
    <Column>
      <h1 className="text-[30px] font-semibold leading-tight tracking-tight">
        {greeting()}, {user ? firstName(user.name ?? user.email) : ''}.
      </h1>
      <p className="mt-2 text-base text-muted-foreground" aria-live="polite">
        {inbox.isLoading ? ' ' : greetingLine(needs, running)}
      </p>

      <div className="mt-10">
        <NextQueue opened={item} />
      </div>

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
              <ProjectRow key={repo} repo={repo} journey={journeys[i]?.data} loading={journeys[i]?.isLoading} phone={phone} paused={projects.data?.[i]?.paused ?? null} />
            ))}
          </ul>
        )}
      </Section>
    </Column>
  )
}

function ProjectRow({ repo, journey: j, loading, phone, paused }: { repo: string; journey?: Journey; loading?: boolean; phone: boolean; paused?: LifecycleMark | null }) {
  // a paused project asks nothing of anyone: its line says who paused it, not what is next
  const yours = !paused && j?.next.owner === 'you'
  const next = paused ? `Paused by ${paused.by}${paused.reason ? `: ${paused.reason}` : ''}` : j ? `Next: ${j.next.short ?? j.next.summary.replace(/\*\*/g, '')}` : ''
  return (
    <li>
      <Link to="/p/$id" params={{ id: projectId(repo) }} className="grid gap-x-6 gap-y-2 px-6 py-4 hover:bg-muted/50 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)] md:items-center" data-density-item>
        <div className="min-w-0">
          <p className="truncate font-semibold">{j?.name ?? projectName(repo)}</p>
          {j ? <p className="text-xs text-muted-foreground">{j.revision} · {j.template === 'fpga' ? 'FPGA' : j.template.charAt(0).toUpperCase() + j.template.slice(1)}</p> : loading && <Skeleton className="mt-1 h-3 w-20" />}
        </div>
        {j ? <StageRail stages={j.stages} gates={j.gates} variant={phone ? 'bar' : 'compact'} /> : loading ? <Skeleton className="h-3 w-32" /> : <span />}
        <p className={cn('text-sm', yours ? 'font-medium text-primary' : paused ? 'inline-flex items-center gap-1.5 text-warning-foreground' : 'text-muted-foreground')}>
          {paused && <PauseCircle className="size-3.5 shrink-0" aria-hidden />}{next}
        </p>
      </Link>
    </li>
  )
}

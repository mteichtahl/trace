/**
 * The notice a project shows while its own agent is not set up yet (project.agent): a project created in the web app
 * gets its agent with the next update of the installation, usually within the hour, and until then trace cannot save
 * what a person tells it, run the project's tools or start work there. The notice says so, roughly when it will be
 * ready, and when the app looks again. Nothing announces the update's end, so the app looks again at the time the API
 * gives (next_check_s), with Check now; once the agent is there the notice goes away by itself.
 *
 * Shown on every project page (routes/_app/p/$id.tsx), in Focus mode (routes/_focus/p/$id/do/$skill.tsx, through
 * FocusNotice) and in the Ask trace panel. The Intent builder's and Change request's Submit and a chat's "Confirm and
 * start" wait for it (agentBlocked), with the reason.
 */
import { useQuery } from '@tanstack/react-query'
import { Clock, ExternalLink, Loader2, TriangleAlert } from 'lucide-react'
import { createContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import { time } from '@/lib/format'
import { useNextLook } from '@/lib/live'
import { q } from '@/lib/queries'
import type { AgentSetup } from '@/lib/types'
import { cn } from '@/lib/utils'

/** When the app looks again: the API's next_check_s, or never once the agent is ready. Pure. */
export function setupLookEvery(s: AgentSetup | undefined): number | false {
  if (!s || s.ready || !s.next_check_s) return false
  return s.next_check_s * 1000
}

/** Whether a project's agent is known not to be set up: an answer that is not project.agent's (an older API, a test's
 * stub) is never taken as not set up. Pure. */
export const notReady = (s: unknown): s is AgentSetup => !!s && typeof s === 'object' && (s as AgentSetup).ready === false

/** Why a button that needs the project's agent waits, or null when it need not. Pure. */
export function agentBlocked(s: unknown): string | null {
  if (!notReady(s)) return null
  return s.state === 'failed' || s.state === 'missing'
    ? 'This project has no agent yet, so this cannot start. An admin can add it by running the installer.'
    : 'trace is still setting up this project\'s agent. This can be sent once it is ready.'
}

/** The id of projects.create's wait for the installation update that brings the project's agent. */
export const AGENT_WAIT = 'installation-update'

/** New project's last button: it says the agent is still being set up while it is. Pure. */
export const openLabel = (settingUp: boolean): string => (settingUp ? 'Open project — trace is still setting up its agent' : 'Open project')

/** useNextLook's words as the notice says them: "trace looks again in 40 s." Pure. */
export const lookWords = (next: string): string => (next === 'looking now' ? 'trace is looking now.' : `trace ${next.replace(/^next look/, 'looks again')}.`)

/** The notice's words. Pure. */
export function setupWords(s: AgentSetup, now: number): { title: string; body: string; when: string | null } {
  const title = s.state === 'failed' ? 'This project\'s agent could not be set up yet'
    : s.state === 'missing' ? 'This project has no agent in this installation yet'
      : 'trace is setting up this project\'s agent'
  const body = `Until it is ready, trace can't save your answers, run this project's tools or start work here. ${s.text}`
  const by = s.expected_by ? Date.parse(s.expected_by) : NaN
  const when = s.state === 'failed' || s.state === 'missing' ? null
    : Number.isFinite(by) && by > now ? `Usually ready by about ${time(by)}.`
      : Number.isFinite(by) ? null
        : 'Usually ready within the hour.'
  return { title, body, when }
}

/**
 * The project's agent as project.agent answers it, looked at again while it is being set up. With `fetch: false` it
 * only reads what a notice on the screen already fetched (a chat card asks nothing of its own).
 */
export function useAgentSetup(repo: string | undefined, o: { fetch?: boolean } = {}) {
  return useQuery({
    ...q('project.agent', { repo: repo ?? '' }),
    enabled: !!repo && o.fetch !== false,
    retry: false,
    refetchInterval: (query) => setupLookEvery(query.state.data),
  })
}

/** Where Focus mode puts the notice (FocusLayout draws it under its header): set by the skill's route. */
export const FocusNotice = createContext<ReactNode>(null)
/** Why Focus mode's Submit waits for the project's agent (FocusLayout's `blocked` when it is given none): set by the
 * skill's route for the skills whose Submit starts the project's agent (NEEDS_AGENT). */
export const FocusBlocked = createContext<string | null>(null)

/** The guided skills whose Submit is for the project's agent to act on: the Intent builder's starts the Verification
 * agent drafting the requirements, a Change request's starts the agents raising it. The others record a person's act
 * in the journey record, which needs no agent. */
export const NEEDS_AGENT: ReadonlySet<string> = new Set(['intent-builder', 'change-request'])

export function AgentSetupNotice({ repo, compact, className }: { repo: string; compact?: boolean; className?: string }) {
  const setup = useAgentSetup(repo)
  const s = setup.data
  const { user } = useAuth()
  const every = setupLookEvery(s)
  const next = useNextLook(setup.dataUpdatedAt, every)
  const [checking, setChecking] = useState(false)
  // say so once when it becomes ready while the person is here (the compact panel copy leaves it to the page's)
  const was = useRef<boolean | null>(null)
  useEffect(() => {
    if (!s || typeof s.ready !== 'boolean') return
    if (was.current === false && s.ready && !compact) toast('This project\'s agent is ready.', { description: 'trace can save your answers and start work here now.' })
    was.current = s.ready
  }, [s, compact])
  if (!notReady(s)) return null
  const w = setupWords(s, Date.now())
  const stalled = s.state === 'failed' || s.state === 'missing'
  const Icon = stalled ? TriangleAlert : Clock
  const look = (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {next && <span aria-live="off">{lookWords(next)}</span>}
      <Button
        variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={checking}
        onClick={async () => { setChecking(true); try { await setup.refetch() } finally { setChecking(false) } }}
      >
        {checking && <Loader2 className="animate-spin" />}
        {checking ? 'Checking' : 'Check now'}
      </Button>
      {s.update?.url && user?.class === 'admin' && (
        <a className="inline-flex items-center gap-1 underline-offset-2 hover:underline" href={s.update.url} target="_blank" rel="noreferrer">
          The update on GitHub <ExternalLink className="size-3" aria-hidden />
        </a>
      )}
    </span>
  )
  return (
    <section
      role="status"
      aria-label="This project's agent"
      className={cn('rounded-xl border px-4 py-3 text-sm', stalled ? 'border-warning/40 bg-warning/5' : 'bg-muted/50', className)}
    >
      <p className="flex items-start gap-2 font-medium">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{w.title}</span>
      </p>
      <p className={cn('mt-1 pl-6 text-muted-foreground', compact && 'text-xs')}>{w.body}</p>
      <p className={cn('mt-1.5 pl-6 text-xs text-muted-foreground')}>
        {w.when && <span className="mr-2">{w.when}</span>}
        {look}
      </p>
    </section>
  )
}

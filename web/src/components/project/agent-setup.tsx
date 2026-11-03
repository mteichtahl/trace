/**
 * The notice a project shows while its own agent is not set up yet (project.agent): a project created in the web app
 * gets its agent with the next update of the installation, usually within the hour, and until then trace cannot save
 * what a person tells it, run the project's tools or start work there. The notice says so, roughly when it will be
 * ready, and when the app looks again. Nothing announces the update's end, so the app looks again at the time the API
 * gives (next_check_s), with Check now; once the agent is there the notice goes away by itself.
 *
 * The update's progress (UpdateProgress) is its steps as the API reads them from the run (done, running, waiting,
 * failed), a bar, "about N min left" from expected_by, and on failure the failing step's last lines (admins only, as
 * the API gives them). The run's own page on GitHub is in the admins' More menu, never a link anyone else sees.
 *
 * Shown on every project page (routes/_app/p/$id.tsx), in Focus mode (routes/_focus/p/$id/do/$skill.tsx, through
 * FocusNotice) and in the Ask trace panel. The Intent builder's and Change request's Submit and a chat's "Confirm and
 * start" wait for it (agentBlocked), with the reason.
 */
import { useQuery } from '@tanstack/react-query'
import { Check, Circle, Clock, Loader2, TriangleAlert, X } from 'lucide-react'
import { createContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { MoreForAdmins } from '@/components/more-for-admins'
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

type Step = NonNullable<NonNullable<AgentSetup['update']>['steps']>[number]

/** How far the update is, 0 to 1: done steps (a running one counts half), or null when there are no steps. Pure. */
export function stepsDone(steps: readonly Step[] | undefined): number | null {
  if (!steps?.length) return null
  return steps.reduce((n, s) => n + (s.state === 'done' ? 1 : s.state === 'running' ? 0.5 : 0), 0) / steps.length
}

/** "about 25 min left" from expected_by, or null (no estimate, or it is past). Pure. */
export function minutesLeft(expectedBy: string | null, now: number): string | null {
  const by = expectedBy ? Date.parse(expectedBy) : NaN
  if (!Number.isFinite(by) || by <= now) return null
  const m = Math.max(1, Math.round((by - now) / 60_000))
  return `about ${m} min left`
}

const STEP_ICON: Record<Step['state'], { Icon: typeof Check; className: string; word: string }> = {
  done: { Icon: Check, className: 'text-verified', word: 'done' },
  running: { Icon: Loader2, className: 'animate-spin text-primary', word: 'running' },
  waiting: { Icon: Circle, className: 'text-muted-foreground/60', word: 'waiting' },
  failed: { Icon: X, className: 'text-destructive', word: 'failed' },
}

/** The installation update's steps, a bar and the time left; on failure the failing step's last lines. */
export function UpdateProgress({ setup: s, className }: { setup: AgentSetup; className?: string }) {
  const u = s.update
  if (!u) return null
  const done = stepsDone(u.steps)
  const left = u.status === 'failed' ? null : minutesLeft(s.expected_by, Date.now())
  return (
    <div className={cn('space-y-2', className)}>
      {done !== null && (
        <div className="flex items-center gap-3">
          <div role="progressbar" aria-label="The installation update" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(done * 100)} className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className={cn('h-full rounded-full transition-[width]', u.status === 'failed' ? 'bg-destructive' : 'bg-primary')} style={{ width: `${Math.round(done * 100)}%` }} />
          </div>
          {left && <span className="shrink-0 text-xs text-muted-foreground">{left}</span>}
        </div>
      )}
      {u.steps?.length ? (
        <ol className="grid gap-1 text-xs sm:grid-cols-2" aria-label="Steps of the update">
          {u.steps.map((st, i) => {
            const { Icon, className: c, word } = STEP_ICON[st.state]
            return (
              <li key={`${i}-${st.name}`} className={cn('flex min-w-0 items-center gap-1.5', st.state === 'waiting' && 'text-muted-foreground', st.state === 'failed' && 'font-medium')}>
                <Icon className={cn('size-3.5 shrink-0', c)} aria-hidden />
                <span className="min-w-0 truncate" title={st.name}>{st.name}</span>
                <span className="sr-only">: {word}</span>
              </li>
            )
          })}
        </ol>
      ) : left ? <p className="text-xs text-muted-foreground">{left[0]!.toUpperCase() + left.slice(1)}.</p> : null}
      {u.failed_log && (
        <details className="rounded-md border bg-background/60 text-xs" open>
          <summary className="cursor-pointer px-3 py-1.5 font-medium">What the failing step said (its last lines)</summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t px-3 py-2 font-mono text-[11px] leading-5">{u.failed_log}</pre>
        </details>
      )}
    </div>
  )
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
      <MoreForAdmins className="h-7" links={[s.update?.url ? { label: 'The update\'s run on GitHub', href: s.update.url } : null]} />
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
      {!compact && <UpdateProgress setup={s} className="mt-2 pl-6" />}
      <p className={cn('mt-1.5 pl-6 text-xs text-muted-foreground')}>
        {w.when && <span className="mr-2">{w.when}</span>}
        {look}
      </p>
    </section>
  )
}

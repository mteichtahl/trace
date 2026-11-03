/**
 * "trace is working" in the top bar, and everything it is doing in one place (docs/progress-and-logs.md, "1." and
 * decision F). The pill shows only while something runs: a spinner and how many. It opens What trace is doing: checks
 * on changes, specialists and tools across every project the person can see, each with its step, its time against
 * the usual, how recently it spoke (Heartbeat), and Watch (the RunSheet), or Look for one that is later than usual.
 * Below: what else trace is waiting on (each project's timed waits) and All work. A popover on a wide screen, a bottom
 * drawer on a phone.
 *
 * Data: activity.list, refreshed by the live events (job.updated, record.changed, log.appended); while the live
 * connection is down, every 15 s.
 */
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Loader2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useMediaQuery } from '@/hooks/use-media-query'
import { projectName } from '@/lib/api'
import { until } from '@/lib/format'
import { useLiveStatus } from '@/lib/live'
import { q, useProjects } from '@/lib/queries'
import type { ActivityItem, Wait } from '@/lib/types'
import { cn } from '@/lib/utils'
import { BeatDot, Heartbeat, quietState, type Quiet } from './heartbeat'
import { timeAgainstUsual } from './log-view'
import { RunSheet } from './run-sheet'
import { useNow } from './use-now'

/** How often the list looks again while the live connection is down. */
export const ACTIVITY_POLL_MS = 15_000

const GROUPS: { kind: ActivityItem['kind']; label: string }[] = [
  { kind: 'check', label: 'Checks on changes' },
  { kind: 'job', label: 'Specialists' },
  { kind: 'tool', label: 'Tools' },
]

/** The activity list, live. */
export function useActivity() {
  const live = useLiveStatus().state === 'live'
  return useQuery({ ...q('activity.list', {}), refetchInterval: live ? false : ACTIVITY_POLL_MS })
}

/** An item's heartbeat input. */
const beatOf = (i: ActivityItem) => ({ heardAt: i.heardAt, usualQuietS: i.usualQuietS, overdueAt: i.overdueAt, lostAt: i.lostAt, startedAt: i.startedAt })

/** "Board checks on #212" for a check, else its title. Pure. */
export const itemTitle = (i: ActivityItem): string => (i.kind === 'check' && i.change && !i.title.includes(`#${i.change}`) ? `${i.title} on #${i.change}` : i.title)

/** "Step 4 of 9: design rule check" / the step / what it waits on. Pure. */
export function itemStep(i: ActivityItem): string | null {
  if (i.state === 'queued') return i.kind === 'check' ? 'Waiting for a build machine' : 'Queued'
  if (i.state === 'paused') return 'Paused: its work so far is kept'
  if (!i.step) return i.newest
  const s = i.step.charAt(0).toLowerCase() + i.step.slice(1)
  return i.stepIndex && i.stepCount ? `Step ${i.stepIndex} of ${i.stepCount}: ${s}` : i.step
}

/** "3 min, usually 6" in the panel's short words. Pure. */
export function itemTime(i: ActivityItem, now: number): string | null {
  const t = timeAgainstUsual(i.startedAt, i.typicalS, now)
  return t ? t.replace(' so far', '') : null
}

/** "4 things · all healthy", "· all healthy but one", "· 2 later than usual". Pure. */
export function healthWords(items: readonly ActivityItem[], now: number): string {
  const n = items.length
  const bad = items.filter((i) => i.state === 'running' && ['late', 'lost'].includes(quietState(beatOf(i), now))).length
  const things = `${n} ${n === 1 ? 'thing' : 'things'}`
  if (!bad) return `${things} · all healthy`
  if (bad === 1 && n > 1) return `${things} · all healthy but one`
  return `${things} · ${bad} later than usual`
}

/** "Also waiting: JLCPCB to confirm order · next check in 13 min" (the first wait), or null. */
export function waitWords(waits: readonly Wait[], now: number): string | null {
  if (!waits.length) return null
  const w = [...waits].sort((a, b) => Date.parse(a.nextCheckAt ?? '9999') - Date.parse(b.nextCheckAt ?? '9999'))[0]!
  const first = `${w.what}${w.nextCheckAt ? ` · next check ${until(w.nextCheckAt, now)}` : ''}`
  return `Also waiting: ${first}${waits.length > 1 ? `, and ${waits.length - 1} more` : ''}`
}

function Row({ item, now, onWatch, compact }: { item: ActivityItem; now: number; onWatch: (i: ActivityItem) => void; compact?: boolean }) {
  const st: Quiet = item.state === 'running' ? quietState(beatOf(item), now) : 'quiet'
  const bad = st === 'late' || st === 'lost'
  const step = itemStep(item)
  const t = itemTime(item, now)
  const button = (
    <Button variant="outline" size="xs" className="shrink-0" onClick={() => onWatch(item)} aria-label={`${bad ? 'Look at' : 'Watch'} ${projectName(item.repo)}: ${itemTitle(item)}`}>
      {bad ? 'Look' : 'Watch'}
    </Button>
  )
  if (compact)
    return (
      <li className="flex items-center gap-3 border-t px-4 py-3">
        <BeatDot state={item.state === 'running' ? st : 'quiet'} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm"><span className="font-semibold">{projectName(item.repo)}:</span> {itemTitle(item)}</p>
          <p className="truncate text-xs text-muted-foreground">{[item.step ?? step, bad ? 'later than usual' : t].filter(Boolean).join(' · ')}</p>
        </div>
        {button}
      </li>
    )
  return (
    <li className="flex items-start gap-3 border-t px-4 py-3">
      {bad ? <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" aria-hidden /> : item.state === 'running' ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-primary" aria-hidden /> : <BeatDot state="quiet" className="mx-1 mt-1.5" />}
      <div className="min-w-0 flex-1">
        <p className="text-sm"><span className="font-semibold">{projectName(item.repo)}:</span> {itemTitle(item)}</p>
        {step && <p className="mt-0.5 text-sm">{step}</p>}
        <p className="mt-1 text-xs text-muted-foreground">
          {item.state === 'running' && <Heartbeat beat={beatOf(item)} className="mr-1" />}
          {t && <span>· {t}</span>}
        </p>
      </div>
      {button}
    </li>
  )
}

/** The panel's body: the groups, then what else waits and All work. */
export function ActivityPanel({ items, waits, onWatch, onClose, compact, unreadable }: { items: ActivityItem[]; waits: Wait[]; onWatch: (i: ActivityItem) => void; onClose?: () => void; compact?: boolean; unreadable?: string[] }) {
  const now = useNow(1000)
  const also = waitWords(waits, now)
  return (
    <div>
      {items.length === 0 && <p className="border-t px-4 py-6 text-sm text-muted-foreground">trace is not working on anything right now.</p>}
      {compact ? (
        <ul>{items.map((i) => <Row key={i.run + i.repo} item={i} now={now} onWatch={onWatch} compact />)}</ul>
      ) : (
        GROUPS.map((g) => {
          const list = items.filter((i) => i.kind === g.kind)
          if (!list.length) return null
          return (
            <section key={g.kind} aria-label={g.label}>
              <div className="flex items-baseline justify-between px-4 pb-1.5 pt-3">
                <h3 className="section-label text-[11px]">{g.label}</h3>
                <span className="text-xs text-muted-foreground">{list.length}</span>
              </div>
              <ul>{list.map((i) => <Row key={i.run + i.repo} item={i} now={now} onWatch={onWatch} />)}</ul>
            </section>
          )
        })
      )}
      {unreadable?.length ? <p className="border-t px-4 py-2 text-xs text-muted-foreground">Could not read what runs on {unreadable.map(projectName).join(', ')}.</p> : null}
      <div className={cn('flex items-center justify-between gap-3 border-t px-4 py-3 text-sm', !compact && 'bg-muted/40')}>
        <span className="min-w-0 truncate text-muted-foreground">{also ?? ''}</span>
        <Link to="/agents" className="shrink-0 text-primary hover:underline" onClick={onClose}>All work ›</Link>
      </div>
    </div>
  )
}

/** The top bar's pill and its panel; nothing when trace is idle. */
export function ActivityPill({ className }: { className?: string }) {
  const phone = useMediaQuery('(max-width: 767px)')
  const a = useActivity()
  const [open, setOpen] = useState(false)
  const [watch, setWatch] = useState<ActivityItem | null>(null)
  const projects = useProjects()
  const repos = (projects.data ?? []).map((p) => p.repo)
  // what else trace waits on: each project's timed waits, asked only while the panel is open
  const waits = useQueries({ queries: repos.map((repo) => ({ ...q('tools.waits', { repo }), enabled: open })) })
  const now = useNow(5_000)
  const items = a.data?.items ?? []
  const n = items.length
  if (!n && !watch) return null
  const allWaits = waits.flatMap((w, i) => (w.data?.waits ?? []).map((x) => ({ ...x, repo: x.repo ?? repos[i] })))
  const onWatch = (i: ActivityItem) => {
    setOpen(false)
    setWatch(i)
  }
  const pill = (
    <button
      type="button"
      onClick={phone ? () => setOpen(true) : undefined}
      className={cn('inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-primary/30 bg-primary-soft px-3 text-xs text-primary hover:bg-primary/10 aria-expanded:ring-2 aria-expanded:ring-primary/30', className)}
      aria-label={`trace is working on ${n} ${n === 1 ? 'thing' : 'things'}: show what`}
    >
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      <span className="hidden md:inline">trace is working</span>
      <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground max-md:bg-transparent max-md:text-xs max-md:text-primary">{n}</span>
    </button>
  )
  const sheet = watch && (
    <RunSheet
      repo={watch.repo} run={watch.run} title={itemTitle(watch)} open={!!watch} onOpenChange={(o) => !o && setWatch(null)}
      facts={{ step: watch.step, stepIndex: watch.stepIndex, stepCount: watch.stepCount, startedAt: watch.startedAt, typicalS: watch.typicalS }}
    />
  )
  if (phone)
    return (
      <>
        {n > 0 && pill}
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent className="max-h-[85dvh]">
            <DrawerHeader className="flex-row items-baseline justify-between text-left">
              <DrawerTitle>What trace is doing</DrawerTitle>
              <span className="text-sm text-muted-foreground">{n}</span>
            </DrawerHeader>
            <div className="min-h-0 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
              <ActivityPanel items={items} waits={allWaits} onWatch={onWatch} onClose={() => setOpen(false)} compact unreadable={a.data?.unreadable} />
            </div>
          </DrawerContent>
        </Drawer>
        {sheet}
      </>
    )
  return (
    <>
      {n > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>{pill}</PopoverTrigger>
          <PopoverContent align="center" sideOffset={8} className="w-[470px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl p-0">
            <div className="flex items-baseline gap-3 px-4 pb-2 pt-4">
              <h2 className="flex-1 text-base font-semibold">What trace is doing</h2>
              <span className="text-xs text-muted-foreground">{healthWords(items, now)}</span>
            </div>
            <div className="max-h-[min(70vh,640px)] overflow-y-auto">
              <ActivityPanel items={items} waits={allWaits} onWatch={onWatch} onClose={() => setOpen(false)} unreadable={a.data?.unreadable} />
            </div>
          </PopoverContent>
        </Popover>
      )}
      {sheet}
    </>
  )
}

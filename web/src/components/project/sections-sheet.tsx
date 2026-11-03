/**
 * A project's sections on a phone (the phone redesign, "Sections instead of tabs"): one button in the project header,
 * with the count of changes ready for the person, opens a bottom sheet listing every section the project has reached,
 * each with a one-line status, the current one marked. The sections still to come are named in one line under the list,
 * and the project's rare actions sit at the bottom. On wider screens the tab row stays.
 */
import { Link, useRouterState } from '@tanstack/react-router'
import { Brain, ClipboardList, Coins, FileStack, Folder, GitPullRequest, LayoutGrid, ListChecks, type LucideIcon, Package, PanelsTopLeft, Settings, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { money } from '@/lib/format'
import type { Journey } from '@/lib/types'
import { cn } from '@/lib/utils'

export interface SectionTab {
  id: string
  label: string
  to: string
}

const ICON: Record<string, LucideIcon> = {
  overview: PanelsTopLeft,
  requirements: ListChecks,
  design: LayoutGrid,
  changes: GitPullRequest,
  evidence: ClipboardList,
  build: Package,
  decisions: ShieldCheck,
  files: Folder,
  settings: Settings,
  cost: Coins,
  memory: Brain,
}

/**
 * Where each later section comes from: "Evidence and Build appear once the project reaches Capture and Release."
 * Evidence starts with the first checks: Capture where the project has it (board, mixed), else Prove (FPGA, firmware).
 */
const LATER: { id: string; label: string; stage: (j?: Journey) => string }[] = [
  { id: 'requirements', label: 'Requirements', stage: () => 'Define' },
  { id: 'design', label: 'Design', stage: () => 'Architect' },
  { id: 'evidence', label: 'Evidence', stage: (j) => (j && !j.stages.some((s) => s.id === 'capture' || s.name.toLowerCase() === 'capture') ? 'Prove' : 'Capture') },
  { id: 'build', label: 'Build', stage: () => 'Release' },
]

const and = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** The sections still to come, in a sentence, or null when every one is open. */
export function laterLine(tabs: SectionTab[], journey?: Journey): string | null {
  const missing = LATER.filter((l) => !tabs.some((t) => t.id === l.id))
  if (!missing.length) return null
  return `${and(missing.map((m) => m.label))} ${missing.length === 1 ? 'appears' : 'appear'} once the project reaches ${and(missing.map((m) => m.stage(journey)))}.`
}

/** Each section's one-line status, from what the project page already has. */
export function statusLine(id: string, j: Journey | undefined, o: { changes: number; ready: number }): string | undefined {
  const r = j?.summary?.requirements
  const c = j?.summary?.cost
  switch (id) {
    case 'overview':
      return j?.next.owner === 'you' ? 'Your next step is here' : 'Where the project is, and what comes next'
    case 'changes':
      return o.changes ? `${o.changes} from trace` : 'Nothing waiting'
    case 'requirements':
      return r ? `${r.accepted} accepted${r.verified ? `, ${r.verified} verified` : ''}` : undefined
    case 'decisions': {
      const n = j?.gates.filter((g) => g.state === 'signed').length ?? 0
      return n ? `${n} ${n === 1 ? 'gate' : 'gates'} signed` : undefined
    }
    case 'cost':
      return c ? `${money(c.cloudToDate, c.currency)} so far` : undefined
    default:
      return undefined
  }
}

export function SectionsSheet({ name, base, tabs, journey, changes, ready, checking = 0, actions }: {
  name: string
  base: string
  tabs: SectionTab[]
  journey?: Journey
  changes: number
  ready: number
  /** changes whose checks are still running (orange) */
  checking?: number
  actions?: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const isHere = (t: SectionTab) => (t.to === '' ? pathname === base || pathname === `${base}/` : pathname.startsWith(base + t.to))
  const here = tabs.find(isHere)
  const later = laterLine(tabs, journey)
  const stage = journey?.stages.find((s) => s.state === 'current' || s.state === 'reopened')
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button variant="outline" className="relative h-11 gap-1.5" aria-label={`Sections${here ? `, on ${here.label}` : ''}${ready ? `, ${ready} ${ready === 1 ? 'change' : 'changes'} ready for you` : ''}`}>
          <FileStack aria-hidden />
          {here && here.id !== 'overview' ? here.label : 'Sections'}
          {ready > 0 && <span className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground" aria-hidden>{ready}</span>}
        </Button>
      </DrawerTrigger>
      <DrawerContent className="max-h-[90dvh]">
        <DrawerHeader className="flex-row items-baseline justify-between gap-3 text-left">
          <DrawerTitle className="text-lg">{name}</DrawerTitle>
          <DrawerDescription>{stage ? `${stage.name} · stage ${journey!.stages.filter((s) => !(s.optional && s.state === 'skipped')).findIndex((s) => s.id === stage.id) + 1} of ${journey!.stages.filter((s) => !(s.optional && s.state === 'skipped')).length}` : 'Sections'}</DrawerDescription>
        </DrawerHeader>
        <nav aria-label="Project sections" className="overflow-y-auto px-3 pb-6">
          <ul className="space-y-0.5">
            {tabs.map((t) => {
              const Icon = ICON[t.id] ?? PanelsTopLeft
              const active = isHere(t)
              const line = statusLine(t.id, journey, { changes, ready })
              return (
                <li key={t.id}>
                  <Link
                    to={base + t.to}
                    onClick={() => setOpen(false)}
                    aria-current={active ? 'page' : undefined}
                    className={cn('flex min-h-[52px] items-center gap-3 rounded-lg px-3 py-2', active ? 'bg-primary-soft' : 'hover:bg-muted/60')}
                  >
                    <Icon className={cn('size-5 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-[15px]', active && 'font-semibold')}>{t.label}</span>
                      {line && <span className="block text-xs text-muted-foreground">{line}</span>}
                    </span>
                    {t.id === 'changes' && ready > 0 && <span className="shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-xs font-semibold text-primary">{ready} for you</span>}
                    {t.id === 'changes' && checking > 0 && <span className="shrink-0 rounded-full bg-orange-500/15 px-2 py-0.5 text-xs font-semibold text-orange-700 dark:text-orange-300">{checking} checking</span>}
                    {active && <span className="shrink-0 text-xs font-semibold text-primary">You are here</span>}
                  </Link>
                </li>
              )
            })}
          </ul>
          {later && <p className="mt-3 px-3 text-sm text-muted-foreground">{later}</p>}
          {actions && <div className="mt-4 flex flex-wrap gap-2 border-t px-3 pt-4">{actions}</div>}
        </nav>
      </DrawerContent>
    </Drawer>
  )
}

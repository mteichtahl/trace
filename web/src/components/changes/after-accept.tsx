/**
 * "What happens next", after a change is accepted (docs/guided-flow.md, Confirmations; the proposal's phone screen):
 * the confirmation (what moved: "Capture is now on step 4 of 5", and what trace is doing now with its time), the next
 * three steps with who does them, "We'll tell you the moment the gate is ready", and "Back to Needs you · N left".
 *
 * It is driven by the accept answer (`stage`, `next`) and the journey as it is after the accept (its refreshed steps).
 * On a phone the screen opens at once, full height, in place of the toast. On wider screens the toast stays (it
 * reads better beside the page) and its "What happens next" action opens the same content in a side sheet.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Check, Circle, CircleDashed, PartyPopper } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { SideSheet } from '@/components/side-sheet'
import { useMediaQuery } from '@/hooks/use-media-query'
import { currentStage, gateOf, ownerWord, stageSteps, stepPlace } from '@/lib/guided'
import { q, useInbox } from '@/lib/queries'
import { createStore, useStore } from '@/lib/store'
import type { ChangeAccepted, Journey, StageStep } from '@/lib/types'
import { cn } from '@/lib/utils'

/** The last accept, for the screen: which project, what was accepted, the API's answer, and whether it is open. */
export interface Accepted { repo: string; project?: string; title: string; result: Pick<ChangeAccepted, 'stage' | 'next'>; open: boolean }
export const afterAccept = createStore<Accepted | null>(null)
export const showAfterAccept = (a: Omit<Accepted, 'open'>, open: boolean) => afterAccept.set({ ...a, open })

export interface NextView {
  title: string
  /** "Capture is now on step 4 of 5." */
  moved: string
  /** "trace is checking stock for 10 boards, about 4 minutes." */
  doing: string
  steps: { text: string; who: string; when: 'now' | 'next' | 'later'; owner: StageStep['owner'] }[]
  notice: string
  back: string
}

const stageNameOf = (j: Pick<Journey, 'stages'> | undefined, id: string) => j?.stages.find((s) => s.id === id)?.name ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'The stage')

/** The screen's words from the accept answer, the journey after it, and how many items still need the person. */
export function nextView(a: Pick<Accepted, 'title' | 'result'>, j: Pick<Journey, 'stages' | 'gates' | 'next'> | undefined, left: number, o: { admin?: boolean } = {}): NextView {
  const c = j ? currentStage(j) : null
  const stage = c?.stage ?? j?.stages.find((s) => s.id === a.result.stage)
  const steps = stage && j ? stageSteps(stage, gateOf(j.gates, stage), o) : []
  const place = j?.next.step ?? stepPlace(steps)
  const name = stage?.name ?? stageNameOf(j, a.result.stage)
  const moved = place ? `${name} is now on step ${place.index} of ${place.total}.` : `"${a.title}" is part of the design now.`
  const upcoming = steps.filter((s) => s.state !== 'done' && s.state !== 'waived').slice(0, 3)
    .map((s) => ({ text: s.text, who: ownerWord(s), when: (s.state === 'now' ? 'now' : s.state === 'next' ? 'next' : 'later') as 'now' | 'next' | 'later', owner: s.owner }))
  // the stage after this one, when fewer than three steps are left in it
  if (upcoming.length < 3 && c) {
    const after = j!.stages.filter((s) => !(s.optional && s.state === 'skipped'))[c.index + 1]
    if (after) upcoming.push({ text: `${after.name} starts`, who: 'trace', when: 'later', owner: 'trace' })
  }
  const gateNext = upcoming.some((s) => /\bsign\b/i.test(s.text) || s.owner === 'admins')
  return {
    title: 'Accepted into the design',
    moved,
    doing: a.result.next || 'trace carries on with the next step.',
    steps: upcoming,
    notice: gateNext ? "We'll tell you the moment the gate is ready. No need to keep this open." : "We'll tell you when something needs you. No need to keep this open.",
    back: left > 0 ? `Back to Needs you · ${left} left` : 'Back to Home',
  }
}

function StepIcon({ when, owner }: { when: 'now' | 'next' | 'later'; owner: StageStep['owner'] }) {
  if (when === 'now' && owner === 'trace') return <CircleDashed className="size-[18px] shrink-0 animate-spin text-primary [animation-duration:3s]" aria-hidden />
  if (when === 'now') return <Circle className="size-[18px] shrink-0 text-primary" aria-hidden />
  return <Circle className="size-[18px] shrink-0 text-muted-foreground/50" aria-hidden />
}

/** The screen's body, shared by the phone screen and the desktop sheet. */
export function NextBody({ v, onBack, className }: { v: NextView; onBack: () => void; className?: string }) {
  return (
    <div className={cn('space-y-4', className)}>
      <div role="status" className="flex gap-3 rounded-xl border border-verified/40 bg-verified/10 p-4">
        <PartyPopper className="mt-0.5 size-5 shrink-0 text-verified" aria-hidden />
        <div className="text-sm">
          <p className="font-semibold">{v.title}</p>
          <p className="mt-0.5">{v.moved} {v.doing}</p>
        </div>
      </div>
      {v.steps.length > 0 && (
        <section className="rounded-xl border bg-card p-4" aria-labelledby="what-next">
          <h3 id="what-next" className="section-label">What happens next</h3>
          <ol className="mt-2 space-y-2">
            {v.steps.map((s, i) => (
              <li key={i} className="flex items-center gap-3 text-sm">
                <StepIcon when={s.when} owner={s.owner} />
                <span className="min-w-0 flex-1">{s.text}</span>
                <span className={cn('shrink-0 text-xs', s.when === 'now' ? 'text-primary' : 'text-muted-foreground')}>{s.who}{s.when === 'now' ? ' · now' : ''}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <p className="text-sm text-muted-foreground">{v.notice}</p>
      <Button variant="outline" className="h-11 w-full" asChild>
        <Link to="/" onClick={onBack}>{v.back}</Link>
      </Button>
    </div>
  )
}

/** Mounted once in the shell: the phone screen, or the desktop sheet when the toast's action opens it. */
export function AfterAccept() {
  const a = useStore(afterAccept)
  const phone = useMediaQuery('(max-width: 767px)')
  const j = useQuery({ ...q('journey.get', { repo: a?.repo ?? '' }), enabled: !!a })
  const inbox = useInbox()
  if (!a) return null
  const v = nextView(a, j.data, inbox.data?.length ?? 0)
  const close = () => afterAccept.set((x) => (x ? { ...x, open: false } : x))
  if (phone)
    return (
      <Drawer open={a.open} onOpenChange={(o) => !o && close()}>
        <DrawerContent className="h-[100dvh] max-h-none rounded-none data-[vaul-drawer-direction=bottom]:mt-0 data-[vaul-drawer-direction=bottom]:max-h-none data-[vaul-drawer-direction=bottom]:rounded-none">
          <DrawerHeader className="text-left">
            <DrawerTitle className="flex items-center gap-2 text-left"><Check className="size-4 text-verified" aria-hidden /> {a.project ?? j.data?.name ?? 'Your project'}</DrawerTitle>
            <DrawerDescription className="text-left">{a.title}</DrawerDescription>
          </DrawerHeader>
          <NextBody v={v} onBack={close} className="overflow-y-auto px-4 pb-6" />
        </DrawerContent>
      </Drawer>
    )
  return (
    <SideSheet open={a.open} onOpenChange={(o) => !o && close()} title="What happens next" description={a.title}>
      <NextBody v={v} onBack={close} />
    </SideSheet>
  )
}

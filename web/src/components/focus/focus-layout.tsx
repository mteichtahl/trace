/**
 * Focus mode: one layout for all twenty guided skills. The shell's rail and tabs fold away, leaving
 *   steps (left, 240 px) · the work (centre) · trace (right, 380 px, folds to a button) · the quality bar (bottom).
 * Escape or the close button returns to exactly where the person was; a draft is kept ("Draft saved 2 seconds ago").
 * A notice the route puts in FocusNotice (the project's agent being set up) is drawn under the header.
 *
 * Variants:
 * - stepped: as above (most skills)
 * - conversational: the chat moves to the centre and becomes the work; the right panel shows what is being built
 *   (pass it as `aside`)
 * - checklist: the picture fills the centre and the steps become a checklist beside it (`aside`); `stop` adds a
 *   large Stop button that is always visible during powered steps
 *
 * On a phone: "Step 3 of 6" at the top with a drawer for the list; trace is a floating button that opens a
 * full-height drawer; the quality bar is a sticky footer.
 */
import { Check, ListOrdered, MessageSquare, PanelRightClose, Sparkles, X, OctagonX } from 'lucide-react'
import { type ReactNode, useContext, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { FocusNotice } from '@/components/project/agent-setup'
import { QualityBar, type QualityCheck } from '@/components/quality-bar'
import { useNow } from '@/components/use-now'
import { ago } from '@/lib/format'
import { cn } from '@/lib/utils'

export interface FocusStep {
  id: string
  title: string
  state: 'done' | 'current' | 'todo'
}

/** A step as the rail draws it: `visited` is a step passed with a check of its own still not met. */
export type RailState = FocusStep['state'] | 'visited'

/**
 * How the rail shows each step. A step passed (Continue, or a later one reached) is done only once its own checks are
 * met: one passed while a check of it is still not met says Visited, not Done (test-esp32 #232). Pure.
 */
export function railStates(steps: readonly FocusStep[], checks: readonly QualityCheck[]): RailState[] {
  return steps.map((s) => (s.state === 'done' && checks.some((c) => c.step === s.id && c.status === 'not_met') ? 'visited' : s.state))
}

export interface FocusLayoutProps {
  /** the skill's name ("Schematic finish") */
  title: string
  /** where it belongs ("Soil sensor · Rev A · Capture") */
  context?: string
  variant?: 'stepped' | 'conversational' | 'checklist'
  steps: FocusStep[]
  onStep?: (id: string) => void
  /** every step on the rail opens with a click, later ones too; else only the steps already reached */
  anyStep?: boolean
  /** below the steps (e.g. the sheets list) */
  stepsExtra?: ReactNode
  /** the centre */
  children: ReactNode
  /** the trace chat (stepped, checklist) — usually <EmbeddedChat/> */
  trace?: ReactNode
  /** the right panel in the conversational variant (the draft being built), or the checklist beside the picture */
  aside?: ReactNode
  checks: QualityCheck[]
  onSubmit: () => void | Promise<void>
  submitLabel?: string
  /** why Submit cannot be pressed whatever the checks say (the project's agent is not set up yet): shown beside it */
  blocked?: string | null
  /** returns to where the person was */
  onClose: () => void
  /** epoch ms of the last draft save */
  draftSavedAt?: number | null
  /** the draft's last change is still being saved: Submit waits for it */
  draftSaving?: boolean
  /** checklist on a picture: a large Stop while powered */
  stop?: { visible: boolean; onStop: () => void }
  /** 'fill': the centre is not padded or scrolled, so a chat can take its full height (conversational skills) */
  centre?: 'padded' | 'fill'
  /** what the last Submit came to while the person is still here (refused, or partly): drawn just above Submit */
  outcome?: ReactNode
}

export function FocusLayout({
  title, context, variant = 'stepped', steps, onStep, anyStep = false, stepsExtra, children, trace, aside, checks, onSubmit, submitLabel, blocked, onClose, draftSavedAt, draftSaving = false, stop, centre = 'padded', outcome,
}: FocusLayoutProps) {
  const now = useNow(5000)
  const notice = useContext(FocusNotice)
  const [traceOpen, setTraceOpen] = useState(true)
  const [stepsDrawer, setStepsDrawer] = useState(false)
  const [traceDrawer, setTraceDrawer] = useState(false)
  const idx = steps.findIndex((s) => s.state === 'current')
  const rail = railStates(steps, checks)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // leave dialogs, popovers and the chat's recall to handle their own Escape
      const t = e.target as HTMLElement | null
      if (t?.closest('[role="dialog"],[data-radix-popper-content-wrapper],textarea')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const stepList = (
    <nav aria-label="Steps">
      <p className="px-2 pb-2 text-xs text-muted-foreground">{variant === 'checklist' ? 'Checklist' : 'Steps'}</p>
      <ol className="space-y-0.5">
        {steps.map((s, i) => {
          const state = rail[i]!
          return (
            <li key={s.id}>
              <button
                type="button"
                disabled={!onStep || (state === 'todo' && !anyStep)}
                onClick={() => onStep?.(s.id)}
                aria-current={state === 'current' ? 'step' : undefined}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm',
                  state === 'current' ? 'bg-primary/10 font-medium text-foreground' : state === 'todo' ? 'text-muted-foreground' : '',
                  state !== 'current' && onStep && (state !== 'todo' || anyStep) && 'hover:bg-accent hover:text-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]',
                    state === 'done' && 'border-foreground bg-foreground text-background',
                    state === 'current' && 'border-primary text-primary',
                    state === 'visited' && 'border-dashed border-foreground',
                  )}
                  aria-hidden
                >
                  {state === 'done' ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                </span>
                <span className="sr-only">{state === 'done' ? 'Done: ' : state === 'current' ? 'Current: ' : state === 'visited' ? 'Visited, a check still not met: ' : ''}</span>
                <span className="min-w-0 flex-1">{s.title}</span>
                {state === 'visited' && <span className="shrink-0 text-xs text-muted-foreground" aria-hidden>Visited</span>}
              </button>
            </li>
          )
        })}
      </ol>
      {stepsExtra && <div className="mt-6">{stepsExtra}</div>}
    </nav>
  )

  const right = variant === 'conversational' ? aside : trace
  const draft = draftSaving ? (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">Saving your draft…</span>
  ) : draftSavedAt ? (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
      <Check className="size-3.5" aria-hidden /> Draft saved {ago(Math.min(draftSavedAt, now), now)}
    </span>
  ) : null

  // The page is exactly the viewport: only the rail, the centre and the right panel scroll, each inside itself.
  // `relative` and `overflow-clip` keep what is positioned inside them (screen-reader text is absolute) from
  // growing the document, so the window never scrolls the header away (test-esp32 R16).
  return (
    <div className="relative flex h-dvh flex-col overflow-clip bg-background" role="main" aria-label={title} data-focus-shell>
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b px-4">
        <Button variant="outline" size="icon" onClick={onClose} aria-label="Close and return">
          <X />
        </Button>
        <div className="min-w-0 flex-1 truncate">
          <span className="font-semibold">{title}</span>
          {context && <span className="ml-3 hidden text-sm text-muted-foreground sm:inline">{context}</span>}
        </div>
        <div className="hidden md:block">{draft}</div>
        {right && (
          <Button variant="ghost" size="icon" className="hidden xl:inline-flex" onClick={() => setTraceOpen((v) => !v)} aria-label={traceOpen ? 'Fold trace away' : 'Open trace'}>
            {traceOpen ? <PanelRightClose /> : <Sparkles />}
          </Button>
        )}
      </header>

      {/* phone: step count with a drawer */}
      <div className="flex items-center justify-between border-b px-4 py-2 text-sm md:hidden">
        <button type="button" className="inline-flex items-center gap-1.5" onClick={() => setStepsDrawer(true)}>
          <ListOrdered className="size-4" aria-hidden /> Step {idx + 1} of {steps.length}
        </button>
        <div className="flex items-center gap-2">
          {draft}
          {/* trace sits in this bar on a phone, rather than floating over the work */}
          {(trace || aside) && (
            <Button variant="outline" size="sm" className="h-9" onClick={() => setTraceDrawer(true)}>
              <MessageSquare /> Ask trace
            </Button>
          )}
        </div>
      </div>

      {notice && <div className="shrink-0 border-b px-4 py-3 empty:hidden">{notice}</div>}

      <div className="flex min-h-0 flex-1">
        <aside className="relative hidden w-[240px] shrink-0 overflow-y-auto border-r bg-sidebar p-3 md:block lg:w-[240px]">{stepList}</aside>
        {centre === 'fill' ? (
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-clip">{children}</div>
        ) : (
          <div className="relative min-w-0 flex-1 overflow-y-auto">
            <div className={cn('mx-auto w-full px-4 py-6 md:px-6', variant === 'checklist' ? 'max-w-none' : 'max-w-[960px]')}>{children}</div>
          </div>
        )}
        {variant === 'checklist' && aside && <aside className="relative hidden w-[320px] shrink-0 overflow-y-auto border-l p-4 lg:block">{aside}</aside>}
        {right && traceOpen && variant !== 'checklist' && (
          <aside className="relative hidden w-[380px] shrink-0 flex-col overflow-clip border-l xl:flex" aria-label={variant === 'conversational' ? 'What is being built' : 'trace'}>
            {right}
          </aside>
        )}
        {trace && traceOpen && variant === 'checklist' && (
          <aside className="relative hidden w-[380px] shrink-0 flex-col overflow-clip border-l 2xl:flex" aria-label="trace">
            {trace}
          </aside>
        )}
      </div>

      {outcome && <div className="relative max-h-[45dvh] shrink-0 overflow-y-auto border-t px-4 py-3 md:px-6">{outcome}</div>}

      <QualityBar checks={checks} onSubmit={onSubmit} submitLabel={submitLabel} blocked={blocked} saving={draftSaving} />

      {stop?.visible && (
        <Button size="lg" variant="destructive" className="fixed bottom-20 right-6 z-30 h-14 px-8 text-base shadow-lg" onClick={stop.onStop}>
          <OctagonX /> Stop
        </Button>
      )}

      {/* trace on tablets and phones: a floating button and a full-height drawer */}
      {(trace || aside) && (
        <Button
          size="icon"
          className="fixed bottom-20 right-4 z-20 size-12 rounded-full shadow-lg max-md:hidden xl:hidden"
          onClick={() => setTraceDrawer(true)}
          aria-label="Open trace"
        >
          <MessageSquare />
        </Button>
      )}
      <Drawer open={traceDrawer} onOpenChange={setTraceDrawer}>
        <DrawerContent className="h-[92dvh]">
          <DrawerHeader className="sr-only">
            <DrawerTitle>trace</DrawerTitle>
          </DrawerHeader>
          <div className="flex min-h-0 flex-1 flex-col">{variant === 'conversational' ? aside : trace}</div>
        </DrawerContent>
      </Drawer>
      <Drawer open={stepsDrawer} onOpenChange={setStepsDrawer}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 pb-6">{stepList}</div>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

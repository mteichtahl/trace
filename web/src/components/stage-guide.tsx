/**
 * "You are here", under the stage rail (docs/guided-flow.md, Screens): the current stage opens into two panels. Left:
 * "Stage 3 of 9 · Capture", what the stage is for, and its steps, each naming who does it (yours highlighted).
 * Right: what the gate needs, with a meter and its criteria, and "What happens in Capture" (the stage sheet).
 * On a phone the stage is a segmented bar with "step 3 of 5". The stage sheet answers what a stage is for, who does
 * what, what you get, how long it takes and what comes next, with its steps and their guided skills.
 */
import { Link } from '@tanstack/react-router'
import { ArrowRight, Check, Circle, CircleDashed, CircleDot, Loader2, MessageCircleQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Facts, SideSheet } from '@/components/side-sheet'
import { askTrace } from '@/components/chat/chat-state'
import { SKILLS } from '@/components/skills/definitions'
import { currentStage, gateMeter, gateOf, ownerWord, stageSteps, stepLabel, stepPlace } from '@/lib/guided'
import { stepLink } from '@/lib/step-skills'
import type { Gate, Journey, RunSummary, Stage, StageStep } from '@/lib/types'
import { cn } from '@/lib/utils'

/** The icon for a step's state; trace's step that runs after you is a dashed ring. */
function StepIcon({ s }: { s: StageStep }) {
  if (s.state === 'done') return <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-verified text-white"><Check className="size-3" strokeWidth={3} aria-hidden /></span>
  if (s.state === 'waived') return <Circle className="size-[18px] shrink-0 text-waived" aria-hidden />
  if (s.state === 'now') return <CircleDot className="size-[18px] shrink-0 text-primary" aria-hidden />
  if (s.owner === 'trace' && s.state === 'next') return <CircleDashed className="size-[18px] shrink-0 text-muted-foreground" aria-hidden />
  return <Circle className="size-[18px] shrink-0 text-muted-foreground/50" aria-hidden />
}

const STATE_WORD: Record<StageStep['state'], string> = { done: 'done', waived: 'waived', now: 'now', next: 'next', later: 'later' }

/** A stage's steps as a list: done ones struck through, the reader's own step on the accent. */
export function StepList({ steps, links, className }: { steps: StageStep[]; links?: { projectId: string; jobs?: RunSummary[] }; className?: string }) {
  return (
    <ol className={cn('space-y-0.5', className)}>
      {steps.map((s, i) => {
        const mine = s.owner === 'you' && s.state === 'now'
        const done = s.state === 'done' || s.state === 'waived'
        const skill = links ? stepLink(s, links) : undefined
        return (
          <li
            key={s.id}
            className={cn('-mx-2 flex items-center gap-3 rounded-md px-2 py-1.5 text-sm', mine && 'bg-primary-soft font-medium')}
            aria-label={`${s.text}: ${ownerWord(s)}, ${STATE_WORD[s.state]}`}
          >
            <StepIcon s={s} />
            <span className={cn('min-w-0 flex-1', done && 'text-muted-foreground line-through decoration-muted-foreground/50')}>
              {s.to && !done && !links ? <Link to={s.to} className="hover:underline">{s.text}</Link> : s.text}
              {skill && !done && (
                <>
                  <span className="text-muted-foreground"> · </span>
                  <Link to={skill.to} className="font-normal text-primary hover:underline">{skill.label}</Link>
                </>
              )}
            </span>
            <span className={cn('shrink-0 text-xs', mine ? 'font-medium text-primary' : 'text-muted-foreground')}>{stepLabel(steps, i)}</span>
          </li>
        )
      })}
    </ol>
  )
}

/** The overview's guide: two panels on desktop. */
export function StageGuidePanel({ j, admin, onWhat, className }: { j: Journey; admin?: boolean; onWhat: (s: Stage) => void; className?: string }) {
  const c = currentStage(j)
  if (!c) return null
  const gate = gateOf(j.gates, c.stage)
  const steps = stageSteps(c.stage, gate, { admin })
  const meter = gateMeter(gate, c.stage)
  return (
    <div className={cn('grid border-t md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]', className)} aria-label={`Where ${j.name} is`}>
      <div className="p-5 md:border-r">
        <p className="section-label">Stage {c.index + 1} of {c.total} · {c.stage.name}</p>
        {c.stage.guide && <p className="mt-1.5 text-sm">{c.stage.guide.purpose}</p>}
        {steps.length > 0 ? <StepList steps={steps} className="mt-3" /> : <p className="mt-3 text-sm text-muted-foreground">trace has not set out this stage's steps yet.</p>}
      </div>
      <GatePanel gate={gate} stage={c.stage} meter={meter} onWhat={() => onWhat(c.stage)} />
    </div>
  )
}

function GatePanel({ gate, stage, meter, onWhat }: { gate?: Gate; stage: Stage; meter: ReturnType<typeof gateMeter>; onWhat: () => void }) {
  return (
    <div className="border-t p-5 md:border-t-0">
      <p className="section-label">To pass the gate</p>
      <p className="mt-1.5 text-sm">
        {meter.total ? `${meter.met} of ${meter.total} criteria met` : 'No criteria yet'}
        {gate?.state === 'ready' && <span className="ml-2 text-primary">· ready to sign</span>}
      </p>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={meter.total} aria-valuenow={meter.met} aria-label={`${meter.met} of ${meter.total} criteria met`}>
        <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${Math.round(meter.frac * 100)}%` }} />
      </div>
      {gate && gate.criteria.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {gate.criteria.map((c) => {
            const met = c.status === 'met' || c.status === 'waived'
            return (
              <li key={c.id} className="flex items-center gap-3 text-sm">
                {met ? <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-verified text-white"><Check className="size-3" strokeWidth={3} aria-hidden /></span> : <Circle className="size-[18px] shrink-0 text-muted-foreground/50" aria-hidden />}
                <span className={cn(!met && 'text-foreground')}>{c.text}{c.status === 'waived' && <span className="text-muted-foreground"> (waived)</span>}</span>
                <span className="sr-only">{met ? 'met' : 'not met yet'}</span>
              </li>
            )
          })}
        </ul>
      )}
      <button type="button" onClick={onWhat} className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:underline">
        What happens in {stage.name} <ArrowRight className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}

/** The phone's stage: one segment per stage (done dark, current accent) and "step 3 of 5". */
export function StageSegments({ j, admin, onWhat, className }: { j: Journey; admin?: boolean; onWhat?: (s: Stage) => void; className?: string }) {
  const visible = j.stages.filter((s) => !(s.optional && s.state === 'skipped'))
  const c = currentStage(j)
  const place = c ? (j.next.step ?? stepPlace(stageSteps(c.stage, gateOf(j.gates, c.stage), { admin }))) : null
  const label = c ? `Stage ${c.index + 1} of ${c.total}, ${c.stage.name}${place ? `, step ${place.index} of ${place.total}` : ''}` : 'No stage in progress'
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{c ? `${c.stage.name}` : 'Stages'}<span className="font-normal text-muted-foreground">{c ? ` · stage ${c.index + 1} of ${c.total}` : ''}</span></span>
        {place && <span className="text-muted-foreground">step {place.index} of {place.total}</span>}
      </div>
      <div role="img" aria-label={label} className="flex gap-1">
        {visible.map((s) => (
          <span key={s.id} className={cn('h-1.5 flex-1 rounded-full', s.state === 'done' ? 'bg-foreground' : s.state === 'current' || s.state === 'reopened' ? 'bg-primary' : 'bg-muted')} />
        ))}
      </div>
      {c?.stage.guide && <p className="text-sm text-muted-foreground">{c.stage.guide.purpose}</p>}
      {c && onWhat && (
        <button type="button" onClick={() => onWhat(c.stage)} className="inline-flex min-h-11 items-center gap-1 text-sm text-primary">
          What happens in {c.stage.name} <ArrowRight className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  )
}

/** The stage sheet: any stage, from the rail or "What happens in …". */
export function StageSheet({ j, stage, admin, onOpenChange }: { j: Journey; stage: Stage | null; admin?: boolean; onOpenChange: (open: boolean) => void }) {
  const visible = j.stages.filter((s) => !(s.optional && s.state === 'skipped'))
  const i = stage ? visible.findIndex((s) => s.id === stage.id) : -1
  const g = stage?.guide
  const steps = stage ? stageSteps(stage, gateOf(j.gates, stage), { admin }) : []
  const skills = stage ? SKILLS.filter((k) => k.stage === stage.name) : []
  const nextName = g?.next?.split(':')[0]
  return (
    <SideSheet
      open={!!stage}
      onOpenChange={onOpenChange}
      title={<><span className="section-label block">Stage {i + 1} of {visible.length}</span><span className="mt-1 block text-lg">{stage?.name}</span></>}
      description={g?.purpose ?? 'trace has not written a guide for this stage yet.'}
    >
      {stage && (
        <div className="space-y-6">
          {g && (
            <Facts
              items={[
                ['You do', g.you_do],
                ['trace does', g.trace_does],
                ['You get', g.you_get],
                ['Typical time', g.typical_time],
                ['Comes next', g.next ? <><span className="font-semibold">{nextName}</span>{g.next.slice(nextName?.length ?? 0)}</> : 'Nothing: this is the last stage.'],
              ]}
            />
          )}
          {stage.state === 'queued' && <p className="text-sm text-muted-foreground">This stage starts once the gate before it is signed.{stage.prepared ? ` ${stage.prepared}` : ''}</p>}
          {steps.length > 0 && (
            <section>
              <h3 className="section-label mb-2">Steps</h3>
              <StepList steps={steps} links={{ projectId: j.repo.replace('/', '~'), jobs: j.jobs }} />
            </section>
          )}
          {skills.length > 0 && (
            <section>
              <h3 className="section-label mb-2">Guided skills for {stage.name}</h3>
              <ul className="space-y-1 text-sm">
                {skills.map((k) => (
                  <li key={k.id}>
                    <Link to="/p/$id/do/$skill" params={{ id: j.repo.replace('/', '~'), skill: k.id }} className="text-primary hover:underline">{k.name}</Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(stage.state === 'current' || stage.state === 'reopened') && (
            <section className="border-t pt-4">
              <h3 className="section-label">Stuck?</h3>
              <p className="mt-1 text-sm">Ask trace why this stage is taking long, and it will tell you what is blocking it.</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => { onOpenChange(false); askTrace(`Why is ${stage.name} taking long on ${j.name}? What is blocking it?`) }}>
                <MessageCircleQuestion /> Ask trace why this stage is taking long
              </Button>
            </section>
          )}
        </div>
      )}
    </SideSheet>
  )
}

/** A small "working" marker for places that wait on a mutation. */
export const Busy = () => <Loader2 className="animate-spin" aria-hidden />

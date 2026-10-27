/**
 * Checklist on a picture (docs/ui-design.md, "Focus mode": Bring-up run, Bench setup, Incoming inspection): the
 * picture fills the centre, the step's checklist sits beside it, ticked by the person (a wire connected) or by trace
 * (an instrument answered), and a live readout panel shows the instruments' values against their limits. A large
 * Stop is always visible during powered steps; any reading out of its limits says so at once.
 *
 * Stop asks trace to switch the supplies off (a `task` for the bench agent; the instruments themselves are driven
 * only on the bench machine, never from the web).
 */
import { ArrowRight, Bot, Hand, OctagonX } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { EmbeddedChat } from '@/components/chat/embedded-chat'
import { FocusLayout } from '@/components/focus/focus-layout'
import { StatusBadge } from '@/components/status-badge'
import { QueryError } from '@/components/states'
import { call } from '@/lib/api'
import { eng } from '@/lib/format'
import type { BenchReadout } from '@/lib/types-s1'
import { cn } from '@/lib/utils'
import { type SkillDef, pictureOf } from './definitions'
import { StepHeader, TraceIntro, Unavailable } from './parts'
import { StepPicture } from './step-picture'
import { type SkillDraftBase, qualityChecks, useSkill } from './use-skill'

interface Draft extends SkillDraftBase { ticked: string[] }

/** In limits, out of limits, or no reading. Pure. */
export function readoutState(r: BenchReadout): 'ok' | 'out' | 'none' {
  if (r.value === null) return 'none'
  if ((r.min !== undefined && r.value < r.min) || (r.max !== undefined && r.value > r.max)) return 'out'
  return 'ok'
}

export function ChecklistSkill({ repo, def }: { repo: string; def: SkillDef }) {
  const s = useSkill<Draft>(repo, def, { done: [], ticked: [] })
  const v = s.view.data
  const bench = v?.bench
  const [stopped, setStopped] = useState(false)
  const powered = !!bench?.powered && !stopped && (s.step.powered ?? false)
  const out = (bench?.readouts ?? []).filter((r) => readoutState(r) === 'out')
  const list = (bench?.checklist ?? []).filter((c) => (s.step.powered ? true : !c.powered))
  const isTicked = (id: string) => s.draft.data.ticked.includes(id) || !!bench?.checklist.find((c) => c.id === id)?.done
  const checks = qualityChecks(def, v, out.length ? { limits: 'not_met' } : {}, s.goTo)

  const stop = async () => {
    setStopped(true)
    try {
      await call('task', { repo, request: 'STOP: switch every bench supply output off now, then report the last readings.', agent: 'verify' })
      toast('Stop sent: trace is switching the supplies off.', { description: 'Nothing advances until you restart the step.' })
    } catch (e) {
      toast.error('Stop could not reach trace. Switch the supply off by hand.', { description: e instanceof Error ? e.message : String(e) })
    }
  }

  const aside = (
    <div className="space-y-5">
      <section aria-labelledby="readouts">
        <h2 id="readouts" className="text-sm font-semibold">Live readout</h2>
        {!bench?.readouts.length ? (
          <p className="mt-1 text-sm text-muted-foreground">No instruments are reporting. Bench setup connects them.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {bench.readouts.map((r) => {
              const st = readoutState(r)
              return (
                <li key={r.id} className={cn('rounded-lg border p-3', st === 'out' && 'border-destructive bg-destructive/5')}>
                  <p className="text-xs text-muted-foreground">{r.label}</p>
                  <p className="font-mono text-2xl font-semibold tabular-nums" aria-live="polite">{r.value === null ? '—' : eng(r.value, r.unit, 4)}</p>
                  <p className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>{r.min !== undefined ? eng(r.min, r.unit) : ''}{r.min !== undefined && r.max !== undefined ? ' to ' : ''}{r.max !== undefined ? `${r.min === undefined ? 'at most ' : ''}${eng(r.max, r.unit)}` : ''}</span>
                    <StatusBadge plain status={st === 'ok' ? 'met' : st === 'out' ? 'failing' : 'untested'} label={st === 'ok' ? 'In limits' : st === 'out' ? 'Out of limits' : 'No reading'} />
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby="checklist">
        <h2 id="checklist" className="text-sm font-semibold">Checklist · {s.step.title}</h2>
        <ul className="mt-2 space-y-2">
          {list.map((c) => {
            const done = isTicked(c.id)
            return (
              <li key={c.id}>
                <Label className={cn('flex items-start gap-2 font-normal', done && 'text-muted-foreground')}>
                  <Checkbox checked={done} disabled={c.by === 'trace'} onCheckedChange={(x) => s.draft.setData((d) => ({ ...d, ticked: x ? [...d.ticked, c.id] : d.ticked.filter((t) => t !== c.id) }))} className="mt-0.5" />
                  <span className="flex-1">{c.text}</span>
                  {c.by === 'trace' ? <Bot className="size-3.5 shrink-0" aria-label="Ticked by trace" /> : <Hand className="size-3.5 shrink-0" aria-label="Ticked by you" />}
                </Label>
              </li>
            )
          })}
          {list.length === 0 && <li className="text-sm text-muted-foreground">Nothing to tick in this step.</li>}
        </ul>
      </section>
    </div>
  )

  return (
    <FocusLayout
      title={def.name}
      context={s.context}
      variant="checklist"
      steps={s.steps}
      onStep={s.onStep}
      checks={checks}
      submitLabel={def.submit}
      onSubmit={() => s.submit()}
      onClose={s.close}
      draftSavedAt={s.draft.savedAt}
      aside={aside}
      stop={{ visible: powered, onStop: () => void stop() }}
      trace={<EmbeddedChat repo={repo} intro={<TraceIntro summary={v?.summary} step={s.step} def={def} />} placeholder="Note something about this step, or ask…" />}
    >
      <StepHeader def={def} index={s.stepIndex} />
      {out.length > 0 && (
        <p role="alert" className="mt-3 flex items-center gap-2 rounded-lg border border-destructive bg-destructive/10 px-3 py-2 text-sm">
          <OctagonX className="size-4 text-destructive" aria-hidden /> {out.map((r) => r.label).join(', ')} out of limits. The run stops here: nothing advances until it is back in limits.
        </p>
      )}
      {stopped && <p className="mt-3 rounded-lg border px-3 py-2 text-sm">Stopped. Supplies are being switched off. <Button variant="link" className="h-auto p-0" onClick={() => setStopped(false)}>Restart this step</Button></p>}
      {s.view.isError && <div className="mt-4"><QueryError error={s.view.error} what="the bench" onRetry={() => void s.view.refetch()} /></div>}
      <div className="mt-4">
        <StepPicture repo={repo} kind={pictureOf(def, s.step.id)} view={v} height={460} />
      </div>
      {/* the readout and checklist sit beside the picture from lg; under it on smaller screens */}
      <div className="mt-6 lg:hidden">{aside}</div>
      {s.stepIndex < def.steps.length - 1 && (
        <div className="mt-6 flex justify-end">
          <Button onClick={s.next} disabled={out.length > 0 || list.some((c) => !isTicked(c.id))}>Continue to {def.steps[s.stepIndex + 1]!.title.toLowerCase()} <ArrowRight /></Button>
        </div>
      )}
      <div className="mt-4"><Unavailable checks={s.view.data?.checks} def={def} /></div>
    </FocusLayout>
  )
}

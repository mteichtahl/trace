/** Small pieces every guided skill screen uses: the step header, trace's opening line, the honest checker note. */
import { Construction } from 'lucide-react'
import { Rich } from '@/components/rich'
import { Explained } from '@/components/term'
import type { SkillDef, SkillStep } from './definitions'

export function StepHeader({ def, index, extra }: { def: SkillDef; index: number; extra?: React.ReactNode }) {
  const step = def.steps[index]!
  return (
    <div>
      <p className="text-xs text-muted-foreground">Step {index + 1} of {def.steps.length}</p>
      <h1 className="mt-0.5 text-xl font-semibold tracking-tight">{step.title}</h1>
      <p className="mt-1 text-sm text-muted-foreground"><Explained text={step.detail} /></p>
      {extra}
    </div>
  )
}

/** trace's summary of the step, shown before anyone has said anything in the step's chat. */
export function TraceIntro({ summary, step, def }: { summary?: string; step: SkillStep; def: SkillDef }) {
  return (
    <div className="space-y-2 text-sm">
      {summary ? <p><Rich text={summary} /></p> : <p>You are on <span className="font-medium">{step.title.toLowerCase()}</span>. {step.detail}</p>}
      <p className="text-muted-foreground">Ask anything about this step: “why this part?”, “show me the datasheet page”. {def.produces ? `When you submit, trace records ${def.produces.charAt(0).toLowerCase()}${def.produces.slice(1)}` : ''}</p>
    </div>
  )
}

/** Said when the skill's checker has not reported: the bar waits for it rather than guessing. */
export function NoChecker({ def }: { def: SkillDef }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <Construction className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>The quality bar comes from {def.name}'s checker tool, which reports each check as Met or Not met. It has not reported here yet, so Submit waits for it (skill.get needs building).</span>
    </p>
  )
}

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
      <span>The quality bar comes from {def.name}'s checks of the record, which report each check as Met or Not met. They have not reported here yet, so Submit waits for them.</span>
    </p>
  )
}

/** The checks the record cannot answer yet, each with what has to be recorded first: Submit waits for them. */
export function Unavailable({ checks, def }: { checks?: { id: string; unavailable?: string }[]; def: SkillDef }) {
  const open = (checks ?? []).filter((c) => c.unavailable)
  if (!open.length) return null
  return (
    <div className="space-y-1 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <p className="flex items-center gap-2"><Construction className="size-3.5 shrink-0" aria-hidden />{open.length === 1 ? 'One check' : `${open.length} checks`} of the bar cannot be checked from the record yet, so Submit waits for {open.length === 1 ? 'it' : 'them'}:</p>
      <ul className="ml-5 list-disc space-y-0.5">
        {open.map((c) => <li key={c.id}><span className="font-medium">{def.checks.find((x) => x.id === c.id)?.text ?? c.id}</span>: needs {c.unavailable}.</li>)}
      </ul>
    </div>
  )
}

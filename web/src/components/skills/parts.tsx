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
/** The draft's confirmations of checks no tool can make yet (skill-checks.ts `yours`): confirmed[check id]. */
export interface Confirmable { data: { confirmed?: Record<string, boolean> }; setData: (fn: (d: { confirmed?: Record<string, boolean> }) => { confirmed?: Record<string, boolean> }) => void }

export function Unavailable({ checks, def, draft }: { checks?: { id: string; unavailable?: string; confirmable?: boolean; confirmed?: boolean }[]; def: SkillDef; draft?: Confirmable }) {
  const open = (checks ?? []).filter((c) => c.unavailable || c.confirmed)
  if (!open.length) return null
  const waiting = open.filter((c) => !c.confirmed && !(draft && c.confirmable))
  const yours = draft ? open.filter((c) => c.confirmable || c.confirmed) : []
  const text = (id: string) => def.checks.find((x) => x.id === id)?.text ?? id
  const set = (id: string, v: boolean) => draft?.setData((d) => ({ ...d, confirmed: { ...(d.confirmed ?? {}), [id]: v } }))
  return (
    <div className="space-y-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      {waiting.length > 0 && (
        <>
          <p className="flex items-center gap-2"><Construction className="size-3.5 shrink-0" aria-hidden />{waiting.length === 1 ? 'One check' : `${waiting.length} checks`} of the bar cannot be checked from the record yet, so Submit waits for {waiting.length === 1 ? 'it' : 'them'}:</p>
          <ul className="ml-5 list-disc space-y-0.5">
            {waiting.map((c) => <li key={c.id}><span className="font-medium">{text(c.id)}</span>: needs {c.unavailable}.</li>)}
          </ul>
        </>
      )}
      {yours.length > 0 && (
        <>
          <p className="flex items-center gap-2"><Construction className="size-3.5 shrink-0" aria-hidden />trace cannot check {yours.length === 1 ? 'this' : 'these'} from the record yet, so {yours.length === 1 ? 'it is' : 'they are'} yours to check and confirm:</p>
          <ul className="space-y-1.5">
            {yours.map((c) => (
              <li key={c.id}>
                <label className="flex items-start gap-2 text-foreground">
                  <input type="checkbox" className="mt-0.5" checked={draft?.data.confirmed?.[c.id] === true} onChange={(e) => set(c.id, e.target.checked)} />
                  <span><span className="font-medium">I checked it: {text(c.id).replace(/^./, (x) => x.toLowerCase())}</span>{c.unavailable ? <span className="block text-muted-foreground">trace would need {c.unavailable}.</span> : null}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/**
 * What the design skills add to a stepped skill's screen, so the draft carries the decisions Submit records
 * (src/api/actions-skills.ts pendingDecisions; design.decide's shapes):
 *
 *   Requirements review  per requirement: accept, or strike with a reason (draft.decisions); per intent line no
 *                        requirement covers: leave it out with a reason (draft.uncovered)
 *   Architecture choice  the criteria step fixes the criteria and their weights now, before any score is read
 *                        (design.decide criteria: "criteria fixed before scoring" checks it was first); the choose
 *                        step names the criteria that decided it (draft.deciding); the option and its reason come
 *                        from the decision card above (draft.choice)
 *   Pin plan review      nothing to add: Submit agrees every part's plan as it stands, once its checks pass
 *
 * The quality bar is the server's, computed with this draft laid over the record, so it moves as the person decides.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatusBadge } from '@/components/status-badge'
import { ArchitectureSummary, OptionSwitch, OptionsTable, drawn, useOption } from '@/components/project/architecture'
import { BlockDiagram } from '@/components/project/block-diagram'
import { useCall } from '@/lib/queries'
import type { ArchitectureRecord } from '@/lib/types-s1'
import type { SkillView } from '@/lib/types-s1'

export interface DesignDraft {
  decisions?: { requirement: string; choice: 'accept' | 'strike'; reason?: string }[]
  uncovered?: { statement: string; reason: string }[]
  deciding?: string[]
  /** Resolve conflicts: the person confirms no two requirements contradict each other (no tool compares their numbers) */
  no_conflicts?: boolean
}

type Set = (fn: (d: DesignDraft) => DesignDraft) => void

/** A requirement's decision in the draft, replaced. Pure. */
export function withDecision(d: DesignDraft, requirement: string, choice: 'accept' | 'strike' | null, reason?: string): DesignDraft {
  const rest = (d.decisions ?? []).filter((x) => x.requirement !== requirement)
  return { ...d, decisions: choice ? [...rest, { requirement, choice, ...(reason ? { reason } : {}) }] : rest }
}

export function DesignSteps({ repo, skill, step, view, draft, setDraft }: { repo: string; skill: string; step: string; view?: SkillView; draft: DesignDraft; setDraft: Set }) {
  if (skill === 'requirements-review' && (step === 'decide' || step === 'cover')) return <ReviewItems view={view} draft={draft} setDraft={setDraft} only={step === 'decide' ? 'requirement' : 'intent'} />
  if (skill === 'requirements-review' && step === 'conflicts') return <NoConflicts draft={draft} setDraft={setDraft} />
  if (skill === 'architecture-choice' && (step === 'read' || step === 'score')) return <CompareOptions view={view} scores={step === 'score'} />
  if (skill === 'architecture-choice' && step === 'criteria') return <FixCriteria repo={repo} view={view} />
  if (skill === 'architecture-choice' && step === 'choose') return <Deciding view={view} draft={draft} setDraft={setDraft} />
  return null
}

function ReviewItems({ view, draft, setDraft, only }: { view?: SkillView; draft: DesignDraft; setDraft: Set; only: 'requirement' | 'intent' }) {
  const items = (view?.items ?? []).filter((i) => i.id.startsWith(`${only}:`))
  const [reasons, setReasons] = useState<Record<string, string>>({})
  if (!items.length) return null
  return (
    <section className="mt-6" aria-labelledby="design-decide">
      <h2 id="design-decide" className="text-base font-semibold">{only === 'requirement' ? 'Accept or strike' : 'Intent no requirement covers'}</h2>
      <ul className="mt-2 divide-y rounded-xl border">
        {items.map((it) => {
          const id = it.id.slice(only.length + 1)
          const d = only === 'requirement' ? draft.decisions?.find((x) => x.requirement === id) : undefined
          const left = only === 'intent' ? draft.uncovered?.find((x) => x.statement === id) : undefined
          const reason = reasons[id] ?? d?.reason ?? left?.reason ?? ''
          return (
            <li key={it.id} className="space-y-2 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">{it.title}<span className="block text-xs text-muted-foreground">{it.detail}</span></span>
                {d && <StatusBadge status={d.choice === 'accept' ? 'met' : 'waived'} label={d.choice === 'accept' ? 'Accept' : 'Strike'} />}
                {left && <StatusBadge status="waived" label="Left out" />}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Label className="sr-only" htmlFor={`r-${id}`}>Reason</Label>
                <Input id={`r-${id}`} className="h-8 max-w-md flex-1" placeholder={only === 'requirement' ? 'Reason (needed to strike)' : 'Why no requirement covers it'} value={reason} onChange={(e) => setReasons((r) => ({ ...r, [id]: e.target.value }))} />
                {only === 'requirement' ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setDraft((x) => withDecision(x, id, 'accept'))}>Accept</Button>
                    <Button size="sm" variant="outline" disabled={reason.trim().length < 3} onClick={() => setDraft((x) => withDecision(x, id, 'strike', reason.trim()))}>Strike</Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" disabled={reason.trim().length < 3} onClick={() => setDraft((x) => ({ ...x, uncovered: [...(x.uncovered ?? []).filter((u) => u.statement !== id), { statement: id, reason: reason.trim() }] }))}>Leave out</Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function FixCriteria({ repo, view }: { repo: string; view?: SkillView }) {
  const a = view?.architecture
  const fix = useCall('design.decide', (x) => [['skill.get', x.repo], ['design.get', x.repo], ['journey.get', x.repo]])
  const [weights, setWeights] = useState<Record<string, number>>({})
  if (!a) return null
  if (a.fixed) return <p className="mt-4 text-sm"><StatusBadge status="met" label="Criteria fixed" /> by {a.fixed.by}. Changing them now means choosing again.</p>
  return (
    <section className="mt-6" aria-labelledby="crit">
      <h2 id="crit" className="text-base font-semibold">The criteria and their weights</h2>
      <p className="mt-1 text-sm text-muted-foreground">Fix them before reading any score, so the choice cannot be made on a criterion picked afterwards.</p>
      <ul className="mt-2 space-y-2">
        {(a.criteria ?? []).map((c) => (
          <li key={c.id} className="flex items-center gap-3 text-sm">
            <span className="w-40">{c.name}</span>
            <Label className="sr-only" htmlFor={`w-${c.id}`}>Weight of {c.name}</Label>
            <Input id={`w-${c.id}`} type="number" min={0} max={10} step={0.5} className="h-8 w-24" value={weights[c.id] ?? c.weight} onChange={(e) => setWeights((w) => ({ ...w, [c.id]: Number(e.target.value) }))} />
          </li>
        ))}
      </ul>
      <Button className="mt-3" size="sm" disabled={!(a.criteria ?? []).length || fix.isPending} onClick={() => fix.mutate({ repo, decision: { kind: 'criteria', criteria: (a.criteria ?? []).map((c) => ({ id: c.id, name: c.name, weight: weights[c.id] ?? c.weight })) } }, { onSuccess: () => toast('Criteria fixed.'), onError: (e) => toast.error('The criteria were not fixed.', { description: e.message }) })}>
        Fix these criteria
      </Button>
    </section>
  )
}

function Deciding({ view, draft, setDraft }: { view?: SkillView; draft: DesignDraft; setDraft: Set }) {
  const criteria = view?.architecture?.criteria ?? []
  if (!criteria.length) return null
  const on = new Set(draft.deciding ?? [])
  return (
    <fieldset className="mt-4 space-y-2">
      <legend className="text-sm font-medium">Which criteria decided it?</legend>
      {criteria.map((c) => (
        <Label key={c.id} className="flex items-center gap-2 font-normal">
          <Checkbox checked={on.has(c.id)} onCheckedChange={(v) => setDraft((d) => ({ ...d, deciding: v ? [...new Set([...(d.deciding ?? []), c.id])] : (d.deciding ?? []).filter((x) => x !== c.id) }))} />
          {c.name}
        </Label>
      ))}
    </fieldset>
  )
}

/**
 * Resolve conflicts: trace has checked for duplicates and for requirements drawn from intent still in conflict; no tool
 * compares the requirements' own numbers, so the person reads them together and confirms (draft.no_conflicts).
 */
function NoConflicts({ draft, setDraft }: { draft: DesignDraft; setDraft: Set }) {
  return (
    <section className="mt-6 space-y-2" aria-labelledby="no-conflicts">
      <h2 id="no-conflicts" className="text-base font-semibold">Do any two requirements contradict each other?</h2>
      <p className="text-sm text-muted-foreground">trace found no duplicates and no requirement drawn from intent still in conflict. No tool compares the requirements&apos; own numbers (a power budget against a draw, a size against a connector), so read them together. If two cannot both hold, strike or reword one in Decide.</p>
      <Label className="flex items-center gap-2 font-normal">
        <Checkbox checked={draft.no_conflicts === true} onCheckedChange={(v) => setDraft((d) => ({ ...d, no_conflicts: v === true }))} />
        I read them together: no two requirements contradict each other.
      </Label>
    </section>
  )
}

/** The steps that take the stage picture's place for Architecture choice: each option's own diagram. */
export const ARCH_COMPARE_STEPS: readonly string[] = ['read', 'score']

/**
 * Read each option / Score: every option, switched with the layout held still (its block diagram, what it is, why,
 * what it gives up, its risks and the requirements none of its blocks serve), and on Score the options side by side on
 * the fixed criteria with each score's reason. The same pieces as the Design tab (components/project/architecture).
 */
function CompareOptions({ view, scores }: { view?: SkillView; scores: boolean }) {
  const a = view?.architecture as (ArchitectureRecord & { options: NonNullable<ArchitectureRecord['options']> }) | undefined
  const [current, setCurrent] = useOption(a)
  if (!a?.options.length) return null
  const o = a.options.find((x) => x.id === current)
  const requirements = [...new Set(a.options.flatMap((x) => x.blocks.flatMap((b) => b.serves)))]
  return (
    <section className="mt-4 space-y-4" aria-labelledby="compare-options">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="compare-options" className="text-base font-semibold">{a.options.length} options{o ? `: option ${o.id}, ${o.name}` : ''}</h2>
        <OptionSwitch a={a} value={current} onChange={setCurrent} />
      </div>
      <div className="overflow-hidden rounded-xl border bg-muted/20 p-2">
        <div className="origin-top-left scale-[0.5] sm:scale-[0.75] 2xl:scale-90"><BlockDiagram {...drawn(a, current)} /></div>
      </div>
      {o && (
        <div className="space-y-1 text-sm">
          <p>{o.summary}</p>
          {o.why && <p className="text-muted-foreground"><span className="font-medium text-foreground">Why:</span> {o.why}</p>}
          {o.gives_up && <p className="text-muted-foreground"><span className="font-medium text-foreground">Gives up:</span> {o.gives_up}</p>}
        </div>
      )}
      <ArchitectureSummary a={a} current={current} requirements={requirements} />
      {scores && <OptionsTable a={a} current={current} />}
    </section>
  )
}

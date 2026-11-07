/**
 * What a guided skill's Submit came to, said on the skill's own page (test-esp32 #89: Submit went back to the
 * Overview, which still said the criterion was not met and the draft was kept; a check had refused it, and nothing on
 * screen said so). Every skill's Submit goes through use-skill, which keeps one of these:
 *
 *   refused  the record refused it (a check not met when checked again, a decision it cannot record, an open question
 *            first): what blocked it in the record's own words, a button to each step that fixes it, the draft kept
 *   partly   it was recorded, but a gate criterion it sets is still not met (a requirement left under an open
 *            question): what it recorded, which criterion, why and what to do, with the step that fixes it; the
 *            draft kept, so the person carries on from here
 *
 * A submission that met everything says what it recorded and returns (use-skill); the criteria it set are written into
 * the journey on screen at once (applyCriteria), before the refetch after-write.ts starts brings the rest.
 */
import type { QueryClient } from '@tanstack/react-query'
import { ArrowRight, CircleAlert, CircleCheck, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SubmitCriterion } from '@/lib/api'
import type { Journey, NextStep } from '@/lib/types'
import { type SkillDef, checksOf } from './definitions'

export type SubmitOutcome =
  | { kind: 'refused'; message: string; fix: { text: string; step: string }[] }
  | { kind: 'partly'; recorded?: string; left: SubmitCriterion[]; met: SubmitCriterion[] }

/** The answer of a submission, as far as the outcome reads it (skill.submit's; a custom Submit's may have none). */
type Answer = { recorded?: unknown; criteria?: unknown } | null | undefined

const criteriaOf = (r: Answer): SubmitCriterion[] =>
  r && typeof r === 'object' && Array.isArray(r.criteria) ? (r.criteria as SubmitCriterion[]).filter((c) => c && typeof c.id === 'string') : []
const recordedOf = (r: Answer): string | undefined => (r && typeof r === 'object' && typeof r.recorded === 'string' && r.recorded ? r.recorded : undefined)

/** A refusal: the record's words, and the skill's checks it names (skill.submit names each by its text). Pure. */
export function refusedOutcome(def: SkillDef, message: string): SubmitOutcome {
  const fix = checksOf(def).filter((c) => c.step && message.includes(c.text)).map((c) => ({ text: c.text, step: c.step! }))
  return { kind: 'refused', message, fix }
}

/** A submission recorded with a criterion it sets still not met is partly refused; null when nothing is left. Pure. */
export function partlyOutcome(result: unknown): SubmitOutcome | null {
  const criteria = criteriaOf(result as Answer)
  const left = criteria.filter((c) => c.status === 'not_met')
  return left.length ? { kind: 'partly', recorded: recordedOf(result as Answer), left, met: criteria.filter((c) => c.status === 'met') } : null
}

/** What a submission that met everything says: what it recorded and the criteria it met, after `done`. Pure. */
export function doneWords(done: string, result: unknown): string {
  const recorded = recordedOf(result as Answer)
  const met = criteriaOf(result as Answer).filter((c) => c.status === 'met')
  const extra = [recorded ? `Recorded: ${recorded}.` : '', met.length ? `Met: ${met.map((c) => c.text.replace(/\.$/, '')).join('; ')}.` : ''].filter(Boolean)
  return [done, ...extra].join(' ')
}

/** The next step while the journey is read again after a submission met the criterion it was about. */
export const SUBMITTED_STEP: NextStep = { kind: 'working', owner: 'trace', summary: 'Submitted. trace works out what comes next.', short: 'trace works out what comes next' }

const isMet = (s: string): boolean => s === 'met' || s === 'waived'

/**
 * The criteria a submission set, written into the journey on screen at once (met or not, as recorded), and everything
 * on screen that counts them with it: the stage's count, and the next step. A next step about a criterion now met
 * gives way to SUBMITTED_STEP; another one's "(0 of 3 criteria met)" is counted again. Before, the gate box said
 * "1 of 3 criteria met" while the next step card still said "(0 of 3 criteria met) … Continue" until the journey was
 * read again (test-esp32-run2 R32).
 */
export function applyCriteria(qc: Pick<QueryClient, 'setQueriesData'>, repo: string, result: unknown): void {
  const set = new Map(criteriaOf(result as Answer).map((c) => [c.id, c.status]))
  if (!set.size) return
  qc.setQueriesData<Journey>({ queryKey: ['journey.get', repo] }, (j) => {
    if (!j || !Array.isArray(j.gates)) return j
    const changed = new Set<string>()
    const gates = j.gates.map((g) => {
      if (!g.criteria.some((c) => set.has(c.id))) return g
      changed.add(g.id)
      return { ...g, criteria: g.criteria.map((c) => (set.has(c.id) ? { ...c, status: set.get(c.id)! } : c)) }
    })
    const metOf = (g: Journey['gates'][number]) => g.criteria.filter((c) => isMet(c.status)).length
    // a stage's count is its gates' (src/core/journey.ts journeyView)
    const stages = Array.isArray(j.stages) ? j.stages.map((s) => {
      const own = gates.filter((g) => g.after === s.id)
      return own.some((g) => changed.has(g.id)) && s.criteria ? { ...s, criteria: { ...s.criteria, met: own.reduce((n, g) => n + metOf(g), 0) } } : s
    }) : j.stages
    const ref = j.next?.ref?.kind === 'criterion' ? j.next.ref.id : null
    let next = j.next
    if (ref && set.has(ref) && isMet(set.get(ref)!)) next = SUBMITTED_STEP
    else if (next?.why) {
      const g = gates.find((x) => (ref ? x.criteria.some((c) => c.id === ref) : changed.has(x.id)))
      if (g && changed.has(g.id)) next = { ...next, why: next.why.replace(/\b\d+ of \d+ criteria met\b/, `${metOf(g)} of ${g.criteria.length} criteria met`) }
    }
    return { ...j, gates, stages, next }
  })
}

/** Criteria not met for the same reason, said once ("A; B: not met. why"). Pure. */
export function sameWhy(left: readonly SubmitCriterion[]): { ids: string; texts: string; why?: string; step?: string }[] {
  const groups = new Map<string, SubmitCriterion[]>()
  for (const c of left) { const k = `${c.why ?? ''}|${c.step ?? ''}`; groups.set(k, [...(groups.get(k) ?? []), c]) }
  const lower = (t: string, i: number): string => (i ? t.charAt(0).toLowerCase() + t.slice(1) : t)
  return [...groups.values()].map((cs) => ({ ids: cs.map((c) => c.id).join(','), texts: cs.map((c, i) => lower(c.text.replace(/\.$/, ''), i)).join('; '), why: cs[0]!.why, step: cs[0]!.step }))
}

/** The outcome on the skill's page, just above Submit. */
export function SubmitOutcomePanel({ def, outcome, onJump, onDismiss }: { def: SkillDef; outcome: SubmitOutcome; onJump: (step: string) => void; onDismiss: () => void }) {
  const title = (id: string): string => def.steps.find((s) => s.id === id)?.title ?? id
  const go = (step: string) => (
    <Button size="sm" variant="outline" className="h-8" onClick={() => onJump(step)}>
      Go to {title(step).toLowerCase()} <ArrowRight />
    </Button>
  )
  const refused = outcome.kind === 'refused'
  return (
    <section
      role={refused ? 'alert' : 'status'}
      aria-labelledby="submit-outcome"
      className={refused ? 'rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm' : 'rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm'}
      data-testid="submit-outcome"
    >
      <div className="flex items-start gap-2">
        <CircleAlert className={refused ? 'mt-0.5 size-4 shrink-0 text-destructive' : 'mt-0.5 size-4 shrink-0 text-warning-foreground'} aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <h2 id="submit-outcome" className="font-semibold">
            {refused ? `${def.name} was not submitted` : `${def.name} was submitted, but not everything is met yet`}
          </h2>
          {outcome.kind === 'refused' ? (
            <>
              <p>{outcome.message}</p>
              {outcome.fix.length > 0 && <div className="flex flex-wrap gap-2">{outcome.fix.map((f) => <span key={f.text}>{go(f.step)}</span>)}</div>}
              <p className="text-muted-foreground">Your draft is kept. Fix what is named above, then submit again.</p>
            </>
          ) : (
            <>
              {outcome.recorded && <p>Recorded: {outcome.recorded}.</p>}
              <ul className="space-y-2">
                {sameWhy(outcome.left).map((g, i, all) => (
                  <li key={g.ids} className="space-y-1">
                    <p><span className="font-medium">{g.texts}: not met.</span>{g.why ? ` ${g.why}` : ''}</p>
                    {/* one button per step: a second "Go to decide" adds nothing */}
                    {g.step && def.steps.some((s) => s.id === g.step) && !all.slice(0, i).some((x) => x.step === g.step) && go(g.step)}
                  </li>
                ))}
              </ul>
              {outcome.met.length > 0 && (
                <p className="flex items-start gap-1.5 text-muted-foreground"><CircleCheck className="mt-0.5 size-3.5 shrink-0 text-verified" aria-hidden />Met: {outcome.met.map((c) => c.text.replace(/\.$/, '')).join('; ')}.</p>
              )}
              <p className="text-muted-foreground">Your draft is kept at this step. When it is done, submit again.</p>
            </>
          )}
        </div>
        <Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label="Hide this message" onClick={onDismiss}><X /></Button>
      </div>
    </section>
  )
}

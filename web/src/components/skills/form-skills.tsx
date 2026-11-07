/**
 * The two form skills (docs/user-journey.md, "Waiver" and "Change request"), stepped:
 *
 * - Waiver: what is waived (with trace's recommendation: waive or fix now), the reason, the risk and its severity,
 *   where it is caught instead, the scope → waiver.add. "Not needed" alone is refused; a safety waiver must name
 *   where it is verified and cannot be accepted for good. Taken again from an earlier waiver (`replaces`, its "Take it
 *   again"), the form opens filled in from that one, and taking the new one withdraws it (test-esp32 #149).
 * - Change request: what changes and why, the impact trace traced (stages that reopen, gates to re-sign, evidence that
 *   goes stale, cost and time) acknowledged, the scope → a `task` for the agents to raise it for approval at a gate.
 *   A released revision is never edited: a change to it opens the next revision.
 */
import { ArrowRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { EmbeddedChat } from '@/components/chat/embedded-chat'
import { DecisionCard } from '@/components/decision-card'
import { EvidenceChip } from '@/components/evidence-chip'
import { FocusLayout } from '@/components/focus/focus-layout'
import { StatusBadge } from '@/components/status-badge'
import { RATINGS } from '@/components/waiver-rating'
import { QueryError } from '@/components/states'
import { call } from '@/lib/api'
import { useJourney } from '@/lib/queries'
import type { CriterionStatus, Waiver } from '@/lib/types'
import { cn } from '@/lib/utils'
import { type SkillDef, pictureOf } from './definitions'
import { StepHeader, TraceIntro, Unavailable, type Confirmable } from './parts'
import { StepPicture } from './step-picture'
import { type SkillDraftBase, draftChecks, qualityChecks, useSkill } from './use-skill'

// ------------------------------------------------------------------ waiver

export type Severity = 'cosmetic' | 'degraded' | 'failure' | 'safety'
export interface WaiverDraft extends SkillDraftBase {
  what?: string
  custom?: string
  reason: string
  risk: string
  severity?: Severity
  caught: 'later' | 'bench' | 'nowhere' | ''
  where: string
  scope: 'revision' | 'condition' | ''
  condition: string
  reasonAgainst?: string
  /** the waiver this one takes again: withdrawn when this one is taken */
  replaces?: string
}

/**
 * A draft filled in from a waiver taken before ("Take it again"): what it waives, its reason, risk, severity, where
 * it is caught instead and its scope, as the record has them (src/api/actions-skills.ts writes "On the bench: …" and
 * "At a later stage: …"; one recorded from an answer keeps the agent's words, read as a later stage). Pure.
 */
export function draftFrom(w: Waiver): Partial<WaiverDraft> {
  const caught = w.caught ?? ''
  const bench = /^On the bench:\s*/i.exec(caught)
  const later = /^At a later stage:\s*/i.exec(caught)
  const nowhere = !caught.trim() || /^Nowhere\b/i.test(caught)
  const until = /^until\s+(.+)$/i.exec((w.scope ?? '').trim())
  return {
    replaces: w.id,
    ...(w.target ? { what: `${w.target.kind}:${w.target.id}` } : {}),
    reason: w.reason, risk: w.riskText ?? '',
    ...(w.severity && ['cosmetic', 'degraded', 'failure', 'safety'].includes(w.severity) ? { severity: w.severity as Severity } : {}),
    caught: nowhere ? 'nowhere' : bench ? 'bench' : 'later',
    where: nowhere ? '' : caught.slice((bench ?? later)?.[0].length ?? 0),
    scope: until ? 'condition' : 'revision', condition: until?.[1] ?? '',
  }
}

const VAGUE = /^(not needed|n\/?a|none|no need|unnecessary|not required|later|tbd|-+)\.?$/i

/**
 * What the "What is waived" step lists: the chosen item first, and only it while `all` is false (opened from a finding's
 * "Waive this one…", test-esp32 #148: the chosen finding sat 28th, below the fold, and read as if nothing were chosen).
 * Nothing chosen, or a choice not in the list: all of them, in their order. Pure.
 */
export function waivableShown<T extends { id: string }>(list: readonly T[], what: string | undefined, all: boolean): T[] {
  const chosen = list.find((w) => w.id === what)
  if (!chosen) return [...list]
  return all ? [chosen, ...list.filter((w) => w !== chosen)] : [chosen]
}

/**
 * The "Where exactly" example, for what is waived and where it is caught: a rule check's finding is run again on the
 * release files, a stock finding when the order is placed, a requirement in a later stage's simulation, anything on
 * the bench in a bring-up step. Pure.
 */
export function whereExample(caught: WaiverDraft['caught'], kind: 'requirement' | 'finding' | 'test' | undefined, title = ''): string {
  if (caught === 'bench') return kind === 'finding' ? 'Bring-up step 1 (inspect the part on the assembled board)' : 'Bring-up step 3 (unpowered rail check)'
  if (kind === 'finding' && /\bstock\b/i.test(title)) return 'Fabricate: the stock check when the order is placed'
  if (kind === 'finding') return 'Sign-off: the rule checks on the release files'
  if (kind === 'test') return 'Bring-up: the same test on the first assembled board'
  return 'Prove: SPICE stability run on the LDO'
}

/** The waiver's quality bar, worked out from the form. Pure, so it is tested on its own. */
export function waiverChecks(d: WaiverDraft): Record<string, CriterionStatus> {
  const reasonOk = d.reason.trim().length >= 12 && !VAGUE.test(d.reason.trim())
  const safety = d.severity === 'safety'
  return {
    what: d.what && (d.what !== 'other' || d.custom?.trim()) ? 'met' : 'not_met',
    reason: reasonOk ? 'met' : 'not_met',
    risk: d.risk.trim().length >= 8 && !!d.severity ? 'met' : 'not_met',
    safety: !safety ? (d.caught ? 'met' : 'not_met') : d.caught && d.caught !== 'nowhere' && d.where.trim().length >= 3 ? 'met' : 'not_met',
    scope: d.scope === 'revision' || (d.scope === 'condition' && d.condition.trim().length >= 3) ? 'met' : 'not_met',
  }
}

// the same words wherever a waiver's rating is shown (components/waiver-rating.tsx)
const SEVERITIES = RATINGS

export function WaiverSkill({ repo, def, about, replaces }: { repo: string; def: SkillDef; about?: string | undefined; replaces?: string | undefined }) {
  const s = useSkill<WaiverDraft>(repo, def, { done: [], what: about, reason: '', risk: '', caught: '', where: '', scope: '', condition: '' })
  const v = s.view.data
  const d = s.draft.data
  const set = (p: Partial<WaiverDraft>) => s.draft.setData((x) => ({ ...x, ...p }))
  // taken again: filled in from the waiver once it is read, over any draft kept from before
  const j = useJourney(repo)
  const from = replaces ? j.data?.waivers.find((w) => w.id === replaces && !w.closed) : undefined
  useEffect(() => {
    if (from && d.replaces !== from.id) s.draft.setData((x) => ({ ...x, ...draftFrom(from) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from?.id])
  // what it waives is waived now, so the skill does not offer it: it is offered here, first
  const waivable = [
    ...(from?.target && !v?.waivable?.some((w) => w.id === `${from.target!.kind}:${from.target!.id}`)
      ? [{ id: `${from.target.kind}:${from.target.id}`, kind: (from.target.kind === 'finding' || from.target.kind === 'test' ? from.target.kind : 'requirement') as 'requirement' | 'finding' | 'test', title: from.title, why: `Waived now by ${from.id}, which taking this one withdraws.` }]
      : []),
    ...(v?.waivable ?? []),
  ]
  // a finding it was opened with ("Waive this one…") that the list does not name: still the one chosen, in the gate's words
  const opened = d.what?.startsWith('finding:') && !waivable.some((w) => w.id === d.what)
    ? j.data?.gates.flatMap((g) => g.criteria.flatMap((c) => c.findings ?? [])).find((f) => `finding:${f.id}` === d.what)
    : undefined
  if (opened) waivable.unshift({ id: `finding:${opened.id}`, kind: 'finding', title: opened.text })
  const target = waivable.find((w) => w.id === d.what)
  // opened with something chosen ("Waive this one…", "Take it again"): only it, until the person asks for the rest
  const [all, setAll] = useState(!about && !replaces)
  const shown = waivableShown(waivable, d.what, all)
  const againstRec = target?.recommendation === 'fix'
  const local = { ...waiverChecks(d), reasons: againstRec && (d.reasonAgainst ?? '').trim().length < 3 ? 'not_met' as const : 'met' as const }
  const checks = qualityChecks(def, v, { ...draftChecks(v, s.draft.data), ...local }, s.goTo)

  return (
    <FocusLayout
      title={def.name}
      context={s.context}
      steps={s.steps}
      onStep={s.onStep}
      checks={checks}
      submitLabel={def.submit}
      onClose={s.close}
      outcome={s.outcome}
      draftSavedAt={s.draft.savedAt}
      onSubmit={() => s.submit(() => call('skill.submit', { repo, skill: def.id, draft: d }), d.replaces ? `Waiver taken again. ${d.replaces} is withdrawn, and the record keeps both.` : 'Waiver taken. It is listed at every later gate until it closes.')}
      trace={<EmbeddedChat repo={repo} intro={<TraceIntro summary={v?.summary} step={s.step} def={def} />} />}
    >
      <StepHeader def={def} index={s.stepIndex} />
      {d.replaces && (
        <p className="mt-4 rounded-lg border bg-muted/40 p-3 text-sm">
          Taking {d.replaces} again: it is filled in as it was taken. Correct what was wrong; taking this one withdraws {d.replaces}, and the record keeps both.
        </p>
      )}
      {s.view.isError && <div className="mt-4"><QueryError error={s.view.error} what="what can be waived" onRetry={() => void s.view.refetch()} /></div>}
      <div className="mt-5 space-y-4">
        {s.step.id === 'what' && (
          <>
            <RadioGroup value={d.what ?? ''} onValueChange={(x) => set({ what: x })} aria-label="What is waived" className="gap-2">
              {shown.map((w) => (
                <Label key={w.id} className="flex cursor-pointer items-start gap-3 rounded-xl border p-4 font-normal has-[[data-state=checked]]:border-primary">
                  <RadioGroupItem value={w.id} className="mt-0.5" />
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-2"><span className="font-medium">{w.title}</span><span className="text-xs capitalize text-muted-foreground">{w.kind}</span></span>
                    {w.recommendation && <span className="block text-sm"><span className={cn('rounded-sm px-1.5 py-0.5 text-xs', w.recommendation === 'waive' ? 'bg-primary/10 text-primary' : 'bg-muted')}>trace recommends: {w.recommendation === 'waive' ? 'waive' : 'fix it now'}</span> <span className="text-muted-foreground">{w.why}</span></span>}
                    {!w.recommendation && w.why && <span className="block text-sm text-muted-foreground">{w.why}</span>}
                    {w.evidence && <EvidenceChip evidence={w.evidence} />}
                  </span>
                </Label>
              ))}
              {shown.length < waivable.length ? (
                <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setAll(true)}>Choose something else ({waivable.length - shown.length} more)</Button>
              ) : (
              <Label className="flex cursor-pointer items-start gap-3 rounded-xl border p-4 font-normal has-[[data-state=checked]]:border-primary">
                <RadioGroupItem value="other" className="mt-0.5" />
                <span className="flex-1 space-y-2">
                  <span className="font-medium">Something else</span>
                  {d.what === 'other' && <Input value={d.custom ?? ''} onChange={(e) => set({ custom: e.target.value })} placeholder="The requirement, finding or test, by its id" aria-label="What is waived" />}
                </span>
              </Label>
              )}
            </RadioGroup>
            {againstRec && (
              <div className="space-y-1.5">
                <Label htmlFor="against">trace recommends fixing this now. Your reason for waiving instead</Label>
                <Textarea id="against" rows={2} value={d.reasonAgainst ?? ''} onChange={(e) => set({ reasonAgainst: e.target.value })} />
              </div>
            )}
          </>
        )}
        {s.step.id === 'reason' && (
          <div className="space-y-1.5">
            <Label htmlFor="w-reason">Why it cannot or need not be met or checked now</Label>
            <Textarea id="w-reason" rows={4} value={d.reason} onChange={(e) => set({ reason: e.target.value })} placeholder="For example: the pin is driven by the battery through J1, which the rule check cannot see." />
            {d.reason && waiverChecks(d).reason === 'not_met' && <StatusBadge plain status="not_met" label={'Say why, not only "not needed"'} />}
          </div>
        )}
        {s.step.id === 'risk' && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="w-risk">What goes wrong if the reason is mistaken</Label>
              <Textarea id="w-risk" rows={3} value={d.risk} onChange={(e) => set({ risk: e.target.value })} />
            </div>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">How bad that would be</legend>
              <RadioGroup value={d.severity ?? ''} onValueChange={(x) => set({ severity: x as Severity })} className="grid gap-2 sm:grid-cols-2">
                {SEVERITIES.map((o) => (
                  <Label key={o.id} className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary">
                    <RadioGroupItem value={o.id} className="mt-0.5" />
                    <span><span className="font-medium">{o.label}</span><span className="block text-xs text-muted-foreground">{o.detail}</span></span>
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>
          </>
        )}
        {s.step.id === 'caught' && (
          <>
            <RadioGroup value={d.caught} onValueChange={(x) => set({ caught: x as WaiverDraft['caught'] })} className="gap-2">
              {([['later', 'At a later stage', 'A check in a later stage catches it'], ['bench', 'On the bench', 'A bring-up step or hardware test catches it'], ['nowhere', 'Nowhere', 'Accepted for good']] as const).map(([id, label, detail]) => (
                <Label key={id} className={cn('flex cursor-pointer items-start gap-2 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary', id === 'nowhere' && d.severity === 'safety' && 'opacity-50')}>
                  <RadioGroupItem value={id} disabled={id === 'nowhere' && d.severity === 'safety'} className="mt-0.5" />
                  <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{id === 'nowhere' && d.severity === 'safety' ? 'Not for a safety waiver: it must be verified somewhere' : detail}</span></span>
                </Label>
              ))}
            </RadioGroup>
            {(d.caught === 'later' || d.caught === 'bench') && (
              <div className="space-y-1.5">
                <Label htmlFor="w-where">Where exactly</Label>
                <Input id="w-where" value={d.where} onChange={(e) => set({ where: e.target.value })} placeholder={whereExample(d.caught, target?.kind, target?.title)} />
                <p className="text-xs text-muted-foreground">A later check is added to the test plan as a test item.</p>
              </div>
            )}
          </>
        )}
        {s.step.id === 'scope' && (
          <RadioGroup value={d.scope} onValueChange={(x) => set({ scope: x as WaiverDraft['scope'] })} className="gap-2">
            <Label className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary"><RadioGroupItem value="revision" className="mt-0.5" /><span className="font-medium">This revision only</span></Label>
            <Label className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary">
              <RadioGroupItem value="condition" className="mt-0.5" />
              <span className="flex-1 space-y-2"><span className="font-medium">Until a named condition changes</span>
                {d.scope === 'condition' && <Input value={d.condition} onChange={(e) => set({ condition: e.target.value })} placeholder="For example: the battery connector changes" aria-label="The condition" />}
              </span>
            </Label>
          </RadioGroup>
        )}
      </div>
      {s.stepIndex < def.steps.length - 1 && <div className="mt-6 flex justify-end"><Button onClick={s.next}>Continue to {def.steps[s.stepIndex + 1]!.title.toLowerCase()} <ArrowRight /></Button></div>}
      <div className="mt-4"><Unavailable checks={s.view.data?.checks} def={def} draft={s.draft as unknown as Confirmable} /></div>
    </FocusLayout>
  )
}

// ------------------------------------------------------------------ change request

export interface ChangeDraft extends SkillDraftBase {
  what: 'requirement' | 'part' | 'block' | 'firmware' | ''
  change: string
  why: string
  acknowledged: boolean
  revision: 'this' | 'next' | ''
  covers: 'both' | 'firmware' | ''
  choice?: { option: string; reason?: string }
}

export function changeChecks(d: ChangeDraft, released: boolean): Record<string, CriterionStatus> {
  return {
    reason: d.what && d.change.trim().length >= 8 && d.why.trim().length >= 8 ? 'met' : 'not_met',
    impact: d.acknowledged ? 'met' : 'not_met',
    released: d.revision === 'next' || (d.revision === 'this' && !released) ? 'met' : 'not_met',
  }
}

export function ChangeSkill({ repo, def, about }: { repo: string; def: SkillDef; about?: string }) {
  const s = useSkill<ChangeDraft>(repo, def, { done: [], what: about ? 'requirement' : '', change: about ? `${about}: ` : '', why: '', acknowledged: false, revision: '', covers: 'both' })
  const v = s.view.data
  const d = s.draft.data
  const imp = v?.impact
  const released = !!imp?.released
  const set = (p: Partial<ChangeDraft>) => s.draft.setData((x) => ({ ...x, ...p }))
  const rec = imp?.recommendation
  const checks = qualityChecks(def, v, { ...draftChecks(v, d), ...changeChecks(d, released), reasons: d.choice && rec && d.choice.option !== rec.recommended && !d.choice.reason ? 'not_met' : 'met' }, s.goTo)
  const request = `Change request (${d.what}): ${d.change.trim()}\nWhy: ${d.why.trim()}\nScope: ${d.revision === 'next' ? 'the next revision' : 'this revision'}, ${d.covers === 'firmware' ? 'firmware only' : 'hardware and firmware'}.${d.choice ? `\nDecision: ${d.choice.option}${d.choice.reason ? ` (reason: ${d.choice.reason})` : ''}` : ''}\nRaise it for approval at a gate; a changed requirement goes through Requirements review.`

  return (
    <FocusLayout
      title={def.name}
      context={s.context}
      steps={s.steps}
      onStep={s.onStep}
      checks={checks}
      submitLabel={def.submit}
      onClose={s.close}
      outcome={s.outcome}
      draftSavedAt={s.draft.savedAt}
      onSubmit={() => s.submit(async () => { const r = await call('task', { repo, request }); if (!r.accepted) throw new Error(r.reason ?? 'trace did not accept the request') }, 'Change request submitted. An admin approves or rejects it at a gate.')}
      trace={<EmbeddedChat repo={repo} intro={<TraceIntro summary={v?.summary} step={s.step} def={def} />} />}
    >
      <StepHeader def={def} index={s.stepIndex} />
      <div className="mt-5 space-y-4">
        {s.step.id === 'state' && (
          <>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">What changes</legend>
              <RadioGroup value={d.what} onValueChange={(x) => set({ what: x as ChangeDraft['what'] })} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(['requirement', 'part', 'block', 'firmware'] as const).map((k) => (
                  <Label key={k} className="flex cursor-pointer items-center gap-2 rounded-lg border p-3 font-normal capitalize has-[[data-state=checked]]:border-primary"><RadioGroupItem value={k} />A {k}</Label>
                ))}
              </RadioGroup>
            </fieldset>
            <div className="space-y-1.5"><Label htmlFor="cr-change">The change</Label><Textarea id="cr-change" rows={2} value={d.change} onChange={(e) => set({ change: e.target.value })} placeholder="For example: move to a 2,000 mAh cell" /></div>
            <div className="space-y-1.5"><Label htmlFor="cr-why">Why</Label><Textarea id="cr-why" rows={2} value={d.why} onChange={(e) => set({ why: e.target.value })} /></div>
            {d.what === 'requirement' && <p className="text-xs text-muted-foreground">A changed requirement goes through Requirements review once approved.</p>}
          </>
        )}
        {s.step.id === 'impact' && (
          <>
            <StepPicture repo={repo} kind={pictureOf(def, 'impact')} view={v} height={300} />
            {!imp ? (
              <p className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">{s.view.isLoading ? 'trace is following the traceability chains…' : 'trace has not traced the impact yet. It follows the chains from what you named in step 1.'}</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Impact label="Stages that reopen" items={imp.stages} />
                <Impact label="Gates to re-sign" items={imp.gates} />
                <Impact label="Evidence that goes stale" items={imp.stale} mono />
                <div className="rounded-xl border p-4 text-sm"><p className="text-xs text-muted-foreground">Expected cost and time</p><p className="mt-1">{imp.cost ?? '—'} · {imp.time ?? '—'}</p></div>
              </div>
            )}
            {rec && <DecisionCard decision={rec} chosen={d.choice ? { option: d.choice.option, recommended: d.choice.option === rec.recommended, reason: d.choice.reason } : undefined} onChoose={(c) => set({ choice: { option: c.option, reason: c.reason } })} />}
            <Label className="flex items-center gap-2 font-normal"><Checkbox checked={d.acknowledged} disabled={!imp} onCheckedChange={(x) => set({ acknowledged: !!x })} /> I've read the impact: what reopens, what goes stale and what it costs.</Label>
          </>
        )}
        {s.step.id === 'scope' && (
          <>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Which revision</legend>
              <RadioGroup value={d.revision} onValueChange={(x) => set({ revision: x as ChangeDraft['revision'] })} className="gap-2">
                <Label className={cn('flex cursor-pointer items-start gap-2 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary', released && 'opacity-50')}><RadioGroupItem value="this" disabled={released} className="mt-0.5" /><span><span className="font-medium">This revision</span><span className="block text-xs text-muted-foreground">{released ? 'Released: a released revision is never edited' : 'Not released yet, so the change is cheapest now'}</span></span></Label>
                <Label className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary"><RadioGroupItem value="next" className="mt-0.5" /><span><span className="font-medium">The next revision</span><span className="block text-xs text-muted-foreground">Opens it, leaving this one as it is</span></span></Label>
              </RadioGroup>
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">What it covers</legend>
              <RadioGroup value={d.covers} onValueChange={(x) => set({ covers: x as ChangeDraft['covers'] })} className="grid gap-2 sm:grid-cols-2">
                <Label className="flex items-center gap-2 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary"><RadioGroupItem value="both" /> Hardware and firmware</Label>
                <Label className="flex items-center gap-2 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary"><RadioGroupItem value="firmware" /> Firmware only</Label>
              </RadioGroup>
            </fieldset>
          </>
        )}
        {s.step.id === 'submit' && (
          <div className="rounded-xl border p-5 text-sm">
            <p className="font-medium">What will be submitted</p>
            <pre className="mt-2 whitespace-pre-wrap font-sans text-muted-foreground">{request}</pre>
            <p className="mt-3 text-xs text-muted-foreground">trace raises it for an admin to approve or reject at a gate. Nothing in the design changes until then.</p>
          </div>
        )}
      </div>
      {s.stepIndex < def.steps.length - 1 && <div className="mt-6 flex justify-end"><Button onClick={s.next}>Continue to {def.steps[s.stepIndex + 1]!.title.toLowerCase()} <ArrowRight /></Button></div>}
      <div className="mt-4"><Unavailable checks={s.view.data?.checks} def={def} draft={s.draft as unknown as Confirmable} /></div>
    </FocusLayout>
  )
}

function Impact({ label, items, mono }: { label: string; items: string[]; mono?: boolean }) {
  return (
    <div className="rounded-xl border p-4 text-sm">
      <p className="text-xs text-muted-foreground">{label} ({items.length})</p>
      {items.length ? <ul className={cn('mt-1 space-y-0.5', mono && 'font-mono text-xs')}>{items.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="mt-1 text-muted-foreground">None</p>}
    </div>
  )
}

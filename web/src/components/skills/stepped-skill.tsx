/**
 * A stepped skill drawn from the table alone (Requirements review, Architecture choice, Pin plan review, Board setup,
 * Gate signing, Release review, Order submit, Design import, Certification run, Production release): the step's
 * picture, what the step asks, the items trace prepared for it (from skill.get), trace beside it with the step's
 * summary and its recommendation, and the quality bar from the checker. Continue moves on; any step opens from the
 * rail, later ones too (test-esp32 #30); leaving keeps the draft. The design skills (Requirements review, Architecture choice) add their decisions
 * (design-steps.tsx).
 */
import { Link } from '@tanstack/react-router'
import { ArrowRight, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DecisionCard } from '@/components/decision-card'
import { EvidenceChip } from '@/components/evidence-chip'
import { FocusLayout } from '@/components/focus/focus-layout'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState, QueryError } from '@/components/states'
import { projectId } from '@/lib/api'
import { cn } from '@/lib/utils'
import { type SkillDef, pictureOf } from './definitions'
import { NoChecker, StepHeader, TraceIntro, Unavailable, type Confirmable } from './parts'
import { ARCH_COMPARE_STEPS, DesignSteps, type DesignDraft, RequirementLine, decidedByReview } from './design-steps'
import { RequirementsChat, withRequirementEdit } from './requirement-edit'
import { ReleaseStep, type ReleaseDraft, releaseChecks } from './release-steps'
import { OrderStep, type OrderDraft, orderChecks } from './order-steps'
import { StepPicture } from './step-picture'
import { type SkillDraftBase, draftChecks, qualityChecks, useSkill } from './use-skill'
import { SkillChat } from './skill-chat'

interface Draft extends SkillDraftBase, DesignDraft, ReleaseDraft, OrderDraft {
  resolved: string[]
  choice?: { option: string; reason?: string }
}

/**
 * Does the draft's choice still lack the reason it needs? One is needed when it is not trace's recommendation, or when
 * another option outscores it (the recommendation included: test-esp32 #96). Pure.
 */
export function needsReason(choice: Draft['choice'], rec: { recommended: string; reasonNeeded?: Record<string, string> } | undefined): boolean {
  if (!choice || (choice.reason ?? '').trim().length >= 3) return false
  return choice.option !== rec?.recommended || Boolean(rec?.reasonNeeded?.[choice.option])
}

export function SteppedSkill({ repo, def }: { repo: string; def: SkillDef }) {
  const s = useSkill<Draft>(repo, def, { done: [], resolved: [] })
  const v = s.view.data
  const all = v?.items ?? []
  // what the skill's own steps decide (Requirements review's requirements and uncovered intent lines) is decided
  // there, with its reason: here a requirement shows with its decision and a way to Decide, never a bare Resolve
  const items = all.filter((it) => !decidedByReview(def.id, it) || (it.id.startsWith('requirement:') && s.step.id !== 'decide'))
  const decisionOf = (it: { id: string }) => s.draft.data.decisions?.find((x) => `requirement:${x.requirement}` === it.id)
  const last = s.stepIndex === def.steps.length - 1
  const release = def.id === 'release-review'
  const order = def.id === 'order-submit'
  // Release review's choice is made on its Decide step, its note the reason (release-steps.tsx)
  const checks = qualityChecks(def, v, { ...draftChecks(v, s.draft.data), ...(order ? orderChecks(v?.order, s.draft.data) : {}), ...(release ? releaseChecks(v?.release, s.draft.data, v?.recommendation?.recommended) : needsReason(s.draft.data.choice, v?.recommendation) ? { reasons: 'not_met' as const } : {}) }, s.goTo)
  const gate = def.id === 'gate-signing'

  return (
    <FocusLayout
      title={def.name}
      context={s.context}
      steps={s.steps}
      onStep={s.onStep}
      anyStep
      checks={checks}
      submitLabel={def.submit}
      onSubmit={() => s.submit()}
      onClose={s.close}
      outcome={s.outcome}
      draftSavedAt={s.draft.savedAt}
      draftSaving={s.draft.saving}
      trace={<SkillChat repo={repo} skill={def.id} intro={<TraceIntro summary={v?.summary} step={s.step} def={def} />} />}
    >
      <StepHeader def={def} index={s.stepIndex} />
      {gate && (
        <p className="mt-3 text-sm">
          Gates open as their own screen, with the evidence beside each criterion.{' '}
          <Link className="text-primary hover:underline" to="/p/$id" params={{ id: projectId(repo) }}>Back to the project</Link> and use Review and sign on the next step card.
        </p>
      )}
      {/* Architecture choice's Read and Score steps draw each option themselves (design-steps.tsx), switchable */}
      {!(def.id === 'architecture-choice' && ARCH_COMPARE_STEPS.includes(s.step.id)) && (
        <div className="mt-4">
          <StepPicture repo={repo} kind={pictureOf(def, s.step.id)} view={v} />
        </div>
      )}

      {s.view.isError && <div className="mt-4"><QueryError error={s.view.error} what={`what trace prepared for ${def.name}`} onRetry={() => void s.view.refetch()} /></div>}

      {!release && v?.recommendation && s.stepIndex >= Math.max(0, def.steps.findIndex((x) => /choose|decide|pick/i.test(x.title))) && (
        <DecisionCard
          className="mt-4"
          decision={v.recommendation}
          chosen={s.draft.data.choice ? { option: s.draft.data.choice.option, recommended: s.draft.data.choice.option === v.recommendation.recommended, reason: s.draft.data.choice.reason } : undefined}
          onChoose={(c) => s.draft.setData((d) => ({ ...d, choice: { option: c.option, reason: c.reason } }))}
        />
      )}

      {/* trace's chat changes the review's rows in the draft as the rows do (decide_requirement), never with a job */}
      {def.id === 'requirements-review' && <RequirementsChat items={all} decisions={s.draft.data.decisions ?? []} loaded={s.draft.loaded} setDecisions={(fn) => s.draft.setData((d) => ({ ...d, decisions: fn(d.decisions ?? []) }))} />}
      <DesignSteps repo={repo} skill={def.id} step={s.step.id} view={v} draft={s.draft.data} setDraft={(fn) => s.draft.setData((d) => ({ ...d, ...fn(d) }))} />
      {v?.pending_errors?.length ? <p className="mt-3 text-sm text-destructive">{v.pending_errors.join(' ')}</p> : null}

      {/* Release review shows each area from the record, with its acknowledgement (release-steps.tsx) */}
      {release && <ReleaseStep step={s.step.id} view={v?.release} draft={s.draft.data} setDraft={(fn) => s.draft.setData((d) => ({ ...d, ...fn(d) }))} loading={s.view.isLoading} recommendation={v?.recommendation} />}

      {/* Order submit shows each step from the record, with its ticks (order-steps.tsx) */}
      {order && <OrderStep repo={repo} step={s.step.id} view={v?.order} draft={s.draft.data} setDraft={(fn) => s.draft.setData((d) => ({ ...d, ...fn(d) }))} loading={s.view.isLoading} />}

      {/* Gate signing has no items of its own: they live on the gate's screen, so an empty "nothing open" here misleads;
          Architecture choice's key parts are their own list (design-steps.tsx KeyParts); Release review's steps are
          their own (above) */}
      {!gate && !release && !order && !(def.id === 'architecture-choice' && s.step.id === 'parts' && v?.key_parts) && !(all.length > 0 && items.length === 0) && <section className="mt-6" aria-labelledby="items">
        <h2 id="items" className="text-base font-semibold">For this step</h2>
        {items.length === 0 ? (
          s.view.isLoading ? <EmptyState className="mt-2">Loading what trace prepared…</EmptyState> : <StepNeeds def={def} step={s.step} checks={v?.checks} />
        ) : (
          <ul className="mt-2 divide-y rounded-xl border">
            {items.map((it) => {
              if (decidedByReview(def.id, it)) {
                return <RequirementLine key={it.id} it={it} decision={decisionOf(it)} onDecide={() => s.goTo('decide')} onEdit={(id, f) => s.draft.setData((d) => withRequirementEdit(d, id, f))} />
              }
              if (it.question) {
                return (
                  <li key={it.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <StatusBadge status="yours" label={it.label ?? 'Unanswered'} />
                    <span className="min-w-0 flex-1 text-sm">{it.title}{it.detail && <span className="block text-xs text-muted-foreground">{it.detail}</span>}</span>
                    <Button size="sm" variant="outline" asChild>
                      <Link to="/p/$id/do/$skill" params={{ id: projectId(repo), skill: 'question-answer' }} search={{ question: it.question }}>Answer it <ArrowRight /></Link>
                    </Button>
                  </li>
                )
              }
              const done = it.status !== 'open' || s.draft.data.resolved.includes(it.id)
              return (
                <li key={it.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <StatusBadge status={it.status === 'waived' ? 'waived' : done ? 'done' : 'yours'} label={it.label ?? (it.status === 'waived' ? undefined : done ? 'Resolved' : 'Open')} />
                  <span className={cn('min-w-0 flex-1 text-sm', done && 'text-muted-foreground')}>{it.title}{it.detail && <span className="block text-xs text-muted-foreground">{it.detail}</span>}</span>
                  {it.evidence && <EvidenceChip evidence={it.evidence} />}
                  {it.status === 'open' && (
                    <Button size="sm" variant="outline" onClick={() => s.draft.setData((d) => ({ ...d, resolved: done ? d.resolved.filter((x) => x !== it.id) : [...d.resolved, it.id] }))}>
                      {done ? 'Reopen' : <><Check /> Resolve</>}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>}

      {!v?.checks?.length && <div className="mt-4"><NoChecker def={def} /></div>}
      <div className="mt-4"><Unavailable checks={v?.checks} def={def} draft={s.draft as unknown as Confirmable} step={s.step.id} /></div>

      {!last && (
        <div className="mt-6 flex justify-end">
          <Button onClick={s.next}>Continue to {def.steps[s.stepIndex + 1]!.title.toLowerCase()} <ArrowRight /></Button>
        </div>
      )}
    </FocusLayout>
  )
}

/**
 * A step with no items of its own (test-esp32 #225): what the step asks and where its checks stand, from the checker,
 * rather than "trace has nothing open", which read as though there was nothing to do. Pure but for rendering.
 */
export function StepNeeds({ def, step, checks }: { def: SkillDef; step: { id: string }; checks?: { id: string; status: string; detail?: string; unavailable?: string }[] }) {
  const here = def.checks.filter((c) => c.step === step.id)
  const of = (id: string) => checks?.find((c) => c.id === id)
  return (
    <div className="mt-2 rounded-xl border px-4 py-3 text-sm">
      {here.length ? (
        <ul className="space-y-1.5">
          {here.map((c) => {
            const r = of(c.id)
            const status = r?.status === 'met' ? 'met' : r?.status === 'waived' ? 'waived' : r?.status === 'not_due' ? 'untested' : 'not_met'
            const why = r?.unavailable ? `trace cannot check it from the record yet: it needs ${r.unavailable}.` : r?.detail
            return (
              <li key={c.id} className="flex flex-wrap items-start gap-2">
                <StatusBadge status={status} {...(r?.status === 'not_due' ? { label: 'Not due yet' } : {})} />
                <span className="min-w-0 flex-1">{c.text}{why && <span className="block text-xs text-muted-foreground">{why}</span>}</span>
              </li>
            )
          })}
        </ul>
      ) : <p className="text-muted-foreground">trace prepares nothing from the record for this step yet: it is yours to do as the step says.</p>}
    </div>
  )
}

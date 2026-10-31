/**
 * A stepped skill drawn from the table alone (Requirements review, Architecture choice, Pin plan review, Board setup,
 * Gate signing, Release review, Order submit, Design import, Certification run, Production release): the step's
 * picture, what the step asks, the items trace prepared for it (from skill.get), trace beside it with the step's
 * summary and its recommendation, and the quality bar from the checker. Continue moves on; any done step can be
 * revisited; leaving keeps the draft. The design skills (Requirements review, Architecture choice) add their decisions
 * (design-steps.tsx).
 */
import { Link } from '@tanstack/react-router'
import { ArrowRight, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmbeddedChat } from '@/components/chat/embedded-chat'
import { DecisionCard } from '@/components/decision-card'
import { EvidenceChip } from '@/components/evidence-chip'
import { FocusLayout } from '@/components/focus/focus-layout'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState, QueryError } from '@/components/states'
import { projectId } from '@/lib/api'
import { cn } from '@/lib/utils'
import { type SkillDef, pictureOf } from './definitions'
import { NoChecker, StepHeader, TraceIntro, Unavailable } from './parts'
import { ARCH_COMPARE_STEPS, DesignSteps, type DesignDraft } from './design-steps'
import { StepPicture } from './step-picture'
import { type SkillDraftBase, qualityChecks, useSkill } from './use-skill'

interface Draft extends SkillDraftBase, DesignDraft {
  resolved: string[]
  choice?: { option: string; reason?: string }
}

export function SteppedSkill({ repo, def }: { repo: string; def: SkillDef }) {
  const s = useSkill<Draft>(repo, def, { done: [], resolved: [] })
  const v = s.view.data
  const items = v?.items ?? []
  const last = s.stepIndex === def.steps.length - 1
  const checks = qualityChecks(def, v, s.draft.data.choice && !s.draft.data.choice.reason && s.draft.data.choice.option !== v?.recommendation?.recommended ? { reasons: 'not_met' } : {}, s.goTo)
  const gate = def.id === 'gate-signing'

  return (
    <FocusLayout
      title={def.name}
      context={s.context}
      steps={s.steps}
      onStep={s.onStep}
      checks={checks}
      submitLabel={def.submit}
      onSubmit={() => s.submit()}
      onClose={s.close}
      draftSavedAt={s.draft.savedAt}
      trace={<EmbeddedChat repo={repo} intro={<TraceIntro summary={v?.summary} step={s.step} def={def} />} />}
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

      {v?.recommendation && s.stepIndex >= Math.max(0, def.steps.findIndex((x) => /choose|decide|pick/i.test(x.title))) && (
        <DecisionCard
          className="mt-4"
          decision={v.recommendation}
          chosen={s.draft.data.choice ? { option: s.draft.data.choice.option, recommended: s.draft.data.choice.option === v.recommendation.recommended, reason: s.draft.data.choice.reason } : undefined}
          onChoose={(c) => s.draft.setData((d) => ({ ...d, choice: { option: c.option, reason: c.reason } }))}
        />
      )}

      <DesignSteps repo={repo} skill={def.id} step={s.step.id} view={v} draft={s.draft.data} setDraft={(fn) => s.draft.setData((d) => ({ ...d, ...fn(d) }))} />
      {v?.pending_errors?.length ? <p className="mt-3 text-sm text-destructive">{v.pending_errors.join(' ')}</p> : null}

      <section className="mt-6" aria-labelledby="items">
        <h2 id="items" className="text-base font-semibold">For this step</h2>
        {items.length === 0 ? (
          <EmptyState className="mt-2">{s.view.isLoading ? 'Loading what trace prepared…' : `trace has nothing open for “${s.step.title.toLowerCase()}”. ${s.step.detail}`}</EmptyState>
        ) : (
          <ul className="mt-2 divide-y rounded-xl border">
            {items.map((it) => {
              const done = it.status !== 'open' || s.draft.data.resolved.includes(it.id)
              return (
                <li key={it.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <StatusBadge status={it.status === 'waived' ? 'waived' : done ? 'done' : 'yours'} label={it.status === 'waived' ? undefined : done ? 'Resolved' : 'Open'} />
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
      </section>

      {!v?.checks?.length && <div className="mt-4"><NoChecker def={def} /></div>}
      <div className="mt-4"><Unavailable checks={v?.checks} def={def} /></div>

      {!last && (
        <div className="mt-6 flex justify-end">
          <Button onClick={s.next}>Continue to {def.steps[s.stepIndex + 1]!.title.toLowerCase()} <ArrowRight /></Button>
        </div>
      )}
    </FocusLayout>
  )
}

/**
 * What every guided skill screen shares: its definition (definitions.ts), the record's view of it (skill.get), the
 * person's draft (kept with their preferences), the steps for the stepper, the quality bar (the checker's verdicts,
 * with any the screen works out itself laid over them), Close back to where the person was, and Submit.
 *
 * Submit says what it came to on the skill's page whatever the skill (submit-outcome.tsx): refused, or recorded with
 * a criterion it sets still not met, it stays here with the draft kept, says what blocked it and which step fixes it;
 * met in full, it says what it recorded, the criteria it set change on screen at once, and the person returns.
 */
import { useNavigate, useRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTraceContext } from '@/components/chat/context'
import type { FocusStep } from '@/components/focus/focus-layout'
import type { QualityCheck } from '@/components/quality-bar'
import { useCommands } from '@/components/shell/command-menu'
import { projectId, projectName } from '@/lib/api'
import { useAction, useJourney } from '@/lib/queries'
import type { CriterionStatus } from '@/lib/types'
import type { SkillView } from '@/lib/types-s1'
import { type SkillDef, checksOf } from './definitions'
import { useSkillDraft } from './draft'
import { type SubmitOutcome, SubmitOutcomePanel, applyCriteria, doneWords, partlyOutcome, refusedOutcome } from './submit-outcome'

export interface SkillDraftBase {
  /** step ids the person has finished */
  done: string[]
}

/** The quality bar: the checker's verdict per check, overridden by what the screen computes; unknown is Not met. */
export function qualityChecks(def: SkillDef, view: Pick<SkillView, 'checks'> | undefined, local: Record<string, CriterionStatus> = {}, jump?: (step: string) => void): QualityCheck[] {
  const from = new Map((view?.checks ?? []).map((c) => [c.id, c]))
  return checksOf(def).map((c) => {
    // what the screen works out from the draft as it is typed wins over the record's last answer, except where the
    // record cannot check it yet (unavailable): then it stays not met, as Submit would be refused
    const api = from.get(c.id)
    const status: CriterionStatus = api?.unavailable ? 'not_met' : local[c.id] ?? api?.status ?? (c.id === 'reasons' ? 'met' : 'not_met')
    const detail = api?.unavailable ? `cannot be checked yet: needs ${api.unavailable}` : api?.detail
    return { id: c.id, text: status === 'not_met' && detail ? `${c.text} (${detail})` : c.text, status, onJump: c.step && jump ? () => jump(c.step!) : undefined }
  })
}

/** The stepper's steps from the current index and the done list. */
export function focusSteps(def: SkillDef, current: number, done: string[]): FocusStep[] {
  return def.steps.map((s, i) => ({ id: s.id, title: s.title, state: i === current ? 'current' : done.includes(s.id) || i < current ? 'done' : 'todo' }))
}

/** `question`: the question Question answer opens (its link names it), else the API's choice. */
export function useSkill<D extends SkillDraftBase>(repo: string, def: SkillDef, initial: D, o: { question?: string | undefined } = {}) {
  const router = useRouter()
  const navigate = useNavigate()
  const j = useJourney(repo)
  const view = useAction('skill.get', { repo, skill: def.id, ...(o.question ? { question: o.question } : {}) })
  const draft = useSkillDraft<D>(repo, def.id, { name: def.name, steps: def.steps.length }, initial)
  const stage = j.data?.stages.find((s) => s.state === 'current' || s.state === 'reopened')
  const context = [j.data?.name ?? projectName(repo), j.data?.revision, def.stage === 'Any' || def.stage === 'Every gate' ? stage?.name : def.stage].filter(Boolean).join(' · ')
  const stepIndex = draft.step
  const step = def.steps[stepIndex] ?? def.steps[0]!

  const goTo = useCallback((idOrIndex: string | number) => {
    const i = typeof idOrIndex === 'number' ? idOrIndex : def.steps.findIndex((s) => s.id === idOrIndex)
    if (i >= 0) draft.setStep(i)
  }, [def.steps, draft])
  const next = useCallback(() => {
    draft.setData((d) => ({ ...d, done: d.done.includes(step.id) ? d.done : [...d.done, step.id] }))
    if (stepIndex < def.steps.length - 1) draft.setStep(stepIndex + 1)
  }, [draft, step.id, stepIndex, def.steps.length])
  const close = useCallback(() => {
    if (window.history.length > 1) router.history.back()
    else void navigate({ to: '/p/$id', params: { id: projectId(repo) } })
  }, [router, navigate, repo])

  const steps = useMemo(() => focusSteps(def, stepIndex, draft.data.done), [def, stepIndex, draft.data.done])
  // done steps can be revisited; later ones open once reached
  const onStep = useCallback((id: string) => goTo(id), [goTo])

  /** Submit: the action given (or skill.submit); then what it came to (submit-outcome.tsx). */
  // one submission at a time: a second click (or the bar's other Submit button) while the first is on its way would
  // record the skill twice
  const submitting = useRef(false)
  const qc = useQueryClient()
  // what the last submission came to, while the person is still here: refused, or partly
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null)
  // done: the toast, or what to say from the call's answer (an answer's summary says whether the agent carried on)
  const submit = useCallback(async (run?: () => Promise<unknown>, done: string | ((result: unknown) => string) = `${def.name} submitted.`) => {
    if (submitting.current) return
    submitting.current = true
    setOutcome(null)
    // no draft save may land after the submission and bring back the draft it discards
    draft.hold()
    const reread = (): void => {
      // what the submission changed (the journey, the gate's criteria, the inbox, the skill's own view) is read again,
      // so the page the person is on shows it at once (lib/after-write.ts reads them again for every act; here for a
      // submission made some other way, or refused, too, without starting again a refetch already on its way)
      for (const k of [['journey.get', repo], ['skill.get', repo], ['skill.drafts', repo], ['design.get', repo], ['requirements.trace', repo], ['inbox']]) void qc.invalidateQueries({ queryKey: k }, { cancelRefetch: false })
    }
    try {
      const result = await (run ? run() : import('@/lib/api').then(({ call }) => call('skill.submit', { repo, skill: def.id, draft: draft.data })))
      applyCriteria(qc, repo, result)
      const partly = partlyOutcome(result)
      if (partly) {
        // recorded, but a criterion it sets is not met yet: stay, keep the draft, say which and what to do
        draft.keep()
        reread()
        setOutcome(partly)
        return
      }
      draft.discard()
      reread()
      toast(typeof done === 'function' ? done(result) : doneWords(done, result))
      close()
    } catch (e) {
      // refused: the person stays on the skill with the draft kept, and the page says what blocked it
      draft.keep()
      reread()
      setOutcome(refusedOutcome(def, e instanceof Error ? e.message : String(e)))
    } finally {
      submitting.current = false
    }
  }, [def, repo, draft, close, qc])
  const outcomeNode = outcome ? <SubmitOutcomePanel def={def} outcome={outcome} onJump={goTo} onDismiss={() => setOutcome(null)} /> : null

  useTraceContext({ label: def.name, description: 'The guided skill the person is doing', value: { skill: def.id, repo, step: step.title, stepNumber: stepIndex + 1, of: def.steps.length } }, 'skill')
  useCommands([
    ...def.steps.map((s, i) => ({ id: `skill-step-${s.id}`, label: `${def.name}: go to step ${i + 1}, ${s.title}`, run: () => goTo(i) })),
    { id: 'skill-close', label: `Leave ${def.name} (the draft is kept)`, run: close },
  ])

  return { j, view, draft, stepIndex, step, steps, onStep, goTo, next, close, submit, context, outcome: outcomeNode }
}

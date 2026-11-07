/**
 * What every guided skill screen shares: its definition (definitions.ts), the record's view of it (skill.get), the
 * person's draft (kept with their preferences), the steps for the stepper, the quality bar (the checker's verdicts,
 * with any the screen works out itself laid over them), Close back to where the person was, and Submit.
 *
 * Submit says what it came to on the skill's page whatever the skill (submit-outcome.tsx): refused, or recorded with
 * a criterion it sets still not met, it stays here with the draft kept, says what blocked it and which step fixes it;
 * met in full, it says what it recorded, the criteria it set change on screen at once, and the person returns to the
 * project page the skill was opened from, else the project's overview (lib/return-to.ts; never browser history, #210).
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
import { returnTo } from '@/lib/return-to'
import type { CheckStatus, CriterionStatus } from '@/lib/types'
import type { SkillView } from '@/lib/types-s1'
import { type SkillDef, checksOf } from './definitions'
import { useSkillDraft } from './draft'
import { type SubmitOutcome, SubmitOutcomePanel, applyCriteria, doneWords, partlyOutcome, refusedOutcome } from './submit-outcome'

export interface SkillDraftBase {
  /** step ids the person has finished */
  done: string[]
}

/**
 * The checks the person's own tick decides, from the draft on screen: the checker's `by_draft` (nothing in the record
 * holds them back), and the "I checked it" confirmations of checks no tool can make yet (`confirmable`, or already
 * `confirmed`: the draft's confirmed[id]). The record's verdict follows only once the draft is saved and the bar
 * checked again, seconds later; the tick counts at once (test-esp32 #64, #210). Pure.
 */
export function draftChecks(view: Pick<SkillView, 'checks'> | undefined, draft: object): Record<string, CriterionStatus> {
  const d = draft as Record<string, unknown>
  const confirmed = d.confirmed && typeof d.confirmed === 'object' ? d.confirmed as Record<string, unknown> : {}
  return Object.fromEntries((view?.checks ?? []).flatMap((c): [string, CriterionStatus][] => {
    if (c.confirmable || c.confirmed) return [[c.id, confirmed[c.id] === true ? 'met' : 'not_met']]
    if (c.by_draft && !c.unavailable) return [[c.id, d[c.by_draft] === true ? 'met' : 'not_met']]
    return []
  }))
}

/** The quality bar: the checker's verdict per check, overridden by what the screen computes; unknown is Not met. */
export function qualityChecks(def: SkillDef, view: Pick<SkillView, 'checks'> | undefined, local: Record<string, CriterionStatus> = {}, jump?: (step: string) => void): QualityCheck[] {
  const from = new Map((view?.checks ?? []).map((c) => [c.id, c]))
  return checksOf(def).map((c) => {
    // what the screen works out from the draft as it is typed wins over the record's last answer, except where the
    // record cannot check it yet (unavailable): then it stays not met, as Submit would be refused, unless it is the
    // person's to confirm (confirmable) and their tick says so
    const api = from.get(c.id)
    const mine = (api?.confirmable || api?.confirmed) && local[c.id] !== undefined
    const held = !!api?.unavailable && !mine
    const status: CheckStatus = held ? 'not_met' : local[c.id] ?? api?.status ?? (c.id === 'reasons' ? 'met' : 'not_met')
    // the record's words are about its own verdict: where the screen's differs, they no longer fit
    const detail = api?.unavailable && status === 'not_met' ? `cannot be checked yet: needs ${api.unavailable}` : local[c.id] && api && local[c.id] !== api.status ? undefined : api?.detail
    return { id: c.id, text: status !== 'met' && detail ? `${c.text} (${detail})` : c.text, status, onJump: c.step && jump ? () => jump(c.step!) : undefined, ...(c.step ? { step: c.step } : {}) }
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
  // once submitted: the project page the skill was opened from, else the overview; never history, which may be a page
  // outside the project (#210)
  const leave = useCallback(() => void navigate({ href: returnTo(repo) }), [navigate, repo])

  const steps = useMemo(() => focusSteps(def, stepIndex, draft.data.done), [def, stepIndex, draft.data.done])
  // any step can be opened from the rail where the screen allows it (FocusLayout `anyStep`); else done steps only
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
      leave()
    } catch (e) {
      // refused: the person stays on the skill with the draft kept, and the page says what blocked it
      draft.keep()
      reread()
      setOutcome(refusedOutcome(def, e instanceof Error ? e.message : String(e)))
    } finally {
      submitting.current = false
    }
  }, [def, repo, draft, leave, qc])
  const outcomeNode = outcome ? <SubmitOutcomePanel def={def} outcome={outcome} onJump={goTo} onDismiss={() => setOutcome(null)} /> : null

  useTraceContext({ label: def.name, description: 'The guided skill the person is doing', value: { skill: def.id, repo, step: step.title, stepNumber: stepIndex + 1, of: def.steps.length } }, 'skill')
  useCommands([
    ...def.steps.map((s, i) => ({ id: `skill-step-${s.id}`, label: `${def.name}: go to step ${i + 1}, ${s.title}`, run: () => goTo(i) })),
    { id: 'skill-close', label: `Leave ${def.name} (the draft is kept)`, run: close },
  ])

  return { j, view, draft, stepIndex, step, steps, onStep, goTo, next, close, submit, context, outcome: outcomeNode }
}

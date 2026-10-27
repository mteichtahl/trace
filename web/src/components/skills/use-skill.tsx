/**
 * What every guided skill screen shares: its definition (definitions.ts), the record's view of it (skill.get), the
 * person's draft (kept with their preferences), the steps for the stepper, the quality bar (the checker's verdicts,
 * with any the screen works out itself laid over them), Close back to where the person was, and Submit.
 */
import { useNavigate, useRouter } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
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

export interface SkillDraftBase {
  /** step ids the person has finished */
  done: string[]
}

/** The quality bar: the checker's verdict per check, overridden by what the screen computes; unknown is Not met. */
export function qualityChecks(def: SkillDef, view: Pick<SkillView, 'checks'> | undefined, local: Record<string, CriterionStatus> = {}, jump?: (step: string) => void): QualityCheck[] {
  const from = new Map((view?.checks ?? []).map((c) => [c.id, c]))
  return checksOf(def).map((c) => {
    const status: CriterionStatus = local[c.id] ?? from.get(c.id)?.status ?? (c.id === 'reasons' ? 'met' : 'not_met')
    const detail = from.get(c.id)?.detail
    return { id: c.id, text: status === 'not_met' && detail ? `${c.text} (${detail})` : c.text, status, onJump: c.step && jump ? () => jump(c.step!) : undefined }
  })
}

/** The stepper's steps from the current index and the done list. */
export function focusSteps(def: SkillDef, current: number, done: string[]): FocusStep[] {
  return def.steps.map((s, i) => ({ id: s.id, title: s.title, state: i === current ? 'current' : done.includes(s.id) || i < current ? 'done' : 'todo' }))
}

export function useSkill<D extends SkillDraftBase>(repo: string, def: SkillDef, initial: D) {
  const router = useRouter()
  const navigate = useNavigate()
  const j = useJourney(repo)
  const view = useAction('skill.get', { repo, skill: def.id })
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

  /** Submit: the action given (or skill.submit), then the draft is discarded and the person returns. */
  const submit = useCallback(async (run?: () => Promise<unknown>, done = `${def.name}: submitted.`) => {
    try {
      await (run ? run() : import('@/lib/api').then(({ call }) => call('skill.submit', { repo, skill: def.id, draft: draft.data })))
      draft.discard()
      toast(done)
      close()
    } catch (e) {
      toast.error(`${def.name} was not submitted. Your work is kept as a draft.`, { description: e instanceof Error ? e.message : String(e) })
    }
  }, [def, repo, draft, close])

  useTraceContext({ label: def.name, description: 'The guided skill the person is doing', value: { skill: def.id, repo, step: step.title, stepNumber: stepIndex + 1, of: def.steps.length } }, 'skill')
  useCommands([
    ...def.steps.map((s, i) => ({ id: `skill-step-${s.id}`, label: `${def.name}: go to step ${i + 1}, ${s.title}`, run: () => goTo(i) })),
    { id: 'skill-close', label: `Leave ${def.name} (the draft is kept)`, run: close },
  ])

  return { j, view, draft, stepIndex, step, steps, onStep, goTo, next, close, submit, context }
}

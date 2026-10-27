/**
 * Leaving a guided skill keeps a draft: the person's work so far is saved with their preferences (me.set under
 * drafts.<project>.<skill>), so it is there on any device and the project's next step card can say "Continue:
 * Schematic finish, step 4 of 6". Nothing is submitted until Submit.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { projectId } from '@/lib/api'
import { getPath, useMe, useSetMe } from '@/lib/prefs'

export interface DraftMeta {
  /** the skill's name, for the Continue line */
  name: string
  /** 0-based index of the current step */
  step: number
  steps: number
  savedAt: number
}

export type Draft<T> = DraftMeta & { data: T }

/** The preferences path of a draft. Keys split on dots, so dots in a repo name are replaced. */
export const draftKey = (repo: string, skill: string): string => `drafts.${projectId(repo).replace(/\./g, '_')}.${skill.replace(/\./g, '_')}`

/** Every draft kept for a project, newest first. */
export function useProjectDrafts(repo: string): (Draft<unknown> & { skill: string })[] {
  const me = useMe()
  const all = getPath(me.data, `drafts.${projectId(repo).replace(/\./g, '_')}`) as Record<string, Draft<unknown> | null> | undefined
  if (!all) return []
  return Object.entries(all)
    .filter((e): e is [string, Draft<unknown>] => !!e[1] && typeof e[1] === 'object')
    .map(([skill, d]) => ({ ...d, skill }))
    .sort((a, b) => b.savedAt - a.savedAt)
}

/** "Continue: Schematic finish, step 4 of 6" */
export const continueText = (d: DraftMeta): string => `Continue: ${d.name}, step ${d.step + 1} of ${d.steps}`

/**
 * A skill's draft: starts from the saved one (once it loads) or `initial`, saves 800 ms after each change. Returns
 * the data, a setter, the step, a step setter, when it was last saved, and `discard` (after a successful submit).
 */
export function useSkillDraft<T>(repo: string, skill: string, meta: { name: string; steps: number }, initial: T) {
  const key = draftKey(repo, skill)
  const me = useMe()
  const setMe = useSetMe()
  const saved = getPath(me.data, key) as Draft<T> | undefined | null
  const [data, setDataState] = useState<T>(initial)
  const [step, setStepState] = useState(0)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const took = useRef(false)
  const dirty = useRef(false)

  // take the saved draft once it arrives (unless the person already started typing)
  useEffect(() => {
    if (took.current || !me.data) return
    took.current = true
    if (saved && !dirty.current) {
      setDataState({ ...initial, ...saved.data })
      setStepState(Math.min(saved.step ?? 0, meta.steps - 1))
      setSavedAt(saved.savedAt)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data])

  const latest = useRef({ data, step })
  latest.current = { data, step }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const schedule = useCallback(() => {
    dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const at = Date.now()
      setMe.mutate({ key, value: { name: meta.name, steps: meta.steps, step: latest.current.step, savedAt: at, data: latest.current.data } satisfies Draft<T> })
      setSavedAt(at)
    }, 800)
  }, [key, meta.name, meta.steps, setMe])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const setData = useCallback((f: T | ((d: T) => T)) => {
    setDataState((d) => (typeof f === 'function' ? (f as (d: T) => T)(d) : f))
    schedule()
  }, [schedule])
  const setStep = useCallback((n: number) => {
    setStepState(n)
    schedule()
  }, [schedule])
  const discard = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    setMe.mutate({ key, value: null })
  }, [key, setMe])

  return { data, setData, step, setStep, savedAt, discard, loaded: !!me.data || me.isError }
}

/**
 * Leaving a guided skill keeps a draft: the person's work so far is kept in the project's journey store (skill.draft;
 * src/core/journey.ts skill_drafts, per person, never copied into the repository), so it is there on any device and
 * the project's next step card can say "Continue: Schematic finish, step 4 of 6". Nothing is submitted until Submit.
 *
 * New project has no project yet, so its draft stays with the person's preferences (me.set under
 * drafts.<key>.<skill>), as before.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { call, projectId } from '@/lib/api'
import { getPath, useMe, useSetMe } from '@/lib/prefs'
import { q } from '@/lib/queries'

export interface DraftMeta {
  /** the skill's name, for the Continue line */
  name: string
  /** 0-based index of the current step */
  step: number
  steps: number
  savedAt: number
}

export type Draft<T> = DraftMeta & { data: T }

/** The preferences path of a draft (New project's only). Keys split on dots, so dots in a name are replaced. */
export const draftKey = (repo: string, skill: string): string => `drafts.${projectId(repo).replace(/\./g, '_')}.${skill.replace(/\./g, '_')}`

/** Every draft this person keeps on a project, newest first (skill.drafts). */
export function useProjectDrafts(repo: string): (DraftMeta & { skill: string })[] {
  const d = useQuery({ ...q('skill.drafts', { repo }), retry: false, staleTime: 30_000 })
  return (d.data?.drafts ?? []).map((x) => ({ skill: x.skill, name: x.name, step: x.step, steps: x.steps, savedAt: Date.parse(x.saved) }))
}

/** "Continue: Schematic finish, step 4 of 6" */
export const continueText = (d: Pick<DraftMeta, 'name' | 'step' | 'steps'> & Partial<DraftMeta>): string => `Continue: ${d.name}, step ${d.step + 1} of ${d.steps}`

/** A repository that is a project (owner/repo), rather than New project's pseudo key. */
const isProject = (repo: string): boolean => /^[^/]+\/[^/]+$/.test(repo) && !repo.startsWith('new/')

/**
 * A skill's draft: starts from the saved one (once it loads) or `initial`, saves 800 ms after each change. Returns
 * the data, a setter, the step, a step setter, when it was last saved, and `discard` (after a successful submit).
 */
export function useSkillDraft<T>(repo: string, skill: string, meta: { name: string; steps: number }, initial: T) {
  const project = isProject(repo)
  const key = draftKey(repo, skill)
  const qc = useQueryClient()
  // a project's draft: skill.get carries it (the same query the screen reads its bar from)
  const view = useQuery({ ...q('skill.get', { repo, skill }), enabled: project, retry: false })
  const me = useMe()
  const setMe = useSetMe()
  const fromPrefs = project ? undefined : (getPath(me.data, key) as Draft<T> | undefined | null)
  const loadedNow = project ? view.isSuccess || view.isError : !!me.data || me.isError
  const saved = project
    ? (view.data?.draft ? { data: view.data.draft as T, step: Number((view.data as { step?: number }).step ?? 0), savedAt: view.data.saved ? Date.parse(view.data.saved) : Date.now() } : null)
    : fromPrefs
  const [data, setDataState] = useState<T>(initial)
  const [step, setStepState] = useState(0)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const took = useRef(false)
  const dirty = useRef(false)

  // take the saved draft once it arrives (unless the person already started typing)
  useEffect(() => {
    if (took.current || !loadedNow) return
    took.current = true
    if (saved && !dirty.current) {
      setDataState({ ...initial, ...saved.data })
      setStepState(Math.min(saved.step ?? 0, meta.steps - 1))
      setSavedAt(saved.savedAt)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedNow])

  const latest = useRef({ data, step })
  latest.current = { data, step }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const save = useCallback((value: { step: number; data: T } | null) => {
    if (project) {
      void call('skill.draft', { repo, skill, step: value?.step ?? 0, data: value ? (value.data as Record<string, unknown>) : null })
        .then(() => qc.invalidateQueries({ queryKey: ['skill.drafts', repo] }))
        .catch(() => undefined)
    } else {
      setMe.mutate({ key, value: value ? { name: meta.name, steps: meta.steps, step: value.step, savedAt: Date.now(), data: value.data } satisfies Draft<T> : null })
    }
  }, [project, repo, skill, key, meta.name, meta.steps, setMe, qc])
  const schedule = useCallback(() => {
    dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      save({ step: latest.current.step, data: latest.current.data })
      setSavedAt(Date.now())
    }, 800)
  }, [save])
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
    save(null)
  }, [save])

  return { data, setData, step, setStep, savedAt, discard, loaded: loadedNow }
}

/**
 * The person's preferences (me.get / me.set): one document stored with the person, so it follows them to every
 * device. `usePref` reads one value with its default; `useSetPref` writes it optimistically (the screen changes at
 * once, "Saved" follows, and a failure rolls back). Table views live under `views.<table>`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { call } from './api'
import type { MeDoc, Prefs, TableView } from './types'

export const DEFAULT_PREFS: Prefs = {
  profile: {},
  display: { theme: 'system', density: 'comfortable', textSize: 1, motion: 'system', contrast: 'standard' },
  chat: { dock: 'asked', enter: 'enter', recall: true, toolRows: 'folded', reasoning: 'hidden', terms: 'first', recommendations: 'short' },
  voice: { rate: 1, readAloud: 'off', language: 'en-AU', mic: 'hold', sendOnStop: false, commands: true },
  formats: { units: 'mm', currency: 'USD', numbers: 'engineering' },
  work: { start: 'home', pinned: [], hideFinished: false },
}

export const ME_KEY = ['me.get', {}] as const

export function useMe() {
  return useQuery({ queryKey: ME_KEY, queryFn: () => call('me.get', {}), staleTime: 5 * 60_000 })
}

/** Read a path ("display.theme", "views.projects") from a document. */
export function getPath(doc: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), doc)
}

/** A copy of the document with one path set. */
export function setPath<T>(doc: T, key: string, value: unknown): T {
  const parts = key.split('.')
  const root: Record<string, unknown> = { ...(doc as Record<string, unknown>) }
  let o = root
  for (const p of parts.slice(0, -1)) {
    const next = o[p]
    o[p] = next && typeof next === 'object' ? { ...(next as Record<string, unknown>) } : {}
    o = o[p] as Record<string, unknown>
  }
  o[parts[parts.length - 1] as string] = value
  return root as T
}

type Group = keyof Prefs
export function usePrefs(): Prefs {
  const { data } = useMe()
  const p = data?.prefs ?? {}
  const out = {} as Record<Group, unknown>
  for (const g of Object.keys(DEFAULT_PREFS) as Group[]) out[g] = { ...DEFAULT_PREFS[g], ...(p[g] ?? {}) }
  return out as Prefs
}

export function usePref<G extends Group, K extends keyof Prefs[G]>(group: G, key: K): Prefs[G][K] {
  return usePrefs()[group][key]
}

/** Set one key path of the document (e.g. "prefs.display.theme" or "views.projects"), optimistically. */
export function useSetMe() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { key: string; value: unknown }) => call('me.set', v),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ME_KEY })
      const prev = qc.getQueryData<MeDoc>(ME_KEY)
      qc.setQueryData<MeDoc>(ME_KEY, (d) => setPath(d ?? { prefs: {}, views: {} }, v.key, v.value))
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ME_KEY, ctx.prev)
    },
  })
}

export function useSetPref() {
  const m = useSetMe()
  return useCallback(<G extends Group, K extends keyof Prefs[G]>(group: G, key: K, value: Prefs[G][K]) => m.mutate({ key: `prefs.${group}.${String(key)}`, value }), [m])
}

/** One table's saved view, and a setter that writes it (debounced by the caller). */
export function useTableView(id: string): [TableView | undefined, (v: TableView | null) => void] {
  const { data } = useMe()
  const m = useSetMe()
  const set = useCallback((v: TableView | null) => m.mutate({ key: `views.${id}`, value: v }), [m, id])
  return [data?.views?.[id], set]
}

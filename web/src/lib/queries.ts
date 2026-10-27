/**
 * Query keys and the data hooks every screen shares. A key starts with the action name, then the repo when there is
 * one, so a live event can invalidate "everything about this repo's journey" with a prefix (lib/live.ts).
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ActionName, type ArgsOf, call } from './api'

export const keys = {
  action: <A extends ActionName>(a: A, args?: ArgsOf<A>) => (args && 'repo' in (args as object) ? [a, (args as { repo: string }).repo, args] : [a, args ?? {}]) as readonly unknown[],
}

/** queryOptions for one action: `useQuery(q('journey.get', { repo }))`. */
export function q<A extends ActionName>(action: A, args: ArgsOf<A>, o: { enabled?: boolean; staleTime?: number } = {}) {
  return queryOptions({
    queryKey: keys.action(action, args),
    queryFn: ({ signal }) => call(action, args, { signal }),
    ...o,
  })
}

export const useAction = <A extends ActionName>(action: A, args: ArgsOf<A>, o: { enabled?: boolean } = {}) => useQuery(q(action, args, o))

export const useProjects = () => useAction('projects', {})
export const useInbox = () => useAction('inbox', {})
export const useJourney = (repo: string) => useAction('journey.get', { repo })
export const useWaits = (repo: string, enabled = true) => useAction('tools.waits', { repo }, { enabled })

/** A mutation for one action; invalidates the given key prefixes when it settles. */
export function useCall<A extends ActionName>(action: A, invalidate: (args: ArgsOf<A>) => readonly unknown[][] = () => []) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: ArgsOf<A>) => call(action, args),
    onSettled: (_d, _e, args) => {
      for (const k of invalidate(args)) void qc.invalidateQueries({ queryKey: k })
    },
  })
}

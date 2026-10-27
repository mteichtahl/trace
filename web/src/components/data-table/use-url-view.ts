import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
import { type UrlView, fromSearch, toSearch } from './view'

/** A Data table's sort, filters and search in the page's address: `<DataTable url={useUrlView('projects')} …/>`. */
export function useUrlView(id: string): { view: UrlView; set: (v: UrlView) => void } {
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const navigate = useNavigate()
  const view = useMemo(() => fromSearch(id, search), [id, search])
  const set = useCallback(
    (v: UrlView) => {
      void navigate({ to: '.', search: ((prev: Record<string, unknown>) => ({ ...prev, ...toSearch(id, v) })) as never, replace: true })
    },
    [id, navigate],
  )
  return { view, set }
}

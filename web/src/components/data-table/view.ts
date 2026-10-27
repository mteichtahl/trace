/**
 * A Data table's view (sort, filters, widths, visible columns, order) and how it travels: to the person's
 * preferences (me.set views.<id>) and, for sort, filters and search, into the page's address so a link shares the
 * exact view. Pure functions, tested on their own.
 */
import type { ColumnFiltersState, SortingState } from '@tanstack/react-table'
import type { TableView } from '@/lib/types'

export interface UrlView {
  sorting?: SortingState
  filters?: ColumnFiltersState
  q?: string
}

/** "status:asc,name:desc" */
export const encodeSort = (s: SortingState): string => s.map((x) => `${x.id}:${x.desc ? 'desc' : 'asc'}`).join(',')
export const decodeSort = (s: string): SortingState =>
  s.split(',').filter(Boolean).map((p) => {
    const [id, dir] = p.split(':')
    return { id: id ?? '', desc: dir === 'desc' }
  }).filter((x) => x.id)

export function toSearch(id: string, v: UrlView): Record<string, string | undefined> {
  return {
    [`${id}.sort`]: v.sorting?.length ? encodeSort(v.sorting) : undefined,
    [`${id}.f`]: v.filters?.length ? JSON.stringify(v.filters.map((f) => [f.id, f.value])) : undefined,
    [`${id}.q`]: v.q || undefined,
  }
}

export function fromSearch(id: string, search: Record<string, unknown>): UrlView {
  const out: UrlView = {}
  const s = search[`${id}.sort`]
  if (typeof s === 'string' && s) out.sorting = decodeSort(s)
  const f = search[`${id}.f`]
  const raw = typeof f === 'string' ? safeJson(f) : f
  if (Array.isArray(raw)) out.filters = raw.filter((x): x is [string, unknown] => Array.isArray(x) && typeof x[0] === 'string').map(([fid, value]) => ({ id: fid, value }))
  const q = search[`${id}.q`]
  if (typeof q === 'string' || typeof q === 'number') out.q = String(q)
  return out
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

export const isEmptyView = (v: TableView | undefined): boolean =>
  !v || (!v.sorting?.length && !v.filters?.length && !Object.keys(v.sizing ?? {}).length && !Object.keys(v.visibility ?? {}).length && !v.order?.length)

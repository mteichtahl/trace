/**
 * The one Data table (docs/ui-design.md, "Every table works the same way"), on TanStack Table with shadcn's Table:
 *
 * - Ordered: click a header for ascending, again descending, again clear; Shift-click adds a further sort.
 * - Searched: one box matches across every visible column, matches highlighted, "12 of 240 rows".
 * - Filtered: per-column filters fitted to the column's `meta.kind` (pick-list, range, contains), shown as removable
 *   chips with Clear all.
 * - Resized: drag a header's edge; double-click it to fit the content. Widths have a minimum.
 * - Shown or hidden: a Columns menu with Reset to default; the first column cannot be hidden.
 * - Reordered: drag a header to move its column.
 * - Kept: the view is saved per table with the person's preferences (me.set views.<id>), and sort, filters and search
 *   go into the address (pass `url={useUrlView(id)}`) so a link shares it. Reset view returns to the default.
 * - Paged, with the header and first column fixed while scrolling; stacked cards under 640 px.
 *
 * Columns are plain TanStack `ColumnDef`s with `meta: { label, kind, options?, mono?, align? }`.
 */
import {
  type Column, type ColumnDef, type ColumnFiltersState, type ColumnOrderState, type ColumnSizingState, type FilterFn, type Row, type SortingState,
  type VisibilityState, flexRender, getCoreRowModel, getFacetedUniqueValues, getFilteredRowModel, getPaginationRowModel, getSortedRowModel, useReactTable,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Columns3, ListFilter, Search, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useTableView } from '@/lib/prefs'
import type { TableView } from '@/lib/types'
import { cn } from '@/lib/utils'
import { SearchContext, highlight } from './highlight'
import { type UrlView, isEmptyView } from './view'

export type ColumnKind = 'text' | 'number' | 'date' | 'enum'

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    /** the header's words, also used in menus and chips */
    label?: string
    kind?: ColumnKind
    /** pick-list choices for kind enum (otherwise taken from the data) */
    options?: string[]
    mono?: boolean
    align?: 'left' | 'right'
  }
}

const MIN_WIDTH = 64

// ------------------------------------------------------------------ filter functions per kind

const enumFilter: FilterFn<unknown> = (row, id, value: string[]) => !value?.length || value.includes(String(row.getValue(id)))
const rangeFilter: FilterFn<unknown> = (row, id, value: [number | string | null, number | string | null]) => {
  const raw = row.getValue(id)
  const v = typeof raw === 'number' ? raw : new Date(String(raw)).getTime()
  const [lo, hi] = (value ?? [null, null]).map((x) => (x === null || x === '' ? null : typeof x === 'number' ? x : isNaN(Number(x)) ? new Date(x).getTime() : Number(x)))
  return (lo === null || v >= lo) && (hi === null || v <= hi)
}
const textFilter: FilterFn<unknown> = (row, id, value: string) => !value || String(row.getValue(id) ?? '').toLowerCase().includes(String(value).toLowerCase())

const kindOf = <T,>(c: Column<T, unknown>): ColumnKind => c.columnDef.meta?.kind ?? 'text'
const labelOf = <T,>(c: Column<T, unknown>): string => c.columnDef.meta?.label ?? (typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id)

export function describeFilter(kind: ColumnKind, value: unknown): string {
  if (kind === 'enum') return (value as string[]).join(', ')
  if (kind === 'number' || kind === 'date') {
    const [lo, hi] = value as [unknown, unknown]
    if (lo != null && lo !== '' && hi != null && hi !== '') return `${lo} – ${hi}`
    if (lo != null && lo !== '') return `≥ ${lo}`
    return `≤ ${hi}`
  }
  return `contains "${value}"`
}

const useNarrow = (px = 640): boolean => {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(`(max-width: ${px - 1}px)`).matches
  const [narrow, set] = useState(get)
  useEffect(() => {
    const mq = window.matchMedia?.(`(max-width: ${px - 1}px)`)
    if (!mq) return
    const on = () => set(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [px])
  return narrow
}

export interface DataTableProps<T> {
  /** the table's id: where its view is saved (views.<id>) and its address keys (<id>.sort, …) */
  id: string
  data: T[]
  columns: ColumnDef<T, any>[]
  getRowId?: (row: T, i: number) => string
  onRowClick?: (row: T) => void
  /** URL sync: `useUrlView(id)` */
  url?: { view: UrlView; set: (v: UrlView) => void }
  /** save the view with the person's preferences (default true) */
  persist?: boolean
  /** the default view: what Reset view returns to */
  defaultView?: TableView
  pageSize?: number
  /** "parts": "12 of 240 parts" */
  noun?: string
  empty?: ReactNode
  /** extra controls at the right of the toolbar */
  actions?: ReactNode
  /** scroll height for the sticky header (default 70vh) */
  maxHeight?: string
  className?: string
}

export function DataTable<T>({
  id, data, columns, getRowId, onRowClick, url, persist = true, defaultView, pageSize = 50, noun = 'rows', empty, actions, maxHeight = '70vh', className,
}: DataTableProps<T>) {
  const [saved, save] = useTableView(id)
  const base = defaultView ?? {}
  const initial: TableView = !isEmptyView(saved) && persist ? saved! : base
  const fromUrl = url?.view

  const [sorting, setSorting] = useState<SortingState>(fromUrl?.sorting ?? initial.sorting ?? [])
  const [columnFilters, setFilters] = useState<ColumnFiltersState>((fromUrl?.filters ?? initial.filters ?? []) as ColumnFiltersState)
  const [globalFilter, setGlobal] = useState(fromUrl?.q ?? '')
  const [columnSizing, setSizing] = useState<ColumnSizingState>(initial.sizing ?? {})
  const [columnVisibility, setVisibility] = useState<VisibilityState>(initial.visibility ?? {})
  const [columnOrder, setOrder] = useState<ColumnOrderState>(initial.order ?? [])
  const narrow = useNarrow()

  // the saved view arrives after the first render (me.get): take it once, unless the address already set a view
  const took = useRef(!isEmptyView(saved))
  useEffect(() => {
    if (took.current || !persist || isEmptyView(saved)) return
    took.current = true
    if (!fromUrl?.sorting) setSorting(saved!.sorting ?? [])
    if (!fromUrl?.filters) setFilters((saved!.filters ?? []) as ColumnFiltersState)
    setSizing(saved!.sizing ?? {})
    setVisibility(saved!.visibility ?? {})
    setOrder(saved!.order ?? [])
  }, [saved, persist, fromUrl])

  // keep the view: preferences (debounced) and the address
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    url?.set({ sorting, filters: columnFilters, q: globalFilter })
    if (!persist) return
    const t = setTimeout(() => save({ sorting, filters: columnFilters as TableView['filters'], sizing: columnSizing, visibility: columnVisibility, order: columnOrder }), 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorting, columnFilters, globalFilter, columnSizing, columnVisibility, columnOrder])

  const cols = useMemo(
    () =>
      columns.map((c, i) => {
        const kind = c.meta?.kind ?? 'text'
        return {
          minSize: MIN_WIDTH,
          // plain columns show their value with the search words marked
          cell: ({ getValue }: { getValue: () => unknown }) => <Highlightable value={getValue()} />,
          ...c,
          ...(i === 0 ? { enableHiding: false } : {}),
          filterFn: c.filterFn ?? (kind === 'enum' ? enumFilter : kind === 'number' || kind === 'date' ? rangeFilter : textFilter),
        } as ColumnDef<T, any>
      }),
    [columns],
  )

  const table = useReactTable({
    data,
    columns: cols,
    getRowId,
    state: { sorting, columnFilters, globalFilter, columnSizing, columnVisibility, columnOrder },
    onSortingChange: setSorting,
    onColumnFiltersChange: setFilters,
    onGlobalFilterChange: setGlobal,
    onColumnSizingChange: setSizing,
    onColumnVisibilityChange: setVisibility,
    onColumnOrderChange: setOrder,
    enableMultiSort: true,
    isMultiSortEvent: (e) => (e as MouseEvent).shiftKey,
    enableSortingRemoval: true,
    sortDescFirst: false,
    columnResizeMode: 'onChange',
    globalFilterFn: (row, colId, value: string): boolean => {
      if (columnVisibility[colId] === false) return false
      return String(row.getValue(colId) ?? '').toLowerCase().includes(String(value).toLowerCase())
    },
    getColumnCanGlobalFilter: () => true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  })

  const total = data.length
  const shown = table.getFilteredRowModel().rows.length
  const filtering = !!globalFilter || columnFilters.length > 0

  const resetView = () => {
    setSorting(base.sorting ?? [])
    setFilters((base.filters ?? []) as ColumnFiltersState)
    setGlobal('')
    setSizing(base.sizing ?? {})
    setVisibility(base.visibility ?? {})
    setOrder(base.order ?? [])
    if (persist) save(null)
  }

  // double-click a resize handle: fit the column to its widest cell
  const scroller = useRef<HTMLDivElement>(null)
  const fit = useCallback((colId: string) => {
    const cells = scroller.current?.querySelectorAll<HTMLElement>(`[data-col="${CSS.escape(colId)}"] > [data-fit]`)
    let w = MIN_WIDTH
    cells?.forEach((c) => (w = Math.max(w, c.scrollWidth + 32)))
    setSizing((s) => ({ ...s, [colId]: Math.min(w, 640) }))
  }, [])

  // drag a header to reorder
  const dragging = useRef<string | null>(null)
  const drop = (target: string) => {
    const from = dragging.current
    dragging.current = null
    if (!from || from === target) return
    const order = table.getAllLeafColumns().map((c) => c.id)
    const current = columnOrder.length ? [...columnOrder, ...order.filter((x) => !columnOrder.includes(x))] : order
    const without = current.filter((x) => x !== from)
    without.splice(without.indexOf(target), 0, from)
    setOrder(without)
  }

  const rows = table.getRowModel().rows
  const visibleCols = table.getVisibleLeafColumns()

  return (
    <SearchContext.Provider value={globalFilter}>
      <div className={cn('space-y-3', className)} data-table={id}>
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={globalFilter} onChange={(e) => setGlobal(e.target.value)} placeholder="Search…" className="pl-8" aria-label="Search the table" />
          </div>
          <FilterMenu table={table} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Columns3 /> Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Show columns</DropdownMenuLabel>
              {table.getAllLeafColumns().map((c) => (
                <DropdownMenuCheckboxItem key={c.id} checked={c.getIsVisible()} disabled={!c.getCanHide()} onCheckedChange={(v) => c.toggleVisibility(!!v)} onSelect={(e) => e.preventDefault()}>
                  {labelOf(c)}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => { setVisibility(base.visibility ?? {}); setOrder(base.order ?? []) }}>Reset to default</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" onClick={resetView} className="text-muted-foreground">
            Reset view
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {actions}
            <span className="text-sm text-muted-foreground" aria-live="polite" data-testid="row-count">
              {shown} of {total} {noun}
            </span>
          </div>
        </div>

        {/* filter chips */}
        {columnFilters.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {columnFilters.map((f) => {
              const col = table.getColumn(f.id)
              if (!col) return null
              return (
                <Badge key={f.id} variant="secondary" className="gap-1 pr-1 font-normal">
                  <span className="font-medium">{labelOf(col)}</span> {describeFilter(kindOf(col), f.value)}
                  <button type="button" aria-label={`Remove filter on ${labelOf(col)}`} className="rounded-sm p-0.5 hover:bg-background" onClick={() => col.setFilterValue(undefined)}>
                    <X className="size-3" />
                  </button>
                </Badge>
              )
            })}
            <Button variant="link" size="sm" className="h-6 px-1" onClick={() => setFilters([])}>
              Clear all
            </Button>
          </div>
        )}

        {/* body */}
        {total === 0 && empty ? (
          <div className="rounded-xl border border-dashed px-5 py-6 text-sm text-muted-foreground">{empty}</div>
        ) : narrow ? (
          <ul className="space-y-2" aria-label={`${noun}, as cards`}>
            {rows.map((r) => (
              <RowCard key={r.id} row={r} onClick={onRowClick} />
            ))}
            {rows.length === 0 && <li className="py-6 text-center text-sm text-muted-foreground">No {noun} match{filtering ? ' the search or filters' : ''}.</li>}
          </ul>
        ) : (
          <div ref={scroller} className="relative overflow-auto rounded-xl border" style={{ maxHeight }}>
            <table className="w-full caption-bottom border-separate border-spacing-0 text-sm" style={{ minWidth: table.getTotalSize() }}>
              <TableHeader className="sticky top-0 z-20 bg-background [&_tr]:border-b-0">
                {table.getHeaderGroups().map((hg) => (
                  <TableRow key={hg.id} className="hover:bg-transparent">
                    {hg.headers.map((h, i) => {
                      const sorted = h.column.getIsSorted()
                      const idx = h.column.getSortIndex()
                      const align = h.column.columnDef.meta?.align
                      return (
                        <TableHead
                          key={h.id}
                          style={{ width: h.getSize() }}
                          aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                          className={cn('relative select-none border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground', i === 0 && 'sticky left-0 z-10 bg-muted', align === 'right' && 'text-right')}
                          draggable
                          onDragStart={() => (dragging.current = h.column.id)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => drop(h.column.id)}
                        >
                          {h.isPlaceholder ? null : h.column.getCanSort() ? (
                            <button
                              type="button"
                              onClick={h.column.getToggleSortingHandler()}
                              className={cn('inline-flex items-center gap-1 hover:text-foreground', sorted && 'text-foreground')}
                              title="Click to sort; Shift-click to add a sort"
                            >
                              {flexRender(h.column.columnDef.header, h.getContext())}
                              {sorted === 'asc' && <ArrowUp className="size-3.5" aria-hidden />}
                              {sorted === 'desc' && <ArrowDown className="size-3.5" aria-hidden />}
                              {sorted && sorting.length > 1 && <span className="text-[10px]">{idx + 1}</span>}
                            </button>
                          ) : (
                            flexRender(h.column.columnDef.header, h.getContext())
                          )}
                          {h.column.getCanResize() && (
                            <div
                              role="separator"
                              aria-orientation="vertical"
                              aria-label={`Resize ${labelOf(h.column)}`}
                              onMouseDown={h.getResizeHandler()}
                              onTouchStart={h.getResizeHandler()}
                              onDoubleClick={() => fit(h.column.id)}
                              className={cn('absolute right-0 top-0 h-full w-1.5 cursor-col-resize touch-none hover:bg-primary/40', h.column.getIsResizing() && 'bg-primary')}
                            />
                          )}
                        </TableHead>
                      )
                    })}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.id}
                    onClick={onRowClick ? () => onRowClick(r.original) : undefined}
                    className={cn('group', onRowClick && 'cursor-pointer')}
                  >
                    {r.getVisibleCells().map((c, i) => (
                      <TableCell
                        key={c.id}
                        data-col={c.column.id}
                        style={{ width: c.column.getSize(), maxWidth: c.column.getSize() }}
                        className={cn(
                          'whitespace-normal border-b px-3 py-2.5 align-middle',
                          i === 0 && 'sticky left-0 z-[1] bg-background group-hover:bg-muted',
                          c.column.columnDef.meta?.mono && 'font-mono text-[13px]',
                          c.column.columnDef.meta?.align === 'right' && 'text-right',
                        )}
                      >
                        <div data-fit className="inline-block max-w-full">
                          {flexRender(c.column.columnDef.cell, c.getContext())}
                        </div>
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={visibleCols.length} className="py-8 text-center text-muted-foreground">
                      No {noun} match{filtering ? ' the search or filters' : ''}.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </table>
          </div>
        )}

        {/* paging */}
        {table.getPageCount() > 1 && (
          <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
            <span>
              Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
            </span>
            <Button variant="outline" size="icon" aria-label="Previous page" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="icon" aria-label="Next page" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
              <ChevronRight />
            </Button>
          </div>
        )}
      </div>
    </SearchContext.Provider>
  )
}

/** On a phone each row is a card with its first column as the title. */
function RowCard<T>({ row, onClick }: { row: Row<T>; onClick?: (r: T) => void }) {
  const [first, ...rest] = row.getVisibleCells()
  const render = (c: (typeof rest)[number]) => flexRender(c.column.columnDef.cell, c.getContext())
  return (
    <li>
      <div
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        onClick={onClick ? () => onClick(row.original) : undefined}
        className="rounded-xl border bg-card p-4"
      >
        {first && <div className="font-medium">{render(first)}</div>}
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {rest.map((c) => (
            <div key={c.id} className="contents">
              <dt className="text-muted-foreground">{labelOf(c.column)}</dt>
              <dd className={cn('min-w-0', c.column.columnDef.meta?.mono && 'font-mono text-[13px]')}>{render(c)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </li>
  )
}

function Highlightable({ value }: { value: unknown }) {
  return <SearchContext.Consumer>{(q) => highlight(String(value ?? ''), q)}</SearchContext.Consumer>
}

// ------------------------------------------------------------------ the Filter popover

function FilterMenu<T>({ table }: { table: ReturnType<typeof useReactTable<T>> }) {
  const filterable = table.getAllLeafColumns().filter((c) => c.getCanFilter())
  const [colId, setColId] = useState<string>(filterable[0]?.id ?? '')
  const col = table.getColumn(colId)
  const active = table.getState().columnFilters.length
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">
          <ListFilter /> Filter
          {active > 0 && <Badge className="ml-0.5 h-5 min-w-5 px-1">{active}</Badge>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="filter-col">Column</Label>
          <Select value={colId} onValueChange={setColId}>
            <SelectTrigger id="filter-col" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {filterable.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {labelOf(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {col && <FilterControl column={col} />}
      </PopoverContent>
    </Popover>
  )
}

function FilterControl<T>({ column }: { column: Column<T, unknown> }) {
  const kind = kindOf(column)
  const value = column.getFilterValue()
  if (kind === 'enum') {
    const options = column.columnDef.meta?.options ?? [...column.getFacetedUniqueValues().keys()].map(String).sort()
    const chosen = (value as string[] | undefined) ?? []
    return (
      <fieldset className="max-h-60 space-y-1 overflow-auto">
        <legend className="sr-only">Show only</legend>
        {options.map((o) => (
          <Label key={o} className="flex items-center gap-2 font-normal">
            <Checkbox
              checked={chosen.includes(o)}
              onCheckedChange={(on) => {
                const next = on ? [...chosen, o] : chosen.filter((x) => x !== o)
                column.setFilterValue(next.length ? next : undefined)
              }}
            />
            {o}
          </Label>
        ))}
      </fieldset>
    )
  }
  if (kind === 'number' || kind === 'date') {
    const [lo, hi] = (value as [string | number | null, string | number | null] | undefined) ?? [null, null]
    const type = kind === 'date' ? 'date' : 'number'
    const set = (a: unknown, b: unknown) => column.setFilterValue(a === '' && b === '' ? undefined : [a === '' ? null : type === 'number' ? Number(a) : a, b === '' ? null : type === 'number' ? Number(b) : b])
    return (
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="f-lo">From</Label>
          <Input id="f-lo" type={type} value={lo ?? ''} onChange={(e) => set(e.target.value, hi ?? '')} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="f-hi">To</Label>
          <Input id="f-hi" type={type} value={hi ?? ''} onChange={(e) => set(lo ?? '', e.target.value)} />
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <Label htmlFor="f-text">Contains</Label>
      <Input id="f-text" value={(value as string) ?? ''} onChange={(e) => column.setFilterValue(e.target.value || undefined)} />
    </div>
  )
}

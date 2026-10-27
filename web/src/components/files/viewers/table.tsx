/**
 * Tables (.csv, .tsv, parts lists, placement files): the shared Data table (sort, search, filter, resize, choose and
 * reorder columns). A parts list links each line's part to the parts library. The card shows the first 5 rows and
 * the row count.
 */
import { Link } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { useMemo } from 'react'
import { DataTable, Highlight } from '@/components/data-table'
import { cn } from '@/lib/utils'
import { useFileText } from '../data'
import { type Table, cellNumber, parseDelimited, partsColumns } from '../csv'
import { AREA, ViewerError, ViewerLoading, type ViewerProps } from './common'

type Row = Record<string, string>

/** Columns for a parsed table: numbers right-aligned and sorted as numbers. */
export function tableColumns(t: Table): ColumnDef<Row, any>[] {
  const parts = partsColumns(t.header)
  return t.header.map((h, i) => {
    const numeric = t.rows.length > 0 && t.rows.slice(0, 50).every((r) => r[i] === '' || r[i] === undefined || cellNumber(r[i]) !== null && /^[\s$€£¥]*-?[\d.,]+\s*[a-zµ%]*$/i.test(r[i]!))
    const id = `c${i}`
    const col: ColumnDef<Row, any> = {
      id,
      accessorFn: (r) => (numeric ? (cellNumber(r[id]) ?? r[id]) : r[id]),
      header: h || `Column ${i + 1}`,
      size: Math.min(340, Math.max(80, (Math.max(h.length, ...t.rows.slice(0, 50).map((r) => (r[i] ?? '').length)) + 3) * 8.4)),
      meta: { label: h || `Column ${i + 1}`, kind: numeric ? 'number' : 'text', align: numeric ? 'right' : 'left', mono: /^(ref|designator|mpn|lcsc|footprint|package|part)/i.test(h) },
    }
    if (parts && i === parts.part) {
      col.cell = ({ row }) => {
        const mpn = row.original[id] ?? ''
        return mpn ? (
          <Link to="/knowledge" search={{ tab: 'parts', q: mpn } as never} className="font-mono text-primary underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
            <Highlight text={mpn} />
          </Link>
        ) : null
      }
    } else if (numeric) {
      col.cell = ({ row }) => <span className="tabular-nums"><Highlight text={row.original[id] ?? ''} /></span>
    }
    return col
  })
}

export const tableRows = (t: Table): Row[] => t.rows.map((r) => Object.fromEntries(r.map((v, i) => [`c${i}`, v])))

export default function TableViewer({ file, size, commit }: ViewerProps) {
  const q = useFileText(file, { commit })
  const table = useMemo(() => (q.data !== undefined ? parseDelimited(q.data, file.path.toLowerCase().endsWith('.tsv') ? '\t' : undefined) : null), [q.data, file.path])
  const columns = useMemo(() => (table ? tableColumns(table) : []), [table])
  const rows = useMemo(() => (table ? tableRows(table) : []), [table])
  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (!table) return <ViewerLoading size={size} />
  const parts = partsColumns(table.header)
  if (size === 'card') {
    return (
      <div className="overflow-x-auto text-xs">
        <table className="w-full">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              {table.header.slice(0, 4).map((h) => (
                <th key={h} className="px-3 py-1.5 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.slice(0, 5).map((r, i) => (
              <tr key={i} className="border-b last:border-0">
                {r.slice(0, 4).map((c, j) => (
                  <td key={j} className={cn('px-3 py-1.5', j === 0 && 'font-mono')}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="px-3 py-1.5 text-muted-foreground">
          {Math.min(5, table.rows.length)} of {table.rows.length.toLocaleString()} rows{parts ? ' · parts list' : ''}
        </p>
      </div>
    )
  }
  return (
    <div className={cn('overflow-auto p-3', AREA[size])}>
      <DataTable
        id={`file:${parts ? 'parts' : 'table'}`}
        data={rows}
        columns={columns}
        getRowId={(_, i) => String(i)}
        persist={false}
        noun={parts ? 'lines' : 'rows'}
        maxHeight={size === 'page' ? 'calc(100dvh - 330px)' : 'calc(100dvh - 350px)'}
        empty="This table has a header but no rows."
      />
    </div>
  )
}

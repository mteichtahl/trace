/**
 * SQLite databases (.db, .sqlite): opened in the browser on a copy of the file, so nothing here changes it. Pick a
 * table to see its rows in the shared Data table (sort, search, filter, resize, choose columns), its structure
 * (columns, keys, the statement that made it), or ask your own read-only question in SQL. Any table or answer
 * downloads as CSV. The card lists the tables and their row counts. Comparing two versions shows which tables
 * changed and, row by row, what was added, removed or changed. A trace project record's tool runs and the files they
 * made are said by tool and by file, with the repeats counted, before their rows (test-esp32 log #49).
 */
import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Download, Play, Table2, Eye } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Database, SqlValue } from 'sql.js'
import { DataTable, Highlight } from '@/components/data-table'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { type FileRef, useFileBytes } from '../data'
import { baseName } from '../kinds'
import { type DbTable, type RunsDigest, type TableDiff, all, cellText, describeDbDiff, describeRuns, diffDb, loadSql, openDb, readOnly, readRows, resultWord, runsDigest, summarise, toCsv } from '../sqlite'
import { AREA, Controls, Note, ViewerError, ViewerLoading, type ViewerProps, type ViewerSize } from './common'

const ROW_LIMIT = 5000

/** "1 row", "2,040 rows" */
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** The file opened as a database (cached with its bytes' version). */
export function useDatabase(file: FileRef | null, commit?: string) {
  const bytes = useFileBytes(file, { commit })
  const db = useQuery({
    queryKey: ['file.sqlite', file?.repo, file?.path, commit ?? file?.commit ?? 'current', file?.url ?? ''],
    queryFn: async () => openDb(await loadSql(), bytes.data!),
    enabled: !!bytes.data,
    staleTime: Infinity,
    gcTime: 5 * 60_000,
  })
  return { db: db.data, error: bytes.error ?? db.error, retry: () => void (bytes.isError ? bytes.refetch() : db.refetch()) }
}

type Row = Record<string, SqlValue>

/** Columns for rows from the database: numbers right-aligned and sorted as numbers, NULLs shown faintly. */
function rowColumns(names: string[], values: SqlValue[][], types: string[] = []): ColumnDef<Row, any>[] {
  return names.map((n, i) => {
    const id = `c${i}`
    const sample = values.slice(0, 50).map((r) => r[i]).filter((v) => v !== null)
    const numeric = /int|real|floa|doub|num|dec/i.test(types[i] ?? '') || (sample.length > 0 && sample.every((v) => typeof v === 'number'))
    const longest = Math.max(n.length, ...values.slice(0, 50).map((r) => cellText(r[i]!).length))
    return {
      id,
      accessorFn: (r) => (r[id] instanceof Uint8Array ? cellText(r[id]) : r[id]),
      header: n || `Column ${i + 1}`,
      size: Math.min(360, Math.max(80, (longest + 3) * 8.4)),
      meta: { label: n || `Column ${i + 1}`, kind: numeric ? 'number' : 'text', align: numeric ? 'right' : 'left', mono: /(^|_)(id|ref|mpn|lcsc|hash|sha|uuid|key)$/i.test(n) },
      cell: ({ row }) => {
        const v = row.original[id]
        if (v === null || v === undefined) return <span className="text-muted-foreground/60 italic">empty</span>
        return <span className={cn(numeric && 'tabular-nums')}><Highlight text={cellText(v)} /></span>
      },
    }
  })
}

const asRows = (values: SqlValue[][]): Row[] => values.map((r) => Object.fromEntries(r.map((v, i) => [`c${i}`, v])))

function saveCsv(name: string, columns: string[], values: SqlValue[][]) {
  const url = URL.createObjectURL(new Blob([toCsv(columns, values)], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.csv`
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function RowsTable({ id, columns, values, types, size, total }: { id: string; columns: string[]; values: SqlValue[][]; types?: string[]; size: ViewerSize; total?: number }) {
  const cols = useMemo(() => rowColumns(columns, values, types), [columns, values, types])
  const data = useMemo(() => asRows(values), [values])
  return (
    <>
      {total !== undefined && total > values.length && (
        <Note>Showing the first {values.length.toLocaleString()} of {total.toLocaleString()} rows. Download as CSV, or ask a question in Query, to reach the rest.</Note>
      )}
      <DataTable
        id={id}
        data={data}
        columns={cols}
        getRowId={(_, i) => String(i)}
        persist={false}
        noun="rows"
        maxHeight={size === 'page' ? 'calc(100dvh - 380px)' : 'calc(100dvh - 400px)'}
        empty="This table has no rows yet."
      />
    </>
  )
}

function Structure({ table, db }: { table: DbTable; db: Database }) {
  const fks = useMemo(() => {
    if (table.kind === 'view') return []
    try {
      return all(db, `PRAGMA foreign_key_list("${table.name.replace(/"/g, '""')}")`).values.map((r) => ({ from: String(r[3]), table: String(r[2]), to: String(r[4] ?? '') }))
    } catch {
      return []
    }
  }, [db, table])
  return (
    <div className="space-y-4 p-3 text-sm">
      <table className="w-full max-w-2xl">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1.5 pr-3 font-medium">Column</th>
            <th className="py-1.5 pr-3 font-medium">Holds</th>
            <th className="py-1.5 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody>
          {table.columns.map((c) => {
            const fk = fks.find((f) => f.from === c.name)
            const notes = [c.pk ? 'Identifies each row (primary key)' : '', c.notnull ? 'Always filled in' : '', fk ? `Points to ${fk.table}${fk.to ? `.${fk.to}` : ''}` : ''].filter(Boolean)
            return (
              <tr key={c.name} className="border-b last:border-0">
                <td className="py-1.5 pr-3 font-mono text-xs">{c.name}</td>
                <td className="py-1.5 pr-3 text-xs">{c.type || 'any value'}</td>
                <td className="py-1.5 text-xs text-muted-foreground">{notes.join(' · ')}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {table.sql && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">The statement that made this {table.kind}</summary>
          <pre className="mt-2 overflow-auto rounded-md bg-muted p-3 font-mono">{table.sql}</pre>
        </details>
      )}
    </div>
  )
}

function Query({ db, size, start }: { db: Database; size: ViewerSize; start: string }) {
  const [sql, setSql] = useState(start)
  const [res, setRes] = useState<{ columns: string[]; values: SqlValue[][] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const run = () => {
    setErr(null)
    if (!readOnly(sql)) {
      setRes(null)
      setErr('Only questions that read (SELECT, WITH, EXPLAIN) run here, one at a time. The file itself is never changed.')
      return
    }
    try {
      setRes(all(db, sql))
    } catch (e) {
      setRes(null)
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="space-y-2 p-3">
      <Textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run() } }}
        className="min-h-[84px] font-mono text-xs"
        spellCheck={false}
        aria-label="Your question in SQL"
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Button size="sm" className="h-7 text-xs" onClick={run}><Play /> Run</Button>
        <span className="text-muted-foreground">Ctrl or ⌘ + Enter runs it. Reading only; runs in your browser.</span>
        {res && res.columns.length > 0 && (
          <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={() => saveCsv('query', res.columns, res.values)}><Download /> Download as CSV</Button>
        )}
      </div>
      {err && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{err}</p>}
      {res && (res.columns.length ? <RowsTable id="file:sqlite-query" columns={res.columns} values={res.values} size={size} /> : <Note>The question ran and gave no rows.</Note>)}
    </div>
  )
}

export default function DatabaseViewer({ file, size, commit }: ViewerProps) {
  const { db, error, retry } = useDatabase(file, commit)
  const summary = useMemo(() => (db ? summarise(db) : null), [db])
  const [pick, setPick] = useState<string | null>(null)
  const [tab, setTab] = useState('rows')
  const table = summary?.tables.find((t) => t.name === pick) ?? [...(summary?.tables ?? [])].filter((t) => t.kind === 'table').sort((a, b) => b.rows - a.rows)[0] ?? summary?.tables[0]
  const rows = useMemo(() => (db && table && size !== 'card' ? readRows(db, table, ROW_LIMIT) : null), [db, table, size])

  if (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return /not a SQLite/.test(msg) ? <Note>{msg} Download it to open it with the program that made it.</Note> : <ViewerError error={error} onRetry={retry} />
  }
  if (!db || !summary) return <ViewerLoading size={size} label="Opening the database" />
  if (summary.tables.length === 0) return <Note>This database has no tables yet.</Note>

  if (size === 'card')
    return (
      <ul className="max-h-[220px] overflow-auto px-3 py-2 text-xs">
        {summary.tables.slice(0, 10).map((t) => (
          <li key={t.name} className="flex items-center gap-2 py-0.5">
            {t.kind === 'view' ? <Eye className="size-3.5 text-muted-foreground" aria-hidden /> : <Table2 className="size-3.5 text-muted-foreground" aria-hidden />}
            <span className="min-w-0 flex-1 truncate font-mono">{t.name}</span>
            <span className="text-muted-foreground">{count(t.rows, 'row')} · {count(t.columns.length, 'column')}</span>
          </li>
        ))}
        {summary.tables.length > 10 && <li className="pt-1 text-muted-foreground">and {summary.tables.length - 10} more</li>}
      </ul>
    )

  const t = table!
  const types = t.columns.map((c) => c.type)
  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <Controls>
        <span className="text-muted-foreground">Table</span>
        <Select value={t.name} onValueChange={(v) => setPick(v)}>
          <SelectTrigger size="sm" className="h-7 min-w-[180px] text-xs" aria-label="Which table">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {summary.tables.map((x) => (
              <SelectItem key={x.name} value={x.name} className="text-xs">
                <span className="font-mono">{x.name}</span>
                <span className="ml-2 text-muted-foreground">{x.kind === 'view' ? 'view · ' : ''}{count(x.rows, 'row')}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground">
          {count(summary.tables.length, 'table')} · opened in your browser, read only
        </span>
        <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={() => saveCsv(`${baseName(file.path).replace(/\.[^.]+$/, '')}-${t.name}`, ...(() => { const r = all(db, `SELECT * FROM "${t.name.replace(/"/g, '""')}"`); return [r.columns, r.values] as const })())}>
          <Download /> Download {t.name} as CSV
        </Button>
      </Controls>
      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
        <div className="border-b px-3 py-1.5">
          <TabsList className="h-8">
            <TabsTrigger value="rows" className="text-xs">Rows</TabsTrigger>
            <TabsTrigger value="structure" className="text-xs">Structure</TabsTrigger>
            <TabsTrigger value="query" className="text-xs">Query</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="rows" className="min-h-0 overflow-auto p-3">
          {rows && <RowsTable key={t.name} id="file:sqlite" columns={rows.columns.length ? rows.columns : t.columns.map((c) => c.name)} values={rows.values} types={types} size={size} total={t.rows} />}
        </TabsContent>
        <TabsContent value="structure" className="min-h-0 overflow-auto">
          <Structure table={t} db={db} />
        </TabsContent>
        <TabsContent value="query" className="min-h-0 overflow-auto">
          <Query key={t.name} db={db} size={size} start={`SELECT *\nFROM "${t.name}"\nLIMIT 100`} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// comparing two versions

const BADGE: Record<TableDiff['status'] | 'added' | 'removed' | 'changed', { status: 'passed' | 'failing' | 'warning' | 'idle'; label: string }> = {
  added: { status: 'passed', label: 'Added' },
  removed: { status: 'failing', label: 'Removed' },
  changed: { status: 'warning', label: 'Changed' },
  same: { status: 'idle', label: 'Same' },
}

const MATCHED = { key: 'Rows matched by their key.', rowid: 'Rows matched by their position (the table has no key).', row: 'Rows matched by their whole contents (the table has no key).' }

/** A trace record's tables of what its tools ran, beside the design. */
const BOOKKEEPING = new Set(['runs', 'artifacts', 'measurements'])

const RUN_STATUS = (s: string): 'passed' | 'failing' | 'warning' | 'idle' => (s === 'pass' ? 'passed' : s === 'fail' || s === 'error' ? 'failing' : s === 'running' ? 'warning' : 'idle')

/**
 * The tool runs a trace project record adds, by kind with the newest one's result, and the files they made, by name
 * with how many are the same file again (test-esp32 log #49): what a reviewer reads instead of one row per copy.
 */
export function RunsSummary({ runs, table }: { runs: RunsDigest; table: 'runs' | 'artifacts' }) {
  return (
    <div className="space-y-2 px-3 pt-2 text-xs">
      <p className="text-muted-foreground">These are trace's own record of what its tools ran, not the design: {table === 'runs' ? 'by tool, with the newest run of each' : 'by file, with how many copies are the same file again'}.</p>
      {table === 'runs' && runs.kinds.length > 0 && (
        <ul className="divide-y rounded-md border" aria-label="Tool runs by kind">
          {runs.kinds.map((k) => (
            <li key={k.kind} className="space-y-1 px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono font-medium">{k.kind}</span>
                <span className="text-muted-foreground">{count(k.runs, 'run')}{k.runs > 1 && Object.keys(k.statuses).length > 1 ? ` (${Object.entries(k.statuses).map(([st, c]) => `${c} ${resultWord(st)}`).join(', ')})` : ''}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground">{k.runs > 1 ? 'The newest:' : 'It:'}</span>
                <StatusBadge plain status={RUN_STATUS(k.last.status)} label={resultWord(k.last.status)} />
                {k.last.summary && <span className="min-w-0 break-words">{k.last.summary}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {table === 'artifacts' && runs.names.length > 0 && (
        <ul className="divide-y rounded-md border" aria-label="Files the runs made">
          {runs.names.map((f) => (
            <li key={f.name} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
              <span className="min-w-0 break-all font-mono font-medium">{f.name}</span>
              <span className="text-muted-foreground">{f.copies === 1 ? '1 copy' : f.different === 1 ? `${f.copies} copies, all the same` : `${f.copies} copies, ${f.different} different`}</span>
              {f.kind && <><span className="text-muted-foreground">· newest from</span><span className="font-mono">{f.kind}</span><StatusBadge plain status={RUN_STATUS(f.status)} label={resultWord(f.status)} /></>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TableChanges({ d, runs }: { d: TableDiff; runs?: RunsDigest | null }) {
  const n = d.counts.added + d.counts.removed + d.counts.changed
  const show = (v: SqlValue[] | undefined) => (v ?? []).map((x, i) => `${d.columns[i] ?? i}: ${x === null ? 'empty' : cellText(x)}`).join(' · ')
  // a trace record's runs and the files they made: said by kind and file, every row one click away
  const grouped = runs && (d.name === 'runs' || d.name === 'artifacts') && d.status !== 'same' ? d.name : null
  const rows = d.rows.length > 0 && (
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Change</th>
              <th className="px-3 py-2 font-medium">Row</th>
              <th className="px-3 py-2 font-medium">What changed</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r, i) => (
              <tr key={`${r.change}:${r.key}:${i}`} className={cn('border-b align-top', r.change === 'added' && 'bg-verified/5', r.change === 'removed' && 'bg-destructive/5')}>
                <td className="px-3 py-2"><StatusBadge status={BADGE[r.change].status} label={BADGE[r.change].label} /></td>
                <td className="max-w-[200px] truncate px-3 py-2 font-mono text-xs" title={r.key}>{d.matchedBy === 'row' ? '—' : r.key}</td>
                <td className="px-3 py-2 text-xs">
                  {r.change === 'changed'
                    ? r.fields.map((f) => (
                        <div key={f.column}>
                          <span className="font-mono">{f.column}</span>: <del className="text-muted-foreground">{f.before || 'empty'}</del> → <ins className="font-medium no-underline">{f.after || 'empty'}</ins>
                        </div>
                      ))
                    : <span className="break-all">{show(r.after ?? r.before)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
  )
  return (
    <div className="space-y-2">
      {grouped && runs && <RunsSummary runs={runs} table={grouped} />}
      <p className="px-3 pt-2 text-xs text-muted-foreground">
        {d.status === 'added' ? `A new table with ${count(d.counts.added, 'row')}.` : d.status === 'removed' ? `This change removes the table and its ${count(d.counts.removed, 'row')}.` : n ? `${d.counts.added} added, ${d.counts.removed} removed, ${d.counts.changed} changed; ${count(d.counts.same, 'row')} the same.` : `All ${count(d.counts.same, 'row')} are the same.`}{' '}
        {d.status === 'changed' && MATCHED[d.matchedBy]}
      </p>
      {d.schemaChanged && (
        <details className="px-3 text-xs" open>
          <summary className="cursor-pointer font-medium">The table's columns changed</summary>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <pre className="overflow-auto rounded-md bg-destructive/5 p-2 font-mono"><span className="text-muted-foreground">Before</span>{'\n'}{d.beforeSql}</pre>
            <pre className="overflow-auto rounded-md bg-verified/5 p-2 font-mono"><span className="text-muted-foreground">After</span>{'\n'}{d.afterSql}</pre>
          </div>
        </details>
      )}
      {grouped ? (
        rows && (
          <details className="px-3 text-xs">
            <summary className="cursor-pointer py-1 font-medium">Every row ({n.toLocaleString()})</summary>
            {rows}
          </details>
        )
      ) : rows}
      {d.truncated && <Note>Showing the first {d.rows.length.toLocaleString()} of {n.toLocaleString()} changed rows.</Note>}
    </div>
  )
}

/** Two versions of a database: a line saying what changed, the tables with their changes, and each table's rows. */
export function DatabaseCompare({ before, after, size }: { before: { file: FileRef; commit?: string } | null; after: { file: FileRef; commit?: string } | null; size: ViewerSize }) {
  const a = useDatabase(before?.file ?? null, before?.commit)
  const b = useDatabase(after?.file ?? null, after?.commit)
  const diff = useMemo(() => ((!before || a.db) && (!after || b.db) ? diffDb(a.db ?? null, b.db ?? null) : null), [a.db, b.db, before, after])
  const runs = useMemo(() => (diff ? runsDigest(a.db ?? null, b.db ?? null) : null), [diff, a.db, b.db])
  const [pick, setPick] = useState<string | null>(null)
  const err = a.error ?? b.error
  if (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return /not a SQLite/.test(msg) ? <Note>{msg}</Note> : <ViewerError error={err} what="both versions" />
  }
  if (!diff) return <ViewerLoading size={size} label="Opening both versions of the database" />
  const changed = diff.filter((d) => d.status !== 'same')
  // a trace record opens on a design table it changes, not on its tool runs' bookkeeping
  const design = runs ? changed.find((d) => !BOOKKEEPING.has(d.name)) : undefined
  const current = diff.find((d) => d.name === pick) ?? design ?? changed[0] ?? diff[0]
  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <Controls>
        <span className="font-medium">{describeDbDiff(diff)}</span>
        {diff.length > changed.length && <span className="text-muted-foreground">{count(diff.length - changed.length, 'table')} unchanged</span>}
        {runs && <span className="text-muted-foreground">{describeRuns(runs)}</span>}
      </Controls>
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[220px_1fr]">
        <ul className="max-h-[160px] overflow-auto border-b text-xs md:max-h-none md:border-r md:border-b-0" aria-label="Tables">
          {diff.map((d) => (
            <li key={d.name}>
              <button type="button" onClick={() => setPick(d.name)} aria-current={current?.name === d.name} className={cn('flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent', current?.name === d.name && 'bg-accent')}>
                <span className="min-w-0 flex-1 truncate font-mono">{d.name}</span>
                {d.status === 'same' ? <span className="text-muted-foreground">same</span> : <StatusBadge status={BADGE[d.status].status} label={d.status === 'changed' ? (d.counts.added + d.counts.removed + d.counts.changed ? count(d.counts.added + d.counts.removed + d.counts.changed, 'row') : 'Columns') : BADGE[d.status].label} />}
              </button>
            </li>
          ))}
        </ul>
        <div className="min-h-0 overflow-auto">{current ? <TableChanges key={current.name} d={current} runs={runs} /> : <Note>Neither version has any tables.</Note>}</div>
      </div>
    </div>
  )
}

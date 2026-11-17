/**
 * Comparing two versions of a file (docs/ui-design.md, "Comparing versions"): text and code line by line; parts lists
 * row by row (added, removed, changed part, quantity or price); pictures and drawings in two locked panes with a
 * slider and a difference overlay; schematics and boards side by side.
 */
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { StatusBadge } from '@/components/status-badge'
import { cn } from '@/lib/utils'
import { type FileRef, resolveUrl, useFileText } from './data'
import { parseDelimited, partsColumns } from './csv'
import { compareMode, viewerKind } from './kinds'
import { describeDiff, diffParts } from './parts-diff'
import { brief, diffJson, isJsonFile, parseJson, type KeyChange } from './json-diff'
import { diffNets, parseNetlist } from './netlist'
import { JsonTree } from './viewers/json-tree'
import { svgDataUrl } from './sanitize'
import { AREA, Controls, Note, ViewerError, ViewerLoading, type ViewerSize } from './viewers/common'
import { PictureCompare } from './viewers/image'
import { KiCadCompare } from './viewers/kicad'
import { lazy, Suspense, useState } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ViewerFor } from './viewers'

const DatabaseCompare = lazy(() => import('./viewers/database').then((m) => ({ default: m.DatabaseCompare })))
import { TextDiff } from './text-diff'

const short = (c: string) => c.slice(0, 7)

function PartsCompare({ before, after, size }: { before: string; after: string; size: ViewerSize }) {
  const result = useMemo(() => {
    try {
      return diffParts(parseDelimited(before), parseDelimited(after))
    } catch {
      return null
    }
  }, [before, after])
  if (!result) return <TextDiff before={before} after={after} size={size} />
  const changed = result.rows.filter((r) => r.change !== 'same')
  const ref = partsColumns(result.header)!
  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <Controls>
        <span className="font-medium">{describeDiff(result.counts)}</span>
        <span className="text-muted-foreground">{result.counts.same} lines unchanged</span>
      </Controls>
      <div className="min-h-0 flex-1 overflow-auto">
        {changed.length === 0 ? (
          <Note>The two parts lists have the same lines.</Note>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background">
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Change</th>
                <th className="px-3 py-2 font-medium">References</th>
                <th className="px-3 py-2 font-medium">Part</th>
                <th className="px-3 py-2 font-medium">What changed</th>
              </tr>
            </thead>
            <tbody>
              {changed.map((r) => {
                const row = r.after ?? r.before ?? []
                return (
                  <tr key={r.key} className={cn('border-b align-top', r.change === 'added' && 'bg-verified/5', r.change === 'removed' && 'bg-destructive/5')}>
                    <td className="px-3 py-2">
                      <StatusBadge status={r.change === 'added' ? 'passed' : r.change === 'removed' ? 'failing' : 'warning'} label={r.change === 'added' ? 'Added' : r.change === 'removed' ? 'Removed' : 'Changed'} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{r.key.replace(/,/g, ', ')}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row[ref.part >= 0 ? ref.part : ref.value]}</td>
                    <td className="px-3 py-2 text-xs">
                      {r.fields.map((f) => (
                        <div key={f.field}>
                          {f.field}: <del className="text-muted-foreground">{f.before || 'none'}</del> → <ins className="no-underline font-medium">{f.after || 'none'}</ins>
                        </div>
                      ))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function TextBased({ file, before, after, size, table }: { file: FileRef; before: string; after: string; size: ViewerSize; table: boolean }) {
  const a = useFileText(file, { commit: before })
  const b = useFileText(file, { commit: after === 'current' ? undefined : after })
  if (a.isError || b.isError) return <ViewerError error={a.error ?? b.error} what="both versions" />
  if (a.data === undefined || b.data === undefined) return <ViewerLoading size={size} label="Opening both versions" />
  if (table) return <PartsCompare before={a.data} after={b.data} size={size} />
  return isJsonFile(file.path) ? <JsonCompare file={file} before={a.data} after={b.data} size={size} /> : <TextDiff before={a.data} after={b.data} size={size} />
}

/** Structured data: the keys that changed (and the tree with them marked), or the line diff. A file that is not JSON is the line diff. */
function JsonCompare({ file, before, after, size }: { file: FileRef; before: string; after: string; size: ViewerSize }) {
  const [view, setView] = useState<'keys' | 'tree' | 'lines'>('keys')
  const parsed = useMemo(() => {
    const a = parseJson(before)
    const b = parseJson(after)
    return a === undefined || b === undefined ? null : { b, diff: diffJson(a, b) }
  }, [before, after])
  if (!parsed) return <TextDiff before={before} after={after} size={size} />
  const marks = new Map<string, KeyChange>(parsed.diff.map((d) => [d.path, d.change]))
  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <Controls>
        <ToggleGroup type="single" size="sm" variant="outline" value={view} onValueChange={(v) => v && setView(v as typeof view)} aria-label="How to show the changes">
          <ToggleGroupItem value="keys" className="h-7 px-3 text-xs">Changed keys</ToggleGroupItem>
          <ToggleGroupItem value="tree" className="h-7 px-3 text-xs">Tree</ToggleGroupItem>
          <ToggleGroupItem value="lines" className="h-7 px-3 text-xs">Lines</ToggleGroupItem>
        </ToggleGroup>
        <span className="ml-auto text-muted-foreground">{parsed.diff.length === 0 ? `${file.path.split('/').pop()}: same keys and values` : `${parsed.diff.length} key${parsed.diff.length === 1 ? '' : 's'} changed`}</span>
      </Controls>
      {view === 'tree' && <JsonTree value={parsed.b} marks={marks} />}
      {view === 'lines' && <TextDiff before={before} after={after} size={size} />}
      {view === 'keys' && (
        <div className="min-h-0 flex-1 overflow-auto">
          {parsed.diff.length === 0 ? (
            <Note>The two versions have the same keys and values.</Note>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background"><tr className="border-b text-left text-xs text-muted-foreground"><th className="px-3 py-2 font-medium">Change</th><th className="px-3 py-2 font-medium">Key</th><th className="px-3 py-2 font-medium">Before → after</th></tr></thead>
              <tbody>
                {parsed.diff.map((d) => (
                  <tr key={d.path} className={cn('border-b align-top', d.change === 'added' && 'bg-verified/5', d.change === 'removed' && 'bg-destructive/5')}>
                    <td className="px-3 py-2"><StatusBadge status={d.change === 'added' ? 'passed' : d.change === 'removed' ? 'failing' : 'warning'} label={d.change === 'added' ? 'Added' : d.change === 'removed' ? 'Removed' : 'Changed'} /></td>
                    <td className="px-3 py-2 font-mono text-xs">{d.path}</td>
                    <td className="px-3 py-2 font-mono text-xs"><del className="text-muted-foreground">{d.change === 'added' ? 'none' : brief(d.before)}</del> → <ins className="no-underline font-medium">{d.change === 'removed' ? 'none' : brief(d.after)}</ins></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

/** A net list: the nets added, removed or rewired, or the line diff when a side is not a net list. */
function NetlistCompare({ file, before, after, size }: { file: FileRef; before: string; after: string; size: ViewerSize }) {
  const a = useFileText(file, { commit: before })
  const b = useFileText(file, { commit: after === 'current' ? undefined : after })
  if (a.isError || b.isError) return <ViewerError error={a.error ?? b.error} what="both versions" />
  if (a.data === undefined || b.data === undefined) return <ViewerLoading size={size} label="Opening both versions" />
  const x = parseNetlist(a.data)
  const y = parseNetlist(b.data)
  if (!x || !y) return <TextDiff before={a.data} after={b.data} size={size} />
  const diff = diffNets(x, y)
  const word = { added: 'Added', removed: 'Removed', changed: 'Rewired' } as const
  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <Controls><span className="font-medium">{diff.length === 0 ? 'The two net lists connect the same pins' : `${diff.length} net${diff.length === 1 ? '' : 's'} changed`}</span></Controls>
      <div className="min-h-0 flex-1 overflow-auto">
        {diff.length === 0 ? <Note>Nothing is connected differently.</Note> : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background"><tr className="border-b text-left text-xs text-muted-foreground"><th className="px-3 py-2 font-medium">Change</th><th className="px-3 py-2 font-medium">Net</th><th className="px-3 py-2 font-medium">Pins</th></tr></thead>
            <tbody>
              {diff.map((d) => (
                <tr key={d.name} className={cn('border-b align-top', d.change === 'added' && 'bg-verified/5', d.change === 'removed' && 'bg-destructive/5')}>
                  <td className="px-3 py-2"><StatusBadge status={d.change === 'added' ? 'passed' : d.change === 'removed' ? 'failing' : 'warning'} label={word[d.change]} /></td>
                  <td className="px-3 py-2 font-mono text-xs">{d.name}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {d.joined.length > 0 && <div>Joined: <ins className="no-underline font-medium">{d.joined.join(', ')}</ins></div>}
                    {d.left.length > 0 && <div>Left: <del className="text-muted-foreground">{d.left.join(', ')}</del></div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Pictures({ file, before, after, size }: { file: FileRef; before: string; after: string; size: ViewerSize }) {
  const svg = viewerKind(file.path) === 'svg'
  const q = useQuery({
    queryKey: ['file.compare', file.repo, file.path, before, after],
    queryFn: async () => {
      const get = async (c?: string) => {
        if (!svg) return (await resolveUrl(file, c)).url
        const { url } = await resolveUrl(file, c)
        return svgDataUrl(await (await fetch(url)).text())
      }
      return Promise.all([get(before), get(after === 'current' ? undefined : after)])
    },
    staleTime: 4 * 60_000,
  })
  if (q.isError) return <ViewerError error={q.error} what="both versions" />
  if (!q.data) return <ViewerLoading size={size} label="Opening both versions" />
  return <PictureCompare before={q.data[0]} after={q.data[1]} beforeLabel={short(before)} afterLabel={after === 'current' ? 'current' : short(after)} size={size} />
}

function KiCad({ file, before, after, size }: { file: FileRef; before: string; after: string; size: ViewerSize }) {
  const a = useFileText(file, { commit: before })
  const b = useFileText(file, { commit: after === 'current' ? undefined : after })
  if (a.isError || b.isError) return <ViewerError error={a.error ?? b.error} what="both versions" />
  if (a.data === undefined || b.data === undefined) return <ViewerLoading size={size} label="Opening both versions" />
  return <KiCadCompare file={file} before={a.data} after={b.data} beforeLabel={short(before)} afterLabel={after === 'current' ? 'current' : short(after)} size={size} />
}

/**
 * Two versions of a file that has no difference view of its own (fabrication layers, a 3D model, a PDF, a video, a plot,
 * firmware, an archive, anything else): each drawn by the file's own viewer, with Before, After and Side by side.
 */
export function SidesCompare({ file, before, after, size }: { file: FileRef; before: string; after: string; size: ViewerSize }) {
  const [side, setSide] = useState<'before' | 'after' | 'both'>('after')
  const afterCommit = after === 'current' ? undefined : after
  const pane = (label: string, commit: string | undefined) => (
    <div key={label} className="flex min-h-[300px] min-w-0 flex-col bg-background">
      <span className="border-b px-3 py-1 text-[11px] font-medium text-muted-foreground">{label}</span>
      <div className="relative h-[min(60vh,520px)] min-h-0 overflow-auto"><ViewerFor file={file} size={size} commit={commit} /></div>
    </div>
  )
  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <Controls>
        <ToggleGroup type="single" size="sm" variant="outline" value={side} onValueChange={(v) => v && setSide(v as typeof side)} aria-label="Which version">
          <ToggleGroupItem value="before" className="h-7 px-3 text-xs">Before</ToggleGroupItem>
          <ToggleGroupItem value="after" className="h-7 px-3 text-xs">After</ToggleGroupItem>
          <ToggleGroupItem value="both" className="h-7 px-3 text-xs">Side by side</ToggleGroupItem>
        </ToggleGroup>
      </Controls>
      <div className={cn('min-h-0 flex-1 overflow-auto', side === 'both' && 'grid grid-cols-1 gap-px bg-border md:grid-cols-2')}>
        {side === 'before' && pane('Before', before)}
        {side === 'after' && pane('After', afterCommit)}
        {side === 'both' && [pane('Before', before), pane('After', afterCommit)]}
      </div>
    </div>
  )
}

/** Compare `before` (a commit) with `after` (a commit, or 'current'). */
export function CompareView({ file, before, after, size }: { file: FileRef; before: string; after: string; size: ViewerSize }) {
  const mode = compareMode(viewerKind(file.path))
  if (mode === 'text') return <TextBased file={file} before={before} after={after} size={size} table={false} />
  if (mode === 'table') return <TextBased file={file} before={before} after={after} size={size} table />
  if (mode === 'netlist') return <NetlistCompare file={file} before={before} after={after} size={size} />
  if (mode === 'image') return <Pictures file={file} before={before} after={after} size={size} />
  if (mode === 'kicad') return <KiCad file={file} before={before} after={after} size={size} />
  if (mode === 'database')
    return (
      <Suspense fallback={<ViewerLoading size={size} label="Opening both versions of the database" />}>
        <DatabaseCompare before={{ file, commit: before }} after={{ file, commit: after === 'current' ? undefined : after }} size={size} />
      </Suspense>
    )
  return <SidesCompare file={file} before={before} after={after} size={size} />
}

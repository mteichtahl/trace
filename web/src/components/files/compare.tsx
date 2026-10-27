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
import { svgDataUrl } from './sanitize'
import { AREA, Controls, Note, ViewerError, ViewerLoading, type ViewerSize } from './viewers/common'
import { PictureCompare } from './viewers/image'
import { KiCadCompare } from './viewers/kicad'
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
  return table ? <PartsCompare before={a.data} after={b.data} size={size} /> : <TextDiff before={a.data} after={b.data} size={size} />
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

/** Compare `before` (a commit) with `after` (a commit, or 'current'). */
export function CompareView({ file, before, after, size }: { file: FileRef; before: string; after: string; size: ViewerSize }) {
  const mode = compareMode(viewerKind(file.path))
  if (mode === 'text') return <TextBased file={file} before={before} after={after} size={size} table={false} />
  if (mode === 'table') return <TextBased file={file} before={before} after={after} size={size} table />
  if (mode === 'image') return <Pictures file={file} before={before} after={after} size={size} />
  if (mode === 'kicad') return <KiCad file={file} before={before} after={after} size={size} />
  return <Note>Versions of this kind of file cannot be compared here. Download each to compare them.</Note>
}

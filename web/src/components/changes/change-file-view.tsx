/**
 * One file of a change, its before and after (change.diff gives the two sides as commits; the bytes come through the
 * File viewer's own reading, files.url at that commit). Schematics and boards open in the KiCanvas viewer with a
 * Before / After switch (or both side by side); parts lists compare row by row; text files show the diff; pictures
 * sit side by side. A file added or removed shows its one side.
 */
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { CompareView } from '@/components/files/compare'
import { resolveUrl, useFileText } from '@/components/files/data'
import { baseName, extOf } from '@/components/files/kinds'
import { svgDataUrl } from '@/components/files/sanitize'
import { PictureCompare } from '@/components/files/viewers/image'
import { OverlayView, overlayAvailable } from './overlay'
import { Note, ViewerError, ViewerLoading } from '@/components/files/viewers/common'
import { ViewerFor } from '@/components/files/viewers'
import { KiCanvasView } from '@/components/files/viewers/kicad'
import { q } from '@/lib/queries'
import type { ChangeFile } from '@/lib/types'
import { cn } from '@/lib/utils'

type Side = 'before' | 'after' | 'both' | 'overlay'

function KiCadSides({ repo, file, before, after }: { repo: string; file: ChangeFile; before: { ref: string; path?: string } | null; after: { ref: string } | null }) {
  const [side, setSide] = useState<Side>(after ? 'after' : 'before')
  const overlay = overlayAvailable(before, after)
  const board = file.kind === 'board'
  const a = useFileText(before ? { repo, path: before.path ?? file.path } : null, { commit: before?.ref })
  const b = useFileText(after ? { repo, path: file.path } : null, { commit: after?.ref })
  const err = a.error ?? b.error
  if (err) return <ViewerError error={err} what="both versions" />
  if ((before && a.data === undefined) || (after && b.data === undefined)) return <ViewerLoading size="sheet" label="Opening both versions" />
  const pane = (t: string, label: string) => <KiCanvasView key={label} text={t} name={`${label}-${baseName(file.path)}`} findings={[]} size="sheet" board={board} fill />
  return (
    <div className="flex h-full min-h-[360px] flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <span className="font-medium">{baseName(file.path)}</span>
        <ToggleGroup type="single" size="sm" variant="outline" value={side} onValueChange={(v) => v && setSide(v as Side)} className="ml-auto" aria-label="Which version">
          <ToggleGroupItem value="before" disabled={!before} className="h-7 px-3 text-xs">Before</ToggleGroupItem>
          <ToggleGroupItem value="after" disabled={!after} className="h-7 px-3 text-xs">After</ToggleGroupItem>
          <ToggleGroupItem value="both" disabled={!before || !after} className="h-7 px-3 text-xs">Side by side</ToggleGroupItem>
          <ToggleGroupItem value="overlay" disabled={!overlay.ok} title={overlay.ok ? 'Before and after on one sheet' : overlay.why} className="h-7 px-3 text-xs">Overlay</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {!overlay.ok && <p className="border-b px-3 py-1 text-xs text-muted-foreground">{overlay.why}</p>}
      <div className={cn('relative min-h-0 flex-1', side === 'both' && 'grid grid-cols-1 gap-px bg-border md:grid-cols-2')}>
        {side === 'overlay' && a.data !== undefined && b.data !== undefined ? (
          <div className="absolute inset-0"><OverlayView before={a.data} after={b.data} name={baseName(file.path)} board={board} /></div>
        ) : side === 'both' ? (
          <>
            {[['Before', a.data!], ['After', b.data!]].map(([l, t]) => (
              <div key={l} className="relative min-h-[300px] bg-background">
                <span className="absolute left-2 top-2 z-10 rounded bg-background/90 px-1.5 py-0.5 text-[11px] font-medium">{l}</span>
                {pane(t!, l!)}
              </div>
            ))}
          </>
        ) : (
          <div className="absolute inset-0">{side === 'before' ? pane(a.data!, 'Before') : pane(b.data!, 'After')}</div>
        )}
      </div>
    </div>
  )
}

/** Two pictures side by side (a drawing's SVG made safe first), with the slider and difference a tap away. */
function Pictures({ repo, file, before, after }: { repo: string; file: ChangeFile; before: { ref: string; path?: string }; after: { ref: string } }) {
  const svg = extOf(file.path) === 'svg'
  const p = useQuery({
    queryKey: ['change.pictures', repo, file.path, before.ref, after.ref],
    queryFn: async () => {
      const get = async (path: string, commit: string) => {
        const { url } = await resolveUrl({ repo, path }, commit)
        return svg ? svgDataUrl(await (await fetch(url)).text()) : url
      }
      return Promise.all([get(before.path ?? file.path, before.ref), get(file.path, after.ref)])
    },
    staleTime: 4 * 60_000,
  })
  if (p.isError) return <ViewerError error={p.error} what="both versions" />
  if (!p.data) return <ViewerLoading size="sheet" label="Opening both versions" />
  return <div className="h-full min-h-[320px]"><PictureCompare before={p.data[0]} after={p.data[1]} beforeLabel="Before" afterLabel="After" size="sheet" initial="side" /></div>
}

export function ChangeFileView({ repo, number, file }: { repo: string; number: number; file: ChangeFile }) {
  const d = useQuery({ ...q('change.diff', { repo, number, path: file.path }), staleTime: 60_000 })
  if (d.isError) return <ViewerError error={d.error} onRetry={() => void d.refetch()} what="this file's change" />
  if (!d.data) return <ViewerLoading size="sheet" label="Opening the change to this file" />
  const { before, after, binary } = d.data
  if (file.kind === 'schematic' || file.kind === 'board') return <KiCadSides repo={repo} file={file} before={before} after={after} />
  if (binary || file.kind === 'binary') return <Note>This file is not text or a picture, so it cannot be shown here. Use View on GitHub to download either version.</Note>
  const ref = { repo, path: file.path }
  // one side only: added or removed
  if (!before || !after) {
    const commit = (after ?? before)!.ref
    return (
      <div className="flex h-full min-h-[320px] flex-col">
        <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">{after ? 'A new file in this change.' : 'This change removes the file. Its last version:'}</p>
        <div className="min-h-0 flex-1"><ViewerFor file={before?.path ? { repo, path: before.path } : ref} size="sheet" commit={commit} /></div>
      </div>
    )
  }
  if (file.kind === 'image') return <Pictures repo={repo} file={file} before={before} after={after} />
  return (
    <div className="h-full min-h-[320px]">
      <CompareView file={before.path ? { repo, path: file.path } : ref} before={before.ref} after={after.ref} size="sheet" />
    </div>
  )
}

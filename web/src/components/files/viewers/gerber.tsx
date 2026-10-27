/**
 * Fabrication files with tracespace: a single Gerber or drill file drawn alone, or the fab zip (JLCPCB's and the
 * like) unpacked in the browser and drawn as the finished board, top and bottom, with each layer on its own and the
 * zip's contents listed. The card shows the composite top side.
 */
import { useEffect, useMemo, useState } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { eng } from '@/lib/format'
import { cn } from '@/lib/utils'
import { type FileRef, useFileBytes } from '../data'
import { type Entry, unpack } from '../archive'
import { baseName, viewerKind } from '../kinds'
import { sanitizeSvg } from '../sanitize'
import { AREA, Controls, Note, PanZoom, ViewerError, ViewerLoading, type ViewerProps } from './common'

interface Rendered {
  top: string
  bottom: string
  layers: { id: string; filename: string; type: string | null; side: string | null; svg: string }[]
}

async function render(entries: Entry[]): Promise<Rendered> {
  const ts = await import('@tracespace/core')
  // Gerber and drill files by name, and .txt files only when they read as Excellon drill files (M48 header) or Gerber
  const looks = (e: Entry) => {
    if (viewerKind(e.path) === 'gerber') return true
    if (!/\.txt$/i.test(e.path)) return false
    const head = new TextDecoder().decode(e.bytes.subarray(0, 200))
    return /^\s*M48/m.test(head) || /%FS[LT][AI]X\d\dY\d\d\*%/.test(head)
  }
  const files = entries.filter(looks).map((e) => new File([e.bytes as Uint8Array<ArrayBuffer>], baseName(e.path)))
  if (!files.length) throw new Error('No Gerber or drill files were found.')
  const read = await ts.read(files)
  const plot = ts.plot(read)
  const layers = ts.renderLayers(plot)
  const board = ts.renderBoard(layers)
  return {
    top: ts.stringifySvg(board.top),
    bottom: ts.stringifySvg(board.bottom),
    layers: read.layers.map((l) => ({ id: l.id, filename: l.filename, type: l.type, side: l.side, svg: ts.stringifySvg(layers.rendersById[l.id]!) })),
  }
}

const words = (type: string | null, side: string | null) => [side === 'top' ? 'Top' : side === 'bottom' ? 'Bottom' : side === 'inner' ? 'Inner' : '', type ?? 'unknown layer'].filter(Boolean).join(' ')

export default function GerberViewer({ file, size, commit, onOpenEntry }: ViewerProps & { onOpenEntry?: (f: FileRef) => void }) {
  const q = useFileBytes(file, { commit })
  const [out, setOut] = useState<Rendered | null>(null)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [view, setView] = useState('top')
  const zip = viewerKind(file.path) === 'gerber-zip'

  useEffect(() => {
    if (!q.data) return
    let live = true
    void (async () => {
      try {
        const es = zip ? await unpack(q.data, 'zip') : [{ path: file.path, size: q.data.byteLength, bytes: new Uint8Array(q.data) }]
        if (live) setEntries(es)
        const r = await render(es)
        if (live) setOut(r)
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      live = false
    }
  }, [q.data, zip, file.path])

  const svg = useMemo(() => {
    if (!out) return ''
    const raw = view === 'top' ? out.top : view === 'bottom' ? out.bottom : (out.layers.find((l) => l.id === view)?.svg ?? '')
    return sanitizeSvg(raw)
  }, [out, view])

  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (err) return <Note>These fabrication files could not be drawn: {err} Download them to check in a Gerber viewer.</Note>
  if (!out) return <ViewerLoading size={size} label="Drawing the board from its Gerbers" />
  // tracespace's own SVG of the copper, mask and silkscreen, sanitised
  const drawing = <div className="h-full w-full [&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
  if (size === 'card') return <div className="h-[220px] bg-[#1a2a1a] p-2">{drawing}</div>
  const single = out.layers.length === 1
  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <Controls>
        {!single && (
          <ToggleGroup type="single" size="sm" variant="outline" value={['top', 'bottom'].includes(view) ? view : ''} onValueChange={(v) => v && setView(v)}>
            <ToggleGroupItem value="top" className="h-7 text-xs">Top</ToggleGroupItem>
            <ToggleGroupItem value="bottom" className="h-7 text-xs">Bottom</ToggleGroupItem>
          </ToggleGroup>
        )}
        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Layer alone</span>
          <select value={['top', 'bottom'].includes(view) ? '' : view} onChange={(e) => setView(e.target.value || 'top')} className="h-7 rounded-md border bg-background px-1 text-xs">
            <option value="">{single ? out.layers[0]!.filename : 'Stacked board'}</option>
            {out.layers.map((l) => (
              <option key={l.id} value={l.id}>
                {words(l.type, l.side)} · {l.filename}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto text-muted-foreground">{out.layers.length} layers</span>
      </Controls>
      <div className="flex min-h-0 flex-1">
        <PanZoom className="min-h-0 flex-1 bg-[#1a2a1a]" label={`Board drawn from ${file.path}`}>
          {drawing}
        </PanZoom>
        {zip && entries && (
          <aside className="hidden w-64 shrink-0 overflow-auto border-l p-3 text-xs md:block" aria-label="Inside the zip">
            <p className="section-label mb-2">Inside the zip ({entries.length})</p>
            <ul className="space-y-1">
              {entries.map((e) => (
                <li key={e.path} className="flex items-center gap-2">
                  <button type="button" className="min-w-0 flex-1 truncate text-left font-mono hover:underline" onClick={() => onOpenEntry?.({ ...file, path: `${file.path}/${e.path}`, url: URL.createObjectURL(new Blob([e.bytes as Uint8Array<ArrayBuffer>])), size: e.size, run: undefined, versions: undefined })}>
                    {e.path}
                  </button>
                  <span className="text-muted-foreground">{eng(e.size, 'B')}</span>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </div>
  )
}

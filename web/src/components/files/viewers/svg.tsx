/** Drawings (.svg): sanitised, then pan and zoom; the text stays selectable (drag with Alt held to select instead). */
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { useFileText } from '../data'
import { sanitizeSvg } from '../sanitize'
import { AREA, Controls, PanZoom, ViewerError, ViewerLoading, type ViewerProps } from './common'

export default function SvgViewer({ file, size, commit }: ViewerProps) {
  const q = useFileText(file, { commit })
  const clean = useMemo(() => (q.data ? sanitizeSvg(q.data) : ''), [q.data])
  const [select, setSelect] = useState(false)
  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (q.data === undefined) return <ViewerLoading size={size} />
  // the sanitised drawing (DOMPurify: no scripts, handlers, foreign objects or outside links)
  const drawing = <div className="max-h-full max-w-full [&_svg]:h-auto [&_svg]:max-h-full [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: clean }} />
  if (size === 'card') return <div className="flex h-[220px] items-center justify-center bg-white p-2">{drawing}</div>
  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <Controls>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={select} onChange={(e) => setSelect(e.target.checked)} /> Select text (stops panning)
        </label>
        <span className="ml-auto text-muted-foreground">Scripts and links in the drawing are removed</span>
      </Controls>
      {select ? (
        <div className="min-h-0 flex-1 overflow-auto bg-white p-4 select-text">{drawing}</div>
      ) : (
        <PanZoom className="min-h-0 flex-1 bg-white" label={`Drawing ${file.path}`}>
          {drawing}
        </PanZoom>
      )}
    </div>
  )
}

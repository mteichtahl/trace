/**
 * Simulation results (`.sim.json` / `.plot.json`, the plot shape trace's tools return: series, axes, a limit): the
 * chat's own Recharts plot with its limit line and verdict. WaveDrom timing diagrams (lazy: the wavedrom package
 * loads with the first diagram), drawn as SVG and sanitised like any drawing.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { StatusBadge } from '@/components/status-badge'
import type { PlotData } from '@/components/chat/cards'
import { cn } from '@/lib/utils'
import { useFileText } from '../data'
import { sanitizeSvg } from '../sanitize'
import { AREA, Note, PanZoom, ViewerError, ViewerLoading, type ViewerProps } from './common'

const PlotImpl = lazy(() => import('@/components/chat/plot-impl'))

export function PlotViewer({ file, size, commit }: ViewerProps) {
  const q = useFileText(file, { commit })
  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (q.data === undefined) return <ViewerLoading size={size} />
  let data: PlotData
  try {
    data = JSON.parse(q.data) as PlotData
    if (!Array.isArray(data.series)) throw new Error('no series')
  } catch {
    return <Note>This file does not hold a plot trace can draw (it needs series, x and y).</Note>
  }
  return (
    <div className={cn('p-3', size !== 'card' && AREA[size])}>
      <div className="mb-2 flex items-center gap-2">
        <p className="text-sm font-medium">{data.title}</p>
        {data.ok !== undefined && <StatusBadge status={data.ok ? 'passed' : 'failing'} />}
      </div>
      <Suspense fallback={<div className="h-52 animate-pulse rounded bg-muted" />}>
        <div className={cn(size !== 'card' && '[&>div]:!h-[min(60vh,520px)]')}>
          <PlotImpl data={data} />
        </div>
      </Suspense>
      {data.verdict && <p className="mt-2 text-sm text-muted-foreground">{data.verdict}</p>}
    </div>
  )
}

export function WaveDromViewer({ file, size, commit }: ViewerProps) {
  const q = useFileText(file, { commit })
  const [svg, setSvg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (q.data === undefined) return
    let live = true
    void (async () => {
      try {
        const [{ default: wd }, { default: json5 }] = await Promise.all([import('wavedrom'), import('json5')])
        const src = json5.parse(q.data!) as object
        const tree = wd.renderAny(0, src, wd.waveSkin)
        if (live) setSvg(sanitizeSvg(wd.onml.stringify(tree), { keepStyle: true }))
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      live = false
    }
  }, [q.data])
  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (err) return <Note>This timing diagram could not be drawn: {err}</Note>
  if (!svg) return <ViewerLoading size={size} />
  // drawn as an image so the skin's own stylesheet stays inside the diagram (never leaking onto the page)
  const drawing = <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={`Timing diagram ${file.path}`} className="h-auto max-w-full" draggable={false} />
  if (size === 'card') return <div className="overflow-x-auto bg-white p-3">{drawing}</div>
  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <PanZoom className="min-h-0 flex-1 bg-white" label={`Timing diagram ${file.path}`}>
        {drawing}
      </PanZoom>
      <Note>Measured against the spec side by side needs the spec's timing as data; open the datasheet beside it meanwhile.</Note>
    </div>
  )
}

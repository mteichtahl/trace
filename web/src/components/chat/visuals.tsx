/**
 * The pictures a reply can hold besides Mermaid and timing diagrams: plots (```plot / ```chart), SVG drawings
 * (```svg) and images (markdown ![alt](src)). Each sits in the diagram frame with Full screen and Download; an image
 * opens full screen with pan and zoom when tapped.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { sanitizeSvg } from '@/components/files/sanitize'
import { PanZoom } from '@/components/files/viewers/common'
import { StatusBadge } from '@/components/status-badge'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { type ChatPlot, parsePlot, plotCsv } from './chat-plot'
import { DiagramFrame, DrawingFailed, DrawingPlaceholder, slug } from './diagram-frame'

const ChatPlotImpl = lazy(() => import('./chat-plot-impl'))

export function PlotBlock({ source, streaming }: { source: string; streaming?: boolean }) {
  const [plot, setPlot] = useState<ChatPlot | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    if (streaming) return
    let live = true
    setFailed(null)
    parsePlot(source)
      .then((p) => live && setPlot(p))
      .catch((e: unknown) => live && setFailed(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [source, streaming])
  if (failed) return <DrawingFailed kind="Plot" reason={failed} source={source} lang="json" />
  if (!plot) {
    return (
      <DiagramFrame kind="Plot" source={source} sourceLang="json">
        <DrawingPlaceholder label="Drawing the plot" />
      </DiagramFrame>
    )
  }
  const chart = (tall: boolean) => (
    <Suspense fallback={<DrawingPlaceholder label="Drawing the plot" />}>
      <ChatPlotImpl plot={plot} tall={tall} />
    </Suspense>
  )
  return (
    <DiagramFrame
      kind="Plot"
      title={plot.title}
      pan={false}
      full={<div className="h-full">{chart(true)}</div>}
      source={source}
      sourceLang="json"
      download={{ name: slug(plot.title ?? 'plot'), csv: plotCsv(plot) }}
    >
      {plot.ok !== undefined && (
        <div className="mb-2 flex justify-end">
          <StatusBadge status={plot.ok ? 'passed' : 'failing'} />
        </div>
      )}
      {chart(false)}
      {plot.verdict && <p className="mt-2 text-sm text-muted-foreground">{plot.verdict}</p>}
    </DiagramFrame>
  )
}

/** The <title> of an SVG, if it has one. */
const svgTitle = (svg: string): string | undefined => /<title[^>]*>([^<]{1,120})<\/title>/i.exec(svg)?.[1]?.trim()

export function SvgBlock({ source, streaming }: { source: string; streaming?: boolean }) {
  const clean = useMemo(() => (streaming ? '' : sanitizeSvg(source)), [source, streaming])
  if (streaming) {
    return (
      <DiagramFrame kind="Drawing" paper source={source} sourceLang="xml">
        <DrawingPlaceholder label="Drawing" />
      </DiagramFrame>
    )
  }
  if (!/<svg[\s>]/i.test(clean)) return <DrawingFailed kind="Drawing" reason="it is not an SVG drawing" source={source} lang="xml" />
  const title = svgTitle(source)
  // the sanitised drawing (DOMPurify: no scripts, handlers, foreign objects, styles or outside links)
  const drawing = (big: boolean) => (
    <div
      className={big ? '[&_svg]:h-auto [&_svg]:w-[min(90vw,1200px)]' : 'flex justify-center [&_svg]:h-auto [&_svg]:max-h-[420px] [&_svg]:max-w-full'}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  )
  return (
    <DiagramFrame kind="Drawing" title={title} paper full={drawing(true)} source={source} sourceLang="xml" download={{ name: slug(title ?? 'drawing'), svg: clean }}>
      {drawing(false)}
    </DiagramFrame>
  )
}

/**
 * An image in a message: shown at a readable size, and full screen with pan and zoom when tapped. Rendered as spans,
 * since markdown puts images inside paragraphs.
 */
export function ChatImage({ src, alt }: { src?: string; alt?: string }) {
  const [open, setOpen] = useState(false)
  const [broken, setBroken] = useState(false)
  if (!src) return null
  if (broken) return <span className="my-2 inline-block rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground">Image could not be loaded{alt ? `: ${alt}` : ''}</span>
  return (
    <>
      <span className="my-2 inline-flex flex-col items-start gap-1">
        <button type="button" className="cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Open image${alt ? ` "${alt}"` : ''} full screen`} onClick={() => setOpen(true)}>
          <img src={src} alt={alt ?? ''} loading="lazy" onError={() => setBroken(true)} className="max-h-96 max-w-full rounded-md border" />
        </button>
        {alt && <span className="text-xs text-muted-foreground">{alt}</span>}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[92dvh] w-[96vw] max-w-[96vw] flex-col gap-2 p-3 sm:max-w-[96vw]">
          <DialogTitle className="pr-8 text-base">{alt || 'Image'}</DialogTitle>
          <DialogDescription className="sr-only">Drag to move, scroll or use the buttons to zoom, double-click to fit.</DialogDescription>
          <PanZoom className="min-h-0 flex-1 rounded-md border" label={alt || 'Image'}>
            <img src={src} alt={alt ?? ''} draggable={false} className="max-h-full max-w-full" />
          </PanZoom>
          <div className="flex justify-end">
            <a href={src} download target="_blank" rel="noopener noreferrer" className="text-xs text-primary underline underline-offset-2">
              Download
            </a>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

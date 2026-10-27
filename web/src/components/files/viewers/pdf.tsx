/**
 * PDFs (datasheets, lab reports, specs) with PDF.js: the first page draws as soon as it arrives (the document streams
 * by range requests), the rest as they scroll into view. Search across pages, the document's outline, jump to a page,
 * and a cited page opened with the cited region highlighted. Text is selectable (PDF.js's text layer). Scripts in a
 * PDF are never run (PDF.js's scripting is off).
 */
import 'pdfjs-dist/web/pdf_viewer.css'
import { ChevronLeft, ChevronRight, ListTree, Minus, Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/toggle'
import { cn } from '@/lib/utils'
import { useFileUrl } from '../data'
import { AREA, Controls, FindBox, ViewerError, ViewerLoading, type ViewerProps } from './common'

type PdfJs = typeof import('pdfjs-dist')
type Doc = Awaited<ReturnType<PdfJs['getDocument']>['promise']>
type Page = Awaited<ReturnType<Doc['getPage']>>

let pdfjs: Promise<PdfJs> | null = null
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default
    return lib
  })
  return pdfjs
}

interface OutlineItem {
  title: string
  page: number | null
  items: OutlineItem[]
}

async function outlineOf(doc: Doc): Promise<OutlineItem[]> {
  const raw = (await doc.getOutline()) ?? []
  const walk = async (items: typeof raw): Promise<OutlineItem[]> =>
    Promise.all(
      items.map(async (o) => {
        let page: number | null = null
        try {
          const dest = typeof o.dest === 'string' ? await doc.getDestination(o.dest) : o.dest
          if (dest?.[0]) page = (await doc.getPageIndex(dest[0] as never)) + 1
        } catch {
          page = null
        }
        return { title: o.title, page, items: await walk(o.items ?? []) }
      }),
    )
  return walk(raw)
}

function PageView({ doc, n, scale, lib, cite, active, onVisible }: { doc: Doc; n: number; scale: number; lib: PdfJs; cite?: ViewerProps['file']['cite']; active: boolean; onVisible: (n: number) => void }) {
  const holder = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState<Page | null>(null)
  const [near, setNear] = useState(n <= 2)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    const el = holder.current
    if (!el) return
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (e.isIntersecting) setNear(true)
          if (e.intersectionRatio > 0.5) onVisible(n)
        }
      },
      { rootMargin: '600px 0px', threshold: [0, 0.5] },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [n, onVisible])

  useEffect(() => {
    if (!near) return
    let live = true
    void doc.getPage(n).then((p) => {
      if (!live) return
      setPage(p)
      const v = p.getViewport({ scale: 1 })
      setBox({ w: v.width, h: v.height })
    })
    return () => {
      live = false
    }
  }, [doc, n, near])

  useEffect(() => {
    if (!page || !canvas.current || !text.current) return
    const viewport = page.getViewport({ scale })
    const ratio = window.devicePixelRatio || 1
    const c = canvas.current
    c.width = Math.floor(viewport.width * ratio)
    c.height = Math.floor(viewport.height * ratio)
    c.style.width = `${viewport.width}px`
    c.style.height = `${viewport.height}px`
    const task = page.render({ canvas: c, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined })
    task.promise.catch(() => undefined)
    const t = text.current
    t.replaceChildren()
    t.style.setProperty('--total-scale-factor', String(scale))
    const layer = new lib.TextLayer({ textContentSource: page.streamTextContent(), container: t, viewport })
    void layer.render().catch(() => undefined)
    return () => {
      task.cancel()
      layer.cancel()
    }
  }, [page, scale, lib])

  const w = (box?.w ?? 612) * scale
  const h = (box?.h ?? 792) * scale
  const region = cite?.page === n ? cite.region : undefined
  return (
    <div ref={holder} data-page={n} className={cn('relative mx-auto my-3 bg-white shadow-sm ring-1 ring-border', active && 'ring-2 ring-primary/40')} style={{ width: w, height: h }}>
      <canvas ref={canvas} className="absolute inset-0" aria-label={`Page ${n}`} />
      <div ref={text} className="pdf-text textLayer absolute inset-0" />
      {region && (
        <div className="pointer-events-none absolute rounded-sm bg-warning/30 ring-2 ring-warning" style={{ left: region[0] * scale, top: region[1] * scale, width: region[2] * scale, height: region[3] * scale }} aria-label="The cited region" />
      )}
      {!page && <div className="absolute inset-0 animate-pulse bg-muted/40" />}
      <span className="absolute -left-10 top-0 hidden text-xs text-muted-foreground lg:block">{n}</span>
    </div>
  )
}

/** Card: the first page (or the cited one) as a small picture, with the page count. */
function Thumb({ doc, n }: { doc: Doc; n: number }) {
  const c = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let live = true
    let task: { cancel: () => void; promise: Promise<void> } | null = null
    void doc.getPage(n).then((p) => {
      if (!live || !c.current) return
      const v = p.getViewport({ scale: 200 / p.getViewport({ scale: 1 }).height })
      c.current.width = v.width
      c.current.height = v.height
      task = p.render({ canvas: c.current, viewport: v })
      task.promise.catch(() => undefined)
    })
    return () => {
      live = false
      task?.cancel()
    }
  }, [doc, n])
  return <canvas ref={c} className="h-[200px] rounded border bg-white" aria-label={`Page ${n}`} />
}

export default function PdfViewer({ file, size, commit }: ViewerProps) {
  const u = useFileUrl(file, commit)
  const [lib, setLib] = useState<PdfJs | null>(null)
  const [doc, setDoc] = useState<Doc | null>(null)
  const [err, setErr] = useState<unknown>(null)
  const [scale, setScale] = useState(size === 'page' ? 1.25 : 1)
  const [current, setCurrent] = useState(file.cite?.page ?? 1)
  const [outline, setOutline] = useState<OutlineItem[] | null>(null)
  const [showOutline, setShowOutline] = useState(false)
  const [find, setFind] = useState('')
  const [hits, setHits] = useState<number[]>([])
  const [hit, setHit] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const url = u.data?.url

  useEffect(() => {
    if (!url) return
    let live = true
    let task: ReturnType<PdfJs['getDocument']> | null = null
    void loadPdfJs()
      .then((l) => {
        setLib(l)
        // no XFA forms, no scripting (pdf.js runs no PDF JavaScript unless a scripting sandbox is given; none is)
        task = l.getDocument({ url, enableXfa: false, disableAutoFetch: true, disableStream: false })
        return task.promise
      })
      .then((d) => {
        if (live) setDoc(d)
      })
      .catch((e) => live && setErr(e))
    return () => {
      live = false
      void task?.destroy()
    }
    // the link refreshes every few minutes; the document stays the one first opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!url, file.path, commit])

  useEffect(() => {
    if (doc && size !== 'card') void outlineOf(doc).then(setOutline).catch(() => setOutline([]))
  }, [doc, size])

  const go = useCallback((n: number) => {
    scroller.current?.querySelector(`[data-page="${n}"]`)?.scrollIntoView({ block: 'start' })
  }, [])

  // open at the cited page
  useEffect(() => {
    if (doc && file.cite?.page && size !== 'card') setTimeout(() => go(file.cite!.page!), 50)
  }, [doc, file.cite, size, go])

  // search: page by page, pages with a match
  useEffect(() => {
    if (!doc || !find.trim()) {
      setHits([])
      return
    }
    let live = true
    const q = find.toLowerCase()
    void (async () => {
      const found: number[] = []
      for (let n = 1; n <= doc.numPages && live; n++) {
        const tc = await (await doc.getPage(n)).getTextContent()
        if (tc.items.map((i) => ('str' in i ? i.str : '')).join(' ').toLowerCase().includes(q)) found.push(n)
        if (live) setHits([...found])
      }
    })()
    return () => {
      live = false
    }
  }, [doc, find])

  // start at the page's width when the view is narrower than the page at its starting zoom (phones, sheets)
  const fitted = useRef(false)
  useEffect(() => {
    if (!doc || fitted.current || size === 'card') return
    fitted.current = true
    void doc.getPage(1).then((p) => {
      const w = p.getViewport({ scale: 1 }).width
      const avail = (scroller.current?.clientWidth ?? 0) - 24
      if (avail > 0 && w * scale > avail) setScale(Math.max(0.4, avail / w))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, size])

  const pages = useMemo(() => (doc ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : []), [doc])
  const onVisible = useCallback((n: number) => setCurrent(n), [])

  if (u.isError || err) return <ViewerError error={u.error ?? err} onRetry={() => { setErr(null); void u.refetch() }} />
  if (!doc || !lib) return <ViewerLoading size={size} label="Opening the PDF" />

  if (size === 'card') {
    return (
      <div className="flex items-start gap-3 p-3">
        <Thumb doc={doc} n={file.cite?.page ?? 1} />
        <div className="text-xs text-muted-foreground">
          {file.cite?.page ? <p className="font-medium text-foreground">Page {file.cite.page} cited</p> : <p>First page</p>}
          {file.cite?.text && <p className="mt-1 italic">“{file.cite.text}”</p>}
          <p className="mt-1">PDF · {doc.numPages} pages</p>
        </div>
      </div>
    )
  }

  const step = (d: 1 | -1) => {
    if (!hits.length) return
    const next = (hit + d + hits.length) % hits.length
    setHit(next)
    go(hits[next]!)
  }
  const renderOutline = (items: OutlineItem[], depth = 0) => (
    <ol className="space-y-1">
      {items.map((o, i) => (
        <li key={i} style={{ paddingLeft: depth * 10 }}>
          <button type="button" disabled={!o.page} className="text-left text-muted-foreground hover:text-foreground disabled:opacity-60" onClick={() => o.page && go(o.page)}>
            {o.title}
          </button>
          {o.items.length > 0 && renderOutline(o.items, depth + 1)}
        </li>
      ))}
    </ol>
  )

  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <Controls>
        <Toggle size="sm" pressed={showOutline} onPressedChange={setShowOutline} className="h-7 text-xs" disabled={!outline?.length} aria-label="Outline">
          <ListTree /> Outline
        </Toggle>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-7" aria-label="Previous page" onClick={() => go(Math.max(1, current - 1))}>
            <ChevronLeft />
          </Button>
          <label className="flex items-center gap-1">
            <span className="sr-only">Page</span>
            <input
              key={current}
              defaultValue={current}
              onKeyDown={(e) => e.key === 'Enter' && go(Math.min(doc.numPages, Math.max(1, Number((e.target as HTMLInputElement).value) || 1)))}
              className="h-7 w-12 rounded-md border bg-background text-center"
              inputMode="numeric"
            />
            <span className="text-muted-foreground">of {doc.numPages}</span>
          </label>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Next page" onClick={() => go(Math.min(doc.numPages, current + 1))}>
            <ChevronRight />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-7" aria-label="Zoom out" onClick={() => setScale((s) => Math.max(0.5, s / 1.2))}>
            <Minus />
          </Button>
          <span className="w-10 text-center font-mono">{Math.round(scale * 100)}%</span>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Zoom in" onClick={() => setScale((s) => Math.min(4, s * 1.2))}>
            <Plus />
          </Button>
        </div>
        <FindBox value={find} onChange={(v) => { setFind(v); setHit(0) }} count={hits.length} index={hit} onStep={step} placeholder="Search the PDF" />
        {find && hits.length > 0 && <span className="text-muted-foreground">on pages {hits.slice(0, 8).join(', ')}{hits.length > 8 ? '…' : ''}</span>}
        {file.cite?.page && (
          <Button variant="outline" size="sm" className="ml-auto h-7 text-xs" onClick={() => go(file.cite!.page!)}>
            Cited: page {file.cite.page}
          </Button>
        )}
      </Controls>
      <div className="flex min-h-0 flex-1">
        {showOutline && outline && (
          <nav aria-label="Outline" className="w-60 shrink-0 overflow-auto border-r p-3 text-sm">
            {renderOutline(outline)}
          </nav>
        )}
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-muted/40 px-2">
          {pages.map((n) => (
            <PageView key={n} doc={doc} n={n} scale={scale} lib={lib} cite={file.cite} active={hits[hit] === n && !!find} onVisible={onVisible} />
          ))}
        </div>
      </div>
    </div>
  )
}

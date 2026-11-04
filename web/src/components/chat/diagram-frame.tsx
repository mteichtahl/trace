/**
 * The frame every picture in a chat message sits in (diagrams, timing diagrams, plots, drawings, images): a title,
 * then the picture, then a small bar with Full screen (pan and zoom, Escape to close), Download (the drawing as SVG
 * or PNG, or a plot's numbers as CSV) and Show source. While a reply is still streaming the frame shows a quiet
 * placeholder, so a half-written diagram never flickers through errors.
 */
import { Code2, Download, Maximize2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { PanZoom } from '@/components/files/viewers/common'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { CodeBlock } from './code-block'

export interface DiagramDownload {
  /** the file name without its extension */
  name: string
  /** a drawing: offered as SVG and PNG */
  svg?: string
  /** a plot's numbers, offered as CSV */
  csv?: string
}

export interface DiagramFrameProps {
  /** what kind of picture this is, in plain words ("Diagram", "Timing diagram", "Plot") */
  kind: string
  title?: string
  /** the picture as it sits in the message */
  children: ReactNode
  /** the picture full screen; pannable unless `pan` is false (a plot has its own hover values instead) */
  full?: ReactNode
  pan?: boolean
  /** a white backing, for drawings made for paper (timing diagrams, SVG drawings) */
  paper?: boolean
  source?: string
  sourceLang?: string
  download?: DiagramDownload
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'diagram'
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Draw an SVG onto a canvas at twice its size, on white, and return it as a PNG. */
export async function svgToPng(svg: string, scale = 2): Promise<Blob> {
  const img = new Image()
  img.decoding = 'async'
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await img.decode()
  const w = Math.max(1, Math.round((img.naturalWidth || 800) * scale))
  const h = Math.max(1, Math.round((img.naturalHeight || 600) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no PNG'))), 'image/png'))
}

function DownloadMenu({ d }: { d: DiagramDownload }) {
  const items: { label: string; run: () => void | Promise<void> }[] = []
  if (d.svg) {
    const svg = d.svg
    items.push({ label: 'Picture (SVG)', run: () => save(new Blob([svg], { type: 'image/svg+xml' }), `${d.name}.svg`) })
    items.push({
      label: 'Picture (PNG)',
      run: async () => {
        try {
          save(await svgToPng(svg), `${d.name}.png`)
        } catch {
          toast.error('This picture could not be made into a PNG. Download it as SVG instead.')
        }
      },
    })
  }
  if (d.csv) {
    const csv = d.csv
    items.push({ label: 'Numbers (CSV)', run: () => save(new Blob([csv], { type: 'text/csv' }), `${d.name}.csv`) })
  }
  if (!items.length) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" aria-label="Download">
          <Download /> <span className="hidden @sm:inline">Download</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((i) => (
          <DropdownMenuItem key={i.label} onSelect={() => void i.run()}>
            {i.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DiagramFrame({ kind, title, children, full, pan = true, paper, source, sourceLang, download }: DiagramFrameProps) {
  const [open, setOpen] = useState(false)
  const [showSource, setShowSource] = useState(false)
  const name = title || kind
  return (
    <figure className="@container my-3 overflow-hidden rounded-lg border" aria-label={name}>
      {title && <figcaption className="border-b px-3 py-1.5 text-sm font-medium">{title}</figcaption>}
      <div className={cn('relative', paper && 'bg-white')}>
        <div
          role="button"
          tabIndex={0}
          className="block w-full cursor-zoom-in p-3 text-left focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={`Open ${name.toLowerCase()} full screen`}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setOpen(true)
            }
          }}
        >
          {children}
        </div>
      </div>
      <div className="flex items-center gap-1 border-t bg-muted/30 px-2 py-0.5">
        <span className="mr-auto truncate px-1 text-xs text-muted-foreground">{kind}</span>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" aria-label="Full screen" onClick={() => setOpen(true)}>
          <Maximize2 /> <span className="hidden @sm:inline">Full screen</span>
        </Button>
        {download && <DownloadMenu d={download} />}
        {source !== undefined && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" aria-label="Source" aria-pressed={showSource} onClick={() => setShowSource((v) => !v)}>
            <Code2 /> <span className="hidden @sm:inline">{showSource ? 'Hide source' : 'Source'}</span>
          </Button>
        )}
      </div>
      {showSource && source !== undefined && (
        <div className="border-t px-3 [&>div]:my-2">
          <CodeBlock code={source} lang={sourceLang} />
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[92dvh] w-[96vw] max-w-[96vw] flex-col gap-2 p-3 sm:max-w-[96vw]">
          <DialogTitle className="pr-8 text-base">{name}</DialogTitle>
          <DialogDescription className="sr-only">
            {pan ? 'Drag to move, scroll or use the buttons to zoom, double-click to fit.' : 'Hover the plot to read its values.'}
          </DialogDescription>
          {pan ? (
            <PanZoom className={cn('min-h-0 flex-1 rounded-md border', paper && 'bg-white')} label={name}>
              {full ?? children}
            </PanZoom>
          ) : (
            <div className={cn('min-h-0 flex-1 overflow-auto rounded-md border p-3', paper && 'bg-white')}>{full ?? children}</div>
          )}
          <div className="@container flex justify-end gap-1">{download && <DownloadMenu d={download} />}</div>
        </DialogContent>
      </Dialog>
    </figure>
  )
}

/** What sits in a frame while the reply is still being written, or while a drawing library loads. */
export function DrawingPlaceholder({ label = 'Drawing the diagram' }: { label?: string }) {
  return (
    <div className="flex h-24 items-center justify-center rounded bg-muted/60 text-xs text-muted-foreground motion-safe:animate-pulse" role="status">
      {label}…
    </div>
  )
}

/** A drawing that could not be made: says so in plain words and shows what was written. */
export function DrawingFailed({ kind, reason, source, lang }: { kind: string; reason?: string; source: string; lang?: string }) {
  return (
    <div className="my-3 rounded-lg border border-dashed p-3 text-sm">
      <p className="text-muted-foreground">
        This {kind.toLowerCase()} could not be drawn{reason ? `: ${reason}` : '.'} Here is what was written instead.
      </p>
      <CodeBlock code={source} lang={lang} />
    </div>
  )
}

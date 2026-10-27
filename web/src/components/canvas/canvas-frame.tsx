/**
 * The Canvas frame: one wrapper for every visual (traceability, block diagram, findings overlay, run plots, bench
 * wiring, file viewers) so they pan, zoom and filter the same way. A slim toolbar (zoom, fit, layers, filter, Compare,
 * Ask about this) over a full-width area; wheel or pinch zooms, drag pans. The selected item's detail opens in a
 * side sheet so the picture stays in view (`detail`).
 */
import { Expand, Layers, ListFilter, Minus, Plus, Scan, Sparkles } from 'lucide-react'
import { type ReactNode, useCallback, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

export interface CanvasLayer {
  id: string
  label: string
  on: boolean
}

export interface CanvasFrameProps {
  title?: ReactNode
  /** quiet text beside the title ("Sheet 1 of 4 · push 7f3e21") */
  subtitle?: ReactNode
  children: ReactNode
  layers?: CanvasLayer[]
  onLayer?: (id: string, on: boolean) => void
  /** filter controls (a popover's content) */
  filter?: ReactNode
  onCompare?: () => void
  onAsk?: () => void
  onFullscreen?: () => void
  /** the selected item's detail; set to show the side sheet */
  detail?: { title: ReactNode; body: ReactNode } | null
  onDetailClose?: () => void
  /** pan and zoom the content (off for content that scrolls itself, like a table) */
  zoomable?: boolean
  height?: number | string
  className?: string
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function CanvasFrame({
  title, subtitle, children, layers, onLayer, filter, onCompare, onAsk, onFullscreen, detail, onDetailClose, zoomable = true, height = 420, className,
}: CanvasFrameProps) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const fit = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  return (
    <div className={cn('overflow-hidden rounded-xl border bg-card', className)}>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <div className="min-w-0 flex-1 truncate text-sm">
          {title && <span className="font-medium">{title}</span>}
          {subtitle && <span className="ml-2 text-xs text-muted-foreground">{subtitle}</span>}
        </div>
        {layers && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <Layers /> Layers
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Show layers</DropdownMenuLabel>
              {layers.map((l) => (
                <DropdownMenuCheckboxItem key={l.id} checked={l.on} onCheckedChange={(v) => onLayer?.(l.id, !!v)} onSelect={(e) => e.preventDefault()}>
                  {l.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {filter && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <ListFilter /> Filter
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64 p-3">
              {filter}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {onCompare && (
          <Button variant="ghost" size="sm" onClick={onCompare}>
            Compare
          </Button>
        )}
        {onAsk && (
          <Button variant="ghost" size="sm" onClick={onAsk}>
            <Sparkles /> Ask about this
          </Button>
        )}
        {zoomable && (
          <div className="flex items-center rounded-md border">
            <Button variant="ghost" size="icon" className="size-8 rounded-none" aria-label="Zoom out" onClick={() => setZoom((z) => clamp(z / 1.25, 0.25, 8))}>
              <Minus />
            </Button>
            <span className="w-12 text-center font-mono text-xs" aria-live="polite">
              {Math.round(zoom * 100)}%
            </span>
            <Button variant="ghost" size="icon" className="size-8 rounded-none" aria-label="Zoom in" onClick={() => setZoom((z) => clamp(z * 1.25, 0.25, 8))}>
              <Plus />
            </Button>
            <Button variant="ghost" size="icon" className="size-8 rounded-none border-l" aria-label="Fit" onClick={fit}>
              <Scan />
            </Button>
          </div>
        )}
        {onFullscreen && (
          <Button variant="outline" size="icon" className="size-8" aria-label="Full screen" onClick={onFullscreen}>
            <Expand />
          </Button>
        )}
      </div>
      <div
        className={cn('relative overflow-hidden bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px]', zoomable && 'cursor-grab active:cursor-grabbing touch-none')}
        style={{ height }}
        onWheel={zoomable ? (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom((z) => clamp(z * (e.deltaY < 0 ? 1.1 : 0.9), 0.25, 8)) } } : undefined}
        onPointerDown={zoomable ? (e) => { drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; (e.target as HTMLElement).setPointerCapture?.(e.pointerId) } : undefined}
        onPointerMove={zoomable ? (e) => { const d = drag.current; if (d) setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }) } : undefined}
        onPointerUp={() => (drag.current = null)}
      >
        <div className="flex h-full w-full items-center justify-center" style={zoomable ? { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center' } : undefined}>
          {children}
        </div>
      </div>
      <Sheet open={!!detail} onOpenChange={(o) => !o && onDetailClose?.()}>
        <SheetContent className="w-full sm:max-w-[480px] xl:max-w-[560px]">
          <SheetHeader>
            <SheetTitle>{detail?.title}</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-6">{detail?.body}</div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

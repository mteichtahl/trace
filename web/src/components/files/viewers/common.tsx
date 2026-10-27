/** Pieces every viewer shares: its props, heights per size, the loading and error states, a pan-and-zoom surface. */
import { Minus, Plus, Scan } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState, Loading } from '@/components/states'
import { cn } from '@/lib/utils'
import type { FileRef } from '../data'

export type ViewerSize = 'card' | 'sheet' | 'page'

export interface ViewerProps {
  file: FileRef
  size: ViewerSize
  /** an earlier version (its commit) instead of the current one */
  commit?: string
}

/** The drawing area's height for each size. */
export const AREA: Record<ViewerSize, string> = {
  card: 'h-[220px]',
  // the viewer fills what the File viewer gives it (its frame is a flex column with a fixed height)
  sheet: 'h-full min-h-[320px]',
  page: 'h-full min-h-[420px]',
}

export function ViewerLoading({ size, label = 'Opening the file' }: { size: ViewerSize; label?: string }) {
  return (
    <Loading>
      <div className={cn('flex flex-col gap-2 p-4', AREA[size])}>
        <span className="sr-only">{label}</span>
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="w-full flex-1" />
      </div>
    </Loading>
  )
}

export function ViewerError({ error, onRetry, what = 'this file' }: { error: unknown; onRetry?: () => void; what?: string }) {
  const msg = error instanceof Error ? error.message : String(error)
  return (
    <div className="p-4">
      <ErrorState title={`Could not open ${what}.`} kept="Nothing was changed." onRetry={onRetry} detail={msg} />
    </div>
  )
}

/** A quiet row of the format's own controls, under the shared toolbar. */
export function Controls({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs', className)}>{children}</div>
}

/** An honest line where a viewer cannot do something yet, or why. */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('px-4 py-2 text-xs text-muted-foreground', className)}>{children}</p>
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export interface PanZoomState {
  zoom: number
  x: number
  y: number
}

/**
 * Pan with a drag, zoom with the wheel (towards the pointer) or the buttons, Fit to reset. `max` 32 lets an image zoom to
 * its pixels. Pass `value`/`onChange` to lock two surfaces together (comparing versions).
 */
export function PanZoom({
  children, className, max = 32, value, onChange, pixelated, toolbar = true, label,
}: {
  children: ReactNode
  className?: string
  max?: number
  value?: PanZoomState
  onChange?: (s: PanZoomState) => void
  pixelated?: boolean
  toolbar?: boolean
  label?: string
}) {
  const [own, setOwn] = useState<PanZoomState>({ zoom: 1, x: 0, y: 0 })
  const s = value ?? own
  const set = useCallback((n: PanZoomState) => (onChange ? onChange(n) : setOwn(n)), [onChange])
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null)
  const latest = useRef(s)
  latest.current = s

  // a non-passive wheel listener, so the page does not scroll while zooming
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const cur = latest.current
      const r = el.getBoundingClientRect()
      const px = e.clientX - r.left - r.width / 2
      const py = e.clientY - r.top - r.height / 2
      const zoom = clamp(cur.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.1, max)
      const k = zoom / cur.zoom
      set({ zoom, x: px - (px - cur.x) * k, y: py - (py - cur.y) * k })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [max, set])

  return (
    <div className={cn('relative overflow-hidden', className)}>
      <div
        ref={ref}
        role="img"
        aria-label={label}
        className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          drag.current = { x: e.clientX, y: e.clientY, sx: s.x, sy: s.y }
          ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d) set({ ...s, x: d.sx + e.clientX - d.x, y: d.sy + e.clientY - d.y })
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={() => set({ zoom: 1, x: 0, y: 0 })}
      >
        <div
          className="flex h-full w-full items-center justify-center"
          style={{ transform: `translate(${s.x}px, ${s.y}px) scale(${s.zoom})`, transformOrigin: 'center', imageRendering: pixelated && s.zoom > 2 ? 'pixelated' : undefined }}
        >
          {children}
        </div>
      </div>
      {toolbar && (
        <div className="absolute bottom-2 right-2 flex items-center rounded-md border bg-background/90 shadow-sm backdrop-blur">
          <Button variant="ghost" size="icon" className="size-8 rounded-none" aria-label="Zoom out" onClick={() => set({ ...s, zoom: clamp(s.zoom / 1.25, 0.1, max) })}>
            <Minus />
          </Button>
          <span className="w-14 text-center font-mono text-xs" aria-live="polite">
            {Math.round(s.zoom * 100)}%
          </span>
          <Button variant="ghost" size="icon" className="size-8 rounded-none" aria-label="Zoom in" onClick={() => set({ ...s, zoom: clamp(s.zoom * 1.25, 0.1, max) })}>
            <Plus />
          </Button>
          <Button variant="ghost" size="sm" className="h-8 rounded-none border-l text-xs" onClick={() => set({ zoom: 1, x: 0, y: 0 })}>
            <Scan /> Fit
          </Button>
        </div>
      )}
    </div>
  )
}

/** A search box for viewers (code, PDF): Enter for next, Shift+Enter for previous, with "3 of 12". */
export function FindBox({ value, onChange, count, index, onStep, placeholder = 'Find' }: { value: string; onChange: (v: string) => void; count: number; index: number; onStep: (d: 1 | -1) => void; placeholder?: string }) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onStep(e.shiftKey ? -1 : 1)
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-7 w-40 rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {value && <span className="whitespace-nowrap text-muted-foreground" aria-live="polite">{count ? `${index + 1} of ${count}` : 'No matches'}</span>}
    </div>
  )
}

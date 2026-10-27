/**
 * Renders and photos (.png, .jpg, .webp, .gif) and turntables (.mp4): zoom to the pixel, shown as made on a neutral
 * frame. Compare (images and drawings): two panes locked together, a slider over one picture, or a difference overlay
 * computed on a canvas.
 */
import { useEffect, useRef, useState } from 'react'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { useFileUrl } from '../data'
import { AREA, Controls, Note, PanZoom, type PanZoomState, ViewerError, ViewerLoading, type ViewerProps } from './common'

export function ImageViewer({ file, size, commit }: ViewerProps) {
  const u = useFileUrl(file, commit)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  if (u.isError) return <ViewerError error={u.error} onRetry={() => void u.refetch()} />
  if (!u.data) return <ViewerLoading size={size} />
  const img = <img src={u.data.url} alt={file.path} draggable={false} onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} className="max-h-full max-w-full object-contain" />
  if (size === 'card') return <div className="flex h-[220px] items-center justify-center bg-muted/40 p-2">{img}</div>
  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <Controls>
        <span className="text-muted-foreground">{dims ? `${dims.w} × ${dims.h} pixels` : 'Loading…'} · scroll to zoom up to the pixel; double-click to fit</span>
      </Controls>
      <PanZoom className="min-h-0 flex-1 bg-muted/40" pixelated max={64} label={`Image ${file.path}`}>
        {img}
      </PanZoom>
    </div>
  )
}

export function VideoViewer({ file, size, commit }: ViewerProps) {
  const u = useFileUrl(file, commit)
  if (u.isError) return <ViewerError error={u.error} onRetry={() => void u.refetch()} />
  if (!u.data) return <ViewerLoading size={size} />
  return (
    <div className={cn('flex items-center justify-center bg-black', size === 'card' ? 'h-[220px]' : AREA[size])}>
      <video src={u.data.url} controls={size !== 'card'} autoPlay={size === 'card'} muted loop playsInline className="max-h-full max-w-full" aria-label={file.path} />
    </div>
  )
}

/** The share of pixels that differ (0..1), and the overlay painted into `out`: changed pixels in red over a faded copy. */
export function differenceOverlay(a: ImageData, b: ImageData, out: ImageData, threshold = 24): number {
  let changed = 0
  const n = Math.min(a.data.length, b.data.length, out.data.length)
  for (let i = 0; i < n; i += 4) {
    const d = Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!)
    const grey = (b.data[i]! + b.data[i + 1]! + b.data[i + 2]!) / 3
    if (d > threshold) {
      changed++
      out.data[i] = 230
      out.data[i + 1] = 40
      out.data[i + 2] = 40
      out.data[i + 3] = 255
    } else {
      const g = 200 + grey / 5
      out.data[i] = g
      out.data[i + 1] = g
      out.data[i + 2] = g
      out.data[i + 3] = 255
    }
  }
  return changed / (n / 4 || 1)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image()
    i.crossOrigin = 'anonymous'
    i.onload = () => res(i)
    i.onerror = () => rej(new Error('The picture could not be read.'))
    i.src = src
  })
}

function Difference({ before, after }: { before: string; after: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [share, setShare] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void Promise.all([loadImage(before), loadImage(after)])
      .then(([a, b]) => {
        if (!live || !canvas.current) return
        const w = Math.min(2048, Math.max(a.naturalWidth || 800, b.naturalWidth || 800))
        const h = Math.round(w * ((b.naturalHeight || 600) / (b.naturalWidth || 800)))
        const c = canvas.current
        c.width = w
        c.height = h
        const ctx = c.getContext('2d', { willReadFrequently: true })
        if (!ctx) return
        const read = (img: HTMLImageElement) => {
          ctx.fillStyle = '#fff'
          ctx.fillRect(0, 0, w, h)
          ctx.drawImage(img, 0, 0, w, h)
          return ctx.getImageData(0, 0, w, h)
        }
        const da = read(a)
        const db = read(b)
        const out = ctx.createImageData(w, h)
        setShare(differenceOverlay(da, db, out))
        ctx.putImageData(out, 0, 0)
      })
      .catch((e: Error) => live && setErr(e.message))
    return () => {
      live = false
    }
  }, [before, after])
  if (err) return <Note>{err} The difference needs both pictures readable from this page.</Note>
  return (
    <div className="flex h-full flex-col">
      <canvas ref={canvas} className="max-h-full max-w-full object-contain" aria-label="Changed pixels shown in red" />
      {share !== null && <p className="mt-1 text-center text-xs text-muted-foreground">{share === 0 ? 'No visible change' : `${(share * 100).toFixed(share < 0.01 ? 2 : 1)}% of the picture changed (red)`}</p>}
    </div>
  )
}

/** Two pictures compared: side by side (locked), a slider, or the difference. */
export function PictureCompare({ before, after, beforeLabel, afterLabel, size }: { before: string; after: string; beforeLabel: string; afterLabel: string; size: ViewerProps['size'] }) {
  const [mode, setMode] = useState<'side' | 'slider' | 'difference'>('slider')
  const [at, setAt] = useState(50)
  const [view, setView] = useState<PanZoomState>({ zoom: 1, x: 0, y: 0 })
  const img = (src: string, label: string) => <img src={src} alt={label} draggable={false} className="max-h-full max-w-full object-contain" />
  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <Controls>
        <ToggleGroup type="single" size="sm" variant="outline" value={mode} onValueChange={(v) => v && setMode(v as typeof mode)}>
          <ToggleGroupItem value="side" className="h-7 text-xs">Side by side</ToggleGroupItem>
          <ToggleGroupItem value="slider" className="h-7 text-xs">Slider</ToggleGroupItem>
          <ToggleGroupItem value="difference" className="h-7 text-xs">Difference</ToggleGroupItem>
        </ToggleGroup>
        {mode === 'slider' && <Slider value={[at]} onValueChange={([v]) => setAt(v ?? 50)} min={0} max={100} step={1} className="w-40" aria-label="Reveal the earlier version" />}
        <span className="ml-auto text-muted-foreground">
          {beforeLabel} → {afterLabel}
        </span>
      </Controls>
      {mode === 'side' && (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-border sm:grid-cols-2">
          {[[before, beforeLabel], [after, afterLabel]].map(([src, label]) => (
            <div key={label} className="relative min-h-0 bg-muted/40">
              <span className="absolute left-2 top-2 z-10 rounded bg-background/90 px-1.5 py-0.5 font-mono text-[11px]">{label}</span>
              <PanZoom className="h-full" value={view} onChange={setView} pixelated label={label}>
                {img(src!, label!)}
              </PanZoom>
            </div>
          ))}
        </div>
      )}
      {mode === 'slider' && (
        <PanZoom className="min-h-0 flex-1 bg-muted/40" value={view} onChange={setView} pixelated label="Comparison">
          <div className="relative inline-grid max-h-full max-w-full">
            <div className="col-start-1 row-start-1">{img(after, afterLabel)}</div>
            <div className="col-start-1 row-start-1" style={{ clipPath: `inset(0 ${100 - at}% 0 0)` }}>{img(before, beforeLabel)}</div>
            <div className="pointer-events-none col-start-1 row-start-1 h-full border-l-2 border-primary" style={{ marginLeft: `${at}%` }} aria-hidden />
          </div>
        </PanZoom>
      )}
      {mode === 'difference' && (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/40 p-2">
          <Difference before={before} after={after} />
        </div>
      )}
    </div>
  )
}

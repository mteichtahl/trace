/**
 * Overlay: a schematic's or board's before and after on one sheet, so a person sees what moved. KiCanvas draws to a
 * canvas, so trace keeps two viewers stacked out of sight (the after one on top, transparent, taking pan and zoom; the
 * before one following its camera every frame) and composites them into one visible canvas, pixel by pixel, in the
 * same task as their draw (which also works for the board's WebGL canvas): ink in both → muted, before only →
 * destructive (removed), after only → verified (added). The colours are the theme's tokens, read at draw time, so it
 * follows light and dark. A file with no before (added) or no after (removed) cannot be overlaid; the switch says why.
 */
import { useEffect, useRef, useState } from 'react'
import { ViewerError } from '@/components/files/viewers/common'
import { type KcViewer, type KcViewerElement, loadKiCanvas, waitForViewer } from '@/components/files/viewers/kicad'
import { cn } from '@/lib/utils'

export type Rgb = [number, number, number]

/** Whether Overlay can be offered for a file, and why not. */
export function overlayAvailable(before: unknown, after: unknown): { ok: true } | { ok: false; why: string } {
  if (!before) return { ok: false, why: 'Overlay needs a before: this file is new in this change.' }
  if (!after) return { ok: false, why: 'Overlay needs an after: this change removes the file.' }
  return { ok: true }
}

/** The legend's three entries, in the order they read. */
export const OVERLAY_LEGEND = [
  { key: 'added', word: 'Added', token: '--verified' },
  { key: 'removed', word: 'Removed', token: '--destructive' },
  { key: 'same', word: 'Unchanged', token: '--muted-foreground' },
] as const

/** How far a pixel is from its background: the largest channel difference. */
const ink = (d: Uint8ClampedArray, i: number, bg: Rgb) => Math.max(Math.abs(d[i]! - bg[0]), Math.abs(d[i + 1]! - bg[1]), Math.abs(d[i + 2]! - bg[2]))

/**
 * Composite two same-sized RGBA images into `out`: before-only ink in `removed`, after-only in `added`, ink in both in
 * `same`, everything else `bg`. Each image's own background is its corner pixel. Returns the counts, for tests.
 */
export function overlayPixels(a: Uint8ClampedArray, b: Uint8ClampedArray, out: Uint8ClampedArray, c: { added: Rgb; removed: Rgb; same: Rgb; bg: Rgb }, o: { threshold?: number; width?: number } = {}): { added: number; removed: number; same: number } {
  const threshold = o.threshold ?? 24
  const bgA: Rgb = [a[0]!, a[1]!, a[2]!]
  const bgB: Rgb = [b[0]!, b[1]!, b[2]!]
  const n = { added: 0, removed: 0, same: 0 }
  const px = out.length / 4
  const ma = new Uint8Array(px)
  const mb = new Uint8Array(px)
  for (let p = 0; p < px; p++) {
    ma[p] = ink(a, p * 4, bgA) > threshold ? 1 : 0
    mb[p] = ink(b, p * 4, bgB) > threshold ? 1 : 0
  }
  // with the width known, thin lines are thickened by a pixel so hairlines read
  const w = o.width
  const thick = (m: Uint8Array, p: number) => m[p] || (w ? (p % w > 0 && m[p - 1]) || (p % w < w - 1 && m[p + 1]) || m[p - w] || m[p + w] : 0)
  for (let i = 0; i < out.length; i += 4) {
    const x = !!thick(ma, i / 4)
    const y = !!thick(mb, i / 4)
    const col = x && y ? c.same : x ? c.removed : y ? c.added : c.bg
    if (x && y) n.same++
    else if (x) n.removed++
    else if (y) n.added++
    out[i] = col[0]; out[i + 1] = col[1]; out[i + 2] = col[2]; out[i + 3] = 255
  }
  return n
}

/** A CSS colour (any syntax the browser knows, oklch included) as RGB, through a 1×1 canvas. */
function cssRgb(value: string, fallback: Rgb): Rgb {
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx || !value) return fallback
    ctx.fillStyle = '#000'
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0]!, d[1]!, d[2]!]
  } catch {
    return fallback
  }
}

function tokens(el: Element) {
  const s = getComputedStyle(el)
  const v = (k: string) => s.getPropertyValue(k).trim()
  return {
    added: cssRgb(v('--verified'), [34, 160, 90]),
    removed: cssRgb(v('--destructive'), [220, 38, 38]),
    same: cssRgb(v('--muted-foreground'), [140, 140, 140]),
    bg: cssRgb(v('--background'), [255, 255, 255]),
  }
}

async function mount(host: HTMLElement, text: string, name: string, board: boolean): Promise<KcViewerElement> {
  const embed = document.createElement('kicanvas-embed')
  embed.setAttribute('controls', 'none')
  embed.setAttribute('style', 'width:100%;height:100%;aspect-ratio:auto;max-height:none;background:transparent')
  const src = document.createElement('kicanvas-source')
  src.setAttribute('name', name)
  src.textContent = text // parsed as S-expressions, never HTML
  embed.append(src)
  host.replaceChildren(embed)
  const el = await waitForViewer(embed, board)
  // one light scheme for both, so the two read alike before compositing
  el.theme = board ? 'witchhazel' : 'kicad'
  el.update_theme?.()
  return el
}

type Cam = { center: { x: number; y: number; set(x: number, y: number): void }; zoom: number; flipped: boolean }
const camOf = (v: KcViewer) => v.viewport.camera as unknown as Cam
/** The drawing canvas inside a viewer element's shadow root. */
const canvasOf = (el: KcViewerElement) => (el.shadowRoot?.querySelector('canvas') ?? el.querySelector('canvas')) as HTMLCanvasElement | null

export function OverlayView({ before, after, name, board }: { before: string; after: string; name: string; board: boolean }) {
  const top = useRef<HTMLDivElement>(null)
  const under = useRef<HTMLDivElement>(null)
  const out = useRef<HTMLCanvasElement>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const t = top.current
    const u = under.current
    if (!t || !u) return
    let live = true
    let frame = 0
    setErr(null)
    setReady(false)
    void loadKiCanvas()
      .then(async () => {
        // the same name for both: KiCad prints it in the title block, and a different one would read as a change
        const [b, a] = await Promise.all([mount(u, before, name, board), mount(t, after, name, board)])
        if (!live) return
        const va = a.viewer!
        const vb = b.viewer!
        if (board) va.zoom_to_board?.()
        else va.zoom_to_page?.()
        const scratch = document.createElement('canvas')
        const sctx = scratch.getContext('2d', { willReadFrequently: true })!
        let last = ''
        const tick = () => {
          frame = requestAnimationFrame(tick)
          const ca = camOf(va)
          const cb = camOf(vb)
          const ka = canvasOf(a)
          const kb = canvasOf(b)
          const o = out.current
          if (!ka || !kb || !o || !ka.width || !ka.height) return
          const key = `${ca.center.x},${ca.center.y},${ca.zoom},${ca.flipped},${ka.width}x${ka.height},${document.documentElement.className}`
          if (key === last) return
          last = key
          // the before follows the after's camera exactly
          cb.center.set(ca.center.x, ca.center.y)
          cb.zoom = ca.zoom
          if (cb.flipped !== ca.flipped) vb.flip_view?.()
          va.draw()
          vb.draw()
          const w = ka.width
          const h = ka.height
          scratch.width = w
          scratch.height = h
          sctx.drawImage(kb, 0, 0, w, h)
          const ib = sctx.getImageData(0, 0, w, h)
          sctx.drawImage(ka, 0, 0, w, h)
          const ia = sctx.getImageData(0, 0, w, h)
          o.width = w
          o.height = h
          const octx = o.getContext('2d')!
          const img = octx.createImageData(w, h)
          overlayPixels(ib.data, ia.data, img.data, tokens(o), { width: w })
          octx.putImageData(img, 0, 0)
          setReady(true)
        }
        tick()
      })
      .catch((e: Error) => live && setErr(e.message))
    return () => {
      live = false
      cancelAnimationFrame(frame)
      t.replaceChildren()
      u.replaceChildren()
    }
  }, [before, after, name, board])

  if (err) return <ViewerError error={new Error(err)} what="the overlay" />
  return (
    <div className="relative h-full min-h-[300px] overflow-hidden bg-background">
      {/* the before: drawn, never seen or touched */}
      <div ref={under} aria-hidden className="pointer-events-none invisible absolute inset-0" />
      <canvas ref={out} aria-label="Before and after on one sheet: added in green, removed in red, unchanged in grey" role="img" className="pointer-events-none absolute inset-0 size-full" />
      {/* the after: transparent, on top, takes pan and zoom */}
      <div ref={top} className={cn('absolute inset-0 opacity-0')} />
      {!ready && <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">Laying the two versions over each other…</p>}
      <OverlayLegend className="absolute bottom-2 left-2" />
    </div>
  )
}

export function OverlayLegend({ className }: { className?: string }) {
  return (
    <ul aria-label="Overlay colours" className={cn('flex gap-3 rounded-md border bg-background/90 px-2.5 py-1.5 text-xs', className)}>
      {OVERLAY_LEGEND.map((l) => (
        <li key={l.key} className="flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-4 rounded-full" style={{ background: `var(${l.token})` }} />
          {l.word}
        </li>
      ))}
    </ul>
  )
}

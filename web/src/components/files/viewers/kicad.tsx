/**
 * Schematics (.kicad_sch) and boards (.kicad_pcb) with KiCanvas (vendored in src/vendor/kicanvas, loaded on first
 * use): pan and zoom, tap a symbol or footprint to select it, hover a net to highlight it (KiCanvas's own). trace adds
 * its findings overlay: numbered markers placed from each finding's coordinates in millimetres (the ERC/DRC `pos`)
 * through KiCanvas's camera, so they follow every pan, zoom and flip; a findings list beside it that zooms to each.
 * Boards add layer toggles and a top/bottom flip. The file's text is handed to KiCanvas inline (never as HTML).
 * If KiCanvas cannot draw the file, the viewer says so and offers Open in KiCad (download).
 */
import { Download, FlipHorizontal2, Layers } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { StatusBadge } from '@/components/status-badge'
import { useMediaQuery } from '@/hooks/use-media-query'
import { cn } from '@/lib/utils'
import { type FileFinding, downloadFile, useFileText } from '../data'
import { baseName, extOf } from '../kinds'
import { AREA, Controls, Note, ViewerError, ViewerLoading, type ViewerProps } from './common'

// ------------------------------------------------------------------ the parts of KiCanvas we reach into

export interface KcPoint { x: number; y: number }
interface KcLayer { name: string; visible: boolean; color: { to_css(): string } }
export interface KcViewer {
  viewport: { camera: { matrix: { transform(p: KcPoint): KcPoint }; flipped: boolean } }
  layers: { in_ui_order(): Iterable<KcLayer>; by_name(n: string): KcLayer | undefined }
  flip_view?: () => void
  draw(): void
  paint(): void
  select(item: string | null): void
  zoom_to_selection(): void
  zoom_to_page?: () => void
  zoom_to_board?: () => void
}
export interface KcViewerElement extends HTMLElement { theme?: string; update_theme?: () => void; viewer?: KcViewer }

let loading: Promise<unknown> | null = null
export const loadKiCanvas = () => (loading ??= import('@/vendor/kicanvas/kicanvas.js'))

/** Wait for the embed to finish loading and hand back its viewer element (inside two shadow roots). */
export function waitForViewer(embed: HTMLElement, board: boolean, timeoutMs = 20000): Promise<KcViewerElement> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const app = embed.shadowRoot?.querySelector(board ? 'kc-board-app' : 'kc-schematic-app') as (HTMLElement & { viewer?: KcViewer }) | null
      const el = app?.shadowRoot?.querySelector(board ? 'kc-board-viewer' : 'kc-schematic-viewer') as KcViewerElement | null
      const v = el?.viewer as (KcViewer & { document?: unknown }) | undefined
      if (el && v?.viewport?.camera && v.document) return resolve(el)
      if (Date.now() - start > timeoutMs) return reject(new Error('KiCanvas did not finish drawing this file.'))
      setTimeout(tick, 120)
    }
    tick()
  })
}

const SEV: Record<FileFinding['severity'], { ring: string; word: 'blocks' | 'fix' | 'waived' }> = {
  blocks: { ring: 'bg-destructive text-white', word: 'blocks' },
  fix: { ring: 'bg-warning text-black', word: 'fix' },
  waived: { ring: 'bg-waived text-white', word: 'waived' },
}

/** Markers positioned every frame from the camera: they stay on their spot through pan, zoom and flip. */
function Overlay({ viewer, findings, active, onPick }: { viewer: KcViewer; findings: FileFinding[]; active: string | null; onPick: (f: FileFinding) => void }) {
  const [pos, setPos] = useState<Record<string, KcPoint>>({})
  useEffect(() => {
    let frame = 0
    let last = ''
    const tick = () => {
      const m = viewer.viewport.camera.matrix
      const next: Record<string, KcPoint> = {}
      for (const f of findings) next[f.id] = m.transform({ x: f.x_mm, y: f.y_mm })
      const key = JSON.stringify(next)
      if (key !== last) {
        last = key
        setPos(next)
      }
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [viewer, findings])
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {findings.map((f, i) => {
        const p = pos[f.id]
        if (!p) return null
        return (
          <button
            key={f.id}
            type="button"
            tabIndex={-1}
            onClick={() => onPick(f)}
            title={f.text}
            className={cn('pointer-events-auto absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[11px] font-semibold shadow ring-2 ring-background', SEV[f.severity].ring, f.severity === 'waived' && 'opacity-70', active === f.id && 'size-7 ring-primary')}
            style={{ left: p.x, top: p.y }}
          >
            {i + 1}
          </button>
        )
      })}
    </div>
  )
}

export function KiCanvasView({ text, name, findings, size, board, fill }: { text: string; name: string; findings: FileFinding[]; size: ViewerProps['size']; board: boolean; /** fill the parent, no controls (compare panes) */ fill?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const [el, setEl] = useState<KcViewerElement | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [layers, setLayers] = useState<{ name: string; visible: boolean; color: string }[]>([])
  const [flipped, setFlipped] = useState(false)
  const [overlay, setOverlay] = useState(true)
  const [active, setActive] = useState<string | null>(null)
  const dark = useMediaQuery('(prefers-color-scheme: dark)') || (typeof document !== 'undefined' && document.documentElement.classList.contains('dark'))

  useEffect(() => {
    const h = host.current
    if (!h) return
    let live = true
    setEl(null)
    setErr(null)
    void loadKiCanvas()
      .then(async () => {
        if (!live) return
        const embed = document.createElement('kicanvas-embed')
        embed.setAttribute('controls', size === 'card' && !fill ? 'none' : 'basic')
        embed.setAttribute('controlslist', 'nodownload nofullscreen noflipview')
        embed.setAttribute('style', 'width:100%;height:100%;aspect-ratio:auto;max-height:none;background:transparent;font-family:inherit')
        const source = document.createElement('kicanvas-source')
        source.setAttribute('name', name)
        source.textContent = text // a text node: KiCanvas parses it as S-expressions; it is never HTML
        embed.append(source)
        h.replaceChildren(embed)
        const v = await waitForViewer(embed, board)
        if (!live) return
        // a board opens on the board itself, not the drawing sheet around it
        if (board) {
          v.viewer?.zoom_to_board?.()
          v.viewer?.draw()
        }
        setEl(v)
      })
      .catch((e: Error) => live && setErr(e.message))
    return () => {
      live = false
      h.replaceChildren()
    }
  }, [text, name, board, size, fill])

  // light and dark KiCad colour schemes
  useEffect(() => {
    if (!el?.viewer) return
    el.theme = dark || board ? 'witchhazel' : 'kicad'
    el.update_theme?.()
    el.viewer.paint()
    el.viewer.draw()
  }, [el, dark, board])

  useEffect(() => {
    if (!el?.viewer || !board) return
    setLayers([...el.viewer.layers.in_ui_order()].filter((l) => !l.name.startsWith(':')).map((l) => ({ name: l.name, visible: l.visible, color: l.color.to_css() })))
  }, [el, board])

  const viewer = el?.viewer
  const toggle = (name: string, on: boolean) => {
    const l = viewer?.layers.by_name(name)
    if (!l || !viewer) return
    l.visible = on
    viewer.draw()
    setLayers((ls) => ls.map((x) => (x.name === name ? { ...x, visible: on } : x)))
  }
  const preset = (match: (n: string) => boolean) => {
    if (!viewer) return
    for (const l of layers) {
      const b = viewer.layers.by_name(l.name)
      if (b) b.visible = match(l.name)
    }
    viewer.draw()
    setLayers((ls) => ls.map((x) => ({ ...x, visible: match(x.name) })))
  }
  const pick = (f: FileFinding) => {
    setActive(f.id)
    if (f.ref && viewer) {
      viewer.select(f.ref)
      viewer.zoom_to_selection()
    }
  }

  if (err)
    return (
      <div className={cn('flex flex-col items-center justify-center gap-2 p-6 text-center text-sm', size === 'card' ? 'h-[220px]' : AREA[size])}>
        <p className="font-medium">This {board ? 'board' : 'schematic'} could not be drawn here.</p>
        <p className="max-w-md text-muted-foreground">{err} Open it in KiCad instead: Download, then open the file in KiCad 8 or later.</p>
      </div>
    )

  const card = size === 'card' || !!fill
  return (
    <div className={cn('flex flex-col', fill ? 'h-full' : card ? 'h-[220px]' : AREA[size])}>
      {!card && (
        <Controls>
          {board && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!layers.length}>
                    <Layers /> Layers
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-[60vh] overflow-auto">
                  <DropdownMenuLabel>Show layers</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={(e) => { e.preventDefault(); preset(() => true) }}>All</DropdownMenuItem>
                  <DropdownMenuItem onSelect={(e) => { e.preventDefault(); preset((n) => n.startsWith('F.') || n === 'Edge.Cuts') }}>Front only</DropdownMenuItem>
                  <DropdownMenuItem onSelect={(e) => { e.preventDefault(); preset((n) => n.startsWith('B.') || n === 'Edge.Cuts') }}>Back only</DropdownMenuItem>
                  <DropdownMenuItem onSelect={(e) => { e.preventDefault(); preset((n) => n.endsWith('.Cu') || n === 'Edge.Cuts') }}>Copper only</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {layers.map((l) => (
                    <DropdownMenuCheckboxItem key={l.name} checked={l.visible} onCheckedChange={(v) => toggle(l.name, !!v)} onSelect={(e) => e.preventDefault()}>
                      <span className="mr-1 inline-block size-2.5 rounded-sm" style={{ background: l.color }} aria-hidden />
                      <span className="font-mono text-xs">{l.name}</span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={!viewer?.flip_view}
                aria-pressed={flipped}
                onClick={() => {
                  viewer?.flip_view?.()
                  setFlipped((f) => !f)
                }}
              >
                <FlipHorizontal2 /> {flipped ? 'Bottom side' : 'Top side'}
              </Button>
            </>
          )}
          <div className="flex items-center gap-2">
            <Switch id={`ov-${name}`} checked={overlay} onCheckedChange={setOverlay} disabled={!findings.length} />
            <Label htmlFor={`ov-${name}`} className="text-xs font-normal">
              Findings overlay {findings.length ? `(${findings.length})` : '(none on this file)'}
            </Label>
          </div>
          <span className="ml-auto hidden text-muted-foreground md:inline">Drag to pan · scroll to zoom · tap a part to select it</span>
        </Controls>
      )}
      <div className="flex min-h-0 flex-1">
        <div className={cn('relative min-h-0 flex-1', dark || board ? 'bg-[#131218]' : 'bg-[#f5f4ef]')}>
          <div ref={host} className="absolute inset-0" />
          {!viewer && (
            <div className="absolute inset-0">
              <ViewerLoading size={size} label={`Drawing the ${board ? 'board' : 'schematic'}`} />
            </div>
          )}
          {viewer && overlay && findings.length > 0 && <Overlay viewer={viewer} findings={findings} active={active} onPick={pick} />}
        </div>
        {!card && findings.length > 0 && (
          <aside className="hidden w-72 shrink-0 overflow-auto border-l p-3 lg:block" aria-label="Findings">
            <p className="section-label mb-2">Findings on this {board ? 'board' : 'sheet'}</p>
            <ol className="space-y-2">
              {findings.map((f, i) => (
                <li key={f.id}>
                  <button type="button" onClick={() => pick(f)} className={cn('w-full rounded-lg border p-2.5 text-left text-sm hover:bg-accent', active === f.id && 'border-primary')}>
                    <div className="mb-1 flex items-center gap-2">
                      <span className="font-mono text-xs">{i + 1}</span>
                      <StatusBadge status={SEV[f.severity].word} />
                      {f.ref && <span className="ml-auto font-mono text-xs text-muted-foreground">{f.ref}</span>}
                    </div>
                    <p className={cn(f.severity === 'waived' && 'text-muted-foreground')}>{f.text}</p>
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>
    </div>
  )
}

export default function KiCadViewer({ file, size, commit }: ViewerProps) {
  const q = useFileText(file, { commit })
  const board = extOf(file.path) === 'kicad_pcb'
  const findings = useMemo(() => (commit ? [] : (file.findings ?? [])), [file.findings, commit])
  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (q.data === undefined) return <ViewerLoading size={size} />
  return (
    <>
      <KiCanvasView text={q.data} name={baseName(file.path)} findings={findings} size={size} board={board} />
      {size === 'page' && commit && <Note>Findings are shown on the current version only.</Note>}
    </>
  )
}

/** Two versions side by side (each pans on its own: KiCanvas has no shared camera to lock). */
export function KiCadCompare({ file, before, after, beforeLabel, afterLabel, size }: { file: ViewerProps['file']; before: string; after: string; beforeLabel: string; afterLabel: string; size: ViewerProps['size'] }) {
  const board = extOf(file.path) === 'kicad_pcb'
  return (
    <div className={cn('flex flex-col', AREA[size])}>
      <Controls>
        <span>
          {beforeLabel} → {afterLabel}
        </span>
        <span className="ml-auto text-muted-foreground">Side by side; each pans on its own. A locked difference overlay needs both drawn as pictures (kicad.export), which this view does not ask for yet.</span>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void downloadFile(file)}>
          <Download /> Open in KiCad
        </Button>
      </Controls>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-border md:grid-cols-2">
        {[[before, beforeLabel], [after, afterLabel]].map(([t, l]) => (
          <div key={l} className="relative min-h-0 bg-background">
            <span className="absolute left-2 top-2 z-10 rounded bg-background/90 px-1.5 py-0.5 font-mono text-[11px]">{l}</span>
            <KiCanvasView text={t!} name={`${l}-${baseName(file.path)}`} findings={[]} size="sheet" fill board={board} />
          </div>
        ))}
      </div>
    </div>
  )
}

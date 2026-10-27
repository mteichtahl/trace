/**
 * Findings drawn where they are (docs/user-journey.md, "Findings marked on sheets and boards"): numbered markers on the
 * sheet or board, each matching its row in the list beside it. Tapping a marker or a row selects both. Severity is a
 * colour, a shape and a word: red circle blocks the gate, amber diamond must be fixed or waived, grey square is waived.
 *
 * The drawing is the SVG trace exports (`kicad.export`), fetched through files.url; without one the frame says so
 * rather than drawing something made up.
 */
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { CanvasFrame } from '@/components/canvas/canvas-frame'
import { EvidenceChip } from '@/components/evidence-chip'
import { StatusBadge } from '@/components/status-badge'
import { q } from '@/lib/queries'
import type { PictureFinding } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

export const SEVERITY = {
  blocks: { word: 'Blocks the gate', status: 'blocks' as const, cls: 'bg-destructive text-white', shape: 'rounded-full' },
  fix: { word: 'Fix or waive', status: 'fix' as const, cls: 'bg-warning text-black', shape: 'rotate-45 rounded-[3px]' },
  waived: { word: 'Waived', status: 'waived' as const, cls: 'bg-waived text-white', shape: 'rounded-[3px]' },
}

/** A signed address for a project file (files.url); undefined while loading or when there is no path. */
export function useFileUrl(repo: string, path?: string) {
  return useQuery({ ...q('files.url', { repo, path: path ?? '' }), enabled: !!path, staleTime: 5 * 60_000 })
}

export function Marker({ n, severity, selected, onClick, label }: { n: number; severity: PictureFinding['severity']; selected?: boolean; onClick?: () => void; label: string }) {
  const s = SEVERITY[severity]
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick?.() }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={label}
      aria-pressed={selected}
      className={cn('flex size-6 items-center justify-center text-[11px] font-semibold shadow-sm ring-offset-1 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', s.cls, s.shape, selected && 'ring-2 ring-primary')}
    >
      <span className={cn(severity === 'fix' && '-rotate-45')}>{n}</span>
    </button>
  )
}

export interface FindingsPictureProps {
  repo: string
  title: ReactNode
  subtitle?: ReactNode
  path?: string
  /** a ready address (a data: URL or signed link) in place of path */
  url?: string
  findings: PictureFinding[]
  selected?: string | null
  onSelect?: (id: string | null) => void
  /** what to say when there is no drawing */
  emptyText?: string
  height?: number | string
  layers?: { id: string; label: string; on: boolean }[]
  onLayer?: (id: string, on: boolean) => void
  onAsk?: () => void
  className?: string
}

export function FindingsPicture({ repo, title, subtitle, path, url, findings, selected, onSelect, emptyText, height = 380, layers, onLayer, onAsk, className }: FindingsPictureProps) {
  const file = useFileUrl(repo, url ? undefined : path)
  const src = url ?? file.data?.url
  const placed = findings.filter((f) => f.at)
  return (
    <CanvasFrame title={title} subtitle={subtitle} height={height} layers={layers} onLayer={onLayer} onAsk={onAsk} className={className}>
      {src ? (
        <div className="relative inline-block max-h-full max-w-full" onClick={() => onSelect?.(null)}>
          <img src={src} alt={typeof title === 'string' ? `${title}, with ${placed.length} finding markers` : 'Drawing with finding markers'} className="block max-h-[calc(100%-8px)] max-w-full select-none" draggable={false} style={{ maxHeight: typeof height === 'number' ? height - 16 : undefined }} />
          {placed.map((f) => {
            const n = findings.indexOf(f) + 1
            return (
              <div key={f.id} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${f.at!.x * 100}%`, top: `${f.at!.y * 100}%` }}>
                {f.id === selected && <span className="pointer-events-none absolute left-1/2 top-1/2 size-12 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed border-primary" aria-hidden />}
                <Marker n={n} severity={f.severity} selected={f.id === selected} onClick={() => onSelect?.(f.id)} label={`Finding ${n}: ${SEVERITY[f.severity].word}. ${f.text}`} />
              </div>
            )
          })}
        </div>
      ) : (
        <p className="max-w-sm px-6 text-center text-sm text-muted-foreground">
          {file.isLoading ? 'Loading the drawing…' : file.isError ? 'The drawing could not be loaded. The findings are listed below.' : (emptyText ?? 'No drawing yet: trace draws it from the KiCad export after the next push.')}
        </p>
      )}
    </CanvasFrame>
  )
}

export interface FindingsListProps {
  findings: PictureFinding[]
  selected?: string | null
  onSelect?: (id: string) => void
  /** actions per finding (Waive…) */
  actions?: (f: PictureFinding) => ReactNode
  empty?: ReactNode
  className?: string
}

export function FindingsList({ findings, selected, onSelect, actions, empty = 'No findings: clean.', className }: FindingsListProps) {
  if (!findings.length) return <p className={cn('rounded-xl border border-dashed px-5 py-4 text-sm text-muted-foreground', className)}>{empty}</p>
  return (
    <ol className={cn('divide-y rounded-xl border', className)}>
      {findings.map((f, i) => (
        <li key={f.id} className={cn('flex flex-wrap items-start gap-3 px-4 py-3.5 transition-colors', f.id === selected && 'bg-primary/5', f.severity === 'waived' && 'text-muted-foreground')}>
          <Marker n={i + 1} severity={f.severity} selected={f.id === selected} onClick={() => onSelect?.(f.id)} label={`Show finding ${i + 1}`} />
          <div className="min-w-0 flex-1">
            <StatusBadge status={SEVERITY[f.severity].status} />
            <p className="mt-1 text-sm">
              {f.text}
              {f.where && <span className="text-muted-foreground"> · {f.where}</span>}
            </p>
            {f.source && <div className="mt-1.5"><EvidenceChip evidence={f.source} /></div>}
          </div>
          <div className="flex shrink-0 gap-2">
            {f.at && onSelect && (
              <Button variant="outline" size="sm" onClick={() => onSelect(f.id)}>
                Show on {f.sheet ? 'sheet' : 'board'}
              </Button>
            )}
            {actions?.(f)}
          </div>
        </li>
      ))}
    </ol>
  )
}

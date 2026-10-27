/**
 * The architecture block diagram (docs/user-journey.md, "Architecture block diagram"): each block with its name, its
 * key part with stock, and the requirements it serves; each connection with what flows along it. Positions are
 * fractions of the frame, so options compare with the layout held still.
 */
import { StatusBadge } from '@/components/status-badge'
import type { Block } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

const W = 860
const H = 380
const BW = 200
const BH = 92

export function BlockDiagram({ blocks, connections, selected, onSelect }: { blocks: Block[]; connections: { from: string; to: string; label: string }[]; selected?: string | null; onSelect?: (b: Block) => void }) {
  const at = new Map(blocks.map((b) => [b.id, { x: b.x * (W - BW), y: b.y * (H - BH) }]))
  return (
    <div className="relative" style={{ width: W, height: H }} role="group" aria-label="Block diagram">
      <svg className="pointer-events-none absolute inset-0" width={W} height={H} aria-hidden>
        {connections.map((c) => {
          const a = at.get(c.from)
          const b = at.get(c.to)
          if (!a || !b) return null
          const x1 = a.x + BW / 2, y1 = a.y + BH / 2, x2 = b.x + BW / 2, y2 = b.y + BH / 2
          return (
            <g key={`${c.from}-${c.to}`}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--muted-foreground)" strokeWidth={1.5} markerEnd="url(#arrow)" />
              <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" fontSize={11} fill="var(--muted-foreground)" style={{ paintOrder: 'stroke', stroke: 'var(--card)', strokeWidth: 4 }}>{c.label}</text>
            </g>
          )
        })}
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="var(--muted-foreground)" />
          </marker>
        </defs>
      </svg>
      {blocks.map((b) => {
        const p = at.get(b.id)!
        return (
          <button
            key={b.id}
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onSelect?.(b)}
            className={cn('absolute rounded-lg border-2 bg-card p-2.5 text-left text-xs shadow-xs hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', selected === b.id ? 'border-primary' : 'border-border', b.serves.length === 0 && 'border-dashed border-warning')}
            style={{ left: p.x, top: p.y, width: BW, height: BH }}
          >
            <span className="block text-sm font-semibold">{b.name}</span>
            {b.part && (
              <span className="mt-0.5 flex items-center gap-1.5">
                <span className="truncate font-mono">{b.part}</span>
                {b.stock && <StatusBadge plain status={b.stock === 'in_stock' ? 'met' : b.stock === 'low' ? 'warning' : 'failing'} label={b.stock === 'in_stock' ? 'In stock' : b.stock === 'low' ? 'Low stock' : 'Out of stock'} />}
              </span>
            )}
            <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{b.serves.length ? b.serves.join(' ') : 'Serves no requirement'}</span>
          </button>
        )
      })}
    </div>
  )
}

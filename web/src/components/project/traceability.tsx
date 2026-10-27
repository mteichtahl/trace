/**
 * The traceability view (docs/user-journey.md, "Traceability view"): intent statements, requirements and evidence in
 * three columns, each requirement linked back to the intent line it came from and forward to the test that proves it.
 * A failing result colours its whole chain back to the intent, so the person sees which promise is at risk. Boxes are
 * HTML (they wrap and take focus); the links are one SVG beneath them, on the same coordinates.
 */
import { useMemo } from 'react'
import { StatusBadge } from '@/components/status-badge'
import type { CoverageRow, TraceView } from '@/lib/types-s1'
import { cn } from '@/lib/utils'
import { VERDICT } from './shared'

const ROW = 70
const BOX = 58
const COL = { intent: { x: 0, w: 250 }, req: { x: 320, w: 280 }, ev: { x: 670, w: 230 } }
export const TRACE_WIDTH = COL.ev.x + COL.ev.w

export interface TraceNode {
  kind: 'intent' | 'requirement' | 'evidence'
  id: string
}

export interface TraceLayout {
  reqs: { row: CoverageRow; y: number; intent?: string; failing: boolean }[]
  intents: { id: string; topic: string; text: string; y: number; failing: boolean; uncovered: boolean }[]
  height: number
}

/** Place every box: requirements grouped under their intent line, intents centred on their requirements. Pure. */
export function layoutTrace(rows: CoverageRow[], trace: TraceView | undefined, filter?: (r: CoverageRow) => boolean): TraceLayout {
  const intentOf = new Map((trace?.links ?? []).map((l) => [l.requirement, l.intent]))
  const order = new Map((trace?.intent ?? []).map((i, n) => [i.id, n]))
  const shown = rows.filter((r) => !filter || filter(r))
  const sorted = [...shown].sort((a, b) => (order.get(intentOf.get(a.id) ?? '') ?? 99) - (order.get(intentOf.get(b.id) ?? '') ?? 99))
  const reqs = sorted.map((row, i) => ({ row, y: i * ROW, intent: intentOf.get(row.id), failing: row.verdict === 'failing' }))
  let spare = reqs.length
  const intents = (trace?.intent ?? []).map((it) => {
    const mine = reqs.filter((r) => r.intent === it.id)
    const y = mine.length ? (mine[0]!.y + mine[mine.length - 1]!.y) / 2 : spare++ * ROW
    return { ...it, y, failing: mine.some((r) => r.failing), uncovered: mine.length === 0 && !filter }
  }).filter((it) => !filter || reqs.some((r) => r.intent === it.id))
  const height = Math.max(reqs.length, ...intents.map((i) => i.y / ROW + 1), 1) * ROW
  return { reqs, intents, height }
}

export function Traceability({ rows, trace, filter, selected, onSelect }: {
  rows: CoverageRow[]
  trace?: TraceView
  filter?: (r: CoverageRow) => boolean
  selected?: string | null
  onSelect: (n: TraceNode) => void
}) {
  const l = useMemo(() => layoutTrace(rows, trace, filter), [rows, trace, filter])
  const iy = new Map(l.intents.map((i) => [i.id, i.y]))
  const mid = BOX / 2
  const path = (x1: number, y1: number, x2: number, y2: number) => `M${x1} ${y1 + mid} C${(x1 + x2) / 2} ${y1 + mid}, ${(x1 + x2) / 2} ${y2 + mid}, ${x2} ${y2 + mid}`
  return (
    <div className="relative" style={{ width: TRACE_WIDTH, height: l.height + 28 }} role="group" aria-label="Traceability: intent, requirements and evidence">
      <div className="absolute inset-x-0 top-0 flex text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="absolute" style={{ left: COL.intent.x }}>Intent</span>
        <span className="absolute" style={{ left: COL.req.x }}>Requirements</span>
        <span className="absolute" style={{ left: COL.ev.x }}>Evidence</span>
      </div>
      <div className="absolute inset-x-0 top-7" style={{ height: l.height }}>
        <svg className="pointer-events-none absolute inset-0" width={TRACE_WIDTH} height={l.height} aria-hidden>
          {l.reqs.map((r) => {
            const y0 = r.intent ? iy.get(r.intent) : undefined
            const stroke = r.failing ? 'var(--destructive)' : 'var(--border)'
            const w = r.failing ? 2 : 1.25
            return (
              <g key={r.row.id}>
                {y0 !== undefined && <path d={path(COL.intent.x + COL.intent.w, y0, COL.req.x, r.y)} stroke={stroke} strokeWidth={w} fill="none" />}
                <path d={path(COL.req.x + COL.req.w, r.y, COL.ev.x, r.y)} stroke={stroke} strokeWidth={w} fill="none" strokeDasharray={r.row.tests.length ? undefined : '4 3'} />
              </g>
            )
          })}
        </svg>
        {l.intents.map((it) => (
          <Box key={it.id} x={COL.intent.x} y={it.y} w={COL.intent.w} failing={it.failing} selected={selected === it.id} onClick={() => onSelect({ kind: 'intent', id: it.id })} label={`Intent ${it.topic}: ${it.text}`}>
            <span className="block text-[11px] text-muted-foreground">{it.topic}{it.uncovered ? ' · not covered' : ''}</span>
            <span className="line-clamp-2">{it.text}</span>
          </Box>
        ))}
        {l.reqs.map((r) => {
          const v = VERDICT[r.row.verdict]
          const test = r.row.tests[0]
          return (
            <div key={r.row.id}>
              <Box x={COL.req.x} y={r.y} w={COL.req.w} failing={r.failing} selected={selected === r.row.id} onClick={() => onSelect({ kind: 'requirement', id: r.row.id })} label={`${r.row.id}: ${r.row.text}`}>
                <span className="block font-mono text-[11px] text-muted-foreground">{r.row.id}</span>
                <span className="line-clamp-2">{r.row.text}</span>
              </Box>
              <Box x={COL.ev.x} y={r.y} w={COL.ev.w} failing={r.failing} selected={selected === `ev:${r.row.id}`} onClick={() => onSelect({ kind: 'evidence', id: r.row.id })} label={`Evidence for ${r.row.id}: ${v.label}`}>
                <StatusBadge status={v.status} label={v.label} plain />
                <span className="block truncate font-mono text-[11px] text-muted-foreground">{test ? `${test.id}${test.last_run ? ` · ${test.last_run}` : ''}` : 'no test planned'}</span>
              </Box>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Box({ x, y, w, failing, selected, onClick, label, children }: { x: number; y: number; w: number; failing?: boolean; selected?: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className={cn(
        'absolute overflow-hidden rounded-lg border bg-card px-2.5 py-1.5 text-left text-xs leading-snug shadow-xs hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        failing && 'border-destructive/60 bg-destructive/5',
        selected && 'ring-2 ring-primary',
      )}
      style={{ left: x, top: y, width: w, height: BOX }}
    >
      {children}
    </button>
  )
}

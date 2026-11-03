/**
 * The results chart: one panel of a ResultPlot (the chat's PlotData plus a log x axis) drawn with Recharts, the same
 * library and look as the chat's Plot card. It fits its box at any width (390 px phones up): the legend wraps under
 * the chart, axis labels stay 11 px. Zoom stays inside the box: drag across the chart (or use the buttons) to zoom
 * into a span of x, the arrows pan, Whole shows everything. At most MAX_POINTS points per series are drawn
 * (min/max-preserving, recomputed for the span in view) and the chart says so when it thins.
 */
import { ChevronLeft, ChevronRight, Minus, Plus, Scan } from 'lucide-react'
import { useMemo, useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { align, pickRows, windowRows } from '../parse/downsample'
import { type ResultPlot, fmtValue } from '../parse/series'

export const MAX_POINTS = 4000

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'oklch(0.6 0.15 320)', 'oklch(0.6 0.12 200)', 'oklch(0.55 0.1 40)']

/** Decade ticks (1, 10, 100 ...) across [a, b], with 2 and 5 when there are few decades. */
export function logTicks(a: number, b: number): number[] {
  if (!(a > 0) || !(b > a)) return []
  const lo = Math.floor(Math.log10(a))
  const hi = Math.ceil(Math.log10(b))
  const steps = hi - lo <= 2 ? [1, 2, 5] : [1]
  const out: number[] = []
  const stride = Math.max(1, Math.ceil((hi - lo) / 8))
  for (let e = lo; e <= hi; e += stride) for (const s of steps) {
    const v = s * 10 ** e
    if (v >= a * 0.999 && v <= b * 1.001) out.push(Number(v.toPrecision(3)))
  }
  return out
}

type Span = [number, number]

export function ResultChart({ plot, height, compact = false, className }: { plot: ResultPlot; height?: number | string; compact?: boolean; className?: string }) {
  const { xs, ys } = useMemo(() => align(plot.series), [plot.series])
  const full: Span = useMemo(() => [xs[0] ?? 0, xs[xs.length - 1] ?? 1], [xs])
  const log = !!plot.xLog && full[0] > 0
  const [span, setSpan] = useState<Span | null>(null)
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null)
  const [x0, x1] = span ?? full

  const rows = useMemo(() => {
    const [lo, hi] = windowRows(xs, x0, x1)
    // every series is drawn at the same rows (so a tooltip reads them all): at most MAX_POINTS rows in all
    const keep = pickRows(ys, MAX_POINTS, lo, hi)
    return keep.map((i) => {
      const r: Record<string, number | null> = { x: xs[i]! }
      ys.forEach((col, s) => (r[`s${s}`] = col[i] ?? null))
      return r
    })
  }, [xs, ys, x0, x1])
  const inView = useMemo(() => {
    const [lo, hi] = windowRows(xs, x0, x1)
    return hi - lo
  }, [xs, x0, x1])

  const ticks = log ? logTicks(x0, x1) : undefined
  const many = plot.series.length > 1
  const total = xs.length

  // zoom about the middle of the view, in log space for a log axis
  const tx = (v: number) => (log ? Math.log10(v) : v)
  const fx = (v: number) => (log ? 10 ** v : v)
  const zoom = (k: number) => {
    const a = tx(x0)
    const b = tx(x1)
    const mid = (a + b) / 2
    const half = ((b - a) * k) / 2
    const fa = tx(full[0])
    const fb = tx(full[1])
    if (half * 2 >= fb - fa) return setSpan(null)
    let na = mid - half
    let nb = mid + half
    if (na < fa) [na, nb] = [fa, fa + half * 2]
    if (nb > fb) [na, nb] = [fb - half * 2, fb]
    setSpan([fx(na), fx(nb)])
  }
  const pan = (d: number) => {
    const a = tx(x0)
    const b = tx(x1)
    const w = b - a
    const fa = tx(full[0])
    const fb = tx(full[1])
    let na = a + d * w * 0.4
    na = Math.max(fa, Math.min(fb - w, na))
    setSpan([fx(na), fx(na + w)])
  }
  const zoomed = span !== null

  const xFmt = (v: number) => fmtValue(v, plot.x.unit)
  const yFmt = (v: number) => fmtValue(v, plot.y.unit)

  return (
    <div className={cn('flex min-w-0 flex-col', className)}>
      <div className="w-full min-w-0 select-none text-xs" style={{ height: height ?? 280, touchAction: 'pan-y' }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={rows}
            margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
            onMouseDown={compact ? undefined : (s) => s?.activeLabel !== undefined && setDrag({ a: Number(s.activeLabel), b: Number(s.activeLabel) })}
            onMouseMove={compact ? undefined : (s) => drag && s?.activeLabel !== undefined && setDrag({ ...drag, b: Number(s.activeLabel) })}
            onMouseUp={compact ? undefined : () => {
              if (drag && drag.a !== drag.b) setSpan([Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)])
              setDrag(null)
            }}
            onMouseLeave={() => setDrag(null)}
          >
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="x"
              type="number"
              scale={log ? 'log' : 'linear'}
              domain={[x0, x1]}
              allowDataOverflow
              ticks={ticks}
              tickCount={compact ? 4 : 5}
              tickFormatter={xFmt}
              stroke="var(--muted-foreground)"
              fontSize={11}
              minTickGap={18}
              label={compact ? undefined : { value: plot.x.label, position: 'insideBottom', offset: -2, fontSize: 11, fill: 'var(--muted-foreground)' }}
              height={compact ? 24 : 38}
            />
            <YAxis tickFormatter={yFmt} stroke="var(--muted-foreground)" fontSize={11} width={compact ? 48 : 58} domain={['auto', 'auto']} />
            <Tooltip
              contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, maxWidth: 260 }}
              formatter={(v, name) => [yFmt(Number(v)), name]}
              labelFormatter={(v) => `${plot.x.label} ${xFmt(Number(v))}`}
              isAnimationActive={false}
            />
            {many && !compact && <Legend verticalAlign="bottom" wrapperStyle={{ fontSize: 11, lineHeight: '16px', paddingTop: 4 }} />}
            {plot.series.map((s, i) => (
              <Line key={`${s.name}-${i}`} dataKey={`s${i}`} name={s.name} stroke={COLORS[i % COLORS.length]} dot={false} strokeWidth={1.75} isAnimationActive={false} connectNulls />
            ))}
            {plot.limit && (
              <ReferenceLine y={plot.limit.value} stroke="var(--destructive)" strokeDasharray="4 3" label={{ value: plot.limit.label ?? 'limit', fill: 'var(--destructive)', fontSize: 11, position: 'insideTopRight' }} />
            )}
            {drag && drag.a !== drag.b && <ReferenceArea x1={drag.a} x2={drag.b} fill="var(--primary)" fillOpacity={0.12} />}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {!compact && (
        <div className="flex flex-wrap items-center gap-1 pt-1 text-xs text-muted-foreground">
          <Button variant="outline" size="icon" className="size-8" aria-label="Zoom in" onClick={() => zoom(0.5)}><Plus /></Button>
          <Button variant="outline" size="icon" className="size-8" aria-label="Zoom out" disabled={!zoomed} onClick={() => zoom(2)}><Minus /></Button>
          <Button variant="outline" size="icon" className="size-8" aria-label="Pan left" disabled={!zoomed || x0 <= full[0]} onClick={() => pan(-1)}><ChevronLeft /></Button>
          <Button variant="outline" size="icon" className="size-8" aria-label="Pan right" disabled={!zoomed || x1 >= full[1]} onClick={() => pan(1)}><ChevronRight /></Button>
          <Button variant="ghost" size="sm" className="h-8 text-xs" disabled={!zoomed} onClick={() => setSpan(null)}><Scan /> Whole</Button>
          <span className="ml-auto text-right" aria-live="polite">
            {inView > rows.length ? `Showing ${rows.length.toLocaleString()} of ${inView.toLocaleString()} points` : `${total.toLocaleString()} points`}
            {zoomed && ` · ${xFmt(x0)} to ${xFmt(x1)}`}
          </span>
        </div>
      )}
    </div>
  )
}

/** A file that draws as several panels (magnitude and phase, voltages and currents): a switch between them. */
export function PanelSwitch({ panels, value, onChange }: { panels: { panel?: string }[]; value: number; onChange: (i: number) => void }) {
  if (panels.length < 2) return null
  return (
    <div role="tablist" aria-label="What to draw" className="inline-flex flex-wrap rounded-md border p-0.5">
      {panels.map((p, i) => (
        <button
          key={i}
          type="button"
          role="tab"
          aria-selected={i === value}
          onClick={() => onChange(i)}
          className={cn('rounded px-2.5 py-1 text-xs', i === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent')}
        >
          {p.panel ?? `Panel ${i + 1}`}
        </button>
      ))}
    </div>
  )
}

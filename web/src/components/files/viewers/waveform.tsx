/**
 * Waveforms (.vcd): one lane per signal drawn in SVG at real pixels (text never scales down on a phone), the names in
 * a column that stays put while the lanes scroll, buses as labelled segments, zoom and pan in time, two cursors (a
 * tap places the chosen one, Shift+click places B) with the time between them and the frequency it implies, and each signal's value at the
 * cursor. The card shows the first lanes without controls.
 */
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { eng } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useFileText } from '../data'
import { type Vcd, type VcdSignal, busLabel, parseVcd, timeLabel, valueAt } from '../vcd'
import { AREA, Controls, Note, ViewerError, ViewerLoading, type ViewerProps } from './common'

const LANE = 28

function Lane({ s, t0, t1, width, y }: { s: VcdSignal; t0: number; t1: number; width: number; y: number }) {
  const x = (t: number) => ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0 || 1)) * width
  const top = y + 5
  const bot = y + LANE - 7
  const changes = s.changes.filter(([t], i) => t <= t1 && (s.changes[i + 1]?.[0] ?? Infinity) >= t0)
  if (s.width <= 1 && s.type !== 'real') {
    let d = ''
    changes.forEach(([t, v], i) => {
      const nx = x(changes[i + 1]?.[0] ?? t1)
      const level = v === '1' || v === 'h' ? top : v === '0' || v === 'l' ? bot : (top + bot) / 2
      d += `${i === 0 ? 'M' : 'L'}${x(t)},${level} L${nx},${level} `
    })
    const unknown = changes.filter(([, v]) => !'01hl'.includes(v))
    return (
      <g>
        <path d={d} fill="none" stroke="var(--chart-1)" strokeWidth={1.5} />
        {unknown.map(([t, v], i) => {
          const end = changes[changes.findIndex((c) => c[0] === t) + 1]?.[0] ?? t1
          return <rect key={i} x={x(t)} y={top} width={Math.max(0, x(end) - x(t))} height={bot - top} fill={v === 'z' ? 'var(--waived)' : 'var(--destructive)'} opacity={0.18} />
        })}
      </g>
    )
  }
  return (
    <g>
      {changes.map(([t, v], i) => {
        const a = x(t)
        const b = x(changes[i + 1]?.[0] ?? t1)
        const label = s.type === 'real' ? v : busLabel(v, s.width)
        const unknown = /x|z/i.test(label)
        const w = b - a
        return (
          <g key={i}>
            <path d={`M${a},${(top + bot) / 2} L${a + 3},${top} L${b - 3},${top} L${b},${(top + bot) / 2} L${b - 3},${bot} L${a + 3},${bot} Z`} fill={unknown ? 'var(--muted)' : 'color-mix(in oklch, var(--chart-1) 12%, transparent)'} stroke="var(--chart-1)" strokeWidth={1} />
            {w > label.length * 6.5 + 8 && (
              <text x={(a + b) / 2} y={(top + bot) / 2 + 4} textAnchor="middle" className="fill-foreground font-mono text-[10px]">
                {label}
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
}

/** The width of a box, live (ResizeObserver), so lanes are drawn in real pixels and text never scales down. */
function useWidth(ref: React.RefObject<HTMLElement | null>, fallback: number): number {
  const [w, setW] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth || fallback)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setW(el.clientWidth || fallback))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, fallback])
  return w
}

export function Waves({ vcd, size }: { vcd: Vcd; size: ViewerProps['size'] }) {
  const card = size === 'card'
  const signals = card ? vcd.signals.slice(0, 4) : vcd.signals
  const [view, setView] = useState<[number, number]>([0, vcd.end || 1])
  const [a, setA] = useState<number | null>(null)
  const [b, setB] = useState<number | null>(null)
  const [next, setNext] = useState<'A' | 'B'>('A')
  const box = useRef<HTMLDivElement>(null)
  const boxW = useWidth(box, 800)
  const narrow = boxW < 560
  // the names column: wide enough for the longest name (12 px monospace is ~7.2 px a character), capped on phones
  const longest = Math.max(4, ...signals.map((s) => s.name.length + (!card && a !== null ? 5 : 0)))
  const nameW = Math.round(Math.min(narrow ? 120 : 220, Math.max(72, longest * 7.2 + 14)))
  const width = Math.max(240, boxW - nameW - 2)
  const [t0, t1] = view
  const toT = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect()
    const px = clientX - r.left
    return Math.round(t0 + (Math.max(0, Math.min(width, px)) / width) * (t1 - t0))
  }
  const zoom = (k: number) => {
    const mid = a ?? (t0 + t1) / 2
    const half = Math.max(1, ((t1 - t0) * k) / 2)
    let lo = Math.max(0, Math.round(mid - half))
    let hi = Math.min(vcd.end || 1, Math.round(mid + half))
    if (hi - lo < 2) [lo, hi] = [Math.max(0, lo - 1), hi + 1]
    setView([lo, hi])
  }
  const pan = (d: number) => {
    const w = t1 - t0
    const lo = Math.max(0, Math.min((vcd.end || 1) - w, Math.round(t0 + d * w * 0.4)))
    setView([lo, lo + w])
  }
  const whole = t0 === 0 && t1 === (vcd.end || 1)
  const xOf = (t: number) => ((t - t0) / (t1 - t0 || 1)) * width
  const delta = a !== null && b !== null ? Math.abs(b - a) : null
  const deltaS = delta !== null ? delta * vcd.timescale.seconds : null
  const lanesH = signals.length * LANE
  const ticks = useMemo(() => {
    const n = Math.max(2, Math.min(6, Math.floor(width / 90)))
    return Array.from({ length: n + 1 }, (_, i) => t0 + ((t1 - t0) * i) / n)
  }, [t0, t1, width])
  const place = (e: React.MouseEvent<SVGSVGElement>) => {
    const t = toT(e.clientX, e.currentTarget)
    if (e.shiftKey || next === 'B') {
      setB(t)
      if (!e.shiftKey) setNext('A')
    } else {
      setA(t)
      if (b === null && narrow) setNext('B')
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      {!card && (
        <Controls>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => zoom(0.5)}>Zoom in</Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={whole} onClick={() => zoom(2)}>Zoom out</Button>
          <Button size="icon" variant="outline" className="size-7" aria-label="Earlier" disabled={t0 <= 0} onClick={() => pan(-1)}><ChevronLeft /></Button>
          <Button size="icon" variant="outline" className="size-7" aria-label="Later" disabled={t1 >= (vcd.end || 1)} onClick={() => pan(1)}><ChevronRight /></Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={whole} onClick={() => setView([0, vcd.end || 1])}>Whole capture</Button>
          <div role="radiogroup" aria-label="A tap places cursor" className="inline-flex rounded-md border p-0.5">
            {(['A', 'B'] as const).map((c) => (
              <button key={c} type="button" role="radio" aria-checked={next === c} onClick={() => setNext(c)} className={cn('rounded px-2 py-0.5 text-xs', next === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent')}>
                Place {c}
              </button>
            ))}
          </div>
          {!narrow && <span className="text-muted-foreground">Click places the cursor (Shift+click places B)</span>}
          <span className="ml-auto font-mono" aria-live="polite">
            {a !== null && `A ${timeLabel(a, vcd.timescale)}`}
            {b !== null && ` · B ${timeLabel(b, vcd.timescale)}`}
            {deltaS !== null && deltaS > 0 && ` · Δ ${timeLabel(delta!, vcd.timescale)} (${eng(1 / deltaS, 'Hz')})`}
          </span>
        </Controls>
      )}
      <div ref={box} className={cn('min-h-0 min-w-0 flex-1 overflow-auto', card && 'max-h-[220px]')}>
        <div className="flex" style={{ width: nameW + width }}>
          <div className="sticky left-0 z-10 shrink-0 border-r bg-background" style={{ width: nameW }}>
            {signals.map((s, i) => (
              <div key={`${s.scope}.${s.name}.${i}`} className="flex items-center gap-1 truncate px-2 font-mono text-xs" style={{ height: LANE }} title={`${s.scope ? `${s.scope}.` : ''}${s.name}${s.width > 1 ? ` [${s.width - 1}:0]` : ''}`}>
                <span className="truncate">{s.name}</span>
                {!card && a !== null && <span className="shrink-0 text-muted-foreground">{busLabel(valueAt(s, a), s.width)}</span>}
              </div>
            ))}
            <div style={{ height: 20 }} />
          </div>
          <svg
            width={width}
            height={lanesH + 20}
            viewBox={`0 0 ${width} ${lanesH + 20}`}
            className="shrink-0 select-none"
            role="img"
            aria-label={`Waveform of ${signals.length} signals over ${timeLabel(vcd.end, vcd.timescale)}`}
            onClick={card ? undefined : place}
          >
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={xOf(t)} x2={xOf(t)} y1={0} y2={lanesH} stroke="var(--border)" />
                <text x={Math.min(width - 2, Math.max(2, xOf(t)))} y={lanesH + 14} textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'} className="fill-muted-foreground text-[11px]">
                  {timeLabel(Math.round(t), vcd.timescale)}
                </text>
              </g>
            ))}
            {signals.map((s, i) => (
              <Lane key={`${s.scope}.${s.name}.${i}`} s={s} t0={t0} t1={t1} width={width} y={i * LANE} />
            ))}
            {a !== null && a >= t0 && a <= t1 && <line x1={xOf(a)} x2={xOf(a)} y1={0} y2={lanesH} stroke="var(--primary)" strokeWidth={1.5} />}
            {b !== null && b >= t0 && b <= t1 && <line x1={xOf(b)} x2={xOf(b)} y1={0} y2={lanesH} stroke="var(--primary)" strokeDasharray="4 3" strokeWidth={1.5} />}
          </svg>
        </div>
      </div>
      {card && vcd.signals.length > 4 && <Note>First 4 of {vcd.signals.length} signals</Note>}
      {!card && (
        <Note>
          {vcd.signals.length} signals · {timeLabel(vcd.end, vcd.timescale)} captured. Decoded bus rows (I²C, SPI) and limits come from the run that made the capture; they are not in the file itself.
        </Note>
      )}
    </div>
  )
}

export default function WaveformViewer({ file, size, commit }: ViewerProps) {
  const q = useFileText(file, { commit })
  const vcd = useMemo(() => (q.data ? parseVcd(q.data) : null), [q.data])
  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (!vcd) return <ViewerLoading size={size} />
  if (!vcd.signals.length) return <Note>This file has no signals in it.</Note>
  return (
    <div className={cn('min-w-0', size !== 'card' && AREA[size])}>
      <Waves vcd={vcd} size={size} />
    </div>
  )
}

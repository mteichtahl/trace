/**
 * Waveforms (.vcd): one lane per signal drawn in SVG, buses as labelled segments, two cursors (click places A,
 * Shift+click places B) with the time between them and the frequency it implies, and each signal's value at the
 * cursor. The card shows the first lanes without controls.
 */
import { useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { eng } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useFileText } from '../data'
import { type Vcd, type VcdSignal, busLabel, parseVcd, timeLabel, valueAt } from '../vcd'
import { AREA, Controls, Note, ViewerError, ViewerLoading, type ViewerProps } from './common'

const LANE = 28
const NAME_W = 140

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

export function Waves({ vcd, size }: { vcd: Vcd; size: ViewerProps['size'] }) {
  const card = size === 'card'
  const signals = card ? vcd.signals.slice(0, 4) : vcd.signals
  const [view, setView] = useState<[number, number]>([0, vcd.end || 1])
  const [a, setA] = useState<number | null>(null)
  const [b, setB] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const width = 1000
  const [t0, t1] = view
  const toT = (clientX: number) => {
    const r = box.current?.querySelector('svg')?.getBoundingClientRect()
    if (!r) return 0
    const px = ((clientX - r.left) / r.width) * (width + NAME_W) - NAME_W
    return Math.round(t0 + (Math.max(0, Math.min(width, px)) / width) * (t1 - t0))
  }
  const zoom = (k: number) => {
    const mid = a ?? (t0 + t1) / 2
    const half = ((t1 - t0) * k) / 2
    setView([Math.max(0, Math.round(mid - half)), Math.min(vcd.end || 1, Math.round(mid + half))])
  }
  const xOf = (t: number) => NAME_W + ((t - t0) / (t1 - t0 || 1)) * width
  const delta = a !== null && b !== null ? Math.abs(b - a) : null
  const deltaS = delta !== null ? delta * vcd.timescale.seconds : null
  const h = signals.length * LANE + 22
  const ticks = useMemo(() => Array.from({ length: 6 }, (_, i) => t0 + ((t1 - t0) * i) / 5), [t0, t1])

  return (
    <div className="flex h-full flex-col">
      {!card && (
        <Controls>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => zoom(0.5)}>Zoom in</Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => zoom(2)}>Zoom out</Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setView([0, vcd.end || 1])}>Whole capture</Button>
          <span className="text-muted-foreground">Click to place cursor A, Shift+click for B</span>
          <span className="ml-auto font-mono" aria-live="polite">
            {a !== null && `A ${timeLabel(a, vcd.timescale)}`}
            {b !== null && ` · B ${timeLabel(b, vcd.timescale)}`}
            {deltaS !== null && deltaS > 0 && ` · Δ ${timeLabel(delta!, vcd.timescale)} (${eng(1 / deltaS, 'Hz')})`}
          </span>
        </Controls>
      )}
      <div ref={box} className={cn('min-h-0 flex-1 overflow-auto', card && 'max-h-[220px]')}>
        <svg
          viewBox={`0 0 ${width + NAME_W} ${h}`}
          className="w-full min-w-[640px] select-none"
          style={{ height: card ? undefined : h * 1.1 }}
          role="img"
          aria-label={`Waveform of ${signals.length} signals over ${timeLabel(vcd.end, vcd.timescale)}`}
          onClick={card ? undefined : (e) => (e.shiftKey ? setB(toT(e.clientX)) : setA(toT(e.clientX)))}
        >
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={xOf(t)} x2={xOf(t)} y1={0} y2={h - 18} stroke="var(--border)" />
              <text x={xOf(t)} y={h - 4} textAnchor={i === 0 ? 'start' : i === 5 ? 'end' : 'middle'} className="fill-muted-foreground text-[10px]">
                {timeLabel(Math.round(t), vcd.timescale)}
              </text>
            </g>
          ))}
          {signals.map((s, i) => (
            <g key={`${s.scope}.${s.name}.${i}`}>
              <text x={6} y={i * LANE + LANE / 2 + 3} className="fill-foreground font-mono text-[11px]">
                {s.name}
                {!card && a !== null && <tspan className="fill-muted-foreground"> {busLabel(valueAt(s, a), s.width)}</tspan>}
              </text>
              <g transform={`translate(${NAME_W},0)`}>
                <Lane s={s} t0={t0} t1={t1} width={width} y={i * LANE} />
              </g>
            </g>
          ))}
          {a !== null && a >= t0 && a <= t1 && <line x1={xOf(a)} x2={xOf(a)} y1={0} y2={h - 18} stroke="var(--primary)" strokeWidth={1.5} />}
          {b !== null && b >= t0 && b <= t1 && <line x1={xOf(b)} x2={xOf(b)} y1={0} y2={h - 18} stroke="var(--primary)" strokeDasharray="4 3" strokeWidth={1.5} />}
        </svg>
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
    <div className={cn(size !== 'card' && AREA[size])}>
      <Waves vcd={vcd} size={size} />
    </div>
  )
}

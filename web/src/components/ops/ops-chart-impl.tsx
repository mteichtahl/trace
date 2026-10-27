/**
 * One Operations widget drawn with shadcn Chart (Recharts), lazily loaded. Series are merged by time; bars stack when
 * there are several series. Tapping a point calls `onPick` with that moment, which opens the side sheet.
 */
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import type { OpsWidget } from '@/lib/admin-types'
import { axisTime, chartRows, momentLabel, seriesKey } from './ops-model'

/** Muted series colours, distinct from the accent (your move) and the status colours (red, amber, green), in both themes. */
const COLORS = ['oklch(0.5 0.08 255)', 'oklch(0.62 0.09 145)', 'oklch(0.66 0.1 80)', 'oklch(0.55 0.1 330)', 'oklch(0.6 0.07 195)', 'oklch(0.55 0.08 40)', 'oklch(0.5 0.03 260)', 'oklch(0.7 0.06 110)']

export interface OpsChartProps {
  widget: OpsWidget
  /** the range's step in ms, for axis labels */
  step: number
  selected?: number | null
  onPick?: (t: number) => void
}

export default function OpsChartImpl({ widget, step, selected, onPick }: OpsChartProps) {
  const rows = chartRows(widget)
  const keys = widget.series.map((s, i) => seriesKey(s, i))
  const config: ChartConfig = Object.fromEntries(widget.series.map((s, i) => [keys[i]!, { label: s.label, color: COLORS[i % COLORS.length] }]))
  const many = widget.series.length > 1
  const click = (s: unknown) => {
    const t = (s as { activePayload?: { payload?: { t?: number } }[] } | null)?.activePayload?.[0]?.payload?.t
    if (typeof t === 'number' && onPick) onPick(t)
  }
  // Recharts 2 finds its parts only as direct children, so these are an array, not a fragment
  const axes = [
    <CartesianGrid key="grid" vertical={false} strokeDasharray="3 3" />,
    <XAxis key="x" dataKey="t" type="category" tickLine={false} axisLine={false} tickMargin={6} minTickGap={24} tickFormatter={(t: number) => axisTime(t, step)} />,
    <YAxis key="y" tickLine={false} axisLine={false} width={36} tickFormatter={(v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : String(Math.round(v * 10) / 10))} />,
    <ChartTooltip key="tip" cursor content={<ChartTooltipContent labelFormatter={(t) => momentLabel(Number(t), step)} />} />,
    ...(many ? [<ChartLegend key="legend" content={<ChartLegendContent />} />] : []),
  ]
  const common = { data: rows, margin: { top: 8, right: 8, bottom: 0, left: 0 }, onClick: click, className: onPick ? 'cursor-pointer' : undefined }
  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full">
      {widget.kind === 'bar' ? (
        <BarChart {...common}>
          {axes}
          {keys.map((k, i) => (
            <Bar
              key={k}
              dataKey={k}
              stackId={many ? 'a' : undefined}
              fill={`var(--color-${k})`}
              radius={i === keys.length - 1 ? [3, 3, 0, 0] : 0}
              isAnimationActive={false}
              shape={(p: unknown) => {
                const b = p as { x: number; y: number; width: number; height: number; fill: string; payload: { t: number } }
                const on = selected !== null && selected !== undefined && b.payload.t === selected
                return <rect x={b.x} y={b.y} width={b.width} height={Math.max(0, b.height)} fill={b.fill} opacity={selected != null && !on ? 0.45 : 1} />
              }}
            />
          ))}
        </BarChart>
      ) : widget.kind === 'area' ? (
        <AreaChart {...common}>
          {axes}
          {keys.map((k) => (
            <Area key={k} dataKey={k} type="monotone" stackId={many ? 'a' : undefined} stroke={`var(--color-${k})`} fill={`var(--color-${k})`} fillOpacity={0.25} isAnimationActive={false} />
          ))}
        </AreaChart>
      ) : (
        <LineChart {...common}>
          {axes}
          {keys.map((k, i) => (
            <Line key={k} dataKey={k} type="monotone" stroke={`var(--color-${k})`} strokeWidth={2} strokeDasharray={i > 0 && /slow|p9|max/i.test(widget.series[i]!.label) ? '4 3' : undefined} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          ))}
        </LineChart>
      )}
    </ChartContainer>
  )
}

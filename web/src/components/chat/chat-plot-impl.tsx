/** A reply's plot drawn with Recharts (lazy: loads with the first plot): line, step, bar, scatter or area, hover values. */
import {
  Area, Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis,
} from 'recharts'
import { eng } from '@/lib/format'
import { type ChatPlot, categorical, plotRows } from './chat-plot'

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)']

const fmt = (v: unknown, unit?: string) => (typeof v === 'number' ? eng(v, unit) : String(v))

export default function ChatPlotImpl({ plot, tall }: { plot: ChatPlot; tall?: boolean }) {
  const rows = plotRows(plot)
  const words = categorical(plot)
  const kind = plot.kind ?? (words ? 'bar' : 'line')
  const axis = { stroke: 'var(--muted-foreground)', fontSize: 11 }
  return (
    <div className={tall ? 'h-full min-h-[320px] w-full text-xs' : 'h-56 w-full text-xs'}>
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: plot.x?.label ? 16 : 4, left: 4 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis
            dataKey="x"
            type={words ? 'category' : 'number'}
            domain={words ? undefined : ['dataMin', 'dataMax']}
            tickFormatter={(v: unknown) => fmt(v, plot.x?.unit)}
            label={plot.x?.label ? { value: plot.x.label, position: 'insideBottom', offset: -8, fill: 'var(--muted-foreground)', fontSize: 11 } : undefined}
            {...axis}
          />
          <YAxis
            tickFormatter={(v: unknown) => fmt(v, plot.y?.unit)}
            width={60}
            label={plot.y?.label ? { value: plot.y.label, angle: -90, position: 'insideLeft', fill: 'var(--muted-foreground)', fontSize: 11 } : undefined}
            {...axis}
          />
          <Tooltip
            contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
            formatter={(v) => fmt(v, plot.y?.unit)}
            labelFormatter={(v) => `${plot.x?.label ?? ''} ${fmt(v, plot.x?.unit)}`.trim()}
          />
          {plot.series.length > 1 && <Legend />}
          {plot.series.map((s, i) => {
            const c = COLORS[i % COLORS.length]
            if (kind === 'bar') return <Bar key={s.name} dataKey={s.name} fill={c} isAnimationActive={false} />
            if (kind === 'scatter') return <Scatter key={s.name} dataKey={s.name} fill={c} isAnimationActive={false} />
            if (kind === 'area') return <Area key={s.name} dataKey={s.name} stroke={c} fill={c} fillOpacity={0.15} type="linear" isAnimationActive={false} connectNulls />
            return <Line key={s.name} dataKey={s.name} stroke={c} dot={false} strokeWidth={2} type={kind === 'step' ? 'stepAfter' : 'linear'} isAnimationActive={false} connectNulls />
          })}
          {plot.limit && (
            <ReferenceLine
              y={plot.limit.value}
              stroke="var(--destructive)"
              strokeDasharray="4 3"
              label={{ value: plot.limit.label ?? `${plot.limit.kind ?? 'limit'} ${fmt(plot.limit.value, plot.y?.unit)}`, fill: 'var(--destructive)', fontSize: 11, position: 'insideTopRight' }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

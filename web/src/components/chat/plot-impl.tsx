/** The Plot card's chart (lazy: Recharts loads with the first plot). Series, a limit line and hover values. */
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { eng } from '@/lib/format'
import type { PlotData } from './cards'

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-5)']

export default function PlotImpl({ data }: { data: PlotData }) {
  const xs = [...new Set(data.series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b)
  const rows = xs.map((x) => {
    const r: Record<string, number> = { x }
    for (const s of data.series) {
      const p = s.points.find((q) => q[0] === x)
      if (p) r[s.name] = p[1]
    }
    return r
  })
  return (
    <div className="h-52 w-full text-xs">
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
          <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(v: number) => eng(v, data.x.unit)} stroke="var(--muted-foreground)" fontSize={11} />
          <YAxis tickFormatter={(v: number) => eng(v, data.y.unit)} stroke="var(--muted-foreground)" fontSize={11} width={56} />
          <Tooltip
            contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
            formatter={(v: number) => eng(v, data.y.unit)}
            labelFormatter={(v: number) => `${data.x.label} ${eng(v, data.x.unit)}`}
          />
          {data.series.length > 1 && <Legend />}
          {data.series.map((s, i) => (
            <Line key={s.name} dataKey={s.name} stroke={COLORS[i % COLORS.length]} dot={false} strokeWidth={2} isAnimationActive={false} />
          ))}
          {data.limit && <ReferenceLine y={data.limit.value} stroke="var(--destructive)" strokeDasharray="4 3" label={{ value: data.limit.label ?? 'limit', fill: 'var(--destructive)', fontSize: 11, position: 'insideTopRight' }} />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

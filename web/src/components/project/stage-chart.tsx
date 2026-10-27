/** Days per stage (bars) with forecast days for what is current or queued, on Recharts (lazy: loads with the tab). */
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { money } from '@/lib/format'
import type { CostView } from '@/lib/types-s1'

export default function StageChart({ stages, currency }: { stages: CostView['stages']; currency: string }) {
  const rows = stages.map((s) => ({ stage: s.stage, days: s.days, forecast: Math.max(0, (s.forecastDays ?? 0) - s.days), cloud: s.cloud }))
  return (
    <div className="h-56 w-full text-xs">
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="stage" stroke="var(--muted-foreground)" fontSize={11} tickLine={false} />
          <YAxis stroke="var(--muted-foreground)" fontSize={11} allowDecimals={false} label={{ value: 'days', angle: -90, position: 'insideLeft', offset: 20, fill: 'var(--muted-foreground)', fontSize: 11 }} />
          <Tooltip
            contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
            formatter={(v: number, name: string, p: { payload?: { cloud: number | null } }) => (name === 'Days so far' ? [`${v} days${p.payload?.cloud != null ? ` · ${money(p.payload.cloud, currency)}` : ''}`, name] : [`${v} days`, name])}
          />
          <Legend />
          <Bar dataKey="days" name="Days so far" stackId="a" fill="var(--chart-1)" radius={[0, 0, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="forecast" name="Forecast" stackId="a" fill="var(--chart-5)" fillOpacity={0.45} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/**
 * shadcn/ui Chart: a Recharts container that takes a `config` of series (label and colour) and exposes the colours as
 * CSS variables (--color-<key>), with a tooltip and legend drawn in the app's theme. Import it only from lazily
 * loaded modules: it pulls in Recharts.
 */
import * as React from 'react'
import * as RechartsPrimitive from 'recharts'
import { cn } from '@/lib/utils'

export type ChartConfig = {
  [k in string]: { label?: React.ReactNode; icon?: React.ComponentType; color?: string }
}

type ChartContextProps = { config: ChartConfig }
const ChartContext = React.createContext<ChartContextProps | null>(null)

function useChart() {
  const context = React.useContext(ChartContext)
  if (!context) throw new Error('useChart must be used within a <ChartContainer />')
  return context
}

function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<'div'> & {
  config: ChartConfig
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children']
}) {
  const uniqueId = React.useId()
  const chartId = `chart-${id || uniqueId.replace(/:/g, '')}`
  const style = Object.fromEntries(Object.entries(config).filter(([, c]) => c.color).map(([k, c]) => [`--color-${k}`, c.color])) as React.CSSProperties
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        style={style}
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/60 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-layer]:outline-hidden [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector]:outline-hidden [&_.recharts-surface]:outline-hidden",
          className,
        )}
        {...props}
      >
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

const ChartTooltip = RechartsPrimitive.Tooltip

interface TooltipItem {
  name?: string | number
  dataKey?: string | number
  value?: number | string
  color?: string
  payload?: Record<string, unknown>
}

function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter,
  className,
}: {
  active?: boolean
  payload?: TooltipItem[]
  label?: string | number
  labelFormatter?: (label: string | number | undefined) => React.ReactNode
  valueFormatter?: (value: number) => string
  className?: string
}) {
  const { config } = useChart()
  if (!active || !payload?.length) return null
  return (
    <div className={cn('grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl', className)}>
      <div className="font-medium">{labelFormatter ? labelFormatter(label) : label}</div>
      <div className="grid gap-1">
        {payload.map((item) => {
          const key = String(item.dataKey ?? item.name ?? 'value')
          const c = config[key]
          return (
            <div key={key} className="flex w-full items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: item.color ?? c?.color }} aria-hidden />
              <span className="flex-1 text-muted-foreground">{c?.label ?? item.name}</span>
              <span className="font-mono font-medium tabular-nums text-foreground">
                {typeof item.value === 'number' ? (valueFormatter ? valueFormatter(item.value) : item.value.toLocaleString()) : item.value}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const ChartLegend = RechartsPrimitive.Legend

function ChartLegendContent({ payload, className }: { payload?: { value?: string; dataKey?: string | number; color?: string }[]; className?: string }) {
  const { config } = useChart()
  if (!payload?.length) return null
  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-3', className)}>
      {payload.map((item) => {
        const key = String(item.dataKey ?? item.value ?? '')
        const c = config[key]
        return (
          <div key={key} className="flex items-center gap-1.5">
            <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: item.color }} aria-hidden />
            <span className="text-muted-foreground">{c?.label ?? item.value}</span>
          </div>
        )
      })}
    </div>
  )
}

export { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent }

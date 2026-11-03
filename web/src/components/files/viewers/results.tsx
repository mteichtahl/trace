/**
 * Result files trace's tools keep, drawn as charts with the shared ResultChart:
 *
 *   SpiceViewer      ngspice rawfiles (<analysis>.raw): transient against time, AC magnitude and phase against a log
 *                    frequency, a DC sweep against its swept variable, an operating point as a table
 *   TouchstoneViewer .s1p ... .sNp: |Sij| in dB and phase against a log frequency, a switch per parameter
 *   SeriesChart      a numeric table's chart (the Table viewer's Chart view)
 *
 * Every panel fits a 390 px phone: the controls wrap, the chart fills the width and zooms inside its own box.
 */
import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { useFileText } from '../data'
import { baseName } from '../kinds'
import { type RawPlot, opRows, parseSpiceRaw, rawToPlots } from '../parse/spice-raw'
import { type ResultPlot, fmtValue } from '../parse/series'
import { parseTouchstone, touchstoneToPlots } from '../parse/touchstone'
import { PanelSwitch, ResultChart } from './chart'
import { AREA, Controls, Note, ViewerError, ViewerLoading, type ViewerProps } from './common'

// leaves room on a 844 px phone for the toolbar, the switch, the zoom row and the points line under the chart
const chartHeight = (size: ViewerProps['size']) => (size === 'card' ? 180 : 'clamp(200px, calc(100dvh - 520px), 520px)')

/** Panels with a switch, series toggles when there are many, and the chart. */
export function Panels({ panels, size, title }: { panels: ResultPlot[]; size: ViewerProps['size']; title?: string }) {
  const [at, setAt] = useState(0)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const p = panels[Math.min(at, panels.length - 1)]!
  const names = p.series.map((s) => s.name)
  const shown = useMemo(() => ({ ...p, series: p.series.filter((s) => !hidden.has(s.name)) }), [p, hidden])
  if (size === 'card')
    return (
      <div className="p-3">
        <p className="mb-1 truncate text-xs text-muted-foreground">{title ?? p.title}{p.panel ? ` · ${p.panel}` : ''}</p>
        <ResultChart plot={p} height={chartHeight(size)} compact />
      </div>
    )
  return (
    <div className={cn('flex min-w-0 flex-col overflow-y-auto overflow-x-hidden', AREA[size])}>
      {(title ?? p.title ?? '') !== '' || panels.length > 1 ? (
        <Controls>
          {(title ?? p.title) && <span className="min-w-0 max-w-full truncate font-medium text-foreground">{title ?? p.title}</span>}
          <PanelSwitch panels={panels} value={at} onChange={(i) => { setAt(i); setHidden(new Set()) }} />
        </Controls>
      ) : null}
      {names.length > 1 && (
        <div className="flex flex-wrap gap-1 px-3 pt-2" aria-label="Series">
          {names.map((n) => {
            const off = hidden.has(n)
            return (
              <button
                key={n}
                type="button"
                aria-pressed={!off}
                onClick={() => setHidden((h) => {
                  const x = new Set(h)
                  if (off) x.delete(n)
                  else if (x.size < names.length - 1) x.add(n)
                  return x
                })}
                className={cn('max-w-full truncate rounded-full border px-2 py-0.5 font-mono text-[11px]', off ? 'text-muted-foreground line-through opacity-60' : 'bg-accent')}
              >
                {n}
              </button>
            )
          })}
        </div>
      )}
      <div className="min-w-0 p-3">
        <ResultChart key={at} plot={shown} height={chartHeight(size)} />
      </div>
    </div>
  )
}

function OpTable({ plot, size }: { plot: RawPlot; size: ViewerProps['size'] }) {
  const rows = opRows(plot)
  const card = size === 'card'
  return (
    <div className={cn('overflow-auto', !card && AREA[size])}>
      {!card && (
        <Controls>
          <span className="font-medium text-foreground">{plot.kind === 'noise_total' ? 'Integrated noise' : 'Operating point'}{plot.title ? ` · ${plot.title}` : ''}</span>
          <span className="text-muted-foreground">{rows.length} values</span>
        </Controls>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="px-3 py-1.5 font-medium">Vector</th>
            <th className="px-3 py-1.5 text-right font-medium">Value</th>
          </tr>
        </thead>
        <tbody>
          {(card ? rows.slice(0, 6) : rows).map((r) => (
            <tr key={r.name} className="border-b last:border-0">
              <td className="break-all px-3 py-1.5 font-mono text-xs">{r.name}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">
                {fmtValue(r.value, r.unit, 4)}
                {r.imag ? ` ${r.imag < 0 ? '−' : '+'} j${fmtValue(Math.abs(r.imag), r.unit, 4)}` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {card && rows.length > 6 && <Note>6 of {rows.length} values</Note>}
    </div>
  )
}

export function SpiceViewer({ file, size, commit }: ViewerProps) {
  const q = useFileText(file, { commit })
  const parsed = useMemo(() => {
    if (q.data === undefined) return null
    try {
      return { plots: parseSpiceRaw(q.data) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }, [q.data])
  const [which, setWhich] = useState(0)
  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (!parsed) return <ViewerLoading size={size} />
  if ('error' in parsed) return <Note>This simulation result could not be read: {parsed.error}</Note>
  if (!parsed.plots.length) return <Note>This file holds no simulation results trace can read (it expects an ngspice ASCII rawfile).</Note>
  const plot = parsed.plots[Math.min(which, parsed.plots.length - 1)]!
  const panels = rawToPlots(plot)
  const picker = parsed.plots.length > 1 && size !== 'card' && (
    <Controls>
      <label className="flex items-center gap-2">
        <span className="text-muted-foreground">Analysis</span>
        <select className="h-7 max-w-[60vw] rounded border bg-background px-1" value={which} onChange={(e) => setWhich(Number(e.target.value))}>
          {parsed.plots.map((p, i) => <option key={i} value={i}>{p.plotname || `Plot ${i + 1}`}</option>)}
        </select>
      </label>
    </Controls>
  )
  const body = panels.length ? <Panels key={which} panels={panels} size={size} title={panels[0]!.title} /> : <OpTable plot={plot} size={size} />
  return picker ? <div className={cn('flex flex-col', AREA[size])}>{picker}<div className="min-h-0 flex-1 [&>*]:h-full">{body}</div></div> : body
}

export function TouchstoneViewer({ file, size, commit }: ViewerProps) {
  const q = useFileText(file, { commit })
  const panels = useMemo(() => {
    if (q.data === undefined) return null
    try {
      const t = parseTouchstone(q.data, baseName(file.path))
      return t.freq.length ? touchstoneToPlots(t, t.param === 'S' ? 'S-parameters' : `${t.param}-parameters`) : []
    } catch {
      return []
    }
  }, [q.data, file.path])
  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (!panels) return <ViewerLoading size={size} />
  if (!panels.length) return <Note>This Touchstone file has no frequency points trace can read.</Note>
  return <Panels panels={panels} size={size} />
}

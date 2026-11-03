/**
 * KiCad's ERC and DRC reports (kicad-cli's JSON: erc-report.json, drc-report.json) as a findings list: what blocks,
 * what to fix or waive, what is waived, with the sheet or the kind of item. "Show the file" shows the JSON itself.
 * The tools' findings files (pin-findings.json, findings.json) read the same way. Any other JSON (or one that does
 * not read as a report) shows as code.
 */
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { FindingsList } from '@/components/skills/findings'
import { cn } from '@/lib/utils'
import { useFileText } from '../data'
import { readKicadReport } from '../parse/kicad-report'
import { CodeText } from './code'
import { AREA, Controls, ViewerError, ViewerLoading, type ViewerProps } from './common'

export default function ReportViewer({ file, size, commit }: ViewerProps) {
  const q = useFileText(file, { commit })
  const report = useMemo(() => (q.data !== undefined ? readKicadReport(q.data) : null), [q.data])
  const [raw, setRaw] = useState(false)
  if (q.isError) return <ViewerError error={q.error} onRetry={() => void q.refetch()} />
  if (q.data === undefined) return <ViewerLoading size={size} />
  if (!report) return <CodeText text={q.data} lang="json" size={size} className={cn(size !== 'card' && AREA[size])} />
  const { counts } = report
  const summary = `${report.check === 'findings' ? 'Findings' : report.check.toUpperCase()}: ${counts.blocks} block${counts.blocks === 1 ? 's' : ''} · ${counts.fix} to fix or waive · ${counts.waived} waived`
  if (size === 'card')
    return (
      <div className="space-y-2 p-3">
        <p className="text-sm font-medium">{summary}</p>
        <FindingsList findings={report.findings.slice(0, 3)} empty="No violations: clean." />
        {report.findings.length > 3 && <p className="text-xs text-muted-foreground">3 of {report.findings.length} findings</p>}
      </div>
    )
  return (
    <div className={cn('flex min-w-0 flex-col', AREA[size])}>
      <Controls>
        <span className="font-medium text-foreground">{summary}</span>
        {report.version && <span className="text-muted-foreground">KiCad {report.version}</span>}
        <Button size="sm" variant="outline" className="ml-auto h-7 text-xs" aria-pressed={raw} onClick={() => setRaw(!raw)}>
          {raw ? 'Show the findings' : 'Show the file'}
        </Button>
      </Controls>
      {raw ? (
        <CodeText text={q.data} lang="json" size={size} className="min-h-0 flex-1" />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <FindingsList findings={report.findings} empty="No violations: clean." />
        </div>
      )}
    </div>
  )
}

/**
 * Interface parts inside the conversation (docs/ui-design.md, "Interface parts inside the chat"). Each is a plain
 * component taking the tool call's parameters and result; renderers.tsx registers them with CopilotKit's
 * useRenderTool / useHumanInTheLoop by tool name.
 */
import { ChevronRight, CircleCheck, CircleX, FileText, GitBranch, Loader2, TriangleAlert, Wrench } from 'lucide-react'
import { lazy, Suspense, useState, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { EvidenceChip } from '@/components/evidence-chip'
import { RunLine } from '@/components/run-line'
import { StatusBadge } from '@/components/status-badge'
import { count, eng, money } from '@/lib/format'
import type { EvidenceRef, RunSummary } from '@/lib/types'
import { cn } from '@/lib/utils'

export type ToolStatus = 'inProgress' | 'executing' | 'complete'

export function parseResult<T = unknown>(result: string | undefined): T | undefined {
  if (!result) return undefined
  try {
    return JSON.parse(result) as T
  } catch {
    return result as unknown as T
  }
}

const Frame = ({ children, className }: { children: ReactNode; className?: string }) => <div className={cn('my-2 rounded-xl border bg-card p-3 text-sm', className)}>{children}</div>

// ------------------------------------------------------------------ Tool row: any other tool call, one quiet line

/** "Read 3 datasheet pages", folded, with arguments and result inside. */
export function ToolRow({ name, args, result, status, summary, defaultOpen = false }: { name: string; args: unknown; result?: string; status: ToolStatus; summary?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const done = status === 'complete'
  const parsed = parseResult<Record<string, unknown>>(result)
  const line = summary ?? (typeof parsed === 'object' && parsed && typeof parsed.summary === 'string' ? parsed.summary : undefined)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-1">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs text-muted-foreground hover:bg-muted/60">
        {done ? <Wrench className="size-3.5" aria-hidden /> : <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        <span className="truncate">
          {line ?? (done ? 'Used' : 'Using')} <span className="font-mono">{name}</span>
        </span>
        <ChevronRight className="ml-auto size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 space-y-2 rounded-md border bg-muted/30 p-2 font-mono text-[11px]">
          <div>
            <p className="mb-0.5 font-sans text-muted-foreground">Arguments</p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{JSON.stringify(args, null, 2)}</pre>
          </div>
          {done && (
            <div>
              <p className="mb-0.5 font-sans text-muted-foreground">Result</p>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap">{typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)}</pre>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// ------------------------------------------------------------------ Run card

export interface RunCardData {
  run: RunSummary
  /** once done: the verdict in one sentence */
  verdict?: string
  ok?: boolean
}

export function RunCard({ data }: { data: RunCardData }) {
  if (data.verdict) {
    return (
      <Frame className="flex items-start gap-2">
        {data.ok ? <CircleCheck className="mt-0.5 size-4 text-verified" aria-hidden /> : <CircleX className="mt-0.5 size-4 text-destructive" aria-hidden />}
        <div>
          <p className="font-medium">{data.run.title}</p>
          <p className="text-muted-foreground">{data.verdict}</p>
        </div>
      </Frame>
    )
  }
  return <RunLine run={data.run} className="my-2 rounded-xl border bg-card px-3 py-3" />
}

// ------------------------------------------------------------------ Plot card (Recharts, lazy)

export interface PlotData {
  title: string
  x: { label: string; unit?: string }
  y: { label: string; unit?: string }
  series: { name: string; points: [number, number][] }[]
  limit?: { value: number; label?: string; kind?: 'min' | 'max' }
  verdict?: string
  ok?: boolean
  runId?: string
}

const PlotImpl = lazy(() => import('./plot-impl'))

export function PlotCard({ data }: { data: PlotData }) {
  return (
    <Frame>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="font-medium">{data.title}</p>
        {data.ok !== undefined && <StatusBadge status={data.ok ? 'passed' : 'failing'} />}
      </div>
      <Suspense fallback={<div className="h-48 animate-pulse rounded bg-muted" />}>
        <PlotImpl data={data} />
      </Suspense>
      {data.verdict && <p className="mt-2 text-muted-foreground">{data.verdict}</p>}
      {data.runId && (
        <div className="mt-2">
          <EvidenceChip evidence={{ kind: 'run', label: data.runId, id: data.runId }} />
        </div>
      )}
    </Frame>
  )
}

// ------------------------------------------------------------------ Findings card

export interface Finding {
  id: string
  severity: 'blocks' | 'fix' | 'waived'
  text: string
  where?: string
  source?: EvidenceRef
}
export interface FindingsData {
  check: string
  findings: Finding[]
  thumbnail?: string
}

export function FindingsCard({ data }: { data: FindingsData }) {
  const by = (s: Finding['severity']) => data.findings.filter((f) => f.severity === s).length
  return (
    <Frame>
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium">{data.check}</p>
        {by('blocks') > 0 && <StatusBadge status="blocks" label={`${by('blocks')} block the gate`} />}
        {by('fix') > 0 && <StatusBadge status="fix" label={`${by('fix')} fix or waive`} />}
        {by('waived') > 0 && <StatusBadge status="waived" label={`${by('waived')} waived`} />}
        {data.findings.length === 0 && <StatusBadge status="clean" />}
      </div>
      {data.thumbnail && <img src={data.thumbnail} alt={`${data.check}: thumbnail with finding markers`} className="mt-2 max-h-40 rounded border" />}
      <ol className="mt-2 space-y-1.5">
        {data.findings.slice(0, 3).map((f, i) => (
          <li key={f.id} className="flex gap-2">
            <span className={cn('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white', f.severity === 'blocks' ? 'bg-destructive' : f.severity === 'fix' ? 'bg-warning text-black' : 'bg-waived')}>{i + 1}</span>
            <span>
              {f.text}
              {f.where && <span className="text-muted-foreground"> · {f.where}</span>}
            </span>
          </li>
        ))}
      </ol>
      {data.findings.length > 3 && <p className="mt-1 text-xs text-muted-foreground">and {data.findings.length - 3} more</p>}
    </Frame>
  )
}

// ------------------------------------------------------------------ Part card

export interface PartData {
  mpn: string
  manufacturer?: string
  description?: string
  lcsc?: string
  stock?: number
  needed?: number
  price?: number
  currency?: string
  lifecycle?: 'active' | 'nrnd' | 'eol' | string
  datasheet?: string
  alternatives?: { mpn: string; note?: string }[]
}

export function PartCard({ data }: { data: PartData }) {
  const enough = data.stock !== undefined && data.needed !== undefined ? data.stock >= data.needed : undefined
  return (
    <Frame>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-mono font-medium">{data.mpn}</p>
          <p className="text-xs text-muted-foreground">{[data.manufacturer, data.description].filter(Boolean).join(' · ')}</p>
        </div>
        {data.lifecycle && <Badge variant={data.lifecycle === 'active' ? 'secondary' : 'outline'}>{data.lifecycle === 'eol' ? 'End of life' : data.lifecycle === 'nrnd' ? 'Not for new designs' : 'Active'}</Badge>}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
        {data.lcsc && (<><dt className="text-muted-foreground">LCSC</dt><dd className="font-mono">{data.lcsc}</dd></>)}
        {data.stock !== undefined && (
          <>
            <dt className="text-muted-foreground">In stock</dt>
            <dd>{enough === undefined ? count(data.stock) : <StatusBadge plain status={enough ? 'met' : 'not_met'} label={`${count(data.stock)}${data.needed ? ` for ${data.needed}` : ''}`} />}</dd>
          </>
        )}
        {data.price !== undefined && (<><dt className="text-muted-foreground">Price</dt><dd>{money(data.price, data.currency)}</dd></>)}
      </dl>
      {(data.datasheet || data.alternatives?.length) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {data.datasheet && <EvidenceChip evidence={{ kind: 'datasheet', label: 'Datasheet', to: data.datasheet }} />}
          {data.alternatives?.map((a) => <EvidenceChip key={a.mpn} evidence={{ kind: 'part', label: a.mpn, summary: a.note }} />)}
        </div>
      )}
    </Frame>
  )
}

// ------------------------------------------------------------------ File card (the viewer plugs in here)

export interface FileData {
  path: string
  kind?: string
  size?: number
  url?: string
}

/**
 * The File viewer's card size. The viewers themselves (KiCanvas, PDF.js, three.js, …) are another piece of work:
 * register one with `registerFileViewer(kind, Component)` and the card draws it.
 */
const viewers = new Map<string, (p: { file: FileData }) => ReactNode>()
export const registerFileViewer = (kind: string, render: (p: { file: FileData }) => ReactNode) => viewers.set(kind, render)

export function FileCard({ data }: { data: FileData }) {
  const ext = data.kind ?? data.path.split('.').pop() ?? ''
  const Viewer = viewers.get(ext)
  return (
    <Frame>
      <div className="flex items-center gap-2">
        <FileText className="size-4 text-muted-foreground" aria-hidden />
        <span className="truncate font-mono text-xs">{data.path}</span>
        {data.size !== undefined && <span className="ml-auto text-xs text-muted-foreground">{eng(data.size, 'B')}</span>}
      </div>
      {Viewer && <div className="mt-2">{Viewer({ file: data })}</div>}
    </Frame>
  )
}

// ------------------------------------------------------------------ Hand-off (SUBAGENT_* events)

export function HandOff({ specialist, steps, state }: { specialist: string; steps: string[]; state: 'running' | 'done' | 'error' }) {
  return (
    <Collapsible className="my-2 rounded-xl border bg-card p-3 text-sm">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left">
        {state === 'running' ? <Loader2 className="size-4 animate-spin text-primary" aria-hidden /> : state === 'error' ? <TriangleAlert className="size-4 text-warning-foreground" aria-hidden /> : <GitBranch className="size-4 text-muted-foreground" aria-hidden />}
        <span>
          Handed to the <span className="font-medium">{specialist}</span>
        </span>
        <span className="ml-auto text-xs text-muted-foreground">{steps.length} steps</span>
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="mt-2 space-y-1 border-l pl-3 text-xs text-muted-foreground">
          {steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * The agents map (docs/agents-screen.md): every agent as a box that says what it is doing on each project, and the
 * hand-offs between them as arrows. Drawn with React Flow in the Canvas frame, as the block diagram and traceability
 * views are. Selecting a box (click, tap, or Tab then Enter) lights its arrows and the agents it works with, and opens
 * its work and hand-offs in the side sheet, with a link to its own page. On a phone the boxes stack as cards
 * (`AgentCards`) and the hand-offs are listed below them on the page.
 *
 * Every line in a box is one line, cut with "…" when it is too long (the whole line is its tooltip), so nothing spills
 * out of a box.
 */
import { type Edge, Handle, MarkerType, type Node, type NodeProps, Position } from '@xyflow/react'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Circle, CircleDot, Loader2, TriangleAlert } from 'lucide-react'
import { memo, useCallback, useMemo, useState } from 'react'
import { FlowCanvas, FlowView, HANDLE, type Lit, litClass, litOf } from '@/components/canvas/flow'
import { StatusBadge, type Status } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { ago } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { AgentWork } from './use-agents'
import { type AgentLink, type AgentRow, COLUMNS, type LinkState, type Side, footerOf, layoutOf, linkedAgents, rowsOf, saysText, sidesFor } from './map-model'

/** One agent as the map draws it. */
export interface AgentView {
  id: string
  name: string
  does: string
  work: AgentWork | undefined
}

export const STATUS_OF: Record<AgentWork['status'], { status: Status; label: string }> = {
  working: { status: 'working', label: 'Working' },
  queued: { status: 'queued', label: 'Queued' },
  waiting_person: { status: 'yours', label: 'Waiting on a person' },
  stuck: { status: 'stuck', label: 'Stuck' },
  idle: { status: 'idle', label: 'Idle' },
}

/** the box's chip: short, so the agent's name keeps its room */
const CHIP: Record<AgentWork['status'], string> = { working: 'Working', queued: 'Queued', waiting_person: 'Waiting', stuck: 'Stuck', idle: 'Idle' }

const BOX: Record<AgentWork['status'], string> = {
  working: 'border-foreground/80 bg-card',
  waiting_person: 'border-primary bg-primary-soft',
  stuck: 'border-warning bg-warning/10',
  queued: 'border-dashed border-muted-foreground/50 bg-card',
  idle: 'border-border bg-card',
}

function StatusIcon({ status, className }: { status: AgentWork['status']; className?: string }) {
  const c = cn('size-4 shrink-0', className)
  if (status === 'working') return <Loader2 className={cn(c, 'animate-spin motion-reduce:animate-none')} aria-hidden />
  if (status === 'waiting_person') return <CircleDot className={cn(c, 'text-primary')} aria-hidden />
  if (status === 'stuck') return <TriangleAlert className={cn(c, 'text-warning-foreground')} aria-hidden />
  if (status === 'queued') return <Circle className={cn(c, 'text-muted-foreground')} aria-hidden />
  return <Circle className={cn(c, 'fill-muted-foreground/30 text-muted-foreground/40')} aria-hidden />
}

const BAR: Record<AgentRow['state'], string> = {
  running: 'bg-foreground',
  paused: 'bg-muted-foreground',
  waiting: 'bg-primary',
  stuck: 'bg-warning',
  queued: '',
}

/** A line's progress: a filled bar, a sliding bar when running with no known size, an empty dashed track when queued. */
function RowBar({ row }: { row: AgentRow }) {
  if (row.state === 'queued') return <span className="mt-1 ml-3.5 block h-1 rounded-full border border-dashed border-muted-foreground/40" aria-hidden />
  const known = row.progress !== null
  return (
    <span className="mt-1 ml-3.5 block h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
      <span
        className={cn('block h-1 rounded-full', BAR[row.state], !known && row.state === 'running' && 'bar-indeterminate')}
        style={known ? { width: `${Math.max(4, Math.round((row.progress ?? 0) * 100))}%` } : row.state === 'running' ? undefined : { width: '100%', opacity: 0.4 }}
      />
    </span>
  )
}

const LEAD: Record<AgentRow['state'], string> = { running: 'Working on', paused: 'Paused', queued: 'Queued', waiting: 'Waiting on a person', stuck: 'Stuck' }
const ROW_WORD: Record<AgentRow['state'], string> = { running: 'working on', paused: 'paused on', queued: 'queued for', waiting: 'waiting on a person about', stuck: 'stuck on' }

/** What a box says, shared by the map's boxes and the phone's cards. */
export function AgentBody({ view, rows, tones, showProject, max = 2 }: { view: AgentView; rows: AgentRow[]; tones: ReadonlyMap<string, string>; showProject: boolean; max?: number }) {
  const w = view.work
  const status = w?.status ?? 'idle'
  const projects = new Set(rows.map((r) => r.project)).size
  const shown = rows.slice(0, max)
  const hidden = rows.length - shown.length
  const footer = `${hidden ? `+${hidden} more ${hidden === 1 ? 'project' : 'projects'} · ` : ''}${footerOf(w)}`
  const chip = showProject && projects > 1 ? `${projects} projects` : CHIP[status]
  return (
    <span className="flex h-full min-w-0 flex-col text-xs leading-4">
      <span className="flex min-w-0 items-center gap-2 text-sm leading-5">
        <StatusIcon status={status} />
        <span className="min-w-0 flex-1 truncate font-semibold" title={view.name}>{view.name}</span>
        <span
          className={cn('shrink-0 rounded-full px-1.5 text-[11px] leading-[18px]',
            status === 'waiting_person' ? 'bg-primary/15 text-primary' : status === 'stuck' ? 'bg-warning/20 text-warning-foreground' : 'bg-muted text-muted-foreground')}
        >
          {chip}
        </span>
      </span>
      {shown.length === 0 ? (
        <span className="mt-2.5 line-clamp-3 text-muted-foreground" title={view.does}>{view.does}</span>
      ) : (
        <span className="mt-2.5 flex flex-col gap-2">
          {shown.map((r) => {
            const lead = showProject ? r.project : LEAD[r.state]
            return (
              <span key={`${r.repo}:${r.project}`} className="block min-w-0" title={`${r.project}: ${ROW_WORD[r.state]} ${r.title}${r.step ? ` (${r.step})` : ''}`}>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: tones.get(r.repo) ?? 'var(--muted-foreground)' }} aria-hidden />
                  <span className={cn('min-w-0 flex-1 truncate font-medium', r.state === 'waiting' ? 'text-primary' : r.state === 'stuck' ? 'text-warning-foreground' : 'text-muted-foreground')}>{lead}</span>
                  {r.step && <span className="shrink-0 text-muted-foreground tabular-nums">{r.step}</span>}
                </span>
                <span className={cn('ml-3.5 block truncate', r.state === 'queued' ? 'text-muted-foreground' : 'text-foreground')}>{r.title}</span>
                <RowBar row={r} />
              </span>
            )
          })}
        </span>
      )}
      <span className="mt-auto truncate pt-2 text-muted-foreground" title={footer}>{footer}</span>
    </span>
  )
}

// ------------------------------------------------------------------ the drawing

const W = 300
const H = 184
const GX = 72
const GY = 72

const SIDES: { side: Side; position: Position }[] = [
  { side: 'left', position: Position.Left }, { side: 'right', position: Position.Right }, { side: 'top', position: Position.Top }, { side: 'bottom', position: Position.Bottom },
]

type BoxData = { view: AgentView; rows: AgentRow[]; tones: ReadonlyMap<string, string>; showProject: boolean; lit: Lit }
type BoxNode = Node<BoxData, 'agent'>

const AgentBox = memo(function AgentBox({ data }: NodeProps<BoxNode>) {
  const status = data.view.work?.status ?? 'idle'
  return (
    <div
      className={cn(
        'rounded-xl border-2 p-3 text-left text-card-foreground shadow-xs transition-[opacity,box-shadow,border-color] duration-150 motion-reduce:transition-none hover:shadow-md',
        BOX[status],
        status === 'waiting_person' && 'ring-4 ring-primary/15',
        litClass(data.lit),
      )}
      style={{ width: W, height: H }}
    >
      {SIDES.map((s) => <Handle key={`t-${s.side}`} id={`t-${s.side}`} type="target" position={s.position} isConnectable={false} className={HANDLE} />)}
      {SIDES.map((s) => <Handle key={`s-${s.side}`} id={`s-${s.side}`} type="source" position={s.position} isConnectable={false} className={HANDLE} />)}
      <AgentBody view={data.view} rows={data.rows} tones={data.tones} showProject={data.showProject} />
    </div>
  )
})

const nodeTypes = { agent: AgentBox }

export const LINK_LOOK: Record<LinkState, { color: string; dashed: boolean; word: string }> = {
  running: { color: 'var(--foreground)', dashed: false, word: 'Being worked on' },
  waiting: { color: 'var(--muted-foreground)', dashed: true, word: 'Waiting its turn' },
  answered: { color: 'var(--verified)', dashed: false, word: 'Answered in the last hour' },
  ended: { color: 'var(--border)', dashed: true, word: 'Declined or failed in the last hour' },
}

/** The boxes and arrows for React Flow, lit for the selected agent. Pure apart from the JSX in each box. */
export function mapElements(views: readonly AgentView[], links: readonly AgentLink[], tones: ReadonlyMap<string, string>, showProject: boolean, selected: string | null): { nodes: BoxNode[]; edges: Edge[]; rows: number } {
  const cells = layoutOf(views.map((v) => v.id))
  const near = selected && cells.has(selected) ? linkedAgents(links, selected) : null
  const nodes: BoxNode[] = views.map((v) => {
    const c = cells.get(v.id)!
    const rows = rowsOf(v.work)
    const st = STATUS_OF[v.work?.status ?? 'idle'].label
    return {
      id: v.id, type: 'agent', position: { x: c.col * (W + GX), y: c.row * (H + GY) }, selected: v.id === selected, ariaRole: 'button',
      ariaLabel: `${v.name}: ${st}.${rows.length ? ` ${rows.map((r) => `${r.project}: ${ROW_WORD[r.state]} ${r.title}`).join('. ')}.` : ''} ${footerOf(v.work)}.`,
      data: { view: v, rows, tones, showProject, lit: litOf(near, selected, v.id) },
    }
  })
  const edges: Edge[] = links.flatMap((l) => {
    const a = cells.get(l.from)
    const b = cells.get(l.to)
    if (!a || !b) return []
    const on = near?.links.has(l.id) ?? false
    const faded = !!near && !on
    const look = LINK_LOOK[l.state]
    const color = on ? 'var(--primary)' : look.color
    const s = sidesFor(a, b)
    return [{
      id: l.id, source: l.from, target: l.to, sourceHandle: `s-${s.from}`, targetHandle: `t-${s.to}`, type: 'smoothstep', selectable: false, focusable: false, zIndex: on ? 1 : 0,
      animated: l.state === 'running' && !faded,
      label: String(l.items.length),
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      style: { stroke: color, strokeWidth: on ? 2.5 : 2, strokeDasharray: look.dashed && l.state !== 'running' ? '6 5' : undefined, opacity: faded ? 0.15 : 1, transition: 'opacity 150ms, stroke-width 150ms' },
      labelStyle: { fontSize: 11, fontWeight: 600, fill: l.state === 'running' ? 'var(--background)' : 'var(--foreground)', opacity: faded ? 0.25 : 1 },
      labelBgStyle: { fill: l.state === 'running' ? 'var(--foreground)' : l.state === 'answered' ? 'var(--verified)' : 'var(--card)', stroke: color, strokeWidth: 1.5, opacity: faded ? 0.25 : 1 },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 9,
    }]
  })
  const rows = Math.max(1, ...[...cells.values()].map((c) => c.row + 1))
  return { nodes, edges, rows }
}

export interface AgentMapProps {
  views: AgentView[]
  links: AgentLink[]
  tones: ReadonlyMap<string, string>
  /** All projects: each line names its project */
  showProject: boolean
  title?: string
  subtitle?: string
}

/** The map in its Canvas frame; the selected agent's work and hand-offs open in the side sheet. */
export function AgentMap({ views, links, tones, showProject, title, subtitle }: AgentMapProps) {
  const [selected, setSelected] = useState<string | null>(null)
  const cells = useMemo(() => layoutOf(views.map((v) => v.id)), [views])
  const rows = Math.max(1, ...[...cells.values()].map((c) => c.row + 1))
  const fit = useMemo(() => ({ bounds: { x: -24, y: -24, width: COLUMNS * W + (COLUMNS - 1) * GX + 48, height: rows * H + (rows - 1) * GY + 48 } }), [rows])
  const view = views.find((v) => v.id === selected) ?? null
  return (
    <FlowCanvas
      title={title}
      subtitle={subtitle}
      fit={fit}
      height={Math.max(380, rows * (H + GY) + 40)}
      detail={view ? { title: view.name, body: <AgentDetail view={view} links={links} tones={tones} /> } : null}
      onDetailClose={() => setSelected(null)}
    >
      <MapDrawing views={views} links={links} tones={tones} showProject={showProject} selected={selected} onSelect={setSelected} fit={fit} />
    </FlowCanvas>
  )
}

function MapDrawing({ views, links, tones, showProject, selected, onSelect, fit }: AgentMapProps & { selected: string | null; onSelect: (id: string | null) => void; fit: { bounds: { x: number; y: number; width: number; height: number } } }) {
  const { nodes, edges } = useMemo(() => mapElements(views, links, tones, showProject, selected), [views, links, tones, showProject, selected])
  const choose = useCallback((id: string | null) => onSelect(id), [onSelect])
  return (
    <FlowView
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} selected={selected} onChoose={choose} fit={fit} refitKey={String(fit.bounds.height)}
      label="Agents map. Each box is an agent and what it is doing; each arrow is a hand-off from one agent to another. Select a box to see its work and hand-offs."
    />
  )
}

/** A selected agent's work on every project and the hand-offs it asked or was asked, with a link to its page. */
export function AgentDetail({ view, links, tones }: { view: AgentView; links: readonly AgentLink[]; tones: ReadonlyMap<string, string> }) {
  const w = view.work
  const st = STATUS_OF[w?.status ?? 'idle']
  const work = [...(w?.now ?? []), ...(w?.queue ?? [])]
  const mine = links.filter((l) => l.from === view.id || l.to === view.id)
  return (
    <div className="space-y-5 text-sm">
      <div>
        <StatusBadge status={st.status} label={st.label} />
        {w && w.status !== 'idle' && w.says && <p className="mt-2 text-muted-foreground">{w.project ? `${w.project}: ` : ''}{saysText(w.says)}</p>}
        {(!w || w.status === 'idle') && <p className="mt-2 text-muted-foreground">{view.does}</p>}
      </div>
      <div>
        <h3 className="section-label mb-2">Its work ({work.length})</h3>
        {work.length === 0 ? <p className="text-muted-foreground">Nothing running or queued.</p> : (
          <ul className="space-y-2">
            {work.map((x) => (
              <li key={`${x.repo}:${x.run.id}`} className="flex gap-2">
                <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: tones.get(x.repo) ?? 'var(--muted-foreground)' }} aria-hidden />
                <span className="min-w-0">
                  <span className="block break-words">{x.run.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {x.project} · {x.run.state === 'queued' ? (x.run.startsWhen ?? 'Queued') : x.run.state === 'paused' ? 'Paused' : x.run.step ?? 'Running'}
                    {x.run.stepIndex && x.run.stepCount ? ` · step ${x.run.stepIndex} of ${x.run.stepCount}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="section-label mb-2">Hand-offs</h3>
        {mine.length === 0 ? <p className="text-muted-foreground">No hand-offs open or ended in the last hour.</p> : (
          <ul className="space-y-2">
            {mine.flatMap((l) => l.items.map((x) => (
              <li key={`${x.repo}:${x.handoff.id}`} className="flex gap-2">
                <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: tones.get(x.repo) ?? 'var(--muted-foreground)' }} aria-hidden />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-1 font-medium">{x.handoff.fromName}<ArrowRight className="size-3.5 text-muted-foreground" aria-label="asked" />{x.handoff.toName}</span>
                  <span className="block break-words">{x.handoff.question}</span>
                  <span className="block text-xs text-muted-foreground">{x.project} · {x.handoff.says} · asked {ago(x.handoff.createdAt)}</span>
                </span>
              </li>
            )))}
          </ul>
        )}
      </div>
      <Button asChild className="w-full">
        <Link to="/agents/$agent" params={{ agent: view.id }}>Open the {view.name} agent: logs and history</Link>
      </Button>
    </div>
  )
}

/** On a phone: each agent as a card, in the map's order, each opening the agent's page. */
export function AgentCards({ views, tones, showProject }: { views: AgentView[]; tones: ReadonlyMap<string, string>; showProject: boolean }) {
  const cells = layoutOf(views.map((v) => v.id))
  const ordered = [...views].sort((a, b) => {
    const x = cells.get(a.id)!
    const y = cells.get(b.id)!
    return x.row - y.row || x.col - y.col
  })
  return (
    <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">
      {ordered.map((v) => {
        const status = v.work?.status ?? 'idle'
        return (
          <li key={v.id}>
            <Link to="/agents/$agent" params={{ agent: v.id }} className={cn('block rounded-xl border-2 p-3 text-card-foreground', BOX[status])}>
              <AgentBody view={v} rows={rowsOf(v.work)} tones={tones} showProject={showProject} max={3} />
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

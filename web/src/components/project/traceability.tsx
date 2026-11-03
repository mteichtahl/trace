/**
 * The traceability view (docs/user-journey.md, "Traceability view"): intent statements, requirements and evidence in
 * three columns, each requirement linked back to the intent line it came from and forward to the test that proves it.
 * A failing result colours its whole chain back to the intent, so the person sees which promise is at risk. An intent
 * line trace proposed and no person has accepted yet is drawn dashed, as is a link to evidence with no test planned.
 *
 * Drawn with React Flow (@xyflow/react): the boxes are its nodes, the links its edges, and its viewport does the
 * panning and zooming, driven from the Canvas frame's own toolbar. Selecting a box (click, tap, or Tab then Enter)
 * lights its whole chain: every intent line, requirement and piece of evidence it is linked to, upstream and
 * downstream, with everything else faded. Clicking the empty canvas or pressing Escape clears it.
 */
import '@xyflow/react/dist/base.css'
import {
  Background, Handle, type Edge, type Node, type NodeChange, type NodeProps, Position, ReactFlow, ReactFlowProvider, useReactFlow, useStore,
} from '@xyflow/react'
import { type ReactNode, memo, useCallback, useEffect, useMemo, useState } from 'react'
import { CanvasFrame, type CanvasFrameProps } from '@/components/canvas/canvas-frame'
import { StatusBadge } from '@/components/status-badge'
import type { CoverageRow, TraceView } from '@/lib/types-s1'
import { cn } from '@/lib/utils'
import { VERDICT } from './shared'

const ROW = 70
const BOX = 58
const COL = { intent: { x: 0, w: 250 }, req: { x: 320, w: 280 }, ev: { x: 670, w: 230 } }
export const TRACE_WIDTH = COL.ev.x + COL.ev.w

export interface TraceNode {
  kind: 'intent' | 'requirement' | 'evidence'
  id: string
}

/** A box's key in the drawing: `intent:I-1`, `req:R-1`, `ev:R-1` (evidence is keyed by its requirement). */
export const nodeKey = (n: TraceNode): string => `${n.kind === 'intent' ? 'intent' : n.kind === 'requirement' ? 'req' : 'ev'}:${n.id}`
export function parseKey(key: string): TraceNode | null {
  const at = key.indexOf(':')
  const kind = { intent: 'intent', req: 'requirement', ev: 'evidence' }[key.slice(0, at)] as TraceNode['kind'] | undefined
  return kind && at > 0 ? { kind, id: key.slice(at + 1) } : null
}

export interface TraceLayout {
  /** intent: the line it is placed under (its first, in the intent's order); intents: every line it is linked to */
  reqs: { row: CoverageRow; y: number; intent?: string; intents: string[]; failing: boolean }[]
  intents: { id: string; topic: string; text: string; y: number; failing: boolean; uncovered: boolean; proposed: boolean }[]
  height: number
}

/** Place every box: requirements grouped under their intent line, intents centred on their requirements. Pure. */
export function layoutTrace(rows: CoverageRow[], trace: TraceView | undefined, filter?: (r: CoverageRow) => boolean): TraceLayout {
  const order = new Map((trace?.intent ?? []).map((i, n) => [i.id, n]))
  // a requirement may come from several intent lines: every link counts, and it is placed under the first
  const linked = new Map<string, string[]>()
  for (const l of trace?.links ?? []) if (order.has(l.intent)) linked.set(l.requirement, [...(linked.get(l.requirement) ?? []), l.intent])
  for (const ids of linked.values()) ids.sort((a, b) => order.get(a)! - order.get(b)!)
  const shown = rows.filter((r) => !filter || filter(r))
  const first = (id: string): number => order.get(linked.get(id)?.[0] ?? '') ?? 99
  const sorted = [...shown].sort((a, b) => first(a.id) - first(b.id))
  const reqs = sorted.map((row, i) => ({ row, y: i * ROW, intent: linked.get(row.id)?.[0], intents: linked.get(row.id) ?? [], failing: row.verdict === 'failing' }))
  let spare = reqs.length
  const intents = (trace?.intent ?? []).map((it) => {
    const placed = reqs.filter((r) => r.intent === it.id)
    const mine = reqs.filter((r) => r.intents.includes(it.id))
    const y = placed.length ? (placed[0]!.y + placed[placed.length - 1]!.y) / 2 : mine.length ? mine[0]!.y : spare++ * ROW
    return { id: it.id, topic: it.topic, text: it.text, y, failing: mine.some((r) => r.failing), uncovered: mine.length === 0 && !filter && it.uncovered === undefined, proposed: it.state === 'proposed' }
  }).filter((it) => !filter || reqs.some((r) => r.intents.includes(it.id)))
  const height = Math.max(reqs.length, ...intents.map((i) => i.y / ROW + 1), 1) * ROW
  return { reqs, intents, height }
}

export interface TraceLink {
  id: string
  source: string
  target: string
  failing: boolean
  /** no test planned yet (requirement → evidence) */
  dashed: boolean
}

/** The links between boxes, by box key: intent → requirement for every link, requirement → its evidence. Pure. */
export function traceLinks(l: TraceLayout): TraceLink[] {
  const shown = new Set(l.intents.map((i) => i.id))
  return l.reqs.flatMap((r) => [
    ...r.intents.filter((i) => shown.has(i)).map((i) => ({ id: `intent:${i}>req:${r.row.id}`, source: `intent:${i}`, target: `req:${r.row.id}`, failing: r.failing, dashed: false })),
    { id: `req:${r.row.id}>ev:${r.row.id}`, source: `req:${r.row.id}`, target: `ev:${r.row.id}`, failing: r.failing, dashed: r.row.tests.length === 0 },
  ])
}

/**
 * A box's whole chain: the box, everything it comes from (upstream, to the intent) and everything that comes from it
 * (downstream, to the evidence), and the links on those paths. Siblings that only share a parent are not in it: a
 * requirement's chain holds its own intent lines and its own evidence, not the other requirements under that intent.
 * Pure.
 */
export function chainOf(links: readonly TraceLink[], key: string): { nodes: Set<string>; links: Set<string> } {
  const nodes = new Set([key])
  const on = new Set<string>()
  // two directed walks, so a walk never turns round at a shared parent or child
  const walk = (from: 'source' | 'target', to: 'source' | 'target') => {
    const stack = [key]
    while (stack.length) {
      const at = stack.pop()!
      for (const l of links) {
        if (l[from] !== at) continue
        on.add(l.id)
        if (!nodes.has(l[to])) {
          nodes.add(l[to])
          stack.push(l[to])
        }
      }
    }
  }
  walk('source', 'target') // downstream, to the evidence
  walk('target', 'source') // upstream, to the intent
  return { nodes, links: on }
}

type Lit = 'none' | 'lit' | 'dim' | 'selected'
type BoxData = { label: string; failing: boolean; dashed: boolean; lit: Lit; side: 'left' | 'right' | 'both'; width: number; body: ReactNode }
type HeadData = { label: string; width: number }
type BoxNode = Node<BoxData, 'box'>
type HeadNode = Node<HeadData, 'head'>

const Box = memo(function Box({ data }: NodeProps<BoxNode>) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-card px-2.5 py-1.5 text-left text-xs leading-snug text-card-foreground shadow-xs transition-[opacity,box-shadow,border-color] duration-150 motion-reduce:transition-none',
        'hover:border-foreground/30',
        data.failing && 'border-destructive/60 bg-destructive/5',
        data.dashed && 'border-dashed',
        data.lit === 'lit' && (data.failing ? 'border-destructive ring-1 ring-destructive/60' : 'border-primary ring-1 ring-primary/50'),
        data.lit === 'selected' && (data.failing ? 'border-destructive ring-2 ring-destructive' : 'border-primary ring-2 ring-primary'),
        data.lit === 'dim' && 'opacity-30',
      )}
      style={{ width: data.width, height: BOX }}
    >
      {data.side !== 'right' && <Handle type="target" position={Position.Left} isConnectable={false} className="!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent" />}
      {data.body}
      {data.side !== 'left' && <Handle type="source" position={Position.Right} isConnectable={false} className="!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent" />}
    </div>
  )
})

const Head = memo(function Head({ data }: NodeProps<HeadNode>) {
  return <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" style={{ width: data.width }}>{data.label}</div>
})

const nodeTypes = { box: Box, head: Head }

/** The boxes and links for React Flow, lit for the selected box's chain. Pure apart from the JSX in each box. */
export function traceElements(l: TraceLayout, links: readonly TraceLink[], selected: string | null): { nodes: (BoxNode | HeadNode)[]; edges: Edge[] } {
  const chain = selected ? chainOf(links, selected) : null
  const lit = (key: string): Lit => (!chain ? 'none' : key === selected ? 'selected' : chain.nodes.has(key) ? 'lit' : 'dim')
  const head = (id: string, label: string, x: number, width: number): HeadNode => ({ id: `head:${id}`, type: 'head', position: { x, y: -28 }, data: { label, width }, selectable: false, focusable: false, draggable: false })
  const nodes: (BoxNode | HeadNode)[] = [
    ...(l.intents.length ? [head('intent', 'Intent', COL.intent.x, COL.intent.w)] : []),
    head('req', 'Requirements', COL.req.x, COL.req.w),
    head('ev', 'Evidence', COL.ev.x, COL.ev.w),
  ]
  for (const it of l.intents) {
    const key = `intent:${it.id}`
    nodes.push({
      id: key, type: 'box', position: { x: COL.intent.x, y: it.y }, selected: key === selected, ariaLabel: `Intent ${it.topic}${it.proposed ? ', proposed by trace' : ''}: ${it.text}`,
      data: {
        label: it.text, failing: it.failing, dashed: it.proposed, lit: lit(key), side: 'right', width: COL.intent.w,
        body: (
          <>
            <span className="block text-[11px] text-muted-foreground">{it.topic}{it.proposed ? ' · proposed' : ''}{it.uncovered ? ' · not covered' : ''}</span>
            <span className="line-clamp-2">{it.text}</span>
          </>
        ),
      },
    })
  }
  for (const r of l.reqs) {
    const v = VERDICT[r.row.verdict]
    const test = r.row.tests[0]
    const rk = `req:${r.row.id}`
    const ek = `ev:${r.row.id}`
    nodes.push({
      id: rk, type: 'box', position: { x: COL.req.x, y: r.y }, selected: rk === selected, ariaLabel: `${r.row.id}: ${r.row.text}`,
      data: {
        label: r.row.text, failing: r.failing, dashed: false, lit: lit(rk), side: 'both', width: COL.req.w,
        body: (
          <>
            <span className="block font-mono text-[11px] text-muted-foreground">{r.row.id}</span>
            <span className="line-clamp-2">{r.row.text}</span>
          </>
        ),
      },
    })
    nodes.push({
      id: ek, type: 'box', position: { x: COL.ev.x, y: r.y }, selected: ek === selected, ariaLabel: `Evidence for ${r.row.id}: ${v.label}`,
      data: {
        label: v.label, failing: r.failing, dashed: false, lit: lit(ek), side: 'left', width: COL.ev.w,
        body: (
          <>
            <StatusBadge status={v.status} label={v.label} plain />
            <span className="block truncate font-mono text-[11px] text-muted-foreground">{test ? `${test.id}${test.last_run ? ` · ${test.last_run}` : ''}` : 'no test planned'}</span>
          </>
        ),
      },
    })
  }
  const edges: Edge[] = links.map((k) => {
    const on = chain?.links.has(k.id)
    const stroke = k.failing ? 'var(--destructive)' : on ? 'var(--primary)' : 'var(--border)'
    return {
      id: k.id, source: k.source, target: k.target, selectable: false, focusable: false, zIndex: on ? 1 : 0,
      style: {
        stroke, strokeWidth: on ? 2.5 : k.failing ? 2 : 1.25, strokeDasharray: k.dashed ? '4 3' : undefined,
        opacity: chain && !on ? 0.15 : 1, transition: 'opacity 150ms, stroke-width 150ms',
      },
    }
  })
  return { nodes, edges }
}

export interface TraceabilityProps {
  rows: CoverageRow[]
  trace?: TraceView
  filter?: (r: CoverageRow) => boolean
  /** the selected box's key (`nodeKey`); leave unset and the view keeps its own selection */
  selected?: string | null
  /** a box was selected, or (null) the selection was cleared */
  onSelect?: (n: TraceNode | null) => void
}

/** The traceability view in its Canvas frame, the frame's zoom and fit driving React Flow's viewport. */
export function TraceabilityCanvas(props: TraceabilityProps & Omit<CanvasFrameProps, 'children' | 'viewport' | 'filter'> & { filterControls?: ReactNode }) {
  return (
    <ReactFlowProvider>
      <Framed {...props} />
    </ReactFlowProvider>
  )
}

function Framed({ rows, trace, filter, selected, onSelect, filterControls, ...frame }: TraceabilityProps & Omit<CanvasFrameProps, 'children' | 'viewport' | 'filter'> & { filterControls?: ReactNode }) {
  const flow = useReactFlow()
  const zoom = useStore((s) => s.transform[2])
  const viewport = useMemo(() => ({
    zoom,
    zoomIn: () => void flow.zoomIn({ duration: 150 }),
    zoomOut: () => void flow.zoomOut({ duration: 150 }),
    fit: () => void flow.fitView({ padding: 0.08, duration: 200 }),
  }), [flow, zoom])
  return (
    <CanvasFrame {...frame} filter={filterControls} viewport={viewport}>
      <Traceability rows={rows} trace={trace} filter={filter} selected={selected} onSelect={onSelect} />
    </CanvasFrame>
  )
}

/** The drawing itself; needs a ReactFlowProvider above it (TraceabilityCanvas gives one). */
export function Traceability({ rows, trace, filter, selected: controlled, onSelect }: TraceabilityProps) {
  const [own, setOwn] = useState<string | null>(null)
  const selected = controlled === undefined ? own : controlled
  const layout = useMemo(() => layoutTrace(rows, trace, filter), [rows, trace, filter])
  const links = useMemo(() => traceLinks(layout), [layout])
  const { nodes, edges } = useMemo(() => traceElements(layout, links, selected), [layout, links, selected])
  const flow = useReactFlow()

  const choose = useCallback((key: string | null) => {
    setOwn(key)
    onSelect?.(key ? parseKey(key) : null)
  }, [onSelect])

  // a different set of boxes (a filter, new rows): fit them in view again
  const shape = nodes.map((n) => n.id).join('|')
  useEffect(() => {
    const t = setTimeout(() => void flow.fitView({ padding: 0.08, duration: 200 }), 0)
    return () => clearTimeout(t)
  }, [shape, flow])

  // the selection leaves the drawing (filtered out): clear it
  useEffect(() => {
    if (selected && !nodes.some((n) => n.id === selected)) choose(null)
  }, [selected, nodes, choose])

  // keyboard: Tab to a box and press Enter selects it; Escape clears (React Flow reports both as select changes)
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const on = changes.find((c) => c.type === 'select' && c.selected)
    if (on && 'id' in on) {
      if (on.id !== selected && !on.id.startsWith('head:')) choose(on.id)
      return
    }
    if (selected && changes.some((c) => c.type === 'select' && !c.selected && c.id === selected)) choose(null)
  }, [selected, choose])

  return (
    <div className="h-full w-full" role="group" aria-label="Traceability: intent, requirements and evidence. Select a box to light its whole chain.">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => { if (n.type === 'box') choose(n.id) }}
        onPaneClick={() => selected && choose(null)}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        elementsSelectable
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        deleteKeyCode={null}
        zoomOnScroll={false}
        zoomActivationKeyCode={['Control', 'Meta']}
        zoomOnDoubleClick={false}
        preventScrolling={false}
        minZoom={0.2}
        maxZoom={2.5}
        fitView
        fitViewOptions={{ padding: 0.08 }}
        proOptions={{ hideAttribution: false }}
       
      >
        <Background gap={16} size={1} color="var(--border)" />
      </ReactFlow>
    </div>
  )
}

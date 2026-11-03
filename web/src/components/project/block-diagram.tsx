/**
 * The architecture block diagram (docs/user-journey.md, "Architecture block diagram"): each block with its name, its
 * key part with stock, and the requirements it serves; each connection with what flows along it. Positions are
 * fractions of the frame, so options compare with the layout held still (the view fits the frame, not the blocks).
 *
 * Drawn with React Flow (@xyflow/react), as the traceability view is: blocks are its nodes, connections its edges,
 * and its viewport pans and zooms from the Canvas frame's toolbar. Selecting a block (click, tap, or Tab then Enter)
 * lights it, every block it connects to in either direction, and the connections between them with what flows along
 * each; everything else fades. Clicking the empty canvas or pressing Escape clears it.
 */
import '@xyflow/react/dist/base.css'
import {
  Background, type Edge, Handle, MarkerType, type Node, type NodeChange, type NodeProps, Position, ReactFlow, ReactFlowProvider, useReactFlow, useStore,
} from '@xyflow/react'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { CanvasFrame, type CanvasFrameProps } from '@/components/canvas/canvas-frame'
import { StatusBadge } from '@/components/status-badge'
import type { Block, BlockConnection } from '@/lib/types-s1'
import { cn } from '@/lib/utils'

const W = 1180
const H = 470
const BW = 200
const BH = 92
const BOUNDS = { x: -16, y: -16, width: W + 32, height: H + 32 }

type Side = 'left' | 'right' | 'top' | 'bottom'
const SIDES: { side: Side; position: Position }[] = [
  { side: 'left', position: Position.Left }, { side: 'right', position: Position.Right }, { side: 'top', position: Position.Top }, { side: 'bottom', position: Position.Bottom },
]

/** A block and the blocks it connects to (either direction), and the connections between them. Pure. */
export function linkedTo(connections: readonly Pick<BlockConnection, 'from' | 'to'>[], id: string): { blocks: Set<string>; connections: Set<string> } {
  const blocks = new Set([id])
  const on = new Set<string>()
  for (const c of connections) {
    if (c.from !== id && c.to !== id) continue
    blocks.add(c.from === id ? c.to : c.from)
    on.add(connectionId(c))
  }
  return { blocks, connections: on }
}

export const connectionId = (c: Pick<BlockConnection, 'from' | 'to'>): string => `${c.from}>${c.to}`

/** Which sides a connection leaves and enters by, from where the two blocks sit. Pure. */
export function sidesFor(a: { x: number; y: number }, b: { x: number; y: number }): { from: Side; to: Side } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  // compare in box units, so a block straight below (wider than tall) still reads as below
  if (Math.abs(dx) / BW >= Math.abs(dy) / BH) return dx >= 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' }
  return dy >= 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' }
}

type Lit = 'none' | 'lit' | 'dim' | 'selected'
type BlockData = { block: Block; lit: Lit }
type BlockNode = Node<BlockData, 'block'>

const BlockBox = memo(function BlockBox({ data }: NodeProps<BlockNode>) {
  const b = data.block
  const handle = '!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent'
  return (
    <div
      className={cn(
        'rounded-lg border-2 bg-card p-2.5 text-left text-xs text-card-foreground shadow-xs transition-[opacity,box-shadow,border-color] duration-150 motion-reduce:transition-none hover:border-foreground/40',
        'border-border',
        b.serves.length === 0 && 'border-dashed border-warning',
        data.lit === 'lit' && 'border-primary/70 ring-1 ring-primary/40',
        data.lit === 'selected' && 'border-primary ring-2 ring-primary',
        data.lit === 'dim' && 'opacity-30',
      )}
      style={{ width: BW, height: BH }}
    >
      {SIDES.map((s) => <Handle key={`t-${s.side}`} id={`t-${s.side}`} type="target" position={s.position} isConnectable={false} className={handle} />)}
      {SIDES.map((s) => <Handle key={`s-${s.side}`} id={`s-${s.side}`} type="source" position={s.position} isConnectable={false} className={handle} />)}
      <span className="block text-sm font-semibold">{b.name}</span>
      {b.part && (
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className="truncate font-mono">{b.part}</span>
          {b.stock && <StatusBadge plain status={b.stock === 'in_stock' ? 'met' : b.stock === 'low' ? 'warning' : 'failing'} label={b.stock === 'in_stock' ? 'In stock' : b.stock === 'low' ? 'Low stock' : 'Out of stock'} />}
        </span>
      )}
      <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{b.serves.length ? b.serves.join(' ') : 'Serves no requirement'}</span>
    </div>
  )
})

const nodeTypes = { block: BlockBox }

/** The blocks and connections for React Flow, lit for the selected block. Pure apart from the JSX in each block. */
export function blockElements(blocks: readonly Block[], connections: readonly BlockConnection[], selected: string | null): { nodes: BlockNode[]; edges: Edge[] } {
  const at = new Map(blocks.map((b) => [b.id, { x: b.x * (W - BW), y: b.y * (H - BH) }]))
  const near = selected && at.has(selected) ? linkedTo(connections, selected) : null
  const lit = (id: string): Lit => (!near ? 'none' : id === selected ? 'selected' : near.blocks.has(id) ? 'lit' : 'dim')
  const nodes: BlockNode[] = blocks.map((b) => ({
    id: b.id, type: 'block', position: at.get(b.id)!, selected: b.id === selected, ariaRole: 'button',
    ariaLabel: `${b.name}${b.part ? `, ${b.part}` : ''}. Serves ${b.serves.length ? b.serves.join(', ') : 'no requirement'}`,
    data: { block: b, lit: lit(b.id) },
  }))
  const edges: Edge[] = connections.flatMap((c) => {
    const a = at.get(c.from)
    const b = at.get(c.to)
    if (!a || !b) return []
    const id = connectionId(c)
    const on = near?.connections.has(id) ?? false
    const faded = !!near && !on
    const color = on ? 'var(--primary)' : 'var(--muted-foreground)'
    const s = sidesFor(a, b)
    return [{
      id, source: c.from, target: c.to, sourceHandle: `s-${s.from}`, targetHandle: `t-${s.to}`, label: c.label, selectable: false, focusable: false, zIndex: on ? 1 : 0,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      style: { stroke: color, strokeWidth: on ? 2.5 : 1.5, opacity: faded ? 0.15 : 1, transition: 'opacity 150ms, stroke-width 150ms' },
      labelStyle: { fontSize: 11, fill: on ? 'var(--foreground)' : 'var(--muted-foreground)', fontWeight: on ? 600 : 400, opacity: faded ? 0.25 : 1 },
      labelBgStyle: { fill: 'var(--card)', opacity: faded ? 0.25 : 1 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
    }]
  })
  return { nodes, edges }
}

export interface BlockDiagramProps {
  blocks: Block[]
  connections: BlockConnection[]
  selected?: string | null
  /** a block was selected, or (null) the selection was cleared */
  onSelect?: (b: Block | null) => void
}

/** The block diagram in its Canvas frame, the frame's zoom and fit driving React Flow's viewport. */
export function BlockDiagramCanvas(props: BlockDiagramProps & Omit<CanvasFrameProps, 'children' | 'viewport'>) {
  return (
    <ReactFlowProvider>
      <Framed {...props} />
    </ReactFlowProvider>
  )
}

function Framed({ blocks, connections, selected, onSelect, ...frame }: BlockDiagramProps & Omit<CanvasFrameProps, 'children' | 'viewport'>) {
  const flow = useReactFlow()
  const zoom = useStore((s) => s.transform[2])
  const viewport = useMemo(() => ({
    zoom,
    zoomIn: () => void flow.zoomIn({ duration: 150 }),
    zoomOut: () => void flow.zoomOut({ duration: 150 }),
    fit: () => void flow.fitBounds(BOUNDS, { duration: 200 }),
  }), [flow, zoom])
  return (
    <CanvasFrame {...frame} viewport={viewport}>
      <BlockDiagram blocks={blocks} connections={connections} selected={selected} onSelect={onSelect} />
    </CanvasFrame>
  )
}

/** The drawing itself; needs a ReactFlowProvider above it (BlockDiagramCanvas gives one). */
export function BlockDiagram({ blocks, connections, selected: controlled, onSelect }: BlockDiagramProps) {
  const flow = useReactFlow()
  // uncontrolled, for pictures that only look (a skill step) rather than open a block's detail
  const [mine, setMine] = useState<string | null>(null)
  const selected = controlled === undefined ? mine : controlled
  const { nodes, edges } = useMemo(() => blockElements(blocks, connections, selected ?? null), [blocks, connections, selected])
  const byId = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks])

  const choose = useCallback((id: string | null) => {
    setMine(id)
    onSelect?.(id ? byId.get(id) ?? null : null)
  }, [onSelect, byId, setMine])

  // fit the frame (not the blocks), so switching options keeps every block where it was drawn
  useEffect(() => {
    const t = setTimeout(() => void flow.fitBounds(BOUNDS), 0)
    return () => clearTimeout(t)
  }, [flow])

  // keyboard: Tab to a block and press Enter selects it; Escape clears (React Flow reports both as select changes)
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const on = changes.find((c) => c.type === 'select' && c.selected)
    if (on && 'id' in on) {
      if (on.id !== selected) choose(on.id)
      return
    }
    if (selected && changes.some((c) => c.type === 'select' && !c.selected && c.id === selected)) choose(null)
  }, [selected, choose])

  return (
    <div className="h-full w-full" role="group" aria-label="Block diagram. Select a block to light what it connects to.">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => choose(n.id)}
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
      >
        <Background gap={16} size={1} color="var(--border)" />
      </ReactFlow>
    </div>
  )
}

